// Rumble provider plugin for PearTube relays:
//   - Searches Rumble via `https://rumble.com/search/video?q=<query>` through the relay's SSRF-guarded fetch
//   - Parses video result cards (permalink, title, channel, duration, thumbnail URL cached internally)
//   - Saves chosen videos via `ubit` (`downloadPage`) into `<staging>/<Title> [Rumble]/`, or with `audio: true` into
//     `<staging>/<Artist> - <Album> [Rumble]/NN - Title.<ext>` pinned to an `rmb:` release, then triggers a scan
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import b4a from 'b4a'
import { MAX_TITLE, MEDIA_FILE } from '../protocol.js'
import { albumKey } from '../tags.js'
import { ALBUM_PIN, freePath, noteMirrored, safeSegment } from './staging.js'

export const NAME = 'rumble'
export const RUMBLE_SEARCH_CAP = 20
const MAX_TRACKS = 100
const RUMBLE_ID = /^v[a-z0-9]{2,32}$/i

export function rumbleRelease ({ artist, album, year }) {
  return `rmb:${createHash('sha256').update(albumKey({ albumArtist: artist, album, year })).digest('hex').slice(0, 20)}`
}

function asText (body) {
  if (typeof body === 'string') return body
  return body ? b4a.toString(body, 'utf8') : ''
}

function decodeHtml (raw) {
  return String(raw || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => {
      const cp = Number(n)
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => {
      const cp = parseInt(h, 16)
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
    })
}

function stripTags (raw) {
  return decodeHtml(String(raw || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

export function parseRumbleDuration (raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  const parts = s.split(':').map(p => Number(p.trim()))
  if (!parts.length || parts.length > 3 || parts.some(n => !Number.isFinite(n) || n < 0)) return null
  if (parts.length === 1) return parts[0] > 0 ? Math.round(parts[0]) : null
  let total = 0
  for (const n of parts) total = total * 60 + n
  return total > 0 ? Math.round(total) : null
}

function parseCard (chunk, siteOrigin, thumbUrls) {
  const linkMatch = /href=["']((?:https?:\/\/[^"']+)?\/(v[a-z0-9]{2,32})(?:-[^"'?#]*)?\.html(?:\?[^"']*)?)["']/i.exec(chunk)
  if (!linkMatch) return null
  const rumbleId = linkMatch[2].toLowerCase()
  let url
  try {
    url = new URL(linkMatch[1], siteOrigin).href
  } catch {
    return null
  }
  const h3Match = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(chunk)
  const titleAttrMatch = /class=["'][^"']*(?:video-item--a|thumbnail__link|title__link)[^"']*["'][^>]*title=["']([^"']+)["']/i.exec(chunk) ||
    /title=["']([^"']+)["'][^>]*class=["'][^"']*(?:video-item--a|thumbnail__link|title__link)[^"']*["']/i.exec(chunk)
  const altMatch = /<img[^>]+alt=["']([^"']+)["']/i.exec(chunk)
  const title = (stripTags(h3Match?.[1]) || decodeHtml(titleAttrMatch?.[1] || altMatch?.[1] || '').trim()).slice(0, 300) || rumbleId

  const channelMatch = /<(?:div|span|a)[^>]*class=["'][^"']*(?:video-item--by-a|channel__name|ellipsis-1)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span|a)>/i.exec(chunk) ||
    /<address[^>]*>([\s\S]*?)<\/address>/i.exec(chunk) ||
    /<a[^>]+href=["']\/(?:c|user)\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/i.exec(chunk)
  const channel = stripTags(channelMatch?.[1]).slice(0, 120) || null

  const durDataMatch = /class=["'][^"']*duration[^"']*["'][^>]*data-value=["']([^"']+)["']/i.exec(chunk) ||
    /data-value=["']([^"']+)["'][^>]*class=["'][^"']*duration[^"']*["']/i.exec(chunk)
  const durInnerMatch = /<(?:span|div)[^>]*class=["'][^"']*duration[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|div)>/i.exec(chunk)
  const length = parseRumbleDuration(durDataMatch?.[1] || stripTags(durInnerMatch?.[1]))

  const imgMatch = /<img[^>]+(?:data-src|src)=["']([^"']+)["'][^>]*>/i.exec(chunk)
  if (imgMatch && thumbUrls) {
    try {
      const thumbUrl = new URL(decodeHtml(imgMatch[1]), siteOrigin).href
      if (/^https?:\/\//i.test(thumbUrl)) {
        thumbUrls.set(rumbleId, thumbUrl)
        while (thumbUrls.size > 256) thumbUrls.delete(thumbUrls.keys().next().value)
      }
    } catch {}
  }

  return {
    title,
    channel,
    length,
    rumbleId,
    url,
    thumbnail: `/v1/providers/rumble/thumb/${rumbleId}`,
    video: true
  }
}

export function parseRumbleSearchHtml (html, { limit = RUMBLE_SEARCH_CAP, siteOrigin = 'https://rumble.com', thumbUrls = null } = {}) {
  const text = String(html || '')
  const rows = []
  const seen = new Set()
  const add = card => {
    if (!card || seen.has(card.rumbleId)) return
    seen.add(card.rumbleId)
    rows.push(card)
  }

  const cardSplit = text.split(/(?=<li[^>]*video-listing-entry|<div[^>]*class=["'][^"']*\bvideostream\b[^"']*["']|<article[^>]*video-item)/i)
  if (cardSplit.length > 1) {
    for (const chunk of cardSplit.slice(1)) {
      add(parseCard(chunk, siteOrigin, thumbUrls))
      if (rows.length >= limit) return rows
    }
  }

  if (!rows.length) {
    const linkRe = /<a[^>]+href=["']((?:https?:\/\/[^"']+)?\/(v[a-z0-9]{2,32})(?:-[^"'?#]*)?\.html(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi
    let m
    while ((m = linkRe.exec(text)) !== null) {
      const snippet = text.slice(Math.max(0, m.index - 400), Math.min(text.length, m.index + m[0].length + 600))
      add(parseCard(snippet, siteOrigin, thumbUrls))
      if (rows.length >= limit) break
    }
  }

  return rows
}

export function createRumblePlugin ({
  storage,
  stagingRoot = join(storage, 'staging'),
  stagingLabel = 'storage',
  placeAndScan = null,
  download: downloadPage = null,
  fetchBytes = null,
  searchBase = 'https://rumble.com/search/video',
  siteOrigin = 'https://rumble.com',
  searchTimeoutMs = 20_000,
  onchange = null
}) {
  const canSearch = typeof fetchBytes === 'function'
  const canSave = typeof downloadPage === 'function'
  const available = canSearch && canSave
  const jobs = new Map()
  const thumbUrls = new Map()
  const thumbs = new Map()
  const workRoot = join(storage, 'rumble-work')
  if (canSave) try { rmSync(workRoot, { recursive: true, force: true }) } catch {}
  let closed = false
  let chain = Promise.resolve()
  let lastSearchAt = null
  let lastResultCount = null
  let lastError = null

  const unavailable = () => Object.assign(new Error('Rumble is not available on this device'), { status: 503 })

  async function search ({ query, limit = RUMBLE_SEARCH_CAP, timeoutMs = searchTimeoutMs } = {}) {
    if (!canSearch) throw unavailable()
    const q = String(query || '').trim().slice(0, 200)
    if (!q) throw Object.assign(new Error('query is required'), { status: 400 })
    const cap = Math.max(1, Math.min(RUMBLE_SEARCH_CAP, Math.trunc(Number(limit)) || RUMBLE_SEARCH_CAP))
    const ms = Math.max(1000, Math.min(45_000, Number(timeoutMs) || searchTimeoutMs))
    let candidates
    try {
      const sep = searchBase.includes('?') ? '&' : '?'
      const url = `${searchBase}${sep}q=${encodeURIComponent(q)}`
      const res = await fetchBytes(url, { timeoutMs: ms, maxBytes: 4 * 1024 * 1024, headers: { accept: 'text/html' } })
      if (res.status < 200 || res.status >= 300) {
        throw Object.assign(new Error(`Rumble answered ${res.status}`), { status: res.status === 429 ? 429 : 502 })
      }
      candidates = parseRumbleSearchHtml(asText(res.body), { limit: cap + 1, siteOrigin, thumbUrls })
      lastError = null
    } catch (err) {
      lastError = String(err?.message || err).slice(0, 200)
      onchange?.()
      throw Object.assign(new Error(`Rumble search failed: ${lastError}`), { status: Number(err?.status) || 502 })
    }
    lastSearchAt = Date.now()
    lastResultCount = candidates.length
    onchange?.()
    return { candidates: candidates.slice(0, cap), cap: RUMBLE_SEARCH_CAP, truncated: candidates.length > cap }
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

  function resolveItemUrl (item) {
    if (typeof item?.url === 'string' && /^https?:\/\//i.test(item.url.trim())) return item.url.trim()
    const rid = String(item?.rumbleId || '').trim()
    if (RUMBLE_ID.test(rid)) return `${siteOrigin.replace(/\/+$/, '')}/${rid.toLowerCase()}.html`
    return ''
  }

  async function mirror (payload = {}, ctx) {
    if (!canSave) throw unavailable()
    const audio = Boolean(payload.audio)
    const yearMatch = /^(1[89]\d{2}|20\d{2})$/.exec(String(payload.year ?? '').trim())
    const year = yearMatch ? yearMatch[1] : ''
    let rawItems
    let artist = ''
    let album = ''
    let title = ''
    let entryId = ''
    let folderName = ''

    if (audio) {
      const hasTracks = Array.isArray(payload.tracks)
      if (hasTracks) {
        artist = safeSegment(payload.artist, '').slice(0, 120)
        album = safeSegment(payload.album, '').slice(0, 120)
        if (!artist || !album) throw Object.assign(new Error('artist and album are required'), { status: 400 })
        rawItems = payload.tracks
      } else {
        const rawTitle = safeSegment(payload.title, '').slice(0, 120)
        if (!rawTitle) throw Object.assign(new Error('title is required'), { status: 400 })
        artist = safeSegment(payload.artist, 'Rumble').slice(0, 120)
        album = safeSegment(payload.album || rawTitle, rawTitle).slice(0, 120)
        rawItems = [{ title: rawTitle, url: payload.url, rumbleId: payload.rumbleId, track: 1 }]
      }
      if (rawItems.length > MAX_TRACKS) throw Object.assign(new Error(`An album takes at most ${MAX_TRACKS} tracks`), { status: 400 })
      entryId = rumbleRelease({ artist, album, year })
      title = `${artist} · ${album}`.slice(0, MAX_TITLE)
      folderName = `${safeSegment(`${artist} - ${album}${year ? ` (${year})` : ''}`, 'Album').slice(0, 128).trimEnd()} [Rumble]`
    } else {
      rawItems = Array.isArray(payload.tracks) && payload.tracks.length
        ? payload.tracks
        : [{ title: payload.title, url: payload.url, rumbleId: payload.rumbleId }]
      const primaryTitle = safeSegment(payload.title || rawItems[0]?.title, '').slice(0, 120)
      if (!primaryTitle) throw Object.assign(new Error('title is required'), { status: 400 })
      title = primaryTitle.slice(0, MAX_TITLE)
      const rid = String(payload.rumbleId || rawItems[0]?.rumbleId || '').trim().toLowerCase()
      entryId = RUMBLE_ID.test(rid)
        ? `rmb:${rid}`
        : `clip:${createHash('sha256').update(resolveItemUrl(rawItems[0]) || title).digest('hex').slice(0, 12)}`
      folderName = `${safeSegment(primaryTitle, 'Video').slice(0, 128).trimEnd()} [Rumble]`
    }

    const items = []
    const numbers = new Set()
    for (const [i, t] of rawItems.entries()) {
      const url = resolveItemUrl(t)
      if (!url) throw Object.assign(new Error(`Item ${i + 1} has no valid URL or rumbleId`), { status: 400 })
      const itemTitle = safeSegment(t?.title || title, '').slice(0, 120)
      if (!itemTitle) throw Object.assign(new Error(`Item ${i + 1} has no title`), { status: 400 })
      const given = Math.trunc(Number(t?.track))
      const track = given >= 1 && given <= 999 ? given : i + 1
      if (audio) {
        if (numbers.has(track)) throw Object.assign(new Error(`Two tracks are numbered ${track}`), { status: 400 })
        numbers.add(track)
      }
      const rid = String(t?.rumbleId || '').trim().toLowerCase()
      items.push({ url, title: itemTitle, track, rumbleId: RUMBLE_ID.test(rid) ? rid : '' })
    }
    if (!items.length) throw Object.assign(new Error('At least one video is required'), { status: 400 })

    const fileOf = (item, ext) => audio
      ? safeSegment(`${String(item.track).padStart(2, '0')} - ${item.title}`, String(item.track).padStart(2, '0')) + ext
      : safeSegment(item.title, 'Video') + ext
    const defaultExt = audio ? '.m4a' : '.mp4'
    const jobId = randomUUID()
    const job = {
      jobId,
      id: entryId,
      title,
      plugin: NAME,
      source: NAME,
      audio,
      channel: true,
      private: false,
      status: 'queued',
      phase: 'queued',
      created: Date.now(),
      peer: null,
      queuePlace: null,
      file: fileOf(items[0], defaultExt),
      fileIndex: 1,
      fileCount: items.length,
      speed: 0,
      bytes: 0,
      total: null,
      error: null,
      skipped: [],
      note: null,
      progressAt: Date.now(),
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
        for (const [i, item] of items.entries()) {
          if (job.controller.aborted || closed) throw new Error('Cancelled')
          Object.assign(job, { status: 'transferring', phase: 'downloading', file: fileOf(item, defaultExt), fileIndex: i + 1, speed: 0, progressAt: Date.now() })
          onchange?.()
          const outDir = join(workDir, String(i + 1))
          mkdirSync(outDir)
          let rateAt = Date.now()
          let rateBytes = 0
          try {
            const dl = await downloadPage(item.url, outDir, {
              audio,
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
            if (!MEDIA_FILE.test(`x${ext}`)) throw new Error(`Rumble sent a file this relay does not import (${ext || 'no extension'})`)
            const size = statSync(dl.path).size
            if (!size) throw new Error('Rumble sent an empty file')
            got.push({ item, path: dl.path, ext })
            doneBytes += size
            job.bytes = doneBytes
          } catch (err) {
            if (job.controller.aborted || closed) throw new Error('Cancelled')
            const reason = String(err?.message || err).slice(0, 200)
            job.skipped.push({ track: item.track, title: item.title, error: reason })
          }
        }
        if (!got.length) {
          const first = job.skipped[0]
          throw Object.assign(new Error(items.length === 1
            ? `Rumble did not send “${first.title}”: ${first.error}`
            : `Rumble sent none of the ${items.length} items. First reason: ${first.error}`), { status: 502 })
        }
        if (job.skipped.length) {
          job.note = `${job.skipped.length} of ${items.length} items not saved: ${job.skipped.map(s => `${s.title} (${s.error})`).join('; ')}`.slice(0, 600)
        }
        const finalDir = join(stagingRoot, folderName)
        const placed = new Set()
        const place = () => {
          if (audio) {
            const pinPath = join(finalDir, ALBUM_PIN)
            let pinned = null
            try { pinned = JSON.parse(readFileSync(pinPath, 'utf8'))?.release } catch {}
            let held = []
            try { held = readdirSync(finalDir).filter(n => !/^[.@]/.test(n)) } catch {}
            if (pinned ? pinned !== entryId : held.length) throw Object.assign(new Error(`The folder “${folderName}” already holds other files`), { status: 409 })
            mkdirSync(finalDir, { recursive: true })
            writeFileSync(pinPath, JSON.stringify({ release: entryId, title, artist }) + '\n')
          } else {
            mkdirSync(finalDir, { recursive: true })
          }
          for (const g of got) {
            const dst = freePath(finalDir, fileOf(g.item, g.ext))
            try {
              renameSync(g.path, dst)
            } catch {
              copyFileSync(g.path, dst)
            }
            if (!audio) {
              const sidecarId = g.item.rumbleId ? `rmb:${g.item.rumbleId}` : entryId
              writeFileSync(`${dst}.json`, JSON.stringify({ id: sidecarId, title: g.item.title }) + '\n')
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
          const g = got.find(x => fileOf(x.item, x.ext) === f.file)
          job.skipped.push({ track: g?.item.track ?? null, title: g?.item.title || f.file, error: `Not imported: ${String(f.error).slice(0, 160)}` })
        }
        const imported = placed.size - refusedImport.length
        if (!imported) throw Object.assign(new Error(`The relay could not import the saved media: ${refusedImport[0].error}`), { status: 500 })
        if (job.skipped.length) {
          job.note = `${job.skipped.length} of ${items.length} items not saved: ${job.skipped.map(s => `${s.title} (${s.error})`).join('; ')}`.slice(0, 600)
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
        return { jobId, id: entryId, folder: folderName, files: imported, bytes: doneBytes, ingested: scan?.ingested || 0, items: scan?.items || [], skipped: job.skipped }
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
      message: !available ? 'Rumble search needs the relay.' : lastError || '',
      canSave,
      configured: available,
      available,
      activeJobs,
      searchCap: RUMBLE_SEARCH_CAP,
      staging: stagingLabel,
      lastSearchAt,
      lastResultCount
    }
  }

  async function thumbnail (rumbleId) {
    const id = String(rumbleId || '').toLowerCase()
    const thumbUrl = thumbUrls.get(id)
    if (!fetchBytes || !RUMBLE_ID.test(id) || !thumbUrl) return null
    if (!thumbs.has(id)) {
      const pending = fetchBytes(thumbUrl, { timeoutMs: 8000, maxBytes: 512 * 1024 }).then(
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
    description: 'Finds videos on Rumble and saves video or audio into the staging folder',
    async run (payload = {}, ctx) {
      if (!available) return { skipped: true, status: 'unavailable' }
      if (Array.isArray(payload?.tracks) || typeof payload?.url === 'string' || typeof payload?.rumbleId === 'string') return mirror(payload, ctx)
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
