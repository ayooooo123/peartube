// Soulseek provider plugin for PearTube relays:
//   - Lazily loads `peartube-soulseek-bare` inside this Bare process (reports `unavailable` when no prebuild matches)
//   - Reads `slskUser`, `slskPass` and `slskServer` from settings.json; inert (`not_configured`) until both are set
//   - Searches Soulseek peers, ranking candidates by open slots + empty queue, queue depth, and lossless depth/rate
//   - Downloads albums one folder deep into `<staging>/<Artist> - <Album> (<Year>)/`, injecting `MUSICBRAINZ_ALBUMID`
//     when tags omit a release id and the caller supplied one, then triggers `watch-dir` (or direct folder import)
import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import b4a from 'b4a'
import { ID, MAX_TITLE, MEDIA_FILE, mediaFormat } from '../protocol.js'
import { parseTags } from '../tags.js'

// Maximum normalised file candidates returned by `POST /v1/providers/soulseek/search` after ranking.
export const SOULSEEK_SEARCH_CAP = 200
const DEFAULT_SERVER = 'vps.slsknet.org:2271'
const TAG_READ_LIMIT = 1024 * 1024

function parseServer (raw) {
  const clean = String(raw || '').trim() || DEFAULT_SERVER
  const m = /^([a-z0-9.:[\]-]{1,253}):(\d{1,5})$/i.exec(clean)
  const port = m ? Number(m[2]) : 2271
  return m && port >= 1 && port <= 65535
    ? { host: m[1].replace(/^\[|\]$/g, ''), port }
    : { host: 'vps.slsknet.org', port: 2271 }
}

function scrub (text, secrets) {
  let out = String(text || '')
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 2) out = out.split(s).join('[redacted]')
  }
  return out
}

function parseReleaseMbid (raw) {
  if (typeof raw !== 'string') return null
  const clean = raw.trim().toLowerCase().replace(/^mb:/, '').replace(/-/g, '')
  return /^[0-9a-f]{32}$/.test(clean) ? clean : null
}

function parsePathMbid (text) {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(String(text || ''))
  return m ? m[1].toLowerCase().replace(/-/g, '') : null
}

function safeSegment (raw, fallback) {
  const clean = String(raw || '')
    .replace(/[/\\:*?"<>|\x00-\x1f]+/g, ' ')
    .replace(/^[.@\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140)
    .replace(/[.\s]+$/, '')
  return clean || fallback
}

function peerFolderHint (files) {
  const first = String(files[0]?.filename || files[0] || '').replace(/\\/g, '/')
  const parts = first.split('/').map(s => s.trim()).filter(s => s && !s.startsWith('@@'))
  if (parts.length < 2) return null
  const albumDir = parts[parts.length - 2]
  const parentDir = parts.length >= 3 ? parts[parts.length - 3] : ''
  const yearMatch = /\b(1[89]\d{2}|20\d{2})\b/.exec(albumDir)
  const year = yearMatch ? yearMatch[1] : null
  const stripped = albumDir.replace(/\(\s*(1[89]\d{2}|20\d{2})\s*\)|\[\s*(1[89]\d{2}|20\d{2})\s*\]/g, '').trim()
  const split = stripped.split(/\s+[-–—]\s+/)
  if (split.length >= 2) {
    return { artist: split[0].trim(), album: split.slice(1).join(' - ').trim(), year }
  }
  return { artist: parentDir, album: stripped || albumDir, year }
}

function formatAlbumDir ({ artist, album, year, fallbackTitle }) {
  if (artist && album) {
    return safeSegment(`${artist} - ${album}${year ? ` (${year})` : ''}`, 'Mirrored Album')
  }
  if (fallbackTitle) {
    const clean = String(fallbackTitle).replace(/\s*·\s*/g, ' - ').trim()
    return safeSegment(clean, 'Mirrored Album')
  }
  if (album) {
    return safeSegment(`${album}${year ? ` (${year})` : ''}`, 'Mirrored Album')
  }
  return 'Unknown Artist - Mirrored Album'
}

function readHeadTags (filePath) {
  let fd = -1
  try {
    fd = openSync(filePath, 'r')
    const buf = b4a.alloc(Math.min(fstatSync(fd).size, TAG_READ_LIMIT))
    let read = 0
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, read)
      if (n <= 0) break
      read += n
    }
    return parseTags(read === buf.length ? buf : buf.subarray(0, read))
  } catch {
    return null
  } finally {
    if (fd >= 0) try { closeSync(fd) } catch {}
  }
}

// Writes `MUSICBRAINZ_ALBUMID=<mbid32>` directly into a downloaded FLAC (Vorbis comment) or MP3 (ID3v2.4/v2.3 TXXX)
// atomically when the file itself carries no release id, so the watch-dir tag reader announces `mb:<mbid>:sNNeMM`.
export function injectMusicBrainzAlbumId (filePath, mbid) {
  const clean = parseReleaseMbid(mbid)
  if (!clean) return false
  let buf
  try { buf = readFileSync(filePath) } catch { return false }
  if (buf.length < 4) return false
  const existing = parseTags(buf.subarray(0, Math.min(buf.length, TAG_READ_LIMIT)))
  if (existing?.mbid || existing?.discogs) return false
  const fmt = mediaFormat(buf)
  let updated = null
  if (fmt === 'flac' && b4a.toString(buf.subarray(0, 4), 'latin1') === 'fLaC') {
    updated = injectFlacMbid(buf, clean)
  } else if (fmt === 'mp3') {
    updated = injectMp3Mbid(buf, clean)
  }
  if (!updated) return false
  const tmp = `${filePath}.tag.tmp`
  writeFileSync(tmp, updated)
  renameSync(tmp, filePath)
  return true
}

function encodeVorbisBlock (vendor, pairs, isLast) {
  const enc = s => b4a.from(s, 'utf8')
  const vBuf = enc(vendor)
  const eBufs = pairs.map(s => enc(s))
  const parts = []
  const u32 = n => { const b = b4a.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b }
  parts.push(u32(vBuf.byteLength), vBuf, u32(eBufs.length))
  for (const e of eBufs) parts.push(u32(e.byteLength), e)
  const body = b4a.concat(parts)
  if (body.byteLength > 0xffffff) return null
  const head = b4a.from([
    (isLast ? 0x80 : 0) | 4,
    (body.byteLength >> 16) & 0xff,
    (body.byteLength >> 8) & 0xff,
    body.byteLength & 0xff
  ])
  return b4a.concat([head, body])
}

function injectFlacMbid (buf, mbid) {
  const entry = `MUSICBRAINZ_ALBUMID=${mbid}`
  let p = 4
  let blocks = []
  let vorbisIdx = -1
  let guard = 0
  while (p + 4 <= buf.length && guard++ < 128) {
    const head = buf[p]
    const last = (head & 0x80) !== 0
    const type = head & 0x7f
    const len = (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]
    if (p + 4 + len > buf.length) return null
    blocks.push({ type, last, start: p, end: p + 4 + len, body: buf.subarray(p + 4, p + 4 + len) })
    if (type === 4 && vorbisIdx === -1) vorbisIdx = blocks.length - 1
    p += 4 + len
    if (last) break
  }
  if (!blocks.length) return null
  const audioFrames = buf.subarray(p)
  if (vorbisIdx !== -1) {
    const blk = blocks[vorbisIdx]
    const body = blk.body
    let o = 0
    if (o + 4 > body.length) return null
    const vLen = body.readUInt32LE(o); o += 4
    if (o + vLen + 4 > body.length) return null
    const vendor = b4a.toString(body.subarray(o, o + vLen), 'utf8'); o += vLen
    const count = body.readUInt32LE(o); o += 4
    const pairs = []
    for (let i = 0; i < count && i < 512; i++) {
      if (o + 4 > body.length) break
      const n = body.readUInt32LE(o); o += 4
      if (o + n > body.length) break
      pairs.push(b4a.toString(body.subarray(o, o + n), 'utf8'))
      o += n
    }
    pairs.push(entry)
    const replaced = encodeVorbisBlock(vendor, pairs, blk.last)
    if (!replaced) return null
    return b4a.concat([buf.subarray(0, blk.start), replaced, buf.subarray(blk.end)])
  }
  const prevLast = blocks[blocks.length - 1]
  const clearedHead = b4a.from([prevLast.type & 0x7f, buf[prevLast.start + 1], buf[prevLast.start + 2], buf[prevLast.start + 3]])
  const added = encodeVorbisBlock('peartube', [entry], true)
  if (!added) return null
  return b4a.concat([
    buf.subarray(0, prevLast.start),
    clearedHead,
    prevLast.body,
    added,
    audioFrames
  ])
}

function synchsafe (n) {
  return b4a.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])
}

function injectMp3Mbid (buf, mbid) {
  const payload = b4a.concat([b4a.from([3]), b4a.from('MUSICBRAINZ_ALBUMID', 'utf8'), b4a.from([0]), b4a.from(mbid, 'utf8')])
  if (buf.length >= 10 && b4a.toString(buf.subarray(0, 3), 'latin1') === 'ID3' && (buf[3] === 3 || buf[3] === 4)) {
    const major = buf[3]
    const ss = b => b & 0x7f
    const tagSize = (ss(buf[6]) << 21) | (ss(buf[7]) << 14) | (ss(buf[8]) << 7) | ss(buf[9])
    if (10 + tagSize > buf.length) return null
    const fh = b4a.alloc(10)
    fh.write('TXXX', 0, 'latin1')
    if (major === 4) synchsafe(payload.byteLength).copy(fh, 4)
    else fh.writeUInt32BE(payload.byteLength, 4)
    const frame = b4a.concat([fh, payload])
    let pos = 10
    const end = 10 + tagSize
    while (pos + 10 <= end) {
      const id = b4a.toString(buf.subarray(pos, pos + 4), 'latin1')
      if (!/^[A-Z0-9]{4}$/.test(id)) break
      const fsz = major === 4
        ? (ss(buf[pos + 4]) << 21) | (ss(buf[pos + 5]) << 14) | (ss(buf[pos + 6]) << 7) | ss(buf[pos + 7])
        : buf.readUInt32BE(pos + 4)
      if (fsz <= 0 || pos + 10 + fsz > end) break
      pos += 10 + fsz
    }
    const usedBody = buf.subarray(10, pos)
    const newBody = b4a.concat([usedBody, frame])
    const newHead = b4a.from(buf.subarray(0, 10))
    synchsafe(newBody.byteLength).copy(newHead, 6)
    return b4a.concat([newHead, newBody, buf.subarray(end)])
  }
  const fh = b4a.alloc(10)
  fh.write('TXXX', 0, 'latin1')
  synchsafe(payload.byteLength).copy(fh, 4)
  const body = b4a.concat([fh, payload])
  const head = b4a.concat([b4a.from('ID3\x04\x00\x00', 'latin1'), synchsafe(body.byteLength)])
  return b4a.concat([head, body, buf])
}

// Normalises and ranks raw Soulseek search hits:
//   1. Open upload slots AND empty queue (`slots && queue === 0`) first
//   2. Smaller queue depth (`queue` ascending)
//   3. Higher bit depth, sample rate, and bitrate
export function normalizeSoulseekCandidates (hits, cap = SOULSEEK_SEARCH_CAP) {
  const out = []
  for (const h of Array.isArray(hits) ? hits : []) {
    if (!h || typeof h.username !== 'string' || typeof h.filename !== 'string') continue
    const filename = h.filename.trim()
    const username = h.username.trim()
    if (!username || !filename || !MEDIA_FILE.test(filename.replace(/\\/g, '/'))) continue
    const queue = Number.isFinite(Number(h.queue)) && Number(h.queue) >= 0 ? Math.trunc(Number(h.queue)) : 0
    const size = Number.isFinite(Number(h.size)) && Number(h.size) >= 0 ? Math.trunc(Number(h.size)) : 0
    const opt = v => Number.isFinite(Number(v)) && Number(v) > 0 ? Math.trunc(Number(v)) : null
    out.push({
      username,
      slots: Boolean(h.slots),
      queue,
      filename,
      size,
      bitrate: opt(h.bitrate),
      sample_rate: opt(h.sample_rate),
      bit_depth: opt(h.bit_depth),
      length: opt(h.length ?? h.length_secs)
    })
  }
  out.sort((a, b) => {
    const aReady = a.slots && a.queue === 0 ? 1 : 0
    const bReady = b.slots && b.queue === 0 ? 1 : 0
    if (aReady !== bReady) return bReady - aReady
    if (a.queue !== b.queue) return a.queue - b.queue
    if (a.slots !== b.slots) return a.slots ? -1 : 1
    const aDepth = a.bit_depth || 0
    const bDepth = b.bit_depth || 0
    if (aDepth !== bDepth) return bDepth - aDepth
    const aRate = a.sample_rate || 0
    const bRate = b.sample_rate || 0
    if (aRate !== bRate) return bRate - aRate
    const aBr = a.bitrate || 0
    const bBr = b.bitrate || 0
    if (aBr !== bBr) return bBr - aBr
    return a.filename.localeCompare(b.filename)
  })
  return out.slice(0, Math.max(1, Math.min(cap, SOULSEEK_SEARCH_CAP)))
}

export function createSoulseekPlugin ({
  storage,
  scanStaging = null,
  slskUser = '',
  slskPass = '',
  slskServer = DEFAULT_SERVER,
  searchTimeoutMs = 5000,
  onchange = null,
  loadAddon = null
}) {
  const stagingRoot = join(storage, 'staging')
  let creds = {
    user: String(slskUser || '').trim(),
    pass: String(slskPass || ''),
    server: String(slskServer || DEFAULT_SERVER).trim() || DEFAULT_SERVER
  }
  let addonState = 'unloaded' // 'unloaded' | 'loaded' | 'unavailable'
  let addonMod = null
  let addonPromise = null
  let client = null
  let clientKey = ''
  let loginPromise = null
  let closed = false
  const jobs = new Map() // jobId -> job record for /v1/jobs progress

  const secrets = () => [creds.pass, creds.user].filter(Boolean)
  const configured = () => Boolean(creds.user && creds.pass)

  async function ensureAddon () {
    if (addonState === 'loaded') return addonMod
    if (addonState === 'unavailable') return null
    if (!addonPromise) {
      addonPromise = (async () => {
        try {
          const mod = loadAddon ? await loadAddon() : await import('peartube-soulseek-bare')
          const resolved = mod?.Soulseek ? mod : mod?.default
          if (typeof resolved?.Soulseek !== 'function') throw new Error('Invalid Soulseek addon export')
          addonMod = resolved
          addonState = 'loaded'
          return addonMod
        } catch {
          addonState = 'unavailable'
          return null
        } finally {
          addonPromise = null
        }
      })()
    }
    return addonPromise
  }

  function closeClient () {
    loginPromise = null
    clientKey = ''
    if (!client) return
    try { client.close() } catch {}
    client = null
  }

  async function ensureLoggedIn () {
    if (closed) throw Object.assign(new Error('Soulseek plugin is closed'), { status: 503 })
    if (!configured()) throw Object.assign(new Error('Soulseek credentials are not configured'), { status: 400 })
    const mod = await ensureAddon()
    if (!mod) throw Object.assign(new Error('Soulseek addon is unavailable on this platform'), { status: 503 })
    const { host, port } = parseServer(creds.server)
    const wantKey = `${host}:${port}\n${creds.user}\n${creds.pass}`
    if (client && clientKey !== wantKey) closeClient()
    if (!client) {
      client = new mod.Soulseek()
      clientKey = wantKey
    }
    const st = client.state()
    if (st?.connected && st?.logged_in) return client
    if (!loginPromise) {
      loginPromise = client.login(host, port, creds.user, creds.pass)
        .then(res => {
          if (!res?.logged_in) throw new Error('Soulseek login rejected')
          return client
        })
        .catch(err => {
          closeClient()
          throw Object.assign(new Error(scrub(err?.message || 'Soulseek login failed', secrets())), { status: 502 })
        })
        .finally(() => { loginPromise = null })
    }
    return loginPromise
  }

  async function search ({ query, limit = SOULSEEK_SEARCH_CAP, timeoutMs = searchTimeoutMs } = {}) {
    if (!configured()) {
      await ensureAddon()
      throw Object.assign(new Error('Soulseek is not configured'), { status: 400 })
    }
    const q = String(query || '').trim()
    if (!q) throw Object.assign(new Error('query is required'), { status: 400 })
    const c = await ensureLoggedIn()
    const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Math.trunc(Number(limit)), SOULSEEK_SEARCH_CAP) : SOULSEEK_SEARCH_CAP
    const waitMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) >= 50 ? Math.min(Math.trunc(Number(timeoutMs)), 30_000) : searchTimeoutMs
    let hits
    try {
      hits = await c.search(q, waitMs)
    } catch (err) {
      throw Object.assign(new Error(scrub(err?.message || 'Soulseek search failed', secrets())), { status: 502 })
    }
    const candidates = normalizeSoulseekCandidates(hits, cap)
    return { candidates, cap: SOULSEEK_SEARCH_CAP, truncated: Array.isArray(hits) && hits.length > candidates.length }
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

  async function mirror (payload = {}, ctx) {
    if (!configured()) {
      await ensureAddon()
      throw Object.assign(new Error('Soulseek is not configured'), { status: 400 })
    }
    const username = String(payload.username || '').trim()
    if (!username) throw Object.assign(new Error('username is required'), { status: 400 })
    const rawFiles = Array.isArray(payload.files) ? payload.files : []
    const items = []
    for (const entry of rawFiles) {
      const filename = typeof entry === 'string' ? entry.trim() : String(entry?.filename || '').trim()
      if (!filename) continue
      const normPath = filename.replace(/\\/g, '/')
      const base = basename(normPath)
      if (!base || !MEDIA_FILE.test(base)) continue
      const size = typeof entry === 'object' && entry !== null && Number.isFinite(Number(entry.size)) && Number(entry.size) > 0
        ? Math.trunc(Number(entry.size))
        : 0
      items.push({ filename, base: safeSegment(base, 'track.flac'), size })
    }
    if (!items.length) throw Object.assign(new Error('files must list at least one audio file'), { status: 400 })

    const c = await ensureLoggedIn()
    const callerId = typeof payload.id === 'string' ? payload.id.trim().toLowerCase() : ''
    const callerMbid = parseReleaseMbid(callerId) || parseReleaseMbid(payload.releaseId) || parsePathMbid(items[0].filename)
    const rawTitle = typeof payload.title === 'string' ? payload.title.trim().slice(0, MAX_TITLE) : ''

    const jobId = randomUUID()
    const expectedTotal = items.reduce((sum, f) => sum + f.size, 0) || null
    const job = {
      jobId,
      id: (callerId && ID.test(callerId)) ? callerId : (callerMbid ? `mb:${callerMbid}` : null),
      title: rawTitle || peerFolderHint(items)?.album || 'Album download',
      plugin: 'soulseek',
      channel: true,
      private: false,
      status: 'running',
      created: Date.now(),
      bytes: 0,
      total: expectedTotal,
      error: null,
      cancelled: false
    }
    trimJobs()
    jobs.set(jobId, job)
    onchange?.()

    const workDir = join(storage, `.slsk-tmp-${jobId}`)
    mkdirSync(workDir, { recursive: true, mode: 0o700 })

    const runDownload = async () => {
      let completedBytes = 0
      let lastNotify = 0
      const downloaded = []
      try {
        for (let i = 0; i < items.length; i++) {
          if (closed || job.cancelled) throw new Error('Cancelled')
          const item = items[i]
          const usedNames = new Set(downloaded.map(d => d.name.toLowerCase()))
          let destName = item.base
          if (usedNames.has(destName.toLowerCase())) {
            const ext = extname(destName)
            const stem = basename(destName, ext)
            destName = `${String(i + 1).padStart(2, '0')} - ${stem}${ext}`
          }
          const tmpDest = join(workDir, destName)
          let fileTotal = item.size
          const res = await c.download(username, item.filename, tmpDest, prog => {
            const cur = Number(prog?.bytes) || 0
            const tot = Number(prog?.total) || fileTotal || 0
            if (tot > fileTotal && expectedTotal != null) {
              job.total = (job.total || 0) + (tot - fileTotal)
              fileTotal = tot
            }
            job.bytes = completedBytes + cur
            const now = Date.now()
            if (now - lastNotify >= 350) {
              lastNotify = now
              onchange?.()
            }
          })
          const finalSize = Number(res?.size) || statSync(tmpDest).size
          completedBytes += finalSize
          job.bytes = completedBytes
          if (job.total != null && completedBytes > job.total) job.total = completedBytes
          downloaded.push({ name: destName, tmpPath: tmpDest, size: finalSize })
          onchange?.()
        }

        if (closed || job.cancelled) throw new Error('Cancelled')
        job.status = 'announcing'
        onchange?.()

        // Inspect downloaded tags; prefer the peer's own MusicBrainz/Discogs release tags, else stamp caller's MBID.
        const tagList = downloaded.map(d => readHeadTags(d.tmpPath))
        const peerHasReleaseId = tagList.some(t => Boolean(t?.mbid || t?.discogs))
        if (!peerHasReleaseId && callerMbid) {
          for (const d of downloaded) injectMusicBrainzAlbumId(d.tmpPath, callerMbid)
        }
        const firstNamed = tagList.find(t => t && (t.album || t.albumArtist || t.artist))
        const hint = peerFolderHint(items)
        const folderName = formatAlbumDir({
          artist: firstNamed?.albumArtist || firstNamed?.artist || hint?.artist || '',
          album: firstNamed?.album || hint?.album || '',
          year: firstNamed?.year || hint?.year || '',
          fallbackTitle: rawTitle
        })
        if (!rawTitle && (firstNamed?.album || hint?.album)) {
          job.title = [firstNamed?.albumArtist || firstNamed?.artist || hint?.artist, firstNamed?.album || hint?.album]
            .filter(Boolean)
            .join(' · ')
            .slice(0, MAX_TITLE) || folderName
        }

        mkdirSync(stagingRoot, { recursive: true })
        const finalAlbumDir = join(stagingRoot, folderName)
        mkdirSync(finalAlbumDir, { recursive: true })
        for (const d of downloaded) {
          const dst = join(finalAlbumDir, d.name)
          try {
            renameSync(d.tmpPath, dst)
          } catch {
            writeFileSync(dst, readFileSync(d.tmpPath))
            try { unlinkSync(d.tmpPath) } catch {}
          }
          // When caller supplied a non-MusicBrainz explicit clip/imdb id on a single-track mirror, drop a sidecar only if needed.
          if (downloaded.length === 1 && !peerHasReleaseId && !callerMbid && callerId && ID.test(callerId)) {
            writeFileSync(`${dst}.json`, JSON.stringify({ id: callerId, title: job.title }))
          }
        }
        cleanupDir(workDir)

        const scanRes = scanStaging
          ? await scanStaging(stagingRoot, ctx)
          : { scanned: 0, ingested: 0, items: [] }

        // If watch-dir was momentarily busy on another file, wait briefly and scan once more so this job settles after ingest.
        let finalScan = scanRes
        if (scanRes?.busy && scanStaging) {
          for (let retry = 0; retry < 20 && finalScan?.busy && !closed; retry++) {
            await new Promise(resolve => setTimeout(resolve, 250))
            finalScan = await scanStaging(stagingRoot, ctx)
          }
        }

        Object.assign(job, {
          status: 'done',
          size: completedBytes,
          bytes: completedBytes,
          total: completedBytes
        })
        onchange?.()
        return {
          jobId,
          folder: folderName,
          files: downloaded.length,
          bytes: completedBytes,
          ingested: finalScan?.ingested || 0,
          items: finalScan?.items || []
        }
      } catch (err) {
        cleanupDir(workDir)
        if (!job.cancelled) {
          job.status = 'failed'
          job.error = scrub(err?.message || String(err), secrets())
        }
        onchange?.()
        throw Object.assign(new Error(job.error || 'Cancelled'), { status: err?.status || 502 })
      }
    }

    if (payload.wait === true) {
      return runDownload()
    }
    runDownload().catch(() => {})
    return { queued: true, job: publicSlskJob(job) }
  }

  function cleanupDir (dir) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }

  function publicSlskJob ({ cancelled: _c, ...rest }) {
    return { ...rest }
  }

  function listJobs () {
    return [...jobs.values()].map(publicSlskJob)
  }

  function getJob (jobId) {
    const j = jobs.get(jobId)
    return j ? publicSlskJob(j) : null
  }

  function cancelJob (jobId) {
    const j = jobs.get(jobId)
    if (!j) return null
    if (j.status === 'running' || j.status === 'queued') {
      j.cancelled = true
      j.status = 'cancelled'
      onchange?.()
      return publicSlskJob(j)
    }
    if (j.status !== 'announcing') {
      jobs.delete(jobId)
      onchange?.()
      return { ...publicSlskJob(j), status: 'removed' }
    }
    return publicSlskJob(j)
  }

  function configure ({ slskUser: nextUser, slskPass: nextPass, slskServer: nextServer } = {}) {
    let changed = false
    if (nextUser !== undefined && String(nextUser).trim() !== creds.user) {
      creds.user = String(nextUser).trim()
      changed = true
    }
    if (nextPass !== undefined && String(nextPass) !== creds.pass) {
      creds.pass = String(nextPass)
      changed = true
    }
    if (nextServer !== undefined) {
      const s = String(nextServer).trim() || DEFAULT_SERVER
      if (s !== creds.server) {
        creds.server = s
        changed = true
      }
    }
    if (changed) {
      closeClient()
      if (configured() && addonState === 'unloaded') {
        ensureAddon().then(() => { onchange?.() }, () => {})
      }
      onchange?.()
    }
  }

  function info () {
    // Probe addon availability lazily when configured, or report current known state without crashing.
    const isCfg = configured()
    if (addonState === 'unavailable') {
      return {
        status: 'unavailable',
        available: false,
        configured: isCfg,
        connected: false,
        activeJobs: [...jobs.values()].filter(j => j.status === 'running' || j.status === 'announcing').length,
        searchCap: SOULSEEK_SEARCH_CAP
      }
    }
    const st = client ? client.state() : null
    return {
      status: !isCfg ? 'not configured' : (st?.logged_in ? 'connected' : 'configured'),
      available: addonState === 'loaded' ? true : null,
      configured: isCfg,
      connected: Boolean(st?.logged_in),
      activeJobs: [...jobs.values()].filter(j => j.status === 'running' || j.status === 'announcing').length,
      searchCap: SOULSEEK_SEARCH_CAP
    }
  }

  async function stop () {
    closed = true
    for (const j of jobs.values()) {
      if (j.status === 'running' || j.status === 'queued') j.cancelled = true
    }
    closeClient()
  }

  // Probe addon availability lazily when configured so /v1/plugins stays unconfigured-inert when credentials are empty,
  // and reports `unavailable` when configured on a platform without a prebuild.
  if (configured()) ensureAddon().then(() => { onchange?.() }, () => {})

  return {
    name: 'soulseek',
    description: 'Finds and mirrors lossless albums from Soulseek peers into the one-level album staging folder',
    async run (payload = {}, ctx) {
      if (!configured()) {
        await ensureAddon()
        return { skipped: true, status: addonState === 'unavailable' ? 'unavailable' : 'not configured' }
      }
      if (payload?.action === 'search' || (typeof payload?.query === 'string' && !Array.isArray(payload?.files))) {
        return search(payload)
      }
      if (Array.isArray(payload?.files)) {
        return mirror(payload, ctx)
      }
      await ensureLoggedIn()
      return { ok: true, ...info() }
    },
    search,
    mirror,
    configure,
    listJobs,
    getJob,
    cancelJob,
    stop,
    info
  }
}
