import b4a from 'b4a'

import { cryptoSuite } from './crypto-suite.js'
import { PrivateRouteError } from './errors.js'
import {
  BRANCH_CLASS,
  M3_MESSAGE_ID,
  M3_PROTOCOL_VERSION,
  decodeM3Object,
  encodeM3Object
} from './protocol.js'

export const REDACTED_RESPONDER_PROOF_SIZE = 378
export const MAX_LIVE_VERIFIED_RESPONDER_PROOFS = 16
export const MAX_VERIFIED_RESPONDER_PROOF_STATES = 96

const BODY_SIZE = 306
const DOMAIN = b4a.from('hyperdht-private-routes/m3/redacted-responder-proof/v1')
const FIELD_NAMES = Object.freeze([
  'responderAdvertisementDigest',
  'initiatorIdentity',
  'responderIdentity',
  'branchClass',
  'branchId',
  'circuitId',
  'generation',
  'extensionIndex',
  'clientTailEphemeralPublicKey',
  'clientNonce',
  'advertisedRouteEncryptionPublicKey',
  'admittedLimitsDigest',
  'expiresAtMs',
  'responderProofNonce'
])
const FIELD_SET = new Set(FIELD_NAMES)
const BUFFER_FIELDS = Object.freeze([
  'branchId',
  'circuitId',
  'responderAdvertisementDigest',
  'initiatorIdentity',
  'responderIdentity',
  'clientTailEphemeralPublicKey',
  'clientNonce',
  'advertisedRouteEncryptionPublicKey',
  'admittedLimitsDigest',
  'responderProofNonce'
])
const VERIFIERS = new WeakMap()
const CONSUMERS = new WeakMap()
const CAPABILITIES = new WeakMap()
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get
const fillIntrinsic = Uint8Array.prototype.fill
const setIntrinsic = Uint8Array.prototype.set

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function authentication() {
  throw PrivateRouteError.ERR_AUTHENTICATION()
}

function replay() {
  throw PrivateRouteError.ERR_REPLAY()
}

function busy() {
  throw PrivateRouteError.ERR_BUSY()
}

function destroyed() {
  throw PrivateRouteError.ERR_DESTROYED()
}

function safeObject(value) {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  } catch {
    return false
  }
}

function option(value, name) {
  try {
    return value[name]
  } catch {
    invalid()
  }
}

function exactKeys(value, names, set) {
  let keys = null
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    invalid()
  }
  if (keys.length !== names.length) invalid()
  for (const key of keys) if (typeof key !== 'string' || !set.has(key)) invalid()
}

function length(value) {
  try {
    return b4a.isBuffer(value) ? byteLengthGetter.call(value) : -1
  } catch {
    return -1
  }
}

function fixed(value, size) {
  return length(value) === size
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) fillIntrinsic.call(value, 0)
  } catch {
    // Best-effort zeroization only.
  }
}

function copy(value, size) {
  let output = null
  let complete = false
  try {
    if (!fixed(value, size)) invalid()
    output = b4a.allocUnsafeSlow(size)
    if (!fixed(output, size)) invalid()
    setIntrinsic.call(output, value)
    complete = true
    return output
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    if (!complete) clear(output)
  }
}

function same(left, right) {
  if (length(left) < 0 || length(left) !== length(right)) return false
  try {
    return b4a.equals(left, right)
  } catch {
    return false
  }
}

function nonzero(value) {
  if (length(value) < 1) return false
  for (let index = 0; index < value.byteLength; index++) {
    if (value[index] !== 0) return true
  }
  return false
}

function uint64(value) {
  return typeof value === 'bigint' && value >= 0n && value <= 0xffff_ffff_ffff_ffffn
}

function nowValue(now) {
  let value = null
  try {
    value = now()
  } catch {
    invalid()
  }
  if (!uint64(value)) invalid()
  return value
}

function writeUint64(target, value, offset) {
  for (let index = 7; index >= 0; index--) {
    target[offset + index] = Number(value & 0xffn)
    value >>= 8n
  }
}

function writeUint16(target, value, offset) {
  target[offset] = value >>> 8
  target[offset + 1] = value
}

function writeUint32(target, value, offset) {
  target[offset] = value >>> 24
  target[offset + 1] = value >>> 16
  target[offset + 2] = value >>> 8
  target[offset + 3] = value
}

function readUint64(source, offset) {
  let value = 0n
  for (let index = offset; index < offset + 8; index++) {
    value = (value << 8n) | BigInt(source[index])
  }
  return value
}

function clearProjection(value) {
  if (!value) return
  for (const field of BUFFER_FIELDS) clear(value[field])
}

function normalize(value) {
  if (!safeObject(value)) invalid()
  exactKeys(value, FIELD_NAMES, FIELD_SET)
  const result = {}
  let complete = false
  try {
    result.responderAdvertisementDigest = copy(option(value, 'responderAdvertisementDigest'), 32)
    result.initiatorIdentity = copy(option(value, 'initiatorIdentity'), 32)
    result.responderIdentity = copy(option(value, 'responderIdentity'), 32)
    result.branchClass = option(value, 'branchClass')
    result.branchId = copy(option(value, 'branchId'), 16)
    result.circuitId = copy(option(value, 'circuitId'), 16)
    result.generation = option(value, 'generation')
    result.extensionIndex = option(value, 'extensionIndex')
    result.clientTailEphemeralPublicKey = copy(option(value, 'clientTailEphemeralPublicKey'), 32)
    result.clientNonce = copy(option(value, 'clientNonce'), 32)
    result.advertisedRouteEncryptionPublicKey = copy(
      option(value, 'advertisedRouteEncryptionPublicKey'),
      32
    )
    result.admittedLimitsDigest = copy(option(value, 'admittedLimitsDigest'), 32)
    result.expiresAtMs = option(value, 'expiresAtMs')
    result.responderProofNonce = copy(option(value, 'responderProofNonce'), 32)
    if (
      (result.branchClass !== BRANCH_CLASS.LOOKUP &&
        result.branchClass !== BRANCH_CLASS.ANNOUNCE) ||
      !uint64(result.generation) ||
      result.generation === 0n ||
      (result.extensionIndex !== 1 && result.extensionIndex !== 2) ||
      !uint64(result.expiresAtMs) ||
      result.expiresAtMs === 0n
    ) {
      invalid()
    }
    for (const field of BUFFER_FIELDS) {
      if (!nonzero(result[field])) invalid()
    }
    complete = true
    return result
  } finally {
    if (!complete) clearProjection(result)
  }
}

function encodeBody(value) {
  let body = null
  let complete = false
  try {
    body = b4a.allocUnsafeSlow(BODY_SIZE)
    if (!fixed(body, BODY_SIZE)) invalid()
    setIntrinsic.call(body, value.responderAdvertisementDigest, 0)
    setIntrinsic.call(body, value.initiatorIdentity, 32)
    setIntrinsic.call(body, value.responderIdentity, 64)
    body[96] = value.branchClass
    setIntrinsic.call(body, value.branchId, 97)
    setIntrinsic.call(body, value.circuitId, 113)
    writeUint64(body, value.generation, 129)
    body[137] = value.extensionIndex
    setIntrinsic.call(body, value.clientTailEphemeralPublicKey, 138)
    setIntrinsic.call(body, value.clientNonce, 170)
    setIntrinsic.call(body, value.advertisedRouteEncryptionPublicKey, 202)
    setIntrinsic.call(body, value.admittedLimitsDigest, 234)
    writeUint64(body, value.expiresAtMs, 266)
    setIntrinsic.call(body, value.responderProofNonce, 274)
    complete = true
    return body
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    if (!complete) clear(body)
  }
}

function decodeBody(body) {
  if (!fixed(body, BODY_SIZE)) invalid()
  return normalize({
    responderAdvertisementDigest: body.subarray(0, 32),
    initiatorIdentity: body.subarray(32, 64),
    responderIdentity: body.subarray(64, 96),
    branchClass: body[96],
    branchId: body.subarray(97, 113),
    circuitId: body.subarray(113, 129),
    generation: readUint64(body, 129),
    extensionIndex: body[137],
    clientTailEphemeralPublicKey: body.subarray(138, 170),
    clientNonce: body.subarray(170, 202),
    advertisedRouteEncryptionPublicKey: body.subarray(202, 234),
    admittedLimitsDigest: body.subarray(234, 266),
    expiresAtMs: readUint64(body, 266),
    responderProofNonce: body.subarray(274, 306)
  })
}

function signatureInput(body) {
  let input = null
  let complete = false
  const size = 2 + DOMAIN.byteLength + 8 + BODY_SIZE
  try {
    input = b4a.allocUnsafeSlow(size)
    if (!fixed(input, size)) invalid()
    writeUint16(input, DOMAIN.byteLength, 0)
    setIntrinsic.call(input, DOMAIN, 2)
    writeUint32(input, M3_PROTOCOL_VERSION, 2 + DOMAIN.byteLength)
    writeUint16(input, M3_MESSAGE_ID.REDACTED_RESPONDER_PROOF_V1, 6 + DOMAIN.byteLength)
    writeUint16(input, BODY_SIZE, 8 + DOMAIN.byteLength)
    setIntrinsic.call(input, body, 10 + DOMAIN.byteLength)
    complete = true
    return input
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    if (!complete) clear(input)
  }
}

function proofNonceKey(value) {
  let input = null
  try {
    input = b4a.allocUnsafeSlow(90)
    if (!fixed(input, 90)) invalid()
    setIntrinsic.call(input, value.responderIdentity, 0)
    input[32] = value.branchClass
    setIntrinsic.call(input, value.branchId, 33)
    writeUint64(input, value.generation, 49)
    input[57] = value.extensionIndex
    setIntrinsic.call(input, value.responderProofNonce, 58)
    return b4a.toString(input, 'hex')
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    clear(input)
  }
}

function proofKey(encoded) {
  let digest = null
  try {
    digest = cryptoSuite.hash(encoded)
    if (!fixed(digest, 32)) invalid()
    return b4a.toString(digest, 'hex')
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    clear(digest)
  }
}

function projectionsEqual(left, right) {
  if (
    left.branchClass !== right.branchClass ||
    left.generation !== right.generation ||
    left.extensionIndex !== right.extensionIndex ||
    left.expiresAtMs !== right.expiresAtMs
  ) {
    return false
  }
  for (const field of BUFFER_FIELDS) {
    if (!same(left[field], right[field])) return false
  }
  return true
}

function clearState(state) {
  if (!state) return
  clear(state.encoded)
  clearProjection(state.projection)
  state.encoded = null
  state.projection = null
}

function destroyOwner(owner) {
  if (!owner || owner.destroyed) return false
  owner.destroyed = true
  owner.lifecycle = Object.freeze({})
  for (const state of owner.states.values()) {
    if (state.capability) CAPABILITIES.delete(state.capability)
    clearState(state)
  }
  owner.states.clear()
  owner.nonces.clear()
  owner.live = 0
  owner.pending = 0
  owner.now = null
  VERIFIERS.delete(owner.verifier)
  CONSUMERS.delete(owner.consumer)
  return true
}

function assertOwner(owner, lifecycle) {
  if (owner.destroyed || lifecycle !== owner.lifecycle) destroyed()
  if (owner.violated) {
    destroyOwner(owner)
    invalid()
  }
}

function sweep(owner, current) {
  for (const [key, state] of owner.states) {
    if (state.deadline > current) continue
    if (state.status === 'LIVE') owner.live--
    if (state.capability) CAPABILITIES.delete(state.capability)
    owner.nonces.delete(state.nonceKey)
    clearState(state)
    owner.states.delete(key)
  }
}

function begin(owner, reserve = false) {
  if (!owner || owner.destroyed) destroyed()
  if (owner.violated) {
    destroyOwner(owner)
    invalid()
  }
  if (owner.mutating) {
    owner.violated = true
    busy()
  }
  owner.mutating = true
  owner.violated = false
  if (reserve) owner.pending++
  const lifecycle = owner.lifecycle
  try {
    const current = nowValue(owner.now)
    assertOwner(owner, lifecycle)
    sweep(owner, current)
    return { current, lifecycle, reserved: reserve }
  } catch (err) {
    if (reserve && owner.pending > 0) owner.pending--
    if (owner.violated && !owner.destroyed) destroyOwner(owner)
    owner.mutating = false
    throw err
  }
}

function end(owner, operation = null) {
  if (operation && operation.reserved && owner.pending > 0) owner.pending--
  if (owner && owner.violated && !owner.destroyed) destroyOwner(owner)
  if (owner) owner.mutating = false
}

export function createRedactedResponderProofAuthority(options = {}) {
  if (!safeObject(options)) invalid()
  exactKeys(options, ['now'], new Set(['now']))
  const now = option(options, 'now')
  if (typeof now !== 'function') invalid()
  const verifier = Object.freeze({})
  const consumer = Object.freeze({})
  const owner = {
    verifier,
    consumer,
    now,
    states: new Map(),
    nonces: new Map(),
    live: 0,
    pending: 0,
    mutating: false,
    violated: false,
    destroyed: false,
    lifecycle: Object.freeze({})
  }
  VERIFIERS.set(verifier, owner)
  CONSUMERS.set(consumer, owner)
  return Object.freeze({
    verifier,
    consumer,
    diagnostics() {
      const operation = begin(owner)
      try {
        assertOwner(owner, operation.lifecycle)
        return Object.freeze({ state: 'ACTIVE', live: owner.live, states: owner.states.size })
      } finally {
        end(owner)
      }
    },
    destroy() {
      return destroyOwner(owner)
    }
  })
}

export function signRedactedResponderProof(value, identitySecretKey) {
  let projection = null
  let body = null
  let input = null
  let signature = null
  let encoded = null
  let complete = false
  try {
    projection = normalize(value)
    if (!fixed(identitySecretKey, 64)) invalid()
    body = encodeBody(projection)
    input = signatureInput(body)
    signature = cryptoSuite.sign(input, identitySecretKey)
    if (
      !fixed(signature, 64) ||
      !cryptoSuite.verify(input, signature, projection.responderIdentity)
    ) {
      invalid()
    }
    encoded = encodeM3Object({
      messageId: M3_MESSAGE_ID.REDACTED_RESPONDER_PROOF_V1,
      body,
      authSuffix: signature
    })
    if (!fixed(encoded, REDACTED_RESPONDER_PROOF_SIZE)) invalid()
    complete = true
    return encoded
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    clearProjection(projection)
    clear(body)
    clear(input)
    clear(signature)
    if (!complete) clear(encoded)
  }
}

export function decodeRedactedResponderProof(encoded) {
  let object = null
  try {
    if (!fixed(encoded, REDACTED_RESPONDER_PROOF_SIZE)) invalid()
    object = decodeM3Object(encoded)
    if (
      object.messageId !== M3_MESSAGE_ID.REDACTED_RESPONDER_PROOF_V1 ||
      !fixed(object.body, BODY_SIZE) ||
      !fixed(object.authSuffix, 64)
    ) {
      invalid()
    }
    return Object.freeze(decodeBody(object.body))
  } finally {
    clear(object && object.body)
    clear(object && object.authSuffix)
  }
}

function verifyProof(verifier, consumer, encoded, expected) {
  const owner = safeObject(verifier) ? VERIFIERS.get(verifier) : null
  const operation = begin(owner, true)
  let key = null
  let state = null
  let object = null
  let projection = null
  let expectedProjection = null
  let input = null
  let owned = null
  let nonceKey = null
  let capability = null
  let stateInserted = false
  let nonceInserted = false
  let capabilityInserted = false
  let published = false
  try {
    if (expected !== null) {
      const consumerOwner = safeObject(consumer) ? CONSUMERS.get(consumer) : null
      if (consumerOwner !== owner) authentication()
    }
    if (!fixed(encoded, REDACTED_RESPONDER_PROOF_SIZE)) invalid()
    key = proofKey(encoded)
    assertOwner(owner, operation.lifecycle)
    if (owner.states.has(key)) replay()
    object = decodeM3Object(encoded)
    if (
      object.messageId !== M3_MESSAGE_ID.REDACTED_RESPONDER_PROOF_V1 ||
      !fixed(object.body, BODY_SIZE) ||
      !fixed(object.authSuffix, 64)
    ) {
      invalid()
    }
    projection = decodeBody(object.body)
    input = signatureInput(object.body)
    if (
      projection.expiresAtMs <= operation.current ||
      !cryptoSuite.verify(input, object.authSuffix, projection.responderIdentity)
    ) {
      authentication()
    }
    if (expected !== null) {
      expectedProjection = normalize(expected)
      assertOwner(owner, operation.lifecycle)
      if (!projectionsEqual(projection, expectedProjection)) authentication()
    }
    nonceKey = proofNonceKey(projection)
    if (owner.nonces.has(nonceKey)) replay()
    if (
      owner.live + owner.pending > MAX_LIVE_VERIFIED_RESPONDER_PROOFS ||
      owner.states.size + owner.pending > MAX_VERIFIED_RESPONDER_PROOF_STATES
    ) {
      busy()
    }
    owned = copy(encoded, REDACTED_RESPONDER_PROOF_SIZE)
    assertOwner(owner, operation.lifecycle)
    capability = Object.freeze({})
    state = {
      key,
      nonceKey,
      capability,
      encoded: owned,
      projection,
      deadline: projection.expiresAtMs,
      status: 'LIVE'
    }
    owner.states.set(key, state)
    stateInserted = true
    owner.nonces.set(nonceKey, key)
    nonceInserted = true
    CAPABILITIES.set(capability, { owner, state })
    capabilityInserted = true
    owner.live++
    owned = null
    projection = null
    published = true
    return capability
  } finally {
    if (capabilityInserted && !published) CAPABILITIES.delete(capability)
    if (nonceInserted && !published) owner.nonces.delete(nonceKey)
    if (stateInserted && !published) owner.states.delete(key)
    if (!published) clearState(state)
    clear(object && object.body)
    clear(object && object.authSuffix)
    clearProjection(projection)
    clearProjection(expectedProjection)
    clear(input)
    clear(owned)
    end(owner, operation)
  }
}

export function verifyRedactedResponderProof(verifier, encoded) {
  return verifyProof(verifier, null, encoded, null)
}

export function verifyExpectedRedactedResponderProof(verifier, consumer, encoded, expected) {
  return verifyProof(verifier, consumer, encoded, expected)
}

export function consumeVerifiedRedactedResponderProof(consumer, capability, expected) {
  const owner = safeObject(consumer) ? CONSUMERS.get(consumer) : null
  const operation = begin(owner)
  const binding = safeObject(capability) ? CAPABILITIES.get(capability) : null
  let projection = null
  try {
    if (!binding || binding.owner !== owner) authentication()
    const state = binding.state
    if (state.status !== 'LIVE') replay()
    if (state.deadline <= operation.current) authentication()
    projection = normalize(expected)
    assertOwner(owner, operation.lifecycle)
    if (!projectionsEqual(state.projection, projection)) authentication()
    const encoded = copy(state.encoded, REDACTED_RESPONDER_PROOF_SIZE)
    assertOwner(owner, operation.lifecycle)
    state.status = 'CONSUMED'
    owner.live--
    clearState(state)
    return encoded
  } finally {
    clearProjection(projection)
    end(owner)
  }
}

export function revokeVerifiedRedactedResponderProof(consumer, capability) {
  const owner = safeObject(consumer) ? CONSUMERS.get(consumer) : null
  const operation = begin(owner)
  try {
    const binding = safeObject(capability) ? CAPABILITIES.get(capability) : null
    if (!binding || binding.owner !== owner || binding.state.status !== 'LIVE') return false
    binding.state.status = 'REVOKED'
    owner.live--
    clearState(binding.state)
    assertOwner(owner, operation.lifecycle)
    return true
  } finally {
    end(owner)
  }
}
