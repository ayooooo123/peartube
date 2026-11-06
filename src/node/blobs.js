import Hyperblobs from 'hyperblobs'
import Hyperbee from 'hyperbee2'
import hypercoreCrypto from 'hypercore-crypto'
import { createBlobRangeServer } from '../blob-server.js'
import b4a from 'b4a'
import { createHash } from 'node:crypto'
import { pipelinePromise, Readable, Transform } from 'streamx'
import { readdirSync, readFileSync, statfsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { unwrapVideoKey, wrapVideoKey } from '../mnemonic.js'
import { BLOB_BLOCK_SIZE, HEX64, ID, cleanText, decodeOp, formatWatchUri, isSystemViewKey, isUniform512, str } from '../protocol.js'

const coreByteLen = c => c.byteLength || 0

export async function createBlobs (ctx) {
  const { storage, worklet: isWorklet } = ctx.opts

  // Legacy shared slots stay readable & migratable in place; every new video gets its own 512 KiB-piece Hypercore closed at rest.
  const blobSlots = []
  const blobCores = new Map()
  const ownedBlobs = new Map() // blobsHex -> { length, byteLength }
  const ownedByDiscovery = new Map() // discoveryKeyHex -> blobsHex
  const cachedBlobs = new Map() // blobsHex -> { length, byteLength, blocks, slices }
  // Cache ceiling. Clients own watch history; the peer only knows what it
  // served, so recency comes from this node's own touch points and is persisted
  // beside settings.json. Everything is measured against the same estimate
  // `status()` reports, because Hypercore never shrinks `byteLength` on clear.
  const cacheLruPath = join(storage, 'cache-lru.json')
  const lastUsedAt = new Map() // blobsHex -> ms
  try {
    const savedLru = JSON.parse(readFileSync(cacheLruPath, 'utf8'))
    for (const [hex, at] of Object.entries(savedLru)) {
      if (HEX64.test(hex) && Number.isFinite(at)) lastUsedAt.set(hex, at)
    }
  } catch {}
  let lruTimer = null
  function touchCached (hex) {
    if (!hex || ctx.life.closing) return
    lastUsedAt.set(hex, Date.now())
    if (lruTimer) return
    lruTimer = setTimeout(() => {
      lruTimer = null
      try {
        writeFileSync(cacheLruPath, JSON.stringify(Object.fromEntries(lastUsedAt)), { mode: 0o600 })
      } catch {}
    }, 2000)
    lruTimer.unref?.()
  }
  let cacheMaxBytes = 0
  let cacheGrowth = 0
  let ceilingPass = null
  let ceilingTimer = null
  // What the filesystem can spare, minus a reserve: the ceiling must never be
  // the thing that fills the disk, even if the user sets a huge contribution.
  const CACHE_DISK_RESERVE = 2 * 1024 * 1024 * 1024
  function cacheFloorBytes () {
    try {
      const st = statfsSync(storage)
      return Math.max(0, Number(st.bavail) * Number(st.bsize) - CACHE_DISK_RESERVE)
    } catch {
      return Infinity
    }
  }
  const cachedByDiscovery = new Map() // discoveryKeyHex -> blobsHex
  const encryptedBlobs = new Map() // blobsHex -> { source, epoch, wrappedKey }
  const unlockedVideoKeys = new Map() // blobsHex -> Buffer(32)
  const registerOwned = (hex, meta) => {
    ownedBlobs.set(hex, meta)
    ownedByDiscovery.set(b4a.toString(hypercoreCrypto.discoveryKey(b4a.from(hex, 'hex')), 'hex'), hex)
  }
  function resolveVideoKey (entry, sourceHex) {
    if (!entry?.wrappedKey) return null
    encryptedBlobs.set(entry.blobs, { source: sourceHex, epoch: entry.epoch || 1, wrappedKey: entry.wrappedKey })
    const cached = unlockedVideoKeys.get(entry.blobs)
    if (cached) return cached
    const ep = entry.epoch || 1
    const candidates = []
    if (ctx.identity.idVault) {
      candidates.push(ctx.identity.idVault.epochKey(sourceHex, ep))
    }
    const passHex = ctx.identity.accessKeys.get(`${sourceHex}:${ep}`)
    if (passHex) candidates.push(b4a.from(passHex, 'hex'))
    for (const ek of candidates) {
      const vk = unwrapVideoKey(entry.wrappedKey, ek)
      if (vk) {
        unlockedVideoKeys.set(entry.blobs, vk)
        return vk
      }
    }
    return null
  }
  function resolveBlobEncryptionKey (hex) {
    const cached = unlockedVideoKeys.get(hex)
    if (cached) return cached
    const meta = encryptedBlobs.get(hex)
    if (!meta) return null
    return resolveVideoKey({ blobs: hex, epoch: meta.epoch, wrappedKey: meta.wrappedKey }, meta.source)
  }
  async function openSlot (i) {
    const core = ctx.storage.store.get({ name: i === 0 ? 'blobs' : `blobs-${i}` })
    await core.ready()
    const slot = { core, blobs: new Hyperblobs(core, { blockSize: BLOB_BLOCK_SIZE }), key: b4a.toString(core.key, 'hex') }
    blobSlots.push(slot)
    blobCores.set(slot.key, core)
    return slot
  }
  await openSlot(0)
  for (let i = 1; i < 64; i++) {
    const core = ctx.storage.store.get({ name: `blobs-${i}` })
    await core.ready()
    if (core.length === 0) { await core.close(); if (i >= 4) break; else continue }
    const slot = { core, blobs: new Hyperblobs(core, { blockSize: BLOB_BLOCK_SIZE }), key: b4a.toString(core.key, 'hex') }
    blobSlots.push(slot)
    blobCores.set(slot.key, core)
  }
  const slotSet = new Set(blobSlots.map(s => s.key))
  const isOwnedBlob = hex => ownedBlobs.has(hex) || slotSet.has(hex)
  const blobsKey = blobSlots[0].key

  async function hydrateOwned () {
    const candidates = new Set()
    const channel = ctx.channel.channel
    const primaryKey = ctx.channel.primaryKey
    const writer = b4a.toString(channel.local.key, 'hex')
    for await (const n of channel.view.createReadStream()) {
      const k = b4a.toString(n.key)
      if (k.startsWith('writer/')) {
        const wHex = k.slice(7)
        if (wHex !== primaryKey) ctx.channel.secondaryWriters.add(wHex)
        continue
      }
      if (k.startsWith('source/')) {
        ctx.channel.markHasEntries()
        continue
      }
      if (isSystemViewKey(k)) continue
      ctx.channel.markHasEntries()
      const op = decodeOp(n.value)
      if (!op || op.type !== 'announce') continue
      if (op.wrappedKey) resolveVideoKey(op, primaryKey)
      if (k.split('/')[1] === writer && !slotSet.has(op.blobs)) candidates.add(op.blobs)
    }
    await ctx.channel.syncWriterCores()
    const keys = [...candidates].filter(hex => !ownedBlobs.has(hex))
    for (let i = 0; i < keys.length; i += 32) {
      await Promise.all(keys.slice(i, i + 32).map(async hex => {
        const c = ctx.storage.store.get({ key: b4a.from(hex, 'hex') })
        try {
          await c.ready()
          if (c.writable && c.length > 0) {
            registerOwned(hex, { length: c.length, byteLength: c.byteLength })
          }
        } finally {
          await c.close().catch(() => {})
        }
      }))
    }
  }
  await hydrateOwned()

  // Bounded Range blob server on its own store session (its close() closes the store it is given).
  // resolve() wakes the video core with our inflightRange and flags owned cores inactive so they never linger.
  let lastHttpViewAt = 0
  const weakOwned = new Map() // blobsHex -> weak Hypercore session
  const httpOwned = new Map() // blobsHex -> { core, timer }
  async function dropOwned (hex) {
    ownedBlobs.delete(hex)
    ownedByDiscovery.delete(b4a.toString(hypercoreCrypto.discoveryKey(b4a.from(hex, 'hex')), 'hex'))
    const w = weakOwned.get(hex)
    weakOwned.delete(hex)
    const h = httpOwned.get(hex)
    if (h) { clearTimeout(h.timer); httpOwned.delete(hex) }
    if (w) await w.close().catch(() => {})
    if (h) await h.core.close().catch(() => {})
  }

  let server = null
  function streamUrl (entry) {
    return server.getLink(b4a.from(entry.blobs, 'hex'), { blob: entry.blob })
  }

  // Local block counts per core, kept beside Hypercore from its public count() and download/append events.
  const blockCounts = new WeakMap() // core -> { blocks, slices: Map<'offset:len', blocks>, ready }
  async function syncBlockCounter (core) {
    const c = blockCounts.get(core)
    if (!c) return
    c.slices.clear()
    c.blocks = core.length > 0 ? await core.count(0, core.length) : 0
  }
  const localBlocks = core => blockCounts.get(core)?.blocks || 0

  // Multi-cursor 16 MiB parallel read-ahead across libuv workers for human viewers (skipped for bulkPeers so HiveRelays never thrash array disks).
  const bulkPeers = new Set()
  const warmCursors = new WeakMap()
  function warmAhead (core, index, lookahead = 32) {
    if (ctx.life.closing || !core?.opened || core.length <= 0) return
    let cursors = warmCursors.get(core)
    if (!cursors) { cursors = []; warmCursors.set(core, cursors) }
    const stride = lookahead >> 1
    const now = Date.now()
    let cur = cursors.find(c => index >= c.from - 2 && index <= c.upTo + 2)
    if (!cur) {
      if (cursors.length >= 4) {
        cursors.sort((a, b) => a.at - b.at)
        cur = cursors[0]
      } else {
        cur = { from: 0, upTo: -1, at: 0 }
        cursors.push(cur)
      }
      cur.from = Math.max(0, index)
      cur.upTo = index
    }
    cur.at = now
    if (index + (lookahead - stride) < cur.upTo) return
    const start = Math.max(0, index + 1, cur.upTo + 1)
    const end = Math.min(core.length, index + 1 + lookahead)
    if (end <= start) return
    cur.upTo = end - 1
    for (let i = start; i < end; i++) core.get(i, { wait: false }).catch(() => {})
  }
  const warmAttached = new WeakSet()
  let playerActive = false
  function setPlayerActive (active) {
    playerActive = Boolean(active)
    if (playerActive) for (const ranges of warmRanges.values()) for (const r of ranges) r.destroy()
  }

  function attachUploadWarmth (core) {
    if (!core || warmAttached.has(core)) return
    warmAttached.add(core)
    core.on('upload', (index, byteLen, peer) => {
      // Watching while seeding: our own player must never wait behind the blocks we fetch ahead
      // for someone else. Peers still get every block on demand; only the read-ahead stops.
      if (playerActive) return
      if (peer?.remotePublicKey && bulkPeers.has(b4a.toString(peer.remotePublicKey, 'hex'))) return
      warmAhead(core, index, byteLen > 0 && byteLen <= 131072 ? 128 : 32)
    })
  }
  const absentDisc = new Set()
  const discByBlob = new Map()
  function blobDisc (hex) {
    let d = discByBlob.get(hex)
    if (!d) {
      const buf = hypercoreCrypto.discoveryKey(b4a.from(hex, 'hex'))
      d = { buf, hex: b4a.toString(buf, 'hex') }
      discByBlob.set(hex, d)
    }
    return d
  }
  function recordCached (hex, length, byteLength, blocks, prevSlices = null) {
    if (!hex || isOwnedBlob(hex)) return
    const existing = cachedBlobs.get(hex)
    const slices = prevSlices || (existing && existing.length === length && existing.blocks === blocks ? existing.slices : new Map())
    cachedBlobs.set(hex, { length, byteLength, blocks, slices })
    const discHex = blobDisc(hex).hex
    if (blocks > 0) cachedByDiscovery.set(discHex, hex)
    else cachedByDiscovery.delete(discHex)
  }
  const onCoreWake = raw => {
    if (ctx.life.closing || !raw?.discoveryKey) return
    const discHex = b4a.toString(raw.discoveryKey, 'hex')
    ctx.storage.storedDisc.add(discHex)
    absentDisc.delete(discHex)
    const hex = ownedByDiscovery.get(discHex) || cachedByDiscovery.get(discHex)
    if (!hex || weakOwned.has(hex) || blobCores.has(hex)) return
    queueMicrotask(() => {
      if (ctx.life.closing || (!ownedBlobs.has(hex) && !cachedBlobs.has(hex)) || weakOwned.has(hex) || blobCores.has(hex)) return
      const s = ctx.storage.store.get({ key: b4a.from(hex, 'hex'), weak: true, active: false })
      weakOwned.set(hex, s)
      s.once('close', () => { if (weakOwned.get(hex) === s) weakOwned.delete(hex) })
      s.ready().then(() => { if (!s.closed && !s.closing) attachUploadWarmth(s) }).catch(() => {})
    })
  }

  function ensureBlockCounter (core, hex = null) {
    let c = blockCounts.get(core)
    if (c) return c
    c = { blocks: 0, slices: new Map(), ready: null }
    blockCounts.set(core, c)
    c.ready = syncBlockCounter(core).then(() => {
      if (hex) recordCached(hex, core.length, core.byteLength, c.blocks, c.slices)
    }).catch(() => {})
    core.on('download', (index, byteLength) => {
      c.blocks++
      c.slices.clear()
      if (hex) {
        recordCached(hex, core.length, core.byteLength, c.blocks, c.slices)
        touchCached(hex)
      }
      // A 4K remux pulls gigabytes in seconds, so growth is bounded between
      // passes instead of only when playback starts.
      cacheGrowth += Number.isFinite(byteLength) && byteLength > 0 ? byteLength : 1 << 19
      const step = Math.max(256 * 1024 * 1024, Math.floor(cacheMaxBytes / 50))
      if (cacheMaxBytes > 0 && cacheGrowth >= step) {
        cacheGrowth = 0
        scheduleCeiling()
      }
    })
    core.on('append', () => {
      syncBlockCounter(core).then(() => {
        if (hex) recordCached(hex, core.length, core.byteLength, c.blocks, c.slices)
      }).catch(() => {})
    })
    attachUploadWarmth(core)
    return c
  }

  const maxOpenBlobCores = isWorklet ? 6 : 24
  function evictIdleBlobCores (keepHex) {
    if (blobCores.size <= slotSet.size + maxOpenBlobCores) return
    for (const [k, v] of blobCores) {
      if (blobCores.size <= slotSet.size + maxOpenBlobCores) break
      if (k === keepHex || slotSet.has(k)) continue
      let warming = false
      for (const tag of warmRanges.keys()) {
        if (tag.startsWith(`${k}:`)) { warming = true; break }
      }
      if (warming || v.peers?.some(p => p.inflight > 0)) continue
      if (v.opened) recordCached(k, v.length, v.byteLength, localBlocks(v), blockCounts.get(v)?.slices)
      blobCores.delete(k)
      v.close().catch(() => {})
    }
  }

  async function blobCore (hex) {
    let core = blobCores.get(hex)
    if (core) {
      blobCores.delete(hex)
      blobCores.set(hex, core)
    } else {
      const slot = blobSlots.find(s => s.key === hex)
      core = slot ? slot.core : ctx.storage.store.get({ key: b4a.from(hex, 'hex'), inflightRange: ctx.net.inflightRange() })
      blobCores.set(hex, core)
    }
    if (!core.opened) await core.ready()
    await ensureBlockCounter(core, hex).ready
    recordCached(hex, core.length, core.byteLength, localBlocks(core), blockCounts.get(core)?.slices)
    touchCached(hex)
    evictIdleBlobCores(hex)
    // Make room before a new film lands, and never evict the one playing now.
    scheduleCeiling({ keepHex: hex })
    return core
  }

  // Bounded head (4 MiB) + tail (1 MiB moov/cues) prefetcher so playback starts immediately.
  const warmRanges = new Map()
  async function warm (entry) {
    if (!entry?.blobs || !entry?.blob) return
    ctx.net.joinContentSwarm(entry.blobs)
    const core = await blobCore(entry.blobs)
    const tag = `${entry.blobs}:${entry.blob.blockOffset}`
    if (warmRanges.has(tag)) return
    if (warmRanges.size >= 8) {
      const oldest = warmRanges.keys().next().value
      for (const r of warmRanges.get(oldest)) r.destroy()
      warmRanges.delete(oldest)
    }
    const { blockOffset, blockLength, byteLength } = entry.blob
    const avgBs = Math.max(4096, Math.round((byteLength || BLOB_BLOCK_SIZE) / Math.max(1, blockLength)))
    const scale = avgBs <= 16384 ? 3 : avgBs <= 131072 ? 2 : 1
    const endBlock = blockOffset + blockLength
    const headEnd = Math.min(endBlock, blockOffset + 8 * scale)
    const ranges = [core.download({ start: blockOffset, end: headEnd, linear: true })]
    if (endBlock > headEnd) ranges.push(core.download({ start: Math.max(headEnd, endBlock - 2 * scale), end: endBlock, linear: true }))
    warmRanges.set(tag, ranges)
  }

  async function entryCachedBytes (core, entry) {
    const { blockOffset, blockLength } = entry.blob
    if (blockLength <= 0) return 0
    if (core?.opened) {
      if (core.length <= blockOffset) return 0
      const c = ensureBlockCounter(core, entry.blobs)
      await c.ready
      if (c.blocks === 0) return 0
      const len = Math.min(blockLength, core.length - blockOffset)
      const tag = `${blockOffset}:${len}`
      let blocks = blockOffset === 0 && len >= core.length ? c.blocks : c.slices.get(tag)
      if (blocks === undefined) {
        blocks = await core.count(blockOffset, blockOffset + len)
        if (c.slices.size >= 512) c.slices.clear()
        c.slices.set(tag, blocks)
      }
      if (blocks <= 0) return 0
      return blocks >= blockLength ? entry.size : Math.min(entry.size, Math.round((blocks / blockLength) * entry.size))
    }
    const meta = cachedBlobs.get(entry.blobs)
    if (!meta || meta.blocks <= 0 || meta.length <= blockOffset) return 0
    const len = Math.min(blockLength, meta.length - blockOffset)
    const tag = `${blockOffset}:${len}`
    let blocks = meta.blocks >= meta.length ? len : (blockOffset === 0 && len >= meta.length ? meta.blocks : meta.slices.get(tag))
    if (blocks === undefined) {
      const tmp = ctx.storage.store.get({ key: b4a.from(entry.blobs, 'hex'), active: false })
      try {
        await tmp.ready()
        blocks = await tmp.count(blockOffset, blockOffset + len)
      } finally {
        await tmp.close().catch(() => {})
      }
      if (meta.slices.size >= 512) meta.slices.clear()
      meta.slices.set(tag, blocks)
    }
    if (blocks <= 0) return 0
    return blocks >= blockLength ? entry.size : Math.min(entry.size, Math.round((blocks / blockLength) * entry.size))
  }

  const dbDir = join(storage, 'corestore', 'db')
  function dbDiskBytes () {
    try {
      let sum = 0
      for (const f of readdirSync(dbDir)) sum += statSync(join(dbDir, f)).size
      return sum
    } catch { return 0 }
  }

  async function clearDownloadedSpans (core) {
    if (core.length > 0) await core.clear(0, core.length)
  }

  let gcQueue = Promise.resolve()
  // Any store still holding live owned blobs (plus `streaming` eviction behind a playhead) disables active blob relocation
  // (`blobGarbageCollectionPolicy: 2`) and compacts non-exclusively down to bottommost (`0`): SST tombstones unlink 100%-dead
  // `.blob` files at once without rewriting a single live `.blob` file. Passing `ageCutoff: 1.0` on a populated store forced
  // RocksDB to rewrite all 1.2 TB of live `.blob` files (~6.5 h on Unraid, 97 s Android watchdog stall on Pi); keep forced
  // `ageCutoff: 1.0` strictly for full cache wipes on pure viewers with zero local blobs left.
  function gcStorage ({ full = false, streaming = false } = {}) {
    const run = async () => {
      if (ctx.life.closing || ctx.storage.coreStorage.closed) return { beforeBytes: 0, afterBytes: 0, reclaimedBytes: 0 }
      const beforeBytes = dbDiskBytes()
      await ctx.storage.coreStorage.flush().catch(() => {})
      if (!ctx.life.closing && !ctx.storage.coreStorage.closed) {
        const hasLocalBlobs = ownedBlobs.size > 0 || blobSlots.some(s => localBlocks(s.core) > 0)
        await ctx.storage.coreStorage.compact(!streaming && full && !hasLocalBlobs
          ? { exclusive: true, blobGarbageCollectionPolicy: 1, blobGarbageCollectionAgeCutoff: 1.0, bottommostLevelCompaction: 2 }
          : { exclusive: false, blobGarbageCollectionPolicy: 2, bottommostLevelCompaction: 0 }
        )
      }
      const afterBytes = dbDiskBytes()
      return { beforeBytes, afterBytes, reclaimedBytes: Math.max(0, beforeBytes - afterBytes) }
    }
    const next = gcQueue.then(run, run)
    gcQueue = next.catch(() => ({ beforeBytes: 0, afterBytes: 0, reclaimedBytes: 0 }))
    return next
  }

  async function hasLiveBlobReference (blobsHex, blockOffset = null) {
    const matchOp = op => op?.type === 'announce' && op.blobs === blobsHex && (blockOffset === null || op.blob?.blockOffset === blockOffset)
    await ctx.channel.channel.update()
    for await (const n of ctx.channel.channel.view.createReadStream()) {
      const k = b4a.toString(n.key)
      if (isSystemViewKey(k)) continue
      if (matchOp(decodeOp(n.value))) return true
    }
    for (const item of ctx.catalog.ephemeralWatches.values()) {
      if (matchOp(item.entry)) return true
    }
    return false
  }

  async function gcUnreferencedSlotBlob (entry) {
    if (!entry?.blobs || !entry?.blob) return
    if (ownedBlobs.has(entry.blobs) && !slotSet.has(entry.blobs)) {
      if (await hasLiveBlobReference(entry.blobs, null)) return
      for (const [tag, ranges] of warmRanges) {
        if (tag.startsWith(`${entry.blobs}:`)) {
          for (const r of ranges) r.destroy()
          warmRanges.delete(tag)
        }
      }
      ctx.net.leaveContentSwarm(entry.blobs)
      await dropOwned(entry.blobs)
      const openSession = blobCores.get(entry.blobs)
      blobCores.delete(entry.blobs)
      if (openSession) await openSession.close().catch(() => {})
      const victim = ctx.storage.store.get({ key: b4a.from(entry.blobs, 'hex') })
      await victim.ready()
      await victim.purge()
      await gcStorage({ full: false })
      return
    }
    const slot = blobSlots.find(s => s.key === entry.blobs)
    if (!slot || !(entry.blob.blockLength > 0)) return
    if (await hasLiveBlobReference(entry.blobs, entry.blob.blockOffset)) return
    const end = Math.min(slot.core.length, entry.blob.blockOffset + entry.blob.blockLength)
    if (end > entry.blob.blockOffset) {
      await slot.core.clear(entry.blob.blockOffset, end)
      await gcStorage({ full: false })
    }
  }

  // Drains spent blocks behind the playhead so tiny TV disks swallow 100 GB remuxes without choking on ENOSPC.
  // `playheadByte` is the earliest position the player is reading within the blob; the caller (the TV receiver)
  // knows it. It clears the spent stretch in 32 MiB steps (a single movie-sized clear gags the playback session
  // mutex), oldest first, up to `maxBytes` per call, then reclaims the space once. Where the last call stopped is
  // remembered, so a pass over a 77 GB film doesn't count its way up from the first block every time; one count
  // checks that nothing below it was downloaded again.
  const evictedTo = new WeakMap()
  async function evictBehind (blobsHex, blob, { playheadByte = 0, keepBehindBytes = 64 * 1024 * 1024, maxBytes = Infinity } = {}) {
    const core = blobCores.get(blobsHex)
    if (!core?.opened || !blob || blob.blockLength <= 16 || isOwnedBlob(blobsHex) || core.writable) return 0
    const bs = Math.max(65536, Math.round((blob.byteLength || BLOB_BLOCK_SIZE) / blob.blockLength))
    const playhead = blob.blockOffset + Math.floor(Math.max(0, playheadByte) / bs)
    const keepBlocks = Math.max(16, Math.ceil(keepBehindBytes / bs))
    const headGuard = blob.blockOffset + Math.max(8, Math.ceil((4 * 1024 * 1024) / bs))
    const tailGuard = blob.blockOffset + blob.blockLength - Math.max(4, Math.ceil((2 * 1024 * 1024) / bs))
    const clearTo = Math.min(tailGuard, core.length, playhead - keepBlocks)
    if (clearTo <= headGuard) return 0
    const maxBlocks = Math.max(1, Math.floor((32 * 1024 * 1024) / bs))
    const hint = Math.min(clearTo, Math.max(headGuard, evictedTo.get(core) || headGuard))
    let start = hint > headGuard && await core.count(headGuard, hint) > 0 ? headGuard : hint
    let cleared = 0
    for (; start < clearTo && !ctx.life.closing && cleared * bs < maxBytes; start += maxBlocks) {
      const end = Math.min(clearTo, start + maxBlocks)
      const n = await core.count(start, end)
      if (n === 0) continue
      await core.clear(start, end)
      cleared += n
    }
    evictedTo.set(core, Math.min(start, clearTo))
    if (cleared === 0) return 0
    await syncBlockCounter(core)
    recordCached(blobsHex, core.length, core.byteLength, localBlocks(core), blockCounts.get(core)?.slices)
    return (await gcStorage({ streaming: true })).reclaimedBytes
  }

  // One cached per-video core: drop any open session, clear its whole range,
  // and keep the ledger honest. Shared by `clearCache(null)` and the ceiling so
  // both evict through exactly one body.
  async function clearBlobHex (hex) {
    if (!hex || isOwnedBlob(hex)) return 0
    if (!slotSet.has(hex) && blobCores.has(hex)) {
      const openCore = blobCores.get(hex)
      blobCores.delete(hex)
      await openCore.close().catch(() => {})
    }
    const isSlot = slotSet.has(hex)
    const core = isSlot ? blobCores.get(hex) : ctx.storage.store.get({ key: b4a.from(hex, 'hex'), active: false })
    let clearedBytes = 0
    try {
      if (!core.opened) await core.ready()
      if (core.writable || core.length === 0) return 0
      const blocks = isSlot ? (await ensureBlockCounter(core, hex).ready, localBlocks(core)) : await core.count(0, core.length)
      if (blocks > 0) {
        clearedBytes = Math.min(core.byteLength, Math.round((blocks / core.length) * core.byteLength))
        await clearDownloadedSpans(core)
        if (isSlot) await syncBlockCounter(core)
      }
      recordCached(hex, core.length, core.byteLength, 0)
      lastUsedAt.delete(hex)
      return clearedBytes
    } finally {
      if (!isSlot) await core.close().catch(() => {})
    }
  }

  // The one estimate the ceiling and `status()` share: open cores through their
  // block counter, closed ones through the ledger, both normalised by length
  // because Hypercore never shrinks `byteLength` when blocks are cleared.
  function cachedTotalBytes () {
    let total = 0
    for (const [k, c] of blobCores) {
      if (isOwnedBlob(k) || !c.opened || c.length <= 0 || c.byteLength <= 0) continue
      ensureBlockCounter(c, k)
      const blocks = localBlocks(c)
      recordCached(k, c.length, c.byteLength, blocks, blockCounts.get(c)?.slices)
      if (blocks > 0) total += Math.min(coreByteLen(c), Math.round((blocks / c.length) * coreByteLen(c)))
    }
    for (const [k, meta] of cachedBlobs) {
      if (blobCores.has(k) || isOwnedBlob(k) || meta.blocks <= 0 || meta.length <= 0 || meta.byteLength <= 0) continue
      total += Math.min(meta.byteLength, Math.round((meta.blocks / meta.length) * meta.byteLength))
    }
    return total
  }

  function scheduleCeiling (opts = {}) {
    if (!(cacheMaxBytes > 0) || ctx.life.closing) return
    if (ceilingTimer) return
    ceilingTimer = setTimeout(() => {
      ceilingTimer = null
      enforceCacheCeiling(opts).catch(() => {})
    }, 2000)
    ceilingTimer.unref?.()
  }

  async function enforceCacheCeiling ({ keepHex = null } = {}) {
    if (ceilingPass) return ceilingPass
    ceilingPass = (async () => {
      const budget = cacheMaxBytes
      let total = cachedTotalBytes()
      if (!(budget > 0)) return { evicted: 0, cachedBytes: total }
      // The contribution is a promise to the user, but the filesystem has the
      // final say: never fill the disk even when the budget is larger.
      const spare = cacheFloorBytes()
      const limit = Number.isFinite(spare) ? Math.min(budget, total + spare) : budget
      if (total <= limit) return { evicted: 0, cachedBytes: total }
      // Evict to 90 % of the budget: without hysteresis one film's trickle
      // would trigger a pass every couple of seconds.
      const target = Math.floor(limit * 0.9)
      const progress = server?.streamProgress?.() || new Map()
      const streaming = server?.streamingHexes?.() || new Set()
      // The film being watched is the freshest one we served. If the caller did
      // not name it, recency is the only honest signal, and a film that has
      // actually been read must never be cleared from the head mid-playback.
      const freshest = [...lastUsedAt.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      // An explicit keepHex comes from playback start and is protected
      // outright; without one, the freshest film is protected while it is
      // still recent, so a growth pass mid-playback cannot clear it.
      const recent = freshest && Date.now() - (lastUsedAt.get(freshest) || 0) < 10 * 60 * 1000
      const playing = keepHex || (recent ? freshest : null)
      const victims = [...new Set([...blobCores.keys(), ...cachedBlobs.keys()])]
        .filter(hex => hex && !isOwnedBlob(hex) && hex !== playing && !streaming.has(hex))
        .filter(hex => {
          for (const tag of warmRanges.keys()) if (tag.startsWith(`${hex}:`)) return false
          const open = blobCores.get(hex)
          if (open?.peers?.some(p => p.inflight > 0)) return false
          return true
        })
        .sort((a, b) => (lastUsedAt.get(a) || 0) - (lastUsedAt.get(b) || 0))
      let evicted = 0
      for (const hex of victims) {
        if (total <= target || ctx.life.closing) break
        const freed = await clearBlobHex(hex).catch(() => 0)
        if (freed > 0) {
          evicted += freed
          total = Math.max(0, total - freed)
          if (!slotSet.has(hex)) ctx.net.leaveContentSwarm(hex)
        }
      }
      // One film can be larger than the whole budget. Keep a window around its
      // playhead — the part the viewer can still rewind into — and drop the
      // rest behind it, instead of clearing a film mid-playback.
      if (total > target && playing && !isOwnedBlob(playing)) {
        const core = blobCores.get(playing)
        if (core?.opened && core.length > 16) {
          const keepBehind = Math.min(64 * 1024 * 1024, Math.max(8 * 1024 * 1024, Math.floor(budget / 8)))
          const beforeTrim = total
          await evictBehind(
            playing,
            { blockOffset: 0, blockLength: core.length, byteLength: core.byteLength },
            { playheadByte: progress.get(playing) || 0, keepBehindBytes: keepBehind, maxBytes: Math.max(0, total - target) }
          ).catch(() => 0)
          total = cachedTotalBytes()
          evicted += Math.max(0, beforeTrim - total)
        }
      }
      if (evicted > 0) {
        if (ceilingTimer) { clearTimeout(ceilingTimer); ceilingTimer = null }
        await gcStorage({ full: false }).catch(() => {})
        ctx.update()
      }
      return { evicted, cachedBytes: total }
    })().finally(() => { ceilingPass = null })
    return ceilingPass
  }

  function setCacheMaxBytes (bytes) {
    const next = Math.max(0, Math.floor(Number(bytes) || 0))
    cacheMaxBytes = next
    cacheGrowth = 0
    if (next > 0) {
      // The first pass must see blocks that survived a restart: the ledger is
      // only whole after the catalog has been walked once.
      const boot = setTimeout(() => {
        ctx.catalog?.search?.('').catch(() => {}).finally(() => scheduleCeiling())
      }, 5000)
      boot.unref?.()
    }
    return cacheMaxBytes
  }

  async function clearCache (key = null, { keepBlobsHex = null } = {}) {
    if (key) {
      const entry = await ctx.catalog.findEntry(key)
      if (!entry || isOwnedBlob(entry.blobs)) return { clearedBytes: 0, reclaimedBytes: 0 }
      await server.abortStreams(entry.blobs)
      const tag = `${entry.blobs}:${entry.blob.blockOffset}`
      if (warmRanges.has(tag)) {
        for (const r of warmRanges.get(tag)) r.destroy()
        warmRanges.delete(tag)
      }
      if (!slotSet.has(entry.blobs) && blobCores.has(entry.blobs)) {
        const openCore = blobCores.get(entry.blobs)
        blobCores.delete(entry.blobs)
        await openCore.close().catch(() => {})
      }
      const isSlot = slotSet.has(entry.blobs)
      const core = isSlot ? blobCores.get(entry.blobs) : ctx.storage.store.get({ key: b4a.from(entry.blobs, 'hex'), active: false })
      let clearedBytes = 0
      let reclaimedBytes = 0
      try {
        if (!core.opened) await core.ready()
        clearedBytes = await entryCachedBytes(core, entry)
        if (clearedBytes > 0 && entry.blob.blockLength > 0 && core.length > entry.blob.blockOffset) {
          await core.clear(entry.blob.blockOffset, Math.min(core.length, entry.blob.blockOffset + entry.blob.blockLength))
          if (isSlot) await syncBlockCounter(core)
          const rem = core.length > 0 ? await core.count(0, core.length) : 0
          recordCached(entry.blobs, core.length, core.byteLength, rem)
          reclaimedBytes = (await gcStorage({ full: false })).reclaimedBytes
          ctx.update()
        }
      } finally {
        if (!isSlot) await core.close().catch(() => {})
      }
      return { clearedBytes, reclaimedBytes }
    }
    await server.abortStreams(null, { exceptHex: keepBlobsHex })
    for (const [tag, ranges] of warmRanges) {
      if (keepBlobsHex && tag.startsWith(`${keepBlobsHex}:`)) continue
      for (const r of ranges) r.destroy()
      warmRanges.delete(tag)
    }
    await ctx.catalog?.search?.('').catch(() => {})
    let clearedBytes = 0
    const allCachedHex = [...new Set([...blobCores.keys(), ...cachedBlobs.keys()])]
    for (const hex of allCachedHex) {
      if (hex === keepBlobsHex) continue
      clearedBytes += await clearBlobHex(hex).catch(() => 0)
    }
    const { reclaimedBytes } = clearedBytes > 0 ? await gcStorage({ full: true }) : { reclaimedBytes: 0 }
    ctx.update()
    return { clearedBytes, reclaimedBytes }
  }

  // Mints a dedicated 512 KiB-piece Hypercore per video (`blockOffset: 0`) and closes the write session at rest so Corestore wakes it lazily on demand.
  // The write session is inactive: an owned core never downloads, so peers see it as an uploader from the first
  // block. Otherwise it reports "downloading" for Hypercore's 20-40 s linger after the write, and a peer whose
  // channel closes when Corestore collects the at-rest core does not reopen it.
  async function put ({ id, title, expectedSize = null, private: isPrivate = false, epoch: explicitEpoch = null }, source, onData = null) {
    if (!str(id, ID)) throw new Error(`Invalid id ${id}`)
    const wantPrivate = Boolean(isPrivate || explicitEpoch)
    let videoKey = null
    let ep = 0
    let wrappedKey
    if (wantPrivate) {
      if (!ctx.identity.idVault) throw new Error('12-word recovery vault required to encrypt private channel media')
      ep = explicitEpoch || await ctx.channel.currentChannelEpoch()
      videoKey = hypercoreCrypto.randomBytes(32)
      wrappedKey = wrapVideoKey(videoKey, ctx.identity.idVault.epochKey(ctx.channel.primaryKey, ep))
    }
    const core = ctx.storage.store.get({
      name: `video:${b4a.toString(hypercoreCrypto.randomBytes(16), 'hex')}`,
      active: false,
      ...(videoKey ? { encryption: { key: videoKey } } : {})
    })
    try {
      const hash = createHash('sha256')
      let size = 0
      let buf = []
      let bufLen = 0
      const hasher = new Transform({
        transform (chunk, cb) {
          hash.update(chunk)
          size += chunk.length
          if (onData) onData(size)
          buf.push(chunk)
          bufLen += chunk.length
          if (bufLen >= BLOB_BLOCK_SIZE) {
            const full = buf.length === 1 ? buf[0] : b4a.concat(buf, bufLen)
            let off = 0
            while (off + BLOB_BLOCK_SIZE <= full.length) this.push(full.subarray(off, off += BLOB_BLOCK_SIZE))
            buf = off < full.length ? [full.subarray(off)] : []
            bufLen = full.length - off
          }
          cb(null)
        },
        flush (cb) {
          if (bufLen > 0) this.push(bufLen === buf[0]?.length ? buf[0] : b4a.concat(buf, bufLen))
          cb(null)
        }
      })
      const blobs = new Hyperblobs(core, { blockSize: BLOB_BLOCK_SIZE })
      const writer = blobs.createWriteStream()
      await pipelinePromise(source, hasher, writer)
      if (Number.isSafeInteger(expectedSize) && expectedSize >= 0 && size !== expectedSize) {
        throw new Error(`Truncated transfer for ${id}: expected ${expectedSize} bytes, got ${size}`)
      }
      await core.ready()
      const keyHex = b4a.toString(core.key, 'hex')
      const blob = writer.id
      registerOwned(keyHex, { length: core.length, byteLength: core.byteLength })
      if (videoKey) {
        encryptedBlobs.set(keyHex, { source: ctx.channel.primaryKey, epoch: ep, wrappedKey })
        unlockedVideoKeys.set(keyHex, videoKey)
      }
      await core.close()
      ctx.net.joinContentSwarm(keyHex)
      return {
        type: 'announce',
        id,
        title: cleanText(title, id),
        size,
        sha256: hash.digest('hex'),
        blobs: keyHex,
        blob,
        ...(videoKey ? { epoch: ep, wrappedKey } : {})
      }
    } catch (err) {
      await core.ready().then(() => core.purge()).catch(() => core.close().catch(() => {}))
      throw err
    }
  }

  async function publish (meta, source) {
    const op = await put(meta, source)
    await ctx.channel.append(op)
    const writerHex = b4a.toString(ctx.channel.channel.local.key, 'hex')
    return {
      ...op,
      key: `${op.id}/${writerHex}/${op.blobs}:${op.blob.blockOffset}`,
      channel: ctx.channel.primaryKey,
      streamUrl: streamUrl(op),
      magnetUrl: formatWatchUri(op)
    }
  }

  async function publishChannel (metaOrOp, source = null) {
    const op = source ? await put(metaOrOp, source) : decodeOp(JSON.stringify({ ...metaOrOp, type: 'announce' }))
    if (!op || op.type !== 'announce') throw new Error('Invalid channel announce payload')
    await ctx.channel.append(op)
    ctx.net.joinContentSwarm(op.blobs)
    const writerHex = b4a.toString(ctx.channel.channel.local.key, 'hex')
    return {
      ...op,
      key: `${op.id}/${writerHex}/${op.blobs}:${op.blob.blockOffset}`,
      channel: ctx.channel.primaryKey,
      streamUrl: streamUrl(op),
      magnetUrl: formatWatchUri(op)
    }
  }

  // One-shot zero-copy import of any pre-unification single-writer Hyperbee entries into the unified Channel.
  async function syncLocalChannel () {
    const legacyNs = ctx.storage.store.namespace('channel')
    const probe = legacyNs.get({ name: 'bee', active: false })
    await probe.ready()
    const legacyLen = probe.length
    await probe.close()
    await ctx.channel.channel.update()
    const existing = new Set()
    let total = 0
    for await (const n of ctx.channel.channel.view.createReadStream()) {
      const k = b4a.toString(n.key)
      if (isSystemViewKey(k)) continue
      const op = decodeOp(n.value)
      if (op?.type === 'announce') {
        existing.add(`${op.id}/${op.blobs}:${op.blob.blockOffset}`)
        total++
      }
    }
    if (legacyLen === 0) return { backfilled: 0, total }
    const legacyBee = new Hyperbee(legacyNs, { writable: false, autoUpdate: false })
    let backfilled = 0
    try {
      await legacyBee.ready()
      for await (const n of legacyBee.createReadStream({ gte: b4a.from('entry/'), lt: b4a.from('entry/\xff') })) {
        const op = decodeOp(n.value)
        if (!op || op.type !== 'announce') continue
        const slice = `${op.id}/${op.blobs}:${op.blob.blockOffset}`
        if (!existing.has(slice)) {
          await ctx.channel.append(op)
          ctx.net.joinContentSwarm(op.blobs)
          existing.add(slice)
          backfilled++
        }
      }
    } finally {
      await legacyBee.close().catch(() => {})
    }
    if (backfilled > 0) { await hydrateOwned(); ctx.update() }
    return { backfilled, total: total + backfilled }
  }

  // Splits legacy variable-block AND multi-entry shared `blobSlots` spans into dedicated 512 KiB-piece per-video Hypercores.
  async function rechunkLegacyBlobs ({ id = null, foreground = false, onMigrate = null, onProgress = null, limit = Infinity } = {}) {
    const writer = b4a.toString(ctx.channel.channel.local.key, 'hex')
    const role = await ctx.channel.localRole()
    const uniformByHash = new Map()
    const legacyGroups = new Map()
    const slotMap = new Map(blobSlots.map(s => [s.key, s]))
    const hasAllBlocks = async (slot, blob) => {
      if (!slot || blob.blockLength <= 0) return blob.byteLength === 0
      const end = blob.blockOffset + blob.blockLength
      if (slot.core.length < end) return false
      return slot.core.has(blob.blockOffset, end)
    }
    const addRef = async (op, fullKey) => {
      if (!slotMap.has(op.blobs)) {
        if (ownedBlobs.has(op.blobs) && op.blob?.blockOffset === 0 && isUniform512(op.blob)) {
          uniformByHash.set(`${op.sha256}:${op.size}`, { blobs: op.blobs, blob: op.blob })
        }
        return
      }
      const slot = slotMap.get(op.blobs)
      if (!(await hasAllBlocks(slot, op.blob))) return
      const oldTag = `${op.blobs}:${op.blob.blockOffset}`
      let g = legacyGroups.get(oldTag)
      if (!g) {
        g = { oldTag, blobs: op.blobs, blob: op.blob, sha256: op.sha256, size: op.size, ops: [] }
        legacyGroups.set(oldTag, g)
      }
      g.ops.push({ fullKey, op })
    }

    await ctx.channel.channel.update()
    for await (const n of ctx.channel.channel.view.createReadStream()) {
      const key = b4a.toString(n.key)
      if (isSystemViewKey(key)) continue
      const op = decodeOp(n.value)
      if (op?.type === 'announce' && (key.split('/')[1] === writer || role === 'owner')) await addRef(op, key)
    }

    const allGroups = [...legacyGroups.values()]
    const filtered = id ? allGroups.filter(g => g.ops.some(t => t.op.id === id)) : allGroups
    const queue = filtered.sort((a, b) => a.size - b.size)
    let migrated = 0, deduped = 0, migratedBytes = 0
    onProgress?.({ total: queue.length, migrated, deduped, remaining: queue.length, migratedBytes, currentId: null, currentTitle: null })

    for (const g of queue) {
      if (ctx.life.closing || migrated >= limit) break
      const sample = g.ops[0]?.op
      onProgress?.({ total: queue.length, migrated, deduped, remaining: queue.length - migrated, migratedBytes, currentId: sample.id, currentTitle: sample.title })
      const oldSlot = slotMap.get(g.blobs)
      if (!oldSlot || !(await hasAllBlocks(oldSlot, g.blob))) continue

      let target = uniformByHash.get(`${g.sha256}:${g.size}`)
      if (target && !ownedBlobs.has(target.blobs)) target = null
      if (target) {
        deduped++
      } else {
        let idx = g.blob.blockOffset
        const endIdx = g.blob.blockOffset + g.blob.blockLength
        const src = new Readable({
          read (cb) {
            if (ctx.life.closing) return cb(new Error('Node closing'))
            if (idx >= endIdx) { this.push(null); return cb(null) }
            const pump = () => {
              if (ctx.life.closing) return cb(new Error('Node closing'))
              ctx.status?.()
              if (!foreground && (ctx.net.downBps > 65536 || ctx.net.upBps > 65536)) { setTimeout(pump, 1500).unref?.(); return }
              const batchEnd = Math.min(endIdx, idx + 64)
              const reqs = []
              while (idx < batchEnd) reqs.push(oldSlot.core.get(idx++, { wait: false }))
              Promise.all(reqs).then(blocks => {
                if (blocks.some(b => !b)) return cb(new Error('Missing local block during rechunk'))
                for (const blk of blocks) this.push(blk)
                setTimeout(() => cb(null), 0)
              }, cb)
            }
            pump()
          }
        })
        let lastProgressBytes = 0
        const newOp = await put({ id: sample.id, title: sample.title }, src, bytes => {
          if (bytes - lastProgressBytes >= BLOB_BLOCK_SIZE) {
            lastProgressBytes = bytes
            onProgress?.({ total: queue.length, migrated, deduped, remaining: queue.length - migrated, migratedBytes: migratedBytes + bytes, currentId: sample.id, currentTitle: sample.title })
          }
        })
        if (newOp.sha256 !== g.sha256 || newOp.size !== g.size) {
          await dropOwned(newOp.blobs)
          ctx.net.leaveContentSwarm(newOp.blobs)
          const bad = ctx.storage.store.get({ key: b4a.from(newOp.blobs, 'hex') })
          await bad.ready().then(() => bad.purge()).catch(() => bad.close().catch(() => {}))
          throw new Error(`SHA-256 mismatch rechunking ${sample.id}: expected ${g.sha256}, got ${newOp.sha256}`)
        }
        target = { blobs: newOp.blobs, blob: newOp.blob }
        uniformByHash.set(`${g.sha256}:${g.size}`, target)
      }

      await onMigrate?.(g.oldTag, target, sample)
      for (const { op } of g.ops) {
        await ctx.channel.append({ ...op, blobs: target.blobs, blob: target.blob })
      }
      for (const { fullKey } of g.ops) {
        await ctx.channel.append({ type: 'remove', key: fullKey })
      }

      const clearEnd = Math.min(oldSlot.core.length, g.blob.blockOffset + g.blob.blockLength)
      if (clearEnd > g.blob.blockOffset) {
        await oldSlot.core.clear(g.blob.blockOffset, clearEnd)
        ensureBlockCounter(oldSlot.core)
        syncBlockCounter(oldSlot.core).catch(() => {})
      }
      migrated++
      migratedBytes += g.size
      onProgress?.({ total: queue.length, migrated, deduped, remaining: queue.length - migrated, migratedBytes, currentId: null, currentTitle: null })
    }

    if (migrated > 0) ctx.update()
    return { total: queue.length, migrated, deduped, remaining: Math.max(0, queue.length - migrated), migratedBytes }
  }

  async function startServer () {
    server = createBlobRangeServer(ctx.storage.store.session(), {
      host: ctx.opts.streamHost,
      port: ctx.opts.streamPort,
      token: null,
      windowBytes: ctx.storage.isMobileWorklet ? 96 * 1024 * 1024 : 256 * 1024 * 1024,
      resolve: async (key, info) => {
        const hex = b4a.toString(key, 'hex')
        const encryptionKey = resolveBlobEncryptionKey(hex)
        if (encryptedBlobs.has(hex) && !encryptionKey) return null
        ctx.net.joinContentSwarm(hex)
        if (!isWorklet && !info?.head) lastHttpViewAt = Date.now()
        if (!isOwnedBlob(hex)) {
          await blobCore(hex).catch(() => {})
        } else if (!ctx.life.closing && ownedBlobs.has(hex) && !info?.head) {
          let rec = httpOwned.get(hex)
          if (!rec) {
            if (httpOwned.size >= 4) {
              const oldest = httpOwned.keys().next().value
              const ev = httpOwned.get(oldest)
              clearTimeout(ev.timer)
              httpOwned.delete(oldest)
              ev.core.close().catch(() => {})
            }
            const core = ctx.storage.store.get({ key: b4a.from(hex, 'hex'), active: false })
            rec = { core, timer: null }
            httpOwned.set(hex, rec)
            await core.ready().catch(() => {})
            attachUploadWarmth(core)
          }
          clearTimeout(rec.timer)
          rec.timer = setTimeout(() => {
            if (httpOwned.get(hex) !== rec) return
            httpOwned.delete(hex)
            rec.core.close().catch(() => {})
          }, 30_000)
          rec.timer.unref?.()
          if (rec.core.opened && info?.blob?.blockOffset === 0) {
            warmAhead(rec.core, Math.floor((info?.range?.start || 0) / BLOB_BLOCK_SIZE) - 1, 32)
          }
        }
        const active = !isOwnedBlob(hex)
        return encryptionKey ? { key, encryptionKey, active } : { key, active }
      }
    })
    ctx.undo.push(() => server.close())
    await server.listen()

    ctx.storage.store.watch(onCoreWake)
    ctx.undo.push(() => ctx.storage.store.unwatch(onCoreWake))

    for (const s of blobSlots) ensureBlockCounter(s.core)
  }

  return {
    blobSlots,
    blobCores,
    ownedBlobs,
    cachedBlobs,
    slotSet,
    blobsKey,
    lastHttpViewAt: () => lastHttpViewAt,
    isOwnedBlob,
    resolveVideoKey,
    hydrateOwned,
    get server () { return server },
    streamUrl,
    syncBlockCounter,
    localBlocks,
    ensureBlockCounter,
    bulkPeers,
    absentDisc,
    blobDisc,
    recordCached,
    onCoreWake,
    blobCore,
    warmRanges,
    warm,
    entryCachedBytes,
    gcStorage,
    gcUnreferencedSlotBlob,
    evictBehind,
    cachedTotalBytes,
    get cacheMaxBytes () { return cacheMaxBytes },
    enforceCacheCeiling,
    setCacheMaxBytes,
    clearCache,
    put,
    publish,
    publishChannel,
    syncLocalChannel,
    rechunkLegacyBlobs,
    setPlayerActive,
    startServer,
    weakOwned,
    httpOwned
  }
}
