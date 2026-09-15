import b4a from 'b4a'

import { PrivateRouteError } from './errors.js'

export const ACTIVATION_FRAGMENT_HEADER_SIZE = 22
export const MAX_ACTIVATION_FRAGMENT_DATA = 1124
export const MAX_ACTIVATION_OBJECT = 8192
export const MAX_ACTIVATION_FRAGMENTS = 8
export const ACTIVATION_FRAGMENT_TIMEOUT = 5_000
export const MAX_COMPLETED_ACTIVATION_IDS = 64

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const bufferByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get
const bufferFill = Uint8Array.prototype.fill
const bufferSet = Uint8Array.prototype.set
const bufferSubarray = Uint8Array.prototype.subarray

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}
function replay() {
  throw PrivateRouteError.REPLAY()
}
function limit() {
  throw PrivateRouteError.CIRCUIT_LIMIT()
}
function length(value) {
  try {
    return b4a.isBuffer(value) ? bufferByteLength.call(value) : -1
  } catch {
    return -1
  }
}
function clear(value) {
  try {
    if (b4a.isBuffer(value)) bufferFill.call(value, 0)
  } catch {}
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
function put(output, value, offset) {
  try {
    bufferSet.call(output, value, offset)
  } catch {
    invalid()
  }
}
function writeU16(output, value, offset) {
  output[offset] = value >>> 8
  output[offset + 1] = value
}
function readU16(input, offset) {
  return input[offset] * 0x100 + input[offset + 1]
}
function idHex(value) {
  try {
    return b4a.toString(value, 'hex')
  } catch {
    invalid()
  }
}
function nowValue(now) {
  let value
  try {
    value = now()
  } catch {
    invalid()
  }
  if (!Number.isSafeInteger(value) || value < 0) invalid()
  return value
}

export function fragmentActivation(message, options) {
  const size = length(message)
  let messageId
  try {
    messageId = options.messageId
  } catch {
    invalid()
  }
  if (size < 0 || size > MAX_ACTIVATION_OBJECT || length(messageId) !== 16) invalid()
  const total = Math.max(1, Math.ceil(size / MAX_ACTIVATION_FRAGMENT_DATA))
  if (total > MAX_ACTIVATION_FRAGMENTS) invalid()
  const output = []
  try {
    for (let index = 0; index < total; index++) {
      const start = index * MAX_ACTIVATION_FRAGMENT_DATA
      const end = Math.min(size, start + MAX_ACTIVATION_FRAGMENT_DATA)
      const dataSize = end - start
      const frame = b4a.allocUnsafeSlow(ACTIVATION_FRAGMENT_HEADER_SIZE + dataSize)
      put(frame, messageId, 0)
      writeU16(frame, index, 16)
      writeU16(frame, total, 18)
      writeU16(frame, size, 20)
      if (dataSize) put(frame, slice(message, start, end), ACTIVATION_FRAGMENT_HEADER_SIZE)
      output.push(frame)
    }
    return output
  } catch (err) {
    for (const frame of output) clear(frame)
    throw err
  }
}

export class ActivationReassembler {
  #now
  #active = null
  #completed = new Set()
  #destroyed = false
  #busy = false

  constructor(options) {
    let now
    try {
      now = options.now
    } catch {
      invalid()
    }
    if (typeof now !== 'function') invalid()
    this.#now = now
  }

  get bufferedBytes() {
    return this.#active ? this.#active.bytes : 0
  }

  pushAuthenticated(frame) {
    if (this.#destroyed || this.#busy) throw PrivateRouteError.CIRCUIT_STATE()
    this.#busy = true
    try {
      return this.#pushAuthenticated(frame)
    } finally {
      this.#busy = false
    }
  }

  #pushAuthenticated(frame) {
    const size = length(frame)
    if (
      size < ACTIVATION_FRAGMENT_HEADER_SIZE ||
      size > ACTIVATION_FRAGMENT_HEADER_SIZE + MAX_ACTIVATION_FRAGMENT_DATA
    )
      return this.#fail()
    const messageId = copy(slice(frame, 0, 16))
    const key = idHex(messageId)
    const index = readU16(frame, 16)
    const total = readU16(frame, 18)
    const objectLength = readU16(frame, 20)
    const dataSize = size - ACTIVATION_FRAGMENT_HEADER_SIZE
    const canonicalTotal = Math.max(1, Math.ceil(objectLength / MAX_ACTIVATION_FRAGMENT_DATA))
    if (this.#completed.has(key)) {
      clear(messageId)
      this.#clearActive()
      replay()
    }
    if (
      total < 1 ||
      total > MAX_ACTIVATION_FRAGMENTS ||
      total !== canonicalTotal ||
      index >= total ||
      objectLength > MAX_ACTIVATION_OBJECT ||
      index !== (this.#active ? this.#active.next : 0)
    ) {
      clear(messageId)
      return this.#fail()
    }
    const expectedSize =
      index + 1 === total
        ? objectLength - index * MAX_ACTIVATION_FRAGMENT_DATA
        : MAX_ACTIVATION_FRAGMENT_DATA
    if (dataSize !== expectedSize) {
      clear(messageId)
      return this.#fail()
    }
    const now = nowValue(this.#now)
    if (this.#destroyed) {
      clear(messageId)
      this.#clearActive()
      throw PrivateRouteError.CIRCUIT_STATE()
    }
    if (now > Number.MAX_SAFE_INTEGER - ACTIVATION_FRAGMENT_TIMEOUT) {
      clear(messageId)
      return this.#fail()
    }
    if (!this.#active) {
      this.#active = {
        key,
        id: messageId,
        total,
        objectLength,
        next: 0,
        parts: [],
        bytes: 0,
        deadline: now + ACTIVATION_FRAGMENT_TIMEOUT
      }
    } else {
      clear(messageId)
      if (
        this.#active.key !== key ||
        this.#active.total !== total ||
        this.#active.objectLength !== objectLength ||
        now >= this.#active.deadline
      )
        return this.#fail()
    }
    const part = copy(slice(frame, ACTIVATION_FRAGMENT_HEADER_SIZE))
    this.#active.parts.push(part)
    this.#active.bytes += length(part)
    this.#active.next++
    if (this.#active.next !== total) return null
    if (this.#completed.size >= MAX_COMPLETED_ACTIVATION_IDS) {
      this.#clearActive()
      limit()
    }
    let result = null
    try {
      result = b4a.concat(this.#active.parts, objectLength)
      if (length(result) !== objectLength) invalid()
      this.#completed.add(key)
      this.#clearActive()
      return result
    } catch (err) {
      clear(result)
      this.#clearActive()
      throw err
    }
  }

  expire() {
    if (this.#destroyed || !this.#active) return false
    if (nowValue(this.#now) < this.#active.deadline) return false
    this.#clearActive()
    return true
  }

  destroy() {
    this.#destroyed = true
    this.#clearActive()
    this.#completed.clear()
  }

  #fail() {
    this.#clearActive()
    invalid()
  }

  #clearActive() {
    if (!this.#active) return
    clear(this.#active.id)
    for (const part of this.#active.parts) clear(part)
    this.#active.parts.length = 0
    this.#active.bytes = 0
    this.#active = null
  }
}
