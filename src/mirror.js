// Formal Mirror Plugin Host for PearTube relays:
//   - Integrates the durable HTTP/debrid acquirer (`jobs.json`) as the core `http-acquire` plugin
//   - Automatically backfills all previously saved tracker blobs into this relay's single-writer Channel (`channel-backfill`)
//   - Mirrors local media folders (`watch-dir`, e.g. `/data/import` on Unraid) without re-ingesting unchanged files
//   - Mirrors remote JSON manifests or peer relay `/v1/entries` catalogs (`feed-mirror`)
//   - Greedy P2P Hyperblobs block replication (`p2p-replicate`) to stuff a replica disk full without duplicating catalog ops
//   - Recruits existing HiveRelays (`hiverelay-seed`) via HTTP `/seed-core` and P2P `hiverelay-seed` DHT as supplemental seeders
//   - Checks that held public files are media before global search offers them (`media-check`)
//   - Dynamically loads custom user plugins dropped into `/data/plugins/*.mjs` or `*.js`
import { closeSync, createReadStream, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import b4a from 'b4a'
import { ID, MAX_TITLE, MEDIA_FILE, mediaFormat, parseUri } from './protocol.js'
import { albumKey, parseTags } from './tags.js'
import { createHiverelaySeeder } from './hiverelay.js'
import { createTrafficGate } from './traffic.js'
import { send } from './art.js'
import { createSoulseekPlugin } from './providers/soulseek.js'
import { ALBUM_PIN, MIRRORED_LIST, RELEASE_ID } from './providers/staging.js'
import { createYoutubePlugin } from './providers/youtube.js'

// File names whose codec is lossy by definition. A `.flac` or `.wav` proves only a lossless container, and `.m4a`
// and `.ogg` hold lossless codecs too (ALAC, FLAC), so those stay unknown (`null`), never `false`.
const LOSSY_FILE = /\.(mp3|aac|opus|wma)$/i

async function fetchJson (url, headers = {}) {
  const res = await send(url, { headers: { accept: 'application/json', ...headers }, timeoutMs: 60_000, maxBytes: 8 * 1024 * 1024 })
  if (res.status < 200 || res.status >= 300) {
    const { host, pathname } = new URL(res.url)
    // Plugin errors are public on /v1/plugins: name the feed by host and path, never its query or credentials.
    throw new Error(`Feed ${host}${pathname} answered ${res.status}`)
  }
  return JSON.parse(res.body)
}

// Infers a canonical PearTube ID (`imdb:tt...:s01e02`, `mb:<release>:s01e03`, `album:<hash>:s01e03`,
// `imdb:tt...`, or `clip:<slug>`) from a filename, its own tags, or a sidecar.
//
// Music comes first when the file carries tags: an album's identity is the release, not the file name, and a folder of
// "01 - Intro.flac" files names nothing. The album is decided once per folder (`albumIdentity`) and handed in, because
// a compilation names a different artist on every track and a folder where only some rips carry a MusicBrainz id must
// still be one album. `title` is the album on every track, the way an episode's title is its show's name: the clients
// name a group from its first row, so a track's own name travels in `music` instead.
function inferMediaMeta (filePath, sidecar = null, tags = null, album = null) {
  const stem = basename(filePath, extname(filePath))
  if (sidecar && typeof sidecar.id === 'string' && ID.test(sidecar.id.toLowerCase())) {
    return { id: sidecar.id.toLowerCase(), title: String(sidecar.title || stem).slice(0, MAX_TITLE) }
  }
  // A file in an album folder joins that album even when its own tags are missing or partial: its track number is
  // its own, else the leading number in its name ("03 - ..."), else the caller passes the position it sits at. A
  // folder of untagged rips is exactly the case tags exist to rescue, so it must not fall through to `clip:`; nor
  // must a lone untagged track in a folder pinned to its album (a single-track mirror).
  // No release means no album identity (no tag in the folder names one): `album.release` would print as "undefined".
  if (album?.release && (tags || album.tracks > 1 || album.pinned)) {
    const fromName = /^(\d{1,3})\b/.exec(stem)
    const track = clamp(tags?.track, 1, 999) || clamp(fromName && Number(fromName[1]), 1, 999) || clamp(album.position, 1, 999)
    if (track) {
      const disc = clamp(tags?.disc, 1, 99) || 1
      const se = `s${String(disc).padStart(2, '0')}e${String(track).padStart(2, '0')}`
      const named = tags?.title || (/^\d{1,3}\s*[-._ ]+\s*(.+)$/.exec(stem) || [])[1] || stem
      return {
        id: `${album.release}:${se}`,
        title: album.title,
        music: { title: named, artist: tags?.artist || tags?.albumArtist || album.artist || undefined }
      }
    }
  }
  const imdb = stem.match(/\b(tt\d{6,10})\b/i)
  const ep = stem.match(/\bs(\d{2})e(\d{2,3})\b/i)
  if (imdb && ep) {
    const cleanTitle = stem.replace(/\btt\d{6,10}\b/ig, '').replace(/\bs\d{2}e\d{2,3}\b/ig, '').replace(/[._-]+/g, ' ').trim()
    return { id: `imdb:${imdb[1].toLowerCase()}:s${ep[1]}e${ep[2]}`, title: cleanTitle || stem }
  }
  if (imdb) {
    const cleanTitle = stem.replace(/\btt\d{6,10}\b/ig, '').replace(/[._-]+/g, ' ').trim()
    return { id: `imdb:${imdb[1].toLowerCase()}`, title: cleanTitle || stem }
  }
  const slug = stem.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const suffix = slug.length >= 4 ? slug.slice(0, 24) : createHash('sha256').update(stem).digest('hex').slice(0, 12)
  return { id: `clip:${suffix}`, title: stem.replace(/[._]+/g, ' ').trim() || stem }
}

// The id suffix is `s<disc>e<track>`: two digits each, three for a track, so an out-of-range or unparseable number
// would produce an id `decodeOp` rejects and abort the whole scan. Clamp instead, and let `null` mean "not stated".
const clamp = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo ? Math.min(v, hi) : null

// One album's identity, from every tagged file in its folder rather than from any single one of them.
//
// The release id wins when the folder agrees on one: it is what makes two rips of the same album land on the same
// tracks, and it survives a rename. The convention tags only some files of a folder, so one id from any file that has
// it is taken. Without one, the album's names and year are hashed; the year is the first four digits only, since a
// reissue and a full date would otherwise split one album, and `albumKey` folds case, punctuation and accents so a
// differently-typed folder still agrees.
function albumIdentity (files) {
  let mbid = null
  let discogs = null
  const names = new Map()
  // Every tagged file names the album, numbered or not (a vinyl rip tags no track numbers); only a numbered one, or
  // a file already announced under a release, vouches for a release id.
  for (const t of files) {
    if (!t) continue
    if (!mbid && t.track && t.mbid) mbid = t.mbid
    if (!discogs && t.track && t.discogs) discogs = t.discogs
    if (t.album) {
      const artist = t.albumArtist || t.artist || ''
      const key = albumKey({ albumArtist: artist, album: t.album, year: t.year })
      names.set(key, (names.get(key) || 0) + 1)
    }
  }
  // The most common album across the folder: a bonus track or a guest credit does not rename the release.
  const best = [...names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (!best && !mbid && !discogs) return null
  const named = [...files].find(t => t && t.album && albumKey({ albumArtist: t.albumArtist || t.artist || '', album: t.album, year: t.year }) === best)
  const release = mbid
    ? `mb:${mbid}`
    : discogs
      ? `discogs:r${discogs}`
      : `album:${createHash('sha256').update(best).digest('hex').slice(0, 20)}`
  const title = [named?.albumArtist || named?.artist, named?.album].filter(Boolean).join(' · ').slice(0, MAX_TITLE)
  // A track with no number of its own takes the place it sorts at, so a folder of untagged rips is still one album.
  return {
    release,
    title: title || basename(named?.file || '') || 'Untitled album',
    tracks: files.filter(Boolean).length
  }
}

// The release a folder is pinned to (`<folder>/.peartube-album.json` `{ release, title?, artist? }`), or null. Dot
// names are skipped by the media walk, so the pin is never itself imported.
function readAlbumPin (folder) {
  try {
    const pin = JSON.parse(readFileSync(join(folder, ALBUM_PIN), 'utf8'))
    if (typeof pin?.release !== 'string' || !RELEASE_ID.test(pin.release)) return null
    return {
      release: pin.release,
      title: typeof pin.title === 'string' ? pin.title.slice(0, MAX_TITLE) : '',
      artist: typeof pin.artist === 'string' ? pin.artist.slice(0, MAX_TITLE) : ''
    }
  } catch {
    return null
  }
}

// Whether files can be created in `dir` (made if missing): a read-only bind mount reports as present but refuses writes.
function writableDir (dir) {
  const probe = join(dir, `.peartube-write-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(probe, '')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

export async function createMirrorHost ({
  node,
  storage,
  acquirer,
  mirrorChannel = true,
  rechunk = false,
  watchDir = null,
  feeds = [],
  replicate = false,
  replicateMinFreeBytes = 20 * 1024 * 1024 * 1024,
  replicateConcurrency = 1,
  replicateStallMs = 20_000,
  replicateMbps = 0,
  hiverelay = null,
  // Global search is on (src/search.js): check held files with `media-check`.
  mediaCheck = false,
  slskUser = '',
  slskPass = '',
  slskServer = 'vps.slsknet.org:2271',
  slskListenPort = 50300,
  slskShare = false,
  slskShareMaxFiles = 2000,
  soulseekOpts = null,
  // `{ info, download }`: the relay's `ubitInfo` and `downloadPage`. Without them the YouTube source is unavailable.
  youtube = null,
  pluginsDir = join(storage, 'plugins'),
  pollIntervalMs = 60_000,
  // How long a provider's finished save waits for another import to finish before it gives up with nothing placed.
  importWaitMs = 120_000,
  onchange = null,
  // Called with the host before the startup backfill and folder import, so a caller can close it while they run.
  onstarting = null
}) {
  const plugins = new Map()
  const stats = new Map()
  const watchStateFile = join(storage, 'mirror-watch.json')
  let watchLedger = {}
  try { watchLedger = JSON.parse(readFileSync(watchStateFile, 'utf8')) } catch {}
  let closed = false

  function saveWatchLedger () {
    writeFileSync(watchStateFile + '.tmp', JSON.stringify(watchLedger, null, 2), { mode: 0o600 })
    renameSync(watchStateFile + '.tmp', watchStateFile)
  }

  function ctxFor (pluginName) {
    return {
      node,
      storage,
      acquirer,
      async has ({ id = null, sha256 = null } = {}) {
        if (acquirer) {
          const active = acquirer.list().some(j =>
            (j.status === 'queued' || j.status === 'copying' || j.status === 'running' || j.status === 'announcing' || j.status === 'done') &&
            ((id && j.id === id) || (sha256 && j.sha256 === sha256))
          )
          if (active) return true
        }
        const entries = await node.search(id || null)
        return entries.some(e => (id ? e.id === id : true) && (sha256 ? e.sha256 === sha256 : true) && (e.local || !sha256))
      },
      // `existing`: the announce of a public copy another followed channel already publishes; the job copies that
      // core from peers and falls back to `source` (src/acquire.js `copyExisting`).
      enqueue ({ id, title, source, channel = mirrorChannel, existing = null }) {
        if (!acquirer) throw new Error('HTTP acquirer unavailable on this peer')
        const job = acquirer.add({ id, title, source, channel, plugin: pluginName, existing })
        onchange?.()
        return job
      },
      async ingestStream ({ id, title, stream, private: isPrivate = false, music = null }) {
        const op = await node.put({ id, title, private: Boolean(isPrivate), music }, stream)
        await node.append(op)
        onchange?.()
        return op
      },
      async repost (entry, { pin = false, channel = mirrorChannel, tracker = true } = {}) {
        const op = { type: 'announce', id: entry.id, title: entry.title, size: entry.size, sha256: entry.sha256, blobs: entry.blobs, blob: entry.blob, ...(entry.epoch ? { epoch: entry.epoch } : {}), ...(entry.wrappedKey ? { wrappedKey: entry.wrappedKey } : {}) }
        if (tracker || channel) await node.append(op)
        if (pin) await node.warm(op)
        onchange?.()
        return op
      },
      async publishDirectory ({ sourceKey, title }) {
        const res = await node.publishSource({ sourceKey, title })
        onchange?.()
        return res
      }
    }
  }

  function register (plugin) {
    if (!plugin || typeof plugin.name !== 'string' || !plugin.name.trim()) {
      throw new Error('Mirror plugin requires a non-empty name')
    }
    const name = plugin.name.trim()
    plugins.set(name, plugin)
    if (!stats.has(name)) stats.set(name, { runs: 0, lastRunAt: null, lastResult: null, lastError: null })
    return plugin
  }

  async function run (name, payload = {}) {
    const plugin = plugins.get(name)
    if (!plugin) throw Object.assign(new Error(`Unknown mirror plugin: ${name}`), { status: 404 })
    if (typeof plugin.run !== 'function') throw new Error(`Plugin ${name} has no run handler`)
    const st = stats.get(name)
    st.runs++
    st.lastRunAt = Date.now()
    st.lastError = null
    try {
      const result = await plugin.run(payload, ctxFor(name))
      st.lastResult = result
      onchange?.()
      return result
    } catch (err) {
      st.lastError = err.message
      throw err
    }
  }

  register({
    name: 'http-acquire',
    description: 'Durable HTTP/HTTPS stream acquirer backed by jobs.json',
    async run (payload, ctx) {
      const { id, title, source, channel = mirrorChannel, dedupe = false } = payload || {}
      if (dedupe && id && await ctx.has({ id })) return { skipped: true, id, reason: 'already_present' }
      return { queued: true, job: ctx.enqueue({ id, title, source, channel }) }
    },
    info () {
      const list = acquirer ? acquirer.list() : []
      return {
        totalJobs: list.length,
        activeJobs: list.filter(j => j.status === 'queued' || j.status === 'copying' || j.status === 'running' || j.status === 'announcing').length,
        doneJobs: list.filter(j => j.status === 'done').length
      }
    }
  })

  register({
    name: 'channel-backfill',
    description: 'Backfills previously saved local tracker blobs into this relay\'s single-writer channel with zero byte duplication',
    async run () {
      return node.syncLocalChannel()
    }
  })

  let rechunkProgress = { running: false, total: 0, migrated: 0, deduped: 0, remaining: 0, migratedBytes: 0, currentId: null, currentTitle: null }
  register({
    name: 'blob-rechunk',
    description: 'Re-chunks legacy variable-block local blobs into uniform 512 KiB blocks with SHA-256 verification and space reclamation',
    async run (payload = {}) {
      if (rechunkProgress.running) return { busy: true, ...rechunkProgress }
      if (typeof node.rechunkLegacyBlobs !== 'function') return { skipped: true }
      rechunkProgress = { ...rechunkProgress, running: true }
      try {
        const res = await node.rechunkLegacyBlobs({
          id: typeof payload?.id === 'string' && payload.id.trim() ? payload.id.trim() : null,
          foreground: Boolean(payload?.foreground),
          limit: Number.isFinite(Number(payload?.limit)) && Number(payload.limit) > 0 ? Number(payload.limit) : Infinity,
          onMigrate: (oldTag, target) => { acquirer?.repointBlob?.(oldTag, target) },
          onProgress: p => { rechunkProgress = { running: true, ...p } }
        })
        rechunkProgress = { running: false, ...res, currentId: null, currentTitle: null }
        return res
      } finally {
        rechunkProgress.running = false
      }
    },
    info () {
      return { ...rechunkProgress }
    }
  })

  // The tag read is bounded and never through the blob server: a core must not be opened just to name a track, and the
  // announce is written from the staged file before the core exists. 1 MiB covers a FLAC picture block plus every
  // comment an album carries; a file whose tags sit past it falls back to its name, as before. Synchronous, because a
  // scan names every file of an album before it writes any of them, and the whole read is a few ms off page cache.
  const TAG_BYTES = 1024 * 1024
  function readTags (full) {
    let fd = -1
    try {
      fd = openSync(full, 'r')
      const buf = b4a.alloc(Math.min(fstatSync(fd).size, TAG_BYTES))
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

  // Album folders are one level deep, so the walk cannot follow a directory into itself and cannot loop. `withFileTypes`
  // reports a directory by its own type, not by what a symlink points at, so a symlinked folder is skipped instead of
  // publishing files from outside the import folder. Dot and `@` names are skipped, which keeps macOS `._01.flac` and
  // Synology's `@eaDir` out; both would otherwise match MEDIA_FILE and land as clips.
  const SKIP_NAME = /^[.@]/
  function listMedia (root) {
    const out = []
    let entries
    try { entries = readdirSync(root, { withFileTypes: true }) } catch { return out }
    for (const dirent of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const name = dirent.name
      if (SKIP_NAME.test(name)) continue
      const full = join(root, name)
      if (dirent.isDirectory()) {
        let kids
        try { kids = readdirSync(full, { withFileTypes: true }) } catch { continue }
        for (const kid of kids.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
          if (SKIP_NAME.test(kid.name) || kid.isDirectory() || !MEDIA_FILE.test(kid.name)) continue
          const path = join(full, kid.name)
          const st = statOf(path)
          if (st) out.push({ rel: `${name}/${kid.name}`, dir: name, full: path, st })
        }
        continue
      }
      if (!MEDIA_FILE.test(name)) continue
      const st = statOf(full)
      if (st) out.push({ rel: name, dir: null, full, st })
    }
    return out
  }
  function statOf (path) {
    try {
      const st = statSync(path)
      return st.isFile() && st.size > 0 ? st : null
    } catch { return null }
  }

  // One album's identity per folder, decided from every file in it that has tags, before the first track is read.
  // Files already imported contribute the id they were stored with, so adding a track to an album that is already on
  // the channel does not renumber its neighbours when the new file's tags read differently. A folder pinned to a
  // release (`.peartube-album.json`, written by a mirror that was told which album it fills) takes that release
  // over anything its files' tags say.
  async function albumFor (group, root, ledgerKeyOf) {
    const tags = []
    for (const f of group) {
      const prev = watchLedger[ledgerKeyOf(f)]
      const hit = prev?.id?.match(/^(mb:[0-9a-f]{32}|discogs:r\d{1,12}|album:[0-9a-f]{20}):s\d{2}e\d{2,3}$/)
      if (hit) tags.push({ track: 1, mbid: hit[1].startsWith('mb:') ? hit[1].slice(3) : null, discogs: hit[1].startsWith('discogs:r') ? hit[1].slice('discogs:r'.length) : null })
      else tags.push(readTags(f.full))
    }
    const identity = albumIdentity(tags.map((t, i) => (t ? { ...t, file: group[i].full } : null)))
    const pinned = readAlbumPin(join(root, group[0].dir))
    if (!pinned) return identity
    return { release: pinned.release, title: pinned.title || identity?.title || group[0].dir, artist: pinned.artist, tracks: group.length, pinned: true }
  }

  const stagingDir = join(storage, 'staging')
  let scanningWatchDir = false
  async function scanFolder (dir, ctx, prefix = '') {
    if (!dir || !existsSync(dir)) return { scanned: 0, ingested: 0, items: [] }
    if (scanningWatchDir) return { scanned: 0, ingested: 0, busy: true, items: [] }
    scanningWatchDir = true
    try {
      const files = listMedia(resolve(dir))
      // Nested folders are albums, so each is identified once; root files are handled one at a time as before.
      const albums = new Map()
      for (const f of files) if (f.dir && !albums.has(f.dir)) albums.set(f.dir, [])
      for (const f of files) if (f.dir) albums.get(f.dir).push(f)
      // A file already recorded under its base name (every import before this change) keeps that key, so an existing
      // mirror-watch.json is not invalidated and nothing already imported is ingested a second time.
      const ledgerKey = f => prefix + f.rel
      const unchanged = f => {
        const prev = watchLedger[ledgerKey(f)] || (f.dir || prefix ? null : watchLedger[basename(f.rel)])
        return Boolean(prev && prev.size === f.st.size && prev.mtimeMs === Math.trunc(f.st.mtimeMs))
      }
      // An album is identified only when it has a file to import: reading every imported album's tags on each 60 s
      // poll read 1 MiB per file, synchronously, for nothing.
      const identities = new Map()
      for (const [name, group] of albums) if (!group.every(unchanged)) identities.set(name, await albumFor(group, resolve(dir), ledgerKey))
      let scanned = 0
      const ingested = []
      const failed = []
      for (const f of files) {
        const { rel, dir: album, full, st } = f
        if (closed) break
        scanned++
        if (unchanged(f)) continue
        const key = ledgerKey(f)
        let sidecar = null
        const sidecarPath = `${full}.json`
        if (existsSync(sidecarPath)) {
          try { sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) } catch {}
        }
        // One bad file must not stop the album or the scan: an id `put` rejects would otherwise abort every later file
        // on every poll. The failure is reported in the result, not thrown.
        try {
          const tags = album ? readTags(full) : null
          // A file with no track number of its own takes the place it holds in the folder, so a folder of untagged
          // rips still numbers its tracks 1..n instead of every one of them landing on track 1.
          const position = album ? albums.get(album).findIndex(f => f.rel === rel) + 1 : 0
          const meta = inferMediaMeta(full, sidecar, tags, album ? { ...identities.get(album), position } : null)
          const op = await ctx.ingestStream({ id: meta.id, title: meta.title, stream: createReadStream(full), channel: mirrorChannel, music: meta.music || null })
          watchLedger[key] = { size: st.size, mtimeMs: Math.trunc(st.mtimeMs), id: op.id, blobs: op.blobs, sha256: op.sha256, ingestedAt: Date.now() }
          saveWatchLedger()
          ingested.push({ file: basename(rel), rel, id: op.id, title: op.title, size: op.size, sha256: op.sha256 })
        } catch (err) {
          failed.push({ file: basename(rel), rel, error: err?.message || String(err) })
        }
      }
      return { scanned, ingested: ingested.length, failed, items: ingested }
    } finally {
      scanningWatchDir = false
    }
  }

  // A provider's finished files and their import as one step. `place` (synchronous) moves the files into the import
  // folder only once no other scan holds it, and the scan starts in the same tick, so no other scan sees a
  // half-placed album. While it waits nothing is placed: a save that is cancelled, or that gives up after `waitMs`
  // (a first import of a large folder can run for hours), leaves nothing behind.
  async function placeAndScan (dir, ctx, prefix, place, { cancelled = () => false, waitMs = importWaitMs } = {}) {
    const end = Date.now() + waitMs
    while (scanningWatchDir) {
      if (closed || cancelled()) throw new Error('Cancelled')
      if (Date.now() >= end) throw Object.assign(new Error(`Another import has held the folder for ${Math.ceil(waitMs / 1000)} s. Nothing was saved; try again when it finishes.`), { status: 503 })
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    // The folder also comes free when the relay closes (the running import stops between files) or the job was
    // cancelled in the last moment of the wait: neither may place anything.
    if (closed || cancelled()) throw new Error('Cancelled')
    place()
    return scanFolder(dir, ctx, prefix)
  }

  // The folder comes only from the host (PEARTUBE_WATCH_DIR), never from a run's payload: the API must not be able to
  // point the relay at another folder on its disk.
  register({
    name: 'watch-dir',
    description: 'Ingests media files dropped into the import folder (PEARTUBE_WATCH_DIR) once, tracking fingerprints in mirror-watch.json',
    async run (_payload, ctx) {
      const hasStaging = existsSync(stagingDir) && resolve(stagingDir) !== (watchDir ? resolve(watchDir) : '')
      if (!watchDir && !hasStaging) return { skipped: true, reason: 'watch_dir_not_configured', scanned: 0, ingested: 0, items: [] }
      const a = watchDir ? await scanFolder(watchDir, ctx) : { scanned: 0, ingested: 0, items: [] }
      const b = hasStaging ? await scanFolder(stagingDir, ctx, 'staging:') : { scanned: 0, ingested: 0, items: [] }
      return {
        scanned: (a.scanned || 0) + (b.scanned || 0),
        ingested: (a.ingested || 0) + (b.ingested || 0),
        ...(a.busy || b.busy ? { busy: true } : {}),
        items: [...(a.items || []), ...(b.items || [])]
      }
    },
    async poll (ctx) {
      const hasStaging = existsSync(stagingDir) && resolve(stagingDir) !== (watchDir ? resolve(watchDir) : '')
      if (!watchDir && !hasStaging) return null
      const a = watchDir ? await scanFolder(watchDir, ctx) : null
      const b = hasStaging ? await scanFolder(stagingDir, ctx, 'staging:') : null
      if (!a && !b) return null
      return {
        scanned: (a?.scanned || 0) + (b?.scanned || 0),
        ingested: (a?.ingested || 0) + (b?.ingested || 0),
        items: [...(a?.items || []), ...(b?.items || [])]
      }
    },
    // /v1/plugins is public: say whether a folder is watched, never which.
    info: () => ({ watching: Boolean(watchDir), trackedFiles: Object.keys(watchLedger).length })
  })

  const configuredFeeds = [...feeds]
  async function mirrorFeedItems (items, headers, ctx) {
    let enqueued = 0
    let skipped = 0
    const jobs = []
    // The same file claimed by a followed channel (same sha256): the copy job copies that core rather than
    // downloading, and hashes it against this feed's digest before announcing it. `has` above answers only for
    // copies this relay wrote or has a job for, never for another channel's claim.
    let bySha = null
    const copyOf = async sha256 => {
      if (!bySha) {
        bySha = new Map()
        for (const e of await ctx.node.search(null)) if (e.sha256 && !e.private && !e.locked && !e.epoch) bySha.set(e.sha256, e)
      }
      const e = bySha.get(sha256)
      const op = e ? await ctx.node.findEntry(e.key).catch(() => null) : null
      return op?.blobs && op.blob && !op.wrappedKey && !op.epoch ? { ...op, key: e.key } : null
    }
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const id = String(item.id || '').toLowerCase()
      if (!ID.test(id)) continue
      const sha256 = typeof item.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(item.sha256) ? item.sha256.toLowerCase() : null
      if (await ctx.has({ id, sha256 })) { skipped++; continue }
      const url = item.source?.url || item.url || item.streamUrl
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) { skipped++; continue }
      const job = ctx.enqueue({
        id,
        title: item.title || id,
        source: { url, headers: { ...headers, ...(item.source?.headers || item.headers) } },
        channel: mirrorChannel,
        existing: sha256 ? await copyOf(sha256) : null
      })
      enqueued++
      jobs.push(job)
    }
    return { enqueued, skipped, jobs }
  }

  register({
    name: 'feed-mirror',
    description: 'Mirrors remote JSON manifests or peer PearTube relay /v1/entries catalogs with idempotent deduplication',
    async run (payload, ctx) {
      if (Array.isArray(payload?.items)) return mirrorFeedItems(payload.items, payload.headers || {}, ctx)
      const targetUrls = payload?.url ? [payload.url] : configuredFeeds
      let enqueued = 0
      let skipped = 0
      for (const u of targetUrls) {
        const data = await fetchJson(u, payload?.headers || {})
        const list = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : (Array.isArray(data?.results) ? data.results : []))
        const res = await mirrorFeedItems(list, payload?.headers || {}, ctx)
        enqueued += res.enqueued
        skipped += res.skipped
      }
      return { feeds: targetUrls.length, enqueued, skipped }
    },
    async poll (ctx) {
      if (!configuredFeeds.length) return null
      return this.run({}, ctx)
    },
    // Feed URLs can carry access tokens; they stay in settings.json.
    info: () => ({ feeds: configuredFeeds.length })
  })

  let allowReplicateKeys = null
  let replicateEnabled = false
  function setReplicate (value) {
    allowReplicateKeys = Array.isArray(value) && value.length
      ? new Set(value.map(k => String(k).trim().toLowerCase()).filter(Boolean))
      : null
    replicateEnabled = Boolean(value) && (!Array.isArray(value) || Boolean(allowReplicateKeys?.size))
  }
  setReplicate(replicate)
  const activeReplicaRanges = new Set()
  const deadReplicaCores = new Map()
  let replicating = false
  let replicateRerun = false
  const repState = {
    replicatedEntries: 0,
    totalEntries: 0,
    replicatedBytes: 0,
    targetBytes: 0,
    activeSlices: 0,
    activeTitles: [],
    skippedDiskFull: 0,
    skippedUnavailable: 0
  }

  function freeDiskBytes () {
    try {
      const st = statfsSync(storage)
      return Number(st.bavail) * Number(st.bsize)
    } catch {
      return Infinity
    }
  }

  // Purges cached spans in non-writable replica cores that no live catalog entry still points at so fresh Unraid flesh can take their place.
  async function pruneUnreferencedReplicaBlocks (allItems) {
    const keepByCore = new Map()
    for (const item of allItems) {
      if (!item?.magnetUrl) continue
      let parsed
      try { parsed = parseUri(item.magnetUrl) } catch { continue }
      const b = parsed?.entry?.blob
      if (!parsed?.entry?.blobs || !b || !(b.blockLength > 0)) continue
      let list = keepByCore.get(parsed.entry.blobs)
      if (!list) { list = []; keepByCore.set(parsed.entry.blobs, list) }
      list.push([b.blockOffset, b.blockOffset + b.blockLength])
    }
    let clearedAny = false
    for (const [blobsHex, spans] of keepByCore) {
      const core = await node.blobCore(blobsHex).catch(() => null)
      if (!core || core.writable || !core.opened || core.length === 0) continue
      spans.sort((a, b) => a[0] - b[0])
      const merged = []
      for (const [s, e] of spans) {
        if (!merged.length || s > merged[merged.length - 1][1]) merged.push([s, e])
        else if (e > merged[merged.length - 1][1]) merged[merged.length - 1][1] = e
      }
      let cleared = false
      let cursor = 0
      for (const [s, e] of merged) {
        const gapEnd = Math.min(s, core.length)
        if (gapEnd > cursor && await core.count(cursor, gapEnd) > 0) {
          await core.clear(cursor, gapEnd)
          cleared = true
        }
        cursor = Math.max(cursor, e)
      }
      if (cursor < core.length && await core.count(cursor, core.length) > 0) {
        await core.clear(cursor, core.length)
        cleared = true
      }
      if (cleared) {
        clearedAny = true
        await node.refreshBlockCount(core)
      }
    }
    if (clearedAny) await node.gcStorage?.({ full: false }).catch(() => {})
    return clearedAny
  }

  // One shared pacer for every replica worker: greedy backfill must leave seeders and this disk room for viewers.
  let replicateBytesPerMs = replicateMbps > 0 ? replicateMbps * 125 : 0
  let replicatePaceAt = 0
  async function paceReplica (bytes) {
    if (!replicateBytesPerMs || bytes <= 0) return
    const now = Date.now()
    const start = Math.max(now, replicatePaceAt)
    replicatePaceAt = start + bytes / replicateBytesPerMs
    if (start > now) await new Promise(resolve => setTimeout(resolve, start - now))
  }

  // Blocks of a slice this node stores, via Hypercore's public count().
  const countLocal = (core, offset, length) => core.length > offset
    ? core.count(offset, Math.min(offset + length, core.length))
    : Promise.resolve(0)

  // Backfill stands down while any connected relay reports it is serving viewers (`peartube/bulk-busy`).
  const peersBusy = () => traffic.peersBusy()
  async function waitWhilePeersBusy () {
    while (!closed && peersBusy()) await new Promise(resolve => setTimeout(resolve, 500))
  }

  // Double-buffered 16 MiB linear windows stay sequential on spinning platters while the pacer spaces them out.
  async function downloadReplicaSlice (core, slice, minFreeBytes, stallMs, onProgress = null) {
    const endBlock = slice.blockOffset + slice.blockLength
    const countHave = () => countLocal(core, slice.blockOffset, slice.blockLength)
    let lastHave = await countHave()
    if (lastHave >= slice.blockLength) return { ok: true, bytes: slice.size }
    const avgBlock = slice.blockLength > 0 ? Math.max(4096, slice.size / slice.blockLength) : 65536
    const winBlocks = Math.max(16, Math.min(256, Math.ceil((16 * 1024 * 1024) / avgBlock)))
    const cursor = slice.blockOffset
    const openWin = async start => {
      if (start >= endBlock) return null
      const end = Math.min(endBlock, start + winBlocks)
      const have = await countLocal(core, start, end - start)
      await paceReplica((end - start - have) * avgBlock)
      await waitWhilePeersBusy()
      if (closed) return null
      const handle = { start, end, range: core.download({ start, end, linear: true }), done: false, err: null }
      activeReplicaRanges.add(handle.range)
      handle.range.done().then(() => { handle.done = true }, err => { handle.err = err; handle.done = true })
      return handle
    }
    const closeWin = h => {
      if (!h) return
      activeReplicaRanges.delete(h.range)
      h.range.destroy()
    }
    await waitWhilePeersBusy()
    let cur = await openWin(cursor)
    let next = cur && cur.end < endBlock ? await openWin(cur.end) : null
    let lastProgressAt = Date.now()
    try {
      while (cur && !closed) {
        while (!cur.done && !closed) {
          await new Promise(resolve => setTimeout(resolve, 250))
          if (peersBusy()) {
            // Drop the windows so no requests sit queued at the seeder, then pick up from this window's start.
            const resumeAt = cur.start
            closeWin(cur)
            closeWin(next)
            cur = next = null
            await waitWhilePeersBusy()
            if (closed) return { ok: false, reason: 'closed' }
            lastProgressAt = Date.now()
            cur = await openWin(resumeAt)
            next = cur && cur.end < endBlock ? await openWin(cur.end) : null
            if (!cur) return { ok: false, reason: 'closed' }
            continue
          }
          const nowHave = await countHave()
          if (nowHave > lastHave) {
            lastHave = nowHave
            lastProgressAt = Date.now()
            onProgress?.(nowHave)
            if (freeDiskBytes() < Math.max(minFreeBytes * 0.5, 4 * 1024 * 1024 * 1024)) {
              return { ok: false, reason: 'disk_full' }
            }
          } else if (Date.now() - lastProgressAt >= stallMs) {
            return { ok: false, reason: 'stalled' }
          }
        }
        if (cur.err || closed) return { ok: false, reason: closed ? 'closed' : 'error' }
        const nowHave = await countHave()
        if (nowHave > lastHave) {
          lastHave = nowHave
          lastProgressAt = Date.now()
          onProgress?.(nowHave)
        }
        closeWin(cur)
        cur = next
        next = cur && cur.end < endBlock ? await openWin(cur.end) : null
      }
      return { ok: await countHave() >= slice.blockLength, bytes: slice.size }
    } finally {
      closeWin(cur)
      closeWin(next)
    }
  }

  async function runReplicatePass (payload = {}) {
    const minFreeBytes = payload?.minFreeBytes != null ? Number(payload.minFreeBytes) : replicateMinFreeBytes
    const stallMs = payload?.stallMs != null ? Number(payload.stallMs) : replicateStallMs
    const filterSet = Array.isArray(payload?.sources) && payload.sources.length
      ? new Set(payload.sources.map(k => String(k).trim().toLowerCase()))
      : allowReplicateKeys
    const baseItems = await node.search()
    const channelSources = node.listSources?.().filter(s => s.kind === 'channel' && !s.writable) || []
    const channelItems = (await Promise.all(channelSources.map(s => node.search(null, { source: s.key }).catch(() => [])))).flat()
    const allItems = [...baseItems, ...channelItems]
    const sliceMap = new Map()
    for (const item of allItems) {
      if (item.local || !item.magnetUrl) continue
      let parsed
      try { parsed = parseUri(item.magnetUrl) } catch { continue }
      const entry = parsed?.entry
      const b = entry?.blob
      if (!entry?.blobs || !b || !(b.blockLength > 0)) continue
      const tag = `${entry.blobs}:${b.blockOffset}:${b.blockLength}`
      let rec = sliceMap.get(tag)
      if (!rec) {
        rec = {
          tag,
          id: item.id,
          title: item.title || item.id,
          size: item.size || b.byteLength || 0,
          blobs: entry.blobs,
          blockOffset: b.blockOffset,
          blockLength: b.blockLength,
          inChannel: false,
          owners: new Set([entry.blobs])
        }
        sliceMap.set(tag, rec)
      }
      if (item.source) rec.owners.add(String(item.source).toLowerCase())
      if (item.sourceKind === 'channel') rec.inChannel = true
      if (typeof item.key === 'string' && !item.key.startsWith('channel:') && !item.key.startsWith('watch/')) {
        const rawKey = item.key.replace(/^tracker:[0-9a-f]{64}\//i, '')
        const writer = rawKey.split('/')[1]
        if (writer) rec.owners.add(writer.toLowerCase())
      }
    }
    const slices = [...sliceMap.values()].filter(s => !filterSet || [...s.owners].some(o => filterSet.has(o)))
    repState.totalEntries = slices.length
    repState.targetBytes = slices.reduce((sum, s) => sum + s.size, 0)
    let doneEntries = 0
    let doneBytes = 0
    let skippedFull = 0
    let skippedDead = 0
    let prunedOnce = false
    let inflightMissingBytes = 0
    const pending = []
    // One core at a time. The node keeps 24 film cores open and closes the oldest (`blobCore`), so a pass
    // that opened its whole library first held a closed session for every core but the newest 24: a closed
    // session reports length 0, and once Hypercore lets that core's peer go, a download through it gets no
    // block. Each core is opened once here and its slices are counted while that session is open; the worker
    // takes the core again at the slice's turn.
    const byCore = new Map()
    for (const s of slices) {
      const list = byCore.get(s.blobs)
      if (list) list.push(s)
      else byCore.set(s.blobs, [s])
    }
    for (const [hex, list] of byCore) {
      if (closed) break
      const core = await node.blobCore(hex).catch(() => null)
      if (!core) { skippedDead += list.length; continue }
      for (const s of list) {
        const have = await countLocal(core, s.blockOffset, s.blockLength)
        if (have >= s.blockLength) {
          doneEntries++
          doneBytes += s.size
          continue
        }
        if (have > 0) doneBytes += Math.min(s.size, Math.round((have / s.blockLength) * s.size))
        // A slice whose length this node knows, or that a connected peer has, goes before one that nothing vouches for.
        s.known = core.length >= s.blockOffset + s.blockLength || Boolean(core.peers?.some(p => (p.remoteLength || 0) > s.blockOffset))
        pending.push(s)
      }
    }
    pending.sort((a, b) => {
      if (a.inChannel !== b.inChannel) return a.inChannel ? -1 : 1
      if (a.known !== b.known) return a.known ? -1 : 1
      return a.blobs.localeCompare(b.blobs) || (a.blockOffset - b.blockOffset)
    })

    repState.replicatedEntries = doneEntries
    repState.replicatedBytes = doneBytes
    repState.skippedDiskFull = 0
    repState.skippedUnavailable = skippedDead

    let idx = 0
    const activeTitles = new Set()
    const workerCount = Math.max(1, Math.min(replicateConcurrency, pending.length))
    async function worker () {
      // Switching replication off stops every worker at its next slice.
      while (!closed && replicateEnabled) {
        const s = pending[idx++]
        if (!s) break
        const now = Date.now()
        if ((deadReplicaCores.get(s.blobs) || 0) > now) {
          skippedDead++
          repState.skippedUnavailable = skippedDead
          continue
        }
        // The node may have closed the session that the count used: take the core again.
        let core = await node.blobCore(s.blobs).catch(() => null)
        if (!core) {
          skippedDead++
          repState.skippedUnavailable = skippedDead
          continue
        }
        const have = await countLocal(core, s.blockOffset, s.blockLength)
        if (have >= s.blockLength) {
          doneEntries++
          repState.replicatedEntries = doneEntries
          continue
        }
        const priorPartial = have > 0 ? Math.min(s.size, Math.round((have / s.blockLength) * s.size)) : 0
        const missingBytes = Math.max(0, s.size - priorPartial)
        if (freeDiskBytes() - inflightMissingBytes - missingBytes < minFreeBytes) {
          if (!prunedOnce) {
            prunedOnce = true
            await pruneUnreferencedReplicaBlocks(allItems)
            // The prune opens every listed core, so the node may have closed this one.
            core = await node.blobCore(s.blobs).catch(() => null)
            if (!core) {
              skippedDead++
              repState.skippedUnavailable = skippedDead
              continue
            }
          }
          if (freeDiskBytes() - inflightMissingBytes - missingBytes < minFreeBytes) {
            skippedFull++
            repState.skippedDiskFull = skippedFull
            continue
          }
        }
        inflightMissingBytes += missingBytes
        const label = `${s.id} · ${s.title}`
        activeTitles.add(label)
        repState.activeSlices = activeTitles.size
        repState.activeTitles = [...activeTitles]
        let reportedDelta = 0
        try {
          const res = await downloadReplicaSlice(core, s, minFreeBytes, stallMs, nowHave => {
            const curBytes = nowHave >= s.blockLength
              ? s.size
              : Math.min(s.size, Math.round((nowHave / s.blockLength) * s.size))
            const nextDelta = Math.max(0, curBytes - priorPartial)
            if (nextDelta > reportedDelta) {
              doneBytes += nextDelta - reportedDelta
              reportedDelta = nextDelta
              repState.replicatedBytes = doneBytes
            }
          })
          const afterHave = await countLocal(core, s.blockOffset, s.blockLength)
          const afterBytes = afterHave >= s.blockLength
            ? s.size
            : (afterHave > 0 ? Math.min(s.size, Math.round((afterHave / s.blockLength) * s.size)) : 0)
          const finalDelta = Math.max(0, afterBytes - priorPartial)
          if (finalDelta > reportedDelta) {
            doneBytes += finalDelta - reportedDelta
            repState.replicatedBytes = doneBytes
          }
          if (res.ok) {
            doneEntries++
            repState.replicatedEntries = doneEntries
            deadReplicaCores.delete(s.blobs)
            onchange?.()
          } else if (res.reason === 'stalled') {
            const st = node.status()
            const hasAnyPeers = (st.peers + st.lanPeers) > 0
            deadReplicaCores.set(s.blobs, Date.now() + (hasAnyPeers ? 5 * 60_000 : 15_000))
            skippedDead++
            repState.skippedUnavailable = skippedDead
          } else if (res.reason === 'disk_full') {
            skippedFull++
            repState.skippedDiskFull = skippedFull
          }
        } finally {
          inflightMissingBytes = Math.max(0, inflightMissingBytes - missingBytes)
          activeTitles.delete(label)
          repState.activeSlices = activeTitles.size
          repState.activeTitles = [...activeTitles]
        }
      }
    }
    if (pending.length > 0) {
      await Promise.all(Array.from({ length: workerCount }, () => worker()))
    }
    return {
      totalEntries: slices.length,
      replicatedEntries: doneEntries,
      replicatedBytes: doneBytes,
      targetBytes: repState.targetBytes,
      freeDiskBytes: freeDiskBytes(),
      skippedDiskFull: skippedFull,
      skippedUnavailable: skippedDead
    }
  }

  register({
    name: 'p2p-replicate',
    description: 'Replicates remote Hyperblobs slices across P2P/LAN up to a free-disk reserve with zero duplicate catalog entries',
    async run (payload) {
      if (!replicateEnabled) return { running: false, ...this.info() }
      if (replicating) {
        replicateRerun = true
        return { running: true, ...this.info() }
      }
      replicating = true
      try {
        let result
        do {
          replicateRerun = false
          result = await runReplicatePass(payload)
        } while (replicateRerun && replicateEnabled && !closed && !payload?.once)
        return result
      } finally {
        replicating = false
      }
    },
    async poll () {
      if (!replicateEnabled || replicating) return null
      return this.run({})
    },
    async stop () {
      for (const r of activeReplicaRanges) r.destroy()
      activeReplicaRanges.clear()
    },
    info: () => ({
      enabled: replicateEnabled,
      replicating,
      minFreeBytes: replicateMinFreeBytes,
      freeDiskBytes: freeDiskBytes(),
      waitingForViewers: peersBusy(),
      ...repState
    })
  })

  const hrOpts = typeof hiverelay === 'boolean'
    ? { discover: hiverelay }
    : (typeof hiverelay === 'string' || Array.isArray(hiverelay))
        ? { relays: hiverelay }
        : (hiverelay && typeof hiverelay === 'object' ? hiverelay : {})
  const traffic = createTrafficGate({ node, uploadMbps: hrOpts.uploadMbps })
  const hiverelayPlugin = register(createHiverelaySeeder({
    node,
    ...hrOpts,
    traffic,
    onchange
  }))

  // Global search offers only files whose first bytes are media (src/search.js). Each held public file is read once,
  // its first block from local disk, and the verdict kept in media-checked.json, keyed by `<blobs>:<blockOffset>` (the
  // bytes at a pointer never change). It reads 2 files a second at most, and one every 5 s while viewers are served.
  const mediaCheckedFile = join(storage, 'media-checked.json')
  const mediaChecked = new Map()
  try {
    const saved = JSON.parse(readFileSync(mediaCheckedFile, 'utf8'))
    if (saved?.version === 1 && saved.checked && typeof saved.checked === 'object') {
      for (const [k, v] of Object.entries(saved.checked)) if (typeof v === 'boolean') mediaChecked.set(k, v)
    }
  } catch {}
  let mediaCheckEnabled = Boolean(mediaCheck)
  let mediaChecking = false
  function saveMediaChecked () {
    const tmp = `${mediaCheckedFile}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, checked: Object.fromEntries(mediaChecked) }), { mode: 0o600 })
    renameSync(tmp, mediaCheckedFile)
  }
  async function readFirstBlock (entry) {
    const core = node.store.get({ key: b4a.from(entry.blobs, 'hex'), active: false })
    try {
      await core.ready()
      return await core.get(entry.blob.blockOffset, { wait: false })
    } finally {
      await core.close().catch(() => {})
    }
  }
  register({
    name: 'media-check',
    description: 'Checks once that each held public file is media, so global search can offer it',
    async run () {
      if (!mediaCheckEnabled || mediaChecking) return { busy: mediaChecking }
      mediaChecking = true
      let checked = 0
      try {
        const held = new Set()
        let whole = true
        let savedAt = Date.now()
        for (const entry of await node.publicEntries()) {
          const key = `${entry.blobs}:${entry.blob.blockOffset}`
          held.add(key)
          if (mediaChecked.has(key)) continue
          await new Promise(resolve => setTimeout(resolve, traffic.info().servingViewers ? 5000 : 500))
          if (closed || !mediaCheckEnabled) { whole = false; break }
          const head = await readFirstBlock(entry).catch(() => null)
          if (!head) continue // not on this disk after all: the next run tries again
          mediaChecked.set(key, Boolean(mediaFormat(head)))
          checked++
          if (Date.now() - savedAt > 10_000) { saveMediaChecked(); savedAt = Date.now() }
        }
        let dropped = 0
        if (whole) for (const key of mediaChecked.keys()) if (!held.has(key)) { mediaChecked.delete(key); dropped++ }
        if (checked || dropped) saveMediaChecked()
        return { checked, dropped }
      } finally {
        mediaChecking = false
      }
    },
    async poll () {
      if (!mediaCheckEnabled || mediaChecking) return null
      return this.run()
    },
    info () {
      let media = 0
      for (const v of mediaChecked.values()) if (v) media++
      return { enabled: mediaCheckEnabled, checking: mediaChecking, checkedFiles: mediaChecked.size, mediaFiles: media }
    }
  })

  // Soulseek mirrors land in the import folder the relay already sweeps, so a mirrored album sits beside (and joins)
  // the albums imported from there, under the same ledger keys. A read-only import folder (a `:ro` Docker mount)
  // cannot take them; they go to `<storage>/staging`, which `watch-dir` sweeps too under the `staging:` prefix.
  const slskStaging = watchDir && writableDir(watchDir) ? resolve(watchDir) : stagingDir
  const slskStagingLabel = slskStaging === stagingDir ? (watchDir ? 'storage (import folder is read-only)' : 'storage') : 'import folder'
  console.error(JSON.stringify({ msg: 'soulseek staging root', root: slskStaging, sweptAs: slskStaging === stagingDir ? 'staging:' : 'watch-dir' }))
  const soulseekPlugin = register(createSoulseekPlugin({
    storage,
    stagingRoot: slskStaging,
    stagingLabel: slskStagingLabel,
    placeAndScan: (place, ctx, opts) => placeAndScan(slskStaging, ctx, watchDir && resolve(watchDir) === resolve(slskStaging) ? '' : 'staging:', place, opts),
    slskUser,
    slskPass,
    slskServer,
    slskListenPort,
    slskShare,
    slskShareMaxFiles,
    onchange,
    ...soulseekOpts
  }))
  register(createYoutubePlugin({
    storage,
    stagingRoot: slskStaging,
    stagingLabel: slskStagingLabel,
    placeAndScan: (place, ctx, opts) => placeAndScan(slskStaging, ctx, watchDir && resolve(watchDir) === resolve(slskStaging) ? '' : 'staging:', place, opts),
    info: youtube?.info || null,
    download: youtube?.download || null,
    fetchBytes: url => send(url, { binary: true, timeoutMs: 8000, maxBytes: 512 * 1024 }),
    onchange
  }))

  if (pluginsDir && existsSync(pluginsDir)) {
    for (const file of readdirSync(pluginsDir).sort()) {
      if (!file.endsWith('.mjs') && !file.endsWith('.js')) continue
      try {
        const mod = await import(`file://${resolve(pluginsDir, file)}`)
        const plug = typeof mod.default === 'function' ? await mod.default({ storage, node }) : (mod.default || mod)
        if (plug?.name) register(plug)
      } catch (err) {
        console.error(JSON.stringify({ msg: 'plugin load error', file, error: err?.message || String(err) }))
      }
    }
  }

  let timer = null
  onstarting?.({ close })
  if (mirrorChannel) {
    await run('channel-backfill').catch(() => {})
  }
  if (rechunk && !closed) {
    run('blob-rechunk').catch(() => {})
  } else if (!closed) {
    // Count legacy blobs without moving any, so the UI can offer the migration only when there is something to migrate.
    node.rechunkLegacyBlobs?.({ limit: 0 }).then(res => {
      if (!rechunkProgress.running) rechunkProgress = { ...rechunkProgress, ...res, running: false }
    }).catch(() => {})
  }
  // The folder import stops between files once the host is closed.
  if (watchDir && !closed) {
    mkdirSync(watchDir, { recursive: true })
    await run('watch-dir').catch(() => {})
  }
  if (existsSync(stagingDir) && (!watchDir || resolve(watchDir) !== resolve(stagingDir)) && !closed) {
    await scanFolder(stagingDir, ctxFor('watch-dir'), 'staging:').catch(() => {})
  }
  if (configuredFeeds.length && !closed) {
    run('feed-mirror').catch(() => {})
  }
  if (replicateEnabled && !closed) {
    run('p2p-replicate').catch(() => {})
  }
  if (hiverelayPlugin.enabled() && !closed) {
    run('hiverelay-seed').catch(() => {})
  }
  if (mediaCheckEnabled && !closed) {
    run('media-check').catch(() => {})
  }

  timer = pollIntervalMs > 0 && !closed
    ? setInterval(async () => {
        if (closed) return
        for (const [name, p] of plugins) {
          if (typeof p.poll !== 'function') continue
          try {
            const res = await p.poll(ctxFor(name))
            if (res) {
              const st = stats.get(name)
              st.lastRunAt = Date.now()
              st.lastResult = res
            }
          } catch (err) {
            const st = stats.get(name)
            st.lastError = err.message
          }
        }
      }, pollIntervalMs)
    : null
  timer?.unref?.()

  function list () {
    return [...plugins.entries()].map(([name, p]) => ({
      name,
      description: p.description || '',
      searchable: typeof p.search === 'function',
      ...(typeof p.info === 'function' ? p.info() : {}),
      ...stats.get(name)
    }))
  }

  // Live settings: followed feeds and replication take effect without a restart. The import folder is fixed at start.
  function configure ({ feeds: nextFeeds, replicate: rep, replicateMinFreeBytes: minFree, replicateMbps: mbps, mediaCheck: check, slskUser: nextSlskUser, slskPass: nextSlskPass, slskServer: nextSlskServer } = {}) {
    if (check !== undefined && Boolean(check) !== mediaCheckEnabled) {
      mediaCheckEnabled = Boolean(check)
      if (mediaCheckEnabled) run('media-check').catch(() => {})
    }
    if (Array.isArray(nextFeeds) && JSON.stringify(nextFeeds) !== JSON.stringify(configuredFeeds)) {
      const added = nextFeeds.filter(u => !configuredFeeds.includes(u))
      configuredFeeds.splice(0, configuredFeeds.length, ...nextFeeds)
      for (const url of added) run('feed-mirror', { url }).catch(() => {})
    }
    if (Number.isFinite(minFree)) replicateMinFreeBytes = minFree
    if (Number.isFinite(mbps)) replicateBytesPerMs = mbps > 0 ? mbps * 125 : 0
    if (rep !== undefined) {
      const was = replicateEnabled
      setReplicate(rep)
      if (was && !replicateEnabled) {
        for (const r of activeReplicaRanges) r.destroy()
        activeReplicaRanges.clear()
      }
      if (replicateEnabled) run('p2p-replicate').catch(() => {})
    }
    if (nextSlskUser !== undefined || nextSlskPass !== undefined || nextSlskServer !== undefined) {
      soulseekPlugin.configure({ slskUser: nextSlskUser, slskPass: nextSlskPass, slskServer: nextSlskServer })
    }
    onchange?.()
  }

  async function close () {
    closed = true
    clearInterval(timer)
    // Every stop starts before any is awaited: a plugin with work parked on this host (a mirror waiting for an
    // import) must mark it stopped now, not after an earlier plugin's stop has finished.
    await Promise.all([...plugins.values()].map(p => p.stop?.()))
    traffic.stop()
  }

  // Whether the file at `<blobs>:<blockOffset>` has been checked and is media (src/search.js offers only those).
  const isMedia = key => mediaChecked.get(key) === true

  // After the owner removed announces (POST /v1/entries/remove): each `{ id, sha256 }` this relay imported from a
  // folder loses its file and its mirror-watch.json row when this relay mirrored that file, so the next scan has
  // nothing to import again. Mirrored means: it sits in `<storage>/staging`, or its album folder's MIRRORED_LIST
  // names it, or that folder carries an ALBUM_PIN (only a mirror writes one; mirrors made before MIRRORED_LIST
  // existed have the pin and no list). A file the owner put in the import folder stays, and so does its row: the
  // row matches the untouched file, which keeps the scan from importing it again until the file changes. An album
  // folder left with no files is removed with its pin. Scans wait while this runs. Returns `id/sha256` ->
  // 'deleted' | 'kept' for each file it found.
  function mirroredHere (full, root) {
    const folder = dirname(full)
    if (resolve(folder) === resolve(root)) return false
    try { if (JSON.parse(readFileSync(join(folder, MIRRORED_LIST), 'utf8')).includes(basename(full))) return true } catch {}
    return existsSync(join(folder, ALBUM_PIN))
  }
  function dropEmptyAlbumFolder (folder, root) {
    if (resolve(folder) === resolve(root)) return
    try {
      const list = join(folder, MIRRORED_LIST)
      const left = readdirSync(folder)
      if (left.some(n => n !== ALBUM_PIN && n !== MIRRORED_LIST)) {
        if (left.includes(MIRRORED_LIST)) writeFileSync(list, JSON.stringify(JSON.parse(readFileSync(list, 'utf8')).filter(n => left.includes(n))) + '\n')
        return
      }
      for (const n of left) unlinkSync(join(folder, n))
      rmdirSync(folder)
    } catch {}
  }
  async function forgetImported (gone) {
    const want = new Set(gone.map(g => `${g.id}/${g.sha256}`))
    const out = new Map()
    for (let i = 0; scanningWatchDir && i < 600; i++) await new Promise(resolve => setTimeout(resolve, 100))
    scanningWatchDir = true
    try {
      let changed = false
      for (const [ledgerKey, row] of Object.entries(watchLedger)) {
        const fk = `${row.id}/${row.sha256}`
        if (!want.has(fk)) continue
        const staged = ledgerKey.startsWith('staging:')
        const root = staged ? stagingDir : watchDir
        const full = root ? resolve(root, staged ? ledgerKey.slice(8) : ledgerKey) : ''
        const inside = full && full.startsWith(resolve(root) + sep)
        if (!inside || !(staged || mirroredHere(full, root))) {
          if (!out.has(fk)) out.set(fk, 'kept')
          continue
        }
        try { unlinkSync(full) } catch (err) {
          if (err?.code !== 'ENOENT') { if (!out.has(fk)) out.set(fk, 'kept'); continue }
        }
        try { unlinkSync(`${full}.json`) } catch {}
        delete watchLedger[ledgerKey]
        changed = true
        dropEmptyAlbumFolder(dirname(full), root)
        out.set(fk, 'deleted')
      }
      if (changed) saveWatchLedger()
    } finally {
      scanningWatchDir = false
    }
    return out
  }

  return {
    register,
    run,
    list,
    configure,
    close,
    isMedia,
    forgetImported,
    providerThumb (name, id) {
      const p = plugins.get(name)
      return typeof p?.thumbnail === 'function' ? p.thumbnail(id) : null
    },
    searchProvider (name, payload) {
      const p = plugins.get(name)
      if (!p || typeof p.search !== 'function') throw Object.assign(new Error(`Unknown provider: ${name}`), { status: 404 })
      return p.search(payload, ctxFor(name))
    },
    // One query over several sources. Each source answers under its own deadline and its own ranking: a queue place
    // on one and relevance on another cannot be compared, so rows are grouped by source, never scored across them.
    // A source that fails is one `errors` entry; the others still answer. `onSource` gets each source's part as it
    // finishes (the fastest first), for a caller that streams.
    async searchSources ({ query, sources, limit, timeoutMs } = {}, onSource = null) {
      const q = String(query || '').trim()
      if (!q) throw Object.assign(new Error('query is required'), { status: 400 })
      const known = [...plugins.entries()].filter(([, p]) => typeof p.search === 'function').map(([name]) => name)
      // No `sources` means every source. Anything else must be a list that names at least one: a string or an
      // empty list is a caller's mistake, not a request for everything.
      if (sources != null && (!Array.isArray(sources) || !sources.length || sources.some(s => typeof s !== 'string'))) {
        throw Object.assign(new Error(`sources must be a list of source names (known: ${known.join(', ')})`), { status: 400 })
      }
      const wanted = sources ? [...new Set(sources)] : known
      const unknown = wanted.find(name => !known.includes(name))
      if (unknown) throw Object.assign(new Error(`Unknown source: ${unknown} (known: ${known.join(', ')})`), { status: 400 })
      const deadline = Math.max(1000, Math.min(45_000, Number(timeoutMs) || 30_000))
      const parts = await Promise.all(wanted.map(async name => {
        let timer
        let part
        try {
          const res = await Promise.race([
            plugins.get(name).search({ query: q, ...(limit ? { limit } : {}) }, ctxFor(name)),
            new Promise((_resolve, reject) => {
              timer = setTimeout(() => reject(Object.assign(new Error(`No answer in ${Math.round(deadline / 1000)} s`), { status: 504 })), deadline)
            })
          ])
          const results = (res?.candidates || []).map(c => ({
            title: c.title || String(c.filename || '').replace(/\\/g, '/').split('/').pop() || '',
            lossy: c.lossy === true || LOSSY_FILE.test(String(c.filename || '')) ? true : null,
            ...c,
            source: name
          }))
          part = { source: name, results, truncated: Boolean(res?.truncated) }
        } catch (err) {
          part = { source: name, results: [], truncated: false, error: { source: name, status: Number(err?.status) || 502, message: String(err?.message || err).slice(0, 300) } }
        } finally {
          clearTimeout(timer)
        }
        onSource?.(part)
        return part
      }))
      return {
        query: q,
        sources: wanted,
        results: parts.flatMap(p => p.results),
        bySource: Object.fromEntries(parts.map(p => [p.source, p.results.length])),
        truncated: Object.fromEntries(parts.map(p => [p.source, p.truncated])),
        errors: parts.filter(p => p.error).map(p => p.error)
      }
    },
    browseProvider (name, payload) {
      const p = plugins.get(name)
      if (!p || typeof p.browse !== 'function') throw Object.assign(new Error(`Unknown provider: ${name}`), { status: 404 })
      return p.browse(payload, ctxFor(name))
    },
    mirrorProvider (name, payload) {
      const p = plugins.get(name)
      if (!p || typeof p.mirror !== 'function') throw Object.assign(new Error(`Unknown provider: ${name}`), { status: 404 })
      return p.mirror(payload, ctxFor(name))
    },
    listProviderJobs () {
      const out = []
      for (const p of plugins.values()) {
        if (typeof p.listJobs === 'function') out.push(...p.listJobs())
      }
      return out
    },
    getProviderJob (jobId) {
      for (const p of plugins.values()) {
        const j = p.getJob?.(jobId)
        if (j) return j
      }
      return null
    },
    cancelProviderJob (jobId) {
      for (const p of plugins.values()) {
        const j = p.cancelJob?.(jobId)
        if (j) return j
      }
      return null
    }
  }
}
