import b4a from 'b4a'

import { cryptoSuite } from './crypto-suite.js'
import { PrivateRouteError } from './errors.js'
import {
  LINK_CREATE_SIZE,
  LINK_CREATED_SIZE,
  decodeLinkCreate,
  decodeLinkCreated
} from './link-setup.js'
import {
  BOOTSTRAP_REJECT_CODE,
  BOOTSTRAP_TYPE,
  DOMAIN,
  LINK_OPERATION,
  PROTOCOL_VERSION
} from './protocol.js'
import { readLinkHandle } from './topology-grant.js'

export const BOOTSTRAP_SIZE = 1200
export const BOOTSTRAP_CLASS = 0x80
export const BOOTSTRAP_HEADER_SIZE = 150
export const BOOTSTRAP_SIGNATURE_SIZE = 64
export const BOOTSTRAP_MAX_BODY = 986
export const BOOTSTRAP_DEADLINE = 5_000
export const DEFAULT_MAX_BOOTSTRAP_PENDING = 64
export const DEFAULT_MAX_BOOTSTRAP_PENDING_PER_PEER = 8
export const DEFAULT_MAX_BOOTSTRAP_CACHE = 64
export const DEFAULT_MAX_BOOTSTRAP_TOMBSTONES = 128
export const TEST_ONLY_BOOTSTRAP_REQUEST_TABLE_OBSERVER = Symbol(
  'test-only-bootstrap-request-table-observer'
)

const MAX_U64 = 0xffff_ffff_ffff_ffffn
const ZERO_DIGEST = b4a.alloc(32)
const CODECS = new WeakMap()
const TABLES = new WeakMap()
const VERIFIED_ENVELOPES = new WeakMap()
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const bufferByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get
const bufferSet = Uint8Array.prototype.set
const bufferFill = Uint8Array.prototype.fill
const bufferSubarray = Uint8Array.prototype.subarray

function invalidRoute() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function unauthorized() {
  throw PrivateRouteError.UNAUTHORIZED()
}

function replay() {
  throw PrivateRouteError.REPLAY()
}

function circuitLimit() {
  throw PrivateRouteError.CIRCUIT_LIMIT()
}

function circuitState() {
  throw PrivateRouteError.CIRCUIT_STATE()
}

function unavailable() {
  throw PrivateRouteError.ROUTE_UNAVAILABLE()
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

function copy(value) {
  const output = b4a.allocUnsafeSlow(bufferLength(value))
  bufferSet.call(output, value)
  return output
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) bufferFill.call(value, 0)
  } catch {
    // Best-effort zeroization only.
  }
}

function same(left, right) {
  try {
    return fixed(left, bufferLength(right)) && b4a.equals(left, right)
  } catch {
    return false
  }
}

function sameAddress(left, right) {
  return left.family === right.family && left.host === right.host && left.port === right.port
}

function u64(value, nonzero = false) {
  return typeof value === 'bigint' && value >= (nonzero ? 1n : 0n) && value <= MAX_U64
}

function knownType(value) {
  return (
    value === BOOTSTRAP_TYPE.LINK_CREATE ||
    value === BOOTSTRAP_TYPE.LINK_CREATED ||
    value === BOOTSTRAP_TYPE.LINK_REJECT ||
    value === BOOTSTRAP_TYPE.LINK_CANCEL
  )
}

function knownRejectCode(value) {
  return (
    value === BOOTSTRAP_REJECT_CODE.UNAUTHORIZED ||
    value === BOOTSTRAP_REJECT_CODE.CIRCUIT_LIMIT ||
    value === BOOTSTRAP_REJECT_CODE.ROUTE_UNAVAILABLE
  )
}

function operationFor(type, sender) {
  const initiatorMessage =
    type === BOOTSTRAP_TYPE.LINK_CREATE || type === BOOTSTRAP_TYPE.LINK_CANCEL
  if (sender) return initiatorMessage ? LINK_OPERATION.INITIATE : LINK_OPERATION.ACCEPT
  return initiatorMessage ? LINK_OPERATION.ACCEPT : LINK_OPERATION.INITIATE
}

function requireOperation(operations, operation) {
  if ((operations & operation) !== operation) unauthorized()
}

function writeU16(buffer, value, offset) {
  buffer[offset] = value >>> 8
  buffer[offset + 1] = value
}

function readU16(buffer, offset) {
  return buffer[offset] * 0x100 + buffer[offset + 1]
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

function safeHash(crypto, parts) {
  let output = null
  try {
    output = crypto.hash(parts)
    if (!fixed(output, 32)) invalidRoute()
    return copy(output)
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalidRoute()
  }
}

function safeSign(crypto, digest, secretKey) {
  let output = null
  try {
    output = crypto.sign(digest, secretKey)
    if (!fixed(output, BOOTSTRAP_SIGNATURE_SIZE)) invalidRoute()
    return copy(output)
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalidRoute()
  }
}

function safeVerify(crypto, digest, signature, publicKey) {
  try {
    return crypto.verify(digest, signature, publicKey) === true
  } catch {
    unauthorized()
  }
}

function validateCreate(body, sender, recipient, epoch) {
  let decoded = null
  try {
    decoded = decodeLinkCreate(body)
    if (
      decoded.epoch !== epoch ||
      !same(decoded.initiatorIdentity, sender) ||
      !same(decoded.responderIdentity, recipient)
    ) {
      invalidRoute()
    }
    return decoded
  } catch (err) {
    if (err instanceof PrivateRouteError) throw PrivateRouteError.INVALID_ROUTE()
    invalidRoute()
  }
}

function validateCreated(body, sender, recipient, epoch, requestBody = null, crypto = null) {
  let decoded = null
  let request = null
  let createHash = null
  try {
    decoded = decodeLinkCreated(body)
    if (
      decoded.epoch !== epoch ||
      !same(decoded.initiatorIdentity, recipient) ||
      !same(decoded.responderIdentity, sender)
    ) {
      invalidRoute()
    }
    if (requestBody !== null) {
      request = validateCreate(requestBody, recipient, sender, epoch)
      createHash = safeHash(crypto, requestBody)
      if (
        !same(decoded.circuitId, request.circuitId) ||
        !same(decoded.initiatorLocalId, request.initiatorLocalId) ||
        !same(decoded.responderLocalId, request.responderLocalId) ||
        !same(decoded.initiatorEphemeralKey, request.initiatorEphemeralKey) ||
        !same(decoded.createHash, createHash)
      ) {
        invalidRoute()
      }
    }
    return decoded
  } catch (err) {
    if (err instanceof PrivateRouteError) throw PrivateRouteError.INVALID_ROUTE()
    invalidRoute()
  } finally {
    clear(createHash)
  }
}

function expectedBodySize(type) {
  if (type === BOOTSTRAP_TYPE.LINK_CREATE) return LINK_CREATE_SIZE
  if (type === BOOTSTRAP_TYPE.LINK_CREATED) return LINK_CREATED_SIZE
  if (type === BOOTSTRAP_TYPE.LINK_REJECT) return 2
  if (type === BOOTSTRAP_TYPE.LINK_CANCEL) return 1
  return -1
}

function validateRejectedBody(body) {
  if (body[0] !== BOOTSTRAP_TYPE.LINK_CREATE) invalidRoute()
}

function parsePacket(
  state,
  packet,
  source,
  expectedSender = null,
  validateAddress = true,
  validateOperation = true
) {
  if (!fixed(packet, BOOTSTRAP_SIZE)) invalidRoute()
  if (
    packet[0] !== PROTOCOL_VERSION ||
    packet[1] !== BOOTSTRAP_CLASS ||
    !knownType(packet[2]) ||
    packet[3] !== 0
  ) {
    invalidRoute()
  }

  const type = packet[2]
  const requestId = readU64(packet, 4)
  const epoch = readU64(packet, 12)
  const bodyLength = readU16(packet, 20)
  if (
    !u64(requestId, true) ||
    epoch !== state.link.epoch ||
    bodyLength !== expectedBodySize(type) ||
    bodyLength > BOOTSTRAP_MAX_BODY
  ) {
    invalidRoute()
  }

  const senderIdentity32 = bufferSubarray.call(packet, 22, 54)
  const recipientIdentity32 = bufferSubarray.call(packet, 54, 86)
  const grantDigest32 = bufferSubarray.call(packet, 86, 118)
  const requestDigest32 = bufferSubarray.call(packet, 118, 150)
  const unsigned = bufferSubarray.call(packet, 0, 1136)
  const signature = bufferSubarray.call(packet, 1136, 1200)
  const sender = expectedSender || state.link.peerIdentity32

  if (validateOperation) requireOperation(state.link.operations, operationFor(type, false))

  if (
    !same(senderIdentity32, sender) ||
    !same(recipientIdentity32, state.link.localIdentity32) ||
    !same(grantDigest32, state.link.digest32)
  ) {
    unauthorized()
  }
  if (validateAddress) {
    if (!safeObject(source)) unauthorized()
    const host = option(source, 'host')
    const port = option(source, 'port')
    if (host !== state.link.peerAddress.host || port !== state.link.peerAddress.port) unauthorized()
  }

  let signedDigest = null
  try {
    signedDigest = safeHash(state.crypto, [DOMAIN.UDX_BOOTSTRAP, unsigned])
    if (!safeVerify(state.crypto, signedDigest, signature, senderIdentity32)) unauthorized()
  } finally {
    clear(signedDigest)
  }

  const bodyView = bufferSubarray.call(
    packet,
    BOOTSTRAP_HEADER_SIZE,
    BOOTSTRAP_HEADER_SIZE + bodyLength
  )
  if (type === BOOTSTRAP_TYPE.LINK_CREATE) {
    if (!same(requestDigest32, ZERO_DIGEST)) invalidRoute()
    validateCreate(bodyView, senderIdentity32, recipientIdentity32, epoch)
  } else {
    if (same(requestDigest32, ZERO_DIGEST)) invalidRoute()
    if (type === BOOTSTRAP_TYPE.LINK_CREATED) {
      validateCreated(bodyView, senderIdentity32, recipientIdentity32, epoch)
    } else {
      validateRejectedBody(bodyView)
      if (type === BOOTSTRAP_TYPE.LINK_REJECT && !knownRejectCode(bodyView[1])) invalidRoute()
    }
  }

  const decoded = {
    type,
    requestId,
    epoch,
    senderIdentity32: copy(senderIdentity32),
    recipientIdentity32: copy(recipientIdentity32),
    grantDigest32: copy(grantDigest32),
    requestDigest32: copy(requestDigest32),
    body: copy(bodyView),
    packetDigest32: safeHash(state.crypto, packet)
  }
  VERIFIED_ENVELOPES.set(decoded, {
    type,
    requestId,
    epoch,
    senderIdentity32: copy(senderIdentity32),
    recipientIdentity32: copy(recipientIdentity32),
    grantDigest32: copy(grantDigest32),
    requestDigest32: copy(requestDigest32),
    body: copy(bodyView),
    packetDigest32: copy(decoded.packetDigest32)
  })
  return Object.freeze(decoded)
}

function validateOriginalRequest(state, packet, localSender) {
  const sender = localSender ? state.link.localIdentity32 : state.link.peerIdentity32
  const temporary = {
    ...state,
    link: {
      ...state.link,
      localIdentity32: localSender ? state.link.peerIdentity32 : state.link.localIdentity32,
      peerIdentity32: sender
    }
  }
  const decoded = parsePacket(temporary, packet, null, sender, false, false)
  if (decoded.type !== BOOTSTRAP_TYPE.LINK_CREATE) invalidRoute()
  return decoded
}

export class BootstrapEnvelopeCodec {
  constructor(options = {}) {
    if (!safeObject(options)) invalidRoute()
    const crypto = option(options, 'crypto') || cryptoSuite
    const linkHandle = option(options, 'linkHandle')
    const localIdentitySecretKey = option(options, 'localIdentitySecretKey')
    let padding = option(options, 'padding')
    if (padding === undefined) padding = crypto.randomBytes
    if (
      !safeObject(crypto) ||
      !fixed(localIdentitySecretKey, 64) ||
      typeof padding !== 'function'
    ) {
      invalidRoute()
    }

    let link
    try {
      link = readLinkHandle(linkHandle)
    } catch {
      unauthorized()
    }

    let challenge = null
    let signature = null
    try {
      challenge = safeHash(crypto, [DOMAIN.UDX_BOOTSTRAP, link.localIdentity32])
      signature = safeSign(crypto, challenge, localIdentitySecretKey)
      if (!safeVerify(crypto, challenge, signature, link.localIdentity32)) unauthorized()
    } finally {
      clear(challenge)
      clear(signature)
    }

    CODECS.set(this, {
      crypto,
      link,
      linkHandle,
      localIdentitySecretKey: copy(localIdentitySecretKey),
      padding,
      destroyed: false
    })
  }

  encode(value) {
    const state = CODECS.get(this)
    if (state.destroyed) circuitState()
    requireLiveLink(state)
    if (!safeObject(value)) invalidRoute()
    const type = option(value, 'type')
    const requestId = option(value, 'requestId')
    const epoch = option(value, 'epoch')
    if (!knownType(type) || !u64(requestId, true) || epoch !== state.link.epoch) invalidRoute()
    requireOperation(state.link.operations, operationFor(type, true))

    let body = null
    let requestDigest32 = null
    let original = null
    if (type === BOOTSTRAP_TYPE.LINK_CREATE) {
      body = option(value, 'body')
      const suppliedDigest = option(value, 'requestDigest32')
      if (!fixed(body, LINK_CREATE_SIZE) || !same(suppliedDigest, ZERO_DIGEST)) invalidRoute()
      validateCreate(body, state.link.localIdentity32, state.link.peerIdentity32, epoch)
      requestDigest32 = ZERO_DIGEST
    } else {
      const requestPacket = option(value, 'requestPacket')
      if (!fixed(requestPacket, BOOTSTRAP_SIZE)) invalidRoute()
      original = validateOriginalRequest(state, requestPacket, type === BOOTSTRAP_TYPE.LINK_CANCEL)
      if (original.requestId !== requestId || original.epoch !== epoch) invalidRoute()
      requestDigest32 = original.packetDigest32
      if (type === BOOTSTRAP_TYPE.LINK_CREATED) {
        body = option(value, 'body')
        if (!fixed(body, LINK_CREATED_SIZE)) invalidRoute()
        validateCreated(
          body,
          state.link.localIdentity32,
          state.link.peerIdentity32,
          epoch,
          original.body,
          state.crypto
        )
      } else {
        const rejectedType = option(value, 'rejectedType')
        if (rejectedType !== BOOTSTRAP_TYPE.LINK_CREATE) invalidRoute()
        if (type === BOOTSTRAP_TYPE.LINK_REJECT) {
          const rejectCode = option(value, 'rejectCode')
          if (!knownRejectCode(rejectCode)) invalidRoute()
          body = b4a.from([rejectedType, rejectCode])
        } else {
          body = b4a.from([rejectedType])
        }
      }
    }

    let packet = null
    let padding = null
    let signedDigest = null
    let signature = null
    try {
      packet = b4a.allocUnsafeSlow(BOOTSTRAP_SIZE)
      packet[0] = PROTOCOL_VERSION
      packet[1] = BOOTSTRAP_CLASS
      packet[2] = type
      packet[3] = 0
      writeU64(packet, requestId, 4)
      writeU64(packet, epoch, 12)
      writeU16(packet, body.byteLength, 20)
      bufferSet.call(packet, state.link.localIdentity32, 22)
      bufferSet.call(packet, state.link.peerIdentity32, 54)
      bufferSet.call(packet, state.link.digest32, 86)
      bufferSet.call(packet, requestDigest32, 118)
      bufferSet.call(packet, body, BOOTSTRAP_HEADER_SIZE)
      const paddingLength = BOOTSTRAP_MAX_BODY - body.byteLength
      if (paddingLength > 0) {
        try {
          padding = state.padding(paddingLength)
        } catch {
          invalidRoute()
        }
        if (!fixed(padding, paddingLength)) invalidRoute()
        bufferSet.call(packet, padding, BOOTSTRAP_HEADER_SIZE + body.byteLength)
      }
      signedDigest = safeHash(state.crypto, [
        DOMAIN.UDX_BOOTSTRAP,
        bufferSubarray.call(packet, 0, 1136)
      ])
      signature = safeSign(state.crypto, signedDigest, state.localIdentitySecretKey)
      bufferSet.call(packet, signature, 1136)
      return packet
    } catch (err) {
      clear(packet)
      if (err instanceof PrivateRouteError) throw err
      invalidRoute()
    } finally {
      clear(signedDigest)
      clear(signature)
      if (original) {
        clear(original.senderIdentity32)
        clear(original.recipientIdentity32)
        clear(original.grantDigest32)
        clear(original.requestDigest32)
        clear(original.body)
        clear(original.packetDigest32)
      }
    }
  }

  decode(packet, source) {
    const state = CODECS.get(this)
    if (state.destroyed) circuitState()
    requireLiveLink(state)
    try {
      return parsePacket(state, packet, source)
    } catch (err) {
      if (err instanceof PrivateRouteError) throw err
      invalidRoute()
    }
  }

  receive(packet, source) {
    try {
      return this.decode(packet, source)
    } catch {
      return null
    }
  }

  destroy() {
    const state = CODECS.get(this)
    if (state.destroyed) return
    state.destroyed = true
    clear(state.localIdentitySecretKey)
    clear(state.link.localIdentity32)
    clear(state.link.peerIdentity32)
    clear(state.link.digest32)
    clear(state.link.runId32)
    state.localIdentitySecretKey = null
    state.linkHandle = null
    state.crypto = null
    state.padding = null
    state.link = null
  }
}

function requireLiveLink(state) {
  let live
  try {
    live = readLinkHandle(state.linkHandle)
  } catch {
    unauthorized()
  }
  if (
    !same(live.digest32, state.link.digest32) ||
    !same(live.localIdentity32, state.link.localIdentity32) ||
    live.localRole !== state.link.localRole ||
    !sameAddress(live.localAddress, state.link.localAddress) ||
    !same(live.peerIdentity32, state.link.peerIdentity32) ||
    live.peerRole !== state.link.peerRole ||
    !sameAddress(live.peerAddress, state.link.peerAddress) ||
    live.epoch !== state.link.epoch ||
    !same(live.runId32, state.link.runId32) ||
    live.operations !== state.link.operations
  ) {
    unauthorized()
  }
}

function tableBound(value, fallback) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > fallback) invalidRoute()
  return value
}

function tableKey(peerIdentity32, epoch, requestId) {
  if (!fixed(peerIdentity32, 32) || !u64(epoch) || !u64(requestId, true)) invalidRoute()
  return `${b4a.toString(peerIdentity32, 'hex')}:${epoch}:${requestId}`
}

function peerKey(peerIdentity32, epoch) {
  if (!fixed(peerIdentity32, 32) || !u64(epoch)) invalidRoute()
  return `${b4a.toString(peerIdentity32, 'hex')}:${epoch}`
}

function tableSnapshot(state) {
  const value = {
    pending: state.pending.size,
    cache: state.cache.size,
    tombstones: state.tombstones.size,
    timers: state.timers.size,
    destroyed: state.destroyed
  }
  if (state.released) {
    value.ownedBytes = 0
    value.callbacks = 0
  }
  return value
}

function observeTable(state) {
  if (!state.observer) return
  try {
    state.observer(tableSnapshot(state))
  } catch {
    // Test diagnostics are passive.
  }
}

function cancelTableTimer(state, key) {
  if (!state.timers.has(key)) return
  const timer = state.timers.get(key)
  state.timers.delete(key)
  try {
    state.cancel(timer)
  } catch {
    unavailable()
  }
}

function clearRecord(record) {
  if (!record) return
  clear(record.peerIdentity32)
  clear(record.packet)
  clear(record.digest32)
  record.peerIdentity32 = null
  record.packet = null
  record.digest32 = null
  record.callback = null
  record.decoded = null
  record.token = null
}

function removeRecord(state, collection, key) {
  const record = collection.get(key)
  if (!record) return null
  collection.delete(key)
  if (collection === state.pending) state.tokens.delete(record.token)
  try {
    cancelTableTimer(state, `${collection === state.pending ? 'p' : 'c'}:${key}`)
  } catch (err) {
    clearRecord(record)
    throw err
  }
  return record
}

function addTombstone(state, key, record) {
  if (state.tombstones.size >= state.maxTombstones) circuitLimit()
  const tombstone = {
    peerIdentity32: copy(record.peerIdentity32),
    epoch: record.epoch,
    requestId: record.requestId,
    digest32: copy(record.digest32),
    packet: null,
    callback: null,
    deadlineAt: tableTime(state) + state.deadline
  }
  state.tombstones.set(key, tombstone)
  let timer
  try {
    timer = state.schedule(() => {
      state.timers.delete(`t:${key}`)
      const removed = state.tombstones.get(key)
      state.tombstones.delete(key)
      clearRecord(removed)
      observeTable(state)
    }, state.deadline)
  } catch {
    state.tombstones.delete(key)
    clearRecord(tombstone)
    unavailable()
  }
  state.timers.set(`t:${key}`, timer)
}

function scheduleRecord(state, collection, prefix, key, record) {
  let timer
  try {
    timer = state.schedule(() => {
      state.timers.delete(`${prefix}:${key}`)
      if (!collection.has(key)) {
        clearRecord(record)
        return
      }
      collection.delete(key)
      if (collection === state.pending) {
        state.tokens.delete(record.token)
        try {
          addTombstone(state, key, record)
        } catch {}
      }
      clearRecord(record)
      observeTable(state)
    }, state.deadline)
  } catch {
    unavailable()
  }
  state.timers.set(`${prefix}:${key}`, timer)
}

function ensureTableOpen(state) {
  if (state.destroyed) circuitState()
}

function ensureTombstoneReservation(state) {
  if (state.pending.size + state.cache.size + state.tombstones.size >= state.maxTombstones) {
    circuitLimit()
  }
}

function tableTime(state) {
  try {
    const value = state.now()
    if (!Number.isSafeInteger(value) || value < 0) unavailable()
    return value
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    unavailable()
  }
}

function randomRequestId(state, peerIdentity32, epoch) {
  for (let attempt = 0; attempt < 32; attempt++) {
    let bytes = null
    try {
      bytes = state.randomBytes(8)
      if (!fixed(bytes, 8)) invalidRoute()
      const requestId = readU64(bytes, 0)
      if (requestId === 0n) continue
      const key = tableKey(peerIdentity32, epoch, requestId)
      if (!state.pending.has(key) && !state.cache.has(key) && !state.tombstones.has(key)) {
        return requestId
      }
    } catch (err) {
      if (err instanceof PrivateRouteError) throw err
      unavailable()
    } finally {
      clear(bytes)
    }
  }
  circuitLimit()
}

function validateDecoded(value) {
  const decoded = safeObject(value) ? VERIFIED_ENVELOPES.get(value) : null
  if (!decoded) unauthorized()
  return decoded
}

export class BootstrapRequestTable {
  constructor(options = {}) {
    if (!safeObject(options)) invalidRoute()
    const crypto = option(options, 'crypto') || cryptoSuite
    const now = option(options, 'now')
    const schedule = option(options, 'schedule')
    const cancel = option(options, 'cancel')
    let randomBytes = option(options, 'randomBytes')
    if (randomBytes === undefined) randomBytes = crypto.randomBytes
    const deadline = option(options, 'deadline') ?? BOOTSTRAP_DEADLINE
    const observer = option(options, TEST_ONLY_BOOTSTRAP_REQUEST_TABLE_OBSERVER)
    if (
      !safeObject(crypto) ||
      typeof now !== 'function' ||
      typeof schedule !== 'function' ||
      typeof cancel !== 'function' ||
      typeof randomBytes !== 'function' ||
      !Number.isSafeInteger(deadline) ||
      deadline !== BOOTSTRAP_DEADLINE ||
      (observer !== undefined && typeof observer !== 'function')
    ) {
      invalidRoute()
    }
    TABLES.set(this, {
      crypto,
      now,
      schedule,
      cancel,
      randomBytes,
      deadline,
      observer,
      maxPending: tableBound(option(options, 'maxPending'), DEFAULT_MAX_BOOTSTRAP_PENDING),
      maxPendingPerPeer: tableBound(
        option(options, 'maxPendingPerPeer'),
        DEFAULT_MAX_BOOTSTRAP_PENDING_PER_PEER
      ),
      maxCache: tableBound(option(options, 'maxCache'), DEFAULT_MAX_BOOTSTRAP_CACHE),
      maxTombstones: tableBound(option(options, 'maxTombstones'), DEFAULT_MAX_BOOTSTRAP_TOMBSTONES),
      pending: new Map(),
      cache: new Map(),
      tombstones: new Map(),
      timers: new Map(),
      tokens: new WeakMap(),
      destroyed: false,
      released: false
    })
  }

  begin(value) {
    const state = TABLES.get(this)
    ensureTableOpen(state)
    const startedAt = tableTime(state)
    if (!safeObject(value)) invalidRoute()
    const peerIdentity32 = option(value, 'peerIdentity32')
    const epoch = option(value, 'epoch')
    const encode = option(value, 'encode')
    const onResponse = option(value, 'onResponse')
    if (
      !fixed(peerIdentity32, 32) ||
      !u64(epoch) ||
      typeof encode !== 'function' ||
      typeof onResponse !== 'function'
    ) {
      invalidRoute()
    }
    if (state.pending.size >= state.maxPending) circuitLimit()
    ensureTombstoneReservation(state)
    const peer = peerKey(peerIdentity32, epoch)
    let peerCount = 0
    for (const record of state.pending.values()) if (record.peerKey === peer) peerCount++
    if (peerCount >= state.maxPendingPerPeer) circuitLimit()

    const requestId = randomRequestId(state, peerIdentity32, epoch)
    const key = tableKey(peerIdentity32, epoch, requestId)
    let packet = null
    let digest32 = null
    let record = null
    try {
      try {
        packet = encode(requestId)
      } catch {
        unavailable()
      }
      if (!fixed(packet, BOOTSTRAP_SIZE)) invalidRoute()
      digest32 = safeHash(state.crypto, packet)
      const token = Object.freeze({})
      record = {
        peerIdentity32: copy(peerIdentity32),
        peerKey: peer,
        epoch,
        requestId,
        packet: copy(packet),
        digest32: copy(digest32),
        callback: onResponse,
        token,
        deadlineAt: startedAt + state.deadline
      }
      state.pending.set(key, record)
      state.tokens.set(token, key)
      try {
        scheduleRecord(state, state.pending, 'p', key, record)
      } catch {
        state.pending.delete(key)
        state.tokens.delete(token)
        clearRecord(record)
        throw PrivateRouteError.ROUTE_UNAVAILABLE()
      }
      observeTable(state)
      return Object.freeze({
        token,
        requestId,
        packet: copy(packet),
        digest32: copy(digest32)
      })
    } finally {
      clear(digest32)
    }
  }

  acceptResponse(peerIdentity32, value, packet) {
    const state = TABLES.get(this)
    ensureTableOpen(state)
    const current = tableTime(state)
    const decoded = validateDecoded(value)
    if (
      (decoded.type !== BOOTSTRAP_TYPE.LINK_CREATED &&
        decoded.type !== BOOTSTRAP_TYPE.LINK_REJECT) ||
      !fixed(packet, BOOTSTRAP_SIZE) ||
      !same(peerIdentity32, decoded.senderIdentity32)
    ) {
      return false
    }
    const key = tableKey(peerIdentity32, decoded.epoch, decoded.requestId)
    const record = state.pending.get(key)
    if (!record) return false
    if (current >= record.deadlineAt) {
      removeRecord(state, state.pending, key)
      state.tokens.delete(record.token)
      try {
        addTombstone(state, key, record)
      } finally {
        clearRecord(record)
      }
      observeTable(state)
      return false
    }
    if (!same(decoded.requestDigest32, record.digest32)) return false
    const packetDigest32 = safeHash(state.crypto, packet)
    const packetMatches = same(packetDigest32, decoded.packetDigest32)
    clear(packetDigest32)
    if (!packetMatches) return false

    removeRecord(state, state.pending, key)
    state.tokens.delete(record.token)
    try {
      addTombstone(state, key, record)
    } catch {
      clearRecord(record)
      unavailable()
    }
    const callback = record.callback
    record.callback = null
    try {
      callback(copy(packet), value)
    } catch {
      clearRecord(record)
      unavailable()
    }
    clearRecord(record)
    observeTable(state)
    return true
  }

  cancel(token) {
    const state = TABLES.get(this)
    ensureTableOpen(state)
    const key = safeObject(token) ? state.tokens.get(token) : null
    if (!key) return false
    const record = removeRecord(state, state.pending, key)
    if (!record) return false
    state.tokens.delete(token)
    try {
      addTombstone(state, key, record)
    } finally {
      clearRecord(record)
    }
    observeTable(state)
    return true
  }

  respond(peerIdentity32, value, requestPacket, createResponse) {
    const state = TABLES.get(this)
    ensureTableOpen(state)
    const current = tableTime(state)
    const decoded = validateDecoded(value)
    if (
      decoded.type !== BOOTSTRAP_TYPE.LINK_CREATE ||
      !same(peerIdentity32, decoded.senderIdentity32) ||
      !fixed(requestPacket, BOOTSTRAP_SIZE) ||
      typeof createResponse !== 'function'
    ) {
      invalidRoute()
    }
    const digest32 = safeHash(state.crypto, requestPacket)
    const key = tableKey(peerIdentity32, decoded.epoch, decoded.requestId)
    let previous = state.cache.get(key)
    if (previous && current >= previous.deadlineAt) {
      removeRecord(state, state.cache, key)
      clearRecord(previous)
      previous = null
    }
    if (previous) {
      const identical = same(previous.digest32, digest32)
      clear(digest32)
      if (!identical) replay()
      return copy(previous.packet)
    }
    if (!same(digest32, decoded.packetDigest32)) {
      clear(digest32)
      unauthorized()
    }
    if (state.cache.size >= state.maxCache) {
      clear(digest32)
      circuitLimit()
    }
    try {
      ensureTombstoneReservation(state)
    } catch (err) {
      clear(digest32)
      throw err
    }

    let result
    try {
      result = createResponse()
    } catch {
      clear(digest32)
      unavailable()
    }
    if (!safeObject(result)) {
      clear(digest32)
      invalidRoute()
    }
    const packet = option(result, 'packet')
    const response = validateDecoded(option(result, 'decoded'))
    if (
      !fixed(packet, BOOTSTRAP_SIZE) ||
      (response.type !== BOOTSTRAP_TYPE.LINK_CREATED &&
        response.type !== BOOTSTRAP_TYPE.LINK_REJECT) ||
      response.requestId !== decoded.requestId ||
      response.epoch !== decoded.epoch ||
      !same(response.senderIdentity32, decoded.recipientIdentity32) ||
      !same(response.recipientIdentity32, decoded.senderIdentity32) ||
      !same(response.requestDigest32, digest32)
    ) {
      clear(digest32)
      invalidRoute()
    }
    const packetDigest32 = safeHash(state.crypto, packet)
    const responseMatches = same(packetDigest32, response.packetDigest32)
    clear(packetDigest32)
    if (!responseMatches) {
      clear(digest32)
      unauthorized()
    }
    const record = {
      peerIdentity32: copy(peerIdentity32),
      epoch: decoded.epoch,
      requestId: decoded.requestId,
      packet: copy(packet),
      digest32,
      callback: null,
      deadlineAt: current + state.deadline
    }
    state.cache.set(key, record)
    try {
      scheduleRecord(state, state.cache, 'c', key, record)
    } catch {
      state.cache.delete(key)
      clearRecord(record)
      unavailable()
    }
    observeTable(state)
    return copy(packet)
  }

  acceptCancel(peerIdentity32, value) {
    const state = TABLES.get(this)
    ensureTableOpen(state)
    const current = tableTime(state)
    const decoded = validateDecoded(value)
    if (
      decoded.type !== BOOTSTRAP_TYPE.LINK_CANCEL ||
      !same(peerIdentity32, decoded.senderIdentity32)
    ) {
      return false
    }
    const key = tableKey(peerIdentity32, decoded.epoch, decoded.requestId)
    const record = state.cache.get(key)
    if (record && current >= record.deadlineAt) {
      removeRecord(state, state.cache, key)
      clearRecord(record)
      return false
    }
    if (!record || !same(record.digest32, decoded.requestDigest32)) return false
    removeRecord(state, state.cache, key)
    try {
      addTombstone(state, key, record)
    } finally {
      clearRecord(record)
    }
    observeTable(state)
    return true
  }

  destroy() {
    const state = TABLES.get(this)
    if (state.destroyed) return
    state.destroyed = true
    const observer = state.observer
    let failed = false
    for (const [key, record] of state.pending) {
      try {
        cancelTableTimer(state, `p:${key}`)
      } catch {
        failed = true
      }
      clearRecord(record)
    }
    for (const [key, record] of state.cache) {
      try {
        cancelTableTimer(state, `c:${key}`)
      } catch {
        failed = true
      }
      clearRecord(record)
    }
    for (const [key, record] of state.tombstones) {
      try {
        cancelTableTimer(state, `t:${key}`)
      } catch {
        failed = true
      }
      clearRecord(record)
    }
    for (const key of Array.from(state.timers.keys())) {
      try {
        cancelTableTimer(state, key)
      } catch {
        failed = true
      }
    }
    state.pending.clear()
    state.cache.clear()
    state.tombstones.clear()
    state.now = null
    state.schedule = null
    state.cancel = null
    state.randomBytes = null
    state.observer = null
    state.released = true
    if (observer) {
      try {
        observer(tableSnapshot(state))
      } catch {
        failed = true
      }
    }
    if (failed) unavailable()
  }
}
