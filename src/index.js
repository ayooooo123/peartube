import Autobee from 'autobee'
import Hyperbee from 'hyperbee2'
import ProtomuxWakeup from 'protomux-wakeup'
import Corestore from 'corestore'
import CoreStorage from 'hypercore-storage'
import Hyperswarm from 'hyperswarm'
import Hyperblobs from 'hyperblobs'
import hypercoreCrypto from 'hypercore-crypto'
import BlobServer from 'hypercore-blob-server'
import b4a from 'b4a'
import { createHash } from 'node:crypto'
import { pipelinePromise, Readable, Transform } from 'streamx'
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tuneUdxSocket } from './lan.js'
import { createPrivateSwarm } from './private-overlay.js'
const ID = /^[a-z0-9]+:[a-z0-9]+(:s\d{2}e\d{2,3})?$/
const HEX64 = /^[0-9a-f]{64}$/
const MAX_TITLE = 300
const BLOB_BLOCK_SIZE = 512 * 1024
const MAX_CONTENT_TOPICS = 24
// How often content beyond the announcement cap gets its turn on the DHT.
const CONTENT_TOPIC_ROTATE_MS = 20_000
const isUniform512 = blob => Boolean(blob && (
  blob.byteLength === 0 || (
    blob.blockLength > 0 &&
    (blob.blockLength - 1) * BLOB_BLOCK_SIZE < blob.byteLength &&
    blob.byteLength <= blob.blockLength * BLOB_BLOCK_SIZE
  )
))

// Every peer value is untrusted until decodeOp blesses it; typeof guards every regex.
const str = (v, re) => typeof v === 'string' && re.test(v)
const cleanText = (v, fallback = '') => String(v || fallback).slice(0, MAX_TITLE).toWellFormed()
const parseQuery = raw => {
  const out = {}
  if (!raw) return out
  for (const part of raw.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const k = eq === -1 ? part : part.slice(0, eq)
    const v = eq === -1 ? '' : part.slice(eq + 1)
    try { out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')) } catch { out[k] = v }
  }
  return out
}

// Formats a zero-subscription magnet URI so any client can stream a blob swarm on sight.
export function formatWatchUri (entry, source = '', sourceKind = '') {
  const b = entry.blob || {}
  const q = [`id=${encodeURIComponent(entry.id)}`, `title=${encodeURIComponent(cleanText(entry.title, entry.id))}`]
  if (str(entry.sha256, HEX64)) q.push(`sha256=${entry.sha256}`)
  if (str(source, HEX64)) {
    q.push(`source=${source}`)
    if (sourceKind === 'channel' || sourceKind === 'tracker') q.push(`kind=${sourceKind}`)
  }
  return `peartube://watch/${entry.blobs}:${b.blockOffset}:${b.blockLength}:${b.byteOffset}:${b.byteLength}?${q.join('&')}`
}

// Strips peartube:// links and raw 64-hex keys down to an actionable source or instant watch payload.
export function parseUri (input, defaultKind = 'tracker') {
  if (typeof input !== 'string') throw new Error('URI or 64-hex key required')
  const raw = input.trim()
  const lower = raw.toLowerCase()
  if (HEX64.test(lower)) return { action: 'source', key: lower, kind: defaultKind === 'channel' ? 'channel' : 'tracker', alias: '' }
  const m = raw.match(/^peartube:(?:\/\/)?([a-z]+)\/([^?#]+)(?:\?([^#]*))?/i)
  if (!m) throw new Error('Invalid PearTube URI or 64-hex key')
  const verb = m[1].toLowerCase()
  const body = m[2].trim()
  const q = parseQuery(m[3] || '')
  if (verb === 'channel' || verb === 'tracker' || verb === 'add' || verb === 'source') {
    const key = body.toLowerCase()
    if (!HEX64.test(key)) throw new Error('Source key must be 64 hex characters')
    const kind = verb === 'channel' ? 'channel' : verb === 'tracker' ? 'tracker' : (q.kind === 'channel' ? 'channel' : 'tracker')
    return { action: 'source', key, kind, alias: cleanText(q.name || q.alias || '') }
  }
  if (verb === 'watch') {
    const parts = body.split(':')
    if (parts.length !== 5 || !HEX64.test(parts[0].toLowerCase())) throw new Error('Malformed peartube://watch blob pointer')
    const blobs = parts[0].toLowerCase()
    const [blockOffset, blockLength, byteOffset, byteLength] = parts.slice(1).map(Number)
    if (![blockOffset, blockLength, byteOffset, byteLength].every(n => Number.isSafeInteger(n) && n >= 0) || blockLength <= 0) {
      throw new Error('Malformed peartube://watch block bounds')
    }
    const sha256 = q.sha256 && HEX64.test(q.sha256.toLowerCase()) ? q.sha256.toLowerCase() : ( '0'.repeat(64) )
    const fallbackId = `clip:${(q.sha256 || blobs).toLowerCase().slice(0, 12)}`
    const id = str(q.id?.toLowerCase(), ID) ? q.id.toLowerCase() : fallbackId
    const title = cleanText(q.title, id)
    const sourceKey = q.source && HEX64.test(q.source.toLowerCase()) ? q.source.toLowerCase() : null
    const sourceKind = q.kind === 'tracker' ? 'tracker' : 'channel'
    return {
      action: 'watch',
      sourceKey,
      sourceKind,
      entry: { type: 'announce', id, title, size: byteLength, sha256, blobs, blob: { blockOffset, blockLength, byteOffset, byteLength } }
    }
  }
  throw new Error(`Unsupported PearTube URI action: ${verb}`)
}

export function decodeOp (value) {
  let op
  try { op = JSON.parse(typeof value === 'string' ? value : b4a.toString(value)) } catch { return null }
  if (op === null || typeof op !== 'object') return null
  if (op.type === 'remove') return typeof op.key === 'string' ? op : null
  if (op.type === 'peer') return str(op.publicKey, HEX64) && Number.isSafeInteger(op.expiresAt) && op.expiresAt > 0 ? op : null
  if (op.type === 'source') {
    if (!str(op.sourceKey, HEX64) || (op.kind !== 'tracker' && op.kind !== 'channel')) return null
    if (typeof op.title !== 'string' || op.title.length === 0 || op.title.length > MAX_TITLE) return null
    return op
  }
  if (op.type !== 'announce' || !str(op.id, ID) || !str(op.blobs, HEX64) || !str(op.sha256, HEX64)) return null
  if (typeof op.title !== 'string' || op.title.length > MAX_TITLE || !Number.isSafeInteger(op.size) || op.size < 0) return null
  const { blockOffset, blockLength, byteOffset, byteLength } = op.blob || {}
  if (![blockOffset, blockLength, byteOffset, byteLength].every(n => Number.isSafeInteger(n) && n >= 0)) return null
  return op
}

// Deterministic multi-writer gate: each writer may file or delete only under its own hex key.
async function apply (nodes, view, host) {
  for (const node of nodes) {
    const op = decodeOp(node.value)
    if (!op) continue
    await host.addWriter(node.key, { isIndexer: false })
    const writer = b4a.toString(node.key, 'hex')
    const w = view.write()
    if (op.type === 'remove') {
      if (op.key.split('/')[1] === writer) w.tryDelete(b4a.from(op.key))
    } else if (op.type === 'peer') {
      w.tryPut(b4a.from(`peer/${writer}`), node.value)
    } else if (op.type === 'source') {
      w.tryPut(b4a.from(`source/${writer}/${op.sourceKey}`), node.value)
    } else {
      w.tryPut(b4a.from(`${op.id}/${writer}/${op.blobs}:${op.blob.blockOffset}`), node.value)
    }
    await w.flush()
  }
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
  tracker: trackerKey = null,
  sources: initialSources = [],
  allowedPeers = null,
  streamHost = '127.0.0.1',
  streamPort = 0,
  bootstrap,
  privateHost = null,
  dhtPort,
  privateRouting = false,
  privateRelay = false,
  relayThrough = null,
  lan: createLan = null,
  onchange = null
}, undo) {
  if (privateRelay) {
    throw new Error('Embedded privateRelay was removed; run standalone peartube-private-relay (bin/private-relay.js) so guard forwarders never open Corestore or tracker state')
  }
  const csDir = join(storage, 'corestore')
  // The node owns its hypercore-storage so compaction and core lookups go through that instance, not Corestore internals.
  let coreStorage = new CoreStorage(csDir)
  let store = new Corestore(coreStorage)
  try {
    await store.ready()
  } catch (err) {
    if (!/Invalid device file/i.test(err?.message || '')) throw err
    await store.close().catch(() => {})
    try { unlinkSync(join(csDir, 'CORESTORE')) } catch {}
    coreStorage = new CoreStorage(csDir)
    store = new Corestore(coreStorage)
    await store.ready()
  }
  undo.push(() => store.close())
  const wakeup = new ProtomuxWakeup()
  let onPeersChanged = null
  let viewEpoch = 1
  const update = () => {
    viewEpoch++
    if (onchange) queueMicrotask(onchange)
    if (onPeersChanged) queueMicrotask(onPeersChanged)
  }
  // fastForward: false forces every peer to verify writer namespaces locally through apply.
  const tracker = new Autobee(store.namespace('tracker'), trackerKey && b4a.from(trackerKey, 'hex'), { apply, update, optimistic: true, fastForward: false, wakeup })
  undo.push(() => tracker.close())
  await tracker.ready()
  // Every node also owns an unforgeable single-writer Hyperbee channel; strangers can read & seed, never append.
  const localChannel = new Hyperbee(store.namespace('channel'), { writable: true, autoUpdate: false })
  undo.push(() => localChannel.close())
  await localChannel.ready()
  const isWorklet = typeof globalThis.BareKit !== 'undefined'
  // Per-peer request window for video cores, passed as Hypercore's documented `inflightRange` when a core opens;
  // the reciprocity tier picks the window for cores opened from then on.
  let inflightRange = isWorklet ? [6, 8] : [12, 32]
  const usePrimaryTracker = Boolean(trackerKey) || initialSources.length === 0
  if (!trackerKey && usePrimaryTracker && tracker.local.length === 0) {
    await tracker.append(b4a.from(JSON.stringify({ type: 'init' })))
    await tracker.updated()
  }
  const primaryKey = b4a.toString(tracker.key, 'hex')
  const channelKey = b4a.toString(localChannel.core.key, 'hex')
  let channelQueue = Promise.resolve()
  const withChannelLock = fn => {
    const next = channelQueue.then(fn, fn)
    channelQueue = next.catch(() => {})
    return next
  }

  // Legacy shared slots stay readable & migratable in place; every new video gets its own 512 KiB-piece Hypercore closed at rest.
  const blobSlots = []
  const blobCores = new Map()
  const ownedBlobs = new Map() // blobsHex -> { length, byteLength }
  async function openSlot (i) {
    const core = store.get({ name: i === 0 ? 'blobs' : `blobs-${i}` })
    await core.ready()
    const slot = { core, blobs: new Hyperblobs(core, { blockSize: BLOB_BLOCK_SIZE }), key: b4a.toString(core.key, 'hex') }
    blobSlots.push(slot)
    blobCores.set(slot.key, core)
    return slot
  }
  await openSlot(0)
  for (let i = 1; i < 64; i++) {
    const core = store.get({ name: `blobs-${i}` })
    await core.ready()
    if (core.length === 0) { await core.close(); if (i >= 4) break; else continue }
    const slot = { core, blobs: new Hyperblobs(core, { blockSize: BLOB_BLOCK_SIZE }), key: b4a.toString(core.key, 'hex') }
    blobSlots.push(slot)
    blobCores.set(slot.key, core)
  }
  const slotSet = new Set(blobSlots.map(s => s.key))
  const isOwnedBlob = hex => ownedBlobs.has(hex) || slotSet.has(hex)
  const blobsKey = blobSlots[0].key

  // Hydrates locally authored per-video cores from RocksDB headers on boot and closes sessions immediately so idle movies take 0 RAM.
  {
    const candidates = new Set()
    if (usePrimaryTracker) {
      await tracker.update()
      const writer = b4a.toString(tracker.local.key, 'hex')
      for await (const n of tracker.view.createReadStream()) {
        const k = b4a.toString(n.key)
        if (k.startsWith('peer/') || k.startsWith('source/') || k.split('/')[1] !== writer) continue
        const op = decodeOp(n.value)
        if (op?.type === 'announce' && !slotSet.has(op.blobs)) candidates.add(op.blobs)
      }
    }
    if (localChannel.core.length > 0) {
      for await (const n of localChannel.createReadStream({ gte: b4a.from('entry/'), lt: b4a.from('entry/\xff') })) {
        const op = decodeOp(n.value)
        if (op?.type === 'announce' && !slotSet.has(op.blobs)) candidates.add(op.blobs)
      }
    }
    const keys = [...candidates]
    for (let i = 0; i < keys.length; i += 32) {
      await Promise.all(keys.slice(i, i + 32).map(async hex => {
        const c = store.get({ key: b4a.from(hex, 'hex') })
        try {
          await c.ready()
          if (c.writable && c.length > 0) {
            ownedBlobs.set(hex, { length: c.length, byteLength: c.byteLength })
          }
        } finally {
          await c.close().catch(() => {})
        }
      }))
    }
  }
  const host = privateHost ?? (Array.isArray(bootstrap) && bootstrap.some(b => String(b?.host || b).startsWith('127.')) ? '127.0.0.1' : undefined)
  const isPrivate = Boolean(privateRouting)
  const privateOpts = typeof privateRouting === 'object' && privateRouting !== null ? privateRouting : {}
  let closing = false

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
  const trackConn = (conn, path) => {
    tuneUdxSocket(conn.rawStream?.socket)
    tuneUdxSocket(conn.rawStream?.rawStream?.socket)
    peerConns.add(conn)
    conn.once('close', () => {
      peerConns.delete(conn)
      path.closedRx += conn.rawBytesRead || conn.rawStream?.bytesReceived || 0
      path.closedTx += conn.rawBytesWritten || conn.rawStream?.bytesTransmitted || 0
    })
    tracker.replicate(conn)
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
    if (dht) { tracker.update().catch(() => {}); scanPeers().catch(() => {}) }
  })
  undo.push(() => swarm.destroy({ force: true }))
  undo.push(() => {
    closing = true
    wakeup.destroy()
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

  if (usePrimaryTracker) joinOverlayTopic(`tracker:${primaryKey}`, tracker.key, tracker.discoveryKey)
  if (localChannel.core.length > 0) joinOverlayTopic(`channel:${channelKey}`, localChannel.core.key, localChannel.core.discoveryKey)

  // Spreads both PearTube's merged blob topic and stock Hypercore discoveryKey wide on public swarms so supplemental HiveRelays find every wet 512 KiB block.
  const contentTopics = new Map()
  function joinContentSwarm (blobsHex, evict = true) {
    if (dht || closing || !str(blobsHex, HEX64)) return
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
      const oldTopics = contentTopics.get(victim)
      contentTopics.delete(victim)
      for (const t of oldTopics) {
        swarm.leave(t).catch(() => {})
        lan?.leave?.(t)
      }
    }
    const keyBuf = b4a.from(blobsHex, 'hex')
    const topics = [
      createHash('sha256').update('peartube/blob/v1/').update(keyBuf).digest(),
      hypercoreCrypto.discoveryKey(keyBuf)
    ]
    contentTopics.set(blobsHex, topics)
    for (const t of topics) {
      swarm.join(t, { server: true, client: true })
      lan?.join(t)
    }
  }
  for (const s of blobSlots) {
    if (s.core.length > 0 && await s.core.count(0, s.core.length) > 0) joinContentSwarm(s.key)
  }
  for (const hex of ownedBlobs.keys()) {
    if (contentTopics.size >= MAX_CONTENT_TOPICS) break
    joinContentSwarm(hex)
  }
  // Content past the cap gets its turn slowly, one complete copy at a time. The status poll used to
  // join every cached core it walked, which churned the DHT and evicted whatever it happened to see.
  const rotateTimer = setInterval(() => {
    if (closing) return
    const candidates = []
    for (const [hex, core] of blobCores) {
      if (contentTopics.has(hex) || !core.opened || core.length === 0) continue
      ensureBlockCounter(core)
      if (localBlocks(core) >= core.length) candidates.push(hex)
    }
    for (const hex of ownedBlobs.keys()) if (!contentTopics.has(hex)) candidates.push(hex)
    if (candidates.length > 0) joinContentSwarm(candidates[0])
  }, CONTENT_TOPIC_ROTATE_MS)
  rotateTimer.unref?.()
  undo.push(() => clearInterval(rotateTimer))
  function leaveContentSwarm (blobsHex) {
    const oldTopics = contentTopics.get(blobsHex)
    if (!oldTopics) return
    contentTopics.delete(blobsHex)
    for (const t of oldTopics) {
      swarm.leave(t).catch(() => {})
      lan?.leave?.(t)
    }
  }

  const extraSources = new Map()
  const ephemeralWatches = new Map()
  let primaryAlias = ''
  let localChannelAlias = ''

  async function addSource (spec) {
    const parsed = typeof spec === 'string' ? parseUri(spec, 'channel') : parseUri(spec.uri || spec.key, spec.kind || 'channel')
    if (parsed.action !== 'source') throw new Error('Expected a channel or tracker source, not a watch URI')
    const { key, kind } = parsed
    const alias = cleanText(spec?.alias ?? parsed.alias)
    if (key === primaryKey && usePrimaryTracker) {
      if (alias) primaryAlias = alias
      update()
      return { key, kind: 'tracker', alias: primaryAlias, primary: true, writable: true }
    }
    if (key === channelKey) {
      if (alias) localChannelAlias = alias
      joinOverlayTopic(`channel:${channelKey}`, localChannel.core.key, localChannel.core.discoveryKey)
      update()
      return { key, kind: 'channel', alias: localChannelAlias, primary: false, writable: true }
    }
    const existing = extraSources.get(key)
    if (existing) {
      if (alias) existing.alias = alias
      update()
      return { key, kind: existing.kind, alias: existing.alias, primary: false, writable: false }
    }
    if (kind === 'tracker') {
      const bee = new Autobee(store.namespace(`tracker:${key}`), b4a.from(key, 'hex'), { apply, update, optimistic: true, fastForward: false, wakeup })
      await bee.ready()
      extraSources.set(key, { key, kind, alias, bee })
      joinOverlayTopic(`tracker:${key}`, bee.key, bee.discoveryKey)
      if (dht) swarm.listen().then(() => advertisePeer(true)).catch(() => {})
    } else {
      const bee = new Hyperbee(store.namespace(`channel:${key}`), { key: b4a.from(key, 'hex'), writable: false, autoUpdate: true })
      await bee.ready()
      const dl = bee.core.download({ start: 0, end: -1 })
      bee.on('update', update)
      extraSources.set(key, { key, kind: 'channel', alias, bee, dl })
      joinOverlayTopic(`channel:${key}`, bee.core.key, bee.core.discoveryKey)
    }
    onPeersChanged?.()
    update()
    return { key, kind, alias, primary: false, writable: false }
  }

  async function removeSource (key) {
    const k = String(key || '').trim().toLowerCase()
    const src = extraSources.get(k)
    if (!src) return { removed: false }
    extraSources.delete(k)
    src.dl?.destroy()
    await leaveOverlayTopic(`${src.kind}:${k}`)
    await src.bee.close().catch(() => {})
    update()
    return { removed: true }
  }

  function listSources () {
    const list = []
    if (usePrimaryTracker) list.push({ key: primaryKey, kind: 'tracker', alias: primaryAlias, primary: true, writable: true })
    if (localChannel.core.length > 0 || localChannelAlias) {
      list.push({ key: channelKey, kind: 'channel', alias: localChannelAlias, primary: false, writable: true })
    }
    for (const s of extraSources.values()) {
      list.push({ key: s.key, kind: s.kind, alias: s.alias, primary: false, writable: false })
    }
    return list
  }

  for (const s of initialSources) await addSource(s)

  const refreshTimer = dht ? setInterval(() => {
    if (closing || swarm.connections.size >= 16) return
    for (const d of discoveries.values()) d.refresh().catch(() => {})
  }, 20_000) : null
  refreshTimer?.unref?.()
  undo.push(() => clearInterval(refreshTimer))

  const roster = new Map()
  let scanningPeers = false
  async function scanPeers () {
    if (!dht || closing || scanningPeers) return
    scanningPeers = true
    try {
      const available = new Map()
      const now = Date.now()
      const views = [
        ...(usePrimaryTracker ? [tracker.view] : []),
        ...[...extraSources.values()].map(s => s.kind === 'tracker' ? s.bee.view : s.bee)
      ]
      for (const v of views) {
        for await (const node of v.createReadStream({ gte: b4a.from('peer/'), lt: b4a.from('peer/\xff') })) {
          const peer = decodeOp(node.value)
          if (!peer || peer.type !== 'peer' || peer.expiresAt <= now || peer.expiresAt > now + 60 * 60_000 || peer.publicKey === b4a.toString(swarm.keyPair.publicKey, 'hex')) continue
          if (available.size >= 64) break
          available.set(peer.publicKey, b4a.from(peer.publicKey, 'hex'))
        }
      }
      for (const [key, publicKey] of roster) if (!available.has(key)) swarm.leavePeer(publicKey)
      for (const [key, publicKey] of available) if (!roster.has(key)) swarm.joinPeer(publicKey)
      roster.clear()
      for (const [key, publicKey] of available) roster.set(key, publicKey)
    } finally {
      scanningPeers = false
    }
  }
  onPeersChanged = () => { scanPeers().catch(() => {}) }
  let advertisingPeer = false
  let lastPeerAdvertised = 0
  async function advertisePeer (force = false) {
    if (!dht || closing || advertisingPeer || (!force && Date.now() - lastPeerAdvertised < 3 * 60_000)) return
    advertisingPeer = true
    try {
      const peerOp = { type: 'peer', publicKey: b4a.toString(swarm.keyPair.publicKey, 'hex'), expiresAt: Date.now() + 10 * 60_000 }
      if (usePrimaryTracker) await append(peerOp)
      for (const s of extraSources.values()) {
        if (s.kind === 'tracker') {
          await s.bee.append(b4a.from(JSON.stringify(peerOp)), { optimistic: !s.bee.writable }).catch(() => {})
          await s.bee.updated().catch(() => {})
        }
      }
      if (localChannel.core.length > 0) {
        await withChannelLock(async () => {
          const w = localChannel.write()
          w.tryPut(b4a.from('peer/owner'), b4a.from(JSON.stringify(peerOp)))
          await w.flush()
        })
      }
      lastPeerAdvertised = Date.now()
    } finally {
      advertisingPeer = false
    }
  }
  const peerTimer = dht ? setInterval(() => {
    advertisePeer().catch(() => {})
    scanPeers().catch(() => {})
  }, 20_000) : null
  peerTimer?.unref?.()
  undo.push(() => clearInterval(peerTimer))
  if (dht) swarm.listen().then(() => advertisePeer()).catch(() => {})
  onPeersChanged()

  async function setLan (factory) {
    const previous = lan
    lan = null
    await previous?.destroy()
    if (!factory || closing || dht) return
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
    if (closing) {
      await next.destroy()
      return
    }
    for (const discKey of lanTopics.values()) next.join(discKey)
    if (!dht) for (const topics of contentTopics.values()) for (const t of topics) next.join(t)
    lan = next
  }
  // LAN discovery is optional: a node that cannot start it (an address this machine lacks) runs without it.
  await setLan(createLan).catch(err => console.error('LAN discovery did not start: ' + (err?.message || err)))
  undo.push(() => lan?.destroy())

  // Stock hypercore-blob-server on its own store session (its close() closes the store it is given).
  // resolve() opens the video core first, so the core is created with our inflightRange before the server's session.
  const server = new BlobServer(store.session(), {
    host: streamHost,
    port: streamPort,
    token: null,
    resolve: async key => {
      const hex = b4a.toString(key, 'hex')
      joinContentSwarm(hex)
      if (!isOwnedBlob(hex)) await blobCore(hex).catch(() => {})
      return { key }
    }
  })
  undo.push(() => server.close())
  await server.listen()

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

  function ensureBlockCounter (core) {
    let c = blockCounts.get(core)
    if (c) return c
    c = { blocks: 0, slices: new Map(), ready: null }
    blockCounts.set(core, c)
    c.ready = syncBlockCounter(core).catch(() => {})
    core.on('download', () => { c.blocks++; c.slices.clear() })
    core.on('append', () => { syncBlockCounter(core).catch(() => {}) })
    // Fan 8 MiB ahead across libuv workers on upload so stock Hypercore's serial receiverQueue hits RAM instead of spinning-disk latency.
    let warmUpTo = -1
    core.on('upload', (index, byteLen) => {
      if (closing) return
      const lookahead = byteLen > 0 && byteLen <= 131072 ? 128 : 24
      const stride = lookahead >> 1
      if (index < warmUpTo - lookahead || index > warmUpTo) warmUpTo = index
      if (index + (lookahead - stride) < warmUpTo) return
      const start = Math.max(index + 1, warmUpTo + 1)
      const end = Math.min(core.length, index + lookahead)
      if (end <= start) return
      warmUpTo = end - 1
      for (let i = start; i < end; i++) core.get(i, { wait: false }).catch(() => {})
    })
    return c
  }
  for (const s of blobSlots) ensureBlockCounter(s.core)
  async function blobCore (hex) {
    let core = blobCores.get(hex)
    if (!core) {
      const slot = blobSlots.find(s => s.key === hex)
      core = slot ? slot.core : store.get({ key: b4a.from(hex, 'hex'), inflightRange })
      blobCores.set(hex, core)
    }
    if (!core.opened) await core.ready()
    await ensureBlockCounter(core).ready
    return core
  }

  // Bounded head (4 MiB) + tail (1 MiB moov/cues) prefetcher so playback starts immediately.
  const warmRanges = new Map()
  async function warm (entry) {
    if (!entry?.blobs || !entry?.blob) return
    joinContentSwarm(entry.blobs)
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
    if (!core?.opened || blockLength <= 0 || core.length <= blockOffset) return 0
    const c = ensureBlockCounter(core)
    await c.ready
    if (c.blocks === 0) return 0
    const len = Math.min(blockLength, core.length - blockOffset)
    const tag = `${blockOffset}:${len}`
    let blocks = c.slices.get(tag)
    if (blocks === undefined) {
      blocks = await core.count(blockOffset, blockOffset + len)
      if (c.slices.size >= 512) c.slices.clear()
      c.slices.set(tag, blocks)
    }
    if (blocks <= 0) return 0
    return blocks >= blockLength ? entry.size : Math.min(entry.size, Math.round((blocks / blockLength) * entry.size))
  }

  async function readChannelEntries (bee, id, sourceKey) {
    const out = []
    const prefix = id ? `entry/${id}/` : 'entry/'
    for await (const node of bee.createReadStream({ gte: b4a.from(prefix), lt: b4a.from(`${prefix}\xff`) })) {
      const op = decodeOp(node.value)
      if (op?.type === 'announce') out.push({ key: `channel:${sourceKey}/${b4a.toString(node.key).slice(6)}`, entry: op, source: sourceKey, sourceKind: 'channel' })
    }
    return out
  }

  async function search (id = null, { source: filterSource = null } = {}) {
    const raw = []
    const primarySlices = new Set()
    if (usePrimaryTracker && (!filterSource || filterSource === primaryKey)) {
      await tracker.update()
      const range = id ? { gte: b4a.from(`${id}/`), lt: b4a.from(`${id}/\xff`) } : {}
      for await (const node of tracker.view.createReadStream(range)) {
        const key = b4a.toString(node.key)
        if (key.startsWith('peer/') || key.startsWith('source/')) continue
        const op = decodeOp(node.value)
        if (op?.type === 'announce') {
          primarySlices.add(`${op.id}/${op.blobs}:${op.blob.blockOffset}`)
          raw.push({ key, entry: op, source: primaryKey, sourceKind: 'tracker' })
        }
      }
    }
    if (localChannel.core.length > 0 && (!filterSource || filterSource === channelKey)) {
      for (const item of await readChannelEntries(localChannel, id, channelKey)) {
        if (!filterSource && primarySlices.has(`${item.entry.id}/${item.entry.blobs}:${item.entry.blob.blockOffset}`)) continue
        raw.push(item)
      }
    }
    for (const s of extraSources.values()) {
      if (filterSource && filterSource !== s.key) continue
      if (s.kind === 'tracker') {
        await s.bee.update()
        const range = id ? { gte: b4a.from(`${id}/`), lt: b4a.from(`${id}/\xff`) } : {}
        for await (const node of s.bee.view.createReadStream(range)) {
          const sub = b4a.toString(node.key)
          if (sub.startsWith('peer/') || sub.startsWith('source/')) continue
          const op = decodeOp(node.value)
          if (op?.type === 'announce') raw.push({ key: `tracker:${s.key}/${sub}`, entry: op, source: s.key, sourceKind: 'tracker' })
        }
      } else {
        for (const item of await readChannelEntries(s.bee, id, s.key)) {
          if (!filterSource && primarySlices.has(`${item.entry.id}/${item.entry.blobs}:${item.entry.blob.blockOffset}`)) continue
          raw.push(item)
        }
      }
    }
    for (const [key, item] of ephemeralWatches) {
      if ((!id || item.entry.id === id) && (!filterSource || filterSource === 'direct')) raw.push({ key, ...item })
    }
    const candidates = [...new Set(raw.map(r => r.entry.blobs))].filter(h => !ownedBlobs.has(h))
    await Promise.all(candidates.map(async h => {
      if (blobCores.has(h) || slotSet.has(h)) return blobCore(h)
      const exists = await coreStorage.hasCore(hypercoreCrypto.discoveryKey(b4a.from(h, 'hex'))).catch(() => false)
      if (!exists) return null
      return blobCore(h)
    }))
    const results = await Promise.all(raw.map(async ({ key, entry, source, sourceKind }) => {
      const owned = ownedBlobs.get(entry.blobs)
      const core = owned ? null : blobCores.get(entry.blobs)
      const cached = owned ? entry.size : await entryCachedBytes(core, entry)
      if (cached > 0 && !owned) joinContentSwarm(entry.blobs, false)
      return {
        key,
        id: entry.id,
        title: cleanText(entry.title, entry.id),
        size: entry.size,
        sha256: entry.sha256,
        local: Boolean(owned) || (slotSet.has(entry.blobs) && cached >= entry.size),
        cachedBytes: cached,
        streamUrl: streamUrl(entry),
        magnetUrl: formatWatchUri(entry, source, sourceKind),
        source,
        sourceKind
      }
    }))
    // One result per file. Writers that announced a file and were later reset leave copies nobody stores (old shared
    // slots), and they can't be removed: only their writer could. Keep the copy most likely to play: owned, then most
    // cached here, then a per-video core (offset 0), then the tracker founder's own.
    const rank = r => [r.local ? 1 : 0, r.cachedBytes, r.key.endsWith(':0') ? 1 : 0, r.key.split('/')[1] === primaryKey ? 1 : 0]
    const better = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false }
    const files = new Map()
    for (const r of results) {
      const k = `${r.id}/${r.sha256}`
      if (!files.has(k) || better(r, files.get(k))) files.set(k, r)
    }
    return [...files.values()]
  }

  let discoveredCache = null
  let discoveredAtEpoch = 0
  async function discoveredSources () {
    if (discoveredCache && discoveredAtEpoch === viewEpoch) return discoveredCache
    const epochSnap = viewEpoch
    const active = new Set(listSources().map(s => s.key))
    const found = new Map()
    const scan = async (view, via) => {
      for await (const node of view.createReadStream({ gte: b4a.from('source/'), lt: b4a.from('source/\xff') })) {
        const op = decodeOp(node.value)
        if (op?.type === 'source' && !active.has(op.sourceKey) && !found.has(op.sourceKey)) {
          found.set(op.sourceKey, { key: op.sourceKey, kind: op.kind, title: cleanText(op.title, op.sourceKey.slice(0, 12)), via })
        }
      }
    }
    if (usePrimaryTracker) { await tracker.update(); await scan(tracker.view, primaryKey) }
    if (localChannel.core.length > 0) await scan(localChannel, channelKey)
    for (const s of extraSources.values()) {
      if (s.kind === 'tracker') await s.bee.update()
      await scan(s.kind === 'tracker' ? s.bee.view : s.bee, s.key)
    }
    const list = [...found.values()]
    discoveredCache = list
    discoveredAtEpoch = epochSnap
    return list
  }

  async function findEntry (key) {
    if (ephemeralWatches.has(key)) return ephemeralWatches.get(key).entry
    if (key.startsWith(`channel:${channelKey}/`)) {
      const n = await localChannel.get(b4a.from(`entry/${key.slice(channelKey.length + 9)}`))
      return n ? decodeOp(n.value) : null
    }
    const chMatch = key.match(/^channel:([0-9a-f]{64})\/(.+)$/)
    if (chMatch) {
      const src = extraSources.get(chMatch[1])
      const n = src?.kind === 'channel' ? await src.bee.get(b4a.from(`entry/${chMatch[2]}`)) : null
      return n ? decodeOp(n.value) : null
    }
    const trMatch = key.match(/^tracker:([0-9a-f]{64})\/(.+)$/)
    if (trMatch) {
      const src = extraSources.get(trMatch[1])
      if (src?.kind !== 'tracker') return null
      await src.bee.update()
      const n = await src.bee.view.get(b4a.from(trMatch[2]))
      return n ? decodeOp(n.value) : null
    }
    await tracker.update()
    const n = await tracker.view.get(b4a.from(key))
    return n ? decodeOp(n.value) : null
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
  function gcStorage ({ full = false, streaming = false } = {}) {
    const run = async () => {
      if (closing || coreStorage.closed) return { beforeBytes: 0, afterBytes: 0, reclaimedBytes: 0 }
      const beforeBytes = dbDiskBytes()
      await coreStorage.flush().catch(() => {})
      if (!closing && !coreStorage.closed) {
        const hasLocalBlobs = ownedBlobs.size > 0 || blobSlots.some(s => localBlocks(s.core) > 0)
        // A playing receiver must never request exclusive compaction; readers keep their lane open.
        await coreStorage.compact(full && !hasLocalBlobs && !streaming
          ? { exclusive: true, blobGarbageCollectionPolicy: 1, blobGarbageCollectionAgeCutoff: 1.0, bottommostLevelCompaction: 2 }
          : { exclusive: false, blobGarbageCollectionPolicy: streaming ? 1 : 0, blobGarbageCollectionAgeCutoff: 1.0, bottommostLevelCompaction: streaming ? 0 : 1 }
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
    if (usePrimaryTracker) {
      await tracker.update()
      for await (const n of tracker.view.createReadStream()) {
        const k = b4a.toString(n.key)
        if (k.startsWith('peer/') || k.startsWith('source/')) continue
        if (matchOp(decodeOp(n.value))) return true
      }
    }
    if (localChannel.core.length > 0) {
      for await (const n of localChannel.createReadStream({ gte: b4a.from('entry/'), lt: b4a.from('entry/\xff') })) {
        if (matchOp(decodeOp(n.value))) return true
      }
    }
    for (const item of ephemeralWatches.values()) {
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
      leaveContentSwarm(entry.blobs)
      ownedBlobs.delete(entry.blobs)
      const openSession = blobCores.get(entry.blobs)
      blobCores.delete(entry.blobs)
      if (openSession) await openSession.close().catch(() => {})
      const victim = store.get({ key: b4a.from(entry.blobs, 'hex') })
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
  // `playheadByte` is the player's position within the blob; the caller (the TV receiver) knows it.
  async function evictBehind (blobsHex, blob, { playheadByte = 0, keepBehindBytes = 64 * 1024 * 1024 } = {}) {
    const core = blobCores.get(blobsHex)
    if (!core?.opened || !blob || blob.blockLength <= 16 || isOwnedBlob(blobsHex) || core.writable) return 0
    const bs = Math.max(65536, Math.round((blob.byteLength || BLOB_BLOCK_SIZE) / blob.blockLength))
    const playhead = blob.blockOffset + Math.floor(Math.max(0, playheadByte) / bs)
    const keepBlocks = Math.max(16, Math.ceil(keepBehindBytes / bs))
    const headGuard = blob.blockOffset + Math.max(8, Math.ceil((4 * 1024 * 1024) / bs))
    const tailGuard = blob.blockOffset + blob.blockLength - Math.max(4, Math.ceil((2 * 1024 * 1024) / bs))
    const clearTo = Math.min(tailGuard, core.length, playhead - keepBlocks)
    if (clearTo <= headGuard) return 0
    // A single movie-sized clear gags the playback session mutex; clear the first cached 32 MiB stretch per pass.
    const maxBlocks = Math.max(1, Math.floor((32 * 1024 * 1024) / bs))
    for (let start = headGuard; start < clearTo; start += maxBlocks) {
      const end = Math.min(clearTo, start + maxBlocks)
      if (await core.count(start, end) === 0) continue
      await core.clear(start, end)
      await syncBlockCounter(core)
      return (await gcStorage({ streaming: true })).reclaimedBytes
    }
    return 0
  }

  async function clearCache (key = null, { keepBlobsHex = null } = {}) {
    if (key) {
      const entry = await findEntry(key)
      if (!entry || isOwnedBlob(entry.blobs)) return { clearedBytes: 0, reclaimedBytes: 0 }
      const tag = `${entry.blobs}:${entry.blob.blockOffset}`
      if (warmRanges.has(tag)) {
        for (const r of warmRanges.get(tag)) r.destroy()
        warmRanges.delete(tag)
      }
      const core = await blobCore(entry.blobs)
      const clearedBytes = await entryCachedBytes(core, entry)
      let reclaimedBytes = 0
      if (clearedBytes > 0 && entry.blob.blockLength > 0 && core.length > entry.blob.blockOffset) {
        await core.clear(entry.blob.blockOffset, Math.min(core.length, entry.blob.blockOffset + entry.blob.blockLength))
        await syncBlockCounter(core)
        reclaimedBytes = (await gcStorage({ full: false })).reclaimedBytes
        update()
      }
      return { clearedBytes, reclaimedBytes }
    }
    for (const [tag, ranges] of warmRanges) {
      if (keepBlobsHex && tag.startsWith(`${keepBlobsHex}:`)) continue
      for (const r of ranges) r.destroy()
      warmRanges.delete(tag)
    }
    await search('').catch(() => {})
    let clearedBytes = 0
    for (const [hex, core] of blobCores) {
      if (hex === keepBlobsHex || isOwnedBlob(hex) || core.writable || !core.opened || core.length === 0) continue
      await ensureBlockCounter(core).ready
      const blocks = localBlocks(core)
      if (blocks > 0) {
        clearedBytes += Math.min(core.byteLength, Math.round((blocks / core.length) * core.byteLength))
        await clearDownloadedSpans(core)
        await syncBlockCounter(core)
      }
    }
    const { reclaimedBytes } = await gcStorage({ full: true })
    update()
    return { clearedBytes, reclaimedBytes }
  }

  // Mints a dedicated 512 KiB-piece Hypercore per video (`blockOffset: 0`) and closes the write session at rest so Corestore wakes it lazily on demand.
  // The write session is inactive: an owned core never downloads, so peers see it as an uploader from the first
  // block. Otherwise it reports "downloading" for Hypercore's 20-40 s linger after the write, and a peer whose
  // channel closes when Corestore collects the at-rest core does not reopen it.
  async function put ({ id, title, expectedSize = null }, source, onData = null) {
    if (!str(id, ID)) throw new Error(`Invalid id ${id}`)
    const core = store.get({ name: `video:${b4a.toString(hypercoreCrypto.randomBytes(16), 'hex')}`, active: false })
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
      ownedBlobs.set(keyHex, { length: core.length, byteLength: core.byteLength })
      await core.close()
      joinContentSwarm(keyHex)
      return { type: 'announce', id, title: cleanText(title, id), size, sha256: hash.digest('hex'), blobs: keyHex, blob }
    } catch (err) {
      await core.ready().then(() => core.purge()).catch(() => core.close().catch(() => {}))
      throw err
    }
  }

  async function publish (meta, source) {
    const op = await put(meta, source)
    await append(op)
    return { ...op, streamUrl: streamUrl(op), magnetUrl: formatWatchUri(op, primaryKey, 'tracker') }
  }

  // Writes an announce op (either freshly streamed or re-curated) into this node's single-writer Hyperbee channel.
  async function publishChannel (metaOrOp, source = null) {
    const op = source ? await put(metaOrOp, source) : decodeOp(JSON.stringify({ ...metaOrOp, type: 'announce' }))
    if (!op || op.type !== 'announce') throw new Error('Invalid channel announce payload')
    const subKey = `${op.id}/${op.blobs}:${op.blob.blockOffset}`
    await withChannelLock(async () => {
      const w = localChannel.write()
      w.tryPut(b4a.from(`entry/${subKey}`), b4a.from(JSON.stringify(op)))
      await w.flush()
    })
    joinOverlayTopic(`channel:${channelKey}`, localChannel.core.key, localChannel.core.discoveryKey)
    joinContentSwarm(op.blobs)
    update()
    return {
      ...op,
      key: `channel:${channelKey}/${subKey}`,
      channel: channelKey,
      streamUrl: streamUrl(op),
      magnetUrl: formatWatchUri(op, channelKey, 'channel')
    }
  }

  async function removeChannel (key) {
    const prefix = `channel:${channelKey}/`
    const fullKey = key.startsWith(prefix) ? key : `${prefix}${key.replace(/^entry\//, '')}`
    const prev = key.startsWith('source/') ? null : await findEntry(fullKey).catch(() => null)
    const sub = key.startsWith(prefix) ? `entry/${key.slice(prefix.length)}` : key.startsWith('source/') ? key : `entry/${key}`
    await withChannelLock(async () => {
      const w = localChannel.write()
      w.tryDelete(b4a.from(sub))
      await w.flush()
    })
    await gcUnreferencedSlotBlob(prev).catch(() => {})
    update()
  }

  // Publishes a gossip/directory recommendation for another channel or tracker.
  async function publishSource ({ sourceKey, kind = 'channel', title }, { target = 'channel' } = {}) {
    const op = decodeOp(JSON.stringify({ type: 'source', sourceKey: String(sourceKey || '').toLowerCase(), kind, title: cleanText(title, String(sourceKey).slice(0, 12)) }))
    if (!op) throw new Error('Invalid source directory record')
    if (target === 'channel' || target === 'both') {
      await withChannelLock(async () => {
        const w = localChannel.write()
        w.tryPut(b4a.from(`source/${op.sourceKey}`), b4a.from(JSON.stringify(op)))
        await w.flush()
      })
      joinOverlayTopic(`channel:${channelKey}`, localChannel.core.key, localChannel.core.discoveryKey)
    }
    if ((target === 'tracker' || target === 'both') && usePrimaryTracker) {
      await append(op)
    }
    update()
    return op
  }

  async function unpublishSource (sourceKey) {
    const k = String(sourceKey || '').trim().toLowerCase()
    if (!HEX64.test(k)) throw new Error('Invalid source key')
    if (localChannel.core.length > 0) {
      await withChannelLock(async () => {
        const w = localChannel.write()
        w.tryDelete(b4a.from(`source/${k}`))
        await w.flush()
      })
    }
    if (usePrimaryTracker) {
      const writer = b4a.toString(tracker.local.key, 'hex')
      const trKey = `source/${writer}/${k}`
      await tracker.update()
      if (await tracker.view.get(b4a.from(trKey))) await append({ type: 'remove', key: trKey })
    }
    update()
    return { unpublished: true, key: k }
  }

  async function publishedSources () {
    const out = new Map()
    if (localChannel.core.length > 0) {
      for await (const node of localChannel.createReadStream({ gte: b4a.from('source/'), lt: b4a.from('source/\xff') })) {
        const op = decodeOp(node.value)
        if (op?.type === 'source') out.set(op.sourceKey, { key: op.sourceKey, kind: op.kind, title: cleanText(op.title, op.sourceKey.slice(0, 12)) })
      }
    }
    if (usePrimaryTracker) {
      await tracker.update()
      const writer = b4a.toString(tracker.local.key, 'hex')
      const pfx = `source/${writer}/`
      for await (const node of tracker.view.createReadStream({ gte: b4a.from(pfx), lt: b4a.from(`${pfx}\xff`) })) {
        const op = decodeOp(node.value)
        if (op?.type === 'source' && !out.has(op.sourceKey)) out.set(op.sourceKey, { key: op.sourceKey, kind: op.kind, title: cleanText(op.title, op.sourceKey.slice(0, 12)) })
      }
    }
    return [...out.values()]
  }

  async function openUri (uri, { joinSource = true } = {}) {
    const parsed = parseUri(uri, 'channel')
    if (parsed.action === 'source') return { action: 'source', source: await addSource(parsed) }
    if (joinSource && parsed.sourceKey) await addSource({ key: parsed.sourceKey, kind: parsed.sourceKind }).catch(() => {})
    else if (parsed.sourceKey && !dht) {
      const sk = b4a.from(parsed.sourceKey, 'hex')
      joinOverlayTopic(`source-swarm:${parsed.sourceKey}`, sk, hypercoreCrypto.discoveryKey(sk))
    }
    const { entry } = parsed
    const key = `watch/${entry.blobs}:${entry.blob.blockOffset}`
    ephemeralWatches.set(key, { entry, source: parsed.sourceKey || 'direct', sourceKind: 'watch' })
    await warm(entry)
    update()
    return {
      action: 'watch',
      entry: {
        key,
        id: entry.id,
        title: entry.title,
        size: entry.size,
        sha256: entry.sha256,
        local: isOwnedBlob(entry.blobs),
        cachedBytes: entryCachedBytes(blobCores.get(entry.blobs), entry),
        streamUrl: streamUrl(entry),
        magnetUrl: formatWatchUri(entry, parsed.sourceKey || '', parsed.sourceKind),
        source: parsed.sourceKey || 'direct',
        sourceKind: 'watch'
      }
    }
  }

  // Backfills all locally stored tracker entries into this node's single-writer channel with zero blob copies.
  async function syncLocalChannel () {
    if (!usePrimaryTracker) return { backfilled: 0, total: 0 }
    return withChannelLock(async () => {
      await tracker.update()
      const writer = b4a.toString(tracker.local.key, 'hex')
      const existing = new Set()
      if (localChannel.core.length > 0) {
        for await (const n of localChannel.createReadStream({ gte: b4a.from('entry/'), lt: b4a.from('entry/\xff') })) {
          existing.add(b4a.toString(n.key))
        }
      }
      let backfilled = 0
      const w = localChannel.write()
      for await (const n of tracker.view.createReadStream()) {
        const key = b4a.toString(n.key)
        if (key.startsWith('peer/') || key.startsWith('source/')) continue
        const op = decodeOp(n.value)
        if (!op || op.type !== 'announce') continue
        if (key.split('/')[1] !== writer && !isOwnedBlob(op.blobs)) continue
        const chKey = `entry/${op.id}/${op.blobs}:${op.blob.blockOffset}`
        if (!existing.has(chKey)) {
          w.tryPut(b4a.from(chKey), b4a.from(JSON.stringify(op)))
          joinContentSwarm(op.blobs)
          backfilled++
        }
      }
      if (backfilled > 0) {
        await w.flush()
        joinOverlayTopic(`channel:${channelKey}`, localChannel.core.key, localChannel.core.discoveryKey)
        update()
      }
      return { backfilled, total: existing.size + backfilled }
    })
  }

  // Splits legacy variable-block AND multi-entry shared `blobSlots` spans into dedicated 512 KiB-piece per-video Hypercores,
  // deduplicates identical `sha256:size` files, SHA-256-verifies every byte before swapping catalog pointers, and clears old slot spans.
  async function rechunkLegacyBlobs ({ id = null, foreground = false, onMigrate = null, onProgress = null, limit = Infinity } = {}) {
    const writer = b4a.toString(tracker.local.key, 'hex')
    const uniformByHash = new Map()
    const legacyGroups = new Map()
    const slotMap = new Map(blobSlots.map(s => [s.key, s]))
    const hasAllBlocks = async (slot, blob) => {
      if (!slot || blob.blockLength <= 0) return blob.byteLength === 0
      const end = blob.blockOffset + blob.blockLength
      if (slot.core.length < end) return false
      return slot.core.has(blob.blockOffset, end)
    }
    const addRef = async (op, kind, fullKey) => {
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
        g = { oldTag, blobs: op.blobs, blob: op.blob, sha256: op.sha256, size: op.size, trackerOps: [], channelOps: [] }
        legacyGroups.set(oldTag, g)
      }
      if (kind === 'tracker') g.trackerOps.push({ fullKey, op })
      else g.channelOps.push({ fullKey, op })
    }

    if (usePrimaryTracker) {
      await tracker.update()
      for await (const n of tracker.view.createReadStream()) {
        const key = b4a.toString(n.key)
        if (key.startsWith('peer/') || key.startsWith('source/')) continue
        const op = decodeOp(n.value)
        if (op?.type === 'announce' && key.split('/')[1] === writer) await addRef(op, 'tracker', key)
      }
    }
    if (localChannel.core.length > 0) {
      for await (const n of localChannel.createReadStream({ gte: b4a.from('entry/'), lt: b4a.from('entry/\xff') })) {
        const subKey = b4a.toString(n.key)
        const op = decodeOp(n.value)
        if (op?.type === 'announce') await addRef(op, 'channel', subKey)
      }
    }

    const allGroups = [...legacyGroups.values()]
    const filtered = id ? allGroups.filter(g => g.trackerOps.some(t => t.op.id === id) || g.channelOps.some(c => c.op.id === id)) : allGroups
    const queue = filtered.sort((a, b) => a.size - b.size)
    let migrated = 0, deduped = 0, migratedBytes = 0
    onProgress?.({ total: queue.length, migrated, deduped, remaining: queue.length, migratedBytes, currentId: null, currentTitle: null })

    for (const g of queue) {
      if (closing || migrated >= limit) break
      const sample = g.trackerOps[0]?.op || g.channelOps[0]?.op
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
            if (closing) return cb(new Error('Node closing'))
            if (idx >= endIdx) { this.push(null); return cb(null) }
            const pump = () => {
              if (closing) return cb(new Error('Node closing'))
              status()
              // Background migration yields while this node is moving data for peers or viewers.
              if (!foreground && (downBps > 65536 || upBps > 65536)) { setTimeout(pump, 1500).unref?.(); return }
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
          ownedBlobs.delete(newOp.blobs)
          leaveContentSwarm(newOp.blobs)
          const bad = store.get({ key: b4a.from(newOp.blobs, 'hex') })
          await bad.ready().then(() => bad.purge()).catch(() => bad.close().catch(() => {}))
          throw new Error(`SHA-256 mismatch rechunking ${sample.id}: expected ${g.sha256}, got ${newOp.sha256}`)
        }
        target = { blobs: newOp.blobs, blob: newOp.blob }
        uniformByHash.set(`${g.sha256}:${g.size}`, target)
      }

      await onMigrate?.(g.oldTag, target, sample)
      for (const { op } of g.trackerOps) {
        await append({ ...op, blobs: target.blobs, blob: target.blob })
      }
      for (const { op } of g.channelOps) {
        await publishChannel({ ...op, blobs: target.blobs, blob: target.blob })
      }
      if (g.channelOps.length > 0) {
        await withChannelLock(async () => {
          const w = localChannel.write()
          for (const { fullKey } of g.channelOps) w.tryDelete(b4a.from(fullKey))
          await w.flush()
        })
      }
      for (const { fullKey } of g.trackerOps) {
        await append({ type: 'remove', key: fullKey })
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

    if (migrated > 0) update()
    return { total: queue.length, migrated, deduped, remaining: Math.max(0, queue.length - migrated), migratedBytes }
  }

  async function remove (key) {
    if (key.startsWith(`channel:${channelKey}/`)) return removeChannel(key)
    const prev = await findEntry(key).catch(() => null)
    const parts = key.split('/')
    if (parts.length === 3 && parts[1] === b4a.toString(tracker.local.key, 'hex') && localChannel.core.length > 0) {
      await removeChannel(`${parts[0]}/${parts[2]}`).catch(() => {})
    }
    await append({ type: 'remove', key })
    await gcUnreferencedSlotBlob(prev).catch(() => {})
  }

  async function append (op) {
    const before = tracker.local.length
    await tracker.append(b4a.from(JSON.stringify(op)), { optimistic: !tracker.writable })
    await tracker.updated()
    while (tracker.local.length <= before) {
      if (closing) throw new Error('Node closed before the write was durable')
      await new Promise(resolve => setTimeout(resolve, 500))
      await tracker.update()
    }
  }

  function setAllowedPeers (keys) {
    allowedSet = Array.isArray(keys) && keys.length ? new Set(keys.map(k => String(k).toLowerCase())) : null
  }

  // Tit-for-tat reciprocity: seeders holding cached/published blocks earn wider inflight windows than empty leechers.
  function applyReciprocity (seededBytes, txBytes, rxBytes, contributingPeers) {
    const tier = seededBytes > 0 && (txBytes > 0 || ownedBlobs.size > 0 || blobSlots.some(s => s.core.byteLength > 0) || seededBytes >= BLOB_BLOCK_SIZE)
      ? 'seeder'
      : (seededBytes > 0 || contributingPeers > 0 ? 'peer' : 'leecher')
    // Mobile/TV BareKit worklets share Android's 256 KiB rmem_max UDP socket; never let background cores blast [16,48] retransmits over Wi-Fi.
    // Measured 2026-10-29: widening this to [24,64] made a 5 GHz phone worse (erratic 0.9–15.9 MB/s,
    // decoded fps 15.7 → 11.5). Keep the small window until the socket buffers are tuned with evidence.
    const next = dht
      ? (tier === 'seeder' ? [64, 192] : tier === 'peer' ? [48, 128] : [24, 64])
      : isWorklet
        ? [6, 8]
        : (tier === 'seeder' ? [16, 48] : tier === 'peer' ? [12, 32] : [8, 24])
    inflightRange = next
    const ratio = rxBytes > 0 ? Math.round((txBytes / rxBytes) * 100) / 100 : (txBytes > 0 ? 1 : 0)
    return { tier, seededBytes, contributingPeers, ratio, inflightMax: next[1] }
  }

  function status () {
    let rttSum = 0, rttCount = 0, retransmits = 0, contributingPeers = 0
    const now = Date.now(), dt = now - prevAt
    function measure (path, connections) {
      let rxBytes = path.closedRx, txBytes = path.closedTx
      if (connections) for (const c of connections) {
        const crx = c.rawBytesRead || c.rawStream?.bytesReceived || 0
        const ctx = c.rawBytesWritten || c.rawStream?.bytesTransmitted || 0
        if (crx > 0) contributingPeers++
        rxBytes += crx
        txBytes += ctx
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
    let inflightBlocks = 0, cachedBytes = 0
    for (const [k, c] of blobCores) {
      // Display only: Hypercore has no public in-flight count, so read it off the documented `core.peers`.
      for (const p of c.peers) inflightBlocks += p.inflight || 0
      if (!isOwnedBlob(k) && c.opened && c.length > 0 && c.byteLength > 0) {
        ensureBlockCounter(c)
        const blocks = localBlocks(c)
        if (blocks > 0) {
          cachedBytes += Math.min(coreByteLen(c), Math.round((blocks / c.length) * coreByteLen(c)))
        }
      }
    }
    let ownedVideoBytes = 0
    for (const v of ownedBlobs.values()) ownedVideoBytes += v.byteLength
    const blobBytes = ownedVideoBytes + blobSlots.reduce((sum, s) => {
      if (s.core.length === 0 || s.core.byteLength === 0) return sum
      ensureBlockCounter(s.core)
      const blocks = localBlocks(s.core)
      if (blocks <= 0) return sum
      return sum + (blocks >= s.core.length ? s.core.byteLength : Math.round((blocks / s.core.length) * s.core.byteLength))
    }, 0)
    const reciprocity = applyReciprocity(blobBytes + cachedBytes, txBytes, rxBytes, contributingPeers)
    return {
      // No primary tracker means the node follows channels only; never report a channel as a tracker.
      tracker: usePrimaryTracker ? primaryKey : '',
      channel: channelKey,
      writer: b4a.toString(tracker.local.key, 'hex'),
      blobs: blobsKey,
      blobBytes,
      cachedBytes,
      peers: swarm.connections.size,
      lanPeers: lanPeers.size,
      downBps,
      upBps,
      rxBytes,
      txBytes,
      routes,
      inflightBlocks,
      rtt: rttCount ? Math.round(rttSum / rttCount) : 0,
      retransmits,
      sources: listSources(),
      reciprocity
    }
  }

  function coreByteLen (c) { return c.byteLength || 0 }
  // Lays bare every non-empty local channel and blob core ready for supplemental HiveRelay seeders to suck dry.
  function seedableCores ({ includeCached = false } = {}) {
    const out = []
    if (localChannel.core.length > 0) {
      out.push({ key: channelKey, kind: 'channel', length: localChannel.core.length, byteLength: localChannel.core.byteLength })
    }
    for (const [key, v] of ownedBlobs) {
      if (v.length > 0) out.push({ key, kind: 'blobs', length: v.length, byteLength: v.byteLength })
    }
    for (const s of blobSlots) {
      if (s.core.length > 0 && localBlocks(s.core) > 0) {
        out.push({ key: s.key, kind: 'blobs', length: s.core.length, byteLength: s.core.byteLength })
      }
    }
    if (includeCached) {
      for (const [k, c] of blobCores) {
        if (isOwnedBlob(k) || !c.opened || c.length === 0 || c.byteLength === 0) continue
        ensureBlockCounter(c)
        if (localBlocks(c) >= c.length) out.push({ key: k, kind: 'blobs', length: c.length, byteLength: c.byteLength })
      }
    }
    return out
  }


  let closingPromise = null
  function close () {
    if (closingPromise) return closingPromise
    closing = true
    closingPromise = (async () => {
      clearInterval(peerTimer)
      clearInterval(refreshTimer)
      clearInterval(rotateTimer)
      for (const ranges of warmRanges.values()) for (const r of ranges) r.destroy()
      warmRanges.clear()
      await lan?.destroy()
      // The private overlay's clear() withdraws its rendezvous routes so readers stop dialing a dead peer.
      // Hyperswarm's would only unannounce each topic; force skips that on the way out.
      if (dht) await swarm.clear()
      await swarm.destroy({ force: true })
      for (const s of extraSources.values()) { s.dl?.destroy(); await s.bee.close().catch(() => {}) }
      extraSources.clear()
      await localChannel.close().catch(() => {})
      await tracker.close()
      wakeup.destroy()
      await server.close()
      await store.close()
    })()
    return closingPromise
  }

  return {
    store,
    findEntry,
    blobCore,
    seedableCores,
    privateRouting: Boolean(dht),
    bootstrap: bootstrap || null,
    relayThrough: relayThrough || null,
    hasLan: () => Boolean(lan),
    hasLanPeer,
    lanEndpoint: () => lan?.port && lan?.host ? { host: lan.host, port: lan.port, publicKey: b4a.toString(swarm.keyPair.publicKey, 'hex') } : null,
    dialLanPeer: ep => { if (ep?.publicKey && ep?.host && ep?.port) lan?.dialDirect?.(ep.publicKey, ep.host, ep.port) },
    evictBehind,
    refreshBlockCount: core => syncBlockCounter(core),
    joinSourceSwarm: keyHex => {
      if (dht || closing || !str(keyHex, HEX64)) return
      const sk = b4a.from(keyHex, 'hex')
      joinOverlayTopic(`source-swarm:${keyHex}`, sk, hypercoreCrypto.discoveryKey(sk))
    },
    tracker,
    localChannel,
    swarm,
    peerConnections: () => peerConns,
    onConnection: fn => { connListeners.add(fn); return () => connListeners.delete(fn) },
    search,
    put,
    append,
    publish,
    publishChannel,
    remove,
    removeChannel,
    publishSource,
    syncLocalChannel,
    rechunkLegacyBlobs,
    unpublishSource,
    publishedSources,
    addSource,
    removeSource,
    listSources,
    discoveredSources,
    openUri,
    warm,
    setAllowedPeers,
    clearCache,
    gcStorage,
    status,
    streamUrl,
    blobServer: server,
    setLan,
    lanStats: () => (lan ? lan.stats() : null),
    close,
    get closing () { return closing }
  }
}
