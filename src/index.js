import b4a from 'b4a'
import { BLOB_BLOCK_SIZE, HEX64, str } from './protocol.js'
import { createStorage } from './node/storage.js'
import { createIdentity } from './node/identity.js'
import { createChannel } from './node/channel.js'
import { createBlobs } from './node/blobs.js'
import { createNetwork } from './node/network.js'
import { createSources } from './node/sources.js'
import { createCatalog } from './node/catalog.js'

// What status() reports before a node exists (an app can ask while a start is still queued). Same fields as status().
export function idleStatus () {
  const bucket = () => ({ peers: 0, rxBytes: 0, txBytes: 0, downBps: 0, upBps: 0 })
  return {
    tracker: '', channel: '', writer: '', writable: false, blobs: '', blobBytes: 0, cachedBytes: 0, cacheMaxBytes: 0,
    peers: 0, lanPeers: 0, downBps: 0, upBps: 0, rxBytes: 0, txBytes: 0,
    routes: { private: bucket(), public: bucket(), lan: bucket() },
    inflightBlocks: 0, rtt: 0, retransmits: 0, sources: [],
    reciprocity: { tier: 'leecher', seededBytes: 0, contributingPeers: 0, ratio: 0, inflightMax: 0 }
  }
}

// listSources() as a host saves it: the channels followed, not the node's own writable one, as {key, kind, alias}.
// A followed tracker the user named stays, so its name survives the next save.
export function followedSources (list) {
  return list.filter(s => !s.writable && (!s.primary || s.alias)).map(({ key, kind, alias }) => ({ key, kind, alias }))
}

// A node that fails partway through opening closes what it opened, so the same storage can be opened again.
export async function createNode (opts) {
  const undo = []
  try {
    return await openNode(opts, undo)
  } catch (err) {
    for (const fn of undo.reverse()) {
      try { await fn() } catch {}
    }
    throw err
  }
}

async function openNode ({
  storage,
  tracker: trackerOpt = null,
  mnemonic: mnemonicOpt = null,
  join: joinOpt = false,
  sources: initialSources = [],
  allowedPeers = null,
  streamHost = '127.0.0.1',
  streamPort = 0,
  bootstrap,
  privateHost = null,
  dhtPort,
  privateRouting = false,
  relayThrough = null,
  lan: createLan = null,
  maxActiveSources = null,
  // Set by the apps' worklet (worklet/worker.js): small request windows for phones' UDP buffers.
  worklet: isWorklet = false,
  onchange = null
}, undo) {
  const life = { closing: false }
  const parsedOpts = {
    storage,
    tracker: trackerOpt,
    mnemonic: mnemonicOpt,
    join: joinOpt,
    sources: initialSources,
    allowedPeers,
    streamHost,
    streamPort,
    bootstrap,
    privateHost,
    dhtPort,
    privateRouting,
    relayThrough,
    lan: createLan,
    maxActiveSources,
    worklet: isWorklet,
    onchange
  }

  const ctx = {
    opts: parsedOpts,
    undo,
    life,
    update: () => {
      ctx.channel?.bumpView()
      if (onchange) queueMicrotask(onchange)
    },
    storage: null,
    identity: null,
    channel: null,
    blobs: null,
    net: null,
    sources: null,
    catalog: null,
    status: null
  }

  ctx.storage = await createStorage(ctx)
  ctx.identity = createIdentity(ctx)
  ctx.channel = await createChannel(ctx)
  ctx.blobs = await createBlobs(ctx)
  ctx.net = await createNetwork(ctx)
  ctx.sources = await createSources(ctx)
  await ctx.net.initLan(createLan)
  await ctx.blobs.startServer()
  ctx.catalog = createCatalog(ctx)

  // Tit-for-tat reciprocity: seeders holding cached/published blocks earn wider inflight windows than empty leechers.
  function applyReciprocity (seededBytes, txBytes, rxBytes, contributingPeers) {
    const tier = seededBytes > 0 && (txBytes > 0 || ctx.blobs.ownedBlobs.size > 0 || ctx.blobs.blobSlots.some(s => s.core.byteLength > 0) || seededBytes >= BLOB_BLOCK_SIZE)
      ? 'seeder'
      : (seededBytes > 0 || contributingPeers > 0 ? 'peer' : 'leecher')
    // Mobile/TV BareKit worklets share Android's 256 KiB rmem_max UDP socket; never let background cores blast [16,48] retransmits over Wi-Fi.
    // Measured 2026-10-29: widening this to [24,64] made a 5 GHz phone worse (erratic 0.9–15.9 MB/s,
    // decoded fps 15.7 → 11.5). Keep the small window until the socket buffers are tuned with evidence.
    const next = ctx.net.dht
      ? (tier === 'seeder' ? [64, 192] : tier === 'peer' ? [48, 128] : [24, 64])
      : ctx.storage.isMobileWorklet
        ? [6, 8]
        : isWorklet
          ? [16, 48]
          : (tier === 'seeder' ? [16, 48] : tier === 'peer' ? [12, 32] : [8, 24])
    ctx.net.setInflightRange(next)
    const ratio = rxBytes > 0 ? Math.round((txBytes / rxBytes) * 100) / 100 : (txBytes > 0 ? 1 : 0)
    return { tier, seededBytes, contributingPeers, ratio, inflightMax: next[1] }
  }

  function status () {
    const { routes, rxBytes, txBytes, downBps, upBps, contributingPeers, rtt, retransmits } = ctx.net.sample()
    let inflightBlocks = 0
    for (const [k, c] of ctx.blobs.blobCores) {
      // Display only: Hypercore has no public in-flight count, so read it off the documented `core.peers`.
      for (const p of c.peers) inflightBlocks += p.inflight || 0
    }
    const cachedBytes = ctx.blobs.cachedTotalBytes()
    let ownedVideoBytes = 0
    for (const v of ctx.blobs.ownedBlobs.values()) ownedVideoBytes += v.byteLength
    const blobBytes = ownedVideoBytes + ctx.blobs.blobSlots.reduce((sum, s) => {
      if (s.core.length === 0 || s.core.byteLength === 0) return sum
      ctx.blobs.ensureBlockCounter(s.core)
      const blocks = ctx.blobs.localBlocks(s.core)
      if (blocks <= 0) return sum
      return sum + (blocks >= s.core.length ? s.core.byteLength : Math.round((blocks / s.core.length) * s.core.byteLength))
    }, 0)
    const reciprocity = applyReciprocity(blobBytes + cachedBytes, txBytes, rxBytes, contributingPeers)
    const writerHex = b4a.toString(ctx.channel.channel.local.key, 'hex')
    return {
      tracker: ctx.channel.usePrimary() || ctx.channel.hasEntries() ? ctx.channel.primaryKey : '',
      channel: ctx.channel.primaryKey,
      writer: writerHex,
      writable: Boolean(ctx.channel.channel.writable || writerHex === ctx.channel.primaryKey || (ctx.identity.idVault && ctx.identity.idVault.channelKey === ctx.channel.primaryKey)),
      blobs: ctx.blobs.blobsKey,
      blobBytes,
      cachedBytes,
      cacheMaxBytes: ctx.blobs.cacheMaxBytes,
      peers: ctx.net.swarm.connections.size,
      lanPeers: ctx.net.lanPeers.size,
      downBps,
      upBps,
      rxBytes,
      txBytes,
      routes,
      inflightBlocks,
      rtt,
      retransmits,
      sources: ctx.sources.listSources(),
      reciprocity
    }
  }
  ctx.status = status

  // Lays bare every non-empty unified Channel core, linked-device writer core, and 512 KiB video core for supplemental HiveRelays.
  function seedableCores ({ includeCached = false } = {}) {
    const out = []
    if (ctx.channel.channel.bootstrap.length > 0 && (ctx.channel.hasEntries() || ctx.blobs.ownedBlobs.size > 0)) {
      out.push({ key: ctx.channel.primaryKey, kind: 'channel', length: ctx.channel.channel.bootstrap.length, byteLength: ctx.channel.channel.bootstrap.byteLength })
    }
    for (const [wHex, wc] of ctx.channel.writerCores) {
      if (wc.opened && wc.length > 0) {
        out.push({ key: wHex, kind: 'channel', length: wc.length, byteLength: wc.byteLength })
      }
    }
    for (const [key, v] of ctx.blobs.ownedBlobs) {
      if (v.length > 0) out.push({ key, kind: 'blobs', length: v.length, byteLength: v.byteLength })
    }
    for (const s of ctx.blobs.blobSlots) {
      if (s.core.length > 0 && ctx.blobs.localBlocks(s.core) > 0) {
        out.push({ key: s.key, kind: 'blobs', length: s.core.length, byteLength: s.core.byteLength })
      }
    }
    if (includeCached) {
      for (const [k, c] of ctx.blobs.blobCores) {
        if (ctx.blobs.isOwnedBlob(k) || !c.opened || c.length === 0 || c.byteLength === 0) continue
        ctx.blobs.ensureBlockCounter(c, k)
        if (ctx.blobs.localBlocks(c) >= c.length) out.push({ key: k, kind: 'blobs', length: c.length, byteLength: c.byteLength })
      }
      for (const [k, meta] of ctx.blobs.cachedBlobs) {
        if (ctx.blobs.blobCores.has(k) || ctx.blobs.isOwnedBlob(k) || meta.length === 0 || meta.byteLength === 0) continue
        if (meta.blocks >= meta.length) out.push({ key: k, kind: 'blobs', length: meta.length, byteLength: meta.byteLength })
      }
    }
    return out
  }

  let closingPromise = null
  function close () {
    if (closingPromise) return closingPromise
    ctx.life.closing = true
    closingPromise = (async () => {
      clearInterval(ctx.net.refreshTimer)
      clearInterval(ctx.net.rotateTimer)
      clearTimeout(ctx.sources.sourceRotateTimer)
      ctx.sources.sourceRotateTimer = null
      ctx.sources.flushCatalogCache()
      for (const ranges of ctx.blobs.warmRanges.values()) for (const r of ranges) r.destroy()
      ctx.blobs.warmRanges.clear()
      ctx.storage.store.unwatch(ctx.blobs.onCoreWake)
      for (const rec of ctx.blobs.httpOwned.values()) { clearTimeout(rec.timer); await rec.core.close().catch(() => {}) }
      ctx.blobs.httpOwned.clear()
      for (const s of ctx.blobs.weakOwned.values()) await s.close().catch(() => {})
      ctx.blobs.weakOwned.clear()
      for (const wc of ctx.channel.writerCores.values()) await wc.close().catch(() => {})
      ctx.channel.writerCores.clear()
      for (const c of ctx.channel.landedCores.values()) await c.close().catch(() => {})
      ctx.channel.landedCores.clear()
      await ctx.net.lan?.destroy()
      if (ctx.net.dht) await ctx.net.swarm.clear()
      await ctx.net.swarm.destroy({ force: true })
      for (const s of ctx.sources.extraSources.values()) {
        if (s.opening) await s.opening.catch(() => {})
        if (s.closing) await s.closing.catch(() => {})
        if (s.bee) await s.bee.close().catch(() => {})
      }
      ctx.sources.extraSources.clear()
      ctx.sources.activeSources.clear()
      await ctx.channel.channel.close()
      ctx.channel.wakeup.destroy()
      await ctx.blobs.server.close()
      await ctx.storage.store.close()
    })()
    return closingPromise
  }

  return {
    store: ctx.storage.store,
    findEntry: ctx.catalog.findEntry,
    blobCore: ctx.blobs.blobCore,
    seedableCores,
    privateRouting: Boolean(ctx.net.dht),
    bootstrap: bootstrap || null,
    relayThrough: relayThrough || null,
    hasLan: () => Boolean(ctx.net.lan),
    lanEndpoint: () => ctx.net.lan?.port && ctx.net.lan?.host ? { host: ctx.net.lan.host, port: ctx.net.lan.port, publicKey: b4a.toString(ctx.net.swarm.keyPair.publicKey, 'hex') } : null,
    dialLanPeer: ep => { if (ep?.publicKey && ep?.host && ep?.port) ctx.net.lan?.dialDirect?.(ep.publicKey, ep.host, ep.port) },
    // This node's peer key, hex, as other peers and TV receivers name it.
    peerKey: b4a.toString(ctx.net.swarm.keyPair.publicKey, 'hex'),
    // The DHT casting opens its Noise RPC sessions on (the private overlay's own when private routing is on).
    dht: ctx.net.swarm.dht,
    // Connects to a peer by key. `lanFirst`: a LAN dial was just started, so give it 1.5 s before also joining through
    // the DHT, which would otherwise open a second connection to the same peer.
    joinPeer: (keyHex, { lanFirst = false } = {}) => {
      if (!str(keyHex, HEX64)) return
      const key = b4a.from(keyHex, 'hex')
      if (b4a.equals(key, ctx.net.swarm.keyPair.publicKey)) return
      const join = () => { try { ctx.net.swarm.joinPeer(key) } catch {} }
      if (!lanFirst || ctx.net.dht || !ctx.net.lan) return join()
      setTimeout(() => { if (!ctx.life.closing && !ctx.net.hasLanPeer(key)) join() }, 1500).unref?.()
    },
    evictBehind: ctx.blobs.evictBehind,
    refreshBlockCount: core => ctx.blobs.syncBlockCounter(core),
    channel: ctx.channel.channel,
    swarm: ctx.net.swarm,
    peerConnections: () => ctx.net.peerConns,
    onConnection: fn => { ctx.net.connListeners.add(fn); return () => ctx.net.connListeners.delete(fn) },
    search: ctx.catalog.search,
    put: ctx.blobs.put,
    dropStore: ctx.blobs.dropStore,
    append: ctx.channel.append,
    publish: ctx.blobs.publish,
    publishChannel: ctx.blobs.publishChannel,
    remove: ctx.channel.remove,
    publishSource: ctx.channel.publishSource,
    syncLocalChannel: ctx.blobs.syncLocalChannel,
    rechunkLegacyBlobs: ctx.blobs.rechunkLegacyBlobs,
    unpublishSource: ctx.channel.unpublishSource,
    publishedSources: ctx.channel.publishedSources,
    addSource: ctx.sources.addSource,
    removeSource: ctx.sources.removeSource,
    listSources: ctx.sources.listSources,
    focusSource: key => ctx.sources.wakeSource(key, { touch: true }).then(b => Boolean(b)),
    setPlayerActive: active => { ctx.blobs.setPlayerActive(active); return { ok: true } },
    activeSourceCount: () => ctx.sources.activeSources.size,
    overlayTopicCount: () => ctx.net.discoveries.size,
    discoveredSources: ctx.catalog.discoveredSources,
    openUri: ctx.catalog.openUri,
    warm: ctx.blobs.warm,
    identity: ctx.identity.identity,
    grantWriter: ctx.channel.grantWriter,
    revokeWriter: ctx.channel.revokeWriter,
    claimWithMnemonic: ctx.identity.claimWithMnemonic,
    rotateEpoch: ctx.identity.rotateEpoch,
    setAllowedPeers: ctx.net.setAllowedPeers,
    clearCache: ctx.blobs.clearCache,
    setCacheMaxBytes: ctx.blobs.setCacheMaxBytes,
    enforceCacheCeiling: ctx.blobs.enforceCacheCeiling,
    gcStorage: ctx.blobs.gcStorage,
    status,
    streamUrl: ctx.blobs.streamUrl,
    httpViewing: () => Date.now() - ctx.blobs.lastHttpViewAt() < 3000,
    markBulkPeer: (hex, on) => { if (hex) on ? ctx.blobs.bulkPeers.add(hex) : ctx.blobs.bulkPeers.delete(hex) },
    blobServer: ctx.blobs.server,
    setLan: ctx.net.setLan,
    lanStats: () => (ctx.net.lan ? ctx.net.lan.stats() : null),
    close,
    get closing () { return ctx.life.closing }
  }
}
