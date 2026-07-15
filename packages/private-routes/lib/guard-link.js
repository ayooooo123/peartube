import b4a from 'b4a'
import sodium from 'sodium-universal'

import { DatagramReplayWindow, OrderedReceiver, SenderCounter } from './counters.js'
import { cryptoSuite } from './crypto-suite.js'
import { PrivateRouteError } from './errors.js'
import { digestPayloadParameters } from './final-exit.js'
import {
  decodeCanonicalEndpoint,
  decodeRelayCapabilityAdvertisement,
  digestRelayCapabilityAdvertisement
} from './relay-capability.js'
import {
  BRANCH_CLASS,
  CELL_CLASS,
  DOMAIN,
  M3_LINK_ROLE,
  M3_MESSAGE_ID,
  M3_PROTOCOL_VERSION,
  decodeM3Object,
  encodeM3Object
} from './protocol.js'

export const LINK_OFFER_SIZE = 374
export const LINK_ACCEPT_SIZE = 285

const LINK_OFFER_BODY_SIZE = 302
const LINK_ACCEPT_BODY_SIZE = 213
const LINK_OFFER_DOMAIN = b4a.from('hyperdht-private-routes/m3/link-offer/v1')
const LINK_ACCEPT_DOMAIN = b4a.from('hyperdht-private-routes/m3/link-accept/v1')
const LINK_OFFER_DIGEST_DOMAIN = b4a.from('hyperdht-private-routes/m3/link-offer-digest/v1')
const LINK_ACCEPT_DIGEST_DOMAIN = b4a.from('hyperdht-private-routes/m3/link-accept-digest/v1')
const INITIATOR_CELL_ID_DOMAIN = b4a.from('hyperdht-private-routes/m3/cell-id/initiator/v1')
const RESPONDER_CELL_ID_DOMAIN = b4a.from('hyperdht-private-routes/m3/cell-id/responder/v1')
const MAX_U32 = 0xffff_ffff
const MAX_U64 = 0xffff_ffff_ffff_ffffn
const PENDING = new WeakMap()
const PENDING_TOKENS = new Set()
const SPENT = new WeakSet()
const ESTABLISHED = new WeakMap()
const SPENT_ESTABLISHED = new WeakSet()
const MAX_PENDING_OFFERS = 4096
const MAX_RESPONDER_REPLAYS = 4096

// Deep test import only. Synthetic states still pass through the production
// one-shot established-link adoption boundary.
export const TEST_ONLY_M3_ESTABLISHED_ISSUER = Object.freeze({
  issue(state) {
    const handle = Object.freeze({})
    ESTABLISHED.set(handle, { ...state })
    return handle
  }
})

const byteLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const setIntrinsic = Uint8Array.prototype.set
const subarrayIntrinsic = Uint8Array.prototype.subarray
const fillIntrinsic = Uint8Array.prototype.fill

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function authentication() {
  throw PrivateRouteError.ERR_AUTHENTICATION()
}

function replay() {
  throw PrivateRouteError.ERR_REPLAY()
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

function safe(value, name) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
    return value[name]
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  }
}

function exactKeys(value, expected) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const keys = Object.keys(value).sort()
    const wanted = [...expected].sort()
    return keys.length === wanted.length && keys.every((key, index) => key === wanted[index])
  } catch {
    return false
  }
}

function copy(value, size = length(value)) {
  if (!fixed(value, size)) invalid()
  const output = b4a.allocUnsafeSlow(size)
  setIntrinsic.call(output, value)
  return output
}

function subarray(value, start, end) {
  try {
    return subarrayIntrinsic.call(value, start, end)
  } catch {
    invalid()
  }
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) fillIntrinsic.call(value, 0)
  } catch {}
}

function equal(left, right) {
  try {
    return length(left) === length(right) && b4a.equals(left, right)
  } catch {
    return false
  }
}

function u32(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_U32
}

function u64(value) {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_U64
}

function nonzero(value) {
  if (length(value) < 1) return false
  for (const byte of value) if (byte !== 0) return true
  return false
}

function writeU16(output, value, offset) {
  output[offset] = value >>> 8
  output[offset + 1] = value
}

function writeU32(output, value, offset) {
  output[offset] = value >>> 24
  output[offset + 1] = value >>> 16
  output[offset + 2] = value >>> 8
  output[offset + 3] = value
}

function readU16(input, offset) {
  return (input[offset] << 8) | input[offset + 1]
}

function readU32(input, offset) {
  return (
    input[offset] * 0x1000000 +
    (input[offset + 1] << 16) +
    (input[offset + 2] << 8) +
    input[offset + 3]
  )
}

function writeU64(output, value, offset) {
  for (let index = offset + 7; index >= offset; index--) {
    output[index] = Number(value & 0xffn)
    value >>= 8n
  }
}

function readU64(input, offset) {
  let value = 0n
  for (let index = offset; index < offset + 8; index++) {
    value = (value << 8n) | BigInt(input[index])
  }
  return value
}

function signatureInput(domain, messageId, body) {
  const output = b4a.allocUnsafeSlow(2 + domain.byteLength + 8 + body.byteLength)
  writeU16(output, domain.byteLength, 0)
  setIntrinsic.call(output, domain, 2)
  writeU32(output, M3_PROTOCOL_VERSION, 2 + domain.byteLength)
  writeU16(output, messageId, 6 + domain.byteLength)
  writeU16(output, body.byteLength, 8 + domain.byteLength)
  setIntrinsic.call(output, body, 10 + domain.byteLength)
  return output
}

function digest(domain, bytes) {
  const domainLength = length(domain)
  if (domainLength < 0 || domainLength > 0xffff || length(bytes) < 0) invalid()
  const prefix = b4a.allocUnsafeSlow(2)
  try {
    writeU16(prefix, domainLength, 0)
    return cryptoSuite.hash([prefix, domain, bytes])
  } finally {
    clear(prefix)
  }
}

function cellIds(completeOfferDigest) {
  const initiator = digest(INITIATOR_CELL_ID_DOMAIN, completeOfferDigest)
  const responder = digest(RESPONDER_CELL_ID_DOMAIN, completeOfferDigest)
  try {
    return {
      initiatorCellId: copy(subarray(initiator, 0, 16), 16),
      responderCellId: copy(subarray(responder, 0, 16), 16)
    }
  } finally {
    clear(initiator)
    clear(responder)
  }
}

function encodeLimits(value) {
  const cellSize = safe(value, 'cellSize')
  const maxCells = safe(value, 'maxCells')
  const maxBytes = safe(value, 'maxBytes')
  const maxCommands = safe(value, 'maxCommands')
  const idleTimeoutMs = safe(value, 'idleTimeoutMs')
  const expiresAtMs = safe(value, 'expiresAtMs')
  if (
    cellSize !== 1200 ||
    !u32(maxCells) ||
    maxCells === 0 ||
    !u32(maxBytes) ||
    maxBytes === 0 ||
    !u32(maxCommands) ||
    maxCommands === 0 ||
    !u32(idleTimeoutMs) ||
    idleTimeoutMs === 0 ||
    !u64(expiresAtMs)
  ) {
    invalid()
  }
  const output = b4a.allocUnsafeSlow(26)
  writeU16(output, cellSize, 0)
  writeU32(output, maxCells, 2)
  writeU32(output, maxBytes, 6)
  writeU32(output, maxCommands, 10)
  writeU32(output, idleTimeoutMs, 14)
  writeU64(output, expiresAtMs, 18)
  return output
}

function decodeLimits(bytes) {
  if (!fixed(bytes, 26)) invalid()
  const value = {
    cellSize: readU16(bytes, 0),
    maxCells: readU32(bytes, 2),
    maxBytes: readU32(bytes, 6),
    maxCommands: readU32(bytes, 10),
    idleTimeoutMs: readU32(bytes, 14),
    expiresAtMs: readU64(bytes, 18)
  }
  encodeLimits(value)
  return value
}

function limitsWithin(admitted, requested) {
  return (
    admitted.cellSize === requested.cellSize &&
    admitted.maxCells <= requested.maxCells &&
    admitted.maxBytes <= requested.maxBytes &&
    admitted.maxCommands <= requested.maxCommands &&
    admitted.idleTimeoutMs <= requested.idleTimeoutMs &&
    admitted.expiresAtMs <= requested.expiresAtMs
  )
}

function limitsWithinAdvertisement(limits, advertisement, now) {
  return (
    limits.maxCells <= advertisement.maxCellsPerCircuit &&
    limits.maxBytes <= advertisement.maxBytesPerCircuit &&
    limits.maxCommands <= advertisement.maxCommandsPerCircuit &&
    limits.idleTimeoutMs <= advertisement.idleTimeoutMs &&
    limits.expiresAtMs <= advertisement.expiresAtMs &&
    limits.expiresAtMs <= now + 300_000n
  )
}

function clearPending(state) {
  if (!state) return
  clear(state.advertisementDigest)
  clear(state.ephemeralSecretKey)
  clearDecoded(state.offer)
}

function prunePending(now) {
  for (const token of PENDING_TOKENS) {
    const state = PENDING.get(token)
    if (state && state.offer.offerDeadlineMs > now) continue
    PENDING.delete(token)
    PENDING_TOKENS.delete(token)
    SPENT.add(token)
    clearPending(state)
  }
}

function decodeOffer(encoded) {
  const object = decodeM3Object(encoded)
  if (
    length(encoded) !== LINK_OFFER_SIZE ||
    object.messageId !== M3_MESSAGE_ID.LINK_OFFER_V1 ||
    length(object.body) !== LINK_OFFER_BODY_SIZE
  ) {
    invalid()
  }
  const body = object.body
  return {
    encoded: copy(encoded, LINK_OFFER_SIZE),
    body,
    signature: object.authSuffix,
    responderAdvertisementDigest: copy(subarray(body, 0, 32), 32),
    initiatorIdentity: copy(subarray(body, 32, 64), 32),
    responderIdentity: copy(subarray(body, 64, 96), 32),
    initiatorRole: body[96],
    responderRole: body[97],
    branchClass: body[98],
    branchId: copy(subarray(body, 99, 115), 16),
    circuitId: copy(subarray(body, 115, 131), 16),
    generation: readU64(body, 131),
    extensionIndex: body[139],
    initiatorLinkEphemeralPublicKey: copy(subarray(body, 140, 172), 32),
    clientTailEphemeralPublicKey: copy(subarray(body, 172, 204), 32),
    clientNonce: copy(subarray(body, 204, 236), 32),
    payloadParametersDigest: copy(subarray(body, 236, 268), 32),
    requestedLimits: decodeLimits(subarray(body, 268, 294)),
    offerDeadlineMs: readU64(body, 294)
  }
}

function decodeAccept(encoded) {
  const object = decodeM3Object(encoded)
  if (
    length(encoded) !== LINK_ACCEPT_SIZE ||
    object.messageId !== M3_MESSAGE_ID.LINK_ACCEPT_V1 ||
    length(object.body) !== LINK_ACCEPT_BODY_SIZE
  ) {
    invalid()
  }
  const body = object.body
  return {
    encoded: copy(encoded, LINK_ACCEPT_SIZE),
    body,
    signature: object.authSuffix,
    completeOfferDigest: copy(subarray(body, 0, 32), 32),
    responderAdvertisementDigest: copy(subarray(body, 32, 64), 32),
    responderIdentity: copy(subarray(body, 64, 96), 32),
    observedPredecessorEndpoint: copy(subarray(body, 96, 115), 19),
    responderLinkEphemeralPublicKey: copy(subarray(body, 115, 147), 32),
    admittedLimits: decodeLimits(subarray(body, 147, 173)),
    acceptedAtMs: readU64(body, 173),
    acceptNonce: copy(subarray(body, 181, 213), 32)
  }
}

function validOffer(offer, now) {
  const input = signatureInput(LINK_OFFER_DOMAIN, M3_MESSAGE_ID.LINK_OFFER_V1, offer.body)
  const signatureValid = cryptoSuite.verify(input, offer.signature, offer.initiatorIdentity)
  clear(input)
  if (
    !signatureValid ||
    offer.initiatorRole !== M3_LINK_ROLE.CLIENT ||
    offer.responderRole !== M3_LINK_ROLE.SAFETY_RELAY ||
    (offer.branchClass !== BRANCH_CLASS.LOOKUP && offer.branchClass !== BRANCH_CLASS.ANNOUNCE) ||
    offer.extensionIndex !== 0 ||
    offer.generation === 0n ||
    offer.offerDeadlineMs <= now ||
    offer.offerDeadlineMs > now + 5_000n ||
    offer.requestedLimits.expiresAtMs < offer.offerDeadlineMs ||
    equal(offer.initiatorIdentity, offer.responderIdentity) ||
    !nonzero(offer.branchId) ||
    !nonzero(offer.circuitId) ||
    !nonzero(offer.initiatorLinkEphemeralPublicKey) ||
    !nonzero(offer.clientTailEphemeralPublicKey) ||
    !nonzero(offer.clientNonce) ||
    !nonzero(offer.payloadParametersDigest)
  ) {
    authentication()
  }
}

function context(cellClass, key, noncePrefix, sender, now) {
  return {
    key: copy(key, 32),
    noncePrefix: copy(noncePrefix, 16),
    counter: sender
      ? new SenderCounter()
      : cellClass === CELL_CLASS.DATAGRAM
        ? new DatagramReplayWindow({ window: 256 })
        : new OrderedReceiver({ window: 256, gapTimeout: 5000, now })
  }
}

function deriveState(shared, offer, accept, initiator, physicalChannel, now) {
  const offerDigest = digest(LINK_OFFER_DIGEST_DOMAIN, offer.encoded)
  const acceptDigest = digest(LINK_ACCEPT_DIGEST_DOMAIN, accept.encoded)
  const ids = cellIds(offerDigest)
  const contexts = {}
  try {
    for (const cellClass of [CELL_CLASS.CONTROL, CELL_CLASS.STREAM, CELL_CLASS.DATAGRAM]) {
      const transcript = b4a.concat([
        DOMAIN.LINK_CREATED,
        offerDigest,
        acceptDigest,
        b4a.from([cellClass])
      ])
      const keys = cryptoSuite.deriveKeys(shared, transcript)
      try {
        contexts[cellClass] = {
          tx: context(
            cellClass,
            initiator ? keys.forwardKey : keys.reverseKey,
            initiator ? keys.forwardNoncePrefix : keys.reverseNoncePrefix,
            true,
            now
          ),
          rx: context(
            cellClass,
            initiator ? keys.reverseKey : keys.forwardKey,
            initiator ? keys.reverseNoncePrefix : keys.forwardNoncePrefix,
            false,
            now
          )
        }
      } finally {
        clear(keys.forwardKey)
        clear(keys.reverseKey)
        clear(keys.forwardNoncePrefix)
        clear(keys.reverseNoncePrefix)
        clear(transcript)
      }
    }
    return {
      initiator,
      completeOfferDigest: copy(offerDigest, 32),
      localId: copy(initiator ? ids.initiatorCellId : ids.responderCellId, 16),
      peerLocalId: copy(initiator ? ids.responderCellId : ids.initiatorCellId, 16),
      physicalChannel,
      localIdentity: copy(initiator ? offer.initiatorIdentity : offer.responderIdentity, 32),
      peerIdentity: copy(initiator ? offer.responderIdentity : offer.initiatorIdentity, 32),
      branchClass: offer.branchClass,
      branchId: copy(offer.branchId, 16),
      circuitId: copy(offer.circuitId, 16),
      generation: offer.generation,
      extensionIndex: 0,
      responderAdvertisementDigest: copy(offer.responderAdvertisementDigest, 32),
      clientTailEphemeralSecretKey: initiator ? copy(offer.clientTailEphemeralSecretKey, 32) : null,
      expiresAt: accept.admittedLimits.expiresAtMs,
      admittedLimits: accept.admittedLimits,
      contexts
    }
  } catch (err) {
    clearContexts(contexts)
    throw err
  } finally {
    clear(ids.initiatorCellId)
    clear(ids.responderCellId)
    clear(offerDigest)
    clear(acceptDigest)
  }
}

function establish(state) {
  const handle = Object.freeze({})
  ESTABLISHED.set(handle, state)
  return handle
}

function clearContexts(contexts) {
  for (const pair of Object.values(contexts || {})) {
    for (const value of [pair && pair.tx, pair && pair.rx]) {
      if (!value) continue
      clear(value.key)
      clear(value.noncePrefix)
      try {
        value.counter.destroy()
      } catch {}
    }
  }
}

function clearState(state) {
  if (!state) return
  const physicalChannel = state.physicalChannel
  clear(state.localIdentity)
  clear(state.peerIdentity)
  clear(state.completeOfferDigest)
  clear(state.localId)
  clear(state.peerLocalId)
  clear(state.branchId)
  clear(state.circuitId)
  clear(state.responderAdvertisementDigest)
  clear(state.clientTailEphemeralSecretKey)
  clearContexts(state.contexts)
  state.physicalChannel = null
  try {
    if (physicalChannel && typeof physicalChannel.destroy === 'function') physicalChannel.destroy()
  } catch {}
}

function clearDecoded(value) {
  if (!value) return
  for (const entry of Object.values(value)) clear(entry)
}

export function createIndexZeroGuardLinkOffer(options = {}) {
  let advertisement = null
  let branchId = null
  let circuitId = null
  let clientPublicKey = null
  let clientSecretKey = null
  let clientTailEphemeralPublicKey = null
  let clientTailEphemeralSecretKey = null
  let payloadParametersDigest = null
  let requestedLimits = null
  let decodedAdvertisement = null
  let advertisementDigest = null
  let seed = null
  let pair = null
  let clientNonce = null
  let body = null
  let input = null
  let signature = null
  let pending = null
  let installed = false
  let complete = false
  try {
    advertisement = copy(safe(options, 'advertisement'))
    const now = safe(options, 'now')
    const randomBytes = safe(options, 'randomBytes') || cryptoSuite.randomBytes
    const branchClass = safe(options, 'branchClass')
    branchId = copy(safe(options, 'branchId'), 16)
    circuitId = copy(safe(options, 'circuitId'), 16)
    const generation = safe(options, 'generation')
    const client = safe(options, 'clientCircuitIdentity')
    clientPublicKey = copy(safe(client, 'publicKey'), 32)
    clientSecretKey = copy(safe(client, 'secretKey'), 64)
    const clientTailEphemeral = safe(options, 'clientTailEphemeral')
    clientTailEphemeralPublicKey = copy(safe(clientTailEphemeral, 'publicKey'), 32)
    clientTailEphemeralSecretKey = copy(safe(clientTailEphemeral, 'secretKey'), 32)
    payloadParametersDigest = copy(safe(options, 'payloadParametersDigest'), 32)
    requestedLimits = encodeLimits(safe(options, 'requestedLimits'))
    if (
      !u64(now) ||
      (branchClass !== BRANCH_CLASS.LOOKUP && branchClass !== BRANCH_CLASS.ANNOUNCE) ||
      !u64(generation) ||
      generation === 0n ||
      typeof randomBytes !== 'function'
    ) {
      invalid()
    }
    decodedAdvertisement = decodeRelayCapabilityAdvertisement(advertisement, { now })
    advertisementDigest = digestRelayCapabilityAdvertisement(advertisement, { now })
    seed = copy(randomBytes(32), 32)
    pair = cryptoSuite.encryptionKeyPair(seed)
    clientNonce = copy(randomBytes(32), 32)
    let deadline = now + 5_000n
    const limits = decodeLimits(requestedLimits)
    if (!limitsWithinAdvertisement(limits, decodedAdvertisement, now)) invalid()
    if (limits.expiresAtMs < deadline) deadline = limits.expiresAtMs
    if (decodedAdvertisement.expiresAtMs < deadline) deadline = decodedAdvertisement.expiresAtMs
    if (deadline <= now) invalid()
    body = b4a.allocUnsafeSlow(LINK_OFFER_BODY_SIZE)
    setIntrinsic.call(body, advertisementDigest, 0)
    setIntrinsic.call(body, clientPublicKey, 32)
    setIntrinsic.call(body, decodedAdvertisement.relayIdentity, 64)
    body[96] = M3_LINK_ROLE.CLIENT
    body[97] = M3_LINK_ROLE.SAFETY_RELAY
    body[98] = branchClass
    setIntrinsic.call(body, branchId, 99)
    setIntrinsic.call(body, circuitId, 115)
    writeU64(body, generation, 131)
    body[139] = 0
    setIntrinsic.call(body, pair.publicKey, 140)
    setIntrinsic.call(body, clientTailEphemeralPublicKey, 172)
    setIntrinsic.call(body, clientNonce, 204)
    setIntrinsic.call(body, payloadParametersDigest, 236)
    setIntrinsic.call(body, requestedLimits, 268)
    writeU64(body, deadline, 294)
    input = signatureInput(LINK_OFFER_DOMAIN, M3_MESSAGE_ID.LINK_OFFER_V1, body)
    signature = cryptoSuite.sign(input, clientSecretKey)
    const offer = encodeM3Object({
      messageId: M3_MESSAGE_ID.LINK_OFFER_V1,
      body,
      authSuffix: signature
    })
    pending = Object.freeze({})
    prunePending(now)
    if (PENDING_TOKENS.size >= MAX_PENDING_OFFERS) throw PrivateRouteError.ERR_BUSY()
    PENDING.set(pending, {
      advertisementDigest: copy(advertisementDigest, 32),
      ephemeralSecretKey: copy(pair.secretKey, 32),
      offer: {
        ...decodeOffer(offer),
        clientTailEphemeralSecretKey: copy(clientTailEphemeralSecretKey, 32)
      }
    })
    PENDING_TOKENS.add(pending)
    installed = true
    complete = true
    return Object.freeze({ offer, pending })
  } finally {
    if (installed && !complete) abortIndexZeroGuardLink(pending)
    clear(advertisement)
    clear(branchId)
    clear(circuitId)
    clear(clientPublicKey)
    clear(clientSecretKey)
    clear(clientTailEphemeralPublicKey)
    clear(clientTailEphemeralSecretKey)
    clear(payloadParametersDigest)
    clear(requestedLimits)
    clearDecoded(decodedAdvertisement)
    clear(advertisementDigest)
    clear(seed)
    clear(pair && pair.publicKey)
    clear(pair && pair.secretKey)
    clear(clientNonce)
    clear(body)
    clear(input)
    clear(signature)
  }
}

function receiveGuardOffer(receiveOffer) {
  let physicalChannel = null
  try {
    const received = receiveOffer()
    physicalChannel = safe(received, 'physicalChannel')
    if (
      physicalChannel === null ||
      typeof physicalChannel !== 'object' ||
      typeof physicalChannel.destroy !== 'function'
    ) {
      invalid()
    }
    if (!exactKeys(received, ['offer', 'observedPredecessorEndpoint', 'physicalChannel'])) {
      invalid()
    }
    const result = {
      offer: copy(safe(received, 'offer'), LINK_OFFER_SIZE),
      observedPredecessorEndpoint: decodeCanonicalEndpoint(
        safe(received, 'observedPredecessorEndpoint')
      ),
      physicalChannel
    }
    physicalChannel = null
    return result
  } finally {
    try {
      if (physicalChannel) physicalChannel.destroy()
    } catch {}
  }
}

export function createIndexZeroGuardLinkResponder({
  advertisement,
  responderIdentitySecretKey,
  responderRouteEncryptionSecretKey,
  now,
  receiveOffer,
  randomBytes = cryptoSuite.randomBytes
} = {}) {
  if (
    typeof now !== 'function' ||
    typeof receiveOffer !== 'function' ||
    typeof randomBytes !== 'function'
  ) {
    invalid()
  }
  let advertisementBytes = null
  let responderSecretKey = null
  let responderRouteSecretKey = null
  let decodedAdvertisement = null
  let identitySeed = null
  let identityPair = null
  let routePublicKey = null
  try {
    advertisementBytes = copy(advertisement)
    responderSecretKey = copy(responderIdentitySecretKey, 64)
    responderRouteSecretKey = copy(responderRouteEncryptionSecretKey, 32)
    const current = now()
    if (!u64(current)) invalid()
    decodedAdvertisement = decodeRelayCapabilityAdvertisement(advertisementBytes, {
      now: current
    })
    identitySeed = copy(subarray(responderSecretKey, 0, 32), 32)
    identityPair = cryptoSuite.keyPair(identitySeed)
    routePublicKey = b4a.allocUnsafeSlow(32)
    sodium.crypto_scalarmult_base(routePublicKey, responderRouteSecretKey)
    if (
      !equal(identityPair.publicKey, decodedAdvertisement.relayIdentity) ||
      !equal(routePublicKey, decodedAdvertisement.routeEncryptionPublicKey)
    ) {
      authentication()
    }
  } catch (err) {
    clear(advertisementBytes)
    clear(responderSecretKey)
    clear(responderRouteSecretKey)
    throw err
  } finally {
    clearDecoded(decodedAdvertisement)
    clear(identitySeed)
    clear(identityPair && identityPair.secretKey)
    clear(identityPair && identityPair.publicKey)
    clear(routePublicKey)
  }
  const replayCache = new Map()
  let isDestroyed = false
  let generation = Object.freeze({})
  const assertGeneration = (operationGeneration) => {
    if (isDestroyed || generation !== operationGeneration) {
      throw PrivateRouteError.ERR_DESTROYED()
    }
  }
  return Object.freeze({
    accept() {
      if (isDestroyed) throw PrivateRouteError.ERR_DESTROYED()
      const operationGeneration = generation
      let received = null
      let physicalChannel = null
      let offer = null
      let advertisementDigest = null
      let decodedAdvertisement = null
      let offerDigest = null
      let expectedParametersDigest = null
      let seed = null
      let pair = null
      let acceptNonce = null
      let admittedLimits = null
      let body = null
      let input = null
      let signature = null
      let shared = null
      let tailShared = null
      let decodedAccept = null
      let replayKey = null
      let replayReservation = null
      let replayCommitted = false
      let randomScratch = null
      let derivedState = null
      try {
        const current = now()
        assertGeneration(operationGeneration)
        if (!u64(current)) invalid()
        received = receiveGuardOffer(receiveOffer)
        assertGeneration(operationGeneration)
        physicalChannel = received.physicalChannel
        offer = decodeOffer(received.offer)
        validOffer(offer, current)
        decodedAdvertisement = decodeRelayCapabilityAdvertisement(advertisementBytes, {
          now: current
        })
        advertisementDigest = digestRelayCapabilityAdvertisement(advertisementBytes, {
          now: current
        })
        expectedParametersDigest = digestPayloadParameters(decodedAdvertisement)
        offerDigest = digest(LINK_OFFER_DIGEST_DOMAIN, offer.encoded)
        replayKey = b4a.toString(offerDigest, 'hex')
        for (const [key, reservation] of replayCache) {
          if (reservation.expiresAt <= current) replayCache.delete(key)
        }
        if (replayCache.has(replayKey)) replay()
        if (replayCache.size >= MAX_RESPONDER_REPLAYS) throw PrivateRouteError.ERR_BUSY()
        if (
          !equal(offer.responderIdentity, decodedAdvertisement.relayIdentity) ||
          !equal(offer.responderAdvertisementDigest, advertisementDigest) ||
          !equal(offer.payloadParametersDigest, expectedParametersDigest)
        ) {
          authentication()
        }
        if (!limitsWithinAdvertisement(offer.requestedLimits, decodedAdvertisement, current)) {
          authentication()
        }
        replayReservation = {
          completed: false,
          expiresAt: offer.offerDeadlineMs
        }
        replayCache.set(replayKey, replayReservation)
        tailShared = cryptoSuite.keyAgreement(
          responderRouteSecretKey,
          offer.clientTailEphemeralPublicKey
        )
        randomScratch = randomBytes(32)
        assertGeneration(operationGeneration)
        seed = copy(randomScratch, 32)
        clear(randomScratch)
        randomScratch = null
        pair = cryptoSuite.encryptionKeyPair(seed)
        randomScratch = randomBytes(32)
        assertGeneration(operationGeneration)
        acceptNonce = copy(randomScratch, 32)
        clear(randomScratch)
        randomScratch = null
        admittedLimits = encodeLimits(offer.requestedLimits)
        body = b4a.allocUnsafeSlow(LINK_ACCEPT_BODY_SIZE)
        setIntrinsic.call(body, offerDigest, 0)
        setIntrinsic.call(body, advertisementDigest, 32)
        setIntrinsic.call(body, decodedAdvertisement.relayIdentity, 64)
        setIntrinsic.call(body, received.observedPredecessorEndpoint, 96)
        setIntrinsic.call(body, pair.publicKey, 115)
        setIntrinsic.call(body, admittedLimits, 147)
        writeU64(body, current, 173)
        setIntrinsic.call(body, acceptNonce, 181)
        input = signatureInput(LINK_ACCEPT_DOMAIN, M3_MESSAGE_ID.LINK_ACCEPT_V1, body)
        signature = cryptoSuite.sign(input, responderSecretKey)
        const accept = encodeM3Object({
          messageId: M3_MESSAGE_ID.LINK_ACCEPT_V1,
          body,
          authSuffix: signature
        })
        decodedAccept = decodeAccept(accept)
        shared = cryptoSuite.keyAgreement(pair.secretKey, offer.initiatorLinkEphemeralPublicKey)
        assertGeneration(operationGeneration)
        if (replayCache.get(replayKey) !== replayReservation) replay()
        derivedState = deriveState(shared, offer, decodedAccept, false, physicalChannel, now)
        physicalChannel = null
        assertGeneration(operationGeneration)
        if (replayCache.get(replayKey) !== replayReservation) replay()
        const established = establish(derivedState)
        derivedState = null
        replayReservation.completed = true
        replayCommitted = true
        return Object.freeze({ accept, established })
      } finally {
        if (
          replayReservation &&
          !replayCommitted &&
          replayCache.get(replayKey) === replayReservation
        ) {
          replayCache.delete(replayKey)
        }
        try {
          if (physicalChannel) physicalChannel.destroy()
        } catch {}
        clear(received && received.offer)
        clear(received && received.observedPredecessorEndpoint)
        clearDecoded(offer)
        clearDecoded(decodedAdvertisement)
        clear(advertisementDigest)
        clear(offerDigest)
        clear(expectedParametersDigest)
        clear(seed)
        clear(pair && pair.publicKey)
        clear(pair && pair.secretKey)
        clear(acceptNonce)
        clear(admittedLimits)
        clear(body)
        clear(input)
        clear(signature)
        clear(shared)
        clear(tailShared)
        clearDecoded(decodedAccept)
        clear(randomScratch)
        clearState(derivedState)
      }
    },
    destroy() {
      if (isDestroyed) return false
      isDestroyed = true
      generation = null
      clear(advertisementBytes)
      clear(responderSecretKey)
      clear(responderRouteSecretKey)
      replayCache.clear()
      return true
    }
  })
}

export function completeIndexZeroGuardLink(
  pending,
  encodedAccept,
  { advertisement, physicalChannel, now } = {}
) {
  const ownsPhysical =
    physicalChannel !== null &&
    typeof physicalChannel === 'object' &&
    typeof physicalChannel.destroy === 'function'
  const state = pending !== null && typeof pending === 'object' ? PENDING.get(pending) : null
  if (!state) {
    try {
      if (ownsPhysical) physicalChannel.destroy()
    } catch {}
    if (pending !== null && typeof pending === 'object' && SPENT.has(pending)) replay()
    authentication()
  }
  PENDING.delete(pending)
  PENDING_TOKENS.delete(pending)
  SPENT.add(pending)
  let accept = null
  let shared = null
  let advertisementBytes = null
  let advertisementDigest = null
  let offerDigest = null
  let input = null
  let transferred = false
  try {
    if (!u64(now) || !ownsPhysical) invalid()
    advertisementBytes = copy(advertisement)
    advertisementDigest = digestRelayCapabilityAdvertisement(advertisementBytes, { now })
    accept = decodeAccept(encodedAccept)
    offerDigest = digest(LINK_OFFER_DIGEST_DOMAIN, state.offer.encoded)
    input = signatureInput(LINK_ACCEPT_DOMAIN, M3_MESSAGE_ID.LINK_ACCEPT_V1, accept.body)
    const validSignature = cryptoSuite.verify(
      input,
      accept.signature,
      state.offer.responderIdentity
    )
    if (
      !validSignature ||
      !equal(accept.completeOfferDigest, offerDigest) ||
      !equal(accept.responderAdvertisementDigest, state.advertisementDigest) ||
      !equal(accept.responderAdvertisementDigest, advertisementDigest) ||
      !equal(accept.responderIdentity, state.offer.responderIdentity) ||
      !nonzero(accept.observedPredecessorEndpoint) ||
      accept.acceptedAtMs > state.offer.offerDeadlineMs ||
      accept.acceptedAtMs > now ||
      now >= state.offer.offerDeadlineMs ||
      !limitsWithin(accept.admittedLimits, state.offer.requestedLimits) ||
      accept.admittedLimits.expiresAtMs <= now ||
      !nonzero(accept.responderLinkEphemeralPublicKey) ||
      !nonzero(accept.acceptNonce)
    ) {
      authentication()
    }
    shared = cryptoSuite.keyAgreement(
      state.ephemeralSecretKey,
      accept.responderLinkEphemeralPublicKey
    )
    const established = establish(
      deriveState(shared, state.offer, accept, true, physicalChannel, () => Number(now))
    )
    transferred = true
    return established
  } finally {
    if (!transferred && ownsPhysical) {
      try {
        physicalChannel.destroy()
      } catch {}
    }
    clear(advertisementBytes)
    clear(advertisementDigest)
    clear(offerDigest)
    clear(input)
    clear(shared)
    clearPending(state)
    clearDecoded(accept)
  }
}

export function abortIndexZeroGuardLink(pending) {
  const state = pending !== null && typeof pending === 'object' ? PENDING.get(pending) : null
  if (!state) return false
  PENDING.delete(pending)
  PENDING_TOKENS.delete(pending)
  SPENT.add(pending)
  clearPending(state)
  return true
}

export function readM3EstablishedLink(value) {
  const state = value !== null && typeof value === 'object' ? ESTABLISHED.get(value) : null
  if (!state) authentication()
  return state
}

export function destroyM3EstablishedLink(value) {
  const state = value !== null && typeof value === 'object' ? ESTABLISHED.get(value) : null
  if (!state) return false
  ESTABLISHED.delete(value)
  SPENT_ESTABLISHED.add(value)
  clearState(state)
  return true
}

// Deep production import used only by M3AdjacencyAuthority. Ownership moves
// out of guard-link exactly once; callers cannot inspect or reuse the handle.
export function takeM3EstablishedLink(value) {
  const state = value !== null && typeof value === 'object' ? ESTABLISHED.get(value) : null
  if (!state) {
    if (value !== null && typeof value === 'object' && SPENT_ESTABLISHED.has(value)) replay()
    authentication()
  }
  ESTABLISHED.delete(value)
  SPENT_ESTABLISHED.add(value)
  return state
}

// Deep production import used when adoption fails after the one-shot take.
export function destroyTakenM3EstablishedLink(state) {
  if (state === null || typeof state !== 'object') return false
  clearState(state)
  return true
}
