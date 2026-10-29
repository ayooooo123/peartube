// Formal Mirror Plugin Host for PearTube relays:
//   - Integrates the durable HTTP/debrid acquirer (`jobs.json`) as the core `http-acquire` plugin
//   - Automatically backfills all previously saved tracker blobs into this relay's single-writer Channel (`channel-backfill`)
//   - Mirrors local media folders (`watch-dir`, e.g. `/data/import` on Unraid) without re-ingesting unchanged files
//   - Mirrors remote JSON manifests or peer relay `/v1/entries` catalogs (`feed-mirror`)
//   - Greedy P2P Hyperblobs block replication (`p2p-replicate`) to stuff a replica disk full without duplicating catalog ops
//   - Recruits existing HiveRelays (`hiverelay-seed`) via HTTP `/seed-core` and P2P `hiverelay-seed` DHT as supplemental seeders
//   - Dynamically loads custom user plugins dropped into `/data/plugins/*.mjs` or `*.js`
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { basename, extname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import b4a from 'b4a'
import { parseUri } from './index.js'
import { createHiverelaySeeder } from './hiverelay.js'

const VALID_ID = /^[a-z0-9]+:[a-z0-9]+(:s\d{2}e\d{2,3})?$/
const CREDENTIAL_HEADER = /^(authorization|cookie|proxy-authorization)$/i
// Like fetch: credentials never follow a URL to another origin.
const headersFor = (headers, from, to) => from.origin === to.origin
  ? headers
  : Object.fromEntries(Object.entries(headers).filter(([k]) => !CREDENTIAL_HEADER.test(k)))
const MEDIA_EXT = new Set(['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.ts', '.m2ts', '.mpg', '.mpeg', '.ogv', '.ogg', '.flac', '.mp3', '.opus', '.wav', '.aac'])

function fetchJson (url, headers = {}, redirects = 0) {
  return new Promise((resolveJson, reject) => {
    const parsed = new URL(url)
    const fn = parsed.protocol === 'https:' ? httpsRequest : httpRequest
    const req = fn(parsed, { headers: { accept: 'application/json', ...headers } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume?.()
        const target = new URL(res.headers.location, parsed)
        resolveJson(fetchJson(target.href, headersFor(headers, parsed, target), redirects + 1))
        return
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume?.()
        reject(new Error(`Feed ${url} answered ${res.statusCode}`))
        return
      }
      const chunks = []
      let total = 0
      // A body cut short, or destroyed at the size cap below, errors here; unheard, it would crash the relay.
      res.once('error', reject)
      res.on('data', chunk => {
        const buf = typeof chunk === 'string' ? b4a.from(chunk) : chunk
        total += buf.length
        if (total > 8 * 1024 * 1024) { req.destroy(new Error('Feed payload exceeded 8 MiB')); return }
        chunks.push(buf)
      })
      res.on('end', () => {
        try { resolveJson(JSON.parse(b4a.toString(b4a.concat(chunks)))) } catch (err) { reject(err) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// Infers a canonical PearTube ID (`imdb:tt...:s01e02`, `imdb:tt...`, or `clip:<slug>`) from a filename or sidecar.
export function inferMediaMeta (filePath, sidecar = null) {
  const stem = basename(filePath, extname(filePath))
  if (sidecar && typeof sidecar.id === 'string' && VALID_ID.test(sidecar.id.toLowerCase())) {
    return { id: sidecar.id.toLowerCase(), title: String(sidecar.title || stem).slice(0, 300) }
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
  pluginsDir = join(storage, 'plugins'),
  pollIntervalMs = 60_000,
  onchange = null
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
            (j.status === 'queued' || j.status === 'running' || j.status === 'announcing' || j.status === 'done') &&
            ((id && j.id === id) || (sha256 && j.sha256 === sha256))
          )
          if (active) return true
        }
        const entries = await node.search(id || null)
        return entries.some(e => (id ? e.id === id : true) && (sha256 ? e.sha256 === sha256 : true) && (e.local || !sha256))
      },
      enqueue ({ id, title, source, channel = mirrorChannel }) {
        if (!acquirer) throw new Error('HTTP acquirer unavailable on this peer')
        const job = acquirer.add({ id, title, source, channel, plugin: pluginName })
        onchange?.()
        return job
      },
      async ingestStream ({ id, title, stream, channel = mirrorChannel }) {
        const op = await node.put({ id, title }, stream)
        await node.append(op)
        if (channel) await node.publishChannel(op)
        onchange?.()
        return op
      },
      async repost (entry, { pin = false, channel = mirrorChannel, tracker = true } = {}) {
        const op = { type: 'announce', id: entry.id, title: entry.title, size: entry.size, sha256: entry.sha256, blobs: entry.blobs, blob: entry.blob }
        if (tracker) await node.append(op)
        if (channel) await node.publishChannel(op)
        if (pin) await node.warm(op)
        onchange?.()
        return op
      },
      async publishDirectory ({ sourceKey, kind = 'channel', title, target = 'both' }) {
        const res = await node.publishSource({ sourceKey, kind, title }, { target })
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

  // 1. Built-in plugin: durable HTTP/HTTPS debrid acquirer (`jobs.json`).
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
        activeJobs: list.filter(j => j.status === 'queued' || j.status === 'running' || j.status === 'announcing').length,
        doneJobs: list.filter(j => j.status === 'done').length
      }
    }
  })

  // 2. Built-in plugin: zero-copy backfill of existing saved tracker blobs into the single-writer Hyperbee channel.
  register({
    name: 'channel-backfill',
    description: 'Backfills previously saved local tracker blobs into this relay\'s single-writer channel with zero byte duplication',
    async run () {
      return node.syncLocalChannel()
    }
  })

  // 2b. Built-in plugin: SHA-256-verified migration of legacy variable-block blobs into uniform 512 KiB slots.
  let rechunkRunning = false
  let rechunkProgress = { running: false, total: 0, migrated: 0, deduped: 0, remaining: 0, migratedBytes: 0, currentId: null, currentTitle: null }
  register({
    name: 'blob-rechunk',
    description: 'Re-chunks legacy variable-block local blobs into uniform 512 KiB blocks with SHA-256 verification and space reclamation',
    async run (payload = {}) {
      if (rechunkRunning) return { busy: true, ...rechunkProgress }
      if (typeof node.rechunkLegacyBlobs !== 'function') return { skipped: true }
      rechunkRunning = true
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
        rechunkRunning = false
        rechunkProgress.running = false
      }
    },
    info () {
      return { ...rechunkProgress }
    }
  })

  // 3. Built-in plugin: local directory Drop/Watch folder mirror (e.g. /data/import on Unraid).
  let scanningWatchDir = false
  async function scanFolder (dir, ctx) {
    if (!dir || !existsSync(dir)) return { scanned: 0, ingested: 0, items: [] }
    if (scanningWatchDir) return { scanned: 0, ingested: 0, busy: true, items: [] }
    scanningWatchDir = true
    try {
      const root = resolve(dir)
      const names = readdirSync(root).sort()
      let scanned = 0
      const ingested = []
      for (const name of names) {
        if (closed) break
        const ext = extname(name).toLowerCase()
        if (!MEDIA_EXT.has(ext)) continue
        const full = join(root, name)
        let st
        try { st = statSync(full) } catch { continue }
        if (!st.isFile() || st.size <= 0) continue
        scanned++
        const prev = watchLedger[name]
        if (prev && prev.size === st.size && prev.mtimeMs === Math.trunc(st.mtimeMs)) continue
        let sidecar = null
        const sidecarPath = `${full}.json`
        if (existsSync(sidecarPath)) {
          try { sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) } catch {}
        }
        const meta = inferMediaMeta(full, sidecar)
        const op = await ctx.ingestStream({ id: meta.id, title: meta.title, stream: createReadStream(full), channel: mirrorChannel })
        watchLedger[name] = { size: st.size, mtimeMs: Math.trunc(st.mtimeMs), id: op.id, sha256: op.sha256, ingestedAt: Date.now() }
        saveWatchLedger()
        ingested.push({ file: name, id: op.id, title: op.title, size: op.size, sha256: op.sha256 })
      }
      return { scanned, ingested: ingested.length, items: ingested }
    } finally {
      scanningWatchDir = false
    }
  }

  register({
    name: 'watch-dir',
    description: 'Ingests media files dropped into a local folder (PEARTUBE_WATCH_DIR) once, tracking fingerprints in mirror-watch.json',
    async run (payload, ctx) {
      return scanFolder(payload?.dir || watchDir, ctx)
    },
    async poll (ctx) {
      if (watchDir) return scanFolder(watchDir, ctx)
      return null
    },
    info: () => ({ watchDir: watchDir || null, trackedFiles: Object.keys(watchLedger).length })
  })

  // 4. Built-in plugin: JSON manifest & remote PearTube relay `/v1/entries` mirror.
  const configuredFeeds = [...feeds]
  // feedUrl is set when the items came from a fetched feed: its headers are that feed's credentials, so they go only to
  // item URLs on the feed's own origin, never to every host the feed lists.
  async function mirrorFeedItems (items, headers, ctx, feedUrl = null) {
    let enqueued = 0
    let skipped = 0
    const jobs = []
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const id = String(item.id || '').toLowerCase()
      if (!VALID_ID.test(id)) continue
      const sha256 = typeof item.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(item.sha256) ? item.sha256.toLowerCase() : null
      if (await ctx.has({ id, sha256 })) { skipped++; continue }
      const url = item.source?.url || item.url || item.streamUrl
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) { skipped++; continue }
      let itemUrl
      try { itemUrl = new URL(url) } catch { skipped++; continue }
      const job = ctx.enqueue({
        id,
        title: item.title || id,
        source: { url, headers: { ...(feedUrl ? headersFor(headers, new URL(feedUrl), itemUrl) : headers), ...(item.source?.headers || item.headers || {}) } },
        channel: mirrorChannel
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
        const res = await mirrorFeedItems(list, payload?.headers || {}, ctx, u)
        enqueued += res.enqueued
        skipped += res.skipped
      }
      return { feeds: targetUrls.length, enqueued, skipped }
    },
    async poll (ctx) {
      if (!configuredFeeds.length) return null
      return this.run({}, ctx)
    },
    info: () => ({ feeds: configuredFeeds })
  })

  // 5. Built-in plugin: greedy P2P Hyperblobs block replicator — sucks every announced peer slice onto disk up to the free-space floor without forging duplicate tracker entries.
  const allowReplicateKeys = Array.isArray(replicate) && replicate.length
    ? new Set(replicate.map(k => String(k).trim().toLowerCase()).filter(Boolean))
    : null
  const replicateEnabled = Boolean(replicate) && (!Array.isArray(replicate) || Boolean(allowReplicateKeys?.size))
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
  const replicateBytesPerMs = replicateMbps > 0 ? replicateMbps * 125 : 0
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
  const peersBusy = () => hiverelayPlugin.peersBusy() === true
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
    const uniqueBlobs = [...new Set(slices.map(s => s.blobs))]
    const cores = new Map()
    await Promise.all(uniqueBlobs.map(async hex => {
      const c = await node.blobCore(hex).catch(() => null)
      if (c) cores.set(hex, c)
    }))
    slices.sort((a, b) => {
      if (a.inChannel !== b.inChannel) return a.inChannel ? -1 : 1
      const ca = cores.get(a.blobs), cb = cores.get(b.blobs)
      const pa = Boolean(ca && (ca.length >= a.blockOffset + a.blockLength || ca.peers?.some(p => (p.remoteLength || 0) > a.blockOffset)))
      const pb = Boolean(cb && (cb.length >= b.blockOffset + b.blockLength || cb.peers?.some(p => (p.remoteLength || 0) > b.blockOffset)))
      if (pa !== pb) return pa ? -1 : 1
      return a.blobs.localeCompare(b.blobs) || (a.blockOffset - b.blockOffset)
    })

    repState.totalEntries = slices.length
    repState.targetBytes = slices.reduce((sum, s) => sum + s.size, 0)
    let doneEntries = 0
    let doneBytes = 0
    let skippedFull = 0
    let skippedDead = 0
    let prunedOnce = false
    let inflightMissingBytes = 0
    const pending = []
    for (const s of slices) {
      const core = cores.get(s.blobs)
      if (!core) { skippedDead++; continue }
      const have = await countLocal(core, s.blockOffset, s.blockLength)
      if (have >= s.blockLength) {
        doneEntries++
        doneBytes += s.size
      } else {
        if (have > 0) doneBytes += Math.min(s.size, Math.round((have / s.blockLength) * s.size))
        pending.push(s)
      }
    }
    repState.replicatedEntries = doneEntries
    repState.replicatedBytes = doneBytes
    repState.skippedDiskFull = 0
    repState.skippedUnavailable = skippedDead

    let idx = 0
    const activeTitles = new Set()
    const workerCount = Math.max(1, Math.min(replicateConcurrency, pending.length))
    async function worker () {
      while (!closed) {
        const s = pending[idx++]
        if (!s) break
        const core = cores.get(s.blobs)
        if (!core) continue
        const now = Date.now()
        if ((deadReplicaCores.get(s.blobs) || 0) > now) {
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
        } while (replicateRerun && !closed && !payload?.once)
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
      ...repState
    })
  })

  // 6. Built-in plugin: supplemental HiveRelay seeder bridge (operator HTTP `/seed-core` + zero-key P2P `hiverelay-seed` DHT).
  const hrOpts = typeof hiverelay === 'boolean'
    ? { discover: hiverelay }
    : (typeof hiverelay === 'string' || Array.isArray(hiverelay))
        ? { relays: hiverelay }
        : (hiverelay && typeof hiverelay === 'object' ? hiverelay : {})
  const hiverelayPlugin = register(createHiverelaySeeder({
    node,
    ...hrOpts,
    onchange
  }))

  // Load any external user plugins placed in `/data/plugins/*.mjs` or `*.js`.
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

  // Backfill any previously saved tracker entries into this relay's single-writer channel right on boot!
  if (mirrorChannel) {
    await run('channel-backfill').catch(() => {})
  }
  if (rechunk) {
    run('blob-rechunk').catch(() => {})
  }
  if (watchDir) {
    mkdirSync(watchDir, { recursive: true })
    await run('watch-dir').catch(() => {})
  }
  if (configuredFeeds.length) {
    run('feed-mirror').catch(() => {})
  }
  if (replicateEnabled) {
    run('p2p-replicate').catch(() => {})
  }
  if (hiverelayPlugin.enabled()) {
    run('hiverelay-seed').catch(() => {})
  }

  const timer = pollIntervalMs > 0
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
      ...(typeof p.info === 'function' ? p.info() : {}),
      ...stats.get(name)
    }))
  }

  async function close () {
    closed = true
    clearInterval(timer)
    for (const p of plugins.values()) await p.stop?.()
  }

  return { register, run, list, close }
}
