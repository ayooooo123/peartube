import b4a from 'b4a'
import sodium from 'sodium-universal'

import { cryptoSuite } from './crypto-suite.js'
import { PrivateRouteError } from './errors.js'
import { EXIT_ORIGIN_SERVICE_POLICY } from './final-exit.js'
import {
  CAPACITY_CLASS,
  BRANCH_CLASS,
  M3_MESSAGE_ID,
  M3_PROTOCOL_VERSION,
  ROLE,
  RELAY_CAPABILITY,
  decodeM3Object,
  encodeM3Object,
  roleForIdentity
} from './protocol.js'

export const CAPABILITY_ADVERTISEMENT_FIXED_BODY = 188
export const CAPABILITY_ADVERTISEMENT_MIN_BYTES = 260
export const CAPABILITY_ADVERTISEMENT_MAX_BYTES = 548
export const MAX_CAPABILITY_ADVERTISEMENTS = 8
export const MAX_CAPABILITY_LIFETIME = 1_800_000n
export const ACTIVE_CHALLENGE_TIMEOUT = 5_000n

const MAX_ROUTE_KEY_HISTORY = 16
const CAPS_COOKIE_LIFETIME = 5_000n
const CAPS_COOKIE_ROTATION = 300_000n
const MAX_CAPS_BINDINGS = 4_096

const CAPABILITY_DOMAIN = b4a.from('hyperdht-private-routes/m3/capability-advertisement/v1')
const CAPABILITY_DIGEST_DOMAIN = b4a.from(
  'hyperdht-private-routes/m3/capability-advertisement-digest/v1'
)
const ACTIVE_RESPONSE_DOMAIN = b4a.from('hyperdht-private-routes/m3/active-challenge-response/v1')
const ACTIVE_PROOF_DOMAIN = b4a.from(
  'hyperdht-private-routes/m3/active-challenge/route-key-proof/v1'
)
const CAPS_COOKIE_DOMAIN = b4a.from('hyperdht-private-routes/m3/caps-return-cookie/v1')
const KNOWN_CAPABILITY_MASK = 7
const MAX_U32 = 0xffff_ffff
const MAX_U64 = 0xffff_ffff_ffff_ffffn
const X25519_CHECK_SECRET = b4a.alloc(32, 0x5a)

const byteLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const setIntrinsic = Uint8Array.prototype.set
const subarrayIntrinsic = Uint8Array.prototype.subarray
const fillIntrinsic = Uint8Array.prototype.fill

function incompatible() {
  throw PrivateRouteError.ERR_INCOMPATIBLE_RELAY()
}

function authentication() {
  throw PrivateRouteError.ERR_AUTHENTICATION()
}

function replay() {
  throw PrivateRouteError.ERR_REPLAY()
}

function option(value, name) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) incompatible()
    return value[name]
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    incompatible()
  }
}

function length(value) {
  try {
    return b4a.isBuffer(value) ? byteLengthGetter.call(value) : -1
  } catch {
    return -1
  }
}

function nonzero(value) {
  if (length(value) < 1) return false
  for (const byte of value) if (byte !== 0) return true
  return false
}

function set(target, source, offset = 0) {
  try {
    setIntrinsic.call(target, source, offset)
  } catch {
    incompatible()
  }
}

function subarray(value, start, end) {
  try {
    return subarrayIntrinsic.call(value, start, end)
  } catch {
    incompatible()
  }
}

function copy(value, expected = null) {
  const size = length(value)
  if (size < 0 || (expected !== null && size !== expected)) incompatible()
  const output = b4a.allocUnsafeSlow(size)
  set(output, value)
  return output
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) fillIntrinsic.call(value, 0)
  } catch {
    // Best-effort zeroization.
  }
}

function clearHistory(history) {
  clear(history.encoded)
  for (const key of history.routeEncryptionPublicKeys) clear(key)
}

function appendRouteKey(history, key) {
  if (history.routeEncryptionPublicKeys.some((known) => equal(known, key))) return true
  if (history.routeEncryptionPublicKeys.length === MAX_ROUTE_KEY_HISTORY) {
    history.poisoned = true
    return false
  }
  history.routeEncryptionPublicKeys.push(copy(key, 32))
  return true
}

function abortBoundary() {
  const listeners = new Set()
  const signal = {
    aborted: false,
    addEventListener(name, listener) {
      if (name === 'abort' && typeof listener === 'function') listeners.add(listener)
    },
    removeEventListener(name, listener) {
      if (name === 'abort') listeners.delete(listener)
    }
  }
  return {
    signal,
    abort() {
      if (signal.aborted) return
      signal.aborted = true
      for (const listener of listeners) {
        try {
          listener()
        } catch {}
      }
      listeners.clear()
    }
  }
}

function unrefTimer(timer) {
  try {
    if (timer && typeof timer.unref === 'function') timer.unref()
  } catch {}
}

function uint16(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff
}

function uint32(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_U32
}

function uint64(value) {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_U64
}

function writeUint16(output, value, offset) {
  output[offset] = value >>> 8
  output[offset + 1] = value
}

function writeUint32(output, value, offset) {
  output[offset] = value >>> 24
  output[offset + 1] = value >>> 16
  output[offset + 2] = value >>> 8
  output[offset + 3] = value
}

function writeUint64(output, value, offset) {
  for (let index = offset + 7; index >= offset; index--) {
    output[index] = Number(value & 0xffn)
    value >>= 8n
  }
}

function readUint16(input, offset) {
  return (input[offset] << 8) | input[offset + 1]
}

function readUint32(input, offset) {
  return (
    input[offset] * 0x1000000 +
    (input[offset + 1] << 16) +
    (input[offset + 2] << 8) +
    input[offset + 3]
  )
}

function readUint64(input, offset) {
  let value = 0n
  for (let index = offset; index < offset + 8; index++) {
    value = (value << 8n) | BigInt(input[index])
  }
  return value
}

function equal(left, right) {
  try {
    return length(left) === length(right) && b4a.equals(left, right)
  } catch {
    return false
  }
}

function signatureInput(domain, messageId, body) {
  const output = b4a.allocUnsafe(2 + domain.byteLength + 8 + body.byteLength)
  writeUint16(output, domain.byteLength, 0)
  set(output, domain, 2)
  writeUint32(output, M3_PROTOCOL_VERSION, 2 + domain.byteLength)
  writeUint16(output, messageId, 6 + domain.byteLength)
  writeUint16(output, body.byteLength, 8 + domain.byteLength)
  set(output, body, 10 + domain.byteLength)
  return output
}

function digest(parts) {
  return cryptoSuite.hash(parts)
}

function keyedHash(key, parts) {
  const output = b4a.allocUnsafeSlow(32)
  const input = b4a.concat(parts)
  try {
    sodium.crypto_generichash(output, input, key)
    return output
  } finally {
    clear(input)
  }
}

export function encodeCanonicalEndpoint(value) {
  const family = option(value, 'addressFamily')
  const address = option(value, 'addressBytes')
  const port = option(value, 'port')
  if ((family !== 4 && family !== 6) || !uint16(port) || port === 0) incompatible()
  const expected = family === 4 ? 4 : 16
  if (length(address) !== expected) incompatible()
  const output = b4a.alloc(19)
  output[0] = family
  if (family === 4) set(output, address, 13)
  else set(output, address, 1)
  writeUint16(output, port, 17)
  return output
}

export function decodeCanonicalEndpoint(encoded) {
  const value = copy(encoded, 19)
  const family = value[0]
  if (family !== 4 && family !== 6) incompatible()
  if (readUint16(value, 17) === 0) incompatible()
  if (family === 4) {
    for (let index = 1; index < 13; index++) if (value[index] !== 0) incompatible()
  } else if (
    value[1] === 0 &&
    value[2] === 0 &&
    value[3] === 0 &&
    value[4] === 0 &&
    value[5] === 0 &&
    value[6] === 0 &&
    value[7] === 0 &&
    value[8] === 0 &&
    value[9] === 0 &&
    value[10] === 0 &&
    value[11] === 0xff &&
    value[12] === 0xff
  ) {
    incompatible()
  }
  return value
}

export function deriveM3DhtNodeId(reachableEndpoint) {
  const endpoint = decodeCanonicalEndpoint(reachableEndpoint)
  if (endpoint[0] !== 4) incompatible()
  const compact = b4a.allocUnsafe(6)
  set(compact, subarray(endpoint, 13, 17))
  compact[4] = endpoint[18]
  compact[5] = endpoint[17]
  const output = b4a.allocUnsafeSlow(32)
  try {
    sodium.crypto_generichash(output, compact)
    return output
  } finally {
    clear(compact)
    clear(endpoint)
  }
}

function copyPolicyEntry(entry) {
  return Object.freeze({ ...entry })
}

export function providerServicePolicyForCapabilities(capabilityMask) {
  if (!uint32(capabilityMask) || capabilityMask === 0 || capabilityMask & ~KNOWN_CAPABILITY_MASK) {
    incompatible()
  }
  if (
    capabilityMask & RELAY_CAPABILITY.DHT_EXIT_V1 &&
    !(capabilityMask & RELAY_CAPABILITY.CIRCUIT_RELAY_V1)
  ) {
    incompatible()
  }
  const entries = []
  if (capabilityMask & RELAY_CAPABILITY.DHT_EXIT_V1) {
    for (let index = 0; index < 4; index++)
      entries.push(copyPolicyEntry(EXIT_ORIGIN_SERVICE_POLICY[index]))
  }
  if (capabilityMask & RELAY_CAPABILITY.PRIVATE_RECORDS_V1) {
    for (let index = 4; index < 9; index++)
      entries.push(copyPolicyEntry(EXIT_ORIGIN_SERVICE_POLICY[index]))
  }
  return Object.freeze(entries)
}

function exactPolicyEntries(actual, capabilityMask) {
  if (!Array.isArray(actual)) incompatible()
  const expected = providerServicePolicyForCapabilities(capabilityMask)
  if (actual.length !== expected.length) incompatible()
  for (let index = 0; index < expected.length; index++) {
    const entry = actual[index]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) incompatible()
    for (const [name, value] of Object.entries(expected[index])) {
      if (option(entry, name) !== value) incompatible()
    }
  }
  return expected
}

function validateRoutePublicKey(value) {
  const key = copy(value, 32)
  let shared = null
  try {
    shared = cryptoSuite.keyAgreement(X25519_CHECK_SECRET, key)
    return key
  } catch {
    incompatible()
  } finally {
    clear(shared)
  }
}

function normalizeAdvertisement(value) {
  const relayIdentity = copy(option(value, 'relayIdentity'), 32)
  const currentDhtNodeId = copy(option(value, 'currentDhtNodeId'), 32)
  const reachableEndpoint = decodeCanonicalEndpoint(option(value, 'reachableEndpoint'))
  const routeEncryptionPublicKey = validateRoutePublicKey(option(value, 'routeEncryptionPublicKey'))
  const capabilityMask = option(value, 'capabilityMask')
  const minimumProtocolVersion = option(value, 'minimumProtocolVersion')
  const maximumProtocolVersion = option(value, 'maximumProtocolVersion')
  const cellSize = option(value, 'cellSize')
  const maxCellPayload = option(value, 'maxCellPayload')
  const contextEnvelopeSize = option(value, 'contextEnvelopeSize')
  const routeFrameSize = option(value, 'routeFrameSize')
  const maxRoutePayload = option(value, 'maxRoutePayload')
  const datagramReplayWindow = option(value, 'datagramReplayWindow')
  const maxConcurrentCircuits = option(value, 'maxConcurrentCircuits')
  const capacityClass = option(value, 'capacityClass')
  const maxCellsPerCircuit = option(value, 'maxCellsPerCircuit')
  const maxBytesPerCircuit = option(value, 'maxBytesPerCircuit')
  const maxCommandsPerCircuit = option(value, 'maxCommandsPerCircuit')
  const idleTimeoutMs = option(value, 'idleTimeoutMs')
  const maxQueuedBytes = option(value, 'maxQueuedBytes')
  const epoch = option(value, 'epoch')
  const issuedAtMs = option(value, 'issuedAtMs')
  const expiresAtMs = option(value, 'expiresAtMs')
  const providerServicePolicyEntries = exactPolicyEntries(
    option(value, 'providerServicePolicyEntries'),
    capabilityMask
  )

  if (
    reachableEndpoint[0] !== 4 ||
    minimumProtocolVersion !== 1 ||
    maximumProtocolVersion !== 1 ||
    cellSize !== 1200 ||
    maxCellPayload !== 1146 ||
    contextEnvelopeSize !== 1101 ||
    routeFrameSize !== 1100 ||
    maxRoutePayload !== 1073 ||
    datagramReplayWindow !== 64 ||
    !uint16(maxConcurrentCircuits) ||
    maxConcurrentCircuits === 0 ||
    !Object.values(CAPACITY_CLASS).includes(capacityClass) ||
    !uint32(maxCellsPerCircuit) ||
    maxCellsPerCircuit === 0 ||
    !uint32(maxBytesPerCircuit) ||
    maxBytesPerCircuit === 0 ||
    !uint32(maxCommandsPerCircuit) ||
    maxCommandsPerCircuit === 0 ||
    !uint32(idleTimeoutMs) ||
    idleTimeoutMs === 0 ||
    !uint32(maxQueuedBytes) ||
    maxQueuedBytes === 0 ||
    !uint64(epoch) ||
    epoch === 0n ||
    !uint64(issuedAtMs) ||
    !uint64(expiresAtMs) ||
    issuedAtMs >= expiresAtMs ||
    expiresAtMs - issuedAtMs > MAX_CAPABILITY_LIFETIME
  ) {
    incompatible()
  }

  const firstAddressByte = reachableEndpoint[13]
  const unspecified =
    firstAddressByte === 0 &&
    reachableEndpoint[14] === 0 &&
    reachableEndpoint[15] === 0 &&
    reachableEndpoint[16] === 0
  const broadcast =
    firstAddressByte === 0xff &&
    reachableEndpoint[14] === 0xff &&
    reachableEndpoint[15] === 0xff &&
    reachableEndpoint[16] === 0xff
  if (unspecified || broadcast || firstAddressByte >= 224) incompatible()

  const derived = deriveM3DhtNodeId(reachableEndpoint)
  if (!equal(derived, currentDhtNodeId)) incompatible()
  if (capabilityMask & RELAY_CAPABILITY.CIRCUIT_RELAY_V1) {
    const requiredRole = capabilityMask & RELAY_CAPABILITY.DHT_EXIT_V1 ? ROLE.PRIVATE : ROLE.SAFETY
    if (roleForIdentity(relayIdentity) !== requiredRole) incompatible()
  }

  return {
    relayIdentity,
    currentDhtNodeId,
    reachableEndpoint,
    routeEncryptionPublicKey,
    capabilityMask,
    minimumProtocolVersion,
    maximumProtocolVersion,
    cellSize,
    maxCellPayload,
    contextEnvelopeSize,
    routeFrameSize,
    maxRoutePayload,
    datagramReplayWindow,
    maxConcurrentCircuits,
    capacityClass,
    maxCellsPerCircuit,
    maxBytesPerCircuit,
    maxCommandsPerCircuit,
    idleTimeoutMs,
    maxQueuedBytes,
    epoch,
    issuedAtMs,
    expiresAtMs,
    providerServicePolicyEntries
  }
}

function encodePolicyEntry(output, entry, offset) {
  writeUint16(output, entry.commandId, offset)
  writeUint16(output, entry.commandVersion, offset + 2)
  writeUint32(output, entry.maxRequestBytes, offset + 4)
  writeUint32(output, entry.maxResponseBytes, offset + 8)
  writeUint32(output, entry.timeoutMs, offset + 12)
  writeUint16(output, entry.maxOutstanding, offset + 16)
  writeUint32(output, entry.requestCost, offset + 18)
  writeUint32(output, entry.responseCost, offset + 22)
  writeUint32(output, entry.maxAmplificationBytes, offset + 26)
  output[offset + 30] = entry.mutationFlag
  output[offset + 31] = entry.destinationValidationClass
}

function encodeAdvertisementBody(value) {
  const normalized = normalizeAdvertisement(value)
  const body = b4a.allocUnsafe(
    CAPABILITY_ADVERTISEMENT_FIXED_BODY + normalized.providerServicePolicyEntries.length * 32
  )
  let offset = 0
  for (const field of [
    normalized.relayIdentity,
    normalized.currentDhtNodeId,
    normalized.reachableEndpoint,
    normalized.routeEncryptionPublicKey
  ]) {
    set(body, field, offset)
    offset += field.byteLength
  }
  writeUint32(body, normalized.capabilityMask, offset)
  writeUint32(body, normalized.minimumProtocolVersion, offset + 4)
  writeUint32(body, normalized.maximumProtocolVersion, offset + 8)
  offset += 12
  for (const scalar of [
    normalized.cellSize,
    normalized.maxCellPayload,
    normalized.contextEnvelopeSize,
    normalized.routeFrameSize,
    normalized.maxRoutePayload,
    normalized.datagramReplayWindow,
    normalized.maxConcurrentCircuits
  ]) {
    writeUint16(body, scalar, offset)
    offset += 2
  }
  body[offset++] = normalized.capacityClass
  for (const scalar of [
    normalized.maxCellsPerCircuit,
    normalized.maxBytesPerCircuit,
    normalized.maxCommandsPerCircuit,
    normalized.idleTimeoutMs,
    normalized.maxQueuedBytes
  ]) {
    writeUint32(body, scalar, offset)
    offset += 4
  }
  for (const scalar of [normalized.epoch, normalized.issuedAtMs, normalized.expiresAtMs]) {
    writeUint64(body, scalar, offset)
    offset += 8
  }
  writeUint16(body, normalized.providerServicePolicyEntries.length, offset)
  offset += 2
  for (const entry of normalized.providerServicePolicyEntries) {
    encodePolicyEntry(body, entry, offset)
    offset += 32
  }
  return { body, normalized }
}

function decodePolicyEntry(body, offset) {
  return Object.freeze({
    commandId: readUint16(body, offset),
    commandVersion: readUint16(body, offset + 2),
    maxRequestBytes: readUint32(body, offset + 4),
    maxResponseBytes: readUint32(body, offset + 8),
    timeoutMs: readUint32(body, offset + 12),
    maxOutstanding: readUint16(body, offset + 16),
    requestCost: readUint32(body, offset + 18),
    responseCost: readUint32(body, offset + 22),
    maxAmplificationBytes: readUint32(body, offset + 26),
    mutationFlag: body[offset + 30],
    destinationValidationClass: body[offset + 31]
  })
}

function decodeAdvertisementBody(body) {
  if (
    body.byteLength < CAPABILITY_ADVERTISEMENT_FIXED_BODY ||
    (body.byteLength - CAPABILITY_ADVERTISEMENT_FIXED_BODY) % 32 !== 0
  ) {
    incompatible()
  }
  let offset = 0
  const take = (size) => {
    const value = copy(subarray(body, offset, offset + size), size)
    offset += size
    return value
  }
  const value = {
    relayIdentity: take(32),
    currentDhtNodeId: take(32),
    reachableEndpoint: take(19),
    routeEncryptionPublicKey: take(32),
    capabilityMask: readUint32(body, offset),
    minimumProtocolVersion: readUint32(body, offset + 4),
    maximumProtocolVersion: readUint32(body, offset + 8)
  }
  offset += 12
  for (const name of [
    'cellSize',
    'maxCellPayload',
    'contextEnvelopeSize',
    'routeFrameSize',
    'maxRoutePayload',
    'datagramReplayWindow',
    'maxConcurrentCircuits'
  ]) {
    value[name] = readUint16(body, offset)
    offset += 2
  }
  value.capacityClass = body[offset++]
  for (const name of [
    'maxCellsPerCircuit',
    'maxBytesPerCircuit',
    'maxCommandsPerCircuit',
    'idleTimeoutMs',
    'maxQueuedBytes'
  ]) {
    value[name] = readUint32(body, offset)
    offset += 4
  }
  value.epoch = readUint64(body, offset)
  value.issuedAtMs = readUint64(body, offset + 8)
  value.expiresAtMs = readUint64(body, offset + 16)
  offset += 24
  const count = readUint16(body, offset)
  offset += 2
  if (count !== (body.byteLength - CAPABILITY_ADVERTISEMENT_FIXED_BODY) / 32) incompatible()
  value.providerServicePolicyEntries = []
  for (let index = 0; index < count; index++) {
    value.providerServicePolicyEntries.push(decodePolicyEntry(body, offset))
    offset += 32
  }
  return normalizeAdvertisement(value)
}

export function signRelayCapabilityAdvertisement(value, identitySecretKey) {
  const { body, normalized } = encodeAdvertisementBody(value)
  const secret = copy(identitySecretKey, 64)
  const input = signatureInput(CAPABILITY_DOMAIN, M3_MESSAGE_ID.CAPABILITY_ADVERTISEMENT_V1, body)
  try {
    const signature = copy(cryptoSuite.sign(input, secret), 64)
    if (!cryptoSuite.verify(input, signature, normalized.relayIdentity)) authentication()
    return Object.freeze({ ...normalized, signature })
  } catch {
    authentication()
  } finally {
    clear(secret)
    clear(input)
    clear(body)
  }
}

export function encodeRelayCapabilityAdvertisement(value) {
  const { body } = encodeAdvertisementBody(value)
  const signature = copy(option(value, 'signature'), 64)
  try {
    return encodeM3Object({
      messageId: M3_MESSAGE_ID.CAPABILITY_ADVERTISEMENT_V1,
      body,
      authSuffix: signature
    })
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code.startsWith('ERR_')) throw err
    incompatible()
  } finally {
    clear(body)
    clear(signature)
  }
}

export function decodeRelayCapabilityAdvertisement(encoded, { now } = {}) {
  let object
  try {
    object = decodeM3Object(encoded)
  } catch {
    incompatible()
  }
  if (object.messageId !== M3_MESSAGE_ID.CAPABILITY_ADVERTISEMENT_V1) incompatible()
  const value = decodeAdvertisementBody(object.body)
  const input = signatureInput(
    CAPABILITY_DOMAIN,
    M3_MESSAGE_ID.CAPABILITY_ADVERTISEMENT_V1,
    object.body
  )
  try {
    if (!cryptoSuite.verify(input, object.authSuffix, value.relayIdentity)) authentication()
  } finally {
    clear(input)
  }
  if (now !== undefined) {
    if (!uint64(now)) incompatible()
    if (value.issuedAtMs > now || value.expiresAtMs <= now) incompatible()
  }
  return Object.freeze({
    ...value,
    providerServicePolicyEntries: Object.freeze(value.providerServicePolicyEntries),
    signature: copy(object.authSuffix, 64)
  })
}

function rawAdvertisementDigest(encoded) {
  return digest([CAPABILITY_DIGEST_DOMAIN, encoded])
}

export function digestRelayCapabilityAdvertisement(encoded, { now } = {}) {
  decodeRelayCapabilityAdvertisement(encoded, { now })
  return rawAdvertisementDigest(encoded)
}

function challengeBody(challenge) {
  let object
  try {
    object = decodeM3Object(challenge)
  } catch {
    authentication()
  }
  if (object.messageId !== M3_MESSAGE_ID.ACTIVE_CHALLENGE_V1 || object.body.byteLength !== 176) {
    authentication()
  }
  return object.body
}

function responseBody(response) {
  let object
  try {
    object = decodeM3Object(response)
  } catch {
    authentication()
  }
  if (
    object.messageId !== M3_MESSAGE_ID.ACTIVE_CHALLENGE_RESPONSE_V1 ||
    object.body.byteLength !== 272
  ) {
    authentication()
  }
  return object
}

function activeProof(shared, bodyWithoutProof) {
  const prefix = b4a.allocUnsafe(2 + ACTIVE_PROOF_DOMAIN.byteLength)
  writeUint16(prefix, ACTIVE_PROOF_DOMAIN.byteLength, 0)
  set(prefix, ACTIVE_PROOF_DOMAIN, 2)
  try {
    return keyedHash(shared, [prefix, bodyWithoutProof])
  } finally {
    clear(prefix)
  }
}

function buildActiveChallengeResponse(
  challenge,
  {
    advertisement,
    identitySecretKey,
    routeEncryptionSecretKey,
    now,
    randomBytes = cryptoSuite.randomBytes,
    crypto = cryptoSuite
  } = {}
) {
  const challengeBytes = challengeBody(challenge)
  const advert = decodeRelayCapabilityAdvertisement(advertisement, { now })
  const advertDigest = rawAdvertisementDigest(advertisement)
  if (!equal(advertDigest, subarray(challengeBytes, 0, 32))) authentication()
  if (!uint64(now) || readUint64(challengeBytes, 96) <= now) authentication()
  if (typeof randomBytes !== 'function') incompatible()
  const responderNonce = copy(randomBytes(32), 32)
  const routeSecret = copy(routeEncryptionSecretKey, 32)
  const identitySecret = copy(identitySecretKey, 64)
  let shared = null
  let proof = null
  const body = b4a.allocUnsafe(272)
  try {
    shared = crypto.keyAgreement(routeSecret, subarray(challengeBytes, 64, 96))
    set(body, advertDigest, 0)
    set(body, advert.relayIdentity, 32)
    set(body, subarray(challengeBytes, 32, 96), 64)
    set(body, responderNonce, 128)
    set(body, subarray(challengeBytes, 96, 176), 160)
    proof = activeProof(shared, subarray(body, 0, 240))
    set(body, proof, 240)
    const input = signatureInput(
      ACTIVE_RESPONSE_DOMAIN,
      M3_MESSAGE_ID.ACTIVE_CHALLENGE_RESPONSE_V1,
      body
    )
    try {
      return encodeM3Object({
        messageId: M3_MESSAGE_ID.ACTIVE_CHALLENGE_RESPONSE_V1,
        body,
        authSuffix: crypto.sign(input, identitySecret)
      })
    } finally {
      clear(input)
    }
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code.startsWith('ERR_')) throw err
    authentication()
  } finally {
    clear(challengeBytes)
    clear(advertDigest)
    clear(responderNonce)
    clear(routeSecret)
    clear(identitySecret)
    clear(shared)
    clear(proof)
    clear(body)
  }
}

function readCapsQuery(value, includeCookie) {
  const sourceEndpoint = decodeCanonicalEndpoint(option(value, 'sourceEndpoint'))
  const requestedCapabilityMask = option(value, 'requestedCapabilityMask')
  const randomTarget = copy(option(value, 'randomTarget'), 32)
  const queryNonce = copy(option(value, 'queryNonce'), 32)
  const maximumResults = option(value, 'maximumResults')
  if (
    !uint32(requestedCapabilityMask) ||
    requestedCapabilityMask === 0 ||
    requestedCapabilityMask & ~KNOWN_CAPABILITY_MASK ||
    !Number.isSafeInteger(maximumResults) ||
    maximumResults < 1 ||
    maximumResults > MAX_CAPABILITY_ADVERTISEMENTS
  ) {
    clear(sourceEndpoint)
    clear(randomTarget)
    clear(queryNonce)
    incompatible()
  }
  const query = {
    sourceEndpoint,
    requestedCapabilityMask,
    randomTarget,
    queryNonce,
    maximumResults
  }
  if (includeCookie) {
    query.cookieExpiresAtMs = option(value, 'cookieExpiresAtMs')
    query.returnRoutabilityCookie = copy(option(value, 'returnRoutabilityCookie'), 32)
    if (!uint64(query.cookieExpiresAtMs)) {
      clearCapsQuery(query)
      incompatible()
    }
  }
  return query
}

function clearCapsQuery(query) {
  clear(query.sourceEndpoint)
  clear(query.randomTarget)
  clear(query.queryNonce)
  clear(query.returnRoutabilityCookie)
}

function capsCookieInput(query) {
  const output = b4a.allocUnsafe(2 + CAPS_COOKIE_DOMAIN.byteLength + 19 + 4 + 32 + 32 + 1 + 8)
  let offset = 0
  writeUint16(output, CAPS_COOKIE_DOMAIN.byteLength, offset)
  offset += 2
  set(output, CAPS_COOKIE_DOMAIN, offset)
  offset += CAPS_COOKIE_DOMAIN.byteLength
  set(output, query.sourceEndpoint, offset)
  offset += 19
  writeUint32(output, query.requestedCapabilityMask, offset)
  offset += 4
  set(output, query.randomTarget, offset)
  offset += 32
  set(output, query.queryNonce, offset)
  offset += 32
  output[offset++] = query.maximumResults
  writeUint64(output, query.cookieExpiresAtMs, offset)
  return output
}

function sameCapsQuery(left, right) {
  return (
    equal(left.sourceEndpoint, right.sourceEndpoint) &&
    left.requestedCapabilityMask === right.requestedCapabilityMask &&
    equal(left.randomTarget, right.randomTarget) &&
    equal(left.queryNonce, right.queryNonce) &&
    left.maximumResults === right.maximumResults &&
    left.cookieExpiresAtMs === right.cookieExpiresAtMs &&
    equal(left.returnRoutabilityCookie, right.returnRoutabilityCookie)
  )
}

function clearResponderBinding(state) {
  clearCapsQuery(state.query)
  clear(state.advertisement)
  clear(state.advertisementDigest)
}

class ActiveChallengeResponderAuthority {
  constructor({
    now,
    crypto = cryptoSuite,
    setTimeout: setTimer = globalThis.setTimeout,
    clearTimeout: clearTimer = globalThis.clearTimeout,
    maxBindings = MAX_CAPS_BINDINGS
  } = {}) {
    const randomBytes = option(crypto, 'randomBytes')
    const keyAgreement = option(crypto, 'keyAgreement')
    const sign = option(crypto, 'sign')
    if (
      typeof now !== 'function' ||
      typeof randomBytes !== 'function' ||
      typeof keyAgreement !== 'function' ||
      typeof sign !== 'function' ||
      typeof setTimer !== 'function' ||
      typeof clearTimer !== 'function' ||
      !Number.isSafeInteger(maxBindings) ||
      maxBindings < 1 ||
      maxBindings > MAX_CAPS_BINDINGS
    ) {
      incompatible()
    }
    const current = now()
    if (!uint64(current)) incompatible()
    this._now = now
    this._setTimer = setTimer
    this._clearTimer = clearTimer
    this._crypto = { randomBytes, keyAgreement, sign }
    this._currentSecret = {
      secret: null,
      rotatedAt: current
    }
    this._priorSecret = null
    this._bindings = new WeakMap()
    this._bindingTokens = new Set()
    this._completed = new WeakSet()
    this._cache = new Map()
    this._maxBindings = maxBindings
    this._destroyed = false
    this._rotationTimer = null
    this._priorEraseTimer = null
    this._rotationDeadline = current + CAPS_COOKIE_ROTATION
    let generatedSecret = null
    try {
      generatedSecret = randomBytes.call(crypto, 32)
      this._currentSecret.secret = copy(generatedSecret, 32)
      this._scheduleRotation()
    } catch (err) {
      this.destroy()
      throw err
    } finally {
      clear(generatedSecret)
    }
  }

  _assertLive() {
    if (this._destroyed) throw PrivateRouteError.ERR_DESTROYED()
  }

  _scheduleRotation() {
    const now = this._now()
    this._assertLive()
    if (!uint64(now)) {
      this.destroy()
      return
    }
    const setTimer = this._setTimer
    const clearTimer = this._clearTimer
    let timer = null
    try {
      timer = setTimer(
        () => {
          this._rotationTimer = null
          if (this._destroyed) return
          const current = this._now()
          if (this._destroyed) return
          if (!uint64(current)) {
            this.destroy()
            return
          }
          this._catchUpRotation(current)
        },
        Number(this._rotationDeadline > now ? this._rotationDeadline - now : 0n)
      )
      this._assertLive()
    } catch (err) {
      if (timer !== null) {
        try {
          clearTimer(timer)
        } catch {}
      }
      throw err
    }
    this._rotationTimer = timer
    unrefTimer(this._rotationTimer)
  }

  _catchUpRotation(now) {
    this._assertLive()
    if (this._priorSecret && this._priorSecret.expiresAt <= now) {
      clear(this._priorSecret.secret)
      this._priorSecret = null
      if (this._priorEraseTimer !== null) {
        try {
          this._clearTimer(this._priorEraseTimer)
        } catch {}
        this._assertLive()
        this._priorEraseTimer = null
      }
    }
    if (now < this._rotationDeadline) return
    let randomScratch = null
    let nextSecret = null
    try {
      randomScratch = this._crypto.randomBytes(32)
      this._assertLive()
      nextSecret = copy(randomScratch, 32)
    } finally {
      clear(randomScratch)
    }
    try {
      if (this._rotationTimer !== null) {
        try {
          this._clearTimer(this._rotationTimer)
        } catch {}
        this._assertLive()
        this._rotationTimer = null
      }
      if (this._priorEraseTimer !== null) {
        try {
          this._clearTimer(this._priorEraseTimer)
        } catch {}
        this._assertLive()
        this._priorEraseTimer = null
      }
      if (this._priorSecret) {
        clear(this._priorSecret.secret)
        this._priorSecret = null
      }
      const elapsed = now - this._rotationDeadline
      const skipped = elapsed / CAPS_COOKIE_ROTATION
      const rotationAt = this._rotationDeadline + skipped * CAPS_COOKIE_ROTATION
      const priorExpiresAt = this._rotationDeadline + CAPS_COOKIE_LIFETIME
      if (skipped === 0n && now < priorExpiresAt) {
        const prior = {
          secret: this._currentSecret.secret,
          expiresAt: priorExpiresAt
        }
        const setTimer = this._setTimer
        const clearTimer = this._clearTimer
        let priorTimer = null
        try {
          priorTimer = setTimer(
            () => {
              this._priorEraseTimer = null
              if (this._priorSecret !== prior) return
              clear(prior.secret)
              this._priorSecret = null
            },
            Number(priorExpiresAt - now)
          )
          this._assertLive()
        } catch (err) {
          if (priorTimer !== null) {
            try {
              clearTimer(priorTimer)
            } catch {}
          }
          throw err
        }
        this._priorSecret = prior
        this._priorEraseTimer = priorTimer
        unrefTimer(this._priorEraseTimer)
      } else {
        clear(this._currentSecret.secret)
      }
      this._currentSecret = {
        secret: nextSecret,
        rotatedAt: rotationAt
      }
      nextSecret = null
      this._rotationDeadline = rotationAt + CAPS_COOKIE_ROTATION
      this._scheduleRotation()
    } finally {
      clear(nextSecret)
    }
  }

  _expire(now) {
    this._catchUpRotation(now)
    for (const [key, state] of this._cache) {
      if (state.query.cookieExpiresAtMs > now) continue
      this._cache.delete(key)
      this._bindings.delete(state.binding)
      this._bindingTokens.delete(state.binding)
      clearResponderBinding(state)
    }
  }

  _cookie(secret, query) {
    const input = capsCookieInput(query)
    try {
      return keyedHash(secret, [input])
    } finally {
      clear(input)
    }
  }

  issueCookie(value) {
    this._assertLive()
    const now = this._now()
    this._assertLive()
    if (!uint64(now)) incompatible()
    this._expire(now)
    this._assertLive()
    const query = readCapsQuery(value, false)
    let cookie = null
    try {
      this._assertLive()
      query.cookieExpiresAtMs = now + CAPS_COOKIE_LIFETIME
      cookie = this._cookie(this._currentSecret.secret, query)
      this._assertLive()
      return Object.freeze({
        cookieExpiresAtMs: query.cookieExpiresAtMs,
        returnRoutabilityCookie: cookie
      })
    } finally {
      clearCapsQuery(query)
    }
  }

  admitCapsRetry(value) {
    this._assertLive()
    const now = this._now()
    this._assertLive()
    if (!uint64(now)) incompatible()
    this._expire(now)
    this._assertLive()
    let query = null
    let advertisement = null
    let advertisementDigest = null
    let expected = null
    let valid = false
    try {
      query = readCapsQuery(value, true)
      this._assertLive()
      if (query.cookieExpiresAtMs <= now || query.cookieExpiresAtMs > now + CAPS_COOKIE_LIFETIME) {
        authentication()
      }
      expected = this._cookie(this._currentSecret.secret, query)
      valid = equal(expected, query.returnRoutabilityCookie)
      clear(expected)
      expected = null
      if (!valid && this._priorSecret && this._priorSecret.expiresAt > now) {
        expected = this._cookie(this._priorSecret.secret, query)
        valid = equal(expected, query.returnRoutabilityCookie)
      }
      if (!valid) authentication()

      const advertisementSource = option(value, 'advertisement')
      this._assertLive()
      advertisement = copy(advertisementSource)
      decodeRelayCapabilityAdvertisement(advertisement, { now })
      advertisementDigest = rawAdvertisementDigest(advertisement)
      const cacheKey = b4a.toString(query.returnRoutabilityCookie, 'hex')
      const existing = this._cache.get(cacheKey)
      if (existing) {
        const exact =
          !existing.used &&
          sameCapsQuery(existing.query, query) &&
          equal(existing.advertisement, advertisement) &&
          equal(existing.advertisementDigest, advertisementDigest)
        clear(advertisement)
        clear(advertisementDigest)
        advertisement = null
        advertisementDigest = null
        if (!exact) authentication()
        clearCapsQuery(query)
        query = null
        this._assertLive()
        return existing.binding
      }
      if (this._cache.size >= this._maxBindings) throw PrivateRouteError.ERR_BUSY()
      this._assertLive()
      const binding = Object.freeze({})
      const state = {
        advertisement,
        advertisementDigest,
        binding,
        cacheKey,
        query,
        used: false
      }
      this._bindings.set(binding, state)
      this._bindingTokens.add(binding)
      this._cache.set(cacheKey, state)
      query = null
      advertisement = null
      advertisementDigest = null
      return binding
    } catch (err) {
      if (query) clearCapsQuery(query)
      clear(advertisement)
      clear(advertisementDigest)
      throw err
    } finally {
      clear(expected)
    }
  }

  respond(binding, challenge, options = {}) {
    this._assertLive()
    const state = this._bindings.get(binding)
    if (!state) {
      if (binding !== null && typeof binding === 'object' && this._completed.has(binding)) replay()
      authentication()
    }
    const now = this._now()
    this._assertLive()
    if (!uint64(now)) incompatible()
    this._expire(now)
    this._assertLive()
    if (!this._bindings.has(binding) || state.query.cookieExpiresAtMs <= now) authentication()
    const sourceEndpointValue = option(options, 'sourceEndpoint')
    this._assertLive()
    const sourceEndpoint = decodeCanonicalEndpoint(sourceEndpointValue)
    const advertisementValue = option(options, 'advertisement')
    this._assertLive()
    const advertisement = copy(advertisementValue)
    const body = challengeBody(challenge)
    let response = null
    try {
      if (
        !equal(sourceEndpoint, state.query.sourceEndpoint) ||
        !equal(advertisement, state.advertisement) ||
        !equal(subarray(body, 0, 32), state.advertisementDigest) ||
        readUint64(body, 96) <= now ||
        readUint64(body, 96) > now + ACTIVE_CHALLENGE_TIMEOUT ||
        !equal(subarray(body, 104, 136), state.query.queryNonce) ||
        readUint64(body, 136) !== state.query.cookieExpiresAtMs ||
        !equal(subarray(body, 144, 176), state.query.returnRoutabilityCookie)
      ) {
        authentication()
      }
      const identitySecretKey = option(options, 'identitySecretKey')
      this._assertLive()
      const routeEncryptionSecretKey = option(options, 'routeEncryptionSecretKey')
      this._assertLive()
      state.used = true
      this._bindings.delete(binding)
      this._bindingTokens.delete(binding)
      this._completed.add(binding)
      response = buildActiveChallengeResponse(challenge, {
        advertisement,
        identitySecretKey,
        routeEncryptionSecretKey,
        now,
        randomBytes: this._crypto.randomBytes,
        crypto: this._crypto
      })
      this._assertLive()
      const result = response
      response = null
      return result
    } finally {
      clear(response)
      clear(sourceEndpoint)
      clear(advertisement)
      clear(body)
    }
  }

  destroy() {
    if (this._destroyed) return
    this._destroyed = true
    if (this._rotationTimer !== null) {
      try {
        this._clearTimer(this._rotationTimer)
      } catch {}
    }
    if (this._priorEraseTimer !== null) {
      try {
        this._clearTimer(this._priorEraseTimer)
      } catch {}
    }
    this._rotationTimer = null
    this._priorEraseTimer = null
    clear(this._currentSecret.secret)
    if (this._priorSecret) clear(this._priorSecret.secret)
    for (const state of this._cache.values()) {
      this._bindings.delete(state.binding)
      clearResponderBinding(state)
    }
    this._cache.clear()
    this._bindingTokens.clear()
    this._priorSecret = null
    this._setTimer = null
    this._clearTimer = null
  }
}

export function createActiveChallengeResponderAuthority(options) {
  return new ActiveChallengeResponderAuthority(options)
}

function copyAdvertisementState(state) {
  return {
    relayIdentity: copy(state.advertisement.relayIdentity, 32),
    currentDhtNodeId: copy(state.advertisement.currentDhtNodeId, 32),
    reachableEndpoint: copy(state.endpoint, 19),
    routeEncryptionPublicKey: copy(state.advertisement.routeEncryptionPublicKey, 32),
    capabilityMask: state.advertisement.capabilityMask,
    capacityClass: state.advertisement.capacityClass,
    epoch: state.advertisement.epoch,
    expiresAtMs: state.advertisement.expiresAtMs,
    advertisement: copy(state.encoded)
  }
}

function clearValidatedState(state) {
  if (!state) return
  clear(state.queryNonce)
  clear(state.returnRoutabilityCookie)
}

function clearValidatedProjection(state) {
  if (!state) return
  for (const name of [
    'advertisement',
    'relayIdentity',
    'currentDhtNodeId',
    'reachableEndpoint',
    'routeEncryptionPublicKey',
    'queryNonce',
    'returnRoutabilityCookie'
  ]) {
    clear(state[name])
  }
}

function clearCapsBinding(binding) {
  if (!binding) return
  clear(binding.queryNonce)
  clear(binding.returnRoutabilityCookie)
}

function clearAdvertisement(advertisement) {
  if (!advertisement) return
  clear(advertisement.relayIdentity)
  clear(advertisement.currentDhtNodeId)
  clear(advertisement.reachableEndpoint)
  clear(advertisement.routeEncryptionPublicKey)
  clear(advertisement.signature)
}

function clearCandidateState(state) {
  if (!state) return
  state.active = false
  clear(state.encoded)
  clear(state.endpoint)
  clearAdvertisement(state.advertisement)
  clearCapsBinding(state.binding)
  state.binding = null
}

function copyValidatedState(state) {
  return {
    ...copyAdvertisementState(state.candidateState),
    challengeExpiresAtMs: state.challengeExpiresAtMs,
    queryNonce: copy(state.queryNonce, 32),
    cookieExpiresAtMs: state.cookieExpiresAtMs,
    returnRoutabilityCookie: copy(state.returnRoutabilityCookie, 32)
  }
}

function clearGuardAdmissionState(state) {
  if (!state) return
  for (const name of [
    'advertisement',
    'advertisementDigest',
    'relayIdentity',
    'reachableEndpoint',
    'routeEncryptionPublicKey',
    'queryNonce',
    'returnRoutabilityCookie',
    'clientIdentity',
    'branchId',
    'circuitId'
  ]) {
    clear(state[name])
  }
  state.candidateState = null
}

function copyGuardAdmissionState(state) {
  return {
    advertisement: copy(state.advertisement),
    advertisementDigest: copy(state.advertisementDigest, 32),
    relayIdentity: copy(state.relayIdentity, 32),
    reachableEndpoint: copy(state.reachableEndpoint, 19),
    epoch: state.epoch,
    expiresAtMs: state.expiresAtMs,
    challengeExpiresAtMs: state.challengeExpiresAtMs,
    cookieExpiresAtMs: state.cookieExpiresAtMs,
    clientIdentity: copy(state.clientIdentity, 32),
    branchClass: state.branchClass,
    branchId: copy(state.branchId, 16),
    circuitId: copy(state.circuitId, 16),
    generation: state.generation
  }
}

export class RelayCapabilityDirectory {
  constructor({
    now,
    randomBytes = cryptoSuite.randomBytes,
    setTimeout: setTimer = globalThis.setTimeout,
    clearTimeout: clearTimer = globalThis.clearTimeout,
    maxIdentities = 256,
    maxPending = 64,
    maxGuardAdmissions = 64
  } = {}) {
    if (
      typeof now !== 'function' ||
      typeof randomBytes !== 'function' ||
      typeof setTimer !== 'function' ||
      typeof clearTimer !== 'function' ||
      !Number.isSafeInteger(maxIdentities) ||
      maxIdentities < 1 ||
      maxIdentities > 4096 ||
      !Number.isSafeInteger(maxPending) ||
      maxPending < 1 ||
      maxPending > 4096 ||
      !Number.isSafeInteger(maxGuardAdmissions) ||
      maxGuardAdmissions < 1 ||
      maxGuardAdmissions > 4096
    ) {
      incompatible()
    }
    this._now = now
    this._randomBytes = randomBytes
    this._setTimer = setTimer
    this._clearTimer = clearTimer
    this._destroyed = false
    this._generation = Object.freeze({})
    this._validations = new Set()
    this._identities = new Map()
    this._history = new Map()
    this._candidates = new WeakMap()
    this._pending = new WeakMap()
    this._pendingTokens = new Set()
    this._pendingReservations = new Set()
    this._completedPending = new WeakSet()
    this._validated = new WeakMap()
    this._validatedTokens = new Set()
    this._completedValidated = new WeakSet()
    this._guardAdmissions = new WeakMap()
    this._guardAdmissionTokens = new Set()
    this._guardAdmissionReservations = new Set()
    this._completedGuardAdmissions = new WeakSet()
    this._quarantine = new Map()
    this._maxIdentities = maxIdentities
    this._maxPending = maxPending
    this._maxGuardAdmissions = maxGuardAdmissions
  }

  _assertLive() {
    if (this._destroyed) throw PrivateRouteError.ERR_DESTROYED()
  }

  _assertGeneration(generation) {
    if (this._destroyed || this._generation !== generation) {
      throw PrivateRouteError.ERR_DESTROYED()
    }
  }

  _assertReservation(reservations, reservation, generation) {
    this._assertGeneration(generation)
    if (!reservations.has(reservation)) throw PrivateRouteError.ERR_DESTROYED()
  }

  _expire(now) {
    for (const [identity, state] of this._identities) {
      if (state.advertisement.expiresAtMs <= now) {
        clearCandidateState(state)
        this._identities.delete(identity)
      }
    }
    for (const [identity, expiresAt] of this._quarantine) {
      if (expiresAt <= now) this._quarantine.delete(identity)
    }
    for (const token of this._validatedTokens) {
      const state = this._validated.get(token)
      if (
        !state ||
        !state.candidateState.active ||
        state.candidateState.advertisement.expiresAtMs <= now ||
        state.challengeExpiresAtMs <= now ||
        state.cookieExpiresAtMs <= now
      ) {
        clearValidatedState(state)
        this._validated.delete(token)
        this._validatedTokens.delete(token)
      }
    }
    for (const token of this._pendingTokens) {
      const state = this._pending.get(token)
      if (
        !state ||
        !state.candidateState.active ||
        state.candidateState.advertisement.expiresAtMs <= now ||
        state.candidateState.binding.cookieExpiresAtMs <= now ||
        readUint64(state.challenge, 96) <= now
      ) {
        this._cancelActiveChallenge(token)
      }
    }
    for (const token of this._guardAdmissionTokens) {
      const state = this._guardAdmissions.get(token)
      if (
        !state ||
        !state.candidateState ||
        !state.candidateState.active ||
        state.expiresAtMs <= now ||
        state.challengeExpiresAtMs <= now ||
        state.cookieExpiresAtMs <= now
      ) {
        this._revokeGuardAdmission(token)
      }
    }
  }

  _assertCurrent(state, now) {
    if (!state.active) replay()
    if (state.advertisement.expiresAtMs <= now) incompatible()
  }

  admit(encoded, { observedEndpoint, capsBinding = null } = {}) {
    this._assertLive()
    const generation = this._generation
    const now = this._now()
    this._assertGeneration(generation)
    if (!uint64(now)) incompatible()
    this._expire(now)
    let advertisement = null
    let endpoint = null
    let binding = null
    let bytes = null
    let state = null
    let nextHistory = null
    let installed = false
    try {
      advertisement = decodeRelayCapabilityAdvertisement(encoded, { now })
      endpoint = decodeCanonicalEndpoint(observedEndpoint)
      if (!equal(endpoint, advertisement.reachableEndpoint)) authentication()
      if (capsBinding !== null) {
        const queryNonceSource = option(capsBinding, 'queryNonce')
        this._assertGeneration(generation)
        const cookieExpiresAtMs = option(capsBinding, 'cookieExpiresAtMs')
        this._assertGeneration(generation)
        const cookieSource = option(capsBinding, 'returnRoutabilityCookie')
        this._assertGeneration(generation)
        binding = {
          queryNonce: copy(queryNonceSource, 32),
          cookieExpiresAtMs,
          returnRoutabilityCookie: copy(cookieSource, 32)
        }
        if (!uint64(binding.cookieExpiresAtMs) || binding.cookieExpiresAtMs <= now) {
          authentication()
        }
      }
      const identity = b4a.toString(advertisement.relayIdentity, 'hex')
      const quarantinedUntil = this._quarantine.get(identity)
      if (quarantinedUntil !== undefined && quarantinedUntil > now) authentication()
      bytes = copy(encoded)
      const previous = this._identities.get(identity)
      const history = this._history.get(identity)
      if (history) {
        if (history.poisoned) authentication()
        if (advertisement.epoch < history.epoch) replay()
        if (advertisement.epoch === history.epoch) {
          if (equal(bytes, history.encoded) && previous) {
            if (binding) {
              clearCapsBinding(previous.binding)
              previous.binding = binding
              binding = null
            }
            this._assertGeneration(generation)
            return previous.candidate
          }
          appendRouteKey(history, advertisement.routeEncryptionPublicKey)
          if (previous) clearCandidateState(previous)
          this._quarantine.set(
            identity,
            advertisement.expiresAtMs > history.expiresAtMs
              ? advertisement.expiresAtMs
              : history.expiresAtMs
          )
          this._identities.delete(identity)
          authentication()
        }
        if (
          history.routeEncryptionPublicKeys.some((key) =>
            equal(advertisement.routeEncryptionPublicKey, key)
          )
        ) {
          replay()
        }
      }
      if (!history && this._history.size >= this._maxIdentities) {
        throw PrivateRouteError.ERR_BUSY()
      }
      nextHistory = {
        encoded: copy(bytes),
        epoch: advertisement.epoch,
        expiresAtMs: advertisement.expiresAtMs,
        routeEncryptionPublicKeys: history
          ? history.routeEncryptionPublicKeys.map((key) => copy(key, 32))
          : [],
        poisoned: false
      }
      appendRouteKey(nextHistory, advertisement.routeEncryptionPublicKey)
      const candidate = Object.freeze({})
      state = { active: true, advertisement, binding, candidate, encoded: bytes, endpoint }
      advertisement = null
      binding = null
      bytes = null
      endpoint = null
      if (previous) clearCandidateState(previous)
      this._assertGeneration(generation)
      this._candidates.set(candidate, state)
      this._identities.set(identity, state)
      this._history.set(identity, nextHistory)
      if (history) clearHistory(history)
      installed = true
      nextHistory = null
      state = null
      return candidate
    } finally {
      if (!installed) clearCandidateState(state)
      if (nextHistory) clearHistory(nextHistory)
      clearAdvertisement(advertisement)
      clearCapsBinding(binding)
      clear(bytes)
      clear(endpoint)
    }
  }

  isAdmitted(value) {
    this._assertLive()
    const generation = this._generation
    const now = this._now()
    this._assertGeneration(generation)
    if (!uint64(now)) return false
    this._expire(now)
    const state = value !== null && typeof value === 'object' ? this._candidates.get(value) : null
    if (!state || !state.active || !state.binding) return false
    if (state.advertisement.expiresAtMs <= now || state.binding.cookieExpiresAtMs <= now) {
      return false
    }
    const identity = b4a.toString(state.advertisement.relayIdentity, 'hex')
    const quarantinedUntil = this._quarantine.get(identity)
    return quarantinedUntil === undefined || quarantinedUntil <= now
  }

  readAdmitted(value) {
    this._assertLive()
    if (!this.isAdmitted(value)) authentication()
    const state = this._candidates.get(value)
    return {
      ...copyAdvertisementState(state),
      capsBinding: Object.freeze({
        queryNonce: copy(state.binding.queryNonce, 32),
        cookieExpiresAtMs: state.binding.cookieExpiresAtMs,
        returnRoutabilityCookie: copy(state.binding.returnRoutabilityCookie, 32)
      })
    }
  }

  beginActiveChallenge(candidate) {
    this._assertLive()
    const state = this._candidates.get(candidate)
    if (!state) authentication()
    const generation = this._generation
    const reservation = Object.freeze({})
    this._pendingReservations.add(reservation)
    let challengeNonce = null
    let ephemeralSeed = null
    let ephemeral = null
    let body = null
    let advertisementDigest = null
    let pending = null
    let randomScratch = null
    let installed = false
    try {
      const now = this._now()
      this._assertReservation(this._pendingReservations, reservation, generation)
      if (!uint64(now)) incompatible()
      this._assertCurrent(state, now)
      if (!state.binding) authentication()
      this._expire(now)
      if (state.binding.cookieExpiresAtMs <= now) incompatible()
      if (
        this._pendingTokens.size + this._pendingReservations.size + this._validatedTokens.size >
        this._maxPending
      ) {
        throw PrivateRouteError.ERR_BUSY()
      }
      randomScratch = this._randomBytes(32)
      this._assertReservation(this._pendingReservations, reservation, generation)
      challengeNonce = copy(randomScratch, 32)
      clear(randomScratch)
      randomScratch = null
      randomScratch = this._randomBytes(32)
      this._assertReservation(this._pendingReservations, reservation, generation)
      ephemeralSeed = copy(randomScratch, 32)
      clear(randomScratch)
      randomScratch = null
      ephemeral = cryptoSuite.encryptionKeyPair(ephemeralSeed)
      body = b4a.allocUnsafe(176)
      advertisementDigest = rawAdvertisementDigest(state.encoded)
      let expiresAt = now + ACTIVE_CHALLENGE_TIMEOUT
      if (state.binding.cookieExpiresAtMs < expiresAt) expiresAt = state.binding.cookieExpiresAtMs
      if (state.advertisement.expiresAtMs < expiresAt) expiresAt = state.advertisement.expiresAtMs
      set(body, advertisementDigest, 0)
      set(body, challengeNonce, 32)
      set(body, ephemeral.publicKey, 64)
      writeUint64(body, expiresAt, 96)
      set(body, state.binding.queryNonce, 104)
      writeUint64(body, state.binding.cookieExpiresAtMs, 136)
      set(body, state.binding.returnRoutabilityCookie, 144)
      pending = Object.freeze({
        message: encodeM3Object({ messageId: M3_MESSAGE_ID.ACTIVE_CHALLENGE_V1, body })
      })
      this._assertReservation(this._pendingReservations, reservation, generation)
      this._pending.set(pending, {
        advertisementDigest,
        candidateState: state,
        challenge: copy(body),
        ephemeralSecretKey: copy(ephemeral.secretKey, 32),
        used: false
      })
      this._pendingTokens.add(pending)
      installed = true
      advertisementDigest = null
      return pending
    } finally {
      this._pendingReservations.delete(reservation)
      if (!installed && pending) {
        this._pending.delete(pending)
        this._pendingTokens.delete(pending)
      }
      clear(challengeNonce)
      clear(ephemeralSeed)
      clear(ephemeral && ephemeral.publicKey)
      clear(ephemeral && ephemeral.secretKey)
      clear(body)
      clear(advertisementDigest)
      clear(randomScratch)
    }
  }

  _cancelActiveChallenge(pending) {
    const state = this._pending.get(pending)
    if (!state) return
    clear(state.advertisementDigest)
    clear(state.challenge)
    clear(state.ephemeralSecretKey)
    state.used = true
    this._pending.delete(pending)
    this._pendingTokens.delete(pending)
  }

  cancelActiveChallenge(pending) {
    this._assertLive()
    this._cancelActiveChallenge(pending)
  }

  completeActiveChallenge(pending, response, { observedEndpoint } = {}) {
    this._assertLive()
    const generation = this._generation
    const state = this._pending.get(pending)
    if (!state) {
      if (pending !== null && typeof pending === 'object' && this._completedPending.has(pending)) {
        replay()
      }
      authentication()
    }
    if (state.used) replay()
    const endpoint = decodeCanonicalEndpoint(observedEndpoint)
    if (!equal(endpoint, state.candidateState.endpoint)) authentication()
    const now = this._now()
    this._assertGeneration(generation)
    if (!uint64(now)) incompatible()
    if (
      !state.candidateState.active ||
      state.candidateState.advertisement.expiresAtMs <= now ||
      state.candidateState.binding.cookieExpiresAtMs <= now ||
      readUint64(state.challenge, 96) <= now
    ) {
      this._cancelActiveChallenge(pending)
      incompatible()
    }
    const object = responseBody(response)
    const body = object.body
    if (
      !equal(subarray(body, 0, 32), state.advertisementDigest) ||
      !equal(subarray(body, 32, 64), state.candidateState.advertisement.relayIdentity) ||
      !equal(subarray(body, 64, 128), subarray(state.challenge, 32, 96)) ||
      !equal(subarray(body, 160, 240), subarray(state.challenge, 96, 176))
    ) {
      authentication()
    }
    const input = signatureInput(
      ACTIVE_RESPONSE_DOMAIN,
      M3_MESSAGE_ID.ACTIVE_CHALLENGE_RESPONSE_V1,
      body
    )
    if (
      !cryptoSuite.verify(
        input,
        object.authSuffix,
        state.candidateState.advertisement.relayIdentity
      )
    ) {
      clear(input)
      authentication()
    }
    clear(input)
    let shared = null
    let expected = null
    try {
      shared = cryptoSuite.keyAgreement(
        state.ephemeralSecretKey,
        state.candidateState.advertisement.routeEncryptionPublicKey
      )
      expected = activeProof(shared, subarray(body, 0, 240))
      if (!equal(expected, subarray(body, 240, 272))) authentication()
    } finally {
      clear(shared)
      clear(expected)
    }
    const validated = Object.freeze({})
    const validatedState = {
      candidateState: state.candidateState,
      challengeExpiresAtMs: readUint64(state.challenge, 96),
      queryNonce: copy(subarray(state.challenge, 104, 136), 32),
      cookieExpiresAtMs: readUint64(state.challenge, 136),
      returnRoutabilityCookie: copy(subarray(state.challenge, 144, 176), 32)
    }
    state.used = true
    clear(state.advertisementDigest)
    clear(state.challenge)
    clear(state.ephemeralSecretKey)
    this._pending.delete(pending)
    this._pendingTokens.delete(pending)
    this._completedPending.add(pending)
    this._validated.set(validated, validatedState)
    this._validatedTokens.add(validated)
    return validated
  }

  async validate(candidate, exchange) {
    this._assertLive()
    const generation = this._generation
    if (typeof exchange !== 'function') incompatible()
    const state = this._candidates.get(candidate)
    if (!state) authentication()
    const pending = this.beginActiveChallenge(candidate)
    const pendingState = this._pending.get(pending)
    const current = this._now()
    this._assertGeneration(generation)
    const deadline = readUint64(pendingState.challenge, 96)
    if (!uint64(current) || deadline <= current) {
      this._cancelActiveChallenge(pending)
      incompatible()
    }
    const boundary = abortBoundary()
    let rejectDeadline
    const deadlinePromise = new Promise((resolve, reject) => {
      rejectDeadline = reject
    })
    void deadlinePromise.catch(() => {})
    const operation = {
      abort: boundary.abort,
      pending,
      reject: rejectDeadline,
      timer: null
    }
    this._validations.add(operation)
    try {
      operation.timer = this._setTimer(
        () => {
          operation.timer = null
          boundary.abort()
          rejectDeadline(PrivateRouteError.ERR_PRIVACY_UNAVAILABLE())
        },
        Number(deadline - current)
      )
      this._assertGeneration(generation)
      const response = await Promise.race([
        Promise.resolve().then(() => {
          this._assertGeneration(generation)
          if (boundary.signal.aborted) {
            throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
          }
          return exchange(pending.message, copy(state.endpoint), boundary.signal)
        }),
        deadlinePromise
      ])
      this._assertLive()
      return this.completeActiveChallenge(pending, response, { observedEndpoint: state.endpoint })
    } finally {
      this._validations.delete(operation)
      if (operation.timer !== null) {
        try {
          this._clearTimer(operation.timer)
        } catch {}
      }
      boundary.abort()
      if (this._pending.has(pending)) this._cancelActiveChallenge(pending)
    }
  }

  isValidated(value) {
    this._assertLive()
    const generation = this._generation
    const state = this._validated.get(value)
    const now = this._now()
    this._assertGeneration(generation)
    return Boolean(
      state &&
      uint64(now) &&
      state.candidateState.active &&
      state.candidateState.advertisement.expiresAtMs > now &&
      state.challengeExpiresAtMs > now &&
      state.cookieExpiresAtMs > now &&
      !this.isQuarantined(state.candidateState.advertisement.relayIdentity)
    )
  }

  read(value) {
    this._assertLive()
    const generation = this._generation
    const state = this._validated.get(value)
    if (!state) authentication()
    const now = this._now()
    this._assertGeneration(generation)
    if (!uint64(now)) incompatible()
    if (!state.candidateState.active) replay()
    if (
      state.candidateState.advertisement.expiresAtMs <= now ||
      state.challengeExpiresAtMs <= now ||
      state.cookieExpiresAtMs <= now
    ) {
      incompatible()
    }
    if (this.isQuarantined(state.candidateState.advertisement.relayIdentity)) authentication()
    return copyValidatedState(state)
  }

  consumeValidated(value) {
    this._assertLive()
    const generation = this._generation
    const state = value !== null && typeof value === 'object' ? this._validated.get(value) : null
    if (!state) {
      if (value !== null && typeof value === 'object' && this._completedValidated.has(value)) {
        replay()
      }
      authentication()
    }
    const current = this._now()
    this._assertGeneration(generation)
    if (!uint64(current) || !this.isValidated(value)) incompatible()
    const result = copyValidatedState(state)
    this._validated.delete(value)
    this._validatedTokens.delete(value)
    this._completedValidated.add(value)
    clearValidatedState(state)
    return result
  }

  revokeValidated(value) {
    this._assertLive()
    const state = value !== null && typeof value === 'object' ? this._validated.get(value) : null
    if (!state) return false
    this._validated.delete(value)
    this._validatedTokens.delete(value)
    this._completedValidated.add(value)
    clearValidatedState(state)
    return true
  }

  reserveGuardAdmission(value, binding) {
    this._assertLive()
    const generation = this._generation
    const reservation = Object.freeze({})
    this._guardAdmissionReservations.add(reservation)
    let validatedState = null
    let validated = null
    let state = null
    let clientIdentity = null
    let branchId = null
    let circuitId = null
    let installed = false
    try {
      validatedState =
        value !== null && typeof value === 'object' ? this._validated.get(value) : null
      validated = this.consumeValidated(value)
      this._assertReservation(this._guardAdmissionReservations, reservation, generation)
      const current = this._now()
      this._assertReservation(this._guardAdmissionReservations, reservation, generation)
      if (!uint64(current)) incompatible()
      this._expire(current)
      if (
        this._guardAdmissionTokens.size + this._guardAdmissionReservations.size >
        this._maxGuardAdmissions
      ) {
        throw PrivateRouteError.ERR_BUSY()
      }
      const clientIdentitySource = option(binding, 'clientIdentity')
      this._assertReservation(this._guardAdmissionReservations, reservation, generation)
      clientIdentity = copy(clientIdentitySource, 32)
      const branchClass = option(binding, 'branchClass')
      this._assertReservation(this._guardAdmissionReservations, reservation, generation)
      const branchIdSource = option(binding, 'branchId')
      this._assertReservation(this._guardAdmissionReservations, reservation, generation)
      branchId = copy(branchIdSource, 16)
      const circuitIdSource = option(binding, 'circuitId')
      this._assertReservation(this._guardAdmissionReservations, reservation, generation)
      circuitId = copy(circuitIdSource, 16)
      const bindingGeneration = option(binding, 'generation')
      this._assertReservation(this._guardAdmissionReservations, reservation, generation)
      if (
        !nonzero(clientIdentity) ||
        (branchClass !== BRANCH_CLASS.LOOKUP && branchClass !== BRANCH_CLASS.ANNOUNCE) ||
        !nonzero(branchId) ||
        !nonzero(circuitId) ||
        !uint64(bindingGeneration) ||
        bindingGeneration === 0n
      ) {
        authentication()
      }
      state = {
        candidateState: validatedState.candidateState,
        advertisement: copy(validated.advertisement),
        advertisementDigest: rawAdvertisementDigest(validated.advertisement),
        relayIdentity: copy(validated.relayIdentity, 32),
        reachableEndpoint: copy(validated.reachableEndpoint, 19),
        epoch: validated.epoch,
        expiresAtMs: validated.expiresAtMs,
        challengeExpiresAtMs: validated.challengeExpiresAtMs,
        cookieExpiresAtMs: validated.cookieExpiresAtMs,
        clientIdentity,
        branchClass,
        branchId,
        circuitId,
        generation: bindingGeneration
      }
      const admission = Object.freeze({})
      this._assertReservation(this._guardAdmissionReservations, reservation, generation)
      this._guardAdmissions.set(admission, state)
      this._guardAdmissionTokens.add(admission)
      installed = true
      clientIdentity = null
      branchId = null
      circuitId = null
      return admission
    } finally {
      this._guardAdmissionReservations.delete(reservation)
      clearValidatedProjection(validated)
      if (!installed) clearGuardAdmissionState(state)
      clear(clientIdentity)
      clear(branchId)
      clear(circuitId)
    }
  }

  readGuardAdmission(value) {
    this._assertLive()
    const generation = this._generation
    const state =
      value !== null && typeof value === 'object' ? this._guardAdmissions.get(value) : null
    if (!state) authentication()
    const current = this._now()
    this._assertGeneration(generation)
    if (
      !uint64(current) ||
      state.expiresAtMs <= current ||
      state.challengeExpiresAtMs <= current ||
      state.cookieExpiresAtMs <= current
    ) {
      this.revokeGuardAdmission(value)
      incompatible()
    }
    return copyGuardAdmissionState(state)
  }

  consumeGuardAdmission(value) {
    this._assertLive()
    const state =
      value !== null && typeof value === 'object' ? this._guardAdmissions.get(value) : null
    if (!state) {
      if (
        value !== null &&
        typeof value === 'object' &&
        this._completedGuardAdmissions.has(value)
      ) {
        replay()
      }
      authentication()
    }
    const result = this.readGuardAdmission(value)
    this._guardAdmissions.delete(value)
    this._guardAdmissionTokens.delete(value)
    this._completedGuardAdmissions.add(value)
    clearGuardAdmissionState(state)
    return result
  }

  revokeGuardAdmission(value) {
    this._assertLive()
    return this._revokeGuardAdmission(value)
  }

  _revokeGuardAdmission(value) {
    const state =
      value !== null && typeof value === 'object' ? this._guardAdmissions.get(value) : null
    if (!state) return false
    this._guardAdmissions.delete(value)
    this._guardAdmissionTokens.delete(value)
    this._completedGuardAdmissions.add(value)
    clearGuardAdmissionState(state)
    return true
  }

  isQuarantined(identity) {
    this._assertLive()
    const generation = this._generation
    const now = this._now()
    this._assertGeneration(generation)
    const key = length(identity) === 32 ? b4a.toString(identity, 'hex') : ''
    const until = this._quarantine.get(key)
    return until !== undefined && uint64(now) && until > now
  }

  diagnostics() {
    this._assertLive()
    const generation = this._generation
    const now = this._now()
    this._assertGeneration(generation)
    if (!uint64(now)) incompatible()
    this._expire(now)
    return Object.freeze({
      identities: this._identities.size,
      quarantined: this._quarantine.size,
      pending: this._pendingTokens.size + this._pendingReservations.size,
      validated: this._validatedTokens.size,
      guardAdmissions: this._guardAdmissionTokens.size + this._guardAdmissionReservations.size
    })
  }

  destroy() {
    if (this._destroyed) return
    this._destroyed = true
    this._generation = null
    for (const operation of this._validations) {
      if (operation.timer !== null) {
        try {
          this._clearTimer(operation.timer)
        } catch {}
      }
      operation.abort()
      operation.reject(PrivateRouteError.ERR_DESTROYED())
    }
    this._validations.clear()
    for (const pending of this._pendingTokens) this._cancelActiveChallenge(pending)
    for (const state of this._identities.values()) {
      clearCandidateState(state)
    }
    this._identities.clear()
    for (const history of this._history.values()) clearHistory(history)
    this._history.clear()
    this._quarantine.clear()
    for (const token of this._validatedTokens) clearValidatedState(this._validated.get(token))
    for (const token of this._guardAdmissionTokens) {
      clearGuardAdmissionState(this._guardAdmissions.get(token))
    }
    this._candidates = new WeakMap()
    this._pending = new WeakMap()
    this._pendingTokens.clear()
    this._pendingReservations.clear()
    this._completedPending = new WeakSet()
    this._validated = new WeakMap()
    this._validatedTokens.clear()
    this._completedValidated = new WeakSet()
    this._guardAdmissions = new WeakMap()
    this._guardAdmissionTokens.clear()
    this._guardAdmissionReservations.clear()
    this._completedGuardAdmissions = new WeakSet()
  }
}
