import b4a from 'b4a'
import c from 'compact-encoding'
import Protomux from 'protomux'
import crypto from 'hypercore-crypto'

import { createNetworkAdmission } from './admission.js'
import {
  ASSET_BLOCK_ERROR_CODES,
  MAX_ASSET_BLOCKS_PER_REQUEST,
  MAX_ASSET_TRANSFER_ID,
  decodeAssetBlockError,
  decodeAssetBlockRequest,
  decodeAssetBlockResponse,
  decodeAssetIdPrefix,
  decodeAssetRangeSummaryPage,
  decodeAssetRangeSummaryRequest,
  encodeAssetBlockError,
  encodeAssetBlockRequest,
  encodeAssetBlockResponse,
  encodeAssetRangeSummaryPage,
  encodeAssetRangeSummaryRequest,
  encodePeerFrame,
  MAX_PEER_FRAME_BYTES,
  PROTOCOL_MAJOR,
} from './frame.js'
import {
  MAX_VERIFIED_BLOCK_BYTES,
  MAX_VERIFIED_PROOF_BYTES,
  VERIFIED_BLOCK_CHUNK_BYTES,
  createVerifiedBlockProof,
  decodeVerifiedBlockChunk,
  decodeVerifiedBlockProof,
  encodeVerifiedBlockChunk,
  encodeVerifiedBlockProof,
} from './block-protocol.js'
import { createVerifiedBlockEngine } from './verified-block-engine.js'
import {
  ARCHIVE_DISCOVERY_CAPABILITY,
  ARCHIVE_RANGE_CAPABILITY,
  ASSET_RENDITION_CAPABILITY,
  INDEX_QUERY_CAPABILITY,
  SCOPED_NETWORK_PROTOCOL,
  createScopedProtocolSession,
  encodeScopedHello,
} from './scoped-protocol.js'
export {
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
  deriveArchiveDiscoveryTopic,
  deriveArchiveTopic,
  deriveBootstrapTopic,
  deriveIndexTopic,
  deriveIndexerTopic,
  deriveModerationTopic,
  derivePublisherTopic,
  topicHex,
} from './topics.js'
import {
  BOOTSTRAP_LOCATOR_CAPABILITY,
  createBootstrapLocator,
} from '../discovery/bootstrap-protocol.js'
import { createBootstrapManager } from '../discovery/bootstrap-manager.js'
import { createPublisherManager } from '../discovery/publisher-manager.js'
import { INDEX_FEED_CAPABILITY } from '../indexing/feed-contract.js'
import { createIndexFeedManager } from '../indexing/feed-manager.js'
import { DEFAULT_CLOCK_DRIFT_MS } from '../validators.js'
import { createModerationManager } from '../moderation/manager.js'
import {
  decodeApplicationEnvelope,
  encodeApplicationEnvelope,
} from '../records/application-envelope.js'
import {
  PUBLISHER_CATALOG_CAPABILITY,
  decodePublisherNamespaceDescriptor,
  encodePublisherNamespaceDescriptor,
  verifyPublisherNamespaceDescriptor,
} from '../publisher/namespace.js'
import { verifyPublisherNamespaceProof } from '../publisher/namespace-proof.js'
import { decodePublisherCatalogFrame } from '../publisher/catalog-view.js'
import { decodePublisherOperationBody } from '../publisher/canonical.js'
import { verifyArchivePledge } from '../archive/pledge.js'
import { isArtworkRendition, normalizeAssetCoreRefV2 } from '../assets/rendition.js'
import { deriveStaticAssetTopic } from '../assets/static-core.js'
import { createAssetSession } from '../assets/asset-session.js'
import { verifyIndexServiceAnnouncement } from '../indexer/service-announcement.js'
import { createIndexQueryClient } from '../indexer/protocol.js'
import {
  assertProtocolCompatibility,
  createProtocolAdvertisement,
  MAX_PROTOCOL_CAPABILITIES,
} from './version.js'


export const MODERATION_FEED_CAPABILITY = 'moderation-feed:v1'

const GENERIC_PURPOSES = Object.freeze(['bootstrap', 'publisher', 'asset', 'archive', 'archive-discovery'])
const MAX_ASSET_BLOCK_BYTES = MAX_VERIFIED_BLOCK_BYTES
const MAX_ASSET_PROOF_BYTES = MAX_VERIFIED_PROOF_BYTES
const MAX_ARCHIVE_CHALLENGE_PROOF_BYTES = 320 * 1024
const MAX_CATALOG_PAGE_RECORDS = 64
const MAX_CATALOG_SESSION_PAGES = 128
const MAX_CATALOG_SESSION_RECORDS = 4096
const MAX_CATALOG_SESSION_BYTES = 4 * 1024 * 1024
const MAX_CATALOG_HEAD_DISTANCE = 4096
const MAX_CATALOG_VERIFICATION_WORK = 8192
const DEFAULT_CATALOG_BUDGET_WINDOW_MS = 60_000
const CATALOG_PAGE_TIMEOUT_MS = 10_000
const ASSET_CHUNK_BYTES = VERIFIED_BLOCK_CHUNK_BYTES
const ASSET_TRANSFER_TIMEOUT_MS = 10_000
// A rate-limited send waits for tokens rather than answering "unavailable":
// refusing marks the peer as failed for that block until the next policy
// change, which would turn a momentary throttle into permanent unavailability.
// The wait must stay well inside the requester's ASSET_TRANSFER_TIMEOUT_MS, so
// anything that cannot be served within this budget is refused instead.
const MAX_OUTBOUND_RATE_DEFER_MS = 4_000
const MAX_OUTBOUND_RATE_DEFERRALS = 4
const ASSET_TRANSPORT_ERROR_CODES = new Set([
  'INVALID_PROOF',
  'QUARANTINED',
  'DISCONNECTED',
  'TIMEOUT',
  'UNAVAILABLE',
])
const MAX_ASSET_PEERS_PER_REQUEST = 16
const MAX_ASSET_PEER_ID_BYTES = 128
const MAX_INDEX_SERVICE_ADAPTERS = 32
const ARCHIVE_CHALLENGE_PROOF_CHUNK_BYTES = 48 * 1024
const MAX_ARCHIVE_CHALLENGE_TRANSFERS = 16
const ARCHIVE_CHALLENGE_TRANSFER_TIMEOUT_MS = 10_000
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
const ARCHIVE_DISCOVERY_ENVELOPE_TYPES = new Set([
  'archive-request',
  'archive-pledge',
  'archive-challenge',
])
const ARCHIVE_DISCOVERY_TYPES = new Set([
  ...ARCHIVE_DISCOVERY_ENVELOPE_TYPES,
  'archive-challenge-proof',
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
    case 'index': return indexService ? INDEX_QUERY_CAPABILITY : INDEX_FEED_CAPABILITY
    case 'moderation': return MODERATION_FEED_CAPABILITY
    default: fail('unsupported purpose')
  }
}

const FEED_PAGE_FRAME_VERSION = 1
const MAX_FEED_CURSOR_BYTES = 256
const MAX_FEED_REQUEST_BYTES = 4096
const MAX_FEED_PAGE_ENVELOPE_BYTES = MAX_PEER_FRAME_BYTES - 1024
const FEED_FRAME_INPUT_FIELDS = Object.freeze([
  'purpose',
  'cursor',
  'minimumProtocolMajor',
  'protocolMinor',
  'requiredCapabilities',
])

function exactFeedFrameFields (value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('feed frame input is invalid')
  const actual = Object.keys(value).sort()
  const allowed = [...fields].sort()
  if (actual.some(field => !allowed.includes(field))) fail('feed frame input fields are invalid')
}

function normalizeFeedCursor (value) {
  if (typeof value !== 'string' || !value || b4a.byteLength(value) > MAX_FEED_CURSOR_BYTES) {
    fail('feed cursor is invalid')
  }
  return value
}

function normalizeFeedFramePurpose (value) {
  const purpose = String(value || '')
  if (purpose !== 'index' && purpose !== 'moderation') fail('feed frame purpose is invalid')
  return purpose
}

function encodeFeedFrameHeader (value) {
  const chunks = [
    c.encode(c.uint, FEED_PAGE_FRAME_VERSION),
    c.encode(c.uint, value.minimumProtocolMajor),
    c.encode(c.uint, value.protocolMinor),
    c.encode(c.uint, value.requiredCapabilities.length),
  ]
  for (const capability of value.requiredCapabilities) chunks.push(c.encode(c.string, capability))
  chunks.push(c.encode(c.string, value.cursor))
  return b4a.concat(chunks)
}

function normalizeFeedFrameInput (input, { response = false } = {}) {
  exactFeedFrameFields(input, response
    ? [...FEED_FRAME_INPUT_FIELDS, 'envelope']
    : FEED_FRAME_INPUT_FIELDS)
  const purpose = normalizeFeedFramePurpose(input.purpose)
  return {
    purpose,
    cursor: normalizeFeedCursor(input.cursor),
    ...createProtocolAdvertisement(input, {
      requiredCapabilities: [capabilityForPurpose(purpose)],
    }),
  }
}

function decodeFeedFrameHeader (state, options = {}) {
  const purpose = normalizeFeedFramePurpose(options.purpose)
  if (c.uint.decode(state) !== FEED_PAGE_FRAME_VERSION) fail('feed frame version is unsupported')
  const minimumProtocolMajor = c.uint.decode(state)
  const protocolMinor = c.uint.decode(state)
  const capabilityCount = c.uint.decode(state)
  if (capabilityCount > MAX_PROTOCOL_CAPABILITIES) fail('feed frame capabilities exceed bounded limit')
  const requiredCapabilities = new Array(capabilityCount)
  for (let index = 0; index < capabilityCount; index++) {
    requiredCapabilities[index] = c.string.decode(state)
  }
  const cursor = normalizeFeedCursor(c.string.decode(state))
  const advertisement = assertProtocolCompatibility({
    minimumProtocolMajor,
    protocolMinor,
    requiredCapabilities,
  }, {
    protocolMajor: options.protocolMajor,
    supportedCapabilities: options.supportedCapabilities || [capabilityForPurpose(purpose)],
    mandatoryCapabilities: [capabilityForPurpose(purpose)],
  })
  return { purpose, cursor, ...advertisement }
}

export function encodeFeedPageRequest (input = {}) {
  const normalized = normalizeFeedFrameInput(input)
  const payload = encodeFeedFrameHeader(normalized)
  if (payload.byteLength > MAX_FEED_REQUEST_BYTES) fail('feed request exceeds bounded limit')
  return payload
}

export function decodeFeedPageRequest (input, options = {}) {
  const payload = b4a.from(input || [])
  if (!payload.byteLength || payload.byteLength > MAX_FEED_REQUEST_BYTES) fail('feed request exceeds bounded limit')
  const state = c.state(0, payload.byteLength, payload)
  const decoded = decodeFeedFrameHeader(state, options)
  if (state.start !== state.end) fail('feed request has trailing bytes')
  if (!b4a.equals(encodeFeedFrameHeader(decoded), payload)) fail('feed request is noncanonical')
  const { purpose, ...result } = decoded
  return result
}

export function encodeFeedPageResponse (input = {}) {
  const normalized = normalizeFeedFrameInput(input, { response: true })
  const envelope = encodeApplicationEnvelope(input.envelope)
  if (envelope.byteLength > MAX_FEED_PAGE_ENVELOPE_BYTES) fail('feed page exceeds bounded limit')
  return b4a.concat([
    encodeFeedFrameHeader(normalized),
    c.encode(c.buffer, envelope),
  ])
}

export function decodeFeedPageResponse (input, options = {}) {
  const payload = b4a.from(input || [])
  if (!payload.byteLength || payload.byteLength > MAX_PEER_FRAME_BYTES) fail('feed response exceeds bounded limit')
  const state = c.state(0, payload.byteLength, payload)
  const decoded = decodeFeedFrameHeader(state, options)
  const envelopeBytes = c.buffer.decode(state)
  if (envelopeBytes.byteLength > MAX_FEED_PAGE_ENVELOPE_BYTES) fail('feed page exceeds bounded limit')
  if (state.start !== state.end) fail('feed response has trailing bytes')
  const canonical = b4a.concat([
    encodeFeedFrameHeader(decoded),
    c.encode(c.buffer, envelopeBytes),
  ])
  if (!b4a.equals(canonical, payload)) fail('feed response is noncanonical')
  const { purpose, ...result } = decoded
  return {
    ...result,
    envelope: decodeApplicationEnvelope(envelopeBytes),
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


function assetAuthorizationId (renditionId, ownerId) {
  return `${renditionId}\0${ownerId}`
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
  // Where first-hand delivery is recorded. Absent, retention still replicates;
  // the title just reports "awaiting replication" until something else proves a
  // peer, which is what every consumer did before this was wired.
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
  const bootstrapManager = options.bootstrapManager || createBootstrapManager({
    now: options.now,
    trustedSigners: options.trustedBootstrapSigners || [],
    trustedRootIds: options.trustedBootstrapRootIds || [],
    protocolMajor,
    supportedCapabilities: [BOOTSTRAP_LOCATOR_CAPABILITY],
    verifyCatalogChain: options.verifyCatalogChain,
    // Locator verification defaulted to zero tolerance, so a device whose clock
    // sat seconds behind a publisher's rejected every locator issued "now" as
    // INVALID_LOCATOR and could never discover anything. Every other timestamp
    // check in the backend already allows this much drift; the locator's own
    // TTL still bounds how long one stays usable.
    maxClockSkewMs: options.maxClockSkewMs ?? DEFAULT_CLOCK_DRIFT_MS,
  })
  const indexFeedManager = options.indexFeedManager || createIndexFeedManager({ now: options.now })
  const moderationManager = options.moderationManager || createModerationManager({ now: options.now })
  const indexFeedProviders = new Map()
  const moderationFeedProviders = new Map()
  const publisherProofProviders = new Map()
  const publisherPageProviders = new Map()
  const bootstrapFollowAttempts = new Map()
  const publisherManager = options.publisherManager || createPublisherManager({
    supportedCapabilities: [PUBLISHER_CATALOG_CAPABILITY],
    ingestBatch: options.ingestPublisherBatch,
  })
  const publisherSyncStateRepository = options.publisherSyncStateRepository || null
  const catalogAdmissionLimits = Object.freeze({
    pages: Math.min(MAX_CATALOG_SESSION_PAGES, Number(options.catalogAdmissionLimits?.pages ?? MAX_CATALOG_SESSION_PAGES)),
    records: Math.min(MAX_CATALOG_SESSION_RECORDS, Number(options.catalogAdmissionLimits?.records ?? MAX_CATALOG_SESSION_RECORDS)),
    bytes: Math.min(MAX_CATALOG_SESSION_BYTES, Number(options.catalogAdmissionLimits?.bytes ?? MAX_CATALOG_SESSION_BYTES)),
    work: Math.min(MAX_CATALOG_VERIFICATION_WORK, Number(options.catalogAdmissionLimits?.work ?? MAX_CATALOG_VERIFICATION_WORK)),
    headDistance: Math.min(MAX_CATALOG_HEAD_DISTANCE, Number(options.catalogAdmissionLimits?.headDistance ?? MAX_CATALOG_HEAD_DISTANCE)),
  })
  const catalogBudgetWindowMs = Number(options.catalogAdmissionLimits?.windowMs ?? DEFAULT_CATALOG_BUDGET_WINDOW_MS)
  if (Object.values(catalogAdmissionLimits).some(limit => !Number.isSafeInteger(limit) || limit < 1) ||
      !Number.isSafeInteger(catalogBudgetWindowMs) || catalogBudgetWindowMs < 1) {
    fail('catalog admission limits are invalid')
  }
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
  let nextAssetTransferId = 1n
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
  // The cumulative ceiling says how many bytes this device may ever send; the
  // rate says how fast. Only the token bucket below makes the second number
  // real - without it "5 Mbit/s" is a label on a settings dialog. `null` means
  // no rate has been declared and the bucket is bypassed entirely; 0 means no
  // outbound content bytes at all.
  let outboundBytesPerSecond = hasInitialNetworkPolicy
    ? normalizeOutboundRate(initialNetworkPolicy.outboundBytesPerSecond, null)
    : null
  let outboundTokens = outboundBytesPerSecond === null ? 0 : outboundCapacity()
  let outboundTokensAt = Number(now())
  let networkPolicyEpoch = 0
  // A device that will not upload answers every block request with
  // "unavailable", so its peers read a fully synced catalog as awaiting
  // replication with nothing anywhere saying why. State it once at startup.
  if (!uploadAllowed) {
    console.log('[ScopedNetwork] uploads are off; this device serves no content bytes',
      JSON.stringify({ uploadPermission, networkEnabled, uploadCeilingBytes }))
  }

  function freshCatalogBudget(current = Number(now())) {
    return { windowStartedAt: current, pages: 0, records: 0, bytes: 0, work: 0, peers: {} }
  }

  function restoreCatalogBudget(value) {
    const current = Number(now())
    if (!value || !Number.isSafeInteger(value.windowStartedAt) ||
        current < value.windowStartedAt || current - value.windowStartedAt >= catalogBudgetWindowMs) {
      return freshCatalogBudget(current)
    }
    const budget = freshCatalogBudget(value.windowStartedAt)
    for (const field of ['pages', 'records', 'bytes', 'work']) {
      const amount = Number(value[field])
      budget[field] = Number.isSafeInteger(amount) && amount >= 0 ? amount : 0
    }
    if (value.peers && typeof value.peers === 'object' && !Array.isArray(value.peers)) {
      for (const [peerId, peer] of Object.entries(value.peers).slice(0, 128)) {
        if (!/^[0-9a-f]{64}$/.test(peerId) || !peer || typeof peer !== 'object') continue
        budget.peers[peerId] = {}
        for (const field of ['pages', 'records', 'bytes', 'work']) {
          const amount = Number(peer[field])
          budget.peers[peerId][field] = Number.isSafeInteger(amount) && amount >= 0 ? amount : 0
        }
      }
    }
    return budget
  }

  function addCatalogBudget(value, peerId, additions) {
    const budget = restoreCatalogBudget(value)
    const peer = { pages: 0, records: 0, bytes: 0, work: 0, ...(budget.peers[peerId] || {}) }
    for (const field of ['pages', 'records', 'bytes', 'work']) {
      budget[field] += additions[field]
      peer[field] += additions[field]
      if (budget[field] > catalogAdmissionLimits[field] || peer[field] > catalogAdmissionLimits[field]) {
        fail('catalog consumer cumulative window budget exceeded', 'PUBLISHER_CATALOG_WINDOW_BUDGET_EXCEEDED')
      }
    }
    budget.peers[peerId] = peer
    return budget
  }

  let catalogGlobalBudget = freshCatalogBudget()
  const catalogGlobalBudgetReady = (async () => {
    catalogGlobalBudget = restoreCatalogBudget(
      await publisherSyncStateRepository?.loadGlobal?.()
    )
  })()

  async function reserveCatalogBudget(scope, peerId, additions) {
    await catalogGlobalBudgetReady
    const publisherBudget = addCatalogBudget(scope.catalogBudget, peerId, additions)
    const globalBudget = addCatalogBudget(catalogGlobalBudget, peerId, additions)
    // Charge verification/admission work before catalog reduction. Invalid but
    // costly pages must not provide a free retry path.
    scope.catalogBudget = publisherBudget
    catalogGlobalBudget = globalBudget
    await Promise.all([
      persistPublisherSyncState(scope),
      publisherSyncStateRepository?.saveGlobal?.(catalogGlobalBudget),
    ])
  }

  async function persistPublisherSyncState(scope) {
    if (!publisherSyncStateRepository?.save) return
    await publisherSyncStateRepository.save(scope.publisherId, {
      version: 1,
      publisherId: scope.publisherId,
      catalogEpoch: scope.descriptor.catalogEpoch,
      cursor: scope.catalogResumeCursor,
      headDigest: scope.catalogHeadDigest,
      authorizationStateDigest: scope.catalogAuthorizationStateDigest,
      complete: scope.catalogComplete === true,
      budget: scope.catalogBudget,
    })
  }

  function normalizeOutboundRate (value, current) {
    if (value === undefined || value === null) return current
    const rate = Number(value)
    if (!Number.isSafeInteger(rate) || rate < 0) fail('invalid outbound rate')
    return rate
  }

  // One second of the rate, but never smaller than a single maximal block: a
  // bucket that cannot hold one block would refuse every block forever, which
  // is what a 250 kB/s data-saver device would do against a 256 KiB block.
  // Capacity only sets the burst; the long-run average is still the rate.
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

  // 0 when the bytes may leave now, a positive millisecond wait when they may
  // leave later, and null when the rate refuses them outright.
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
    // Bounded retries: a peer that keeps losing the race for tokens gives up
    // rather than holding its session open indefinitely.
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
    // Charge the cumulative total before waiting on the rate, so a deferred
    // send cannot be overtaken into breaching the ceiling while it waits.
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
      // A candidate scope exists only for the bounded namespace-proof exchange
      // that turns untrusted bootstrap metadata into a verified binding, and
      // authorizeConnection already restricts it to exactly that action: it has
      // no catalog binding, so no page or block can be served through it.
      // Gating it behind serving consent strands every locator-discovered
      // publisher, because neither side would ever attach the scope that
      // carries the proof.
      return scope.modes.has('followed') || scope.modes.has('candidate') || scopeMayServe(scope)
    }
    if (scope.purpose === 'archive' || scope.purpose === 'archive-discovery') return scopeMayServe(scope)
    return true
  }

  function recordProtocolError (scope, peerId, error) {
    // These are the failures that decide whether a followed publisher ever
    // becomes a visible catalog, and they were only ever readable through a
    // diagnostics call nobody makes while debugging an empty screen.
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
        scope.serverAnnounced = scopeMayServe(scope)
        void Promise.resolve(scope.discovery.resume?.()).catch(() => {})
      }
      return scope.discovery
    }
    const server = scopeMayServe(scope)
    const discovery = swarm.join(scope.topic, { server, client: true })
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
      // Re-joining is also how a scope recovers a peer it lost. A channel can
      // close while the connection carrying it stays up, and nothing else ever
      // re-attaches one: new sessions are only opened from a connection event
      // or from creating a scope, and this scope is neither new nor newly
      // connected. attachScope is a no-op for a connection already sessioned
      // here, so this costs nothing in the common case.
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

  function boundedAssetPeerId (value) {
    const peerId = String(value || '')
    if (!peerId || b4a.byteLength(peerId) > MAX_ASSET_PEER_ID_BYTES) fail('asset peerId is invalid')
    return peerId
  }

  function assetTransportError (code, peerId, message, cause = null) {
    if (!ASSET_TRANSPORT_ERROR_CODES.has(code)) fail('asset transport error code is invalid')
    const boundedCause = cause
      ? {
          code: String(cause.code || cause.name || 'ERROR').slice(0, 64),
          message: String(cause.message || cause).slice(0, 256),
        }
      : null
    const error = new Error(
      String(message || code).slice(0, 256),
      boundedCause ? { cause: boundedCause } : undefined,
    )
    error.name = 'AssetTransportError'
    error.code = code
    error.peerId = peerId === null || peerId === undefined ? null : boundedAssetPeerId(peerId)
    return error
  }

  function sealAssetInventoryRequest (session, request) {
    if (!request || request.closed || session?.assetInventoryRequest !== request) return false
    request.closed = true
    clearTimeout(request.timer)
    request.timer = null
    request.signal?.removeEventListener?.('abort', request.onAbort)
    session.assetInventoryRequest = null
    return true
  }

  function settleAssetInventoryRequest (request, error = null, page = null) {
    if (error) request.reject(error)
    else request.resolve(page)
  }

  function closeAssetInventoryRequest (session, request, error = null, page = null) {
    if (!sealAssetInventoryRequest(session, request)) return false
    settleAssetInventoryRequest(request, error, page)
    return true
  }

  function cancelAssetSummaryScan(session) {
    if (!session?.assetSummaryScan) return false
    session.assetSummaryScan.cancelled = true
    session.assetSummaryScan = null
    return true
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


  function encodeAssetIndex (index) {
    if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) fail('asset block index is out of bounds')
    const payload = b4a.alloc(4)
    payload.writeUInt32BE(index, 0)
    return payload
  }

  function decodeAssetIndex (payload) {
    if (!b4a.isBuffer(payload) || payload.byteLength !== 4) fail('asset block index payload is invalid')
    return payload.readUInt32BE(0)
  }

  function sendScopedFrame (tracked, purpose, type, payload) {
    if (!tracked || tracked.closed || tracked.channel?.closed || tracked.state !== 'active') return false
    if (nextRequestId > 0xffffffff) fail('scoped request id exhausted')
    const frame = encodePeerFrame({ purpose, type, requestId: nextRequestId++, payload })
    const sender = tracked.channel?.messages?.[0] || tracked.message
    if (!sender?.send) return false
    // Protomux returns stream.write()'s value: false means the frame is queued
    // and the writer should ease off, not that anything was dropped. Treating
    // it as a failure kills the catalog walk exactly when a page is large
    // enough to fill the socket buffer, which is precisely when it matters.
    // A closed session is the only real send failure.
    const drained = sender.send(frame, tracked.channel)
    if (drained === false) {
      if (tracked.closed || tracked.channel?.closed) return false
      counters.backpressuredFrames = (counters.backpressuredFrames || 0) + 1
    }
    counters.outboundFrames++
    return true
  }

  function sendBootstrapLocatorToSession(tracked, locator) {
    return sendScopedFrame(
      tracked,
      'bootstrap',
      'locator',
      encodeApplicationEnvelope(locator.envelope),
    )
  }

  // A bootstrap session sends everything in localBootstrapLocators the moment
  // it activates, so a publisher that never records one is invisible to every
  // consumer while still reporting a healthy catalog. The early returns below
  // are the difference between "discoverable" and "silently unreachable", so
  // they say which one happened instead of returning a bare 'unavailable'.
  async function refreshLocalBootstrapLocator(publisherId) {
    const local = localPublishers.get(publisherId)
    if (!local || !bootstrapLocatorKeyPair) {
      const reason = !local ? 'no-local-publisher-scope' : 'no-bootstrap-locator-keypair'
      console.log('[ScopedNetwork] bootstrap locator unavailable:', reason, publisherId.slice(0, 16))
      return { status: 'unavailable', reason }
    }
    const catalog = local.scope?.binding?.catalog
    if (typeof catalog?.getViewHead !== 'function' ||
        typeof catalog?.getAuthorizationState !== 'function') {
      console.log('[ScopedNetwork] bootstrap locator unavailable: catalog-not-inspectable', publisherId.slice(0, 16))
      return { status: 'unavailable', reason: 'catalog-not-inspectable' }
    }
    const issuedAt = Number(now())
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0 ||
        issuedAt > Number.MAX_SAFE_INTEGER - bootstrapLocatorTtlMs) {
      fail('bootstrap locator clock is invalid')
    }
    const signerId = b4a.toString(bootstrapLocatorKeyPair.publicKey, 'hex')
    const localWriterId = catalog.localWriterKey
      ? b4a.toString(b4a.from(catalog.localWriterKey), 'hex')
      : null
    const [head, authorization] = await Promise.all([
      catalog.getViewHead(),
      catalog.getAuthorizationState(),
    ])
    const writer = authorization?.writers?.find(candidate =>
      candidate?.key === localWriterId &&
      candidate?.signerKey === signerId
    )
    if (!writer || writer.revocation || writer.expiresAt < issuedAt ||
        !writer.capabilities?.includes('announce')) {
      fail('local locator signer is not an admitted announce writer', 'BOOTSTRAP_LOCATOR_SIGNER_UNAUTHORIZED')
    }
    const descriptor = local.scope.descriptor
    const locator = createBootstrapLocator({
      publisherId,
      catalogBootstrapKey: b4a.toString(descriptor.catalogBootstrapKey, 'hex'),
      catalogHead: hex32(head?.digest, 'catalogHead'),
      catalogEpoch: descriptor.catalogEpoch,
      authorizationChainDigest: hex32(head?.authorizationStateDigest, 'authorizationChainDigest'),
      rootSignerId: b4a.toString(descriptor.publisherRootKey, 'hex'),
      issuedAt,
      expiresAt: issuedAt + bootstrapLocatorTtlMs,
      keyPair: bootstrapLocatorKeyPair,
    })
    const previous = localBootstrapLocators.get(publisherId)
    if (previous?.timer) cancelBootstrapLocatorRefresh(previous.timer)
    const record = { locator, timer: null }
    localBootstrapLocators.set(publisherId, record)
    const delivery = networkEnabled ? await publishBootstrapLocator({ locator }) : null
    console.log('[ScopedNetwork] bootstrap locator recorded for', publisherId.slice(0, 16),
      'networkEnabled:', networkEnabled, 'deliveredToSessions:', delivery?.delivered ?? 0)
    if (status === 'active') {
      record.timer = scheduleBootstrapLocatorRefresh(() => {
        void refreshLocalBootstrapLocator(publisherId).catch(error => {
          const scope = localPublishers.get(publisherId)?.scope
          if (scope) recordProtocolError(scope, 'local', error)
        })
      }, bootstrapLocatorRefreshMs)
      record.timer.unref?.()
    }
    return { status: 'refreshed', locator }
  }

  async function handleFeedFrame(scope, tracked, frame) {
    const providers = scope.feedKind === 'index' ? indexFeedProviders : moderationFeedProviders
    if (frame.type === 'feed-page-request') {
      const { cursor } = decodeFeedPageRequest(frame.payload, {
        purpose: scope.purpose,
        protocolMajor,
      })
      const fetchPage = providers.get(scope.feedId)
      if (!fetchPage) return { status: 'rejected', reason: 'feed-not-provided' }
      const page = await fetchPage(cursor)
      if (!page?.envelope) return { status: 'rejected', reason: 'feed-page-unavailable' }
      if (!sendScopedFrame(tracked, scope.purpose, 'feed-page-response', encodeFeedPageResponse({
        purpose: scope.purpose,
        cursor,
        envelope: page.envelope,
      }))) return { status: 'rejected', reason: 'feed-response-send-failed' }
      return { status: 'sent' }
    }
    if (frame.type === 'feed-page-response') {
      const response = decodeFeedPageResponse(frame.payload, {
        purpose: scope.purpose,
        protocolMajor,
      })
      const pending = scope.feedPending?.get(response.cursor)
      if (!pending) return { status: 'rejected', reason: 'unexpected-feed-page' }
      clearTimeout(pending.timer)
      scope.feedPending.delete(response.cursor)
      pending.resolve({ envelope: response.envelope })
      return { status: 'accepted' }
    }
    return { status: 'rejected', reason: 'feed-frame-type-not-allowed' }
  }

  function requestFeedPage(scope, cursor) {
    const key = String(cursor || '0')
    if (scope.feedPending?.has(key)) return scope.feedPending.get(key).promise
    const tracked = [...scope.sessions.values()].find(session => !session.closed && session.state === 'active')
    if (!tracked) return Promise.reject(Object.assign(new Error('feed peer unavailable'), { code: 'FEED_PEER_UNAVAILABLE' }))
    let resolve, reject
    const promise = new Promise((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject })
    const timer = setTimeout(() => {
      scope.feedPending.delete(key)
      reject(Object.assign(new Error('feed page timed out'), { code: 'FEED_PAGE_TIMEOUT' }))
    }, 10_000)
    timer.unref?.()
    scope.feedPending.set(key, { promise, resolve, reject, timer })
    if (!sendScopedFrame(tracked, scope.purpose, 'feed-page-request', encodeFeedPageRequest({
      purpose: scope.purpose,
      cursor: key,
    }))) {
      clearTimeout(timer)
      scope.feedPending.delete(key)
      reject(Object.assign(new Error('feed page request failed'), { code: 'FEED_REQUEST_FAILED' }))
    }
    return promise
  }

  function encodeNamespaceProof(proof) {
    const payload = c.encode(c.any, proof)
    if (payload.byteLength > MAX_PEER_FRAME_BYTES - 1024) fail('namespace proof exceeds frame bound')
    return payload
  }

  function decodeNamespaceProof(payload) {
    const proof = c.decode(c.any, payload)
    if (!b4a.equals(c.encode(c.any, proof), payload)) fail('namespace proof response is noncanonical')
    if (!proof || typeof proof !== 'object' || !proof.genesis || !Array.isArray(proof.transitions)) {
      fail('namespace proof response is invalid')
    }
    return proof
  }

  function canonicalCatalogPayload(value, name) {
    const payload = c.encode(c.any, value)
    if (payload.byteLength > MAX_PEER_FRAME_BYTES - 1024) fail(`${name} exceeds frame bound`)
    return payload
  }

  function decodeCanonicalCatalogPayload(payload, name) {
    if (!b4a.isBuffer(payload) || payload.byteLength > MAX_PEER_FRAME_BYTES - 1024) fail(`${name} exceeds frame bound`)
    const value = c.decode(c.any, payload)
    if (!value || typeof value !== 'object' || !b4a.equals(c.encode(c.any, value), payload)) fail(`${name} is noncanonical`)
    return value
  }

  function pageDigest(value) {
    return crypto.hash(canonicalCatalogPayload(value, 'catalog page'))
  }

  function normalizeCatalogCursor(value, name = 'catalog cursor') {
    if (value === null) return null
    const text = String(value || '').toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(text)) fail(`${name} is invalid`)
    return text
  }

  function normalizeCatalogRequest(payload) {
    const value = decodeCanonicalCatalogPayload(payload, 'catalog page request')
    if (value.version !== 1) fail('catalog page request version is unsupported')
    const cursor = normalizeCatalogCursor(value.cursor)
    const previousPageDigest = value.previousPageDigest == null
      ? null
      : hex32(value.previousPageDigest, 'previousPageDigest')
    const expectedHeadDigest = value.expectedHeadDigest == null
      ? null
      : hex32(value.expectedHeadDigest, 'expectedHeadDigest')
    const catalogEpoch = Number(value.catalogEpoch)
    const limit = Number(value.limit)
    if (!Number.isSafeInteger(catalogEpoch) || catalogEpoch < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CATALOG_PAGE_RECORDS) {
      fail('catalog page request bounds are invalid')
    }
    return { version: 1, cursor, previousPageDigest, expectedHeadDigest, catalogEpoch, limit }
  }

  function normalizeCatalogResponse(payload, request) {
    const value = decodeCanonicalCatalogPayload(payload, 'catalog page response')
    if (value.version !== 1 || value.catalogEpoch !== request.catalogEpoch ||
        normalizeCatalogCursor(value.requestedCursor, 'requestedCursor') !== request.cursor ||
        (value.previousPageDigest == null ? null : hex32(value.previousPageDigest, 'previousPageDigest')) !== request.previousPageDigest ||
        (value.expectedHeadDigest == null ? null : hex32(value.expectedHeadDigest, 'expectedHeadDigest')) !== request.expectedHeadDigest) {
      fail('catalog page response does not match its request')
    }
    const nextCursor = normalizeCatalogCursor(value.nextCursor)
    const headDigest = hex32(value.headDigest, 'headDigest')
    const authorizationStateDigest = hex32(value.authorizationStateDigest, 'authorizationStateDigest')
    const pageDigestHex = hex32(value.pageDigest, 'pageDigest')
    const headLength = Number(value.headLength)
    if (!Number.isSafeInteger(headLength) || headLength < 0 || headLength > MAX_CATALOG_HEAD_DISTANCE) fail('catalog head distance exceeds bounded limit')
    if (!Array.isArray(value.entries) || value.entries.length > request.limit) fail('catalog page record bound exceeded')
    let prior = request.cursor
    const entries = value.entries.map(entry => {
      const operationId = normalizeCatalogCursor(entry?.operationId, 'operationId')
      const sourceWriterKey = exactBuffer(entry?.sourceWriterKey, 32, 'sourceWriterKey')
      const frame = b4a.from(entry?.frame || [])
      const operation = decodePublisherCatalogFrame(frame)
      const derivedId = b4a.toString(operation.recordId || operation.transitionId, 'hex')
      if (derivedId !== operationId || (prior !== null && operationId <= prior)) fail('catalog page ordering or provenance is invalid')
      prior = operationId
      return { operationId, sourceWriterKey, frame }
    })
    if (entries.length === 0 && nextCursor !== null) fail('empty catalog page cannot advance')
    if (nextCursor !== null && nextCursor !== entries.at(-1)?.operationId) fail('catalog page cursor linkage is invalid')
    const unsigned = {
      version: 1,
      requestedCursor: request.cursor,
      nextCursor,
      previousPageDigest: request.previousPageDigest,
      expectedHeadDigest: request.expectedHeadDigest,
      catalogEpoch: request.catalogEpoch,
      headLength,
      headDigest,
      authorizationStateDigest,
      entries,
    }
    if (b4a.toString(pageDigest(unsigned), 'hex') !== pageDigestHex) fail('catalog page digest mismatch')
    return { ...unsigned, pageDigest: pageDigestHex }
  }

  async function serveCatalogPage(scope, tracked, frame) {
    if (!tracked?.namespaceProofServed) fail('namespace proof is mandatory before catalog pages')
    const provider = publisherPageProviders.get(scope.publisherId)
    if (!provider) fail('catalog page provider is unavailable')
    const request = normalizeCatalogRequest(frame.payload)
    if (request.catalogEpoch !== provider.catalogEpoch) fail('catalog page epoch mismatch')
    // One session can carry more than one walk: a locator refresh, a retried
    // walk after a truncated one, or a head that moved all start a new page
    // sequence over the connection that is already open. A null previous
    // digest is exactly that restart. Refusing it killed the session, and the
    // consumer reported the result as a disconnected catalog peer it could
    // never recover from. Pages within a sequence must still chain, and the
    // per-session budgets below keep accumulating across sequences, so a
    // restart buys a peer nothing it could not already have.
    if (request.previousPageDigest === null) tracked.catalogServeDigest = null
    else if (request.previousPageDigest !== tracked.catalogServeDigest) fail('catalog page linkage mismatch')
    const head = await provider.catalog.getViewHead()
    const headDigest = hex32(head?.digest, 'headDigest')
    if (request.expectedHeadDigest !== null && request.expectedHeadDigest !== headDigest) fail('catalog head changed before cursor resume')
    const page = await provider.catalog.listAcceptedPage({ cursor: request.cursor, limit: request.limit })
    if (!page || !Array.isArray(page.entries) || page.entries.length > request.limit) fail('catalog provider returned an invalid page')
    const entries = page.entries.map(entry => ({
      operationId: normalizeCatalogCursor(entry?.operationId, 'operationId'),
      sourceWriterKey: exactBuffer(entry?.sourceWriterKey, 32, 'sourceWriterKey'),
      frame: b4a.from(entry?.frame || []),
    }))
    // NOTE: a page that encodes past the frame bound cannot simply be served in
    // smaller slices. Wire order is operation-id ascending (a hash order), and
    // causality is repaired only *within* a page, so a slice can separate an
    // operation from the namespace genesis or writer admission that authorizes
    // it. The consumer then applies nothing and reports the page inadmissible.
    // Fixing this needs either transport-level fragmentation of one logical
    // page or consumer-side deferral of operations whose dependencies have not
    // arrived yet; shrinking here alone corrupts the walk.
    const nextCursor = normalizeCatalogCursor(page.nextCursor)
    const unsigned = {
      version: 1,
      requestedCursor: request.cursor,
      nextCursor,
      previousPageDigest: request.previousPageDigest,
      expectedHeadDigest: request.expectedHeadDigest,
      catalogEpoch: provider.catalogEpoch,
      headLength: Number(head?.length),
      headDigest,
      authorizationStateDigest: hex32(head?.authorizationStateDigest, 'authorizationStateDigest'),
      entries,
    }
    const response = { ...unsigned, pageDigest: b4a.toString(pageDigest(unsigned), 'hex') }
    const payload = canonicalCatalogPayload(response, 'catalog page response')
    const entriesServed = entries
    const nextPages = tracked.catalogServePages + 1
    const nextRecords = tracked.catalogServeRecords + entriesServed.length
    const nextBytes = tracked.catalogServeBytes + payload.byteLength
    if (nextPages > MAX_CATALOG_SESSION_PAGES || nextRecords > MAX_CATALOG_SESSION_RECORDS ||
        nextBytes > MAX_CATALOG_SESSION_BYTES || nextRecords * 2 > MAX_CATALOG_VERIFICATION_WORK) {
      fail('catalog provider cumulative session budget exceeded')
    }
    if (!sendScopedFrame(tracked, 'publisher', 'catalog-page-response', payload)) fail('catalog page response send failed')
    tracked.catalogServePages = nextPages
    tracked.catalogServeRecords = nextRecords
    tracked.catalogServeBytes = nextBytes
    tracked.catalogServeDigest = response.pageDigest
    return { status: 'sent', records: entriesServed.length, nextCursor }
  }

  async function acceptCatalogPage(scope, tracked, frame) {
    const pending = scope.catalogPagePending
    if (!pending) fail('unexpected catalog page response')
    try {
      const response = normalizeCatalogResponse(frame.payload, pending.request)
      if (scope.catalogHeadDigest && scope.catalogHeadDigest !== response.headDigest) {
        // A publisher that appended since this walk began serves a newer head.
        // That is the catalog growing, not a publisher showing two faces, and
        // the signed advertised head checked immediately below is what decides
        // whether the response is authentic at all. Retarget the walk instead
        // of rejecting the publisher, which previously meant a catalog could
        // never gain a title once a device had synced it.
        if (scope.advertisedCatalogHead && scope.advertisedCatalogHead === response.headDigest) {
          // Adopt the signed locator's head, never the peer's claim. They are
          // equal here by the test above; taking it from the locator keeps the
          // provenance of this value obvious.
          scope.catalogHeadDigest = scope.advertisedCatalogHead
          scope.catalogAuthorizationStateDigest = null
          scope.catalogCursor = null
          scope.catalogResumeCursor = null
          scope.catalogPreviousPageDigest = null
          scope.catalogComplete = false
        } else {
          fail('catalog head equivocation detected')
        }
      }
      if (scope.advertisedCatalogHead && scope.advertisedCatalogHead !== response.headDigest) {
        fail('catalog response does not match the signed advertised head', 'PUBLISHER_CATALOG_ADVERTISED_HEAD_MISMATCH')
      }
      const nextPages = tracked.catalogAcceptPages + 1
      const nextRecords = tracked.catalogAcceptRecords + response.entries.length
      const nextBytes = tracked.catalogAcceptBytes + frame.payload.byteLength
      const nextWork = tracked.catalogAcceptVerificationWork + response.entries.length * 2
      if (nextPages > MAX_CATALOG_SESSION_PAGES || nextRecords > MAX_CATALOG_SESSION_RECORDS ||
          nextBytes > MAX_CATALOG_SESSION_BYTES || nextWork > MAX_CATALOG_VERIFICATION_WORK ||
          response.headLength - tracked.catalogAcceptInitialHeadLength > MAX_CATALOG_HEAD_DISTANCE) {
        fail('catalog consumer cumulative session budget exceeded')
      }
      const additions = {
        pages: 1,
        records: response.entries.length,
        bytes: frame.payload.byteLength,
        work: response.entries.length * 2,
      }
      scope.catalogComplete = false
      await reserveCatalogBudget(scope, tracked.peerId, additions)
      let ingestResult = { accepted: 0, rejected: 0 }
      if (response.entries.length > 0) {
        ingestResult = await scope.binding.catalog.ingestAcceptedPage(response.entries)
        if (ingestResult?.accepted !== response.entries.length || Number(ingestResult?.rejected || 0) !== 0) {
          fail('catalog page contained an inadmissible operation', 'PUBLISHER_CATALOG_PAGE_INGEST_REJECTED')
        }
      }
      tracked.catalogAcceptPages = nextPages
      tracked.catalogAcceptRecords = nextRecords
      tracked.catalogAcceptBytes = nextBytes
      tracked.catalogAcceptVerificationWork = nextWork
      scope.catalogVerifiedPages++
      scope.catalogVerifiedRecords += response.entries.length
      scope.catalogVerifiedBytes += frame.payload.byteLength
      scope.catalogVerificationWork += response.entries.length * 2
      scope.catalogHeadDigest ||= response.headDigest
      scope.catalogAuthorizationStateDigest ||= response.authorizationStateDigest
      scope.catalogCursor = response.nextCursor
      scope.catalogResumeCursor = response.entries.at(-1)?.operationId || scope.catalogResumeCursor
      scope.catalogPreviousPageDigest = response.pageDigest
      await persistPublisherSyncState(scope)
      clearTimeout(pending.timer)
      scope.catalogPagePending = null
      pending.resolve(response)
      return { status: 'accepted', records: response.entries.length }
    } catch (error) {
      clearTimeout(pending.timer)
      scope.catalogPagePending = null
      pending.reject(error)
      throw error
    }
  }

  async function handlePublisherProofFrame(scope, tracked, frame) {
    if (scope.retired) return { status: 'rejected', reason: 'publisher-epoch-retired' }
    if (frame.type === 'namespace-proof-request') {
      const proof = publisherProofProviders.get(scope.publisherId)
      if (!proof) return { status: 'rejected', reason: 'namespace-proof-unavailable' }
      if (!sendScopedFrame(tracked, 'publisher', 'namespace-proof-response', encodeNamespaceProof(proof))) {
        return { status: 'rejected', reason: 'namespace-proof-send-failed' }
      }
      tracked.namespaceProofServed = true
      return { status: 'sent' }
    }
    if (frame.type === 'namespace-proof-response') {
      const pending = scope.proofPending
      if (!pending) return { status: 'rejected', reason: 'unexpected-namespace-proof' }
      clearTimeout(pending.timer)
      scope.proofPending = null
      pending.resolve(decodeNamespaceProof(frame.payload))
      return { status: 'accepted' }
    }
    if (frame.type === 'catalog-page-request') return serveCatalogPage(scope, tracked, frame)
    if (frame.type === 'catalog-page-response') return acceptCatalogPage(scope, tracked, frame)
    return { status: 'rejected', reason: 'publisher-frame-type-not-allowed' }
  }

  async function awaitActiveScopedSession (scope, timeoutMs = 1_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const active = [...scope.sessions.values()].find(session => !session.closed && session.state === 'active')
      if (active) return active
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return null
  }

  async function requestNamespaceProof(scope) {
    if (scope.proofPending?.promise) return scope.proofPending.promise
    const tracked = await awaitActiveScopedSession(scope)
    if (!tracked) return Promise.reject(Object.assign(new Error('publisher proof peer unavailable'), { code: 'PUBLISHER_PROOF_PEER_UNAVAILABLE' }))
    let resolve, reject
    const promise = new Promise((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject })
    const timer = setTimeout(() => {
      if (scope.proofPending?.promise === promise) scope.proofPending = null
      reject(Object.assign(new Error('publisher proof timed out'), { code: 'PUBLISHER_PROOF_TIMEOUT' }))
    }, 10_000)
    timer.unref?.()
    scope.proofPending = { promise, resolve, reject, timer }
    if (!sendScopedFrame(tracked, 'publisher', 'namespace-proof-request', b4a.alloc(0))) {
      clearTimeout(timer)
      scope.proofPending = null
      reject(Object.assign(new Error('publisher proof request failed'), { code: 'PUBLISHER_PROOF_REQUEST_FAILED' }))
    }
    return promise
  }

  async function ensurePublisherNamespaceProof(scope) {
    const active = await awaitActiveScopedSession(scope)
    if (!active) fail('publisher proof peer unavailable', 'PUBLISHER_PROOF_PEER_UNAVAILABLE')
    if (scope.namespaceProofVerified && active.namespaceProofReceived) return scope.namespaceProofVerified
    const proof = await requestNamespaceProof(scope)
    const descriptor = scope.descriptor
    const verified = verifyPublisherNamespaceProof({
      locator: {
        publisherId: scope.publisherId,
        catalogBootstrapKey: b4a.toString(descriptor.catalogBootstrapKey, 'hex'),
        catalogEpoch: descriptor.catalogEpoch,
      },
      ...proof,
    })
    if (!b4a.equals(encodePublisherNamespaceDescriptor(verified.descriptor), encodePublisherNamespaceDescriptor(descriptor))) {
      fail('namespace proof does not match followed descriptor')
    }
    scope.namespaceProofVerified = verified
    active.namespaceProofReceived = true
    return verified
  }

  async function requestCatalogPage(scope, request) {
    if (scope.catalogPagePending) return scope.catalogPagePending.promise
    const tracked = await awaitActiveScopedSession(scope)
    if (!tracked) fail('publisher catalog peer unavailable', 'PUBLISHER_CATALOG_PEER_UNAVAILABLE')
    let resolve, reject
    const promise = new Promise((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject })
    const timer = setTimeout(() => {
      if (scope.catalogPagePending?.promise === promise) scope.catalogPagePending = null
      reject(Object.assign(new Error('publisher catalog page timed out'), { code: 'PUBLISHER_CATALOG_PAGE_TIMEOUT' }))
    }, CATALOG_PAGE_TIMEOUT_MS)
    timer.unref?.()
    scope.catalogPagePending = { promise, resolve, reject, timer, request }
    if (!sendScopedFrame(tracked, 'publisher', 'catalog-page-request', canonicalCatalogPayload(request, 'catalog page request'))) {
      clearTimeout(timer)
      scope.catalogPagePending = null
      reject(Object.assign(new Error('publisher catalog page request failed'), { code: 'PUBLISHER_CATALOG_PAGE_REQUEST_FAILED' }))
    }
    return promise
  }

  async function verifyCatalogCompletion(scope) {
    const catalog = scope.binding?.catalog
    if (typeof catalog?.getViewHead !== 'function') {
      fail('verified catalog head is unavailable', 'PUBLISHER_CATALOG_HEAD_UNAVAILABLE')
    }
    const head = await catalog.getViewHead()
    const localDigest = hex32(head?.digest, 'local catalog head digest')
    const localAuthorizationDigest = hex32(
      head?.authorizationStateDigest,
      'local authorization state digest',
    )
    if (localDigest !== scope.catalogHeadDigest ||
        localAuthorizationDigest !== scope.catalogAuthorizationStateDigest) {
      fail('terminal catalog page did not reconstruct its claimed head', 'PUBLISHER_CATALOG_TRUNCATED')
    }
    if (scope.advertisedCatalogHead && localDigest !== scope.advertisedCatalogHead) {
      fail('terminal catalog page did not reconstruct the signed advertised head', 'PUBLISHER_CATALOG_ADVERTISED_HEAD_MISMATCH')
    }
    if (scope.advertisedLocatorSignerId) {
      const authorization = await catalog.getAuthorizationState()
      const writer = authorization?.writers?.find(candidate =>
        candidate?.signerKey === scope.advertisedLocatorSignerId
      )
      if (!writer || writer.revocation ||
          writer.firstAcceptedSequence > writer.lastAcceptedSequence ||
          writer.expiresAt < scope.advertisedLocatorIssuedAt ||
          !writer.capabilities?.includes('announce')) {
        fail('signed locator is not authorized by the reconstructed catalog', 'PUBLISHER_CATALOG_LOCATOR_SIGNER_UNAUTHORIZED')
      }
    }
    scope.catalogComplete = true
    await persistPublisherSyncState(scope)
    return head
  }

  async function syncPublisherCatalog(scope) {
    if (!scope || scope.closed || !scope.modes.has('followed')) return { status: 'not-followed' }
    if (scope.catalogSyncing) return scope.catalogSyncing
    scope.catalogSyncing = (async () => {
      await ensurePublisherNamespaceProof(scope)
      let cursor = scope.catalogResumeCursor ?? null
      if (cursor === null) {
        scope.catalogHeadDigest = scope.advertisedCatalogHead || null
        scope.catalogAuthorizationStateDigest = null
      }
      let previousPageDigest = null
      let pages = 0
      do {
        const response = await requestCatalogPage(scope, {
          version: 1,
          cursor,
          previousPageDigest,
          expectedHeadDigest: scope.advertisedCatalogHead || (cursor === null ? null : scope.catalogHeadDigest),
          catalogEpoch: scope.descriptor.catalogEpoch,
          limit: MAX_CATALOG_PAGE_RECORDS,
        })
        pages++
        cursor = response.nextCursor
        previousPageDigest = response.pageDigest
      } while (cursor !== null)
      await verifyCatalogCompletion(scope)
      await onCatalogUpdate?.({ publisherId: scope.publisherId })
      return { status: 'synced', pages, records: scope.catalogVerifiedRecords, cursor: scope.catalogResumeCursor }
    })().finally(() => { scope.catalogSyncing = null })
    return scope.catalogSyncing
  }

  async function syncFollowedFeed (scope) {
    if (!scope || scope.closed || !scope.modes.has('subscribed')) return { status: 'not-subscribed' }
    try {
      if (scope.feedKind === 'index') {
        return await indexFeedManager.syncFeed({
          curatorId: scope.feedId,
          fetchPage: cursor => requestFeedPage(scope, cursor),
        })
      }
      return await moderationManager.syncFeed({
        moderatorId: scope.feedId,
        fetchPage: cursor => requestFeedPage(scope, cursor),
      })
    } catch (error) {
      // Discovery is intentionally opportunistic: retaining a local subscription
      // must not make a policy transition fail merely because no peer currently
      // serves its bounded signed pages.
      return { status: 'deferred', errorCode: error?.code || 'FEED_SYNC_DEFERRED' }
    }
  }

  function clearAssetTimer (tracked) {
    if (!tracked?.assetTimer) return
    clearTimeout(tracked.assetTimer)
    tracked.assetTimer = null
  }

  function allocateAssetTransferId () {
    if (nextAssetTransferId > MAX_ASSET_TRANSFER_ID) fail('asset transfer id exhausted')
    return nextAssetTransferId++
  }

  function assetAbortError (peerId = null, message = 'asset request aborted') {
    const error = new Error(message)
    error.name = 'AbortError'
    error.code = 'ABORT_ERR'
    error.peerId = peerId
    return error
  }

  function sealAssetRequest (scope, request) {
    if (!request || request.closed) return false
    request.closed = true
    clearTimeout(request.timer)
    request.timer = null
    request.signal?.removeEventListener?.('abort', request.onAbort)
    for (const transfer of request.transfers.values()) transfer.close?.('request-closed')
    request.transfers.clear()
    scope.assetRequests.delete(request.key)
    return true
  }

  function settleAssetRequest (request, error = null) {
    if (error) request.reject(error)
    else request.resolve({
      verifiedBlockIndexes: [...request.verified].sort((left, right) => left - right),
      peerIds: [...request.peerIds].sort(),
    })
  }

  function closeAssetRequest (scope, request, error = null) {
    if (!sealAssetRequest(scope, request)) return false
    settleAssetRequest(request, error)
    return true
  }

  async function quarantineAssetScope (scope, cause, context = null) {
    if (!scope) return
    const invalidPeerId = context?.peerId || null
    const invalidTransferId = context?.transferId ?? null
    const requestSettlements = []
    for (const request of [...(scope.assetRequests?.values() || [])]) {
      const code = invalidPeerId &&
          invalidTransferId !== null &&
          request.transferId === invalidTransferId
        ? 'INVALID_PROOF'
        : 'QUARANTINED'
      if (sealAssetRequest(scope, request)) {
        requestSettlements.push([request, assetTransportError(
          code,
          invalidPeerId,
          code === 'INVALID_PROOF' ? 'asset proof verification failed' : 'asset core was quarantined',
          cause,
        )])
      }
    }
    const inventorySettlements = []
    for (const session of scope.sessions.values()) {
      cancelAssetSummaryScan(session)
      const inventory = session.assetInventoryRequest
      if (sealAssetInventoryRequest(session, inventory)) {
        inventorySettlements.push([inventory, assetTransportError(
          'QUARANTINED',
          invalidPeerId,
          'asset core was quarantined',
          cause,
        )])
      }
      for (const response of session.assetResponses?.values() || []) response.cancelled = true
      session.assetResponses?.clear()
    }
    const download = scope.download
    scope.download = null
    await cleanupResource(download, ['destroy', 'close'])
    for (const [request, error] of requestSettlements) settleAssetRequest(request, error)
    for (const [request, error] of inventorySettlements) settleAssetInventoryRequest(request, error)
  }

  function requestPeerFailure (request) {
    const priority = ['INVALID_PROOF', 'QUARANTINED', 'TIMEOUT', 'UNAVAILABLE', 'DISCONNECTED']
    const failures = [...request.peerFailures.values()]
    for (const code of priority) {
      const failure = failures.find(error => error.code === code)
      if (failure) return failure
    }
    return assetTransportError('UNAVAILABLE', null, 'asset blocks are unavailable')
  }

  function failAssetRequestPeer (scope, peerId, code = 'DISCONNECTED', cause = null) {
    for (const request of scope.assetRequests?.values() || []) {
      if (!request.requestedPeers.has(peerId) || request.closed) continue
      request.failedPeers.add(peerId)
      if (!request.peerFailures.has(peerId)) {
        request.peerFailures.set(peerId, assetTransportError(
          code,
          peerId,
          code === 'INVALID_PROOF' ? 'asset proof verification failed' : 'asset blocks are unavailable from peer',
          cause,
        ))
      }
      for (const [index, transfer] of request.transfers) {
        if (transfer.peerId !== peerId) continue
        transfer.close?.('peer-failed')
        request.transfers.delete(index)
      }
      if ([...request.requestedPeers].every(id => request.failedPeers.has(id))) {
        closeAssetRequest(scope, request, requestPeerFailure(request))
      }
    }
  }

  function assertAssetFrameScope (scope, payload) {
    const assetId = decodeAssetIdPrefix(payload)
    if (!b4a.equals(assetId, b4a.from(scope.assetId, 'hex'))) fail('asset frame assetId mismatch')
  }

  async function authorizedBlockProof (core, index) {
    return createVerifiedBlockProof({
      manifest: core.manifest,
      proof: blockIndex => core.proof({
        block: { index: blockIndex, nodes: 0 },
        upgrade: { start: 0, length: core.length },
      }),
    }, index)
  }

  function encodeAssetProof (index, proof, value) {
    return encodeVerifiedBlockProof({ index, proof, value })
  }

  function decodeAssetProof (payload, expectedIndex) {
    return decodeVerifiedBlockProof(payload, { index: expectedIndex })
  }

  function encodeAssetChunk (index, offset, value) {
    return encodeVerifiedBlockChunk({ index, offset, value })
  }

  const decodeAssetChunk = decodeVerifiedBlockChunk


  function sendAssetError (scope, tracked, range, code) {
    return sendScopedFrame(tracked, 'asset', 'asset-block-error', encodeAssetBlockError({
      assetId: scope.assetId,
      transferId: range.transferId,
      startBlock: range.startBlock,
      endBlock: range.endBlock,
      code,
    }))
  }


  async function sendAssetBlocks (scope, tracked, range) {
    if (range.startBlock < scope.range.start || range.endBlock > scope.range.end) {
      fail('asset block request is outside the authorized range')
    }
    if (tracked.assetResponses.size >= MAX_ASSET_BLOCKS_PER_REQUEST ||
        tracked.assetResponses.has(range.transferId)) {
      fail('asset responder request limit exceeded')
    }
    const responseState = { cancelled: false, policyEpoch: networkPolicyEpoch, range }
    tracked.assetResponses.set(range.transferId, responseState)
    let served = 0
    try {
      const retentionClass = scopeUploadRetentionClass(scope)
      if (!retentionClass || !networkEnabled) {
        sendAssetError(scope, tracked, range, ASSET_BLOCK_ERROR_CODES.UNAVAILABLE)
        return
      }
      await scope.assetSession.ready()
      const abandon = () => {
        const current = !responseState.cancelled && !scope.closed && !tracked.closed &&
          scope.sessions.get(tracked.peerId) === tracked
        if (current) sendAssetError(scope, tracked, range, ASSET_BLOCK_ERROR_CODES.UNAVAILABLE)
      }
      for (let index = range.startBlock; index < range.endBlock; index++) {
        const result = await scope.assetSession.blockEngine.serve({
          handle: scope.blockHandle,
          peerId: tracked.peerId,
          request: {
            resourceId: scope.assetId,
            start: range.startBlock,
            end: range.endBlock,
            index,
            retentionClass,
          },
          isActive: () => !responseState.cancelled && !scope.closed && !tracked.closed &&
            networkEnabled && responseState.policyEpoch === networkPolicyEpoch,
          encodeProof: ({ index, proof, value }) => encodeAssetProof(index, proof, value),
          reserve: ({ bytes }) => reservePolicyUpload(retentionClass, bytes),
          sendProofPart: ({ offset, totalBytes, chunk }) => sendScopedFrame(
            tracked,
            'asset',
            'asset-block-response',
            encodeAssetBlockResponse({
              assetId: scope.assetId,
              transferId: range.transferId,
              startBlock: range.startBlock,
              endBlock: range.endBlock,
              blockIndex: index,
              kind: 'proof',
              offset,
              totalBytes,
              chunk,
            }),
          ),
          sendBlockPart: ({ offset, totalBytes, chunk }) => sendScopedFrame(
            tracked,
            'asset',
            'asset-block-response',
            encodeAssetBlockResponse({
              assetId: scope.assetId,
              transferId: range.transferId,
              startBlock: range.startBlock,
              endBlock: range.endBlock,
              blockIndex: index,
              kind: 'block',
              offset,
              totalBytes,
              chunk,
            }),
          ),
        })
        if (result.status === 'sent') served++
        else if (result.status === 'cancelled') return abandon()
      }
      if (served === 0 && !responseState.cancelled && !tracked.closed) {
        sendAssetError(scope, tracked, range, ASSET_BLOCK_ERROR_CODES.UNAVAILABLE)
      }
    } finally {
      tracked.assetResponses.delete(range.transferId)
    }
  }

  function blockResponsePart (scope, response) {
    return {
      resourceId: scope.assetId,
      start: response.startBlock,
      end: response.endBlock,
      index: response.blockIndex,
      offset: response.offset,
      totalBytes: response.totalBytes,
      chunk: response.chunk,
    }
  }

  function receiveAssetProofPart (scope, transfer, response) {
    if (transfer.proofMetadata) fail('asset proof was already completed')
    const received = scope.assetSession.blockEngine.receiveProofPart({
      handle: scope.blockHandle,
      transfer,
      part: blockResponsePart(scope, response),
    })
    if (received.status !== 'complete') return
    const metadata = decodeAssetProof(received.assembly.buffer, transfer.index)
    const validation = scope.assetSession.validateProofMetadata({
      index: transfer.index,
      proof: metadata.proof,
      byteLength: metadata.byteLength,
      peerId: transfer.peerId,
      transferId: transfer.transferId,
    })
    if (validation && typeof validation.then === 'function') {
      received.assembly.buffer = null
      transfer.preflight = validation
      return validation
    }
    transfer.expectedBlockBytes = validation
    transfer.proofMetadata = metadata
    received.assembly.buffer = null
  }

  function receiveAssetBlockPart (scope, transfer, response) {
    if (!transfer.proofMetadata) fail('asset block bytes arrived before a complete canonical proof')
    if (response.totalBytes !== transfer.expectedBlockBytes) {
      fail('asset block response length does not match the verified descriptor')
    }
    return scope.assetSession.blockEngine.receiveBlockPart({
      handle: scope.blockHandle,
      transfer,
      part: blockResponsePart(scope, response),
    })
  }

  async function finishAssetResponse (scope, request, transfer) {
    if (transfer.applying || !transfer.proofMetadata || !transfer.block ||
        transfer.block.receivedBytes !== transfer.block.totalBytes) return
    transfer.applying = true
    try {
      if (request.closed || scope.assetRequests.get(request.key) !== request) return
      const result = await scope.assetSession.blockEngine.finish({
        handle: scope.blockHandle,
        request,
        transfer,
        proof: transfer.proofMetadata.proof,
      })
      if (result.status === 'ignored' || request.closed || scope.assetRequests.get(request.key) !== request) return 'ignored'
      request.transfers.delete(transfer.index)
      request.remaining.delete(transfer.index)
      request.verified.add(transfer.index)
      request.peerIds.add(transfer.peerId)
      if (request.remaining.size === 0) closeAssetRequest(scope, request)
    } catch (error) {
      const closedDuringVerification =
        error?.message === 'asset block request is closed' &&
        (request.closed ||
          scope.assetRequests.get(request.key) !== request ||
          request.transfers.get(transfer.index) !== transfer)
      transfer.close?.('failed')
      if (request.transfers.get(transfer.index) === transfer) request.transfers.delete(transfer.index)
      if (closedDuringVerification) return 'ignored'
      throw error
    }
  }

  async function acceptAssetBlockResponse (scope, tracked, payload) {
    assertAssetFrameScope(scope, payload)
    const response = decodeAssetBlockResponse(payload, { coreLength: scope.assetSession.coreRef.length })
    const request = scope.assetRequests.get(response.transferId)
    if (!request || request.closed || !request.requestedPeers.has(tracked.peerId)) return { status: 'ignored' }
    if (response.startBlock !== request.startBlock || response.endBlock !== request.endBlock) {
      fail('asset block response range does not match its transfer')
    }
    if (!request.remaining.has(response.blockIndex)) return { status: 'ignored' }
    let transfer = request.transfers.get(response.blockIndex)
    if (!transfer) {
      if (response.kind !== 'proof' || response.offset !== 0) {
        fail('asset block bytes arrived before a complete canonical proof')
      }
      transfer = scope.assetSession.blockEngine.createTransfer({
        handle: scope.blockHandle,
        resourceId: scope.assetId,
        start: response.startBlock,
        end: response.endBlock,
        index: response.blockIndex,
        peerId: tracked.peerId,
        transferId: response.transferId,
      })
      transfer.proofMetadata = null
      transfer.preflight = null
      transfer.expectedBlockBytes = null
      transfer.applying = false
      request.transfers.set(response.blockIndex, transfer)
    }
    if (transfer.transferId !== response.transferId) fail('asset block response transferId changed')
    if (transfer.peerId !== tracked.peerId) fail('asset block response changed contributing peer')
    if (transfer.preflight) await transfer.preflight
    if (response.kind === 'proof') {
      const preflight = receiveAssetProofPart(scope, transfer, response)
      if (preflight) await preflight
    } else {
      receiveAssetBlockPart(scope, transfer, response)
    }
    const completion = await finishAssetResponse(scope, request, transfer)
    if (completion === 'ignored') return { status: 'ignored' }
    return { status: request.closed ? 'complete' : 'accepted' }
  }

  async function handleAssetFrame (scope, tracked, frame) {
    counters.inboundAssetFrames++
    if (!tracked || tracked.closed || tracked.state !== 'active') fail('asset session is not active')
    switch (frame.type) {
      case 'probe':
        return { status: 'ok' }
      case 'asset-range-summary-request': {
        assertAssetFrameScope(scope, frame.payload)
        const request = decodeAssetRangeSummaryRequest(frame.payload, { coreLength: scope.assetSession.coreRef.length })
        if (tracked.assetSummaryScan) fail('asset inventory scan is already active for this peer')
        const scan = { cancelled: false, policyEpoch: networkPolicyEpoch }
        tracked.assetSummaryScan = scan
        const isActive = () => !scan.cancelled &&
          tracked.assetSummaryScan === scan &&
          !scope.closed &&
          !tracked.closed &&
          !tracked.channel?.closed &&
          scan.policyEpoch === networkPolicyEpoch
        try {
          const page = uploadAllowed && networkEnabled
            ? await scope.assetSession.listAssetRanges({ cursor: request.cursor, limit: request.limit, isActive })
            : { ranges: [], nextCursor: null }
          if (!isActive()) return { status: 'ignored' }
          sendScopedFrame(tracked, 'asset', 'asset-range-summary-page', encodeAssetRangeSummaryPage({
            assetId: scope.assetId,
            ranges: page.ranges,
            nextCursor: page.nextCursor,
            coreLength: scope.assetSession.coreRef.length,
            cursor: request.cursor,
            limit: request.limit,
          }))
          return { status: 'sent' }
        } finally {
          if (tracked.assetSummaryScan === scan) tracked.assetSummaryScan = null
        }
      }
      case 'asset-range-summary-page': {
        assertAssetFrameScope(scope, frame.payload)
        const request = tracked.assetInventoryRequest
        const page = decodeAssetRangeSummaryPage(frame.payload, {
          coreLength: scope.assetSession.coreRef.length,
          cursor: request?.cursor ?? null,
          limit: request?.limit,
        })
        if (!request || request.closed) return { status: 'ignored' }
        closeAssetInventoryRequest(tracked, request, null, {
          ranges: page.ranges,
          nextCursor: page.nextCursor,
        })
        return { status: 'accepted' }
      }
      case 'asset-block-request': {
        assertAssetFrameScope(scope, frame.payload)
        const range = decodeAssetBlockRequest(frame.payload, { coreLength: scope.assetSession.coreRef.length })
        if (range.transferId <= tracked.lastAssetTransferId) fail('asset transferId is not monotonically increasing')
        tracked.lastAssetTransferId = range.transferId
        await sendAssetBlocks(scope, tracked, range)
        return { status: 'sent' }
      }
      case 'asset-block-response':
        try {
          return await acceptAssetBlockResponse(scope, tracked, frame.payload)
        } catch (error) {
          failAssetRequestPeer(scope, tracked.peerId, 'INVALID_PROOF', error)
          throw error
        }
      case 'asset-block-error': {
        assertAssetFrameScope(scope, frame.payload)
        const response = decodeAssetBlockError(frame.payload, { coreLength: scope.assetSession.coreRef.length })
        const request = scope.assetRequests.get(response.transferId)
        if (!request || request.closed || !request.requestedPeers.has(tracked.peerId)) return { status: 'ignored' }
        if (response.startBlock !== request.startBlock || response.endBlock !== request.endBlock) {
          fail('asset block error range does not match its transfer')
        }
        failAssetRequestPeer(scope, tracked.peerId, 'UNAVAILABLE')
        return { status: 'unavailable' }
      }
      default:
        fail('frame type is not allowed for asset purpose')
    }
  }

  function archiveBlockKey (coreKey, index) {
    return `${coreKey}:${index}`
  }

  function archiveResourceFor (scope, coreKey, index) {
    return [...(scope.archiveResources?.values() || [])].find(resource =>
      resource.quarantined !== true &&
      resource.coreKey === coreKey &&
      Number.isSafeInteger(index) &&
      index >= resource.range.start &&
      index < resource.range.end
    ) || null
  }

  function encodeArchiveBlockRef (coreKey, index) {
    const payload = c.encode(c.any, { coreKey: hex32(coreKey, 'coreKey'), index })
    if (payload.byteLength > 256) fail('archive block reference exceeds bounded limit')
    return payload
  }

  function decodeArchiveBlockRef (payload) {
    if (!b4a.isBuffer(payload) || payload.byteLength > 256) fail('archive block reference is invalid')
    const value = c.decode(c.any, payload)
    return {
      coreKey: hex32(value?.coreKey, 'coreKey'),
      index: decodeAssetIndex(encodeAssetIndex(value?.index)),
    }
  }

  function encodeArchiveProof (coreKey, index, proof, value) {
    const metadata = c.decode(c.any, encodeAssetProof(index, proof, value))
    metadata.coreKey = hex32(coreKey, 'coreKey')
    const payload = c.encode(c.any, metadata)
    if (payload.byteLength > MAX_ASSET_PROOF_BYTES) fail('archive proof exceeds bounded limit')
    return payload
  }

  function decodeArchiveProof (payload, expected) {
    if (!b4a.isBuffer(payload) || payload.byteLength > MAX_ASSET_PROOF_BYTES) fail('archive proof exceeds bounded limit')
    const metadata = c.decode(c.any, payload)
    if (hex32(metadata?.coreKey, 'coreKey') !== expected.coreKey) fail('archive proof core is invalid')
    const assetMetadata = { ...metadata }
    delete assetMetadata.coreKey
    return decodeAssetProof(c.encode(c.any, assetMetadata), expected.index)
  }

  function clearArchiveTimer (tracked) {
    if (!tracked?.archiveTimer) return
    clearTimeout(tracked.archiveTimer)
    tracked.archiveTimer = null
  }

  function queueArchiveRetry (scope, tracked, request) {
    if (!request) return
    const resource = archiveResourceFor(scope, request.coreKey, request.index)
    const key = archiveBlockKey(request.coreKey, request.index)
    scope.archivePending.delete(key)
    if (resource) {
      const failures = scope.archiveFailures.get(key) || new Set()
      failures.add(tracked.peerId)
      scope.archiveFailures.set(key, failures)
      scope.archiveRetries.set(key, request)
    }
    tracked.archiveTransfer?.close?.('archive-retry')
    tracked.archiveRequest = null
    tracked.archiveTransfer = null
    clearArchiveTimer(tracked)
  }

  async function nextArchiveBlock (scope, tracked) {
    for (const [key, request] of scope.archiveRetries) {
      if (scope.archivePending.has(key)) continue
      if (scope.archiveFailures.get(key)?.has(tracked.peerId)) return null
      scope.archiveRetries.delete(key)
      return request
    }
    for (const resource of scope.archiveResources?.values() || []) {
      while (resource.nextIndex < resource.range.end) {
        const index = resource.nextIndex++
        const key = archiveBlockKey(resource.coreKey, index)
        if (scope.archivePending.has(key)) continue
        if (await resource.core.has?.(index)) continue
        return { coreKey: resource.coreKey, index }
      }
    }
    return null
  }

  async function pumpArchiveSession (scope, tracked) {
    if (!networkEnabled || scope.archiveDiscovery || scope.closed || tracked.closed || tracked.state !== 'active') return
    // nextArchiveBlock awaits the core, so without a synchronous claim two
    // callers both pass the in-flight check below and pipeline two requests to
    // the same peer. A responder serves one block per session and refuses the
    // second as a monotonic-range violation, which fails the session closed in
    // the middle of the transfer the first request was already getting. A
    // caller that arrives while this one is deciding hands its turn over
    // instead, so a peer that answers inside send still advances the range.
    if (tracked.archivePumping) {
      tracked.archivePumpQueued = true
      return
    }
    tracked.archivePumping = true
    try {
      do {
        tracked.archivePumpQueued = false
        if (tracked.archiveRequest || scope.closed || tracked.closed || tracked.state !== 'active') break
        const request = await nextArchiveBlock(scope, tracked)
        if (!request || scope.closed || tracked.closed) break
        tracked.archiveRequest = request
        scope.archivePending.add(archiveBlockKey(request.coreKey, request.index))
        if (!sendScopedFrame(tracked, 'archive', 'archive-block-request', encodeArchiveBlockRef(request.coreKey, request.index))) {
          queueArchiveRetry(scope, tracked, request)
          break
        }
        // A peer that answered inside the send above has already cleared this
        // request; arming its timeout would retry a block that arrived.
        if (tracked.archiveRequest !== request) continue
        tracked.archiveTimer = setTimeout(() => {
          queueArchiveRetry(scope, tracked, request)
          void pumpArchiveSessions(scope)
        }, ASSET_TRANSFER_TIMEOUT_MS)
      } while (tracked.archivePumpQueued)
    } finally {
      tracked.archivePumping = false
    }
  }

  function startArchivePumpWhenOpen (scope, tracked) {
    const opened = tracked.channel?.fullyOpened?.()
    void Promise.resolve(opened === undefined ? true : opened).then(ready => {
      if (ready !== false) return pumpArchiveSession(scope, tracked)
    }).catch(() => closeSession(scope, tracked.peerId, 'archive-channel-open-failed', tracked))
  }
  async function pumpArchiveSessions (scope) {
    if (!scope || scope.closed || scope.purpose !== 'archive') return
    await Promise.all([...scope.sessions.values()].map(tracked => pumpArchiveSession(scope, tracked)))
  }

  async function sendArchiveBlock (scope, tracked, request) {
    if (!archiveAllowed) {
      sendScopedFrame(tracked, 'archive', 'archive-block-unavailable', encodeArchiveBlockRef(request.coreKey, request.index))
      return
    }
    const resource = archiveResourceFor(scope, request.coreKey, request.index)
    const lastServed = tracked.archiveLastServed.get(resource?.resourceId) ?? -1
    if (tracked.archiveServing || !resource || request.index <= lastServed) {
      fail('archive block request is outside the authorized monotonic range')
    }
    tracked.archiveServing = true
    const policyEpoch = networkPolicyEpoch
    try {
      if (!archiveAllowed || !uploadAllowed || !networkEnabled || !await resource.core.has?.(request.index)) {
        sendScopedFrame(tracked, 'archive', 'archive-block-unavailable', encodeArchiveBlockRef(request.coreKey, request.index))
        return
      }
      const proof = await authorizedBlockProof(resource.core, request.index)
      const value = b4a.from(proof?.block?.value || [])
      const ceiling = scope.archiveUploadCeilingBytes
      const reservation = policyEpoch === networkPolicyEpoch
        ? await reservePolicyUpload('archive-pin', value.byteLength)
        : null
      // The reservation may have waited on the outbound rate, so the policy is
      // rechecked after it resolves rather than only before.
      if (!reservation || policyEpoch !== networkPolicyEpoch ||
          proof?.block?.index !== request.index || value.byteLength > MAX_ASSET_BLOCK_BYTES ||
          tracked.archiveServedBytes + value.byteLength > ceiling) {
        reservation?.release()
        sendScopedFrame(tracked, 'archive', 'archive-block-unavailable', encodeArchiveBlockRef(request.coreKey, request.index))
        return
      }
      const canBatch = typeof tracked.channel?.cork === 'function' && typeof tracked.channel?.uncork === 'function'
      if (canBatch) tracked.channel.cork()
      let sent = false
      try {
        sent = sendScopedFrame(tracked, 'archive', 'archive-block-proof', encodeArchiveProof(request.coreKey, request.index, proof, value))
        for (let offset = 0; sent && offset < value.byteLength; offset += ASSET_CHUNK_BYTES) {
          if (!archiveAllowed || policyEpoch !== networkPolicyEpoch || scope.closed || tracked.closed) {
            sent = false
            break
          }
          const chunk = value.subarray(offset, Math.min(value.byteLength, offset + ASSET_CHUNK_BYTES))
          sent = sendScopedFrame(tracked, 'archive', 'archive-block-chunk', encodeAssetChunk(request.index, offset, chunk))
        }
        if (sent) {
          tracked.archiveServedBytes += value.byteLength
          tracked.archiveLastServed.set(resource.resourceId, request.index)
          reservation.commit()
        }
      } finally {
        reservation.release()
        if (canBatch) tracked.channel.uncork()
      }
    } finally {
      tracked.archiveServing = false
    }
  }

  async function finishArchiveTransfer (scope, tracked) {
    const request = tracked.archiveRequest
    const transfer = tracked.archiveTransfer
    const resource = request && archiveResourceFor(scope, request.coreKey, request.index)
    if (!resource || !transfer) fail('archive block transfer is incomplete')
    const result = await blockEngine.finish({
      handle: resource.blockHandle,
      request,
      transfer,
      proof: transfer.proofMetadata.proof,
    })
    if (result.status === 'ignored') {
      queueArchiveRetry(scope, tracked, request)
      await pumpArchiveSessions(scope)
      return
    }
    const key = archiveBlockKey(request.coreKey, request.index)
    scope.archivePending.delete(key)
    scope.archiveRetries.delete(key)
    scope.archiveFailures.delete(key)
    tracked.archiveRequest = null
    tracked.archiveTransfer = null
    clearArchiveTimer(tracked)
    await pumpArchiveSession(scope, tracked)
  }
  function clearArchiveChallengeProofTransfer(scope, key) {
    const transfer = scope.archiveChallengeProofTransfers?.get(key)
    if (!transfer) return
    clearTimeout(transfer.timer)
    scope.archiveChallengeProofTransfers.delete(key)
  }

  async function receiveArchiveChallengeProofChunk(scope, tracked, payload) {
    const packet = c.decode(c.any, payload)
    const envelopeBytes = b4a.from(packet?.envelope || [])
    const chunk = b4a.from(packet?.chunk || [])
    const offset = Number(packet?.offset)
    const totalBytes = Number(packet?.totalBytes)
    if (!Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > MAX_ARCHIVE_CHALLENGE_PROOF_BYTES ||
        chunk.byteLength < 1 || chunk.byteLength > ARCHIVE_CHALLENGE_PROOF_CHUNK_BYTES ||
        offset + chunk.byteLength > totalBytes) {
      fail('archive challenge proof chunk is invalid')
    }
    const envelope = decodeApplicationEnvelope(envelopeBytes)
    const transferId = b4a.toString(envelope.recordId, 'hex')
    const key = `${tracked.peerId}:${transferId}`
    let transfer = scope.archiveChallengeProofTransfers.get(key)
    if (offset === 0) {
      clearArchiveChallengeProofTransfer(scope, key)
      if (scope.archiveChallengeProofTransfers.size >= MAX_ARCHIVE_CHALLENGE_TRANSFERS) {
        fail('archive challenge proof transfer limit exceeded')
      }
      transfer = {
        envelope,
        totalBytes,
        chunks: [],
        receivedBytes: 0,
        timer: setTimeout(() => clearArchiveChallengeProofTransfer(scope, key), ARCHIVE_CHALLENGE_TRANSFER_TIMEOUT_MS),
      }
      transfer.timer?.unref?.()
      scope.archiveChallengeProofTransfers.set(key, transfer)
    }
    if (!transfer || transfer.totalBytes !== totalBytes || transfer.receivedBytes !== offset ||
        !b4a.equals(transfer.envelope.recordId, envelope.recordId)) {
      clearArchiveChallengeProofTransfer(scope, key)
      fail('archive challenge proof chunks are not contiguous')
    }
    transfer.chunks.push(chunk)
    transfer.receivedBytes += chunk.byteLength
    if (transfer.receivedBytes !== transfer.totalBytes) return
    const proofBytes = b4a.concat(transfer.chunks, transfer.totalBytes)
    clearArchiveChallengeProofTransfer(scope, key)
    await Promise.allSettled([...scope.archiveChallengeProofListeners].map(listener =>
      listener({ envelope: transfer.envelope, proofBytes }, { peerId: tracked.peerId })))
  }


  async function handleArchiveFrame (scope, tracked, frame) {
    if (!tracked || tracked.closed || tracked.state !== 'active') fail('archive session is not active')
    if (scope.archiveDiscovery) {
      if (!ARCHIVE_DISCOVERY_TYPES.has(frame.type)) fail('frame type is not allowed for archive discovery')
      if (frame.type === 'archive-challenge-proof') {
        await receiveArchiveChallengeProofChunk(scope, tracked, frame.payload)
      } else {
        const envelope = decodeApplicationEnvelope(frame.payload)
        const listeners = frame.type === 'archive-request'
          ? scope.archiveRequestListeners
          : frame.type === 'archive-pledge'
            ? scope.archivePledgeListeners
            : scope.archiveChallengeListeners
        await Promise.allSettled([...listeners].map(listener => listener(envelope, { peerId: tracked.peerId })))
      }
      counters.acceptedFrames++
      return { status: 'accepted' }
    }
    switch (frame.type) {
      case 'probe':
        return { status: 'ok' }
      case 'archive-block-request':
        await sendArchiveBlock(scope, tracked, decodeArchiveBlockRef(frame.payload))
        return { status: 'sent' }
      case 'archive-block-proof': {
        const request = tracked.archiveRequest
        const resource = request && archiveResourceFor(scope, request.coreKey, request.index)
        if (!resource || tracked.archiveTransfer) fail('unexpected archive proof')
        const metadata = decodeArchiveProof(frame.payload, request)
        const transfer = blockEngine.createTransfer({
          handle: resource.blockHandle,
          resourceId: request.coreKey,
          start: resource.range.start,
          end: resource.range.end,
          index: request.index,
          peerId: tracked.peerId,
          transferId: archiveBlockKey(request.coreKey, request.index),
        })
        const received = blockEngine.receiveProofPart({
          handle: resource.blockHandle,
          transfer,
          part: {
            resourceId: request.coreKey,
            start: resource.range.start,
            end: resource.range.end,
            index: request.index,
            offset: 0,
            totalBytes: frame.payload.byteLength,
            chunk: frame.payload,
          },
        })
        if (received.status !== 'complete') fail('archive proof transfer is incomplete')
        transfer.proofMetadata = metadata
        transfer.expectedBlockBytes = metadata.byteLength
        tracked.archiveTransfer = transfer
        if (metadata.byteLength === 0) await finishArchiveTransfer(scope, tracked)
        return { status: 'accepted' }
      }
      case 'archive-block-chunk': {
        const request = tracked.archiveRequest
        const transfer = tracked.archiveTransfer
        const resource = request && archiveResourceFor(scope, request.coreKey, request.index)
        if (!resource || !transfer) fail('unexpected archive block chunk')
        const chunk = decodeAssetChunk(frame.payload)
        if (chunk.index !== request.index) fail('archive block chunk is out of sequence')
        const received = blockEngine.receiveBlockPart({
          handle: resource.blockHandle,
          transfer,
          part: {
            resourceId: request.coreKey,
            start: resource.range.start,
            end: resource.range.end,
            index: request.index,
            offset: chunk.offset,
            totalBytes: transfer.expectedBlockBytes,
            chunk: chunk.value,
          },
        })
        if (received.status === 'complete') await finishArchiveTransfer(scope, tracked)
        return { status: 'accepted' }
      }
      case 'archive-block-unavailable': {
        const request = decodeArchiveBlockRef(frame.payload)
        if (!tracked.archiveRequest || request.coreKey !== tracked.archiveRequest.coreKey || request.index !== tracked.archiveRequest.index) {
          fail('unexpected unavailable archive block')
        }
        queueArchiveRetry(scope, tracked, request)
        await pumpArchiveSessions(scope)
        return { status: 'unavailable' }
      }
      default:
        fail('frame type is not allowed for archive purpose')
    }
  }

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
    for (const session of scope.sessions.values()) cancelAssetSummaryScan(session)
    for (const request of [...(scope.assetRequests?.values() || [])]) {
      closeAssetRequest(scope, request, new Error('asset scope was released'))
    }
    await scope.assetSession?.close?.()
    for (const transfer of scope.archiveChallengeProofTransfers?.values() || []) clearTimeout(transfer.timer)
    scope.archiveChallengeProofTransfers?.clear()
    for (const peerId of [...scope.sessions.keys()]) closeSession(scope, peerId, 'scope-released')
    for (const resource of scope.archiveResources?.values() || []) {
      blockEngine.detach(resource.blockHandle)
      try { resource.releaseArchiveProtection?.() } catch { /* best-effort protection release */ }
      resource.releaseArchiveProtection = null
    }
    const resources = scope.archiveResources
      ? [...scope.archiveResources.values()].flatMap(resource => [
          [resource.download, ['destroy', 'close']],
          [resource.core, ['close']],
        ])
      : [
          [scope.download, ['destroy', 'close']],
          [scope.assetSession ? null : scope.core, ['close']],
        ]
    resources.push([scope.discovery, ['destroy', 'close']])
    await Promise.allSettled(resources.map(([resource, methods]) => cleanupResource(resource, methods)))
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

  async function handleBootstrapFrame (frame, context) {
    if (frame.type !== 'locator') return { status: 'rejected', reason: 'bootstrap-metadata-only' }
    const envelope = decodeApplicationEnvelope(frame.payload)
    const result = await bootstrapManager.ingestLocator(context.peerId, envelope)
    console.log('[ScopedNetwork] bootstrap locator received from', String(context.peerId).slice(0, 16),
      '- status:', result?.status, 'errorCode:', result?.errorCode || result?.reason || 'none')
    if (result.status === 'accepted' && result.publisherId && isPeerConnected(context.peerId)) {
      // Candidate promotion is bounded and best-effort. The locator itself is
      // never authority; followBootstrapLocator still requires the scoped
      // publisher-root proof before it can bind a catalog.
      void addPublisherFollowReason({
        publisherId: result.publisherId,
        reason: 'bootstrap:auto',
      }).catch(error => console.log('[ScopedNetwork] follow-reason FAILED:', error?.message || error))
    }
    counters.acceptedFrames++
    return result
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
          // The scope decides whether this peer may have the core at all; the
          // core itself moves and verifies its own blocks. Hand-rolling that
          // transfer meant hand-rolling proofs, and every one of them was
          // refused on arrival as an invalid signature.
          replicateAuthorizedCore(scope, connection, mux)
          if (!isCurrentSession()) return
        }
        const result = authorizeScopeConnection(scope, { peerId: remoteKey, connection, tracked })
        if (result.status !== 'authorized') fail(result.reason)
        if (isCurrentSession()) {
          if (scope.purpose === 'bootstrap') {
            // This is the only moment a consumer is told which publishers
            // exist. Nothing is sent when the map is empty, and the peer then
            // sees an empty catalog forever with no error anywhere.
            for (const { locator } of localBootstrapLocators.values()) {
              sendBootstrapLocatorToSession(tracked, locator)
            }
          }
          if (scope.purpose === 'index' || scope.purpose === 'moderation') {
            void syncFollowedFeed(scope)
          }
          if (scope.purpose === 'publisher' && scope.modes.has('followed') && !scope.modes.has('local')) {
            void syncPublisherCatalog(scope).catch(error => {
              recordProtocolError(scope, remoteKey, error)
            })
          }
          // Asset bytes move by hypercore replication, which requests and
          // verifies its own blocks. The scope's job is deciding whether this
          // peer may have the core; asking for blocks by hand on top of that
          // only produced proofs the receiver refused, and each refusal tore
          // down the session replication was using.
          if (scope.purpose === 'archive' && !scope.archiveDiscovery) {
            for (const failures of scope.archiveFailures?.values?.() || []) failures.delete(remoteKey)
            startArchivePumpWhenOpen(scope, tracked)
          }
          if (scope.purpose === 'archive-discovery' && scope.archivePeerListeners) { for (const listener of scope.archivePeerListeners) { try { listener({ peerId: remoteKey }) } catch { /* Observers must not affect transport. */ } } }
        }
      },
      onFrame: frame => {
        if (!isCurrentSession()) fail('scoped session is no longer current')
        if (scope.purpose === 'bootstrap') return handleBootstrapFrame(frame, { peerId: remoteKey })
        if (scope.purpose === 'publisher') return handlePublisherProofFrame(scope, scope.sessions.get(remoteKey), frame)
        if (scope.purpose === 'index' || scope.purpose === 'moderation') return handleFeedFrame(scope, scope.sessions.get(remoteKey), frame)
        if (scope.purpose === 'asset') return handleAssetFrame(scope, ownedSession, frame)
        if (scope.purpose === 'archive') return handleArchiveFrame(scope, ownedSession, frame)
        if (scope.purpose === 'archive-discovery') return handleArchiveFrame(scope, ownedSession, frame)
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

  // Protomux writes one frame per send, and a peer applies each frame on its
  // own. Work that changes several channels at once therefore leaks a
  // half-applied state onto the wire unless the frames travel together, so this
  // corks every live connection for the duration and lets Protomux flush one
  // batch per peer. Only local work may run inside: a corked connection cannot
  // answer a peer until the batch flushes.
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
      queueMicrotask(() => {
        if (!activeConnections.has(connection)) return
        mux?.cork?.()
        try {
          for (const scope of scopes.values()) {
            if (scope.purpose !== 'index' || scope.feedKind) attachScope(scope, connection, info)
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

  async function restoreLocalPublisherScopes () {
    if (!contributionAllowed) return
    if (typeof catalogRegistry?.getWritableBindings !== 'function') return
    const bindings = await catalogRegistry.getWritableBindings()
    if (!Array.isArray(bindings) || bindings.length > 64) fail('writable catalog restore exceeds its bound')
    for (const binding of bindings) {
      const publisherId = hex32(binding?.publisherId, 'publisherId')
      const catalog = binding?.catalog
      if (!catalog?.writable || typeof catalog.listProjections !== 'function') continue
      const [publications, claims] = await Promise.all([
        catalog.listProjections('publication', { limit: 1 }),
        catalog.listProjections('claim', { limit: 1 }),
      ])
      if ((publications?.items?.length || 0) === 0 && (claims?.items?.length || 0) === 0) continue
      await publishLocalPublisherCatalog({ publisherId })
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

  function normalizeFollowReason(reason) {
    const value = String(reason || '')
    if (value.length < 1 || value.length > 256 || !/^[a-z0-9][a-z0-9:_-]*$/.test(value)) {
      fail('invalid publisher follow reason')
    }
    return value
  }

  function scheduleReasonedPublisherFollow(publisherId) {
    // Every return below silently decides a discovered publisher will never be
    // followed, which surfaces only as a permanently empty catalog.
    const skip = (why) => console.log('[ScopedNetwork] follow not scheduled:', publisherId.slice(0, 16), why)
    if (status !== 'active') return skip(`status=${status}`)
    if (publisherFollowWork.has(publisherId)) return skip('follow already in flight')
    const locator = bootstrapManager.getLocator?.(publisherId)
    if (!publisherFollowReasons.get(publisherId)?.size) return skip('no follow reasons')
    if (!locator) return skip('no locator retained')
    const existing = followedPublishers.get(publisherId)
    const locatorTopic = derivePublisherTopic({ publisherId, catalogEpoch: locator.catalogEpoch })
    if (existing) {
      const currentEpoch = Number(existing.scope.descriptor.catalogEpoch)
      if (locator.catalogEpoch < currentEpoch || locator.catalogEpoch > currentEpoch + 1) return skip('locator epoch out of range')
      const identical = locator.catalogEpoch === currentEpoch &&
        b4a.equals(existing.scope.topic, locatorTopic) &&
        locator.catalogBootstrapKey === b4a.toString(existing.scope.descriptor.catalogBootstrapKey, 'hex') &&
        locator.catalogHead === existing.scope.advertisedCatalogHead &&
        locator.authorizationChainDigest === existing.scope.advertisedAuthorizationStateDigest
      if (identical) {
        // The locator has not moved, but a walk that never finished leaves the
        // catalog permanently short: a peer that dropped mid-page is recorded
        // as a scope error and nothing ever asks again. A republished locator
        // is the natural retry tick, so use it as one rather than skipping.
        //
        // Only retry while a session is actually live. A locator arrives before
        // the transport is up, and the proof step waits one second for a peer,
        // so retrying eagerly just burns the attempt and logs a failure that
        // reads like a broken publisher rather than a connection still forming.
        const live = [...existing.scope.sessions.values()]
          .some(session => !session.closed && session.state === 'active')
        existing.scope.idleLocatorTicks = live ? 0 : (existing.scope.idleLocatorTicks || 0) + 1
        if (existing.scope.catalogComplete !== true && live) {
          void syncPublisherCatalog(existing.scope).catch(error => {
            recordProtocolError(existing.scope, 'locator-retry', error)
          })
          return skip('locator unchanged; retrying an unfinished catalog walk')
        }
        // A channel can close while the connection carrying it stays up, and
        // then this scope is not waiting for anything: the locator has not
        // moved so the checks above skip it, the topic is already joined so no
        // connection event re-attaches it, and the catalog can never advance
        // again. Rebuilding from the same locator rejoins the topic, which
        // re-attaches the peers already connected. Two consecutive idle ticks
        // rather than one, because a transport still forming is not stalled,
        // and only while a peer is actually connected - with nobody there,
        // rebuilding would burn the attempt cap against an absent publisher.
        // That cap counts locators that never worked, and this one did.
        const stalled = !live && existing.scope.idleLocatorTicks >= 2 && activeConnections.size > 0
        if (!stalled) {
          return skip(live ? 'locator identical to current scope' : 'locator identical; no live session yet')
        }
        bootstrapFollowAttempts.delete(publisherId)
      }
    }
    const fingerprint = [
      locator.catalogEpoch,
      b4a.toString(locatorTopic, 'hex'),
      locator.catalogBootstrapKey,
      locator.catalogHead,
      locator.authorizationChainDigest,
    ].join(':')
    const prior = bootstrapFollowAttempts.get(publisherId)
    const attempts = prior?.fingerprint === fingerprint ? prior.attempts : 0
    if (attempts >= 4) return skip(`attempt cap reached (${attempts})`)
    bootstrapFollowAttempts.set(publisherId, { fingerprint, attempts: attempts + 1 })
    const work = followBootstrapLocator({ publisherId })
      .then(async result => {
        if (!publisherFollowReasons.get(publisherId)?.size) {
          await unfollowPublisher({ publisherId })
          return null
        }
        reasonFollowedPublishers.add(publisherId)
        return result
      })
      .finally(() => publisherFollowWork.delete(publisherId))
    publisherFollowWork.set(publisherId, work)
    // Following is how a discovered publisher becomes a visible catalog. When
    // it fails there is otherwise no trace anywhere: the peer stays connected,
    // the locator stays accepted, and every catalog surface stays empty.
    void work.then(
      result => console.log('[ScopedNetwork] publisher follow ok:', publisherId.slice(0, 16), result?.status || 'followed'),
      error => console.log('[ScopedNetwork] publisher follow FAILED:', publisherId.slice(0, 16), error?.code || error?.message || error)
    )
  }

  async function addPublisherFollowReason({ publisherId, reason } = {}) {
    const id = hex32(publisherId, 'publisherId')
    const normalizedReason = normalizeFollowReason(reason)
    let reasons = publisherFollowReasons.get(id)
    if (!reasons) {
      if (publisherFollowReasons.size >= 4096) fail('publisher follow reason limit exceeded')
      reasons = new Set()
      publisherFollowReasons.set(id, reasons)
    }
    if (reasons.size >= 64 && !reasons.has(normalizedReason)) fail('publisher follow reason limit exceeded')
    reasons.add(normalizedReason)
    scheduleReasonedPublisherFollow(id)
    return { status: 'scheduled', publisherId: id, reasons: [...reasons].sort() }
  }

  async function removePublisherFollowReason({ publisherId, reason } = {}) {
    const id = hex32(publisherId, 'publisherId')
    const normalizedReason = normalizeFollowReason(reason)
    const reasons = publisherFollowReasons.get(id)
    reasons?.delete(normalizedReason)
    if (reasons?.size === 0) publisherFollowReasons.delete(id)
    if (!publisherFollowReasons.has(id) && reasonFollowedPublishers.has(id) && !publisherFollowWork.has(id)) {
      reasonFollowedPublishers.delete(id)
      await unfollowPublisher({ publisherId: id })
    }
    return { status: 'removed', publisherId: id, reasons: [...(publisherFollowReasons.get(id) || [])].sort() }
  }

  function getPublisherFollowReasons({ publisherId } = {}) {
    const id = hex32(publisherId, 'publisherId')
    return [...(publisherFollowReasons.get(id) || [])].sort()
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

  async function followPublisher ({
    publisherId,
    namespaceDescriptor,
    verifiedNamespaceProof = null,
    verifiedBootstrapLocator = null,
    locatorAuthority = null,
  } = {}) {
    if (status !== 'active') fail('runtime is not active')
    const id = hex32(publisherId, 'publisherId')
    const descriptor = normalizeNamespace(namespaceDescriptor, protocolMajor, { verifiedNamespaceProof })
    if (b4a.toString(descriptor.publisherId, 'hex') !== id) fail('namespace publisherId mismatch')
    const existing = followedPublishers.get(id)
    let previousFollow = null
    const authoritativeLocator = locatorAuthority === verifiedLocatorAuthority
      ? verifiedBootstrapLocator
      : null
    if (existing) {
      if (descriptor.catalogEpoch > existing.scope.descriptor.catalogEpoch) {
        // Promote the already-authenticated candidate for the new epoch before
        // closing the prior epoch channel. Closing first can tear down the
        // shared transport while the peer is still proving the replacement.
        previousFollow = existing
        followedPublishers.delete(id)
      } else {
        if (authoritativeLocator &&
            Number(authoritativeLocator.issuedAt) >= Number(existing.scope.advertisedLocatorIssuedAt || 0)) {
          existing.scope.advertisedCatalogHead = authoritativeLocator.catalogHead
          existing.scope.advertisedAuthorizationStateDigest = authoritativeLocator.authorizationChainDigest
          existing.scope.advertisedLocatorSignerId = authoritativeLocator.signerId
          existing.scope.advertisedLocatorIssuedAt = authoritativeLocator.issuedAt
          // Same reason as on first follow: a publisher that has appended now
          // serves a head this scope is not walking toward, and the page
          // response would be rejected as equivocation. Retarget the walk at
          // the newly advertised head and drop the cursor for the old one.
          if (existing.scope.catalogHeadDigest !== authoritativeLocator.catalogHead) {
            existing.scope.catalogHeadDigest = authoritativeLocator.catalogHead
            existing.scope.catalogAuthorizationStateDigest = null
            existing.scope.catalogCursor = null
            existing.scope.catalogResumeCursor = null
            existing.scope.catalogPreviousPageDigest = null
          }
          existing.scope.catalogComplete = false
          void syncPublisherCatalog(existing.scope).catch(error => {
            recordProtocolError(existing.scope, 'bootstrap-refresh', error)
          })
        }
        return { ...existing.result, status: 'already-following' }
      }
    }
    if (!catalogRegistry?.bindNamespace) fail('catalog registry cannot bind verified namespaces')
    const binding = await catalogRegistry.bindNamespace(descriptor, { verifiedNamespaceProof })
    if (hex32(binding.catalogBootstrapKey, 'catalogBootstrapKey') !== b4a.toString(descriptor.catalogBootstrapKey, 'hex')) fail('catalog binding mismatch')
    await publisherManager.followPublisher(id)
    await binding.catalog?.openVerifiedPageView?.()
    const saved = await publisherSyncStateRepository?.load?.(id)
    const restored = saved?.version === 1 && saved.publisherId === id &&
      saved.catalogEpoch === descriptor.catalogEpoch
      ? saved
      : null
    // The locator is signed and fresher than anything persisted here. Once a
    // publisher appends, its advertised head no longer matches the head this
    // device last synced to, and syncing toward the stale one makes the
    // publisher's own pages look like head equivocation - so a catalog could
    // never grow for anyone already following it. Adopt the advertised head
    // and walk again from the start, because the saved cursor describes the
    // head that has just been superseded.
    const advertisedHead = authoritativeLocator?.catalogHead || null
    const resumable = !advertisedHead || !restored?.headDigest || restored.headDigest === advertisedHead
    const topic = derivePublisherTopic({ publisherId: id, catalogEpoch: descriptor.catalogEpoch })
    const { scope } = joinScope({
      purpose: 'publisher',
      topic,
      scopeId: id,
      mode: 'followed',
      publisherId: id,
      descriptor,
      binding,
      namespaceProofVerified: null,
      catalogPagePending: null,
      catalogSyncing: null,
      catalogCursor: null,
      catalogResumeCursor: resumable ? (restored?.cursor || null) : null,
      catalogPreviousPageDigest: null,
      catalogHeadDigest: resumable ? (restored?.headDigest || advertisedHead) : advertisedHead,
      catalogAuthorizationStateDigest: resumable ? (restored?.authorizationStateDigest || null) : null,
      advertisedCatalogHead: authoritativeLocator?.catalogHead || null,
      advertisedAuthorizationStateDigest: authoritativeLocator?.authorizationChainDigest || null,
      advertisedLocatorSignerId: authoritativeLocator?.signerId || null,
      advertisedLocatorIssuedAt: authoritativeLocator?.issuedAt || null,
      catalogComplete: restored?.complete === true &&
        (!authoritativeLocator || restored?.headDigest === authoritativeLocator.catalogHead),
      catalogBudget: restoreCatalogBudget(restored?.budget),
      catalogInitialHeadLength: 0,
      catalogVerifiedPages: 0,
      catalogVerifiedRecords: 0,
      catalogVerifiedBytes: 0,
      catalogVerificationWork: 0,
    })
    scope.publisherId = id
    scope.descriptor = descriptor
    scope.binding = binding
    Object.assign(scope, {
      namespaceProofVerified: null,
      catalogPagePending: null,
      catalogSyncing: null,
      catalogCursor: null,
      catalogResumeCursor: restored?.cursor || null,
      catalogPreviousPageDigest: null,
      catalogHeadDigest: restored?.headDigest || authoritativeLocator?.catalogHead || null,
      catalogAuthorizationStateDigest: restored?.authorizationStateDigest || null,
      advertisedCatalogHead: authoritativeLocator?.catalogHead || null,
      advertisedAuthorizationStateDigest: authoritativeLocator?.authorizationChainDigest || null,
      advertisedLocatorSignerId: authoritativeLocator?.signerId || null,
      advertisedLocatorIssuedAt: authoritativeLocator?.issuedAt || null,
      catalogComplete: restored?.complete === true &&
        (!authoritativeLocator || restored?.headDigest === authoritativeLocator.catalogHead),
      catalogBudget: restoreCatalogBudget(restored?.budget),
      catalogInitialHeadLength: 0,
      catalogVerifiedPages: 0,
      catalogVerifiedRecords: 0,
      catalogVerifiedBytes: 0,
      catalogVerificationWork: 0,
    })
    const result = { status: 'following', publisherId: id, catalogBootstrapKey: hex32(binding.catalogBootstrapKey, 'catalogBootstrapKey'), topic: stableScopeDiagnostic(scope) }
    followedPublishers.set(id, { scope, result })
    if (previousFollow) {
      await leaveScope(previousFollow.scope, 'followed')
    }
    if ([...scope.sessions.values()].some(session => !session.closed && session.state === 'active')) {
      void syncPublisherCatalog(scope).catch(error => {
        recordProtocolError(scope, 'bootstrap-promotion', error)
      })
    }
    return result
  }

  // Bootstrap metadata only identifies an untrusted candidate. A caller may
  // supply the bounded namespace proof collected from that publisher topic;
  // this is the sole route from candidate metadata to catalog binding.
  async function followBootstrapLocator ({ publisherId, proof = null } = {}) {
    const id = hex32(publisherId, 'publisherId')
    const locator = bootstrapManager.getLocator?.(id)
    if (!locator) fail('bootstrap locator is unavailable', 'BOOTSTRAP_LOCATOR_UNAVAILABLE')
    const topic = derivePublisherTopic({ publisherId: id, catalogEpoch: locator.catalogEpoch })
    const { scope } = joinScope({
      purpose: 'publisher', topic, scopeId: id, mode: 'candidate', publisherId: id,
      candidateLocator: locator, proofPending: null,
    })
    let verified
    let namespaceProof
    try {
      namespaceProof = proof || await requestNamespaceProof(scope)
      verified = verifyPublisherNamespaceProof({ locator, ...namespaceProof })
    } catch (error) {
      await leaveScope(scope, 'candidate')
      const rejected = new Error(error?.message || 'namespace proof rejected')
      rejected.code = 'PUBLISHER_NAMESPACE_PROOF_REJECTED'
      throw rejected
    }
    const result = await followPublisher({
      publisherId: id,
      namespaceDescriptor: verified.descriptor,
      verifiedNamespaceProof: verified.descriptor.catalogEpoch > 0 ? namespaceProof : null,
      verifiedBootstrapLocator: locator,
      locatorAuthority: verifiedLocatorAuthority,
    })
    await leaveScope(scope, 'candidate')
    return result
  }

  async function providePublisherNamespaceProof ({ locator, proof } = {}) {
    const id = hex32(locator?.publisherId, 'locator publisherId')
    const verified = verifyPublisherNamespaceProof({ locator, ...(proof || {}) })
    const topic = derivePublisherTopic({ publisherId: id, catalogEpoch: locator.catalogEpoch })
    // The proof response deliberately carries only signed operations. The
    // descriptor is reconstructed from those operations, avoiding an
    // unauthenticated duplicate descriptor representation on the wire.
    publisherProofProviders.set(id, { genesis: proof?.genesis, transitions: proof?.transitions })
    const { scope } = joinScope({
      purpose: 'publisher', topic, scopeId: id, mode: 'candidate', publisherId: id,
      candidateLocator: locator, proofPending: null,
    })
    return { status: 'provided', publisherId: id, catalogEpoch: verified.descriptor.catalogEpoch, topic: stableScopeDiagnostic(scope) }
  }

  async function provideLocalPublisherNamespaceProof ({ publisherId, descriptor, catalog } = {}) {
    const id = hex32(publisherId, 'publisherId')
    let genesis = null
    const transitions = []
    if (typeof catalog?.listAcceptedPage !== 'function') fail('local catalog accepted pages are unavailable for namespace proof')
    let cursor = null
    let scanned = 0
    do {
      const page = await catalog.listAcceptedPage({ cursor, limit: MAX_CATALOG_PAGE_RECORDS })
      if (!page || !Array.isArray(page.entries) || page.entries.length > MAX_CATALOG_PAGE_RECORDS) fail('local catalog namespace proof page is invalid')
      for (const entry of page.entries) {
        const operation = decodePublisherCatalogFrame(entry.frame)
        scanned++
        if (scanned > MAX_CATALOG_SESSION_RECORDS) fail('local catalog namespace proof scan exceeds bounded limit')
        if (operation.recordType === 'publisher.namespace' && !operation.transitionId) genesis ||= operation
        else if (operation.recordType === 'publisher.root-transition') transitions.push(operation)
      }
      cursor = page.nextCursor ?? null
    } while (cursor !== null)
    if (!genesis) fail('local catalog has no namespace genesis proof')
    transitions.sort((left, right) => {
      const leftEpoch = decodePublisherOperationBody(left.recordType, left.canonicalBody).newCatalogEpoch
      const rightEpoch = decodePublisherOperationBody(right.recordType, right.canonicalBody).newCatalogEpoch
      return leftEpoch - rightEpoch || left.issuerSequence - right.issuerSequence ||
        b4a.compare(left.transitionId, right.transitionId)
    })
    publisherProofProviders.set(id, { genesis, transitions })
    publisherPageProviders.set(id, { catalog, catalogEpoch: descriptor.catalogEpoch })
    const topic = derivePublisherTopic({ publisherId: id, catalogEpoch: descriptor.catalogEpoch })
    const { scope } = joinScope({ purpose: 'publisher', topic, scopeId: id, mode: 'local', publisherId: id, proofPending: null })
    return { status: 'provided', publisherId: id, topic: stableScopeDiagnostic(scope) }
  }

  async function provideIndexFeed ({ curatorId, fetchPage } = {}) {
    const id = hex32(curatorId, 'curatorId')
    if (typeof fetchPage !== 'function') fail('index feed provider requires fetchPage')
    indexFeedProviders.set(id, fetchPage)
    joinScope({ purpose: 'index', topic: deriveIndexTopic({ protocolMajor, curatorId: id }), scopeId: id, mode: 'provided', feedId: id, feedKind: 'index', feedPending: new Map() })
    return { status: 'provided', curatorId: id }
  }

  async function subscribeIndexFeed ({ curatorId } = {}) {
    const id = hex32(curatorId, 'curatorId')
    await indexFeedManager.ready
    await indexFeedManager.subscribe(id)
    const { scope } = joinScope({ purpose: 'index', topic: deriveIndexTopic({ protocolMajor, curatorId: id }), scopeId: id, mode: 'subscribed', feedId: id, feedKind: 'index', feedPending: new Map() })
    return syncFollowedFeed(scope)
  }

  async function followIndexFeed ({ curatorId } = {}) {
    const id = hex32(curatorId, 'curatorId')
    await indexFeedManager.ready
    await indexFeedManager.subscribe(id)
    const { scope } = joinScope({ purpose: 'index', topic: deriveIndexTopic({ protocolMajor, curatorId: id }), scopeId: id, mode: 'subscribed', feedId: id, feedKind: 'index', feedPending: new Map() })
    return { status: 'following', curatorId: id, topic: stableScopeDiagnostic(scope) }
  }

  async function unfollowIndexFeed ({ curatorId } = {}) {
    const id = hex32(curatorId, 'curatorId')
    await indexFeedManager.ready
    await indexFeedManager.unsubscribe(id)
    const scope = findScope('index', deriveIndexTopic({ protocolMajor, curatorId: id }))
    const released = scope ? await leaveScope(scope, 'subscribed') : false
    return { status: 'unfollowed', curatorId: id, released }
  }

  async function provideModerationFeed ({ moderatorId, fetchPage } = {}) {
    const id = hex32(moderatorId, 'moderatorId')
    if (typeof fetchPage !== 'function') fail('moderation feed provider requires fetchPage')
    moderationFeedProviders.set(id, fetchPage)
    joinScope({ purpose: 'moderation', topic: deriveModerationTopic({ protocolMajor, moderatorId: id }), scopeId: id, mode: 'provided', feedId: id, feedKind: 'moderation', feedPending: new Map() })
    return { status: 'provided', moderatorId: id }
  }

  async function subscribeModerationFeed ({ moderatorId } = {}) {
    const id = hex32(moderatorId, 'moderatorId')
    await moderationManager.ready
    await moderationManager.subscribe(id)
    const { scope } = joinScope({ purpose: 'moderation', topic: deriveModerationTopic({ protocolMajor, moderatorId: id }), scopeId: id, mode: 'subscribed', feedId: id, feedKind: 'moderation', feedPending: new Map() })
    return syncFollowedFeed(scope)
  }

  async function followModerationFeed ({ moderatorId } = {}) {
    const id = hex32(moderatorId, 'moderatorId')
    await moderationManager.ready
    await moderationManager.subscribe(id)
    const { scope } = joinScope({ purpose: 'moderation', topic: deriveModerationTopic({ protocolMajor, moderatorId: id }), scopeId: id, mode: 'subscribed', feedId: id, feedKind: 'moderation', feedPending: new Map() })
    return { status: 'following', moderatorId: id, topic: stableScopeDiagnostic(scope) }
  }

  async function unfollowModerationFeed ({ moderatorId } = {}) {
    const id = hex32(moderatorId, 'moderatorId')
    await moderationManager.ready
    await moderationManager.unsubscribe(id)
    const scope = findScope('moderation', deriveModerationTopic({ protocolMajor, moderatorId: id }))
    const released = scope ? await leaveScope(scope, 'subscribed') : false
    return { status: 'unfollowed', moderatorId: id, released }
  }

  async function unfollowPublisher ({ publisherId } = {}) {
    const id = hex32(publisherId, 'publisherId')
    const followed = followedPublishers.get(id)
    followedPublishers.delete(id)
    reasonFollowedPublishers.delete(id)
    await publisherManager.unfollowPublisher(id)
    const released = followed ? await leaveScope(followed.scope, 'followed') : false
    if (followed && !localPublishers.has(id)) await catalogRegistry?.release?.(b4a.from(id, 'hex'))
    await publisherSyncStateRepository?.clear?.(id)
    return { status: 'unfollowed', publisherId: id, released }
  }

  async function publishLocalPublisherCatalog ({ publisherId, retentionClass: requestedRetentionClass } = {}) {
    const retentionClass = normalizeRetentionClass(requestedRetentionClass)
    if (!retentionClassAllowed(retentionClass) || !uploadAllowed) {
      if (retentionClass === 'contribution-cache') {
        fail('explicit contribution upload permission is required')
      }
      fail('explicit archive upload permission is required')
    }
    if (status !== 'active') fail('runtime is not active')
    const id = hex32(publisherId, 'publisherId')
    const existing = localPublishers.get(id)
    if (existing) {
      existing.scope.retentionClasses ??= new Set()
      existing.scope.retentionClasses.add(retentionClass)
      await rejoinScopeDiscovery(existing.scope)
      return rebindLocalPublisherCatalog({ publisherId: id })
    }
    if (!catalogRegistry?.resolve) fail('catalog registry is unavailable')
    const binding = await catalogRegistry.resolve(b4a.from(id, 'hex'))
    await binding.catalog?.ready?.()
    if (typeof binding.catalog?.listProjections !== 'function') fail('local catalog projection is unavailable')
    const [publications, claims] = await Promise.all([
      binding.catalog.listProjections('publication', { limit: 1 }),
      binding.catalog.listProjections('claim', { limit: 1 })
    ])
    if ((publications?.items?.length || 0) === 0 && (claims?.items?.length || 0) === 0) {
      fail('local catalog has no accepted publication or claim')
    }
    const descriptorEntry = await binding.catalog?.view?.get?.('state/descriptor')
    const descriptor = normalizeNamespace(descriptorEntry?.value || binding.namespaceDescriptor, protocolMajor, {
      verifiedNamespaceProof: descriptorEntry?.value ? true : null,
    })
    if (b4a.toString(descriptor.publisherId, 'hex') !== id) fail('local catalog namespace mismatch')
    if (hex32(binding.catalogBootstrapKey, 'catalogBootstrapKey') !== b4a.toString(descriptor.catalogBootstrapKey, 'hex')) fail('local catalog binding mismatch')
    binding.namespaceDescriptor = descriptor
    const topic = derivePublisherTopic({ publisherId: id, catalogEpoch: descriptor.catalogEpoch })
    const { scope } = joinScope({
      purpose: 'publisher',
      topic,
      scopeId: id,
      mode: 'local',
      publisherId: id,
      descriptor,
      binding,
      retentionClasses: new Set([retentionClass]),
    })
    scope.publisherId = id
    scope.descriptor = descriptor
    scope.binding = binding
    scope.retentionClasses ??= new Set()
    scope.retentionClasses.add(retentionClass)
    if (typeof binding.catalog?.listAcceptedPage === 'function') {
      await provideLocalPublisherNamespaceProof({ publisherId: id, descriptor, catalog: binding.catalog })
    }
    const result = {
      status: 'published',
      publisherId: id,
      catalogBootstrapKey: hex32(binding.catalogBootstrapKey, 'catalogBootstrapKey'),
      catalogEpoch: descriptor.catalogEpoch,
      topic: stableScopeDiagnostic(scope),
    }
    localPublishers.set(id, { scope, result })
    if (bootstrapLocatorKeyPair) await refreshLocalBootstrapLocator(id)
    return result
  }

  async function rebindLocalPublisherCatalog ({ publisherId } = {}) {
    if (status !== 'active') fail('runtime is not active')
    const id = hex32(publisherId, 'publisherId')
    const existing = localPublishers.get(id)
    if (!existing) return publishLocalPublisherCatalog({ publisherId: id })
    const binding = await catalogRegistry.resolve(b4a.from(id, 'hex'))
    await binding.catalog?.ready?.()
    const descriptorEntry = await binding.catalog?.view?.get?.('state/descriptor')
    const descriptor = normalizeNamespace(descriptorEntry?.value || binding.namespaceDescriptor, protocolMajor, {
      verifiedNamespaceProof: descriptorEntry?.value ? true : null,
    })
    const previous = existing.scope.descriptor
    const changed = descriptor.catalogEpoch !== previous.catalogEpoch ||
      !b4a.equals(descriptor.publisherRootKey, previous.publisherRootKey) ||
      !b4a.equals(descriptor.catalogBootstrapKey, previous.catalogBootstrapKey)
    if (!changed) {
      binding.namespaceDescriptor = descriptor
      existing.scope.descriptor = descriptor
      existing.scope.binding = binding
      await provideLocalPublisherNamespaceProof({ publisherId: id, descriptor, catalog: binding.catalog })
      if (bootstrapLocatorKeyPair) await refreshLocalBootstrapLocator(id)
      existing.result = {
        ...existing.result,
        catalogEpoch: descriptor.catalogEpoch,
        topic: stableScopeDiagnostic(existing.scope),
      }
      return { ...existing.result, status: 'refreshed' }
    }

    const locator = localBootstrapLocators.get(id)
    if (locator?.timer) cancelBootstrapLocatorRefresh(locator.timer)
    localBootstrapLocators.delete(id)
    publisherProofProviders.delete(id)
    publisherPageProviders.delete(id)
    localPublishers.delete(id)
    existing.scope.retired = true
    existing.scope.modes.add('rotation-drain')
    // A rotation writes three things that only make sense together: the new
    // epoch's channel, the signed locator advertising it, and the retirement of
    // the old channel. Batch them per connection so a peer applies the whole
    // rotation from one Protomux frame instead of observing a half-rotated
    // publisher, which is also one write per peer instead of three.
    const result = await withBatchedConnectionWrites(async () => {
      const published = await publishLocalPublisherCatalog({ publisherId: id })
      await leaveScope(existing.scope, 'local')
      return published
    })
    const timer = schedulePublisherRotationDrain(() => {
      publisherRotationDrainTimers.delete(timer)
      void leaveScope(existing.scope, 'rotation-drain')
    }, publisherRotationDrainMs)
    timer.unref?.()
    publisherRotationDrainTimers.add(timer)
    return { ...result, status: 'rebound' }
  }

  async function resolveLocalPublisherCatalog ({ publisherId } = {}) {
    const id = hex32(publisherId, 'publisherId')
    if (!catalogRegistry?.resolve) return { status: 'unavailable', publisherId: id }
    try {
      const binding = await catalogRegistry.resolve(b4a.from(id, 'hex'))
      await binding.catalog?.ready?.()
      const descriptorEntry = await binding.catalog?.view?.get?.('state/descriptor')
      const descriptor = binding.namespaceDescriptor || (descriptorEntry?.value ? normalizeNamespace(descriptorEntry.value, protocolMajor) : null)
      return {
        status: 'available',
        catalogBootstrapKey: hex32(binding.catalogBootstrapKey, 'catalogBootstrapKey'),
        catalogEpoch: descriptor?.catalogEpoch ?? null,
        writable: Boolean(binding.catalog?.writable),
      }
    } catch {
      return { status: 'unavailable', publisherId: id }
    }
  }

  // Artwork is small and belongs to the publication, so it is retained beside
  // the media rather than on demand. Best effort by design: a cover that will
  // not retain must never cost the caller the video it actually asked for.
  async function retainPublicationArtwork({ manifest, entityRef, publicationId }) {
    for (const candidate of manifest?.body?.renditions || []) {
      if (!isArtworkRendition(candidate) || candidate.blocked || candidate.superseded) continue
      if (renditions.has(String(candidate.renditionId))) continue
      try {
        await retainAuthorizedRendition({
          manifest,
          renditionId: candidate.renditionId,
          entityRef,
          publicationId,
        })
      } catch (error) {
        // A missing cover is a blank card; a failed retain here would be a
        // title that will not seed at all. Say why, or a publisher that is
        // silently not serving its cover looks exactly like one that is.
        console.log('[ScopedNetwork] cover not retained:', String(candidate.renditionId).slice(0, 12), error?.message)
      }
    }
  }

  async function retainAuthorizedRendition ({
    manifest,
    renditionId,
    ownerId: requestedOwnerId,
    retentionClass: requestedRetentionClass,
    start = 0,
    end = null,
    entityRef = null,
    publicationId = null,
  } = {}) {
    const retentionClass = normalizeRetentionClass(requestedRetentionClass)
    if (status !== 'active') fail('runtime is not active')
    const consumerVisible = await authorizeConsumerWork({
      operation: 'asset-retain',
      entityRef,
      publicationId: publicationId || manifest?.publicationId || null,
      renditionId,
    })
    if (!consumerVisible) fail('consumer media is not visible under local policy', 'CONSUMER_MEDIA_NOT_VISIBLE')
    const id = String(renditionId || '')
    const ownerId = String(requestedOwnerId || manifest?.publicationId || id)
    if (!ownerId) fail('retention owner is required')
    const rendition = (manifest?.body?.renditions || []).find(candidate => candidate.renditionId === id)
    if (!rendition || rendition.blocked || rendition.superseded) fail('rendition is not manifest-authorized')
    const coreRef = normalizeAssetCoreRefV2(rendition.core)
    const declaredLength = coreRef.length
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 1) fail('rendition core length is invalid')
    // A channel appends every rendition to one blobs core, so core.length is the
    // whole core rather than this rendition's span. Defaulting an unspecified
    // range to 0..core.length only authorizes for the first rendition ever
    // written; every later one asks for blocks outside its own upload
    // provenance and fails authorization. Fall back to the rendition's declared
    // upload range instead.
    // Cover art records its span the same way, under its own provenance type,
    // so it is held over the blocks it actually occupies rather than the whole
    // shared core — which would ask for blocks belonging to other renditions
    // and fail authorization.
    const uploadProvenance = (manifest?.body?.provenance || []).filter(candidate =>
      (candidate?.type === 'upload' || candidate?.type === 'artwork') &&
      candidate.renditionId === id &&
      candidate.coreKey === rendition.core?.key &&
      Number.isSafeInteger(candidate.start) &&
      Number.isSafeInteger(candidate.end) &&
      candidate.start >= 0 &&
      candidate.end > candidate.start
    )
    // Authorization requires one provenance entry to cover the whole requested
    // range, so a span stitched across several entries could never verify.
    // Only derive a default when the rendition has exactly one upload span;
    // anything else keeps the old default and fails loudly rather than
    // silently retaining part of the rendition.
    const soleUpload = uploadProvenance.length === 1 ? uploadProvenance[0] : null
    const defaultStart = soleUpload ? soleUpload.start : 0
    const defaultEnd = soleUpload ? soleUpload.end : declaredLength
    const range = safeRange(start === 0 && end === null ? defaultStart : start, end === null ? defaultEnd : end)
    if (range.end > declaredLength) fail('rendition range exceeds the manifest core length')
    const verified = await authorizePublication({ manifest, renditionId: id, start: range.start, end: range.end })
    if (!verified) fail('publication manifest authorization failed')
    const coreKey = coreRef.key
    const existing = renditions.get(id)
    if (existing) {
      if (existing.scope.coreKey !== coreKey ||
          range.start < existing.scope.range.start ||
          range.end > existing.scope.range.end) {
        fail('rendition is already retained with a different authorization')
      }
      const existingOwner = existing.owners.get(ownerId)
      if (existingOwner) {
        if (existingOwner.range.start !== range.start || existingOwner.range.end !== range.end) {
          fail('retention owner already has a different authorization range')
        }
        existing.scope.retentionClasses ??= new Set()
        existing.scope.retentionClasses.add(retentionClass)
        return { ...existing.result, ownerId, range: { ...range }, status: 'already-retained' }
      }
      const mode = `retained:${id}:${ownerId}`
      joinScope({
        purpose: 'asset',
        topic: existing.scope.topic,
        scopeId: coreRef.assetId,
        mode,
      })
      existing.scope.retentionClasses ??= new Set()
      existing.scope.retentionClasses.add(retentionClass)
      existing.scope.assetAuthorizations.set(
        assetAuthorizationId(id, ownerId),
        { manifest, renditionId: id, range: { ...range } },
      )
      existing.owners.set(ownerId, { mode, manifest, range: { ...range } })
      return { ...existing.result, ownerId, range: { ...range }, status: 'retained' }
    }

    const topic = deriveStaticAssetTopic(coreRef.assetId)
    const sharedScope = findScope('asset', topic)
    if (sharedScope && (
      sharedScope.coreKey !== coreKey ||
      range.start < sharedScope.range.start ||
      range.end > sharedScope.range.end
    )) {
      fail('static asset is already retained with a different authorization range')
    }
    const mode = `retained:${id}:${ownerId}`
    let scope = sharedScope
    if (scope) {
      joinScope({ purpose: 'asset', topic, scopeId: coreRef.assetId, mode })
      scope.retentionClasses ??= new Set()
      scope.retentionClasses.add(retentionClass)
      scope.assetAuthorizations.set(
        assetAuthorizationId(id, ownerId),
        { manifest, renditionId: id, range: { ...range } },
      )
    } else {
      if (!store?.get) fail('corestore is unavailable')
      let assetSession = null
      try {
        assetSession = createAssetSession({
          coreRef,
          store,
          startBlock: range.start,
          endBlock: range.end,
          onQuarantine: ({ cause, context }) => quarantineAssetScope(scope, cause, context),
        })
        const core = await assetSession.ready()
        const download = core.download?.({ start: range.start, end: range.end }) || null
        ;({ scope } = joinScope({
          purpose: 'asset',
          topic,
          scopeId: coreRef.assetId,
          mode,
          assetId: coreRef.assetId,
          coreKey,
          download,
          range,
          assetSession,
          assetRequests: new Map(),
          retentionClasses: new Set([retentionClass]),
          entityRef,
          publicationId: publicationId || manifest?.publicationId || null,
          assetAuthorizations: new Map([[
            assetAuthorizationId(id, ownerId),
            { manifest, renditionId: id, range: { ...range } },
          ]]),
        }))
        scope.blockHandle = assetSession.blockEngine.attach({
          scope,
          source: assetSession.blockSource,
          allowedRange: range,
          policyEpoch: () => networkPolicyEpoch,
          mayServe: () => Boolean(scopeUploadRetentionClass(scope)) && networkEnabled,
        })
      } catch (error) {
        try { await assetSession?.close?.() } catch { /* best-effort failed-session close */ }
        throw error
      }
    }
    const result = {
      status: 'retained',
      ownerId,
      renditionId: id,
      assetId: coreRef.assetId,
      coreKey,
      range: { ...range },
      topic: stableScopeDiagnostic(scope),
    }
    renditions.set(id, {
      scope,
      result,
      range: { ...range },
      owners: new Map([[ownerId, { mode, manifest, range: { ...range } }]]),
    })
    // Holding a title means holding what it looks like. Cover art rides the
    // same manifest precisely so a peer that seeds the movie can answer for
    // its poster too; leaving that to each caller means the one seeder that
    // forgets is a title nobody downstream can render.
    await retainPublicationArtwork({ manifest, entityRef, publicationId })
    return result
  }

  async function releaseAuthorizedRendition ({
    renditionId,
    ownerId: requestedOwnerId,
    assetId: requestedAssetId,
  } = {}) {
    const id = String(renditionId || '')
    const assetId = requestedAssetId === undefined
      ? null
      : hex32(requestedAssetId, 'assetId')
    const retained = renditions.get(id)
    if (!retained) {
      const scope = assetId ? findScope('asset', deriveStaticAssetTopic(assetId)) : null
      const remainingOwners = scope?.assetAuthorizations?.size || 0
      return {
        status: 'released',
        renditionId: id,
        ownerId: requestedOwnerId || null,
        assetId,
        released: false,
        remainingOwners,
        scopeQuiescent: remainingOwners === 0,
      }
    }
    if (assetId && retained.scope.assetId !== assetId) {
      fail('retained rendition asset identity mismatch')
    }
    const requestedOwnerIds = requestedOwnerId === undefined
      ? new Set(retained.owners.keys())
      : new Set([String(requestedOwnerId)])
    const requestedAuthorizationIds = new Set([...requestedOwnerIds].map(ownerId =>
      assetAuthorizationId(id, ownerId)))
    const remainingAuthorizations = [...(retained.scope.assetAuthorizations?.entries() || [])]
      .filter(([authorizationId]) => !requestedAuthorizationIds.has(authorizationId))
    const scopeRangeStillOwned = remainingAuthorizations.some(([, authorization]) =>
      authorization.range.start === retained.scope.range.start &&
      authorization.range.end === retained.scope.range.end)
    const revokeDependentOwners = remainingAuthorizations.length > 0 && !scopeRangeStillOwned
    let released = false
    for (const [retainedId, value] of [...renditions]) {
      if (value.scope !== retained.scope) continue
      for (const [ownerId, owner] of [...value.owners]) {
        if (!revokeDependentOwners && (retainedId !== id || !requestedOwnerIds.has(ownerId))) continue
        value.owners.delete(ownerId)
        retained.scope.assetAuthorizations?.delete(assetAuthorizationId(retainedId, ownerId))
        retained.scope.modes.delete(owner.mode)
        if (retainedId === id && requestedOwnerIds.has(ownerId)) released = true
      }
      if (value.owners.size === 0) renditions.delete(retainedId)
    }
    await leaveScope(retained.scope)
    const remainingOwners = retained.scope.assetAuthorizations?.size || 0
    return {
      status: 'released',
      renditionId: id,
      ownerId: requestedOwnerId === undefined ? null : String(requestedOwnerId),
      assetId: retained.scope.assetId,
      released,
      remainingOwners,
      scopeQuiescent: remainingOwners === 0,
    }
  }
  function activeAssetScope (assetId) {
    const id = hex32(assetId, 'assetId')
    const scope = findScope('asset', deriveStaticAssetTopic(id))
    if (!scope || scope.closed || scope.assetId !== id || !scope.assetSession) {
      fail('asset scope is not active')
    }
    return scope
  }

  function activeAssetPeers (scope) {
    return [...scope.sessions.values()].filter(session =>
      !session.closed && (session.state === 'active' || session.protocol?.state === 'active') && !session.channel?.closed)
  }

  function normalizeAssetPeerIds (peerIds) {
    if (peerIds === undefined) return null
    if (!Array.isArray(peerIds) || peerIds.length < 1 || peerIds.length > MAX_ASSET_PEERS_PER_REQUEST) {
      fail('asset peerIds are out of bounds')
    }
    const normalized = peerIds.map(boundedAssetPeerId)
    if (new Set(normalized).size !== normalized.length) fail('asset peerIds must be unique')
    return normalized.sort()
  }

  function mapAssetSessionError (scope, error) {
    if (error?.name === 'AbortError') return error
    if (scope && (!scope.assetSession.core || scope.assetSession.poisoned)) {
      return assetTransportError('QUARANTINED', null, 'asset core was quarantined', error)
    }
    if (String(error?.message || '').includes('unavailable')) {
      return assetTransportError('UNAVAILABLE', null, 'verified asset block is unavailable', error)
    }
    return error
  }

  function getActiveAssetSession ({ assetId } = {}) {
    if (status !== 'active') fail('runtime is not active')
    const scope = activeAssetScope(assetId)
    const session = scope.assetSession
    if (session.assetId !== scope.assetId ||
        session.coreRef?.assetId !== scope.assetId) {
      fail('active asset session identity mismatch')
    }
    return session
  }

  function getActiveAssetPeerIds ({ assetId } = {}) {
    if (status !== 'active' || !networkEnabled) fail('runtime is not active')
    return activeAssetPeers(activeAssetScope(assetId)).map(peer => peer.peerId).sort()
  }

  async function listAssetRanges ({ assetId, cursor = null, limit } = {}) {
    if (status !== 'active') fail('runtime is not active')
    const scope = activeAssetScope(assetId)
    return scope.assetSession.listAssetRanges({ cursor, limit })
  }

  async function listPeerAssetRanges ({ assetId, peerId, cursor = null, limit, signal } = {}) {
    if (status !== 'active' || !networkEnabled) fail('runtime is not active')
    const scope = activeAssetScope(assetId)
    const id = boundedAssetPeerId(peerId)
    const session = scope.sessions.get(id)
    if (!session || session.closed || session.state !== 'active' || session.channel?.closed) {
      throw assetTransportError('UNAVAILABLE', id, 'asset peer is not active')
    }
    if (session.assetInventoryRequest) {
      throw assetTransportError('UNAVAILABLE', id, 'asset inventory request is already pending')
    }
    if (signal?.aborted) throw assetAbortError(id, 'asset inventory request aborted')
    const payload = encodeAssetRangeSummaryRequest({
      assetId: scope.assetId,
      cursor,
      limit,
    })
    const normalized = decodeAssetRangeSummaryRequest(payload, {
      coreLength: scope.assetSession.coreRef.length,
    })
    let resolve
    let reject
    const promise = new Promise((onResolve, onReject) => {
      resolve = onResolve
      reject = onReject
    })
    const request = {
      cursor: normalized.cursor,
      limit: normalized.limit,
      signal,
      timer: null,
      closed: false,
      onAbort: null,
      resolve,
      reject,
    }
    request.onAbort = () => {
      if (!closeAssetInventoryRequest(
        session,
        request,
        assetAbortError(id, 'asset inventory request aborted'),
      )) return
      closeSession(scope, id, 'asset-inventory-aborted', session)
    }
    session.assetInventoryRequest = request
    signal?.addEventListener?.('abort', request.onAbort, { once: true })
    request.timer = setTimeout(() => {
      if (!closeAssetInventoryRequest(
        session,
        request,
        assetTransportError('TIMEOUT', id, 'asset inventory request timed out'),
      )) return
      closeSession(scope, id, 'asset-inventory-timeout', session)
    }, assetTransferTimeoutMs)
    if (signal?.aborted) {
      request.onAbort()
      return promise
    }
    try {
      if (!sendScopedFrame(session, 'asset', 'asset-range-summary-request', payload)) {
        closeAssetInventoryRequest(
          session,
          request,
          assetTransportError('UNAVAILABLE', id, 'asset inventory request could not be sent'),
        )
      }
    } catch (cause) {
      closeAssetInventoryRequest(
        session,
        request,
        assetTransportError('UNAVAILABLE', id, 'asset inventory request could not be sent', cause),
      )
    }
    return promise
  }

  async function hasVerifiedAssetBlock ({ assetId, blockIndex, signal } = {}) {
    if (status !== 'active') fail('runtime is not active')
    if (signal?.aborted) throw assetAbortError(null, 'asset block possession check aborted')
    const scope = activeAssetScope(assetId)
    const isActive = () => status === 'active' && !scope.closed && !signal?.aborted
    try {
      return await scope.assetSession.hasVerifiedBlock(blockIndex, { isActive })
    } catch (error) {
      if (signal?.aborted) throw assetAbortError(null, 'asset block possession check aborted')
      throw mapAssetSessionError(scope, error)
    }
  }

  async function readVerifiedAssetBlock ({ assetId, blockIndex, signal } = {}) {
    if (status !== 'active') fail('runtime is not active')
    if (signal?.aborted) throw assetAbortError(null, 'asset block read aborted')
    const scope = activeAssetScope(assetId)
    const isActive = () => status === 'active' && !scope.closed && !signal?.aborted
    try {
      return await scope.assetSession.readVerifiedBlock(blockIndex, { isActive })
    } catch (error) {
      if (signal?.aborted) throw assetAbortError(null, 'asset block read aborted')
      throw mapAssetSessionError(scope, error)
    }
  }

  async function requestAssetBlocks ({ assetId, startBlock, endBlock, peerIds, requirePeerEvidence = false, signal } = {}) {
    if (status !== 'active' || !networkEnabled) fail('runtime is not active')
    if (typeof requirePeerEvidence !== 'boolean') fail('requirePeerEvidence must be a boolean')
    const cancellation = { aborted: signal?.aborted === true, request: null, scope: null }
    if (cancellation.aborted) throw assetAbortError()
    const onAbort = () => {
      cancellation.aborted = true
      if (cancellation.request) closeAssetRequest(cancellation.scope, cancellation.request, assetAbortError())
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    const detachAbort = () => signal?.removeEventListener?.('abort', onAbort)

    let scope
    let range
    let selectedPeerIds
    const verified = new Set()
    const remaining = new Set()
    try {
      scope = activeAssetScope(assetId)
      cancellation.scope = scope
      selectedPeerIds = normalizeAssetPeerIds(peerIds)
      const transferId = allocateAssetTransferId()
      range = decodeAssetBlockRequest(encodeAssetBlockRequest({
        assetId: scope.assetId,
        transferId,
        startBlock,
        endBlock,
      }), { coreLength: scope.assetSession.coreRef.length })
      if (range.startBlock < scope.range.start || range.endBlock > scope.range.end) {
        fail('asset block request is outside the authorized range')
      }
      if (scope.assetRequests.size >= MAX_ASSET_BLOCKS_PER_REQUEST) {
        fail('active asset request limit exceeded')
      }
      const scanActive = () => !cancellation.aborted &&
        status === 'active' &&
        networkEnabled &&
        !scope.closed
      for (let index = range.startBlock; index < range.endBlock; index++) {
        if (!scanActive()) throw cancellation.aborted ? assetAbortError() : new Error('asset block request is closed')
        const present = await scope.assetSession.hasVerifiedBlock(index, { isActive: scanActive })
        if (!scanActive()) throw cancellation.aborted ? assetAbortError() : new Error('asset block request is closed')
        if (present) verified.add(index)
        if (!present || requirePeerEvidence) remaining.add(index)
      }
      if (remaining.size === 0) {
        if (cancellation.aborted) throw assetAbortError()
        detachAbort()
        return {
          verifiedBlockIndexes: [...verified],
          peerIds: [],
        }
      }
    } catch (error) {
      detachAbort()
      if (cancellation.aborted && error?.name !== 'AbortError') throw assetAbortError()
      throw mapAssetSessionError(scope, error)
    }

    const activePeers = activeAssetPeers(scope)
    const selectedSet = selectedPeerIds ? new Set(selectedPeerIds) : null
    const peers = selectedSet
      ? activePeers.filter(peer => selectedSet.has(peer.peerId))
      : activePeers
    if (peers.length === 0) {
      detachAbort()
      const unavailablePeerId = selectedPeerIds?.length === 1 ? selectedPeerIds[0] : null
      throw assetTransportError('UNAVAILABLE', unavailablePeerId, 'asset scope has no selected active peers')
    }
    if (cancellation.aborted) {
      detachAbort()
      throw assetAbortError()
    }

    let resolve
    let reject
    const promise = new Promise((onResolve, onReject) => {
      resolve = onResolve
      reject = onReject
    })
    // A peer may answer synchronously through an in-memory Protomux pair before
    // this async function returns the request promise. Mark the owned promise
    // handled immediately; callers still receive and observe its rejection.
    void promise.catch(() => {})
    const request = {
      key: range.transferId,
      transferId: range.transferId,
      startBlock: range.startBlock,
      endBlock: range.endBlock,
      remaining,
      verified,
      peerIds: new Set(),
      requestedPeers: new Set(),
      failedPeers: new Set(),
      peerFailures: new Map(),
      transfers: new Map(),
      signal,
      onAbort,
      timer: null,
      closed: false,
      resolve,
      reject,
    }
    request.timer = setTimeout(() => {
      const timedOutPeerId = request.requestedPeers.size === 1
        ? request.requestedPeers.values().next().value
        : null
      closeAssetRequest(scope, request, assetTransportError(
        'TIMEOUT',
        timedOutPeerId,
        'asset block request timed out',
      ))
    }, assetTransferTimeoutMs)
    scope.assetRequests.set(request.key, request)
    cancellation.request = request
    if (cancellation.aborted || signal?.aborted) {
      closeAssetRequest(scope, request, assetAbortError())
      return promise
    }

    const payload = encodeAssetBlockRequest({
      assetId: scope.assetId,
      transferId: request.transferId,
      startBlock: range.startBlock,
      endBlock: range.endBlock,
    })
    // Record every peer this request targets before a single frame goes out. A
    // peer can answer re-entrantly - an in-process transport, or a mux that
    // flushes inside send - and an answer from a peer the request has not
    // recorded yet is discarded as unsolicited, which strands the caller until
    // the transfer timeout instead of failing it now. Registering the whole set
    // first also keeps a synchronous refusal from one peer from settling a
    // request that still has others outstanding.
    for (const peer of peers) request.requestedPeers.add(peer.peerId)
    try {
      for (const peer of peers) {
        if (request.closed) break
        if (!sendScopedFrame(peer, 'asset', 'asset-block-request', payload)) {
          request.requestedPeers.delete(peer.peerId)
        }
      }
    } catch (cause) {
      const peerId = peers.length === 1 ? peers[0].peerId : null
      closeAssetRequest(scope, request, assetTransportError(
        'UNAVAILABLE',
        peerId,
        'asset block request could not be sent',
        cause,
      ))
      return promise
    }
    if (request.requestedPeers.size === 0) {
      const peerId = peers.length === 1 ? peers[0].peerId : null
      closeAssetRequest(scope, request, assetTransportError(
        'UNAVAILABLE',
        peerId,
        'asset block request could not be sent',
      ))
    }
    return promise
  }
  async function revalidateRetainedRenditions () {
    let released = 0
    for (const [renditionId, retained] of [...renditions]) {
      for (const [ownerId, owner] of [...retained.owners]) {
        const authorized = await authorizePublication({
          manifest: owner.manifest,
          renditionId,
          start: owner.range.start,
          end: owner.range.end,
        }).catch(() => false)
        const consumerVisible = authorized && await authorizeConsumerWork({
          operation: 'asset-revalidate',
          entityRef: retained.scope.entityRef,
          publicationId: retained.scope.publicationId || owner.manifest?.publicationId || null,
          renditionId,
        }).catch(() => false)
        if (consumerVisible) continue
        await releaseAuthorizedRendition({ renditionId, ownerId })
        released++
      }
    }
    return { released }
  }

  async function retainArchiveDiscovery ({ onRequest, onPledge, onChallenge, onChallengeProof, onPeer } = {}) {
    if (status !== 'active') fail('runtime is not active')
    for (const [name, listener] of Object.entries({ onRequest, onPledge, onChallenge, onChallengeProof })) {
      if (listener !== undefined && typeof listener !== 'function') fail(`${name} must be a function`)
    }
    const topic = deriveArchiveDiscoveryTopic({ protocolMajor, networkId })
    const { scope } = joinScope({
      purpose: 'archive-discovery',
      topic,
      scopeId: networkId,
      mode: 'discovery',
      archiveDiscovery: true,
      archiveRequestListeners: new Set(),
      archivePledgeListeners: new Set(),
      archiveChallengeListeners: new Set(),
      archiveChallengeProofListeners: new Set(),
      archiveChallengeProofTransfers: new Map(),
    })
    if (!scope.archiveDiscovery) fail('archive discovery topic collided with a custody scope')
    if (onRequest) scope.archiveRequestListeners.add(onRequest)
    if (onPledge) scope.archivePledgeListeners.add(onPledge)
    if (onChallenge) scope.archiveChallengeListeners.add(onChallenge)
    if (onChallengeProof) scope.archiveChallengeProofListeners.add(onChallengeProof)
    if (typeof onPeer === 'function') (scope.archivePeerListeners = scope.archivePeerListeners || new Set()).add(onPeer)
    return { status: 'retained', topic: stableScopeDiagnostic(scope) }
  }

  async function releaseArchiveDiscovery ({ onRequest, onPledge, onChallenge, onChallengeProof } = {}) {
    const topic = deriveArchiveDiscoveryTopic({ protocolMajor, networkId })
    const scope = findScope('archive-discovery', topic)
    if (!scope?.archiveDiscovery) return { status: 'released', released: false }
    if (onRequest) scope.archiveRequestListeners.delete(onRequest)
    if (onPledge) scope.archivePledgeListeners.delete(onPledge)
    if (onChallenge) scope.archiveChallengeListeners.delete(onChallenge)
    if (onChallengeProof) scope.archiveChallengeProofListeners.delete(onChallengeProof)
    if (scope.archiveRequestListeners.size > 0 || scope.archivePledgeListeners.size > 0 ||
        scope.archiveChallengeListeners.size > 0 || scope.archiveChallengeProofListeners.size > 0) {
      return { status: 'released', released: false }
    }
    return { status: 'released', released: await leaveScope(scope, 'discovery') }
  }

  async function publishArchiveEnvelope (type, value) {
    if (!ARCHIVE_DISCOVERY_ENVELOPE_TYPES.has(type)) fail('archive discovery frame type is invalid')
    const scope = findScope('archive-discovery', deriveArchiveDiscoveryTopic({ protocolMajor, networkId }))
    if (!scope?.archiveDiscovery) fail('archive discovery is disabled')
    const payload = encodeApplicationEnvelope(value)
    let delivered = 0
    for (const session of scope.sessions.values()) {
      if (sendScopedFrame(session, 'archive-discovery', type, payload)) delivered++
    }
    return { status: 'published', delivered }
  }

  async function publishArchiveRequest ({ request, envelope, entityRef = null, publicationId = null } = {}) {
    const consumerVisible = await authorizeConsumerWork({
      operation: 'archive-request',
      entityRef,
      publicationId: publicationId || request?.body?.publicationId || null,
    })
    if (!consumerVisible) fail('consumer media is not visible under local policy', 'CONSUMER_MEDIA_NOT_VISIBLE')
    return publishArchiveEnvelope('archive-request', envelope || request?.envelope || request)
  }

  async function publishArchivePledge ({ pledge, envelope } = {}) {
    if (!archiveAllowed) fail('explicit archive consent is required')
    return publishArchiveEnvelope('archive-pledge', envelope || pledge?.envelope || pledge)
  }

  async function publishArchiveChallenge ({ challenge, envelope } = {}) {
    if (!archiveAllowed) fail('explicit archive consent is required')
    return publishArchiveEnvelope('archive-challenge', envelope || challenge?.envelope || challenge)
  }

  async function publishArchiveChallengeProof ({ envelope, proofBytes } = {}) {
    if (!archiveAllowed) fail('explicit archive consent is required')
    const scope = findScope('archive-discovery', deriveArchiveDiscoveryTopic({ protocolMajor, networkId }))
    if (!scope?.archiveDiscovery) fail('archive discovery is disabled')
    const proof = b4a.from(proofBytes || [])
    if (proof.byteLength === 0 || proof.byteLength > MAX_ARCHIVE_CHALLENGE_PROOF_BYTES) {
      fail('archive challenge proof exceeds bounded limit')
    }
    const envelopeBytes = encodeApplicationEnvelope(envelope)
    let delivered = 0
    for (const session of scope.sessions.values()) {
      let complete = true
      const canBatch = typeof session.channel?.cork === 'function' && typeof session.channel?.uncork === 'function'
      if (canBatch) session.channel.cork()
      try {
        for (let offset = 0; offset < proof.byteLength; offset += ARCHIVE_CHALLENGE_PROOF_CHUNK_BYTES) {
          const chunk = proof.subarray(offset, Math.min(proof.byteLength, offset + ARCHIVE_CHALLENGE_PROOF_CHUNK_BYTES))
          const payload = c.encode(c.any, { envelope: envelopeBytes, offset, totalBytes: proof.byteLength, chunk })
          if (!sendScopedFrame(session, 'archive-discovery', 'archive-challenge-proof', payload)) {
            complete = false
            break
          }
        }
      } finally {
        if (canBatch) session.channel.uncork()
      }
      if (complete) delivered++
    }
    return { status: 'published', delivered }
  }

  async function retainAuthorizedArchive ({ pledge, coreKey: requestedCoreKey, start, end, download: shouldDownload = true } = {}) {
    if (shouldDownload !== false && !archiveAllowed) fail('explicit archive consent is required')
    if (shouldDownload !== false && archiveUploadCeilingBytes <= archiveUploadedBytes) fail('archive budget exhausted')
    if (status !== 'active') fail('runtime is not active')
    const envelope = pledge?.envelope || pledge
    const verified = await verifyArchivePledge(envelope, { now: options.now?.() })
    if (!verified) fail('archive pledge authorization failed')
    const coreKey = hex32(requestedCoreKey, 'coreKey')
    const range = safeRange(start, end)
    if (range.end === null) fail('archive range.end is required')
    const authorized = verified.body.ranges.some(candidate => candidate.coreKey === coreKey && candidate.start === range.start && candidate.end === range.end)
    if (!authorized) fail('archive range is not pledge-authorized')
    const archiveId = verified.pledgeId
    const resourceId = `${archiveId}:${coreKey}:${range.start}:${range.end}`
    const existing = archives.get(resourceId)
    if (existing) return { ...existing.result, status: 'already-retained' }
    if (!store?.get) fail('corestore is unavailable')
    const core = store.get({ key: b4a.from(coreKey, 'hex') })
    let releaseArchiveProtection = null
    try {
      if (typeof options.retainArchiveCore === 'function') {
        const release = options.retainArchiveCore({ archiveId, coreKey, start: range.start, end: range.end })
        if (typeof release === 'function') releaseArchiveProtection = release
      }
      await core.ready?.()
      const download = shouldDownload === false
        ? null
        : core.download?.({ start: range.start, end: range.end }) || null
      const topic = deriveArchiveTopic({ protocolMajor, archiveId })
      const mode = `range:${coreKey}:${range.start}:${range.end}`
      const { scope } = joinScope({
        purpose: 'archive',
        topic,
        scopeId: archiveId,
        mode,
        archiveId,
        archiveResources: new Map(),
        archivePending: new Set(),
        archiveRetries: new Map(),
        archiveFailures: new Map(),
        archiveUploadCeilingBytes: verified.body.uploadCeilingBytes,
      })
      if (!scope.archiveResources) scope.archiveResources = new Map()
      const resource = {
        resourceId,
        archiveId,
        coreKey,
        core,
        download,
        range,
        mode,
        nextIndex: shouldDownload === false ? range.end : range.start,
        releaseArchiveProtection,
      }
      resource.blockSource = {
        resourceId: coreKey,
        length: range.end,
        async apply({ index, proof, value, isActive }) {
          if (!isActive()) throw new Error('archive block request is closed')
          try {
            const applied = await core.applyProof({ ...proof, block: { ...proof.block, value } })
            if (applied !== true) throw new Error('core.applyProof rejected the archive block')
            if (!await core.has(index)) throw new Error('verified archive block was not committed')
          } catch (cause) {
            resource.quarantined = true
            await core.close?.()
            throw new Error('archive block proof verification failed', { cause })
          }
        },
      }
      resource.blockHandle = blockEngine.attach({
        scope,
        source: resource.blockSource,
        allowedRange: range,
        policyEpoch: () => networkPolicyEpoch,
        mayServe: () => archiveAllowed && networkEnabled,
      })
      scope.archiveResources.set(resourceId, resource)
      void pumpArchiveSessions(scope)
      const result = { status: 'retained', archiveId, coreKey, range: { ...range }, topic: stableScopeDiagnostic(scope) }
      archives.set(resourceId, { scope, resource, result })
      return result
    } catch (error) {
      try { releaseArchiveProtection?.() } catch { /* best-effort protection release */ }
      try { await core.close?.() } catch { /* best-effort failed-retention core close */ }
      throw error
    }
  }

  function retainedArchiveResource(archiveId, coreKey, index) {
    const id = hex32(archiveId, 'archiveId')
    const key = hex32(coreKey, 'coreKey')
    if (!Number.isSafeInteger(index) || index < 0) fail('archive challenge index is invalid')
    for (const retained of archives.values()) {
      const resource = retained.resource
      if (resource.quarantined !== true && resource.archiveId === id && resource.coreKey === key &&
          index >= resource.range.start && index < resource.range.end) return resource
    }
    fail('archive challenge is outside the retained pledge range')
  }

  async function createAuthorizedArchiveChallengeProof({ archiveId, coreKey, index } = {}) {
    const resource = retainedArchiveResource(archiveId, coreKey, index)
    if (!await resource.core.has?.(index)) fail('challenged archive block is not locally retained')
    const proof = await authorizedBlockProof(resource.core, index)
    if (proof?.block?.index !== index || !b4a.isBuffer(proof.block.value) ||
        proof.block.value.byteLength === 0 || proof.block.value.byteLength > MAX_ASSET_BLOCK_BYTES) {
      fail('generated archive challenge proof is invalid')
    }
    const proofBytes = c.encode(c.any, proof)
    if (proofBytes.byteLength > MAX_ARCHIVE_CHALLENGE_PROOF_BYTES) fail('archive challenge proof exceeds bounded limit')
    return proofBytes
  }

  async function verifyAuthorizedArchiveChallengeProof({ archiveId, coreKey, index, proofBytes } = {}) {
    const resource = retainedArchiveResource(archiveId, coreKey, index)
    const bytes = b4a.from(proofBytes || [])
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARCHIVE_CHALLENGE_PROOF_BYTES) return false
    try {
      const proof = c.decode(c.any, bytes)
      if (proof?.block?.index !== index || !b4a.isBuffer(proof.block.value) ||
          proof.block.value.byteLength === 0 || proof.block.value.byteLength > MAX_ASSET_BLOCK_BYTES) return false
      await resource.core.verifyFullyRemote(proof)
      return true
    } catch {
      return false
    }
  }

  async function releaseAuthorizedArchive ({ archiveId } = {}) {
    const id = hex32(archiveId, 'archiveId')
    const retained = [...archives.entries()].filter(([, value]) => value.resource.archiveId === id)
    let released = false
    for (const [resourceId, value] of retained) {
      archives.delete(resourceId)
      blockEngine.detach(value.resource.blockHandle)
      value.scope.archiveResources?.delete(resourceId)
      try { value.resource.releaseArchiveProtection?.() } catch { /* best-effort protection release */ }
      value.resource.releaseArchiveProtection = null
      await Promise.allSettled([
        cleanupResource(value.resource.download, ['destroy', 'close']),
        cleanupResource(value.resource.core, ['close']),
      ])
      released = await leaveScope(value.scope, value.resource.mode) || released
    }
    return { status: 'released', archiveId: id, released }
  }

  async function publishBootstrapLocator ({ locator, envelope } = {}) {
    if (!contributionAllowed || !uploadAllowed) fail('explicit contribution upload permission is required')
    const bootstrapScope = findScope('bootstrap', deriveBootstrapTopic({ protocolMajor, networkId }))
    if (!bootstrapScope) fail('bootstrap discovery is disabled')
    const value = envelope || locator?.envelope || locator
    const payload = encodeApplicationEnvelope(value)
    let delivered = 0
    for (const session of bootstrapScope.sessions.values()) {
      if (session.closed || session.state !== 'active') continue
      const frame = encodePeerFrame({ purpose: 'bootstrap', type: 'locator', requestId: nextRequestId++, payload })
      const sender = session.channel?.messages?.[0] || session.message
      if (sender?.send?.(frame, session.channel) !== false) delivered++
    }
    return { status: 'published', delivered }
  }

  function listBootstrapLocators () {
    return bootstrapManager.listLocators()
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
        ? handleBootstrapFrame(value, { peerId })
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

  function getIndexFeedRecords () {
    return indexFeedManager.getRecords()
  }

  function getModerationFeedRecords () {
    return moderationManager.getRecords()
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
    followedPublishers.clear()
    publisherFollowReasons.clear()
    publisherFollowWork.clear()
    reasonFollowedPublishers.clear()
    for (const value of localBootstrapLocators.values()) {
      if (value.timer) cancelBootstrapLocatorRefresh(value.timer)
    }
    for (const timer of publisherRotationDrainTimers) cancelPublisherRotationDrain(timer)
    publisherRotationDrainTimers.clear()
    localBootstrapLocators.clear()
    localPublishers.clear()
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
    start,
    applyNetworkPolicy,
    retainIndexService,
    releaseIndexService,
    followPublisher,
    followBootstrapLocator,
    addPublisherFollowReason,
    removePublisherFollowReason,
    getPublisherFollowReasons,
    providePublisherNamespaceProof,
    provideLocalPublisherNamespaceProof,
    provideIndexFeed,
    subscribeIndexFeed,
    followIndexFeed,
    unfollowIndexFeed,
    provideModerationFeed,
    subscribeModerationFeed,
    followModerationFeed,
    unfollowModerationFeed,
    unfollowPublisher,
    publishLocalPublisherCatalog,
    rebindLocalPublisherCatalog,
    resolveLocalPublisherCatalog,
    retainAuthorizedRendition,
    releaseAuthorizedRendition,
    queryIndexService,
    listRetainedIndexServiceAdapters,
    listAssetRanges,
    getActiveAssetSession,
    getActiveAssetPeerIds,
    listPeerAssetRanges,
    hasVerifiedAssetBlock,
    readVerifiedAssetBlock,
    requestAssetBlocks,
    revalidateRetainedRenditions,
    retainArchiveDiscovery,
    releaseArchiveDiscovery,
    publishArchiveRequest,
    publishArchivePledge,
    publishArchiveChallenge,
    publishArchiveChallengeProof,
    retainAuthorizedArchive,
    releaseAuthorizedArchive,
    createAuthorizedArchiveChallengeProof,
    verifyAuthorizedArchiveChallengeProof,
    publishBootstrapLocator,
    listBootstrapLocators,
    getIndexFeedRecords,
    getModerationFeedRecords,
    getDiagnostics,
    authorizeConnection,
    getLocalTransportPeerId,
    isPeerConnected,
    inspectIncomingFrame,
    close,
  }
}

export function createScopedNetworkApi (runtime) {
  if (!runtime) fail('scoped network runtime is required')
  return {
    retainIndexService: request => runtime.retainIndexService(request),
    releaseIndexService: request => runtime.releaseIndexService(request),
    followPublisher: request => runtime.followPublisher(request),
    followBootstrapLocator: request => runtime.followBootstrapLocator(request),
    addPublisherFollowReason: request => runtime.addPublisherFollowReason(request),
    removePublisherFollowReason: request => runtime.removePublisherFollowReason(request),
    getPublisherFollowReasons: request => runtime.getPublisherFollowReasons(request),
    providePublisherNamespaceProof: request => runtime.providePublisherNamespaceProof(request),
    provideLocalPublisherNamespaceProof: request => runtime.provideLocalPublisherNamespaceProof(request),
    provideIndexFeed: request => runtime.provideIndexFeed(request),
    subscribeIndexFeed: request => runtime.subscribeIndexFeed(request),
    followIndexFeed: request => runtime.followIndexFeed(request),
    unfollowIndexFeed: request => runtime.unfollowIndexFeed(request),
    provideModerationFeed: request => runtime.provideModerationFeed(request),
    subscribeModerationFeed: request => runtime.subscribeModerationFeed(request),
    followModerationFeed: request => runtime.followModerationFeed(request),
    unfollowModerationFeed: request => runtime.unfollowModerationFeed(request),
    unfollowPublisher: request => runtime.unfollowPublisher(request),
    publishLocalPublisherCatalog: request => runtime.publishLocalPublisherCatalog(request),
    rebindLocalPublisherCatalog: request => runtime.rebindLocalPublisherCatalog(request),
    resolveLocalPublisherCatalog: request => runtime.resolveLocalPublisherCatalog(request),
    retainAuthorizedRendition: request => runtime.retainAuthorizedRendition(request),
    releaseAuthorizedRendition: request => runtime.releaseAuthorizedRendition(request),
    queryIndexService: request => runtime.queryIndexService(request),
    listAssetRanges: request => runtime.listAssetRanges(request),
    getActiveAssetPeerIds: request => runtime.getActiveAssetPeerIds(request),
    listPeerAssetRanges: request => runtime.listPeerAssetRanges(request),
    hasVerifiedAssetBlock: request => runtime.hasVerifiedAssetBlock(request),
    readVerifiedAssetBlock: request => runtime.readVerifiedAssetBlock(request),
    requestAssetBlocks: request => runtime.requestAssetBlocks(request),
    retainArchiveDiscovery: request => runtime.retainArchiveDiscovery(request),
    releaseArchiveDiscovery: request => runtime.releaseArchiveDiscovery(request),
    publishArchiveRequest: request => runtime.publishArchiveRequest(request),
    publishArchivePledge: request => runtime.publishArchivePledge(request),
    publishArchiveChallenge: request => runtime.publishArchiveChallenge(request),
    publishArchiveChallengeProof: request => runtime.publishArchiveChallengeProof(request),
    retainAuthorizedArchive: request => runtime.retainAuthorizedArchive(request),
    releaseAuthorizedArchive: request => runtime.releaseAuthorizedArchive(request),
    createAuthorizedArchiveChallengeProof: request => runtime.createAuthorizedArchiveChallengeProof(request),
    verifyAuthorizedArchiveChallengeProof: request => runtime.verifyAuthorizedArchiveChallengeProof(request),
    publishBootstrapLocator: request => runtime.publishBootstrapLocator(request),
    getLocalTransportPeerId: () => runtime.getLocalTransportPeerId(),
    listBootstrapLocators: () => runtime.listBootstrapLocators(),
    getIndexFeedRecords: () => runtime.getIndexFeedRecords(),
    getModerationFeedRecords: () => runtime.getModerationFeedRecords(),
    getScopedNetworkDiagnostics: () => runtime.getDiagnostics(),
  }
}
