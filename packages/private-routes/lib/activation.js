import b4a from 'b4a'
import sodium from 'sodium-universal'

import {
  ACTIVATION_FRAGMENT_TIMEOUT,
  ActivationReassembler,
  MAX_ACTIVATION_OBJECT,
  fragmentActivation
} from './activation-fragments.js'
import { isSafetyRouteChecker } from './circuit-authority.js'
import { cryptoSuite } from './crypto-suite.js'
import { CELL_SIZE, CellCodec } from './cell-codec.js'
import {
  AUTHORIZATION_MODE,
  decodeDelegation,
  decodeRelayAdvertisement,
  encodeDelegation,
  encodeUnsignedDelegation,
  encodeUnsignedRelayAdvertisement
} from './descriptor.js'
import { PrivateRouteError } from './errors.js'
import { TEST_ONLY_TICKET_OBSERVER, createLinkSetupAuthority } from './link-setup.js'
import { RelayService, TEST_ONLY_RELAY_OBSERVER } from './relay-service.js'
import { ACTOR_CONTROL_KIND, ActorControlCodec } from './remote-control.js'
import {
  ROUTE_ENDPOINT,
  RoutePayloadCodec,
  mintCreatedRoutePayloadContext
} from './route-payload.js'
import {
  CELL_CLASS,
  DIRECTION,
  DOMAIN,
  PROTOCOL_VERSION,
  ROLE,
  roleForIdentity
} from './protocol.js'

export const MAX_PRIVATE_HOPS = 3
export const DEFAULT_MAX_ACTOR_CIRCUITS = 128
export const MAX_PRIVATE_ADVERTISEMENT = 1024
export const MAX_ENCRYPTED_HOPS = 4096
export const PRIVATE_TEMPLATE_FIXED_SIZE = 101
export const PRIVATE_FINAL_TOKEN_SIZE = 64
export const SEALED_BOX_OVERHEAD = 48
export const CREATE_FIXED_SIZE = 219
export const CREATE_BASE_SIZE = 153
export const ENTRY_PROOF_UNSIGNED_SIZE = 129
export const ENTRY_PROOF_SIZE = 209
export const CREATED_UNSIGNED_SIZE = 225
export const CREATED_SIZE = 305
export const TEST_ONLY_ACTIVATION_OBSERVER = Symbol('test-only-activation-observer')
export const TEST_ONLY_DESTINATION_PROOF_MUTATOR = Symbol('test-only-destination-proof-mutator')
export const TEST_ONLY_DESTINATION_REGISTRATION_ACK_MUTATOR = Symbol(
  'test-only-destination-registration-ack-mutator'
)
export const TEST_ONLY_REGISTRATION_COMMAND_ACK_MUTATOR = Symbol(
  'test-only-registration-command-ack-mutator'
)
// Imported only by deep compiler tests. It is intentionally absent from the
// package entry point so production callers cannot select payload counters.
export const TEST_ONLY_ROUTE_PAYLOAD_COUNTERS = Symbol('test-only-route-payload-counters')
export const TEST_ONLY_ROUTE_FRAME_OBSERVER = Symbol('test-only-route-frame-observer')

export const ASYNC_REGISTRATION_STATE = Object.freeze({
  NEW: 'NEW',
  STAGED: 'STAGED',
  PREPARED: 'PREPARED',
  FINALIZED: 'FINALIZED',
  ABORTING: 'ABORTING',
  ABORTED: 'ABORTED',
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED'
})

export const ASYNC_CIRCUIT_STATE = Object.freeze({
  NEW: 'NEW',
  ACTIVATING: 'ACTIVATING',
  OPEN: 'OPEN',
  DESTROYING: 'DESTROYING',
  DESTROYED: 'DESTROYED'
})

const ASYNC_REGISTRATION_TRANSITIONS = Object.freeze({
  NEW: Object.freeze({ stage: ASYNC_REGISTRATION_STATE.STAGED }),
  STAGED: Object.freeze({
    prepare: ASYNC_REGISTRATION_STATE.PREPARED,
    abort: ASYNC_REGISTRATION_STATE.ABORTING
  }),
  PREPARED: Object.freeze({
    finalize: ASYNC_REGISTRATION_STATE.FINALIZED,
    abort: ASYNC_REGISTRATION_STATE.ABORTING
  }),
  FINALIZED: Object.freeze({
    expire: ASYNC_REGISTRATION_STATE.EXPIRED,
    revoke: ASYNC_REGISTRATION_STATE.REVOKED
  }),
  ABORTING: Object.freeze({ aborted: ASYNC_REGISTRATION_STATE.ABORTED })
})

const ASYNC_CIRCUIT_TRANSITIONS = Object.freeze({
  NEW: Object.freeze({ activate: ASYNC_CIRCUIT_STATE.ACTIVATING }),
  ACTIVATING: Object.freeze({
    opened: ASYNC_CIRCUIT_STATE.OPEN,
    destroy: ASYNC_CIRCUIT_STATE.DESTROYING
  }),
  OPEN: Object.freeze({ destroy: ASYNC_CIRCUIT_STATE.DESTROYING }),
  DESTROYING: Object.freeze({ destroyed: ASYNC_CIRCUIT_STATE.DESTROYED })
})

const TRANSACTION_REAFFIRMING_NONE = 0
const TRANSACTION_REAFFIRMING_STAGED = 1
const TRANSACTION_REAFFIRMING_PREPARED = 2

const MAX_U64 = 0xffff_ffff_ffff_ffffn
const DELEGATION_SIZE = 168
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const bufferByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get
const bufferFill = Uint8Array.prototype.fill
const bufferSet = Uint8Array.prototype.set
const bufferSubarray = Uint8Array.prototype.subarray
const REGISTRY_STATES = new WeakMap()
const ENTRY_REPLAY_STATES = new WeakMap()
const DESTINATION_REPLAY_STATES = new WeakMap()
const RELAY_ACTOR_STATES = new WeakMap()
const DESTINATION_ACTOR_STATES = new WeakMap()
const ACTOR_PUBLIC_INFOS = new WeakMap()
const ACTOR_SESSIONS = new WeakMap()
const MAX_ENTRY_REPLAYS = 4096
const MAX_TEMPLATE_RECORDS = 128
const REGISTRATION_CAPSULE_FINAL = 0
const REGISTRATION_CAPSULE_FORWARD = 1
const REGISTRATION_CAPSULE_PREPARE_FINAL = 2
const REGISTRATION_CAPSULE_PREPARE_FORWARD = 3
const REGISTRATION_CAPSULE_ABORT_FINAL = 4
const REGISTRATION_CAPSULE_ABORT_FORWARD = 5
const REGISTRATION_CAPSULE_FINALIZE_FINAL = 6
const REGISTRATION_CAPSULE_FINALIZE_FORWARD = 7
const REGISTRATION_TRANSACTION_SIZE = 16
const REGISTRATION_CAPSULE_HEADER = 38
const REGISTRATION_ACK_SIZE = 193
const REGISTRATION_ACK_HEADER = 2
const REGISTRATION_COMMAND_ACK = 0xff
const ACTIVATION_REQUEST_ENTRY = 0
const ACTIVATION_REQUEST_FORWARD = 1
const ACTIVATION_REQUEST_HEADER = 22
const ACTIVATION_PARAMETERS_SIZE = 19
const DESTINATION_ACTIVATION_REQUEST_HEADER = 19

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

// Shared by the synchronous fixture and the real asynchronous executor. This
// is the single allowlist for setup state changes; callers cannot skip a step
// by assigning state directly.
export function transitionAsyncControlState(scope, state, operation) {
  const table =
    scope === 'registration'
      ? ASYNC_REGISTRATION_TRANSITIONS
      : scope === 'circuit'
        ? ASYNC_CIRCUIT_TRANSITIONS
        : null
  if (!table || typeof state !== 'string' || typeof operation !== 'string') invalid()
  if (
    (scope === 'registration' &&
      operation === 'abort' &&
      (state === 'ABORTING' || state === 'ABORTED')) ||
    (scope === 'circuit' &&
      operation === 'destroy' &&
      (state === 'DESTROYING' || state === 'DESTROYED'))
  )
    return state
  const next = table[state] && table[state][operation]
  if (!next) throw PrivateRouteError.CIRCUIT_STATE()
  return next
}

function unauthorized() {
  throw PrivateRouteError.UNAUTHORIZED()
}

function replay() {
  throw PrivateRouteError.REPLAY()
}

function safeObject(value) {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  } catch {
    return false
  }
}

function actorPublicInfo(actor) {
  const value = safeObject(actor) ? ACTOR_PUBLIC_INFOS.get(actor) : null
  if (!value) unauthorized()
  return Object.freeze({
    identity: copy(value.identity),
    ...(value.routeSigningKey ? { routeSigningKey: copy(value.routeSigningKey) } : {}),
    routeEncryptionKey: copy(value.routeEncryptionKey)
  })
}

function option(value, name) {
  try {
    return value[name]
  } catch {
    invalid()
  }
}

function observePassively(callback, event) {
  if (!callback) return
  try {
    callback(Object.freeze(event))
  } catch {
    // Diagnostics cannot alter protocol state or outcomes.
  }
}

function length(value) {
  try {
    return b4a.isBuffer(value) ? bufferByteLength.call(value) : -1
  } catch {
    return -1
  }
}

function fixed(value, size) {
  return length(value) === size
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) bufferFill.call(value, 0)
  } catch {
    // Best-effort zeroization.
  }
}

function copy(value) {
  const size = length(value)
  if (size < 0) invalid()
  let output = null
  try {
    output = b4a.allocUnsafeSlow(size)
    bufferSet.call(output, value)
    return output
  } catch {
    clear(output)
    invalid()
  }
}

function slice(value, start, end) {
  try {
    return bufferSubarray.call(value, start, end)
  } catch {
    invalid()
  }
}

function same(a, b) {
  if (length(a) !== length(b) || length(a) < 0) return false
  try {
    return b4a.equals(a, b)
  } catch {
    return false
  }
}

function randomDistinct(randomBytes, size, excluded) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const value = randomBytes(size)
    if (!fixed(value, size)) {
      clear(value)
      invalid()
    }
    if (!same(value, excluded)) return value
    clear(value)
  }
  invalid()
}

function u64(value) {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_U64
}

function writeU16(output, value, offset) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) invalid()
  output[offset] = value >>> 8
  output[offset + 1] = value
}

function readU16(input, offset) {
  return input[offset] * 0x100 + input[offset + 1]
}

function writeU64(output, value, offset) {
  if (!u64(value)) invalid()
  for (let index = offset + 7; index >= offset; index--) {
    output[index] = Number(value & 0xffn)
    value >>= 8n
  }
}

function readU64(input, offset) {
  let value = 0n
  for (let index = offset; index < offset + 8; index++) value = (value << 8n) | BigInt(input[index])
  return value
}

function allocate(size) {
  let output = null
  try {
    output = b4a.allocUnsafeSlow(size)
    if (length(output) !== size) invalid()
    return output
  } catch {
    clear(output)
    invalid()
  }
}

function put(output, value, offset) {
  try {
    bufferSet.call(output, value, offset)
  } catch {
    invalid()
  }
}

function hash(parts) {
  let output = null
  try {
    output = cryptoSuite.hash(parts)
    if (!fixed(output, 32)) invalid()
    return copy(output)
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    clear(output)
  }
}

function sign(message, secretKey) {
  if (!fixed(secretKey, 64)) invalid()
  let value = null
  try {
    value = cryptoSuite.sign(message, secretKey)
    if (!fixed(value, 64)) invalid()
    return copy(value)
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    clear(value)
  }
}

function verify(message, signature, key) {
  try {
    return (
      fixed(signature, 64) && fixed(key, 32) && cryptoSuite.verify(message, signature, key) === true
    )
  } catch {
    return false
  }
}

function signed(domain, encoding) {
  const output = allocate(length(domain) + length(encoding))
  put(output, domain, 0)
  put(output, encoding, length(domain))
  return output
}

function validateTemplate(value) {
  if (
    !safeObject(value) ||
    option(value, 'version') !== PROTOCOL_VERSION ||
    !fixed(option(value, 'descriptorId'), 32) ||
    !fixed(option(value, 'templateId'), 16) ||
    !u64(option(value, 'epoch')) ||
    !u64(option(value, 'expiresAt')) ||
    !fixed(option(value, 'relayIdentity'), 32)
  )
    invalid()
  const advertisement = option(value, 'nextAdvertisement')
  const nextLayer = option(value, 'nextLayer')
  if (length(advertisement) < 0 || length(advertisement) > MAX_PRIVATE_ADVERTISEMENT) invalid()
  if (length(nextLayer) < 1 || length(nextLayer) > MAX_ENCRYPTED_HOPS) invalid()
}

export function encodePrivateTemplate(value) {
  validateTemplate(value)
  const advertisement = option(value, 'nextAdvertisement')
  const nextLayer = option(value, 'nextLayer')
  const output = allocate(PRIVATE_TEMPLATE_FIXED_SIZE + length(advertisement) + length(nextLayer))
  let offset = 0
  output[offset++] = PROTOCOL_VERSION
  for (const [field, size] of [
    ['descriptorId', 32],
    ['templateId', 16]
  ]) {
    put(output, option(value, field), offset)
    offset += size
  }
  writeU64(output, option(value, 'epoch'), offset)
  offset += 8
  writeU64(output, option(value, 'expiresAt'), offset)
  offset += 8
  put(output, option(value, 'relayIdentity'), offset)
  offset += 32
  writeU16(output, length(advertisement), offset)
  offset += 2
  put(output, advertisement, offset)
  offset += length(advertisement)
  writeU16(output, length(nextLayer), offset)
  offset += 2
  put(output, nextLayer, offset)
  return output
}

export function decodePrivateTemplate(message) {
  const size = length(message)
  if (size < PRIVATE_TEMPLATE_FIXED_SIZE || size > PRIVATE_TEMPLATE_FIXED_SIZE + 1024 + 4096)
    invalid()
  let offset = 0
  const value = { version: message[offset++] }
  let accepted = false
  try {
    value.descriptorId = copy(slice(message, offset, offset + 32))
    offset += 32
    value.templateId = copy(slice(message, offset, offset + 16))
    offset += 16
    value.epoch = readU64(message, offset)
    offset += 8
    value.expiresAt = readU64(message, offset)
    offset += 8
    value.relayIdentity = copy(slice(message, offset, offset + 32))
    offset += 32
    if (offset + 2 > size) invalid()
    const advertisementSize = readU16(message, offset)
    offset += 2
    if (advertisementSize > MAX_PRIVATE_ADVERTISEMENT || offset + advertisementSize + 2 > size)
      invalid()
    value.nextAdvertisement = copy(slice(message, offset, offset + advertisementSize))
    offset += advertisementSize
    const layerSize = readU16(message, offset)
    offset += 2
    if (layerSize < 1 || layerSize > MAX_ENCRYPTED_HOPS || offset + layerSize !== size) invalid()
    value.nextLayer = copy(slice(message, offset, size))
    validateTemplate(value)
    accepted = true
    return value
  } finally {
    if (!accepted) clearTree(value)
  }
}

function delegationSize(mode) {
  if (mode === AUTHORIZATION_MODE.DIRECT) return 0
  if (mode === AUTHORIZATION_MODE.DELEGATED) return DELEGATION_SIZE
  invalid()
}

function validateRegister(value, withSignature) {
  if (!safeObject(value) || option(value, 'version') !== PROTOCOL_VERSION) invalid()
  const mode = option(value, 'authorizationMode')
  delegationSize(mode)
  for (const [name, size] of [
    ['descriptorId', 32],
    ['templateId', 16],
    ['endpointKey', 32],
    ['routeSigningKey', 32],
    ['relayIdentity', 32],
    ['templateCommitment', 32],
    ['nextCommitment', 32]
  ])
    if (!fixed(option(value, name), size)) invalid()
  if (!u64(option(value, 'epoch')) || !u64(option(value, 'expiresAt'))) invalid()
  if (mode === AUTHORIZATION_MODE.DIRECT) {
    if (
      option(value, 'delegation') !== undefined ||
      !same(value.endpointKey, value.routeSigningKey)
    )
      invalid()
  } else {
    if (length(encodeDelegation(option(value, 'delegation'))) !== DELEGATION_SIZE) invalid()
  }
  if (withSignature && !fixed(option(value, 'destinationSignature'), 64)) invalid()
}

function encodeRegister(value, withSignature) {
  validateRegister(value, withSignature)
  const mode = value.authorizationMode
  const output = allocate(226 + delegationSize(mode) + (withSignature ? 64 : 0))
  let offset = 0
  output[offset++] = value.version
  output[offset++] = mode
  put(output, value.descriptorId, offset)
  offset += 32
  put(output, value.templateId, offset)
  offset += 16
  writeU64(output, value.epoch, offset)
  offset += 8
  writeU64(output, value.expiresAt, offset)
  offset += 8
  for (const name of [
    'endpointKey',
    'routeSigningKey',
    'relayIdentity',
    'templateCommitment',
    'nextCommitment'
  ]) {
    put(output, value[name], offset)
    offset += 32
  }
  if (mode === AUTHORIZATION_MODE.DELEGATED) {
    put(output, encodeDelegation(value.delegation), offset)
    offset += DELEGATION_SIZE
  }
  if (withSignature) put(output, value.destinationSignature, offset)
  return output
}

export function encodeTemplateRegisterUnsigned(value) {
  return encodeRegister(value, false)
}
export function encodeTemplateRegister(value) {
  return encodeRegister(value, true)
}

function decodeRegister(message, withSignature) {
  const size = length(message)
  if (
    size !== 226 + (withSignature ? 64 : 0) &&
    size !== 226 + DELEGATION_SIZE + (withSignature ? 64 : 0)
  )
    invalid()
  let offset = 0
  const value = { version: message[offset++], authorizationMode: message[offset++] }
  let accepted = false
  try {
    value.descriptorId = copy(slice(message, offset, offset + 32))
    offset += 32
    value.templateId = copy(slice(message, offset, offset + 16))
    offset += 16
    value.epoch = readU64(message, offset)
    offset += 8
    value.expiresAt = readU64(message, offset)
    offset += 8
    for (const name of [
      'endpointKey',
      'routeSigningKey',
      'relayIdentity',
      'templateCommitment',
      'nextCommitment'
    ]) {
      value[name] = copy(slice(message, offset, offset + 32))
      offset += 32
    }
    const expectedDelegation = delegationSize(value.authorizationMode)
    if (expectedDelegation) {
      value.delegation = decodeDelegation(copy(slice(message, offset, offset + DELEGATION_SIZE)))
      offset += DELEGATION_SIZE
    }
    if (withSignature) {
      value.destinationSignature = copy(slice(message, offset, offset + 64))
      offset += 64
    }
    if (offset !== size) invalid()
    validateRegister(value, withSignature)
    accepted = true
    return value
  } finally {
    if (!accepted) clearTree(value)
  }
}

export function decodeTemplateRegisterUnsigned(message) {
  return decodeRegister(message, false)
}
export function decodeTemplateRegister(message) {
  return decodeRegister(message, true)
}

function validateRegistered(value, withSignature) {
  if (
    !safeObject(value) ||
    value.version !== PROTOCOL_VERSION ||
    !fixed(value.descriptorId, 32) ||
    !fixed(value.templateId, 16) ||
    !u64(value.epoch) ||
    !u64(value.expiresAt) ||
    !fixed(value.relayIdentity, 32) ||
    !fixed(value.templateCommitment, 32) ||
    (withSignature && !fixed(value.relayIdentitySignature, 64))
  )
    invalid()
}

function encodeRegistered(value, withSignature) {
  validateRegistered(value, withSignature)
  const output = allocate(129 + (withSignature ? 64 : 0))
  let offset = 0
  output[offset++] = value.version
  put(output, value.descriptorId, offset)
  offset += 32
  put(output, value.templateId, offset)
  offset += 16
  writeU64(output, value.epoch, offset)
  offset += 8
  writeU64(output, value.expiresAt, offset)
  offset += 8
  put(output, value.relayIdentity, offset)
  offset += 32
  put(output, value.templateCommitment, offset)
  offset += 32
  if (withSignature) put(output, value.relayIdentitySignature, offset)
  return output
}

export function encodeTemplateRegisteredUnsigned(value) {
  return encodeRegistered(value, false)
}
export function encodeTemplateRegistered(value) {
  return encodeRegistered(value, true)
}

function decodeRegistered(message, withSignature) {
  if (!fixed(message, 129 + (withSignature ? 64 : 0))) invalid()
  let offset = 0
  const value = { version: message[offset++] }
  let accepted = false
  try {
    value.descriptorId = copy(slice(message, offset, offset + 32))
    offset += 32
    value.templateId = copy(slice(message, offset, offset + 16))
    offset += 16
    value.epoch = readU64(message, offset)
    offset += 8
    value.expiresAt = readU64(message, offset)
    offset += 8
    value.relayIdentity = copy(slice(message, offset, offset + 32))
    offset += 32
    value.templateCommitment = copy(slice(message, offset, offset + 32))
    offset += 32
    if (withSignature) value.relayIdentitySignature = copy(slice(message, offset, offset + 64))
    validateRegistered(value, withSignature)
    accepted = true
    return value
  } finally {
    if (!accepted) clearTree(value)
  }
}

export function decodeTemplateRegisteredUnsigned(message) {
  return decodeRegistered(message, false)
}
export function decodeTemplateRegistered(message) {
  return decodeRegistered(message, true)
}

function verifyAdvertisement(encoding, epoch, expiresAt, now) {
  if (length(encoding) > MAX_PRIVATE_ADVERTISEMENT) invalid()
  const advertisement = decodeRelayAdvertisement(encoding)
  if (
    advertisement.role !== ROLE.PRIVATE ||
    roleForIdentity(advertisement.identityKey) !== ROLE.PRIVATE
  )
    invalid()
  if (
    advertisement.epoch !== epoch ||
    advertisement.expiresAt < expiresAt ||
    advertisement.expiresAt <= now
  )
    invalid()
  const unsigned = encodeUnsignedRelayAdvertisement(advertisement)
  const message = signed(DOMAIN.RELAY_ADVERTISEMENT, unsigned)
  const valid = verify(message, advertisement.relaySignature, advertisement.identityKey)
  clear(message)
  if (!valid) unauthorized()
  return advertisement
}

function sealTemplate(plaintext, publicKey) {
  const output = allocate(length(plaintext) + SEALED_BOX_OVERHEAD)
  try {
    sodium.crypto_box_seal(output, plaintext, publicKey)
    return output
  } catch {
    clear(output)
    invalid()
  }
}

function openTemplate(ciphertext, publicKey, secretKey) {
  if (length(ciphertext) < SEALED_BOX_OVERHEAD || !fixed(publicKey, 32) || !fixed(secretKey, 32))
    unauthorized()
  const output = allocate(length(ciphertext) - SEALED_BOX_OVERHEAD)
  try {
    const result = sodium.crypto_box_seal_open(output, ciphertext, publicKey, secretKey)
    if (result === false) unauthorized()
    return output
  } catch (err) {
    clear(output)
    if (err instanceof PrivateRouteError) throw err
    unauthorized()
  }
}

function verifyAuthorization(register, now) {
  const unsigned = encodeTemplateRegisterUnsigned(register)
  const message = signed(DOMAIN.TEMPLATE_REGISTER, unsigned)
  const valid = verify(message, register.destinationSignature, register.routeSigningKey)
  clear(message)
  if (!valid) unauthorized()
  if (register.authorizationMode === AUTHORIZATION_MODE.DIRECT) return
  const delegation = register.delegation
  if (
    !same(delegation.endpointKey, register.endpointKey) ||
    !same(delegation.routeSigningKey, register.routeSigningKey) ||
    now < delegation.notBefore ||
    now >= delegation.expiresAt ||
    register.epoch < delegation.minEpoch ||
    register.epoch > delegation.maxEpoch ||
    register.expiresAt > delegation.expiresAt
  )
    unauthorized()
  const delegationMessage = signed(DOMAIN.DELEGATION, encodeUnsignedDelegation(delegation))
  const delegationValid = verify(
    delegationMessage,
    delegation.endpointSignature,
    delegation.endpointKey
  )
  clear(delegationMessage)
  if (!delegationValid) unauthorized()
}

function registrationKey(value) {
  return `${b4a.toString(value.descriptorId, 'hex')}:${b4a.toString(value.templateId, 'hex')}:${value.epoch}`
}

export function buildPrivateTemplates(options) {
  if (!safeObject(options)) invalid()
  const relays = option(options, 'relays')
  const randomBytes = option(options, 'randomBytes') || cryptoSuite.randomBytes
  const now = option(options, 'now')
  if (
    !Array.isArray(relays) ||
    relays.length < 1 ||
    relays.length > MAX_PRIVATE_HOPS ||
    typeof randomBytes !== 'function' ||
    !u64(now)
  )
    invalid()
  if (
    !fixed(options.descriptorId, 32) ||
    !u64(options.epoch) ||
    !u64(options.expiresAt) ||
    options.expiresAt <= now ||
    !fixed(options.endpointKey, 32) ||
    !fixed(options.routeSigningKey, 32) ||
    !fixed(options.destinationSecretKey, 64) ||
    !fixed(options.finalToken, PRIVATE_FINAL_TOKEN_SIZE)
  )
    invalid()
  delegationSize(options.authorizationMode)
  const advertisements = relays.map((encoding) => copy(encoding))
  const decoded = advertisements.map((encoding) =>
    verifyAdvertisement(encoding, options.epoch, options.expiresAt, now)
  )
  const identities = new Set()
  const dials = new Set()
  for (const advertisement of decoded) {
    const identity = b4a.toString(advertisement.identityKey, 'hex')
    const dial = b4a.toString(advertisement.dial, 'hex')
    if (identities.has(identity) || dials.has(dial)) invalid()
    identities.add(identity)
    dials.add(dial)
  }
  let nextLayer = copy(options.finalToken)
  let registrationCapsule = b4a.alloc(0)
  let prepareCapsule = b4a.alloc(0)
  let finalizeCapsule = b4a.alloc(0)
  let abortCapsule = b4a.alloc(0)
  let transactionId = null
  const registrations = new Array(relays.length)
  try {
    for (let index = relays.length - 1; index >= 0; index--) {
      const templateId = randomBytes(16)
      if (!fixed(templateId, 16)) invalid()
      const template = {
        version: PROTOCOL_VERSION,
        descriptorId: options.descriptorId,
        templateId,
        epoch: options.epoch,
        expiresAt: options.expiresAt,
        relayIdentity: decoded[index].identityKey,
        nextAdvertisement: index + 1 < relays.length ? advertisements[index + 1] : b4a.alloc(0),
        nextLayer
      }
      const plaintext = encodePrivateTemplate(template)
      const projected = length(plaintext) + SEALED_BOX_OVERHEAD
      if (projected > MAX_ENCRYPTED_HOPS) {
        clear(plaintext)
        invalid()
      }
      const sealedTemplate = sealTemplate(plaintext, decoded[index].routeEncryptionKey)
      clear(plaintext)
      const unsigned = {
        version: PROTOCOL_VERSION,
        authorizationMode: options.authorizationMode,
        descriptorId: options.descriptorId,
        templateId,
        epoch: options.epoch,
        expiresAt: options.expiresAt,
        endpointKey: options.endpointKey,
        routeSigningKey: options.routeSigningKey,
        relayIdentity: decoded[index].identityKey,
        templateCommitment: hash([sealedTemplate]),
        nextCommitment: hash([nextLayer]),
        ...(options.authorizationMode === AUTHORIZATION_MODE.DELEGATED
          ? { delegation: options.delegation }
          : {})
      }
      const unsignedEncoding = encodeTemplateRegisterUnsigned(unsigned)
      const signatureMessage = signed(DOMAIN.TEMPLATE_REGISTER, unsignedEncoding)
      const destinationSignature = sign(signatureMessage, options.destinationSecretKey)
      clear(signatureMessage)
      const message = encodeTemplateRegister({ ...unsigned, destinationSignature })
      registrations[index] = Object.freeze({ message, sealedTemplate: copy(sealedTemplate) })
      clear(nextLayer)
      nextLayer = sealedTemplate
    }
    transactionId = randomBytes(REGISTRATION_TRANSACTION_SIZE)
    if (!fixed(transactionId, REGISTRATION_TRANSACTION_SIZE)) invalid()
    for (let index = registrations.length - 1; index >= 0; index--) {
      let envelope = null
      let capsule = null
      let sealedCapsule = null
      try {
        envelope = encodeRegistrationEnvelope(registrations[index])
        capsule = encodeRegistrationCapsule({
          operation:
            index + 1 === registrations.length
              ? REGISTRATION_CAPSULE_FINAL
              : REGISTRATION_CAPSULE_FORWARD,
          envelope,
          nextCapsule: registrationCapsule,
          transactionId,
          epoch: options.epoch,
          expiresAt: options.expiresAt
        })
        sealedCapsule = sealTemplate(capsule, decoded[index].routeEncryptionKey)
        if (length(sealedCapsule) > MAX_ACTIVATION_OBJECT) invalid()
        clear(registrationCapsule)
        registrationCapsule = sealedCapsule
        sealedCapsule = null
      } finally {
        clear(envelope)
        clear(capsule)
        clear(sealedCapsule)
      }
    }
    for (const action of ['prepare', 'finalize', 'abort']) {
      let command = b4a.alloc(0)
      try {
        for (let index = registrations.length - 1; index >= 0; index--) {
          let capsule = null
          let sealedCapsule = null
          try {
            const final = index + 1 === registrations.length
            capsule = encodeRegistrationCapsule({
              operation:
                action === 'prepare'
                  ? final
                    ? REGISTRATION_CAPSULE_PREPARE_FINAL
                    : REGISTRATION_CAPSULE_PREPARE_FORWARD
                  : action === 'finalize'
                    ? final
                      ? REGISTRATION_CAPSULE_FINALIZE_FINAL
                      : REGISTRATION_CAPSULE_FINALIZE_FORWARD
                    : final
                      ? REGISTRATION_CAPSULE_ABORT_FINAL
                      : REGISTRATION_CAPSULE_ABORT_FORWARD,
              envelope: b4a.alloc(0),
              nextCapsule: command,
              transactionId,
              epoch: options.epoch,
              expiresAt: options.expiresAt
            })
            sealedCapsule = sealTemplate(capsule, decoded[index].routeEncryptionKey)
            if (length(sealedCapsule) > MAX_ACTIVATION_OBJECT) invalid()
            clear(command)
            command = sealedCapsule
            sealedCapsule = null
          } finally {
            clear(capsule)
            clear(sealedCapsule)
          }
        }
        if (action === 'prepare') prepareCapsule = copy(command)
        else if (action === 'finalize') finalizeCapsule = copy(command)
        else abortCapsule = copy(command)
      } finally {
        clear(command)
      }
    }
    const built = Object.freeze({
      encryptedHops: copy(nextLayer),
      registrationCapsule: copy(registrationCapsule),
      prepareCapsule: copy(prepareCapsule),
      finalizeCapsule: copy(finalizeCapsule),
      abortCapsule: copy(abortCapsule),
      transactionId: copy(transactionId),
      registrations: Object.freeze(registrations),
      finalToken: copy(options.finalToken)
    })
    return built
  } catch (err) {
    for (const registration of registrations) {
      if (registration) {
        clear(registration.message)
        clear(registration.sealedTemplate)
      }
    }
    throw err
  } finally {
    clear(nextLayer)
    clear(registrationCapsule)
    clear(prepareCapsule)
    clear(finalizeCapsule)
    clear(abortCapsule)
    clear(transactionId)
  }
}

export function createTemplateRegistry(options) {
  if (
    !safeObject(options) ||
    !fixed(options.identity, 32) ||
    !fixed(options.identitySecretKey, 64) ||
    !fixed(options.routeEncryptionSecretKey, 32) ||
    typeof options.now !== 'function'
  )
    invalid()
  const identity = copy(options.identity)
  const identitySecretKey = copy(options.identitySecretKey)
  const routeEncryptionSecretKey = copy(options.routeEncryptionSecretKey)
  const now = options.now
  const publicKey = allocate(32)
  try {
    sodium.crypto_scalarmult_base(publicKey, routeEncryptionSecretKey)
  } catch {
    clear(identity)
    clear(identitySecretKey)
    clear(routeEncryptionSecretKey)
    clear(publicKey)
    invalid()
  }
  const routeEncryptionPublicKey = copy(publicKey)
  const records = new Map()
  const activations = new Map()
  let destroyed = false
  function ensureLive() {
    if (destroyed) throw PrivateRouteError.CIRCUIT_STATE()
  }
  function current() {
    ensureLive()
    let value
    try {
      value = now()
    } catch {
      invalid()
    }
    if (!Number.isSafeInteger(value) || value < 0) invalid()
    return BigInt(value)
  }
  function prune(now) {
    for (const [key, record] of records)
      if (record.expiresAt <= now) {
        clearRecord(record)
        records.delete(key)
      }
    for (const [key, expiry] of activations) if (expiry <= now) activations.delete(key)
  }
  function clearRecord(record) {
    for (const value of Object.values(record)) clear(value)
  }
  function registerEnvelope(envelope, includeRouting, transactionId = null) {
    ensureLive()
    if (!safeObject(envelope)) invalid()
    const register = decodeTemplateRegister(option(envelope, 'message'))
    const sealedTemplate = option(envelope, 'sealedTemplate')
    const now = current()
    let plaintext = null
    let template = null
    prune(now)
    try {
      if (
        register.expiresAt <= now ||
        !same(register.relayIdentity, identity) ||
        !same(hash([sealedTemplate]), register.templateCommitment)
      )
        unauthorized()
      verifyAuthorization(register, now)
      plaintext = openTemplate(sealedTemplate, publicKey, routeEncryptionSecretKey)
      template = decodePrivateTemplate(plaintext)
      if (
        !same(template.descriptorId, register.descriptorId) ||
        !same(template.templateId, register.templateId) ||
        template.epoch !== register.epoch ||
        template.expiresAt !== register.expiresAt ||
        !same(template.relayIdentity, register.relayIdentity) ||
        !same(hash([template.nextLayer]), register.nextCommitment)
      )
        unauthorized()
      const key = registrationKey(register)
      const existing = records.get(key)
      const inserted = !existing
      if (
        existing &&
        (!same(existing.commitment, register.templateCommitment) ||
          !same(existing.nextCommitment, register.nextCommitment))
      )
        replay()
      if (
        existing &&
        !existing.committed &&
        (!transactionId || !same(existing.stagedTransactionId, transactionId))
      )
        replay()
      if (existing && existing.committed) {
        if (transactionId && same(existing.stagedTransactionId, transactionId)) {
          existing.reaffirming = TRANSACTION_REAFFIRMING_STAGED
        } else {
          clear(existing.stagedTransactionId)
          existing.stagedTransactionId = null
          existing.reaffirming = TRANSACTION_REAFFIRMING_NONE
        }
      }
      if (!existing) {
        if (records.size >= MAX_TEMPLATE_RECORDS) throw PrivateRouteError.CIRCUIT_LIMIT()
        records.set(key, {
          descriptorId: copy(register.descriptorId),
          templateId: copy(register.templateId),
          epoch: register.epoch,
          expiresAt: register.expiresAt,
          commitment: copy(register.templateCommitment),
          nextCommitment: copy(register.nextCommitment),
          committed: transactionId === null,
          prepared: transactionId === null,
          stagedTransactionId: transactionId ? copy(transactionId) : null,
          reaffirming: TRANSACTION_REAFFIRMING_NONE
        })
      }
      const ackUnsigned = {
        version: PROTOCOL_VERSION,
        descriptorId: register.descriptorId,
        templateId: register.templateId,
        epoch: register.epoch,
        expiresAt: register.expiresAt,
        relayIdentity: identity,
        templateCommitment: register.templateCommitment
      }
      const ackMessage = signed(
        DOMAIN.TEMPLATE_REGISTERED,
        encodeTemplateRegisteredUnsigned(ackUnsigned)
      )
      const relayIdentitySignature = sign(ackMessage, identitySecretKey)
      clear(ackMessage)
      const ack = encodeTemplateRegistered({ ...ackUnsigned, relayIdentitySignature })
      if (!includeRouting) return ack
      return Object.freeze({
        ack,
        inserted,
        nextAdvertisement: copy(template.nextAdvertisement),
        nextLayer: copy(template.nextLayer),
        epoch: template.epoch,
        expiresAt: template.expiresAt
      })
    } finally {
      clear(plaintext)
      clearTree(template)
    }
  }
  const registry = Object.freeze({
    get size() {
      ensureLive()
      prune(current())
      return records.size
    },
    register(envelope) {
      return registerEnvelope(envelope, false)
    },
    activate(tuple) {
      ensureLive()
      if (!safeObject(tuple)) invalid()
      const now = current()
      prune(now)
      const record = records.get(registrationKey(tuple))
      if (
        !record ||
        !record.committed ||
        !same(record.commitment, option(tuple, 'templateCommitment'))
      )
        unauthorized()
      return Object.freeze({ expiresAt: record.expiresAt })
    },
    inspect() {
      ensureLive()
      prune(current())
      return Array.from(records.values(), (record) => ({
        descriptorId: copy(record.descriptorId),
        templateId: copy(record.templateId),
        epoch: record.epoch,
        expiresAt: record.expiresAt,
        commitment: copy(record.commitment),
        nextCommitment: copy(record.nextCommitment)
      }))
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      for (const record of records.values()) clearRecord(record)
      records.clear()
      activations.clear()
      clear(identity)
      clear(identitySecretKey)
      clear(routeEncryptionSecretKey)
      clear(routeEncryptionPublicKey)
      clear(publicKey)
      REGISTRY_STATES.delete(registry)
    }
  })
  REGISTRY_STATES.set(registry, {
    identity,
    identitySecretKey,
    routeEncryptionPublicKey,
    routeEncryptionSecretKey,
    records,
    activations,
    prune,
    registerForTraversal(envelope, transactionId) {
      ensureLive()
      if (!fixed(transactionId, REGISTRATION_TRANSACTION_SIZE)) invalid()
      return registerEnvelope(envelope, true, transactionId)
    },
    finishTransaction(transactionId, action) {
      ensureLive()
      if (
        !fixed(transactionId, REGISTRATION_TRANSACTION_SIZE) ||
        (action !== 'prepare' && action !== 'finalize' && action !== 'abort')
      )
        invalid()
      let changed = 0
      for (const [key, record] of records) {
        if (!same(record.stagedTransactionId, transactionId)) continue
        if (record.committed && action !== 'abort') {
          if (action === 'prepare' && record.reaffirming === TRANSACTION_REAFFIRMING_STAGED) {
            record.reaffirming = TRANSACTION_REAFFIRMING_PREPARED
            changed++
          } else if (
            action === 'finalize' &&
            record.reaffirming === TRANSACTION_REAFFIRMING_PREPARED
          ) {
            clear(record.stagedTransactionId)
            record.stagedTransactionId = null
            record.reaffirming = TRANSACTION_REAFFIRMING_NONE
            changed++
          }
          continue
        }
        changed++
        if (action === 'prepare') {
          record.prepared = true
        } else if (action === 'finalize') {
          if (record.prepared !== true) unauthorized()
          record.committed = true
        } else {
          clearRecord(record)
          records.delete(key)
        }
      }
      return changed
    },
    rollbackRegistration(value, transactionId) {
      const key = registrationKey(value)
      const record = records.get(key)
      if (
        !record ||
        record.committed ||
        !fixed(transactionId, REGISTRATION_TRANSACTION_SIZE) ||
        !same(record.stagedTransactionId, transactionId)
      )
        return false
      clearRecord(record)
      records.delete(key)
      return true
    }
  })
  return registry
}

export function createPrivateRelayActor(options) {
  const commandAckMutator = safeObject(options)
    ? option(options, TEST_ONLY_REGISTRATION_COMMAND_ACK_MUTATOR)
    : undefined
  const relayObserver = safeObject(options) ? option(options, TEST_ONLY_RELAY_OBSERVER) : undefined
  if (
    !safeObject(options) ||
    !fixed(options.identity, 32) ||
    !fixed(options.identitySecretKey, 64) ||
    !fixed(options.routeEncryptionSecretKey, 32) ||
    typeof options.now !== 'function' ||
    typeof options.randomBytes !== 'function' ||
    (options.waitForCreated !== undefined && typeof options.waitForCreated !== 'function') ||
    (options.transmit !== undefined && typeof options.transmit !== 'function') ||
    (options.observe !== undefined && typeof options.observe !== 'function') ||
    (commandAckMutator !== undefined && typeof commandAckMutator !== 'function') ||
    (relayObserver !== undefined && typeof relayObserver !== 'function') ||
    (options.maxCircuits !== undefined &&
      (!Number.isSafeInteger(options.maxCircuits) ||
        options.maxCircuits < 1 ||
        options.maxCircuits > DEFAULT_MAX_ACTOR_CIRCUITS)) ||
    (options.next !== undefined && !RELAY_ACTOR_STATES.has(options.next)) ||
    (options.destination !== undefined && !DESTINATION_ACTOR_STATES.has(options.destination)) ||
    (options.next !== undefined && options.destination !== undefined)
  )
    invalid()
  const registry = createTemplateRegistry({
    identity: options.identity,
    identitySecretKey: options.identitySecretKey,
    routeEncryptionSecretKey: options.routeEncryptionSecretKey,
    now: options.now
  })
  const registryState = REGISTRY_STATES.get(registry)
  const actor = Object.freeze({})
  const next = options.next || null
  const destination = options.destination || null
  const observe = options.observe || null
  const maxCircuits = options.maxCircuits || DEFAULT_MAX_ACTOR_CIRCUITS
  const entryReplayCache = createEntryReplayCache({
    now: options.now,
    maxEntries: maxCircuits
  })
  const circuits = new Map()
  let destroyed = false
  function circuitKey(value) {
    if (!fixed(value, 16)) invalid()
    return b4a.toString(value, 'hex')
  }
  function readCircuit(value) {
    const record = circuits.get(circuitKey(value))
    if (destroyed || !record) throw PrivateRouteError.CIRCUIT_STATE()
    return record
  }
  const state = {
    isDestroyed() {
      return destroyed
    },
    capability() {
      return actor
    },
    transmit(peer, packet, receive, reverse = false, synchronous = false) {
      const peerCapability =
        safeObject(peer) && typeof peer.capability === 'function' ? peer.capability() : peer
      if (destroyed || !safeObject(peerCapability) || typeof receive !== 'function') unauthorized()
      if (!options.transmit) {
        receive(packet)
        return true
      }
      const accepted = options.transmit(
        reverse ? peerCapability : actor,
        reverse ? actor : peerCapability,
        packet,
        receive,
        synchronous
      )
      if (
        accepted !== true &&
        (!safeObject(accepted) ||
          Object.keys(accepted).join(',') !== 'cancel' ||
          typeof accepted.cancel !== 'function')
      )
        throw PrivateRouteError.ROUTE_UNAVAILABLE()
      return accepted
    },
    bindPrevious(circuitId, value, transport, epoch, expiresAt) {
      if (
        !RELAY_ACTOR_STATES.has(value) ||
        !safeObject(transport) ||
        typeof transport.reverse !== 'function' ||
        !u64(epoch) ||
        !u64(expiresAt)
      )
        unauthorized()
      const key = circuitKey(circuitId)
      let record = circuits.get(key)
      if (!record) {
        if (circuits.size >= maxCircuits) throw PrivateRouteError.CIRCUIT_LIMIT()
        record = {
          circuitId: copy(circuitId),
          epoch,
          expiresAt,
          previous: null,
          next: null,
          destination: null,
          safetyReverse: null,
          pendingActivation: true
        }
        circuits.set(key, record)
      }
      if (
        record.epoch !== epoch ||
        record.expiresAt !== expiresAt ||
        (record.previous && record.previous.actor !== value)
      )
        unauthorized()
      record.previous = { actor: value, transport }
    },
    bindNext(circuitId, value, transport) {
      const record = readCircuit(circuitId)
      if (
        !RELAY_ACTOR_STATES.has(value) ||
        !safeObject(transport) ||
        typeof transport.forward !== 'function' ||
        (record.next && record.next.actor !== value)
      )
        unauthorized()
      record.next = { actor: value, transport }
    },
    bindDestination(circuitId, value, transport) {
      const record = readCircuit(circuitId)
      if (
        !DESTINATION_ACTOR_STATES.has(value) ||
        !safeObject(transport) ||
        typeof transport.forward !== 'function' ||
        record.destination
      )
        unauthorized()
      record.destination = { actor: value, transport }
    },
    now: options.now,
    randomBytes: options.randomBytes,
    publicInfo() {
      if (destroyed) throw PrivateRouteError.CIRCUIT_STATE()
      return Object.freeze({
        identity: copy(registryState.identity),
        routeEncryptionKey: copy(registryState.routeEncryptionPublicKey)
      })
    },
    routeBinding(circuitId) {
      const record = readCircuit(circuitId)
      return Object.freeze({ epoch: record.epoch, expiresAt: record.expiresAt })
    },
    routeTransport(circuitId, forward) {
      const record = readCircuit(circuitId)
      const binding = forward ? record.next : record.previous
      if (!binding) throw PrivateRouteError.CIRCUIT_STATE()
      return binding.transport
    },
    initiateLink(authority, common, responderStaticKey) {
      if (destroyed) throw PrivateRouteError.CIRCUIT_STATE()
      return authority.initiate({
        ...common,
        responderStaticKey,
        initiatorIdentitySecretKey: registryState.identitySecretKey
      })
    },
    acceptLink(authority, message, common) {
      if (destroyed) throw PrivateRouteError.CIRCUIT_STATE()
      return authority.respond(message, {
        ...common,
        responderStaticSecretKey: registryState.routeEncryptionSecretKey,
        responderIdentitySecretKey: registryState.identitySecretKey
      })
    },
    observePacket(peerIdentity, packet, details = null) {
      if (!observe) return
      const digest = hash([packet])
      try {
        observePassively(observe, {
          localIdentity: b4a.toString(registryState.identity, 'hex'),
          peerIdentity: b4a.toString(peerIdentity, 'hex'),
          packetHash: b4a.toString(digest, 'hex'),
          packetBytes: length(packet),
          ...(details || {})
        })
      } finally {
        clear(digest)
      }
    },
    observeState(details) {
      if (!observe) return
      observePassively(observe, {
        localIdentity: b4a.toString(registryState.identity, 'hex'),
        ...details
      })
    },
    mutateCommandAcknowledgement(value) {
      if (!commandAckMutator) return value
      return commandAckMutator(value)
    },
    receiveRegistration(transport, expectedKind = null) {
      if (destroyed) unauthorized()
      let plaintext = null
      let capsule = null
      let envelope = null
      let registered = null
      let advertisement = null
      let register = null
      let inserted = false
      let complete = false
      try {
        plaintext = openTemplate(
          transport,
          registryState.routeEncryptionPublicKey,
          registryState.routeEncryptionSecretKey
        )
        capsule = decodeRegistrationCapsule(plaintext)
        if (expectedKind !== null && !registrationOperationMatches(expectedKind, capsule.operation))
          unauthorized()
        const commandPrepare =
          capsule.operation === REGISTRATION_CAPSULE_PREPARE_FINAL ||
          capsule.operation === REGISTRATION_CAPSULE_PREPARE_FORWARD
        const commandFinalize =
          capsule.operation === REGISTRATION_CAPSULE_FINALIZE_FINAL ||
          capsule.operation === REGISTRATION_CAPSULE_FINALIZE_FORWARD
        const commandAbort =
          capsule.operation === REGISTRATION_CAPSULE_ABORT_FINAL ||
          capsule.operation === REGISTRATION_CAPSULE_ABORT_FORWARD
        if (commandPrepare || commandFinalize || commandAbort) {
          const forward =
            capsule.operation === REGISTRATION_CAPSULE_PREPARE_FORWARD ||
            capsule.operation === REGISTRATION_CAPSULE_FINALIZE_FORWARD ||
            capsule.operation === REGISTRATION_CAPSULE_ABORT_FORWARD
          if (forward) {
            if (!next) unauthorized()
            const acknowledged = actorControlTransport(
              state,
              next,
              capsule.nextCapsule,
              capsule.epoch,
              capsule.expiresAt,
              commandFinalize ? 'finalize' : true
            )
            if (acknowledged !== true) throw PrivateRouteError.ROUTE_UNAVAILABLE()
          } else if (next || !destination) {
            unauthorized()
          }
          const action = commandPrepare ? 'prepare' : commandFinalize ? 'finalize' : 'abort'
          registryState.finishTransaction(capsule.transactionId, action)
          complete = true
          state.observeState({
            type:
              action === 'prepare'
                ? 'private-registration-prepared'
                : action === 'finalize'
                  ? 'private-registration-commit'
                  : 'private-registration-rollback',
            records: registryState.records.size
          })
          return true
        }
        envelope = decodeRegistrationEnvelope(capsule.envelope)
        registered = registryState.registerForTraversal(envelope, capsule.transactionId)
        register = decodeTemplateRegister(envelope.message)
        if (register.epoch !== capsule.epoch || register.expiresAt !== capsule.expiresAt)
          unauthorized()
        inserted = registered.inserted
        verifyRegistrationAck(registered.ack, register)
        if (capsule.operation === REGISTRATION_CAPSULE_FINAL) {
          if (
            next ||
            !destination ||
            length(registered.nextAdvertisement) !== 0 ||
            !fixed(registered.nextLayer, PRIVATE_FINAL_TOKEN_SIZE)
          )
            unauthorized()
          const value = actorDestinationRegistrationTransport(
            state,
            destination,
            registered.nextLayer,
            register.epoch,
            register.expiresAt
          )
          complete = value === true
          if (complete)
            state.observeState({
              type: 'private-registration-staged',
              records: registryState.records.size
            })
          return [copy(registered.ack)]
        }
        if (!next) unauthorized()
        const nextPublic = actorPublicInfo(next)
        try {
          advertisement = decodeRelayAdvertisement(registered.nextAdvertisement)
          if (
            !same(advertisement.identityKey, nextPublic.identity) ||
            !same(advertisement.routeEncryptionKey, nextPublic.routeEncryptionKey)
          )
            unauthorized()
          const acknowledgements = actorControlTransport(
            state,
            next,
            capsule.nextCapsule,
            register.epoch,
            register.expiresAt
          )
          if (!Array.isArray(acknowledgements) || acknowledgements.length >= MAX_PRIVATE_HOPS)
            unauthorized()
          complete = true
          return [copy(registered.ack), ...acknowledgements.map(copy)]
        } finally {
          clearTree(nextPublic)
        }
      } finally {
        if (!complete && inserted && register) {
          registryState.rollbackRegistration(register, capsule && capsule.transactionId)
          state.observeState({
            type: 'private-registration-rollback',
            records: registryState.records.size
          })
        }
        clear(plaintext)
        clearTree(capsule)
        clearTree(envelope)
        clearTree(registered)
        clearTree(advertisement)
        clearTree(register)
      }
    },
    receiveActivation(request) {
      return state.receiveActivationRequest(request, true, false)
    },
    receiveActivationForReply(request) {
      return state.receiveActivationRequest(request, true, true)
    },
    receiveActivationRequest(request, expectedEntry, returnProof) {
      let decodedRequest = null
      let decodedCreate = null
      try {
        decodedRequest = decodeActivationRequest(request)
        if (decodedRequest.entry !== expectedEntry) unauthorized()
        decodedCreate = decodeCreate(decodedRequest.create)
        return state.receiveActivationLayer(
          decodedRequest.entry ? decodedCreate.encryptedHops : decodedRequest.layer,
          decodedRequest.create,
          {
            descriptorId: decodedCreate.descriptorId,
            epoch: decodedCreate.epoch,
            circuitId: decodedCreate.circuitId,
            expiresAt: decodedRequest.expiresAt,
            parameters: decodedRequest.parameters,
            startedAt: decodedRequest.startedAt,
            entryProof: decodedRequest.entry ? null : decodedRequest.entryProof,
            returnProof
          }
        )
      } finally {
        clearTree(decodedRequest)
        clearTree(decodedCreate)
      }
    },
    receiveActivationLayer(layer, create, context) {
      if (destroyed) throw PrivateRouteError.CIRCUIT_STATE()
      const decodedCreate = decodeCreate(create)
      if (
        !same(decodedCreate.descriptorId, context.descriptorId) ||
        decodedCreate.epoch !== context.epoch ||
        !same(decodedCreate.circuitId, context.circuitId)
      )
        unauthorized()
      let plaintext = null
      let template = null
      let entryProof = context.entryProof || null
      try {
        plaintext = openTemplate(
          layer,
          registryState.routeEncryptionPublicKey,
          registryState.routeEncryptionSecretKey
        )
        template = decodePrivateTemplate(plaintext)
        registryState.prune(BigInt(options.now()))
        if (
          !same(template.descriptorId, context.descriptorId) ||
          template.epoch !== context.epoch ||
          template.expiresAt !== context.expiresAt ||
          !same(template.relayIdentity, registryState.identity)
        )
          unauthorized()
        const record = registryState.records.get(registrationKey(template))
        if (
          !record ||
          record.committed !== true ||
          !same(record.commitment, hash([layer])) ||
          !same(record.nextCommitment, hash([template.nextLayer]))
        )
          unauthorized()
        const replayKey = `${registrationKey(template)}:${b4a.toString(decodedCreate.sourceEphemeralKey, 'hex')}:${b4a.toString(decodedCreate.circuitId, 'hex')}`
        if (registryState.activations.has(replayKey)) replay()
        const key = circuitKey(context.circuitId)
        const pendingCircuit = circuits.get(key)
        if (!pendingCircuit && circuits.size >= maxCircuits) throw PrivateRouteError.CIRCUIT_LIMIT()
        if (registryState.activations.size >= maxCircuits) throw PrivateRouteError.CIRCUIT_LIMIT()
        registryState.activations.set(replayKey, template.expiresAt)
        if (pendingCircuit) {
          if (
            pendingCircuit.pendingActivation !== true ||
            pendingCircuit.epoch !== context.epoch ||
            pendingCircuit.expiresAt !== context.expiresAt
          )
            replay()
          pendingCircuit.pendingActivation = false
        } else {
          circuits.set(key, {
            circuitId: copy(context.circuitId),
            epoch: context.epoch,
            expiresAt: context.expiresAt,
            previous: null,
            next: null,
            destination: null,
            safetyReverse: null,
            pendingActivation: false
          })
        }
        if (!entryProof) {
          entryProof = createEntryProof({
            create,
            entryIdentity: registryState.identity,
            entryIdentitySecretKey: registryState.identitySecretKey,
            entryRouteEncryptionSecretKey: registryState.routeEncryptionSecretKey,
            expectedDescriptorId: context.descriptorId,
            expectedEpoch: context.epoch,
            expectedCircuitId: context.circuitId,
            expiresAt: context.expiresAt,
            startedAt: context.startedAt,
            now: options.now,
            replayCache: entryReplayCache
          })
        }
        if (next) {
          const nextPublic = actorPublicInfo(next)
          let nextRequest = null
          try {
            const advertisement = decodeRelayAdvertisement(template.nextAdvertisement)
            if (
              !same(advertisement.identityKey, nextPublic.identity) ||
              !same(advertisement.routeEncryptionKey, nextPublic.routeEncryptionKey)
            )
              unauthorized()
            nextRequest = encodeActivationRequest({
              entry: false,
              create,
              layer: template.nextLayer,
              expiresAt: context.expiresAt,
              startedAt: context.startedAt,
              parameters: context.parameters,
              entryProof
            })
            return actorActivationTransport(state, next, nextRequest, context.returnProof)
          } finally {
            clear(nextRequest)
            clearTree(nextPublic)
          }
        }
        if (
          !destination ||
          length(template.nextAdvertisement) !== 0 ||
          !fixed(template.nextLayer, PRIVATE_FINAL_TOKEN_SIZE)
        )
          unauthorized()
        const destinationRequest = encodeDestinationActivationRequest({
          finalToken: template.nextLayer,
          create,
          entryProof,
          parameters: context.parameters,
          expiresAt: context.expiresAt,
          startedAt: context.startedAt
        })
        let complete
        try {
          complete = actorDestinationActivationTransport(
            state,
            destination,
            destinationRequest,
            context.returnProof
          )
        } finally {
          clear(destinationRequest)
        }
        const destinationSession = ACTOR_SESSIONS.get(destination)
        if (!destinationSession) unauthorized()
        destinationSession.bindRouteActor(context.circuitId, state.capability())
        return complete
      } finally {
        clearTree(decodedCreate)
        clear(plaintext)
        clearTree(template)
        if (!context.entryProof) clear(entryProof)
      }
    },
    forwardFrame(circuitId, cellClass, frame, deliver) {
      if (destroyed || typeof deliver !== 'function' || length(frame) !== 1100)
        throw PrivateRouteError.CIRCUIT_STATE()
      const record = readCircuit(circuitId)
      if (record.next) return actorFrameTransport(state, circuitId, cellClass, frame, deliver, true)
      if (record.destination) return record.destination.transport.forward(cellClass, frame, deliver)
      throw PrivateRouteError.CIRCUIT_STATE()
    },
    bindSafetyReverse(circuitId, epoch, expiresAt, send, teardown) {
      if (
        circuits.has(circuitKey(circuitId)) ||
        !u64(epoch) ||
        !u64(expiresAt) ||
        typeof send !== 'function' ||
        typeof teardown !== 'function'
      )
        unauthorized()
      if (circuits.size >= maxCircuits) throw PrivateRouteError.CIRCUIT_LIMIT()
      circuits.set(circuitKey(circuitId), {
        circuitId: copy(circuitId),
        epoch,
        expiresAt,
        previous: null,
        next: null,
        destination: null,
        safetyReverse: { send, teardown },
        pendingActivation: true
      })
    },
    unbindSafetyReverse(circuitId) {
      const record = circuits.get(circuitKey(circuitId))
      if (record) record.safetyReverse = null
    },
    reverseFrame(circuitId, cellClass, frame) {
      if (destroyed || length(frame) !== 1100) throw PrivateRouteError.CIRCUIT_STATE()
      const record = readCircuit(circuitId)
      if (record.previous)
        return actorFrameTransport(state, circuitId, cellClass, frame, null, false)
      if (!record.safetyReverse) throw PrivateRouteError.CIRCUIT_STATE()
      return record.safetyReverse.send(cellClass, frame)
    },
    reverseControl(circuitId, payload) {
      if (destroyed || length(payload) < 1) throw PrivateRouteError.CIRCUIT_STATE()
      const record = readCircuit(circuitId)
      if (record.previous) return record.previous.transport.reverse(CELL_CLASS.CONTROL, payload)
      if (!record.safetyReverse) throw PrivateRouteError.CIRCUIT_STATE()
      return record.safetyReverse.send(CELL_CLASS.CONTROL, payload)
    },
    destroyCircuit(circuitId) {
      const key = circuitKey(circuitId)
      const record = circuits.get(key)
      if (!record) return false
      circuits.delete(key)
      const safetyReverse = record.safetyReverse
      record.safetyReverse = null
      let firstError = null
      const attempt = (action) => {
        try {
          action()
        } catch (err) {
          if (!firstError) firstError = err
        }
      }
      if (record.next) attempt(() => record.next.transport.destroy(true))
      if (record.destination) attempt(() => record.destination.transport.destroy(true))
      if (record.previous) {
        attempt(() => record.previous.transport.destroy(false))
        const previousSession = ACTOR_SESSIONS.get(record.previous.actor)
        if (previousSession) attempt(() => previousSession.destroyCircuit(record.circuitId))
      }
      if (safetyReverse) attempt(safetyReverse.teardown)
      clear(record.circuitId)
      state.observeState({
        type: 'private-circuit-destroyed',
        activeCircuits: circuits.size,
        activationReplayTombstones: registryState.activations.size,
        entryReplayTombstones: ENTRY_REPLAY_STATES.get(entryReplayCache).entries.size
      })
      if (firstError) throw firstError
      return true
    },
    activeCircuitCount() {
      return circuits.size
    },
    openSafetyBinding(authority, inboundTicket, common) {
      if (destroyed) throw PrivateRouteError.CIRCUIT_STATE()
      const terminalIdentity = cryptoSuite.keyPair(options.randomBytes(32))
      const terminalEncryption = cryptoSuite.encryptionKeyPair(options.randomBytes(32))
      const outboundCommon = {
        circuitId: common.circuitId,
        epoch: common.epoch,
        initiatorIdentity: registryState.identity,
        responderIdentity: terminalIdentity.publicKey,
        initiatorLocalId: randomDistinct(options.randomBytes, 16, common.responderLocalId),
        responderLocalId: options.randomBytes(16),
        expiresAt: common.expiresAt
      }
      const started = state.initiateLink(authority, outboundCommon, terminalEncryption.publicKey)
      const accepted = authority.respond(started.message, {
        ...outboundCommon,
        responderStaticSecretKey: terminalEncryption.secretKey,
        responderIdentitySecretKey: terminalIdentity.secretKey
      })
      const outboundTicket = authority.complete(started.pending, accepted.message)
      const terminalEndpoint = endpointLink(authority.checker, accepted.ticket)
      const previousIdentity = copy(common.initiatorIdentity)
      const previousLocalId = copy(common.responderLocalId)
      const controls = []
      let forwarded = null
      let reversePacket = null
      let live = true
      const service = new RelayService({
        identity: registryState.identity,
        ticketChecker: authority.checker,
        crypto: cryptoSuite,
        now: options.now,
        padding: (size) => b4a.alloc(size),
        send(peerIdentity, packet) {
          if (!live) return false
          if (same(peerIdentity, terminalIdentity.publicKey)) {
            const cellClass = packet[1]
            const opened = terminalEndpoint.open(cellClass, DIRECTION.FORWARD, packet)
            forwarded = Array.isArray(opened) ? opened[0] : opened
            return true
          }
          if (same(peerIdentity, previousIdentity)) {
            clear(reversePacket)
            reversePacket = copy(packet)
            return true
          }
          return false
        },
        onControl(event) {
          if (event.direction !== DIRECTION.FORWARD) return false
          controls.push(copy(event.payload))
          return true
        },
        [TEST_ONLY_RELAY_OBSERVER](event) {
          observePassively(relayObserver, event)
          if (event.type === 'zeroized')
            state.observeState({
              type: 'private-binding-zeroized',
              contexts: event.contexts,
              queuedBytes: event.queuedBytes
            })
        }
      })
      service.install(inboundTicket, outboundTicket)
      service.created(common.initiatorIdentity, common.responderLocalId)
      service.open(common.initiatorIdentity, common.responderLocalId)
      return Object.freeze({
        receive(fromIdentity, packet) {
          state.observePacket(fromIdentity, packet)
          service.receive(fromIdentity, packet)
        },
        takeControls() {
          return controls.splice(0)
        },
        takeForward() {
          const value = forwarded
          forwarded = null
          return value
        },
        sendReverse(cellClass, frame) {
          let packet = null
          try {
            packet = terminalEndpoint.seal(cellClass, DIRECTION.REVERSE, frame)
            service.receive(terminalIdentity.publicKey, packet)
            const value = reversePacket
            reversePacket = null
            return value
          } finally {
            clear(packet)
          }
        },
        nextReverseCounter(cellClass) {
          return terminalEndpoint.nextCounter(cellClass)
        },
        destroy(fromIdentity) {
          if (!live) return
          live = false
          try {
            service.destroy(fromIdentity, previousLocalId)
          } finally {
            terminalEndpoint.destroy()
            clear(forwarded)
            clear(reversePacket)
            for (const control of controls) clear(control)
            controls.length = 0
            clear(previousIdentity)
            clear(previousLocalId)
            clear(terminalIdentity.secretKey)
            clear(terminalEncryption.secretKey)
          }
        }
      })
    },
    openRegistrationBinding(authority, inboundTicket, common) {
      if (destroyed) throw PrivateRouteError.CIRCUIT_STATE()
      const terminalIdentity = cryptoSuite.keyPair(options.randomBytes(32))
      const terminalEncryption = cryptoSuite.encryptionKeyPair(options.randomBytes(32))
      const outboundCommon = {
        circuitId: common.circuitId,
        epoch: common.epoch,
        initiatorIdentity: registryState.identity,
        responderIdentity: terminalIdentity.publicKey,
        initiatorLocalId: randomDistinct(options.randomBytes, 16, common.responderLocalId),
        responderLocalId: options.randomBytes(16),
        expiresAt: common.expiresAt
      }
      const started = state.initiateLink(authority, outboundCommon, terminalEncryption.publicKey)
      const accepted = authority.respond(started.message, {
        ...outboundCommon,
        responderStaticSecretKey: terminalEncryption.secretKey,
        responderIdentitySecretKey: terminalIdentity.secretKey
      })
      const outboundTicket = authority.complete(started.pending, accepted.message)
      const terminalEndpoint = endpointLink(authority.checker, accepted.ticket)
      const receiver = new ActivationReassembler({ now: options.now })
      const previousIdentity = copy(common.initiatorIdentity)
      let result = null
      let pendingRequest = null
      let reversePacket = null
      const acknowledgementPackets = []
      const service = new RelayService({
        identity: registryState.identity,
        ticketChecker: authority.checker,
        crypto: cryptoSuite,
        now: options.now,
        padding: (size) => b4a.alloc(size),
        send(peerIdentity, packet) {
          if (same(peerIdentity, terminalIdentity.publicKey)) {
            const cellClass = packet[1]
            const opened = terminalEndpoint.open(cellClass, DIRECTION.FORWARD, packet)
            clearTree(opened)
            return true
          }
          if (same(peerIdentity, previousIdentity)) {
            clear(reversePacket)
            reversePacket = copy(packet)
            return true
          }
          return false
        },
        onControl(event) {
          if (event.direction !== DIRECTION.FORWARD) return false
          const value = receiver.pushAuthenticated(event.payload)
          if (value) {
            try {
              pendingRequest = copy(value)
            } finally {
              clear(value)
            }
          }
          return true
        }
      })
      service.install(inboundTicket, outboundTicket)
      return Object.freeze({
        receive(fromIdentity, packet) {
          state.observePacket(fromIdentity, packet)
          service.receive(fromIdentity, packet)
          if (!pendingRequest) return
          const request = pendingRequest
          pendingRequest = null
          let encoded = null
          try {
            service.created(common.initiatorIdentity, common.responderLocalId)
            result = state.receiveRegistration(request)
            encoded =
              result === true
                ? b4a.from([PROTOCOL_VERSION, REGISTRATION_COMMAND_ACK])
                : encodeRegistrationAcknowledgements(result)
            const fragments = fragmentActivation(encoded, {
              messageId: options.randomBytes(16)
            })
            for (const fragment of fragments) {
              let responsePacket = null
              try {
                responsePacket = terminalEndpoint.seal(
                  CELL_CLASS.CONTROL,
                  DIRECTION.REVERSE,
                  fragment
                )
                service.receive(terminalIdentity.publicKey, responsePacket)
                if (!reversePacket) throw PrivateRouteError.ROUTE_UNAVAILABLE()
                acknowledgementPackets.push(reversePacket)
                reversePacket = null
              } finally {
                clear(fragment)
                clear(responsePacket)
              }
            }
          } finally {
            clear(request)
            clear(encoded)
          }
        },
        takeAcknowledgementPackets() {
          return acknowledgementPackets.splice(0)
        },
        destroy(fromIdentity) {
          try {
            service.destroy(fromIdentity, common.responderLocalId)
          } finally {
            receiver.destroy()
            terminalEndpoint.destroy()
            clearTree(result)
            clear(pendingRequest)
            clear(reversePacket)
            for (const packet of acknowledgementPackets) clear(packet)
            acknowledgementPackets.length = 0
            clear(previousIdentity)
            clear(terminalIdentity.secretKey)
            clear(terminalEncryption.secretKey)
          }
        }
      })
    },
    openActivationBinding(authority, inboundTicket, common, returnProof = false) {
      if (destroyed) throw PrivateRouteError.CIRCUIT_STATE()
      const terminalIdentity = cryptoSuite.keyPair(options.randomBytes(32))
      const terminalEncryption = cryptoSuite.encryptionKeyPair(options.randomBytes(32))
      const outboundCommon = {
        circuitId: common.circuitId,
        epoch: common.epoch,
        initiatorIdentity: registryState.identity,
        responderIdentity: terminalIdentity.publicKey,
        initiatorLocalId: randomDistinct(options.randomBytes, 16, common.responderLocalId),
        responderLocalId: options.randomBytes(16),
        expiresAt: common.expiresAt
      }
      const started = state.initiateLink(authority, outboundCommon, terminalEncryption.publicKey)
      const accepted = authority.respond(started.message, {
        ...outboundCommon,
        responderStaticSecretKey: terminalEncryption.secretKey,
        responderIdentitySecretKey: terminalIdentity.secretKey
      })
      const outboundTicket = authority.complete(started.pending, accepted.message)
      const terminalEndpoint = endpointLink(authority.checker, accepted.ticket)
      const previousIdentity = copy(common.initiatorIdentity)
      const previousLocalId = copy(common.responderLocalId)
      const receiver = new ActivationReassembler({ now: options.now })
      let forwarded = null
      let reversePacket = null
      let result = null
      let pendingRequest = null
      let live = true
      const service = new RelayService({
        identity: registryState.identity,
        ticketChecker: authority.checker,
        crypto: cryptoSuite,
        now: options.now,
        padding: (size) => b4a.alloc(size),
        send(peerIdentity, packet) {
          if (!live) return true
          if (same(peerIdentity, terminalIdentity.publicKey)) {
            const cellClass = packet[1]
            const opened = terminalEndpoint.open(cellClass, DIRECTION.FORWARD, packet)
            forwarded = Array.isArray(opened) ? opened[0] : opened
            return true
          }
          if (same(peerIdentity, previousIdentity)) {
            reversePacket = copy(packet)
            return true
          }
          return false
        },
        onControl(event) {
          if (event.direction === DIRECTION.REVERSE) return false
          const value = receiver.pushAuthenticated(event.payload)
          if (value) {
            try {
              pendingRequest = copy(value)
            } finally {
              clear(value)
            }
          }
          return true
        },
        [TEST_ONLY_RELAY_OBSERVER](event) {
          observePassively(relayObserver, event)
          if (event.type === 'zeroized')
            state.observeState({
              type: 'private-binding-zeroized',
              contexts: event.contexts,
              queuedBytes: event.queuedBytes
            })
        }
      })
      service.install(inboundTicket, outboundTicket)
      return Object.freeze({
        receive(fromIdentity, packet) {
          state.observePacket(fromIdentity, packet)
          service.receive(fromIdentity, packet)
          if (!pendingRequest) return
          const request = pendingRequest
          pendingRequest = null
          try {
            service.created(common.initiatorIdentity, common.responderLocalId)
            result = state.receiveActivationRequest(request, false, returnProof)
          } finally {
            clear(request)
          }
        },
        open() {
          service.open(common.initiatorIdentity, common.responderLocalId)
        },
        result() {
          return result
        },
        takeForward() {
          const value = forwarded
          forwarded = null
          return value
        },
        sendReverse(cellClass, frame) {
          let packet = null
          try {
            packet = terminalEndpoint.seal(cellClass, DIRECTION.REVERSE, frame)
            service.receive(terminalIdentity.publicKey, packet)
            const value = reversePacket
            reversePacket = null
            return value
          } finally {
            clear(packet)
          }
        },
        nextReverseCounter(cellClass) {
          return terminalEndpoint.nextCounter(cellClass)
        },
        destroy(fromIdentity) {
          if (!live) return
          live = false
          try {
            service.destroy(fromIdentity, previousLocalId)
          } finally {
            receiver.destroy()
            terminalEndpoint.destroy()
            clear(forwarded)
            clear(reversePacket)
            clear(pendingRequest)
            clear(previousIdentity)
            clear(previousLocalId)
            clear(terminalIdentity.secretKey)
            clear(terminalEncryption.secretKey)
          }
        }
      })
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      let firstError = null
      const attempt = (action) => {
        try {
          action()
        } catch (err) {
          if (!firstError) firstError = err
        }
      }
      for (const record of Array.from(circuits.values()))
        attempt(() => state.destroyCircuit(record.circuitId))
      const records = registry.size
      state.observeState({
        type: 'private-relay-destroying',
        records,
        activationReplayTombstones: registryState.activations.size,
        entryReplayTombstones: entryReplayCache.size
      })
      attempt(() => registry.destroy())
      ACTOR_PUBLIC_INFOS.delete(actor)
      ACTOR_SESSIONS.delete(actor)
      if (firstError) throw firstError
    }
  }
  RELAY_ACTOR_STATES.set(actor, state)
  ACTOR_PUBLIC_INFOS.set(actor, {
    identity: registryState.identity,
    routeEncryptionKey: registryState.routeEncryptionPublicKey
  })
  ACTOR_SESSIONS.set(
    actor,
    Object.freeze({
      bindSafetyReverse: state.bindSafetyReverse.bind(state),
      destroyCircuit: state.destroyCircuit.bind(state),
      forwardFrame: state.forwardFrame.bind(state),
      receiveActivation: state.receiveActivation.bind(state),
      receiveRegistration: state.receiveRegistration.bind(state),
      unbindSafetyReverse: state.unbindSafetyReverse.bind(state)
    })
  )
  return actor
}

export function destroyPrivateRelayActor(actor) {
  const state = safeObject(actor) ? RELAY_ACTOR_STATES.get(actor) : null
  if (!state) unauthorized()
  if (state.isDestroyed()) return
  state.destroy()
}

export function createPrivateDestinationActor(options) {
  const proofMutator = safeObject(options)
    ? option(options, TEST_ONLY_DESTINATION_PROOF_MUTATOR)
    : undefined
  const registrationAckMutator = safeObject(options)
    ? option(options, TEST_ONLY_DESTINATION_REGISTRATION_ACK_MUTATOR)
    : undefined
  if (
    !safeObject(options) ||
    !fixed(options.identity, 32) ||
    !fixed(options.identitySecretKey, 64) ||
    !fixed(options.routeSigningKey, 32) ||
    !fixed(options.routeSigningSecretKey, 64) ||
    !fixed(options.routeEncryptionSecretKey, 32) ||
    !fixed(options.finalToken, PRIVATE_FINAL_TOKEN_SIZE) ||
    typeof options.now !== 'function' ||
    typeof options.randomBytes !== 'function' ||
    (proofMutator !== undefined && typeof proofMutator !== 'function') ||
    (registrationAckMutator !== undefined && typeof registrationAckMutator !== 'function') ||
    (options.maxCircuits !== undefined &&
      (!Number.isSafeInteger(options.maxCircuits) ||
        options.maxCircuits < 1 ||
        options.maxCircuits > DEFAULT_MAX_ACTOR_CIRCUITS)) ||
    (options.observe !== undefined && typeof options.observe !== 'function')
  )
    invalid()
  const identity = copy(options.identity)
  const identitySecretKey = copy(options.identitySecretKey)
  const routeSigningKey = copy(options.routeSigningKey)
  const routeSigningSecretKey = copy(options.routeSigningSecretKey)
  const routeEncryptionSecretKey = copy(options.routeEncryptionSecretKey)
  const routeEncryptionKey = allocate(32)
  const finalToken = copy(options.finalToken)
  sodium.crypto_scalarmult_base(routeEncryptionKey, routeEncryptionSecretKey)
  const maxCircuits = options.maxCircuits || DEFAULT_MAX_ACTOR_CIRCUITS
  const replayCache = createDestinationReplayCache({
    now: options.now,
    maxEntries: maxCircuits
  })
  const observe = options.observe || null
  const circuitKeys = new Set()
  const reverse = new Map()
  const routeActors = new Map()
  const transports = new Map()
  let destroyed = false
  const actor = Object.freeze({})
  ACTOR_PUBLIC_INFOS.set(actor, {
    identity,
    routeSigningKey,
    routeEncryptionKey
  })
  function circuitKey(value) {
    if (!fixed(value, 16)) invalid()
    return b4a.toString(value, 'hex')
  }
  function retainCircuit(key) {
    if (circuitKeys.has(key)) return
    if (circuitKeys.size >= maxCircuits) throw PrivateRouteError.CIRCUIT_LIMIT()
    circuitKeys.add(key)
  }
  const state = {
    capability() {
      return actor
    },
    publicInfo() {
      if (destroyed) throw PrivateRouteError.CIRCUIT_STATE()
      return Object.freeze({
        identity: copy(identity),
        routeSigningKey: copy(routeSigningKey),
        routeEncryptionKey: copy(routeEncryptionKey)
      })
    },
    acceptLink(authority, message, common) {
      if (destroyed) throw PrivateRouteError.CIRCUIT_STATE()
      return authority.respond(message, {
        ...common,
        responderStaticSecretKey: routeEncryptionSecretKey,
        responderIdentitySecretKey: identitySecretKey
      })
    },
    acceptRegistration(token, circuitId) {
      if (destroyed || !same(token, finalToken)) unauthorized()
      let acknowledgement = registrationAcknowledgement(circuitId, token)
      if (!registrationAckMutator) return acknowledgement
      try {
        const changed = registrationAckMutator(copy(acknowledgement))
        if (changed === null) return null
        if (!fixed(changed, 32)) invalid()
        return changed
      } finally {
        clear(acknowledgement)
      }
    },
    observeState(details) {
      observePassively(observe, { ...details })
    },
    createActivationReceiver() {
      if (destroyed) throw PrivateRouteError.CIRCUIT_STATE()
      const receiver = new ActivationReassembler({ now: options.now })
      let complete = false
      return Object.freeze({
        receive(fragment) {
          if (complete || destroyed) throw PrivateRouteError.CIRCUIT_STATE()
          const request = receiver.pushAuthenticated(fragment)
          if (!request) return null
          complete = true
          let decoded = null
          let decodedCreate = null
          let proof = null
          try {
            decoded = decodeDestinationActivationRequest(request)
            if (!same(decoded.finalToken, finalToken)) unauthorized()
            decodedCreate = decodeCreate(decoded.create)
            proof = createDestinationProof({
              create: decoded.create,
              entryProof: decoded.entryProof,
              endpointIdentity: identity,
              routeSigningKey,
              routeSigningSecretKey,
              destinationRouteEncryptionSecretKey: routeEncryptionSecretKey,
              expectedDescriptorId: decodedCreate.descriptorId,
              expectedEpoch: decodedCreate.epoch,
              expectedCircuitId: decodedCreate.circuitId,
              parameters: decoded.parameters,
              expiresAt: decoded.expiresAt,
              startedAt: decoded.startedAt,
              now: options.now,
              replayCache
            })
            if (!proofMutator) return proof
            const changed = proofMutator(copy(proof))
            if (!fixed(changed, CREATED_SIZE)) invalid()
            return changed
          } finally {
            clear(request)
            clearTree(decoded)
            clearTree(decodedCreate)
            if (proofMutator) clear(proof)
          }
        },
        destroy() {
          receiver.destroy()
          complete = true
        }
      })
    },
    bindReverse(circuitId, send, teardown) {
      const key = circuitKey(circuitId)
      if (
        destroyed ||
        typeof send !== 'function' ||
        typeof teardown !== 'function' ||
        reverse.has(key)
      )
        unauthorized()
      retainCircuit(key)
      reverse.set(key, { send, teardown })
    },
    unbindReverse(circuitId) {
      reverse.delete(circuitKey(circuitId))
    },
    bindRouteActor(circuitId, value) {
      const key = circuitKey(circuitId)
      const current = routeActors.get(key)
      if (destroyed || !RELAY_ACTOR_STATES.has(value) || (current && current !== value))
        unauthorized()
      retainCircuit(key)
      routeActors.set(key, value)
    },
    bindTransport(circuitId, transport) {
      const key = circuitKey(circuitId)
      if (
        destroyed ||
        !safeObject(transport) ||
        typeof transport.reverse !== 'function' ||
        transports.has(key)
      )
        unauthorized()
      retainCircuit(key)
      transports.set(key, transport)
    },
    reverseFrame(circuitId, cellClass, frame) {
      const transport = transports.get(circuitKey(circuitId))
      if (destroyed || !transport) throw PrivateRouteError.CIRCUIT_STATE()
      return transport.reverse(cellClass, frame)
    },
    routeActor(circuitId) {
      const value = routeActors.get(circuitKey(circuitId))
      if (destroyed || !value) throw PrivateRouteError.CIRCUIT_STATE()
      return value
    },
    sendPayload(cellClass, payload, circuitId) {
      let send
      if (circuitId === undefined) {
        if (reverse.size !== 1) throw PrivateRouteError.CIRCUIT_STATE()
        send = reverse.values().next().value.send
      } else {
        send = reverse.get(circuitKey(circuitId))?.send
      }
      if (destroyed || !send) throw PrivateRouteError.CIRCUIT_STATE()
      send(cellClass, payload)
    },
    destroyCircuit(circuitId) {
      const key = circuitKey(circuitId)
      const existed = reverse.has(key) || routeActors.has(key) || transports.has(key)
      reverse.delete(key)
      routeActors.delete(key)
      transports.delete(key)
      circuitKeys.delete(key)
      if (existed)
        this.observeState({
          type: 'private-destination-circuit-destroyed',
          activeCircuits: circuitKeys.size,
          reverseBindings: reverse.size,
          routeActors: routeActors.size,
          activationReplayTombstones: DESTINATION_REPLAY_STATES.get(replayCache).entries.size
        })
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      let firstError = null
      const attempt = (action) => {
        try {
          action()
        } catch (err) {
          if (!firstError) firstError = err
        }
      }
      for (const binding of Array.from(reverse.values())) attempt(binding.teardown)
      for (const [key, routeActor] of Array.from(routeActors)) {
        const session = ACTOR_SESSIONS.get(routeActor)
        if (!session) continue
        const circuitId = b4a.from(key, 'hex')
        try {
          attempt(() => session.destroyCircuit(circuitId))
        } finally {
          clear(circuitId)
        }
      }
      for (const transport of Array.from(transports.values()))
        attempt(() => transport.destroy(false))
      reverse.clear()
      routeActors.clear()
      transports.clear()
      circuitKeys.clear()
      clear(identity)
      clear(identitySecretKey)
      clear(routeSigningKey)
      clear(routeSigningSecretKey)
      clear(routeEncryptionSecretKey)
      clear(routeEncryptionKey)
      clear(finalToken)
      ACTOR_PUBLIC_INFOS.delete(actor)
      ACTOR_SESSIONS.delete(actor)
      if (firstError) throw firstError
    }
  }
  DESTINATION_ACTOR_STATES.set(actor, state)
  ACTOR_SESSIONS.set(
    actor,
    Object.freeze({
      bindReverse: state.bindReverse.bind(state),
      bindRouteActor: state.bindRouteActor.bind(state),
      destroyCircuit: state.destroyCircuit.bind(state),
      reverseFrame: state.reverseFrame.bind(state),
      unbindReverse: state.unbindReverse.bind(state)
    })
  )
  return actor
}

export function sendPrivateDestinationStream(actor, payload, circuitId) {
  const state = safeObject(actor) ? DESTINATION_ACTOR_STATES.get(actor) : null
  if (!state) unauthorized()
  state.sendPayload(CELL_CLASS.STREAM, payload, circuitId)
}

export function sendPrivateDestinationDatagram(actor, payload, circuitId) {
  const state = safeObject(actor) ? DESTINATION_ACTOR_STATES.get(actor) : null
  if (!state) unauthorized()
  state.sendPayload(CELL_CLASS.DATAGRAM, payload, circuitId)
}

export function destroyPrivateDestinationActor(actor) {
  const state = safeObject(actor) ? DESTINATION_ACTOR_STATES.get(actor) : null
  if (!state) unauthorized()
  state.destroy()
}

// Remote circuit ownership follows the actor capability, not an individual
// host registration. One actor may legitimately be reachable through several
// adjacent links, but only the adapter which reserved a generation may mutate
// that circuit. Records remain as tombstones so stale generations cannot be
// rebound after teardown.
const REMOTE_ACTOR_AUTHORITIES = new WeakMap()

function remoteActorAuthority(actor) {
  let authority = REMOTE_ACTOR_AUTHORITIES.get(actor)
  if (!authority) {
    authority = { circuits: new Map() }
    REMOTE_ACTOR_AUTHORITIES.set(actor, authority)
  }
  return authority
}

// Package-internal boundary used by RemoteActorHost. The public actor capability
// remains frozen and methodless; only canonical ActorControl bytes enter or
// leave this adapter.
export function createActorCommandAdapter(actor) {
  const relayState = safeObject(actor) ? RELAY_ACTOR_STATES.get(actor) : null
  const destinationState = safeObject(actor) ? DESTINATION_ACTOR_STATES.get(actor) : null
  if (!relayState && !destinationState) unauthorized()
  const codec = new ActorControlCodec()
  const authority = remoteActorAuthority(actor)
  const owner = Object.freeze({})

  function reserve(circuitId, generation) {
    const key = b4a.toString(circuitId, 'hex')
    const current = authority.circuits.get(key)
    if (!current && authority.circuits.size >= DEFAULT_MAX_ACTOR_CIRCUITS)
      throw PrivateRouteError.CIRCUIT_LIMIT()
    if (current) {
      if (current.owner !== owner) unauthorized()
      if (current.state !== 'destroyed' || generation <= current.generation) unauthorized()
    }
    const record = { owner, generation, state: 'activating', circuitId: copy(circuitId) }
    authority.circuits.set(key, record)
    return { key, record, previous: current || null }
  }

  function releaseReservation(reservation, destroy) {
    const { key, record, previous } = reservation
    if (authority.circuits.get(key) !== record) return false
    if (destroy) {
      try {
        if (relayState) relayState.destroyCircuit(record.circuitId)
        else destinationState.destroyCircuit(record.circuitId)
      } catch {}
    }
    if (previous) authority.circuits.set(key, previous)
    else authority.circuits.delete(key)
    clear(record.circuitId)
    return true
  }

  function commitReservation(reservation) {
    const { key, record, previous } = reservation
    if (authority.circuits.get(key) !== record || record.state !== 'activating') unauthorized()
    record.state = 'open'
    if (previous) clear(previous.circuitId)
  }

  return Object.freeze({
    execute(message) {
      const request = codec.decode(message)
      let body = null
      let response = null
      try {
        switch (request.kind) {
          case ACTOR_CONTROL_KIND.REGISTER_STAGE: {
            if (!relayState) unauthorized()
            const acknowledgements = relayState.receiveRegistration(request.body, request.kind)
            try {
              body = encodeRegistrationAcknowledgements(acknowledgements)
            } finally {
              clearTree(acknowledgements)
            }
            break
          }
          case ACTOR_CONTROL_KIND.REGISTER_PREPARE:
          case ACTOR_CONTROL_KIND.REGISTER_FINALIZE:
          case ACTOR_CONTROL_KIND.REGISTER_ABORT:
            if (!relayState || relayState.receiveRegistration(request.body, request.kind) !== true)
              unauthorized()
            body = b4a.from([PROTOCOL_VERSION, REGISTRATION_COMMAND_ACK])
            break
          case ACTOR_CONTROL_KIND.ACTIVATE_CREATE:
            if (relayState) {
              let decodedActivation = null
              let decodedCreate = null
              let result = null
              let activated = false
              let attempted = false
              let reservation = null
              try {
                decodedActivation = decodeActivationRequest(request.body)
                decodedCreate = decodeCreate(decodedActivation.create)
                if (!decodedActivation.entry || !same(decodedCreate.circuitId, request.circuitId))
                  unauthorized()
                reservation = reserve(decodedCreate.circuitId, request.generation)
                attempted = true
                result = relayState.receiveActivationForReply(request.body)
                validateActorCommandReplyBody(ACTOR_CONTROL_KIND.ACTIVATE_CREATED, result)
                body = copy(result)
                commitReservation(reservation)
                activated = true
              } finally {
                if (reservation && !activated) releaseReservation(reservation, attempted)
                clear(result)
                clearTree(decodedActivation)
                clearTree(decodedCreate)
              }
            } else {
              let decodedActivation = null
              let decodedCreate = null
              let reservation = null
              let attempted = false
              let activated = false
              const receiver = destinationState.createActivationReceiver()
              try {
                decodedActivation = decodeDestinationActivationRequest(request.body)
                decodedCreate = decodeCreate(decodedActivation.create)
                if (!same(decodedCreate.circuitId, request.circuitId)) unauthorized()
                reservation = reserve(decodedCreate.circuitId, request.generation)
                attempted = true
                const fragments = fragmentActivation(request.body, {
                  messageId: b4a.alloc(16, 1)
                })
                for (const fragment of fragments) {
                  try {
                    const result = receiver.receive(fragment)
                    if (result) body = result
                  } finally {
                    clear(fragment)
                  }
                }
                if (body) {
                  commitReservation(reservation)
                  activated = true
                }
              } finally {
                if (reservation && !activated) releaseReservation(reservation, attempted)
                receiver.destroy()
                clearTree(decodedActivation)
                clearTree(decodedCreate)
              }
              if (!body) throw PrivateRouteError.ROUTE_UNAVAILABLE()
            }
            break
          case ACTOR_CONTROL_KIND.CIRCUIT_DESTROY: {
            const generationKey = b4a.toString(request.circuitId, 'hex')
            const record = authority.circuits.get(generationKey)
            if (!record) {
              body = b4a.alloc(0)
              break
            }
            if (
              record.owner !== owner ||
              record.generation !== request.generation ||
              record.state === 'activating'
            )
              unauthorized()
            if (record.state === 'open') {
              if (relayState) relayState.destroyCircuit(request.circuitId)
              else destinationState.destroyCircuit(request.circuitId)
              record.state = 'destroyed'
            }
            body = b4a.alloc(0)
            break
          }
          default:
            invalid()
        }
        response = codec.encode({
          version: PROTOCOL_VERSION,
          kind: request.kind + 1,
          flags: 0,
          requestId: request.requestId,
          actorId: request.actorId,
          circuitId: request.circuitId,
          generation: request.generation,
          body
        })
        return response
      } finally {
        clear(body)
        clearTree(request)
      }
    },
    destroy() {
      for (const [key, record] of authority.circuits) {
        if (record.owner !== owner || record.state === 'destroyed') continue
        try {
          if (relayState) relayState.destroyCircuit(record.circuitId)
          else destinationState.destroyCircuit(record.circuitId)
        } catch {}
        record.state = 'destroyed'
        authority.circuits.set(key, record)
      }
    }
  })
}

function registrationOperationMatches(kind, operation) {
  switch (kind) {
    case ACTOR_CONTROL_KIND.REGISTER_STAGE:
      return operation === REGISTRATION_CAPSULE_FINAL || operation === REGISTRATION_CAPSULE_FORWARD
    case ACTOR_CONTROL_KIND.REGISTER_PREPARE:
      return (
        operation === REGISTRATION_CAPSULE_PREPARE_FINAL ||
        operation === REGISTRATION_CAPSULE_PREPARE_FORWARD
      )
    case ACTOR_CONTROL_KIND.REGISTER_FINALIZE:
      return (
        operation === REGISTRATION_CAPSULE_FINALIZE_FINAL ||
        operation === REGISTRATION_CAPSULE_FINALIZE_FORWARD
      )
    case ACTOR_CONTROL_KIND.REGISTER_ABORT:
      return (
        operation === REGISTRATION_CAPSULE_ABORT_FINAL ||
        operation === REGISTRATION_CAPSULE_ABORT_FORWARD
      )
    default:
      return false
  }
}

// Package-internal reply validation shared by the byte-only host and adapter.
export function validateActorCommandReplyBody(kind, body) {
  let decoded = null
  try {
    switch (kind) {
      case ACTOR_CONTROL_KIND.REGISTER_STAGED:
        decoded = decodeRegistrationAcknowledgements(body)
        for (const acknowledgement of decoded) {
          const registered = decodeTemplateRegistered(acknowledgement)
          clearTree(registered)
        }
        break
      case ACTOR_CONTROL_KIND.REGISTER_PREPARED:
      case ACTOR_CONTROL_KIND.REGISTER_FINALIZED:
      case ACTOR_CONTROL_KIND.REGISTER_ABORTED:
        if (
          length(body) !== 2 ||
          body[0] !== PROTOCOL_VERSION ||
          body[1] !== REGISTRATION_COMMAND_ACK
        )
          invalid()
        break
      case ACTOR_CONTROL_KIND.ACTIVATE_CREATED:
        if (length(body) === CREATED_SIZE) decoded = decodeCreated(body)
        else {
          decoded = decodeActivationResponse(body)
          const entryProof = decodeEntryProof(decoded.entryProof)
          const created = decodeCreated(decoded.created)
          clearTree(entryProof)
          clearTree(created)
        }
        break
      case ACTOR_CONTROL_KIND.CIRCUIT_DESTROYED:
        if (length(body) !== 0) invalid()
        break
      default:
        invalid()
    }
    return true
  } finally {
    clearTree(decoded)
  }
}

// Package-internal, one-shot verifier for remote staged-registration replies.
// Expected records are canonical TemplateRegister messages from the builder and
// are bound to the exact sealed stage capsule before it can leave the host.
const REMOTE_REGISTRATION_VERIFIERS = new WeakMap()

export function createRemoteRegistrationVerifier(options) {
  if (
    !safeObject(options) ||
    length(option(options, 'request')) < 0 ||
    !Array.isArray(option(options, 'registrations')) ||
    options.registrations.length < 1 ||
    options.registrations.length > MAX_PRIVATE_HOPS
  )
    invalid()
  const expected = []
  let accepted = false
  try {
    for (const registration of options.registrations) {
      const message = safeObject(registration) ? option(registration, 'message') : registration
      expected.push(decodeTemplateRegister(message))
    }
    const capability = Object.freeze({})
    REMOTE_REGISTRATION_VERIFIERS.set(capability, {
      request: copy(options.request),
      expected,
      bound: false
    })
    accepted = true
    return capability
  } finally {
    if (!accepted) clearTree(expected)
  }
}

function clearRemoteRegistrationVerifier(state) {
  if (!state) return
  clear(state.request)
  clearTree(state.expected)
}

export function destroyRemoteRegistrationVerifier(capability) {
  const state = safeObject(capability) ? REMOTE_REGISTRATION_VERIFIERS.get(capability) : null
  if (!state) return false
  REMOTE_REGISTRATION_VERIFIERS.delete(capability)
  clearRemoteRegistrationVerifier(state)
  return true
}

export function isRemoteRegistrationVerifier(capability) {
  try {
    return REMOTE_REGISTRATION_VERIFIERS.has(capability)
  } catch {
    return false
  }
}

export function bindRemoteRegistrationVerifier(capability, request) {
  const state = safeObject(capability) ? REMOTE_REGISTRATION_VERIFIERS.get(capability) : null
  if (!state || state.bound || !same(request, state.request)) unauthorized()
  state.bound = true
  return true
}

export function verifyRemoteRegistrationReply(capability, request, response) {
  const state = safeObject(capability) ? REMOTE_REGISTRATION_VERIFIERS.get(capability) : null
  if (!state) unauthorized()
  REMOTE_REGISTRATION_VERIFIERS.delete(capability)
  let acknowledgements = null
  try {
    if (!state.bound || !same(request, state.request)) unauthorized()
    acknowledgements = decodeRegistrationAcknowledgements(response)
    if (acknowledgements.length !== state.expected.length) unauthorized()
    for (let index = 0; index < acknowledgements.length; index++)
      clearTree(verifyRegistrationAck(acknowledgements[index], state.expected[index]))
    return true
  } finally {
    clearTree(acknowledgements)
    clearRemoteRegistrationVerifier(state)
  }
}

// Package-internal, one-shot verifier capability. It deliberately retains the
// source-only material which cannot be reconstructed from ActorControl bytes.
// The package root does not export its constructor.
const REMOTE_ACTIVATION_VERIFIERS = new WeakMap()

export function createRemoteActivationVerifier(options) {
  if (
    !safeObject(options) ||
    length(option(options, 'request')) < 0 ||
    !fixed(option(options, 'circuitId'), 16) ||
    !u64(option(options, 'generation')) ||
    !fixed(option(options, 'entryIdentity'), 32) ||
    !fixed(option(options, 'entryRouteEncryptionKey'), 32) ||
    !fixed(option(options, 'endpointIdentity'), 32) ||
    !fixed(option(options, 'routeSigningKey'), 32) ||
    !fixed(option(options, 'destinationRouteEncryptionKey'), 32) ||
    !fixed(option(options, 'sourceEphemeralSecretKey'), 32) ||
    !fixed(option(options, 'entryChallenge'), 32) ||
    !fixed(option(options, 'destinationChallenge'), 32) ||
    !DESTINATION_REPLAY_STATES.has(option(options, 'replayCache')) ||
    typeof option(options, 'now') !== 'function'
  )
    invalid()
  const activation = decodeActivationRequest(options.request)
  const create = decodeCreate(activation.create)
  let state = null
  let accepted = false
  try {
    if (!activation.entry || !same(create.circuitId, options.circuitId)) unauthorized()
    const capability = Object.freeze({})
    state = {}
    state.request = copy(options.request)
    state.circuitId = copy(options.circuitId)
    state.generation = options.generation
    state.entryIdentity = copy(options.entryIdentity)
    state.entryRouteEncryptionKey = copy(options.entryRouteEncryptionKey)
    state.endpointIdentity = copy(options.endpointIdentity)
    state.routeSigningKey = copy(options.routeSigningKey)
    state.destinationRouteEncryptionKey = copy(options.destinationRouteEncryptionKey)
    state.sourceEphemeralSecretKey = copy(options.sourceEphemeralSecretKey)
    state.entryChallenge = copy(options.entryChallenge)
    state.destinationChallenge = copy(options.destinationChallenge)
    state.replayCache = options.replayCache
    state.now = options.now
    REMOTE_ACTIVATION_VERIFIERS.set(capability, state)
    accepted = true
    return capability
  } finally {
    if (!accepted) clearRemoteActivationVerifier(state)
    clearTree(activation)
    clearTree(create)
  }
}

function clearRemoteActivationVerifier(state) {
  if (!state) return
  for (const name of [
    'request',
    'circuitId',
    'entryIdentity',
    'entryRouteEncryptionKey',
    'endpointIdentity',
    'routeSigningKey',
    'destinationRouteEncryptionKey',
    'sourceEphemeralSecretKey',
    'entryChallenge',
    'destinationChallenge'
  ])
    clear(state[name])
}

export function destroyRemoteActivationVerifier(capability) {
  const state = safeObject(capability) ? REMOTE_ACTIVATION_VERIFIERS.get(capability) : null
  if (!state) return false
  REMOTE_ACTIVATION_VERIFIERS.delete(capability)
  clearRemoteActivationVerifier(state)
  return true
}

export function isRemoteActivationVerifier(capability) {
  try {
    return REMOTE_ACTIVATION_VERIFIERS.has(capability)
  } catch {
    return false
  }
}

export function bindRemoteActivationVerifier(capability, request, circuitId, generation) {
  const state = safeObject(capability) ? REMOTE_ACTIVATION_VERIFIERS.get(capability) : null
  if (
    !state ||
    state.bound === true ||
    !same(request, state.request) ||
    !same(circuitId, state.circuitId) ||
    generation !== state.generation
  )
    unauthorized()
  state.bound = true
  return true
}

export function verifyRemoteActivationReply(capability, request, circuitId, generation, response) {
  const state = safeObject(capability) ? REMOTE_ACTIVATION_VERIFIERS.get(capability) : null
  if (!state) unauthorized()
  REMOTE_ACTIVATION_VERIFIERS.delete(capability)
  let activation = null
  let decodedResponse = null
  let entry = null
  let destination = null
  try {
    if (
      !same(request, state.request) ||
      !same(circuitId, state.circuitId) ||
      generation !== state.generation
    )
      unauthorized()
    activation = decodeActivationRequest(request)
    decodedResponse = decodeActivationResponse(response)
    entry = verifyEntryProof({
      create: activation.create,
      proof: decodedResponse.entryProof,
      entryIdentity: state.entryIdentity,
      entryRouteEncryptionKey: state.entryRouteEncryptionKey,
      sourceEphemeralSecretKey: state.sourceEphemeralSecretKey,
      entryChallenge: state.entryChallenge,
      expiresAt: activation.expiresAt,
      startedAt: activation.startedAt,
      now: state.now
    })
    destination = verifyDestinationProof({
      create: activation.create,
      entryProof: decodedResponse.entryProof,
      created: decodedResponse.created,
      endpointIdentity: state.endpointIdentity,
      routeSigningKey: state.routeSigningKey,
      destinationRouteEncryptionKey: state.destinationRouteEncryptionKey,
      sourceEphemeralSecretKey: state.sourceEphemeralSecretKey,
      destinationChallenge: state.destinationChallenge,
      parameters: activation.parameters,
      expiresAt: activation.expiresAt,
      startedAt: activation.startedAt,
      now: state.now,
      replayCache: state.replayCache
    })
    return true
  } finally {
    clearRemoteActivationVerifier(state)
    clearTree(activation)
    clearTree(decodedResponse)
    clearTree(entry)
    clearTree(destination)
  }
}

const DEFAULT_ACTIVATION_PARAMETERS = Object.freeze({
  version: PROTOCOL_VERSION,
  cellSize: 1200,
  routeFrameSize: 1100,
  maxCellPayload: 1146,
  maxRoutePayload: 1073,
  capabilities: 7,
  safetyMin: 1,
  safetyMax: 3,
  privateMin: 1,
  privateMax: 3,
  counterWindow: 64
})

export function encodeActivationRequest(value) {
  if (
    !safeObject(value) ||
    typeof value.entry !== 'boolean' ||
    length(value.create) < CREATE_FIXED_SIZE ||
    length(value.create) > CREATE_FIXED_SIZE + MAX_ENCRYPTED_HOPS ||
    !u64(value.expiresAt) ||
    !Number.isSafeInteger(value.startedAt) ||
    value.startedAt < 0
  )
    invalid()
  const layerSize = length(value.layer)
  const proofSize = length(value.entryProof)
  if (
    (value.entry && (layerSize !== 0 || proofSize !== 0)) ||
    (!value.entry &&
      (layerSize < 1 || layerSize > MAX_ENCRYPTED_HOPS || proofSize !== ENTRY_PROOF_SIZE))
  )
    invalid()
  const parameters = encodeActivationParameters(value.parameters)
  const size =
    ACTIVATION_REQUEST_HEADER +
    ACTIVATION_PARAMETERS_SIZE +
    length(value.create) +
    layerSize +
    proofSize
  if (size > MAX_ACTIVATION_OBJECT) {
    clear(parameters)
    invalid()
  }
  const output = allocate(size)
  let offset = 0
  output[offset++] = PROTOCOL_VERSION
  output[offset++] = value.entry ? ACTIVATION_REQUEST_ENTRY : ACTIVATION_REQUEST_FORWARD
  writeU16(output, length(value.create), offset)
  offset += 2
  writeU16(output, layerSize, offset)
  offset += 2
  writeU64(output, value.expiresAt, offset)
  offset += 8
  writeU64(output, BigInt(value.startedAt), offset)
  offset += 8
  put(output, parameters, offset)
  offset += ACTIVATION_PARAMETERS_SIZE
  put(output, value.create, offset)
  offset += length(value.create)
  put(output, value.layer, offset)
  offset += layerSize
  put(output, value.entryProof, offset)
  clear(parameters)
  return output
}

export function decodeActivationRequest(value) {
  const size = length(value)
  if (size < ACTIVATION_REQUEST_HEADER + ACTIVATION_PARAMETERS_SIZE || size > MAX_ACTIVATION_OBJECT)
    invalid()
  let offset = 0
  if (value[offset++] !== PROTOCOL_VERSION) invalid()
  const operation = value[offset++]
  const createSize = readU16(value, offset)
  offset += 2
  const layerSize = readU16(value, offset)
  offset += 2
  const expiresAt = readU64(value, offset)
  offset += 8
  const startedAtValue = readU64(value, offset)
  offset += 8
  if (startedAtValue > BigInt(Number.MAX_SAFE_INTEGER)) invalid()
  const startedAt = Number(startedAtValue)
  const parameters = decodeActivationParameters(
    copy(slice(value, offset, offset + ACTIVATION_PARAMETERS_SIZE))
  )
  offset += ACTIVATION_PARAMETERS_SIZE
  const proofSize = operation === ACTIVATION_REQUEST_ENTRY ? 0 : ENTRY_PROOF_SIZE
  if (
    (operation !== ACTIVATION_REQUEST_ENTRY && operation !== ACTIVATION_REQUEST_FORWARD) ||
    createSize < CREATE_FIXED_SIZE ||
    createSize > CREATE_FIXED_SIZE + MAX_ENCRYPTED_HOPS ||
    (operation === ACTIVATION_REQUEST_ENTRY && layerSize !== 0) ||
    (operation === ACTIVATION_REQUEST_FORWARD &&
      (layerSize < 1 || layerSize > MAX_ENCRYPTED_HOPS)) ||
    offset + createSize + layerSize + proofSize !== size
  ) {
    clearTree(parameters)
    invalid()
  }
  return Object.freeze({
    entry: operation === ACTIVATION_REQUEST_ENTRY,
    create: copy(slice(value, offset, offset + createSize)),
    layer: copy(slice(value, offset + createSize, offset + createSize + layerSize)),
    expiresAt,
    startedAt,
    parameters,
    entryProof: copy(slice(value, offset + createSize + layerSize))
  })
}

export function encodeDestinationActivationRequest(value) {
  if (
    !safeObject(value) ||
    !fixed(value.finalToken, PRIVATE_FINAL_TOKEN_SIZE) ||
    length(value.create) < CREATE_FIXED_SIZE ||
    length(value.create) > CREATE_FIXED_SIZE + MAX_ENCRYPTED_HOPS ||
    !fixed(value.entryProof, ENTRY_PROOF_SIZE) ||
    !u64(value.expiresAt) ||
    !Number.isSafeInteger(value.startedAt) ||
    value.startedAt < 0
  )
    invalid()
  const parameters = encodeActivationParameters(value.parameters)
  const size =
    DESTINATION_ACTIVATION_REQUEST_HEADER +
    PRIVATE_FINAL_TOKEN_SIZE +
    ACTIVATION_PARAMETERS_SIZE +
    length(value.create) +
    ENTRY_PROOF_SIZE
  if (size > MAX_ACTIVATION_OBJECT) {
    clear(parameters)
    invalid()
  }
  const output = allocate(size)
  let offset = 0
  output[offset++] = PROTOCOL_VERSION
  writeU16(output, length(value.create), offset)
  offset += 2
  writeU64(output, value.expiresAt, offset)
  offset += 8
  writeU64(output, BigInt(value.startedAt), offset)
  offset += 8
  put(output, value.finalToken, offset)
  offset += PRIVATE_FINAL_TOKEN_SIZE
  put(output, value.create, offset)
  offset += length(value.create)
  put(output, value.entryProof, offset)
  offset += ENTRY_PROOF_SIZE
  put(output, parameters, offset)
  clear(parameters)
  return output
}

export function decodeDestinationActivationRequest(value) {
  const size = length(value)
  const minimum =
    DESTINATION_ACTIVATION_REQUEST_HEADER +
    PRIVATE_FINAL_TOKEN_SIZE +
    CREATE_FIXED_SIZE +
    ENTRY_PROOF_SIZE +
    ACTIVATION_PARAMETERS_SIZE
  if (size < minimum || size > MAX_ACTIVATION_OBJECT) invalid()
  let offset = 0
  if (value[offset++] !== PROTOCOL_VERSION) invalid()
  const createSize = readU16(value, offset)
  offset += 2
  const expiresAt = readU64(value, offset)
  offset += 8
  const startedAtValue = readU64(value, offset)
  offset += 8
  if (
    createSize < CREATE_FIXED_SIZE ||
    createSize > CREATE_FIXED_SIZE + MAX_ENCRYPTED_HOPS ||
    startedAtValue > BigInt(Number.MAX_SAFE_INTEGER) ||
    offset +
      PRIVATE_FINAL_TOKEN_SIZE +
      createSize +
      ENTRY_PROOF_SIZE +
      ACTIVATION_PARAMETERS_SIZE !==
      size
  )
    invalid()
  const finalToken = copy(slice(value, offset, offset + PRIVATE_FINAL_TOKEN_SIZE))
  offset += PRIVATE_FINAL_TOKEN_SIZE
  const create = copy(slice(value, offset, offset + createSize))
  offset += createSize
  const entryProof = copy(slice(value, offset, offset + ENTRY_PROOF_SIZE))
  offset += ENTRY_PROOF_SIZE
  let parameters = null
  try {
    parameters = decodeActivationParameters(
      copy(slice(value, offset, offset + ACTIVATION_PARAMETERS_SIZE))
    )
    return Object.freeze({
      finalToken,
      create,
      entryProof,
      parameters,
      expiresAt,
      startedAt: Number(startedAtValue)
    })
  } catch (err) {
    clear(finalToken)
    clear(create)
    clear(entryProof)
    clearTree(parameters)
    throw err
  }
}

function encodeActivationResponse(value) {
  if (
    !safeObject(value) ||
    !fixed(value.entryProof, ENTRY_PROOF_SIZE) ||
    !fixed(value.created, CREATED_SIZE)
  )
    invalid()
  return b4a.concat([value.entryProof, value.created])
}

function decodeActivationResponse(value) {
  if (length(value) !== ENTRY_PROOF_SIZE + CREATED_SIZE) invalid()
  return Object.freeze({
    entryProof: copy(slice(value, 0, ENTRY_PROOF_SIZE)),
    created: copy(slice(value, ENTRY_PROOF_SIZE))
  })
}

function deliverRoutePayload(codec, direction, frame, callback) {
  const opened = codec.open({ direction }, frame)
  const deliveries = Array.isArray(opened) ? opened : [opened]
  try {
    for (const delivery of deliveries) {
      if (typeof callback === 'function') callback(delivery.payload)
    }
  } finally {
    for (const delivery of deliveries) clear(delivery.payload)
  }
}

export function createPrivateRouteCompiler(options) {
  const payloadCounters = safeObject(options)
    ? option(options, TEST_ONLY_ROUTE_PAYLOAD_COUNTERS)
    : undefined
  const frameObserver = safeObject(options)
    ? option(options, TEST_ONLY_ROUTE_FRAME_OBSERVER)
    : undefined
  if (
    !safeObject(options) ||
    !RELAY_ACTOR_STATES.has(options.entryActor) ||
    !DESTINATION_ACTOR_STATES.has(options.destinationActor) ||
    !isSafetyRouteChecker(options.safetyRouteChecker) ||
    typeof options.now !== 'function' ||
    typeof options.randomBytes !== 'function' ||
    (options.scheduleDrain !== undefined && typeof options.scheduleDrain !== 'function') ||
    (options.cancelDrain !== undefined && typeof options.cancelDrain !== 'function') ||
    (options.maxCircuits !== undefined &&
      (!Number.isSafeInteger(options.maxCircuits) ||
        options.maxCircuits < 1 ||
        options.maxCircuits > DEFAULT_MAX_ACTOR_CIRCUITS)) ||
    (options.sourceDestinationReplayCache !== undefined &&
      !DESTINATION_REPLAY_STATES.has(options.sourceDestinationReplayCache)) ||
    (options.observe !== undefined && typeof options.observe !== 'function') ||
    (frameObserver !== undefined && typeof frameObserver !== 'function') ||
    (payloadCounters !== undefined &&
      (!safeObject(payloadCounters) ||
        Object.keys(payloadCounters).sort().join(',') !==
          'destinationReceiverInitial,rotationAlreadyRequested,sourceSenderInitial' ||
        typeof option(payloadCounters, 'sourceSenderInitial') !== 'bigint' ||
        typeof option(payloadCounters, 'destinationReceiverInitial') !== 'bigint' ||
        typeof option(payloadCounters, 'rotationAlreadyRequested') !== 'boolean' ||
        option(payloadCounters, 'sourceSenderInitial') < 0n ||
        option(payloadCounters, 'sourceSenderInitial') > MAX_U64 ||
        option(payloadCounters, 'destinationReceiverInitial') !==
          option(payloadCounters, 'sourceSenderInitial')))
  )
    invalid()
  const callbacks = {}
  for (const name of [
    'onDestinationStream',
    'onDestinationDatagram',
    'onSourceStream',
    'onSourceDatagram'
  ]) {
    const callback = option(options, name)
    if (callback !== undefined && typeof callback !== 'function') invalid()
    callbacks[name] = callback || null
  }
  Object.freeze(callbacks)
  const observe = options.observe || null
  const parameters = options.parameters || DEFAULT_ACTIVATION_PARAMETERS
  const scheduleDrain = options.scheduleDrain || ((callback, delay) => setTimeout(callback, delay))
  const cancelDrain = options.cancelDrain || ((handle) => clearTimeout(handle))
  const waitForCreated = options.waitForCreated || null
  const maxCircuits = options.maxCircuits || DEFAULT_MAX_ACTOR_CIRCUITS
  if (
    options.sourceDestinationReplayCache &&
    DESTINATION_REPLAY_STATES.get(options.sourceDestinationReplayCache).maximum > maxCircuits
  )
    invalid()
  const sourceDestinationReplayCache =
    options.sourceDestinationReplayCache ||
    createDestinationReplayCache({
      now: options.now,
      maxEntries: maxCircuits
    })
  encodeActivationParameters(parameters)
  return function compile(request) {
    if (
      !safeObject(request) ||
      !safeObject(request.descriptorValue) ||
      !fixed(request.circuitId, 16) ||
      !safeObject(request.circuitContext) ||
      !safeObject(request.safetyRouteCapability) ||
      typeof request.requestReplacement !== 'function'
    )
      invalid()
    const descriptor = request.descriptorValue
    const entryPublic = actorPublicInfo(options.entryActor)
    const destinationPublic = actorPublicInfo(options.destinationActor)
    if (
      !same(descriptor.entry.identityKey, entryPublic.identity) ||
      !same(descriptor.entry.routeEncryptionKey, entryPublic.routeEncryptionKey) ||
      !same(descriptor.endpointKey, destinationPublic.identity) ||
      !same(descriptor.routeSigningKey, destinationPublic.routeSigningKey) ||
      !same(descriptor.routeEncryptionKey, destinationPublic.routeEncryptionKey)
    )
      unauthorized()
    const entrySession = ACTOR_SESSIONS.get(options.entryActor)
    const destinationSession = ACTOR_SESSIONS.get(options.destinationActor)
    if (!entrySession || !destinationSession) unauthorized()
    const safetyRoute = options.safetyRouteChecker.read(
      request.safetyRouteCapability,
      request.circuitContext
    )
    if (!fixed(safetyRoute.transcriptHash32, 32)) invalid()
    const entryAttachment = safetyRoute.attachEntry(
      Object.freeze({
        entryActor: options.entryActor,
        circuitId: copy(request.circuitId),
        epoch: descriptor.epoch,
        expiresAt: descriptor.expiresAt
      })
    )
    if (
      !safeObject(entryAttachment) ||
      Object.keys(entryAttachment).join(',') !== 'destroy' ||
      typeof entryAttachment.destroy !== 'function'
    )
      invalid()
    let sourceEphemeral = null
    let entryChallenge = null
    let destinationChallenge = null
    const startedAt = options.now()
    let create = null
    let activationRequest = null
    let entryShared = null
    let destinationShared = null
    let activation = null
    let verified = null
    let sourcePayload = null
    let destinationPayload = null
    let safetyBound = false
    let destinationBound = false
    let drainingAt = null
    let drainTimer = null
    let rotationRequested = payloadCounters ? payloadCounters.rotationAlreadyRequested : false
    let state = 'creating'
    function cancelDrainTimer() {
      const timer = drainTimer
      drainTimer = null
      if (!timer || !timer.armed) return
      try {
        cancelDrain(timer.handle)
      } catch {
        // Cleanup must not be blocked by a scheduler adapter.
      }
    }
    function destroyCircuitState() {
      if (state === 'destroyed') return
      state = 'destroyed'
      cancelDrainTimer()
      if (destinationBound) {
        destinationBound = false
        destinationSession.unbindReverse(request.circuitId)
      }
      if (safetyBound) {
        safetyBound = false
        entrySession.unbindSafetyReverse(request.circuitId)
      }
      entrySession.destroyCircuit(request.circuitId)
      destinationSession.destroyCircuit(request.circuitId)
      const source = sourcePayload
      const destination = destinationPayload
      sourcePayload = null
      destinationPayload = null
      try {
        if (source) source.destroy()
      } finally {
        try {
          if (destination) destination.destroy()
        } finally {
          try {
            entryAttachment.destroy()
          } finally {
            safetyRoute.destroy()
          }
        }
      }
    }
    function failClosed(action) {
      try {
        return action()
      } catch (err) {
        try {
          destroyCircuitState()
        } catch {}
        throw err
      }
    }
    try {
      sourceEphemeral = cryptoSuite.encryptionKeyPair(options.randomBytes(32))
      entryChallenge = options.randomBytes(32)
      destinationChallenge = options.randomBytes(32)
      const createValue = {
        version: PROTOCOL_VERSION,
        circuitId: request.circuitId,
        epoch: descriptor.epoch,
        descriptorId: descriptor.descriptorId,
        sourceEphemeralKey: sourceEphemeral.publicKey,
        safetyTranscriptHash: safetyRoute.transcriptHash32,
        entryChallengeCipher: b4a.alloc(48),
        destinationChallengeCipher: b4a.alloc(48),
        encryptedHops: descriptor.encryptedHops
      }
      const base = hashCreateBase(createValue)
      try {
        entryShared = cryptoSuite.keyAgreement(
          sourceEphemeral.secretKey,
          entryPublic.routeEncryptionKey
        )
        destinationShared = cryptoSuite.keyAgreement(
          sourceEphemeral.secretKey,
          destinationPublic.routeEncryptionKey
        )
        createValue.entryChallengeCipher = activationChallengeCipher(
          entryShared,
          base,
          entryChallenge,
          0
        )
        createValue.destinationChallengeCipher = activationChallengeCipher(
          destinationShared,
          base,
          destinationChallenge,
          1
        )
        create = encodeCreate(createValue)
        activationRequest = encodeActivationRequest({
          entry: true,
          create,
          layer: b4a.alloc(0),
          expiresAt: descriptor.expiresAt,
          startedAt,
          parameters,
          entryProof: b4a.alloc(0)
        })
      } finally {
        clear(base)
      }
      const receiver = new ActivationReassembler({ now: options.now })
      const createdReceiver = new ActivationReassembler({ now: options.now })
      entrySession.bindSafetyReverse(
        request.circuitId,
        descriptor.epoch,
        descriptor.expiresAt,
        (cellClass, frame) =>
          safetyRoute.sendReverseFrame(cellClass, frame, (authenticated) => {
            try {
              if (state === 'creating') {
                if (cellClass !== CELL_CLASS.CONTROL) unauthorized()
                const complete = createdReceiver.pushAuthenticated(authenticated)
                if (complete) {
                  try {
                    activation = decodeActivationResponse(complete)
                  } finally {
                    clear(complete)
                  }
                }
                return true
              }
              deliverRoutePayload(
                sourcePayload,
                DIRECTION.REVERSE,
                authenticated,
                cellClass === CELL_CLASS.DATAGRAM
                  ? callbacks.onSourceDatagram
                  : callbacks.onSourceStream
              )
              return true
            } catch (err) {
              if (state !== 'creating')
                try {
                  destroyCircuitState()
                } catch {}
              throw err
            }
          }),
        destroyCircuitState
      )
      safetyBound = true
      const fragments = fragmentActivation(activationRequest, {
        messageId: options.randomBytes(16)
      })
      try {
        const accepted = safetyRoute.sendControl(fragments, (fragment) => {
          const value = receiver.pushAuthenticated(fragment)
          if (!value) return undefined
          try {
            return entrySession.receiveActivation(value)
          } finally {
            clear(value)
          }
        })
        if (accepted === false) throw PrivateRouteError.ROUTE_UNAVAILABLE()
        if (!activation) {
          if (
            !waitForCreated ||
            !Number.isSafeInteger(startedAt) ||
            startedAt < 0 ||
            startedAt > Number.MAX_SAFE_INTEGER - ACTIVATION_FRAGMENT_TIMEOUT
          )
            throw PrivateRouteError.ROUTE_UNAVAILABLE()
          // The compiler API is synchronous today: this injected adapter is the
          // deterministic bridge for prototype transports that queue CREATED.
          const completed = waitForCreated(startedAt + ACTIVATION_FRAGMENT_TIMEOUT)
          if (completed !== true || !activation) throw PrivateRouteError.ROUTE_UNAVAILABLE()
        }
      } finally {
        receiver.destroy()
        createdReceiver.destroy()
        for (const fragment of fragments) clear(fragment)
      }
      observePassively(observe, { phase: 'create-sent' })
      verifyEntryProof({
        create,
        proof: activation.entryProof,
        entryIdentity: entryPublic.identity,
        entryRouteEncryptionKey: entryPublic.routeEncryptionKey,
        sourceEphemeralSecretKey: sourceEphemeral.secretKey,
        entryChallenge,
        expiresAt: descriptor.expiresAt,
        startedAt,
        now: options.now
      })
      observePassively(observe, { phase: 'entry-proof-verified' })
      verified = verifyDestinationProof({
        create,
        entryProof: activation.entryProof,
        created: activation.created,
        endpointIdentity: destinationPublic.identity,
        routeSigningKey: destinationPublic.routeSigningKey,
        destinationRouteEncryptionKey: destinationPublic.routeEncryptionKey,
        sourceEphemeralSecretKey: sourceEphemeral.secretKey,
        destinationChallenge,
        parameters,
        expiresAt: descriptor.expiresAt,
        startedAt,
        now: options.now,
        replayCache: sourceDestinationReplayCache
      })
      observePassively(observe, { phase: 'created-verified' })
      const fields = {
        descriptorId: descriptor.descriptorId,
        circuitId: request.circuitId,
        forwardKey: verified.payloadKeys.forwardKey,
        forwardNoncePrefix: verified.payloadKeys.forwardNoncePrefix,
        reverseKey: verified.payloadKeys.reverseKey,
        reverseNoncePrefix: verified.payloadKeys.reverseNoncePrefix
      }
      sourcePayload = new RoutePayloadCodec({
        crypto: cryptoSuite,
        context: mintCreatedRoutePayloadContext({
          ...fields,
          endpointRole: ROUTE_ENDPOINT.SOURCE
        }),
        window: parameters.counterWindow,
        gapTimeout: 5_000,
        now: options.now,
        padding: (size) => b4a.alloc(size),
        senderInitial: payloadCounters && payloadCounters.sourceSenderInitial
      })
      destinationPayload = new RoutePayloadCodec({
        crypto: cryptoSuite,
        context: mintCreatedRoutePayloadContext({
          ...fields,
          endpointRole: ROUTE_ENDPOINT.DESTINATION
        }),
        window: parameters.counterWindow,
        gapTimeout: 5_000,
        now: options.now,
        padding: (size) => b4a.alloc(size),
        receiverInitial: payloadCounters && payloadCounters.destinationReceiverInitial
      })
      state = 'open'
      destinationSession.bindReverse(
        request.circuitId,
        (cellClass, payload) =>
          failClosed(() => {
            if (state === 'draining') {
              const current = activationNow(options.now)
              if (
                drainingAt === null ||
                current < BigInt(drainingAt) ||
                drainingAt > Number.MAX_SAFE_INTEGER - ACTIVATION_FRAGMENT_TIMEOUT ||
                current >= BigInt(drainingAt + ACTIVATION_FRAGMENT_TIMEOUT)
              ) {
                destroyCircuitState()
                throw PrivateRouteError.CIRCUIT_STATE()
              }
            } else if (state !== 'open') throw PrivateRouteError.CIRCUIT_STATE()
            const frame = destinationPayload.seal({
              class: cellClass,
              direction: DIRECTION.REVERSE,
              payload
            })
            try {
              observePassively(frameObserver, {
                direction: DIRECTION.REVERSE,
                cellClass,
                frame: copy(frame)
              })
              destinationSession.reverseFrame(request.circuitId, cellClass, frame)
            } finally {
              clear(frame)
            }
          }),
        destroyCircuitState
      )
      destinationBound = true
      observePassively(observe, { phase: 'open' })
      function send(cellClass, payload) {
        if (state !== 'open') throw PrivateRouteError.CIRCUIT_STATE()
        const frame = sourcePayload.seal({
          class: cellClass,
          direction: DIRECTION.FORWARD,
          payload
        })
        try {
          observePassively(frameObserver, {
            direction: DIRECTION.FORWARD,
            cellClass,
            frame: copy(frame)
          })
          const accepted = safetyRoute.sendFrame(cellClass, frame, (authenticated) =>
            entrySession.forwardFrame(
              request.circuitId,
              cellClass,
              authenticated,
              (atDestination) =>
                failClosed(() => {
                  deliverRoutePayload(
                    destinationPayload,
                    DIRECTION.FORWARD,
                    atDestination,
                    cellClass === CELL_CLASS.DATAGRAM
                      ? callbacks.onDestinationDatagram
                      : callbacks.onDestinationStream
                  )
                  return true
                })
            )
          )
          if (accepted === false) throw PrivateRouteError.ROUTE_UNAVAILABLE()
        } finally {
          clear(frame)
        }
        const forward = sourcePayload.stats.forward
        const needsRotation =
          cellClass === CELL_CLASS.DATAGRAM
            ? forward.datagramSenderNeedsRotation
            : forward.senderNeedsRotation
        if (needsRotation && !rotationRequested) {
          rotationRequested = true
          request.requestReplacement('rotation')
        }
      }
      return Object.freeze({
        sendDatagram(payload) {
          send(CELL_CLASS.DATAGRAM, payload)
        },
        sendStreamFrame(payload) {
          send(CELL_CLASS.STREAM, payload)
        },
        drain() {
          if (state !== 'open') throw PrivateRouteError.CIRCUIT_STATE()
          drainingAt = Number(activationNow(options.now))
          if (drainingAt > Number.MAX_SAFE_INTEGER - ACTIVATION_FRAGMENT_TIMEOUT) {
            destroyCircuitState()
            throw PrivateRouteError.CIRCUIT_STATE()
          }
          state = 'draining'
          const timer = { armed: false, handle: null }
          drainTimer = timer
          try {
            const handle = scheduleDrain(() => {
              if (drainTimer !== timer || state !== 'draining') return
              drainTimer = null
              destroyCircuitState()
            }, ACTIVATION_FRAGMENT_TIMEOUT)
            timer.handle = handle
            timer.armed = true
            if (drainTimer !== timer) {
              try {
                cancelDrain(handle)
              } catch {
                // The synchronous callback already destroyed the circuit.
              }
            }
          } catch {
            destroyCircuitState()
            throw PrivateRouteError.CIRCUIT_STATE()
          }
        },
        destroy() {
          if (state === 'destroyed') return
          destroyCircuitState()
        }
      })
    } catch (err) {
      try {
        destroyCircuitState()
      } finally {
        throw err
      }
    } finally {
      clear(create)
      clear(activationRequest)
      clearTree(activation)
      clearTree(verified)
      clearTree(sourceEphemeral)
      clear(entryShared)
      clear(destinationShared)
      clear(entryChallenge)
      clear(destinationChallenge)
      clearTree(entryPublic)
      clearTree(destinationPublic)
      clear(safetyRoute.transcriptHash32)
    }
  }
}

function clearTree(value, seen = new Set()) {
  if (value === null || value === undefined || seen.has(value)) return
  if (b4a.isBuffer(value)) {
    clear(value)
    return
  }
  if (typeof value !== 'object') return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) clearTree(item, seen)
    value.length = 0
    return
  }
  for (const item of Object.values(value)) clearTree(item, seen)
}

function verifyRegistrationAck(ack, register) {
  const value = decodeTemplateRegistered(ack)
  if (
    !same(value.descriptorId, register.descriptorId) ||
    !same(value.templateId, register.templateId) ||
    value.epoch !== register.epoch ||
    value.expiresAt !== register.expiresAt ||
    !same(value.relayIdentity, register.relayIdentity) ||
    !same(value.templateCommitment, register.templateCommitment)
  )
    unauthorized()
  const message = signed(DOMAIN.TEMPLATE_REGISTERED, encodeTemplateRegisteredUnsigned(value))
  const valid = verify(message, value.relayIdentitySignature, value.relayIdentity)
  clear(message)
  if (!valid) unauthorized()
  return value
}

function endpointLink(checker, ticket, onDestroy) {
  const state = checker.take(ticket)
  const codec = new CellCodec({
    crypto: cryptoSuite,
    cellSize: CELL_SIZE,
    padding: (size) => b4a.alloc(size)
  })
  let live = true
  return Object.freeze({
    get peerIdentity() {
      return copy(state.peerIdentity)
    },
    sealControl(payload) {
      if (!live) throw PrivateRouteError.CIRCUIT_STATE()
      const context = state.contexts[CELL_CLASS.CONTROL].tx
      return codec.seal({
        key: context.key,
        noncePrefix: context.noncePrefix,
        senderCounter: context.counter,
        class: CELL_CLASS.CONTROL,
        direction: DIRECTION.FORWARD,
        epoch: state.epoch,
        circuitId: state.peerLocalId,
        payload
      })
    },
    seal(cellClass, direction, payload) {
      if (!live) throw PrivateRouteError.CIRCUIT_STATE()
      const context = state.contexts[cellClass].tx
      return codec.seal({
        key: context.key,
        noncePrefix: context.noncePrefix,
        senderCounter: context.counter,
        class: cellClass,
        direction,
        epoch: state.epoch,
        circuitId: state.peerLocalId,
        payload
      })
    },
    openControl(packet, direction) {
      if (!live) throw PrivateRouteError.CIRCUIT_STATE()
      const context = state.contexts[CELL_CLASS.CONTROL].rx
      return codec.open(
        {
          key: context.key,
          noncePrefix: context.noncePrefix,
          receiver: context.counter,
          expectedClass: CELL_CLASS.CONTROL,
          expectedDirection: direction,
          expectedEpoch: state.epoch,
          expectedCircuitId: state.localId
        },
        packet
      )
    },
    open(cellClass, direction, packet) {
      if (!live) throw PrivateRouteError.CIRCUIT_STATE()
      const context = state.contexts[cellClass].rx
      return codec.open(
        {
          key: context.key,
          noncePrefix: context.noncePrefix,
          receiver: context.counter,
          expectedClass: cellClass,
          expectedDirection: direction,
          expectedEpoch: state.epoch,
          expectedCircuitId: state.localId
        },
        packet
      )
    },
    nextCounter(cellClass) {
      if (!live) throw PrivateRouteError.CIRCUIT_STATE()
      return state.contexts[cellClass].tx.counter.value
    },
    bindingSnapshot() {
      if (!live) throw PrivateRouteError.CIRCUIT_STATE()
      const digest = hash([
        state.circuitId,
        state.localId,
        state.peerLocalId,
        ...Object.values(state.contexts).flatMap((pair) => [
          pair.tx.key,
          pair.tx.noncePrefix,
          pair.rx.key,
          pair.rx.noncePrefix
        ])
      ])
      try {
        return Object.freeze({
          localId: b4a.toString(state.localId, 'hex'),
          peerLocalId: b4a.toString(state.peerLocalId, 'hex'),
          bindingFingerprint: b4a.toString(digest, 'hex')
        })
      } finally {
        clear(digest)
      }
    },
    destroy() {
      if (!live) return
      live = false
      let contexts = 0
      for (const pair of Object.values(state.contexts)) {
        for (const context of [pair.tx, pair.rx]) {
          clear(context.key)
          clear(context.noncePrefix)
          try {
            if (typeof context.counter.destroy === 'function') context.counter.destroy()
          } catch {}
          contexts++
        }
      }
      clear(state.circuitId)
      clear(state.localId)
      clear(state.peerLocalId)
      if (onDestroy) onDestroy(contexts)
    }
  })
}

function synchronousCancellation(value) {
  if (!safeObject(value)) return null
  try {
    if (Object.keys(value).join(',') !== 'cancel' || typeof value.cancel !== 'function') return null
    return value.cancel.bind(value)
  } catch {
    return null
  }
}

function transmitSynchronously(send, receive) {
  let live = true
  let delivered = false
  let duplicate = false
  let accepted
  try {
    accepted = send((value) => {
      if (!live) return
      if (delivered) {
        duplicate = true
        throw PrivateRouteError.ROUTE_UNAVAILABLE()
      }
      delivered = true
      receive(value)
    })
  } catch (err) {
    live = false
    throw err
  }
  const cancel = synchronousCancellation(accepted)
  live = false
  if (!duplicate && delivered && (accepted === true || cancel)) return true
  if (!delivered && cancel)
    try {
      cancel()
    } catch {
      // Cancellation is best effort; the synchronous operation still fails closed.
    }
  throw PrivateRouteError.ROUTE_UNAVAILABLE()
}

function transmitQueued(send, receive, pending) {
  let live = true
  let delivered = false
  let cancellation = null
  let accepted
  const close = () => {
    if (!live) return false
    live = false
    return true
  }
  try {
    accepted = send((value) => {
      if (!close()) return
      delivered = true
      if (cancellation) pending.delete(cancellation)
      receive(value)
    })
  } catch (err) {
    close()
    throw err
  }
  const cancelAdapter = accepted === true ? null : synchronousCancellation(accepted)
  if (accepted !== true && !cancelAdapter) {
    close()
    throw PrivateRouteError.ROUTE_UNAVAILABLE()
  }
  if (!delivered) {
    let cancelled = false
    cancellation = Object.freeze({
      cancel() {
        if (cancelled) return 0
        cancelled = true
        if (!close()) return 0
        return cancelAdapter ? cancelAdapter() : 1
      }
    })
    pending.add(cancellation)
  }
  return cancellation || accepted
}

function transmitActorSynchronously(fromState, peer, packet, receive, reverse = false) {
  return transmitSynchronously(
    (deliver) => fromState.transmit(peer, packet, deliver, reverse, true),
    receive
  )
}

export function createPrivateSafetyEntryAttachment(options) {
  if (
    !safeObject(options) ||
    !RELAY_ACTOR_STATES.has(options.entryActor) ||
    !fixed(options.circuitId, 16) ||
    !u64(options.epoch) ||
    !u64(options.expiresAt) ||
    !fixed(options.finalSafetyIdentity, 32) ||
    !fixed(options.finalSafetyIdentitySecretKey, 64) ||
    roleForIdentity(options.finalSafetyIdentity) !== ROLE.SAFETY ||
    typeof options.now !== 'function' ||
    typeof options.randomBytes !== 'function' ||
    typeof options.transmit !== 'function'
  )
    invalid()
  const now = options.now()
  if (!Number.isSafeInteger(now) || now < 0 || BigInt(now) >= options.expiresAt) invalid()
  const authority = createLinkSetupAuthority({
    crypto: cryptoSuite,
    now: options.now,
    randomBytes: options.randomBytes
  })
  const entryPublic = actorPublicInfo(options.entryActor)
  const finalSafetyIdentity = copy(options.finalSafetyIdentity)
  const routeId = copy(options.circuitId)
  const common = {
    circuitId: routeId,
    epoch: options.epoch,
    initiatorIdentity: finalSafetyIdentity,
    responderIdentity: entryPublic.identity,
    initiatorLocalId: options.randomBytes(16),
    responderLocalId: options.randomBytes(16),
    expiresAt: options.expiresAt
  }
  const started = authority.initiate({
    ...common,
    responderStaticKey: entryPublic.routeEncryptionKey,
    initiatorIdentitySecretKey: options.finalSafetyIdentitySecretKey
  })
  let entryState = null
  let accepted = null
  let created = null
  let initiator = null
  let binding = null
  let snapshot = null
  let setupComplete = false
  try {
    transmitSynchronously(
      (deliver) => options.transmit(DIRECTION.FORWARD, started.message, deliver),
      (message) => {
        entryState = adjacentActorState(options.entryActor)
        if (!entryState) unauthorized()
        accepted = entryState.acceptLink(authority, message, common)
      }
    )
    if (!accepted) throw PrivateRouteError.ROUTE_UNAVAILABLE()
    transmitSynchronously(
      (deliver) => options.transmit(DIRECTION.REVERSE, accepted.message, deliver),
      (message) => {
        created = copy(message)
      }
    )
    if (!created) throw PrivateRouteError.ROUTE_UNAVAILABLE()
    initiator = endpointLink(authority.checker, authority.complete(started.pending, created))
    binding = entryState.openSafetyBinding(authority, accepted.ticket, common)
    snapshot = initiator.bindingSnapshot()
    setupComplete = true
  } finally {
    clear(created)
    if (!setupComplete) {
      authority.abort(started.pending)
      if (accepted) authority.revoke(accepted.ticket)
      if (binding) binding.destroy(finalSafetyIdentity)
      if (initiator) initiator.destroy()
    }
  }
  const pending = new Set()
  let live = true
  function transmit(direction, packet, receive) {
    return transmitQueued(
      (deliver) => options.transmit(direction, packet, deliver),
      receive,
      pending
    )
  }
  entryState.observeState({
    type: 'private-binding-opened',
    peerIdentity: b4a.toString(finalSafetyIdentity, 'hex'),
    peerRole: ROLE.SAFETY,
    direction: DIRECTION.FORWARD,
    ...snapshot
  })
  return Object.freeze({
    sendControl(fragments, deliver) {
      if (!live || !Array.isArray(fragments) || typeof deliver !== 'function')
        throw PrivateRouteError.CIRCUIT_STATE()
      let result
      for (const fragment of fragments) {
        let packet = null
        try {
          packet = initiator.sealControl(fragment)
          transmit(DIRECTION.FORWARD, packet, (received) => {
            binding.receive(finalSafetyIdentity, received)
            for (const value of binding.takeControls()) {
              try {
                const accepted = deliver(value)
                if (accepted !== undefined) result = accepted
              } finally {
                clear(value)
              }
            }
          })
        } finally {
          clear(packet)
        }
      }
      return result === undefined ? true : result
    },
    sendFrame(cellClass, frame, deliver) {
      if (!live || typeof deliver !== 'function') throw PrivateRouteError.CIRCUIT_STATE()
      let packet = null
      try {
        packet = initiator.seal(cellClass, DIRECTION.FORWARD, frame)
        transmit(DIRECTION.FORWARD, packet, (received) => {
          try {
            binding.receive(finalSafetyIdentity, received)
            const value = binding.takeForward()
            if (!value) throw PrivateRouteError.ROUTE_UNAVAILABLE()
            try {
              deliver(value)
            } finally {
              clear(value)
            }
          } catch (err) {
            try {
              entryState.destroyCircuit(routeId)
            } catch {}
            throw err
          }
        })
        return true
      } finally {
        clear(packet)
      }
    },
    sendReverseFrame(cellClass, frame, deliver) {
      if (!live || typeof deliver !== 'function') throw PrivateRouteError.CIRCUIT_STATE()
      let packet = null
      try {
        packet = binding.sendReverse(cellClass, frame)
        if (!packet) throw PrivateRouteError.ROUTE_UNAVAILABLE()
        transmit(DIRECTION.REVERSE, packet, (received) => {
          let value = null
          try {
            value = initiator.open(cellClass, DIRECTION.REVERSE, received)
            if (Array.isArray(value)) value = value[0]
            deliver(value)
          } catch (err) {
            try {
              entryState.destroyCircuit(routeId)
            } catch {}
            throw err
          } finally {
            clear(value)
          }
        })
        return true
      } finally {
        clear(packet)
      }
    },
    destroy() {
      if (!live) return
      live = false
      cancelPendingTransmissions(pending)
      try {
        binding.destroy(finalSafetyIdentity)
      } finally {
        initiator.destroy()
        clear(finalSafetyIdentity)
        clear(routeId)
        clearTree(entryPublic)
      }
    }
  })
}

function encodeRegistrationEnvelope(envelope) {
  const messageSize = length(envelope.message)
  const sealedSize = length(envelope.sealedTemplate)
  if (
    messageSize < 1 ||
    messageSize > 0xffff ||
    sealedSize < SEALED_BOX_OVERHEAD ||
    sealedSize > MAX_ENCRYPTED_HOPS
  )
    invalid()
  const output = allocate(2 + messageSize + sealedSize)
  writeU16(output, messageSize, 0)
  put(output, envelope.message, 2)
  put(output, envelope.sealedTemplate, 2 + messageSize)
  return output
}

function decodeRegistrationEnvelope(value) {
  if (length(value) < 2) invalid()
  const messageSize = readU16(value, 0)
  if (messageSize < 1 || 2 + messageSize + SEALED_BOX_OVERHEAD > length(value)) invalid()
  return {
    message: copy(slice(value, 2, 2 + messageSize)),
    sealedTemplate: copy(slice(value, 2 + messageSize))
  }
}

function encodeRegistrationCapsule(value) {
  const registration =
    value.operation === REGISTRATION_CAPSULE_FINAL ||
    value.operation === REGISTRATION_CAPSULE_FORWARD
  const final =
    value.operation === REGISTRATION_CAPSULE_FINAL ||
    value.operation === REGISTRATION_CAPSULE_PREPARE_FINAL ||
    value.operation === REGISTRATION_CAPSULE_ABORT_FINAL ||
    value.operation === REGISTRATION_CAPSULE_FINALIZE_FINAL
  const forward =
    value.operation === REGISTRATION_CAPSULE_FORWARD ||
    value.operation === REGISTRATION_CAPSULE_PREPARE_FORWARD ||
    value.operation === REGISTRATION_CAPSULE_ABORT_FORWARD ||
    value.operation === REGISTRATION_CAPSULE_FINALIZE_FORWARD
  if (
    !safeObject(value) ||
    (!registration && !final && !forward) ||
    (registration ? length(value.envelope) < 1 : length(value.envelope) !== 0) ||
    length(value.envelope) > 0xffff ||
    length(value.nextCapsule) > 0xffff ||
    (final && length(value.nextCapsule) !== 0) ||
    (forward && length(value.nextCapsule) < SEALED_BOX_OVERHEAD) ||
    !fixed(value.transactionId, REGISTRATION_TRANSACTION_SIZE) ||
    !u64(value.epoch) ||
    !u64(value.expiresAt)
  )
    invalid()
  const size = REGISTRATION_CAPSULE_HEADER + length(value.envelope) + length(value.nextCapsule)
  if (size + SEALED_BOX_OVERHEAD > MAX_ACTIVATION_OBJECT) invalid()
  const output = allocate(size)
  output[0] = PROTOCOL_VERSION
  output[1] = value.operation
  writeU16(output, length(value.envelope), 2)
  writeU16(output, length(value.nextCapsule), 4)
  put(output, value.transactionId, 6)
  writeU64(output, value.epoch, 22)
  writeU64(output, value.expiresAt, 30)
  put(output, value.envelope, REGISTRATION_CAPSULE_HEADER)
  put(output, value.nextCapsule, REGISTRATION_CAPSULE_HEADER + length(value.envelope))
  return output
}

function decodeRegistrationCapsule(value) {
  if (length(value) < REGISTRATION_CAPSULE_HEADER || value[0] !== PROTOCOL_VERSION) invalid()
  const operation = value[1]
  const envelopeSize = readU16(value, 2)
  const nextSize = readU16(value, 4)
  const registration =
    operation === REGISTRATION_CAPSULE_FINAL || operation === REGISTRATION_CAPSULE_FORWARD
  const final =
    operation === REGISTRATION_CAPSULE_FINAL ||
    operation === REGISTRATION_CAPSULE_PREPARE_FINAL ||
    operation === REGISTRATION_CAPSULE_ABORT_FINAL ||
    operation === REGISTRATION_CAPSULE_FINALIZE_FINAL
  const forward =
    operation === REGISTRATION_CAPSULE_FORWARD ||
    operation === REGISTRATION_CAPSULE_PREPARE_FORWARD ||
    operation === REGISTRATION_CAPSULE_ABORT_FORWARD ||
    operation === REGISTRATION_CAPSULE_FINALIZE_FORWARD
  if (
    (!registration && !final && !forward) ||
    (registration ? envelopeSize < 1 : envelopeSize !== 0) ||
    REGISTRATION_CAPSULE_HEADER + envelopeSize + nextSize !== length(value) ||
    (final && nextSize !== 0) ||
    (forward && nextSize < SEALED_BOX_OVERHEAD)
  )
    invalid()
  return {
    operation,
    transactionId: copy(slice(value, 6, 22)),
    epoch: readU64(value, 22),
    expiresAt: readU64(value, 30),
    envelope: copy(
      slice(value, REGISTRATION_CAPSULE_HEADER, REGISTRATION_CAPSULE_HEADER + envelopeSize)
    ),
    nextCapsule: copy(slice(value, REGISTRATION_CAPSULE_HEADER + envelopeSize))
  }
}

function encodeRegistrationAcknowledgements(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_PRIVATE_HOPS) invalid()
  const output = allocate(REGISTRATION_ACK_HEADER + values.length * REGISTRATION_ACK_SIZE)
  output[0] = PROTOCOL_VERSION
  output[1] = values.length
  let offset = REGISTRATION_ACK_HEADER
  for (const value of values) {
    if (!fixed(value, REGISTRATION_ACK_SIZE)) invalid()
    put(output, value, offset)
    offset += REGISTRATION_ACK_SIZE
  }
  return output
}

function decodeRegistrationAcknowledgements(value) {
  if (
    length(value) < REGISTRATION_ACK_HEADER + REGISTRATION_ACK_SIZE ||
    value[0] !== PROTOCOL_VERSION ||
    value[1] < 1 ||
    value[1] > MAX_PRIVATE_HOPS ||
    length(value) !== REGISTRATION_ACK_HEADER + value[1] * REGISTRATION_ACK_SIZE
  )
    invalid()
  const values = new Array(value[1])
  for (let index = 0; index < values.length; index++) {
    const offset = REGISTRATION_ACK_HEADER + index * REGISTRATION_ACK_SIZE
    values[index] = copy(slice(value, offset, offset + REGISTRATION_ACK_SIZE))
  }
  return values
}

function registerPrivateRouteActors(options) {
  const session = ACTOR_SESSIONS.get(options.entryActor)
  if (
    !session ||
    !safeObject(options.built) ||
    !fixed(options.built.registrationCapsule, length(options.built.registrationCapsule)) ||
    length(options.built.registrationCapsule) < SEALED_BOX_OVERHEAD ||
    length(options.built.registrationCapsule) > MAX_ACTIVATION_OBJECT ||
    length(options.built.prepareCapsule) < SEALED_BOX_OVERHEAD ||
    length(options.built.prepareCapsule) > MAX_ACTIVATION_OBJECT ||
    length(options.built.finalizeCapsule) < SEALED_BOX_OVERHEAD ||
    length(options.built.finalizeCapsule) > MAX_ACTIVATION_OBJECT ||
    length(options.built.abortCapsule) < SEALED_BOX_OVERHEAD ||
    length(options.built.abortCapsule) > MAX_ACTIVATION_OBJECT ||
    !fixed(options.built.transactionId, REGISTRATION_TRANSACTION_SIZE) ||
    !Array.isArray(options.built.registrations) ||
    options.built.registrations.length < 1 ||
    options.built.registrations.length > MAX_PRIVATE_HOPS ||
    !safeObject(options.safetyRoute) ||
    typeof options.safetyRoute.attachEntry !== 'function' ||
    typeof options.safetyRoute.sendControl !== 'function' ||
    typeof options.safetyRoute.sendReverseFrame !== 'function' ||
    typeof options.now !== 'function' ||
    typeof options.randomBytes !== 'function'
  )
    invalid()
  let envelope = null
  let transport = null
  let result = null
  let entryAttachment = null
  let registration = null
  let attachmentCircuitId = null
  const receiver = new ActivationReassembler({ now: options.now })
  const acknowledgementReceiver = new ActivationReassembler({ now: options.now })
  const startedAt = registrationAttachmentTime(options.now)
  let acknowledgements = null
  let abortable = false
  let committed = false
  let controlState = ASYNC_REGISTRATION_STATE.NEW
  const entryPublic = actorPublicInfo(options.entryActor)
  function sendCommand(capsule, requireAcknowledgement) {
    const commandReceiver = new ActivationReassembler({ now: options.now })
    let accepted = false
    try {
      const fragments = fragmentActivation(capsule, { messageId: options.randomBytes(16) })
      let sent
      try {
        sent = options.safetyRoute.sendControl(fragments, (fragment) => {
          if (requireAcknowledgement) enforceRegistrationAttachmentDeadline(startedAt, options.now)
          const value = commandReceiver.pushAuthenticated(fragment)
          if (!value) return
          try {
            accepted = session.receiveRegistration(value) === true
            if (requireAcknowledgement)
              enforceRegistrationAttachmentDeadline(startedAt, options.now)
          } finally {
            clear(value)
          }
        })
      } finally {
        for (const fragment of fragments) clear(fragment)
      }
      if (requireAcknowledgement) enforceRegistrationAttachmentDeadline(startedAt, options.now)
      return sent === true && (!requireAcknowledgement || accepted)
    } finally {
      commandReceiver.destroy()
    }
  }
  try {
    registration = decodeTemplateRegister(options.built.registrations[0].message)
    attachmentCircuitId = options.randomBytes(16)
    if (!fixed(attachmentCircuitId, 16)) invalid()
    entryAttachment = options.safetyRoute.attachEntry(
      Object.freeze({
        entryActor: options.entryActor,
        circuitId: copy(attachmentCircuitId),
        epoch: registration.epoch,
        expiresAt: registration.expiresAt
      })
    )
    if (
      !safeObject(entryAttachment) ||
      Object.keys(entryAttachment).join(',') !== 'destroy' ||
      typeof entryAttachment.destroy !== 'function'
    )
      invalid()
    transport = copy(options.built.registrationCapsule)
    enforceRegistrationAttachmentDeadline(startedAt, options.now)
    const fragments = fragmentActivation(transport, { messageId: options.randomBytes(16) })
    const sent = options.safetyRoute.sendControl(fragments, (fragment) => {
      enforceRegistrationAttachmentDeadline(startedAt, options.now)
      const value = receiver.pushAuthenticated(fragment)
      if (!value) return
      try {
        abortable = true
        const relayAcknowledgements = session.receiveRegistration(value)
        let encoded = null
        try {
          encoded = encodeRegistrationAcknowledgements(relayAcknowledgements)
          const responseFragments = fragmentActivation(encoded, {
            messageId: options.randomBytes(16)
          })
          for (const responseFragment of responseFragments) {
            try {
              enforceRegistrationAttachmentDeadline(startedAt, options.now)
              const reversed = options.safetyRoute.sendReverseFrame(
                CELL_CLASS.CONTROL,
                responseFragment,
                (authenticated) => {
                  const complete = acknowledgementReceiver.pushAuthenticated(authenticated)
                  if (complete) acknowledgements = decodeRegistrationAcknowledgements(complete)
                  clear(complete)
                  return true
                }
              )
              if (reversed === false) throw PrivateRouteError.ROUTE_UNAVAILABLE()
            } finally {
              clear(responseFragment)
            }
          }
          result = true
        } finally {
          clear(encoded)
          clearTree(relayAcknowledgements)
        }
      } finally {
        clear(value)
      }
    })
    for (const fragment of fragments) clear(fragment)
    enforceRegistrationAttachmentDeadline(startedAt, options.now)
    if (
      sent !== true ||
      result !== true ||
      !Array.isArray(acknowledgements) ||
      acknowledgements.length !== options.built.registrations.length
    )
      throw PrivateRouteError.ROUTE_UNAVAILABLE()
    for (let index = 0; index < acknowledgements.length; index++) {
      const expected = decodeTemplateRegister(options.built.registrations[index].message)
      try {
        verifyRegistrationAck(acknowledgements[index], expected)
      } finally {
        clearTree(expected)
      }
    }
    controlState = transitionAsyncControlState('registration', controlState, 'stage')
    if (!sendCommand(options.built.prepareCapsule, true))
      throw PrivateRouteError.ROUTE_UNAVAILABLE()
    controlState = transitionAsyncControlState('registration', controlState, 'prepare')
    enforceRegistrationAttachmentDeadline(startedAt, options.now)
    if (!sendCommand(options.built.finalizeCapsule, false))
      throw PrivateRouteError.ROUTE_UNAVAILABLE()
    controlState = transitionAsyncControlState('registration', controlState, 'finalize')
    committed = true
    return Object.freeze({
      registered: true,
      acknowledgements: Object.freeze(acknowledgements.map(copy)),
      safetyRoute: options.safetyRoute
    })
  } catch (err) {
    if (abortable && !committed) {
      if (
        controlState === ASYNC_REGISTRATION_STATE.STAGED ||
        controlState === ASYNC_REGISTRATION_STATE.PREPARED
      )
        controlState = transitionAsyncControlState('registration', controlState, 'abort')
      try {
        sendCommand(options.built.abortCapsule, false)
      } catch {}
      if (controlState === ASYNC_REGISTRATION_STATE.ABORTING)
        controlState = transitionAsyncControlState('registration', controlState, 'aborted')
    }
    return Object.freeze({
      registered: false,
      failureCode: err instanceof PrivateRouteError ? err.code : 'ROUTE_UNAVAILABLE',
      safetyRoute: options.safetyRoute
    })
  } finally {
    if (entryAttachment) entryAttachment.destroy()
    receiver.destroy()
    acknowledgementReceiver.destroy()
    clear(envelope)
    clear(transport)
    clearTree(registration)
    clearTree(acknowledgements)
    clear(attachmentCircuitId)
    clearTree(entryPublic)
  }
}

function registrationAcknowledgement(circuitId, token) {
  if (!fixed(circuitId, 16) || !fixed(token, PRIVATE_FINAL_TOKEN_SIZE)) invalid()
  return hash([DOMAIN.TEMPLATE_REGISTERED, circuitId, token])
}

function registrationAttachmentTime(now) {
  let value
  try {
    value = now()
  } catch {
    invalid()
  }
  if (!Number.isSafeInteger(value) || value < 0) invalid()
  return value
}

function enforceRegistrationAttachmentDeadline(startedAt, now) {
  const current = registrationAttachmentTime(now)
  if (current < startedAt || current - startedAt >= ACTIVATION_FRAGMENT_TIMEOUT)
    throw PrivateRouteError.ROUTE_UNAVAILABLE()
}

// The only actor-capability dispatcher. Callers hand it canonical bytes and an
// opaque destination capability; the adjacent actor state is resolved only at
// delivery time, after the injected transport has accepted the bytes.
function adjacentActorState(capability) {
  return RELAY_ACTOR_STATES.get(capability) || DESTINATION_ACTOR_STATES.get(capability) || null
}

function exchangeActorLink(
  fromState,
  toActor,
  authority,
  common,
  responderStaticKey,
  onInitiatorDestroy = null
) {
  const started = fromState.initiateLink(authority, common, responderStaticKey)
  let accepted = null
  let created = null
  let complete = false
  try {
    transmitActorSynchronously(fromState, toActor, started.message, (message) => {
      const receiver = adjacentActorState(toActor)
      if (!receiver) unauthorized()
      accepted = receiver.acceptLink(authority, message, common)
    })
    if (!accepted) throw PrivateRouteError.ROUTE_UNAVAILABLE()
    transmitActorSynchronously(
      fromState,
      toActor,
      accepted.message,
      (message) => {
        created = copy(message)
      },
      true
    )
    if (!created) throw PrivateRouteError.ROUTE_UNAVAILABLE()
    const link = Object.freeze({
      receiver: adjacentActorState(toActor),
      accepted,
      initiator: endpointLink(
        authority.checker,
        authority.complete(started.pending, created),
        onInitiatorDestroy
      )
    })
    complete = true
    return link
  } finally {
    if (!complete) {
      authority.abort(started.pending)
      if (accepted) authority.revoke(accepted.ticket)
    }
    clear(created)
  }
}

function actorDestinationRegistrationTransport(
  fromState,
  destinationActor,
  token,
  epoch,
  expiresAt
) {
  const startedAt = registrationAttachmentTime(fromState.now)
  if (BigInt(startedAt) >= expiresAt) invalid()
  const authority = createLinkSetupAuthority({
    crypto: cryptoSuite,
    now: () => registrationAttachmentTime(fromState.now),
    randomBytes: fromState.randomBytes
  })
  const circuitId = fromState.randomBytes(16)
  const fromPublic = fromState.publicInfo()
  const destinationPublic = actorPublicInfo(destinationActor)
  const common = {
    circuitId,
    epoch,
    initiatorIdentity: fromPublic.identity,
    responderIdentity: destinationPublic.identity,
    initiatorLocalId: fromState.randomBytes(16),
    responderLocalId: fromState.randomBytes(16),
    expiresAt
  }
  const link = exchangeActorLink(
    fromState,
    destinationActor,
    authority,
    common,
    destinationPublic.routeEncryptionKey,
    (contexts) =>
      fromState.observeState({
        type: 'private-registration-attachment-destroyed',
        activeAttachments: 0,
        contexts
      })
  )
  const destinationState = link.receiver
  if (!destinationState) unauthorized()
  const initiator = link.initiator
  const responder = endpointLink(authority.checker, link.accepted.ticket, (contexts) =>
    destinationState.observeState({
      type: 'private-registration-attachment-destroyed',
      activeAttachments: 0,
      contexts
    })
  )
  const tokenReceiver = new ActivationReassembler({ now: fromState.now })
  const acknowledgementReceiver = new ActivationReassembler({ now: fromState.now })
  let receivedToken = null
  let acknowledgement = null
  let receivedAcknowledgement = null
  try {
    fromState.observeState({
      type: 'private-registration-attachment-opened',
      activeAttachments: 1
    })
    destinationState.observeState({
      type: 'private-registration-attachment-opened',
      activeAttachments: 1
    })
    const tokenFragments = fragmentActivation(token, {
      messageId: fromState.randomBytes(16)
    })
    for (const fragment of tokenFragments) {
      let packet = null
      try {
        enforceRegistrationAttachmentDeadline(startedAt, fromState.now)
        packet = initiator.sealControl(fragment)
        fromState.observePacket(destinationPublic.identity, packet)
        transmitActorSynchronously(fromState, destinationActor, packet, (received) => {
          const opened = responder.openControl(received, DIRECTION.FORWARD)
          const values = Array.isArray(opened) ? opened : [opened]
          for (const value of values) {
            try {
              const complete = tokenReceiver.pushAuthenticated(value)
              if (complete) {
                clear(receivedToken)
                receivedToken = complete
                clear(acknowledgement)
                acknowledgement = destinationState.acceptRegistration(receivedToken, circuitId)
              }
            } finally {
              clear(value)
            }
          }
        })
      } finally {
        clear(fragment)
        clear(packet)
      }
    }
    if (!receivedToken) throw PrivateRouteError.ROUTE_UNAVAILABLE()
    enforceRegistrationAttachmentDeadline(startedAt, fromState.now)
    if (!acknowledgement) throw PrivateRouteError.ROUTE_UNAVAILABLE()
    const acknowledgementFragments = fragmentActivation(acknowledgement, {
      messageId: fromState.randomBytes(16)
    })
    for (const fragment of acknowledgementFragments) {
      let packet = null
      try {
        packet = responder.seal(CELL_CLASS.CONTROL, DIRECTION.REVERSE, fragment)
        destinationState.observeState({
          type: 'private-registration-ack-cell',
          packetBytes: length(packet)
        })
        transmitActorSynchronously(
          fromState,
          destinationActor,
          packet,
          (received) => {
            const opened = initiator.openControl(received, DIRECTION.REVERSE)
            const values = Array.isArray(opened) ? opened : [opened]
            for (const value of values) {
              try {
                const complete = acknowledgementReceiver.pushAuthenticated(value)
                if (complete) {
                  clear(receivedAcknowledgement)
                  receivedAcknowledgement = complete
                }
              } finally {
                clear(value)
              }
            }
          },
          true
        )
        enforceRegistrationAttachmentDeadline(startedAt, fromState.now)
      } finally {
        clear(fragment)
        clear(packet)
      }
    }
    const expected = registrationAcknowledgement(circuitId, token)
    try {
      if (!receivedAcknowledgement || !same(receivedAcknowledgement, expected)) unauthorized()
    } finally {
      clear(expected)
    }
    return true
  } finally {
    tokenReceiver.destroy()
    acknowledgementReceiver.destroy()
    responder.destroy()
    initiator.destroy()
    clear(receivedToken)
    clear(acknowledgement)
    clear(receivedAcknowledgement)
    clear(circuitId)
    clearTree(fromPublic)
    clearTree(destinationPublic)
  }
}

function actorControlTransport(fromState, toActor, payload, epoch, expiresAt, command = false) {
  const now = fromState.now()
  if (!Number.isSafeInteger(now) || now < 0 || BigInt(now) >= expiresAt) invalid()
  const authority = createLinkSetupAuthority({
    crypto: cryptoSuite,
    now: () => now,
    randomBytes: fromState.randomBytes
  })
  const circuitId = fromState.randomBytes(16)
  const fromPublic = fromState.publicInfo()
  const toPublic = actorPublicInfo(toActor)
  const common = {
    circuitId,
    epoch,
    initiatorIdentity: fromPublic.identity,
    responderIdentity: toPublic.identity,
    initiatorLocalId: fromState.randomBytes(16),
    responderLocalId: fromState.randomBytes(16),
    expiresAt
  }
  const link = exchangeActorLink(fromState, toActor, authority, common, toPublic.routeEncryptionKey)
  const toState = link.receiver
  if (!toState || toState.isDestroyed()) unauthorized()
  const initiator = link.initiator
  const binding = toState.openRegistrationBinding(authority, link.accepted.ticket, common)
  const acknowledgementReceiver = new ActivationReassembler({ now: fromState.now })
  let result = null
  try {
    const fragments = fragmentActivation(payload, { messageId: fromState.randomBytes(16) })
    for (const fragment of fragments) {
      let packet = null
      try {
        packet = initiator.sealControl(fragment)
        fromState.observePacket(toPublic.identity, packet)
        transmitActorSynchronously(
          fromState,
          toActor,
          packet,
          (received) => binding.receive(fromPublic.identity, received),
          false
        )
      } finally {
        clear(fragment)
        clear(packet)
      }
    }
    if (command === 'finalize') return true
    const packets = binding.takeAcknowledgementPackets()
    for (const packet of packets) {
      try {
        transmitActorSynchronously(
          fromState,
          toActor,
          packet,
          (received) => {
            const opened = initiator.openControl(received, DIRECTION.REVERSE)
            for (const value of Array.isArray(opened) ? opened : [opened]) {
              const complete = acknowledgementReceiver.pushAuthenticated(value)
              if (complete) {
                let acknowledged = null
                try {
                  acknowledged = command
                    ? toState.mutateCommandAcknowledgement(copy(complete))
                    : complete
                  result = command
                    ? length(acknowledged) === 2 &&
                      acknowledged[0] === PROTOCOL_VERSION &&
                      acknowledged[1] === REGISTRATION_COMMAND_ACK
                    : decodeRegistrationAcknowledgements(acknowledged)
                } finally {
                  if (command) clear(acknowledged)
                  clear(complete)
                }
              }
            }
          },
          true
        )
      } finally {
        clear(packet)
      }
    }
    if (!result) throw PrivateRouteError.ROUTE_UNAVAILABLE()
    return result
  } finally {
    acknowledgementReceiver.destroy()
    binding.destroy(fromPublic.identity)
    initiator.destroy()
    clear(circuitId)
    clearTree(fromPublic)
    clearTree(toPublic)
    if (!result) clearTree(result)
  }
}

function transmitOwned(fromState, peerState, packet, receive, reverse, synchronous, pending) {
  if (synchronous) return transmitActorSynchronously(fromState, peerState, packet, receive, reverse)
  return transmitQueued(
    (deliver) => fromState.transmit(peerState, packet, deliver, reverse, synchronous),
    receive,
    pending
  )
}

function cancelPendingTransmissions(pending) {
  for (const cancellation of pending) {
    try {
      cancellation.cancel()
    } catch {}
  }
  pending.clear()
}

function actorDestinationActivationTransport(fromState, destinationActor, request, returnProof) {
  const decodedRequest = decodeDestinationActivationRequest(request)
  const decodedCreate = decodeCreate(decodedRequest.create)
  const now = fromState.now()
  const authority = createLinkSetupAuthority({
    crypto: cryptoSuite,
    now: () => now,
    randomBytes: fromState.randomBytes
  })
  const linkCircuitId = fromState.randomBytes(16)
  const fromPublic = fromState.publicInfo()
  const destinationPublic = actorPublicInfo(destinationActor)
  const destinationIdentity = copy(destinationPublic.identity)
  const common = {
    circuitId: linkCircuitId,
    epoch: decodedCreate.epoch,
    initiatorIdentity: fromPublic.identity,
    responderIdentity: destinationPublic.identity,
    initiatorLocalId: fromState.randomBytes(16),
    responderLocalId: fromState.randomBytes(16),
    expiresAt: decodedRequest.expiresAt
  }
  const link = exchangeActorLink(
    fromState,
    destinationActor,
    authority,
    common,
    destinationPublic.routeEncryptionKey
  )
  const destinationState = link.receiver
  if (!destinationState) unauthorized()
  const initiator = link.initiator
  const responder = endpointLink(authority.checker, link.accepted.ticket)
  const snapshot = initiator.bindingSnapshot()
  const destinationReceiver = destinationState.createActivationReceiver()
  const routeId = copy(decodedCreate.circuitId)
  let created = null
  let response = null
  let retained = false
  let live = true
  let transport = null
  const pending = new Set()
  try {
    const requestFragments = fragmentActivation(request, { messageId: fromState.randomBytes(16) })
    for (const fragment of requestFragments) {
      let packet = null
      let opened = null
      try {
        packet = initiator.sealControl(fragment)
        fromState.observePacket(destinationIdentity, packet, {
          type: 'private-activation-control',
          direction: DIRECTION.FORWARD
        })
        // Activation is still a synchronous prototype API. The transport adapter
        // must authenticate delivery before returning while retaining byte-only
        // actor boundaries; persistent payload traffic remains queueable.
        transmitOwned(
          fromState,
          destinationState,
          packet,
          (received) => {
            opened = responder.openControl(received, DIRECTION.FORWARD)
            for (const value of Array.isArray(opened) ? opened : [opened]) {
              const proof = destinationReceiver.receive(value)
              if (proof) created = proof
            }
          },
          false,
          true,
          pending
        )
      } finally {
        clear(fragment)
        clear(packet)
        clearTree(opened)
      }
    }
    if (!created) throw PrivateRouteError.ROUTE_UNAVAILABLE()
    transport = Object.freeze({
      forward(cellClass, frame, deliver) {
        if (!live) throw PrivateRouteError.CIRCUIT_STATE()
        const counter = initiator.nextCounter(cellClass)
        let packet = null
        let opened = null
        try {
          packet = initiator.seal(cellClass, DIRECTION.FORWARD, frame)
          fromState.observePacket(destinationIdentity, packet, {
            type: 'private-frame',
            cellClass,
            direction: DIRECTION.FORWARD,
            counter,
            ...snapshot
          })
          let result
          transmitOwned(
            fromState,
            destinationState,
            packet,
            (received) => {
              try {
                opened = responder.open(cellClass, DIRECTION.FORWARD, received)
                if (Array.isArray(opened)) opened = opened[0]
                result = deliver(opened)
              } catch (err) {
                try {
                  fromState.destroyCircuit(routeId)
                } catch {}
                throw err
              }
            },
            false,
            false,
            pending
          )
          return result
        } finally {
          clear(packet)
          clear(opened)
        }
      },
      reverse(cellClass, frame) {
        if (!live) throw PrivateRouteError.CIRCUIT_STATE()
        const counter = responder.nextCounter(cellClass)
        let packet = null
        let opened = null
        try {
          packet = responder.seal(cellClass, DIRECTION.REVERSE, frame)
          fromState.observePacket(destinationIdentity, packet, {
            type: 'private-frame',
            cellClass,
            direction: DIRECTION.REVERSE,
            counter,
            ...snapshot
          })
          let result
          transmitOwned(
            fromState,
            destinationState,
            packet,
            (received) => {
              try {
                opened = initiator.open(cellClass, DIRECTION.REVERSE, received)
                if (Array.isArray(opened)) opened = opened[0]
                result =
                  cellClass === CELL_CLASS.CONTROL
                    ? fromState.reverseControl(routeId, opened)
                    : fromState.reverseFrame(routeId, cellClass, opened)
              } catch (err) {
                try {
                  fromState.destroyCircuit(routeId)
                } catch {}
                throw err
              }
            },
            true,
            false,
            pending
          )
          return result
        } finally {
          clear(packet)
          clear(opened)
        }
      },
      destroy(propagateForward) {
        if (!live) return
        live = false
        cancelPendingTransmissions(pending)
        responder.destroy()
        initiator.destroy()
        if (propagateForward) destinationState.destroyCircuit(routeId)
        clear(routeId)
        clear(destinationIdentity)
      }
    })
    fromState.bindDestination(decodedCreate.circuitId, destinationActor, transport)
    destinationState.bindTransport(decodedCreate.circuitId, transport)
    retained = true
    response = encodeActivationResponse({ entryProof: decodedRequest.entryProof, created })
    if (!returnProof) {
      const createdFragments = fragmentActivation(response, {
        messageId: fromState.randomBytes(16)
      })
      for (const fragment of createdFragments) {
        try {
          destinationState.observeState({
            type: 'private-created-control',
            direction: DIRECTION.REVERSE,
            packetBytes: CELL_SIZE
          })
          transport.reverse(CELL_CLASS.CONTROL, fragment)
        } finally {
          clear(fragment)
        }
      }
    }
    return returnProof ? copy(response) : true
  } finally {
    destinationReceiver.destroy()
    if (!retained) {
      if (transport) transport.destroy(false)
      else {
        responder.destroy()
        initiator.destroy()
        clear(routeId)
        clear(destinationIdentity)
      }
    }
    clear(linkCircuitId)
    clear(created)
    clear(response)
    clearTree(decodedRequest)
    clearTree(decodedCreate)
    clearTree(fromPublic)
    clearTree(destinationPublic)
  }
}

function actorActivationTransport(fromState, toActor, request, returnProof) {
  const decodedRequest = decodeActivationRequest(request)
  const decodedCreate = decodeCreate(decodedRequest.create)
  if (decodedRequest.entry) unauthorized()
  const now = fromState.now()
  const authority = createLinkSetupAuthority({
    crypto: cryptoSuite,
    now: () => now,
    randomBytes: fromState.randomBytes
  })
  const circuitId = fromState.randomBytes(16)
  const fromPublic = fromState.publicInfo()
  const toPublic = actorPublicInfo(toActor)
  const common = {
    circuitId,
    epoch: decodedCreate.epoch,
    initiatorIdentity: fromPublic.identity,
    responderIdentity: toPublic.identity,
    initiatorLocalId: fromState.randomBytes(16),
    responderLocalId: fromState.randomBytes(16),
    expiresAt: decodedRequest.expiresAt
  }
  const link = exchangeActorLink(fromState, toActor, authority, common, toPublic.routeEncryptionKey)
  const toState = link.receiver
  if (!toState || toState.isDestroyed()) unauthorized()
  const initiator = link.initiator
  const binding = toState.openActivationBinding(
    authority,
    link.accepted.ticket,
    common,
    returnProof
  )
  const routeId = copy(decodedCreate.circuitId)
  const fromIdentity = copy(fromPublic.identity)
  const toIdentity = copy(toPublic.identity)
  let retained = false
  let live = true
  let adjacency = null
  let result = null
  const pending = new Set()
  try {
    const snapshot = initiator.bindingSnapshot()
    fromState.observeState({
      type: 'private-binding-opened',
      peerIdentity: b4a.toString(toIdentity, 'hex'),
      peerRole: ROLE.PRIVATE,
      direction: DIRECTION.FORWARD,
      ...snapshot
    })
    toState.observeState({
      type: 'private-binding-opened',
      peerIdentity: b4a.toString(fromIdentity, 'hex'),
      peerRole: ROLE.PRIVATE,
      direction: DIRECTION.REVERSE,
      ...snapshot
    })
    adjacency = Object.freeze({
      forward(cellClass, frame, deliver) {
        if (!live) throw PrivateRouteError.CIRCUIT_STATE()
        const counter = initiator.nextCounter(cellClass)
        let packet = null
        let opened = null
        try {
          packet = initiator.seal(cellClass, DIRECTION.FORWARD, frame)
          fromState.observePacket(toIdentity, packet, {
            type: 'private-frame',
            cellClass,
            direction: DIRECTION.FORWARD,
            counter,
            ...snapshot
          })
          let result
          transmitOwned(
            fromState,
            toState,
            packet,
            (received) => {
              try {
                binding.receive(fromIdentity, received)
                opened = binding.takeForward()
                if (!opened) throw PrivateRouteError.ROUTE_UNAVAILABLE()
                result = toState.forwardFrame(routeId, cellClass, opened, deliver)
              } catch (err) {
                try {
                  fromState.destroyCircuit(routeId)
                } catch {}
                throw err
              }
            },
            false,
            false,
            pending
          )
          return result
        } finally {
          clear(packet)
          clear(opened)
        }
      },
      reverse(cellClass, frame) {
        if (!live) throw PrivateRouteError.CIRCUIT_STATE()
        const counter = binding.nextReverseCounter(cellClass)
        let packet = null
        let opened = null
        try {
          packet = binding.sendReverse(cellClass, frame)
          if (!packet) throw PrivateRouteError.ROUTE_UNAVAILABLE()
          fromState.observePacket(toIdentity, packet, {
            type: cellClass === CELL_CLASS.CONTROL ? 'private-created-control' : 'private-frame',
            cellClass,
            direction: DIRECTION.REVERSE,
            counter,
            ...snapshot
          })
          let result
          transmitOwned(
            fromState,
            toState,
            packet,
            (received) => {
              try {
                opened = initiator.open(cellClass, DIRECTION.REVERSE, received)
                if (Array.isArray(opened)) opened = opened[0]
                result =
                  cellClass === CELL_CLASS.CONTROL
                    ? fromState.reverseControl(routeId, opened)
                    : fromState.reverseFrame(routeId, cellClass, opened)
              } catch (err) {
                try {
                  fromState.destroyCircuit(routeId)
                } catch {}
                throw err
              }
            },
            true,
            false,
            pending
          )
          return result
        } finally {
          clear(packet)
          clear(opened)
        }
      },
      destroy(propagateForward) {
        if (!live) return
        live = false
        cancelPendingTransmissions(pending)
        try {
          binding.destroy(fromIdentity)
        } finally {
          initiator.destroy()
          if (propagateForward) toState.destroyCircuit(routeId)
          clear(routeId)
          clear(fromIdentity)
          clear(toIdentity)
        }
      }
    })
    fromState.bindNext(decodedCreate.circuitId, toActor, adjacency)
    toState.bindPrevious(
      decodedCreate.circuitId,
      fromState.capability(),
      adjacency,
      decodedCreate.epoch,
      decodedRequest.expiresAt
    )
    const fragments = fragmentActivation(request, { messageId: fromState.randomBytes(16) })
    for (const fragment of fragments) {
      let packet = null
      try {
        packet = initiator.sealControl(fragment)
        fromState.observePacket(toPublic.identity, packet)
        transmitActorSynchronously(
          fromState,
          toActor,
          packet,
          (received) => binding.receive(fromPublic.identity, received),
          false
        )
      } finally {
        clear(fragment)
        clear(packet)
      }
    }
    result = binding.result()
    if (returnProof ? length(result) < 0 : result !== true)
      throw PrivateRouteError.ROUTE_UNAVAILABLE()
    const completedAt = fromState.now()
    if (
      !Number.isSafeInteger(completedAt) ||
      completedAt < decodedRequest.startedAt ||
      decodedRequest.startedAt > Number.MAX_SAFE_INTEGER - ACTIVATION_FRAGMENT_TIMEOUT ||
      completedAt >= decodedRequest.startedAt + ACTIVATION_FRAGMENT_TIMEOUT
    )
      throw PrivateRouteError.ROUTE_UNAVAILABLE()
    binding.open()
    retained = true
    return result
  } finally {
    if (!retained) {
      if (adjacency) adjacency.destroy(true)
      else {
        binding.destroy(fromPublic.identity)
        initiator.destroy()
        clear(routeId)
        clear(fromIdentity)
        clear(toIdentity)
      }
    }
    clear(circuitId)
    clearTree(fromPublic)
    clearTree(toPublic)
    clearTree(decodedRequest)
    clearTree(decodedCreate)
  }
}

function actorFrameTransport(fromState, circuitId, cellClass, frame, deliver, forward) {
  const transport = fromState.routeTransport(circuitId, forward)
  return forward
    ? transport.forward(cellClass, frame, deliver)
    : transport.reverse(cellClass, frame)
}

export function registerPrivateRoute(options) {
  if (!safeObject(options) || options.entryActor === undefined) invalid()
  return registerPrivateRouteActors(options)
}

export function registerPrivateRouteLegacy(options) {
  if (
    !safeObject(options) ||
    !safeObject(options.built) ||
    !Array.isArray(options.registries) ||
    options.registries.length < 1 ||
    options.registries.length > MAX_PRIVATE_HOPS ||
    options.registries.length !== options.built.registrations.length ||
    !fixed(options.destinationIdentity, 32) ||
    !fixed(options.destinationIdentitySecretKey, 64) ||
    typeof options.now !== 'function' ||
    typeof options.randomBytes !== 'function'
  )
    invalid()
  const states = options.registries.map((registry) => REGISTRY_STATES.get(registry))
  if (states.some((state) => !state)) invalid()
  if (!fixed(options.built.finalToken, PRIVATE_FINAL_TOKEN_SIZE)) invalid()
  const observeActivation = option(options, TEST_ONLY_ACTIVATION_OBSERVER)
  if (observeActivation !== undefined && typeof observeActivation !== 'function') invalid()
  const resources = { links: 0, ids: 0, secretBytes: 0, queuedBytes: 0, fragmentBytes: 0 }
  const proof = {
    peakLinks: 0,
    peakIds: 0,
    peakSecretBytes: 0,
    peakQueuedBytes: 0,
    zeroizedContexts: 0
  }
  const touched = []
  const services = []
  const serviceBindings = []
  const endpointLinks = []
  const registrationReceivers = []
  const continuationReceivers = []
  const registrationBatches = []
  const continuationBatches = []
  const pendingRoutes = []
  const acknowledgements = []
  const pendingDeliveries = []
  let acknowledgementReceiver = null
  let finalTokenReceiver = null
  let finalTokenMatched = false
  let sourceLink = null
  let sourceReceive = () => invalid()
  let queueTerminal = false
  let terminalSend = () => false
  function pump() {
    while (pendingDeliveries.length) {
      const delivery = pendingDeliveries.shift()
      try {
        services[delivery.index].receive(delivery.from, delivery.packet)
      } finally {
        clear(delivery.from)
        clear(delivery.packet)
      }
    }
  }
  let complete = false
  let failureCode = null
  let authority = null
  try {
    let now
    try {
      now = options.now()
    } catch {
      invalid()
    }
    if (!Number.isSafeInteger(now) || now < 0) invalid()
    authority = createLinkSetupAuthority({
      now: () => now,
      randomBytes(size) {
        const value = options.randomBytes(size)
        if (!fixed(value, size)) invalid()
        return value
      }
    })
    const endpointEncryption = cryptoSuite.encryptionKeyPair(options.randomBytes(32))
    const safetyIdentity = cryptoSuite.keyPair(options.randomBytes(32))
    const safetyEncryption = cryptoSuite.encryptionKeyPair(options.randomBytes(32))
    try {
      const nodes = [
        {
          identity: safetyIdentity.publicKey,
          identitySecretKey: safetyIdentity.secretKey,
          routeEncryptionPublicKey: safetyEncryption.publicKey,
          routeEncryptionSecretKey: safetyEncryption.secretKey
        },
        ...states,
        {
          identity: options.destinationIdentity,
          identitySecretKey: options.destinationIdentitySecretKey,
          routeEncryptionPublicKey: endpointEncryption.publicKey,
          routeEncryptionSecretKey: endpointEncryption.secretKey
        }
      ]
      const links = []
      const registration = decodeTemplateRegister(options.built.registrations[0].message)
      const circuitId = options.randomBytes(16)
      for (let index = 0; index < nodes.length - 1; index++) {
        const initiator = nodes[index]
        const responder = nodes[index + 1]
        const common = {
          circuitId,
          epoch: registration.epoch,
          initiatorIdentity: initiator.identity,
          responderIdentity: responder.identity,
          initiatorLocalId: options.randomBytes(16),
          responderLocalId: options.randomBytes(16),
          expiresAt: registration.expiresAt
        }
        const started = authority.initiate({
          ...common,
          responderStaticKey: responder.routeEncryptionPublicKey,
          initiatorIdentitySecretKey: initiator.identitySecretKey
        })
        const responded = authority.respond(started.message, {
          ...common,
          responderStaticSecretKey: responder.routeEncryptionSecretKey,
          responderIdentitySecretKey: responder.identitySecretKey
        })
        const initiatorTicket = authority.complete(started.pending, responded.message)
        links.push({ common, initiatorTicket, responderTicket: responded.ticket })
        resources.links++
        resources.ids += 2
      }
      resources.secretBytes = links.length * 2 * 6 * (32 + 16)
      proof.peakLinks = resources.links
      proof.peakIds = resources.ids
      proof.peakSecretBytes = resources.secretBytes

      for (let index = 0; index < states.length; index++) {
        registrationReceivers.push(new ActivationReassembler({ now: () => now }))
        if (index + 1 < states.length)
          continuationReceivers.push(new ActivationReassembler({ now: () => now }))
      }
      let initialEnvelope = null
      let initialTransport = null
      try {
        initialEnvelope = encodeRegistrationEnvelope(options.built.registrations[0])
        initialTransport = sealTemplate(initialEnvelope, states[0].routeEncryptionPublicKey)
        const messageId = options.randomBytes(16)
        messageId[0] = 0
        registrationBatches.push(fragmentActivation(initialTransport, { messageId }))
      } finally {
        clear(initialEnvelope)
        clear(initialTransport)
      }
      for (let index = 1; index < states.length; index++) {
        let envelope = options.built.registrations[index]
        let bad = null
        let encoded = null
        try {
          if (options.fault === 'reject' && index === 1) {
            bad = copy(envelope.sealedTemplate)
            bad[length(bad) - 1] ^= 1
            envelope = { message: envelope.message, sealedTemplate: bad }
          }
          encoded = encodeRegistrationEnvelope(envelope)
          const messageId = options.randomBytes(16)
          messageId[0] = 0xf0
          messageId[1] = index - 1
          continuationBatches.push(fragmentActivation(encoded, { messageId }))
        } finally {
          clear(bad)
          clear(encoded)
        }
      }

      for (let index = 0; index < states.length; index++) {
        const service = new RelayService({
          identity: states[index].identity,
          ticketChecker: authority.checker,
          crypto: cryptoSuite,
          now: () => now,
          padding: (size) => b4a.alloc(size),
          send(peer, packet) {
            if (same(peer, nodes[index].identity)) {
              if (index === 0) return sourceReceive(packet)
              pendingDeliveries.push({
                index: index - 1,
                from: copy(states[index].identity),
                packet: copy(packet)
              })
              return true
            }
            if (!same(peer, nodes[index + 2].identity)) invalid()
            const next = services[index + 1]
            if (!next) return terminalSend(peer, packet)
            pendingDeliveries.push({
              index: index + 1,
              from: copy(states[index].identity),
              packet: copy(packet)
            })
            return true
          },
          onControl(event) {
            if (length(event.payload) === 2 && event.payload[0] === 0xf0) {
              return false
            }
            if (event.payload[0] === 0xf0) {
              const origin = event.payload[1]
              if (origin !== index) return false
              const value = continuationReceivers[index].pushAuthenticated(event.payload)
              proof.peakFragmentBytes = Math.max(
                proof.peakFragmentBytes || 0,
                continuationReceivers[index].bufferedBytes
              )
              if (value) {
                const route = pendingRoutes[index]
                let envelope = null
                let advertisement = null
                let transport = null
                let fragments = null
                try {
                  if (!route || index + 1 >= states.length) invalid()
                  envelope = decodeRegistrationEnvelope(value)
                  if (!same(envelope.sealedTemplate, route.nextLayer)) unauthorized()
                  advertisement = verifyAdvertisement(
                    route.nextAdvertisement,
                    route.epoch,
                    route.expiresAt,
                    BigInt(now)
                  )
                  if (
                    !same(advertisement.identityKey, nodes[index + 2].identity) ||
                    !same(
                      advertisement.routeEncryptionKey,
                      states[index + 1].routeEncryptionPublicKey
                    )
                  )
                    unauthorized()
                  transport = sealTemplate(value, advertisement.routeEncryptionKey)
                  const messageId = options.randomBytes(16)
                  messageId[0] = index + 1
                  fragments = fragmentActivation(transport, { messageId })
                  event.forward(fragments)
                  pendingRoutes[index] = null
                  clearTree(route)
                } finally {
                  clear(value)
                  clear(transport)
                  if (fragments) for (const fragment of fragments) clear(fragment)
                  clearTree(envelope)
                  clearTree(advertisement)
                }
              }
              return true
            }
            const target = event.payload[0]
            if (target !== index) return false
            const value = registrationReceivers[index].pushAuthenticated(event.payload)
            proof.peakFragmentBytes = Math.max(
              proof.peakFragmentBytes || 0,
              registrationReceivers[index].bufferedBytes
            )
            if (value) {
              let plaintext = null
              let envelope = null
              try {
                plaintext = openTemplate(
                  value,
                  states[index].routeEncryptionPublicKey,
                  states[index].routeEncryptionSecretKey
                )
                envelope = decodeRegistrationEnvelope(plaintext)
                const register = decodeTemplateRegister(envelope.message)
                const key = registrationKey(register)
                const existed = states[index].records.has(key)
                const registered = states[index].registerForTraversal(
                  envelope,
                  options.built.transactionId
                )
                if (!existed) touched.push([states[index], key])
                if (!(options.fault === 'drop-ack' && index === states.length - 1)) {
                  const ackId = options.randomBytes(16)
                  ackId[0] = 0xe0 + index
                  const ackFragments = fragmentActivation(registered.ack, { messageId: ackId })
                  try {
                    if (index + 1 === states.length) {
                      if (
                        length(registered.nextAdvertisement) !== 0 ||
                        !fixed(registered.nextLayer, PRIVATE_FINAL_TOKEN_SIZE)
                      )
                        unauthorized()
                      const token = copy(registered.nextLayer)
                      if (options.fault === 'wrong-final-token') token[0] ^= 1
                      const tokenId = options.randomBytes(16)
                      tokenId[0] = 0xd0
                      const tokenFragments = fragmentActivation(token, { messageId: tokenId })
                      try {
                        event.forward([...tokenFragments, ...ackFragments])
                      } finally {
                        clear(token)
                        for (const fragment of tokenFragments) clear(fragment)
                      }
                      clearTree(registered)
                    } else {
                      if (
                        length(registered.nextAdvertisement) < 1 ||
                        length(registered.nextLayer) < SEALED_BOX_OVERHEAD
                      )
                        unauthorized()
                      if (pendingRoutes[index]) replay()
                      pendingRoutes[index] = registered
                      event.reply(ackFragments)
                    }
                  } finally {
                    for (const fragment of ackFragments) clear(fragment)
                  }
                } else {
                  clearTree(registered)
                }
              } finally {
                clear(value)
                clear(plaintext)
                if (envelope) {
                  clear(envelope.message)
                  clear(envelope.sealedTemplate)
                }
              }
            }
            return true
          },
          [TEST_ONLY_RELAY_OBSERVER](event) {
            if (event.type === 'zeroized') proof.zeroizedContexts += event.contexts.length
          }
        })
        service.install(links[index].responderTicket, links[index + 1].initiatorTicket)
        services.push(service)
        serviceBindings.push({
          peer: nodes[index].identity,
          localId: links[index].common.responderLocalId
        })
      }
      const destinationLink = endpointLink(
        authority.checker,
        links[links.length - 1].responderTicket,
        (count) => {
          proof.zeroizedContexts += count
        }
      )
      sourceLink = endpointLink(authority.checker, links[0].initiatorTicket, (count) => {
        proof.zeroizedContexts += count
      })
      endpointLinks.push(sourceLink, destinationLink)
      acknowledgementReceiver = new ActivationReassembler({ now: () => now })
      finalTokenReceiver = new ActivationReassembler({ now: () => now })
      const handleAcknowledgement = (deliveries) => {
        for (const fragment of deliveries) {
          try {
            if (fragment[0] === 0xd0) {
              const token = finalTokenReceiver.pushAuthenticated(fragment)
              if (token) {
                try {
                  if (finalTokenMatched || !same(token, options.built.finalToken)) unauthorized()
                  finalTokenMatched = true
                } finally {
                  clear(token)
                }
              }
              continue
            }
            const ack = acknowledgementReceiver.pushAuthenticated(fragment)
            if (ack) {
              const decoded = decodeTemplateRegistered(ack)
              const index = Number(fragment[0] - 0xe0)
              if (
                !Number.isInteger(index) ||
                index < 0 ||
                index >= states.length ||
                (index + 1 === states.length && !finalTokenMatched)
              )
                unauthorized()
              const register = decodeTemplateRegister(options.built.registrations[index].message)
              verifyRegistrationAck(ack, register)
              acknowledgements.push(decoded)
              clear(ack)
            }
          } finally {
            clear(fragment)
          }
        }
        return true
      }
      sourceReceive = (packet) =>
        handleAcknowledgement(sourceLink.openControl(packet, DIRECTION.REVERSE))
      terminalSend = (peer, packet) => {
        if (queueTerminal) return false
        return handleAcknowledgement(destinationLink.openControl(packet, DIRECTION.FORWARD))
      }
      if (options.fault === 'timeout') {
        const first = registrationBatches[0][0]
        services[0].receive(safetyIdentity.publicKey, sourceLink.sealControl(first))
        pump()
        proof.peakFragmentBytes = registrationReceivers[0].bufferedBytes
        throw PrivateRouteError.ROUTE_UNAVAILABLE()
      }
      for (const fragment of registrationBatches[0]) {
        services[0].receive(safetyIdentity.publicKey, sourceLink.sealControl(fragment))
        pump()
      }
      for (const batch of continuationBatches) {
        for (const fragment of batch) {
          services[0].receive(safetyIdentity.publicKey, sourceLink.sealControl(fragment))
          pump()
        }
      }
      if (acknowledgements.length !== states.length || !finalTokenMatched)
        throw PrivateRouteError.ROUTE_UNAVAILABLE()
      for (const state of states) {
        state.finishTransaction(options.built.transactionId, 'prepare')
        state.finishTransaction(options.built.transactionId, 'finalize')
      }
      queueTerminal = true
      const queuedFragment = fragmentActivation(b4a.from([PROTOCOL_VERSION]), {
        messageId: options.randomBytes(16)
      })[0]
      queuedFragment[0] = 0xff
      services[0].receive(safetyIdentity.publicKey, sourceLink.sealControl(queuedFragment))
      pump()
      proof.peakQueuedBytes = services.reduce((total, service) => total + service.queuedBytes, 0)
      resources.queuedBytes = proof.peakQueuedBytes
      if (observeActivation) {
        const names = ['entry', 'middle', 'final']
        for (let index = 0; index < states.length; index++) {
          observeActivation(
            Object.freeze({
              phase: 'registration',
              node: names[index],
              adjacent: Object.freeze([
                index === 0 ? 'safety-final' : names[index - 1],
                index + 1 === states.length ? 'destination' : names[index + 1]
              ])
            })
          )
        }
        observeActivation(
          Object.freeze({
            phase: 'registration',
            node: 'destination',
            adjacent: Object.freeze(['guard', 'final'])
          })
        )
      }
      complete = true
    } finally {
      clear(endpointEncryption.publicKey)
      clear(endpointEncryption.secretKey)
      clear(safetyIdentity.secretKey)
      clear(safetyEncryption.secretKey)
    }
  } catch (err) {
    try {
      failureCode = err instanceof PrivateRouteError ? err.code : err && err.message
    } catch {}
    for (const [state, key] of touched) {
      const record = state.records.get(key)
      if (record) clearTree(record)
      state.records.delete(key)
    }
  } finally {
    for (let index = services.length - 1; index >= 0; index--) {
      const binding = serviceBindings[index]
      try {
        services[index].destroy(binding.peer, binding.localId)
      } catch {}
    }
    for (const link of endpointLinks) link.destroy()
    for (const receiver of registrationReceivers) receiver.destroy()
    for (const receiver of continuationReceivers) receiver.destroy()
    if (acknowledgementReceiver) acknowledgementReceiver.destroy()
    if (finalTokenReceiver) finalTokenReceiver.destroy()
    for (const batch of registrationBatches) for (const fragment of batch) clear(fragment)
    for (const batch of continuationBatches) for (const fragment of batch) clear(fragment)
    for (const route of pendingRoutes) clearTree(route)
    for (const acknowledgement of acknowledgements) clearTree(acknowledgement)
    for (const delivery of pendingDeliveries) {
      clear(delivery.from)
      clear(delivery.packet)
    }
    pendingDeliveries.length = 0
    proof.postActiveCircuits = services.reduce(
      (total, service) => total + service.activeCircuits,
      0
    )
    proof.postQueuedBytes = services.reduce((total, service) => total + service.queuedBytes, 0)
    proof.postFragmentBytes = registrationReceivers.reduce(
      (total, receiver) => total + receiver.bufferedBytes,
      0
    )
    resources.links = 0
    resources.ids = 0
    resources.secretBytes = 0
    resources.queuedBytes = 0
    resources.fragmentBytes = 0
  }
  return Object.freeze({
    registered: complete,
    failureCode,
    safetyRoute: options.safetyRoute,
    resources: Object.freeze({ ...resources }),
    proof: Object.freeze({ ...proof })
  })
}

function secretBytes(state) {
  let total = 0
  for (const pair of Object.values(state.contexts)) {
    for (const context of [pair.tx, pair.rx])
      total += length(context.key) + length(context.noncePrefix)
  }
  return total
}

function validateCreate(value) {
  if (
    !safeObject(value) ||
    option(value, 'version') !== PROTOCOL_VERSION ||
    !fixed(option(value, 'circuitId'), 16) ||
    !u64(option(value, 'epoch')) ||
    !fixed(option(value, 'descriptorId'), 32) ||
    !fixed(option(value, 'sourceEphemeralKey'), 32) ||
    !fixed(option(value, 'safetyTranscriptHash'), 32) ||
    !fixed(option(value, 'entryChallengeCipher'), 48) ||
    !fixed(option(value, 'destinationChallengeCipher'), 48)
  )
    invalid()
  const encryptedHops = option(value, 'encryptedHops')
  if (length(encryptedHops) < 1 || length(encryptedHops) > MAX_ENCRYPTED_HOPS) invalid()
}

export function encodeCreate(value) {
  validateCreate(value)
  const encryptedHops = value.encryptedHops
  const output = allocate(CREATE_FIXED_SIZE + length(encryptedHops))
  let offset = 0
  output[offset++] = value.version
  put(output, value.circuitId, offset)
  offset += 16
  writeU64(output, value.epoch, offset)
  offset += 8
  for (const name of ['descriptorId', 'sourceEphemeralKey', 'safetyTranscriptHash']) {
    put(output, value[name], offset)
    offset += 32
  }
  put(output, value.entryChallengeCipher, offset)
  offset += 48
  put(output, value.destinationChallengeCipher, offset)
  offset += 48
  writeU16(output, length(encryptedHops), offset)
  offset += 2
  put(output, encryptedHops, offset)
  return output
}

export function decodeCreate(message) {
  const size = length(message)
  if (size < CREATE_FIXED_SIZE + 1 || size > CREATE_FIXED_SIZE + MAX_ENCRYPTED_HOPS) invalid()
  let offset = 0
  const value = { version: message[offset++] }
  let accepted = false
  try {
    value.circuitId = copy(slice(message, offset, offset + 16))
    offset += 16
    value.epoch = readU64(message, offset)
    offset += 8
    for (const name of ['descriptorId', 'sourceEphemeralKey', 'safetyTranscriptHash']) {
      value[name] = copy(slice(message, offset, offset + 32))
      offset += 32
    }
    value.entryChallengeCipher = copy(slice(message, offset, offset + 48))
    offset += 48
    value.destinationChallengeCipher = copy(slice(message, offset, offset + 48))
    offset += 48
    const encryptedSize = readU16(message, offset)
    offset += 2
    if (encryptedSize < 1 || encryptedSize > MAX_ENCRYPTED_HOPS || offset + encryptedSize !== size)
      invalid()
    value.encryptedHops = copy(slice(message, offset, size))
    validateCreate(value)
    accepted = true
    return value
  } finally {
    if (!accepted) clearTree(value)
  }
}

export function hashCreateBase(value) {
  validateCreate(value)
  const encryptedHash = hash([value.encryptedHops])
  const encoding = allocate(CREATE_BASE_SIZE)
  let offset = 0
  try {
    encoding[offset++] = value.version
    put(encoding, value.circuitId, offset)
    offset += 16
    writeU64(encoding, value.epoch, offset)
    offset += 8
    for (const field of [
      value.descriptorId,
      value.sourceEphemeralKey,
      value.safetyTranscriptHash,
      encryptedHash
    ]) {
      put(encoding, field, offset)
      offset += 32
    }
    return hash([DOMAIN.ACTIVATE_CREATE, encoding])
  } finally {
    clear(encryptedHash)
    clear(encoding)
  }
}

function validateEntryProof(value, withProof) {
  if (
    !safeObject(value) ||
    option(value, 'version') !== PROTOCOL_VERSION ||
    !fixed(option(value, 'circuitId'), 16) ||
    !u64(option(value, 'epoch')) ||
    !fixed(option(value, 'entryIdentity'), 32) ||
    !fixed(option(value, 'createHash'), 32) ||
    !fixed(option(value, 'entryChallengeHash'), 32) ||
    !u64(option(value, 'expiresAt'))
  )
    invalid()
  if (
    withProof &&
    (!fixed(option(value, 'possessionTag'), 16) || !fixed(option(value, 'identitySignature'), 64))
  )
    invalid()
}

function encodeEntryProofValue(value, withProof) {
  validateEntryProof(value, withProof)
  const output = allocate(withProof ? ENTRY_PROOF_SIZE : ENTRY_PROOF_UNSIGNED_SIZE)
  let offset = 0
  output[offset++] = value.version
  put(output, value.circuitId, offset)
  offset += 16
  writeU64(output, value.epoch, offset)
  offset += 8
  for (const name of ['entryIdentity', 'createHash', 'entryChallengeHash']) {
    put(output, value[name], offset)
    offset += 32
  }
  writeU64(output, value.expiresAt, offset)
  offset += 8
  if (withProof) {
    put(output, value.possessionTag, offset)
    offset += 16
    put(output, value.identitySignature, offset)
  }
  return output
}

function decodeEntryProofValue(message, withProof) {
  const expected = withProof ? ENTRY_PROOF_SIZE : ENTRY_PROOF_UNSIGNED_SIZE
  if (length(message) !== expected) invalid()
  let offset = 0
  const value = { version: message[offset++] }
  let accepted = false
  try {
    value.circuitId = copy(slice(message, offset, offset + 16))
    offset += 16
    value.epoch = readU64(message, offset)
    offset += 8
    for (const name of ['entryIdentity', 'createHash', 'entryChallengeHash']) {
      value[name] = copy(slice(message, offset, offset + 32))
      offset += 32
    }
    value.expiresAt = readU64(message, offset)
    offset += 8
    if (withProof) {
      value.possessionTag = copy(slice(message, offset, offset + 16))
      offset += 16
      value.identitySignature = copy(slice(message, offset, offset + 64))
    }
    validateEntryProof(value, withProof)
    accepted = true
    return value
  } finally {
    if (!accepted) clearTree(value)
  }
}

export function encodeEntryProofUnsigned(value) {
  return encodeEntryProofValue(value, false)
}
export function decodeEntryProofUnsigned(message) {
  return decodeEntryProofValue(message, false)
}
export function encodeEntryProof(value) {
  return encodeEntryProofValue(value, true)
}
export function decodeEntryProof(message) {
  return decodeEntryProofValue(message, true)
}

function activationNow(now) {
  let value
  try {
    value = now()
  } catch {
    invalid()
  }
  if (!Number.isSafeInteger(value) || value < 0) invalid()
  return BigInt(value)
}

function requireActivationLive(startedAt, current) {
  if (
    !Number.isSafeInteger(startedAt) ||
    startedAt < 0 ||
    startedAt > Number.MAX_SAFE_INTEGER - ACTIVATION_FRAGMENT_TIMEOUT
  )
    invalid()
  if (current < BigInt(startedAt) || current >= BigInt(startedAt + ACTIVATION_FRAGMENT_TIMEOUT)) {
    throw PrivateRouteError.ROUTE_UNAVAILABLE()
  }
}

function entryReplayKey(epoch, circuitId, createHash) {
  try {
    return `${epoch}:${b4a.toString(circuitId, 'hex')}:${b4a.toString(createHash, 'hex')}`
  } catch {
    invalid()
  }
}

export function createEntryReplayCache(options) {
  if (!safeObject(options) || typeof option(options, 'now') !== 'function') invalid()
  const configured = option(options, 'maxEntries')
  const maximum = configured === undefined ? MAX_ENTRY_REPLAYS : configured
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_ENTRY_REPLAYS) invalid()
  const state = { now: options.now, maximum, entries: new Map() }
  function prune(current) {
    for (const [key, expiry] of state.entries) if (expiry <= current) state.entries.delete(key)
  }
  const cache = Object.freeze({
    get size() {
      prune(activationNow(state.now))
      return state.entries.size
    },
    expire() {
      const before = state.entries.size
      prune(activationNow(state.now))
      return before !== state.entries.size
    }
  })
  ENTRY_REPLAY_STATES.set(cache, state)
  return cache
}

function createReplayCache(options, states) {
  if (!safeObject(options) || typeof option(options, 'now') !== 'function') invalid()
  const configured = option(options, 'maxEntries')
  const maximum = configured === undefined ? MAX_ENTRY_REPLAYS : configured
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_ENTRY_REPLAYS) invalid()
  const state = { now: options.now, maximum, entries: new Map() }
  const cache = Object.freeze({
    get size() {
      pruneEntryReplays(state, activationNow(state.now))
      return state.entries.size
    },
    expire() {
      const before = state.entries.size
      pruneEntryReplays(state, activationNow(state.now))
      return before !== state.entries.size
    }
  })
  states.set(cache, state)
  return cache
}

export function createDestinationReplayCache(options) {
  return createReplayCache(options, DESTINATION_REPLAY_STATES)
}

function replayState(cache) {
  const state = safeObject(cache) ? ENTRY_REPLAY_STATES.get(cache) : null
  if (!state) unauthorized()
  return state
}

function pruneEntryReplays(state, current) {
  for (const [key, expiry] of state.entries) if (expiry <= current) state.entries.delete(key)
}

function openActivationChallenge(sharedSecret, createBaseHash, cipher, role) {
  if (!fixed(cipher, 48)) invalid()
  const keys = activationKeys(sharedSecret, createBaseHash, role)
  const associatedData = b4a.concat([createBaseHash, b4a.from([role])])
  let challenge = null
  try {
    challenge = cryptoSuite.open({
      key: keys.forwardKey,
      noncePrefix: keys.forwardNoncePrefix,
      counter: 0n,
      associatedData,
      ciphertext: cipher
    })
    if (!fixed(challenge, 32)) unauthorized()
    return copy(challenge)
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    unauthorized()
  } finally {
    clearKeys(keys)
    clear(associatedData)
    clear(challenge)
  }
}

function agreement(secretKey, publicKey) {
  if (!fixed(secretKey, 32) || !fixed(publicKey, 32)) invalid()
  let shared = null
  try {
    shared = cryptoSuite.keyAgreement(secretKey, publicKey)
    if (!fixed(shared, 32)) unauthorized()
    return copy(shared)
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    unauthorized()
  } finally {
    clear(shared)
  }
}

export function createEntryProof(options) {
  if (
    !safeObject(options) ||
    length(option(options, 'create')) < 0 ||
    !fixed(option(options, 'entryIdentity'), 32) ||
    !fixed(option(options, 'entryIdentitySecretKey'), 64) ||
    !fixed(option(options, 'entryRouteEncryptionSecretKey'), 32) ||
    !fixed(option(options, 'expectedDescriptorId'), 32) ||
    !u64(option(options, 'expectedEpoch')) ||
    !fixed(option(options, 'expectedCircuitId'), 16) ||
    !u64(option(options, 'expiresAt')) ||
    !Number.isSafeInteger(option(options, 'startedAt')) ||
    typeof option(options, 'now') !== 'function'
  )
    invalid()
  if (roleForIdentity(options.entryIdentity) !== ROLE.PRIVATE) unauthorized()
  const state = replayState(option(options, 'replayCache'))
  const current = activationNow(options.now)
  requireActivationLive(options.startedAt, current)
  if (options.expiresAt <= current) throw PrivateRouteError.ROUTE_UNAVAILABLE()
  const create = decodeCreate(options.create)
  if (
    create.epoch !== options.expectedEpoch ||
    !same(create.circuitId, options.expectedCircuitId) ||
    !same(create.descriptorId, options.expectedDescriptorId)
  )
    unauthorized()
  let baseHash = null
  let createHash = null
  let shared = null
  let challenge = null
  let challengeHash = null
  let tag = null
  let unsignedEncoding = null
  let signatureInput = null
  try {
    baseHash = hashCreateBase(create)
    createHash = hash([options.create])
    pruneEntryReplays(state, current)
    const key = entryReplayKey(create.epoch, create.circuitId, createHash)
    if (state.entries.has(key)) replay()
    if (state.entries.size >= state.maximum) throw PrivateRouteError.CIRCUIT_LIMIT()
    shared = agreement(options.entryRouteEncryptionSecretKey, create.sourceEphemeralKey)
    challenge = openActivationChallenge(shared, baseHash, create.entryChallengeCipher, 0)
    challengeHash = hash([challenge])
    const unsigned = {
      version: PROTOCOL_VERSION,
      circuitId: create.circuitId,
      epoch: create.epoch,
      entryIdentity: options.entryIdentity,
      createHash,
      entryChallengeHash: challengeHash,
      expiresAt: options.expiresAt
    }
    tag = entryPossessionTag(shared, baseHash, challenge, createHash)
    unsignedEncoding = encodeEntryProofUnsigned(unsigned)
    signatureInput = b4a.concat([DOMAIN.ACTIVATE_ENTRY_PROOF, unsignedEncoding, tag])
    const identitySignature = sign(signatureInput, options.entryIdentitySecretKey)
    if (!verify(signatureInput, identitySignature, options.entryIdentity)) unauthorized()
    state.entries.set(key, options.expiresAt)
    return encodeEntryProof({ ...unsigned, possessionTag: tag, identitySignature })
  } finally {
    clear(baseHash)
    clear(createHash)
    clear(shared)
    clear(challenge)
    clear(challengeHash)
    clear(tag)
    clear(unsignedEncoding)
    clear(signatureInput)
  }
}

export function verifyEntryProof(options) {
  if (
    !safeObject(options) ||
    length(option(options, 'create')) < 0 ||
    length(option(options, 'proof')) < 0 ||
    !fixed(option(options, 'entryIdentity'), 32) ||
    !fixed(option(options, 'entryRouteEncryptionKey'), 32) ||
    !fixed(option(options, 'sourceEphemeralSecretKey'), 32) ||
    !fixed(option(options, 'entryChallenge'), 32) ||
    !u64(option(options, 'expiresAt')) ||
    !Number.isSafeInteger(option(options, 'startedAt')) ||
    typeof option(options, 'now') !== 'function'
  )
    invalid()
  if (roleForIdentity(options.entryIdentity) !== ROLE.PRIVATE) unauthorized()
  const current = activationNow(options.now)
  requireActivationLive(options.startedAt, current)
  const create = decodeCreate(options.create)
  const proof = decodeEntryProof(options.proof)
  if (
    proof.expiresAt !== options.expiresAt ||
    proof.expiresAt <= current ||
    proof.epoch !== create.epoch ||
    !same(proof.circuitId, create.circuitId) ||
    !same(proof.entryIdentity, options.entryIdentity)
  )
    unauthorized()
  let baseHash = null
  let createHash = null
  let challengeHash = null
  let unsigned = null
  let signatureInput = null
  let shared = null
  let expectedCipher = null
  let expectedTag = null
  try {
    baseHash = hashCreateBase(create)
    createHash = hash([options.create])
    challengeHash = hash([options.entryChallenge])
    if (!same(proof.createHash, createHash) || !same(proof.entryChallengeHash, challengeHash))
      unauthorized()
    unsigned = encodeEntryProofUnsigned(proof)
    signatureInput = b4a.concat([DOMAIN.ACTIVATE_ENTRY_PROOF, unsigned, proof.possessionTag])
    if (!verify(signatureInput, proof.identitySignature, options.entryIdentity)) unauthorized()
    shared = agreement(options.sourceEphemeralSecretKey, options.entryRouteEncryptionKey)
    expectedCipher = activationChallengeCipher(shared, baseHash, options.entryChallenge, 0)
    if (!same(expectedCipher, create.entryChallengeCipher)) unauthorized()
    expectedTag = entryPossessionTag(shared, baseHash, options.entryChallenge, createHash)
    if (!same(expectedTag, proof.possessionTag)) unauthorized()
    return proof
  } finally {
    clear(baseHash)
    clear(createHash)
    clear(challengeHash)
    clear(unsigned)
    clear(signatureInput)
    clear(shared)
    clear(expectedCipher)
    clear(expectedTag)
  }
}

function validateCreated(value, withProof) {
  if (
    !safeObject(value) ||
    option(value, 'version') !== PROTOCOL_VERSION ||
    !fixed(option(value, 'circuitId'), 16) ||
    !u64(option(value, 'epoch')) ||
    !fixed(option(value, 'descriptorId'), 32) ||
    !fixed(option(value, 'endpointIdentity'), 32) ||
    !fixed(option(value, 'compiledTranscriptHash'), 32) ||
    !fixed(option(value, 'parametersHash'), 32) ||
    !fixed(option(value, 'destinationChallengeHash'), 32) ||
    !fixed(option(value, 'entryProofHash'), 32) ||
    !u64(option(value, 'expiresAt'))
  )
    invalid()
  if (
    withProof &&
    (!fixed(option(value, 'possessionTag'), 16) || !fixed(option(value, 'routeSignature'), 64))
  )
    invalid()
}

function encodeCreatedValue(value, withProof) {
  validateCreated(value, withProof)
  const output = allocate(withProof ? CREATED_SIZE : CREATED_UNSIGNED_SIZE)
  let offset = 0
  output[offset++] = value.version
  put(output, value.circuitId, offset)
  offset += 16
  writeU64(output, value.epoch, offset)
  offset += 8
  for (const name of [
    'descriptorId',
    'endpointIdentity',
    'compiledTranscriptHash',
    'parametersHash',
    'destinationChallengeHash',
    'entryProofHash'
  ]) {
    put(output, value[name], offset)
    offset += 32
  }
  writeU64(output, value.expiresAt, offset)
  offset += 8
  if (withProof) {
    put(output, value.possessionTag, offset)
    offset += 16
    put(output, value.routeSignature, offset)
  }
  return output
}

function decodeCreatedValue(message, withProof) {
  const expected = withProof ? CREATED_SIZE : CREATED_UNSIGNED_SIZE
  if (length(message) !== expected) invalid()
  let offset = 0
  const value = { version: message[offset++] }
  let accepted = false
  try {
    value.circuitId = copy(slice(message, offset, offset + 16))
    offset += 16
    value.epoch = readU64(message, offset)
    offset += 8
    for (const name of [
      'descriptorId',
      'endpointIdentity',
      'compiledTranscriptHash',
      'parametersHash',
      'destinationChallengeHash',
      'entryProofHash'
    ]) {
      value[name] = copy(slice(message, offset, offset + 32))
      offset += 32
    }
    value.expiresAt = readU64(message, offset)
    offset += 8
    if (withProof) {
      value.possessionTag = copy(slice(message, offset, offset + 16))
      offset += 16
      value.routeSignature = copy(slice(message, offset, offset + 64))
    }
    validateCreated(value, withProof)
    accepted = true
    return value
  } finally {
    if (!accepted) clearTree(value)
  }
}

export function encodeCreatedUnsigned(value) {
  return encodeCreatedValue(value, false)
}
export function decodeCreatedUnsigned(message) {
  return decodeCreatedValue(message, false)
}
export function encodeCreated(value) {
  return encodeCreatedValue(value, true)
}
export function decodeCreated(message) {
  return decodeCreatedValue(message, true)
}

export function hashCompiledTranscript(value) {
  if (
    !safeObject(value) ||
    !fixed(option(value, 'safetyTranscriptHash'), 32) ||
    length(option(value, 'encryptedHops')) < 1 ||
    length(value.encryptedHops) > MAX_ENCRYPTED_HOPS ||
    length(option(value, 'entryProof')) !== ENTRY_PROOF_SIZE ||
    !fixed(option(value, 'sourceEphemeralKey'), 32) ||
    !fixed(option(value, 'circuitId'), 16) ||
    !u64(option(value, 'epoch'))
  )
    invalid()
  const encryptedHash = hash([value.encryptedHops])
  const entryProofHash = hash([value.entryProof])
  const epoch = allocate(8)
  try {
    writeU64(epoch, value.epoch, 0)
    return hash([
      DOMAIN.ACTIVATE_DESTINATION_PROOF,
      value.safetyTranscriptHash,
      encryptedHash,
      entryProofHash,
      value.sourceEphemeralKey,
      value.circuitId,
      epoch
    ])
  } finally {
    clear(encryptedHash)
    clear(entryProofHash)
    clear(epoch)
  }
}

function destinationReplayState(cache) {
  const state = safeObject(cache) ? DESTINATION_REPLAY_STATES.get(cache) : null
  if (!state) unauthorized()
  return state
}

function derivePayloadKeys(shared, compiledTranscriptHash) {
  const transcript = b4a.concat([DOMAIN.ROUTE_PAYLOAD, compiledTranscriptHash])
  let value = null
  try {
    value = cryptoSuite.deriveKeys(shared, transcript)
    if (
      !safeObject(value) ||
      !fixed(value.forwardKey, 32) ||
      !fixed(value.reverseKey, 32) ||
      !fixed(value.forwardNoncePrefix, 16) ||
      !fixed(value.reverseNoncePrefix, 16)
    )
      invalid()
    return {
      forwardKey: copy(value.forwardKey),
      reverseKey: copy(value.reverseKey),
      forwardNoncePrefix: copy(value.forwardNoncePrefix),
      reverseNoncePrefix: copy(value.reverseNoncePrefix)
    }
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    clear(transcript)
    if (value) {
      clear(value.forwardKey)
      clear(value.reverseKey)
      clear(value.forwardNoncePrefix)
      clear(value.reverseNoncePrefix)
    }
  }
}

export function createDestinationProof(options) {
  if (
    !safeObject(options) ||
    length(option(options, 'create')) < 0 ||
    length(option(options, 'entryProof')) !== ENTRY_PROOF_SIZE ||
    !fixed(option(options, 'endpointIdentity'), 32) ||
    !fixed(option(options, 'routeSigningKey'), 32) ||
    !fixed(option(options, 'routeSigningSecretKey'), 64) ||
    !fixed(option(options, 'destinationRouteEncryptionSecretKey'), 32) ||
    !fixed(option(options, 'expectedDescriptorId'), 32) ||
    !u64(option(options, 'expectedEpoch')) ||
    !fixed(option(options, 'expectedCircuitId'), 16) ||
    !safeObject(option(options, 'parameters')) ||
    !u64(option(options, 'expiresAt')) ||
    !Number.isSafeInteger(option(options, 'startedAt')) ||
    typeof option(options, 'now') !== 'function'
  )
    invalid()
  const state = destinationReplayState(option(options, 'replayCache'))
  const current = activationNow(options.now)
  requireActivationLive(options.startedAt, current)
  if (options.expiresAt <= current) throw PrivateRouteError.ROUTE_UNAVAILABLE()
  const create = decodeCreate(options.create)
  if (
    create.epoch !== options.expectedEpoch ||
    !same(create.circuitId, options.expectedCircuitId) ||
    !same(create.descriptorId, options.expectedDescriptorId)
  )
    unauthorized()
  let baseHash = null
  let createHash = null
  let compiledHash = null
  let parametersHash = null
  let entryProofHash = null
  let shared = null
  let challenge = null
  let challengeHash = null
  let tag = null
  let unsignedEncoding = null
  let signatureInput = null
  try {
    baseHash = hashCreateBase(create)
    createHash = hash([options.create])
    compiledHash = hashCompiledTranscript({
      safetyTranscriptHash: create.safetyTranscriptHash,
      encryptedHops: create.encryptedHops,
      entryProof: options.entryProof,
      sourceEphemeralKey: create.sourceEphemeralKey,
      circuitId: create.circuitId,
      epoch: create.epoch
    })
    parametersHash = hashActivationParameters(options.parameters)
    entryProofHash = hash([options.entryProof])
    pruneEntryReplays(state, current)
    const key = entryReplayKey(create.epoch, create.circuitId, createHash)
    if (state.entries.has(key)) replay()
    if (state.entries.size >= state.maximum) throw PrivateRouteError.CIRCUIT_LIMIT()
    shared = agreement(options.destinationRouteEncryptionSecretKey, create.sourceEphemeralKey)
    challenge = openActivationChallenge(shared, baseHash, create.destinationChallengeCipher, 1)
    challengeHash = hash([challenge])
    const unsigned = {
      version: PROTOCOL_VERSION,
      circuitId: create.circuitId,
      epoch: create.epoch,
      descriptorId: create.descriptorId,
      endpointIdentity: options.endpointIdentity,
      compiledTranscriptHash: compiledHash,
      parametersHash,
      destinationChallengeHash: challengeHash,
      entryProofHash,
      expiresAt: options.expiresAt
    }
    tag = destinationPossessionTag(shared, baseHash, challenge, compiledHash, parametersHash)
    unsignedEncoding = encodeCreatedUnsigned(unsigned)
    signatureInput = b4a.concat([DOMAIN.ACTIVATE_DESTINATION_PROOF, unsignedEncoding, tag])
    const routeSignature = sign(signatureInput, options.routeSigningSecretKey)
    if (!verify(signatureInput, routeSignature, options.routeSigningKey)) unauthorized()
    state.entries.set(key, options.expiresAt)
    return encodeCreated({ ...unsigned, possessionTag: tag, routeSignature })
  } finally {
    clear(baseHash)
    clear(createHash)
    clear(compiledHash)
    clear(parametersHash)
    clear(entryProofHash)
    clear(shared)
    clear(challenge)
    clear(challengeHash)
    clear(tag)
    clear(unsignedEncoding)
    clear(signatureInput)
  }
}

export function verifyDestinationProof(options) {
  if (
    !safeObject(options) ||
    length(option(options, 'create')) < 0 ||
    length(option(options, 'entryProof')) !== ENTRY_PROOF_SIZE ||
    length(option(options, 'created')) !== CREATED_SIZE ||
    !fixed(option(options, 'endpointIdentity'), 32) ||
    !fixed(option(options, 'routeSigningKey'), 32) ||
    !fixed(option(options, 'destinationRouteEncryptionKey'), 32) ||
    !fixed(option(options, 'sourceEphemeralSecretKey'), 32) ||
    !fixed(option(options, 'destinationChallenge'), 32) ||
    !safeObject(option(options, 'parameters')) ||
    !u64(option(options, 'expiresAt')) ||
    !Number.isSafeInteger(option(options, 'startedAt')) ||
    typeof option(options, 'now') !== 'function'
  )
    invalid()
  const sourceReplay = destinationReplayState(option(options, 'replayCache'))
  const current = activationNow(options.now)
  requireActivationLive(options.startedAt, current)
  const create = decodeCreate(options.create)
  const created = decodeCreated(options.created)
  if (
    created.expiresAt !== options.expiresAt ||
    created.expiresAt <= current ||
    created.epoch !== create.epoch ||
    !same(created.circuitId, create.circuitId) ||
    !same(created.descriptorId, create.descriptorId) ||
    !same(created.endpointIdentity, options.endpointIdentity)
  )
    unauthorized()
  let baseHash = null
  let createHash = null
  let compiledHash = null
  let parametersHash = null
  let challengeHash = null
  let entryProofHash = null
  let unsigned = null
  let signatureInput = null
  let shared = null
  let expectedCipher = null
  let expectedTag = null
  try {
    baseHash = hashCreateBase(create)
    createHash = hash([options.create])
    compiledHash = hashCompiledTranscript({
      safetyTranscriptHash: create.safetyTranscriptHash,
      encryptedHops: create.encryptedHops,
      entryProof: options.entryProof,
      sourceEphemeralKey: create.sourceEphemeralKey,
      circuitId: create.circuitId,
      epoch: create.epoch
    })
    parametersHash = hashActivationParameters(options.parameters)
    challengeHash = hash([options.destinationChallenge])
    entryProofHash = hash([options.entryProof])
    if (
      !same(created.compiledTranscriptHash, compiledHash) ||
      !same(created.parametersHash, parametersHash) ||
      !same(created.destinationChallengeHash, challengeHash) ||
      !same(created.entryProofHash, entryProofHash)
    )
      unauthorized()
    unsigned = encodeCreatedUnsigned(created)
    signatureInput = b4a.concat([
      DOMAIN.ACTIVATE_DESTINATION_PROOF,
      unsigned,
      created.possessionTag
    ])
    if (!verify(signatureInput, created.routeSignature, options.routeSigningKey)) unauthorized()
    shared = agreement(options.sourceEphemeralSecretKey, options.destinationRouteEncryptionKey)
    expectedCipher = activationChallengeCipher(shared, baseHash, options.destinationChallenge, 1)
    if (!same(expectedCipher, create.destinationChallengeCipher)) unauthorized()
    expectedTag = destinationPossessionTag(
      shared,
      baseHash,
      options.destinationChallenge,
      compiledHash,
      parametersHash
    )
    if (!same(expectedTag, created.possessionTag)) unauthorized()
    pruneEntryReplays(sourceReplay, current)
    const replayKey = entryReplayKey(create.epoch, create.circuitId, createHash)
    if (sourceReplay.entries.has(replayKey)) replay()
    if (sourceReplay.entries.size >= sourceReplay.maximum) throw PrivateRouteError.CIRCUIT_LIMIT()
    sourceReplay.entries.set(replayKey, created.expiresAt)
    return Object.freeze({
      created,
      payloadKeys: Object.freeze(derivePayloadKeys(shared, compiledHash))
    })
  } finally {
    clear(baseHash)
    clear(createHash)
    clear(compiledHash)
    clear(parametersHash)
    clear(challengeHash)
    clear(entryProofHash)
    clear(unsigned)
    clear(signatureInput)
    clear(shared)
    clear(expectedCipher)
    clear(expectedTag)
  }
}

function activationKeys(sharedSecret, createBaseHash, role) {
  if (!fixed(sharedSecret, 32) || !fixed(createBaseHash, 32) || (role !== 0 && role !== 1))
    invalid()
  const transcript = b4a.concat([DOMAIN.ACTIVATE_CHALLENGE, createBaseHash, b4a.from([role])])
  try {
    return cryptoSuite.deriveKeys(sharedSecret, transcript)
  } catch {
    invalid()
  } finally {
    clear(transcript)
  }
}

function clearKeys(keys) {
  if (!keys) return
  clear(keys.forwardKey)
  clear(keys.reverseKey)
  clear(keys.forwardNoncePrefix)
  clear(keys.reverseNoncePrefix)
}

export function activationChallengeCipher(sharedSecret, createBaseHash, challenge, role) {
  if (!fixed(challenge, 32)) invalid()
  const keys = activationKeys(sharedSecret, createBaseHash, role)
  const associatedData = b4a.concat([createBaseHash, b4a.from([role])])
  try {
    const output = cryptoSuite.seal({
      key: keys.forwardKey,
      noncePrefix: keys.forwardNoncePrefix,
      counter: 0n,
      associatedData,
      plaintext: challenge
    })
    if (!fixed(output, 48)) invalid()
    return copy(output)
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    clearKeys(keys)
    clear(associatedData)
  }
}

export function entryPossessionTag(sharedSecret, createBaseHash, challenge, createHash) {
  if (!fixed(challenge, 32) || !fixed(createHash, 32)) invalid()
  const keys = activationKeys(sharedSecret, createBaseHash, 0)
  const challengeHash = hash([challenge])
  const associatedData = b4a.concat([challengeHash, createHash])
  try {
    const output = cryptoSuite.seal({
      key: keys.reverseKey,
      noncePrefix: keys.reverseNoncePrefix,
      counter: 1n,
      associatedData,
      plaintext: b4a.alloc(0)
    })
    if (!fixed(output, 16)) invalid()
    return copy(output)
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    clearKeys(keys)
    clear(challengeHash)
    clear(associatedData)
  }
}

export function destinationPossessionTag(
  sharedSecret,
  createBaseHash,
  challenge,
  compiledTranscriptHash,
  parametersHash
) {
  if (!fixed(challenge, 32) || !fixed(compiledTranscriptHash, 32) || !fixed(parametersHash, 32))
    invalid()
  const keys = activationKeys(sharedSecret, createBaseHash, 1)
  const challengeHash = hash([challenge])
  const associatedData = b4a.concat([challengeHash, compiledTranscriptHash, parametersHash])
  try {
    const output = cryptoSuite.seal({
      key: keys.reverseKey,
      noncePrefix: keys.reverseNoncePrefix,
      counter: 1n,
      associatedData,
      plaintext: b4a.alloc(0)
    })
    if (!fixed(output, 16)) invalid()
    return copy(output)
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    clearKeys(keys)
    clear(challengeHash)
    clear(associatedData)
  }
}

export function encodeActivationParameters(value) {
  if (!safeObject(value)) invalid()
  const fields16 = [
    'cellSize',
    'routeFrameSize',
    'maxCellPayload',
    'maxRoutePayload',
    'counterWindow'
  ]
  const fields8 = ['safetyMin', 'safetyMax', 'privateMin', 'privateMax']
  if (
    value.version !== PROTOCOL_VERSION ||
    !Number.isInteger(value.capabilities) ||
    value.capabilities < 0 ||
    value.capabilities > 0xffff_ffff
  )
    invalid()
  for (const name of fields16)
    if (!Number.isInteger(value[name]) || value[name] < 0 || value[name] > 0xffff) invalid()
  for (const name of fields8)
    if (!Number.isInteger(value[name]) || value[name] < 0 || value[name] > 0xff) invalid()
  const output = allocate(19)
  let offset = 0
  output[offset++] = value.version
  for (const name of fields16.slice(0, 4)) {
    writeU16(output, value[name], offset)
    offset += 2
  }
  output[offset++] = value.capabilities >>> 24
  output[offset++] = value.capabilities >>> 16
  output[offset++] = value.capabilities >>> 8
  output[offset++] = value.capabilities
  for (const name of fields8) output[offset++] = value[name]
  writeU16(output, value.counterWindow, offset)
  return output
}

export function decodeActivationParameters(value) {
  if (!fixed(value, ACTIVATION_PARAMETERS_SIZE)) invalid()
  let offset = 0
  const parameters = {
    version: value[offset++],
    cellSize: readU16(value, offset),
    routeFrameSize: readU16(value, offset + 2),
    maxCellPayload: readU16(value, offset + 4),
    maxRoutePayload: readU16(value, offset + 6)
  }
  offset += 8
  parameters.capabilities =
    value[offset] * 0x1000000 +
    value[offset + 1] * 0x10000 +
    value[offset + 2] * 0x100 +
    value[offset + 3]
  offset += 4
  parameters.safetyMin = value[offset++]
  parameters.safetyMax = value[offset++]
  parameters.privateMin = value[offset++]
  parameters.privateMax = value[offset++]
  parameters.counterWindow = readU16(value, offset)
  const canonical = encodeActivationParameters(parameters)
  try {
    if (!same(canonical, value)) invalid()
  } finally {
    clear(canonical)
  }
  return Object.freeze(parameters)
}

export function hashActivationParameters(value) {
  const encoding = encodeActivationParameters(value)
  try {
    return hash([DOMAIN.ACTIVATE_PARAMETERS, encoding])
  } finally {
    clear(encoding)
  }
}

export function activateRegisteredRoute(options) {
  if (
    !safeObject(options) ||
    !Array.isArray(options.registries) ||
    options.registries.length < 1 ||
    options.registries.length > MAX_PRIVATE_HOPS ||
    length(options.encryptedHops) < 1 ||
    length(options.encryptedHops) > MAX_ENCRYPTED_HOPS ||
    !fixed(options.descriptorId, 32) ||
    !u64(options.epoch) ||
    !u64(options.expiresAt) ||
    !fixed(options.sourceEphemeralKey, 32) ||
    !fixed(options.sourceCircuitId, 16) ||
    !fixed(options.destinationIdentity, 32) ||
    !fixed(options.destinationIdentitySecretKey, 64) ||
    typeof options.now !== 'function' ||
    typeof options.randomBytes !== 'function'
  )
    invalid()
  const observe = option(options, TEST_ONLY_ACTIVATION_OBSERVER)
  if (observe !== undefined && typeof observe !== 'function') invalid()
  const states = options.registries.map((registry) => REGISTRY_STATES.get(registry))
  if (states.some((state) => !state)) invalid()
  let now
  try {
    now = options.now()
  } catch {
    invalid()
  }
  if (!Number.isSafeInteger(now) || now < 0) invalid()
  const current = BigInt(now)
  const ticketStates = new Map()
  const authority = createLinkSetupAuthority({
    now: () => now,
    randomBytes: options.randomBytes,
    [TEST_ONLY_TICKET_OBSERVER](ticket, state) {
      ticketStates.set(ticket, state)
    }
  })
  const safetyIdentity = cryptoSuite.keyPair(options.randomBytes(32))
  const safetyEncryption = cryptoSuite.encryptionKeyPair(options.randomBytes(32))
  const endpointEncryption = cryptoSuite.encryptionKeyPair(options.randomBytes(32))
  const nodes = [
    {
      identity: safetyIdentity.publicKey,
      identitySecretKey: safetyIdentity.secretKey,
      routeEncryptionPublicKey: safetyEncryption.publicKey,
      routeEncryptionSecretKey: safetyEncryption.secretKey
    },
    ...states,
    {
      identity: options.destinationIdentity,
      identitySecretKey: options.destinationIdentitySecretKey,
      routeEncryptionPublicKey: endpointEncryption.publicKey,
      routeEncryptionSecretKey: endpointEncryption.secretKey
    }
  ]
  const links = []
  const services = []
  const bindings = []
  const receivers = []
  const pending = []
  const packetHashes = []
  const counterIds = new WeakMap()
  let nextCounterId = 0
  let sourceLink = null
  let destinationLink = null
  let destinationReceiver = null
  let destinationReached = false
  let reverseResult = null
  let routeState = 'create'

  function enqueue(index, from, packet) {
    pending.push({ index, from: copy(from), packet: copy(packet) })
  }
  function pump() {
    while (pending.length) {
      const delivery = pending.shift()
      try {
        services[delivery.index].receive(delivery.from, delivery.packet)
      } finally {
        clear(delivery.from)
        clear(delivery.packet)
      }
    }
  }
  function destroy() {
    if (routeState === 'destroyed') return
    routeState = 'destroyed'
    for (let index = services.length - 1; index >= 0; index--) {
      try {
        services[index].destroy(bindings[index].peer, bindings[index].localId)
      } catch {}
    }
    if (sourceLink) sourceLink.destroy()
    if (destinationLink) destinationLink.destroy()
    for (const receiver of receivers) receiver.destroy()
    if (destinationReceiver) destinationReceiver.destroy()
    for (const delivery of pending) {
      clear(delivery.from)
      clear(delivery.packet)
    }
    pending.length = 0
  }

  try {
    for (let index = 0; index < nodes.length - 1; index++) {
      const initiator = nodes[index]
      const responder = nodes[index + 1]
      const common = {
        circuitId: options.sourceCircuitId,
        epoch: options.epoch,
        initiatorIdentity: initiator.identity,
        responderIdentity: responder.identity,
        initiatorLocalId: options.randomBytes(16),
        responderLocalId: options.randomBytes(16),
        expiresAt: options.expiresAt
      }
      const started = authority.initiate({
        ...common,
        responderStaticKey: responder.routeEncryptionPublicKey,
        initiatorIdentitySecretKey: initiator.identitySecretKey
      })
      const accepted = authority.respond(started.message, {
        ...common,
        responderStaticSecretKey: responder.routeEncryptionSecretKey,
        responderIdentitySecretKey: responder.identitySecretKey
      })
      links.push({
        common,
        initiatorTicket: authority.complete(started.pending, accepted.message),
        responderTicket: accepted.ticket
      })
    }
    for (let index = 0; index < states.length; index++) {
      const receiver = new ActivationReassembler({ now: () => now })
      receivers.push(receiver)
      const service = new RelayService({
        identity: states[index].identity,
        ticketChecker: authority.checker,
        crypto: cryptoSuite,
        now: () => now,
        padding: (size) => b4a.alloc(size),
        send(peer, packet) {
          if (same(peer, nodes[index].identity)) {
            if (index === 0) {
              const opened = sourceLink.open(CELL_CLASS.STREAM, DIRECTION.REVERSE, packet)
              const frame = Array.isArray(opened) ? opened[0] : opened
              if (frame) {
                const size = readU16(frame, 0)
                reverseResult = copy(slice(frame, 2, 2 + size))
                clear(frame)
              }
              return true
            }
            enqueue(index - 1, states[index].identity, packet)
            return true
          }
          if (!same(peer, nodes[index + 2].identity)) invalid()
          if (index + 1 < services.length) {
            enqueue(index + 1, states[index].identity, packet)
            return true
          }
          const opened = destinationLink.openControl(packet, DIRECTION.FORWARD)
          for (const fragment of opened) {
            try {
              if (destinationReceiver.pushAuthenticated(fragment)) destinationReached = true
            } finally {
              clear(fragment)
            }
          }
          return true
        },
        onControl(event) {
          const layer = receiver.pushAuthenticated(event.payload)
          if (!layer) return true
          let plaintext = null
          try {
            plaintext = openTemplate(
              layer,
              states[index].routeEncryptionPublicKey,
              states[index].routeEncryptionSecretKey
            )
            const template = decodePrivateTemplate(plaintext)
            states[index].prune(current)
            if (
              !same(template.descriptorId, options.descriptorId) ||
              template.epoch !== options.epoch ||
              template.expiresAt !== options.expiresAt ||
              template.expiresAt <= current ||
              !same(template.relayIdentity, states[index].identity)
            )
              unauthorized()
            const record = states[index].records.get(registrationKey(template))
            if (
              !record ||
              !same(record.commitment, hash([layer])) ||
              !same(record.nextCommitment, hash([template.nextLayer]))
            )
              unauthorized()
            const replayKey = `${registrationKey(template)}:${b4a.toString(options.sourceEphemeralKey, 'hex')}:${b4a.toString(options.sourceCircuitId, 'hex')}`
            if (states[index].activations.has(replayKey)) replay()
            if (states[index].activations.size >= 128) throw PrivateRouteError.CIRCUIT_LIMIT()
            states[index].activations.set(replayKey, template.expiresAt)
            if (index + 1 < states.length) {
              const next = decodeRelayAdvertisement(template.nextAdvertisement)
              if (!same(next.identityKey, states[index + 1].identity)) unauthorized()
            } else if (
              length(template.nextAdvertisement) !== 0 ||
              length(template.nextLayer) !== PRIVATE_FINAL_TOKEN_SIZE
            )
              unauthorized()
            const id = options.randomBytes(16)
            id[0] = 0xa0 + index
            event.forward(fragmentActivation(template.nextLayer, { messageId: id }))
            if (observe) {
              const contextHashes = []
              const counters = []
              for (const ticket of [
                links[index].responderTicket,
                links[index + 1].initiatorTicket
              ]) {
                const observedTicket = ticketStates.get(ticket)
                for (const pair of Object.values(observedTicket.contexts)) {
                  for (const context of [pair.tx, pair.rx]) {
                    const digest = hash([context.key, context.noncePrefix])
                    contextHashes.push(b4a.toString(digest, 'hex'))
                    clear(digest)
                    if (!counterIds.has(context.counter))
                      counterIds.set(context.counter, ++nextCounterId)
                    counters.push(counterIds.get(context.counter))
                  }
                }
              }
              observePassively(
                observe,
                Object.freeze({
                  phase: 'activation',
                  circuitId: b4a.toString(options.sourceCircuitId, 'hex'),
                  relayIdentity: b4a.toString(states[index].identity, 'hex'),
                  adjacent: Object.freeze([
                    b4a.toString(nodes[index].identity, 'hex'),
                    b4a.toString(nodes[index + 2].identity, 'hex')
                  ]),
                  localIds: Object.freeze([
                    b4a.toString(links[index].common.responderLocalId, 'hex'),
                    b4a.toString(links[index + 1].common.initiatorLocalId, 'hex')
                  ]),
                  contextHashes: Object.freeze(contextHashes),
                  counterIds: Object.freeze(counters),
                  decryptCount: 1
                })
              )
            }
          } finally {
            clear(layer)
            clear(plaintext)
          }
          return true
        },
        [TEST_ONLY_RELAY_OBSERVER](event) {
          if (event.type !== 'forward' || event.class !== CELL_CLASS.STREAM) return
          const value = b4a.toString(event.beforeHash, 'hex')
          packetHashes.push(value)
          if (observe)
            observePassively(
              observe,
              Object.freeze({
                phase: 'packet',
                relayIdentity: b4a.toString(states[index].identity, 'hex'),
                frameHash: value
              })
            )
        }
      })
      service.install(links[index].responderTicket, links[index + 1].initiatorTicket)
      services.push(service)
      bindings.push({ peer: nodes[index].identity, localId: links[index].common.responderLocalId })
    }
    sourceLink = endpointLink(authority.checker, links[0].initiatorTicket)
    destinationLink = endpointLink(authority.checker, links[links.length - 1].responderTicket)
    destinationReceiver = new ActivationReassembler({ now: () => now })
    const startId = options.randomBytes(16)
    for (const fragment of fragmentActivation(options.encryptedHops, { messageId: startId })) {
      services[0].receive(safetyIdentity.publicKey, sourceLink.sealControl(fragment))
      pump()
    }
    if (!destinationReached) throw PrivateRouteError.ROUTE_UNAVAILABLE()
    for (let index = 0; index < services.length; index++) {
      services[index].created(bindings[index].peer, bindings[index].localId)
      services[index].open(bindings[index].peer, bindings[index].localId)
    }
    routeState = 'open'
    return Object.freeze({
      get state() {
        return routeState
      },
      testReverse(value) {
        if (routeState !== 'open' || length(value) < 0 || length(value) > 1098)
          throw PrivateRouteError.CIRCUIT_STATE()
        const frame = b4a.alloc(1100)
        writeU16(frame, length(value), 0)
        put(frame, value, 2)
        reverseResult = null
        services[services.length - 1].receive(
          options.destinationIdentity,
          destinationLink.seal(CELL_CLASS.STREAM, DIRECTION.REVERSE, frame)
        )
        pump()
        clear(frame)
        if (!reverseResult || packetHashes.length < services.length)
          throw PrivateRouteError.ROUTE_UNAVAILABLE()
        const result = reverseResult
        reverseResult = null
        return result
      },
      destroy
    })
  } catch (err) {
    destroy()
    throw err
  } finally {
    clear(safetyIdentity.secretKey)
    clear(safetyEncryption.secretKey)
    clear(endpointEncryption.secretKey)
    for (const state of ticketStates.values()) clearTree(state)
  }
}
