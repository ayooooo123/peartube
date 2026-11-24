// Soulseek provider plugin for PearTube relays:
//   - Lazily loads `peartube-soulseek-bare` inside this Bare process (reports `unavailable` when no prebuild matches)
//   - Reads `slskUser`, `slskPass`, `slskServer` and `slskListenPort` from settings.json; inert (`not_configured`)
//     until user and password are set
//   - Searches Soulseek peers, ranking candidates by open slots + empty queue, queue depth, and lossless depth/rate
//   - Browses one peer's shared media (cached in memory for a few minutes) so a folder can be inspected before mirroring
//   - Downloads albums one folder deep into `<staging>/<Artist> - <Album> (<Year>)/` (the relay's swept import folder),
//     never rewriting peer bytes; a caller-supplied release id pins the folder to that album, then triggers a scan.
//     A single track lands in its album's folder as `NN - Title.ext`, or fails when nothing names its album
//   - Jobs report `queued` (waiting on the peer) / `transferring` / `failed` with a plain reason; a peer that never
//     answers or never connects back fails the job instead of leaving it at 0 bytes
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { basename, extname, join } from 'node:path'
import b4a from 'b4a'
import { ID, MAX_TITLE, MEDIA_FILE } from '../protocol.js'
import { albumKey, parseTags } from '../tags.js'
import { ALBUM_PIN, formatAlbumDir, freePath, noteMirrored, safeSegment } from './staging.js'

// Maximum normalised file candidates returned by `POST /v1/providers/soulseek/search` after ranking.
export const SOULSEEK_SEARCH_CAP = 200
const DEFAULT_SERVER = 'vps.slsknet.org:2271'
// Peers open file connections back to this TCP port; it must be published/forwarded for downloads to arrive.
export const DEFAULT_LISTEN_PORT = 50300
export const DEFAULT_SHARE_MAX_FILES = 2000
const TAG_READ_LIMIT = 1024 * 1024
const BROWSE_TIMEOUT_MS = 30_000
const BROWSE_TTL_MS = 5 * 60_000
const BROWSE_CACHE_MAX = 16
// A download whose peer never answers (no queue place, no transfer) or says "ready" but never opens the file
// connection is failed with the reason; a peer that reported a queue place is waited on.
const NO_ANSWER_MS = 3 * 60_000
const NO_CONNECT_MS = 90_000
const DURABLE_RETRY_BACKOFF_MS = [5_000, 15_000, 45_000, 120_000, 300_000]
const MAX_AUTO_WAKE_RESUMES = 3
const STALE_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000
const JOBS_FILENAME = 'soulseek-jobs.json'

function isTransientError (err) {
  const msg = String(err?.message || err || '')
  if (msg === 'Cancelled' || err?.reason === 'unplaced' || err?.status === 400 || err?.status === 422) return false
  if (msg.includes('refused the file:') || /upload denied/i.test(msg)) return false
  return true
}

function existingTrackSize (tmpDest, item, completedFiles, destName) {
  if (!existsSync(tmpDest)) return 0
  let existingSize = 0
  try { existingSize = statSync(tmpDest).size || 0 } catch {
    // ast-grep-ignore: js-no-empty-catch -- unreadable partial treated as missing
    return 0
  }
  const recordedDone = completedFiles.includes(destName)
  if ((recordedDone && existingSize > 0) || (item.size > 0 && existingSize === item.size)) {
    return existingSize
  }
  return 0
}

function partLen (dest) {
  try {
    return statSync(`${dest}.part`).size || 0
  } catch {
    // ast-grep-ignore: js-no-empty-catch -- missing .part file means 0 bytes resumed
    return 0
  }
}

// Plain-English reason for a failed browse or download; `reason` tags the cause so `info()` can flag the listen port.
function peerError (err, username, port, secrets) {
  const msg = String(err?.message || err || '')
  const at = port ? `port ${port}` : 'its Soulseek port'
  if (/indirect connection/i.test(msg)) {
    return Object.assign(new Error(`Could not connect to ${username}: it is offline, or behind a firewall while peers cannot reach this relay on ${at}.`), { status: 502, reason: 'no-inbound' })
  }
  if (/timed out/i.test(msg)) {
    return Object.assign(new Error(`${username} did not answer: it may be offline, or unable to reach this relay on ${at}.`), { status: 504, reason: 'no-answer' })
  }
  const denied = /upload denied by peer: (.*)$/i.exec(msg)
  if (denied) return Object.assign(new Error(`${username} refused the file: ${scrub(denied[1] || 'no reason given', secrets).replace(/\.+$/, '')}.`), { status: 502, reason: 'refused' })
  if (/upload failed/i.test(msg)) return Object.assign(new Error(`${username} could not send the file (upload failed on their side).`), { status: 502, reason: 'refused' })
  return Object.assign(new Error(scrub(msg || 'Soulseek request failed', secrets)), { status: Number(err?.status) || 502, reason: 'error' })
}

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

// The album release a caller names: `mb:<32hex>`, `discogs:r<n>` or `album:<20hex>`, bare or as a track id
// (`mb:<32hex>:s01e02`), or a bare/hyphenated MusicBrainz release id.
function parseRelease (raw) {
  if (typeof raw !== 'string') return null
  const clean = raw.trim().toLowerCase()
  const m = /^(mb:[0-9a-f]{32}|discogs:r\d{1,12}|album:[0-9a-f]{20})(?::s\d{2}e\d{2,3})?$/.exec(clean)
  if (m) return m[1]
  const mb = clean.replace(/^mb:/, '').replace(/-/g, '')
  return /^[0-9a-f]{32}$/.test(mb) ? `mb:${mb}` : null
}

// The album a peer's folder names: `Artist - Album (Year)`, or `Album` under an `Artist` folder, or `Year - Album`
// under one. A `CD1`/`Disc 2` folder is a disc of the album above it.
function peerFolderHint (files) {
  const first = String(files[0]?.filename || files[0] || '').replace(/\\/g, '/')
  const parts = first.split('/').map(s => s.trim()).filter(s => s && !s.startsWith('@@'))
  if (parts.length < 2) return null
  const at = parts.length >= 3 && /^(cd|disc|disk)\s*\d{1,2}$/i.test(parts[parts.length - 2]) ? parts.length - 3 : parts.length - 2
  const albumDir = parts[at]
  const parentDir = at >= 1 ? parts[at - 1] : ''
  const yearMatch = /\b(1[89]\d{2}|20\d{2})\b/.exec(albumDir)
  const year = yearMatch ? yearMatch[1] : null
  const stripped = albumDir.replace(/\(\s*(1[89]\d{2}|20\d{2})\s*\)|\[\s*(1[89]\d{2}|20\d{2})\s*\]/g, '').trim()
  const split = stripped.split(/\s+[-–—]\s+/)
  if (split.length >= 2 && /^(1[89]\d{2}|20\d{2})$/.test(split[0].trim())) {
    return { artist: parentDir, album: split.slice(1).join(' - ').trim(), year }
  }
  if (split.length >= 2) {
    return { artist: split[0].trim(), album: split.slice(1).join(' - ').trim(), year }
  }
  return { artist: parentDir, album: stripped || albumDir, year }
}

// Where one mirrored track goes, or why it cannot go anywhere. A lone file has no neighbours to name its album, so it
// needs its own: the album from its tags, else from its folder on the peer ("Artist - Album (Year)"); the track
// number from its tags, else the caller's, else the leading number of its file name, else the place it sorts at in
// its folder on the peer (`position`; vinyl rips are named by side, "A1".."B6"). Its folder is pinned to that
// release (the one the importer would hash from the same names, so it joins the rest of the album) and the file is
// named `NN - Title.ext`. Without an album or a number it is an error, never a clip.
export function placeSingleTrack ({ tags, filename, release = null, track: givenTrack = null, position = null, fallbackTitle = '' }) {
  const path = String(filename || '').replace(/\\/g, '/')
  const leaf = path.split('/').pop() || ''
  const ext = extname(leaf) || '.flac'
  const stem = basename(leaf, extname(leaf))
  const hint = peerFolderHint([path])
  const taggedAlbum = Boolean(tags?.album)
  const artist = (taggedAlbum ? tags.albumArtist || tags.artist : hint?.artist || tags?.albumArtist || tags?.artist) || ''
  const album = (taggedAlbum ? tags.album : hint?.album) || ''
  const year = (taggedAlbum ? tags.year : hint?.year || tags?.year) || ''
  if (!album && !release && !tags?.mbid && !tags?.discogs) {
    return { error: `Could not place “${leaf}”: it has no album tag and its folder on the peer does not name an album. Mirror its whole folder instead.` }
  }
  const fromName = /^(\d{1,3})(?!\d)/.exec(stem)
  const track = tags?.track || givenTrack || (fromName ? Number(fromName[1]) : 0) || position || 0
  if (!(track >= 1 && track <= 999)) {
    return { error: `Could not place “${leaf}”: neither its tags, its file name nor its folder on the peer give a track number.` }
  }
  const title = tags?.title || stem.replace(fromName ? /^\d{1,3}\s*[-._ ]*\s*/ : /^[a-h]\d{1,2}(?!\d)\s*[-._ ]*\s*/i, '').trim() || stem
  const pin = release ||
    (tags?.mbid ? `mb:${tags.mbid}` : tags?.discogs ? `discogs:r${tags.discogs}` : `album:${createHash('sha256').update(albumKey({ albumArtist: artist, album, year })).digest('hex').slice(0, 20)}`)
  return {
    // A release known only by its id still gets a folder of its own, never one shared with other unnamed albums.
    folder: formatAlbumDir({ artist, album, year, fallbackTitle: album ? '' : fallbackTitle || `Release ${pin.replace(/:/g, ' ')}` }),
    file: safeSegment(`${String(track).padStart(2, '0')} - ${title}`, String(track).padStart(2, '0')) + ext,
    release: pin,
    albumTitle: [artist, album].filter(Boolean).join(' · ').slice(0, MAX_TITLE),
    trackTitle: title,
    from: release ? 'release' : taggedAlbum || tags?.mbid || tags?.discogs ? 'tags' : 'peer folder'
  }
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

// One raw addon record (search hit or browse entry) in the shape the API returns, or null when it is not media.
function normalizeRecord (h) {
  if (!h || typeof h.username !== 'string' || typeof h.filename !== 'string') return null
  const filename = h.filename.trim()
  const username = h.username.trim()
  if (!username || !filename || !MEDIA_FILE.test(filename.replace(/\\/g, '/'))) return null
  const queue = Number.isFinite(Number(h.queue)) && Number(h.queue) >= 0 ? Math.trunc(Number(h.queue)) : 0
  const size = Number.isFinite(Number(h.size)) && Number(h.size) >= 0 ? Math.trunc(Number(h.size)) : 0
  const opt = v => Number.isFinite(Number(v)) && Number(v) > 0 ? Math.trunc(Number(v)) : null
  return {
    username,
    slots: Boolean(h.slots),
    queue,
    filename,
    size,
    bitrate: opt(h.bitrate),
    sample_rate: opt(h.sample_rate),
    bit_depth: opt(h.bit_depth),
    length: opt(h.length ?? h.length_secs)
  }
}

// Normalises and ranks raw Soulseek search hits:
//   1. Open upload slots AND empty queue (`slots && queue === 0`) first
//   2. Smaller queue depth (`queue` ascending)
//   3. Higher bit depth, sample rate, and bitrate
export function normalizeSoulseekCandidates (hits, cap = SOULSEEK_SEARCH_CAP) {
  const out = []
  for (const h of Array.isArray(hits) ? hits : []) {
    const rec = normalizeRecord(h)
    if (rec) out.push(rec)
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

// A peer's browse reply as `{ username, files, tracks, size }`: media files only (same row shape as search),
// ordered by path so a client can group them into folders in one pass.
export function normalizeSoulseekBrowse (records, username) {
  const files = []
  let size = 0
  for (const h of Array.isArray(records) ? records : []) {
    const rec = normalizeRecord(h && typeof h.username !== 'string' ? { ...h, username } : h)
    if (!rec) continue
    files.push(rec)
    size += rec.size
  }
  files.sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0)
  return { username, files, tracks: files.length, size }
}

export function createSoulseekPlugin ({
  storage,
  // The folder mirrors land in: the relay passes the root `watch-dir` sweeps; a bare plugin uses `<storage>/staging`.
  stagingRoot = join(storage, 'staging'),
  stagingLabel = 'storage',
  // `(place, ctx, { cancelled }) => scan result`: the host runs `place` once no other import holds the folder and
  // imports in the same step. Without it (a bare plugin) the files are only placed.
  placeAndScan = null,
  slskUser = '',
  slskPass = '',
  slskServer = DEFAULT_SERVER,
  searchTimeoutMs = 5000,
  // 0 lets the OS pick a port each start, which cannot be published; the relay setting defaults to 50300.
  slskListenPort = DEFAULT_LISTEN_PORT,
  // Advertise and serve the album folders to peers; the addon caps the index at `slskShareMaxFiles`.
  slskShare = false,
  slskShareMaxFiles = DEFAULT_SHARE_MAX_FILES,
  browseTimeoutMs = BROWSE_TIMEOUT_MS,
  noAnswerMs = NO_ANSWER_MS,
  noConnectMs = NO_CONNECT_MS,
  persistJobs = false,
  onchange = null,
  loadAddon = null
}) {
  const listenPort = Number.isInteger(Number(slskListenPort)) && Number(slskListenPort) >= 0 && Number(slskListenPort) <= 65535 ? Number(slskListenPort) : DEFAULT_LISTEN_PORT
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
  const jobMeta = new Map() // jobId -> { request, items, workDir, completedFiles, activeRunner, transientFailure, autoResumes }
  const wakeListeners = new Set()
  let hostCtx = null
  const browseCache = new Map() // username -> { at, promise }
  // Evidence about the listen port this session: failures that mean "a peer could not reach us", and transfers that
  // moved bytes. The relay cannot probe its own public port, so the UI warns from these.
  let inboundFailures = 0
  let lastInboundFailure = null
  let transfersOk = 0

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
      // The addon takes its share options from the environment when a client is made (its constructor has only
      // `listenPort`), so the relay's settings are handed over there, overriding any env value the host set.
      process.env.PEARTUBE_SLSK_SHARE = slskShare ? '1' : '0'
      process.env.PEARTUBE_SLSK_SHARE_MAX_FILES = String(slskShareMaxFiles)
      client = new mod.Soulseek({ listenPort })
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
    remember(candidates)
    return { candidates, cap: SOULSEEK_SEARCH_CAP, truncated: Array.isArray(hits) && hits.length > candidates.length }
  }

  // The port peers are told to connect back to: the bound port once a client exists, else the configured one.
  const advertisedPort = () => (client ? Number(client.state()?.listen_port) || 0 : listenPort)

  // Files this relay has seen a peer share (search hits, browse replies), so a mirror request that names a file by its
  // bare name, or without a size, still asks for the peer's real path and can show a percentage from the start.
  const seenFiles = new Map()
  function remember (rows) {
    if (seenFiles.size > 50_000) seenFiles.clear()
    for (const r of rows) {
      const file = { filename: r.filename, size: r.size }
      seenFiles.set(r.username + '\n' + r.filename, file)
      seenFiles.set(r.username + '\n' + basename(r.filename.replace(/\\/g, '/')).toLowerCase(), file)
    }
  }
  const knownFile = (user, filename) => seenFiles.get(user + '\n' + filename) ||
    (/[\\/]/.test(filename) ? null : seenFiles.get(user + '\n' + filename.toLowerCase())) || null

  function notePeerFailure (err) {
    if (err?.reason !== 'no-inbound' && err?.reason !== 'no-answer') return
    inboundFailures++
    lastInboundFailure = Date.now()
  }

  // A peer's shared media, cached per username for BROWSE_TTL_MS (a concurrent second call shares the same request).
  async function browse ({ username, refresh = false } = {}) {
    if (!configured()) {
      await ensureAddon()
      throw Object.assign(new Error('Soulseek is not configured'), { status: 400 })
    }
    const user = String(username || '').trim()
    if (!user) throw Object.assign(new Error('username is required'), { status: 400 })
    const hit = browseCache.get(user)
    if (hit && !refresh && Date.now() - hit.at < BROWSE_TTL_MS) {
      const res = await hit.promise
      return { ...res, cached: true }
    }
    const c = await ensureLoggedIn()
    const at = Date.now()
    const promise = c.browse(user, browseTimeoutMs).then(
      records => { const res = { ...normalizeSoulseekBrowse(records, user), at }; remember(res.files); return res },
      err => {
        browseCache.delete(user)
        const e = peerError(err, user, advertisedPort(), secrets())
        notePeerFailure(e)
        onchange?.()
        throw e
      }
    )
    browseCache.delete(user)
    browseCache.set(user, { at, promise })
    while (browseCache.size > BROWSE_CACHE_MAX) browseCache.delete(browseCache.keys().next().value)
    return { ...(await promise), cached: false }
  }

  function notifyWake () {
    for (const fn of [...wakeListeners]) fn()
  }

  function waitBackoff (job, waitMs) {
    return new Promise((resolve, reject) => {
      if (closed || job.cancelled) return reject(new Error('Cancelled'))
      let done = false
      const finish = (err) => {
        if (done) return
        done = true
        clearTimeout(timer)
        clearInterval(poll)
        wakeListeners.delete(onWake)
        if (err) reject(err)
        else resolve()
      }
      const onWake = () => finish(closed || job.cancelled ? new Error('Cancelled') : null)
      const timer = setTimeout(() => finish(null), waitMs)
      const poll = setInterval(() => {
        if (closed || job.cancelled) finish(new Error('Cancelled'))
      }, 200)
      timer.unref?.()
      poll.unref?.()
      wakeListeners.add(onWake)
    })
  }

  function saveJobs () {
    if (!persistJobs || !storage) return
    const now = Date.now()
    const snapshot = []
    for (const [id, j] of jobs) {
      if (j.cancelled || j.status === 'cancelled') continue
      const meta = jobMeta.get(id)
      if (!meta) continue
      snapshot.push({
        id,
        request: meta.request,
        items: meta.items,
        completedFiles: meta.completedFiles,
        status: j.status,
        created: j.created,
        updated: now,
        bytes: j.bytes || 0,
        total: j.total ?? null,
        file: j.file || '',
        fileIndex: j.fileIndex || 1,
        error: j.error || null,
        note: j.note || null,
        transientFailure: Boolean(meta.transientFailure),
        autoResumes: Number(meta.autoResumes) || 0
      })
    }
    const path = join(storage, JOBS_FILENAME)
    const tmp = `${path}.tmp`
    try {
      mkdirSync(storage, { recursive: true })
      writeFileSync(tmp, JSON.stringify({ version: 1, jobs: snapshot }), { mode: 0o600 })
      renameSync(tmp, path)
    } catch {
      // Disk persistence is best-effort; in-memory queue continues
      return
    }
  }

  function loadPersistedJobs () {
    if (!persistJobs || !storage) return
    const path = join(storage, JOBS_FILENAME)
    if (!existsSync(path)) return
    let parsed = null
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      // ast-grep-ignore: js-no-empty-catch -- corrupt persisted snapshot falls back to empty queue
      return
    }
    const now = Date.now()
    for (const entry of Array.isArray(parsed?.jobs) ? parsed.jobs : []) {
      if (!entry?.id || !Array.isArray(entry.items) || !entry.items.length || !entry.request?.username) continue
      const workDir = join(storage, `.slsk-job-${entry.id}`)
      const age = now - Math.max(Number(entry.updated) || 0, Number(entry.created) || 0)
      if (age > STALE_JOB_TTL_MS && (entry.status === 'done' || entry.status === 'failed')) {
        cleanupDir(workDir)
        continue
      }
      let status = 'queued'
      if (entry.status === 'done') status = 'done'
      else if (entry.status === 'failed') status = 'failed'
      else if (entry.status !== 'queued' && entry.status !== 'transferring' && entry.status !== 'announcing') continue

      let diskBytes = 0
      if (status !== 'done' && existsSync(workDir)) {
        const seenNames = new Set()
        for (let i = 0; i < entry.items.length; i++) {
          const item = entry.items[i]
          let destName = item.base
          if (seenNames.has(destName.toLowerCase())) {
            const ext = extname(destName)
            destName = `${String(i + 1).padStart(2, '0')} - ${basename(destName, ext)}${ext}`
          }
          seenNames.add(destName.toLowerCase())
          const dest = join(workDir, destName)
          try {
            diskBytes += statSync(dest).size || 0
          } catch {
            // ast-grep-ignore: js-no-empty-catch -- incomplete track falls back to .part length
            diskBytes += partLen(dest)
          }
        }
      }
      const bytes = status === 'done' ? Number(entry.bytes) || 0 : Math.max(diskBytes, Number(entry.bytes) || 0)
      const items = entry.items
      const albumTotal = items.every(f => f.size > 0) ? items.reduce((sum, f) => sum + f.size, 0) : null
      const callerId = entry.request.callerId || ''
      const callerRelease = entry.request.callerRelease || null
      const rawTitle = entry.request.rawTitle || ''
      let phase = 'queued'
      if (status === 'failed') phase = 'failed'
      else if (status === 'done') phase = 'completed'
      const job = {
        jobId: entry.id,
        id: (callerId && ID.test(callerId)) ? callerId : callerRelease,
        title: rawTitle || peerFolderHint(items)?.album || 'Album download',
        plugin: 'soulseek',
        channel: true,
        private: false,
        status,
        created: Number(entry.created) || now,
        peer: entry.request.username,
        file: entry.file || basename(items[0].filename.replace(/\\/g, '/')),
        fileIndex: Math.max(1, Math.min(Number(entry.fileIndex) || 1, items.length)),
        fileCount: items.length,
        phase,
        queuePlace: null,
        speed: 0,
        listenPort: 0,
        bytes,
        total: entry.total ?? albumTotal,
        error: entry.error || null,
        ...(entry.note ? { note: entry.note } : {}),
        ...(status === 'done' ? { size: bytes, sha256s: [] } : {}),
        cancelled: false,
        progressAt: now
      }
      jobs.set(entry.id, job)
      jobMeta.set(entry.id, {
        request: entry.request,
        items,
        workDir,
        completedFiles: Array.isArray(entry.completedFiles) ? [...entry.completedFiles] : [],
        activeRunner: false,
        transientFailure: Boolean(entry.transientFailure),
        autoResumes: Number(entry.autoResumes) || 0
      })
    }
    if (jobs.size > 0) saveJobs()
  }

  async function loginWithBackoff (job) {
    const maxAttempts = persistJobs ? DURABLE_RETRY_BACKOFF_MS.length : 0
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      if (closed || job.cancelled) throw new Error('Cancelled')
      try {
        return await ensureLoggedIn()
      } catch (err) {
        if (attempt === maxAttempts || closed || job.cancelled || !isTransientError(err)) throw err
        const waitMs = DURABLE_RETRY_BACKOFF_MS[attempt]
        Object.assign(job, {
          status: 'queued',
          phase: 'retrying',
          queuePlace: null,
          speed: 0,
          note: `Waiting for Soulseek connection — retrying in ${Math.round(waitMs / 1000)}s (${attempt + 1}/${maxAttempts})…`,
          progressAt: Date.now()
        })
        saveJobs()
        onchange?.()
        await waitBackoff(job, waitMs)
      }
    }
    throw Object.assign(new Error('Soulseek login failed'), { status: 502 })
  }

  async function executeJob (jobId, initialClient, ctx) {
    const job = jobs.get(jobId)
    const meta = jobMeta.get(jobId)
    if (!job || !meta) throw new Error('Job not found')
    const { request, items, workDir } = meta
    const { username, callerId, callerRelease, rawTitle, callerTrack } = request
    const albumTotal = () => items.every(f => f.size > 0) ? items.reduce((sum, f) => sum + f.size, 0) : null
    mkdirSync(workDir, { recursive: true, mode: 0o700 })

    const downloadAttempt = (activeClient, item, tmpDest, onProgress) => new Promise((resolve, reject) => {
      let phase = 'queued'
      let since = Date.now()
      let answered = false
      let bytes = 0
      let settled = false
      const finish = fn => value => {
        if (settled) return
        settled = true
        clearInterval(watchdog)
        fn(value)
      }
      const ok = finish(resolve)
      const fail = finish(reject)
      const port = advertisedPort()
      const watchdog = setInterval(() => {
        if (closed || job.cancelled) return fail(new Error('Cancelled'))
        const idle = Date.now() - since
        if (phase === 'connecting' && idle > noConnectMs) {
          fail(Object.assign(new Error(`${username} was ready to send but could not connect to this relay on port ${port || '(none)'}.`), { reason: 'no-inbound' }))
        } else if (phase === 'queued' && !answered && idle > noAnswerMs) {
          fail(Object.assign(new Error(`${username} never answered in ${Math.round(noAnswerMs / 60_000) || 1} min: it may be offline, or unable to reach this relay on port ${port || '(none)'}.`), { reason: 'no-answer' }))
        } else if (phase === 'transferring' && idle > noAnswerMs) {
          fail(Object.assign(new Error(`${username} stopped sending: no data for ${Math.round(noAnswerMs / 60_000) || 1} min.`), { reason: 'stalled' }))
        }
      }, 1000)
      watchdog.unref?.()
      activeClient.download(username, item.filename, tmpDest, prog => {
        if (settled) return
        const next = String(prog?.phase || phase)
        const got = Number(prog?.bytes) || 0
        if (next !== phase || got > bytes) since = Date.now()
        phase = next
        bytes = Math.max(bytes, got)
        if (Number.isInteger(prog?.queue) && prog.queue >= 0) answered = true
        onProgress(prog, phase)
      }).then(ok, err => fail(peerError(err, username, port, secrets())))
    })

    const downloadOne = async (activeClientRef, item, tmpDest, onProgress) => {
      const maxRetries = persistJobs ? DURABLE_RETRY_BACKOFF_MS.length : 3
      let activeClient = activeClientRef.client
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const res = await downloadAttempt(activeClient, item, tmpDest, onProgress)
          activeClientRef.client = activeClient
          return res
        } catch (err) {
          const retryable = persistJobs
            ? isTransientError(err)
            : /server session disconnected/i.test(String(err?.message || ''))
          if (attempt === maxRetries || closed || job.cancelled || !retryable) throw err
          const waitMs = persistJobs ? DURABLE_RETRY_BACKOFF_MS[attempt] : 2000 * (attempt + 1)
          Object.assign(job, {
            status: 'queued',
            phase: persistJobs ? 'retrying' : 'queued',
            queuePlace: null,
            speed: 0,
            ...(persistJobs ? { note: `Connection paused — retrying in ${Math.round(waitMs / 1000)}s (${attempt + 1}/${maxRetries})…` } : {}),
            progressAt: Date.now()
          })
          saveJobs()
          onchange?.()
          await waitBackoff(job, waitMs)
          // ast-grep-ignore: js-no-empty-catch -- keep the existing client when reconnect has not finished yet; the next download attempt will surface any persistent login error
          try { activeClient = await ensureLoggedIn() } catch {}
        }
      }
    }

    let completedBytes = 0
    let lastNotify = 0
    const downloaded = []
    meta.activeRunner = true
    try {
      const activeClientRef = { client: initialClient || await loginWithBackoff(job) }
      for (let i = 0; i < items.length; i++) {
        if (closed || job.cancelled) throw new Error('Cancelled')
        const item = items[i]
        const usedNames = new Set(downloaded.map(d => d.name.toLowerCase()))
        let destName = item.base
        if (usedNames.has(destName.toLowerCase())) {
          const ext = extname(destName)
          destName = `${String(i + 1).padStart(2, '0')} - ${basename(destName, ext)}${ext}`
        }
        const tmpDest = join(workDir, destName)

        const existingSize = persistJobs ? existingTrackSize(tmpDest, item, meta.completedFiles, destName) : 0
        if (existingSize > 0) {
          completedBytes += existingSize
          job.bytes = completedBytes
          job.file = basename(item.filename.replace(/\\/g, '/'))
          job.fileIndex = i + 1
          if (job.total != null && completedBytes > job.total) job.total = completedBytes
          downloaded.push({ name: destName, tmpPath: tmpDest, size: existingSize })
          continue
        }

        const existingPart = persistJobs ? partLen(tmpDest) : 0
        Object.assign(job, {
          status: 'queued',
          phase: 'queued',
          queuePlace: null,
          speed: 0,
          ...(persistJobs ? { bytes: completedBytes + existingPart } : {}),
          progressAt: Date.now(),
          file: basename(item.filename.replace(/\\/g, '/')),
          fileIndex: i + 1
        })
        if (persistJobs) delete job.note
        onchange?.()
        let rateAt = 0
        let rateBytes = 0
        const res = await downloadOne(activeClientRef, item, tmpDest, (prog, phase) => {
          const cur = Number(prog?.bytes) || 0
          const tot = Number(prog?.total) || 0
          if (tot > item.size) {
            item.size = tot
            const t = albumTotal()
            if (t != null) job.total = Math.max(job.total || 0, t)
          }
          const statusChanged = job.phase !== phase
          const now = Date.now()
          if (statusChanged || completedBytes + cur > job.bytes) job.progressAt = now
          job.phase = phase
          job.status = phase === 'transferring' || phase === 'completed' ? 'transferring' : 'queued'
          job.queuePlace = Number.isInteger(prog?.queue) && prog.queue >= 0 ? prog.queue : job.queuePlace
          job.bytes = completedBytes + cur
          if (phase !== 'transferring') {
            rateAt = 0
            job.speed = 0
          } else if (!rateAt) {
            rateAt = now
            rateBytes = job.bytes
          } else if (now - rateAt >= 1000) {
            const inst = (job.bytes - rateBytes) * 1000 / (now - rateAt)
            job.speed = Math.round(job.speed ? job.speed * 0.5 + inst * 0.5 : inst)
            rateAt = now
            rateBytes = job.bytes
          }
          if (statusChanged || now - lastNotify >= 350) {
            lastNotify = now
            onchange?.()
          }
        })
        const finalSize = Number(res?.size) || statSync(tmpDest).size
        if (finalSize > item.size) item.size = finalSize
        completedBytes += finalSize
        if (finalSize > 0) transfersOk++
        job.bytes = completedBytes
        job.speed = 0
        if (persistJobs) delete job.note
        if (job.total != null && completedBytes > job.total) job.total = completedBytes
        if (!meta.completedFiles.includes(destName)) meta.completedFiles.push(destName)
        downloaded.push({ name: destName, tmpPath: tmpDest, size: finalSize })
        saveJobs()
        onchange?.()
      }

      if (closed || job.cancelled) throw new Error('Cancelled')
      job.status = 'announcing'
      job.phase = 'waiting'
      onchange?.()

      const tagList = downloaded.map(d => readHeadTags(d.tmpPath))
      const lone = downloaded.length === 1 && !(callerId && ID.test(callerId) && !callerRelease)
      const needsPlace = lone && !tagList[0]?.track && !callerTrack && !/^\d{1,3}(?!\d)/.test(basename(items[0].base, extname(items[0].base)))
      const single = lone
        ? placeSingleTrack({ tags: tagList[0], filename: items[0].filename, release: callerRelease, track: callerTrack, position: needsPlace ? await folderPosition(username, items[0].filename) : null, fallbackTitle: rawTitle })
        : null
      if (single?.error) throw Object.assign(new Error(single.error), { status: 422, reason: 'unplaced' })
      const firstNamed = tagList.find(t => t && (t.album || t.albumArtist || t.artist))
      const hint = peerFolderHint(items)
      const folderName = single
        ? single.folder
        : formatAlbumDir({
          artist: firstNamed?.albumArtist || firstNamed?.artist || hint?.artist || '',
          album: firstNamed?.album || hint?.album || '',
          year: firstNamed?.year || hint?.year || '',
          fallbackTitle: rawTitle
        })
      if (single) {
        if (!rawTitle) job.title = [single.trackTitle, single.albumTitle].filter(Boolean).join(' · ').slice(0, MAX_TITLE)
        if (single.from === 'peer folder') job.note = `No album tag: placed in “${folderName}” from the peer's folder name.`
      } else if (!rawTitle && (firstNamed?.album || hint?.album)) {
        job.title = [firstNamed?.albumArtist || firstNamed?.artist || hint?.artist, firstNamed?.album || hint?.album]
          .filter(Boolean)
          .join(' · ')
          .slice(0, MAX_TITLE) || folderName
      }

      if (closed || job.cancelled) throw new Error('Cancelled')
      const finalAlbumDir = join(stagingRoot, folderName)
      const placed = new Set()
      const place = () => {
        mkdirSync(finalAlbumDir, { recursive: true })
        const pinPath = join(finalAlbumDir, ALBUM_PIN)
        if (callerRelease) writeFileSync(pinPath, JSON.stringify({ release: callerRelease, ...(single ? { title: single.albumTitle } : {}) }) + '\n')
        else if (single && !existsSync(pinPath)) writeFileSync(pinPath, JSON.stringify({ release: single.release, title: single.albumTitle }) + '\n')
        for (const d of downloaded) {
          const dst = freePath(finalAlbumDir, single ? single.file : d.name)
          placed.add(basename(dst))
          try {
            renameSync(d.tmpPath, dst)
          } catch {
            copyFileSync(d.tmpPath, dst)
            rmSync(d.tmpPath, { force: true })
          }
          if (downloaded.length === 1 && !single && !callerRelease && callerId && ID.test(callerId)) {
            writeFileSync(`${dst}.json`, JSON.stringify({ id: callerId, title: job.title }))
          }
        }
        noteMirrored(finalAlbumDir, placed)
        cleanupDir(workDir)
        job.phase = 'importing'
        onchange?.()
      }
      let finalScan = { scanned: 0, ingested: 0, items: [] }
      if (placeAndScan) finalScan = await placeAndScan(place, ctx, { cancelled: () => closed || job.cancelled })
      else place()

      Object.assign(job, {
        status: 'done',
        size: completedBytes,
        bytes: completedBytes,
        total: completedBytes,
        sha256s: (finalScan?.items || []).filter(it => placed.has(it.file) && it.rel === `${folderName}/${it.file}`).map(it => it.sha256)
      })
      saveJobs()
      onchange?.()
      return {
        jobId,
        folder: folderName,
        files: downloaded.length,
        bytes: completedBytes,
        ingested: finalScan?.ingested || 0,
        items: finalScan?.items || [],
        ...(single ? { placed: { file: [...placed][0], from: single.from, release: single.release, note: job.note || null } } : {})
      }
    } catch (err) {
      if (persistJobs && closed && !job.cancelled) {
        Object.assign(job, { status: 'queued', phase: 'queued', queuePlace: null, speed: 0 })
        saveJobs()
        throw Object.assign(new Error('Cancelled'), { status: 502 })
      }
      if (!persistJobs || job.cancelled) cleanupDir(workDir)
      if (!job.cancelled) {
        job.status = 'failed'
        job.phase = 'failed'
        job.error = scrub(err?.message || String(err), secrets())
        meta.transientFailure = isTransientError(err)
        if (persistJobs) job.note = 'Progress saved — tap Retry to continue.'
        notePeerFailure(err)
      }
      job.speed = 0
      saveJobs()
      onchange?.()
      throw Object.assign(new Error(job.error || 'Cancelled'), { status: err?.status || 502 })
    } finally {
      meta.activeRunner = false
    }
  }

  function trimJobs () {
    if (jobs.size <= 48) return
    for (const [id, j] of jobs) {
      if (j.status === 'done' || j.status === 'failed' || j.status === 'cancelled') {
        const meta = jobMeta.get(id)
        if (persistJobs && meta?.workDir) cleanupDir(meta.workDir)
        jobs.delete(id)
        jobMeta.delete(id)
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
      const named = typeof entry === 'string' ? entry.trim() : String(entry?.filename || '').trim()
      if (!named) continue
      const known = knownFile(username, named)
      const filename = known ? known.filename : named
      const normPath = filename.replace(/\\/g, '/')
      const base = basename(normPath)
      if (!base || !MEDIA_FILE.test(base)) continue
      const size = typeof entry === 'object' && entry !== null && Number.isFinite(Number(entry.size)) && Number(entry.size) > 0
        ? Math.trunc(Number(entry.size))
        : known?.size || 0
      items.push({ filename, base: safeSegment(base, 'track.flac'), size })
    }
    if (!items.length) throw Object.assign(new Error('files must list at least one audio file'), { status: 400 })

    const c = await ensureLoggedIn()
    const callerId = typeof payload.id === 'string' ? payload.id.trim().toLowerCase() : ''
    const callerRelease = parseRelease(callerId) || parseRelease(payload.releaseId)
    const rawTitle = typeof payload.title === 'string' ? payload.title.trim().slice(0, MAX_TITLE) : ''
    // A caller that names the track (`mb:<release>:s01e05`) gives its number to a lone file with none of its own.
    const callerTrack = Number(/:s\d{2}e(\d{2,3})$/.exec(callerId)?.[1]) || null

    const jobId = randomUUID()
    // The album's size once every file's size is known (from the caller, an earlier search or browse, or the peer as
    // each transfer starts); null until then, so a percentage is never computed against a partial sum.
    const albumTotal = () => items.every(f => f.size > 0) ? items.reduce((sum, f) => sum + f.size, 0) : null
    const job = {
      jobId,
      id: (callerId && ID.test(callerId)) ? callerId : callerRelease,
      title: rawTitle || peerFolderHint(items)?.album || 'Album download',
      plugin: 'soulseek',
      channel: true,
      private: false,
      // 'queued' (waiting on the peer) | 'transferring' | 'announcing' | 'done' | 'failed' | 'cancelled'
      status: 'queued',
      created: Date.now(),
      peer: username,
      file: basename(items[0].filename.replace(/\\/g, '/')),
      fileIndex: 1,
      fileCount: items.length,
      // The addon's transfer phase: 'queued' | 'connecting' | 'transferring' | 'completed' | 'failed' | 'cancelled'
      phase: 'queued',
      queuePlace: null,
      speed: 0,
      listenPort: advertisedPort(),
      bytes: 0,
      total: albumTotal(),
      error: null,
      cancelled: false,
      progressAt: Date.now()
    }
    if (ctx) hostCtx = ctx
    trimJobs()
    jobs.set(jobId, job)
    const workDir = join(storage, persistJobs ? `.slsk-job-${jobId}` : `.slsk-tmp-${jobId}`)
    jobMeta.set(jobId, {
      request: { username, callerId, callerRelease, rawTitle, callerTrack },
      items,
      workDir,
      completedFiles: [],
      activeRunner: false,
      transientFailure: false,
      autoResumes: 0
    })
    saveJobs()
    onchange?.()

    mkdirSync(workDir, { recursive: true, mode: 0o700 })

    const runDownload = () => executeJob(jobId, c, ctx)

    if (payload.wait === true) {
      return runDownload()
    }
    runDownload().catch(() => {})
    return { queued: true, job: publicSlskJob(job) }
  }

  function cleanupDir (dir) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }

  // The place `filename` sorts at among the media files of its folder on the peer (1-based), from the peer's share
  // list (cached after a browse, else asked for now), or null. Names sort the way a person reads them, so "A2"
  // comes before "A10" and side A before side B.
  async function folderPosition (username, filename) {
    const norm = s => String(s).replace(/\\/g, '/')
    const want = norm(filename)
    const dir = want.slice(0, want.lastIndexOf('/') + 1)
    const parts = s => s.toLowerCase().split(/(\d+)/).map((p, i) => (i % 2 ? Number(p) : p))
    const natural = (a, b) => {
      const x = parts(a)
      const y = parts(b)
      for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
      return x.length - y.length
    }
    try {
      const { files } = await browse({ username })
      const names = files.map(f => norm(f.filename)).filter(f => f.startsWith(dir) && !f.slice(dir.length).includes('/')).sort(natural)
      const at = names.indexOf(want)
      return at >= 0 ? at + 1 : null
    } catch {
      return null
    }
  }

  // `idleMs`: how long a waiting or transferring job has gone without a phase change or a new byte, so a client can
  // tell a slow peer from a stuck one without comparing clocks.
  function publicSlskJob ({ cancelled: _c, progressAt, ...rest }) {
    const waiting = rest.status === 'queued' || rest.status === 'transferring'
    return {
      ...rest,
      ...(persistJobs && rest.status === 'failed' ? { retryable: true } : {}),
      idleMs: waiting ? Date.now() - progressAt : null
    }
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
    const meta = jobMeta.get(jobId)
    // Cancel works until this album's own import starts: while it waits for another import, nothing is placed yet.
    if (j.status === 'queued' || j.status === 'transferring' || (j.status === 'announcing' && j.phase === 'waiting')) {
      j.cancelled = true
      j.status = 'cancelled'
      notifyWake()
      if (persistJobs && meta && !meta.activeRunner) cleanupDir(meta.workDir)
      saveJobs()
      onchange?.()
      return publicSlskJob(j)
    }
    if (j.status !== 'announcing') {
      if (persistJobs && meta?.workDir) cleanupDir(meta.workDir)
      jobs.delete(jobId)
      jobMeta.delete(jobId)
      saveJobs()
      onchange?.()
      return { ...publicSlskJob(j), status: 'removed' }
    }
    return publicSlskJob(j)
  }

  function retryJob (jobId, ctx) {
    if (!persistJobs || closed) return null
    if (ctx) hostCtx = ctx
    const j = jobs.get(jobId)
    const meta = jobMeta.get(jobId)
    if (!j || !meta) return null
    if (j.status !== 'failed' || meta.activeRunner) return publicSlskJob(j)
    Object.assign(j, {
      status: 'queued',
      phase: 'queued',
      error: null,
      cancelled: false,
      speed: 0,
      queuePlace: null,
      progressAt: Date.now()
    })
    delete j.note
    meta.transientFailure = false
    meta.autoResumes = 0
    saveJobs()
    onchange?.()
    executeJob(jobId, null, ctx || hostCtx).catch(() => {})
    return publicSlskJob(j)
  }

  function resumePersisted (ctx) {
    if (ctx) hostCtx = ctx
    if (!persistJobs || closed || !configured()) return
    let started = false
    for (const [id, j] of jobs) {
      const meta = jobMeta.get(id)
      if (!meta || meta.activeRunner || j.cancelled || j.status !== 'queued') continue
      j.progressAt = Date.now()
      started = true
      executeJob(id, null, ctx || hostCtx).catch(() => {})
    }
    if (started) onchange?.()
  }

  function wakeJobs (ctx) {
    if (ctx) hostCtx = ctx
    notifyWake()
    if (!persistJobs || closed || !configured()) return 0
    let active = 0
    let started = false
    for (const [id, j] of jobs) {
      const meta = jobMeta.get(id)
      if (!meta || j.cancelled) continue
      if (meta.activeRunner) {
        active++
        continue
      }
      const resumeQueued = j.status === 'queued'
      const resumeTransient = j.status === 'failed' && meta.transientFailure && meta.autoResumes < MAX_AUTO_WAKE_RESUMES
      if (resumeQueued || resumeTransient) {
        if (resumeTransient) meta.autoResumes++
        Object.assign(j, {
          status: 'queued',
          phase: 'queued',
          error: null,
          speed: 0,
          queuePlace: null,
          progressAt: Date.now()
        })
        delete j.note
        active++
        started = true
        executeJob(id, null, ctx || hostCtx).catch(() => {})
      }
    }
    if (started) {
      saveJobs()
      onchange?.()
    }
    return active
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
      if (persistJobs) wakeJobs(hostCtx)
    }
  }

  function info () {
    // Probe addon availability lazily when configured, or report current known state without crashing.
    const isCfg = configured()
    const activeJobs = [...jobs.values()].filter(j => j.status === 'queued' || j.status === 'transferring' || j.status === 'announcing').length
    if (addonState === 'unavailable') {
      return {
        status: 'unavailable',
        available: false,
        configured: isCfg,
        connected: false,
        activeJobs,
        searchCap: SOULSEEK_SEARCH_CAP
      }
    }
    const st = client ? client.state() : null
    return {
      status: !isCfg ? 'not configured' : (st?.logged_in ? 'connected' : 'configured'),
      available: addonState === 'loaded' ? true : null,
      configured: isCfg,
      connected: Boolean(st?.logged_in),
      activeJobs,
      searchCap: SOULSEEK_SEARCH_CAP,
      // Where mirrors land, by kind only ('import folder' | 'storage' …): /v1/plugins is public and never names a path.
      staging: stagingLabel,
      // Port peers connect back to: the bound port once signed in (0 = the configured port could not be opened),
      // null before the first sign-in. `listenPortSetting` 0 means "OS picks one each start".
      listenPort: st ? Number(st.listen_port) || 0 : null,
      listenPortSetting: listenPort,
      // This session's evidence: peers that could not reach us vs transfers that moved bytes.
      inboundFailures,
      lastInboundFailure,
      transfersOk
    }
  }

  async function stop () {
    closed = true
    for (const j of jobs.values()) {
      if (persistJobs) {
        if (j.status === 'queued' || j.status === 'transferring' || (j.status === 'announcing' && j.phase === 'waiting')) {
          j.status = 'queued'
          j.phase = 'queued'
          j.speed = 0
          j.queuePlace = null
        }
      } else {
        if (j.status === 'queued' || j.status === 'transferring') j.cancelled = true
        // A mirror waiting for another import has placed nothing: closing ends it as a cancel, not as a failure.
        if (j.status === 'announcing' && j.phase === 'waiting') {
          j.cancelled = true
          j.status = 'cancelled'
        }
      }
    }
    notifyWake()
    saveJobs()
    browseCache.clear()
    closeClient()
  }

  if (persistJobs) loadPersistedJobs()
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
      if (payload?.action === 'browse') return browse(payload)
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
    browse,
    mirror,
    configure,
    listJobs,
    getJob,
    cancelJob,
    retryJob,
    wakeJobs,
    resumePersisted,
    stop,
    info
  }
}
