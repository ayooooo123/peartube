import Hyperswarm from 'hyperswarm'
import hypercoreCrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { tuneUdxSocket } from '../lan.js'
import { createPrivateSwarm } from '../private-overlay.js'
import { HEX64, str } from '../protocol.js'

const MAX_CONTENT_TOPICS = 48
// How often content beyond the announcement cap gets its turn on the DHT.
const CONTENT_TOPIC_ROTATE_MS = 20_000

export async function createNetwork (ctx) {
  const {
    bootstrap,
    privateHost = null,
    dhtPort,
    privateRouting = false,
    relayThrough = null,
    allowedPeers = null,
    worklet: isWorklet = false
  } = ctx.opts

  const host = privateHost ?? (Array.isArray(bootstrap) && bootstrap.some(b => String(b?.host || b).startsWith('127.')) ? '127.0.0.1' : undefined)
  const isPrivate = Boolean(privateRouting)
  const privateOpts = typeof privateRouting === 'object' && privateRouting !== null ? privateRouting : {}

  let allowedSet = Array.isArray(allowedPeers) && allowedPeers.length ? new Set(allowedPeers.map(k => String(k).toLowerCase())) : null
  const lanPeers = new Set()
  const hasLanPeer = keyBuf => Boolean(keyBuf && [...lanPeers].some(c => !c.destroyed && c.remotePublicKey && b4a.equals(c.remotePublicKey, keyBuf)))
  const firewall = remotePublicKey => (allowedSet ? !allowedSet.has(b4a.toString(remotePublicKey, 'hex')) : false) || hasLanPeer(remotePublicKey)
  const bucket = () => ({ closedRx: 0, closedTx: 0, prevRx: 0, prevTx: 0, downBps: 0, upBps: 0 })
  const traffic = { private: bucket(), public: bucket(), lan: bucket() }
  let prevRx = 0, prevTx = 0, prevAt = Date.now(), downBps = 0, upBps = 0
  const tuneDht = inst => inst?.ready?.().then(() => { tuneUdxSocket(inst.io?.serverSocket); tuneUdxSocket(inst.io?.clientSocket) }).catch(() => {})
  // Every replication connection, public swarm and LAN alike, for plugins that act per peer.
  const peerConns = new Set()
  const connListeners = new Set()
  // A followed channel is an Autobee of its own, and Autobee's wakeup rides its replication stream:
  // a peer that never gets one is never told which writer cores to fetch, so a follower stalls at
  // whatever head it happened to wake with. `Hypercore.createProtocolStream` reuses the connection's
  // existing Protomux, so sharing a connection here is safe.
  function attachSource (src, conn) {
    if (!src?.bee || !src.conns) return
    if (src.conns.has(conn)) return
    src.conns.add(conn)
    try { src.bee.replicate(conn) } catch {}
  }
  const trackConn = (conn, path) => {
    tuneUdxSocket(conn.rawStream?.socket)
    tuneUdxSocket(conn.rawStream?.rawStream?.socket)
    peerConns.add(conn)
    conn.once('close', () => {
      peerConns.delete(conn)
      path.closedRx += conn.rawBytesRead || conn.rawStream?.bytesReceived || 0
      path.closedTx += conn.rawBytesWritten || conn.rawStream?.bytesTransmitted || 0
    })
    ctx.channel.channel.replicate(conn)
    if (ctx.sources) {
      for (const s of ctx.sources.extraSources.values()) attachSource(s, conn)
    }
    for (const fn of connListeners) fn(conn)
  }
  const swarm = isPrivate
    ? await createPrivateSwarm({
        host,
        bootstrap,
        port: dhtPort || [0, 0],
        allowLoopback: privateOpts.allowLoopback,
        resolveAddress: privateOpts.resolveAddress,
        firewall
      })
    : new Hyperswarm({
        maxParallel: 16,
        bootstrap,
        port: dhtPort || [0, 0],
        firewall,
        relayThrough: relayThrough && (force => force ? relayThrough.map(k => b4a.from(k, 'hex')) : null)
      })
  const dht = isPrivate ? swarm.dht : null
  if (!isPrivate) tuneDht(swarm.dht)
  swarm.on('connection', conn => {
    if (hasLanPeer(conn.remotePublicKey)) { conn.destroy(); return }
    trackConn(conn, dht ? traffic.private : traffic.public)
    if (dht) ctx.channel.channel.update().catch(() => {})
  })
  ctx.undo.push(() => swarm.destroy({ force: true }))
  ctx.undo.push(() => {
    ctx.life.closing = true
    ctx.channel.wakeup.destroy()
  })
  const discoveries = new Map()
  const lanTopics = new Map()
  // lanPeers declared above so swarm firewall yields to direct LAN sockets
  let lan = null

  function joinOverlayTopic (id, keyBuf, discKey) {
    if (discoveries.has(id)) return
    if (dht) {
      discoveries.set(id, swarm.joinSource(id, keyBuf))
      return
    }
    const disc = swarm.join(discKey, { server: true, client: true })
    discoveries.set(id, disc)
    lanTopics.set(id, discKey)
    lan?.join(discKey)
  }

  async function leaveOverlayTopic (id) {
    const disc = discoveries.get(id)
    const discKey = lanTopics.get(id)
    discoveries.delete(id)
    lanTopics.delete(id)
    if (discKey) lan?.leave?.(discKey)
    if (dht) await swarm.leaveSource(id).catch(() => {})
    else if (disc) await swarm.leave(disc.topic).catch(() => {})
  }

  if (ctx.channel.usePrimary()) joinOverlayTopic(`channel:${ctx.channel.primaryKey}`, ctx.channel.channel.key, ctx.channel.channel.discoveryKey)

  // Announces each video on its stock Hypercore discoveryKey, the topic HiveRelays and every PearTube since v0.4.32 look up.
  const contentTopics = new Map()
  function joinContentSwarm (blobsHex, evict = true) {
    if (dht || ctx.life.closing || !str(blobsHex, HEX64)) return
    // Re-joining an announced topic only refreshes its place in line: the eviction order is the
    // serving order, so a title being played is the last one dropped.
    if (contentTopics.has(blobsHex)) {
      const live = contentTopics.get(blobsHex)
      contentTopics.delete(blobsHex)
      contentTopics.set(blobsHex, live)
      return
    }
    if (contentTopics.size >= MAX_CONTENT_TOPICS) {
      // Catalog reads never displace a topic just because a refresh saw a cached copy. Deliberate
      // joins still rotate the least recently served title out, owned or not: a finished download
      // walks the same queue, so a large library still gets its turn.
      if (!evict) return
      const victim = contentTopics.keys().next().value
      const oldTopic = contentTopics.get(victim)
      contentTopics.delete(victim)
      swarm.leave(oldTopic).catch(() => {})
      lan?.leave?.(oldTopic)
    }
    const topic = hypercoreCrypto.discoveryKey(b4a.from(blobsHex, 'hex'))
    contentTopics.set(blobsHex, topic)
    swarm.join(topic, { server: true, client: true })
    lan?.join(topic)
  }
  for (const s of ctx.blobs.blobSlots) {
    if (s.core.length > 0 && await s.core.count(0, s.core.length) > 0) joinContentSwarm(s.key)
  }
  for (const hex of ctx.blobs.ownedBlobs.keys()) {
    if (contentTopics.size >= MAX_CONTENT_TOPICS) break
    joinContentSwarm(hex)
  }
  // Content past the cap gets its turn slowly, one complete copy at a time. The status poll used to
  // join every cached core it walked, which churned the DHT and evicted whatever it happened to see.
  const rotateTimer = setInterval(() => {
    if (ctx.life.closing) return
    const candidates = []
    for (const [hex, core] of ctx.blobs.blobCores) {
      if (contentTopics.has(hex) || ctx.blobs.isOwnedBlob(hex) || !core.opened || core.length === 0) continue
      ctx.blobs.ensureBlockCounter(core, hex)
      if (ctx.blobs.localBlocks(core) >= core.length) candidates.push(hex)
    }
    for (const [hex, meta] of ctx.blobs.cachedBlobs) {
      if (!contentTopics.has(hex) && !ctx.blobs.blobCores.has(hex) && !ctx.blobs.isOwnedBlob(hex) && meta.length > 0 && meta.blocks >= meta.length) {
        candidates.push(hex)
      }
    }
    for (const hex of ctx.blobs.ownedBlobs.keys()) if (!contentTopics.has(hex)) candidates.push(hex)
    if (candidates.length > 0) joinContentSwarm(candidates[0])
  }, CONTENT_TOPIC_ROTATE_MS)
  rotateTimer.unref?.()
  ctx.undo.push(() => clearInterval(rotateTimer))
  if (ctx.channel.usePrimary()) ctx.channel.channel.update().then(() => ctx.life.closing ? null : ctx.blobs.hydrateOwned()).catch(() => {})

  function leaveContentSwarm (blobsHex) {
    const oldTopic = contentTopics.get(blobsHex)
    if (!oldTopic) return
    contentTopics.delete(blobsHex)
    swarm.leave(oldTopic).catch(() => {})
    lan?.leave?.(oldTopic)
  }

  let refreshTimer = null

  async function setLan (factory) {
    const previous = lan
    lan = null
    await previous?.destroy()
    if (!factory || ctx.life.closing || dht) return
    const next = factory(swarm.keyPair)
    next.on('connection', conn => {
      lanPeers.add(conn)
      conn.once('close', () => lanPeers.delete(conn))
      if (conn.remotePublicKey) {
        for (const sc of swarm.connections) {
          if (!sc.destroyed && sc.remotePublicKey && b4a.equals(sc.remotePublicKey, conn.remotePublicKey)) sc.destroy()
        }
      }
      trackConn(conn, traffic.lan)
    })
    try {
      await next.ready()
    } catch (err) {
      await next.destroy()
      throw err
    }
    if (ctx.life.closing) {
      await next.destroy()
      return
    }
    for (const discKey of lanTopics.values()) next.join(discKey)
    if (!dht) for (const topic of contentTopics.values()) next.join(topic)
    lan = next
  }

  async function initLan (createLan) {
    if (dht) {
      refreshTimer = setInterval(() => {
        if (ctx.life.closing || swarm.connections.size >= 16) return
        for (const d of discoveries.values()) d.refresh().catch(() => {})
      }, 20_000)
      refreshTimer?.unref?.()
      ctx.undo.push(() => clearInterval(refreshTimer))
      swarm.listen().catch(() => {})
    }
    await setLan(createLan).catch(err => console.error('LAN discovery did not start: ' + (err?.message || err)))
    ctx.undo.push(() => lan?.destroy())
  }

  let inflightRange = ctx.storage.isMobileWorklet ? [6, 8] : (isWorklet ? [16, 48] : [12, 32])

  // Bytes per route (live connections plus closed ones), whole-node totals, and rates; rates move at most every 500 ms.
  function sample () {
    let rttSum = 0, rttCount = 0, retransmits = 0, contributingPeers = 0
    const now = Date.now(), dt = now - prevAt
    function measure (path, connections) {
      let rxBytes = path.closedRx, txBytes = path.closedTx
      if (connections) for (const c of connections) {
        const crx = c.rawBytesRead || c.rawStream?.bytesReceived || 0
        if (crx > 0) contributingPeers++
        rxBytes += crx
        txBytes += c.rawBytesWritten || c.rawStream?.bytesTransmitted || 0
        const r = c.rawStream
        if (r?.rtt > 0) { rttSum += r.rtt; rttCount++ }
        if (r?.retransmits > 0) retransmits += r.retransmits
      }
      if (dt >= 500) {
        path.downBps = Math.max(0, Math.round(((rxBytes - path.prevRx) * 1000) / dt))
        path.upBps = Math.max(0, Math.round(((txBytes - path.prevTx) * 1000) / dt))
        path.prevRx = rxBytes; path.prevTx = txBytes
      }
      return { peers: connections?.size || 0, rxBytes, txBytes, downBps: path.downBps, upBps: path.upBps }
    }
    const routes = {
      private: measure(traffic.private, dht ? swarm.connections : null),
      public: measure(traffic.public, dht ? null : swarm.connections),
      lan: measure(traffic.lan, lanPeers)
    }
    const rxBytes = routes.private.rxBytes + routes.public.rxBytes + routes.lan.rxBytes
    const txBytes = routes.private.txBytes + routes.public.txBytes + routes.lan.txBytes
    if (dt >= 500) {
      downBps = Math.max(0, Math.round(((rxBytes - prevRx) * 1000) / dt))
      upBps = Math.max(0, Math.round(((txBytes - prevTx) * 1000) / dt))
      prevRx = rxBytes; prevTx = txBytes; prevAt = now
    }
    return { routes, rxBytes, txBytes, downBps, upBps, contributingPeers, rtt: rttCount ? Math.round(rttSum / rttCount) : 0, retransmits }
  }

  function setAllowedPeers (keys) {
    allowedSet = Array.isArray(keys) && keys.length ? new Set(keys.map(k => String(k).toLowerCase())) : null
  }

  return {
    swarm,
    dht,
    get lan () { return lan },
    hasLanPeer,
    lanPeers,
    peerConns,
    connListeners,
    sample,
    discoveries,
    joinOverlayTopic,
    leaveOverlayTopic,
    joinContentSwarm,
    leaveContentSwarm,
    rotateTimer,
    get refreshTimer () { return refreshTimer },
    setLan,
    initLan,
    setAllowedPeers,
    attachSource,
    inflightRange: () => inflightRange,
    setInflightRange: r => { inflightRange = r },
    get downBps () { return downBps },
    get upBps () { return upBps }
  }
}
