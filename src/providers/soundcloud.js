// SoundCloud provider plugin for PearTube relays:
//   - Scrapes a public SoundCloud `client_id` from `https://soundcloud.com` and its `sndcdn.com/assets/*.js` bundles
//     through the relay's SSRF-guarded fetch, caches it in memory (re-scraping once on 401/403), and searches
//     `https://api-v2.soundcloud.com/search/tracks`
//   - Saves chosen tracks' audio via `ubit` (`downloadPage(..., { audio: true })`) into
//     `<staging>/<Artist> - <Album> (<Year>) [SoundCloud]/NN - Title.<ext>`, pinned to an `sc:` release, then scans
//   - Serves result thumbnails through the relay so the owner's browser never contacts SoundCloud's image host
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import b4a from 'b4a'
import { MAX_TITLE, MEDIA_FILE } from '../protocol.js'
import { albumKey } from '../tags.js'
import { ALBUM_PIN, freePath, noteMirrored, safeSegment } from './staging.js'

export const NAME = 'soundcloud'
export const SOUNDCLOUD_SEARCH_CAP = 20
export const SOUNDCLOUD_BITRATE = 128
const MAX_TRACKS = 100
const TRACK_ID = /^[A-Za-z0-9_-]{1,64}$/
const CLIENT_ID_PATTERNS = [
  /client_id\s*[:=]\s*["']([A-Za-z0-9_-]{16,64})["']/,
  /client_id=([A-Za-z0-9_-]{16,64})/
]

// The `sc:` release an album saved from SoundCloud is pinned to: same hash recipe as `album:<hex>` and `yt:<hex>`.
export function soundcloudRelease ({ artist, album, year }) {
  return `sc:${createHash('sha256').update(albumKey({ albumArtist: artist, album, year })).digest('hex').slice(0, 20)}`
}

function asText (body) {
  if (typeof body === 'string') return body
  return body ? b4a.toString(body, 'utf8') : ''
}

function extractClientId (text) {
  for (const re of CLIENT_ID_PATTERNS) {
    const m = re.exec(text)
    if (m && m[1]) return m[1]
  }
  return null
}

function extractScriptUrls (html, siteBase) {
  const urls = []
  const seen = new Set()
  const re = /<script[^>]+src=["']([^"']+\.js(?:\?[^"']*)?)["']/gi
  let m
  while ((m = re.exec(html)) !== null) {
    let resolved
    try { resolved = new URL(m[1], siteBase).href } catch { continue }
    if (!/sndcdn\.com\/assets\/|\/assets\/[^/]+\.js/i.test(resolved)) continue
    if (seen.has(resolved)) continue
    seen.add(resolved)
    urls.push(resolved)
  }
  return urls
}

function artworkUrlFor (e) {
  let raw = null
  if (typeof e?.artwork_url === 'string' && /^https?:\/\//i.test(e.artwork_url)) {
    raw = e.artwork_url
  } else if (typeof e?.user?.avatar_url === 'string' && /^https?:\/\//i.test(e.user.avatar_url)) {
    raw = e.user.avatar_url
  }
  if (!raw) return null
  return /sndcdn\.com/i.test(raw) ? raw.replace(/-large\.(jpg|jpeg|png|webp)$/i, '-t300x300.$1') : raw
}

function trackListFrom (data) {
  if (Array.isArray(data?.collection)) return data.collection
  if (Array.isArray(data?.tracks)) return data.tracks
  return Array.isArray(data) ? data : []
}

function trackUrlFor (e) {
  if (typeof e?.permalink_url === 'string' && /^https?:\/\//i.test(e.permalink_url)) return e.permalink_url
  if (typeof e?.url === 'string' && /^https?:\/\//i.test(e.url)) return e.url
  return ''
}

function trackLengthFor (e) {
  const rawSec = Number(e?.length)
  if (Number.isFinite(rawSec) && rawSec > 0) return Math.round(rawSec)
  const rawMs = Number(e?.duration ?? e?.full_duration)
  if (Number.isFinite(rawMs) && rawMs > 0) return Math.round(rawMs / 1000)
  return null
}

export function normalizeSoundcloudResults (data, limit = SOUNDCLOUD_SEARCH_CAP, thumbUrls = null) {
  const list = trackListFrom(data)
  const rows = []
  const seen = new Set()
  for (const e of list) {
    const trackId = String(e?.id ?? e?.trackId ?? '').trim()
    if (!TRACK_ID.test(trackId) || seen.has(trackId)) continue
    const url = trackUrlFor(e)
    if (!url) continue
    seen.add(trackId)
    const artist = String(e?.user?.username || e?.user?.full_name || e?.artist || e?.publisher_metadata?.artist || '').trim().slice(0, 120) || null
    const length = trackLengthFor(e)
    const art = artworkUrlFor(e)
    if (thumbUrls && art) {
      thumbUrls.set(trackId, art)
      while (thumbUrls.size > 256) thumbUrls.delete(thumbUrls.keys().next().value)
    }
    rows.push({
      title: String(e?.title || '').trim().slice(0, 300) || trackId,
      artist,
      length,
      size: null,
      bitrate: SOUNDCLOUD_BITRATE,
      sample_rate: null,
      bit_depth: null,
      lossy: true,
      trackId,
      url,
      channel: artist,
      thumbnail: `/v1/providers/soundcloud/thumb/${trackId}`
    })
    if (rows.length >= limit) break
  }
  return rows
}

export function createSoundcloudPlugin ({
  storage,
  stagingRoot = join(storage, 'staging'),
  stagingLabel = 'storage',
  placeAndScan = null,
  download: downloadPage = null,
  fetchBytes = null,
  siteBase = 'https://soundcloud.com',
  apiBase = 'https://api-v2.soundcloud.com',
  searchTracks = null,
  searchTimeoutMs = 20_000,
  onchange = null
}) {
  const canSearch = typeof searchTracks === 'function' || typeof fetchBytes === 'function'
  const canSave = typeof downloadPage === 'function'
  const available = canSearch && canSave
  const jobs = new Map()
  const thumbUrls = new Map()
  const thumbs = new Map()
  const workRoot = join(storage, 'soundcloud-work')
  // ast-grep-ignore: js-no-empty-catch -- best-effort cleanup of leftover scratch dir at startup
  if (canSave) try { rmSync(workRoot, { recursive: true, force: true }) } catch {}
  let closed = false
  let chain = Promise.resolve()
  let cachedClientId = null
  let lastSearchAt = null
  let lastResultCount = null
  let lastError = null

  const unavailable = () => Object.assign(new Error('SoundCloud is not available on this device'), { status: 503 })

  async function scrapeClientId (timeoutMs) {
    const pageRes = await fetchBytes(siteBase, { timeoutMs, maxBytes: 4 * 1024 * 1024, headers: { accept: 'text/html' } })
    if (pageRes.status < 200 || pageRes.status >= 300) {
      throw Object.assign(new Error(`SoundCloud homepage answered ${pageRes.status}`), { status: 502 })
    }
    const html = asText(pageRes.body)
    const inline = extractClientId(html)
    if (inline) return inline
    const scripts = extractScriptUrls(html, siteBase).slice(-8).reverse()
    for (const src of scripts) {
      try {
        const res = await fetchBytes(src, { timeoutMs, maxBytes: 6 * 1024 * 1024 })
        if (res.status !== 200) continue
        const found = extractClientId(asText(res.body))
        if (found) return found
      } catch {
        continue
      }
    }
    throw Object.assign(new Error('Could not find a SoundCloud client_id'), { status: 502 })
  }

  async function queryApi (q, limit, timeoutMs) {
    if (typeof searchTracks === 'function') return searchTracks({ query: q, limit, timeoutMs })
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!cachedClientId) cachedClientId = await scrapeClientId(timeoutMs)
      const url = `${apiBase.replace(/\/+$/, '')}/search/tracks?q=${encodeURIComponent(q)}&client_id=${encodeURIComponent(cachedClientId)}&limit=${limit}`
      const res = await fetchBytes(url, { timeoutMs, maxBytes: 2 * 1024 * 1024, headers: { accept: 'application/json' } })
      if ((res.status === 401 || res.status === 403) && attempt === 0) {
        cachedClientId = null
        continue
      }
      if (res.status < 200 || res.status >= 300) {
        throw Object.assign(new Error(`SoundCloud API answered ${res.status}`), { status: res.status === 429 ? 429 : 502 })
      }
      try {
        return JSON.parse(asText(res.body))
      } catch {
        throw Object.assign(new Error('SoundCloud returned invalid JSON'), { status: 502 })
      }
    }
    throw Object.assign(new Error('SoundCloud refused the client_id'), { status: 502 })
  }

  async function search ({ query, limit = SOUNDCLOUD_SEARCH_CAP, timeoutMs = searchTimeoutMs } = {}) {
    if (!canSearch) throw unavailable()
    const q = String(query || '').trim().slice(0, 200)
    if (!q) throw Object.assign(new Error('query is required'), { status: 400 })
    const cap = Math.max(1, Math.min(SOUNDCLOUD_SEARCH_CAP, Math.trunc(Number(limit)) || SOUNDCLOUD_SEARCH_CAP))
    const ms = Math.max(1000, Math.min(45_000, Number(timeoutMs) || searchTimeoutMs))
    let candidates
    try {
      const data = await queryApi(q, cap + 1, ms)
      candidates = normalizeSoundcloudResults(data, cap + 1, thumbUrls)
      lastError = null
    } catch (err) {
      lastError = String(err?.message || err).slice(0, 200)
      onchange?.()
      throw Object.assign(new Error(`SoundCloud search failed: ${lastError}`), { status: Number(err?.status) || 502 })
    }
    lastSearchAt = Date.now()
    lastResultCount = candidates.length
    onchange?.()
    return { candidates: candidates.slice(0, cap), cap: SOUNDCLOUD_SEARCH_CAP, truncated: candidates.length > cap }
  }

  function trimJobs () {
    if (jobs.size <= 48) return
    for (const [id, j] of jobs) {
      if (j.status === 'done' || j.status === 'failed' || j.status === 'cancelled') {
        jobs.delete(id)
        if (jobs.size <= 32) break
      }
    }
  }

  const publicJob = ({ controller: _c, progressAt, ...rest }) => ({
    ...rest,
    idleMs: rest.status === 'queued' || rest.status === 'transferring' ? Date.now() - progressAt : null
  })

  async function mirror (payload = {}, ctx) {
    if (!canSave) throw unavailable()
    const isSingle = !Array.isArray(payload.tracks) && typeof payload.url === 'string'
    let artist
    let album
    let raw
    if (isSingle) {
      const singleTitle = safeSegment(payload.title, '').slice(0, 120)
      if (!singleTitle) throw Object.assign(new Error('title is required'), { status: 400 })
      artist = safeSegment(payload.artist, 'SoundCloud').slice(0, 120)
      album = safeSegment(payload.album || singleTitle, singleTitle).slice(0, 120)
      raw = [{ trackId: payload.trackId || '', url: payload.url, title: singleTitle, track: 1, disc: 1 }]
    } else {
      artist = safeSegment(payload.artist, '').slice(0, 120)
      album = safeSegment(payload.album, '').slice(0, 120)
      if (!artist || !album) throw Object.assign(new Error('artist and album are required'), { status: 400 })
      raw = Array.isArray(payload.tracks) ? payload.tracks : []
    }
    if (raw.length > MAX_TRACKS) throw Object.assign(new Error(`An album takes at most ${MAX_TRACKS} tracks`), { status: 400 })
    const yearMatch = /^(1[89]\d{2}|20\d{2})$/.exec(String(payload.year ?? '').trim())
    const year = yearMatch ? yearMatch[1] : ''
    const tracks = []
    const numbers = new Set()
    for (const [i, t] of raw.entries()) {
      const url = typeof t?.url === 'string' ? t.url.trim() : ''
      if (!/^https?:\/\//i.test(url)) throw Object.assign(new Error(`Track ${i + 1} has no valid URL`), { status: 400 })
      const title = safeSegment(t.title, '').slice(0, 120)
      if (!title) throw Object.assign(new Error(`Track ${i + 1} has no title`), { status: 400 })
      const givenTrack = Math.trunc(Number(t.track))
      const track = givenTrack >= 1 && givenTrack <= 999 ? givenTrack : i + 1
      const givenDisc = Math.trunc(Number(t.disc))
      const disc = givenDisc >= 1 && givenDisc <= 99 ? givenDisc : 1
      const numKey = `${disc}:${track}`
      if (numbers.has(numKey)) throw Object.assign(new Error(`Two tracks are numbered ${track}`), { status: 400 })
      numbers.add(numKey)
      tracks.push({ trackId: String(t.trackId || ''), url, title, track, disc })
    }
    if (!tracks.length) throw Object.assign(new Error('tracks must list at least one track'), { status: 400 })

    const release = soundcloudRelease({ artist, album, year })
    const albumTitle = `${artist} · ${album}`.slice(0, MAX_TITLE)
    const folderName = `${safeSegment(`${artist} - ${album}${year ? ` (${year})` : ''}`, 'Album').slice(0, 128).trimEnd()} [SoundCloud]`
    const fileOf = (t, ext) => safeSegment(`${String(t.track).padStart(2, '0')} - ${t.title}`, String(t.track).padStart(2, '0')) + ext
    const jobId = randomUUID()
    const job = {
      jobId, id: release, title: albumTitle, plugin: NAME, source: NAME, channel: true, private: false,
      status: 'queued', phase: 'queued', created: Date.now(), peer: null, queuePlace: null,
      file: fileOf(tracks[0], '.mp3'), fileIndex: 1, fileCount: tracks.length, speed: 0,
      bytes: 0, total: null, error: null, skipped: [], note: null, progressAt: Date.now(),
      controller: { aborted: false, onabort: null }
    }
    trimJobs()
    jobs.set(jobId, job)
    onchange?.()

    const run = async () => {
      let workDir = null
      try {
        if (job.controller.aborted || closed) throw new Error('Cancelled')
        mkdirSync(workRoot, { recursive: true })
        workDir = mkdtempSync(join(workRoot, 'job-'))
        const got = []
        let doneBytes = 0
        for (const [i, t] of tracks.entries()) {
          if (job.controller.aborted || closed) throw new Error('Cancelled')
          Object.assign(job, { status: 'transferring', phase: 'downloading', file: fileOf(t, '.mp3'), fileIndex: i + 1, speed: 0, progressAt: Date.now() })
          onchange?.()
          const outDir = join(workDir, String(i + 1))
          mkdirSync(outDir)
          let rateAt = Date.now()
          let rateBytes = 0
          try {
            const dl = await downloadPage(t.url, outDir, {
              audio: true,
              controller: job.controller,
              onProgress ({ bytes }) {
                const now = Date.now()
                if (doneBytes + bytes > job.bytes) job.progressAt = now
                job.bytes = Math.max(job.bytes, doneBytes + bytes)
                if (now - rateAt >= 1000) {
                  const rate = (bytes - rateBytes) / ((now - rateAt) / 1000)
                  job.speed = Math.max(0, Math.round(job.speed ? job.speed * 0.5 + rate * 0.5 : rate))
                  rateAt = now
                  rateBytes = bytes
                  onchange?.()
                }
              }
            })
            const ext = extname(dl.path).toLowerCase()
            if (!MEDIA_FILE.test(`x${ext}`)) throw new Error(`SoundCloud sent a file this relay does not import (${ext || 'no extension'})`)
            const size = statSync(dl.path).size
            if (!size) throw new Error('SoundCloud sent an empty file')
            got.push({ t, path: dl.path, ext })
            doneBytes += size
            job.bytes = doneBytes
          } catch (err) {
            if (job.controller.aborted || closed) throw new Error('Cancelled')
            const reason = String(err?.message || err).slice(0, 200)
            job.skipped.push({ track: t.track, title: t.title, error: reason })
          }
        }
        if (!got.length) {
          const first = job.skipped[0]
          throw Object.assign(new Error(tracks.length === 1
            ? `SoundCloud did not send “${first.title}”: ${first.error}`
            : `SoundCloud sent none of the ${tracks.length} tracks. First reason: ${first.error}`), { status: 502 })
        }
        if (job.skipped.length) {
          job.note = `${job.skipped.length} of ${tracks.length} tracks not saved: ${job.skipped.map(s => `${s.title} (${s.error})`).join('; ')}`.slice(0, 600)
        }
        const finalDir = join(stagingRoot, folderName)
        const placed = new Set()
        const place = () => {
          const pinPath = join(finalDir, ALBUM_PIN)
          let pinned = null
          try { pinned = JSON.parse(readFileSync(pinPath, 'utf8'))?.release } catch { pinned = null }
          let held = []
          try { held = readdirSync(finalDir).filter(n => !/^[.@]/.test(n)) } catch { held = [] }
          if (pinned ? pinned !== release : held.length) throw Object.assign(new Error(`The folder “${folderName}” already holds other files`), { status: 409 })
          mkdirSync(finalDir, { recursive: true })
          writeFileSync(pinPath, JSON.stringify({ release, title: albumTitle, artist }) + '\n')
          for (const g of got) {
            const dst = freePath(finalDir, fileOf(g.t, g.ext))
            try {
              renameSync(g.path, dst)
            } catch {
              copyFileSync(g.path, dst)
            }
            placed.add(basename(dst))
          }
          noteMirrored(finalDir, placed)
          job.phase = 'importing'
          onchange?.()
        }
        Object.assign(job, { status: 'announcing', phase: 'waiting', speed: 0, progressAt: Date.now() })
        onchange?.()
        let scan = { scanned: 0, ingested: 0, items: [] }
        if (placeAndScan) scan = await placeAndScan(place, ctx, { cancelled: () => closed || job.controller.aborted })
        else place()
        const relOf = name => `${folderName}/${name}`
        const refusedImport = (scan?.failed || []).filter(f => placed.has(f.file) && f.rel === relOf(f.file))
        for (const f of refusedImport) {
          const g = got.find(x => fileOf(x.t, x.ext) === f.file)
          job.skipped.push({ track: g?.t.track ?? null, title: g?.t.title || f.file, error: `Not imported: ${String(f.error).slice(0, 160)}` })
        }
        const imported = placed.size - refusedImport.length
        if (!imported) throw Object.assign(new Error(`The relay could not import the saved tracks: ${refusedImport[0].error}`), { status: 500 })
        if (job.skipped.length) {
          job.note = `${job.skipped.length} of ${tracks.length} tracks not saved: ${job.skipped.map(s => `${s.title} (${s.error})`).join('; ')}`.slice(0, 600)
        }
        Object.assign(job, {
          status: 'done',
          phase: 'done',
          size: doneBytes,
          bytes: doneBytes,
          total: doneBytes,
          sha256s: (scan?.items || []).filter(it => placed.has(it.file) && it.rel === relOf(it.file)).map(it => it.sha256)
        })
        onchange?.()
        return { jobId, id: release, folder: folderName, files: imported, bytes: doneBytes, ingested: scan?.ingested || 0, items: scan?.items || [], skipped: job.skipped }
      } catch (err) {
        if (job.controller.aborted || closed) {
          job.status = 'cancelled'
          job.phase = 'cancelled'
        } else {
          job.status = 'failed'
          job.phase = 'failed'
          job.error = String(err?.message || err).slice(0, 300)
        }
        job.speed = 0
        onchange?.()
        throw Object.assign(new Error(job.error || 'Cancelled'), { status: err?.status || 502 })
      } finally {
        // ast-grep-ignore: js-no-empty-catch -- best-effort cleanup of per-job scratch dir
        if (workDir) try { rmSync(workDir, { recursive: true, force: true }) } catch {}
      }
    }

    const result = chain.then(run)
    chain = result.catch(() => {})
    if (payload.wait === true) return result
    result.catch(() => {})
    return { queued: true, job: publicJob(job) }
  }

  function listJobs () {
    return [...jobs.values()].map(publicJob)
  }

  function getJob (jobId) {
    const j = jobs.get(jobId)
    return j ? publicJob(j) : null
  }

  function cancelJob (jobId) {
    const j = jobs.get(jobId)
    if (!j) return null
    if (j.status === 'queued' || j.status === 'transferring' || (j.status === 'announcing' && j.phase === 'waiting')) {
      j.controller.aborted = true
      j.controller.onabort?.()
      j.status = 'cancelled'
      j.phase = 'cancelled'
      onchange?.()
      return publicJob(j)
    }
    if (j.status !== 'announcing') {
      jobs.delete(jobId)
      onchange?.()
      return { ...publicJob(j), status: 'removed' }
    }
    return publicJob(j)
  }

  function info () {
    let activeJobs = 0
    for (const j of jobs.values()) if (j.status === 'queued' || j.status === 'transferring' || j.status === 'announcing') activeJobs++
    return {
      status: !available ? 'unavailable' : 'ready',
      message: !available ? 'SoundCloud search needs the relay.' : lastError || '',
      canSave,
      configured: available,
      available,
      activeJobs,
      searchCap: SOUNDCLOUD_SEARCH_CAP,
      bitrate: SOUNDCLOUD_BITRATE,
      staging: stagingLabel,
      lastSearchAt,
      lastResultCount
    }
  }

  async function thumbnail (trackId) {
    const id = String(trackId || '')
    const artUrl = thumbUrls.get(id)
    if (!fetchBytes || !TRACK_ID.test(id) || !artUrl) return null
    if (!thumbs.has(id)) {
      const pending = fetchBytes(artUrl, { timeoutMs: 8000, maxBytes: 512 * 1024 }).then(
        res => res.status === 200 && res.body.byteLength && /^image\/(jpeg|webp|png|gif)/i.test(String(res.headers['content-type'] || ''))
          ? { type: String(res.headers['content-type']).split(';')[0], bytes: res.body }
          : null,
        () => { if (thumbs.get(id) === pending) thumbs.delete(id); return null }
      )
      thumbs.set(id, pending)
      while (thumbs.size > 64) thumbs.delete(thumbs.keys().next().value)
    }
    return thumbs.get(id)
  }

  async function stop () {
    closed = true
    for (const j of jobs.values()) {
      if (j.status === 'queued' || j.status === 'transferring' || (j.status === 'announcing' && j.phase === 'waiting')) {
        j.controller.aborted = true
        j.controller.onabort?.()
        if (j.status === 'announcing') Object.assign(j, { status: 'cancelled', phase: 'cancelled' })
      }
    }
    await chain
  }

  return {
    name: NAME,
    description: 'Finds music on SoundCloud and saves its audio as albums in the staging folder',
    async run (payload = {}, ctx) {
      if (!available) return { skipped: true, status: 'unavailable' }
      if (Array.isArray(payload?.tracks) || typeof payload?.url === 'string') return mirror(payload, ctx)
      if (typeof payload?.query === 'string') return search(payload)
      return { ok: true, ...info() }
    },
    search,
    mirror,
    listJobs,
    getJob,
    cancelJob,
    thumbnail,
    status: info,
    info,
    close: stop,
    stop
  }
}
