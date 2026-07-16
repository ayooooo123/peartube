import b4a from 'b4a'
import sodium from 'sodium-universal'

import { OrderedReceiver, SenderCounter } from './counters.js'
import { cryptoSuite } from './crypto-suite.js'
import { PrivateRouteError } from './errors.js'
import { takeM3TailCapability } from './m3-adjacency-runtime.js'
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

export const ADMITTED_LIMITS_SIZE = 26
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
const RELAY_DISCOVER_DEADLINE_MS = 5_000n
const MAX_RELAY_DISCOVER_REQUESTS = 3
const RELAY_DISCOVER_NONCE_DOMAIN = b4a.from(
  'hyperdht-private-routes/m3/tail-control/discovery-nonce/v1'
)
const ROUTE_FRAME_SIZE = 1100
const ROUTE_PLAINTEXT_SIZE = 1076
const MAX_ROUTE_PAYLOAD = 1073
const AEAD_TAG_SIZE = 16
const SESSIONS = new WeakMap()
const DESTROYED_SESSIONS = new WeakSet()
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

function copy(value) {
  let output = null
  try {
    const length = bufferLength(value)
    if (length < 0) invalid()
    output = b4a.allocUnsafeSlow(length)
    if (!fixed(output, length)) invalid()
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
    value[field] = null
  }
  value.requestedCapabilityMask = 0
  value.maximumResults = 0
  value.branchClass = -1
  value.generation = 0n
  value.currentExtensionIndex = -1
  value.extensionIndex = -1
  value.requiredRole = -1
  value.localAdmissionDeadline = 0n
  value.tailExpiresAt = 0n
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
  record.randomTarget = null
  record.queryNonce = null
  record.deadline = 0n
  record.requestedCapabilityMask = 0
  record.maximumResults = 0
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
  state.now = null
  state.crypto = null
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

function openControlFrame(state, envelope, direction, expectedSize) {
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
    if (payloadLength !== expectedSize || payloadLength > MAX_ROUTE_PAYLOAD) invalid()
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

  diagnostics() {
    const state = SESSIONS.get(this)
    if (!state || state.destroyed || DESTROYED_SESSIONS.has(this)) {
      return Object.freeze({
        state: 'DESTROYED',
        pendingDiscoveries: 0,
        discoveryAttempts: 0
      })
    }
    beginSessionMutation(this)
    try {
      sessionNow(state)
      return Object.freeze({
        state: state.ready ? 'ACTIVE' : 'WAITING_READY',
        pendingDiscoveries: state.discoveries.size,
        discoveryAttempts: state.discoveryAttempts
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

export function createTailControlSession(capability, options = {}) {
  let material = null
  let transcript = null
  let derived = null
  let session = null
  let installed = false
  try {
    const now = option(object(options), 'now')
    const crypto = option(options, 'crypto') || cryptoSuite
    if (
      typeof now !== 'function' ||
      !object(crypto) ||
      typeof crypto.sign !== 'function' ||
      typeof crypto.verify !== 'function' ||
      typeof crypto.seal !== 'function' ||
      typeof crypto.open !== 'function'
    ) {
      invalid()
    }
    material = takeM3TailCapability(capability)
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
