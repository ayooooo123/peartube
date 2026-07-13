import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { DatagramReplayWindow, OrderedReceiver, SenderCounter } from './counters.js'
import { PrivateRouteError } from './errors.js'
import { CELL_CLASS, DIRECTION } from './protocol.js'

export const ROUTE_FRAME_SIZE = 1100
export const ROUTE_COUNTER_SIZE = 8
export const ROUTE_CIPHERTEXT_SIZE = 1092
export const ROUTE_PLAINTEXT_SIZE = 1076
export const MAX_ROUTE_PAYLOAD = 1073

export const TEST_ONLY_RECEIVERS = Symbol('test-only-route-payload-receivers')
export const ROUTE_ENDPOINT = Object.freeze({ SOURCE: 0, DESTINATION: 1 })

const CREATED_CONTEXTS = new WeakMap()
const CREATED_CONTEXT_TOKENS = new WeakSet()
const NONCE_DOMAIN_CLAIMS = new Map()

const KEY_BYTES = 32
const NONCE_PREFIX_BYTES = 16
const DESCRIPTOR_ID_BYTES = 32
const CIRCUIT_ID_BYTES = 16
const MAX_UINT64 = (1n << 64n) - 1n
const MAX_LOGICAL_COUNTER = (1n << 63n) - 1n
const MAX_NONCE_DOMAIN_CLAIMS = 4096
const NONCE_DOMAIN_CLAIM = b4a.from('hyperdht-private-routes/nonce-domain/v0')
const RECEIVER_CODES = new Set(['REPLAY', 'COUNTER_INVALID', 'COUNTER_GAP', 'COUNTER_EXHAUSTED'])
const bufferFill = Uint8Array.prototype.fill
const bufferSet = Uint8Array.prototype.set
const bufferSubarray = Uint8Array.prototype.subarray

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function optionsObject(options) {
  try {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) invalid()
  } catch {
    invalid()
  }
  return options
}

function option(options, name) {
  try {
    return options[name]
  } catch {
    invalid()
  }
}

function bufferLength(value) {
  try {
    return b4a.isBuffer(value) ? value.byteLength : -1
  } catch {
    return -1
  }
}

function isBuffer(value, size) {
  return bufferLength(value) === size
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) bufferFill.call(value, 0)
  } catch {
    // Best-effort zeroization only.
  }
}

function allocate(size) {
  let owned = null
  try {
    owned = b4a.allocUnsafeSlow(size)
    if (!isBuffer(owned, size)) invalid()
    return owned
  } catch {
    clear(owned)
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

function set(target, source, offset = 0) {
  try {
    bufferSet.call(target, source, offset)
  } catch {
    invalid()
  }
}

function copy(value) {
  let owned = null
  try {
    const length = bufferLength(value)
    if (length < 0) invalid()
    owned = allocate(length)
    set(owned, value)
    return owned
  } catch {
    clear(owned)
    invalid()
  }
}

function directionValue(value) {
  if (value !== DIRECTION.FORWARD && value !== DIRECTION.REVERSE) invalid()
  return value
}

function endpointRoleValue(value) {
  if (value !== ROUTE_ENDPOINT.SOURCE && value !== ROUTE_ENDPOINT.DESTINATION) invalid()
  return value
}

function sendDirection(endpointRole) {
  return endpointRole === ROUTE_ENDPOINT.SOURCE ? DIRECTION.FORWARD : DIRECTION.REVERSE
}

function routeClass(value) {
  if (value !== CELL_CLASS.STREAM && value !== CELL_CLASS.DATAGRAM) invalid()
  return value
}

function uint64(value) {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_UINT64
}

function wireCounter(logical, cellClass) {
  if (typeof logical !== 'bigint' || logical < 0n || logical > MAX_LOGICAL_COUNTER) invalid()
  return (logical << 1n) | (cellClass === CELL_CLASS.DATAGRAM ? 1n : 0n)
}

function logicalCounter(wire, cellClass) {
  const expected = cellClass === CELL_CLASS.DATAGRAM ? 1n : 0n
  if ((wire & 1n) !== expected) invalid()
  return wire >> 1n
}

function writeUint64BE(buffer, value, offset) {
  for (let i = offset + 7; i >= offset; i--) {
    buffer[i] = Number(value & 0xffn)
    value >>= 8n
  }
}

function readUint64BE(buffer, offset) {
  let value = 0n
  for (let i = offset; i < offset + 8; i++) value = (value << 8n) | BigInt(buffer[i])
  return value
}

function writeUint16BE(buffer, value, offset) {
  buffer[offset] = value >>> 8
  buffer[offset + 1] = value
}

function associatedData(descriptorId, circuitId, direction, counter) {
  let data = null
  try {
    data = allocate(DESCRIPTOR_ID_BYTES + CIRCUIT_ID_BYTES + 1 + 8)
    set(data, descriptorId, 0)
    set(data, circuitId, DESCRIPTOR_ID_BYTES)
    data[DESCRIPTOR_ID_BYTES + CIRCUIT_ID_BYTES] = direction
    writeUint64BE(data, counter, DESCRIPTOR_ID_BYTES + CIRCUIT_ID_BYTES + 1)
    return data
  } catch {
    clear(data)
    invalid()
  }
}

function normalizeCrypto(operation) {
  try {
    return operation()
  } catch {
    invalid()
  }
}

function privateRouteCode(err, allowed) {
  try {
    if (!(err instanceof PrivateRouteError)) return null
    const code = err.code
    return allowed.has(code) ? code : null
  } catch {
    return null
  }
}

function invokeReceiver(operation) {
  try {
    return operation()
  } catch (err) {
    const code = privateRouteCode(err, RECEIVER_CODES)
    if (code !== null) throw new PrivateRouteError(code)
    invalid()
  }
}

function method(target, name) {
  let value
  try {
    value = target && target[name]
  } catch {
    invalid()
  }
  if (typeof value !== 'function') invalid()
  return value.bind(target)
}

function optionalMethod(target, name) {
  let value
  try {
    value = target && target[name]
  } catch {
    invalid()
  }
  if (value === undefined) return null
  if (typeof value !== 'function') invalid()
  return value.bind(target)
}

function directionState(receivers, name, defaults) {
  if (receivers !== undefined) optionsObject(receivers)
  const ordered = receivers === undefined ? defaults.ordered : option(receivers, `${name}Ordered`)
  const datagram =
    receivers === undefined ? defaults.datagram : option(receivers, `${name}Datagram`)
  return Object.freeze({
    key: defaults.key,
    noncePrefix: defaults.noncePrefix,
    streamSender: defaults.streamSender,
    datagramSender: defaults.datagramSender,
    ordered,
    datagram,
    pushAuthenticated: method(ordered, 'pushAuthenticated'),
    acceptAuthenticated: method(datagram, 'acceptAuthenticated'),
    destroyStreamSender: optionalMethod(defaults.streamSender, 'destroy'),
    destroyDatagramSender: optionalMethod(defaults.datagramSender, 'destroy'),
    destroyOrdered: optionalMethod(ordered, 'destroy'),
    destroyDatagram: optionalMethod(datagram, 'destroy')
  })
}

function clearOperationResult(result) {
  try {
    if (b4a.isBuffer(result)) {
      clear(result)
      return
    }
    if (Array.isArray(result)) {
      for (const value of result) clear(value && value.payload)
      return
    }
    clear(result && result.payload)
  } catch {
    // Result cleanup is best-effort; route teardown still continues.
  }
}

function decodeDelivery(value) {
  const length = bufferLength(value)
  if (length < 1 || length > MAX_ROUTE_PAYLOAD + 1) invalid()
  const cellClass = routeClass(value[0])
  return Object.freeze({ class: cellClass, payload: copy(subarray(value, 1)) })
}

function decodeDeliveries(deliveries) {
  let values
  try {
    if (!Array.isArray(deliveries)) invalid()
    values = Array.from(deliveries)
  } catch {
    invalid()
  }
  const decoded = []
  let complete = false
  try {
    for (const delivery of values) decoded.push(decodeDelivery(delivery))
    complete = true
    return decoded
  } finally {
    for (const delivery of values) clear(delivery)
    if (!complete) {
      for (const value of decoded) clear(value.payload)
    }
  }
}

function contextFields(options) {
  options = optionsObject(options)
  const endpointRole = endpointRoleValue(option(options, 'endpointRole'))
  const descriptorId = option(options, 'descriptorId')
  const circuitId = option(options, 'circuitId')
  const forwardKey = option(options, 'forwardKey')
  const forwardNoncePrefix = option(options, 'forwardNoncePrefix')
  const reverseKey = option(options, 'reverseKey')
  const reverseNoncePrefix = option(options, 'reverseNoncePrefix')
  if (
    !isBuffer(descriptorId, DESCRIPTOR_ID_BYTES) ||
    !isBuffer(circuitId, CIRCUIT_ID_BYTES) ||
    !isBuffer(forwardKey, KEY_BYTES) ||
    !isBuffer(reverseKey, KEY_BYTES) ||
    !isBuffer(forwardNoncePrefix, NONCE_PREFIX_BYTES) ||
    !isBuffer(reverseNoncePrefix, NONCE_PREFIX_BYTES)
  ) {
    invalid()
  }
  try {
    if (b4a.equals(forwardKey, reverseKey) || b4a.equals(forwardNoncePrefix, reverseNoncePrefix)) {
      invalid()
    }
  } catch {
    invalid()
  }
  return {
    endpointRole,
    descriptorId,
    circuitId,
    forwardKey,
    forwardNoncePrefix,
    reverseKey,
    reverseNoncePrefix
  }
}

function nonceDomainClaim(owned) {
  const direction = sendDirection(owned.endpointRole)
  const key = direction === DIRECTION.FORWARD ? owned.forwardKey : owned.reverseKey
  const noncePrefix =
    direction === DIRECTION.FORWARD ? owned.forwardNoncePrefix : owned.reverseNoncePrefix
  let digest = null
  let claimKey = null
  try {
    digest = crypto.hash([NONCE_DOMAIN_CLAIM, key, noncePrefix])
    claimKey = b4a.toString(digest, 'hex')
  } catch {
    invalid()
  } finally {
    clear(digest)
  }
  if (NONCE_DOMAIN_CLAIMS.has(claimKey)) invalid()
  if (NONCE_DOMAIN_CLAIMS.size >= MAX_NONCE_DOMAIN_CLAIMS) invalid()
  const claim = { key: claimKey, state: 'pending' }
  NONCE_DOMAIN_CLAIMS.set(claimKey, claim)
  return claim
}

function releasePendingClaim(owned) {
  const claim = owned && owned.claim
  if (!claim || claim.state !== 'pending') return
  if (NONCE_DOMAIN_CLAIMS.get(claim.key) === claim) NONCE_DOMAIN_CLAIMS.delete(claim.key)
  claim.state = 'released'
}

function activateClaim(owned) {
  const claim = owned && owned.claim
  if (!claim || claim.state !== 'pending' || NONCE_DOMAIN_CLAIMS.get(claim.key) !== claim) invalid()
  claim.state = 'active'
  return claim
}

// Internal post-authentication boundary. Task 11's verified CREATED handler is
// the only production issuer. This mint is deliberately absent from index.js.
export function mintCreatedRoutePayloadContext(options) {
  const fields = contextFields(options)
  const owned = { endpointRole: fields.endpointRole, claim: null }
  try {
    for (const [name, value] of Object.entries(fields)) {
      if (name !== 'endpointRole') owned[name] = copy(value)
    }
    owned.claim = nonceDomainClaim(owned)
    const context = Object.freeze(Object.create(null))
    CREATED_CONTEXTS.set(context, owned)
    CREATED_CONTEXT_TOKENS.add(context)
    return context
  } catch {
    releasePendingClaim(owned)
    clearCreatedContext(owned)
    invalid()
  }
}

function clearCreatedContext(owned) {
  if (!owned) return
  for (const value of Object.values(owned)) clear(value)
}

// Task 11 must call this if activation aborts after minting but before the
// context is consumed by RoutePayloadCodec.
export function destroyCreatedRoutePayloadContext(context) {
  let known = false
  let owned = null
  try {
    known = CREATED_CONTEXT_TOKENS.has(context)
    owned = CREATED_CONTEXTS.get(context)
  } catch {
    invalid()
  }
  if (!known) invalid()
  if (!owned) return
  CREATED_CONTEXTS.delete(context)
  releasePendingClaim(owned)
  clearCreatedContext(owned)
}

function takeCreatedContext(context) {
  let known = false
  let owned = null
  try {
    known = CREATED_CONTEXT_TOKENS.has(context)
    owned = CREATED_CONTEXTS.get(context)
  } catch {
    invalid()
  }
  if (!known || !owned) invalid()
  CREATED_CONTEXTS.delete(context)
  return owned
}

export class RoutePayloadCodec {
  #crypto
  #padding
  #descriptorId
  #circuitId
  #forward
  #reverse
  #endpointRole
  #sendDirection
  #receiveDirection
  #nonceDomainClaim
  #destroyed
  #mutating
  #destroyRequested

  constructor(options) {
    options = optionsObject(options)
    const crypto = option(options, 'crypto')
    const context = option(options, 'context')
    const window = option(options, 'window')
    const gapTimeout = option(options, 'gapTimeout')
    const now = option(options, 'now')
    const configuredPadding = option(options, 'padding')
    const senderInitial = option(options, 'senderInitial')
    const receiverInitial = option(options, 'receiverInitial')
    const receivers = option(options, TEST_ONLY_RECEIVERS)
    if (receivers !== undefined) optionsObject(receivers)

    let seal
    let open
    let randomBytes
    try {
      seal = crypto && crypto.seal
      open = crypto && crypto.open
      randomBytes = crypto && crypto.randomBytes
    } catch {
      invalid()
    }
    if (
      typeof seal !== 'function' ||
      typeof open !== 'function' ||
      (configuredPadding === undefined && typeof randomBytes !== 'function') ||
      (configuredPadding !== undefined && typeof configuredPadding !== 'function')
    ) {
      invalid()
    }

    const counterOptions = { initial: senderInitial, maximum: MAX_LOGICAL_COUNTER }
    const receiverOptions = {
      window,
      gapTimeout,
      now,
      initial: receiverInitial,
      maximum: MAX_LOGICAL_COUNTER
    }
    let ownedForwardKey = null
    let ownedForwardPrefix = null
    let ownedReverseKey = null
    let ownedReversePrefix = null
    let ownedDescriptor = null
    let ownedCircuit = null
    let created = null

    try {
      created = takeCreatedContext(context)
      ownedForwardKey = created.forwardKey
      ownedForwardPrefix = created.forwardNoncePrefix
      ownedReverseKey = created.reverseKey
      ownedReversePrefix = created.reverseNoncePrefix
      ownedDescriptor = created.descriptorId
      ownedCircuit = created.circuitId

      const forwardDefaults = Object.freeze({
        key: ownedForwardKey,
        noncePrefix: ownedForwardPrefix,
        streamSender: new SenderCounter(counterOptions),
        datagramSender: new SenderCounter(counterOptions),
        ordered: new OrderedReceiver(receiverOptions),
        datagram: new DatagramReplayWindow({ window, maximum: MAX_LOGICAL_COUNTER })
      })
      const reverseDefaults = Object.freeze({
        key: ownedReverseKey,
        noncePrefix: ownedReversePrefix,
        streamSender: new SenderCounter(counterOptions),
        datagramSender: new SenderCounter(counterOptions),
        ordered: new OrderedReceiver(receiverOptions),
        datagram: new DatagramReplayWindow({ window, maximum: MAX_LOGICAL_COUNTER })
      })

      this.#crypto = Object.freeze({ seal: seal.bind(crypto), open: open.bind(crypto) })
      this.#padding = configuredPadding === undefined ? randomBytes.bind(crypto) : configuredPadding
      this.#descriptorId = ownedDescriptor
      this.#circuitId = ownedCircuit
      this.#endpointRole = created.endpointRole
      this.#sendDirection = sendDirection(created.endpointRole)
      this.#receiveDirection =
        this.#sendDirection === DIRECTION.FORWARD ? DIRECTION.REVERSE : DIRECTION.FORWARD
      this.#forward = directionState(receivers, 'forward', forwardDefaults)
      this.#reverse = directionState(receivers, 'reverse', reverseDefaults)
      this.#nonceDomainClaim = activateClaim(created)
      this.#destroyed = false
      this.#mutating = false
      this.#destroyRequested = false
    } catch {
      releasePendingClaim(created)
      clear(ownedForwardKey)
      clear(ownedForwardPrefix)
      clear(ownedReverseKey)
      clear(ownedReversePrefix)
      clear(ownedDescriptor)
      clear(ownedCircuit)
      invalid()
    }
  }

  get stats() {
    return Object.freeze({
      destroyed: this.#destroyed,
      forward: Object.freeze({
        senderNext: this.#forward.streamSender.value,
        senderClosed: this.#forward.streamSender.closed,
        senderNeedsRotation: this.#forward.streamSender.needsRotation,
        datagramSenderNext: this.#forward.datagramSender.value,
        datagramSenderClosed: this.#forward.datagramSender.closed,
        datagramSenderNeedsRotation: this.#forward.datagramSender.needsRotation,
        orderedNext: this.#forward.ordered.next,
        orderedBuffered: this.#forward.ordered.buffered,
        orderedNeedsRotation: this.#forward.ordered.needsRotation,
        datagramHighest: this.#forward.datagram.highest,
        datagramNeedsRotation: this.#forward.datagram.needsRotation
      }),
      reverse: Object.freeze({
        senderNext: this.#reverse.streamSender.value,
        senderClosed: this.#reverse.streamSender.closed,
        senderNeedsRotation: this.#reverse.streamSender.needsRotation,
        datagramSenderNext: this.#reverse.datagramSender.value,
        datagramSenderClosed: this.#reverse.datagramSender.closed,
        datagramSenderNeedsRotation: this.#reverse.datagramSender.needsRotation,
        orderedNext: this.#reverse.ordered.next,
        orderedBuffered: this.#reverse.ordered.buffered,
        orderedNeedsRotation: this.#reverse.ordered.needsRotation,
        datagramHighest: this.#reverse.datagram.highest,
        datagramNeedsRotation: this.#reverse.datagram.needsRotation
      })
    })
  }

  seal(options) {
    return this.#mutate(() => this.#seal(options))
  }

  #seal(options) {
    options = optionsObject(options)
    const direction = directionValue(option(options, 'direction'))
    if (direction !== this.#sendDirection) invalid()
    const cellClass = routeClass(option(options, 'class'))
    const payload = option(options, 'payload')
    const payloadLength = bufferLength(payload)
    if (payloadLength < 0 || payloadLength > MAX_ROUTE_PAYLOAD) invalid()

    const state = direction === DIRECTION.FORWARD ? this.#forward : this.#reverse
    const sender = cellClass === CELL_CLASS.STREAM ? state.streamSender : state.datagramSender
    let plaintext = null
    let padding = null
    let data = null
    let ciphertext = null
    let frame = null

    try {
      plaintext = allocate(ROUTE_PLAINTEXT_SIZE)
      plaintext[0] = cellClass
      writeUint16BE(plaintext, payloadLength, 1)
      set(plaintext, payload, 3)
      const paddingSize = MAX_ROUTE_PAYLOAD - payloadLength
      if (paddingSize > 0) {
        padding = normalizeCrypto(() => this.#padding(paddingSize))
        if (!isBuffer(padding, paddingSize)) invalid()
        set(plaintext, padding, 3 + payloadLength)
      }

      let counter
      try {
        counter = wireCounter(sender.next(), cellClass)
      } catch (err) {
        const code = privateRouteCode(err, RECEIVER_CODES)
        if (code !== null) throw new PrivateRouteError(code)
        invalid()
      }
      if (!uint64(counter)) invalid()
      data = associatedData(this.#descriptorId, this.#circuitId, direction, counter)
      ciphertext = normalizeCrypto(() =>
        this.#crypto.seal({
          key: state.key,
          noncePrefix: state.noncePrefix,
          counter,
          associatedData: data,
          plaintext
        })
      )
      if (!isBuffer(ciphertext, ROUTE_CIPHERTEXT_SIZE)) invalid()

      frame = allocate(ROUTE_FRAME_SIZE)
      writeUint64BE(frame, counter, 0)
      set(frame, ciphertext, ROUTE_COUNTER_SIZE)
      return frame
    } catch (err) {
      clear(frame)
      const code = privateRouteCode(err, RECEIVER_CODES)
      if (code !== null) throw new PrivateRouteError(code)
      invalid()
    } finally {
      clear(plaintext)
      clear(data)
      // Padding and ciphertext are adapter-owned public outputs.
    }
  }

  open(options, frame) {
    return this.#mutate(() => this.#open(options, frame))
  }

  #open(options, frame) {
    if (!isBuffer(frame, ROUTE_FRAME_SIZE)) invalid()
    options = optionsObject(options)
    const direction = directionValue(option(options, 'direction'))
    if (direction !== this.#receiveDirection) invalid()
    const state = direction === DIRECTION.FORWARD ? this.#forward : this.#reverse
    const counter = readUint64BE(frame, 0)
    let data = null
    let plaintext = null
    let delivery = null

    try {
      data = associatedData(this.#descriptorId, this.#circuitId, direction, counter)
      plaintext = normalizeCrypto(() =>
        this.#crypto.open({
          key: state.key,
          noncePrefix: state.noncePrefix,
          counter,
          associatedData: data,
          ciphertext: subarray(frame, ROUTE_COUNTER_SIZE)
        })
      )
      if (plaintext === null || !isBuffer(plaintext, ROUTE_PLAINTEXT_SIZE)) invalid()

      const cellClass = routeClass(plaintext[0])
      const logical = logicalCounter(counter, cellClass)
      const payloadLength = (plaintext[1] << 8) | plaintext[2]
      if (payloadLength > MAX_ROUTE_PAYLOAD) invalid()

      if (cellClass === CELL_CLASS.DATAGRAM) {
        const accepted = invokeReceiver(() => state.acceptAuthenticated(logical))
        if (accepted !== true) invalid()
        return Object.freeze({
          class: cellClass,
          payload: copy(subarray(plaintext, 3, 3 + payloadLength))
        })
      }

      delivery = allocate(payloadLength + 1)
      delivery[0] = cellClass
      set(delivery, subarray(plaintext, 3, 3 + payloadLength), 1)
      const deliveries = invokeReceiver(() => state.pushAuthenticated(logical, delivery))
      return decodeDeliveries(deliveries)
    } finally {
      clear(data)
      clear(plaintext)
      clear(delivery)
    }
  }

  destroy() {
    if (this.#destroyed || this.#destroyRequested) return
    if (this.#mutating) {
      this.#destroyRequested = true
      return
    }
    this.#destroyNow()
  }

  #mutate(operation) {
    if (this.#destroyed) throw PrivateRouteError.CIRCUIT_STATE()
    if (this.#mutating) {
      this.#destroyRequested = true
      invalid()
    }
    this.#mutating = true
    let result = null
    try {
      result = operation()
      if (this.#destroyRequested || this.#destroyed) {
        clearOperationResult(result)
        result = null
        throw PrivateRouteError.CIRCUIT_STATE()
      }
      return result
    } finally {
      this.#mutating = false
      if (this.#destroyRequested) this.#destroyNow()
    }
  }

  #destroyNow() {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#destroyRequested = false
    for (const state of [this.#forward, this.#reverse]) {
      for (const destroy of [
        state.destroyStreamSender,
        state.destroyDatagramSender,
        state.destroyOrdered,
        state.destroyDatagram
      ]) {
        try {
          if (destroy) destroy()
        } catch {
          // Key and identifier cleanup must continue even for hostile injected state.
        }
      }
    }
    clear(this.#forward.key)
    clear(this.#forward.noncePrefix)
    clear(this.#reverse.key)
    clear(this.#reverse.noncePrefix)
    clear(this.#descriptorId)
    clear(this.#circuitId)
    if (this.#nonceDomainClaim && this.#nonceDomainClaim.state === 'active') {
      this.#nonceDomainClaim.state = 'spent'
    }
  }
}
