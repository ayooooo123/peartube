import b4a from 'b4a'
import sodium from 'sodium-universal'

import { OrderedReceiver, SenderCounter } from './counters.js'
import { cryptoSuite } from './crypto-suite.js'
import { PrivateRouteError } from './errors.js'
import { digestPayloadParameters } from './final-exit.js'
import {
  completeBranchPathReservation,
  failBranchPathAuthorization,
  failBranchPathReservation,
  isBranchPathAuthority,
  isBranchPathAuthorityFor,
  takeBranchPathAuthorization
} from './branch-path-authority.js'
import {
  isM3AdjacencyAuthority,
  revokeM3TailCapability,
  takeM3TailCapability
} from './m3-adjacency-runtime.js'
import {
  destroyTakenExtensionLinkCompletion,
  takeExtensionLinkCompletion
} from './extension-link-completion.js'
import {
  destroyTailExtensionCommitter,
  enqueueTailExtended,
  installTailExtension,
  isTailExtensionCommitter
} from './tail-extension-committer.js'
import {
  consumeVerifiedRedactedResponderProof,
  createRedactedResponderProofAuthority,
  decodeRedactedResponderProof,
  verifyExpectedRedactedResponderProof
} from './redacted-responder-proof.js'
import {
  decodeM3ContextEnvelope,
  encodeM3ContextAD,
  encodeM3ContextEnvelope
} from './m3-context.js'
import {
  BRANCH_CLASS,
  CELL_CLASS,
  CONTEXT_CLASS,
  DIRECTION,
  M3_LINK_ROLE,
  M3_MESSAGE_ID,
  M3_PROTOCOL_VERSION,
  RELAY_CAPABILITY,
  decodeM3Object,
  encodeM3Object
} from './protocol.js'
import {
  commitCurrentTailCandidateResponse,
  consumeCurrentTailCandidateAdmissionHandle,
  decodeRelayDiscoverResponse,
  isRoutedCandidateAuthorityPair,
  isCurrentTailCandidateAdmissionPair,
  publishAuthenticatedDiscoveryEvidence,
  reserveCurrentTailCandidateResponse,
  revokeCurrentTailCandidateAdmissionHandle,
  revokeAuthenticatedDiscoveryEvidence,
  rollbackCurrentTailCandidateResponse
} from './routed-candidate.js'
import {
  decodeRelayCapabilityAdvertisement,
  digestRelayCapabilityAdvertisement
} from './relay-capability.js'

export const ADMITTED_LIMITS_SIZE = 26
export const EXTENDED_SIZE = 494
export const EXTEND_REQUEST_MIN_SIZE = 466
export const EXTEND_REQUEST_MAX_SIZE = 754
export const RELAY_DISCOVER_SIZE = 77
export const TAIL_CONTROL_TRANSCRIPT_SIZE = 290
export const TAIL_READY_SIZE = 282

const MAX_UINT32 = 0xffff_ffff
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn
const TAIL_DOMAIN = b4a.from('hyperdht-private-routes/tail-control/transcript/v1')
const LIMITS_DOMAIN = b4a.from('hyperdht-private-routes/tail-control/limits/v1')
const TAIL_DIGEST_DOMAIN = b4a.from('hyperdht-private-routes/final-exit/tail-digest/v1')
const TAIL_READY_DOMAIN = b4a.from('hyperdht-private-routes/m3/tail-ready/v1')
const TAIL_READY_TRANSCRIPT_DOMAIN = b4a.from(
  'hyperdht-private-routes/m3/tail-control/transcript-digest/v1'
)
const TAIL_READY_BODY_SIZE = 210
const RELAY_DISCOVER_BODY_SIZE = 69
const EXTEND_REQUEST_FIXED_BODY_SIZE = 198
const EXTENDED_BODY_SIZE = 486
const REDACTED_RESPONDER_PROOF_SIZE = 378
const RELAY_DISCOVER_DEADLINE_MS = 5_000n
const MAX_RELAY_DISCOVER_REQUESTS = 3
const MAX_RELAY_DISCOVER_RESPONSE = 4_449
const CORE_FRAGMENT_BODY_SIZE = 48
const ROUTED_FRAGMENT_DATA = 1_017
const MAX_ROUTED_RESPONSE_FRAGMENTS = 5
const MAX_RESPONSE_REASSEMBLIES = 3
const RESPONSE_MODE_NONE = 0
const RESPONSE_MODE_FRAGMENT = 1
const RESPONSE_MODE_DIRECT = 2
const CORE_FRAGMENT_DOMAIN = b4a.from('hyperdht-private-routes/m3/core-fragment/object/v1')
const RELAY_DISCOVER_NONCE_DOMAIN = b4a.from(
  'hyperdht-private-routes/m3/tail-control/discovery-nonce/v1'
)
const ROUTE_FRAME_SIZE = 1100
const ROUTE_PLAINTEXT_SIZE = 1076
const MAX_ROUTE_PAYLOAD = 1073
const AEAD_TAG_SIZE = 16
const SESSIONS = new WeakMap()
const DESTROYED_SESSIONS = new WeakSet()
const ADMITTED_EXTEND_REQUESTS = new WeakMap()
const CLIENT_EXTENSION_COMPLETIONS = new WeakMap()
const SPENT_CLIENT_EXTENSION_COMPLETIONS = new WeakSet()
const bufferByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const bufferFill = Uint8Array.prototype.fill
const bufferSet = Uint8Array.prototype.set
const bufferSubarray = Uint8Array.prototype.subarray

const TAIL_LABELS = Object.freeze({
  forwardKey: 'hyperdht-private-routes/kdf/v1/tail-control/forward-key',
  reverseKey: 'hyperdht-private-routes/kdf/v1/tail-control/reverse-key',
  forwardNonce: 'hyperdht-private-routes/kdf/v1/tail-control/forward-nonce',
  reverseNonce: 'hyperdht-private-routes/kdf/v1/tail-control/reverse-nonce'
})

const FINALIZE_LABELS = Object.freeze({
  finalizeForwardKey: 'hyperdht-private-routes/kdf/v1/tail-finalize/forward-key',
  finalizeReverseKey: 'hyperdht-private-routes/kdf/v1/tail-finalize/reverse-key',
  finalizeForwardNonce: 'hyperdht-private-routes/kdf/v1/tail-finalize/forward-nonce',
  finalizeReverseNonce: 'hyperdht-private-routes/kdf/v1/tail-finalize/reverse-nonce'
})

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function busy() {
  throw PrivateRouteError.ERR_BUSY()
}

function replay() {
  throw PrivateRouteError.ERR_REPLAY()
}

function authentication() {
  throw PrivateRouteError.ERR_AUTHENTICATION()
}

function object(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value
}

function option(value, name) {
  try {
    return value[name]
  } catch {
    invalid()
  }
}

function fixed(value, size) {
  return bufferLength(value) === size
}

function bufferLength(value) {
  try {
    return b4a.isBuffer(value) ? bufferByteLength.call(value) : -1
  } catch {
    return -1
  }
}

function set(target, source, offset = 0) {
  try {
    bufferSet.call(target, source, offset)
  } catch {
    invalid()
  }
}

function subarray(value, start, end) {
  try {
    return bufferSubarray.call(value, start, end)
  } catch {
    invalid()
  }
}

function copy(value, size = bufferLength(value)) {
  let output = null
  try {
    if (size < 0 || !fixed(value, size)) invalid()
    output = b4a.allocUnsafeSlow(size)
    if (!fixed(output, size)) invalid()
    set(output, value)
    return output
  } catch (err) {
    clear(output)
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalid()
  }
}

function uint16(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff
}

function uint32(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_UINT32
}

function relayCapabilityMask(value) {
  const known =
    RELAY_CAPABILITY.CIRCUIT_RELAY_V1 |
    RELAY_CAPABILITY.DHT_EXIT_V1 |
    RELAY_CAPABILITY.PRIVATE_RECORDS_V1
  if (!uint32(value) || value === 0 || value & ~known) {
    invalid()
  }
  return value
}

function uint64(value) {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_UINT64
}

function branchClass(value) {
  if (value !== BRANCH_CLASS.LOOKUP && value !== BRANCH_CLASS.ANNOUNCE) invalid()
  return value
}

function extensionIndex(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2) invalid()
  return value
}

function nextExtensionIndex(value) {
  value = extensionIndex(value)
  if (value === 0) invalid()
  return value
}

function nonzero(value) {
  const length = bufferLength(value)
  if (length < 1) return false
  for (let index = 0; index < length; index++) if (value[index] !== 0) return true
  return false
}

function writeUint16(buffer, value, offset) {
  buffer[offset] = value >>> 8
  buffer[offset + 1] = value
}

function writeUint32(buffer, value, offset) {
  buffer[offset] = value >>> 24
  buffer[offset + 1] = value >>> 16
  buffer[offset + 2] = value >>> 8
  buffer[offset + 3] = value
}

function writeUint64(buffer, value, offset) {
  for (let index = offset + 7; index >= offset; index--) {
    buffer[index] = Number(value & 0xffn)
    value >>= 8n
  }
}

function readUint16(buffer, offset) {
  return (buffer[offset] << 8) | buffer[offset + 1]
}

function readUint32(buffer, offset) {
  return (
    buffer[offset] * 0x1000000 +
    (buffer[offset + 1] << 16) +
    (buffer[offset + 2] << 8) +
    buffer[offset + 3]
  )
}

function readUint64(buffer, offset) {
  let value = 0n
  for (let index = offset; index < offset + 8; index++) {
    value = (value << 8n) | BigInt(buffer[index])
  }
  return value
}

function clear(buffer) {
  try {
    if (b4a.isBuffer(buffer)) bufferFill.call(buffer, 0)
  } catch {
    // Best-effort zeroization only.
  }
}

function clearRelayDiscover(value) {
  if (!value) return
  for (const field of [
    'randomTarget',
    'queryNonce',
    'branchId',
    'circuitId',
    'currentTailIdentity',
    'currentTailAdvertisementDigest'
  ]) {
    clear(value[field])
    try {
      value[field] = null
    } catch {}
  }
  try {
    value.requestedCapabilityMask = 0
    value.maximumResults = 0
    value.branchClass = -1
    value.generation = 0n
    value.currentExtensionIndex = -1
    value.extensionIndex = -1
    value.requiredRole = -1
    value.localAdmissionDeadline = 0n
    value.tailExpiresAt = 0n
  } catch {}
}

function clearRelayDiscoverResponse(value) {
  if (!value) return
  clear(value.queryNonce)
  if (Array.isArray(value.advertisements)) {
    for (const advertisement of value.advertisements) clear(advertisement)
  }
}

function encodeRequestedLimits(value) {
  value = object(value)
  const cellSize = option(value, 'cellSize')
  const maxCells = option(value, 'maxCells')
  const maxBytes = option(value, 'maxBytes')
  const maxCommands = option(value, 'maxCommands')
  const idleTimeoutMs = option(value, 'idleTimeoutMs')
  const expiresAtMs = option(value, 'expiresAtMs')
  if (
    cellSize !== 1200 ||
    !uint32(maxCells) ||
    maxCells === 0 ||
    !uint32(maxBytes) ||
    maxBytes === 0 ||
    !uint32(maxCommands) ||
    maxCommands === 0 ||
    !uint32(idleTimeoutMs) ||
    idleTimeoutMs === 0 ||
    !uint64(expiresAtMs) ||
    expiresAtMs === 0n
  ) {
    invalid()
  }
  let encoded = null
  let complete = false
  try {
    encoded = b4a.allocUnsafeSlow(ADMITTED_LIMITS_SIZE)
    if (!fixed(encoded, ADMITTED_LIMITS_SIZE)) invalid()
    writeUint16(encoded, cellSize, 0)
    writeUint32(encoded, maxCells, 2)
    writeUint32(encoded, maxBytes, 6)
    writeUint32(encoded, maxCommands, 10)
    writeUint32(encoded, idleTimeoutMs, 14)
    writeUint64(encoded, expiresAtMs, 18)
    complete = true
    return encoded
  } finally {
    if (!complete) clear(encoded)
  }
}

function decodeRequestedLimits(encoded) {
  if (!fixed(encoded, ADMITTED_LIMITS_SIZE)) invalid()
  const value = Object.freeze({
    cellSize: readUint16(encoded, 0),
    maxCells: readUint32(encoded, 2),
    maxBytes: readUint32(encoded, 6),
    maxCommands: readUint32(encoded, 10),
    idleTimeoutMs: readUint32(encoded, 14),
    expiresAtMs: readUint64(encoded, 18)
  })
  const canonical = encodeRequestedLimits(value)
  clear(canonical)
  return value
}

function assertNestedObject(encoded, messageId, bodySize, authSize) {
  const nested = decodeM3Object(encoded)
  try {
    if (
      nested.messageId !== messageId ||
      !fixed(nested.body, bodySize) ||
      !fixed(nested.authSuffix, authSize)
    ) {
      invalid()
    }
  } finally {
    clear(nested.body)
    clear(nested.authSuffix)
  }
}

function clearExtendRequest(value) {
  if (!value) return
  for (const field of [
    'branchId',
    'circuitId',
    'advertisement',
    'clientTailEphemeralPublicKey',
    'clientNonce',
    'payloadParametersDigest',
    'extensionNonce'
  ]) {
    clear(value[field])
    try {
      value[field] = null
    } catch {}
  }
  try {
    value.generation = 0n
    value.extensionIndex = -1
    value.branchClass = -1
  } catch {}
}

function clearAdmittedExtendRequest(record) {
  if (!record) return
  try {
    if (!Object.prototype.hasOwnProperty.call(record, 'status')) return
  } catch {
    return
  }
  if (record.capability) ADMITTED_EXTEND_REQUESTS.delete(record.capability)
  clearExtendRequest(record.request)
  clear(record.currentTailIdentity)
  clear(record.currentTailAdvertisementDigest)
  record.capability = null
  record.request = null
  record.currentTailIdentity = null
  record.currentTailAdvertisementDigest = null
  record.session = null
  record.status = 'DESTROYED'
  record.deadline = 0n
  record.key = null
  record.extensionNonce = null
}

function clearAdmittedExtendMaterial(value) {
  if (!value) return
  clearExtendRequest(value.request)
  clear(value.currentTailIdentity)
  clear(value.currentTailAdvertisementDigest)
  value.request = null
  value.currentTailIdentity = null
  value.currentTailAdvertisementDigest = null
  value.deadline = 0n
}

function clearBranchPathMaterial(value) {
  if (!value) return
  for (const field of [
    'advertisement',
    'advertisementDigest',
    'routeEncryptionPublicKey',
    'currentTailIdentity',
    'currentTailAdvertisementDigest',
    'branchId',
    'circuitId'
  ]) {
    clear(value[field])
    try {
      value[field] = null
    } catch {}
  }
  try {
    value.reservation = null
  } catch {}
}

function rollbackClientExtension(record) {
  if (!record) return false
  const authorization = record.authorization
  record.authorization = null
  const reservation = record.reservation
  record.reservation = null
  if (authorization) {
    try {
      failBranchPathAuthorization(authorization)
    } catch {}
  } else if (reservation) {
    try {
      failBranchPathReservation(reservation)
    } catch {}
  }
  for (const field of [
    'advertisementDigest',
    'routeEncryptionPublicKey',
    'relayIdentity',
    'branchId',
    'circuitId',
    'currentTailIdentity',
    'currentTailAdvertisementDigest',
    'clientTailEphemeralPublicKey',
    'clientTailEphemeralSecretKey',
    'clientNonce',
    'extensionNonce'
  ]) {
    clear(record[field])
    record[field] = null
  }
  record.generation = 0n
  record.extensionIndex = -1
  record.deadline = 0n
  record.requestedExpiresAt = 0n
  return true
}

function destroyClientExtensionCompletionState(state) {
  if (!state || state.destroyed) return false
  state.destroyed = true
  try {
    if (state.session) state.session.destroy()
  } catch {}
  state.session = null
  if (state.reservation) {
    try {
      failBranchPathReservation(state.reservation)
    } catch {}
  }
  state.reservation = null
  return true
}

function createClientExtensionCompletion(session, reservation) {
  const completion = Object.freeze({})
  CLIENT_EXTENSION_COMPLETIONS.set(completion, { session, reservation, destroyed: false })
  return completion
}

function publishAdmittedExtendRequest(state, session, request, key, deadline) {
  const record = {
    capability: null,
    request: null,
    currentTailIdentity: null,
    currentTailAdvertisementDigest: null,
    session,
    status: 'LIVE',
    deadline,
    key,
    extensionNonce: responseFragmentKey(request.extensionNonce)
  }
  let complete = false
  try {
    record.currentTailIdentity = copy(state.transcript.tailIdentity, 32)
    record.currentTailAdvertisementDigest = copy(state.transcript.candidateAdvertisementDigest, 32)
    record.capability = Object.freeze({})
    record.request = request
    ADMITTED_EXTEND_REQUESTS.set(record.capability, record)
    state.extensionRequest = record
    complete = true
    return record.capability
  } finally {
    if (!complete) clearAdmittedExtendRequest(record)
  }
}

export function encodeExtendRequest(value) {
  value = object(value)
  let branchId = null
  let circuitId = null
  let advertisement = null
  let clientTailEphemeralPublicKey = null
  let clientNonce = null
  let payloadParametersDigest = null
  let requestedLimits = null
  let extensionNonce = null
  let body = null
  try {
    const selectedBranchClass = branchClass(option(value, 'branchClass'))
    branchId = copy(option(value, 'branchId'), 16)
    circuitId = copy(option(value, 'circuitId'), 16)
    const generation = option(value, 'generation')
    const selectedExtensionIndex = nextExtensionIndex(option(value, 'extensionIndex'))
    const suppliedAdvertisement = option(value, 'advertisement')
    const advertisementLength = bufferLength(suppliedAdvertisement)
    if (advertisementLength < 260 || advertisementLength > 548) invalid()
    advertisement = copy(suppliedAdvertisement, advertisementLength)
    clientTailEphemeralPublicKey = copy(option(value, 'clientTailEphemeralPublicKey'), 32)
    clientNonce = copy(option(value, 'clientNonce'), 32)
    payloadParametersDigest = copy(option(value, 'payloadParametersDigest'), 32)
    requestedLimits = encodeRequestedLimits(option(value, 'requestedLimits'))
    extensionNonce = copy(option(value, 'extensionNonce'), 32)
    if (
      !fixed(branchId, 16) ||
      !fixed(circuitId, 16) ||
      !uint64(generation) ||
      generation === 0n ||
      !nonzero(branchId) ||
      !nonzero(circuitId) ||
      !nonzero(clientTailEphemeralPublicKey) ||
      !nonzero(clientNonce) ||
      !nonzero(payloadParametersDigest) ||
      !nonzero(extensionNonce)
    ) {
      invalid()
    }
    assertNestedObject(
      advertisement,
      M3_MESSAGE_ID.CAPABILITY_ADVERTISEMENT_V1,
      bufferLength(advertisement) - 72,
      64
    )
    body = b4a.allocUnsafeSlow(EXTEND_REQUEST_FIXED_BODY_SIZE + bufferLength(advertisement))
    if (!fixed(body, EXTEND_REQUEST_FIXED_BODY_SIZE + bufferLength(advertisement))) invalid()
    body[0] = selectedBranchClass
    set(body, branchId, 1)
    set(body, circuitId, 17)
    writeUint64(body, generation, 33)
    body[41] = selectedExtensionIndex
    writeUint16(body, advertisement.byteLength, 42)
    set(body, advertisement, 44)
    let offset = 44 + advertisement.byteLength
    for (const encoded of [
      clientTailEphemeralPublicKey,
      clientNonce,
      payloadParametersDigest,
      requestedLimits,
      extensionNonce
    ]) {
      set(body, encoded, offset)
      offset += encoded.byteLength
    }
    return encodeM3Object({ messageId: M3_MESSAGE_ID.EXTEND_REQUEST_V1, body })
  } finally {
    for (const encoded of [
      branchId,
      circuitId,
      advertisement,
      clientTailEphemeralPublicKey,
      clientNonce,
      payloadParametersDigest,
      requestedLimits,
      extensionNonce,
      body
    ]) {
      clear(encoded)
    }
  }
}

export function decodeExtendRequest(encoded) {
  const object = decodeM3Object(encoded)
  let result = null
  let complete = false
  try {
    if (
      bufferLength(encoded) < EXTEND_REQUEST_MIN_SIZE ||
      bufferLength(encoded) > EXTEND_REQUEST_MAX_SIZE ||
      object.messageId !== M3_MESSAGE_ID.EXTEND_REQUEST_V1 ||
      bufferLength(object.authSuffix) !== 0 ||
      bufferLength(object.body) < EXTEND_REQUEST_FIXED_BODY_SIZE + 260
    ) {
      invalid()
    }
    const body = object.body
    const advertisementLength = readUint16(body, 42)
    if (
      advertisementLength < 260 ||
      advertisementLength > 548 ||
      bufferLength(body) !== EXTEND_REQUEST_FIXED_BODY_SIZE + advertisementLength
    ) {
      invalid()
    }
    const advertisement = subarray(body, 44, 44 + advertisementLength)
    assertNestedObject(
      advertisement,
      M3_MESSAGE_ID.CAPABILITY_ADVERTISEMENT_V1,
      advertisementLength - 72,
      64
    )
    let offset = 44 + advertisementLength
    result = {}
    result.branchClass = branchClass(body[0])
    result.branchId = copy(subarray(body, 1, 17), 16)
    result.circuitId = copy(subarray(body, 17, 33), 16)
    result.generation = readUint64(body, 33)
    result.extensionIndex = nextExtensionIndex(body[41])
    result.advertisement = copy(advertisement, advertisementLength)
    result.clientTailEphemeralPublicKey = copy(subarray(body, offset, offset + 32), 32)
    result.clientNonce = copy(subarray(body, offset + 32, offset + 64), 32)
    result.payloadParametersDigest = copy(subarray(body, offset + 64, offset + 96), 32)
    result.requestedLimits = decodeRequestedLimits(subarray(body, offset + 96, offset + 122))
    result.extensionNonce = copy(subarray(body, offset + 122, offset + 154), 32)
    if (
      result.generation === 0n ||
      !nonzero(result.branchId) ||
      !nonzero(result.circuitId) ||
      !nonzero(result.clientTailEphemeralPublicKey) ||
      !nonzero(result.clientNonce) ||
      !nonzero(result.payloadParametersDigest) ||
      !nonzero(result.extensionNonce)
    ) {
      invalid()
    }
    complete = true
    return Object.freeze(result)
  } finally {
    clear(object.body)
    clear(object.authSuffix)
    if (!complete) clearExtendRequest(result)
  }
}

function clearExtended(value) {
  if (!value) return
  for (const field of [
    'branchId',
    'circuitId',
    'responderAdvertisementDigest',
    'redactedProof',
    'extensionNonce'
  ]) {
    clear(value[field])
    try {
      value[field] = null
    } catch {}
  }
  try {
    value.generation = 0n
    value.extensionIndex = -1
    value.branchClass = -1
  } catch {}
}

export function encodeExtended(value) {
  value = object(value)
  let branchId = null
  let circuitId = null
  let responderAdvertisementDigest = null
  let redactedProof = null
  let extensionNonce = null
  let body = null
  try {
    const selectedBranchClass = branchClass(option(value, 'branchClass'))
    branchId = copy(option(value, 'branchId'), 16)
    circuitId = copy(option(value, 'circuitId'), 16)
    const generation = option(value, 'generation')
    const selectedExtensionIndex = nextExtensionIndex(option(value, 'extensionIndex'))
    responderAdvertisementDigest = copy(option(value, 'responderAdvertisementDigest'), 32)
    redactedProof = copy(option(value, 'redactedProof'), REDACTED_RESPONDER_PROOF_SIZE)
    extensionNonce = copy(option(value, 'extensionNonce'), 32)
    if (
      !fixed(branchId, 16) ||
      !fixed(circuitId, 16) ||
      !uint64(generation) ||
      generation === 0n ||
      !nonzero(branchId) ||
      !nonzero(circuitId) ||
      !nonzero(responderAdvertisementDigest) ||
      !nonzero(extensionNonce)
    ) {
      invalid()
    }
    assertNestedObject(redactedProof, M3_MESSAGE_ID.REDACTED_RESPONDER_PROOF_V1, 306, 64)
    body = b4a.allocUnsafeSlow(EXTENDED_BODY_SIZE)
    if (!fixed(body, EXTENDED_BODY_SIZE)) invalid()
    body[0] = selectedBranchClass
    set(body, branchId, 1)
    set(body, circuitId, 17)
    writeUint64(body, generation, 33)
    body[41] = selectedExtensionIndex
    set(body, responderAdvertisementDigest, 42)
    writeUint16(body, REDACTED_RESPONDER_PROOF_SIZE, 74)
    set(body, redactedProof, 76)
    set(body, extensionNonce, 454)
    return encodeM3Object({ messageId: M3_MESSAGE_ID.EXTENDED_V1, body })
  } finally {
    for (const encoded of [
      branchId,
      circuitId,
      responderAdvertisementDigest,
      redactedProof,
      extensionNonce,
      body
    ]) {
      clear(encoded)
    }
  }
}

export function decodeExtended(encoded) {
  const object = decodeM3Object(encoded)
  let result = null
  let complete = false
  try {
    if (
      !fixed(encoded, EXTENDED_SIZE) ||
      object.messageId !== M3_MESSAGE_ID.EXTENDED_V1 ||
      !fixed(object.body, EXTENDED_BODY_SIZE) ||
      bufferLength(object.authSuffix) !== 0 ||
      readUint16(object.body, 74) !== REDACTED_RESPONDER_PROOF_SIZE
    ) {
      invalid()
    }
    const proof = subarray(object.body, 76, 454)
    assertNestedObject(proof, M3_MESSAGE_ID.REDACTED_RESPONDER_PROOF_V1, 306, 64)
    result = {}
    result.branchClass = branchClass(object.body[0])
    result.branchId = copy(subarray(object.body, 1, 17), 16)
    result.circuitId = copy(subarray(object.body, 17, 33), 16)
    result.generation = readUint64(object.body, 33)
    result.extensionIndex = nextExtensionIndex(object.body[41])
    result.responderAdvertisementDigest = copy(subarray(object.body, 42, 74), 32)
    result.redactedProof = copy(proof, REDACTED_RESPONDER_PROOF_SIZE)
    result.extensionNonce = copy(subarray(object.body, 454, 486), 32)
    if (
      result.generation === 0n ||
      !nonzero(result.branchId) ||
      !nonzero(result.circuitId) ||
      !nonzero(result.responderAdvertisementDigest) ||
      !nonzero(result.extensionNonce)
    ) {
      invalid()
    }
    complete = true
    return Object.freeze(result)
  } finally {
    clear(object.body)
    clear(object.authSuffix)
    if (!complete) clearExtended(result)
  }
}

function encodeRoutedResponseObjects(encoded) {
  const totalObjectBytes = bufferLength(encoded)
  if (totalObjectBytes < 49 || totalObjectBytes > MAX_RELAY_DISCOVER_RESPONSE) invalid()
  if (totalObjectBytes <= MAX_ROUTE_PAYLOAD) return [encoded]
  const fragmentCount = Math.ceil(totalObjectBytes / ROUTED_FRAGMENT_DATA)
  if (fragmentCount < 2 || fragmentCount > MAX_ROUTED_RESPONSE_FRAGMENTS) invalid()
  let digest = null
  let body = null
  const objects = []
  try {
    digest = cryptoSuite.hash([CORE_FRAGMENT_DOMAIN, encoded])
    if (!fixed(digest, 32)) invalid()
    for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex++) {
      const fragmentOffset = fragmentIndex * ROUTED_FRAGMENT_DATA
      const fragmentDataBytes = Math.min(ROUTED_FRAGMENT_DATA, totalObjectBytes - fragmentOffset)
      body = b4a.allocUnsafeSlow(CORE_FRAGMENT_BODY_SIZE + fragmentDataBytes)
      if (!fixed(body, CORE_FRAGMENT_BODY_SIZE + fragmentDataBytes)) invalid()
      writeUint16(body, M3_MESSAGE_ID.RELAY_DISCOVER_RESPONSE_V1, 0)
      set(body, digest, 2)
      writeUint32(body, totalObjectBytes, 34)
      writeUint16(body, fragmentIndex, 38)
      writeUint16(body, fragmentCount, 40)
      writeUint32(body, fragmentOffset, 42)
      writeUint16(body, fragmentDataBytes, 46)
      set(body, subarray(encoded, fragmentOffset, fragmentOffset + fragmentDataBytes), 48)
      objects.push(encodeM3Object({ messageId: M3_MESSAGE_ID.CORE_FRAGMENT_V1, body }))
      clear(body)
      body = null
    }
    return objects
  } catch (err) {
    for (const object of objects) clear(object)
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    clear(digest)
    clear(body)
  }
}

export function encodeRelayDiscoverRequest(value) {
  let randomTarget = null
  let queryNonce = null
  let body = null
  try {
    object(value)
    const requestedCapabilityMask = relayCapabilityMask(option(value, 'requestedCapabilityMask'))
    randomTarget = copy(option(value, 'randomTarget'))
    queryNonce = copy(option(value, 'queryNonce'))
    const maximumResults = option(value, 'maximumResults')
    if (
      !fixed(randomTarget, 32) ||
      !fixed(queryNonce, 32) ||
      !Number.isSafeInteger(maximumResults) ||
      maximumResults < 1 ||
      maximumResults > 8
    ) {
      invalid()
    }
    body = b4a.allocUnsafeSlow(RELAY_DISCOVER_BODY_SIZE)
    if (!fixed(body, RELAY_DISCOVER_BODY_SIZE)) invalid()
    writeUint32(body, requestedCapabilityMask, 0)
    set(body, randomTarget, 4)
    set(body, queryNonce, 36)
    body[68] = maximumResults
    return encodeM3Object({ messageId: M3_MESSAGE_ID.RELAY_DISCOVER_V1, body })
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalid()
  } finally {
    clear(randomTarget)
    clear(queryNonce)
    clear(body)
  }
}

export function decodeRelayDiscoverRequest(encoded) {
  let decoded = null
  let result = null
  try {
    if (!fixed(encoded, RELAY_DISCOVER_SIZE)) invalid()
    decoded = decodeM3Object(encoded)
    if (
      decoded.messageId !== M3_MESSAGE_ID.RELAY_DISCOVER_V1 ||
      !fixed(decoded.body, RELAY_DISCOVER_BODY_SIZE) ||
      bufferLength(decoded.authSuffix) !== 0
    ) {
      invalid()
    }
    const requestedCapabilityMask = relayCapabilityMask(readUint32(decoded.body, 0))
    const maximumResults = decoded.body[68]
    if (maximumResults < 1 || maximumResults > 8) invalid()
    result = {
      requestedCapabilityMask,
      randomTarget: null,
      queryNonce: null,
      maximumResults
    }
    result.randomTarget = copy(subarray(decoded.body, 4, 36))
    result.queryNonce = copy(subarray(decoded.body, 36, 68))
    return result
  } catch (err) {
    clearRelayDiscover(result)
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalid()
  } finally {
    if (decoded) {
      clear(decoded.body)
      clear(decoded.authSuffix)
    }
  }
}

export function encodeAdmittedLimits(value) {
  try {
    object(value)
    const cellSize = option(value, 'cellSize')
    const maxCells = option(value, 'maxCells')
    const maxBytes = option(value, 'maxBytes')
    const maxCommands = option(value, 'maxCommands')
    const idleTimeoutMs = option(value, 'idleTimeoutMs')
    const expiresAtMs = option(value, 'expiresAtMs')

    if (
      cellSize !== 1200 ||
      !uint16(cellSize) ||
      !uint32(maxCells) ||
      maxCells === 0 ||
      !uint32(maxBytes) ||
      maxBytes === 0 ||
      !uint32(maxCommands) ||
      maxCommands === 0 ||
      !uint32(idleTimeoutMs) ||
      idleTimeoutMs === 0 ||
      !uint64(expiresAtMs) ||
      expiresAtMs === 0n
    ) {
      invalid()
    }

    const output = b4a.allocUnsafe(ADMITTED_LIMITS_SIZE)
    writeUint16(output, cellSize, 0)
    writeUint32(output, maxCells, 2)
    writeUint32(output, maxBytes, 6)
    writeUint32(output, maxCommands, 10)
    writeUint32(output, idleTimeoutMs, 14)
    writeUint64(output, expiresAtMs, 18)
    return output
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalid()
  }
}

export function decodeAdmittedLimits(encoded) {
  if (!fixed(encoded, ADMITTED_LIMITS_SIZE)) invalid()
  const value = {
    cellSize: readUint16(encoded, 0),
    maxCells: readUint32(encoded, 2),
    maxBytes: readUint32(encoded, 6),
    maxCommands: readUint32(encoded, 10),
    idleTimeoutMs: readUint32(encoded, 14),
    expiresAtMs: readUint64(encoded, 18)
  }
  const canonical = encodeAdmittedLimits(value)
  clear(canonical)
  return value
}

export function digestAdmittedLimits(value) {
  const encoded = encodeAdmittedLimits(value)
  try {
    return copy(cryptoSuite.hash([LIMITS_DOMAIN, encoded]))
  } finally {
    clear(encoded)
  }
}

export function encodeTailControlTranscript(value) {
  try {
    object(value)
    const selectedBranchClass = branchClass(option(value, 'branchClass'))
    const branchId = option(value, 'branchId')
    const circuitId = option(value, 'circuitId')
    const generation = option(value, 'generation')
    const selectedExtensionIndex = extensionIndex(option(value, 'extensionIndex'))
    const clientTailEphemeralPublicKey = option(value, 'clientTailEphemeralPublicKey')
    const advertisedTailRouteEncryptionPublicKey = option(
      value,
      'advertisedTailRouteEncryptionPublicKey'
    )
    const candidateAdvertisementDigest = option(value, 'candidateAdvertisementDigest')
    const clientNonce = option(value, 'clientNonce')
    const tailIdentity = option(value, 'tailIdentity')
    const admittedLimitsDigest = option(value, 'admittedLimitsDigest')

    if (
      !fixed(branchId, 16) ||
      !fixed(circuitId, 16) ||
      !uint64(generation) ||
      !fixed(clientTailEphemeralPublicKey, 32) ||
      !fixed(advertisedTailRouteEncryptionPublicKey, 32) ||
      !fixed(candidateAdvertisementDigest, 32) ||
      !fixed(clientNonce, 32) ||
      !fixed(tailIdentity, 32) ||
      !fixed(admittedLimitsDigest, 32)
    ) {
      invalid()
    }

    const output = b4a.allocUnsafe(TAIL_CONTROL_TRANSCRIPT_SIZE)
    let offset = 0
    const tailDomainBytes = bufferLength(TAIL_DOMAIN)
    writeUint16(output, tailDomainBytes, offset)
    offset += 2
    set(output, TAIL_DOMAIN, offset)
    offset += tailDomainBytes
    writeUint32(output, M3_PROTOCOL_VERSION, offset)
    offset += 4
    output[offset++] = selectedBranchClass
    set(output, branchId, offset)
    offset += 16
    set(output, circuitId, offset)
    offset += 16
    writeUint64(output, generation, offset)
    offset += 8
    output[offset++] = selectedExtensionIndex
    for (const field of [
      clientTailEphemeralPublicKey,
      advertisedTailRouteEncryptionPublicKey,
      candidateAdvertisementDigest,
      clientNonce,
      tailIdentity,
      admittedLimitsDigest
    ]) {
      set(output, field, offset)
      offset += 32
    }
    return output
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalid()
  }
}

function validateTailControlTranscript(encoded) {
  if (!fixed(encoded, TAIL_CONTROL_TRANSCRIPT_SIZE)) invalid()
  const tailDomainBytes = bufferLength(TAIL_DOMAIN)
  if (readUint16(encoded, 0) !== tailDomainBytes) invalid()
  if (!b4a.equals(subarray(encoded, 2, 2 + tailDomainBytes), TAIL_DOMAIN)) invalid()

  let offset = 2 + tailDomainBytes
  if (readUint32(encoded, offset) !== M3_PROTOCOL_VERSION) invalid()
  offset += 4
  branchClass(encoded[offset++])
  offset += 16 + 16 + 8
  return extensionIndex(encoded[offset])
}

export function decodeTailControlTranscript(encoded) {
  try {
    validateTailControlTranscript(encoded)
    const tailDomainBytes = bufferLength(TAIL_DOMAIN)
    let offset = 2 + tailDomainBytes
    offset += 4
    const selectedBranchClass = encoded[offset++]
    const branchId = copy(subarray(encoded, offset, offset + 16))
    offset += 16
    const circuitId = copy(subarray(encoded, offset, offset + 16))
    offset += 16
    const generation = readUint64(encoded, offset)
    offset += 8
    const selectedExtensionIndex = encoded[offset++]
    const fields = []
    for (let index = 0; index < 6; index++) {
      fields.push(copy(subarray(encoded, offset, offset + 32)))
      offset += 32
    }

    return {
      branchClass: selectedBranchClass,
      branchId,
      circuitId,
      generation,
      extensionIndex: selectedExtensionIndex,
      clientTailEphemeralPublicKey: fields[0],
      advertisedTailRouteEncryptionPublicKey: fields[1],
      candidateAdvertisementDigest: fields[2],
      clientNonce: fields[3],
      tailIdentity: fields[4],
      admittedLimitsDigest: fields[5]
    }
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalid()
  }
}

export function digestTailControlTranscript(transcript) {
  validateTailControlTranscript(transcript)
  return copy(cryptoSuite.hash([TAIL_DIGEST_DOMAIN, transcript]))
}

function derive(secret, label, transcript) {
  let input = null
  let output = null
  try {
    const labelBytes = b4a.from(label)
    const labelLength = bufferLength(labelBytes)
    const transcriptLength = bufferLength(transcript)
    input = b4a.allocUnsafe(2 + labelLength + 4 + 4 + transcriptLength)
    writeUint16(input, labelLength, 0)
    set(input, labelBytes, 2)
    writeUint32(input, M3_PROTOCOL_VERSION, 2 + labelLength)
    writeUint32(input, transcriptLength, 6 + labelLength)
    set(input, transcript, 10 + labelLength)
    output = b4a.allocUnsafeSlow(32)
    sodium.crypto_generichash(output, input, secret)
    return output
  } catch {
    clear(output)
    invalid()
  } finally {
    clear(input)
  }
}

export function deriveTailControlTestVector(sharedSecret, transcript, selectedExtensionIndex) {
  if (!fixed(sharedSecret, 32)) invalid()
  const transcriptExtensionIndex = validateTailControlTranscript(transcript)
  if (extensionIndex(selectedExtensionIndex) !== transcriptExtensionIndex) invalid()

  const labels = selectedExtensionIndex === 2 ? { ...TAIL_LABELS, ...FINALIZE_LABELS } : TAIL_LABELS
  const result = {}
  const owned = []
  let complete = false

  try {
    for (const [name, label] of Object.entries(labels)) {
      const output = derive(sharedSecret, label, transcript)
      owned.push(output)
      if (name.endsWith('Nonce')) result[`${name}Prefix`] = copy(subarray(output, 0, 16))
      else result[name] = output
    }
    complete = true
    return Object.freeze(result)
  } finally {
    for (const output of owned) {
      if (!Object.values(result).includes(output) || !complete) clear(output)
    }
    if (!complete) {
      for (const output of Object.values(result)) clear(output)
    }
  }
}

function tailReadySignatureInput(body) {
  const output = b4a.allocUnsafeSlow(10 + TAIL_READY_DOMAIN.byteLength + body.byteLength)
  writeUint16(output, TAIL_READY_DOMAIN.byteLength, 0)
  set(output, TAIL_READY_DOMAIN, 2)
  writeUint32(output, M3_PROTOCOL_VERSION, 2 + TAIL_READY_DOMAIN.byteLength)
  writeUint16(output, M3_MESSAGE_ID.TAIL_READY_V1, 6 + TAIL_READY_DOMAIN.byteLength)
  writeUint16(output, body.byteLength, 8 + TAIL_READY_DOMAIN.byteLength)
  set(output, body, 10 + TAIL_READY_DOMAIN.byteLength)
  return output
}

function digestTailReadyTranscript(transcript) {
  let output = null
  try {
    output = cryptoSuite.hash([TAIL_READY_TRANSCRIPT_DOMAIN, transcript])
    if (!fixed(output, 32)) invalid()
    return copy(output)
  } finally {
    clear(output)
  }
}

function decodeTailReadyBody(body) {
  if (!fixed(body, TAIL_READY_BODY_SIZE)) invalid()
  return {
    branchClass: branchClass(body[0]),
    branchId: copy(subarray(body, 1, 17)),
    circuitId: copy(subarray(body, 17, 33)),
    generation: readUint64(body, 33),
    extensionIndex: extensionIndex(body[41]),
    tailControlTranscriptDigest: copy(subarray(body, 42, 74)),
    tailIdentity: copy(subarray(body, 74, 106)),
    tailAdvertisementDigest: copy(subarray(body, 106, 138)),
    clientNonce: copy(subarray(body, 138, 170)),
    readyNonce: copy(subarray(body, 170, 202)),
    expiresAtMs: readUint64(body, 202)
  }
}

function clearTailReady(value) {
  if (!value) return
  for (const child of Object.values(value)) clear(child)
}

export function decodeTailReady(encoded) {
  const object = decodeM3Object(encoded)
  if (
    !fixed(encoded, TAIL_READY_SIZE) ||
    object.messageId !== M3_MESSAGE_ID.TAIL_READY_V1 ||
    !fixed(object.body, TAIL_READY_BODY_SIZE) ||
    !fixed(object.authSuffix, 64)
  ) {
    clear(object.body)
    clear(object.authSuffix)
    invalid()
  }
  const decoded = decodeTailReadyBody(object.body)
  decoded.body = object.body
  decoded.signature = object.authSuffix
  decoded.encoded = copy(encoded)
  return decoded
}

function nowValue(now) {
  let current
  try {
    current = now()
  } catch {
    invalid()
  }
  if (Number.isSafeInteger(current) && current >= 0) return BigInt(current)
  if (uint64(current)) return current
  invalid()
}

function same(left, right) {
  try {
    return fixed(left, bufferLength(right)) && b4a.equals(left, right)
  } catch {
    return false
  }
}

function writeFrameCounter(frame, value) {
  writeUint64(frame, value, 0)
}

function readFrameCounter(frame) {
  return readUint64(frame, 0)
}

function frameAssociatedData(state, direction, counter) {
  return encodeM3ContextAD({
    contextClass: CONTEXT_CLASS.TAIL_CONTROL_ORDERED,
    branchId: state.transcript.branchId,
    circuitId: state.transcript.circuitId,
    generation: state.transcript.generation,
    direction,
    innerCounter: counter
  })
}

function discoveryNonceKey(queryNonce) {
  let digest = null
  try {
    digest = cryptoSuite.hash([RELAY_DISCOVER_NONCE_DOMAIN, queryNonce])
    if (!fixed(digest, 32)) invalid()
    return b4a.toString(digest, 'hex')
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    clear(digest)
  }
}

function clearDiscoveryRecord(record) {
  if (!record) return
  clear(record.randomTarget)
  clear(record.queryNonce)
  clear(record.responseDigest)
  record.randomTarget = null
  record.queryNonce = null
  record.responseDigest = null
  record.deadline = 0n
  record.requestedCapabilityMask = 0
  record.maximumResults = 0
  record.responseMode = RESPONSE_MODE_NONE
}

function clearResponseReassembly(reassembly) {
  if (!reassembly) return
  clear(reassembly.bytes)
  clear(reassembly.digest)
  reassembly.bytes = null
  reassembly.digest = null
  reassembly.discoveryKey = null
  reassembly.totalObjectBytes = 0
  reassembly.fragmentCount = 0
  reassembly.nextFragmentIndex = 0
}

function clearResponseReassemblies(state) {
  if (!state.responseReassemblies) return
  for (const reassembly of state.responseReassemblies.values()) {
    clearResponseReassembly(reassembly)
  }
  state.responseReassemblies.clear()
  state.responseReassemblies = null
}

function clearDiscoveries(state) {
  if (state.discoveries) {
    for (const record of state.discoveries.values()) clearDiscoveryRecord(record)
    state.discoveries.clear()
  }
  if (state.discoveryNonces) state.discoveryNonces.clear()
  state.discoveries = null
  state.discoveryNonces = null
  state.discoveryAttempts = 0
}

function purgeExpiredDiscoveries(state, current) {
  for (const [key, record] of state.discoveries) {
    if (record.deadline > current) continue
    state.discoveries.delete(key)
    clearDiscoveryRecord(record)
    for (const [digestKey, reassembly] of state.responseReassemblies) {
      if (reassembly.discoveryKey !== key) continue
      state.responseReassemblies.delete(digestKey)
      clearResponseReassembly(reassembly)
    }
  }
}

function requiredDiscoveryMask(state) {
  if (state.transcript.extensionIndex === 0) return RELAY_CAPABILITY.CIRCUIT_RELAY_V1
  if (state.transcript.extensionIndex === 1) {
    return RELAY_CAPABILITY.CIRCUIT_RELAY_V1 | RELAY_CAPABILITY.DHT_EXIT_V1
  }
  invalid()
}

function registerDiscovery(state, request, current) {
  purgeExpiredDiscoveries(state, current)
  if (request.requestedCapabilityMask !== requiredDiscoveryMask(state)) invalid()
  if (state.discoveryAttempts >= MAX_RELAY_DISCOVER_REQUESTS) busy()
  const key = discoveryNonceKey(request.queryNonce)
  if (state.discoveryNonces.has(key)) replay()
  const deadline =
    current + RELAY_DISCOVER_DEADLINE_MS < state.expiresAt
      ? current + RELAY_DISCOVER_DEADLINE_MS
      : state.expiresAt
  const record = {
    requestedCapabilityMask: request.requestedCapabilityMask,
    randomTarget: null,
    queryNonce: null,
    maximumResults: request.maximumResults,
    responseMode: RESPONSE_MODE_NONE,
    responseDigest: null,
    deadline
  }
  try {
    record.randomTarget = copy(request.randomTarget)
    record.queryNonce = copy(request.queryNonce)
    state.discoveryNonces.add(key)
    state.discoveries.set(key, record)
    state.discoveryAttempts++
    return record
  } catch (err) {
    state.discoveryNonces.delete(key)
    state.discoveries.delete(key)
    clearDiscoveryRecord(record)
    if (err instanceof PrivateRouteError) throw err
    invalid()
  }
}

function findDiscovery(state, queryNonce) {
  const key = discoveryNonceKey(queryNonce)
  const record = state.discoveries.get(key)
  if (!record) authentication()
  return { key, record }
}

function consumeDiscovery(state, key) {
  const record = state.discoveries.get(key)
  if (!record) return false
  state.discoveries.delete(key)
  clearDiscoveryRecord(record)
  for (const [digestKey, reassembly] of state.responseReassemblies) {
    if (reassembly.discoveryKey !== key) continue
    state.responseReassemblies.delete(digestKey)
    clearResponseReassembly(reassembly)
  }
  return true
}

function clearCandidateAdmissionRecord(state, key, record, revoke = true) {
  if (!record) return
  if (revoke && record.admission) {
    try {
      revokeCurrentTailCandidateAdmissionHandle(state.candidateAdmissionConsumer, record.admission)
    } catch {}
  }
  if (key !== null && state.candidateAdmissions) state.candidateAdmissions.delete(key)
  record.admission = null
  record.deadline = 0n
}

function clearCandidateAdmissions(state) {
  if (!state.candidateAdmissions) return
  for (const [key, record] of state.candidateAdmissions) {
    clearCandidateAdmissionRecord(state, key, record)
  }
  state.candidateAdmissions.clear()
  state.candidateAdmissions = null
}

function purgeCandidateAdmissions(state, current) {
  for (const [key, record] of state.candidateAdmissions) {
    if (record.deadline > current) continue
    clearCandidateAdmissionRecord(state, key, record)
  }
}

function discoveryBinding(state, record) {
  return {
    queryNonce: record.queryNonce,
    randomTarget: record.randomTarget,
    requestedCapabilityMask: record.requestedCapabilityMask,
    maximumResults: record.maximumResults,
    currentTailIdentity: state.transcript.tailIdentity,
    currentTailAdvertisementDigest: state.transcript.candidateAdvertisementDigest,
    branchClass: state.transcript.branchClass,
    branchId: state.transcript.branchId,
    circuitId: state.transcript.circuitId,
    generation: state.transcript.generation,
    extensionIndex: state.transcript.extensionIndex + 1,
    requiredRole:
      state.transcript.extensionIndex === 0 ? M3_LINK_ROLE.SAFETY_RELAY : M3_LINK_ROLE.DHT_EXIT,
    requestDeadline: record.deadline,
    tailExpiresAt: state.expiresAt
  }
}

function responseFragmentKey(digest) {
  try {
    return b4a.toString(digest, 'hex')
  } catch {
    invalid()
  }
}

function acceptResponseFragment(state, encoded, current) {
  let decoded = null
  let created = null
  let inserted = false
  let complete = null
  let completeReturned = false
  let calculatedDigest = null
  try {
    decoded = decodeM3Object(encoded)
    const body = decoded.body
    if (
      decoded.messageId !== M3_MESSAGE_ID.CORE_FRAGMENT_V1 ||
      bufferLength(decoded.authSuffix) !== 0 ||
      bufferLength(body) < CORE_FRAGMENT_BODY_SIZE
    ) {
      invalid()
    }
    const objectMessageId = readUint16(body, 0)
    const objectDigest = subarray(body, 2, 34)
    const totalObjectBytes = readUint32(body, 34)
    const fragmentIndex = readUint16(body, 38)
    const fragmentCount = readUint16(body, 40)
    const fragmentOffset = readUint32(body, 42)
    const fragmentDataBytes = readUint16(body, 46)
    const expectedFragmentCount = Math.ceil(totalObjectBytes / ROUTED_FRAGMENT_DATA)
    const expectedFragmentBytes =
      fragmentIndex + 1 === fragmentCount ? totalObjectBytes - fragmentOffset : ROUTED_FRAGMENT_DATA
    if (
      objectMessageId !== M3_MESSAGE_ID.RELAY_DISCOVER_RESPONSE_V1 ||
      totalObjectBytes <= MAX_ROUTE_PAYLOAD ||
      totalObjectBytes > MAX_RELAY_DISCOVER_RESPONSE ||
      fragmentCount !== expectedFragmentCount ||
      fragmentCount < 2 ||
      fragmentCount > MAX_ROUTED_RESPONSE_FRAGMENTS ||
      fragmentIndex >= fragmentCount ||
      fragmentOffset !== fragmentIndex * ROUTED_FRAGMENT_DATA ||
      fragmentDataBytes !== expectedFragmentBytes ||
      fragmentDataBytes < 1 ||
      bufferLength(body) !== CORE_FRAGMENT_BODY_SIZE + fragmentDataBytes
    ) {
      invalid()
    }
    const key = responseFragmentKey(objectDigest)
    let reassembly = state.responseReassemblies.get(key)
    const data = subarray(body, CORE_FRAGMENT_BODY_SIZE)
    if (!reassembly) {
      if (
        fragmentIndex !== 0 ||
        state.responseReassemblies.size >= MAX_RESPONSE_REASSEMBLIES ||
        readUint32(data, 0) !== M3_PROTOCOL_VERSION ||
        readUint16(data, 4) !== M3_MESSAGE_ID.RELAY_DISCOVER_RESPONSE_V1 ||
        readUint16(data, 6) !== totalObjectBytes - 8
      ) {
        invalid()
      }
      const queryNonce = subarray(data, 8, 40)
      const found = findDiscovery(state, queryNonce)
      if (found.record.deadline <= current) authentication()
      if (found.record.responseMode === RESPONSE_MODE_NONE) {
        found.record.responseMode = RESPONSE_MODE_FRAGMENT
        found.record.responseDigest = copy(objectDigest)
      } else if (
        found.record.responseMode !== RESPONSE_MODE_FRAGMENT ||
        !same(found.record.responseDigest, objectDigest)
      ) {
        authentication()
      }
      created = {
        bytes: null,
        digest: null,
        discoveryKey: found.key,
        totalObjectBytes,
        fragmentCount,
        nextFragmentIndex: 0
      }
      created.bytes = b4a.allocUnsafeSlow(totalObjectBytes)
      if (!fixed(created.bytes, totalObjectBytes)) invalid()
      created.digest = copy(objectDigest)
      state.responseReassemblies.set(key, created)
      inserted = true
      reassembly = created
    }
    const discovery = state.discoveries.get(reassembly.discoveryKey)
    if (
      !discovery ||
      discovery.deadline <= current ||
      reassembly.totalObjectBytes !== totalObjectBytes ||
      reassembly.fragmentCount !== fragmentCount ||
      !same(reassembly.digest, objectDigest)
    ) {
      authentication()
    }
    if (fragmentIndex < reassembly.nextFragmentIndex) {
      if (
        !same(subarray(reassembly.bytes, fragmentOffset, fragmentOffset + fragmentDataBytes), data)
      ) {
        authentication()
      }
      return null
    }
    if (fragmentIndex > reassembly.nextFragmentIndex) authentication()
    set(reassembly.bytes, data, fragmentOffset)
    reassembly.nextFragmentIndex++
    if (reassembly.nextFragmentIndex !== fragmentCount) return null
    complete = copy(reassembly.bytes)
    calculatedDigest = cryptoSuite.hash([CORE_FRAGMENT_DOMAIN, complete])
    if (
      !fixed(calculatedDigest, 32) ||
      !same(calculatedDigest, reassembly.digest) ||
      readUint32(complete, 0) !== M3_PROTOCOL_VERSION ||
      readUint16(complete, 4) !== M3_MESSAGE_ID.RELAY_DISCOVER_RESPONSE_V1 ||
      readUint16(complete, 6) !== totalObjectBytes - 8
    ) {
      authentication()
    }
    state.responseReassemblies.delete(key)
    clearResponseReassembly(reassembly)
    completeReturned = true
    return complete
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    if (decoded) {
      clear(decoded.body)
      clear(decoded.authSuffix)
    }
    if (created && !inserted) clearResponseReassembly(created)
    clear(calculatedDigest)
    if (!completeReturned) clear(complete)
  }
}

function clearSessionState(state, session = null) {
  if (!state) return false
  if (session) {
    SESSIONS.delete(session)
    DESTROYED_SESSIONS.add(session)
  }
  if (state.destroyed) return false
  state.destroyed = true
  const tx = state.tx
  const rx = state.rx
  const transcript = state.transcript
  const txKey = state.txKey
  const rxKey = state.rxKey
  const txNoncePrefix = state.txNoncePrefix
  const rxNoncePrefix = state.rxNoncePrefix
  const transcriptDigest = state.transcriptDigest
  state.tx = null
  state.rx = null
  state.transcript = null
  state.txKey = null
  state.rxKey = null
  state.txNoncePrefix = null
  state.rxNoncePrefix = null
  state.transcriptDigest = null
  state.evidenceProducer = null
  state.candidateDirectory = null
  state.branchPathAuthority = null
  rollbackClientExtension(state.clientExtension)
  state.clientExtension = null
  state.candidateAdmissionProducer = null
  clearCandidateAdmissions(state)
  state.candidateAdmissionConsumer = null
  state.adjacencyAuthority = null
  destroyTailExtensionCommitter(state.extensionCommitter)
  state.extensionCommitter = null
  clearAdmittedExtendRequest(state.extensionRequest)
  state.extensionRequest = null
  state.now = null
  state.crypto = null
  clearResponseReassemblies(state)
  clearDiscoveries(state)
  clear(txKey)
  clear(rxKey)
  clear(txNoncePrefix)
  clear(rxNoncePrefix)
  clear(transcriptDigest)
  clearTailReady(transcript)
  try {
    if (tx) tx.destroy()
  } catch {}
  try {
    if (rx) rx.destroy()
  } catch {}
  return true
}

function sessionState(session) {
  const state = SESSIONS.get(session)
  if (!state || state.destroyed) throw PrivateRouteError.ERR_DESTROYED()
  return state
}

function beginSessionMutation(session) {
  const state = sessionState(session)
  if (state.mutating) {
    state.violated = true
    throw PrivateRouteError.ERR_BUSY()
  }
  state.mutating = true
  state.violated = false
  return state
}

function assertSessionMutation(state) {
  if (state.destroyed) throw PrivateRouteError.ERR_DESTROYED()
  if (state.violated) invalid()
}

function sessionNow(state) {
  const current = nowValue(state.now)
  assertSessionMutation(state)
  purgeExpiredDiscoveries(state, current)
  purgeCandidateAdmissions(state, current)
  return current
}

function sealControlFrame(state, encoded, randomBytes, direction) {
  const counter = state.tx.next()
  let associatedData = null
  let plaintext = null
  let padding = null
  let ciphertext = null
  let frame = null
  try {
    associatedData = frameAssociatedData(state, direction, counter)
    plaintext = b4a.allocUnsafeSlow(ROUTE_PLAINTEXT_SIZE)
    if (!fixed(plaintext, ROUTE_PLAINTEXT_SIZE)) invalid()
    plaintext[0] = CELL_CLASS.CONTROL
    writeUint16(plaintext, encoded.byteLength, 1)
    set(plaintext, encoded, 3)
    padding = randomBytes(MAX_ROUTE_PAYLOAD - encoded.byteLength)
    assertSessionMutation(state)
    if (!fixed(padding, MAX_ROUTE_PAYLOAD - encoded.byteLength)) invalid()
    set(plaintext, padding, 3 + encoded.byteLength)
    ciphertext = state.crypto.seal({
      key: state.txKey,
      noncePrefix: state.txNoncePrefix,
      counter,
      associatedData,
      plaintext
    })
    assertSessionMutation(state)
    if (!fixed(ciphertext, ROUTE_PLAINTEXT_SIZE + AEAD_TAG_SIZE)) invalid()
    frame = b4a.allocUnsafeSlow(ROUTE_FRAME_SIZE)
    if (!fixed(frame, ROUTE_FRAME_SIZE)) invalid()
    writeFrameCounter(frame, counter)
    set(frame, ciphertext, 8)
    return encodeM3ContextEnvelope({
      contextClass: CONTEXT_CLASS.TAIL_CONTROL_ORDERED,
      frame
    })
  } finally {
    clear(associatedData)
    clear(plaintext)
    clear(padding)
    clear(ciphertext)
    clear(frame)
  }
}

function openControlFrame(state, envelope, direction, minimumSize, maximumSize = minimumSize) {
  const decodedEnvelope = decodeM3ContextEnvelope(envelope)
  let associatedData = null
  let plaintext = null
  try {
    if (decodedEnvelope.contextClass !== CONTEXT_CLASS.TAIL_CONTROL_ORDERED) invalid()
    const counter = readFrameCounter(decodedEnvelope.frame)
    associatedData = frameAssociatedData(state, direction, counter)
    plaintext = state.crypto.open({
      key: state.rxKey,
      noncePrefix: state.rxNoncePrefix,
      counter,
      associatedData,
      ciphertext: subarray(decodedEnvelope.frame, 8, ROUTE_FRAME_SIZE)
    })
    assertSessionMutation(state)
    if (!fixed(plaintext, ROUTE_PLAINTEXT_SIZE) || plaintext[0] !== CELL_CLASS.CONTROL) invalid()
    const payloadLength = readUint16(plaintext, 1)
    if (
      payloadLength < minimumSize ||
      payloadLength > maximumSize ||
      payloadLength > MAX_ROUTE_PAYLOAD
    ) {
      invalid()
    }
    const encoded = copy(subarray(plaintext, 3, 3 + payloadLength))
    const delivered = state.rx.pushAuthenticated(counter, encoded)
    assertSessionMutation(state)
    if (delivered.length !== 1 || delivered[0] !== encoded) {
      clear(encoded)
      invalid()
    }
    return { counter, encoded }
  } finally {
    clear(decodedEnvelope.frame)
    clear(associatedData)
    clear(plaintext)
  }
}

export function takeAdmittedExtendRequest(capability) {
  const record =
    capability !== null && typeof capability === 'object'
      ? ADMITTED_EXTEND_REQUESTS.get(capability)
      : null
  if (!record || record.status !== 'LIVE') replay()
  const state = sessionState(record.session)
  beginSessionMutation(record.session)
  let material = null
  let complete = false
  try {
    const current = sessionNow(state)
    if (record.deadline <= current) replay()
    material = {
      request: null,
      currentTailIdentity: copy(record.currentTailIdentity, 32),
      currentTailAdvertisementDigest: copy(record.currentTailAdvertisementDigest, 32),
      deadline: record.deadline
    }
    assertSessionMutation(state)
    if (state.extensionRequest !== record || record.request === null) replay()
    material.request = record.request
    record.request = null
    record.status = 'CONSUMED'
    complete = true
    return Object.freeze(material)
  } catch (err) {
    clearSessionState(state, record.session)
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    state.mutating = false
    if (!complete) clearAdmittedExtendMaterial(material)
  }
}

class TailControlSession {
  sealReady(options) {
    const state = beginSessionMutation(this)
    let secretKey = null
    let readyNonce = null
    let body = null
    let input = null
    let signature = null
    let encoded = null
    try {
      if (state.initiator || state.ready) invalid()
      const current = sessionNow(state)
      if (current >= state.expiresAt) throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
      const randomBytes = option(object(options), 'randomBytes')
      secretKey = copy(option(options, 'identitySecretKey'))
      if (!fixed(secretKey, 64) || typeof randomBytes !== 'function') invalid()
      readyNonce = copy(randomBytes(32))
      assertSessionMutation(state)
      if (!fixed(readyNonce, 32)) invalid()
      body = b4a.allocUnsafeSlow(TAIL_READY_BODY_SIZE)
      body[0] = state.transcript.branchClass
      set(body, state.transcript.branchId, 1)
      set(body, state.transcript.circuitId, 17)
      writeUint64(body, state.transcript.generation, 33)
      body[41] = state.transcript.extensionIndex
      set(body, state.transcriptDigest, 42)
      set(body, state.transcript.tailIdentity, 74)
      set(body, state.transcript.candidateAdvertisementDigest, 106)
      set(body, state.transcript.clientNonce, 138)
      set(body, readyNonce, 170)
      writeUint64(body, state.expiresAt, 202)
      input = tailReadySignatureInput(body)
      signature = state.crypto.sign(input, secretKey)
      assertSessionMutation(state)
      if (
        !fixed(signature, 64) ||
        !state.crypto.verify(input, signature, state.transcript.tailIdentity)
      ) {
        invalid()
      }
      assertSessionMutation(state)
      encoded = encodeM3Object({
        messageId: M3_MESSAGE_ID.TAIL_READY_V1,
        body,
        authSuffix: signature
      })
      const envelope = sealControlFrame(state, encoded, randomBytes, DIRECTION.REVERSE)
      assertSessionMutation(state)
      state.ready = true
      return envelope
    } catch (err) {
      clearSessionState(state, this)
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
      clear(secretKey)
      clear(readyNonce)
      clear(body)
      clear(input)
      clear(signature)
      clear(encoded)
    }
  }

  openReady(envelope) {
    const state = beginSessionMutation(this)
    let opened = null
    let encoded = null
    let ready = null
    let input = null
    try {
      if (!state.initiator || state.ready) invalid()
      const current = sessionNow(state)
      if (current >= state.expiresAt) throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
      opened = openControlFrame(state, envelope, DIRECTION.REVERSE, TAIL_READY_SIZE)
      if (opened.counter !== 0n) invalid()
      encoded = opened.encoded
      assertSessionMutation(state)
      ready = decodeTailReady(encoded)
      input = tailReadySignatureInput(ready.body)
      const signatureValid = state.crypto.verify(
        input,
        ready.signature,
        state.transcript.tailIdentity
      )
      assertSessionMutation(state)
      if (
        !signatureValid ||
        ready.branchClass !== state.transcript.branchClass ||
        !same(ready.branchId, state.transcript.branchId) ||
        !same(ready.circuitId, state.transcript.circuitId) ||
        ready.generation !== state.transcript.generation ||
        ready.extensionIndex !== state.transcript.extensionIndex ||
        !same(ready.tailControlTranscriptDigest, state.transcriptDigest) ||
        !same(ready.tailIdentity, state.transcript.tailIdentity) ||
        !same(ready.tailAdvertisementDigest, state.transcript.candidateAdvertisementDigest) ||
        !same(ready.clientNonce, state.transcript.clientNonce) ||
        ready.expiresAtMs !== state.expiresAt ||
        ready.expiresAtMs <= current
      ) {
        invalid()
      }
      state.ready = true
      return Object.freeze({ encoded: copy(encoded), readyNonce: copy(ready.readyNonce) })
    } catch (err) {
      clearSessionState(state, this)
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
      clear(encoded)
      clearTailReady(ready)
      clear(input)
    }
  }

  attachClientExtensionAuthority(branchPathAuthority, candidateDirectory, evidenceProducer) {
    const state = beginSessionMutation(this)
    try {
      if (
        !state.initiator ||
        !state.ready ||
        state.branchPathAuthority ||
        state.candidateDirectory ||
        state.clientExtension ||
        (state.evidenceProducer && state.evidenceProducer !== evidenceProducer) ||
        !isBranchPathAuthorityFor(branchPathAuthority, candidateDirectory) ||
        !isRoutedCandidateAuthorityPair(candidateDirectory, evidenceProducer)
      ) {
        authentication()
      }
      sessionNow(state)
      state.branchPathAuthority = branchPathAuthority
      state.candidateDirectory = candidateDirectory
      state.evidenceProducer = evidenceProducer
      assertSessionMutation(state)
      return true
    } catch (err) {
      clearSessionState(state, this)
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
    }
  }

  sealDiscoverRequest(options) {
    const state = beginSessionMutation(this)
    let encoded = null
    let request = null
    try {
      if (!state.initiator || !state.ready) invalid()
      const current = sessionNow(state)
      if (current >= state.expiresAt) throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
      const selectedOptions = object(options)
      const randomBytes = option(selectedOptions, 'randomBytes')
      if (typeof randomBytes !== 'function') invalid()
      encoded = encodeRelayDiscoverRequest({
        requestedCapabilityMask: option(selectedOptions, 'requestedCapabilityMask'),
        randomTarget: option(selectedOptions, 'randomTarget'),
        queryNonce: option(selectedOptions, 'queryNonce'),
        maximumResults: option(selectedOptions, 'maximumResults')
      })
      assertSessionMutation(state)
      request = decodeRelayDiscoverRequest(encoded)
      assertSessionMutation(state)
      registerDiscovery(state, request, current)
      assertSessionMutation(state)
      const envelope = sealControlFrame(state, encoded, randomBytes, DIRECTION.FORWARD)
      assertSessionMutation(state)
      return envelope
    } catch (err) {
      clearSessionState(state, this)
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
      clear(encoded)
      clearRelayDiscover(request)
    }
  }

  openDiscoverRequest(envelope) {
    const state = beginSessionMutation(this)
    let opened = null
    let request = null
    let projection = null
    try {
      if (state.initiator || !state.ready) invalid()
      const current = sessionNow(state)
      if (current >= state.expiresAt) throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
      opened = openControlFrame(state, envelope, DIRECTION.FORWARD, RELAY_DISCOVER_SIZE)
      assertSessionMutation(state)
      request = decodeRelayDiscoverRequest(opened.encoded)
      const record = registerDiscovery(state, request, current)
      assertSessionMutation(state)
      projection = {
        requestedCapabilityMask: request.requestedCapabilityMask,
        randomTarget: null,
        queryNonce: null,
        maximumResults: request.maximumResults,
        branchClass: state.transcript.branchClass,
        branchId: null,
        circuitId: null,
        generation: state.transcript.generation,
        currentTailIdentity: null,
        currentTailAdvertisementDigest: null,
        currentExtensionIndex: state.transcript.extensionIndex,
        extensionIndex: state.transcript.extensionIndex + 1,
        requiredRole:
          state.transcript.extensionIndex === 0 ? M3_LINK_ROLE.SAFETY_RELAY : M3_LINK_ROLE.DHT_EXIT,
        localAdmissionDeadline: record.deadline,
        tailExpiresAt: state.expiresAt
      }
      projection.randomTarget = copy(request.randomTarget)
      projection.queryNonce = copy(request.queryNonce)
      projection.branchId = copy(state.transcript.branchId)
      projection.circuitId = copy(state.transcript.circuitId)
      projection.currentTailIdentity = copy(state.transcript.tailIdentity)
      projection.currentTailAdvertisementDigest = copy(
        state.transcript.candidateAdvertisementDigest
      )
      return Object.freeze(projection)
    } catch (err) {
      clearRelayDiscover(projection)
      clearSessionState(state, this)
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
      if (opened) clear(opened.encoded)
      clearRelayDiscover(request)
    }
  }

  sealDiscoverResponse(options) {
    const state = beginSessionMutation(this)
    let encoded = null
    let response = null
    let objects = null
    const envelopes = []
    let reservation = null
    let admissionProducer = null
    let admissions = null
    const retained = []
    let complete = false
    try {
      if (state.initiator || !state.ready || state.transcript.extensionIndex === 2) invalid()
      const current = sessionNow(state)
      if (current >= state.expiresAt) throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
      const selectedOptions = object(options)
      const randomBytes = option(selectedOptions, 'randomBytes')
      if (typeof randomBytes !== 'function') invalid()
      encoded = copy(option(selectedOptions, 'encodedResponse'))
      if (bufferLength(encoded) < 49 || bufferLength(encoded) > MAX_RELAY_DISCOVER_RESPONSE) {
        invalid()
      }
      response = decodeRelayDiscoverResponse(encoded)
      const found = findDiscovery(state, response.queryNonce)
      if (
        response.responseTimeMs > current ||
        response.advertisements.length > found.record.maximumResults
      ) {
        authentication()
      }
      const binding = discoveryBinding(state, found.record)
      admissionProducer = state.candidateAdmissionProducer
      reservation = reserveCurrentTailCandidateResponse(admissionProducer, {
        ...binding,
        advertisements: response.advertisements
      })
      assertSessionMutation(state)
      objects = encodeRoutedResponseObjects(encoded)
      for (const object of objects) {
        envelopes.push(sealControlFrame(state, object, randomBytes, DIRECTION.REVERSE))
        assertSessionMutation(state)
      }
      sessionNow(state)
      if (!state.discoveries.has(found.key)) authentication()
      admissions = commitCurrentTailCandidateResponse(admissionProducer, reservation)
      if (!admissions || admissions.length !== response.advertisements.length) invalid()
      reservation = null
      for (let index = 0; index < admissions.length; index++) {
        let digest = null
        try {
          digest = digestRelayCapabilityAdvertisement(response.advertisements[index], {
            now: current
          })
          const key = responseFragmentKey(digest)
          const previous = state.candidateAdmissions.get(key)
          if (previous) clearCandidateAdmissionRecord(state, key, previous)
          const record = { admission: admissions[index], deadline: found.record.deadline }
          state.candidateAdmissions.set(key, record)
          retained.push({ key, record })
        } finally {
          clear(digest)
        }
      }
      if (!consumeDiscovery(state, found.key)) invalid()
      complete = true
      return Object.freeze(envelopes)
    } catch (err) {
      if (reservation) {
        try {
          rollbackCurrentTailCandidateResponse(admissionProducer, reservation)
        } catch {}
      }
      for (const { key, record } of retained) {
        clearCandidateAdmissionRecord(state, key, record)
      }
      if (admissions) {
        for (const admission of admissions) {
          try {
            revokeCurrentTailCandidateAdmissionHandle(state.candidateAdmissionConsumer, admission)
          } catch {}
        }
      }
      clearSessionState(state, this)
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
      clear(encoded)
      clearRelayDiscoverResponse(response)
      if (objects) for (const object of objects) clear(object)
      if (!complete) for (const envelope of envelopes) clear(envelope)
    }
  }

  openExtendRequest(envelope) {
    const state = beginSessionMutation(this)
    const pending = Object.freeze({})
    let opened = null
    let request = null
    let digest = null
    let transferred = false
    try {
      if (
        state.initiator ||
        !state.ready ||
        state.transcript.extensionIndex === 2 ||
        state.extensionRequest !== null
      ) {
        invalid()
      }
      state.extensionRequest = pending
      const current = sessionNow(state)
      if (current >= state.expiresAt) throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
      opened = openControlFrame(
        state,
        envelope,
        DIRECTION.FORWARD,
        EXTEND_REQUEST_MIN_SIZE,
        EXTEND_REQUEST_MAX_SIZE
      )
      assertSessionMutation(state)
      request = decodeExtendRequest(opened.encoded)
      if (
        request.branchClass !== state.transcript.branchClass ||
        !same(request.branchId, state.transcript.branchId) ||
        !same(request.circuitId, state.transcript.circuitId) ||
        request.generation !== state.transcript.generation ||
        request.extensionIndex !== state.transcript.extensionIndex + 1
      ) {
        authentication()
      }
      digest = digestRelayCapabilityAdvertisement(request.advertisement, { now: current })
      const key = responseFragmentKey(digest)
      const admission = state.candidateAdmissions.get(key)
      if (!admission || admission.deadline <= current) authentication()
      const deadline = admission.deadline
      if (state.extensionRequest !== pending) invalid()
      if (
        !consumeCurrentTailCandidateAdmissionHandle(
          state.candidateAdmissionConsumer,
          admission.admission
        )
      ) {
        authentication()
      }
      assertSessionMutation(state)
      clearCandidateAdmissionRecord(state, key, admission, false)
      const capability = publishAdmittedExtendRequest(state, this, request, key, deadline)
      assertSessionMutation(state)
      transferred = true
      return capability
    } catch (err) {
      clearSessionState(state, this)
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
      if (opened) clear(opened.encoded)
      clear(digest)
      if (!transferred) clearExtendRequest(request)
    }
  }

  sealExtend(candidate, options) {
    const state = beginSessionMutation(this)
    const record = {
      authorization: null,
      reservation: null,
      advertisementDigest: null,
      routeEncryptionPublicKey: null,
      relayIdentity: null,
      branchId: null,
      circuitId: null,
      currentTailIdentity: null,
      currentTailAdvertisementDigest: null,
      clientTailEphemeralPublicKey: null,
      clientTailEphemeralSecretKey: null,
      clientNonce: null,
      extensionNonce: null,
      generation: 0n,
      extensionIndex: -1,
      deadline: 0n,
      requestedExpiresAt: 0n
    }
    let authorizationMaterial = null
    let decodedAdvertisement = null
    let payloadParametersDigest = null
    let seedBytes = null
    let pair = null
    let encoded = null
    let decodedRequest = null
    let complete = false
    try {
      if (
        !state.initiator ||
        !state.ready ||
        !state.branchPathAuthority ||
        state.transcript.extensionIndex === 2 ||
        state.clientExtension !== null
      ) {
        invalid()
      }
      state.clientExtension = record
      record.authorization = state.branchPathAuthority.reserve(candidate)
      assertSessionMutation(state)
      authorizationMaterial = takeBranchPathAuthorization(record.authorization)
      record.authorization = null
      record.reservation = authorizationMaterial.reservation
      assertSessionMutation(state)
      const current = sessionNow(state)
      if (
        current >= state.expiresAt ||
        authorizationMaterial.deadline <= current ||
        authorizationMaterial.deadline > state.expiresAt ||
        authorizationMaterial.branchClass !== state.transcript.branchClass ||
        !same(authorizationMaterial.branchId, state.transcript.branchId) ||
        !same(authorizationMaterial.circuitId, state.transcript.circuitId) ||
        authorizationMaterial.generation !== state.transcript.generation ||
        authorizationMaterial.extensionIndex !== state.transcript.extensionIndex + 1 ||
        authorizationMaterial.requiredRole !==
          (state.transcript.extensionIndex === 0
            ? M3_LINK_ROLE.SAFETY_RELAY
            : M3_LINK_ROLE.DHT_EXIT) ||
        !same(authorizationMaterial.currentTailIdentity, state.transcript.tailIdentity) ||
        !same(
          authorizationMaterial.currentTailAdvertisementDigest,
          state.transcript.candidateAdvertisementDigest
        )
      ) {
        authentication()
      }
      const selected = object(options)
      const randomBytes = option(selected, 'randomBytes')
      const requestedLimits = option(selected, 'requestedLimits')
      if (typeof randomBytes !== 'function') invalid()
      decodedAdvertisement = decodeRelayCapabilityAdvertisement(
        authorizationMaterial.advertisement,
        { now: current }
      )
      payloadParametersDigest = digestPayloadParameters(decodedAdvertisement)
      seedBytes = copy(randomBytes(32), 32)
      assertSessionMutation(state)
      pair = state.crypto.encryptionKeyPair(seedBytes)
      assertSessionMutation(state)
      if (!fixed(pair.publicKey, 32) || !fixed(pair.secretKey, 32)) invalid()
      record.clientNonce = copy(randomBytes(32), 32)
      assertSessionMutation(state)
      record.extensionNonce = copy(randomBytes(32), 32)
      assertSessionMutation(state)
      record.advertisementDigest = copy(authorizationMaterial.advertisementDigest, 32)
      record.routeEncryptionPublicKey = copy(authorizationMaterial.routeEncryptionPublicKey, 32)
      record.relayIdentity = copy(decodedAdvertisement.relayIdentity, 32)
      record.branchId = copy(authorizationMaterial.branchId, 16)
      record.circuitId = copy(authorizationMaterial.circuitId, 16)
      record.currentTailIdentity = copy(authorizationMaterial.currentTailIdentity, 32)
      record.currentTailAdvertisementDigest = copy(
        authorizationMaterial.currentTailAdvertisementDigest,
        32
      )
      record.clientTailEphemeralPublicKey = copy(pair.publicKey, 32)
      record.clientTailEphemeralSecretKey = copy(pair.secretKey, 32)
      record.generation = authorizationMaterial.generation
      record.extensionIndex = authorizationMaterial.extensionIndex
      record.deadline = authorizationMaterial.deadline
      const request = {
        branchClass: authorizationMaterial.branchClass,
        branchId: record.branchId,
        circuitId: record.circuitId,
        generation: record.generation,
        extensionIndex: record.extensionIndex,
        advertisement: authorizationMaterial.advertisement,
        clientTailEphemeralPublicKey: record.clientTailEphemeralPublicKey,
        clientNonce: record.clientNonce,
        payloadParametersDigest,
        requestedLimits,
        extensionNonce: record.extensionNonce
      }
      encoded = encodeExtendRequest(request)
      decodedRequest = decodeExtendRequest(encoded)
      record.requestedExpiresAt = decodedRequest.requestedLimits.expiresAtMs
      if (record.requestedExpiresAt <= current) authentication()
      const envelope = sealControlFrame(state, encoded, randomBytes, DIRECTION.FORWARD)
      assertSessionMutation(state)
      sessionNow(state)
      complete = true
      return envelope
    } catch (err) {
      clearSessionState(state, this)
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
      if (!complete && state.clientExtension === record) state.clientExtension = null
      if (!complete) rollbackClientExtension(record)
      clearBranchPathMaterial(authorizationMaterial)
      clearTailReady(decodedAdvertisement)
      clear(payloadParametersDigest)
      clear(seedBytes)
      clear(pair && pair.publicKey)
      clear(pair && pair.secretKey)
      clear(encoded)
      clearExtendRequest(decodedRequest)
    }
  }

  sealExtended(completion, options) {
    const state = beginSessionMutation(this)
    let material = null
    let encodedProof = null
    let encodedExtended = null
    let envelope = null
    let nextRuntime = null
    let nextTail = null
    let forwarding = null
    let complete = false
    try {
      if (
        state.initiator ||
        !state.ready ||
        !state.adjacencyAuthority ||
        !state.extensionCommitter
      ) {
        invalid()
      }
      const current = sessionNow(state)
      if (current >= state.expiresAt) throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
      const randomBytes = option(object(options), 'randomBytes')
      if (typeof randomBytes !== 'function') invalid()
      material = takeExtensionLinkCompletion(completion)
      const expected = material.expectedProof
      const record = state.extensionRequest
      if (
        !record ||
        record.status !== 'CONSUMED' ||
        !expected ||
        expected.branchClass !== state.transcript.branchClass ||
        !same(expected.branchId, state.transcript.branchId) ||
        !same(expected.circuitId, state.transcript.circuitId) ||
        expected.generation !== state.transcript.generation ||
        expected.extensionIndex !== state.transcript.extensionIndex + 1 ||
        !same(expected.initiatorIdentity, state.transcript.tailIdentity) ||
        expected.expiresAtMs > state.expiresAt ||
        expected.expiresAtMs <= current ||
        responseFragmentKey(material.extensionNonce) !== record.extensionNonce
      ) {
        authentication()
      }
      const adopted = state.adjacencyAuthority.adopt(material.established)
      material.established = null
      nextRuntime = adopted.runtime
      nextTail = adopted.tail
      assertSessionMutation(state)
      if (!revokeM3TailCapability(nextTail)) invalid()
      nextTail = null
      encodedProof = consumeVerifiedRedactedResponderProof(
        material.proofConsumer,
        material.verifiedProof,
        expected
      )
      material.verifiedProof = null
      material.proofConsumer = null
      assertSessionMutation(state)
      encodedExtended = encodeExtended({
        branchClass: expected.branchClass,
        branchId: expected.branchId,
        circuitId: expected.circuitId,
        generation: expected.generation,
        extensionIndex: expected.extensionIndex,
        responderAdvertisementDigest: expected.responderAdvertisementDigest,
        redactedProof: encodedProof,
        extensionNonce: material.extensionNonce
      })
      envelope = sealControlFrame(state, encodedExtended, randomBytes, DIRECTION.REVERSE)
      assertSessionMutation(state)
      enqueueTailExtended(state.extensionCommitter, envelope)
      let refreshed = sessionNow(state)
      if (refreshed >= expected.expiresAtMs) authentication()
      forwarding = installTailExtension(state.extensionCommitter, nextRuntime)
      nextRuntime = null
      refreshed = sessionNow(state)
      if (refreshed >= expected.expiresAtMs) authentication()
      clearSessionState(state, this)
      complete = true
      const result = forwarding
      forwarding = null
      return result
    } catch (err) {
      clearSessionState(state, this)
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
      if (!complete && forwarding) {
        try {
          forwarding.destroy()
        } catch {}
      }
      if (nextRuntime) {
        try {
          nextRuntime.destroy()
        } catch {}
      }
      if (nextTail) revokeM3TailCapability(nextTail)
      destroyTakenExtensionLinkCompletion(material)
      clear(encodedProof)
      clear(encodedExtended)
      clear(envelope)
    }
  }

  openExtended(envelope) {
    const state = beginSessionMutation(this)
    const record = state.clientExtension
    let opened = null
    let extended = null
    let proof = null
    let proofAuthority = null
    let verifiedProof = null
    let encodedProof = null
    let sharedSecret = null
    let nextTranscript = null
    let nextSession = null
    let reservation = null
    let completion = null
    let complete = false
    try {
      if (
        !state.initiator ||
        !state.ready ||
        !state.branchPathAuthority ||
        !record ||
        !record.reservation
      ) {
        invalid()
      }
      const current = sessionNow(state)
      if (current >= state.expiresAt || current >= record.deadline) authentication()
      opened = openControlFrame(state, envelope, DIRECTION.REVERSE, EXTENDED_SIZE)
      assertSessionMutation(state)
      extended = decodeExtended(opened.encoded)
      proof = decodeRedactedResponderProof(extended.redactedProof)
      if (
        extended.branchClass !== state.transcript.branchClass ||
        !same(extended.branchId, record.branchId) ||
        !same(extended.circuitId, record.circuitId) ||
        extended.generation !== record.generation ||
        extended.extensionIndex !== record.extensionIndex ||
        !same(extended.responderAdvertisementDigest, record.advertisementDigest) ||
        !same(extended.extensionNonce, record.extensionNonce) ||
        !same(proof.responderAdvertisementDigest, record.advertisementDigest) ||
        !same(proof.initiatorIdentity, record.currentTailIdentity) ||
        !same(proof.responderIdentity, record.relayIdentity) ||
        proof.branchClass !== state.transcript.branchClass ||
        !same(proof.branchId, record.branchId) ||
        !same(proof.circuitId, record.circuitId) ||
        proof.generation !== record.generation ||
        proof.extensionIndex !== record.extensionIndex ||
        !same(proof.clientTailEphemeralPublicKey, record.clientTailEphemeralPublicKey) ||
        !same(proof.clientNonce, record.clientNonce) ||
        !same(proof.advertisedRouteEncryptionPublicKey, record.routeEncryptionPublicKey) ||
        proof.expiresAtMs <= current ||
        proof.expiresAtMs > record.deadline ||
        proof.expiresAtMs > record.requestedExpiresAt
      ) {
        authentication()
      }
      proofAuthority = createRedactedResponderProofAuthority({ now: () => current })
      verifiedProof = verifyExpectedRedactedResponderProof(
        proofAuthority.verifier,
        proofAuthority.consumer,
        extended.redactedProof,
        proof
      )
      assertSessionMutation(state)
      encodedProof = consumeVerifiedRedactedResponderProof(
        proofAuthority.consumer,
        verifiedProof,
        proof
      )
      verifiedProof = null
      assertSessionMutation(state)
      if (!same(encodedProof, extended.redactedProof)) authentication()
      sharedSecret = state.crypto.keyAgreement(
        record.clientTailEphemeralSecretKey,
        record.routeEncryptionPublicKey
      )
      assertSessionMutation(state)
      if (!fixed(sharedSecret, 32)) invalid()
      nextTranscript = encodeTailControlTranscript({
        branchClass: state.transcript.branchClass,
        branchId: record.branchId,
        circuitId: record.circuitId,
        generation: record.generation,
        extensionIndex: record.extensionIndex,
        clientTailEphemeralPublicKey: record.clientTailEphemeralPublicKey,
        advertisedTailRouteEncryptionPublicKey: record.routeEncryptionPublicKey,
        candidateAdvertisementDigest: record.advertisementDigest,
        clientNonce: record.clientNonce,
        tailIdentity: record.relayIdentity,
        admittedLimitsDigest: proof.admittedLimitsDigest
      })
      nextSession = createTailControlSessionFromMaterial(
        {
          initiator: true,
          secret: sharedSecret,
          transcript: nextTranscript,
          expiresAt: proof.expiresAtMs
        },
        {
          now: state.now,
          crypto: state.crypto,
          evidenceProducer: state.evidenceProducer,
          candidateDirectory: state.candidateDirectory,
          branchPathAuthority: state.branchPathAuthority
        }
      )
      sharedSecret = null
      nextTranscript = null
      reservation = record.reservation
      record.reservation = null
      state.clientExtension = null
      rollbackClientExtension(record)
      clearSessionState(state, this)
      completion = createClientExtensionCompletion(nextSession, reservation)
      nextSession = null
      reservation = null
      complete = true
      return completion
    } catch (err) {
      clearSessionState(state, this)
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
      if (!complete && nextSession) nextSession.destroy()
      if (!complete && reservation) {
        try {
          failBranchPathReservation(reservation)
        } catch {}
      }
      if (proofAuthority) proofAuthority.destroy()
      if (opened) clear(opened.encoded)
      clearExtended(extended)
      clearTailReady(proof)
      clear(encodedProof)
      clear(sharedSecret)
      clear(nextTranscript)
    }
  }

  openDiscoverResponse(envelope) {
    const state = beginSessionMutation(this)
    let opened = null
    let controlObject = null
    let reassembled = null
    let response = null
    let evidence = null
    let evidenceProducer = null
    try {
      if (!state.initiator || !state.ready || state.transcript.extensionIndex === 2) invalid()
      const current = sessionNow(state)
      if (current >= state.expiresAt) throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
      opened = openControlFrame(state, envelope, DIRECTION.REVERSE, 49, MAX_ROUTE_PAYLOAD)
      assertSessionMutation(state)
      controlObject = decodeM3Object(opened.encoded)
      const controlMessageId = controlObject.messageId
      clear(controlObject.body)
      clear(controlObject.authSuffix)
      controlObject = null
      if (controlMessageId === M3_MESSAGE_ID.CORE_FRAGMENT_V1) {
        reassembled = acceptResponseFragment(state, opened.encoded, current)
        assertSessionMutation(state)
        if (reassembled === null) return null
      } else if (controlMessageId !== M3_MESSAGE_ID.RELAY_DISCOVER_RESPONSE_V1) {
        invalid()
      }
      const encodedResponse = reassembled || opened.encoded
      response = decodeRelayDiscoverResponse(encodedResponse)
      const found = findDiscovery(state, response.queryNonce)
      if (!reassembled) {
        if (found.record.responseMode !== RESPONSE_MODE_NONE) authentication()
        found.record.responseMode = RESPONSE_MODE_DIRECT
      }
      if (
        response.responseTimeMs > current ||
        response.advertisements.length > found.record.maximumResults
      ) {
        authentication()
      }
      const binding = discoveryBinding(state, found.record)
      binding.encodedResponse = encodedResponse
      evidenceProducer = state.evidenceProducer
      evidence = publishAuthenticatedDiscoveryEvidence(evidenceProducer, binding)
      assertSessionMutation(state)
      if (!consumeDiscovery(state, found.key)) invalid()
      return evidence
    } catch (err) {
      if (evidence) {
        try {
          revokeAuthenticatedDiscoveryEvidence(evidenceProducer, evidence)
        } catch {}
      }
      clearSessionState(state, this)
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
      if (opened) clear(opened.encoded)
      if (controlObject) {
        clear(controlObject.body)
        clear(controlObject.authSuffix)
      }
      clear(reassembled)
      clearRelayDiscoverResponse(response)
    }
  }

  diagnostics() {
    const state = SESSIONS.get(this)
    if (!state || state.destroyed || DESTROYED_SESSIONS.has(this)) {
      return Object.freeze({
        state: 'DESTROYED',
        pendingDiscoveries: 0,
        discoveryAttempts: 0,
        responseReassemblies: 0
      })
    }
    beginSessionMutation(this)
    try {
      sessionNow(state)
      return Object.freeze({
        state: state.ready ? 'ACTIVE' : 'WAITING_READY',
        pendingDiscoveries: state.discoveries.size,
        discoveryAttempts: state.discoveryAttempts,
        responseReassemblies: state.responseReassemblies.size
      })
    } catch (err) {
      clearSessionState(state, this)
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
    }
  }

  destroy() {
    const state = SESSIONS.get(this)
    if (!state || state.destroyed) return false
    clearSessionState(state, this)
    return true
  }
}

export function completeClientTailExtension(completion, readyEnvelope) {
  const state = object(completion) ? CLIENT_EXTENSION_COMPLETIONS.get(completion) : null
  if (!state || state.destroyed) {
    if (object(completion) && SPENT_CLIENT_EXTENSION_COMPLETIONS.has(completion)) replay()
    authentication()
  }
  CLIENT_EXTENSION_COMPLETIONS.delete(completion)
  SPENT_CLIENT_EXTENSION_COMPLETIONS.add(completion)
  let ready = null
  let session = state.session
  try {
    ready = session.openReady(readyEnvelope)
    if (!completeBranchPathReservation(state.reservation)) invalid()
    state.reservation = null
    state.session = null
    state.destroyed = true
    const result = session
    session = null
    return result
  } catch (err) {
    destroyClientExtensionCompletionState(state)
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    if (ready) {
      clear(ready.encoded)
      clear(ready.readyNonce)
    }
    if (session) {
      try {
        session.destroy()
      } catch {}
    }
  }
}

export function abortClientTailExtension(completion) {
  const state = object(completion) ? CLIENT_EXTENSION_COMPLETIONS.get(completion) : null
  if (!state || state.destroyed) return false
  CLIENT_EXTENSION_COMPLETIONS.delete(completion)
  SPENT_CLIENT_EXTENSION_COMPLETIONS.add(completion)
  return destroyClientExtensionCompletionState(state)
}

function tailControlOptions(options) {
  const selected = object(options)
  const values = {
    now: option(selected, 'now'),
    crypto: option(selected, 'crypto') || cryptoSuite,
    evidenceProducer: option(selected, 'evidenceProducer'),
    candidateDirectory: option(selected, 'candidateDirectory'),
    candidateAdmissionProducer: option(selected, 'candidateAdmissionProducer'),
    candidateAdmissionConsumer: option(selected, 'candidateAdmissionConsumer'),
    branchPathAuthority: option(selected, 'branchPathAuthority'),
    adjacencyAuthority: option(selected, 'adjacencyAuthority'),
    extensionCommitter: option(selected, 'extensionCommitter')
  }
  if (
    typeof values.now !== 'function' ||
    !object(values.crypto) ||
    typeof values.crypto.sign !== 'function' ||
    typeof values.crypto.verify !== 'function' ||
    typeof values.crypto.seal !== 'function' ||
    typeof values.crypto.open !== 'function'
  ) {
    invalid()
  }
  if (
    (values.candidateAdmissionProducer !== undefined ||
      values.candidateAdmissionConsumer !== undefined) &&
    !isCurrentTailCandidateAdmissionPair(
      values.candidateAdmissionProducer,
      values.candidateAdmissionConsumer
    )
  ) {
    invalid()
  }
  if (
    values.branchPathAuthority !== undefined &&
    (!isBranchPathAuthority(values.branchPathAuthority) ||
      !isBranchPathAuthorityFor(values.branchPathAuthority, values.candidateDirectory) ||
      !isRoutedCandidateAuthorityPair(values.candidateDirectory, values.evidenceProducer))
  ) {
    invalid()
  }
  if (values.candidateDirectory !== undefined && values.branchPathAuthority === undefined) invalid()
  if (
    (values.adjacencyAuthority !== undefined || values.extensionCommitter !== undefined) &&
    (!isM3AdjacencyAuthority(values.adjacencyAuthority) ||
      !isTailExtensionCommitter(values.extensionCommitter))
  ) {
    invalid()
  }
  return values
}

function createTailControlSessionFromMaterial(material, options = {}, normalized = null) {
  let transcript = null
  let derived = null
  let session = null
  let installed = false
  try {
    const values = normalized || tailControlOptions(options)
    const {
      now,
      crypto,
      evidenceProducer,
      candidateDirectory,
      candidateAdmissionProducer,
      candidateAdmissionConsumer,
      branchPathAuthority,
      adjacencyAuthority,
      extensionCommitter
    } = values
    if (
      typeof material.initiator !== 'boolean' ||
      !fixed(material.secret, 32) ||
      !fixed(material.transcript, TAIL_CONTROL_TRANSCRIPT_SIZE) ||
      !uint64(material.expiresAt)
    ) {
      invalid()
    }
    const current = nowValue(now)
    if (current >= material.expiresAt) throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
    const counterNow = () => {
      const value = nowValue(now)
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid()
      return Number(value)
    }
    transcript = decodeTailControlTranscript(material.transcript)
    derived = deriveTailControlTestVector(
      material.secret,
      material.transcript,
      transcript.extensionIndex
    )
    const initiator = material.initiator
    if (
      branchPathAuthority !== undefined &&
      (!initiator ||
        !isBranchPathAuthority(branchPathAuthority) ||
        typeof crypto.encryptionKeyPair !== 'function' ||
        typeof crypto.keyAgreement !== 'function')
    ) {
      invalid()
    }
    if ((adjacencyAuthority !== undefined || extensionCommitter !== undefined) && initiator) {
      invalid()
    }
    session = new TailControlSession()
    SESSIONS.set(session, {
      initiator,
      now,
      crypto,
      expiresAt: material.expiresAt,
      transcript,
      transcriptDigest: digestTailReadyTranscript(material.transcript),
      txKey: initiator ? derived.forwardKey : derived.reverseKey,
      rxKey: initiator ? derived.reverseKey : derived.forwardKey,
      txNoncePrefix: initiator ? derived.forwardNoncePrefix : derived.reverseNoncePrefix,
      rxNoncePrefix: initiator ? derived.reverseNoncePrefix : derived.forwardNoncePrefix,
      tx: new SenderCounter(),
      rx: new OrderedReceiver({ window: 256, gapTimeout: 5_000, now: counterNow }),
      discoveries: new Map(),
      discoveryNonces: new Set(),
      discoveryAttempts: 0,
      responseReassemblies: new Map(),
      evidenceProducer,
      candidateDirectory: candidateDirectory || null,
      branchPathAuthority: branchPathAuthority || null,
      clientExtension: null,
      candidateAdmissionProducer,
      candidateAdmissionConsumer,
      adjacencyAuthority: adjacencyAuthority || null,
      extensionCommitter: extensionCommitter || null,
      candidateAdmissions: new Map(),
      extensionRequest: null,
      ready: false,
      mutating: false,
      violated: false,
      destroyed: false
    })
    transcript = null
    derived = null
    installed = true
    return session
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    if (material) {
      clear(material.secret)
      clear(material.transcript)
      material.secret = null
      material.transcript = null
    }
    clearTailReady(transcript)
    if (derived) for (const value of Object.values(derived)) clear(value)
    if (!installed && session) {
      const state = SESSIONS.get(session)
      clearSessionState(state, session)
    }
  }
}

export function createTailControlSession(capability, options = {}) {
  let material = null
  try {
    const normalized = tailControlOptions(options)
    material = takeM3TailCapability(capability)
    const session = createTailControlSessionFromMaterial(material, options, normalized)
    material = null
    return session
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    if (material) {
      clear(material.secret)
      clear(material.transcript)
      material.secret = null
      material.transcript = null
    }
  }
}
