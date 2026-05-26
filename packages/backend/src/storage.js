/**
 * Storage Module - Shared storage initialization and channel management
 *
 * Handles Corestore, Hyperbee, Hyperblobs, and BlobServer setup.
 */

import Corestore from 'corestore';
import Hyperbee from 'hyperbee';
import BlobServer from 'hypercore-blob-server';
import b4a from 'b4a';
import crypto from 'hypercore-crypto';
import { MultiWriterChannel, ChannelPairer } from './channel/index.js'
import { PublicChannelBee } from './channel/public-channel-bee.js'
import { loadPublicBeeFromCache } from './public-bee-loader.js'
import { logger } from './logger.js'
import { relocateLegacyBlindPeerDir, relocateLegacyLogsDir } from './storage-layout.js'
import { cleanupFailedCorestoreOpen } from './corestore-cleanup.js'
import {
  loadBareOrNodeFsModule,
  loadBareOrNodeHttpModule,
  loadBareOrNodePathModule,
  loadHyperswarmModule,
  resolveBareOrNodeFsModuleSync,
  resolveBareOrNodePathModuleSync,
} from './runtime-modules.js'
import { NETWORK_TOPIC_STRING } from './types.js'
import { normalizeBlobRefInput } from './blob-ref.js'
import { createKnownPeerCache, loadKnownPeers, dialKnownPeers } from './known-peers.js'

function resolveDebugLogPath() {
  return globalThis?.process?.env?.PEARTUBE_NATIVE_WORKLET_DEBUG_LOG || null
}

function isEmbeddedBareKitStoragePath() {
  return globalThis?.process?.env?.PEARTUBE_NATIVE_EMBEDDED_BAREKIT === '1'
}

function describeDebugError(error) {
  if (!error) return 'unknown'
  if (typeof error === 'string') return error
  if (typeof error === 'number') return `number:${error}`

  const details = {
    type: typeof error,
    constructor: error?.constructor?.name ?? null,
    code: error?.code ?? null,
    errno: error?.errno ?? null,
    message: error?.message ?? null
  }

  if (error?.stack) details.stack = error.stack

  try {
    const extra = {}
    for (const key of Object.getOwnPropertyNames(error)) {
      if (key in details || key === 'stack') continue
      extra[key] = error[key]
    }
    if (Object.keys(extra).length > 0) details.extra = extra
  } catch { /* best effort */ }

  try {
    return JSON.stringify(details)
  } catch {
    return String(error)
  }
}

async function appendDebugLine(line) {
  const filePath = resolveDebugLogPath()
  if (!filePath) return

  try {
    const fsModule = await import('bare-fs')
    const fs = fsModule?.default ?? fsModule
    if (typeof fs?.appendFileSync !== 'function') return
    fs.appendFileSync(filePath, `${new Date().toISOString()} ${line}\n`)
  } catch { /* best effort */ }
}

const log = logger('Storage')

// Network stats for debugging connection issues
let HyperswarmStats = null
let optionalStorageDepsReady = null
let hyperswarmModuleReady = null

// Global network stats instance (set after swarm is created)
let networkStats = null;

function createNetworkStartupTiming() {
  const startedAt = Date.now()
  const events = []
  const seen = new Set()
  const record = (name, details = {}) => {
    const at = Date.now()
    const event = {
      name,
      at,
      sinceStartMs: Math.max(0, at - startedAt),
      ...details
    }
    events.push(event)
    while (events.length > 80) events.shift()
    seen.add(name)
    void appendDebugLine(`[startup-timing] ${name} t=${event.sinceStartMs}ms ${JSON.stringify(details)}`)
    return event
  }
  record('storage-entry')
  return {
    startedAt,
    record,
    markOnce(name, details = {}) {
      if (seen.has(name)) return null
      return record(name, details)
    },
    snapshot() {
      return {
        startedAt,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        events: events.slice(-40)
      }
    }
  }
}

// Global references for suspend/resume (set in initializeStorage)
let globalSwarm = null;
let globalBlobServer = null;
let globalChannels = null;
let globalPeerPoolDiscovery = null;
let globalPeerPoolTopicHex = null;
let globalSwarmDiagnostics = null;
let globalNetworkStartupTiming = null;
let globalKnownPeerCache = null;
let globalMetaDb = null;

// Cast active flag — set by API handlers to prevent network suspension during active cast
let globalCastActive = false
let watchdogTimer = null

/**
 * Generate a random session token for blob server URL auth.
 * This token is included in blob URLs and verified by the server.
 * @returns {string} 32-char hex token
 */
function generateSessionToken() {
  const tokenBytes = crypto.randomBytes(16)
  return b4a.toString(tokenBytes, 'hex')
}

function peerKeyHex(value) {
  if (!value) return null
  if (typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase()
  if (b4a.isBuffer(value) || value instanceof Uint8Array) {
    if (value.length !== 32) return null
    return b4a.toString(value, 'hex')
  }
  const publicKey = value?.publicKey || value?.remotePublicKey || value?.key || value?.value?.publicKey || value?.value?.remotePublicKey || value?.value?.key
  if (typeof publicKey === 'string' && /^[a-f0-9]{64}$/i.test(publicKey)) return publicKey.toLowerCase()
  if (publicKey && (b4a.isBuffer(publicKey) || publicKey instanceof Uint8Array)) {
    if (publicKey.length !== 32) return null
    return b4a.toString(publicKey, 'hex')
  }
  return null
}

async function dialPersistedPeers(swarm, metaDb, { reason = 'startup' } = {}) {
  if (!swarm || typeof swarm.joinPeer !== 'function' || swarm._peartubeOffline) {
    return { knownDialed: 0, relayDialed: 0, totalDialed: 0 }
  }

  let knownDialed = 0
  let relayDialed = 0
  const dialed = new Set()

  try {
    const known = await loadKnownPeers(metaDb)
    for (const entry of known) {
      const keyHex = typeof entry?.key === 'string' ? entry.key.toLowerCase() : null
      if (!keyHex || dialed.has(keyHex)) continue
      try {
        const pk = b4a.from(keyHex, 'hex')
        if (pk.length !== 32) continue
        swarm.joinPeer(pk)
        knownDialed++
        dialed.add(keyHex)
      } catch { /* best effort */ }
    }
  } catch (err) {
    console.log('[Storage] Persisted known-peer dial skipped:', err?.message)
  }

  try {
    const swarmPeers = swarm?.peers
    if (swarmPeers && typeof swarmPeers[Symbol.iterator] === 'function') {
      for (const [key, peerInfo] of swarmPeers) {
        const keyHex = peerKeyHex(peerInfo?.publicKey || peerInfo?.remotePublicKey || key)
        if (!keyHex || dialed.has(keyHex)) continue
        const relayAddresses = Array.isArray(peerInfo?.relayAddresses) ? peerInfo.relayAddresses : []
        const shouldDial = relayAddresses.length > 0 || Boolean(peerInfo?.explicit || peerInfo?.queued || peerInfo?.waiting || peerInfo?.proven || peerInfo?.client)
        if (!shouldDial) continue
        try {
          const pk = b4a.from(keyHex, 'hex')
          if (pk.length !== 32) continue
          swarm.joinPeer(pk)
          relayDialed++
          dialed.add(keyHex)
        } catch { /* best effort */ }
      }
    }
  } catch (err) {
    console.log('[Storage] Persisted relay-peer dial skipped:', err?.message)
  }

  if (knownDialed + relayDialed > 0) {
    console.log('[Storage] Explicitly dialed persisted peers:', { reason, knownDialed, relayDialed })
  }

  return { knownDialed, relayDialed, totalDialed: knownDialed + relayDialed }
}

// Wakeup for fast content announcements to peers
let Wakeup = null

let fs = null;
let path = null;
let Hyperswarm = null;
let http = null;

function createNoopDiscoveryHandle() {
  return {
    flushed: async () => {},
    destroy() {},
    close() {}
  }
}

function shortKeyHex(value) {
  try {
    if (!value) return 'unknown'
    if (typeof value === 'string') return value.slice(0, 16)
    return b4a.toString(value, 'hex').slice(0, 16)
  } catch {
    return 'unknown'
  }
}

function describeRelayAddresses(relayAddresses) {
  if (!Array.isArray(relayAddresses)) return []
  return relayAddresses.slice(0, 4).map((address) => {
    try {
      if (typeof address === 'string') return address
      if (address?.host && address?.port) return `${address.host}:${address.port}`
      if (address?.publicKey) return `relay:${shortKeyHex(address.publicKey)}`
      return String(address)
    } catch {
      return 'unreadable'
    }
  })
}

function describeStreamError(stream) {
  try {
    const err = stream?.errored || stream?._error || stream?.error || null
    if (!err) return null
    return {
      name: err.name || null,
      code: err.code || null,
      message: err.message || String(err)
    }
  } catch {
    return { message: 'unreadable' }
  }
}

function describeSocketAddress(socket) {
  try {
    const address = socket?.address?.()
    if (!address) return null
    return {
      host: address.host || address.address || null,
      port: Number(address.port || 0) || null,
      family: address.family || null
    }
  } catch {
    return null
  }
}

function describeAddress(address) {
  try {
    if (!address) return null
    if (typeof address === 'string') return { host: address, port: null }
    return {
      host: address.host || address.address || null,
      port: Number(address.port || 0) || null,
      family: address.family || null
    }
  } catch {
    return null
  }
}

function describeTrackedConnection(conn) {
  if (!conn || typeof conn !== 'object') return null
  const rawStream = conn.rawStream || conn._rawStream || null
  const socket = rawStream?.socket || rawStream?._socket || conn.socket || null
  const remoteAddress = rawStream?.remoteAddress || rawStream?.remote || conn.remoteAddress || null
  return {
    constructor: conn.constructor?.name || null,
    destroyed: Boolean(conn.destroyed),
    opened: Boolean(conn.opened),
    opening: Boolean(conn.opening),
    closed: Boolean(conn.closed),
    readable: Boolean(conn.readable),
    writable: Boolean(conn.writable),
    connecting: Boolean(conn.connecting),
    error: describeStreamError(conn),
    rawStream: rawStream ? {
      constructor: rawStream.constructor?.name || null,
      connected: Boolean(rawStream.connected),
      destroyed: Boolean(rawStream.destroyed),
      errored: describeStreamError(rawStream),
      id: rawStream.id ? shortKeyHex(rawStream.id) : null,
      remoteHost: rawStream.remoteHost || null,
      remotePort: Number(rawStream.remotePort || 0) || null,
      remoteAddress: describeAddress(remoteAddress),
      socketLocal: describeSocketAddress(socket)
    } : null,
    bytesRead: Number(conn.bytesRead || rawStream?.bytesRead || 0),
    bytesWritten: Number(conn.bytesWritten || rawStream?.bytesWritten || 0)
  }
}

function describePeerInfo(peerInfo) {
  if (!peerInfo || typeof peerInfo !== 'object') return null
  const relayAddresses = Array.isArray(peerInfo.relayAddresses) ? peerInfo.relayAddresses : []
  const topics = Array.isArray(peerInfo.topics) ? peerInfo.topics : []
  return {
    key: shortKeyHex(peerInfo.publicKey),
    attempts: Number(peerInfo.attempts || 0),
    queued: Boolean(peerInfo.queued),
    waiting: Boolean(peerInfo.waiting),
    explicit: Boolean(peerInfo.explicit),
    banned: Boolean(peerInfo.banned),
    proven: Boolean(peerInfo.proven),
    client: Boolean(peerInfo.client),
    connectedTime: Number(peerInfo.connectedTime ?? -1),
    disconnectedTime: Number(peerInfo.disconnectedTime || 0),
    relayAddresses: relayAddresses.length,
    relayAddressHints: describeRelayAddresses(relayAddresses),
    topics: topics.length
  }
}

function attachConnectionDiagnostics(conn, entry) {
  if (!conn || !entry) return
  const recordEvent = (event, detail = {}) => {
    entry.events.push({ at: Date.now(), event, ...detail })
    while (entry.events.length > 20) entry.events.shift()
    entry.stream = describeTrackedConnection(conn)
  }

  try { conn.once?.('open', () => recordEvent('open')) } catch { /* diagnostics only */ }
  try { conn.once?.('close', () => recordEvent('close', { error: describeStreamError(conn) })) } catch { /* diagnostics only */ }
  try { conn.once?.('error', (err) => recordEvent('error', { error: describeStreamError({ errored: err }) })) } catch { /* diagnostics only */ }

  const rawStream = conn.rawStream || conn._rawStream || null
  try { rawStream?.once?.('connect', () => recordEvent('raw-connect')) } catch { /* diagnostics only */ }
  try { rawStream?.once?.('close', () => recordEvent('raw-close', { error: describeStreamError(rawStream) })) } catch { /* diagnostics only */ }
  try { rawStream?.once?.('error', (err) => recordEvent('raw-error', { error: describeStreamError({ errored: err }) })) } catch { /* diagnostics only */ }
}

function describeDhtState(dht) {
  if (!dht) return null
  let socketAddress = null
  let localAddress = null
  let remoteAddress = null
  try {
    socketAddress = dht.address?.() || null
    if (!socketAddress && dht.io?.serverSocket?.address) socketAddress = dht.io.serverSocket.address()
  } catch { socketAddress = null }
  try { localAddress = dht.localAddress?.() || null } catch { localAddress = null }
  try { remoteAddress = dht.remoteAddress?.() || null } catch { remoteAddress = null }
  return {
    bootstrapped: dht.bootstrapped ?? null,
    firewalled: dht.firewalled ?? null,
    ephemeral: dht.ephemeral ?? null,
    online: dht.online ?? null,
    host: dht.host || null,
    port: Number(dht.port || 0) || null,
    socketAddress,
    localAddress,
    remoteAddress,
    serverSocket: describeSocketAddress(dht.io?.serverSocket),
    clientSocket: describeSocketAddress(dht.io?.clientSocket)
  }
}

function createSwarmDiagnostics(swarm) {
  const recentConnections = []
  const recentPeers = []
  const recentUpdates = []
  const maxRecent = 20

  const record = (items, entry) => {
    items.push({ at: Date.now(), ...entry })
    while (items.length > maxRecent) items.shift()
  }

  return {
    recordPeer(peer, topic) {
      record(recentPeers, {
        key: shortKeyHex(peer?.publicKey),
        topic: shortKeyHex(topic),
        relayAddresses: Array.isArray(peer?.relayAddresses) ? peer.relayAddresses.length : 0,
        relayAddressHints: describeRelayAddresses(peer?.relayAddresses),
        queueSize: swarm?._queue?.length || 0,
        connecting: Number(swarm?.connecting || 0),
        connections: swarm?.connections?.size || 0,
        allConnections: swarm?._allConnections?.size || 0
      })
    },
    recordUpdate() {
      record(recentUpdates, {
        peers: swarm?.peers?.size || 0,
        connections: swarm?.connections?.size || 0,
        allConnections: swarm?._allConnections?.size || 0,
        connecting: Number(swarm?.connecting || 0),
        queueSize: swarm?._queue?.length || 0,
        dht: describeDhtState(swarm?.dht)
      })
    },
    recordConnection(conn, info) {
      const entry = {
        key: shortKeyHex(info?.publicKey),
        openedAt: Date.now(),
        initiator: Boolean(info?.client),
        type: info?.type || null,
        topics: Array.isArray(info?.topics) ? info.topics.length : null,
        stream: describeTrackedConnection(conn),
        events: [],
        closedAt: null,
        error: null
      }
      record(recentConnections, entry)
      attachConnectionDiagnostics(conn, entry)
    },
    recordClientConnect(conn, peerInfo) {
      const entry = {
        key: shortKeyHex(peerInfo?.publicKey || conn?.remotePublicKey),
        openedAt: Date.now(),
        initiator: true,
        type: 'client-attempt',
        topics: Array.isArray(peerInfo?.topics) ? peerInfo.topics.length : null,
        stream: describeTrackedConnection(conn),
        relayAddresses: Array.isArray(peerInfo?.relayAddresses) ? peerInfo.relayAddresses.length : 0,
        relayAddressHints: describeRelayAddresses(peerInfo?.relayAddresses),
        events: [],
        closedAt: null,
        error: null
      }
      record(recentConnections, entry)
      attachConnectionDiagnostics(conn, entry)
    },
    snapshot() {
      const peerStates = []
      try {
        if (swarm?.peers && typeof swarm.peers.values === 'function') {
          for (const peerInfo of swarm.peers.values()) {
            peerStates.push(describePeerInfo(peerInfo))
            if (peerStates.length >= 20) break
          }
        }
      } catch {
        // Diagnostics must never break status rendering.
      }

      const allConnections = []
      try {
        if (swarm?._allConnections && typeof swarm._allConnections.entries === 'function') {
          for (const [key, conn] of swarm._allConnections.entries()) {
            allConnections.push({ key: shortKeyHex(key), ...describeTrackedConnection(conn) })
            if (allConnections.length >= 20) break
          }
        }
      } catch {
        // Diagnostics must never break status rendering.
      }

      return {
        recentPeers: recentPeers.slice(-10),
        recentUpdates: recentUpdates.slice(-10),
        recentConnections: recentConnections.slice(-10),
        peerStates,
        allConnections
      }
    }
  }
}

function createOfflineSwarm(keyPair, reason = 'unavailable') {
  const listeners = new Map()
  const swarm = {
    keyPair,
    connections: new Set(),
    peers: new Set(),
    dht: {
      firewalled: null,
      bootstrapped: false,
      ephemeral: true,
      online: false
    },
    _peartubeOffline: true,
    _peartubeOfflineReason: reason,
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(listener)
      return this
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener)
      return this
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) || []) {
        try { listener(...args) } catch { /* best effort */ }
      }
      return true
    },
    join() {
      return createNoopDiscoveryHandle()
    },
    listen: async () => {},
    suspend: async () => {},
    resume: async () => {},
    destroy: async () => {
      listeners.clear()
      swarm.connections.clear()
      swarm.peers.clear()
    }
  }
  return swarm
}

function installSwarmConnectDiagnostics(swarm, diagnostics) {
  if (!swarm || swarm._peartubeConnectDiagnosticsInstalled) return false
  if (typeof swarm._connect !== 'function') return false

  const connect = swarm._connect
  swarm._connect = function peartubeDiagnosedConnect(peerInfo, queued) {
    const before = this._allConnections?.size || 0
    const result = connect.call(this, peerInfo, queued)
    try {
      const after = this._allConnections?.size || 0
      if (after > before && this._allConnections && typeof this._allConnections.values === 'function') {
        let latest = null
        for (const conn of this._allConnections.values()) latest = conn
        diagnostics?.recordClientConnect?.(latest, peerInfo)
      }
    } catch { /* diagnostics only */ }
    return result
  }
  swarm._peartubeConnectDiagnosticsInstalled = true
  return true
}

function installSwarmPeerDiscoveryEmitter(swarm) {
  if (!swarm || swarm._peartubePeerDiscoveryEmitterInstalled) return false
  if (typeof swarm._handlePeer !== 'function' || typeof swarm.emit !== 'function') return false

  const handlePeer = swarm._handlePeer
  swarm._handlePeer = function peartubeHandlePeer(peer, topic) {
    const result = handlePeer.call(this, peer, topic)
    try {
      swarm.emit('peer', peer, topic)
    } catch { /* best effort */ }
    return result
  }
  swarm._peartubePeerDiscoveryEmitterInstalled = true
  return true
}

async function ensureHttpModule() {
  if (http) return http
  try {
    http = await loadBareOrNodeHttpModule()
  } catch {
    http = null
  }
  return http
}

function initOptionalStorageDeps() {
  if (optionalStorageDepsReady) return optionalStorageDepsReady

  optionalStorageDepsReady = (async () => {
    console.log('[Storage] initOptionalStorageDeps start')
    await appendDebugLine('[storage] initOptionalStorageDeps start')
    if (!HyperswarmStats) {
      try {
        console.log('[Storage] Loading hyperswarm-stats')
        HyperswarmStats = (await import('hyperswarm-stats')).default
        console.log('[Storage] Loaded hyperswarm-stats')
        await appendDebugLine('[storage] hyperswarm-stats loaded')
      } catch {
        log.debug('hyperswarm-stats not available')
        await appendDebugLine('[storage] hyperswarm-stats unavailable')
      }
    }

    if (!Wakeup) {
      try {
        console.log('[Storage] Loading protomux-wakeup')
        Wakeup = (await import('protomux-wakeup')).default
        console.log('[Storage] Loaded protomux-wakeup')
        await appendDebugLine('[storage] protomux-wakeup loaded')
      } catch {
        log.debug('protomux-wakeup not available, content announcements may be slower')
        await appendDebugLine('[storage] protomux-wakeup unavailable')
      }
    }
    console.log('[Storage] initOptionalStorageDeps complete')
    await appendDebugLine('[storage] initOptionalStorageDeps complete')
  })()

  return optionalStorageDepsReady
}

async function initStorageModules() {
  if (fs && path) return;
  fs = resolveBareOrNodeFsModuleSync()
  path = resolveBareOrNodePathModuleSync()
  if (!fs) {
    try { fs = await loadBareOrNodeFsModule(); } catch { /* best effort */ }
  }
  if (!path) {
    try { path = await loadBareOrNodePathModule(); } catch { /* best effort */ }
  }
}

function warmOptionalStorageDeps() {
  void initOptionalStorageDeps()
    .catch((error) => {
      log.debug('optional storage dependency warm-up failed', { error: error?.message || String(error) })
    })
}

function warmHyperswarmModule() {
  if (Hyperswarm) return hyperswarmModuleReady || Promise.resolve(Hyperswarm)
  if (!hyperswarmModuleReady) {
    hyperswarmModuleReady = loadHyperswarmModule()
      .then((LoadedHyperswarm) => {
        if (!Hyperswarm) Hyperswarm = LoadedHyperswarm
        return Hyperswarm
      })
      .catch(async (error) => {
        await appendDebugLine(`[storage] hyperswarm module unavailable during background warm-up ${error?.message || String(error)}`)
        return null
      })
  }
  return hyperswarmModuleReady
}

async function migrateLegacyCorestoreLayout(storagePath) {
  if (!fs || !path) return

  const corestoreFile = path.join(storagePath, 'CORESTORE')

  try {
    if (typeof fs.existsSync === 'function' && fs.existsSync(corestoreFile)) {
      await appendDebugLine('[storage] embedded migration skipped (CORESTORE exists)')
      return
    }
  } catch { /* best effort */ }

  if (!fs.promises?.readdir || !fs.promises?.rename || !fs.promises?.mkdir) {
    await appendDebugLine('[storage] embedded migration skipped (fs.promises unavailable)')
    return
  }

  let files = []
  try {
    files = await fs.promises.readdir(storagePath)
  } catch {
    await appendDebugLine('[storage] embedded migration skipped (readdir failed)')
    return
  }

  const notRocks = new Set([
    'CORESTORE',
    'primary-key',
    'cores',
    'app-preferences',
    'cache',
    'preferences.json',
    'db',
    'clone',
    'core',
    'notifications'
  ])

  let moved = 0
  for (const entry of files) {
    if (notRocks.has(entry)) continue

    try {
      await fs.promises.mkdir(path.join(storagePath, 'db'), { recursive: true })
    } catch { /* best effort */ }

    try {
      await fs.promises.rename(
        path.join(storagePath, entry),
        path.join(storagePath, 'db', entry)
      )
      moved++
    } catch { /* best effort */ }
  }

  await appendDebugLine(`[storage] embedded migration moved=${moved}`)
}

async function createCorestoreInstance(storagePath, options = {}) {
  if (isEmbeddedBareKitStoragePath()) {
    await appendDebugLine('[storage] embedded BareKit using plain Corestore(storagePath, options)')
  }

  return new Corestore(storagePath, options)
}

async function openDeterministicNamedCore(store, name) {
  if (!isEmbeddedBareKitStoragePath()) {
    return store.get({ name })
  }

  try {
    const keyPair = await store.createKeyPair(name)
    await appendDebugLine(`[storage] embedded named core "${name}" opening via explicit keyPair`)
    return store.get({ keyPair })
  } catch (error) {
    await appendDebugLine(
      `[storage] embedded named core "${name}" keyPair open fallback ${describeDebugError(error)}`
    )
    return store.get({ name })
  }
}

/**
 * Wrap a corestore to add default timeout to all get() calls.
 * This ensures cores used by BlobServer have timeout for P2P fetching.
 *
 * @param {import('corestore')} store - Corestore instance
 * @param {number} [defaultTimeout=30000] - Default timeout in ms
 * @returns {import('corestore')} Wrapped store
 */
function wrapStoreWithTimeout(store, defaultTimeout = 30000) {
  const originalGet = store.get.bind(store);
  store.get = function(keyOrOpts = {}) {
    // Handle both store.get(key) and store.get({ key, ... }) signatures
    // If first arg is a Buffer, it's a raw key - wrap it in options
    if (b4a.isBuffer(keyOrOpts)) {
      return originalGet({ key: keyOrOpts, timeout: defaultTimeout });
    }
    // Otherwise it's an options object - add timeout if not present
    const optsWithTimeout = {
      ...keyOrOpts,
      timeout: keyOrOpts.timeout ?? defaultTimeout
    };
    return originalGet(optsWithTimeout);
  };
  return store;
}

function getSwarmDiscoveryHandles(ctx) {
  if (!ctx?._swarmDiscoveryHandles) ctx._swarmDiscoveryHandles = new Map()
  return ctx._swarmDiscoveryHandles
}

export function retainSwarmDiscovery(ctx, discoveryKey, options = {}) {
  if (!ctx?.swarm || !discoveryKey) return null

  const handles = getSwarmDiscoveryHandles(ctx)
  const discoveryKeyHex = b4a.toString(discoveryKey, 'hex')
  const existing = handles.get(discoveryKeyHex)
  if (existing) return existing

  const handle = ctx.swarm.join(discoveryKey, { server: true, client: true })
  handles.set(discoveryKeyHex, handle)

  try {
    const flushed = handle?.flushed?.()
    if (flushed && typeof flushed.then === 'function') {
      const label = options.label || discoveryKeyHex.slice(0, 16)
      flushed
        .then(() => {
          console.log(`[Storage] Swarm discovery flushed for ${label}`)
        })
        .catch((err) => {
          console.log(`[Storage] Swarm discovery flush failed for ${label} (non-fatal):`, err?.message)
        })
    }
  } catch { /* best effort */ }

  return handle
}


function isValidCoreKeyHex(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

/**
 * Retain discovery for a PublicBee and the video/thumbnail blob cores it advertises.
 * This restores the old relay-style cache behavior for any runtime: once we know a
 * publicBeeKey, cached content is announced as content cores without waiting for a
 * full channel Autobase load.
 *
 * @param {import('./types.js').StorageContext} ctx
 * @param {string} publicBeeKeyHex
 * @param {{ label?: string, maxVideos?: number }} [options]
 * @returns {Promise<{publicBeeKey: string, videos: number, blobCores: number, thumbnailBlobCores: number, discoveryHandles: number, retained: number, errors: number, lastError: string | null}>}
 */
export async function retainPublicBeeContentDiscovery(ctx, publicBeeKeyHex, options = {}) {
  const stats = {
    publicBeeKey: publicBeeKeyHex,
    videos: 0,
    blobCores: 0,
    thumbnailBlobCores: 0,
    discoveryHandles: getSwarmDiscoveryHandles(ctx).size,
    retained: 0,
    errors: 0,
    lastError: null,
  }

  if (!isValidCoreKeyHex(publicBeeKeyHex)) {
    stats.errors += 1
    stats.lastError = 'invalid-publicBeeKey'
    return stats
  }

  let publicBee = null
  try {
    publicBee = await loadPublicBee(ctx, publicBeeKeyHex)
  } catch (err) {
    stats.errors += 1
    stats.lastError = err?.message || String(err)
    return stats
  }

  let videos = []
  try {
    videos = await publicBee?.listVideos?.().catch(() => [])
  } catch (err) {
    stats.errors += 1
    stats.lastError = err?.message || String(err)
    videos = []
  }

  const maxVideos = Number.isFinite(options.maxVideos) && options.maxVideos > 0
    ? Math.floor(options.maxVideos)
    : 200
  const coreKeys = new Map()
  for (const video of (Array.isArray(videos) ? videos.slice(0, maxVideos) : [])) {
    stats.videos += 1
    if (isValidCoreKeyHex(video?.blobsCoreKey)) coreKeys.set(video.blobsCoreKey.toLowerCase(), 'blob')
    if (isValidCoreKeyHex(video?.thumbnailBlobsCoreKey)) coreKeys.set(video.thumbnailBlobsCoreKey.toLowerCase(), 'thumbnail')
  }

  for (const [coreKeyHex, kind] of coreKeys) {
    try {
      const core = ctx.store?.get?.(b4a.from(coreKeyHex, 'hex'))
      await core?.ready?.()
      if (core?.discoveryKey && retainSwarmDiscovery(ctx, core.discoveryKey, {
        label: `${options.label || 'publicBee'}:${kind}:${coreKeyHex.slice(0, 16)}`
      })) {
        stats.retained += 1
        if (kind === 'thumbnail') stats.thumbnailBlobCores += 1
        else stats.blobCores += 1
      }
    } catch (err) {
      stats.errors += 1
      stats.lastError = err?.message || String(err)
    }
  }

  stats.discoveryHandles = getSwarmDiscoveryHandles(ctx).size
  return stats
}

/**
 * Initialize core storage components.
 *
 * @param {Object} config
 * @param {string} config.storagePath - Path to storage directory
 * @param {number} [config.defaultTimeout=30000] - Default timeout for operations
 * @param {string} [config.swarmKeyPath] - Optional path to persist Hyperswarm keypair
 * @param {number} [config.blobServerPort] - Optional fixed blob server port
 * @param {string} [config.blobServerHost] - Optional blob server host (defaults to 127.0.0.1)
 * @param {string} [config.blobServerBindHost] - Optional blob server bind host (defaults to blobServerHost)
 * @returns {Promise<import('./types.js').StorageContext>}
 */
export async function initializeStorage(config) {
  globalNetworkStartupTiming = createNetworkStartupTiming()
  await appendDebugLine('[storage] initializeStorage entry')
  warmOptionalStorageDeps()
  warmHyperswarmModule()
  await initStorageModules();
  await appendDebugLine('[storage] initStorageModules complete')

  const {
    storagePath,
    defaultTimeout = 30000,
    swarmKeyPath,
    blobServerPort: blobServerPortOverride,
    blobServerHost: blobServerHostOverride,
    blobServerBindHost: blobServerBindHostOverride,
    primaryKey = null,
    corestoreWaitForLock = false,
    corestoreAllowBackup = false
  } = config;

  console.log('[Storage] Initializing storage at:', storagePath);

  // Validate storage path
  if (!storagePath || storagePath === './storage') {
    console.warn('[Storage] WARNING: Using relative/default storage path. Data may not persist!');
    console.warn('[Storage] Consider using --store flag for persistent storage.');
  }

  if (isEmbeddedBareKitStoragePath()) {
    await appendDebugLine('[storage] relocateLegacyLogsDir skipped for embedded BareKit storage')
  } else {
    try {
      await appendDebugLine('[storage] relocateLegacyBlindPeerDir start')
      const relocatedBlindPeerDir = relocateLegacyBlindPeerDir(storagePath, fs, path)
      await appendDebugLine(`[storage] relocateLegacyBlindPeerDir done moved=${relocatedBlindPeerDir || 'none'}`)
      if (relocatedBlindPeerDir) {
        console.log('[Storage] Relocated legacy blind-peer dir to avoid Corestore migration conflict:', relocatedBlindPeerDir)
      }
    } catch (error) {
      await appendDebugLine(`[storage] relocateLegacyBlindPeerDir failed ${describeDebugError(error)}`)
      console.warn('[Storage] Failed to relocate legacy blind-peer dir before Corestore init:', error?.message)
    }

    try {
      await appendDebugLine('[storage] relocateLegacyLogsDir start')
      const relocatedLogsDir = relocateLegacyLogsDir(storagePath, fs, path)
      await appendDebugLine(`[storage] relocateLegacyLogsDir done moved=${relocatedLogsDir || 'none'}`)
      if (relocatedLogsDir) {
        console.log('[Storage] Relocated legacy logs dir to avoid Corestore migration conflict:', relocatedLogsDir)
      }
    } catch (error) {
      await appendDebugLine(`[storage] relocateLegacyLogsDir failed ${describeDebugError(error)}`)
      console.warn('[Storage] Failed to relocate legacy logs dir before Corestore init:', error?.message)
    }
  }

  // Initialize Corestore
  console.log('[Storage] Creating Corestore...');
  await appendDebugLine('[storage] creating corestore')
  console.log('[Storage] Corestore primaryKey:', primaryKey ? 'provided (deterministic)' : 'not provided (random)');
  console.log('[Storage] Corestore lock wait:', corestoreWaitForLock ? 'enabled' : 'disabled');
  const corestoreOptions = primaryKey
    ? { primaryKey, unsafe: true, wait: corestoreWaitForLock, allowBackup: corestoreAllowBackup }
    : { wait: corestoreWaitForLock, allowBackup: corestoreAllowBackup }
  let store = await createCorestoreInstance(storagePath, corestoreOptions)

  console.log('[Storage] Waiting for Corestore ready...');
  await appendDebugLine('[storage] awaiting corestore ready')
  try {
    await store.ready();
  } catch (error) {
    await appendDebugLine(`[storage] corestore ready failed ${describeDebugError(error)}`)
    await cleanupFailedCorestoreOpen(store, 'corestore ready cleanup', {
      appendDebugLine,
      describeError: describeDebugError
    })
    throw error
  }
  console.log('[Storage] Corestore ready, opened:', store.opened, 'closed:', store.closed);
  await appendDebugLine(`[storage] corestore ready opened=${store.opened} closed=${store.closed}`)
  if (b4a.isBuffer(store.primaryKey)) {
    const primaryKeyHex = b4a.toString(store.primaryKey, 'hex')
    console.log('[Storage] Corestore primaryKey after ready:', `${primaryKeyHex.slice(0, 16)}...`)
    await appendDebugLine(`[storage] corestore primaryKey after ready ${primaryKeyHex}`)
  }

  // Wrap store with timeout for P2P operations to prevent indefinite hangs
  const blobStore = wrapStoreWithTimeout(store, defaultTimeout);

  // Initialize blob server for video streaming only after metadata cores are open.
  let blobServer = null;
  let blobServerPort = 0;
  let blobServerError = null;
  let resolveBlobServerReady;
  const blobServerReady = new Promise((resolve) => {
    resolveBlobServerReady = resolve
  })
  let blobServerHost = blobServerHostOverride || '127.0.0.1';
  let blobServerBindHost = blobServerBindHostOverride || blobServerHost;

  let metaCore = null
  let metaDb = null

  async function cleanupFailedMetadataStartup(label, originalError) {
    await appendDebugLine(`[storage] metadata init cleanup start ${label}`)

    try {
      await metaDb?.close?.()
      await appendDebugLine(`[storage] metadata init cleanup metaDb ok ${label}`)
    } catch (error) {
      await appendDebugLine(
        `[storage] metadata init cleanup metaDb failed ${label} ${describeDebugError(error)}`
      )
    }

    try {
      await metaCore?.close?.()
      await appendDebugLine(`[storage] metadata init cleanup metaCore ok ${label}`)
    } catch (error) {
      await appendDebugLine(
        `[storage] metadata init cleanup metaCore failed ${label} ${describeDebugError(error)}`
      )
    }

    try {
      await blobServer?.close?.()
      if (globalBlobServer === blobServer) globalBlobServer = null
      if (globalMetaDb === metaDb) globalMetaDb = null
      await appendDebugLine(`[storage] metadata init cleanup blobServer ok ${label}`)
    } catch (error) {
      await appendDebugLine(
        `[storage] metadata init cleanup blobServer failed ${label} ${describeDebugError(error)}`
      )
    }

    await cleanupFailedCorestoreOpen(store, `metadata init cleanup ${label}`, {
      appendDebugLine,
      describeError: describeDebugError
    })

    throw originalError
  }

  // Initialize metadata database
  await appendDebugLine('[storage] metaCore get start')
  console.log('[Storage] metaCore get start')
  metaCore = await openDeterministicNamedCore(store, 'peartube-meta');
  await appendDebugLine('[storage] metaCore get returned')
  console.log('[Storage] metaCore get returned')
  try {
    await appendDebugLine('[storage] metaCore ready start')
    console.log('[Storage] metaCore ready start')
    await metaCore.ready()
    await appendDebugLine('[storage] metaCore ready ok')
    console.log('[Storage] metaCore ready ok')
  } catch (error) {
    await appendDebugLine(`[storage] metaCore ready failed ${describeDebugError(error)}`)
    console.error('[Storage] metaCore ready failed:', describeDebugError(error))
    await cleanupFailedMetadataStartup('metaCore.ready', error)
  }

  await appendDebugLine('[storage] metaDb construct start')
  console.log('[Storage] metaDb construct start')
  metaDb = new Hyperbee(metaCore, {
    keyEncoding: 'utf-8',
    valueEncoding: 'json'
  });
  await appendDebugLine('[storage] metaDb construct ok')
  console.log('[Storage] metaDb construct ok')
  try {
    await appendDebugLine('[storage] metaDb ready start')
    console.log('[Storage] metaDb ready start')
    await metaDb.ready();
    await appendDebugLine('[storage] metaDb ready')
    console.log('[Storage] metaDb ready')
    globalMetaDb = metaDb
  } catch (error) {
    await appendDebugLine(`[storage] metaDb ready failed ${describeDebugError(error)}`)
    console.error('[Storage] metaDb ready failed:', describeDebugError(error))
    await cleanupFailedMetadataStartup('metaDb.ready', error)
  }

  try {
    const desiredPort = blobServerPortOverride || 0;

    blobServer = new BlobServer(blobStore, {
      port: desiredPort || 0,
      host: blobServerBindHost
    });

    // Patch _onrequest to add CORS headers for mediabunny's UrlSource (fetch)
    const origOnRequest = blobServer._onrequest.bind(blobServer)
    blobServer._onrequest = async function (req, res) {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Range')
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
      return origOnRequest(req, res)
    }

    console.log('[Storage] Starting blob server listen...');
    await appendDebugLine('[storage] blob server listen start')
    globalBlobServer = blobServer;
    const markBlobServerReady = (port, error = null) => {
      blobServerPort = Number(port || 0) || 0
      blobServerError = error || null
      blobServer._peartubeListenResolved = true
      blobServer._peartubeReady = blobServerPort > 0 && !blobServerError
      blobServer._peartubeListenError = blobServerError
      if (!blobServerError) {
        console.log('[Storage] Blob server listening on port:', blobServerPort)
        void appendDebugLine(`[storage] blob server listening port=${blobServerPort}`)
      }
      resolveBlobServerReady?.({ port: blobServerPort, error: blobServerError })
    }

    blobServer._peartubeListenResolved = false
    blobServer._peartubeReady = false
    blobServer._peartubeListenError = null
    const blobServerListenPromise = blobServer.listen()

    if (blobServerListenPromise && typeof blobServerListenPromise.then === 'function') {
      blobServerListenPromise
        .then(() => {
          const resolvedPort = Number(blobServer.port || 0) || 0
          if (!resolvedPort) {
            markBlobServerReady(0, new Error('Blob server listen resolved without an assigned port'))
            return
          }
          markBlobServerReady(resolvedPort)
        })
        .catch((err) => {
          markBlobServerReady(0, err)
        })
    } else {
      const resolvedPort = Number(blobServer.port || 0) || 0
      markBlobServerReady(
        resolvedPort,
        resolvedPort ? null : new Error('Blob server listen returned before an assigned port was available')
      )
    }
  } catch (err) {
    blobServerError = err
    resolveBlobServerReady?.({ port: 0, error: err })
    console.error('[Storage] Failed to initialize blob server:', err.message);
    await appendDebugLine(`[storage] blob server init failed ${err?.message || String(err)}`)
    // Continue without blob server - will need alternative video streaming
  }

  // Initialize Hyperswarm for P2P networking
  let keyPair = null;
  const resolvedSwarmKeyPath = swarmKeyPath || (path && storagePath ? path.join(storagePath, 'swarm-key.json') : null);

  if (resolvedSwarmKeyPath && fs) {
    try {
      const raw = fs.readFileSync(resolvedSwarmKeyPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed?.publicKey && parsed?.secretKey) {
        keyPair = {
          publicKey: b4a.from(parsed.publicKey, 'hex'),
          secretKey: b4a.from(parsed.secretKey, 'hex')
        };
        console.log('[Storage] Loaded persisted swarm key:', parsed.publicKey.slice(0, 16));
      }
    } catch (e) {
      // If missing or invalid, we'll generate below
    }
  }

  if (!keyPair) {
    keyPair = crypto.keyPair();
    if (resolvedSwarmKeyPath && fs) {
      try {
        fs.mkdirSync(path.dirname(resolvedSwarmKeyPath), { recursive: true });
        fs.writeFileSync(resolvedSwarmKeyPath, JSON.stringify({
          publicKey: b4a.toString(keyPair.publicKey, 'hex'),
          secretKey: b4a.toString(keyPair.secretKey, 'hex')
        }));
        console.log('[Storage] Persisted new swarm key to', resolvedSwarmKeyPath);
      } catch (e) {
        console.log('[Storage] Could not persist swarm key:', e.message);
      }
    }
  }

  console.log('[Storage] Creating Hyperswarm...');
  await appendDebugLine('[storage] creating hyperswarm')
  const LoadedHyperswarm = Hyperswarm || (hyperswarmModuleReady ? await Promise.race([
    hyperswarmModuleReady,
    new Promise((resolve) => setTimeout(() => resolve(null), 100))
  ]) : null)
  let swarm
  if (typeof LoadedHyperswarm !== 'function') {
    console.warn('[Storage] Hyperswarm unavailable; continuing with offline P2P networking')
    await appendDebugLine('[storage] hyperswarm unavailable; using offline swarm')
    swarm = createOfflineSwarm(keyPair, 'module-unavailable')
  } else {
    try {
      swarm = new LoadedHyperswarm({ keyPair });
    } catch (err) {
      console.warn('[Storage] Hyperswarm creation failed; continuing with offline P2P networking:', err?.message)
      await appendDebugLine(`[storage] hyperswarm create failed; using offline swarm ${err?.message || String(err)}`)
      swarm = createOfflineSwarm(keyPair, err?.message || 'create-failed')
    }
  }
  console.log('[Storage] Swarm created, publicKey:', b4a.toString(swarm.keyPair.publicKey, 'hex').slice(0, 16));
  globalNetworkStartupTiming?.record('swarm-created', { offline: Boolean(swarm._peartubeOffline) })
  const initialDhtState = describeDhtState(swarm.dht)
  if (initialDhtState) {
    console.log('[Storage] Initial DHT bind state:', JSON.stringify(initialDhtState))
  }
  await appendDebugLine(`[storage] hyperswarm created offline=${Boolean(swarm._peartubeOffline)}`)
  globalSwarmDiagnostics = createSwarmDiagnostics(swarm)
  installSwarmConnectDiagnostics(swarm, globalSwarmDiagnostics)
  installSwarmPeerDiscoveryEmitter(swarm)

  // Set global references for suspend/resume and stats
  globalSwarm = swarm;

  // Initialize network stats for debugging
  if (HyperswarmStats) {
    try {
      networkStats = new HyperswarmStats(swarm);
      console.log('[Storage] Network stats initialized');
    } catch (e) {
      console.log('[Storage] Network stats init failed:', e?.message);
    }
  }

  const channels = new Map();

  // Initialize protomux-wakeup for content announcements
  let wakeup = null;
  if (Wakeup) {
    try {
      wakeup = new Wakeup();
      console.log('[Storage] Wakeup protocol initialized');
    } catch (err) {
      console.log('[Storage] Wakeup init failed (non-fatal):', err?.message);
    }
  }

  // Known-peer cache: persist remote pubkeys so the next cold start can
  // `swarm.joinPeer(pk)` them directly without waiting for a topic DHT lookup.
  const selfKeyHex = swarm.keyPair?.publicKey ? b4a.toString(swarm.keyPair.publicKey, 'hex') : null
  const knownPeerCache = createKnownPeerCache(metaDb, { selfKeyHex })
  globalKnownPeerCache = knownPeerCache

  // Register handlers BEFORE swarm.join so any incoming connection is replicated
  // immediately (canonical Hyperswarm/Hyperdrive pattern).
  swarm.on('connection', (conn, info) => {
    try {
      if (!conn || conn.destroyed) return
      const remoteKey = info?.publicKey ? b4a.toString(info.publicKey, 'hex').slice(0, 16) : 'unknown';
      globalNetworkStartupTiming?.record('socket-connected', { key: remoteKey, connections: swarm.connections?.size || 0, connecting: swarm.connecting || 0 })
      globalSwarmDiagnostics?.recordConnection?.(conn, info)
      console.log('[Storage] Peer connected:', remoteKey, 'connections:', swarm.connections?.size || 0, 'connecting:', swarm.connecting || 0);
      void appendDebugLine(`[storage] peer connected ${remoteKey} connections=${swarm.connections?.size || 0} connecting=${swarm.connecting || 0}`)
      if (info?.publicKey) knownPeerCache.record(info.publicKey)

      // Register stream with wakeup protocol for content announcements
      if (wakeup) {
        try {
          wakeup.addStream(conn);
        } catch (err) {
          console.log('[Storage] Wakeup addStream error (non-fatal):', err?.message);
        }
      }

      // Replicate all Hypercore data in the Corestore:
      // - Autobase cores (channel metadata, videos, comments, etc.)
      // - Hyperblobs cores (video bytes, thumbnails)
      try {
        if (conn.destroyed) return
        store.replicate(conn);
      } catch (err) {
        console.log('[Storage] store.replicate failed (non-fatal):', err?.message);
      }

      // Also replicate all loaded Autobase channels. Each channel's setupPairing
      // registers its own handler, but only for connections established AFTER the
      // channel is loaded. This covers channels that were loaded BEFORE this peer
      // connected.
      if (channels.size > 0) {
        console.log('[Storage] Replicating', channels.size, 'Autobase channel(s) on new connection');
        for (const [keyHex, channel] of channels) {
          if (conn.destroyed) break
          if (channel?.base && channel._replicatedConns && !channel._replicatedConns.has(conn)) {
            try {
              channel._replicatedConns.add(conn)
              if (conn.destroyed) {
                channel._replicatedConns.delete(conn)
                continue
              }
              channel.base.replicate(conn)
              console.log('[Storage] Replicated Autobase for channel:', keyHex.slice(0, 16))
            } catch (err) {
              console.log('[Storage] Error replicating channel', keyHex.slice(0, 16), ':', err?.message)
            }
          }
        }
      }
    } catch (err) {
      console.log('[Storage] connection handler error (non-fatal):', err?.message)
    }
  });

  // Log swarm events for debugging mobile connectivity
  swarm.on('update', () => {
    globalSwarmDiagnostics?.recordUpdate?.()
    log.debug('Swarm update event', { connections: swarm.connections?.size || 0, peers: swarm.peers?.size || 0 })
  });

  // Log peer discovery events (DHT found a peer)
  swarm.on('peer', (peer, topic) => {
    globalSwarmDiagnostics?.recordPeer?.(peer, topic)
    const peerKey = peer?.publicKey ? b4a.toString(peer.publicKey, 'hex').slice(0, 16) : 'unknown'
    globalNetworkStartupTiming?.record('peer-discovered', { key: peerKey, relayAddresses: Array.isArray(peer?.relayAddresses) ? peer.relayAddresses.length : 0, connections: swarm.connections?.size || 0, connecting: swarm.connecting || 0 })
    const relayAddresses = Array.isArray(peer?.relayAddresses) ? peer.relayAddresses.length : 0
    console.log('[Storage] PEER DISCOVERED:', peerKey, 'total peers:', swarm.peers?.size || 0, 'relayAddresses:', relayAddresses, 'connecting:', swarm.connecting || 0)
    void appendDebugLine(`[storage] peer discovered ${peerKey} totalPeers=${swarm.peers?.size || 0} relayAddresses=${relayAddresses} connecting=${swarm.connecting || 0}`)
  })

  // Warm dial: re-connect to recently-seen peers. swarm.joinPeer is idempotent
  // against any topic-based discovery that follows.
  if (!swarm._peartubeOffline) {
    void dialPersistedPeers(swarm, metaDb, { reason: 'startup' }).catch((err) => {
      console.log('[Storage] Warm-dial skipped:', err?.message)
    })
  }

  // Join the PearTube network topic for peer pool building
  // More connected peers = better relay options for symmetric NAT holepunching
  const PEARTUBE_NETWORK_TOPIC = crypto.data(b4a.from(NETWORK_TOPIC_STRING, 'utf-8'));
  globalPeerPoolTopicHex = b4a.toString(PEARTUBE_NETWORK_TOPIC, 'hex')
  if (!swarm._peartubeOffline) {
    try {
      const poolDiscovery = swarm.join(PEARTUBE_NETWORK_TOPIC, { server: true, client: true });
      globalNetworkStartupTiming?.record('topic-join-called', { topic: 'peer-pool', topicHex: globalPeerPoolTopicHex })
      globalPeerPoolDiscovery = poolDiscovery;
      console.log('[Storage] Joined peartube-network topic for peer pool building');
      // Don't await flushed() - it can hang on mobile
      poolDiscovery.flushed().then(() => {
        console.log('[Storage] Peer pool topic discovery flushed, connections:', swarm.connections?.size || 0);
        globalNetworkStartupTiming?.record('topic-flushed', { topic: 'peer-pool', connections: swarm.connections?.size || 0, bootstrapped: swarm.dht?.bootstrapped })
        void appendDebugLine(
          `[storage] peer-pool discovery flushed connections=${swarm.connections?.size || 0} bootstrapped=${swarm.dht?.bootstrapped}`
        )
      }).catch(() => {});
    } catch (e) {
      console.log('[Storage] Failed to join peer pool topic:', e?.message);
      globalPeerPoolDiscovery = null;
    }
  } else {
    console.log('[Storage] Skipping peer pool discovery; P2P networking is offline:', swarm._peartubeOfflineReason)
    await appendDebugLine(`[storage] peer-pool discovery skipped offline reason=${swarm._peartubeOfflineReason}`)
    globalPeerPoolDiscovery = null
  }

  // Start listening - DON'T block on it since it may hang on mobile
  // The listen() call starts the server but we don't need to wait for it
  console.log('[Storage] Starting swarm.listen() (non-blocking)...');
  await appendDebugLine('[storage] swarm.listen start')
  const listenPromise = swarm.listen()
  globalNetworkStartupTiming?.record('swarm-listen-called')

  // Track listen state for debugging
  swarm._peartubeListenResolved = false
  if (listenPromise && typeof listenPromise.then === 'function') {
    listenPromise
      .then(() => {
        swarm._peartubeListenResolved = true
        globalNetworkStartupTiming?.record('swarm-listen-resolved', { firewalled: swarm.dht?.firewalled, bootstrapped: swarm.dht?.bootstrapped })
        console.log('[Storage] listen() resolved, dht.firewalled:', swarm.dht?.firewalled, 'dht.bootstrapped:', swarm.dht?.bootstrapped)
        void appendDebugLine(
          `[storage] swarm.listen resolved firewalled=${swarm.dht?.firewalled} bootstrapped=${swarm.dht?.bootstrapped}`
        )
      })
      .catch((e) => {
        globalNetworkStartupTiming?.record('swarm-listen-failed', { error: e?.message || String(e) })
        console.log('[Storage] listen() failed:', e?.message)
        void appendDebugLine(`[storage] swarm.listen failed ${e?.message || String(e)}`)
      })
  }

  // Log DHT state for debugging
  const logDhtState = () => {
    const dht = swarm.dht
    if (dht) {
      const state = describeDhtState(dht)
      console.log('[Storage] DHT state: bootstrapped=', dht.bootstrapped, 'firewalled=', dht.firewalled, 'ephemeral=', dht.ephemeral, 'online=', dht.online, 'address=', state?.socketAddress, 'remoteAddress=', state?.remoteAddress)
      void appendDebugLine(
        `[storage] dht state bootstrapped=${dht.bootstrapped} firewalled=${dht.firewalled} ephemeral=${dht.ephemeral} online=${dht.online} address=${JSON.stringify(state?.socketAddress || null)} remoteAddress=${JSON.stringify(state?.remoteAddress || null)}`
      )
    }
  }

  // Check DHT state after a delay
  setTimeout(logDhtState, 2000)
  setTimeout(logDhtState, 5000)


  // Set global reference for suspend/resume lifecycle management
  globalChannels = channels;

  // Generate session token for blob URL authentication
  // This token is included in video URLs to prevent unauthorized access
  // NOTE: Full token validation requires extending hypercore-blob-server or using a proxy
  // For now, the token is generated and stored for future middleware implementation
  const blobSessionToken = generateSessionToken()
  console.log('[Storage] Generated blob session token:', blobSessionToken.slice(0, 8) + '...')

  return {
    store,
    metaCore,
    metaDb,
    swarm,
    blobServer,
    blobServerPort,
    blobServerReady,
    blobServerError,
    blobServerHost,
    blobServerBindHost,
    blobSessionToken, // Session token for URL authentication
    channels,
    wakeup,
    peerPoolDiscovery: globalPeerPoolDiscovery
  };
}

/**
 * Load or create a multi-writer channel by Autobase key.
 *
 * @param {import('./types.js').StorageContext} ctx
 * @param {string} channelKeyHex
 * @param {Object} [options]
 * @param {string} [options.encryptionKeyHex]
 * @returns {Promise<import('./channel/multi-writer-channel.js').MultiWriterChannel>}
 */
// Track in-progress channel loads to prevent duplicate concurrent loads
const loadingChannels = new Map()

export async function loadChannel(ctx, channelKeyHex, options = {}) {
  if (!ctx.channels) ctx.channels = new Map()
  if (ctx.channels.has(channelKeyHex)) {
    const cached = ctx.channels.get(channelKeyHex)
    if (!isChannelUsable(cached)) {
      console.log('[Storage] loadChannel: evicting stale cached channel:', channelKeyHex.slice(0, 16))
      ctx.channels.delete(channelKeyHex)
      try { await cached?.close?.() } catch { /* best effort */ }
    }

    if (ctx.channels.has(channelKeyHex)) {
      const current = ctx.channels.get(channelKeyHex)
      if (options.preferWritable && current && !current.writable) {
        if (typeof options.writerKeyName === 'string' && options.writerKeyName) {
          console.log('[Storage] loadChannel: cached channel read-only, reloading for writable access:', channelKeyHex.slice(0, 16))
          try {
            await Promise.race([
              current.close(),
              new Promise((resolve) => setTimeout(resolve, 2000))
            ])
          } catch { /* best effort */ }
          ctx.channels.delete(channelKeyHex)
        } else {
          console.log('[Storage] loadChannel: cached channel remains read-only (no writer key name):', channelKeyHex.slice(0, 16))
        }
      }
    }

    if (ctx.channels.has(channelKeyHex)) {
      const current = ctx.channels.get(channelKeyHex)
      log.debug('loadChannel returning cached channel', { channelKey: channelKeyHex.slice(0, 16) })

    // CRITICAL: Ensure replication is set up on any connections that came in after the channel was loaded
    // This handles the case where channel was cached but new peers connected since then
    if (ctx.swarm && ctx.swarm.connections?.size > 0 && current.base && current._replicatedConns) {
      for (const conn of ctx.swarm.connections) {
        if (!current._replicatedConns.has(conn)) {
          current._replicatedConns.add(conn)
          try {
            current.base.replicate(conn)
            console.log('[Storage] loadChannel: replicated cached channel on new connection:', channelKeyHex.slice(0, 16))
          } catch (err) {
            console.log('[Storage] loadChannel: replicate error:', err?.message)
          }
        }
      }
    }

      return current
    }
  }

  if (loadingChannels.has(channelKeyHex)) {
    console.log('[Storage] loadChannel: already loading, waiting...:', channelKeyHex.slice(0, 16))
    const pending = loadingChannels.get(channelKeyHex)
    const timeoutMs = 30000
    try {
      return await Promise.race([
        pending,
        new Promise((_, reject) => setTimeout(() => reject(new Error('loadChannel wait timeout')), timeoutMs))
      ])
    } catch (err) {
      if (ctx.store?.closed) {
        throw new Error('Corestore is closed')
      }

      console.warn('[Storage] loadChannel: pending load failed:', channelKeyHex.slice(0, 16), err?.message)
      throw err
    }
  }

  console.log('[Storage] loadChannel: cache miss, loading new:', channelKeyHex.slice(0, 16))

  // Create loading promise and store it to prevent duplicate loads
  const loadPromise = (async () => {
    // Check if corestore is still open
    if (ctx.store.closed) {
      console.error('[Storage] ERROR: Corestore is closed! Cannot load channel:', channelKeyHex.slice(0, 16));
      throw new Error('Corestore is closed');
    }

    const openChannel = async (writerKeyName) => {
      const writerKeyPair =
        typeof writerKeyName === 'string' && writerKeyName && typeof ctx.store.createKeyPair === 'function'
          ? await ctx.store.createKeyPair(writerKeyName)
          : null

      console.log('[Storage] Loading channel:', channelKeyHex.slice(0, 16));
      const ch = new MultiWriterChannel(ctx.store, {
        key: b4a.from(channelKeyHex, 'hex'),
        encryptionKey: options.encryptionKeyHex ? b4a.from(options.encryptionKeyHex, 'hex') : null,
        keyPair: writerKeyPair || undefined,
        swarm: ctx.swarm
      })

      const readyTimeoutMs = options.preferWritable ? 25000 : 10000
      const readyStart = Date.now()
      try {
        await Promise.race([
          ch.ready(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Channel ready timeout')), readyTimeoutMs))
        ])
      } catch (err) {
        try { await ch.close() } catch { /* best effort */ }
        throw err
      }

      console.log('[Storage] Channel ready in', Date.now() - readyStart, 'ms:', channelKeyHex.slice(0, 16));
      return ch
    }

    let ch
    try {
      ch = await openChannel(options.writerKeyName)
    } catch (err) {
      const canRetryWithoutWriter = Boolean(options.writerKeyName)
      if (!canRetryWithoutWriter) {
        console.error('[Storage] Channel ready failed:', err.message)
        throw err
      }

      console.log('[Storage] Channel load with writer key failed, retrying without writer key:', err?.message)
      ch = await openChannel(null)
    }

    if (options.preferWritable && !ch.writable) {
      console.log('[Storage] Channel loaded but not writable:', channelKeyHex.slice(0, 16))
    }
    ctx.channels.set(channelKeyHex, ch)

    // Ensure we join the channel topic so this device can FIND peers and replicate Autobase cores.
    // (Even non-writable peers must join; pairing setup is only for writable "members".)
    if (ctx.swarm) {
      try {
        if (ch.discoveryKey) ctx.swarm.join(ch.discoveryKey)
        await Promise.race([
          ch.setupPairing(ctx.swarm),
          new Promise(resolve => setTimeout(resolve, 15000))
        ])
      } catch (err) {
        console.log('[Storage] Pairing setup error (non-fatal):', err?.message)
      }
    }


    // Create wakeup session for this channel
    // This enables fast content announcements to peers when new videos/comments are added
    if (ctx.wakeup && ch.base) {
      try {
        ch.wakeupSession = ctx.wakeup.session(ch.base.key, {
          onannounce(announcement, peer) {
            console.log('[Wakeup] Peer announced new content for channel:', channelKeyHex.slice(0, 16));
            // Trigger sync - the announcement means peer has new data
            if (ch.base) {
              ch.base.update().catch(() => {});
            }
          }
        });
        console.log('[Storage] Wakeup session created for channel:', channelKeyHex.slice(0, 16));
      } catch (err) {
        console.log('[Storage] Wakeup session failed (non-fatal):', err?.message);
      }
    }

    return ch
  })()

  // Store the promise so concurrent callers can wait on the same load
  loadingChannels.set(channelKeyHex, loadPromise)

  try {
    const ch = await loadPromise
    return ch
  } finally {
    // Clean up loading state
    loadingChannels.delete(channelKeyHex)
  }
}

function isResourceClosing(resource) {
  if (!resource || typeof resource !== 'object') return true
  if (resource.closing || resource.closed) return true
  return false
}

function isCoreClosing(core) {
  if (!core || typeof core !== 'object') return true
  if (core.closing || core.closed) return true
  return false
}

function isChannelUsable(channel) {
  if (isResourceClosing(channel)) return false
  if (isResourceClosing(channel.base)) return false
  if (channel.view && isResourceClosing(channel.view)) return false
  return true
}

function isPublicBeeUsable(bee) {
  if (isResourceClosing(bee)) return false
  if (isCoreClosing(bee.core)) return false
  if (bee.bee && isResourceClosing(bee.bee)) return false
  return true
}

function getPublicBeeCache(ctx) {
  if (!ctx._publicBeeCache) ctx._publicBeeCache = new Map()
  return ctx._publicBeeCache
}

function getPublicBeeInflight(ctx) {
  if (!ctx._publicBeeInflight) ctx._publicBeeInflight = new Map()
  return ctx._publicBeeInflight
}

/**
 * Load a public channel Hyperbee for viewing.
 * This is the simple, auto-replicating layer for public feed viewers.
 * No Autobase complexity - just load the Hyperbee by key and it syncs via store.replicate().
 *
 * @param {import('./types.js').StorageContext} ctx
 * @param {string} publicBeeKeyHex - The public Hyperbee key (NOT the Autobase channel key)
 * @returns {Promise<PublicChannelBee>}
 */
export async function loadPublicBee(ctx, publicBeeKeyHex) {
  if (ctx.store.closed) {
    throw new Error('Corestore is closed')
  }

  const publicBeeCache = getPublicBeeCache(ctx)
  const publicBeeInflight = getPublicBeeInflight(ctx)

  return loadPublicBeeFromCache({
    cache: publicBeeCache,
    inflight: publicBeeInflight,
    key: publicBeeKeyHex,
    isUsable: (bee) => {
      if (isPublicBeeUsable(bee)) {
        log.debug('loadPublicBee returning cached', { publicBeeKey: publicBeeKeyHex.slice(0, 16) })
        return true
      }

      console.log('[Storage] loadPublicBee: evicting stale cached entry:', publicBeeKeyHex.slice(0, 16))
      return false
    },
    closeStale: async (bee) => {
      try { await bee?.close?.() } catch { /* best effort */ }
    },
    loadFresh: async () => {
      console.log('[Storage] loadPublicBee: loading:', publicBeeKeyHex.slice(0, 16))

      const bee = new PublicChannelBee(ctx.store, {
        key: publicBeeKeyHex
      })

      try {
        await Promise.race([
          bee.ready(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('PublicBee ready timeout')), 10000))
        ])
      } catch (err) {
        console.error('[Storage] loadPublicBee failed:', err.message)
        try { await bee.close() } catch { /* best effort */ }
        throw err
      }

      if (ctx.swarm && bee.discoveryKey) {
        retainSwarmDiscovery(ctx, bee.discoveryKey, {
          label: `publicBee:${publicBeeKeyHex.slice(0, 16)}`
        })
        console.log('[Storage] loadPublicBee: joined swarm for:', publicBeeKeyHex.slice(0, 16))
      }

      console.log('[Storage] loadPublicBee: ready:', publicBeeKeyHex.slice(0, 16), 'length:', bee.core?.length)
      return bee
    }
  })
}

/**
 * Create a new multi-writer channel and join it on the swarm.
 *
 * @param {import('./types.js').StorageContext} ctx
 * @param {Object} [options]
 * @returns {Promise<{channel: import('./channel/multi-writer-channel.js').MultiWriterChannel, channelKeyHex: string, encryptionKeyHex: string|null}>}
 */
export async function createChannel(ctx, options = {}) {
  if (!ctx.channels) ctx.channels = new Map()

  const suffix = b4a.toString(crypto.randomBytes(16), 'hex')
  const writerKeyName = typeof options.writerKeyName === 'string' && options.writerKeyName
    ? options.writerKeyName
    : `peartube-channel-writer:${suffix}`

  const { channelKeyHex: derivedChannelKeyHex, encryptionKeyHex: derivedEncryptionKeyHex } =
    await deriveDeterministicChannelSeed(ctx.store, {
      writerKeyName,
      encrypt: Boolean(options.encrypt)
    })

  const ch = new MultiWriterChannel(ctx.store, {
    key: derivedChannelKeyHex ? b4a.from(derivedChannelKeyHex, 'hex') : null,
    encryptionKey: derivedEncryptionKeyHex ? b4a.from(derivedEncryptionKeyHex, 'hex') : null,
    encrypt: Boolean(options.encrypt),
    swarm: ctx.swarm // Pass swarm for early replication setup
  })
  await ch.ready()

  if (!ch.writable) {
    // This should never happen for a brand-new channel; fail loudly so callers don't hang.
    throw new Error('Channel not writable after creation')
  }

  const channelKeyHex = ch.keyHex
  const encryptionKeyHex = ch.encryptionKey
    ? b4a.toString(ch.encryptionKey, 'hex')
    : derivedEncryptionKeyHex

  ctx.channels.set(channelKeyHex, ch)

  // Persist a marker so we can reliably distinguish multi-writer channels.
  try {
    await ctx.metaDb.put(`mw-channel:${channelKeyHex}`, { kind: 'autobase', createdAt: Date.now() })
  } catch { /* best effort */ }

  // Set up pairing and replication - AWAIT to ensure handlers are registered
  if (ctx.swarm) {
    try {
      if (ch.discoveryKey) ctx.swarm.join(ch.discoveryKey)
      // CRITICAL: AWAIT setupPairing to ensure base.replicate(conn) handlers are registered
      await ch.setupPairing(ctx.swarm)
    } catch (err) {
      console.log('[Storage] Pairing setup error (non-fatal):', err?.message)
    }
  }

  // Create wakeup session for this channel
  if (ctx.wakeup && ch.base) {
    try {
      ch.wakeupSession = ctx.wakeup.session(ch.base.key, {
        onannounce(announcement, peer) {
          console.log('[Wakeup] Peer announced new content for channel:', channelKeyHex.slice(0, 16));
          if (ch.base) {
            ch.base.update().catch(() => {});
          }
        }
      });
      console.log('[Storage] Wakeup session created for new channel:', channelKeyHex.slice(0, 16));
    } catch (err) {
      console.log('[Storage] Wakeup session failed (non-fatal):', err?.message);
    }
  }

  return { channel: ch, channelKeyHex, encryptionKeyHex, writerKeyName }
}

export async function deriveDeterministicChannelSeed(store, { writerKeyName, encrypt = false } = {}) {
  if (typeof writerKeyName !== 'string' || !writerKeyName) {
    return { channelKeyHex: null, encryptionKeyHex: null }
  }
  if (typeof store?.get !== 'function') {
    return { channelKeyHex: null, encryptionKeyHex: null }
  }

  const deriveSession = typeof store.session === 'function' ? store.session() : store
  let bootstrapCore = null

  try {
    await deriveSession.ready?.()
    bootstrapCore = deriveSession.get({ name: writerKeyName })
    await bootstrapCore.ready()
    return {
      channelKeyHex: bootstrapCore.key ? b4a.toString(bootstrapCore.key, 'hex') : null,
      encryptionKeyHex: encrypt && bootstrapCore.encryptionKey ? b4a.toString(bootstrapCore.encryptionKey, 'hex') : null
    }
  } finally {
    try { await bootstrapCore?.close?.() } catch { /* best effort */ }
    if (deriveSession !== store) {
      try { await deriveSession.close?.() } catch { /* best effort */ }
    }
  }
}

/**
 * Pair a new device into an existing channel using an invite code.
 *
 * @param {import('./types.js').StorageContext} ctx
 * @param {string} inviteCode
 * @param {Object} [options]
 * @param {string} [options.deviceName]
 * @returns {Promise<{channel: import('./channel/multi-writer-channel.js').MultiWriterChannel, channelKeyHex: string}>}
 */
export async function pairDevice(ctx, inviteCode, options = {}) {
  const pairer = new ChannelPairer(ctx.store, inviteCode, {
    swarm: ctx.swarm,
    deviceName: options.deviceName || ''
  })
  await pairer.ready()
  const channel = await pairer.finished()
  const channelKeyHex = channel.keyHex
  if (!ctx.channels) ctx.channels = new Map()
  ctx.channels.set(channelKeyHex, channel)

  // Persist marker for multi-writer channel
  try {
    await ctx.metaDb.put(`mw-channel:${channelKeyHex}`, { kind: 'autobase', createdAt: Date.now() })
  } catch { /* best effort */ }

  // Set up pairing and replication - AWAIT to ensure base.replicate(conn) handlers are registered
  if (ctx.swarm) {
    try {
      if (channel.discoveryKey) ctx.swarm.join(channel.discoveryKey)
      // CRITICAL: AWAIT setupPairing to ensure base.replicate(conn) handlers are registered
      await channel.setupPairing(ctx.swarm)
    } catch (err) {
      console.log('[Storage] Pairing setup error (non-fatal):', err?.message)
    }
  }

  // Create wakeup session for paired channel
  if (ctx.wakeup && channel.base) {
    try {
      channel.wakeupSession = ctx.wakeup.session(channel.base.key, {
        onannounce(announcement, peer) {
          console.log('[Wakeup] Peer announced new content for paired channel:', channelKeyHex.slice(0, 16));
          if (channel.base) {
            channel.base.update().catch(() => {});
          }
        }
      });
      console.log('[Storage] Wakeup session created for paired channel:', channelKeyHex.slice(0, 16));
    } catch (err) {
      console.log('[Storage] Wakeup session failed (non-fatal):', err?.message);
    }
  }

  return { channel, channelKeyHex }
}

/**
 * Get video URL from Hyperblobs - INSTANT version (no sync wait)
 * Generates URL immediately, lets blob server fetch data on-demand.
 * @param {Object} ctx - Storage context
 * @param {string} blobsCoreKeyHex - Hex key of the blobs Hypercore
 * @param {Object} blobId - Blob ID with {blockOffset, blockLength, byteOffset, byteLength}
 * @param {Object} [options]
 * @param {string} [options.mimeType] - MIME type (default: video/mp4)
 * @returns {{url: string}} - Returns synchronously!
 */
export function getVideoUrlInstant(ctx, blobsCoreKeyHex, blobId, options = {}) {
  console.log('[Storage] GET_VIDEO_URL_INSTANT:', blobsCoreKeyHex?.slice(0, 16));

  if (!blobsCoreKeyHex || blobsCoreKeyHex.length !== 64) {
    throw new Error('Invalid blobsCoreKeyHex')
  }

  if (!ctx.blobServer) {
    throw new Error('BlobServer not initialized')
  }

  const keyBuffer = b4a.from(blobsCoreKeyHex, 'hex')
  const mimeType = options.mimeType || 'video/mp4'

  // Parse blobId string to object if needed
  const blob = normalizeBlobRefInput(blobId)
  if (!blob) {
    throw new Error('Invalid blob ID format')
  }

  // Generate URL immediately - blob server fetches data on-demand
  const url = ctx.blobServer.getLink(keyBuffer, {
    blob,
    type: mimeType,
    host: ctx.blobServerHost || '127.0.0.1',
    port: ctx.blobServer?.port || ctx.blobServerPort
  });

  // Kick off background sync (don't await)
  const blobsCore = ctx.store.get(keyBuffer)
  blobsCore.ready().then(() => {
    if (ctx.swarm && blobsCore.discoveryKey) {
      try {
        retainSwarmDiscovery(ctx, blobsCore.discoveryKey, {
          label: `blobs:${blobsCoreKeyHex.slice(0, 16)}`
        })
      } catch { /* best effort */ }
    }
    // Trigger update in background to find peers
    blobsCore.update().catch(() => {})
  }).catch(() => {})

  console.log('[Storage] Instant URL generated:', url.replace(/token=[^&]+/, 'token=***'));
  return { url };
}

/**
 * Get video URL from Hyperblobs (new multi-writer architecture)
 * @param {Object} ctx - Storage context
 * @param {string} blobsCoreKeyHex - Hex key of the blobs Hypercore
 * @param {Object} blobId - Blob ID with {blockOffset, blockLength, byteOffset, byteLength}
 * @param {Object} [options]
 * @param {string} [options.mimeType] - MIME type (default: video/mp4)
 * @param {boolean} [options.instant] - If true, return URL immediately without waiting
 * @returns {Promise<{url: string}>}
 */
export async function getVideoUrlFromBlob(ctx, blobsCoreKeyHex, blobId, options = {}) {
  // Fast path: instant URL generation
  if (options.instant) {
    return getVideoUrlInstant(ctx, blobsCoreKeyHex, blobId, options)
  }

  console.log('[Storage] GET_VIDEO_URL_FROM_BLOB:', blobsCoreKeyHex?.slice(0, 16), 'blobId:', JSON.stringify(blobId), 'keyLength:', blobsCoreKeyHex?.length);

  if (!blobsCoreKeyHex) {
    throw new Error('Missing blobsCoreKeyHex')
  }

  // Validate key length - should be 64 hex chars (32 bytes)
  if (blobsCoreKeyHex.length !== 64) {
    throw new Error(`Invalid blobsCoreKey length: ${blobsCoreKeyHex.length} (expected 64). Key is truncated or corrupted. Full key: ${blobsCoreKeyHex}`)
  }

  // Load the blobs core
  console.log('[Storage] GET_VIDEO_URL_FROM_BLOB: converting hex to buffer...');
  const keyBuffer = b4a.from(blobsCoreKeyHex, 'hex')
  console.log('[Storage] GET_VIDEO_URL_FROM_BLOB: keyBuffer length:', keyBuffer.length, 'bytes');

  console.log('[Storage] GET_VIDEO_URL_FROM_BLOB: calling store.get...');
  const blobsCore = ctx.store.get(keyBuffer)
  console.log('[Storage] GET_VIDEO_URL_FROM_BLOB: store.get returned, calling ready...');

  await blobsCore.ready()
  console.log('[Storage] GET_VIDEO_URL_FROM_BLOB: ready() complete');

  if (!blobsCore.key) {
    throw new Error('Blobs core key not available after ready')
  }

  console.log('[Storage] Blobs core ready, key:', b4a.toString(blobsCore.key, 'hex').slice(0, 16));

  // Join swarm for the blobs core discovery key
  if (ctx.swarm && blobsCore.discoveryKey) {
    try {
      retainSwarmDiscovery(ctx, blobsCore.discoveryKey, {
        label: `blobs:${blobsCoreKeyHex.slice(0, 16)}`
      })
    } catch (err) {
      console.log('[Storage] Swarm join error (non-fatal):', err?.message)
    }
  }

  // Wait briefly for peers if needed (reduced from 15s to 5s for faster startup)
  try {
    await Promise.race([
      blobsCore.update({ wait: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('blobs core update timeout')), 10000))
    ])
  } catch { /* best effort */ }

  const mimeType = options.mimeType || 'video/mp4'

  // Parse blobId string to object if needed
  // blobId can be a string like "0:28174:0:1846355808" or an object
  const blob = normalizeBlobRefInput(blobId)
  if (!blob) {
    throw new Error('Invalid blob ID format')
  }

  // Generate direct blob URL
  console.log('[Storage] GET_VIDEO_URL_FROM_BLOB: blobsCore.key type:', typeof blobsCore.key, 'isBuffer:', Buffer.isBuffer(blobsCore.key), 'length:', blobsCore.key?.length);
  console.log('[Storage] GET_VIDEO_URL_FROM_BLOB: blobsCore.key hex:', blobsCore.key ? b4a.toString(blobsCore.key, 'hex') : 'NULL');
  console.log('[Storage] GET_VIDEO_URL_FROM_BLOB: blob:', JSON.stringify(blob));
  console.log('[Storage] GET_VIDEO_URL_FROM_BLOB: ctx.blobServer exists:', !!ctx.blobServer, 'port:', ctx.blobServer?.port);
  
  if (!ctx.blobServer) {
    throw new Error('BlobServer not initialized')
  }
  
  try {
    // NOTE: hypercore-blob-server.getLink() already includes a token parameter for access control
    // Do NOT append additional tokens - it causes malformed URLs with duplicate token params
    const url = ctx.blobServer.getLink(blobsCore.key, {
      blob,
      type: mimeType,
      host: ctx.blobServerHost || '127.0.0.1',
      port: ctx.blobServer?.port || ctx.blobServerPort
    });

    console.log('[Storage] Direct blob URL (hyperblobs):', url.replace(/token=[^&]+/, 'token=***'));
    return { url };
  } catch (err) {
    console.error('[Storage] GET_VIDEO_URL_FROM_BLOB: blobServer.getLink FAILED:', err.message, err.stack);
    throw err;
  }
}

export async function shutdownBackend(ctx) {
  if (!ctx) return
  if (ctx._isShutdown) return

  ctx._isShutdown = true
  ctx.isShuttingDown = true

  async function runShutdownStep(label, fn, timeoutMs = 5000) {
    let timeoutId = null
    let timedOut = false

    try {
      await Promise.race([
        Promise.resolve().then(fn),
        new Promise((resolve) => {
          timeoutId = setTimeout(() => {
            timedOut = true
            resolve()
          }, timeoutMs)
        })
      ])
    } catch (err) {
      console.log(`[Backend] Shutdown: ${label} failed (non-fatal):`, err?.message)
      return
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }

    if (timedOut) {
      console.log(`[Backend] Shutdown: ${label} timed out after ${timeoutMs}ms (continuing)`)
    }
  }

  const shutdownBody = async () => {
    if (ctx.publicFeed) {
      console.log('[Backend] Shutdown: persisting public feed cache...')
      try {
        if (typeof ctx.publicFeed._persistDiscoveredNow === 'function') {
          await ctx.publicFeed._persistDiscoveredNow()
        }
      } catch (err) {
        console.log('[Backend] Shutdown: public feed cache persist failed (non-fatal):', err?.message)
      }
    }

    if (ctx.channels) {
      const channelCount = ctx.channels.size
      console.log(`[Backend] Shutdown: closing ${channelCount} channels...`)
      try {
        await Promise.allSettled([...ctx.channels.values()].map(async (ch) => {
          try {
            if (ch && typeof ch.close === 'function') {
              await ch.close()
            }
          } catch { /* best effort */ }
        }))
      } catch (err) {
        console.log('[Backend] Shutdown: channel close batch failed (non-fatal):', err?.message)
      }
    }

    if (ctx._publicBeeCache) {
      const publicBeeCount = ctx._publicBeeCache.size
      console.log(`[Backend] Shutdown: closing ${publicBeeCount} publicBeeCache entries...`)
      try {
        await Promise.allSettled([...ctx._publicBeeCache.values()].map(async (bee) => {
          try {
            if (bee && typeof bee.close === 'function') {
              await bee.close()
            }
          } catch { /* best effort */ }
        }))
      } catch (err) {
        console.log('[Backend] Shutdown: publicBeeCache close batch failed (non-fatal):', err?.message)
      }
    }

    if (ctx.publicFeed) {
      console.log('[Backend] Shutdown: stopping publicFeed...')
      await runShutdownStep('publicFeed stop', async () => {
        await ctx.publicFeed.stop()
      }, 2000)
    }

    if (ctx._swarmDiscoveryHandles) {
      const discoveryCount = ctx._swarmDiscoveryHandles.size
      console.log(`[Backend] Shutdown: destroying ${discoveryCount} retained swarm discoveries...`)
      for (const handle of ctx._swarmDiscoveryHandles.values()) {
        try {
          handle?.destroy?.()
        } catch { /* best effort */ }
      }
      ctx._swarmDiscoveryHandles.clear()
    }

    if (ctx.blobServer) {
      console.log('[Backend] Shutdown: closing blobServer...')
      await runShutdownStep('blobServer close', async () => {
        await ctx.blobServer.close()
      }, 2000)
    }

    if (ctx.swarm) {
      console.log('[Backend] Shutdown: destroying swarm...')
      await runShutdownStep('swarm destroy', async () => {
        await ctx.swarm.destroy()
      }, 2000)
    }

    if (ctx.metaDb) {
      console.log('[Backend] Shutdown: closing metaDb...')
      await runShutdownStep('metaDb close', async () => {
        await ctx.metaDb.close()
      }, 2000)
    }

    if (ctx.metaCore) {
      console.log('[Backend] Shutdown: closing metaCore...')
      await runShutdownStep('metaCore close', async () => {
        await ctx.metaCore.close()
      }, 2000)
    }

    if (ctx.store) {
      const storeDb = ctx.store?.storage?.db
      if (storeDb && typeof storeDb.flush === 'function') {
        console.log('[Backend] Shutdown: flushing store db...')
        try {
          await storeDb.flush()
        } catch (err) {
          console.log('[Backend] Shutdown: store db flush failed (non-fatal):', err?.message)
        }
      }

      console.log('[Backend] Shutdown: closing store...')
      await runShutdownStep('store close', async () => {
        await ctx.store.close()
      }, 5000)
    }
  }

  await shutdownBody()
  console.log('[Backend] Shutdown complete')
}

// =============================================================================
// Mobile Lifecycle Management
// =============================================================================

/**
 * Suspend networking for mobile background state.
 * Call this when the app goes to background to save battery and avoid connection issues.
 * Uses Hyperswarm's built-in suspend() which gracefully pauses DHT and connections.
 *
 * @returns {Promise<void>}
 */
export async function suspendNetworking() {
  console.log('[CastDiag] suspendNetworking called - will check cast state before suspending');
  
  // GUARD: Skip entire suspend when cast is active.
  // The foreground service keeps the process alive, and the cast session needs
  // both the blob server (for serving video) and the swarm (for fetching sparse data).
  if (isCastActive()) {
    console.log('[Network] Skipping suspend — cast is active');
    console.log('[CastDiag] suspendNetworking: SKIPPED (cast is active)');
    return;
  }
  
  console.log('[Network] Suspending...');
  try {
    // Mark all wakeup sessions as inactive
    if (globalChannels) {
      for (const channel of globalChannels.values()) {
        if (channel.wakeupSession) {
          try {
            channel.wakeupSession.inactive();
          } catch (err) {
            // Non-fatal
          }
        }
      }
      console.log('[Network] Wakeup sessions marked inactive');
    }

    if (globalSwarm) {
      await globalSwarm.suspend();
      console.log('[Network] Swarm suspended');
    }
    if (globalKnownPeerCache) {
      try { await globalKnownPeerCache.flush() } catch { /* best effort */ }
    }
    if (globalBlobServer) {
      console.log('[CastDiag] suspendNetworking: suspending BlobServer (cast not active)');
      await globalBlobServer.suspend();
      console.log('[Network] BlobServer suspended');
    }
    console.log('[Network] Suspended successfully');
  } catch (err) {
    console.log('[Network] Suspend error (non-fatal):', err?.message);
  }
}

/**
 * Set the cast active flag to prevent network suspension during active cast sessions.
 * @param {boolean} active - Whether cast is currently active
 */
export function setCastActive(active) {
  globalCastActive = active
  console.log('[CastDiag] castActive flag set to:', active)
  if (active) {
    startBlobServerWatchdog()
  } else {
    if (watchdogTimer) {
      clearInterval(watchdogTimer)
      watchdogTimer = null
      console.log('[CastDiag] BlobServer watchdog stopped')
    }
  }
}

/**
 * Check if cast is currently active.
 * @returns {boolean} True if cast is active
 */
export function isCastActive() {
  return globalCastActive
}

/**
 * Start a watchdog that probes the blob server every 30 seconds during active cast.
 * If the blob server is unresponsive, force-resume it.
 */
export function startBlobServerWatchdog() {
  if (watchdogTimer) return
  console.log('[CastDiag] BlobServer watchdog started')
  watchdogTimer = setInterval(async () => {
    if (!isCastActive()) {
      clearInterval(watchdogTimer)
      watchdogTimer = null
      console.log('[CastDiag] BlobServer watchdog stopped (cast no longer active)')
      return
    }

    const port = globalBlobServer?.port
    if (!port) {
      console.log('[CastDiag] BlobServer watchdog: no port available, skipping probe')
      return
    }

    const httpModule = await ensureHttpModule()
    if (!httpModule?.request) {
      console.log('[CastDiag] BlobServer watchdog: HTTP module unavailable, skipping probe')
      return
    }

    const req = httpModule.request({
      hostname: '127.0.0.1',
      port,
      path: '/',
      method: 'HEAD',
      timeout: 5000
    }, (res) => {
      res.resume()
      console.log('[CastDiag] BlobServer watchdog: healthy (status ' + res.statusCode + ')')
    })

    req.on('timeout', () => {
      req.destroy()
      console.log('[CastDiag] BlobServer unresponsive during cast — force resuming')
      if (globalBlobServer) globalBlobServer.resume()
    })

    req.on('error', (err) => {
      console.log('[CastDiag] BlobServer unresponsive during cast — force resuming')
      if (globalBlobServer) globalBlobServer.resume()
    })

    req.end()
  }, 30000)
}

export async function prefetchVideoForCast(drive, filePath, signal) {
  if (!drive || typeof drive.createReadStream !== 'function') {
    throw new Error('Invalid drive passed to prefetchVideoForCast')
  }
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid filePath passed to prefetchVideoForCast')
  }

  const abortError = () => {
    const err = new Error('Cast pre-buffer aborted')
    err.name = 'AbortError'
    return err
  }

  if (signal?.aborted) throw abortError()

  let totalBytes = 0
  try {
    const entry = await drive.entry(filePath)
    totalBytes = Number(
      entry?.value?.blob?.byteLength ??
      entry?.value?.byteLength ??
      entry?.value?.size ??
      entry?.size ??
      0
    ) || 0
  } catch {
    totalBytes = 0
  }

  const driveKeyHex = drive?.key ? b4a.toString(drive.key, 'hex') : 'unknown'
  const logKey = driveKeyHex === 'unknown' ? 'unknown' : driveKeyHex.slice(0, 16)
  let bytesRead = 0
  let chunkCount = 0
  let nextPercentLog = 10
  const chunkLogInterval = 256

  const stream = drive.createReadStream(filePath)
  let settled = false

  const onAbort = () => {
    try {
      stream.destroy(abortError())
    } catch { /* best effort */ }
  }
  if (signal) signal.addEventListener('abort', onAbort)

  try {
    await new Promise((resolve, reject) => {
      stream.on('data', (chunk) => {
        const chunkLen = chunk?.byteLength || chunk?.length || 0
        bytesRead += chunkLen
        chunkCount++

        if (totalBytes > 0) {
          const percent = Math.max(0, Math.min(100, Math.floor((bytesRead / totalBytes) * 100)))
          if (percent >= nextPercentLog) {
            console.log(`[CastDiag] Pre-buffering video for cast: ${logKey} — ${percent}%`)
            nextPercentLog += 10
          }
        } else if (chunkCount % chunkLogInterval === 0) {
          console.log(`[CastDiag] Pre-buffering video for cast: ${logKey} — ${chunkCount} chunks`)
        }
      })

      stream.once('end', () => {
        settled = true
        if (totalBytes > 0) {
          console.log(`[CastDiag] Pre-buffering video for cast: ${logKey} — 100%`)
        }
        resolve()
      })
      stream.once('error', (err) => {
        settled = true
        reject(err)
      })
    })
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
    if (!settled) {
      try { stream.destroy() } catch { /* best effort */ }
    }
  }
}

/**
 * Resume networking when app returns to foreground.
 * Resumes DHT operations and re-establishes connections.
 *
 * @returns {Promise<void>}
 */
export async function resumeNetworking() {
  console.log('[Network] Resuming...');
  try {
    if (globalSwarm) {
      await globalSwarm.resume();
      console.log('[Network] Swarm resumed, connections:', globalSwarm.connections?.size || 0);
      if (!globalSwarm._peartubeOffline) {
        void dialPersistedPeers(globalSwarm, globalMetaDb, { reason: 'resume' }).catch((err) => {
          console.log('[Network] Resume dial skipped:', err?.message)
        })
      }
    }
    if (globalBlobServer) {
      await globalBlobServer.resume();
      console.log('[Network] BlobServer resumed');
    }

    // Mark all wakeup sessions as active
    if (globalChannels) {
      for (const channel of globalChannels.values()) {
        if (channel.wakeupSession) {
          try {
            channel.wakeupSession.active();
          } catch (err) {
            // Non-fatal
          }
        }
      }
      console.log('[Network] Wakeup sessions marked active');
    }

    console.log('[Network] Resumed successfully');
  } catch (err) {
    console.log('[Network] Resume error (non-fatal):', err?.message);
  }
}

// =============================================================================
// Network Debugging
// =============================================================================

/**
 * Get network stats as JSON for debugging.
 * Uses hyperswarm-stats to provide detailed connection and DHT information.
 *
 * @returns {Object|null} Stats object or null if stats not available
 */
export function getNetworkStats() {
  const diagnostics = globalSwarmDiagnostics?.snapshot?.() || null
  const startupTiming = globalNetworkStartupTiming?.snapshot?.() || null
  if (!networkStats) {
    // Fallback: return basic stats from swarm
    if (globalSwarm) {
      return {
        connections: globalSwarm.connections?.size || 0,
        peers: globalSwarm.peers?.size || 0,
        offline: Boolean(globalSwarm._peartubeOffline),
        offlineReason: globalSwarm._peartubeOfflineReason || null,
        listenResolved: Boolean(globalSwarm._peartubeListenResolved),
        peerPoolJoined: Boolean(globalPeerPoolDiscovery),
        peerPoolTopicHex: globalPeerPoolTopicHex,
        dht: {
          firewalled: globalSwarm.dht?.firewalled ?? null,
          bootstrapped: globalSwarm.dht?.bootstrapped ?? null,
          ephemeral: globalSwarm.dht?.ephemeral ?? null,
          online: globalSwarm.dht?.online ?? null
        },
        hyperswarm: diagnostics,
        startupTiming
      };
    }
    return null;
  }

  try {
    const stats = networkStats.toJson();
    return { ...stats, hyperswarm: diagnostics, startupTiming }
  } catch (err) {
    console.log('[Network] Stats toJson error:', err?.message);
    return diagnostics || startupTiming ? { hyperswarm: diagnostics, startupTiming } : null;
  }
}

/**
 * Get human-readable network stats for debugging.
 *
 * @returns {string} Human-readable stats or message if not available
 */
export function getNetworkStatsReadable() {
  if (!networkStats) {
    // Fallback: create basic readable output
    if (globalSwarm) {
      const dht = globalSwarm.dht;
      return [
        `Connections: ${globalSwarm.connections?.size || 0}`,
        `Peers discovered: ${globalSwarm.peers?.size || 0}`,
        `Swarm offline: ${Boolean(globalSwarm._peartubeOffline)}`,
        `Swarm offline reason: ${globalSwarm._peartubeOfflineReason || 'none'}`,
        `Swarm listen resolved: ${Boolean(globalSwarm._peartubeListenResolved)}`,
        `Peer pool joined: ${Boolean(globalPeerPoolDiscovery)}`,
        `Peer pool topic: ${globalPeerPoolTopicHex || 'unknown'}`,
        `DHT firewalled: ${dht?.firewalled ?? 'unknown'}`,
        `DHT bootstrapped: ${dht?.bootstrapped ?? 'unknown'}`,
        `DHT online: ${dht?.online ?? 'unknown'}`
      ].join('\n');
    }
    return 'Network stats not available';
  }

  try {
    return networkStats.toString();
  } catch (err) {
    return `Stats error: ${err?.message}`;
  }
}
