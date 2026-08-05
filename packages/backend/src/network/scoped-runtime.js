import b4a from 'b4a'
import c from 'compact-encoding'
import Protomux from 'protomux'
import crypto from 'hypercore-crypto'

import { createNetworkAdmission } from './admission.js'
import {
  decodePeerFrame,
  encodePeerFrame,
  MAX_PEER_FRAME_BYTES,
  PEER_FRAME_TYPE_NAMES,
  PROTOCOL_MAJOR,
} from './frame.js'
import {
  deriveArchiveDiscoveryTopic,
  deriveArchiveTopic,
  deriveAssetTopic,
  deriveBootstrapTopic,
  deriveIndexTopic,
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
import { isArtworkRendition } from '../assets/rendition.js'
import {
  assertProtocolCompatibility,
  createProtocolAdvertisement,
  MAX_PROTOCOL_CAPABILITIES,
} from './version.js'


const FRAME_TYPES = PEER_FRAME_TYPE_NAMES
export const ASSET_RENDITION_CAPABILITY = 'asset-rendition:v1'
export const ARCHIVE_RANGE_CAPABILITY = 'archive-range:v1'
export const ARCHIVE_DISCOVERY_CAPABILITY = 'archive-discovery:v1'
export const MODERATION_FEED_CAPABILITY = 'moderation-feed:v1'
export const SCOPED_NETWORK_PROTOCOL = 'peartube/scoped-network'

const PURPOSE_CODES = Object.freeze({ bootstrap: 1, publisher: 2, asset: 3, archive: 5, 'archive-discovery': 6, index: 7, moderation: 8 })
const PURPOSE_NAMES = new Map(Object.entries(PURPOSE_CODES).map(([name, code]) => [code, name]))
const MAX_HELLO_BYTES = 2048
const MAX_CAPABILITIES = 16
const MAX_CAPABILITY_BYTES = 128
const MAX_ASSET_BLOCK_BYTES = 256 * 1024
const MAX_ASSET_PROOF_BYTES = 32 * 1024
const MAX_ARCHIVE_CHALLENGE_PROOF_BYTES = 320 * 1024
const MAX_CATALOG_PAGE_RECORDS = 64
const MAX_CATALOG_SESSION_PAGES = 128
const MAX_CATALOG_SESSION_RECORDS = 4096
const MAX_CATALOG_SESSION_BYTES = 4 * 1024 * 1024
const MAX_CATALOG_HEAD_DISTANCE = 4096
const MAX_CATALOG_VERIFICATION_WORK = 8192
const DEFAULT_CATALOG_BUDGET_WINDOW_MS = 60_000
const CATALOG_PAGE_TIMEOUT_MS = 10_000
const ASSET_CHUNK_BYTES = 48 * 1024
const ASSET_TRANSFER_TIMEOUT_MS = 10_000
// A rate-limited send waits for tokens rather than answering "unavailable":
// refusing marks the peer as failed for that block until the next policy
// change, which would turn a momentary throttle into permanent unavailability.
// The wait must stay well inside the requester's ASSET_TRANSFER_TIMEOUT_MS, so
// anything that cannot be served within this budget is refused instead.
const MAX_OUTBOUND_RATE_DEFER_MS = 4_000
const MAX_OUTBOUND_RATE_DEFERRALS = 4
const ARCHIVE_CHALLENGE_PROOF_CHUNK_BYTES = 48 * 1024
const MAX_ARCHIVE_CHALLENGE_TRANSFERS = 16
const ARCHIVE_CHALLENGE_TRANSFER_TIMEOUT_MS = 10_000
const ASSET_TRANSFER_TYPES = new Set([
  'asset-block-request',
  'asset-block-proof',
  'asset-block-chunk',
  'asset-block-unavailable',
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

function normalizeCapabilities (values) {
  if (!Array.isArray(values) || values.length > MAX_CAPABILITIES) fail('capabilities exceed bounded limit')
  const result = []
  for (const value of values) {
    const capability = String(value || '')
    const encoded = b4a.from(capability)
    if (!capability || encoded.byteLength > MAX_CAPABILITY_BYTES) fail('capability exceeds bounded limit')
    if (result.includes(capability)) fail('capabilities must be distinct')
    result.push(capability)
  }
  return result.sort()
}

export function encodeScopedHello (input = {}) {
  const purposeCode = PURPOSE_CODES[input.purpose]
  if (!purposeCode) fail('unknown purpose')
  const topic = exactBuffer(input.topic, 32, 'topic')
  const protocolMajor = Number(input.protocolMajor ?? PROTOCOL_MAJOR)
  const maxFrameBytes = Number(input.maxFrameBytes ?? MAX_PEER_FRAME_BYTES)
  if (!Number.isSafeInteger(protocolMajor) || protocolMajor < 1 || protocolMajor > 255) fail('invalid protocol major')
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 32 || maxFrameBytes > MAX_PEER_FRAME_BYTES) fail('invalid frame limit')
  const capabilities = normalizeCapabilities(input.capabilities || [])
  let length = 40
  for (const capability of capabilities) length += 1 + b4a.byteLength(capability)
  if (length > MAX_HELLO_BYTES) fail('hello exceeds bounded limit')
  const output = b4a.alloc(length)
  let offset = 0
  output.writeUInt8(1, offset++)
  output.writeUInt8(protocolMajor, offset++)
  output.writeUInt8(purposeCode, offset++)
  output.writeUInt8(capabilities.length, offset++)
  output.writeUInt32BE(maxFrameBytes, offset); offset += 4
  b4a.copy(topic, output, offset); offset += 32
  for (const capability of capabilities) {
    const encoded = b4a.from(capability)
    output.writeUInt8(encoded.byteLength, offset++)
    b4a.copy(encoded, output, offset); offset += encoded.byteLength
  }
  return output
}

export function decodeScopedHello (input) {
  const buffer = b4a.from(input || [])
  if (buffer.byteLength < 40 || buffer.byteLength > MAX_HELLO_BYTES) fail('invalid bounded hello')
  let offset = 0
  if (buffer.readUInt8(offset++) !== 1) fail('unsupported hello version')
  const protocolMajor = buffer.readUInt8(offset++)
  const purpose = PURPOSE_NAMES.get(buffer.readUInt8(offset++))
  if (!purpose) fail('unknown purpose')
  const count = buffer.readUInt8(offset++)
  if (count > MAX_CAPABILITIES) fail('capabilities exceed bounded limit')
  const maxFrameBytes = buffer.readUInt32BE(offset); offset += 4
  if (maxFrameBytes < 32 || maxFrameBytes > MAX_PEER_FRAME_BYTES) fail('invalid frame limit')
  const topic = b4a.from(buffer.subarray(offset, offset + 32)); offset += 32
  const capabilities = []
  for (let index = 0; index < count; index++) {
    if (offset >= buffer.byteLength) fail('truncated hello')
    const length = buffer.readUInt8(offset++)
    if (!length || length > MAX_CAPABILITY_BYTES || offset + length > buffer.byteLength) fail('truncated capability')
    const capability = b4a.toString(buffer.subarray(offset, offset + length)); offset += length
    if (!b4a.equals(b4a.from(capability), buffer.subarray(offset - length, offset))) fail('noncanonical capability')
    capabilities.push(capability)
  }
  if (offset !== buffer.byteLength) fail('trailing hello bytes')
  return { protocolMajor, purpose, topic, maxFrameBytes, capabilities: normalizeCapabilities(capabilities) }
}


export function createScopedProtocolSession (options = {}) {
  const purpose = String(options.purpose || '')
  const topic = exactBuffer(options.topic, 32, 'topic')
  const protocolMajor = Number(options.protocolMajor ?? PROTOCOL_MAJOR)
  const requiredCapability = String(options.requiredCapability || '')
  const peerId = String(options.peerId || 'unknown')
  const admission = options.admission?.reserve ? options.admission : createNetworkAdmission(options.admission)
  const localMaxFrameBytes = Number(options.maxFrameBytes || MAX_PEER_FRAME_BYTES)
  let state = 'noise-authenticated'
  let negotiatedMaxFrameBytes = null
  let lastRequestId = 0
  let activated = false
  let closed = false

  return {
    get state () { return state },
    get maxFrameBytes () { return negotiatedMaxFrameBytes || localMaxFrameBytes },
    async acceptHello (encoded) {
      if (closed) fail('session is closed')
      const bytes = encoded?.byteLength ?? 0
      if (bytes < 40 || bytes > MAX_HELLO_BYTES) fail('invalid bounded hello')
      const reservation = admission.reserve({ peerId, bytes, verify: true })
      if (!reservation.accepted) fail(reservation.reason, 'SCOPED_NETWORK_ADMISSION_REJECTED')
      try {
        const hello = decodeScopedHello(encoded)
        if (hello.purpose !== purpose) fail('purpose mismatch')
        if (!b4a.equals(hello.topic, topic)) fail('topic mismatch')
        if (hello.protocolMajor !== protocolMajor) fail('major mismatch')
        if (!hello.capabilities.includes(requiredCapability)) fail('required capability missing')
        negotiatedMaxFrameBytes = Math.min(localMaxFrameBytes, hello.maxFrameBytes)
        state = 'active'
        if (!activated) {
          activated = true
          await options.onActivate?.({ peerId, purpose, topic, capabilities: hello.capabilities, maxFrameBytes: negotiatedMaxFrameBytes })
        }
        return { purpose, topic: b4a.from(topic), protocolMajor, maxFrameBytes: negotiatedMaxFrameBytes }
      } finally {
        reservation.release('complete')
      }
    },
    async receive (encoded) {
      if (state !== 'active') fail('handshake required')
      const bytes = encoded?.byteLength ?? 0
      if (bytes > negotiatedMaxFrameBytes) fail('frame exceeds negotiated maximum')
      const frame = decodePeerFrame(b4a.from(encoded), { typeCodes: FRAME_TYPES })
      if (frame.purpose !== purpose) fail('purpose mismatch')
      if (frame.protocolMajor !== protocolMajor) fail('major mismatch')
      if (!Number.isSafeInteger(frame.requestId) || frame.requestId <= lastRequestId) fail('replay rejected')
      lastRequestId = frame.requestId
      const admissionExempt = options.isAdmissionExempt?.(frame) === true
      const reservation = admissionExempt ? null : admission.reserve({ peerId, bytes, verify: purpose === 'bootstrap' })
      if (reservation && !reservation.accepted) fail(reservation.reason, 'SCOPED_NETWORK_ADMISSION_REJECTED')
      try {
        return await options.onFrame?.(frame, { peerId, purpose, topic })
      } finally {
        reservation?.release('complete')
      }
    },
    close (reason = 'closed') {
      if (closed) return false
      closed = true
      state = 'closed'
      admission.disconnect(peerId)
      options.onClose?.(reason)
      return true
    },
  }
}

function capabilityForPurpose (purpose) {
  switch (purpose) {
    case 'bootstrap': return BOOTSTRAP_LOCATOR_CAPABILITY
    case 'publisher': return PUBLISHER_CATALOG_CAPABILITY
    case 'asset': return ASSET_RENDITION_CAPABILITY
    case 'archive': return ARCHIVE_RANGE_CAPABILITY
    case 'archive-discovery': return ARCHIVE_DISCOVERY_CAPABILITY
    case 'index': return INDEX_FEED_CAPABILITY
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

function renditionCoreKey (rendition) {
  return rendition?.core?.key || rendition?.coreKey || null
}

function stableScopeDiagnostic (scope) {
  return {
    purpose: scope.purpose,
    topicHex: scope.topicHex,
    scopeId: scope.scopeId,
    modes: [...scope.modes].sort(),
    sessions: scope.sessions.size,
    range: scope.range ? { ...scope.range } : null,
    coreKey: scope.coreKey || null,
    publisherId: scope.publisherId || null,
  }
}

export function createScopedNetworkRuntime (options = {}) {
  if (!options.swarm || typeof options.swarm.join !== 'function') fail('swarm is required')
  const swarm = options.swarm
  const store = options.store
  const catalogRegistry = options.catalogRegistry || null
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
  const networkId = String(options.networkId || 'peartube-main')
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
  const activeConnections = new Map()
  const connectionIds = new WeakMap()
  let nextConnectionId = 1
  const pairedConnections = new WeakSet()
  const counters = { acceptedFrames: 0, rejectedFrames: 0, outboundFrames: 0, inboundAssetFrames: 0, openedCatalogs: 0, openedCores: 0, closedSessions: 0, joinedTopics: 0, leftTopics: 0 }
  const recentErrors = []
  let status = 'idle'
  let nextRequestId = 1
  let listening = false
  const hasInitialNetworkPolicy = options.initialNetworkPolicy != null
  const initialNetworkPolicy = options.initialNetworkPolicy || {}
  let networkEnabled = hasInitialNetworkPolicy ? initialNetworkPolicy.networkEnabled !== false : true
  let uploadPermission = hasInitialNetworkPolicy
    ? String(initialNetworkPolicy.uploadPermission || 'disabled')
    : 'enabled'
  let uploadCeilingBytes = hasInitialNetworkPolicy
    ? Number(initialNetworkPolicy.uploadCeilingBytes || 0)
    : Number.MAX_SAFE_INTEGER
  let diskCeilingBytes = hasInitialNetworkPolicy
    ? Number(initialNetworkPolicy.diskCeilingBytes || 0)
    : Number.MAX_SAFE_INTEGER
  let uploadAllowed = hasInitialNetworkPolicy
    ? (initialNetworkPolicy.uploadAllowed ?? (
        networkEnabled && uploadPermission === 'enabled' && uploadCeilingBytes > 0
      ))
    : true
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

  async function reservePolicyUpload (bytes) {
    const amount = Number(bytes)
    if (!uploadAllowed || !networkEnabled || !Number.isSafeInteger(amount) || amount < 0 ||
        uploadedBytes + amount > uploadCeilingBytes) return null
    // Charge the cumulative total before waiting on the rate, so a deferred
    // send cannot be overtaken into breaching the ceiling while it waits.
    uploadedBytes += amount
    if (!await acquireOutboundRate(amount)) {
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
        uploadedBytes -= amount
        // Nothing left the device, so the rate was never actually spent.
        if (outboundBytesPerSecond !== null) {
          outboundTokens = Math.min(outboundCapacity(), outboundTokens + amount)
        }
      },
    }
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
    if (!networkEnabled || scope.closed) return null
    if (scope.discovery) {
      if (scope.discoverySuspended) {
        scope.discoverySuspended = false
        void Promise.resolve(scope.discovery.resume?.()).catch(() => {})
      }
      return scope.discovery
    }
    const discovery = swarm.join(scope.topic, { server: true, client: true })
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
      return
    }
    await cleanupResource(scope.discovery, ['destroy', 'close'])
    scope.discovery = null
    scope.discoverySuspended = false
  }

  function joinScope ({ purpose, topic, scopeId, mode, ...metadata }) {
    const topicBuffer = exactBuffer(topic, 32, 'topic')
    const id = `${purpose}:${topicHex(topicBuffer)}`
    let scope = scopes.get(id)
    if (scope) {
      scope.modes.add(mode)
      return { scope, created: false }
    }
    scope = {
      id,
      purpose,
      topic: topicBuffer,
      topicHex: topicHex(topicBuffer),
      scopeId: String(scopeId),
      modes: new Set([mode]),
      sessions: new Map(),
      discovery: null,
      discoverySuspended: false,
      closed: false,
      ...metadata,
    }
    scopes.set(id, scope)
    counters.joinedTopics++
    ensureScopeDiscovery(scope)
    if (networkEnabled) {
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

  function closeSession (scope, peerId, reason) {
    const session = scope.sessions.get(peerId)
    if (!session || session.closed) return false
    session.closed = true
    for (const cleanup of session.cleanupFns.splice(0)) {
      try { cleanup() } catch {}
    }
    session.protocol.close(reason)
    try { session.channel?.close?.() } catch {}
    scope.sessions.delete(peerId)
    counters.closedSessions++
    return true
  }

  function assetRangeContains (scope, index) {
    return Number.isSafeInteger(index) &&
      index >= scope.range.start &&
      index < scope.range.end
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
    if (tracked.catalogServePages > 0 && request.previousPageDigest !== tracked.catalogServeDigest) fail('catalog page linkage mismatch')
    if (tracked.catalogServePages === 0 && request.previousPageDigest !== null) fail('first catalog page in a session must reset linkage')
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

  function queueAssetRetry (scope, tracked, index) {
    if (!assetRangeContains(scope, index)) return
    scope.assetPending.delete(index)
    const failures = scope.assetFailures.get(index) || new Set()
    failures.add(tracked.peerId)
    scope.assetFailures.set(index, failures)
    scope.assetRetries.add(index)
    tracked.assetRequestIndex = null
    tracked.assetTransfer = null
    clearAssetTimer(tracked)
  }

  async function nextAssetIndex (scope, tracked) {
    for (const index of scope.assetRetries) {
      if (scope.assetPending.has(index)) continue
      if (scope.assetFailures.get(index)?.has(tracked.peerId)) continue
      scope.assetRetries.delete(index)
      return index
    }
    while (scope.assetNextIndex < scope.range.end) {
      const index = scope.assetNextIndex++
      if (scope.assetPending.has(index)) continue
      if (await scope.core.has?.(index)) continue
      return index
    }
    return null
  }

  async function pumpAssetSession (scope, tracked) {
    if (!networkEnabled || scope.closed || tracked.closed || tracked.state !== 'active' || tracked.assetRequestIndex !== null) return
    const index = await nextAssetIndex(scope, tracked)
    if (index === null || scope.closed || tracked.closed) return
    tracked.assetRequestIndex = index
    scope.assetPending.add(index)
    if (!sendScopedFrame(tracked, 'asset', 'asset-block-request', encodeAssetIndex(index))) {
      queueAssetRetry(scope, tracked, index)
      return
    }
    tracked.assetTimer = setTimeout(() => {
      queueAssetRetry(scope, tracked, index)
      void pumpAssetSessions(scope)
    }, ASSET_TRANSFER_TIMEOUT_MS)
  }

  function startAssetPumpWhenOpen (scope, tracked) {
    const opened = tracked.channel?.fullyOpened?.()
    void Promise.resolve(opened === undefined ? true : opened).then(ready => {
      if (ready !== false) return pumpAssetSession(scope, tracked)
    }).catch(() => closeSession(scope, tracked.peerId, 'asset-channel-open-failed'))
  }

  async function pumpAssetSessions (scope) {
    if (!scope || scope.closed || scope.purpose !== 'asset') return
    await Promise.all([...scope.sessions.values()].map(tracked => pumpAssetSession(scope, tracked)))
  }

  // A peer that opened a core from its key alone has no manifest, so it cannot
  // check the signature over the tree and rejects every proof as unsigned. The
  // manifest is self-authenticating - the core key is its hash - so it rides
  // along with the proof, exactly as hypercore's own replicator sends it.
  async function authorizedBlockProof (core, index) {
    const proof = await core.proof({
      block: { index, nodes: 0 },
      upgrade: { start: 0, length: core.length },
    })
    if (proof && !proof.manifest && core.manifest) proof.manifest = core.manifest
    return proof
  }

  function encodeAssetProof (index, proof, value) {
    const metadata = {
      index,
      byteLength: value.byteLength,
      proof: {
        ...proof,
        block: { ...proof.block, value: null },
      },
    }
    const payload = c.encode(c.any, metadata)
    if (payload.byteLength > MAX_ASSET_PROOF_BYTES) fail('asset proof exceeds bounded limit')
    return payload
  }

  function decodeAssetProof (payload, expectedIndex) {
    if (!b4a.isBuffer(payload) || payload.byteLength > MAX_ASSET_PROOF_BYTES) fail('asset proof exceeds bounded limit')
    const metadata = c.decode(c.any, payload)
    if (!metadata || typeof metadata !== 'object' ||
        !Number.isSafeInteger(metadata.index) || metadata.index !== expectedIndex ||
        !Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 0 || metadata.byteLength > MAX_ASSET_BLOCK_BYTES ||
        !metadata.proof || typeof metadata.proof !== 'object' ||
        !metadata.proof.block || metadata.proof.block.index !== expectedIndex ||
        metadata.proof.block.value !== null) {
      fail('asset proof metadata is invalid')
    }
    return metadata
  }

  function encodeAssetChunk (index, offset, value) {
    const payload = b4a.allocUnsafe(8 + value.byteLength)
    payload.writeUInt32BE(index, 0)
    payload.writeUInt32BE(offset, 4)
    b4a.copy(value, payload, 8)
    return payload
  }

  function decodeAssetChunk (payload) {
    if (!b4a.isBuffer(payload) || payload.byteLength < 8 || payload.byteLength > 8 + ASSET_CHUNK_BYTES) fail('asset block chunk is invalid')
    return {
      index: payload.readUInt32BE(0),
      offset: payload.readUInt32BE(4),
      value: payload.subarray(8),
    }
  }

  async function sendAssetBlock (scope, tracked, index) {
    if (tracked.assetServing || index <= tracked.assetLastServed || !assetRangeContains(scope, index)) {
      fail('asset block request is outside the authorized monotonic range')
    }
    tracked.assetServing = true
    const policyEpoch = networkPolicyEpoch
    try {
      if (!uploadAllowed || !networkEnabled || !await scope.core.has?.(index)) {
        sendScopedFrame(tracked, 'asset', 'asset-block-unavailable', encodeAssetIndex(index))
        return
      }
      const proof = await authorizedBlockProof(scope.core, index)
      const value = b4a.from(proof?.block?.value || [])
      const reservation = policyEpoch === networkPolicyEpoch
        ? await reservePolicyUpload(value.byteLength)
        : null
      // The reservation may have waited on the outbound rate, so the policy is
      // rechecked after it resolves rather than only before.
      if (!reservation || policyEpoch !== networkPolicyEpoch ||
          proof?.block?.index !== index || value.byteLength > MAX_ASSET_BLOCK_BYTES) {
        reservation?.release()
        sendScopedFrame(tracked, 'asset', 'asset-block-unavailable', encodeAssetIndex(index))
        return
      }
      const canBatch = typeof tracked.channel?.cork === 'function' && typeof tracked.channel?.uncork === 'function'
      if (canBatch) tracked.channel.cork()
      let sent = false
      try {
        sent = sendScopedFrame(tracked, 'asset', 'asset-block-proof', encodeAssetProof(index, proof, value))
        for (let offset = 0; sent && offset < value.byteLength; offset += ASSET_CHUNK_BYTES) {
          const chunk = value.subarray(offset, Math.min(value.byteLength, offset + ASSET_CHUNK_BYTES))
          sent = sendScopedFrame(tracked, 'asset', 'asset-block-chunk', encodeAssetChunk(index, offset, chunk))
        }
        if (sent) {
          tracked.assetLastServed = index
          reservation.commit()
        }
      } finally {
        reservation.release()
        if (canBatch) tracked.channel.uncork()
      }
    } finally {
      tracked.assetServing = false
    }
  }

  async function acceptAssetProof (scope, tracked, frame) {
    const expectedIndex = tracked.assetRequestIndex
    if (!assetRangeContains(scope, expectedIndex) || tracked.assetTransfer) fail('unexpected asset proof')
    const metadata = decodeAssetProof(frame.payload, expectedIndex)
    tracked.assetTransfer = {
      proof: metadata.proof,
      value: b4a.allocUnsafe(metadata.byteLength),
      nextOffset: 0,
    }
    if (metadata.byteLength === 0) await finishAssetTransfer(scope, tracked)
  }

  async function acceptAssetChunk (scope, tracked, frame) {
    const transfer = tracked.assetTransfer
    const expectedIndex = tracked.assetRequestIndex
    if (!transfer || !assetRangeContains(scope, expectedIndex)) fail('unexpected asset block chunk')
    const chunk = decodeAssetChunk(frame.payload)
    if (chunk.index !== expectedIndex || chunk.offset !== transfer.nextOffset ||
        chunk.value.byteLength === 0 || chunk.offset + chunk.value.byteLength > transfer.value.byteLength) {
      fail('asset block chunk is out of sequence')
    }
    b4a.copy(chunk.value, transfer.value, chunk.offset)
    transfer.nextOffset += chunk.value.byteLength
    if (transfer.nextOffset === transfer.value.byteLength) await finishAssetTransfer(scope, tracked)
  }

  async function finishAssetTransfer (scope, tracked) {
    const index = tracked.assetRequestIndex
    const transfer = tracked.assetTransfer
    if (!transfer || transfer.nextOffset !== transfer.value.byteLength) fail('asset block transfer is incomplete')
    transfer.proof.block.value = transfer.value
    await scope.core.applyProof(transfer.proof)
    scope.assetPending.delete(index)
    scope.assetRetries.delete(index)
    scope.assetFailures.delete(index)
    tracked.assetRequestIndex = null
    tracked.assetTransfer = null
    clearAssetTimer(tracked)
    await pumpAssetSession(scope, tracked)
  }

  async function handleAssetFrame (scope, tracked, frame) {
    counters.inboundAssetFrames++
    if (!tracked || tracked.closed || tracked.state !== 'active') fail('asset session is not active')
    switch (frame.type) {
      case 'probe':
        return { status: 'ok' }
      case 'asset-block-request':
        await sendAssetBlock(scope, tracked, decodeAssetIndex(frame.payload))
        return { status: 'sent' }
      case 'asset-block-proof':
        await acceptAssetProof(scope, tracked, frame)
        return { status: 'accepted' }
      case 'asset-block-chunk':
        await acceptAssetChunk(scope, tracked, frame)
        return { status: 'accepted' }
      case 'asset-block-unavailable': {
        const index = decodeAssetIndex(frame.payload)
        if (index !== tracked.assetRequestIndex) fail('unexpected unavailable asset block')
        queueAssetRetry(scope, tracked, index)
        await pumpAssetSessions(scope)
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
    if (!request || !archiveResourceFor(scope, request.coreKey, request.index)) return
    const key = archiveBlockKey(request.coreKey, request.index)
    scope.archivePending.delete(key)
    const failures = scope.archiveFailures.get(key) || new Set()
    failures.add(tracked.peerId)
    scope.archiveFailures.set(key, failures)
    scope.archiveRetries.set(key, request)
    tracked.archiveRequest = null
    tracked.archiveTransfer = null
    clearArchiveTimer(tracked)
  }

  async function nextArchiveBlock (scope, tracked) {
    for (const [key, request] of scope.archiveRetries) {
      if (scope.archivePending.has(key)) continue
      if (scope.archiveFailures.get(key)?.has(tracked.peerId)) continue
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
    if (!networkEnabled || scope.archiveDiscovery || scope.closed || tracked.closed || tracked.state !== 'active' || tracked.archiveRequest) return
    const request = await nextArchiveBlock(scope, tracked)
    if (!request || scope.closed || tracked.closed) return
    tracked.archiveRequest = request
    scope.archivePending.add(archiveBlockKey(request.coreKey, request.index))
    if (!sendScopedFrame(tracked, 'archive', 'archive-block-request', encodeArchiveBlockRef(request.coreKey, request.index))) {
      queueArchiveRetry(scope, tracked, request)
      return
    }
    tracked.archiveTimer = setTimeout(() => {
      queueArchiveRetry(scope, tracked, request)
      void pumpArchiveSessions(scope)
    }, ASSET_TRANSFER_TIMEOUT_MS)
  }

  function startArchivePumpWhenOpen (scope, tracked) {
    const opened = tracked.channel?.fullyOpened?.()
    void Promise.resolve(opened === undefined ? true : opened).then(ready => {
      if (ready !== false) return pumpArchiveSession(scope, tracked)
    }).catch(() => closeSession(scope, tracked.peerId, 'archive-channel-open-failed'))
  }

  async function pumpArchiveSessions (scope) {
    if (!scope || scope.closed || scope.purpose !== 'archive') return
    await Promise.all([...scope.sessions.values()].map(tracked => pumpArchiveSession(scope, tracked)))
  }

  async function sendArchiveBlock (scope, tracked, request) {
    const resource = archiveResourceFor(scope, request.coreKey, request.index)
    const lastServed = tracked.archiveLastServed.get(resource?.resourceId) ?? -1
    if (tracked.archiveServing || !resource || request.index <= lastServed) {
      fail('archive block request is outside the authorized monotonic range')
    }
    tracked.archiveServing = true
    const policyEpoch = networkPolicyEpoch
    try {
      if (!uploadAllowed || !networkEnabled || !await resource.core.has?.(request.index)) {
        sendScopedFrame(tracked, 'archive', 'archive-block-unavailable', encodeArchiveBlockRef(request.coreKey, request.index))
        return
      }
      const proof = await authorizedBlockProof(resource.core, request.index)
      const value = b4a.from(proof?.block?.value || [])
      const ceiling = scope.archiveUploadCeilingBytes
      const reservation = policyEpoch === networkPolicyEpoch
        ? await reservePolicyUpload(value.byteLength)
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
    if (!resource || !transfer || transfer.nextOffset !== transfer.value.byteLength) fail('archive block transfer is incomplete')
    transfer.proof.block.value = transfer.value
    await resource.core.applyProof(transfer.proof)
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
        if (!request || tracked.archiveTransfer || !archiveResourceFor(scope, request.coreKey, request.index)) fail('unexpected archive proof')
        const metadata = decodeArchiveProof(frame.payload, request)
        tracked.archiveTransfer = { proof: metadata.proof, value: b4a.allocUnsafe(metadata.byteLength), nextOffset: 0 }
        if (metadata.byteLength === 0) await finishArchiveTransfer(scope, tracked)
        return { status: 'accepted' }
      }
      case 'archive-block-chunk': {
        const request = tracked.archiveRequest
        const transfer = tracked.archiveTransfer
        if (!request || !transfer || !archiveResourceFor(scope, request.coreKey, request.index)) fail('unexpected archive block chunk')
        const chunk = decodeAssetChunk(frame.payload)
        if (chunk.index !== request.index || chunk.offset !== transfer.nextOffset ||
            chunk.value.byteLength === 0 || chunk.offset + chunk.value.byteLength > transfer.value.byteLength) {
          fail('archive block chunk is out of sequence')
        }
        b4a.copy(chunk.value, transfer.value, chunk.offset)
        transfer.nextOffset += chunk.value.byteLength
        if (transfer.nextOffset === transfer.value.byteLength) await finishArchiveTransfer(scope, tracked)
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
    for (const transfer of scope.archiveChallengeProofTransfers?.values() || []) clearTimeout(transfer.timer)
    scope.archiveChallengeProofTransfers?.clear()
    for (const peerId of [...scope.sessions.keys()]) closeSession(scope, peerId, 'scope-released')
    for (const resource of scope.archiveResources?.values() || []) {
      try { resource.releaseArchiveProtection?.() } catch {}
      resource.releaseArchiveProtection = null
    }
    const resources = scope.archiveResources
      ? [...scope.archiveResources.values()].flatMap(resource => [
          [resource.download, ['destroy', 'close']],
          [resource.core, ['close']],
        ])
      : [
          [scope.download, ['destroy', 'close']],
          [scope.core, ['close']],
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
    if (scope.purpose === 'bootstrap') return { status: 'authorized', action: 'metadata-only' }
    if (scope.purpose === 'publisher') {
      if (scope.modes.has('candidate') && !scope.modes.has('followed') && !scope.modes.has('local')) {
        return { status: 'authorized', action: 'namespace-proof', publisherId: scope.publisherId }
      }
      if (!scope.binding?.catalog || (!scope.modes.has('followed') && !scope.modes.has('local'))) return { status: 'rejected', reason: 'publisher-not-followed' }
      if (connection) counters.openedCatalogs++
      return { status: 'authorized', action: 'catalog-pages', publisherId: scope.publisherId }
    }
    if (scope.purpose === 'index' || scope.purpose === 'moderation') {
      return { status: 'authorized', action: 'bounded-feed', feedId: scope.feedId }
    }
    if (scope.purpose === 'asset') {
      if (!scope.core || !scope.coreKey) return { status: 'rejected', reason: 'core-not-authorized' }
      if (requestedCoreKey && hex32(requestedCoreKey, 'requestedCoreKey') !== scope.coreKey) return { status: 'rejected', reason: 'core-not-authorized' }
      return { status: 'authorized', action: 'retained-range', coreKey: scope.coreKey, range: { ...scope.range } }
    }
    if (scope.purpose === 'archive-discovery') return { status: 'authorized', action: 'archive-discovery' }
    if (scope.purpose === 'archive') {
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
    if (!networkEnabled || scope.closed) return
    const remoteKey = connectionKey(connection, info)
    if (scope.sessions.has(remoteKey)) return scope.sessions.get(remoteKey)
    const mux = muxFactory(connection)
    if (!mux || typeof mux.createChannel !== 'function') return
    const protocolSession = createScopedProtocolSession({
      peerId: remoteKey,
      purpose: scope.purpose,
      topic: scope.topic,
      protocolMajor,
      requiredCapability: capabilityForPurpose(scope.purpose),
      admission,
      isAdmissionExempt: frame =>
        (scope.purpose === 'asset' && ASSET_TRANSFER_TYPES.has(frame.type)) ||
        (scope.purpose === 'archive' && ARCHIVE_TRANSFER_TYPES.has(frame.type)),
      onActivate: async () => {
        let tracked = scope.sessions.get(remoteKey)
        if (scope.purpose === 'asset') {
          const range = scope.range || { start: 0, end: null }
          const current = await authorizePublication({
            manifest: scope.manifest,
            renditionId: scope.renditionId,
            start: range.start,
            end: range.end,
          })
          if (!current) fail('publication manifest authorization failed')
          // The scope decides whether this peer may have the core at all; the
          // core itself moves and verifies its own blocks. Hand-rolling that
          // transfer meant hand-rolling proofs, and every one of them was
          // refused on arrival as an invalid signature.
          replicateAuthorizedCore(scope, connection, mux)
          tracked = scope.sessions.get(remoteKey)
        }
        const result = authorizeScopeConnection(scope, { peerId: remoteKey, connection, tracked })
        if (result.status !== 'authorized') fail(result.reason)
        if (tracked) {
          tracked.state = 'active'
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
          if (scope.purpose === 'archive' && !scope.archiveDiscovery) startArchivePumpWhenOpen(scope, tracked)
          if (scope.purpose === 'archive-discovery' && scope.archivePeerListeners) { for (const listener of scope.archivePeerListeners) { try { listener({ peerId: remoteKey }) } catch {} } }
        }
      },
      onFrame: frame => {
        if (scope.purpose === 'bootstrap') return handleBootstrapFrame(frame, { peerId: remoteKey })
        if (scope.purpose === 'publisher') return handlePublisherProofFrame(scope, scope.sessions.get(remoteKey), frame)
        if (scope.purpose === 'index' || scope.purpose === 'moderation') return handleFeedFrame(scope, scope.sessions.get(remoteKey), frame)
        if (scope.purpose === 'asset') return handleAssetFrame(scope, scope.sessions.get(remoteKey), frame)
        if (scope.purpose === 'archive') return handleArchiveFrame(scope, scope.sessions.get(remoteKey), frame)
        if (scope.purpose === 'archive-discovery') return handleArchiveFrame(scope, scope.sessions.get(remoteKey), frame)
        return frame.type === 'probe' ? { status: 'ok' } : fail('frame type is not allowed for this purpose')
      },
      onClose: () => {
        const tracked = scope.sessions.get(remoteKey)
        if (tracked?.assetRequestIndex !== null && tracked?.assetRequestIndex !== undefined) {
          queueAssetRetry(scope, tracked, tracked.assetRequestIndex)
        }
        if (tracked?.archiveRequest) {
          queueArchiveRetry(scope, tracked, tracked.archiveRequest)
        } else {
          clearArchiveTimer(tracked)
        }
        if (tracked && !tracked.closed) {
          tracked.closed = true
          for (const cleanup of tracked.cleanupFns.splice(0)) {
            try { cleanup() } catch {}
          }
          scope.sessions.delete(remoteKey)
          if (scope.catalogPagePending) {
            clearTimeout(scope.catalogPagePending.timer)
            scope.catalogPagePending.reject(Object.assign(new Error('publisher catalog peer disconnected'), { code: 'PUBLISHER_CATALOG_PEER_DISCONNECTED' }))
            scope.catalogPagePending = null
          }
          scope.catalogPreviousPageDigest = null
          counters.closedSessions++
          if (scope.purpose === 'archive') void pumpArchiveSessions(scope)
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
        try { channel?.close?.() } catch {}
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
        try { channel?.close?.() } catch {}
      }),
      onclose: () => protocolSession.close('channel-closed'),
    })
    if (!channel) return
    const tracked = {
      peerId: remoteKey,
      connection,
      channel,
      message: channel.messages?.[0] || message,
      protocol: protocolSession,
      state: protocolSession.state === 'active' ? 'active' : 'handshaking',
      closed: false,
      cleanupFns: [],
      assetRequestIndex: null,
      assetTransfer: null,
      assetTimer: null,
      assetServing: false,
      assetLastServed: -1,
      archiveRequest: null,
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
    scope.sessions.set(remoteKey, tracked)
    if (tracked.state === 'active' && scope.purpose === 'asset') startAssetPumpWhenOpen(scope, tracked)
    if (tracked.state === 'active' && scope.purpose === 'archive' && !scope.archiveDiscovery) startArchivePumpWhenOpen(scope, tracked)
    channel.open(encodeScopedHello({
      purpose: scope.purpose,
      topic: scope.topic,
      protocolMajor,
      capabilities: [capabilityForPurpose(scope.purpose)],
      maxFrameBytes: MAX_PEER_FRAME_BYTES,
    }))
    return tracked
  }


  function handleConnection (connection, info = {}) {
    if (!networkEnabled) return
    const firstSeen = !activeConnections.has(connection)
    activeConnections.set(connection, info)
    const mux = muxFactory(connection)
    if (mux && typeof mux.pair === 'function' && !pairedConnections.has(connection)) {
      pairedConnections.add(connection)
      for (const purpose of Object.keys(PURPOSE_CODES)) {
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
          for (const scope of scopes.values()) attachScope(scope, connection, info)
        } finally {
          mux?.uncork?.()
        }
      })
    }
    if (firstSeen) {
      connection?.once?.('close', () => {
        activeConnections.delete(connection)
        const peerId = connectionKey(connection, info)
        for (const scope of scopes.values()) closeSession(scope, peerId, 'connection-closed')
      })
    }
  }

  async function restoreLocalPublisherScopes () {
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
    for (const connection of swarm.connections || []) handleConnection(connection)
    for (const [connection, info] of activeConnections) handleConnection(connection, info)
  }

  async function deactivateNetwork () {
    if (listening) {
      swarm.off?.('connection', handleConnection)
      swarm.removeListener?.('connection', handleConnection)
      listening = false
    }
    for (const scope of scopes.values()) {
      for (const peerId of [...scope.sessions.keys()]) closeSession(scope, peerId, 'network-policy-disabled')
    }
    await Promise.allSettled([...scopes.values()].map(scope => suspendScopeDiscovery(scope)))
  }

  async function restartTransferSessions (closeSessions = false) {
    for (const scope of scopes.values()) {
      scope.assetFailures?.clear()
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
      for (const scope of scopes.values()) attachScope(scope, connection, info)
    }
    await Promise.all([...scopes.values()].flatMap(scope => [
      pumpAssetSessions(scope),
      pumpArchiveSessions(scope),
    ]))
  }

  async function applyNetworkPolicy (policy = {}) {
    const nextUploadPermission = String(policy.uploadPermission || 'disabled')
    const nextUploadCeilingBytes = Number(policy.uploadCeilingBytes ?? 0)
    const nextDiskCeilingBytes = Number(policy.diskCeilingBytes ?? diskCeilingBytes)
    if (!['disabled', 'manual', 'enabled'].includes(nextUploadPermission)) fail('invalid upload permission')
    if (!Number.isSafeInteger(nextUploadCeilingBytes) || nextUploadCeilingBytes < 0) fail('invalid upload ceiling')
    if (!Number.isSafeInteger(nextDiskCeilingBytes) || nextDiskCeilingBytes < 0) fail('invalid disk ceiling')
    // An absent rate leaves the limit exactly where it was: a caller that only
    // moves the disk ceiling must not silently uncap the outbound path.
    const nextOutboundBytesPerSecond = normalizeOutboundRate(policy.outboundBytesPerSecond, outboundBytesPerSecond)

    const wasNetworkEnabled = networkEnabled
    const wasUploadAllowed = uploadAllowed
    networkEnabled = policy.networkEnabled !== false
    uploadPermission = nextUploadPermission
    uploadCeilingBytes = nextUploadCeilingBytes
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
    uploadAllowed = policy.uploadAllowed ?? (
      networkEnabled && uploadPermission === 'enabled' && uploadCeilingBytes > 0
    )
    networkPolicyEpoch++

    if (wasNetworkEnabled && !networkEnabled) await deactivateNetwork()
    else if (!wasNetworkEnabled && networkEnabled) await activateNetwork()
    await restartTransferSessions(wasUploadAllowed && !uploadAllowed)
    return {
      networkEnabled,
      uploadAllowed,
      uploadPermission,
      uploadCeilingBytes,
      uploadedBytes,
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
        if (existing.scope.catalogComplete !== true && live) {
          void syncPublisherCatalog(existing.scope).catch(error => {
            recordProtocolError(existing.scope, 'locator-retry', error)
          })
          return skip('locator unchanged; retrying an unfinished catalog walk')
        }
        return skip(live ? 'locator identical to current scope' : 'locator identical; no live session yet')
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

  async function publishLocalPublisherCatalog ({ publisherId } = {}) {
    if (status !== 'active') fail('runtime is not active')
    const id = hex32(publisherId, 'publisherId')
    const existing = localPublishers.get(id)
    if (existing) return rebindLocalPublisherCatalog({ publisherId: id })
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
    const { scope } = joinScope({ purpose: 'publisher', topic, scopeId: id, mode: 'local', publisherId: id, descriptor, binding })
    scope.publisherId = id
    scope.descriptor = descriptor
    scope.binding = binding
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
    const result = await publishLocalPublisherCatalog({ publisherId: id })
    await leaveScope(existing.scope, 'local')
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
        publisherId: id,
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

  async function retainAuthorizedRendition ({ manifest, renditionId, start = 0, end = null, entityRef = null, publicationId = null } = {}) {
    if (status !== 'active') fail('runtime is not active')
    const consumerVisible = await authorizeConsumerWork({
      operation: 'asset-retain',
      entityRef,
      publicationId: publicationId || manifest?.publicationId || null,
      renditionId,
    })
    if (!consumerVisible) fail('consumer media is not visible under local policy', 'CONSUMER_MEDIA_NOT_VISIBLE')
    const id = String(renditionId || '')
    const rendition = (manifest?.body?.renditions || []).find(candidate => candidate.renditionId === id)
    if (!rendition || rendition.blocked || rendition.superseded) fail('rendition is not manifest-authorized')
    const declaredLength = Number(rendition.core?.length)
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
    const coreKey = hex32(renditionCoreKey(rendition), 'rendition core key')
    const existing = renditions.get(id)
    if (existing) {
      if (existing.scope.coreKey !== coreKey || existing.scope.range.start !== range.start || existing.scope.range.end !== range.end) fail('rendition is already retained with a different authorization')
      return { ...existing.result, status: 'already-retained' }
    }
    if (!store?.get) fail('corestore is unavailable')
    const core = store.get({ key: b4a.from(coreKey, 'hex') })
    try {
      await core.ready?.()
      const download = core.download?.({ start: range.start, end: range.end }) || null
      const topic = deriveAssetTopic({ protocolMajor, renditionId: id })
      const { scope } = joinScope({
        purpose: 'asset',
        topic,
        scopeId: id,
        mode: 'retained',
        renditionId: id,
        coreKey,
        core,
        download,
        range,
        manifest,
        entityRef,
        publicationId: publicationId || manifest?.publicationId || null,
        manifestId: manifest.body.manifestId,
        assetNextIndex: range.start,
        assetPending: new Set(),
        assetRetries: new Set(),
        assetFailures: new Map(),
      })
      const result = { status: 'retained', renditionId: id, coreKey, range: { ...range }, topic: stableScopeDiagnostic(scope) }
      renditions.set(id, { scope, result, manifest })
      // Holding a title means holding what it looks like. Cover art rides the
      // same manifest precisely so a peer that seeds the movie can answer for
      // its poster too; leaving that to each caller means the one seeder that
      // forgets is a title nobody downstream can render.
      await retainPublicationArtwork({ manifest, entityRef, publicationId })
      return result
    } catch (error) {
      try { await core.close?.() } catch {}
      throw error
    }
  }

  async function releaseAuthorizedRendition ({ renditionId } = {}) {
    const id = String(renditionId || '')
    const retained = renditions.get(id)
    renditions.delete(id)
    const released = retained ? await leaveScope(retained.scope, 'retained') : false
    return { status: 'released', renditionId: id, released }
  }
  async function revalidateRetainedRenditions () {
    let released = 0
    for (const [renditionId, retained] of [...renditions]) {
      const range = retained.scope.range || { start: 0, end: null }
      const publicationAuthorized = await authorizePublication({
        manifest: retained.manifest,
        renditionId,
        start: range.start,
        end: range.end
      }).catch(() => false)
      const consumerVisible = publicationAuthorized && await authorizeConsumerWork({
        operation: 'asset-revalidate',
        entityRef: retained.scope.entityRef,
        publicationId: retained.scope.publicationId || retained.manifest?.publicationId || null,
        renditionId,
      }).catch(() => false)
      if (consumerVisible) continue
      await releaseAuthorizedRendition({ renditionId })
      released++
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
    return publishArchiveEnvelope('archive-pledge', envelope || pledge?.envelope || pledge)
  }

  async function publishArchiveChallenge ({ challenge, envelope } = {}) {
    return publishArchiveEnvelope('archive-challenge', envelope || challenge?.envelope || challenge)
  }

  async function publishArchiveChallengeProof ({ envelope, proofBytes } = {}) {
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
      scope.archiveResources.set(resourceId, resource)
      void pumpArchiveSessions(scope)
      const result = { status: 'retained', archiveId, coreKey, range: { ...range }, topic: stableScopeDiagnostic(scope) }
      archives.set(resourceId, { scope, resource, result })
      return result
    } catch (error) {
      try { releaseArchiveProtection?.() } catch {}
      try { await core.close?.() } catch {}
      throw error
    }
  }

  function retainedArchiveResource(archiveId, coreKey, index) {
    const id = hex32(archiveId, 'archiveId')
    const key = hex32(coreKey, 'coreKey')
    if (!Number.isSafeInteger(index) || index < 0) fail('archive challenge index is invalid')
    for (const retained of archives.values()) {
      const resource = retained.resource
      if (resource.archiveId === id && resource.coreKey === key &&
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
      value.scope.archiveResources?.delete(resourceId)
      try { value.resource.releaseArchiveProtection?.() } catch {}
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
      requiredCapability: capabilityForPurpose(purpose),
      admission,
      onFrame: value => purpose === 'bootstrap'
        ? handleBootstrapFrame(value, { peerId })
        : (value.type === 'probe' ? { status: 'ok' } : { status: 'rejected', reason: 'frame-type-not-allowed' }),
    })
    await session.acceptHello(encodeScopedHello({ purpose, topic: scope.topic, protocolMajor, capabilities: [capabilityForPurpose(purpose)] }))
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
        assetRequestIndex: session.assetRequestIndex,
        assetTransferBytes: session.assetTransfer?.nextOffset || 0,
      })
    }
    sessions.sort((left, right) => left.peerId.localeCompare(right.peerId) || left.topicHex.localeCompare(right.topicHex))
    return {
      status,
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

  async function close () {
    if (status === 'closed') return
    status = 'closed'
    if (listening) {
      swarm.off?.('connection', handleConnection)
      swarm.removeListener?.('connection', handleConnection)
      listening = false
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
    const closing = []
    for (const scope of [...scopes.values()]) {
      scope.modes.clear()
      closing.push(leaveScope(scope))
    }
    await Promise.allSettled(closing)
    activeConnections.clear()
  }

  return {
    start,
    applyNetworkPolicy,
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
