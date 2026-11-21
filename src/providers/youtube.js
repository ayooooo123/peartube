// YouTube provider plugin for PearTube relays:
//   - Searches YouTube through `ubit` (`info ytsearch:<query>`), one page, no account, no cookies
//   - Saves chosen videos' audio as the tracks of an album the caller names, into
//     `<staging>/<Artist> - <Album> (<Year>) [YouTube]/NN - Title.m4a`, pinned to a `yt:` release, then triggers a scan
//   - Every copy is lossy (AAC about 128 kbps, stream-copied, never re-wrapped): rows say so, and the `yt:` id keeps a
//     saved album from answering for an `mb:`/`discogs:`/`album:` release
//   - Jobs use the Soulseek provider's shape (`/v1/jobs`), without a peer, a queue place or a total size
// `info` and `download` are the relay's `ubitInfo` and `downloadPage` (src/identify.js), passed in: a host without
// them (the apps' worklet cannot run ubit) reports `unavailable`.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { MAX_TITLE, MEDIA_FILE } from '../protocol.js'
import { albumKey } from '../tags.js'
import { ALBUM_PIN, freePath, noteMirrored, safeSegment } from './staging.js'

// One page of results is all `ubit` returns.
export const YOUTUBE_SEARCH_CAP = 20
// Nominal rate of the AAC stream `ubit get -a` copies (itag 140; measured 129.5 kbps).
export const YOUTUBE_BITRATE = 128
const MAX_TRACKS = 100
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
// Empty answers in a row before the provider says the extractor may be out of date: when YouTube changes its result
// layout, `ubit` finds nothing and that cannot be told from a query with no results.
const EMPTY_STREAK = 3
const BOT_CHECK = /not a bot|sign in to confirm/i

// The `yt:` release an album saved from YouTube is pinned to: the same hash the importer gives an untagged folder as
// `album:<hex>`, so the two name one album without sharing an id.
export function youtubeRelease ({ artist, album, year }) {
  return `yt:${createHash('sha256').update(albumKey({ albumArtist: artist, album, year })).digest('hex').slice(0, 20)}`
}

export function normalizeYoutubeResults (info, limit = YOUTUBE_SEARCH_CAP) {
  const rows = []
  const seen = new Set()
  for (const e of Array.isArray(info?.entries) ? info.entries : []) {
    const videoId = typeof e?.id === 'string' ? e.id : ''
    if (!VIDEO_ID.test(videoId) || seen.has(videoId)) continue
    seen.add(videoId)
    const length = Number(e.duration)
    rows.push({
      title: String(e.title || '').trim().slice(0, 300) || videoId,
      length: Number.isFinite(length) && length > 0 ? Math.round(length) : null,
      size: null,
      bitrate: YOUTUBE_BITRATE,
      sample_rate: null,
      bit_depth: null,
      lossy: true,
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      channel: String(e.author || e.channel || e.uploader || '').trim().slice(0, 120) || null,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
    })
    if (rows.length >= limit) break
  }
  return rows
}

export function createYoutubePlugin ({
  storage,
  stagingRoot = join(storage, 'staging'),
  stagingLabel = 'storage',
  scanStaging = null,
  info: ubitInfo = null,
  download: downloadPage = null,
  searchTimeoutMs = 20_000,
  onchange = null
}) {
  const available = typeof ubitInfo === 'function' && typeof downloadPage === 'function'
  const jobs = new Map()
  const workRoot = join(storage, 'youtube-work')
  let closed = false
  // `ubit` holds one connection at a time, so saves run one after another across jobs.
  let chain = Promise.resolve()
  let lastSearchAt = null
  let lastResultCount = null
  let emptyStreak = 0
  let lastError = null
  // YouTube's bot check refuses every download from a network exit it distrusts (hosting ranges, some VPNs) while
  // search keeps working. It is the network's state, not one video's: set by a refused save, cleared by a saved one.
  let savesBlocked = false

  const unavailable = () => Object.assign(new Error('YouTube is not available on this device'), { status: 503 })

  async function search ({ query, limit = YOUTUBE_SEARCH_CAP, timeoutMs = searchTimeoutMs } = {}) {
    if (!available) throw unavailable()
    const q = String(query || '').trim().slice(0, 200)
    if (!q) throw Object.assign(new Error('query is required'), { status: 400 })
    const cap = Math.max(1, Math.min(YOUTUBE_SEARCH_CAP, Math.trunc(Number(limit)) || YOUTUBE_SEARCH_CAP))
    let candidates
    try {
      candidates = normalizeYoutubeResults(await ubitInfo(`ytsearch:${q}`, { timeoutMs: Math.max(1000, Math.min(45_000, Number(timeoutMs) || searchTimeoutMs)) }), cap)
      lastError = null
    } catch (err) {
      if (!/no youtube results/i.test(String(err?.message))) {
        lastError = String(err?.message || err).slice(0, 200)
        onchange?.()
        throw Object.assign(new Error(`YouTube search failed: ${lastError}`), { status: Number(err?.status) || 502 })
      }
      candidates = []
      lastError = null
    }
    lastSearchAt = Date.now()
    lastResultCount = candidates.length
    emptyStreak = candidates.length || q.length <= 3 ? 0 : emptyStreak + 1
    onchange?.()
    return { candidates, cap: YOUTUBE_SEARCH_CAP, truncated: false }
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

  // Artist and album come from the caller: a video title is not album metadata, and guessing it here would file
  // albums under whatever an uploader typed.
  async function mirror (payload = {}, ctx) {
    if (!available) throw unavailable()
    const artist = safeSegment(payload.artist, '').slice(0, 120)
    const album = safeSegment(payload.album, '').slice(0, 120)
    if (!artist || !album) throw Object.assign(new Error('artist and album are required'), { status: 400 })
    const yearMatch = /^(1[89]\d{2}|20\d{2})$/.exec(String(payload.year ?? '').trim())
    const year = yearMatch ? yearMatch[1] : ''
    const raw = Array.isArray(payload.tracks) ? payload.tracks : []
    if (raw.length > MAX_TRACKS) throw Object.assign(new Error(`An album takes at most ${MAX_TRACKS} tracks`), { status: 400 })
    const tracks = []
    const numbers = new Set()
    for (const [i, t] of raw.entries()) {
      const videoId = String(t?.videoId || '')
      if (!VIDEO_ID.test(videoId)) throw Object.assign(new Error(`Track ${i + 1} has no valid video id`), { status: 400 })
      const title = safeSegment(t.title, '').slice(0, 120)
      if (!title) throw Object.assign(new Error(`Track ${i + 1} has no title`), { status: 400 })
      const given = Math.trunc(Number(t.track))
      const track = given >= 1 && given <= 999 ? given : i + 1
      if (numbers.has(track)) throw Object.assign(new Error(`Two tracks are numbered ${track}`), { status: 400 })
      numbers.add(track)
      tracks.push({ videoId, title, track })
    }
    if (!tracks.length) throw Object.assign(new Error('tracks must list at least one video'), { status: 400 })

    const release = youtubeRelease({ artist, album, year })
    const albumTitle = `${artist} · ${album}`.slice(0, MAX_TITLE)
    // Its own folder, never the one a lossless copy of the same album sits in: the pin would re-file those tracks
    // under `yt:`.
    const folderName = safeSegment(`${artist} - ${album}${year ? ` (${year})` : ''} [YouTube]`, 'YouTube Album')
    const fileOf = (t, ext) => safeSegment(`${String(t.track).padStart(2, '0')} - ${t.title}`, String(t.track).padStart(2, '0')) + ext
    const jobId = randomUUID()
    const job = {
      jobId,
      id: release,
      title: albumTitle,
      plugin: 'youtube',
      source: 'youtube',
      channel: true,
      private: false,
      // 'queued' (behind another save) | 'transferring' | 'announcing' | 'done' | 'failed' | 'cancelled'
      status: 'queued',
      phase: 'queued',
      created: Date.now(),
      peer: null,
      queuePlace: null,
      file: fileOf(tracks[0], '.m4a'),
      fileIndex: 1,
      fileCount: tracks.length,
      speed: 0,
      bytes: 0,
      // YouTube does not state a size before the download, so there is never a percentage for the album.
      total: null,
      error: null,
      // Tracks that could not be saved while the rest of the album was: `[{ track, title, error }]`.
      skipped: [],
      note: null,
      progressAt: Date.now(),
      controller: { aborted: false, onabort: null }
    }
    trimJobs()
    jobs.set(jobId, job)
    onchange?.()

    const run = async () => {
      if (job.controller.aborted || closed) throw new Error('Cancelled')
      mkdirSync(workRoot, { recursive: true })
      const workDir = mkdtempSync(join(workRoot, 'job-'))
      try {
        const finalDir = join(stagingRoot, folderName)
        const placed = new Set()
        let doneBytes = 0
        for (const [i, t] of tracks.entries()) {
          if (job.controller.aborted || closed) throw new Error('Cancelled')
          Object.assign(job, { status: 'transferring', phase: 'downloading', file: fileOf(t, '.m4a'), fileIndex: i + 1, speed: 0, progressAt: Date.now() })
          onchange?.()
          const outDir = join(workDir, String(i + 1))
          mkdirSync(outDir)
          let rateAt = Date.now()
          let rateBytes = 0
          try {
            const dl = await downloadPage(`https://www.youtube.com/watch?v=${t.videoId}`, outDir, {
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
            if (!MEDIA_FILE.test(`x${ext}`)) throw new Error(`YouTube sent a file this relay does not import (${ext || 'no extension'})`)
            const size = statSync(dl.path).size
            if (!size) throw new Error('YouTube sent an empty file')
            // The pin goes in before the first file, so a scan that runs between the two already sees it.
            mkdirSync(finalDir, { recursive: true })
            writeFileSync(join(finalDir, ALBUM_PIN), JSON.stringify({ release, title: albumTitle, artist }) + '\n')
            const dst = freePath(finalDir, fileOf(t, ext))
            try {
              renameSync(dl.path, dst)
            } catch {
              writeFileSync(dst, readFileSync(dl.path))
              try { unlinkSync(dl.path) } catch {}
            }
            placed.add(basename(dst))
            noteMirrored(finalDir, [basename(dst)])
            doneBytes += size
            job.bytes = doneBytes
            savesBlocked = false
          } catch (err) {
            if (job.controller.aborted || closed) throw new Error('Cancelled')
            if (BOT_CHECK.test(String(err?.message))) {
              // Every other track would be refused the same way; asking again only deepens the block.
              savesBlocked = true
              throw Object.assign(new Error(`YouTube is refusing downloads from this relay's network (its bot check).${placed.size ? ` ${placed.size} of ${tracks.length} tracks were saved first.` : ''} Search still works; saving needs another network.`), { status: 503 })
            }
            // One video YouTube will not hand over (removed, age-gated, blocked here) does not lose the album.
            job.skipped.push({ track: t.track, title: t.title, error: String(err?.message || err).slice(0, 200) })
          }
        }
        if (!placed.size) {
          const first = job.skipped[0]
          throw Object.assign(new Error(tracks.length === 1 ? `YouTube did not send “${first.title}”: ${first.error}` : `YouTube sent none of the ${tracks.length} tracks. First reason: ${first.error}`), { status: 502 })
        }
        if (job.skipped.length) {
          job.note = `${job.skipped.length} of ${tracks.length} tracks not saved: ${job.skipped.map(s => `${s.title} (${s.error})`).join('; ')}`.slice(0, 600)
        }
        Object.assign(job, { status: 'announcing', phase: 'importing', speed: 0, progressAt: Date.now() })
        onchange?.()
        let scan = scanStaging ? await scanStaging(stagingRoot, ctx) : { scanned: 0, ingested: 0, items: [] }
        for (let retry = 0; retry < 20 && scan?.busy && !closed; retry++) {
          await new Promise(resolve => setTimeout(resolve, 250))
          scan = await scanStaging(stagingRoot, ctx)
        }
        Object.assign(job, {
          status: 'done',
          phase: 'done',
          size: doneBytes,
          bytes: doneBytes,
          total: doneBytes,
          sha256s: (scan?.items || []).filter(it => placed.has(it.file)).map(it => it.sha256)
        })
        onchange?.()
        return { jobId, id: release, folder: folderName, files: placed.size, bytes: doneBytes, ingested: scan?.ingested || 0, items: scan?.items || [], skipped: job.skipped }
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
        try { rmSync(workDir, { recursive: true, force: true }) } catch {}
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
    if (j.status === 'queued' || j.status === 'transferring') {
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
    const degraded = savesBlocked || emptyStreak >= EMPTY_STREAK
    let activeJobs = 0
    for (const j of jobs.values()) if (j.status === 'queued' || j.status === 'transferring' || j.status === 'announcing') activeJobs++
    return {
      status: !available ? 'unavailable' : degraded ? 'degraded' : 'ready',
      message: !available
        ? 'YouTube search needs the relay.'
        : savesBlocked
          ? 'YouTube is refusing downloads from this network. Search still works.'
          : degraded
            ? `YouTube search returned nothing ${emptyStreak} times; it may be out of date.`
            : lastError || '',
      // false = a save was refused by YouTube's bot check on this network and none has worked since.
      canSave: available && !savesBlocked,
      configured: available,
      available,
      activeJobs,
      searchCap: YOUTUBE_SEARCH_CAP,
      bitrate: YOUTUBE_BITRATE,
      staging: stagingLabel,
      lastSearchAt,
      lastResultCount,
      emptyStreak
    }
  }

  async function stop () {
    closed = true
    for (const j of jobs.values()) {
      if (j.status === 'queued' || j.status === 'transferring') {
        j.controller.aborted = true
        j.controller.onabort?.()
      }
    }
    await chain
  }

  return {
    name: 'youtube',
    description: 'Finds music on YouTube and saves its audio (AAC, lossy) as albums in the staging folder',
    async run (payload = {}, ctx) {
      if (!available) return { skipped: true, status: 'unavailable' }
      if (Array.isArray(payload?.tracks)) return mirror(payload, ctx)
      if (typeof payload?.query === 'string') return search(payload)
      return { ok: true, ...info() }
    },
    search,
    mirror,
    listJobs,
    getJob,
    cancelJob,
    stop,
    info
  }
}
