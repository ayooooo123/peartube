import b4a from 'b4a'
import c from 'compact-encoding'
import Protomux from 'protomux'

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
  decodePeerFrame,
  encodeAssetBlockError,
  encodeAssetBlockRequest,
  encodeAssetBlockResponse,
  encodeAssetRangeSummaryPage,
  encodeAssetRangeSummaryRequest,
  encodePeerFrame,
  MAX_PEER_FRAME_BYTES,
  PEER_FRAME_TYPE_NAMES,
  PROTOCOL_MAJOR,
} from './frame.js'
import {
  deriveArchiveDiscoveryTopic,
  deriveArchiveTopic,
  deriveBootstrapTopic,
  derivePublisherTopic,
  topicHex,
} from './topics.js'
import {
  BOOTSTRAP_LOCATOR_CAPABILITY,
} from '../discovery/bootstrap-protocol.js'
import { createBootstrapManager } from '../discovery/bootstrap-manager.js'
import { createPublisherManager } from '../discovery/publisher-manager.js'
import {
  decodeApplicationEnvelope,
  encodeApplicationEnvelope,
} from '../records/application-envelope.js'
import {
  PUBLISHER_CATALOG_CAPABILITY,
  decodePublisherNamespaceDescriptor,
  verifyPublisherNamespaceDescriptor,
} from '../publisher/namespace.js'
import { verifyArchivePledge } from '../archive/pledge.js'
import { normalizeAssetCoreRefV2 } from '../assets/rendition.js'
import { deriveStaticAssetTopic } from '../assets/static-core.js'
import { createAssetSession } from '../assets/asset-session.js'


const FRAME_TYPES = PEER_FRAME_TYPE_NAMES
export const ASSET_RENDITION_CAPABILITY = 'asset-rendition:v2'
export const ARCHIVE_RANGE_CAPABILITY = 'archive-range:v1'
export const ARCHIVE_DISCOVERY_CAPABILITY = 'archive-discovery:v1'
export const SCOPED_NETWORK_PROTOCOL = 'peartube/scoped-network'

const PURPOSE_CODES = Object.freeze({ bootstrap: 1, publisher: 2, asset: 3, archive: 5, 'archive-discovery': 6 })
const PURPOSE_NAMES = new Map(Object.entries(PURPOSE_CODES).map(([name, code]) => [code, name]))
const MAX_HELLO_BYTES = 2048
const MAX_CAPABILITIES = 16
const MAX_CAPABILITY_BYTES = 128
const MAX_ASSET_BLOCK_BYTES = 256 * 1024
const MAX_ASSET_PROOF_BYTES = 32 * 1024
const MAX_ARCHIVE_CHALLENGE_PROOF_BYTES = 320 * 1024
const ASSET_CHUNK_BYTES = 48 * 1024
const ASSET_TRANSFER_TIMEOUT_MS = 10_000
const ASSET_TRANSPORT_ERROR_CODES = new Set([
  'INVALID_PROOF',
  'QUARANTINED',
  'DISCONNECTED',
  'TIMEOUT',
  'UNAVAILABLE',
])
const MAX_ASSET_PEERS_PER_REQUEST = 16
const MAX_ASSET_PEER_ID_BYTES = 128
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

function normalizeNamespace (value, protocolMajor) {
  const descriptor = b4a.isBuffer(value) || value instanceof Uint8Array
    ? decodePublisherNamespaceDescriptor(b4a.from(value), { protocolMajor, supportedCapabilities: [PUBLISHER_CATALOG_CAPABILITY] })
    : value
  verifyPublisherNamespaceDescriptor(descriptor, {
    protocolMajor,
    supportedCapabilities: [PUBLISHER_CATALOG_CAPABILITY],
    genesisRootKey: descriptor?.catalogEpoch === 0 ? descriptor.publisherRootKey : undefined,
  })
  if (descriptor.catalogEpoch !== 0) fail('rotated namespace requires a verified committed transition')
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
  const assetTransferTimeoutMs = Number(options.assetTransferTimeoutMs ?? ASSET_TRANSFER_TIMEOUT_MS)
  if (!Number.isSafeInteger(assetTransferTimeoutMs) ||
      assetTransferTimeoutMs < 1 ||
      assetTransferTimeoutMs > ASSET_TRANSFER_TIMEOUT_MS) {
    fail('asset transfer timeout is out of bounds')
  }
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
  let nextAssetTransferId = 1n
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
      protocolMajor,
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

  function closeSession (scope, peerId, reason) {
    const session = scope.sessions.get(peerId)
    if (!session || session.closed) return false
    cancelAssetSummaryScan(session)
    closeAssetInventoryRequest(
      session,
      session.assetInventoryRequest,
      assetTransportError('DISCONNECTED', peerId, 'asset peer disconnected'),
    )
    for (const response of session.assetResponses?.values() || []) response.cancelled = true
    session.assetResponses?.clear()
    if (scope.purpose === 'asset') failAssetRequestPeer(scope, peerId, 'DISCONNECTED')
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
        if (transfer.peerId === peerId) request.transfers.delete(index)
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

  function expectedAssetValueBytes (scope, index) {
    const coreRef = scope.assetSession.coreRef
    if (index < coreRef.length - 1) return coreRef.blockSize
    return coreRef.byteLength - ((coreRef.length - 1) * coreRef.blockSize)
  }

  function sendAssetError (scope, tracked, range, code) {
    return sendScopedFrame(tracked, 'asset', 'asset-block-error', encodeAssetBlockError({
      assetId: scope.assetId,
      transferId: range.transferId,
      startBlock: range.startBlock,
      endBlock: range.endBlock,
      code,
    }))
  }

  function sendAssetResponseBytes (scope, tracked, responseState, range, blockIndex, kind, bytes) {
    for (let offset = 0; offset < bytes.byteLength; offset += ASSET_CHUNK_BYTES) {
      if (responseState.cancelled || scope.closed || tracked.closed ||
          !networkEnabled || responseState.policyEpoch !== networkPolicyEpoch) return false
      const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + ASSET_CHUNK_BYTES))
      if (!sendScopedFrame(tracked, 'asset', 'asset-block-response', encodeAssetBlockResponse({
        assetId: scope.assetId,
        transferId: range.transferId,
        startBlock: range.startBlock,
        endBlock: range.endBlock,
        blockIndex,
        kind,
        offset,
        totalBytes: bytes.byteLength,
        chunk,
      }))) return false
    }
    return true
  }

  async function sendAssetBlocks (scope, tracked, range) {
    if (range.startBlock < scope.range.start || range.endBlock > scope.range.end) {
      fail('asset block request is outside the authorized range')
    }
    if (tracked.assetResponses.size >= MAX_ASSET_BLOCKS_PER_REQUEST ||
        tracked.assetResponses.has(range.transferId)) {
      fail('asset responder request limit exceeded')
    }
    const responseState = { cancelled: false, policyEpoch: networkPolicyEpoch }
    tracked.assetResponses.set(range.transferId, responseState)
    let served = 0
    try {
      if (!uploadAllowed || !networkEnabled) {
        sendAssetError(scope, tracked, range, ASSET_BLOCK_ERROR_CODES.UNAVAILABLE)
        return
      }
      const core = await scope.assetSession.ready()
      for (let index = range.startBlock; index < range.endBlock; index++) {
        if (responseState.cancelled || scope.closed || tracked.closed ||
            responseState.policyEpoch !== networkPolicyEpoch) return
        const present = await core.has(index)
        if (responseState.cancelled || scope.closed || tracked.closed ||
            responseState.policyEpoch !== networkPolicyEpoch) return
        if (!present) continue
        const proof = await core.proof({
          block: { index, nodes: 0 },
          upgrade: { start: 0, length: scope.assetSession.coreRef.length },
        })
        if (responseState.cancelled || scope.closed || tracked.closed ||
            responseState.policyEpoch !== networkPolicyEpoch) return
        const value = proof?.block?.value
        if (!b4a.isBuffer(value) || proof.block.index !== index ||
            value.byteLength !== expectedAssetValueBytes(scope, index)) {
          fail('local asset block does not match the verified descriptor')
        }
        const proofBytes = encodeAssetProof(index, proof, value)
        const reservation = responseState.policyEpoch === networkPolicyEpoch
          ? reservePolicyUpload(value.byteLength)
          : null
        if (!reservation) return
        const canBatch = typeof tracked.channel?.cork === 'function' && typeof tracked.channel?.uncork === 'function'
        if (canBatch) tracked.channel.cork()
        try {
          const proofSent = sendAssetResponseBytes(scope, tracked, responseState, range, index, 'proof', proofBytes)
          const blockSent = proofSent && sendAssetResponseBytes(scope, tracked, responseState, range, index, 'block', value)
          if (!blockSent) return
          reservation.commit()
          served++
        } finally {
          reservation.release()
          if (canBatch) tracked.channel.uncork()
        }
      }
      if (served === 0 && !responseState.cancelled && !tracked.closed) {
        sendAssetError(scope, tracked, range, ASSET_BLOCK_ERROR_CODES.UNAVAILABLE)
      }
    } finally {
      tracked.assetResponses.delete(range.transferId)
    }
  }

  function receiveAssetProofPart (scope, transfer, response) {
    if (transfer.proofMetadata) fail('asset proof was already completed')
    let part = transfer.proof
    if (!part) {
      if (response.offset !== 0) fail('asset proof response is not contiguous')
      part = {
        buffer: b4a.allocUnsafe(response.totalBytes),
        receivedBytes: 0,
        totalBytes: response.totalBytes,
      }
      transfer.proof = part
    }
    if (part.totalBytes !== response.totalBytes || part.receivedBytes !== response.offset) {
      fail('asset proof response is not contiguous')
    }
    b4a.copy(response.chunk, part.buffer, response.offset)
    part.receivedBytes += response.chunk.byteLength
    if (part.receivedBytes !== part.totalBytes) return

    const metadata = decodeAssetProof(part.buffer, transfer.index)
    if (!b4a.equals(c.encode(c.any, metadata), part.buffer)) {
      fail('asset proof encoding is noncanonical')
    }
    const validation = scope.assetSession.validateProofMetadata({
      index: transfer.index,
      proof: metadata.proof,
      byteLength: metadata.byteLength,
      peerId: transfer.peerId,
      transferId: transfer.transferId,
    })
    if (validation && typeof validation.then === 'function') {
      part.buffer = null
      transfer.preflight = validation
      return validation
    }
    transfer.expectedBlockBytes = validation
    transfer.proofMetadata = metadata
    part.buffer = null
  }

  function receiveAssetBlockPart (transfer, response) {
    if (!transfer.proofMetadata) fail('asset block bytes arrived before a complete canonical proof')
    if (response.totalBytes !== transfer.expectedBlockBytes) {
      fail('asset block response length does not match the verified descriptor')
    }
    let part = transfer.block
    if (!part) {
      if (response.offset !== 0) fail('asset block response is not contiguous')
      part = {
        buffer: b4a.allocUnsafe(transfer.expectedBlockBytes),
        receivedBytes: 0,
        totalBytes: transfer.expectedBlockBytes,
      }
      transfer.block = part
    }
    if (part.totalBytes !== response.totalBytes || part.receivedBytes !== response.offset) {
      fail('asset block response is not contiguous')
    }
    b4a.copy(response.chunk, part.buffer, response.offset)
    part.receivedBytes += response.chunk.byteLength
  }

  async function finishAssetResponse (scope, request, transfer) {
    if (transfer.applying || !transfer.proofMetadata || !transfer.block ||
        transfer.block.receivedBytes !== transfer.block.totalBytes) return
    transfer.applying = true
    try {
      if (request.closed || scope.assetRequests.get(request.key) !== request) return
      await scope.assetSession.verifyBlock({
        index: transfer.index,
        proof: transfer.proofMetadata.proof,
        value: transfer.block.buffer,
        peerId: transfer.peerId,
        transferId: transfer.transferId,
        isActive: () => !request.closed &&
          scope.assetRequests.get(request.key) === request &&
          request.transfers.get(transfer.index) === transfer,
      })
      if (request.closed || scope.assetRequests.get(request.key) !== request) return
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
      if (request.transfers.get(transfer.index) === transfer) {
        request.transfers.delete(transfer.index)
      }
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
      transfer = {
        transferId: response.transferId,
        index: response.blockIndex,
        peerId: tracked.peerId,
        proof: null,
        proofMetadata: null,
        preflight: null,
        expectedBlockBytes: null,
        block: null,
        applying: false,
      }
      request.transfers.set(response.blockIndex, transfer)
    }
    if (transfer.transferId !== response.transferId) fail('asset block response transferId changed')
    if (transfer.peerId !== tracked.peerId) fail('asset block response changed contributing peer')
    if (transfer.preflight) await transfer.preflight
    if (response.kind === 'proof') {
      const preflight = receiveAssetProofPart(scope, transfer, response)
      if (preflight) await preflight
    } else {
      receiveAssetBlockPart(transfer, response)
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
    for (const session of scope.sessions.values()) cancelAssetSummaryScan(session)
    for (const request of [...(scope.assetRequests?.values() || [])]) {
      closeAssetRequest(scope, request, new Error('asset scope was released'))
    }
    await scope.assetSession?.close?.()
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
          [scope.assetSession ? null : scope.core, ['close']],
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
      if (!scope.binding?.catalog || (!scope.modes.has('followed') && !scope.modes.has('local'))) return { status: 'rejected', reason: 'publisher-not-followed' }
      if (connection) {
        attachCatalogReplication(scope, connection, tracked)
        counters.openedCatalogs++
      }
      return { status: 'authorized', action: 'catalog', publisherId: scope.publisherId }
    }
    if (scope.purpose === 'asset') {
      if (!scope.assetSession || !scope.coreKey) return { status: 'rejected', reason: 'core-not-authorized' }
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
          tracked = scope.sessions.get(remoteKey)
        }
        const result = authorizeScopeConnection(scope, { peerId: remoteKey, connection, tracked })
        if (result.status !== 'authorized') fail(result.reason)
        if (tracked) {
          tracked.state = 'active'
          if (scope.purpose === 'archive' && !scope.archiveDiscovery) startArchivePumpWhenOpen(scope, tracked)
        }
      },
      onFrame: frame => {
        if (scope.purpose === 'bootstrap') return handleBootstrapFrame(frame, { peerId: remoteKey })
        if (scope.purpose === 'asset') return handleAssetFrame(scope, scope.sessions.get(remoteKey), frame)
        if (scope.purpose === 'archive') return handleArchiveFrame(scope, scope.sessions.get(remoteKey), frame)
        if (scope.purpose === 'archive-discovery') return handleArchiveFrame(scope, scope.sessions.get(remoteKey), frame)
        return frame.type === 'probe' ? { status: 'ok' } : fail('frame type is not allowed for this purpose')
      },
      onClose: () => {
        const tracked = scope.sessions.get(remoteKey)
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
      assetResponses: new Map(),
      assetSummaryScan: null,
      assetInventoryRequest: null,
      lastAssetTransferId: 0n,
      archiveRequest: null,
      archiveTransfer: null,
      archiveTimer: null,
      archiveServing: false,
      archiveLastServed: new Map(),
      archiveServedBytes: 0,
    }
    scope.sessions.set(remoteKey, tracked)
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
    await Promise.all([...scopes.values()].map(scope => pumpArchiveSessions(scope)))
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

  async function followPublisher ({ publisherId, namespaceDescriptor } = {}) {
    if (status !== 'active') fail('runtime is not active')
    const id = hex32(publisherId, 'publisherId')
    const descriptor = normalizeNamespace(namespaceDescriptor, protocolMajor)
    if (b4a.toString(descriptor.publisherId, 'hex') !== id) fail('namespace publisherId mismatch')
    const existing = followedPublishers.get(id)
    if (existing) return { ...existing.result, status: 'already-following' }
    if (!catalogRegistry?.bindNamespace) fail('catalog registry cannot bind verified namespaces')
    const binding = await catalogRegistry.bindNamespace(descriptor)
    if (hex32(binding.catalogBootstrapKey, 'catalogBootstrapKey') !== b4a.toString(descriptor.catalogBootstrapKey, 'hex')) fail('catalog binding mismatch')
    await publisherManager.followPublisher(id)
    const topic = derivePublisherTopic({ protocolMajor, publisherId: id, catalogEpoch: descriptor.catalogEpoch })
    const { scope } = joinScope({ purpose: 'publisher', topic, scopeId: id, mode: 'followed', publisherId: id, descriptor, binding })
    const result = { status: 'following', publisherId: id, catalogBootstrapKey: hex32(binding.catalogBootstrapKey, 'catalogBootstrapKey'), topic: stableScopeDiagnostic(scope) }
    followedPublishers.set(id, { scope, result })
    return result
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
    const topic = derivePublisherTopic({ protocolMajor, publisherId: id, catalogEpoch: descriptor.catalogEpoch })
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
        catalogBootstrapKey: hex32(binding.catalogBootstrapKey, 'catalogBootstrapKey'),
        catalogEpoch: descriptor?.catalogEpoch ?? null,
        writable: Boolean(binding.catalog?.writable),
      }
    } catch {
      return { status: 'unavailable', publisherId: id }
    }
  }

  async function retainAuthorizedRendition ({
    manifest,
    renditionId,
    ownerId: requestedOwnerId,
    start = 0,
    end = null,
  } = {}) {
    if (status !== 'active') fail('runtime is not active')
    const id = String(renditionId || '')
    const ownerId = String(requestedOwnerId || manifest?.publicationId || id)
    if (!ownerId) fail('retention owner is required')
    const rendition = (manifest?.body?.renditions || []).find(candidate => candidate.renditionId === id)
    if (!rendition || rendition.blocked || rendition.superseded) fail('rendition is not manifest-authorized')
    const coreRef = normalizeAssetCoreRefV2(rendition.core)
    if (coreRef.length < 1) fail('rendition core length is invalid')
    const range = safeRange(start, end === null ? coreRef.length : end)
    if (range.end > coreRef.length) fail('rendition range exceeds the manifest core length')
    const verified = await authorizePublication({ manifest, renditionId: id, start: range.start, end: range.end })
    if (!verified) fail('publication manifest authorization failed')
    const coreKey = coreRef.key
    const existing = renditions.get(id)
    if (existing) {
      if (existing.scope.coreKey !== coreKey ||
          existing.range.start !== range.start ||
          existing.range.end !== range.end) {
        fail('rendition is already retained with a different authorization')
      }
      if (existing.owners.has(ownerId)) {
        return { ...existing.result, ownerId, status: 'already-retained' }
      }
      const mode = `retained:${id}:${ownerId}`
      joinScope({
        purpose: 'asset',
        topic: existing.scope.topic,
        scopeId: coreRef.assetId,
        mode,
      })
      existing.scope.assetAuthorizations.set(
        assetAuthorizationId(id, ownerId),
        { manifest, renditionId: id, range: { ...range } },
      )
      existing.owners.set(ownerId, { mode, manifest })
      return { ...existing.result, ownerId, status: 'retained' }
    }

    const topic = deriveStaticAssetTopic(coreRef.assetId)
    const sharedScope = findScope('asset', topic)
    if (sharedScope && (
      sharedScope.coreKey !== coreKey ||
      sharedScope.range.start !== range.start ||
      sharedScope.range.end !== range.end
    )) {
      fail('static asset is already retained with a different authorization range')
    }
    const mode = `retained:${id}:${ownerId}`
    let scope = sharedScope
    if (scope) {
      joinScope({ purpose: 'asset', topic, scopeId: coreRef.assetId, mode })
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
          assetAuthorizations: new Map([[
            assetAuthorizationId(id, ownerId),
            { manifest, renditionId: id, range: { ...range } },
          ]]),
        }))
      } catch (error) {
        try { await assetSession?.close?.() } catch {}
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
      owners: new Map([[ownerId, { mode, manifest }]]),
    })
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
    const ownerIds = requestedOwnerId === undefined
      ? [...retained.owners.keys()]
      : [String(requestedOwnerId)]
    let released = false
    for (const ownerId of ownerIds) {
      const owner = retained.owners.get(ownerId)
      if (!owner) continue
      retained.owners.delete(ownerId)
      retained.scope.assetAuthorizations?.delete(assetAuthorizationId(id, ownerId))
      released = true
      await leaveScope(retained.scope, owner.mode)
    }
    if (retained.owners.size === 0) renditions.delete(id)
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
      !session.closed && session.state === 'active' && !session.channel?.closed)
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
      closeSession(scope, id, 'asset-inventory-aborted')
    }
    session.assetInventoryRequest = request
    signal?.addEventListener?.('abort', request.onAbort, { once: true })
    request.timer = setTimeout(() => {
      if (!closeAssetInventoryRequest(
        session,
        request,
        assetTransportError('TIMEOUT', id, 'asset inventory request timed out'),
      )) return
      closeSession(scope, id, 'asset-inventory-timeout')
    }, assetTransferTimeoutMs)
    request.timer?.unref?.()
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

  async function requestAssetBlocks ({ assetId, startBlock, endBlock, peerIds, signal } = {}) {
    if (status !== 'active' || !networkEnabled) fail('runtime is not active')
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
        else remaining.add(index)
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
    request.timer?.unref?.()
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
    try {
      for (const peer of peers) {
        if (request.closed) break
        if (sendScopedFrame(peer, 'asset', 'asset-block-request', payload)) {
          request.requestedPeers.add(peer.peerId)
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
          start: retained.range.start,
          end: retained.range.end,
        }).catch(() => false)
        if (authorized) continue
        await releaseAuthorizedRendition({ renditionId, ownerId })
        released++
      }
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
        assetResponseCount: session.assetResponses?.size || 0,
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
    unfollowPublisher,
    publishLocalPublisherCatalog,
    resolveLocalPublisherCatalog,
    retainAuthorizedRendition,
    releaseAuthorizedRendition,
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
    unfollowPublisher: request => runtime.unfollowPublisher(request),
    publishLocalPublisherCatalog: request => runtime.publishLocalPublisherCatalog(request),
    resolveLocalPublisherCatalog: request => runtime.resolveLocalPublisherCatalog(request),
    retainAuthorizedRendition: request => runtime.retainAuthorizedRendition(request),
    releaseAuthorizedRendition: request => runtime.releaseAuthorizedRendition(request),
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
    getScopedNetworkDiagnostics: () => runtime.getDiagnostics(),
  }
}
