import b4a from 'b4a'

import { PrivateRouteError } from './errors.js'
import { CELL_CLASS, DIRECTION, DOMAIN, PROTOCOL_VERSION } from './protocol.js'

export const CELL_SIZE = 1200
export const CELL_HEADER_SIZE = 36
export const CELL_BODY_SIZE = 1148
export const MAX_CELL_PAYLOAD = 1146
export const AEAD_TAG_BYTES = 16

const MAX_UINT64 = (1n << 64n) - 1n
const KEY_BYTES = 32
const NONCE_PREFIX_BYTES = 16
const CIRCUIT_ID_BYTES = 16
const RECEIVER_FAILURES = new Set(['REPLAY', 'COUNTER_INVALID', 'COUNTER_GAP', 'COUNTER_EXHAUSTED'])

function invalid() {
  throw PrivateRouteError.CELL_INVALID()
}

function clear(buffer) {
  try {
    if (b4a.isBuffer(buffer)) b4a.fill(buffer, 0)
  } catch {
    // Untrusted adapters may return hostile values. There is nothing owned to clear.
  }
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

function uint64(value) {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_UINT64
}

function knownClass(value) {
  return (
    value === CELL_CLASS.CONTROL || value === CELL_CLASS.STREAM || value === CELL_CLASS.DATAGRAM
  )
}

function knownDirection(value) {
  return value === DIRECTION.FORWARD || value === DIRECTION.REVERSE
}

function writeUint16BE(buffer, value, offset) {
  buffer[offset] = value >>> 8
  buffer[offset + 1] = value
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

function associatedData(header) {
  return b4a.concat([DOMAIN.CELL_HEADER, header])
}

function normalizeCrypto(operation) {
  try {
    return operation()
  } catch {
    invalid()
  }
}

function receiverFailureCode(err) {
  try {
    if (!(err instanceof PrivateRouteError)) return null
    const code = err.code
    return RECEIVER_FAILURES.has(code) ? code : null
  } catch {
    return null
  }
}

function invokeReceiver(operation) {
  try {
    return operation()
  } catch (err) {
    const code = receiverFailureCode(err)
    if (code !== null) throw new PrivateRouteError(code)
    invalid()
  }
}

function retainsPayload(delivery, payload) {
  if (delivery === payload) return true
  try {
    return Array.isArray(delivery) && delivery.includes(payload)
  } catch {
    return false
  }
}

export class CellCodec {
  #crypto
  #padding

  constructor(options) {
    options = optionsObject(options)
    const crypto = option(options, 'crypto')
    const cellSize = option(options, 'cellSize')
    const configuredPadding = option(options, 'padding')

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
      cellSize !== CELL_SIZE ||
      typeof seal !== 'function' ||
      typeof open !== 'function' ||
      (configuredPadding === undefined && typeof randomBytes !== 'function') ||
      (configuredPadding !== undefined && typeof configuredPadding !== 'function')
    ) {
      invalid()
    }

    this.#crypto = Object.freeze({ seal: seal.bind(crypto), open: open.bind(crypto) })
    this.#padding = configuredPadding === undefined ? randomBytes.bind(crypto) : configuredPadding
  }

  seal(options) {
    options = optionsObject(options)
    const key = option(options, 'key')
    const noncePrefix = option(options, 'noncePrefix')
    const senderCounter = option(options, 'senderCounter')
    const cellClass = option(options, 'class')
    const direction = option(options, 'direction')
    const epoch = option(options, 'epoch')
    const circuitId = option(options, 'circuitId')
    const payload = option(options, 'payload')
    const payloadLength = bufferLength(payload)

    let next
    try {
      next = senderCounter && senderCounter.next
    } catch {
      invalid()
    }

    if (
      !isBuffer(key, KEY_BYTES) ||
      !isBuffer(noncePrefix, NONCE_PREFIX_BYTES) ||
      typeof next !== 'function' ||
      !knownClass(cellClass) ||
      !knownDirection(direction) ||
      !uint64(epoch) ||
      !isBuffer(circuitId, CIRCUIT_ID_BYTES) ||
      payloadLength < 0 ||
      payloadLength > MAX_CELL_PAYLOAD
    ) {
      invalid()
    }

    const header = b4a.allocUnsafe(CELL_HEADER_SIZE)
    const body = b4a.allocUnsafeSlow(CELL_BODY_SIZE)
    let padding = null
    let ciphertext = null

    try {
      writeUint16BE(body, payloadLength, 0)
      body.set(payload, 2)

      const paddingSize = MAX_CELL_PAYLOAD - payloadLength
      if (paddingSize > 0) {
        padding = normalizeCrypto(() => this.#padding(paddingSize))
        if (!isBuffer(padding, paddingSize)) invalid()
        body.set(padding, 2 + payloadLength)
      }

      let counter
      try {
        counter = next.call(senderCounter)
      } catch (err) {
        if (err instanceof PrivateRouteError) throw err
        invalid()
      }
      if (!uint64(counter)) invalid()

      header[0] = PROTOCOL_VERSION
      header[1] = cellClass
      header[2] = direction
      header[3] = 0
      writeUint64BE(header, epoch, 4)
      header.set(circuitId, 12)
      writeUint64BE(header, counter, 28)

      const data = associatedData(header)
      try {
        ciphertext = normalizeCrypto(() =>
          this.#crypto.seal({ key, noncePrefix, counter, associatedData: data, plaintext: body })
        )
      } finally {
        clear(data)
      }

      if (!isBuffer(ciphertext, CELL_BODY_SIZE + AEAD_TAG_BYTES)) invalid()

      const packet = b4a.allocUnsafeSlow(CELL_SIZE)
      packet.set(header, 0)
      packet.set(ciphertext, CELL_HEADER_SIZE)
      return packet
    } finally {
      clear(body)
      // Padding and ciphertext outputs remain adapter-owned and are not secret.
      // Clearing them could corrupt aliased caller storage after the codec copies them.
    }
  }

  open(options, packet) {
    if (!isBuffer(packet, CELL_SIZE)) invalid()

    const header = packet.subarray(0, CELL_HEADER_SIZE)
    const version = header[0]
    const cellClass = header[1]
    const direction = header[2]
    const flags = header[3]

    if (
      version !== PROTOCOL_VERSION ||
      !knownClass(cellClass) ||
      !knownDirection(direction) ||
      flags !== 0
    ) {
      invalid()
    }

    const epoch = readUint64BE(header, 4)
    const circuitId = header.subarray(12, 28)
    const counter = readUint64BE(header, 28)

    options = optionsObject(options)
    const key = option(options, 'key')
    const noncePrefix = option(options, 'noncePrefix')
    const expectedClass = option(options, 'expectedClass')
    const expectedDirection = option(options, 'expectedDirection')
    const expectedEpoch = option(options, 'expectedEpoch')
    const expectedCircuitId = option(options, 'expectedCircuitId')

    if (
      !isBuffer(key, KEY_BYTES) ||
      !isBuffer(noncePrefix, NONCE_PREFIX_BYTES) ||
      !knownClass(expectedClass) ||
      !knownDirection(expectedDirection) ||
      !uint64(expectedEpoch) ||
      !isBuffer(expectedCircuitId, CIRCUIT_ID_BYTES) ||
      cellClass !== expectedClass ||
      direction !== expectedDirection ||
      epoch !== expectedEpoch ||
      !b4a.equals(circuitId, expectedCircuitId)
    ) {
      invalid()
    }

    const data = associatedData(header)
    let plaintext = null
    let payload = null
    let transferred = false

    try {
      // Contract: crypto.open transfers an exclusive plaintext buffer to this
      // codec. It is always cleared below, on both success and failure.
      plaintext = normalizeCrypto(() =>
        this.#crypto.open({
          key,
          noncePrefix,
          counter,
          associatedData: data,
          ciphertext: packet.subarray(CELL_HEADER_SIZE)
        })
      )
      if (plaintext === null || !isBuffer(plaintext, CELL_BODY_SIZE)) invalid()

      const payloadLength = (plaintext[0] << 8) | plaintext[1]
      if (payloadLength > MAX_CELL_PAYLOAD) invalid()

      try {
        payload = b4a.from(plaintext.subarray(2, 2 + payloadLength))
      } catch {
        invalid()
      }

      const receiver = option(options, 'receiver')
      let receive
      try {
        receive =
          cellClass === CELL_CLASS.DATAGRAM
            ? receiver && receiver.acceptAuthenticated
            : receiver && receiver.pushAuthenticated
      } catch {
        invalid()
      }
      if (typeof receive !== 'function') invalid()

      if (cellClass === CELL_CLASS.DATAGRAM) {
        const accepted = invokeReceiver(() => receive.call(receiver, counter))
        if (accepted !== true) invalid()
        transferred = true
        return payload
      }

      const delivery = invokeReceiver(() => receive.call(receiver, counter, payload))
      transferred = retainsPayload(delivery, payload)
      return delivery
    } finally {
      clear(data)
      clear(plaintext)
      if (!transferred) clear(payload)
    }
  }
}
