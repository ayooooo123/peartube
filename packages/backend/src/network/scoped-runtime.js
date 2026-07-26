import b4a from 'b4a'
import c from 'compact-encoding'
import Protomux from 'protomux'

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
} from '../discovery/bootstrap-protocol.js'
import { createBootstrapManager } from '../discovery/bootstrap-manager.js'
import { createPublisherManager } from '../discovery/publisher-manager.js'
import { INDEX_FEED_CAPABILITY } from '../indexing/feed-contract.js'
import { createIndexFeedManager } from '../indexing/feed-manager.js'
import { createModerationManager } from '../moderation/manager.js'
import {
  decodeApplicationEnvelope,
  encodeApplicationEnvelope,
} from '../records/application-envelope.js'
import {
  PUBLISHER_CATALOG_CAPABILITY,
  decodePublisherNamespaceDescriptor,
  verifyPublisherNamespaceDescriptor,
} from '../publisher/namespace.js'
import { verifyPublisherNamespaceProof } from '../publisher/namespace-proof.js'
import { verifyArchivePledge } from '../archive/pledge.js'


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
const ASSET_CHUNK_BYTES = 48 * 1024
const ASSET_TRANSFER_TIMEOUT_MS = 10_000
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

function protocolForPurpose (purpose, major) {
  return `${SCOPED_NETWORK_PROTOCOL}/${major}/${purpose}`
}


function catalogReplicationCores (binding) {
  const catalog = binding?.catalog
  const base = catalog?.base
  if (!base) fail('publisher catalog does not expose a bounded replication set')
  const expectedBootstrapKey = exactBuffer(binding.catalogBootstrapKey, 32, 'catalogBootstrapKey')
  if (!base.key || !b4a.equals(base.key, expectedBootstrapKey)) fail('catalog bootstrap binding mismatch')
  const candidates = [
    base._primaryBootstrap,
    base.local,
    base.core,
    base.view?.core,
    catalog.view?.core,
  ]
  for (const writer of base.activeWriters || []) candidates.push(writer?.core)
  for (const writer of base._bootstrapWriters || []) candidates.push(writer?.core)
  const cores = new Map()
  for (const core of candidates) {
    if (!core?.key || typeof core.replicate !== 'function') continue
    const key = hex32(core.key, 'catalog core key')
    cores.set(key, core)
  }
  if (!cores.has(b4a.toString(expectedBootstrapKey, 'hex'))) fail('catalog bootstrap core is not open')
  if (cores.size > 256) fail('catalog replication set exceeds bounded limit')
  return cores
}

function normalizeNamespace (value, protocolMajor, { verifiedTransitionChain = false } = {}) {
  const descriptor = b4a.isBuffer(value) || value instanceof Uint8Array
    ? decodePublisherNamespaceDescriptor(b4a.from(value), { protocolMajor, supportedCapabilities: [PUBLISHER_CATALOG_CAPABILITY] })
    : value
  verifyPublisherNamespaceDescriptor(descriptor, {
    protocolMajor,
    supportedCapabilities: [PUBLISHER_CATALOG_CAPABILITY],
    genesisRootKey: descriptor?.catalogEpoch === 0 ? descriptor.publisherRootKey : undefined,
  })
  if (descriptor.catalogEpoch !== 0 && !verifiedTransitionChain) fail('rotated namespace requires a verified committed transition')
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
  const onCatalogUpdate = typeof options.onCatalogUpdate === 'function'
    ? options.onCatalogUpdate
    : null
  const protocolMajor = Number(options.protocolMajor ?? PROTOCOL_MAJOR)
  if (protocolMajor !== PROTOCOL_MAJOR) fail('unsupported protocol major')
  const networkId = String(options.networkId || 'peartube-main')
  const bootstrapEnabled = options.bootstrapEnabled !== false
  const admission = options.admission?.reserve ? options.admission : createNetworkAdmission(options.admission)
  const bootstrapManager = options.bootstrapManager || createBootstrapManager({
    now: options.now,
    trustedSigners: options.trustedBootstrapSigners || [],
    trustedRootIds: options.trustedBootstrapRootIds || [],
    protocolMajor,
    supportedCapabilities: [BOOTSTRAP_LOCATOR_CAPABILITY],
    verifyCatalogChain: options.verifyCatalogChain,
  })
  const indexFeedManager = options.indexFeedManager || createIndexFeedManager({ now: options.now })
  const moderationManager = options.moderationManager || createModerationManager({ now: options.now })
  const indexFeedProviders = new Map()
  const moderationFeedProviders = new Map()
  const publisherProofProviders = new Map()
  const bootstrapFollowAttempts = new Map()
  const publisherManager = options.publisherManager || createPublisherManager({
    supportedCapabilities: [PUBLISHER_CATALOG_CAPABILITY],
    ingestBatch: options.ingestPublisherBatch,
  })
  const muxFactory = options.muxFactory || (connection => Protomux.from(connection))
  const scopes = new Map()
  const followedPublishers = new Map()
  const localPublishers = new Map()
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
  let networkPolicyEpoch = 0

  function reservePolicyUpload (bytes) {
    const amount = Number(bytes)
    if (!uploadAllowed || !networkEnabled || !Number.isSafeInteger(amount) || amount < 0 ||
        uploadedBytes + amount > uploadCeilingBytes) return null
    uploadedBytes += amount
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
      },
    }
  }

  function recordProtocolError (scope, peerId, error) {
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
        if (info?.client === false) continue
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
    if (sender.send(frame, tracked.channel) === false) return false
    counters.outboundFrames++
    return true
  }

  function encodeFeedRequest(cursor) {
    const value = String(cursor || '0')
    if (b4a.byteLength(value) > 256) fail('feed cursor is too large')
    return c.encode(c.any, { cursor: value })
  }

  function decodeFeedRequest(payload) {
    const value = c.decode(c.any, payload)
    if (!value || typeof value.cursor !== 'string' || b4a.byteLength(value.cursor) > 256) fail('feed request is invalid')
    return value.cursor
  }

  function encodeFeedResponse(cursor, envelope) {
    const encoded = encodeApplicationEnvelope(envelope)
    if (encoded.byteLength > MAX_PEER_FRAME_BYTES - 1024) fail('feed page exceeds frame bound')
    return c.encode(c.any, { cursor, envelope: encoded })
  }

  function decodeFeedResponse(payload) {
    const value = c.decode(c.any, payload)
    if (!value || typeof value.cursor !== 'string' || b4a.byteLength(value.cursor) > 256 || !value.envelope) fail('feed response is invalid')
    const envelope = decodeApplicationEnvelope(b4a.from(value.envelope))
    return { cursor: value.cursor, envelope }
  }

  async function handleFeedFrame(scope, tracked, frame) {
    const providers = scope.feedKind === 'index' ? indexFeedProviders : moderationFeedProviders
    if (frame.type === 'feed-page-request') {
      const cursor = decodeFeedRequest(frame.payload)
      const fetchPage = providers.get(scope.feedId)
      if (!fetchPage) return { status: 'rejected', reason: 'feed-not-provided' }
      const page = await fetchPage(cursor)
      if (!page?.envelope) return { status: 'rejected', reason: 'feed-page-unavailable' }
      if (!sendScopedFrame(tracked, scope.purpose, 'feed-page-response', encodeFeedResponse(cursor, page.envelope))) return { status: 'rejected', reason: 'feed-response-send-failed' }
      return { status: 'sent' }
    }
    if (frame.type === 'feed-page-response') {
      const response = decodeFeedResponse(frame.payload)
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
    if (!sendScopedFrame(tracked, scope.purpose, 'feed-page-request', encodeFeedRequest(key))) {
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
    if (!proof || typeof proof !== 'object' || !proof.genesis || !Array.isArray(proof.transitions)) {
      fail('namespace proof response is invalid')
    }
    return proof
  }

  async function handlePublisherProofFrame(scope, tracked, frame) {
    if (frame.type === 'namespace-proof-request') {
      const proof = publisherProofProviders.get(scope.publisherId)
      if (!proof) return { status: 'rejected', reason: 'namespace-proof-unavailable' }
      if (!sendScopedFrame(tracked, 'publisher', 'namespace-proof-response', encodeNamespaceProof(proof))) {
        return { status: 'rejected', reason: 'namespace-proof-send-failed' }
      }
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
      const proof = await scope.core.proof({
        block: { index, nodes: 0 },
        upgrade: { start: 0, length: scope.core.length },
      })
      const value = b4a.from(proof?.block?.value || [])
      const reservation = policyEpoch === networkPolicyEpoch
        ? reservePolicyUpload(value.byteLength)
        : null
      if (!reservation || proof?.block?.index !== index || value.byteLength > MAX_ASSET_BLOCK_BYTES) {
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
      const proof = await resource.core.proof({
        block: { index: request.index, nodes: 0 },
        upgrade: { start: 0, length: resource.core.length },
      })
      const value = b4a.from(proof?.block?.value || [])
      const ceiling = scope.archiveUploadCeilingBytes
      const reservation = policyEpoch === networkPolicyEpoch
        ? reservePolicyUpload(value.byteLength)
        : null
      if (!reservation || proof?.block?.index !== request.index || value.byteLength > MAX_ASSET_BLOCK_BYTES ||
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

  function attachCatalogReplication (scope, connection, tracked = null) {
    const mux = muxFactory(connection)
    const replicated = tracked?.replicatedCoreKeys || new Set()
    const sync = () => {
      for (const [key, core] of catalogReplicationCores(scope.binding)) {
        if (replicated.has(key)) continue
        core.replicate(mux, { live: true })
        replicated.add(key)
      }
    }
    sync()
    if (tracked) {
      tracked.replicatedCoreKeys = replicated
      const base = scope.binding.catalog.base
      const onupdate = () => {
        try {
          sync()
          if (onCatalogUpdate) {
            Promise.resolve(onCatalogUpdate({ publisherId: scope.publisherId })).catch(() => {
              closeSession(scope, tracked.peerId, 'catalog-projection-update-failed')
            })
          }
        } catch {
          closeSession(scope, tracked.peerId, 'catalog-authorization-changed')
        }
      }
      base.on?.('update', onupdate)
      tracked.cleanupFns.push(() => {
        base.off?.('update', onupdate)
        base.removeListener?.('update', onupdate)
      })
    }
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
      if (connection) {
        attachCatalogReplication(scope, connection, tracked)
        counters.openedCatalogs++
      }
      return { status: 'authorized', action: 'catalog', publisherId: scope.publisherId }
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
    if (result.status === 'accepted' && result.publisherId && isPeerConnected(context.peerId)) {
      const previous = bootstrapFollowAttempts.get(result.publisherId) || 0
      if (previous < 4) {
        bootstrapFollowAttempts.set(result.publisherId, previous + 1)
        // Candidate promotion is bounded and best-effort. The locator itself is
        // never authority; followBootstrapLocator still requires the scoped
        // publisher-root proof before it can bind a catalog.
        void followBootstrapLocator({ publisherId: result.publisherId }).catch(() => {})
      }
    }
    counters.acceptedFrames++
    return result
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
          tracked = scope.sessions.get(remoteKey)
        }
        const result = authorizeScopeConnection(scope, { peerId: remoteKey, connection, tracked })
        if (result.status !== 'authorized') fail(result.reason)
        if (tracked) {
          tracked.state = 'active'
          if (scope.purpose === 'index' || scope.purpose === 'moderation') {
            void syncFollowedFeed(scope)
          }
          if (scope.purpose === 'asset') startAssetPumpWhenOpen(scope, tracked)
          if (scope.purpose === 'archive' && !scope.archiveDiscovery) startArchivePumpWhenOpen(scope, tracked)
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
      onopen: encoded => protocolSession.acceptHello(encoded).catch(error => {
        counters.rejectedFrames++
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
      replicatedCoreKeys: new Set(),
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
      if (info?.client === false) continue
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

    const wasNetworkEnabled = networkEnabled
    const wasUploadAllowed = uploadAllowed
    networkEnabled = policy.networkEnabled !== false
    uploadPermission = nextUploadPermission
    uploadCeilingBytes = nextUploadCeilingBytes
    diskCeilingBytes = nextDiskCeilingBytes
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
      policyEpoch: networkPolicyEpoch,
    }
  }

  async function start () {
    if (status === 'closed') fail('runtime is closed')
    if (status === 'active') return { status: 'active' }
    status = 'active'
    if (networkEnabled) await activateNetwork()
    return { status: 'active' }
  }

  async function followPublisher ({ publisherId, namespaceDescriptor, verifiedTransitionChain = false } = {}) {
    if (status !== 'active') fail('runtime is not active')
    const id = hex32(publisherId, 'publisherId')
    const descriptor = normalizeNamespace(namespaceDescriptor, protocolMajor, { verifiedTransitionChain })
    if (b4a.toString(descriptor.publisherId, 'hex') !== id) fail('namespace publisherId mismatch')
    const existing = followedPublishers.get(id)
    if (existing) return { ...existing.result, status: 'already-following' }
    if (!catalogRegistry?.bindNamespace) fail('catalog registry cannot bind verified namespaces')
    const binding = await catalogRegistry.bindNamespace(descriptor)
    if (hex32(binding.catalogBootstrapKey, 'catalogBootstrapKey') !== b4a.toString(descriptor.catalogBootstrapKey, 'hex')) fail('catalog binding mismatch')
    await publisherManager.followPublisher(id)
    const topic = derivePublisherTopic({ publisherId: id, catalogEpoch: descriptor.catalogEpoch })
    const { scope } = joinScope({ purpose: 'publisher', topic, scopeId: id, mode: 'followed', publisherId: id, descriptor, binding })
    scope.publisherId = id
    scope.descriptor = descriptor
    scope.binding = binding
    const result = { status: 'following', publisherId: id, catalogBootstrapKey: hex32(binding.catalogBootstrapKey, 'catalogBootstrapKey'), topic: stableScopeDiagnostic(scope) }
    followedPublishers.set(id, { scope, result })
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
    try {
      verified = verifyPublisherNamespaceProof({ locator, ...(proof || await requestNamespaceProof(scope)) })
    } catch (error) {
      await leaveScope(scope, 'candidate')
      const rejected = new Error(error?.message || 'namespace proof rejected')
      rejected.code = 'PUBLISHER_NAMESPACE_PROOF_REJECTED'
      throw rejected
    }
    await leaveScope(scope, 'candidate')
    return followPublisher({ publisherId: id, namespaceDescriptor: verified.descriptor, verifiedTransitionChain: verified.descriptor.catalogEpoch > 0 })
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

  async function provideIndexFeed ({ curatorId, fetchPage } = {}) {
    const id = hex32(curatorId, 'curatorId')
    if (typeof fetchPage !== 'function') fail('index feed provider requires fetchPage')
    indexFeedProviders.set(id, fetchPage)
    joinScope({ purpose: 'index', topic: deriveIndexTopic({ protocolMajor, curatorId: id }), scopeId: id, mode: 'provided', feedId: id, feedKind: 'index', feedPending: new Map() })
    return { status: 'provided', curatorId: id }
  }

  async function subscribeIndexFeed ({ curatorId } = {}) {
    const id = hex32(curatorId, 'curatorId')
    indexFeedManager.subscribe(id)
    const { scope } = joinScope({ purpose: 'index', topic: deriveIndexTopic({ protocolMajor, curatorId: id }), scopeId: id, mode: 'subscribed', feedId: id, feedKind: 'index', feedPending: new Map() })
    return syncFollowedFeed(scope)
  }

  async function followIndexFeed ({ curatorId } = {}) {
    const id = hex32(curatorId, 'curatorId')
    indexFeedManager.subscribe(id)
    const { scope } = joinScope({ purpose: 'index', topic: deriveIndexTopic({ protocolMajor, curatorId: id }), scopeId: id, mode: 'subscribed', feedId: id, feedKind: 'index', feedPending: new Map() })
    return { status: 'following', curatorId: id, topic: stableScopeDiagnostic(scope) }
  }

  async function unfollowIndexFeed ({ curatorId } = {}) {
    const id = hex32(curatorId, 'curatorId')
    indexFeedManager.unsubscribe(id)
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
    moderationManager.subscribe(id)
    const { scope } = joinScope({ purpose: 'moderation', topic: deriveModerationTopic({ protocolMajor, moderatorId: id }), scopeId: id, mode: 'subscribed', feedId: id, feedKind: 'moderation', feedPending: new Map() })
    return syncFollowedFeed(scope)
  }

  async function followModerationFeed ({ moderatorId } = {}) {
    const id = hex32(moderatorId, 'moderatorId')
    moderationManager.subscribe(id)
    const { scope } = joinScope({ purpose: 'moderation', topic: deriveModerationTopic({ protocolMajor, moderatorId: id }), scopeId: id, mode: 'subscribed', feedId: id, feedKind: 'moderation', feedPending: new Map() })
    return { status: 'following', moderatorId: id, topic: stableScopeDiagnostic(scope) }
  }

  async function unfollowModerationFeed ({ moderatorId } = {}) {
    const id = hex32(moderatorId, 'moderatorId')
    moderationManager.unsubscribe(id)
    const scope = findScope('moderation', deriveModerationTopic({ protocolMajor, moderatorId: id }))
    const released = scope ? await leaveScope(scope, 'subscribed') : false
    return { status: 'unfollowed', moderatorId: id, released }
  }

  async function unfollowPublisher ({ publisherId } = {}) {
    const id = hex32(publisherId, 'publisherId')
    const followed = followedPublishers.get(id)
    followedPublishers.delete(id)
    await publisherManager.unfollowPublisher(id)
    const released = followed ? await leaveScope(followed.scope, 'followed') : false
    if (followed && !localPublishers.has(id)) await catalogRegistry?.release?.(b4a.from(id, 'hex'))
    return { status: 'unfollowed', publisherId: id, released }
  }

  async function publishLocalPublisherCatalog ({ publisherId } = {}) {
    if (status !== 'active') fail('runtime is not active')
    const id = hex32(publisherId, 'publisherId')
    const existing = localPublishers.get(id)
    if (existing) return { ...existing.result, status: 'already-published' }
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
    const descriptor = normalizeNamespace(binding.namespaceDescriptor || descriptorEntry?.value, protocolMajor)
    if (b4a.toString(descriptor.publisherId, 'hex') !== id) fail('local catalog namespace mismatch')
    if (hex32(binding.catalogBootstrapKey, 'catalogBootstrapKey') !== b4a.toString(descriptor.catalogBootstrapKey, 'hex')) fail('local catalog binding mismatch')
    const topic = derivePublisherTopic({ publisherId: id, catalogEpoch: descriptor.catalogEpoch })
    const { scope } = joinScope({ purpose: 'publisher', topic, scopeId: id, mode: 'local', publisherId: id, descriptor, binding })
    const result = { status: 'published', publisherId: id, catalogBootstrapKey: hex32(binding.catalogBootstrapKey, 'catalogBootstrapKey'), topic: stableScopeDiagnostic(scope) }
    localPublishers.set(id, { scope, result })
    return result
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

  async function retainAuthorizedRendition ({ manifest, renditionId, start = 0, end = null } = {}) {
    if (status !== 'active') fail('runtime is not active')
    const id = String(renditionId || '')
    const rendition = (manifest?.body?.renditions || []).find(candidate => candidate.renditionId === id)
    if (!rendition || rendition.blocked || rendition.superseded) fail('rendition is not manifest-authorized')
    const declaredLength = Number(rendition.core?.length)
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 1) fail('rendition core length is invalid')
    const range = safeRange(start, end === null ? declaredLength : end)
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
        manifestId: manifest.body.manifestId,
        assetNextIndex: range.start,
        assetPending: new Set(),
        assetRetries: new Set(),
        assetFailures: new Map(),
      })
      const result = { status: 'retained', renditionId: id, coreKey, range: { ...range }, topic: stableScopeDiagnostic(scope) }
      renditions.set(id, { scope, result, manifest })
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
      const authorized = await authorizePublication({
        manifest: retained.manifest,
        renditionId,
        start: range.start,
        end: range.end
      }).catch(() => false)
      if (authorized) continue
      await releaseAuthorizedRendition({ renditionId })
      released++
    }
    return { released }
  }

  async function retainArchiveDiscovery ({ onRequest, onPledge, onChallenge, onChallengeProof } = {}) {
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

  async function publishArchiveRequest ({ request, envelope } = {}) {
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
    const proof = await resource.core.proof({
      block: { index, nodes: 0 },
      upgrade: { start: 0, length: resource.core.length },
    })
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
    providePublisherNamespaceProof,
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
    providePublisherNamespaceProof: request => runtime.providePublisherNamespaceProof(request),
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
