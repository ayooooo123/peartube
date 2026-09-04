import b4a from 'b4a'
import c from 'compact-encoding'
import Protomux from 'protomux'

import { createNetworkAdmission } from './admission.js'
import { ASSET_BLOCK_ERROR_CODES, encodePeerFrame, MAX_PEER_FRAME_BYTES, PROTOCOL_MAJOR } from './frame.js'
import { MAX_VERIFIED_BLOCK_BYTES } from './block-protocol.js'
import { createVerifiedBlockEngine } from './verified-block-engine.js'
import {
  ACQUISITION_DISCOVERY_CAPABILITY,
  ACQUISITION_WORK_CAPABILITY,
  ARCHIVE_DISCOVERY_CAPABILITY,
  ARCHIVE_RANGE_CAPABILITY,
  ASSET_RENDITION_CAPABILITY,
  INDEX_QUERY_CAPABILITY,
  SCOPED_NETWORK_PROTOCOL,
  createScopedProtocolSession,
  encodeScopedHello,
} from './scoped-protocol.js'
export {
  ACQUISITION_DISCOVERY_CAPABILITY,
  ACQUISITION_WORK_CAPABILITY,
  ARCHIVE_DISCOVERY_CAPABILITY,
  ARCHIVE_RANGE_CAPABILITY,
  ASSET_RENDITION_CAPABILITY,
  INDEX_QUERY_CAPABILITY,
  SCOPED_NETWORK_PROTOCOL,
  createScopedProtocolSession,
  decodeScopedHello,
  encodeScopedHello,
} from './scoped-protocol.js'
import {
  deriveAcquisitionDiscoveryTopic,
  deriveAcquisitionTopic,
  deriveBootstrapTopic,
  deriveIndexerTopic,
  topicHex,
} from './topics.js'
import { BOOTSTRAP_LOCATOR_CAPABILITY } from '../discovery/bootstrap-protocol.js'
import { INDEX_FEED_CAPABILITY } from '../indexing/feed-contract.js'
import {
  PUBLISHER_CATALOG_CAPABILITY,
  decodePublisherNamespaceDescriptor,
  verifyPublisherNamespaceDescriptor,
} from '../publisher/namespace.js'
import { verifyIndexServiceAnnouncement } from '../indexer/service-announcement.js'
import { createIndexQueryClient } from '../indexer/protocol.js'
import { MODERATION_FEED_CAPABILITY, createScopedFeedRuntime } from './scoped-feed-runtime.js'
export {
  MODERATION_FEED_CAPABILITY,
  decodeFeedPageRequest,
  decodeFeedPageResponse,
  encodeFeedPageRequest,
  encodeFeedPageResponse,
} from './scoped-feed-runtime.js'
import { createBootstrapLocatorRuntime } from './bootstrap-locator-runtime.js'
import { createScopedContentRuntime } from './scoped-content-runtime.js'
import { createPublisherCatalogRuntime } from './publisher-catalog-runtime.js'

const GENERIC_PURPOSES = Object.freeze([
  'bootstrap',
  'publisher',
  'asset',
  'archive',
  'archive-discovery',
  'acquisition-discovery',
  'acquisition',
])
const MAX_ASSET_BLOCK_BYTES = MAX_VERIFIED_BLOCK_BYTES
const ASSET_TRANSFER_TIMEOUT_MS = 10_000
// Rate-limited sends wait only within the request timeout budget.
const MAX_OUTBOUND_RATE_DEFER_MS = 4_000
const MAX_OUTBOUND_RATE_DEFERRALS = 4
const MAX_INDEX_SERVICE_ADAPTERS = 32
const ASSET_TRANSFER_TYPES = new Set([
  'asset-range-summary-request',
  'asset-range-summary-page',
  'asset-block-request',
  'asset-block-response',
  'asset-block-error',
])
const ARCHIVE_TRANSFER_TYPES = new Set([
  'archive-block-request',
  'archive-block-proof',
  'archive-block-chunk',
  'archive-block-unavailable',
])
const ACQUISITION_DISCOVERY_FRAME_TYPES = new Set([
  'acquisition-request',
  'acquisition-offer',
  'acquisition-assignment',
  'acquisition-cancel',
])
const ACQUISITION_WORK_FRAME_TYPES = new Set([
  'acquisition-progress',
  'acquisition-result',
  'acquisition-cancel',
  'acquisition-block-request',
  'acquisition-block-proof',
  'acquisition-block-chunk',
  'acquisition-block-unavailable',
])

function fail (message, code = 'SCOPED_NETWORK_REJECTED') {
  const error = new Error(message)
  error.code = code
  throw error
}

function exactBuffer (value, size, name) {
  const buffer = b4a.from(value || [])
  if (buffer.byteLength !== size) fail(`${name} must be ${size} bytes`)
  return buffer
}

function hex32 (value, name) {
  if (b4a.isBuffer(value) || value instanceof Uint8Array) return b4a.toString(exactBuffer(value, 32, name), 'hex')
  const text = String(value || '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(text)) fail(`${name} must be 32-byte hex`)
  return text
}

function safeRange (startValue = 0, endValue = null) {
  const start = Number(startValue)
  const end = endValue == null ? null : Number(endValue)
  if (!Number.isSafeInteger(start) || start < 0) fail('range.start must be a non-negative safe integer')
  if (end !== null && (!Number.isSafeInteger(end) || end <= start)) fail('range.end must be greater than range.start')
  return { start, end }
}


function capabilityForPurpose (purpose, { indexService = false } = {}) {
  switch (purpose) {
    case 'bootstrap': return BOOTSTRAP_LOCATOR_CAPABILITY
    case 'publisher': return PUBLISHER_CATALOG_CAPABILITY
    case 'asset': return ASSET_RENDITION_CAPABILITY
    case 'archive': return ARCHIVE_RANGE_CAPABILITY
    case 'archive-discovery': return ARCHIVE_DISCOVERY_CAPABILITY
    case 'acquisition-discovery': return ACQUISITION_DISCOVERY_CAPABILITY
    case 'acquisition': return ACQUISITION_WORK_CAPABILITY
    case 'index': return indexService ? INDEX_QUERY_CAPABILITY : INDEX_FEED_CAPABILITY
    case 'moderation': return MODERATION_FEED_CAPABILITY
    default: fail('unsupported purpose')
  }
}


function protocolForPurpose (purpose, major) {
  return `${SCOPED_NETWORK_PROTOCOL}/${major}/${purpose}`
}


function normalizeNamespace (value, protocolMajor, { verifiedNamespaceProof = null } = {}) {
  const descriptor = b4a.isBuffer(value) || value instanceof Uint8Array
    ? decodePublisherNamespaceDescriptor(b4a.from(value), { protocolMajor, supportedCapabilities: [PUBLISHER_CATALOG_CAPABILITY] })
    : value
  verifyPublisherNamespaceDescriptor(descriptor, {
    protocolMajor,
    supportedCapabilities: [PUBLISHER_CATALOG_CAPABILITY],
    genesisRootKey: descriptor?.catalogEpoch === 0 ? descriptor.publisherRootKey : undefined,
  })
  if (descriptor.catalogEpoch !== 0 && !verifiedNamespaceProof) fail('rotated namespace requires a verified committed transition')
  return descriptor
}



function stableScopeDiagnostic (scope) {
  return {
    purpose: scope.purpose,
    protocolMajor: scope.protocolMajor,
    topicHex: scope.topicHex,
    scopeId: scope.scopeId,
    modes: [...scope.modes].sort(),
    sessions: scope.sessions.size,
    range: scope.range ? { ...scope.range } : null,
    coreKey: scope.coreKey || null,
    publisherId: scope.publisherId || null,
    indexerId: scope.indexerId || null,
    transportPublicKey: scope.transportPublicKey || null,
    publicAnnounced: scope.serverAnnounced === true,
  }
}

export function createScopedNetworkRuntime (options = {}) {
  if (!options.swarm || typeof options.swarm.join !== 'function') fail('swarm is required')
  const swarm = options.swarm
  const store = options.store
  const catalogRegistry = options.catalogRegistry || null
  // Optional first-hand delivery evidence; retention itself still replicates without it.
  const authorizePublication = typeof options.authorizePublication === 'function'
    ? options.authorizePublication
    : async () => false
  const authorizeConsumerWork = typeof options.authorizeConsumerWork === 'function'
    ? options.authorizeConsumerWork
    : async () => true
  const onCatalogUpdate = typeof options.onCatalogUpdate === 'function'
    ? options.onCatalogUpdate
    : null
  const protocolMajor = Number(options.protocolMajor ?? PROTOCOL_MAJOR)
  if (protocolMajor !== PROTOCOL_MAJOR) fail('unsupported protocol major')
  const assetTransferTimeoutMs = Number(options.assetTransferTimeoutMs ?? ASSET_TRANSFER_TIMEOUT_MS)
  if (!Number.isSafeInteger(assetTransferTimeoutMs) ||
      assetTransferTimeoutMs < 1 ||
      assetTransferTimeoutMs > ASSET_TRANSFER_TIMEOUT_MS) {
    fail('asset transfer timeout is out of bounds')
  }
  const networkId = String(options.networkId || 'peartube-main')
  const currentTime = () => {
    const value = typeof options.now === 'function' ? options.now() : Date.now()
    if (!Number.isSafeInteger(value) || value < 0) fail('current time must be a non-negative safe integer')
    return value
  }
  const bootstrapEnabled = options.bootstrapEnabled !== false
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const bootstrapLocatorKeyPair = options.bootstrapLocatorKeyPair ||
    (swarm?.keyPair?.publicKey && swarm?.keyPair?.secretKey ? swarm.keyPair : null)
  const bootstrapLocatorTtlMs = Number(options.bootstrapLocatorTtlMs ?? 5 * 60_000)
  const bootstrapLocatorRefreshMs = Number(options.bootstrapLocatorRefreshMs ?? Math.floor(bootstrapLocatorTtlMs / 2))
  const scheduleBootstrapLocatorRefresh = typeof options.setBootstrapLocatorTimer === 'function'
    ? options.setBootstrapLocatorTimer
    : setTimeout
  const cancelBootstrapLocatorRefresh = typeof options.clearBootstrapLocatorTimer === 'function'
    ? options.clearBootstrapLocatorTimer
    : clearTimeout
  const schedulePublisherRotationDrain = typeof options.setPublisherRotationDrainTimer === 'function'
    ? options.setPublisherRotationDrainTimer
    : setTimeout
  const cancelPublisherRotationDrain = typeof options.clearPublisherRotationDrainTimer === 'function'
    ? options.clearPublisherRotationDrainTimer
    : clearTimeout
  const scheduleOutboundRefill = typeof options.setOutboundRateTimer === 'function'
    ? options.setOutboundRateTimer
    : setTimeout
  const publisherRotationDrainMs = Number(options.publisherRotationDrainMs ?? 500)
  if (!Number.isSafeInteger(bootstrapLocatorTtlMs) || bootstrapLocatorTtlMs < 1 ||
      !Number.isSafeInteger(bootstrapLocatorRefreshMs) || bootstrapLocatorRefreshMs < 1 ||
      bootstrapLocatorRefreshMs >= bootstrapLocatorTtlMs ||
      !Number.isSafeInteger(publisherRotationDrainMs) || publisherRotationDrainMs < 1 ||
      publisherRotationDrainMs > 5_000) {
    fail('bootstrap locator refresh bounds are invalid')
  }
  const admission = options.admission?.reserve ? options.admission : createNetworkAdmission(options.admission)
  const publisherProofProviders = new Map()
  const publisherPageProviders = new Map()
  const bootstrapFollowAttempts = new Map()
  const publisherSyncStateRepository = options.publisherSyncStateRepository || null
  const verifiedLocatorAuthority = Symbol('verified bootstrap locator')
  const muxFactory = options.muxFactory || (connection => Protomux.from(connection))
  const scopes = new Map()
  const followedPublishers = new Map()
  const publisherFollowReasons = new Map()
  const publisherFollowWork = new Map()
  const reasonFollowedPublishers = new Set()
  const localPublishers = new Map()
  const localBootstrapLocators = new Map()
  const publisherRotationDrainTimers = new Set()
  const renditions = new Map()
  const archives = new Map()
  const blockEngine = createVerifiedBlockEngine()
  const activeConnections = new Map()
  const indexServices = new Map()
  const indexSequenceFloors = new Map()
  const directPeerRefs = new Map()
  const joinedDirectPeers = new Set()
  const indexTransitions = new Map()
  const connectionIds = new WeakMap()
  let nextConnectionId = 1
  const pairedConnections = new WeakSet()
  const counters = { acceptedFrames: 0, rejectedFrames: 0, outboundFrames: 0, inboundAssetFrames: 0, openedCatalogs: 0, openedCores: 0, closedSessions: 0, joinedTopics: 0, leftTopics: 0 }
  const recentErrors = []
  let status = 'idle'
  let closePromise = null
  let policyTail = Promise.resolve()
  let nextRequestId = 1
  let listening = false
  const hasInitialNetworkPolicy = options.initialNetworkPolicy != null
  const initialNetworkPolicy = options.initialNetworkPolicy || {}
  let networkEnabled = hasInitialNetworkPolicy ? initialNetworkPolicy.networkEnabled !== false : true
  let uploadPermission = hasInitialNetworkPolicy
    ? String(initialNetworkPolicy.uploadPermission || 'disabled')
    : 'disabled'
  let contributionUploadCeilingBytes = hasInitialNetworkPolicy
    ? Number(initialNetworkPolicy.contributionBudgetBytes || 0)
    : 0
  let archiveUploadCeilingBytes = hasInitialNetworkPolicy
    ? Number(initialNetworkPolicy.archiveBudgetBytes || 0)
    : 0
  let uploadCeilingBytes = hasInitialNetworkPolicy
    ? Number(initialNetworkPolicy.uploadCeilingBytes || 0)
    : 0
  let diskCeilingBytes = hasInitialNetworkPolicy
    ? Number(initialNetworkPolicy.diskCeilingBytes || 0)
    : Number.MAX_SAFE_INTEGER
  let contributionAllowed = initialNetworkPolicy.permissions?.contribute === true
  let archiveAllowed = initialNetworkPolicy.permissions?.archive === true
  let publicServingRequested = hasInitialNetworkPolicy &&
    initialNetworkPolicy.publicServingAllowed === true &&
    (contributionAllowed || archiveAllowed)
  let publicServingAllowed = publicServingRequested && networkEnabled
  let uploadAllowed = publicServingAllowed &&
    uploadPermission === 'enabled' &&
    uploadCeilingBytes > 0
  let contributionUploadedBytes = 0
  let archiveUploadedBytes = 0
  let uploadedBytes = 0
  // null bypasses rate limiting; zero prohibits outbound content bytes.
  let outboundBytesPerSecond = hasInitialNetworkPolicy
    ? normalizeOutboundRate(initialNetworkPolicy.outboundBytesPerSecond, null)
    : null
  let outboundTokens = outboundBytesPerSecond === null ? 0 : outboundCapacity()
  let outboundTokensAt = Number(now())
  let networkPolicyEpoch = 0
  const contentPolicy = {
    get status () { return status },
    get networkEnabled () { return networkEnabled },
    get uploadAllowed () { return uploadAllowed },
    get archiveAllowed () { return archiveAllowed },
    get contributionAllowed () { return contributionAllowed },
    get archiveUploadCeilingBytes () { return archiveUploadCeilingBytes },
    get archiveUploadedBytes () { return archiveUploadedBytes },
    get epoch () { return networkPolicyEpoch },
  }
  // State disabled serving explicitly instead of leaving peers to infer it.
  if (!uploadAllowed) {
    console.log('[ScopedNetwork] uploads are off; this device serves no content bytes',
      JSON.stringify({ uploadPermission, networkEnabled, uploadCeilingBytes }))
  }


  function normalizeOutboundRate (value, current) {
    if (value === undefined || value === null) return current
    const rate = Number(value)
    if (!Number.isSafeInteger(rate) || rate < 0) fail('invalid outbound rate')
    return rate
  }

  // One second of burst capacity, never smaller than one maximal block.
  function outboundCapacity () {
    return Math.max(outboundBytesPerSecond, MAX_ASSET_BLOCK_BYTES)
  }

  function refillOutboundTokens () {
    if (outboundBytesPerSecond === null) return
    const current = Number(now())
    const elapsed = current - outboundTokensAt
    // A clock that jumped backwards must not mint tokens.
    if (!(elapsed > 0)) {
      if (elapsed < 0) outboundTokensAt = current
      return
    }
    outboundTokensAt = current
    outboundTokens = Math.min(outboundCapacity(), outboundTokens + (elapsed * outboundBytesPerSecond) / 1000)
  }

  // Returns zero, a bounded wait, or null when the amount cannot be served.
  function outboundRateDelayMs (amount) {
    if (outboundBytesPerSecond === null) return 0
    if (outboundBytesPerSecond === 0 || amount > outboundCapacity()) return null
    refillOutboundTokens()
    if (outboundTokens >= amount) return 0
    const waitMs = Math.ceil(((amount - outboundTokens) * 1000) / outboundBytesPerSecond)
    return waitMs > MAX_OUTBOUND_RATE_DEFER_MS ? null : waitMs
  }

  async function acquireOutboundRate (amount) {
    if (amount === 0) return true
    // Bound retries so token contention cannot hold a session indefinitely.
    for (let attempt = 0; attempt <= MAX_OUTBOUND_RATE_DEFERRALS; attempt++) {
      const waitMs = outboundRateDelayMs(amount)
      if (waitMs === null) return false
      if (waitMs === 0) {
        if (outboundBytesPerSecond !== null) outboundTokens -= amount
        return true
      }
      await new Promise(resolve => {
        scheduleOutboundRefill(resolve, waitMs)?.unref?.()
      })
      if (status === 'closed' || !networkEnabled || !uploadAllowed) return false
    }
    return false
  }

  async function reservePolicyUpload (retentionClass, bytes) {
    const amount = Number(bytes)
    const contribution = retentionClass === 'contribution-cache'
    const archive = retentionClass === 'archive-pin'
    const allowed = contribution ? contributionAllowed : archive ? archiveAllowed : false
    const used = contribution ? contributionUploadedBytes : archiveUploadedBytes
    const ceiling = contribution ? contributionUploadCeilingBytes : archiveUploadCeilingBytes
    if (!allowed || !uploadAllowed || !networkEnabled || !Number.isSafeInteger(amount) || amount < 0 ||
        uploadedBytes + amount > uploadCeilingBytes || used + amount > ceiling) return null
    // Charge before waiting so concurrent deferred sends cannot breach the ceiling.
    if (contribution) contributionUploadedBytes += amount
    else archiveUploadedBytes += amount
    uploadedBytes += amount
    if (!await acquireOutboundRate(amount)) {
      if (contribution) contributionUploadedBytes -= amount
      else archiveUploadedBytes -= amount
      uploadedBytes -= amount
      return null
    }
    let committed = false
    let released = false
    return {
      commit () {
        committed = true
      },
      release () {
        if (released || committed) return
        released = true
        if (contribution) contributionUploadedBytes -= amount
        else archiveUploadedBytes -= amount
        uploadedBytes -= amount
        // Nothing left the device, so the rate was never actually spent.
        if (outboundBytesPerSecond !== null) {
          outboundTokens = Math.min(outboundCapacity(), outboundTokens + amount)
        }
      },
    }
  }

  function normalizeRetentionClass (value) {
    if (value === 'archive-pin') return value
    if (value === 'contribution-cache') return value
    return archiveAllowed && !contributionAllowed ? 'archive-pin' : 'contribution-cache'
  }

  function retentionClassAllowed (retentionClass) {
    if (retentionClass === 'archive-pin') {
      return archiveAllowed && archiveUploadCeilingBytes > 0
    }
    return contributionAllowed && contributionUploadCeilingBytes > 0
  }

  function scopeUploadRetentionClass (scope) {
    const retentionClasses = scope?.retentionClasses instanceof Set
      ? scope.retentionClasses
      : new Set([normalizeRetentionClass(scope?.retentionClass)])
    if (retentionClasses.has('contribution-cache') && retentionClassAllowed('contribution-cache')) return 'contribution-cache'
    if (retentionClasses.has('archive-pin') && retentionClassAllowed('archive-pin')) return 'archive-pin'
    return null
  }

  function scopeMayServe (scope) {
    if (scope.purpose === 'acquisition-discovery' || scope.purpose === 'acquisition') {
      return scope.discoveryServer === true
    }
    if (!uploadAllowed) return false
    if (scope.purpose === 'bootstrap') return true
    if (scope.purpose === 'asset') return scopeUploadRetentionClass(scope) !== null
    if (scope.purpose === 'publisher') {
      return scope.modes?.has?.('local') === true && scopeUploadRetentionClass(scope) !== null
    }
    return (scope.purpose === 'archive' || scope.purpose === 'archive-discovery') &&
      retentionClassAllowed('archive-pin')
  }

  function scopeMayAttach (scope) {
    if (scope.purpose === 'publisher') {
      // Candidate publisher scopes carry only the bounded namespace proof needed for promotion.
      return scope.modes.has('followed') || scope.modes.has('candidate') || scopeMayServe(scope)
    }
    if (scope.purpose === 'archive' || scope.purpose === 'archive-discovery') return scopeMayServe(scope)
    return true
  }

  function recordProtocolError (scope, peerId, error) {
    // Surface catalog-affecting failures in ordinary runtime diagnostics.
    console.log('[ScopedNetwork] scope error:', scope.purpose, String(scope.scopeId).slice(0, 16),
      String(error?.code || 'SCOPED_NETWORK_REJECTED'), String(error?.message || error || '').slice(0, 160))
    recentErrors.push({
      purpose: scope.purpose,
      scopeId: scope.scopeId,
      peerId,
      code: String(error?.code || 'SCOPED_NETWORK_REJECTED'),
      message: String(error?.message || error || 'unknown scoped network error').slice(0, 256),
    })
    if (recentErrors.length > 16) recentErrors.shift()
  }

  function findScope (purpose, topic) {
    const id = `${purpose}:${topicHex(topic)}`
    return scopes.get(id) || null
  }

  function ensureScopeDiscovery (scope) {
    if (scope.direct) return null
    if (!networkEnabled || scope.closed) return null
    if (scope.discovery) {
      if (scope.discoverySuspended) {
        scope.discoverySuspended = false
        scope.serverAnnounced = scope.discoveryServer == null ? scopeMayServe(scope) : scope.discoveryServer === true
        void Promise.resolve(scope.discovery.resume?.()).catch(() => {})
      }
      return scope.discovery
    }
    const server = scope.discoveryServer == null ? scopeMayServe(scope) : scope.discoveryServer === true
    const client = scope.discoveryClient == null ? true : scope.discoveryClient === true
    if (!server && !client) return null
    const discovery = swarm.join(scope.topic, { server, client })
    scope.serverAnnounced = server
    scope.discovery = discovery
    scope.discoverySuspended = false
    Promise.resolve(discovery?.flushed?.()).catch(() => {})
    return discovery
  }

  async function suspendScopeDiscovery (scope) {
    if (!scope.discovery || scope.discoverySuspended) return
    if (typeof scope.discovery.suspend === 'function') {
      await scope.discovery.suspend()
      scope.discoverySuspended = true
      scope.serverAnnounced = false
      return
    }
    await cleanupResource(scope.discovery, ['destroy', 'close'])
    scope.discovery = null
    scope.discoverySuspended = false
    scope.serverAnnounced = false
  }

  async function rejoinScopeDiscovery (scope) {
    if (scope.direct || !scope.discovery) return
    await cleanupResource(scope.discovery, ['destroy', 'close'])
    scope.discovery = null
    scope.discoverySuspended = false
    scope.serverAnnounced = false
    ensureScopeDiscovery(scope)
  }

  function joinScope ({ purpose, topic, scopeId, mode, ...metadata }) {
    const topicBuffer = exactBuffer(topic, 32, 'topic')
    const id = `${purpose}:${topicHex(topicBuffer)}`
    let scope = scopes.get(id)
    if (scope) {
      scope.modes.add(mode)
      // Rejoining must reattach scopes whose channel closed while the connection stayed live.
      if (networkEnabled && !scope.closed) {
        for (const [connection, info] of activeConnections) attachScope(scope, connection, info)
      }
      return { scope, created: false }
    }
    scope = {
      id,
      purpose,
      topic: topicBuffer,
      topicHex: topicHex(topicBuffer),
      scopeId: String(scopeId),
      modes: new Set([mode]),
      serverAnnounced: false,
      sessions: new Map(),
      discovery: null,
      discoverySuspended: false,
      closed: false,
      ...metadata,
      protocolMajor,
    }
    scopes.set(id, scope)
    counters.joinedTopics++
    ensureScopeDiscovery(scope)
    if (networkEnabled && purpose !== 'index') {
      for (const [connection, info] of activeConnections) {
        attachScope(scope, connection, info)
      }
    }
    return { scope, created: true }
  }

  function connectionKey (connection, info = {}) {
    if (info.publicKey) return b4a.toString(info.publicKey, 'hex')
    if (connection?.remotePublicKey) return b4a.toString(connection.remotePublicKey, 'hex')
    let id = connectionIds.get(connection)
    if (!id) {
      id = `connection-${nextConnectionId++}`
      connectionIds.set(connection, id)
    }
    return id
  }


  function authenticatedRemoteKey (connection) {
    const value = connection?.remotePublicKey
    if ((!b4a.isBuffer(value) && !(value instanceof Uint8Array)) || value.byteLength !== 32) return null
    return b4a.toString(b4a.from(value), 'hex')
  }


  function notifyAcquisitionPeerClosed(scope, peerId, reason) {
    if ((scope.purpose !== 'acquisition-discovery' && scope.purpose !== 'acquisition') ||
        typeof scope.onPeerClose !== 'function') return
    try {
      Promise.resolve(scope.onPeerClose({
        peerId,
        purpose: scope.purpose,
        scopeId: scope.scopeId,
        reason,
      })).catch(() => {})
    } catch {
      // Peer observers do not own transport teardown.
    }
  }

  function closeSession (scope, peerId, reason, ownedSession = null) {
    const session = scope.sessions.get(peerId)
    if (!session || session.closed || (ownedSession && session !== ownedSession)) return false
    cancelAssetSummaryScan(session)
    closeAssetInventoryRequest(
      session,
      session.assetInventoryRequest,
      assetTransportError('DISCONNECTED', peerId, 'asset peer disconnected'),
    )
    for (const response of session.assetResponses?.values() || []) response.cancelled = true
    session.assetResponses?.clear()
    if (scope.purpose === 'asset') failAssetRequestPeer(scope, peerId, 'DISCONNECTED')
    if (scope.purpose === 'archive' && session.archiveRequest) {
      queueArchiveRetry(scope, session, session.archiveRequest)
    } else if (scope.purpose === 'archive') {
      clearArchiveTimer(session)
    }
    const channel = session.channel
    notifyAcquisitionPeerClosed(scope, peerId, reason)
    session.closed = true
    for (const cleanup of session.cleanupFns.splice(0)) {
      try { cleanup() } catch { /* best-effort session cleanup */ }
    }
    session.protocol.close(reason)
    try { channel?.close?.() } catch { /* best-effort channel close */ }
    if (scope.sessions.get(peerId) === session) scope.sessions.delete(peerId)
    counters.closedSessions++
    return true
  }



  function sendScopedFrame (tracked, purpose, type, payload) {
    if (!tracked || tracked.closed || tracked.channel?.closed || tracked.state !== 'active') return false
    if (nextRequestId > 0xffffffff) fail('scoped request id exhausted')
    const frame = encodePeerFrame({ purpose, type, requestId: nextRequestId++, payload })
    const sender = tracked.channel?.messages?.[0] || tracked.message
    if (!sender?.send) return false
    // Protomux false means queued backpressure; only a closed session is a send failure.
    const drained = sender.send(frame, tracked.channel)
    if (drained === false) {
      if (tracked.closed || tracked.channel?.closed) return false
      counters.backpressuredFrames = (counters.backpressuredFrames || 0) + 1
    }
    counters.outboundFrames++
    return true
  }
  const feedRuntime = createScopedFeedRuntime({
    options, protocolMajor, sendScopedFrame, joinScope, findScope, leaveScope, stableScopeDiagnostic, hex32,
  })
  const {
    handleFeedFrame, syncFollowedFeed, provideIndexFeed, subscribeIndexFeed, followIndexFeed,
    unfollowIndexFeed, provideModerationFeed, subscribeModerationFeed, followModerationFeed,
    unfollowModerationFeed, getIndexFeedRecords, getModerationFeedRecords,
  } = feedRuntime
  const bootstrapRuntime = createBootstrapLocatorRuntime({
    options, protocolMajor, networkId, now, bootstrapLocatorKeyPair, bootstrapLocatorTtlMs,
    bootstrapLocatorRefreshMs, scheduleBootstrapLocatorRefresh, cancelBootstrapLocatorRefresh,
    localPublishers, localBootstrapLocators, sendScopedFrame, findScope, recordProtocolError,
    addPublisherFollowReason: request => addPublisherFollowReason(request), isPeerConnected,
    getStatus: () => status, isNetworkEnabled: () => networkEnabled,
    canPublish: () => contributionAllowed && uploadAllowed, allocateRequestId: () => nextRequestId++,
    counters, hex32,
  })
  const {
    bootstrapManager, handleBootstrapFrame, sendLocatorsToSession,
    publishBootstrapLocator, listBootstrapLocators,
  } = bootstrapRuntime
  const contentRuntime = createScopedContentRuntime({
    options, store, authorizePublication, authorizeConsumerWork, protocolMajor, networkId,
    assetTransferTimeoutMs, counters, renditions, archives, blockEngine,
    normalizeRetentionClass, scopeUploadRetentionClass, reservePolicyUpload,
    findScope, joinScope, leaveScope, closeSession, sendScopedFrame, recordProtocolError,
    cleanupResource, stableScopeDiagnostic, safeRange, hex32, policy: contentPolicy,
  })
  const {
    assetTransportError, closeAssetInventoryRequest, cancelAssetSummaryScan, failAssetRequestPeer,
    queueArchiveRetry, clearArchiveTimer, startArchivePumpWhenOpen, handleAssetFrame, handleArchiveFrame,
    pumpArchiveSessions,
    sendAssetError, retainAuthorizedRendition, releaseAuthorizedRendition, listAssetRanges,
    getActiveAssetSession, getActiveAssetPeerIds, listPeerAssetRanges, hasVerifiedAssetBlock,
    readVerifiedAssetBlock, requestAssetBlocks, revalidateRetainedRenditions, retainArchiveDiscovery,
    releaseArchiveDiscovery, publishArchiveRequest, publishArchivePledge, publishArchiveChallenge,
    publishArchiveChallengeProof, retainAuthorizedArchive, releaseAuthorizedArchive,
    createAuthorizedArchiveChallengeProof, verifyAuthorizedArchiveChallengeProof,
  } = contentRuntime
  const publisherRuntime = createPublisherCatalogRuntime({
    options, catalogRegistry, protocolMajor, now, onCatalogUpdate,
    publisherProofProviders, publisherPageProviders, publisherSyncStateRepository,
    followedPublishers, publisherFollowReasons, publisherFollowWork, reasonFollowedPublishers,
    localPublishers, bootstrapFollowAttempts, publisherRotationDrainTimers,
    schedulePublisherRotationDrain, cancelPublisherRotationDrain, publisherRotationDrainMs,
    verifiedLocatorAuthority, bootstrapManager, bootstrapRuntime,
    hasBootstrapLocatorKeyPair: Boolean(bootstrapLocatorKeyPair),
    sendScopedFrame, joinScope, findScope, leaveScope, rejoinScopeDiscovery, withBatchedConnectionWrites,
    stableScopeDiagnostic, recordProtocolError, normalizeNamespace, normalizeRetentionClass,
    retentionClassAllowed, hex32, exactBuffer, isPeerConnected,
    getActiveConnectionCount: () => activeConnections.size,
    policy: contentPolicy,
  })
  const {
    handlePublisherProofFrame, syncPublisherCatalog, restoreLocalPublisherScopes,
    scheduleReasonedPublisherFollow, addPublisherFollowReason, removePublisherFollowReason,
    getPublisherFollowReasons, followPublisher, followBootstrapLocator,
    providePublisherNamespaceProof, provideLocalPublisherNamespaceProof, unfollowPublisher,
    publishLocalPublisherCatalog, rebindLocalPublisherCatalog, resolveLocalPublisherCatalog,
  } = publisherRuntime

  async function cleanupResource (resource, methods) {
    if (!resource) return
    for (const method of methods) {
      if (typeof resource[method] !== 'function') continue
      await resource[method]()
      return
    }
  }

  async function leaveScope (scope, mode = null) {
    if (!scope || scope.closed) return false
    if (mode) scope.modes.delete(mode)
    if (scope.modes.size > 0) return false
    scope.closed = true
    for (const pending of scope.feedPending?.values() || []) {
      clearTimeout(pending.timer)
      pending.reject(Object.assign(new Error('feed scope released'), { code: 'FEED_SCOPE_RELEASED' }))
    }
    scope.feedPending?.clear()
    if (scope.proofPending) {
      clearTimeout(scope.proofPending.timer)
      scope.proofPending.reject(Object.assign(new Error('publisher proof scope released'), { code: 'PUBLISHER_PROOF_SCOPE_RELEASED' }))
      scope.proofPending = null
    }
    if (scope.catalogPagePending) {
      clearTimeout(scope.catalogPagePending.timer)
      scope.catalogPagePending.reject(Object.assign(new Error('publisher catalog scope released'), { code: 'PUBLISHER_CATALOG_SCOPE_RELEASED' }))
      scope.catalogPagePending = null
    }
    await contentRuntime.prepareScopeClose(scope)
    for (const peerId of [...scope.sessions.keys()]) closeSession(scope, peerId, 'scope-released')
    await contentRuntime.finalizeScopeClose(scope)
    await cleanupResource(scope.discovery, ['destroy', 'close'])
    scopes.delete(scope.id)
    counters.leftTopics++
    return true
  }

  function authorizeScopeConnection (scope, { peerId, connection, requestedCoreKey, tracked } = {}) {
    if (!networkEnabled) return { status: 'rejected', reason: 'network-policy-disabled' }
    if (!scope || scope.closed) return { status: 'rejected', reason: 'scope-not-retained' }
    if (scope.purpose === 'index' && !scope.feedKind) {
      if (!scope.announcement || !scope.transportPublicKey) return { status: 'rejected', reason: 'index-service-not-retained' }
      const liveRemoteKey = authenticatedRemoteKey(connection)
      if (!liveRemoteKey || liveRemoteKey !== scope.transportPublicKey) return { status: 'rejected', reason: 'index-transport-key-mismatch' }
      return { status: 'authorized', action: 'index-service', indexerId: scope.indexerId }
    }
    if (scope.purpose === 'acquisition-discovery') {
      return { status: 'authorized', action: 'acquisition-discovery' }
    }
    if (scope.purpose === 'acquisition') {
      const liveRemoteKey = authenticatedRemoteKey(connection)
      if (!liveRemoteKey || !scope.allowedPeerIds?.has?.(liveRemoteKey)) {
        return { status: 'rejected', reason: 'acquisition-audience-mismatch' }
      }
      return { status: 'authorized', action: 'acquisition-work', assignmentId: scope.assignmentId }
    }
    if (scope.purpose === 'bootstrap') return { status: 'authorized', action: 'metadata-only' }
    if (scope.purpose === 'publisher') {
      if (scope.modes.has('candidate') && !scope.modes.has('followed') && !scope.modes.has('local')) {
        return { status: 'authorized', action: 'namespace-proof', publisherId: scope.publisherId }
      }
      if (!scope.binding?.catalog || (!scope.modes.has('followed') && !scope.modes.has('local'))) return { status: 'rejected', reason: 'publisher-not-followed' }
      if (scope.modes.has('local') && !scope.modes.has('followed') && !scopeMayServe(scope)) {
        return { status: 'rejected', reason: 'publisher-serving-policy-disabled' }
      }
      if (connection) {
        counters.openedCatalogs++
      }
      return { status: 'authorized', action: 'catalog-pages', publisherId: scope.publisherId }
    }
    if (scope.purpose === 'index' || scope.purpose === 'moderation') {
      return { status: 'authorized', action: 'bounded-feed', feedId: scope.feedId }
    }
    if (scope.purpose === 'asset') {
      if (!scope.assetSession || !scope.coreKey) return { status: 'rejected', reason: 'core-not-authorized' }
      if (requestedCoreKey && hex32(requestedCoreKey, 'requestedCoreKey') !== scope.coreKey) return { status: 'rejected', reason: 'core-not-authorized' }
      return { status: 'authorized', action: 'retained-range', coreKey: scope.coreKey, range: { ...scope.range } }
    }
    if (scope.purpose === 'archive-discovery') {
      return scopeMayServe(scope)
        ? { status: 'authorized', action: 'archive-discovery' }
        : { status: 'rejected', reason: 'archive-policy-disabled' }
    }
    if (scope.purpose === 'archive') {
      if (!scopeMayServe(scope)) return { status: 'rejected', reason: 'archive-policy-disabled' }
      if (scope.archiveDiscovery) fail('archive custody scope cannot be discovery')
      const requested = requestedCoreKey ? hex32(requestedCoreKey, 'requestedCoreKey') : null
      const resource = requested
        ? [...(scope.archiveResources?.values() || [])].find(candidate => candidate.coreKey === requested)
        : null
      if (requested && !resource) return { status: 'rejected', reason: 'archive-range-not-authorized' }
      // Archive cores are deliberately not attached to Hypercore's unrestricted
      // responder. The retained exact ranges are local custody resources; scoped
      // challenge/transfer frames must enforce the range before any block is read.
      return { status: 'authorized', action: 'archive-range', coreKey: resource?.coreKey || null, range: resource ? { ...resource.range } : null }
    }
    return { status: 'rejected', reason: 'unknown-purpose' }
  }


  // One replication stream per core per connection. Hypercore verifies every
  // block it accepts, so nothing here has to build or check a proof.
  const replicatedCores = new WeakMap()

  function replicateAuthorizedCore (scope, connection, mux) {
    if (!scope.core || !connection) return
    let cores = replicatedCores.get(connection)
    if (!cores) {
      cores = new Set()
      replicatedCores.set(connection, cores)
    }
    const key = scope.coreKey || scope.scopeId
    if (cores.has(key)) return
    cores.add(key)
    try {
      scope.core.replicate(mux)
    } catch (error) {
      cores.delete(key)
      console.log('[ScopedNetwork] asset core replication failed:', error?.message)
    }
  }

  function attachScope (scope, connection, info) {
    if (!networkEnabled || scope.closed || (scope.purpose === 'index' && !scope.feedKind) || connection?.destroyed === true) return
    if (!scopeMayAttach(scope)) return
    const remoteKey = connectionKey(connection, info)
    if (!remoteKey) return
    if (scope.allowedPeerIds instanceof Set && !scope.allowedPeerIds.has(remoteKey)) return
    const existing = scope.sessions.get(remoteKey)
    if (existing) {
      const sameLiveConnection = existing.connection === connection &&
        activeConnections.has(connection) && !existing.closed && existing.channel?.closed !== true
      if (sameLiveConnection) return existing
      if (!existing.closed) closeSession(scope, remoteKey, 'connection-replaced', existing)
      else if (scope.sessions.get(remoteKey) === existing) scope.sessions.delete(remoteKey)
    }
    const mux = muxFactory(connection)
    if (!mux || typeof mux.createChannel !== 'function') return
    let ownedSession = null
    const isCurrentSession = () => ownedSession !== null &&
      !ownedSession.closed && scope.sessions.get(remoteKey) === ownedSession
    const protocolSession = createScopedProtocolSession({
      peerId: remoteKey,
      purpose: scope.purpose,
      topic: scope.topic,
      protocolMajor,
      requiredCapability: capabilityForPurpose(scope.purpose, { indexService: !scope.feedKind }),
      admission,
      isAdmissionExempt: frame =>
        (scope.purpose === 'bootstrap' && frame.type === 'locator') ||
        (scope.purpose === 'asset' && ASSET_TRANSFER_TYPES.has(frame.type)) ||
        (scope.purpose === 'archive' && ARCHIVE_TRANSFER_TYPES.has(frame.type)),
      onActivate: async () => {
        if (!isCurrentSession()) return
        const tracked = ownedSession
        if (scope.purpose === 'asset') {
          let current = false
          for (const authorization of scope.assetAuthorizations?.values?.() || []) {
            current = await authorizePublication({
              manifest: authorization.manifest,
              renditionId: authorization.renditionId,
              start: authorization.range.start,
              end: authorization.range.end,
            })
            if (current) break
          }
          if (!current) fail('publication manifest authorization failed')
          // Hypercore replication verifies asset blocks after scoped authorization.
          replicateAuthorizedCore(scope, connection, mux)
          if (!isCurrentSession()) return
        }
        const result = authorizeScopeConnection(scope, { peerId: remoteKey, connection, tracked })
        if (result.status !== 'authorized') fail(result.reason)
        if (isCurrentSession()) {
          if (scope.purpose === 'bootstrap') {
            // Activation is the only moment consumers receive retained publisher locators.
            sendLocatorsToSession(tracked)
          }
          if (scope.purpose === 'index' || scope.purpose === 'moderation') {
            void syncFollowedFeed(scope)
          }
          if (scope.purpose === 'publisher' && scope.modes.has('followed') && !scope.modes.has('local')) {
            void syncPublisherCatalog(scope).catch(error => {
              recordProtocolError(scope, remoteKey, error)
            })
          }
          // Asset bytes move only through verified Hypercore replication.
          if (scope.purpose === 'archive' && !scope.archiveDiscovery) {
            for (const failures of scope.archiveFailures?.values?.() || []) failures.delete(remoteKey)
            startArchivePumpWhenOpen(scope, tracked)
          }
          if (scope.purpose === 'archive-discovery' && scope.archivePeerListeners) { for (const listener of scope.archivePeerListeners) { try { listener({ peerId: remoteKey }) } catch { /* Observers must not affect transport. */ } } }
          if ((scope.purpose === 'acquisition-discovery' || scope.purpose === 'acquisition') &&
              typeof scope.onPeer === 'function') {
            await scope.onPeer({ peerId: remoteKey, purpose: scope.purpose, scopeId: scope.scopeId })
          }
        }
      },
      onFrame: frame => {
        if (!isCurrentSession()) fail('scoped session is no longer current')
        if (scope.purpose === 'bootstrap') return handleBootstrapFrame(frame, { peerId: remoteKey, tracked })
        if (scope.purpose === 'publisher') return handlePublisherProofFrame(scope, scope.sessions.get(remoteKey), frame)
        if (scope.purpose === 'index' || scope.purpose === 'moderation') return handleFeedFrame(scope, scope.sessions.get(remoteKey), frame)
        if (scope.purpose === 'asset') return handleAssetFrame(scope, ownedSession, frame)
        if (scope.purpose === 'archive') return handleArchiveFrame(scope, ownedSession, frame)
        if (scope.purpose === 'archive-discovery') return handleArchiveFrame(scope, ownedSession, frame)
        if ((scope.purpose === 'acquisition-discovery' || scope.purpose === 'acquisition') &&
            typeof scope.handleFrame === 'function') {
          return scope.handleFrame(frame, { peerId: remoteKey, purpose: scope.purpose, scopeId: scope.scopeId })
        }
        return frame.type === 'probe' ? { status: 'ok' } : fail('frame type is not allowed for this purpose')
      },
      onClose: () => {
        const tracked = ownedSession
        if (!tracked || tracked.closed || scope.sessions.get(remoteKey) !== tracked) return
        closeAssetInventoryRequest(
          tracked,
          tracked?.assetInventoryRequest,
          assetTransportError('DISCONNECTED', remoteKey, 'asset peer disconnected'),
        )
        for (const response of tracked?.assetResponses?.values() || []) response.cancelled = true
        tracked?.assetResponses?.clear()
        if (scope.purpose === 'asset') failAssetRequestPeer(scope, remoteKey)
        if (tracked?.archiveRequest) {
          queueArchiveRetry(scope, tracked, tracked.archiveRequest)
        } else {
          clearArchiveTimer(tracked)
        }
        if (tracked && !tracked.closed) {
          notifyAcquisitionPeerClosed(scope, remoteKey, 'channel-closed')
          cancelAssetSummaryScan(tracked)
          tracked.closed = true
          for (const cleanup of tracked.cleanupFns.splice(0)) {
            try { cleanup() } catch { /* best-effort session cleanup */ }
          }
          if (scope.sessions.get(remoteKey) === tracked) scope.sessions.delete(remoteKey)
          if (scope.catalogPagePending) {
            clearTimeout(scope.catalogPagePending.timer)
            scope.catalogPagePending.reject(Object.assign(new Error('publisher catalog peer disconnected'), { code: 'PUBLISHER_CATALOG_PEER_DISCONNECTED' }))
            scope.catalogPagePending = null
          }
          scope.catalogPreviousPageDigest = null
          counters.closedSessions++
        }
      },
    })
    let channel
    const message = {
      encoding: c.buffer,
      autoBatch: false,
      onmessage: encoded => protocolSession.receive(encoded).catch(error => {
        counters.rejectedFrames++
        recordProtocolError(scope, remoteKey, error)
        protocolSession.close(error.code || error.message)
        try { channel?.close?.() } catch { /* best-effort rejected channel close */ }
      }),
    }
    channel = mux.createChannel({
      protocol: protocolForPurpose(scope.purpose, protocolMajor),
      id: scope.topic,
      handshake: c.buffer,
      messages: [message],
      onopen: encoded => protocolSession.acceptHello(encoded).then(() => {
        if (scope.purpose === 'archive-discovery') console.log('[ScopedNetwork] archive-discovery session ACTIVE for peer:', remoteKey.slice(0, 16))
      }).catch(error => {
        counters.rejectedFrames++
        if (scope.purpose === 'archive-discovery') console.log('[ScopedNetwork] archive-discovery acceptHello REJECTED:', error?.message || String(error))
        protocolSession.close(error.code || error.message)
        recordProtocolError(scope, remoteKey, error)
        try { channel?.close?.() } catch { /* best-effort handshake channel close */ }
      }),
      onclose: isRemote => protocolSession.close(isRemote ? 'remote-channel-closed' : 'local-channel-closed'),
    })
    if (!channel) return
    const tracked = {
      peerId: remoteKey,
      connection,
      channel,
      message: channel.messages?.[0] || message,
      protocol: protocolSession,
      get state() { return this.closed ? 'closed' : this.protocol.state },
      closed: false,
      cleanupFns: [],
      assetRequestIndex: null,
      assetTransfer: null,
      assetTimer: null,
      assetServing: false,
      assetLastServed: -1,
      replicatedCoreKeys: new Set(),
      assetResponses: new Map(),
      assetSummaryScan: null,
      assetInventoryRequest: null,
      lastAssetTransferId: 0n,
      archiveRequest: null,
      archivePumping: false,
      archivePumpQueued: false,
      archiveTransfer: null,
      archiveTimer: null,
      archiveServing: false,
      archiveLastServed: new Map(),
      archiveServedBytes: 0,
      namespaceProofServed: false,
      namespaceProofReceived: false,
      catalogServePages: 0,
      catalogServeRecords: 0,
      catalogServeBytes: 0,
      catalogServeDigest: null,
      catalogAcceptPages: 0,
      catalogAcceptRecords: 0,
      catalogAcceptBytes: 0,
      catalogAcceptVerificationWork: 0,
      catalogAcceptInitialHeadLength: 0,
    }
    ownedSession = tracked
    scope.sessions.set(remoteKey, tracked)
    if (tracked.state === 'active' && scope.purpose === 'archive' && !scope.archiveDiscovery) startArchivePumpWhenOpen(scope, tracked)
    channel.open(encodeScopedHello({
      purpose: scope.purpose,
      topic: scope.topic,
      protocolMajor,
      capabilities: [capabilityForPurpose(scope.purpose, { indexService: !scope.feedKind })],
      maxFrameBytes: MAX_PEER_FRAME_BYTES,
    }))
    return tracked
  }

  // Cork every live mux so multi-channel local changes flush atomically per peer.
  async function withBatchedConnectionWrites (work) {
    const corked = []
    for (const connection of activeConnections.keys()) {
      const mux = muxFactory(connection)
      if (typeof mux?.cork !== 'function' || typeof mux?.uncork !== 'function') continue
      mux.cork()
      corked.push(mux)
    }
    try {
      return await work()
    } finally {
      for (const mux of corked) {
        try { mux.uncork() } catch { /* best-effort batch flush */ }
      }
    }
  }



  function handleConnection (connection, info = {}) {
    if (!networkEnabled) return
    const firstSeen = !activeConnections.has(connection)
    activeConnections.set(connection, info)
    if (firstSeen) {
      connection?.once?.('close', () => {
        activeConnections.delete(connection)
        const peerId = authenticatedRemoteKey(connection) || connectionKey(connection, info)
        for (const scope of scopes.values()) {
          const tracked = scope.sessions.get(peerId)
          if (tracked?.connection === connection) closeSession(scope, peerId, 'connection-closed', tracked)
        }
      })
    }
    let onlyIndexScopes = scopes.size > 0
    let matchesRetainedIndex = false
    const liveRemoteKey = authenticatedRemoteKey(connection)
    for (const scope of scopes.values()) {
      if (scope.purpose !== 'index' || scope.feedKind) onlyIndexScopes = false
      else if (liveRemoteKey !== null && scope.transportPublicKey === liveRemoteKey) matchesRetainedIndex = true
    }
    if (onlyIndexScopes) {
      if (!matchesRetainedIndex) return
      return
    }
    const mux = muxFactory(connection)
    if (mux && typeof mux.pair === 'function' && !pairedConnections.has(connection)) {
      pairedConnections.add(connection)
      for (const purpose of [...GENERIC_PURPOSES, 'index', 'moderation']) {
        mux.pair({ protocol: protocolForPurpose(purpose, protocolMajor), id: null }, id => {
          const scope = id ? findScope(purpose, id) : null
          if (scope) attachScope(scope, connection, info)
        })
      }
    }
    if (info.client !== false) {
      for (const scope of scopes.values()) {
        if (scope.purpose === 'acquisition-discovery' || scope.purpose === 'acquisition') {
          attachScope(scope, connection, info)
        }
      }
    }
    if (info.client !== false) {
      queueMicrotask(() => {
        if (!activeConnections.has(connection)) return
        mux?.cork?.()
        try {
          for (const scope of scopes.values()) {
            if ((scope.purpose !== 'index' || scope.feedKind) &&
                scope.purpose !== 'acquisition-discovery' &&
                scope.purpose !== 'acquisition') {
              attachScope(scope, connection, info)
            }
          }
        } finally {
          mux?.uncork?.()
        }
      })
    }
  }

  function joinDirectPeer (transportPublicKey) {
    if (!networkEnabled || status !== 'active' || joinedDirectPeers.has(transportPublicKey)) return
    if (typeof swarm.joinPeer !== 'function') fail('swarm.joinPeer is required for direct index services')
    swarm.joinPeer(b4a.from(transportPublicKey, 'hex'))
    joinedDirectPeers.add(transportPublicKey)
  }

  async function leaveDirectPeer (transportPublicKey) {
    if (!joinedDirectPeers.delete(transportPublicKey)) return false
    if (typeof swarm.leavePeer !== 'function') fail('swarm.leavePeer is required for direct index services')
    await swarm.leavePeer(b4a.from(transportPublicKey, 'hex'))
    return true
  }

  function retainDirectPeer (scope) {
    const transportPublicKey = scope.transportPublicKey
    let refs = directPeerRefs.get(transportPublicKey)
    if (!refs) {
      refs = new Set()
      directPeerRefs.set(transportPublicKey, refs)
    }
    refs.add(scope.id)
    try {
      joinDirectPeer(transportPublicKey)
    } catch (error) {
      refs.delete(scope.id)
      if (refs.size === 0) directPeerRefs.delete(transportPublicKey)
      throw error
    }
  }

  async function releaseDirectPeer (scope) {
    const transportPublicKey = scope.transportPublicKey
    const refs = directPeerRefs.get(transportPublicKey)
    if (!refs) return false
    refs.delete(scope.id)
    if (refs.size > 0) return false
    directPeerRefs.delete(transportPublicKey)
    return leaveDirectPeer(transportPublicKey)
  }

  async function leaveAllDirectPeers () {
    await Promise.allSettled([...joinedDirectPeers].map(leaveDirectPeer))
  }

  async function withIndexTransition (indexerId, work) {
    const previous = indexTransitions.get(indexerId) || Promise.resolve()
    let release
    const gate = new Promise(resolve => { release = resolve })
    const tail = previous.then(() => gate)
    indexTransitions.set(indexerId, tail)
    await previous
    try {
      return await work()
    } finally {
      release()
      if (indexTransitions.get(indexerId) === tail) indexTransitions.delete(indexerId)
    }
  }


  async function activateNetwork () {
    if (status !== 'active' || !networkEnabled) return
    for (const retained of indexServices.values()) {
      if (!retained.client) retained.client = createRetainedIndexClient(retained.announcement, retained.limits)
      else retained.client.resume()
    }
    if (!listening) {
      swarm.on?.('connection', handleConnection)
      listening = true
    }
    if (bootstrapEnabled) {
      joinScope({
        purpose: 'bootstrap',
        topic: deriveBootstrapTopic({ protocolMajor, networkId }),
        scopeId: networkId,
        mode: 'bootstrap',
      })
    }
    await restoreLocalPublisherScopes()
    for (const scope of scopes.values()) ensureScopeDiscovery(scope)
    for (const transportPublicKey of directPeerRefs.keys()) joinDirectPeer(transportPublicKey)
    for (const connection of swarm.connections || []) handleConnection(connection)
    for (const [connection, info] of activeConnections) handleConnection(connection, info)
  }

  async function deactivateNetwork () {
    for (const retained of indexServices.values()) {
      retained.client?.suspend('network-policy-disabled')
    }
    if (listening) {
      swarm.off?.('connection', handleConnection)
      swarm.removeListener?.('connection', handleConnection)
      listening = false
    }
    for (const scope of scopes.values()) {
      for (const peerId of [...scope.sessions.keys()]) closeSession(scope, peerId, 'network-policy-disabled')
    }
    await Promise.allSettled([...scopes.values()].map(scope => suspendScopeDiscovery(scope)))
    await leaveAllDirectPeers()
  }

  async function restartTransferSessions (closeSessions = false) {
    for (const scope of scopes.values()) {
      scope.archiveFailures?.clear()
      if (!closeSessions) continue
      for (const peerId of [...scope.sessions.keys()]) {
        if (scope.purpose === 'asset' || scope.purpose === 'archive') {
          closeSession(scope, peerId, 'network-policy-changed')
        }
      }
    }
    if (!networkEnabled || status !== 'active') return
    for (const [connection, info] of activeConnections) {
      for (const scope of scopes.values()) {
        if ((scope.purpose !== 'index' || scope.feedKind) && scopeMayAttach(scope)) attachScope(scope, connection, info)
      }
    }
    await Promise.all([...scopes.values()].map(scope => pumpArchiveSessions(scope)))
  }

  function applyNetworkPolicy (policy = {}) {
    if (status === 'closed') fail('runtime is closed')
    const operation = policyTail.then(() => {
      if (status === 'closed') fail('runtime is closed')
      return applyNetworkPolicyTransition(policy)
    })
    policyTail = operation.catch(() => {})
    return operation
  }

  async function applyNetworkPolicyTransition (policy = {}) {
    const nextUploadPermission = String(policy.uploadPermission || 'disabled')
    const nextDiskCeilingBytes = Number(policy.diskCeilingBytes ?? diskCeilingBytes)
    const nextContributionAllowed = policy.permissions?.contribute === true
    const nextArchiveAllowed = policy.permissions?.archive === true
    const nextPublicServingRequested = policy.publicServingAllowed === true &&
      (nextContributionAllowed || nextArchiveAllowed)
    const nextContributionUploadCeilingBytes = Number(policy.contributionBudgetBytes ?? 0)
    const nextArchiveUploadCeilingBytes = Number(policy.archiveBudgetBytes ?? 0)
    const nextUploadCeilingBytes = Number(policy.uploadCeilingBytes ?? 0)
    if (!['disabled', 'manual', 'enabled'].includes(nextUploadPermission)) fail('invalid upload permission')
    if (!Number.isSafeInteger(nextContributionUploadCeilingBytes) || nextContributionUploadCeilingBytes < 0) fail('invalid contribution upload ceiling')
    if (!Number.isSafeInteger(nextArchiveUploadCeilingBytes) || nextArchiveUploadCeilingBytes < 0) fail('invalid archive upload ceiling')
    if (!Number.isSafeInteger(nextUploadCeilingBytes) || nextUploadCeilingBytes < 0) fail('invalid upload ceiling')
    if (!Number.isSafeInteger(nextDiskCeilingBytes) || nextDiskCeilingBytes < 0) fail('invalid disk ceiling')
    // An absent rate leaves the limit exactly where it was: a caller that only
    // moves the disk ceiling must not silently uncap the outbound path.
    const nextOutboundBytesPerSecond = normalizeOutboundRate(policy.outboundBytesPerSecond, outboundBytesPerSecond)

    const wasNetworkEnabled = networkEnabled
    const wasPublicServingRequested = publicServingRequested
    const wasUploadPermission = uploadPermission
    const wasContributionAllowed = contributionAllowed
    const wasArchiveAllowed = archiveAllowed
    const wasUploadCeilingBytes = uploadCeilingBytes
    const wasContributionUploadCeilingBytes = contributionUploadCeilingBytes
    const wasArchiveUploadCeilingBytes = archiveUploadCeilingBytes
    networkEnabled = policy.networkEnabled !== false
    uploadPermission = nextUploadPermission
    uploadCeilingBytes = nextUploadCeilingBytes
    contributionUploadCeilingBytes = nextContributionUploadCeilingBytes
    archiveUploadCeilingBytes = nextArchiveUploadCeilingBytes
    diskCeilingBytes = nextDiskCeilingBytes
    if (nextOutboundBytesPerSecond !== outboundBytesPerSecond) {
      // Refill against the old rate first so bytes already earned are not lost,
      // then reseat the bucket under the new one. A tightened rate must not
      // leave a stale burst behind, so the balance is clamped down too. Coming
      // from an uncapped path there is no prior consumption to carry, so the
      // first rate starts the device with a full burst rather than a stall.
      const wasUncapped = outboundBytesPerSecond === null
      if (!wasUncapped) refillOutboundTokens()
      outboundBytesPerSecond = nextOutboundBytesPerSecond
      outboundTokensAt = Number(now())
      if (outboundBytesPerSecond === null) outboundTokens = 0
      else if (wasUncapped) outboundTokens = outboundCapacity()
      else outboundTokens = Math.min(outboundTokens, outboundCapacity())
    }
    contributionAllowed = nextContributionAllowed
    archiveAllowed = nextArchiveAllowed
    publicServingRequested = nextPublicServingRequested
    publicServingAllowed = publicServingRequested && networkEnabled
    uploadAllowed = publicServingAllowed &&
      uploadPermission === 'enabled' &&
      uploadCeilingBytes > 0
    networkPolicyEpoch++
    const uploadPolicyChanged =
      wasPublicServingRequested !== publicServingRequested ||
      wasUploadPermission !== uploadPermission ||
      wasUploadCeilingBytes !== uploadCeilingBytes
    const contributionServingPolicyChanged =
      (wasContributionAllowed || contributionAllowed) && (
        wasContributionAllowed !== contributionAllowed ||
        wasContributionUploadCeilingBytes !== contributionUploadCeilingBytes ||
        uploadPolicyChanged
      )
    const archiveServingPolicyChanged =
      (wasArchiveAllowed || archiveAllowed) && (
        wasArchiveAllowed !== archiveAllowed ||
        wasArchiveUploadCeilingBytes !== archiveUploadCeilingBytes ||
        uploadPolicyChanged
      )
    if (contributionServingPolicyChanged || archiveServingPolicyChanged) {
      for (const scope of scopes.values()) {
        if (scope.purpose !== 'asset') continue
        const contributionChanged = scope.retentionClasses?.has?.('contribution-cache') &&
          contributionServingPolicyChanged
        const archiveChanged = scope.retentionClasses?.has?.('archive-pin') &&
          archiveServingPolicyChanged
        if (!contributionChanged && !archiveChanged) continue
        for (const tracked of scope.sessions.values()) {
          for (const response of tracked.assetResponses?.values?.() || []) {
            if (response.cancelled) continue
            response.cancelled = true
            try {
              sendAssetError(scope, tracked, response.range, ASSET_BLOCK_ERROR_CODES.UNAVAILABLE)
            } catch (error) {
              recordProtocolError(scope, tracked.peerId, error)
            }
          }
        }
      }
    }

    if (contributionServingPolicyChanged || archiveServingPolicyChanged) {
      const cutoverConnections = new Set()
      await Promise.allSettled([...scopes.values()].map(async scope => {
        const contributionScope = (scope.purpose === 'asset' || scope.purpose === 'publisher') &&
          scope.retentionClasses?.has?.('contribution-cache')
        const retainedArchiveScope = (scope.purpose === 'asset' || scope.purpose === 'publisher') &&
          scope.retentionClasses?.has?.('archive-pin')
        const archiveScope = scope.purpose === 'archive' || scope.purpose === 'archive-discovery'
        const contributionChanged = contributionScope && contributionServingPolicyChanged
        const archiveChanged = (archiveScope || retainedArchiveScope) && archiveServingPolicyChanged
        if (contributionChanged || archiveChanged) {
          for (const peerId of [...scope.sessions.keys()]) {
            const session = scope.sessions.get(peerId)
            if (!session) continue
            if (!closeSession(scope, peerId, 'network-policy-role-changed', session)) continue
            if (session.connection) cutoverConnections.add(session.connection)
          }
        }
        await rejoinScopeDiscovery(scope)
      }))
      for (const connection of cutoverConnections) {
        activeConnections.delete(connection)
        try { connection.destroy?.() } catch { /* fail closed after removing the cutover connection */ }
      }
    }
    if (wasNetworkEnabled && !networkEnabled) await deactivateNetwork()
    else if (!wasNetworkEnabled && networkEnabled) await activateNetwork()
    await restartTransferSessions(false)
    return {
      networkEnabled,
      uploadAllowed,
      publicServingAllowed,
      contributionAllowed,
      archiveAllowed,
      uploadPermission,
      uploadCeilingBytes,
      uploadedBytes,
      contributionUploadCeilingBytes,
      contributionUploadedBytes,
      archiveUploadCeilingBytes,
      archiveUploadedBytes,
      diskCeilingBytes,
      outboundBytesPerSecond,
      outboundRateEnforced: outboundBytesPerSecond !== null,
      policyEpoch: networkPolicyEpoch,
    }
  }

  async function start () {
    if (status === 'closed') fail('runtime is closed')
    if (status === 'active') return { status: 'active' }
    status = 'active'
    if (networkEnabled) await activateNetwork()
    for (const publisherId of publisherFollowReasons.keys()) scheduleReasonedPublisherFollow(publisherId)
    return { status: 'active' }
  }


  function retainedIndexClientLimits (limits) {
    return {
      ...limits,
      muxFactory,
      sequenceState: new Map(),
      now: currentTime,
    }
  }
  function createRetainedIndexClient (announcement, limits) {
    return createIndexQueryClient({
      announcement,
      limits: retainedIndexClientLimits(limits),
    })
  }
  function armIndexServiceExpiry (retained, announcement, limits) {
    const setTimer = limits.setTimeout || setTimeout
    let timer = null
    const schedule = () => {
      if (indexServices.get(retained.indexerId) !== retained || retained.announcement !== announcement) return
      const remaining = announcement.expiresAt - currentTime()
      if (remaining < 0) {
        void withIndexTransition(retained.indexerId, () =>
          releaseIndexServiceInternal(retained, 'announcement-expired')
        ).catch(() => {})
        return
      }
      timer = setTimer(schedule, Math.min(remaining + 1, 0x7fffffff))
      retained.expiryTimer = timer
      timer?.unref?.()
    }
    const remaining = announcement.expiresAt - currentTime()
    timer = setTimer(schedule, Math.min(Math.max(remaining + 1, 1), 0x7fffffff))
    timer?.unref?.()
    return timer
  }

  async function releaseIndexServiceInternal (retained, reason) {
    if (!retained || indexServices.get(retained.indexerId) !== retained) return false
    indexServices.delete(retained.indexerId)
    const clearTimer = retained.limits.clearTimeout || clearTimeout
    if (retained.expiryTimer) clearTimer(retained.expiryTimer)
    retained.expiryTimer = null
    retained.client?.close(reason)
    await leaveScope(retained.scope, retained.mode)
    await releaseDirectPeer(retained.scope)
    return true
  }

  async function retainIndexService (input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('retain index service input is required')
    for (const name of Object.keys(input)) {
      if (name !== 'announcement' && name !== 'limits') fail(`unsupported retain index service field ${name}`)
    }
    const { announcement, limits = {} } = input
    if (status !== 'active') fail('runtime is not active')
    const indexerId = hex32(announcement?.indexerId, 'indexerId')
    return withIndexTransition(indexerId, async () => {
      if (status !== 'active') fail('runtime is not active')
      const candidateSequenceFloors = new Map(indexSequenceFloors)
      if (!verifyIndexServiceAnnouncement(announcement, {
        now: currentTime(),
        sequenceState: candidateSequenceFloors,
        supportedDimensions: limits.supportedDimensions,
        supportedQueryCapabilities: limits.supportedQueryCapabilities,
      })) {
        fail('index service announcement is invalid, unsupported, expired, or replayed')
      }
      const transportPublicKey = hex32(announcement.transportPublicKey, 'transportPublicKey')
      const existing = indexServices.get(indexerId)
      const sameChannelIdentity = existing?.transportPublicKey === transportPublicKey
      if (sameChannelIdentity) {
        const previousLimits = existing.limits
        const previousTimer = existing.expiryTimer
        const candidateTimer = armIndexServiceExpiry(existing, announcement, limits)
        try {
          existing.client?.refreshAnnouncement(announcement, retainedIndexClientLimits(limits))
        } catch (error) {
          try { (limits.clearTimeout || clearTimeout)(candidateTimer) } catch { /* best-effort candidate timer cleanup */ }
          throw error
        }
        existing.announcement = announcement
        existing.limits = limits
        existing.scope.announcement = announcement
        existing.scope.limits = limits
        existing.expiryTimer = candidateTimer
        indexSequenceFloors.set(indexerId, announcement.sequence)
        if (previousTimer) {
          try { (previousLimits.clearTimeout || clearTimeout)(previousTimer) } catch { /* best-effort superseded timer cleanup */ }
        }
        return {
          status: 'superseded',
          indexerId,
          transportPublicKey,
          topic: stableScopeDiagnostic(existing.scope),
        }
      }
      if (existing) await releaseIndexServiceInternal(existing, 'announcement-superseded')
      if (status !== 'active') fail('runtime is not active')
      const mode = `index-service:${indexerId}`
      const topic = deriveIndexerTopic({ protocolMajor, indexerId })
      const { scope } = joinScope({
        purpose: 'index',
        topic,
        scopeId: indexerId,
        mode,
        direct: true,
        indexerId,
        transportPublicKey,
        announcement,
        limits,
      })
      let client = null
      try {
        if (networkEnabled) client = createRetainedIndexClient(announcement, limits)
        retainDirectPeer(scope)
      } catch (error) {
        client?.close('index-service-retain-failed')
        await leaveScope(scope, mode)
        throw error
      }
      const retained = {
        indexerId,
        transportPublicKey,
        announcement,
        client,
        limits,
        scope,
        mode,
        expiryTimer: null,
      }
      let initialExpiryTimer
      try {
        initialExpiryTimer = armIndexServiceExpiry(retained, announcement, limits)
      } catch (error) {
        retained.client?.close('index-service-retain-failed')
        await leaveScope(scope, mode)
        await releaseDirectPeer(scope)
        throw error
      }
      retained.expiryTimer = initialExpiryTimer
      indexServices.set(indexerId, retained)
      indexSequenceFloors.set(indexerId, announcement.sequence)
      return {
        status: existing ? 'superseded' : 'retained',
        indexerId,
        transportPublicKey,
        topic: stableScopeDiagnostic(scope),
      }
    })
  }

  async function releaseIndexService ({ indexerId } = {}) {
    const id = hex32(indexerId, 'indexerId')
    if (status === 'closed') return { status: 'released', indexerId: id, released: false }
    return withIndexTransition(id, async () => {
      const released = await releaseIndexServiceInternal(indexServices.get(id), 'index-service-released')
      return { status: 'released', indexerId: id, released }
    })
  }

  function listRetainedIndexServiceAdapters (limit = 8) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INDEX_SERVICE_ADAPTERS) {
      fail('index service adapter limit is out of bounds')
    }
    if (status === 'closed') return Object.freeze([])
    const selected = []
    for (const indexerId of indexServices.keys()) {
      let offset = 0
      while (offset < selected.length && selected[offset] < indexerId) offset++
      if (offset >= limit) continue
      selected.splice(offset, 0, indexerId)
      if (selected.length > limit) selected.pop()
    }
    return Object.freeze(selected.map(indexerId => Object.freeze({
      indexerId,
      queryIndexService: ({ query, signal } = {}) => queryIndexService({ indexerId, query, signal }),
    })))
  }

  function queryIndexService ({ indexerId, query, signal } = {}) {
    try {
      if (!networkEnabled) fail('network policy is disabled')
      if (status !== 'active') fail('runtime is not active')
      const id = hex32(indexerId, 'indexerId')
      if (!query || typeof query !== 'object' || Array.isArray(query)) fail('index query is required')
      const retained = indexServices.get(id)
      if (!retained) fail('index service is not retained')
      let connection = null
      for (const [candidate, info] of activeConnections) {
        if (info?.client === false) continue
        if (authenticatedRemoteKey(candidate) === retained.transportPublicKey) {
          connection = candidate
          break
        }
      }
      if (!connection) fail('index service connection is not active')
      if (!retained.client) fail('index query client is not active')
      return retained.client.queryIndex({ connection, query, signal })
    } catch (error) {
      return Promise.reject(error)
    }
  }


  function acquisitionScopeCallbacks(input = {}) {
    return {
      handleFrame: typeof input.onFrame === 'function' ? input.onFrame : null,
      onPeer: typeof input.onPeer === 'function' ? input.onPeer : null,
      onPeerClose: typeof input.onPeerClose === 'function' ? input.onPeerClose : null,
    }
  }

  async function retainAcquisitionDiscovery(input = {}) {
    if (status === 'closed') fail('runtime is closed')
    const requestedNetworkId = String(input.networkId || networkId)
    if (requestedNetworkId !== networkId) fail('acquisition discovery networkId mismatch')
    const discoveryServer = input.server === true
    const discoveryClient = input.client === true
    if (!discoveryServer && !discoveryClient) fail('acquisition discovery requires a server or client role')
    const { scope, created } = joinScope({
      purpose: 'acquisition-discovery',
      topic: deriveAcquisitionDiscoveryTopic({ protocolMajor, networkId }),
      scopeId: networkId,
      mode: 'acquisition-discovery',
      discoveryServer,
      discoveryClient,
      ...acquisitionScopeCallbacks(input),
    })
    const changed = scope.discoveryServer !== discoveryServer || scope.discoveryClient !== discoveryClient
    scope.discoveryServer = discoveryServer
    scope.discoveryClient = discoveryClient
    Object.assign(scope, acquisitionScopeCallbacks(input))
    if (!created && changed) await rejoinScopeDiscovery(scope)
    else ensureScopeDiscovery(scope)
    return stableScopeDiagnostic(scope)
  }

  async function releaseAcquisitionDiscovery() {
    const topic = deriveAcquisitionDiscoveryTopic({ protocolMajor, networkId })
    return leaveScope(findScope('acquisition-discovery', topic), 'acquisition-discovery')
  }

  async function retainAcquisitionAssignment(input = {}) {
    if (status === 'closed') fail('runtime is closed')
    const assignmentId = hex32(input.assignmentId, 'assignmentId')
    const peerId = hex32(input.peerId, 'peerId')
    const discoveryServer = input.server === true
    const discoveryClient = input.client === true
    if (!discoveryServer && !discoveryClient) fail('acquisition assignment requires a server or client role')
    const topic = deriveAcquisitionTopic({ protocolMajor, assignmentId })
    const { scope, created } = joinScope({
      purpose: 'acquisition',
      topic,
      scopeId: assignmentId,
      mode: 'acquisition',
      assignmentId,
      allowedPeerIds: new Set([peerId]),
      discoveryServer,
      discoveryClient,
      ...acquisitionScopeCallbacks(input),
    })
    if (!scope.allowedPeerIds?.has(peerId) || scope.allowedPeerIds.size !== 1) {
      fail('acquisition assignment audience mismatch')
    }
    const changed = scope.discoveryServer !== discoveryServer || scope.discoveryClient !== discoveryClient
    scope.discoveryServer = discoveryServer
    scope.discoveryClient = discoveryClient
    Object.assign(scope, acquisitionScopeCallbacks(input))
    if (!created && changed) await rejoinScopeDiscovery(scope)
    else ensureScopeDiscovery(scope)
    for (const [connection, info] of activeConnections) attachScope(scope, connection, info)
    return stableScopeDiagnostic(scope)
  }

  async function releaseAcquisitionAssignment(input = {}) {
    const assignmentId = hex32(input.assignmentId, 'assignmentId')
    const topic = deriveAcquisitionTopic({ protocolMajor, assignmentId })
    return leaveScope(findScope('acquisition', topic), 'acquisition')
  }

  function publishAcquisitionFrame(input = {}) {
    const purpose = String(input.purpose || '')
    const type = String(input.type || '')
    if ((purpose === 'acquisition-discovery' && !ACQUISITION_DISCOVERY_FRAME_TYPES.has(type)) ||
        (purpose === 'acquisition' && !ACQUISITION_WORK_FRAME_TYPES.has(type))) {
      fail('frame type is not allowed for acquisition purpose')
    }
    let topic
    if (purpose === 'acquisition-discovery') {
      topic = deriveAcquisitionDiscoveryTopic({ protocolMajor, networkId })
    } else if (purpose === 'acquisition') {
      topic = deriveAcquisitionTopic({ protocolMajor, assignmentId: input.assignmentId })
    } else {
      fail('invalid acquisition purpose')
    }
    const scope = findScope(purpose, topic)
    if (!scope || scope.closed) return { sent: 0, peerIds: [] }
    const peerId = input.peerId == null ? null : hex32(input.peerId, 'peerId')
    const sentPeerIds = []
    for (const [candidatePeerId, session] of scope.sessions) {
      if (peerId !== null && candidatePeerId !== peerId) continue
      if (sendScopedFrame(session, purpose, type, b4a.from(input.payload || []))) {
        sentPeerIds.push(candidatePeerId)
      }
    }
    return { sent: sentPeerIds.length, peerIds: sentPeerIds }
  }



  async function inspectIncomingFrame ({ purpose, topic, peerId = 'inspect', frame } = {}) {
    const scope = findScope(purpose, topic)
    if (!scope) return { status: 'rejected', reason: 'scope-not-retained' }
    const session = createScopedProtocolSession({
      peerId,
      purpose,
      topic: scope.topic,
      protocolMajor,
      requiredCapability: capabilityForPurpose(purpose, { indexService: !scope.feedKind }),
      admission,
      onFrame: value => purpose === 'bootstrap'
        ? handleBootstrapFrame(value, { peerId, tracked: null })
        : (value.type === 'probe' ? { status: 'ok' } : { status: 'rejected', reason: 'frame-type-not-allowed' }),
    })
    await session.acceptHello(encodeScopedHello({ purpose, topic: scope.topic, protocolMajor, capabilities: [capabilityForPurpose(purpose, { indexService: !scope.feedKind })] }))
    try {
      return await session.receive(frame)
    } catch (error) {
      counters.rejectedFrames++
      return { status: 'rejected', reason: error.code || error.message }
    } finally {
      session.close('inspection-complete')
    }
  }

  function authorizeConnection ({ purpose, topic, peerId = 'manual', connection, requestedCoreKey } = {}) {
    return authorizeScopeConnection(findScope(purpose, topic), { peerId, connection, requestedCoreKey })
  }

  function getDiagnostics () {
    const topicList = [...scopes.values()].map(stableScopeDiagnostic).sort((left, right) => left.topicHex.localeCompare(right.topicHex))
    const sessions = []
    for (const scope of scopes.values()) {
      for (const session of scope.sessions.values()) sessions.push({
        peerId: session.peerId,
        purpose: scope.purpose,
        topicHex: scope.topicHex,
        state: session.state,
        assetResponseCount: session.assetResponses?.size || 0,
        archiveServing: session.archiveServing === true,
      })
    }
    sessions.sort((left, right) => left.peerId.localeCompare(right.peerId) || left.topicHex.localeCompare(right.topicHex))
    return {
      status,
      publicWork: {
        activeAnnouncements: [...scopes.values()]
          .filter(scope => scope.serverAnnounced === true).length,
        activeServes: sessions.reduce((total, session) =>
          total + session.assetResponseCount + (session.archiveServing ? 1 : 0), 0),
        servedBytes: uploadedBytes,
      },
      selectedIndexerCount: Math.min(indexServices.size, 64),
      selectedIndexers: [...indexServices.values()]
        .sort((left, right) => String(left.indexerId).localeCompare(String(right.indexerId)))
        .slice(0, 8)
        .map((service, index) => ({
          id: `selected-${index + 1}`,
          status: service.client ? 'active' : 'pending',
        })),
      protocolMajor,
      networkId,
      topics: topicList,
      sessions,
      policy: {
        networkEnabled,
        uploadAllowed,
        uploadPermission,
        uploadCeilingBytes,
        uploadedBytes,
        contributionUploadCeilingBytes,
        contributionUploadedBytes,
        archiveUploadCeilingBytes,
        archiveUploadedBytes,
        diskCeilingBytes,
        outboundBytesPerSecond,
        outboundRateEnforced: outboundBytesPerSecond !== null,
        policyEpoch: networkPolicyEpoch,
      },
      counters: { ...counters },
      recentErrors: recentErrors.map(error => ({ ...error })),
    }
  }


  function isPeerConnected (peerId) {
    if (typeof peerId !== 'string' || !/^[0-9a-f]{64}$/.test(peerId)) return false
    for (const [connection, info] of activeConnections) {
      if (connectionKey(connection, info) === peerId) return true
    }
    return false
  }

  function getLocalTransportPeerId () {
    const publicKey = swarm?.keyPair?.publicKey
    if (!publicKey || b4a.from(publicKey).byteLength !== 32) return null
    return b4a.toString(b4a.from(publicKey), 'hex')
  }

  function close () {
    if (!closePromise) closePromise = closeRuntime()
    return closePromise
  }

  async function closeRuntime () {
    status = 'closed'
    if (listening) {
      swarm.off?.('connection', handleConnection)
      swarm.removeListener?.('connection', handleConnection)
      listening = false
    }
    for (const retained of indexServices.values()) {
      const clearTimer = retained.limits.clearTimeout || clearTimeout
      if (retained.expiryTimer) clearTimer(retained.expiryTimer)
      retained.expiryTimer = null
      retained.client?.close('runtime-closed')
    }
    await policyTail
    while (indexTransitions.size > 0) {
      await Promise.allSettled([...indexTransitions.values()])
    }
    publisherRuntime.closeFollowState()
    bootstrapRuntime.close()
    publisherRuntime.closeLocalState()
    renditions.clear()
    archives.clear()
    indexServices.clear()
    const closing = []
    for (const scope of [...scopes.values()]) {
      scope.modes.clear()
      closing.push(leaveScope(scope))
    }
    await Promise.allSettled(closing)
    await blockEngine.close()
    await leaveAllDirectPeers()
    directPeerRefs.clear()
    activeConnections.clear()
  }

  return {
    start, applyNetworkPolicy, retainIndexService, releaseIndexService, followPublisher, followBootstrapLocator,
    addPublisherFollowReason, removePublisherFollowReason, getPublisherFollowReasons,
    providePublisherNamespaceProof, provideLocalPublisherNamespaceProof, provideIndexFeed, subscribeIndexFeed,
    followIndexFeed, unfollowIndexFeed, provideModerationFeed, subscribeModerationFeed, followModerationFeed,
    unfollowModerationFeed, unfollowPublisher, publishLocalPublisherCatalog, rebindLocalPublisherCatalog,
    resolveLocalPublisherCatalog, retainAuthorizedRendition, releaseAuthorizedRendition, queryIndexService,
    listRetainedIndexServiceAdapters, listAssetRanges, getActiveAssetSession, getActiveAssetPeerIds,
    listPeerAssetRanges, hasVerifiedAssetBlock, readVerifiedAssetBlock, requestAssetBlocks,
    revalidateRetainedRenditions, retainArchiveDiscovery, releaseArchiveDiscovery, publishArchiveRequest,
    publishArchivePledge, publishArchiveChallenge, publishArchiveChallengeProof, retainAuthorizedArchive,
    releaseAuthorizedArchive, createAuthorizedArchiveChallengeProof, verifyAuthorizedArchiveChallengeProof,
    publishBootstrapLocator, listBootstrapLocators, getIndexFeedRecords, getModerationFeedRecords,
    retainAcquisitionDiscovery, releaseAcquisitionDiscovery, retainAcquisitionAssignment,
    releaseAcquisitionAssignment, publishAcquisitionFrame,
    getDiagnostics, authorizeConnection, getLocalTransportPeerId, isPeerConnected, inspectIncomingFrame, close,
  }
}

