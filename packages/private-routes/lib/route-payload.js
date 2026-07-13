import b4a from 'b4a'

import { DatagramReplayWindow, OrderedReceiver, SenderCounter } from './counters.js'
import { PrivateRouteError } from './errors.js'
import { CELL_CLASS, DIRECTION } from './protocol.js'

export const ROUTE_FRAME_SIZE = 1100
export const ROUTE_COUNTER_SIZE = 8
export const ROUTE_CIPHERTEXT_SIZE = 1092
export const ROUTE_PLAINTEXT_SIZE = 1076
export const MAX_ROUTE_PAYLOAD = 1073

export const TEST_ONLY_RECEIVERS = Symbol('test-only-route-payload-receivers')

const KEY_BYTES = 32
const NONCE_PREFIX_BYTES = 16
const DESCRIPTOR_ID_BYTES = 32
const CIRCUIT_ID_BYTES = 16
const MAX_UINT64 = (1n << 64n) - 1n
const RECEIVER_CODES = new Set(['REPLAY', 'COUNTER_INVALID', 'COUNTER_GAP', 'COUNTER_EXHAUSTED'])

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function optionsObject(options) {
  try {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) invalid()
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
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

function copy(value) {
  try {
    const owned = b4a.allocUnsafeSlow(value.byteLength)
    owned.set(value)
    return owned
  } catch {
    invalid()
  }
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) b4a.fill(value, 0)
  } catch {
    // Best-effort zeroization only.
  }
}

function directionValue(value) {
  if (value !== DIRECTION.FORWARD && value !== DIRECTION.REVERSE) invalid()
  return value
}

function routeClass(value) {
  if (value !== CELL_CLASS.STREAM && value !== CELL_CLASS.DATAGRAM) invalid()
  return value
}

function uint64(value) {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_UINT64
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
  const data = b4a.allocUnsafeSlow(DESCRIPTOR_ID_BYTES + CIRCUIT_ID_BYTES + 1 + 8)
  data.set(descriptorId, 0)
  data.set(circuitId, DESCRIPTOR_ID_BYTES)
  data[DESCRIPTOR_ID_BYTES + CIRCUIT_ID_BYTES] = direction
  writeUint64BE(data, counter, DESCRIPTOR_ID_BYTES + CIRCUIT_ID_BYTES + 1)
  return data
}

function normalizeCrypto(operation) {
  try {
    return operation()
  } catch {
    invalid()
  }
}

function receiverFailure(err) {
  try {
    if (!(err instanceof PrivateRouteError)) return null
    const code = err.code
    return RECEIVER_CODES.has(code) ? code : null
  } catch {
    return null
  }
}

function invokeReceiver(operation) {
  try {
    return operation()
  } catch (err) {
    const code = receiverFailure(err)
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
  if (receivers === undefined) return defaults
  optionsObject(receivers)

  const ordered = option(receivers, `${name}Ordered`)
  const datagram = option(receivers, `${name}Datagram`)
  return Object.freeze({
    key: defaults.key,
    noncePrefix: defaults.noncePrefix,
    sender: defaults.sender,
    ordered,
    datagram,
    pushAuthenticated: method(ordered, 'pushAuthenticated'),
    acceptAuthenticated: method(datagram, 'acceptAuthenticated'),
    destroyOrdered: optionalMethod(ordered, 'destroy')
  })
}

function decodeDelivery(value) {
  const length = bufferLength(value)
  if (length < 1 || length > MAX_ROUTE_PAYLOAD + 1) invalid()
  const cellClass = routeClass(value[0])
  return Object.freeze({ class: cellClass, payload: copy(value.subarray(1)) })
}

function decodeDeliveries(deliveries) {
  let values
  try {
    if (!Array.isArray(deliveries)) invalid()
    values = Array.from(deliveries)
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
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

export class RoutePayloadCodec {
  #crypto
  #padding
  #descriptorId
  #circuitId
  #forward
  #reverse
  #destroyed

  constructor(options) {
    options = optionsObject(options)
    const crypto = option(options, 'crypto')
    const descriptorId = option(options, 'descriptorId')
    const circuitId = option(options, 'circuitId')
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
      (configuredPadding !== undefined && typeof configuredPadding !== 'function') ||
      !isBuffer(descriptorId, DESCRIPTOR_ID_BYTES) ||
      !isBuffer(circuitId, CIRCUIT_ID_BYTES)
    ) {
      invalid()
    }

    const forwardKey = option(options, 'forwardKey')
    const forwardNoncePrefix = option(options, 'forwardNoncePrefix')
    const reverseKey = option(options, 'reverseKey')
    const reverseNoncePrefix = option(options, 'reverseNoncePrefix')
    if (
      !isBuffer(forwardKey, KEY_BYTES) ||
      !isBuffer(reverseKey, KEY_BYTES) ||
      !isBuffer(forwardNoncePrefix, NONCE_PREFIX_BYTES) ||
      !isBuffer(reverseNoncePrefix, NONCE_PREFIX_BYTES)
    ) {
      invalid()
    }
    try {
      if (
        b4a.equals(forwardKey, reverseKey) ||
        b4a.equals(forwardNoncePrefix, reverseNoncePrefix)
      ) {
        invalid()
      }
    } catch (err) {
      if (err instanceof PrivateRouteError) throw err
      invalid()
    }

    const counterOptions = senderInitial === undefined ? undefined : { initial: senderInitial }
    const receiverOptions = { window, gapTimeout, now, initial: receiverInitial }
    let ownedForwardKey = null
    let ownedForwardPrefix = null
    let ownedReverseKey = null
    let ownedReversePrefix = null
    let ownedDescriptor = null
    let ownedCircuit = null

    try {
      ownedForwardKey = copy(forwardKey)
      ownedForwardPrefix = copy(forwardNoncePrefix)
      ownedReverseKey = copy(reverseKey)
      ownedReversePrefix = copy(reverseNoncePrefix)
      ownedDescriptor = copy(descriptorId)
      ownedCircuit = copy(circuitId)

      const forwardDefaults = Object.freeze({
        key: ownedForwardKey,
        noncePrefix: ownedForwardPrefix,
        sender: new SenderCounter(counterOptions),
        ordered: new OrderedReceiver(receiverOptions),
        datagram: new DatagramReplayWindow({ window })
      })
      const reverseDefaults = Object.freeze({
        key: ownedReverseKey,
        noncePrefix: ownedReversePrefix,
        sender: new SenderCounter(counterOptions),
        ordered: new OrderedReceiver(receiverOptions),
        datagram: new DatagramReplayWindow({ window })
      })

      this.#crypto = Object.freeze({ seal: seal.bind(crypto), open: open.bind(crypto) })
      this.#padding = configuredPadding === undefined ? randomBytes.bind(crypto) : configuredPadding
      this.#descriptorId = ownedDescriptor
      this.#circuitId = ownedCircuit
      this.#forward = directionState(receivers, 'forward', forwardDefaults)
      this.#reverse = directionState(receivers, 'reverse', reverseDefaults)
      if (!this.#forward.pushAuthenticated) {
        this.#forward = Object.freeze({
          ...this.#forward,
          pushAuthenticated: method(this.#forward.ordered, 'pushAuthenticated'),
          acceptAuthenticated: method(this.#forward.datagram, 'acceptAuthenticated'),
          destroyOrdered: optionalMethod(this.#forward.ordered, 'destroy')
        })
      }
      if (!this.#reverse.pushAuthenticated) {
        this.#reverse = Object.freeze({
          ...this.#reverse,
          pushAuthenticated: method(this.#reverse.ordered, 'pushAuthenticated'),
          acceptAuthenticated: method(this.#reverse.datagram, 'acceptAuthenticated'),
          destroyOrdered: optionalMethod(this.#reverse.ordered, 'destroy')
        })
      }
      this.#destroyed = false
    } catch (err) {
      clear(ownedForwardKey)
      clear(ownedForwardPrefix)
      clear(ownedReverseKey)
      clear(ownedReversePrefix)
      clear(ownedDescriptor)
      clear(ownedCircuit)
      if (err instanceof PrivateRouteError) throw err
      invalid()
    }
  }

  get stats() {
    return Object.freeze({
      destroyed: this.#destroyed,
      forward: Object.freeze({
        senderNext: this.#forward.sender.value,
        senderClosed: this.#forward.sender.closed,
        orderedNext: this.#forward.ordered.next,
        orderedBuffered: this.#forward.ordered.buffered,
        datagramHighest: this.#forward.datagram.highest
      }),
      reverse: Object.freeze({
        senderNext: this.#reverse.sender.value,
        senderClosed: this.#reverse.sender.closed,
        orderedNext: this.#reverse.ordered.next,
        orderedBuffered: this.#reverse.ordered.buffered,
        datagramHighest: this.#reverse.datagram.highest
      })
    })
  }

  seal(options) {
    if (this.#destroyed) throw PrivateRouteError.CIRCUIT_STATE()
    options = optionsObject(options)
    const direction = directionValue(option(options, 'direction'))
    const cellClass = routeClass(option(options, 'class'))
    const payload = option(options, 'payload')
    const payloadLength = bufferLength(payload)
    if (payloadLength < 0 || payloadLength > MAX_ROUTE_PAYLOAD) invalid()

    const state = direction === DIRECTION.FORWARD ? this.#forward : this.#reverse
    const plaintext = b4a.allocUnsafeSlow(ROUTE_PLAINTEXT_SIZE)
    let padding = null
    let data = null
    let ciphertext = null

    try {
      plaintext[0] = cellClass
      writeUint16BE(plaintext, payloadLength, 1)
      plaintext.set(payload, 3)
      const paddingSize = MAX_ROUTE_PAYLOAD - payloadLength
      if (paddingSize > 0) {
        padding = normalizeCrypto(() => this.#padding(paddingSize))
        if (!isBuffer(padding, paddingSize)) invalid()
        plaintext.set(padding, 3 + payloadLength)
      }

      let counter
      try {
        counter = state.sender.next()
      } catch (err) {
        const code = receiverFailure(err)
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

      const frame = b4a.allocUnsafeSlow(ROUTE_FRAME_SIZE)
      writeUint64BE(frame, counter, 0)
      frame.set(ciphertext, ROUTE_COUNTER_SIZE)
      return frame
    } finally {
      clear(plaintext)
      clear(data)
      // Padding and ciphertext are adapter-owned public outputs.
    }
  }

  open(options, frame) {
    if (this.#destroyed) throw PrivateRouteError.CIRCUIT_STATE()
    if (!isBuffer(frame, ROUTE_FRAME_SIZE)) invalid()
    options = optionsObject(options)
    const direction = directionValue(option(options, 'direction'))
    const state = direction === DIRECTION.FORWARD ? this.#forward : this.#reverse
    const counter = readUint64BE(frame, 0)
    const data = associatedData(this.#descriptorId, this.#circuitId, direction, counter)
    let plaintext = null
    let delivery = null

    try {
      plaintext = normalizeCrypto(() =>
        this.#crypto.open({
          key: state.key,
          noncePrefix: state.noncePrefix,
          counter,
          associatedData: data,
          ciphertext: frame.subarray(ROUTE_COUNTER_SIZE)
        })
      )
      if (plaintext === null || !isBuffer(plaintext, ROUTE_PLAINTEXT_SIZE)) invalid()

      const cellClass = routeClass(plaintext[0])
      const payloadLength = (plaintext[1] << 8) | plaintext[2]
      if (payloadLength > MAX_ROUTE_PAYLOAD) invalid()

      if (cellClass === CELL_CLASS.DATAGRAM) {
        const accepted = invokeReceiver(() => state.acceptAuthenticated(counter))
        if (accepted !== true) invalid()
        return Object.freeze({
          class: cellClass,
          payload: copy(plaintext.subarray(3, 3 + payloadLength))
        })
      }

      delivery = b4a.allocUnsafeSlow(payloadLength + 1)
      delivery[0] = cellClass
      delivery.set(plaintext.subarray(3, 3 + payloadLength), 1)
      const deliveries = invokeReceiver(() => state.pushAuthenticated(counter, delivery))
      return decodeDeliveries(deliveries)
    } finally {
      clear(data)
      clear(plaintext)
      clear(delivery)
    }
  }

  destroy() {
    if (this.#destroyed) return
    this.#destroyed = true
    for (const state of [this.#forward, this.#reverse]) {
      try {
        if (state.destroyOrdered) state.destroyOrdered()
      } catch {
        // Key and identifier cleanup must continue even for hostile injected receivers.
      }
    }
    clear(this.#forward.key)
    clear(this.#forward.noncePrefix)
    clear(this.#reverse.key)
    clear(this.#reverse.noncePrefix)
    clear(this.#descriptorId)
    clear(this.#circuitId)
  }
}
