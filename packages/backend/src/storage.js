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
import { assertLoopbackPlaybackUrl } from './playback/transport-guard.js'
import { PublicChannelBee } from './channel/public-channel-bee.js'
import { loadPublicBeeFromCache } from './public-bee-loader.js'
import { logger } from './logger.js'
import { relocateLegacyBlindPeerDir, relocateLegacyCorestoreDir, relocateLegacyLogsDir } from './storage-layout.js'
import { cleanupFailedCorestoreOpen } from './corestore-cleanup.js'
import {
  loadBareOrNodeFsModule,
  loadBareOrNodeHttpModule,
  loadBareOrNodePathModule,
  loadHyperswarmModule,
  resolveBareOrNodeFsModuleSync,
  resolveBareOrNodePathModuleSync,
} from './runtime-modules.js'
import { normalizeBlobRefInput } from './blob-ref.js'
import { redactCapabilityUrl } from './capability-url.js'
import { createKnownPeerCache, loadKnownPeers } from './known-peers.js'
import { readStoredIdentityRecords } from './identity-state.js'
import { createMetaSubspaces, migrateMetaSubspaces } from './meta-subspaces.js'
import { prioritizeBlobServerRangeRequest, releaseAllPrioritizedBlobRanges } from './blob-range-priority.js'
import { serveThumbnailHttpRequest } from './thumbnail-http.js'
import { serveVideoRangeHttpRequest } from './video-range-http.js'
import { installExpectedBlobRequestCancellationHandler } from './blob-request-cancellation.js'
import { appendDebugLine } from './debug-log.js'
import { DEFAULT_STORED_PROTOCOL_MIGRATIONS, prepareStoredProtocolState } from './stored-protocol.js'
export { DEFAULT_STORED_PROTOCOL_MIGRATIONS, prepareStoredProtocolState }

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000

function createLifecycleAbortController() {
  const AbortControllerCtor = globalThis?.AbortController
  if (typeof AbortControllerCtor === 'function') return new AbortControllerCtor()

  let aborted = false
  const listeners = new Map()
  const signal = {
    onabort: null,
    get aborted() {
      return aborted
    },
    addEventListener(type, listener, options = {}) {
      if (type !== 'abort' || (!listener?.handleEvent && typeof listener !== 'function')) return
      listeners.set(listener, options?.once === true)
    },
    removeEventListener(type, listener) {
      if (type === 'abort') listeners.delete(listener)
    },
  }

  return {
    signal,
    abort() {
      if (aborted) return
      aborted = true
      const event = { type: 'abort', target: signal, currentTarget: signal }
      const notify = (listener) => {
        try {
          if (typeof listener === 'function') listener.call(signal, event)
          else listener.handleEvent(event)
        } catch (error) {
          console.warn('[BackendLifecycle] abort listener failed:', error?.message || error)
        }
      }
      const onabort = signal.onabort
      const pendingListeners = Array.from(listeners.keys())
      listeners.clear()
      if (typeof onabort === 'function') notify(onabort)
      for (const listener of pendingListeners) notify(listener)
    },
  }
}

export function createBackendLifecycle({
  scheduleDeferred = typeof setImmediate === 'function' ? setImmediate : (fn) => setTimeout(fn, 0),
  cancelDeferred = typeof clearImmediate === 'function' ? clearImmediate : clearTimeout,
  shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
} = {}) {
  const controller = createLifecycleAbortController()
  const ownership = new Set()
  let shutdownPromise = null

  const runBounded = async (entry) => {
    let timeoutId = null
    let timedOut = false
    try {
      await Promise.race([
        Promise.resolve().then(entry.cleanup),
        new Promise((resolve) => {
          timeoutId = setTimeout(() => {
            timedOut = true
            resolve()
          }, entry.timeoutMs)
        }),
      ])
    } catch (error) {
      console.warn(`[BackendLifecycle] ${entry.label} cleanup failed:`, error?.message || error)
    } finally {
      clearTimeout(timeoutId)
    }
    if (timedOut) {
      console.warn(`[BackendLifecycle] ${entry.label} cleanup timed out after ${entry.timeoutMs}ms`)
    }
  }

  const consume = (entry) => {
    if (entry.cleanupPromise) return entry.cleanupPromise
    if (!entry.active) return Promise.resolve()
    entry.active = false
    entry.cleanupPromise = runBounded(entry).finally(() => {
      ownership.delete(entry)
    })
    return entry.cleanupPromise
  }

  const own = (label, cleanup, timeoutMs = shutdownTimeoutMs) => {
    if (typeof cleanup !== 'function') throw new TypeError(`Cleanup for ${label} must be a function`)
    const entry = {
      label,
      cleanup,
      timeoutMs: Math.max(1, Number(timeoutMs) || shutdownTimeoutMs),
      active: true,
      cleanupPromise: null,
    }
    ownership.add(entry)

    const registration = {
      release() {
        if (!entry.active) return
        entry.active = false
        ownership.delete(entry)
      },
      cleanup() {
        return consume(entry)
      },
    }

    if (controller.signal.aborted) void registration.cleanup()
    return registration
  }

  const ownResource = (label, resource, methods = ['close', 'destroy', 'stop'], timeoutMs) => {
    const candidates = Array.isArray(methods) ? methods : [methods]
    return own(label, async () => {
      if (resource?.closed === true) return
      for (const method of candidates) {
        if (typeof resource?.[method] === 'function') {
          await resource[method]()
          return
        }
      }
    }, timeoutMs)
  }

  const ownTimer = (label, handle, cancel = clearTimeout) =>
    own(label, () => cancel(handle), shutdownTimeoutMs)

  const defer = (label, work) => {
    if (controller.signal.aborted) return null
    let handle = null
    let task = null
    const registration = own(label, async () => {
      if (handle !== null) {
        cancelDeferred(handle)
        handle = null
      }
      if (task) await task
    })
    try {
      handle = scheduleDeferred(() => {
        handle = null
        task = Promise.resolve()
          .then(() => work(controller.signal))
          .catch((error) => {
            if (!controller.signal.aborted) {
              console.warn(`[BackendLifecycle] ${label} failed:`, error?.message || error)
            }
          })
          .finally(() => registration.release())
      })
    } catch (error) {
      registration.release()
      throw error
    }
    return registration
  }

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise
    controller.abort()
    shutdownPromise = (async () => {
      const entries = Array.from(ownership)
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        await consume(entries[index])
      }
    })()
    return shutdownPromise
  }

  return {
    signal: controller.signal,
    own,
    ownResource,
    ownTimer,
    defer,
    shutdown,
    get ownedCount() {
      return ownership.size
    },
  }
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

const log = logger('Storage')

// How many of the most-recently-seen persisted known peers to proactively
// re-dial at startup for warm reconnect. Bounded so a firewalled client warms
// its best recent peers without flooding the swarm with stale dials.
const KNOWN_PEER_REDIAL_LIMIT = 16
const DESKTOP_SWARM_DEFAULTS = Object.freeze({
  maxParallel: 12,
  maxPeers: 96
})
const DESKTOP_PEER_POOL_WARM_REFRESH_INTERVALS_MS = Object.freeze([3000, 10000, 30000])
const DESKTOP_PEER_POOL_MIN_CONNECTIONS = 4

// Network stats for debugging connection issues
let HyperswarmStats = null
let optionalStorageDepsReady = null
let hyperswarmModuleReady = null
const HYPERSWARM_MODULE_TIMEOUT_MS = 5000

// Global network stats instance (set after swarm is created)
let networkStats = null;

function copyDefinedOptions(source, keys) {
  const out = {}
  if (!source || typeof source !== 'object') return out
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  return out
}

function summarizeSwarmOptions(options = {}) {
  if (!options || typeof options !== 'object') return null
  const summary = { ...options }
  if (summary.keyPair) {
    summary.keyPair = {
      publicKey: shortKeyHex(summary.keyPair.publicKey)
    }
  }
  if (summary.dht) summary.dht = '[custom-dht]'
  if (typeof summary.firewall === 'function') summary.firewall = '[function]'
  if (typeof summary.relayThrough === 'function') summary.relayThrough = '[function]'
  return summary
}

export function resolveHyperswarmOptions({
  keyPair,
  platform = 'desktop',
  network = {},
  swarmOptions = {}
} = {}) {
  const normalizedPlatform = platform === 'mobile' ? 'mobile' : 'desktop'
  const networkOptions = copyDefinedOptions(network, [
    'bootstrap',
    'nodes',
    'port',
    'deferRandomPunch',
    'randomPunchInterval'
  ])
  const explicitOptions = swarmOptions && typeof swarmOptions === 'object' ? { ...swarmOptions } : {}

  // Storage owns the persisted Hyperswarm identity; launch-time tuning must not
  // replace it with an ephemeral caller-provided keypair.
  delete explicitOptions.keyPair

  return {
    ...networkOptions,
    ...(normalizedPlatform === 'desktop' ? DESKTOP_SWARM_DEFAULTS : {}),
    ...explicitOptions,
    keyPair
  }
}

export function schedulePeerPoolWarmupRefreshes({
  platform = 'desktop',
  swarm,
  discovery,
  startupTiming = null,
  intervals = DESKTOP_PEER_POOL_WARM_REFRESH_INTERVALS_MS,
  minConnections = DESKTOP_PEER_POOL_MIN_CONNECTIONS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (platform !== 'desktop') return { scheduled: 0, reason: 'non-desktop', cancel() {} }
  if (!swarm || !discovery || typeof discovery.refresh !== 'function') {
    return { scheduled: 0, reason: 'missing-discovery-refresh', cancel() {} }
  }
  const currentConnections = Number(swarm.connections?.size || 0)
  if (currentConnections >= minConnections) {
    return { scheduled: 0, reason: 'connection-target-met', cancel() {} }
  }

  let cancelled = false
  const timers = []

  intervals.forEach((delayMs, index) => {
    const timer = setTimer(async () => {
      if (cancelled) return
      const connections = Number(swarm.connections?.size || 0)
      const connecting = Number(swarm.connecting || 0)
      if (connections >= minConnections) {
        startupTiming?.record?.('peer-pool-warm-refresh-skipped', {
          attempt: index + 1,
          connections,
          connecting,
          reason: 'connection-target-met'
        })
        return
      }

      startupTiming?.record?.('peer-pool-warm-refresh', {
        attempt: index + 1,
        connections,
        connecting
      })
      try {
        await discovery.refresh({ server: true, client: true })
      } catch (err) {
        startupTiming?.record?.('peer-pool-warm-refresh-failed', {
          attempt: index + 1,
          connections,
          connecting,
          error: err?.message || String(err)
        })
      }
    }, delayMs)
    timers.push(timer)
  })

  return {
    scheduled: timers.length,
    reason: 'scheduled',
    cancel() {
      cancelled = true
      for (const timer of timers) {
        try { clearTimer(timer) } catch { /* best effort */ }
      }
    }
  }
}

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
let globalSwarmDiagnostics = null;
let globalNetworkStartupTiming = null;
let globalKnownPeerCache = null;
let globalMetaDb = null;
let globalPlaybackActive = false;
let globalPlaybackActiveUntil = 0;
let globalPlaybackActiveUpdatedAt = 0;

// Cast active flag — set by API handlers to prevent network suspension during active cast
let globalCastActive = false
let watchdogTimer = null

export function installBackendCleanupStack(ctx, options = {}) {
  if (!ctx || typeof ctx !== 'object') return ctx
  if (ctx._cleanupStack && typeof ctx.registerCleanup === 'function') return ctx

  const stack = []
  let cleanupPromise = null
  const defaultTimeoutMs = Math.max(1, Number(options.defaultTimeoutMs || 5000) || 5000)

  ctx._cleanupStack = stack
  ctx._cleanupStackConsumed = false
  ctx.isShuttingDown = Boolean(ctx.isShuttingDown)

  ctx.registerCleanup = function registerCleanup(label, cleanup, entryOptions = {}) {
    if (typeof cleanup !== 'function') return { cancel() {} }
    const entry = {
      label: String(label || `cleanup:${stack.length + 1}`),
      cleanup,
      timeoutMs: Math.max(1, Number(entryOptions.timeoutMs || defaultTimeoutMs) || defaultTimeoutMs),
      cancelled: false,
      ran: false,
    }
    stack.push(entry)
    return {
      cancel() {
        entry.cancelled = true
      }
    }
  }

  ctx.registerCleanupTimer = function registerCleanupTimer(label, timer, clearFn = clearTimeout) {
    return ctx.registerCleanup(label, () => {
      if (timer) clearFn(timer)
    }, { timeoutMs: 100 })
  }

  ctx._runCleanupStack = async function runCleanupStack(runShutdownStep) {
    if (cleanupPromise) return cleanupPromise
    ctx.isShuttingDown = true
    cleanupPromise = (async () => {
      for (let index = stack.length - 1; index >= 0; index--) {
        const entry = stack[index]
        if (!entry || entry.cancelled || entry.ran) continue
        entry.ran = true
        await runShutdownStep(entry.label, entry.cleanup, entry.timeoutMs)
      }
      ctx._cleanupStackConsumed = true
    })()
    return cleanupPromise
  }

  return ctx
}

const PLAYBACK_ACTIVITY_TTL_MS = 60 * 60 * 1000

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

const DHT_ROUTING_TABLE_KEY = 'dht-routing-table-v1'
const DHT_ROUTING_TABLE_MAX_ENTRIES = 128

function encodePersistedValue(value) {
  if (value == null) return value
  if (b4a.isBuffer(value) || value instanceof Uint8Array) {
    return {
      __peartubeType: 'buffer',
      data: b4a.toString(value, 'base64')
    }
  }
  if (Array.isArray(value)) return value.map(encodePersistedValue)
  if (typeof value === 'object') {
    const out = {}
    for (const [key, nested] of Object.entries(value)) {
      out[key] = encodePersistedValue(nested)
    }
    return out
  }
  return value
}

function decodePersistedValue(value) {
  if (value == null) return value
  if (Array.isArray(value)) return value.map(decodePersistedValue)
  if (typeof value === 'object') {
    if (value.__peartubeType === 'buffer' && typeof value.data === 'string') {
      try {
        return b4a.from(value.data, 'base64')
      } catch {
        return null
      }
    }

    const out = {}
    for (const [key, nested] of Object.entries(value)) {
      out[key] = decodePersistedValue(nested)
    }
    return out
  }
  return value
}

function collectPersistedDhtRoutingEntries(swarm) {
  const router = swarm?.dht?._router
  const forwards = router?.forwards
  if (!forwards || typeof forwards[Symbol.iterator] !== 'function') return []

  const entries = []
  const seen = new Set()

  for (const [target, state] of forwards) {
    const targetHex = typeof target === 'string'
      ? target.toLowerCase()
      : peerKeyHex(target)
    if (!targetHex || seen.has(targetHex)) continue

    const record = state?.record
    if (!(b4a.isBuffer(record) || record instanceof Uint8Array) || record.length === 0) continue

    seen.add(targetHex)
    entries.push({
      target: targetHex,
      relay: encodePersistedValue(state?.relay ?? null),
      record: b4a.toString(record, 'base64')
    })

    if (entries.length >= DHT_ROUTING_TABLE_MAX_ENTRIES) break
  }

  return entries
}

async function persistDhtRoutingTable(swarm, metaDb, { reason = 'unknown' } = {}) {
  if (!swarm?.dht || !metaDb) return { saved: 0, skipped: true }

  const entries = collectPersistedDhtRoutingEntries(swarm)
  if (entries.length === 0) {
    try {
      await metaDb.del?.(DHT_ROUTING_TABLE_KEY)
    } catch { /* best effort */ }
    return { saved: 0 }
  }

  try {
    await metaDb.put(DHT_ROUTING_TABLE_KEY, {
      updatedAt: Date.now(),
      reason,
      entries
    })
  } catch (err) {
    console.log('[Storage] Persisting DHT routing table failed:', err?.message)
    return { saved: 0, error: err?.message || String(err) }
  }

  return { saved: entries.length }
}

async function restorePersistedDhtRoutingTable(swarm, metaDb, { reason = 'startup' } = {}) {
  if (!swarm?.dht || !metaDb) return { restored: 0, skipped: true }

  let persisted = null
  try {
    const entry = await metaDb.get(DHT_ROUTING_TABLE_KEY).catch(() => null)
    persisted = entry?.value ?? null
  } catch (err) {
    console.log('[Storage] Loading persisted DHT routing table failed:', err?.message)
    return { restored: 0, error: err?.message || String(err) }
  }

  const entries = Array.isArray(persisted)
    ? persisted
    : Array.isArray(persisted?.entries)
      ? persisted.entries
      : []

  if (!entries.length) return { restored: 0 }

  let restored = 0
  for (const entry of entries) {
    const targetHex = typeof entry?.target === 'string' ? entry.target.toLowerCase() : null
    const recordHex = typeof entry?.record === 'string' ? entry.record : null
    if (!targetHex || !recordHex) continue
    try {
      const target = b4a.from(targetHex, 'hex')
      const record = b4a.from(recordHex, 'base64')
      if (target.length !== 32 || record.length === 0) continue
      swarm.dht._router.set(targetHex, {
        relay: decodePersistedValue(entry?.relay ?? null),
        record,
        onconnect: null,
        onholepunch: null
      })
      restored++
    } catch (err) {
      console.log('[Storage] Skipping persisted DHT route restore entry:', err?.message)
    }
  }

  if (restored > 0) {
    console.log('[Storage] Restored persisted DHT routing table entries:', { reason, restored })
  }

  return { restored }
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
        options: summarizeSwarmOptions(swarm?._peartubeSwarmOptions),
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

async function waitForHyperswarmModule() {
  if (Hyperswarm) return Hyperswarm

  const ready = hyperswarmModuleReady || warmHyperswarmModule()
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve(null), HYPERSWARM_MODULE_TIMEOUT_MS)
  })
  const LoadedHyperswarm = await Promise.race([ready, timeout])

  return typeof LoadedHyperswarm === 'function' ? LoadedHyperswarm : null
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

export async function createCorestoreInstance(storagePath, options = {}) {
  if (isEmbeddedBareKitStoragePath()) {
    await appendDebugLine('[storage] embedded BareKit using plain Corestore(storagePath, options)')
  }

  return new Corestore(storagePath, options)
}

export async function openDeterministicNamedCore(store, name) {
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
 * This keeps ordinary backend P2P operations from hanging forever.
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

/**
 * The HTTP blob server must not inherit the backend's default core.get timeout:
 * a slow video block should keep the player buffering, not close the response
 * body and surface as ExoPlayer "unexpected end of stream".
 *
 * @param {import('corestore')} store - Timeout-wrapped Corestore instance
 * @returns {import('corestore')} Store facade for BlobServer
 */
function wrapStoreForBlobServerStreaming(store) {
  const blobStore = Object.create(store)
  blobStore.get = function(keyOrOpts = {}) {
    if (b4a.isBuffer(keyOrOpts)) {
      return store.get({ key: keyOrOpts, timeout: 0 })
    }
    return store.get({
      ...keyOrOpts,
      timeout: 0
    })
  }
  return blobStore
}

function getContextResourceOwnership(ctx) {
  if (!ctx?._resourceOwnership) ctx._resourceOwnership = new WeakMap()
  return ctx._resourceOwnership
}

function ownContextResource(ctx, label, resource, methods = ['close', 'destroy', 'stop'], timeoutMs = 2000) {
  if (!resource || !ctx?.lifecycle) return null
  const ownership = getContextResourceOwnership(ctx)
  const existing = ownership.get(resource)
  if (existing) return existing
  const registration = ctx.lifecycle.ownResource(label, resource, methods, timeoutMs)
  ownership.set(resource, registration)
  return registration
}

async function cleanupContextResource(ctx, resource, methods = ['close', 'destroy', 'stop']) {
  const registration = ctx?._resourceOwnership?.get?.(resource)
  if (registration) {
    await registration.cleanup()
    return
  }
  const candidates = Array.isArray(methods) ? methods : [methods]
  for (const method of candidates) {
    if (typeof resource?.[method] === 'function') {
      await resource[method]()
      return
    }
  }
}

function assertContextRunning(ctx) {
  if (ctx?.lifecycle?.signal?.aborted) throw new Error('Backend is shutting down')
}

function getSwarmDiscoveryHandles(ctx) {
  if (!ctx?._swarmDiscoveryHandles) ctx._swarmDiscoveryHandles = new Map()
  return ctx._swarmDiscoveryHandles
}

function createDeferredDiscoveryHandle() {
  let realHandle = null
  let destroyed = false
  let resolveFlushed = null
  const flushedPromise = new Promise((resolve) => {
    resolveFlushed = resolve
  })

  const closeHandle = (handle) => {
    if (typeof handle?.destroy === 'function') handle.destroy()
    else handle?.close?.()
  }

  return {
    _peartubeDeferred: true,
    _peartubeDestroyed: false,
    _peartubeStarted: false,
    _setRealHandle(handle) {
      if (destroyed) {
        try { closeHandle(handle) } catch { /* best effort */ }
        resolveFlushed?.(null)
        return
      }
      realHandle = handle || null
      resolveFlushed?.(realHandle)
    },
    async flushed() {
      await flushedPromise
      return realHandle?.flushed?.()
    },
    destroy() {
      destroyed = true
      this._peartubeDestroyed = true
      try { closeHandle(realHandle) } catch { /* best effort */ }
      resolveFlushed?.(null)
    },
    close() {
      this.destroy()
    }
  }
}

function scheduleDeferredDiscoveryJoin(ctx, discoveryKey, handle, options = {}) {
  if (!ctx?.swarm || !discoveryKey || !handle) return handle

  const swarm = ctx.swarm
  const discoveryKeyHex = b4a.toString(discoveryKey, 'hex')

  const start = () => {
    if (handle._peartubeStarted || handle._peartubeDestroyed || swarm._peartubeOffline) return null
    handle._peartubeStarted = true
    try {
      const realHandle = swarm.join(discoveryKey, { server: true, client: true })
      handle._setRealHandle(realHandle)
      if (options?.label) {
        console.log(`[Storage] Swarm discovery joined immediately for ${options.label}`)
      } else {
        console.log('[Storage] Swarm discovery joined immediately:', discoveryKeyHex.slice(0, 16))
      }
      return realHandle
    } catch (err) {
      console.log('[Storage] Immediate swarm discovery join failed:', err?.message)
      handle._setRealHandle(null)
      return null
    }
  }

  return start() || handle
}

export function retainSwarmDiscovery(ctx, discoveryKey, options = {}) {
  if (!ctx?.swarm || !discoveryKey) return null

  const handles = getSwarmDiscoveryHandles(ctx)
  const discoveryKeyHex = b4a.toString(discoveryKey, 'hex')
  const existing = handles.get(discoveryKeyHex)
  if (existing) return existing

  const handle = createDeferredDiscoveryHandle()
  if (ctx.lifecycle?.signal?.aborted) return null
  ownContextResource(ctx, `swarm discovery ${options?.label || discoveryKeyHex.slice(0, 16)}`, handle, ['destroy', 'close'])
  handles.set(discoveryKeyHex, handle)
  scheduleDeferredDiscoveryJoin(ctx, discoveryKey, handle, options)
  return handle
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
  const lifecycle = config.lifecycle || createBackendLifecycle()
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
    corestoreAllowBackup = false,
    platform = 'desktop',
    network = {},
    swarmOptions = {},
    expectedProtocolVersion,
    storedProtocolMigrations = DEFAULT_STORED_PROTOCOL_MIGRATIONS,
  } = config;

  // This sidecar is deliberately validated before Corestore, migrations,
  // networking, or any backend data surface is opened. Unsupported state must
  // fail closed without giving startup code a chance to mutate or expose it.
  const storedProtocol = prepareStoredProtocolState({
    storagePath,
    expectedVersion: expectedProtocolVersion,
    migrations: storedProtocolMigrations,
    fs,
    path,
  })

  console.log('[Storage] Initializing storage at:', storagePath);

  // Validate storage path
  if (!storagePath || storagePath === './storage') {
    console.warn('[Storage] WARNING: Using relative/default storage path. Data may not persist!');
    console.warn('[Storage] Consider using --store flag for persistent storage.');
  }

  // Create the Hyperswarm instance and kick off DHT bootstrap BEFORE the
  // Corestore/Hyperbee/blob-server warmup below. On mobile the DHT bootstrap
  // is the long pole for topic discovery, so it should overlap local disk I/O
  // instead of starting after it. We intentionally do NOT join() or listen()
  // here — the network topic join happens after metadata storage is ready, so
  // peer discovery still flows exclusively through the Hyperswarm topic.
  let keyPair = null;
  const resolvedSwarmKeyPath = swarmKeyPath || (path && storagePath ? path.join(storagePath, 'swarm-key.json') : null);
  // hypercore-storage sweeps every unrecognized entry at the storage root into
  // db/ when it opens. This key is written at the root and is not on its
  // allowlist, so from the second startup onward the original only exists in
  // db/. Reading just the root path made every restart mint a new device
  // keypair, which silently invalidated the publisher writer admission bound to
  // the old one.
  //
  // db/ is checked first on purpose: a relay that already suffered the rotation
  // has the swept original in db/ and a newer replacement at the root, and the
  // original is the identity peers and prior admissions know.
  const swarmKeyCandidates = resolvedSwarmKeyPath
    ? [...(path && storagePath && !swarmKeyPath
        ? [path.join(storagePath, 'db', 'swarm-key.json')]
        : []), resolvedSwarmKeyPath]
    : [];

  for (const candidate of swarmKeyCandidates) {
    if (keyPair || !fs) break;
    try {
      const raw = fs.readFileSync(candidate, 'utf-8');
      const parsed = JSON.parse(typeof raw === 'string' ? raw : b4a.toString(raw, 'utf8'));
      if (parsed?.publicKey && parsed?.secretKey) {
        keyPair = {
          publicKey: b4a.from(parsed.publicKey, 'hex'),
          secretKey: b4a.from(parsed.secretKey, 'hex')
        };
        console.log('[Storage] Loaded persisted swarm key:', parsed.publicKey.slice(0, 16), 'from', candidate);
      }
    } catch (e) {
      // Missing or invalid at this location; try the next one, then generate.
    }
  }

  // The sweep renames the root file over db/, so a stale root copy left behind
  // by an earlier rotation would overwrite the key just chosen and poison the
  // next startup. Writing the chosen key back to the root makes that rename a
  // no-op whichever copy the sweep moves.
  if (keyPair && resolvedSwarmKeyPath && fs) {
    try {
      fs.writeFileSync(resolvedSwarmKeyPath, JSON.stringify({
        publicKey: b4a.toString(keyPair.publicKey, 'hex'),
        secretKey: b4a.toString(keyPair.secretKey, 'hex')
      }));
    } catch (e) {
      console.log('[Storage] Could not canonicalize swarm key:', e.message);
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

  console.log('[Storage] Creating Hyperswarm (early, before storage warmup)...');
  await appendDebugLine('[storage] creating hyperswarm early')
  const LoadedHyperswarm = await waitForHyperswarmModule()
  const hyperswarmOptions = resolveHyperswarmOptions({
    keyPair,
    platform,
    network,
    swarmOptions
  })
  let swarmOwnership = null
  let swarm
  if (typeof LoadedHyperswarm !== 'function') {
    console.warn('[Storage] Hyperswarm unavailable; continuing with offline P2P networking')
    await appendDebugLine('[storage] hyperswarm unavailable; using offline swarm')
    swarm = createOfflineSwarm(keyPair, 'module-unavailable')
  } else {
    try {
      swarm = new LoadedHyperswarm(hyperswarmOptions);
    } catch (err) {
      console.warn('[Storage] Hyperswarm creation failed; continuing with offline P2P networking:', err?.message)
      await appendDebugLine(`[storage] hyperswarm create failed; using offline swarm ${err?.message || String(err)}`)
      swarm = createOfflineSwarm(keyPair, err?.message || 'create-failed')
    }
  }
  swarmOwnership = lifecycle.ownResource('Hyperswarm', swarm, 'destroy', 2000)
  swarm._peartubeSwarmOptions = summarizeSwarmOptions(hyperswarmOptions)
  console.log('[Storage] Swarm created, publicKey:', b4a.toString(swarm.keyPair.publicKey, 'hex').slice(0, 16));
  globalNetworkStartupTiming?.record('swarm-created', {
    offline: Boolean(swarm._peartubeOffline),
    options: swarm._peartubeSwarmOptions
  })
  const initialDhtState = describeDhtState(swarm.dht)
  if (initialDhtState) {
    console.log('[Storage] Initial DHT bind state:', JSON.stringify(initialDhtState))
  }
  await appendDebugLine(`[storage] hyperswarm created offline=${Boolean(swarm._peartubeOffline)}`)
  globalSwarmDiagnostics = createSwarmDiagnostics(swarm)
  installSwarmConnectDiagnostics(swarm, globalSwarmDiagnostics)

  // Set global references for suspend/resume and stats
  globalSwarm = swarm;

  // Start DHT bind + bootstrap in the background while storage initializes.
  // listen()/join() later reuse the same bootstrap, so this only moves the
  // network wait earlier — it does not add work or connect to any peer.
  if (!swarm._peartubeOffline && typeof swarm.dht?.ready === 'function') {
    swarm.dht.ready()
      .then(() => {
        globalNetworkStartupTiming?.record('dht-early-bootstrap', { bootstrapped: swarm.dht?.bootstrapped, firewalled: swarm.dht?.firewalled })
        console.log('[Storage] Early DHT bootstrap done, bootstrapped:', swarm.dht?.bootstrapped, 'firewalled:', swarm.dht?.firewalled)
        void appendDebugLine(`[storage] early dht bootstrap done bootstrapped=${swarm.dht?.bootstrapped} firewalled=${swarm.dht?.firewalled}`)
      })
      .catch((err) => {
        console.log('[Storage] Early DHT bootstrap failed (non-fatal):', err?.message)
        void appendDebugLine(`[storage] early dht bootstrap failed ${err?.message || String(err)}`)
      })
  }

  // The swarm now exists before storage init, so every storage failure path
  // below must tear it down or a failed attempt leaks the DHT socket (and the
  // orchestrator's retry would stack a second swarm on top).
  const destroySwarmAfterInitFailure = async (label) => {
    try {
      if (globalSwarm === swarm) globalSwarm = null
      globalSwarmDiagnostics = null
      await swarmOwnership?.cleanup()
      await appendDebugLine(`[storage] swarm destroyed after init failure ${label}`)
    } catch (error) {
      await appendDebugLine(`[storage] swarm destroy after init failure failed ${label} ${describeDebugError(error)}`)
    }
  }

  if (isEmbeddedBareKitStoragePath()) {
    await appendDebugLine('[storage] relocateLegacyLogsDir skipped for embedded BareKit storage')
  } else {
    try {
      await appendDebugLine('[storage] relocateLegacyCorestoreDir start')
      const relocatedCorestoreDir = relocateLegacyCorestoreDir(storagePath, fs, path)
      await appendDebugLine(`[storage] relocateLegacyCorestoreDir done moved=${relocatedCorestoreDir || 'none'}`)
      if (relocatedCorestoreDir) {
        console.log('[Storage] Relocated legacy corestore dir to avoid Corestore migration conflict:', relocatedCorestoreDir)
      }
    } catch (error) {
      await appendDebugLine(`[storage] relocateLegacyCorestoreDir failed ${describeDebugError(error)}`)
      console.warn('[Storage] Failed to relocate legacy corestore dir before Corestore init:', error?.message)
    }

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
  let store
  let storeOwnership = null
  try {
    store = await createCorestoreInstance(storagePath, corestoreOptions)
    storeOwnership = lifecycle.ownResource('Corestore', store, 'close', 5000)
  } catch (error) {
    await appendDebugLine(`[storage] corestore create failed ${describeDebugError(error)}`)
    await destroySwarmAfterInitFailure('corestore create')
    throw error
  }

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
    storeOwnership?.release()
    await destroySwarmAfterInitFailure('corestore ready')
    throw error
  }
  console.log('[Storage] Corestore ready, opened:', store.opened, 'closed:', store.closed);
  await appendDebugLine(`[storage] corestore ready opened=${store.opened} closed=${store.closed}`)
  if (b4a.isBuffer(store.primaryKey)) {
    const primaryKeyHex = b4a.toString(store.primaryKey, 'hex')
    console.log('[Storage] Corestore primaryKey after ready:', `${primaryKeyHex.slice(0, 16)}...`)
    await appendDebugLine(`[storage] corestore primaryKey after ready ${primaryKeyHex}`)
  }

  // Wrap the shared store with finite timeouts for backend control-plane work,
  // but give BlobServer a no-timeout facade so media reads don't abort while
  // waiting for slow P2P blocks.
  wrapStoreWithTimeout(store, defaultTimeout);
  const blobStore = wrapStoreForBlobServerStreaming(store);

  // Initialize blob server for video streaming only after metadata cores are open.
  let blobServer = null;
  let blobServerPort = 0;
  let blobServerError = null;
  let resolveBlobServerReady;
  const blobServerReady = new Promise((resolve) => {
    resolveBlobServerReady = resolve
  })
  let storageContext = null
  let blobServerHost = blobServerHostOverride || '127.0.0.1';
  let blobServerBindHost = blobServerBindHostOverride || blobServerHost;

  let metaCore = null
  let metaDb = null
  let metaCoreOwnership = null
  let metaDbOwnership = null
  let blobServerOwnership = null

  async function cleanupFailedMetadataStartup(label, originalError) {
    await appendDebugLine(`[storage] metadata init cleanup start ${label}`)

    await blobServerOwnership?.cleanup()
    if (globalBlobServer === blobServer) globalBlobServer = null

    await metaDbOwnership?.cleanup()
    if (globalMetaDb === metaDb) globalMetaDb = null

    await metaCoreOwnership?.cleanup()
    await storeOwnership?.cleanup()
    await destroySwarmAfterInitFailure(label)

    throw originalError
  }

  // Initialize metadata database
  await appendDebugLine('[storage] metaCore get start')
  console.log('[Storage] metaCore get start')
  try {
    metaCore = await openDeterministicNamedCore(store, 'peartube-meta');
    metaCoreOwnership = lifecycle.ownResource('metadata core', metaCore, 'close', 2000)
  } catch (error) {
    await appendDebugLine(`[storage] metaCore get failed ${describeDebugError(error)}`)
    console.error('[Storage] metaCore get failed:', describeDebugError(error))
    await cleanupFailedMetadataStartup('metaCore.get', error)
  }
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
  metaDbOwnership = lifecycle.ownResource('metadata database', metaDb, 'close', 2000)
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

  if (storedProtocol) {
    try {
      await storedProtocol.migrate({ store, metaCore, metaDb, storagePath, platform })
    } catch (error) {
      await cleanupFailedMetadataStartup('stored protocol migration', error)
    }
  }

  // Sub-encoded metaDb keyspaces (download intents, channel kinds, playback
  // profiles) + one-time migration of any legacy flat-prefixed keys. Best-effort:
  // a migration failure must not block startup (it retries next launch).
  const metaSubspaces = createMetaSubspaces(metaDb)
  try {
    const migration = await migrateMetaSubspaces(metaDb, metaSubspaces)
    if (migration.migrated > 0 || migration.incomplete) {
      console.log('[Storage] meta-subspaces migration:', JSON.stringify(migration))
    }
  } catch (error) {
    console.warn('[Storage] meta-subspaces migration skipped (non-fatal):', error?.message)
  }

  try {
    const desiredPort = blobServerPortOverride || 0;

    installExpectedBlobRequestCancellationHandler()

    blobServer = new BlobServer(blobStore, {
      port: desiredPort || 0,
      host: blobServerBindHost
    });
    blobServerOwnership = lifecycle.own('blob server', async () => {
      releaseAllPrioritizedBlobRanges()
      await blobServer?.close?.()
    }, 2000)
    blobServer._peartubeLifecycle = lifecycle
    // Patch _onrequest to add CORS headers for mediabunny's UrlSource (fetch)
    const origOnRequest = blobServer._onrequest.bind(blobServer)
    blobServer._onrequest = async function (req, res) {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Range')
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
      if (String(req.url || '').includes('pt_health=1')) {
        res.writeHead(204)
        res.end()
        return
      }

      // Thumbnails tag their blob URL with pt_thumbnail=1 (see api.getVideoThumbnail).
      // Serve those as a buffered, fixed-length response Android image loaders
      // accept, instead of hypercore-blob-server's plain-GET streaming pipe (which
      // never ends deterministically — Fresco errors, expo-image/Glide hangs then
      // errors). Only tagged requests are intercepted; video Range reads and every
      // other request fall through to the upstream handler unchanged.
      try {
        const handled = await serveThumbnailHttpRequest({
          store,
          blobServer,
          retainDiscovery: (discoveryKey, options) => retainSwarmDiscovery(storageContext || { swarm }, discoveryKey, options)
        }, req, res)
        if (handled) return
      } catch (err) {
        console.log('[Storage] Thumbnail serve failed:', err?.message || err)
      }

      try {
        const handled = await serveVideoRangeHttpRequest({ blobServer }, req, res)
        if (handled) return
      } catch (err) {
        console.log('[Storage] Video range serve failed:', err?.message || err)
      }

      try {
        await prioritizeBlobServerRangeRequest(blobServer, req)
      } catch (err) {
        console.log('[Storage] Blob range priority failed:', err?.message || err)
      }
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

  // Hyperswarm was created (and DHT bootstrap kicked off) before storage init
  // above so the network warmup overlaps disk I/O. From here on we only wire
  // handlers and join the discovery topic.
  console.log('[Storage] Wiring early-created Hyperswarm, DHT bootstrapped:', swarm.dht?.bootstrapped ?? null);
  await appendDebugLine(`[storage] wiring early hyperswarm bootstrapped=${swarm.dht?.bootstrapped ?? null}`)

  // Initialize network stats for debugging
  if (HyperswarmStats) {
    try {
      networkStats = new HyperswarmStats(swarm);
      lifecycle.ownResource('network statistics', networkStats, ['destroy', 'close', 'stop'], 2000)
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
      lifecycle.ownResource('wakeup protocol', wakeup, ['destroy', 'close', 'stop'], 2000)
      console.log('[Storage] Wakeup protocol initialized');
    } catch (err) {
      console.log('[Storage] Wakeup init failed (non-fatal):', err?.message);
    }
  }

  // Known-peer cache records remote pubkeys for diagnostics and future peer tracking.
  const selfKeyHex = swarm.keyPair?.publicKey ? b4a.toString(swarm.keyPair.publicKey, 'hex') : null
  const knownPeerCache = createKnownPeerCache(metaDb, { selfKeyHex })
  lifecycle.ownResource('known-peer cache', knownPeerCache, 'close', 2000)
  globalKnownPeerCache = knownPeerCache

  // Register handlers BEFORE swarm.join so any incoming connection is replicated
  // immediately (canonical Hyperswarm/Hyperdrive pattern).
  swarm.on('connection', (conn, info) => {
    try {
      if (!conn || conn.destroyed) return
      // Send liveness keepalives more frequently so a half-open connection (one
      // that handshakes and syncs but then moves no data) is detected and torn
      // down sooner — the default lets a dead link linger tens of seconds, which
      // stalls playback until hyperswarm finally redials. Best-effort: not every
      // stream implementation exposes setKeepAlive.
      try { conn.setKeepAlive?.(4000) } catch { /* best effort */ }
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


    } catch (err) {
      console.log('[Storage] connection handler error (non-fatal):', err?.message)
    }
  });

  // Log swarm events for debugging mobile connectivity
  swarm.on('update', () => {
    globalSwarmDiagnostics?.recordUpdate?.()
    log.debug('Swarm update event', { connections: swarm.connections?.size || 0, peers: swarm.peers?.size || 0 })
  });

  await restorePersistedDhtRoutingTable(swarm, metaDb, { reason: 'startup' })


  // Warm reconnect: proactively re-dial peers we have actually connected to in
  // prior sessions (persisted by the known-peer cache — learned dynamically from
  // real connections, NOT a hardcoded relay list). Cold DHT discovery can take
  // many seconds for a firewalled client with no warm routing table, leaving
  // playback stuck at "0 peers"; re-dialing known-good peers (seeders/relays we
  // have reached before) gives an immediate path while DHT discovery catches up.
  // Bounded and best-effort; joinPeer is idempotent so this never duplicates an
  // existing connection.
  if (!swarm._peartubeOffline && typeof swarm.joinPeer === 'function') {
    lifecycle.defer('known peer warm reconnect', async (signal) => {
      try {
        const known = await loadKnownPeers(metaDb)
        let dialed = 0
        for (const { key } of known.slice(0, KNOWN_PEER_REDIAL_LIMIT)) {
          if (signal.aborted) return
          try { swarm.joinPeer(b4a.from(key, 'hex')); dialed++ } catch { /* best effort */ }
        }
        if (dialed > 0) {
          console.log('[Storage] Warm reconnect: re-dialing', dialed, 'known peer(s) from prior sessions')
          void appendDebugLine(`[storage] warm reconnect re-dialing ${dialed} known peers`)
        }
      } catch (err) {
        if (!signal.aborted) console.log('[Storage] Warm reconnect skipped:', err?.message || err)
      }
    })
  }

  // Start listening - DON'T block on it since it may hang on mobile
  // The listen() call starts the server but we don't need to wait for it
  console.log('[Storage] Starting swarm.listen() (non-blocking)...');
  await appendDebugLine('[storage] swarm.listen start')
  const listenPromise = swarm.listen()
  swarm._peartubeListenPromise = listenPromise
  globalNetworkStartupTiming?.record('swarm-listen-called')

  // Track listen state for debugging
  swarm._peartubeListenResolved = false
  if (!listenPromise || typeof listenPromise.then !== 'function') {
    swarm._peartubeListenResolved = true
  } else {
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

  // Check DHT state after a delay; lifecycle shutdown clears both timers.
  lifecycle.ownTimer('DHT state log timer (2s)', setTimeout(logDhtState, 2000))
  lifecycle.ownTimer('DHT state log timer (5s)', setTimeout(logDhtState, 5000))

  // Set global reference for suspend/resume lifecycle management
  globalChannels = channels;
  lifecycle.own('storage shutdown preparation', async () => {
    await persistDhtRoutingTable(swarm, metaDb, { reason: 'shutdown' })
    if (globalSwarm === swarm) globalSwarm = null
    if (globalBlobServer === blobServer) globalBlobServer = null
    if (globalChannels === channels) globalChannels = null
    if (globalMetaDb === metaDb) globalMetaDb = null
    if (globalKnownPeerCache === knownPeerCache) globalKnownPeerCache = null
    globalSwarmDiagnostics = null
    globalNetworkStartupTiming = null
    networkStats = null
  }, 2000)

  storageContext = {
    store,
    metaCore,
    metaDb,
    metaSubspaces,
    swarm,
    blobServer,
    blobServerPort,
    blobServerReady,
    blobServerError,
    blobServerHost,
    blobServerBindHost,
    channels,
    wakeup,
    knownPeerCache,
    platform,
    storedProtocol,
    lifecycle,
    ownResource(label, resource, methods, timeoutMs) {
      return ownContextResource(storageContext, label, resource, methods, timeoutMs)
    },
    registerCleanup(label, cleanup, options = {}) {
      const registration = lifecycle.own(label, cleanup, options.timeoutMs)
      return { cancel: () => registration.release() }
    },
    registerCleanupTimer(label, timer, clear = clearTimeout) {
      const registration = lifecycle.ownTimer(label, timer, clear)
      return { cancel: () => registration.release() }
    },
  };


  return storageContext
}

/**
 * Load or create a multi-writer channel by HyperDB channel key.
 *
 * @param {import('./types.js').StorageContext} ctx
 * @param {string} channelKeyHex
 * @param {Object} [options]
 * @param {string} [options.encryptionKeyHex]
 * @returns {Promise<import('./channel/multi-writer-channel.js').MultiWriterChannel>}
 */
// Track in-progress channel loads to prevent duplicate concurrent loads
const loadingChannels = new Map()
const publicProjectionStateWrites = new WeakMap()


function identityChannelKey(identity) {
  return identity?.channelKey?.toLowerCase?.() || identity?.driveKey?.toLowerCase?.() || null
}

function createPublicProjectionStateWriter(ctx, channelKeyHex) {
  const states = ctx.metaSubspaces?.publicProjectionStates
  if (!states || typeof states.get !== 'function' || typeof states.put !== 'function') return null
  const canonicalChannelKey = channelKeyHex.toLowerCase()
  return async (state) => {
    if (state !== 'pending' && state !== 'active') {
      throw new Error(`Invalid public projection state: ${state}`)
    }
    let queues = publicProjectionStateWrites.get(ctx.metaDb)
    if (!queues) {
      queues = new Map()
      publicProjectionStateWrites.set(ctx.metaDb, queues)
    }
    const previous = queues.get(canonicalChannelKey) || Promise.resolve()
    const write = previous.catch(() => {}).then(async () => {
      const current = await states.get(canonicalChannelKey)
      if (current?.value?.state === 'active') return 'active'
      if (current?.value?.state === state) return state
      await states.put(canonicalChannelKey, { state, updatedAt: Date.now() })
      return state
    })
    queues.set(canonicalChannelKey, write)
    try {
      return await write
    } finally {
      if (queues.get(canonicalChannelKey) === write) queues.delete(canonicalChannelKey)
    }
  }
}

async function resolveChannelLoadOptions(ctx, channelKeyHex, options) {
  if (typeof ctx.metaDb?.get !== 'function') return options
  try {
    const identities = await readStoredIdentityRecords(ctx.metaDb)
    const identity = identities.find((candidate) =>
      identityChannelKey(candidate) === channelKeyHex)
    const deferPublicProjection =
      options?.deferPublicProjection === true ||
      identity?.deferPublicProjection === true
    if (!deferPublicProjection) return options
    const marker = await ctx.metaSubspaces?.publicProjectionStates?.get?.(channelKeyHex)
    return {
      ...options,
      deferPublicProjection: true,
      publicProjectionState: marker?.value?.state === 'active' ? 'active' : 'pending',
      setPublicProjectionState: createPublicProjectionStateWriter(ctx, channelKeyHex),
    }
  } catch (err) {
    throw new Error('Unable to resolve channel public projection mode', { cause: err })
  }
}

export async function loadChannel(ctx, channelKeyHex, options = {}) {
  assertContextRunning(ctx)
  channelKeyHex = channelKeyHex.toLowerCase()
  options = await resolveChannelLoadOptions(ctx, channelKeyHex, options)
  assertContextRunning(ctx)
  if (!ctx.channels) ctx.channels = new Map()
  if (ctx.channels.has(channelKeyHex)) {
    const cached = ctx.channels.get(channelKeyHex)
    if (!isChannelUsable(cached)) {
      console.log('[Storage] loadChannel: evicting stale cached channel:', channelKeyHex.slice(0, 16))
      ctx.channels.delete(channelKeyHex)
      try { await cleanupContextResource(ctx, cached) } catch { /* best effort */ }
    }

    if (ctx.channels.has(channelKeyHex)) {
      const current = ctx.channels.get(channelKeyHex)
      if (options.preferWritable && current && !current.writable) {
        if (typeof options.writerKeyName === 'string' && options.writerKeyName) {
          console.log('[Storage] loadChannel: cached channel read-only, reloading for writable access:', channelKeyHex.slice(0, 16))
          try {
            await Promise.race([
              cleanupContextResource(ctx, current),
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

      assertContextRunning(ctx)
      console.log('[Storage] Loading channel:', channelKeyHex.slice(0, 16));
      const ch = new MultiWriterChannel(ctx.store, {
        key: b4a.from(channelKeyHex, 'hex'),
        encryptionKey: options.encryptionKeyHex ? b4a.from(options.encryptionKeyHex, 'hex') : null,
        keyPair: writerKeyPair || undefined,
        swarm: ctx.swarm,
        deferPublicProjection: options.deferPublicProjection === true,
        publicProjectionState: options.publicProjectionState,
        setPublicProjectionState: options.setPublicProjectionState,
      })
      ownContextResource(ctx, `channel ${channelKeyHex.slice(0, 16)}`, ch)

      const readyTimeoutMs = options.preferWritable ? 25000 : 10000
      const readyStart = Date.now()
      let readyTimer = null
      try {
        await Promise.race([
          ch.ready(),
          new Promise((_, reject) => {
            readyTimer = setTimeout(() => reject(new Error('Channel ready timeout')), readyTimeoutMs)
          })
        ])
        assertContextRunning(ctx)
      } catch (err) {
        try { await cleanupContextResource(ctx, ch) } catch { /* best effort */ }
        throw err
      } finally {
        clearTimeout(readyTimer)
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

    // Ensure we join the channel topic so this device can find peers and replicate HyperDB cores.
    // Even non-writable peers must join; pairing setup is only for writable members.
    if (ctx.swarm) {
      let pairingTimer = null
      try {
        if (ch.discoveryKey) retainSwarmDiscovery(ctx, ch.discoveryKey, { label: `channel:${channelKeyHex.slice(0, 16)}` })
        await Promise.race([
          ch.setupPairing(ctx.swarm),
          new Promise((resolve) => {
            pairingTimer = setTimeout(resolve, 15000)
          })
        ])
      } catch (err) {
        console.log('[Storage] Pairing setup error (non-fatal):', err?.message)
      } finally {
        clearTimeout(pairingTimer)
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
  if (isCoreClosing(channel.core)) return false
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
 * Load an already-local legacy public projection.
 *
 * This compatibility reader does not join discovery or replicate. Network
 * catalog and asset access is exclusively authorized by the scoped runtime.
 *
 * @param {import('./types.js').StorageContext} ctx
 * @param {string} publicBeeKeyHex - The local public index key
 * @returns {Promise<PublicChannelBee>}
 */
export async function loadPublicBee(ctx, publicBeeKeyHex) {
  assertContextRunning(ctx)
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
      try { await cleanupContextResource(ctx, bee) } catch { /* best effort */ }
    },
    loadFresh: async () => {
      assertContextRunning(ctx)
      console.log('[Storage] loadPublicBee: loading:', publicBeeKeyHex.slice(0, 16))

      const bee = new PublicChannelBee(ctx.store, {
        key: publicBeeKeyHex
      })
      ownContextResource(ctx, `public bee ${publicBeeKeyHex.slice(0, 16)}`, bee)

      try {
        await Promise.race([
          bee.ready(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('PublicBee ready timeout')), 10000))
        ])
        assertContextRunning(ctx)
      } catch (err) {
        console.error('[Storage] loadPublicBee failed:', err.message)
        try { await cleanupContextResource(ctx, bee) } catch { /* best effort */ }
        throw err
      }

      console.log('[Storage] loadPublicBee: ready:', publicBeeKeyHex.slice(0, 16), 'length:', bee.core?.length)
      return bee
    }
  })
}

/**
 * Create a new multi-writer channel.
 *
 * @param {import('./types.js').StorageContext} ctx
 * @param {Object} [options]
 * @returns {Promise<{channel: import('./channel/multi-writer-channel.js').MultiWriterChannel, channelKeyHex: string, encryptionKeyHex: string|null}>}
 */
export async function createChannel(ctx, options = {}) {
  assertContextRunning(ctx)
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

  // Derive the same writer keypair the load paths use (loadChannel passes
  // `writerKeyName`). Without this, creation falls back to a different internal
  // writer-key derivation than every subsequent load, so the owner ends up with
  // two writer-table records — one of which shows up as a phantom "synced
  // device". Passing it here keeps the owner's writer key stable from creation.
  const writerKeyPair = typeof ctx.store.createKeyPair === 'function'
    ? await ctx.store.createKeyPair(writerKeyName)
    : null

  assertContextRunning(ctx)
  const ch = new MultiWriterChannel(ctx.store, {
    key: derivedChannelKeyHex ? b4a.from(derivedChannelKeyHex, 'hex') : null,
    encryptionKey: derivedEncryptionKeyHex ? b4a.from(derivedEncryptionKeyHex, 'hex') : null,
    encrypt: Boolean(options.encrypt),
    keyPair: writerKeyPair || undefined,
    swarm: ctx.swarm, // Pass swarm for early replication setup
    deferPublicProjection: options.deferPublicProjection === true,
    publicProjectionState: options.deferPublicProjection === true ? 'pending' : 'active',
    setPublicProjectionState: derivedChannelKeyHex
      ? createPublicProjectionStateWriter(ctx, derivedChannelKeyHex)
      : null,
  })
  ownContextResource(ctx, `channel ${derivedChannelKeyHex?.slice(0, 16) || 'new'}`, ch)
  try {
    await ch.ready()
    assertContextRunning(ctx)
    if (!ch.writable) {
      throw new Error('Channel not writable after creation')
    }
  } catch (error) {
    await cleanupContextResource(ctx, ch)
    throw error
  }

  const channelKeyHex = ch.keyHex
  const encryptionKeyHex = ch.encryptionKey
    ? b4a.toString(ch.encryptionKey, 'hex')
    : derivedEncryptionKeyHex
  if (options.deferPublicProjection === true && !ch.opts.setPublicProjectionState) {
    ch.opts.setPublicProjectionState = createPublicProjectionStateWriter(ctx, channelKeyHex)
  }

  ctx.channels.set(channelKeyHex, ch)

  // Persist a marker so we can reliably distinguish multi-writer channels.
  try {
    await ctx.metaSubspaces.channelKinds.put(channelKeyHex, { kind: 'hyperdb', createdAt: Date.now() })
  } catch { /* best effort */ }

  // Set up pairing and replication - AWAIT to ensure handlers are registered
  if (ctx.swarm) {
    try {
      if (ch.discoveryKey) retainSwarmDiscovery(ctx, ch.discoveryKey, { label: `channel:${channelKeyHex.slice(0, 16)}` })
      await ch.setupPairing(ctx.swarm)
    } catch (err) {
      console.log('[Storage] Pairing setup error (non-fatal):', err?.message)
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
  assertContextRunning(ctx)
  const channelOwnerships = new Map()
  const pairer = new ChannelPairer(ctx.store, inviteCode, {
    swarm: ctx.swarm,
    deviceName: options.deviceName || '',
    onChannel: (channel) => {
      if (!channelOwnerships.has(channel)) {
        channelOwnerships.set(
          channel,
          ownContextResource(ctx, `paired channel ${channel.keyHex?.slice(0, 16) || 'unknown'}`, channel, 'close', 2000)
        )
      }
    },
  })
  const pairerOwnership = ownContextResource(ctx, 'channel pairer', pairer, 'close', 2000)
  let channel = null
  try {
    await pairer.ready()
    assertContextRunning(ctx)
    channel = await pairer.finished()
  } catch (error) {
    await Promise.all([...channelOwnerships.values()].map((ownership) => ownership.cleanup()))
    await pairerOwnership?.cleanup()
    throw error
  }
  const channelOwnership = channelOwnerships.get(channel)
  await pairerOwnership?.cleanup()
  try {
    assertContextRunning(ctx)
  } catch (error) {
    await channelOwnership?.cleanup()
    throw error
  }
  const channelKeyHex = channel.keyHex
  if (!ctx.channels) ctx.channels = new Map()
  ctx.channels.set(channelKeyHex, channel)

  // Persist marker for multi-writer channel
  try {
    await ctx.metaSubspaces.channelKinds.put(channelKeyHex, { kind: 'hyperdb', createdAt: Date.now() })
  } catch { /* best effort */ }
  if (ctx.lifecycle?.signal?.aborted) {
    ctx.channels.delete(channelKeyHex)
    await channelOwnership?.cleanup()
    throw new Error('Backend is shutting down')
  }

  // Install the channel pairer's scoped Protomux handlers before discovery can accept peers.
  if (ctx.swarm) {
    try {
      // Await registration so an early connection cannot race ahead of the authorized channel handlers.
      await channel.setupPairing(ctx.swarm)
    } catch (err) {
      console.log('[Storage] Pairing setup error (non-fatal):', err?.message)
    }
  }
  if (ctx.lifecycle?.signal?.aborted) {
    ctx.channels.delete(channelKeyHex)
    await channelOwnership?.cleanup()
    throw new Error('Backend is shutting down')
  }

  // Create wakeup session for paired channel
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
  assertContextRunning(ctx)
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
  assertLoopbackPlaybackUrl(url, 'instant blob playback url')

  // Kick off background sync (don't await)
  const blobsCore = ctx.store.get(keyBuffer)
  ownContextResource(ctx, `instant blob core ${blobsCoreKeyHex.slice(0, 16)}`, blobsCore, 'close')
  blobsCore.ready().then(() => {
    if (ctx.lifecycle?.signal?.aborted) return
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

  console.log('[Storage] Instant URL generated:', redactCapabilityUrl(url));
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
  assertContextRunning(ctx)

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
  ownContextResource(ctx, `blob core ${blobsCoreKeyHex.slice(0, 16)}`, blobsCore, 'close')
  console.log('[Storage] GET_VIDEO_URL_FROM_BLOB: store.get returned, calling ready...');

  await blobsCore.ready()
  assertContextRunning(ctx)
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
    // Strict P2P: the only URL a player may ever receive is the local blob
    // server. A non-loopback link here would mean media bytes could come from
    // an origin, so refuse to hand it out at all.
    assertLoopbackPlaybackUrl(url, 'direct blob playback url')

    console.log('[Storage] Direct blob URL (hyperblobs):', redactCapabilityUrl(url));
    return { url };
  } catch (err) {
    console.error('[Storage] GET_VIDEO_URL_FROM_BLOB: blobServer.getLink FAILED:', err.message, err.stack);
    throw err;
  }
}

export async function shutdownBackend(ctx) {
  if (!ctx) return
  if (ctx._shutdownPromise) return ctx._shutdownPromise
  if (ctx._isShutdown) return

  ctx._isShutdown = true
  ctx.isShuttingDown = true

  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }

  const runShutdownStep = async (label, cleanup, timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS) => {
    let timeout = null
    let timedOut = false
    try {
      await Promise.race([
        Promise.resolve().then(cleanup),
        new Promise((resolve) => {
          timeout = setTimeout(() => {
            timedOut = true
            resolve()
          }, timeoutMs)
        }),
      ])
    } catch (error) {
      console.warn(`[Backend] Shutdown: ${label} failed (non-fatal):`, error?.message || error)
    } finally {
      clearTimeout(timeout)
    }
    if (timedOut) console.warn(`[Backend] Shutdown: ${label} timed out after ${timeoutMs}ms`)
  }

  ctx._shutdownPromise = (async () => {
    if (typeof ctx.lifecycle?.shutdown === 'function') {
      await ctx.lifecycle.shutdown()
    } else if (typeof ctx._runCleanupStack === 'function') {
      await ctx._runCleanupStack(runShutdownStep)
    }
    console.log('[Backend] Shutdown complete')
  })()

  return ctx._shutdownPromise
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

  if (isPlaybackActive()) {
    console.log('[Network] Skipping suspend - local playback is active');
    console.log('[CastDiag] suspendNetworking: SKIPPED (playback is active)');
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
      await persistDhtRoutingTable(globalSwarm, globalMetaDb, { reason: 'suspend' })
      try { globalSwarm._peartubePeerPoolWarmup?.cancel?.() } catch { /* best effort */ }
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

export function setPlaybackActive(active, options = {}) {
  globalPlaybackActive = Boolean(active)
  globalPlaybackActiveUpdatedAt = Date.now()
  const ttlMs = Math.max(1000, Number(options.ttlMs || PLAYBACK_ACTIVITY_TTL_MS) || PLAYBACK_ACTIVITY_TTL_MS)
  globalPlaybackActiveUntil = globalPlaybackActive ? globalPlaybackActiveUpdatedAt + ttlMs : 0
  console.log('[Network] playbackActive flag set to:', globalPlaybackActive)
  return {
    active: globalPlaybackActive,
    updatedAt: globalPlaybackActiveUpdatedAt,
    expiresAt: globalPlaybackActiveUntil
  }
}

export function isPlaybackActive(now = Date.now()) {
  if (!globalPlaybackActive) return false
  if (globalPlaybackActiveUntil > 0 && now > globalPlaybackActiveUntil) {
    globalPlaybackActive = false
    globalPlaybackActiveUntil = 0
    return false
  }
  return true
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
  globalBlobServer?._peartubeLifecycle?.ownTimer('blob server watchdog', watchdogTimer, clearInterval)
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
      await restorePersistedDhtRoutingTable(globalSwarm, globalMetaDb, { reason: 'resume' })
      console.log('[Network] Swarm resumed, connections:', globalSwarm.connections?.size || 0);
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
        swarmOptions: globalSwarm._peartubeSwarmOptions || null,
        offline: Boolean(globalSwarm._peartubeOffline),
        offlineReason: globalSwarm._peartubeOfflineReason || null,
        listenResolved: Boolean(globalSwarm._peartubeListenResolved),
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
