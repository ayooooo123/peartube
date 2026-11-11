import Hyperswarm from 'hyperswarm'
import hypercoreCrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { tuneUdxSocket } from '../lan.js'
import { createPrivateSwarm } from '../private-overlay.js'
import { HEX64, str } from '../protocol.js'

// How many videos a node announces at once, and how often one past that cap gets its turn on the DHT.
const MAX_ANNOUNCED = 48
const ANNOUNCE_ROTATE_MS = 20_000
// Titles looked up at once: the one playing and the last few opened.
const MAX_LOOKUPS = 4

export async function createNetwork (ctx) {
  const {
    bootstrap,
    privateHost = null,
    dhtPort,
    privateRouting = false,
    relayThrough = null,
    allowedPeers = null,
    worklet: isWorklet = false,
    announceCache = false,
    keyPair = null
  } = ctx.opts

  const host = privateHost ?? (Array.isArray(bootstrap) && bootstrap.some(b => String(b?.host || b).startsWith('127.')) ? '127.0.0.1' : undefined)
  const isPrivate = Boolean(privateRouting)
  const privateOpts = typeof privateRouting === 'object' && privateRouting !== null ? privateRouting : {}

  let allowedSet = Array.isArray(allowedPeers) && allowedPeers.length ? new Set(allowedPeers.map(k => String(k).toLowerCase())) : null
  const lanPeers = new Set()
  const hasLanPeer = keyBuf => Boolean(keyBuf && [...lanPeers].some(c => !c.destroyed && c.remotePublicKey && b4a.equals(c.remotePublicKey, keyBuf)))
  // Never feed LAN peers into Hyperswarm's firewall: Hyperswarm bans rejected keys for life (`peerInfo.ban(true)`),
  // blinding cellular handoff once Wi-Fi drops; duplicate public sockets get destroyed cleanly on open instead.
  const firewall = remotePublicKey => allowedSet ? !allowedSet.has(b4a.toString(remotePublicKey, 'hex')) : false
  const bucket = () => ({ closedRx: 0, closedTx: 0, prevRx: 0, prevTx: 0, downBps: 0, upBps: 0 })
  const traffic = { private: bucket(), public: bucket(), lan: bucket() }
  let prevRx = 0, prevTx = 0, prevAt = Date.now(), downBps = 0, upBps = 0
  const tuneDht = inst => inst?.ready?.().then(() => { tuneUdxSocket(inst.io?.serverSocket); tuneUdxSocket(inst.io?.clientSocket) }).catch(() => {})
  // Every replication connection, public swarm and LAN alike, for plugins that act per peer.
  const peerConns = new Set()
  const connListeners = new Set()
  // One root Corestore replication pipe and one shared ProtomuxWakeup stream serve the primary channel and every
  // woken namespace together without stacking 25 duplicate close listeners and StreamTracker entries per peer.
  const trackConn = (conn, path) => {
    tuneUdxSocket(conn.rawStream?.socket)
    tuneUdxSocket(conn.rawStream?.rawStream?.socket)
    peerConns.add(conn)
    conn.once('close', () => {
      peerConns.delete(conn)
      path.closedRx += conn.rawBytesRead || conn.rawStream?.bytesReceived || 0
      path.closedTx += conn.rawBytesWritten || conn.rawStream?.bytesTransmitted || 0
      const key = conn.remotePublicKey
      if (key && ![...peerConns].some(c => c.remotePublicKey && b4a.equals(c.remotePublicKey, key))) ctx.blobs.sourcePeers.delete(b4a.toString(key, 'hex'))
    })
    const stream = ctx.storage.store.replicate(conn)
    ctx.channel.wakeup.addStream(stream)
    for (const fn of connListeners) fn(conn)
  }
  const swarm = isPrivate
    ? await createPrivateSwarm({
        host,
        bootstrap,
        port: dhtPort || [0, 0],
        allowLoopback: privateOpts.allowLoopback,
        resolveAddress: privateOpts.resolveAddress,
        firewall,
        keyPair: keyPair || undefined
      })
    : new Hyperswarm({
        maxParallel: 16,
        bootstrap,
        port: dhtPort || [0, 0],
        firewall,
        keyPair: keyPair || undefined,
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

  // A topic only this LAN hears: the peers on it connect to each other here, and it is never announced on the DHT.
  function joinLanTopic (id, topic) {
    if (dht || lanTopics.has(id)) return
    lanTopics.set(id, topic)
    lan?.join(topic)
  }

  // Two holds can share one topic: a followed channel and a watch link to it. Leaving one ends only that hold, and
  // the topic leaves the DHT and the LAN with its last hold.
  async function leaveOverlayTopic (id) {
    const disc = discoveries.get(id)
    const discKey = lanTopics.get(id)
    discoveries.delete(id)
    lanTopics.delete(id)
    if (discKey && ![...lanTopics.values()].some(held => b4a.equals(held, discKey))) lan?.leave?.(discKey)
    if (dht) await swarm.leaveSource(id).catch(() => {})
    else if (disc) await disc.destroy().catch(() => {})
  }

  if (ctx.channel.usePrimary()) joinOverlayTopic(`channel:${ctx.channel.primaryKey}`, ctx.channel.channel.key, ctx.channel.channel.discoveryKey)

  // A video's DHT topic is its Hypercore discoveryKey, the one HiveRelays and every PearTube since v0.4.32 use.
  // Announcing it tells the DHT and the LAN that this address holds the video. So a node announces only what it
  // published, plus its complete cached copies when it is a relay (`announceCache`), and never looks peers up for
  // those. A title being read is looked up without announcing. A peer that is already connected (the channel's
  // swarm, the LAN) serves any video it stores over that connection with no topic at all.
  const announced = new Map() // blobsHex -> { topic, session }, least recently served first
  const lookups = new Map() // the same, least recently read first
  const usable = hex => !dht && !ctx.life.closing && str(hex, HEX64)
  const holdsAll = hex => {
    const meta = ctx.blobs.cachedBlobs.get(hex)
    return Boolean(meta && meta.length > 0 && meta.blocks >= meta.length)
  }
  function dropTopic (map, hex) {
    const held = map.get(hex)
    if (!held) return
    map.delete(hex)
    held.session.destroy().catch(() => {})
    lan?.leave?.(held.topic)
  }
  function joinTopic (hex, opts) {
    const topic = hypercoreCrypto.discoveryKey(b4a.from(hex, 'hex'))
    lan?.join(topic)
    return { topic, session: swarm.join(topic, opts) }
  }
  // Asking again for a held topic only refreshes its place in line: a title being played is the last one dropped.
  function touch (map, hex) {
    const held = map.get(hex)
    if (!held) return false
    map.delete(hex)
    map.set(hex, held)
    return true
  }
  function announceContent (hex, evict = true) {
    if (!usable(hex) || touch(announced, hex)) return
    if (announced.size >= MAX_ANNOUNCED) {
      // Catalog reads never displace a topic just because a refresh saw a complete copy. Deliberate
      // joins still rotate the least recently served title out, owned or not: a finished download
      // walks the same queue, so a large library still gets its turn.
      if (!evict) return
      dropTopic(announced, announced.keys().next().value)
    }
    const looked = lookups.get(hex)
    lookups.delete(hex)
    looked?.session.refresh({ server: true, client: false }).catch(() => {})
    announced.set(hex, looked || joinTopic(hex, { server: true, client: false }))
  }
  function lookupContent (hex) {
    if (!usable(hex) || announced.has(hex) || touch(lookups, hex)) return
    if (lookups.size >= MAX_LOOKUPS) dropTopic(lookups, lookups.keys().next().value)
    lookups.set(hex, joinTopic(hex, { server: false, client: true }))
  }
  // A title about to be read: find its peers, unless this node holds all of it.
  function wantContent (hex) {
    if (ctx.blobs.isOwnedBlob(hex) || (announceCache && holdsAll(hex))) announceContent(hex)
    else if (!holdsAll(hex)) lookupContent(hex)
  }
  function leaveContent (hex) {
    dropTopic(announced, hex)
    dropTopic(lookups, hex)
  }
  // A complete cached copy seen while the catalog is listed: a relay announces it when a slot is free.
  const offerCopy = hex => { if (announceCache) announceContent(hex, false) }
  for (const s of ctx.blobs.blobSlots) {
    if (s.core.length > 0 && await s.core.count(0, s.core.length) > 0) announceContent(s.key)
  }
  for (const hex of ctx.blobs.ownedBlobs.keys()) {
    if (announced.size >= MAX_ANNOUNCED) break
    announceContent(hex)
  }
  // Content past the cap gets its turn slowly, one complete copy at a time. The status poll used to
  // join every cached core it walked, which churned the DHT and evicted whatever it happened to see.
  const rotateTimer = setInterval(() => {
    if (ctx.life.closing || ctx.life.suspended) return
    const candidates = []
    if (announceCache) {
      for (const [hex, core] of ctx.blobs.blobCores) {
        if (announced.has(hex) || ctx.blobs.isOwnedBlob(hex) || !core.opened || core.length === 0) continue
        ctx.blobs.ensureBlockCounter(core, hex)
        if (ctx.blobs.localBlocks(core) >= core.length) candidates.push(hex)
      }
      for (const hex of ctx.blobs.cachedBlobs.keys()) {
        if (!announced.has(hex) && !ctx.blobs.blobCores.has(hex) && !ctx.blobs.isOwnedBlob(hex) && holdsAll(hex)) candidates.push(hex)
      }
    }
    for (const hex of ctx.blobs.ownedBlobs.keys()) if (!announced.has(hex)) candidates.push(hex)
    if (candidates.length > 0) announceContent(candidates[0])
  }, ANNOUNCE_ROTATE_MS)
  rotateTimer.unref?.()
  ctx.undo.push(() => clearInterval(rotateTimer))
  if (ctx.channel.usePrimary()) {
    const done = !dht ? ctx.storage.store.findingPeers() : null
    if (done) {
      const t = setTimeout(done, 3_000)
      t.unref?.()
      swarm.flush().then(done, done).finally(() => clearTimeout(t))
    }
    ctx.channel.channel.update().then(() => ctx.life.closing ? null : ctx.blobs.hydrateOwned()).catch(() => {})
  }

  let refreshTimer = null

  async function setLan (factory) {
    const previous = lan
    lan = null
    await previous?.destroy()
    if (!factory || ctx.life.closing || dht) return
    const next = factory(swarm.keyPair)
    next.on('connection', conn => {
      if (allowedSet && conn.remotePublicKey && !allowedSet.has(b4a.toString(conn.remotePublicKey, 'hex'))) {
        conn.destroy()
        return
      }
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
    for (const held of [...announced.values(), ...lookups.values()]) next.join(held.topic)
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
    if (swarm.peers) {
      for (const [hex, peerInfo] of swarm.peers) {
        if (!allowedSet || allowedSet.has(hex)) peerInfo.ban?.(false)
      }
    }
    if (allowedSet) {
      for (const conn of [...peerConns]) {
        if (conn.remotePublicKey && !allowedSet.has(b4a.toString(conn.remotePublicKey, 'hex'))) conn.destroy()
      }
    }
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
    announceContent,
    wantContent,
    leaveContent,
    offerCopy,
    joinLanTopic,
    rotateTimer,
    get refreshTimer () { return refreshTimer },
    setLan,
    initLan,
    setAllowedPeers,
    inflightRange: () => inflightRange,
    setInflightRange: r => { inflightRange = r },
    get downBps () { return downBps },
    get upBps () { return upBps }
  }
}
