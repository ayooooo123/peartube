import b4a from 'b4a'

import { DatagramReplayWindow, OrderedReceiver, SenderCounter } from './counters.js'
import { cryptoSuite } from './crypto-suite.js'
import { PrivateRouteError } from './errors.js'
import { CELL_CLASS, DOMAIN, PROTOCOL_VERSION } from './protocol.js'

export const LINK_CREATE_SIZE = 273
export const LINK_CREATED_SIZE = 337

// Imported only by this module's tests. Production code receives opaque tickets.
export const TEST_ONLY_TICKET_OBSERVER = Symbol('test-only-ticket-observer')

const MAX_U64 = 0xffff_ffff_ffff_ffffn
const MAX_REPLAYS = 4096
const CHECKERS = new WeakSet()
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const bufferArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get
const bufferByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get
const bufferByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get
const bufferSet = Uint8Array.prototype.set
const bufferFill = Uint8Array.prototype.fill
const bufferSubarray = Uint8Array.prototype.subarray

function unauthorized() {
  throw PrivateRouteError.UNAUTHORIZED()
}

function invalidRoute() {
  throw PrivateRouteError.INVALID_ROUTE()
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
    invalidRoute()
  }
}

function bufferLength(value) {
  try {
    return b4a.isBuffer(value) ? bufferByteLength.call(value) : -1
  } catch {
    return -1
  }
}

function fixed(value, size) {
  return bufferLength(value) === size
}

function u64(value) {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_U64
}

function copyBuffer(value) {
  const copy = b4a.allocUnsafeSlow(bufferLength(value))
  bufferSet.call(copy, value)
  return copy
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) bufferFill.call(value, 0)
  } catch {
    // Best-effort zeroization only.
  }
}

function overlaps(left, right) {
  if (!b4a.isBuffer(left) || !b4a.isBuffer(right)) return false
  try {
    if (bufferArrayBuffer.call(left) !== bufferArrayBuffer.call(right)) return false
    const leftStart = bufferByteOffset.call(left)
    const leftEnd = leftStart + bufferLength(left)
    const rightStart = bufferByteOffset.call(right)
    const rightEnd = rightStart + bufferLength(right)
    return leftStart < rightEnd && rightStart < leftEnd
  } catch {
    return false
  }
}

function clearAdapterOutput(value, inputs) {
  if (!inputs.some((input) => overlaps(value, input))) clear(value)
}

function aliasesInput(value, inputs) {
  return inputs.some((input) => overlaps(value, input))
}

function same(left, right) {
  try {
    return fixed(left, bufferLength(right)) && b4a.equals(left, right)
  } catch {
    return false
  }
}

function writeU64(buffer, value, offset) {
  for (let index = offset + 7; index >= offset; index--) {
    buffer[index] = Number(value & 0xffn)
    value >>= 8n
  }
}

function readU64(buffer, offset) {
  let value = 0n
  for (let index = offset; index < offset + 8; index++) {
    value = (value << 8n) | BigInt(buffer[index])
  }
  return value
}

function encodeFields(value, fields, size) {
  if (!safeObject(value)) invalidRoute()
  const output = b4a.allocUnsafeSlow(size)
  let offset = 0

  for (const [name, bytes] of fields) {
    const field = option(value, name)
    if (bytes === 0) {
      if (!u64(field)) invalidRoute()
      writeU64(output, field, offset)
      offset += 8
    } else if (bytes === 1) {
      if (field !== PROTOCOL_VERSION) invalidRoute()
      output[offset++] = field
    } else {
      if (!fixed(field, bytes)) invalidRoute()
      bufferSet.call(output, field, offset)
      offset += bytes
    }
  }

  return output
}

function decodeFields(message, fields, size) {
  if (!fixed(message, size)) invalidRoute()
  const value = {}
  let offset = 0

  for (const [name, bytes] of fields) {
    if (bytes === 0) {
      value[name] = readU64(message, offset)
      offset += 8
    } else if (bytes === 1) {
      value[name] = message[offset++]
    } else {
      value[name] = copyBuffer(bufferSubarray.call(message, offset, offset + bytes))
      offset += bytes
    }
  }

  if (value.version !== PROTOCOL_VERSION) invalidRoute()
  return value
}

const CREATE_FIELDS = Object.freeze([
  ['version', 1],
  ['circuitId', 16],
  ['epoch', 0],
  ['initiatorIdentity', 32],
  ['responderIdentity', 32],
  ['initiatorLocalId', 16],
  ['responderLocalId', 16],
  ['initiatorEphemeralKey', 32],
  ['expiresAt', 0],
  ['staticChallengeCipher', 48],
  ['initiatorIdentitySignature', 64]
])

const CREATED_FIELDS = Object.freeze([
  ['version', 1],
  ['circuitId', 16],
  ['epoch', 0],
  ['initiatorIdentity', 32],
  ['responderIdentity', 32],
  ['initiatorLocalId', 16],
  ['responderLocalId', 16],
  ['initiatorEphemeralKey', 32],
  ['responderEphemeralKey', 32],
  ['createHash', 32],
  ['challengeHash', 32],
  ['expiresAt', 0],
  ['staticPossessionTag', 16],
  ['responderIdentitySignature', 64]
])

export function encodeLinkCreate(value) {
  return encodeFields(value, CREATE_FIELDS, LINK_CREATE_SIZE)
}

export function decodeLinkCreate(message) {
  return decodeFields(message, CREATE_FIELDS, LINK_CREATE_SIZE)
}

export function encodeLinkCreated(value) {
  return encodeFields(value, CREATED_FIELDS, LINK_CREATED_SIZE)
}

export function decodeLinkCreated(message) {
  return decodeFields(message, CREATED_FIELDS, LINK_CREATED_SIZE)
}

function createBase(value) {
  return encodeFields(value, CREATE_FIELDS.slice(0, 9), 161)
}

function createUnsigned(value) {
  return encodeFields(value, CREATE_FIELDS.slice(0, 10), 209)
}

function createdUnsigned(value) {
  return encodeFields(value, CREATED_FIELDS.slice(0, 12), 257)
}

function hash(crypto, parts) {
  let value = null
  try {
    value = crypto.hash(parts)
    if (!fixed(value, 32)) invalidRoute()
    if (aliasesInput(value, parts)) invalidRoute()
    return copyBuffer(value)
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalidRoute()
  } finally {
    clearAdapterOutput(value, parts)
  }
}

function derive(crypto, sharedSecret, transcript) {
  let value = null
  let forwardKey = null
  let reverseKey = null
  let forwardNoncePrefix = null
  let reverseNoncePrefix = null
  let ownedForwardKey = null
  let ownedReverseKey = null
  let ownedForwardNoncePrefix = null
  let ownedReverseNoncePrefix = null
  let transferred = false
  try {
    value = crypto.deriveKeys(sharedSecret, transcript)
    if (!safeObject(value)) invalidRoute()
    forwardKey = option(value, 'forwardKey')
    reverseKey = option(value, 'reverseKey')
    forwardNoncePrefix = option(value, 'forwardNoncePrefix')
    reverseNoncePrefix = option(value, 'reverseNoncePrefix')
    if (
      !fixed(forwardKey, 32) ||
      !fixed(reverseKey, 32) ||
      !fixed(forwardNoncePrefix, 16) ||
      !fixed(reverseNoncePrefix, 16)
    ) {
      invalidRoute()
    }
    ownedForwardKey = copyBuffer(forwardKey)
    ownedReverseKey = copyBuffer(reverseKey)
    ownedForwardNoncePrefix = copyBuffer(forwardNoncePrefix)
    ownedReverseNoncePrefix = copyBuffer(reverseNoncePrefix)
    transferred = true
    return {
      forwardKey: ownedForwardKey,
      reverseKey: ownedReverseKey,
      forwardNoncePrefix: ownedForwardNoncePrefix,
      reverseNoncePrefix: ownedReverseNoncePrefix
    }
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalidRoute()
  } finally {
    const inputs = [sharedSecret, transcript]
    clearAdapterOutput(forwardKey, inputs)
    clearAdapterOutput(reverseKey, inputs)
    clearAdapterOutput(forwardNoncePrefix, inputs)
    clearAdapterOutput(reverseNoncePrefix, inputs)
    if (!transferred) {
      clear(ownedForwardKey)
      clear(ownedReverseKey)
      clear(ownedForwardNoncePrefix)
      clear(ownedReverseNoncePrefix)
    }
  }
}

function challengeCipher(crypto, sharedSecret, baseHash, challenge) {
  const transcript = b4a.concat([DOMAIN.LINK_CREATE, baseHash])
  const keys = derive(crypto, sharedSecret, transcript)
  let cipher = null
  try {
    cipher = crypto.seal({
      key: keys.forwardKey,
      noncePrefix: keys.forwardNoncePrefix,
      counter: 0n,
      associatedData: baseHash,
      plaintext: challenge
    })
    if (!fixed(cipher, 48)) invalidRoute()
    return copyBuffer(cipher)
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalidRoute()
  } finally {
    clear(keys.forwardKey)
    clear(keys.reverseKey)
    clear(keys.forwardNoncePrefix)
    clear(keys.reverseNoncePrefix)
    clear(transcript)
    clear(cipher)
  }
}

export function linkChallengeCipher(sharedSecret, baseHash, challenge) {
  if (!fixed(sharedSecret, 32) || !fixed(baseHash, 32) || !fixed(challenge, 32)) invalidRoute()
  return challengeCipher(cryptoSuite, sharedSecret, baseHash, challenge)
}

function possessionTag(crypto, sharedSecret, baseHash, challenge, createHash) {
  const transcript = b4a.concat([DOMAIN.LINK_CREATE, baseHash])
  const associatedData = b4a.concat([hash(crypto, [challenge]), createHash])
  const keys = derive(crypto, sharedSecret, transcript)
  let tag = null
  try {
    tag = crypto.seal({
      key: keys.reverseKey,
      noncePrefix: keys.reverseNoncePrefix,
      counter: 1n,
      associatedData,
      plaintext: b4a.alloc(0)
    })
    if (!fixed(tag, 16)) invalidRoute()
    return copyBuffer(tag)
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalidRoute()
  } finally {
    clear(keys.forwardKey)
    clear(keys.reverseKey)
    clear(keys.forwardNoncePrefix)
    clear(keys.reverseNoncePrefix)
    clear(transcript)
    clear(associatedData)
    clear(tag)
  }
}

export function linkPossessionTag(sharedSecret, baseHash, challenge, createHash) {
  if (
    !fixed(sharedSecret, 32) ||
    !fixed(baseHash, 32) ||
    !fixed(challenge, 32) ||
    !fixed(createHash, 32)
  ) {
    invalidRoute()
  }
  return possessionTag(cryptoSuite, sharedSecret, baseHash, challenge, createHash)
}

function nowValue(now) {
  let value
  try {
    value = now()
  } catch {
    invalidRoute()
  }
  if (!Number.isSafeInteger(value) || value < 0) invalidRoute()
  return BigInt(value)
}

function validateCommon(value) {
  if (
    !safeObject(value) ||
    !fixed(option(value, 'circuitId'), 16) ||
    !u64(option(value, 'epoch')) ||
    !fixed(option(value, 'initiatorIdentity'), 32) ||
    !fixed(option(value, 'responderIdentity'), 32) ||
    !fixed(option(value, 'initiatorLocalId'), 16) ||
    !fixed(option(value, 'responderLocalId'), 16) ||
    !u64(option(value, 'expiresAt'))
  ) {
    invalidRoute()
  }
}

function matchesCommon(message, expected) {
  return (
    same(message.circuitId, expected.circuitId) &&
    message.epoch === expected.epoch &&
    same(message.initiatorIdentity, expected.initiatorIdentity) &&
    same(message.responderIdentity, expected.responderIdentity) &&
    same(message.initiatorLocalId, expected.initiatorLocalId) &&
    same(message.responderLocalId, expected.responderLocalId) &&
    message.expiresAt === expected.expiresAt
  )
}

function verify(crypto, message, signature, publicKey) {
  try {
    return crypto.verify(message, signature, publicKey) === true
  } catch {
    return false
  }
}

function sign(crypto, message, secretKey) {
  let signature = null
  try {
    signature = crypto.sign(message, secretKey)
    if (!fixed(signature, 64)) invalidRoute()
    if (aliasesInput(signature, [message, secretKey])) invalidRoute()
    return copyBuffer(signature)
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalidRoute()
  } finally {
    clearAdapterOutput(signature, [message, secretKey])
  }
}

function agreement(crypto, secretKey, publicKey) {
  let shared = null
  try {
    shared = crypto.keyAgreement(secretKey, publicKey)
    if (!fixed(shared, 32)) unauthorized()
    if (aliasesInput(shared, [secretKey, publicKey])) unauthorized()
    return copyBuffer(shared)
  } catch {
    unauthorized()
  } finally {
    clearAdapterOutput(shared, [secretKey, publicKey])
  }
}

function ephemeral(crypto, randomBytes) {
  let seed = null
  let pair = null
  let publicKey = null
  let secretKey = null
  try {
    seed = randomBytes(32)
    if (!fixed(seed, 32)) invalidRoute()
    pair = crypto.encryptionKeyPair(seed)
    if (!safeObject(pair)) invalidRoute()
    publicKey = option(pair, 'publicKey')
    secretKey = option(pair, 'secretKey')
    if (!fixed(publicKey, 32) || !fixed(secretKey, 32)) invalidRoute()
    return { publicKey: copyBuffer(publicKey), secretKey: copyBuffer(secretKey) }
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalidRoute()
  } finally {
    clearAdapterOutput(publicKey, [seed])
    clearAdapterOutput(secretKey, [seed])
    clear(seed)
  }
}

function counterContext(cellClass, key, noncePrefix, sender, now) {
  return {
    key: copyBuffer(key),
    noncePrefix: copyBuffer(noncePrefix),
    counter: sender
      ? new SenderCounter()
      : cellClass === CELL_CLASS.DATAGRAM
        ? new DatagramReplayWindow({ window: 256 })
        : new OrderedReceiver({ window: 256, gapTimeout: 5000, now })
  }
}

function ticketState(crypto, shared, createHash, createdHash, common, initiator, now) {
  const contexts = {}

  for (const cellClass of [CELL_CLASS.CONTROL, CELL_CLASS.STREAM, CELL_CLASS.DATAGRAM]) {
    const transcript = b4a.concat([
      DOMAIN.LINK_CREATED,
      createHash,
      createdHash,
      b4a.from([cellClass])
    ])
    const keys = derive(crypto, shared, transcript)
    try {
      contexts[cellClass] = {
        tx: counterContext(
          cellClass,
          initiator ? keys.forwardKey : keys.reverseKey,
          initiator ? keys.forwardNoncePrefix : keys.reverseNoncePrefix,
          true,
          now
        ),
        rx: counterContext(
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
    circuitId: copyBuffer(common.circuitId),
    epoch: common.epoch,
    localIdentity: copyBuffer(initiator ? common.initiatorIdentity : common.responderIdentity),
    peerIdentity: copyBuffer(initiator ? common.responderIdentity : common.initiatorIdentity),
    localId: copyBuffer(initiator ? common.initiatorLocalId : common.responderLocalId),
    peerLocalId: copyBuffer(initiator ? common.responderLocalId : common.initiatorLocalId),
    expiresAt: common.expiresAt,
    contexts
  }
}

function observeState(state, now) {
  const contexts = {}
  for (const cellClass of [CELL_CLASS.CONTROL, CELL_CLASS.STREAM, CELL_CLASS.DATAGRAM]) {
    contexts[cellClass] = {
      tx: counterContext(
        cellClass,
        state.contexts[cellClass].tx.key,
        state.contexts[cellClass].tx.noncePrefix,
        true,
        now
      ),
      rx: counterContext(
        cellClass,
        state.contexts[cellClass].rx.key,
        state.contexts[cellClass].rx.noncePrefix,
        false,
        now
      )
    }
  }
  return {
    circuitId: copyBuffer(state.circuitId),
    epoch: state.epoch,
    localIdentity: copyBuffer(state.localIdentity),
    peerIdentity: copyBuffer(state.peerIdentity),
    localId: copyBuffer(state.localId),
    peerLocalId: copyBuffer(state.peerLocalId),
    expiresAt: state.expiresAt,
    contexts
  }
}

export function createLinkSetupAuthority(options = {}) {
  if (!safeObject(options)) invalidRoute()
  const crypto = option(options, 'crypto') || cryptoSuite
  const now = option(options, 'now')
  let randomBytes = option(options, 'randomBytes')
  if (randomBytes === undefined) {
    try {
      randomBytes = crypto.randomBytes
    } catch {
      invalidRoute()
    }
  }
  const observe = option(options, TEST_ONLY_TICKET_OBSERVER)
  if (typeof now !== 'function' || typeof randomBytes !== 'function') invalidRoute()
  if (observe !== undefined && typeof observe !== 'function') invalidRoute()

  const pendingStates = new WeakMap()
  const spentPending = new WeakSet()
  const ticketStates = new WeakMap()
  const replay = new Map()

  function issue(state) {
    const ticket = Object.freeze({})
    ticketStates.set(ticket, state)
    if (observe) observe(ticket, observeState(state, now))
    return ticket
  }

  const checker = Object.freeze({
    take(ticket) {
      const state = safeObject(ticket) ? ticketStates.get(ticket) : null
      if (!state) unauthorized()
      ticketStates.delete(ticket)
      return state
    }
  })
  CHECKERS.add(checker)

  function pruneReplay(current) {
    for (const [key, expiry] of replay) {
      if (expiry <= current) replay.delete(key)
    }
  }

  return Object.freeze({
    checker,

    initiate(value) {
      validateCommon(value)
      if (!fixed(option(value, 'responderStaticKey'), 32)) invalidRoute()
      if (!fixed(option(value, 'initiatorIdentitySecretKey'), 64)) invalidRoute()

      const pair = ephemeral(crypto, randomBytes)
      let shared = null
      let baseHash = null
      let challenge = null
      let cipher = null
      try {
        const base = {
          version: PROTOCOL_VERSION,
          circuitId: value.circuitId,
          epoch: value.epoch,
          initiatorIdentity: value.initiatorIdentity,
          responderIdentity: value.responderIdentity,
          initiatorLocalId: value.initiatorLocalId,
          responderLocalId: value.responderLocalId,
          initiatorEphemeralKey: pair.publicKey,
          expiresAt: value.expiresAt
        }
        baseHash = hash(crypto, [DOMAIN.LINK_CREATE, createBase(base)])
        shared = agreement(crypto, pair.secretKey, value.responderStaticKey)
        challenge = hash(crypto, [DOMAIN.LINK_CREATE, pair.secretKey, baseHash])
        cipher = challengeCipher(crypto, shared, baseHash, challenge)
        const unsigned = { ...base, staticChallengeCipher: cipher }
        const signed = b4a.concat([DOMAIN.LINK_CREATE, createUnsigned(unsigned)])
        const message = {
          ...unsigned,
          initiatorIdentitySignature: sign(crypto, signed, value.initiatorIdentitySecretKey)
        }
        clear(signed)

        const pending = Object.freeze({})
        pendingStates.set(pending, {
          common: base,
          responderStaticKey: copyBuffer(value.responderStaticKey),
          ephemeralSecretKey: copyBuffer(pair.secretKey),
          challenge: copyBuffer(challenge),
          createHash: hash(crypto, [encodeLinkCreate(message)])
        })
        return { message: encodeLinkCreate(message), pending }
      } finally {
        clear(pair.secretKey)
        clear(shared)
        clear(baseHash)
        clear(challenge)
        clear(cipher)
      }
    },

    respond(message, expected) {
      validateCommon(expected)
      if (!fixed(option(expected, 'responderStaticSecretKey'), 32)) invalidRoute()
      if (!fixed(option(expected, 'responderIdentitySecretKey'), 64)) invalidRoute()

      const create = decodeLinkCreate(message)
      const current = nowValue(now)
      if (!matchesCommon(create, expected) || create.expiresAt <= current) invalidRoute()

      const unsigned = b4a.concat([DOMAIN.LINK_CREATE, createUnsigned(create)])
      if (!verify(crypto, unsigned, create.initiatorIdentitySignature, create.initiatorIdentity)) {
        clear(unsigned)
        unauthorized()
      }
      clear(unsigned)

      const createHash = hash(crypto, [encodeLinkCreate(create)])
      const replayKey = b4a.toString(createHash, 'hex')
      pruneReplay(current)
      if (replay.has(replayKey)) unauthorizedReplay()
      if (replay.size >= MAX_REPLAYS) throw PrivateRouteError.CIRCUIT_LIMIT()
      // A valid identity signature is enough to consume the create transcript.
      // Otherwise an authenticated initiator can replay a deliberately bad
      // challenge indefinitely and force repeated static-key work.
      replay.set(replayKey, create.expiresAt)

      const baseHash = hash(crypto, [DOMAIN.LINK_CREATE, createBase(create)])
      let shared = null
      let challenge = null
      let pair = null
      let ephemeralShared = null
      try {
        shared = agreement(crypto, expected.responderStaticSecretKey, create.initiatorEphemeralKey)
        const transcript = b4a.concat([DOMAIN.LINK_CREATE, baseHash])
        const keys = derive(crypto, shared, transcript)
        try {
          challenge = crypto.open({
            key: keys.forwardKey,
            noncePrefix: keys.forwardNoncePrefix,
            counter: 0n,
            associatedData: baseHash,
            ciphertext: create.staticChallengeCipher
          })
        } catch {
          challenge = null
        } finally {
          clear(keys.forwardKey)
          clear(keys.reverseKey)
          clear(keys.forwardNoncePrefix)
          clear(keys.reverseNoncePrefix)
          clear(transcript)
        }
        if (!fixed(challenge, 32)) unauthorized()

        pair = ephemeral(crypto, randomBytes)
        const createdBase = {
          version: PROTOCOL_VERSION,
          circuitId: create.circuitId,
          epoch: create.epoch,
          initiatorIdentity: create.initiatorIdentity,
          responderIdentity: create.responderIdentity,
          initiatorLocalId: create.initiatorLocalId,
          responderLocalId: create.responderLocalId,
          initiatorEphemeralKey: create.initiatorEphemeralKey,
          responderEphemeralKey: pair.publicKey,
          createHash,
          challengeHash: hash(crypto, [challenge]),
          expiresAt: create.expiresAt
        }
        const tag = possessionTag(crypto, shared, baseHash, challenge, createHash)
        const signed = b4a.concat([DOMAIN.LINK_CREATED, createdUnsigned(createdBase), tag])
        const created = {
          ...createdBase,
          staticPossessionTag: tag,
          responderIdentitySignature: sign(crypto, signed, expected.responderIdentitySecretKey)
        }
        clear(signed)

        const encoded = encodeLinkCreated(created)
        const createdHash = hash(crypto, [encoded])
        ephemeralShared = agreement(crypto, pair.secretKey, create.initiatorEphemeralKey)
        const state = ticketState(
          crypto,
          ephemeralShared,
          createHash,
          createdHash,
          create,
          false,
          now
        )
        return { message: encoded, ticket: issue(state) }
      } finally {
        clear(shared)
        clear(challenge)
        clear(baseHash)
        clear(createHash)
        clear(pair && pair.secretKey)
        clear(ephemeralShared)
      }
    },

    complete(pending, message) {
      const state = safeObject(pending) ? pendingStates.get(pending) : null
      if (!state || spentPending.has(pending)) unauthorizedReplay()
      pendingStates.delete(pending)
      spentPending.add(pending)

      let shared = null
      let createdHash = null
      try {
        const created = decodeLinkCreated(message)
        if (
          !matchesCommon(created, state.common) ||
          !same(created.initiatorEphemeralKey, state.common.initiatorEphemeralKey) ||
          !same(created.createHash, state.createHash) ||
          created.expiresAt <= nowValue(now)
        ) {
          unauthorized()
        }

        const signed = b4a.concat([
          DOMAIN.LINK_CREATED,
          createdUnsigned(created),
          created.staticPossessionTag
        ])
        const validSignature = verify(
          crypto,
          signed,
          created.responderIdentitySignature,
          created.responderIdentity
        )
        clear(signed)
        if (!validSignature) unauthorized()

        const expectedChallengeHash = hash(crypto, [state.challenge])
        if (!same(created.challengeHash, expectedChallengeHash)) {
          clear(expectedChallengeHash)
          unauthorized()
        }
        clear(expectedChallengeHash)

        shared = agreement(crypto, state.ephemeralSecretKey, state.responderStaticKey)
        const baseHash = hash(crypto, [DOMAIN.LINK_CREATE, createBase(state.common)])
        const expectedTag = possessionTag(
          crypto,
          shared,
          baseHash,
          state.challenge,
          state.createHash
        )
        clear(baseHash)
        if (!same(created.staticPossessionTag, expectedTag)) {
          clear(expectedTag)
          unauthorized()
        }
        clear(expectedTag)

        clear(shared)
        shared = agreement(crypto, state.ephemeralSecretKey, created.responderEphemeralKey)
        createdHash = hash(crypto, [encodeLinkCreated(created)])
        return issue(
          ticketState(crypto, shared, state.createHash, createdHash, state.common, true, now)
        )
      } finally {
        clear(shared)
        clear(createdHash)
        clear(state.responderStaticKey)
        clear(state.ephemeralSecretKey)
        clear(state.challenge)
        clear(state.createHash)
      }
    }
  })
}

function unauthorizedReplay() {
  throw PrivateRouteError.REPLAY()
}

export function isLinkTicketChecker(value) {
  return safeObject(value) && CHECKERS.has(value)
}
