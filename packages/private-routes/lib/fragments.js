import b4a from 'b4a'

import { cryptoSuite } from './crypto-suite.js'
import { PrivateRouteError } from './errors.js'
import { MAX_ROUTE_PAYLOAD } from './route-payload.js'

export const FRAGMENT_HEADER_SIZE = 20
export const MAX_FRAGMENT_DATA = MAX_ROUTE_PAYLOAD - FRAGMENT_HEADER_SIZE
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024
export const MAX_MESSAGES = 64
export const MAX_BUFFERED_BYTES = 32 * 1024 * 1024
export const MAX_COMPLETED_IDS = 4096
export const MESSAGE_TIMEOUT = 30_000

export const TEST_ONLY_FRAGMENT_OBSERVER = Symbol('test-only-fragment-observer')

const MESSAGE_ID_BYTES = 16
const MAX_FRAGMENTS = Math.ceil(MAX_MESSAGE_BYTES / MAX_FRAGMENT_DATA)

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function limit() {
  throw PrivateRouteError.CIRCUIT_LIMIT()
}

function optionsObject(options, optional = false) {
  if (options === undefined && optional) return {}
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

function clear(value) {
  try {
    if (b4a.isBuffer(value)) b4a.fill(value, 0)
  } catch {
    // Best-effort zeroization only.
  }
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

function positiveLimit(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid()
  return value
}

function timeoutValue(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MESSAGE_TIMEOUT) invalid()
  return value
}

function timeValue(value) {
  if (!Number.isSafeInteger(value) || value < 0) invalid()
  return value
}

function writeUint16BE(buffer, value, offset) {
  buffer[offset] = value >>> 8
  buffer[offset + 1] = value
}

function readUint16BE(buffer, offset) {
  return (buffer[offset] << 8) | buffer[offset + 1]
}

function idKey(messageId) {
  try {
    return b4a.toString(messageId, 'hex')
  } catch {
    invalid()
  }
}

function same(a, b) {
  try {
    return b4a.equals(a, b)
  } catch {
    invalid()
  }
}

export function fragment(message, options) {
  const messageLength = bufferLength(message)
  if (messageLength < 0 || messageLength > MAX_MESSAGE_BYTES) invalid()
  options = optionsObject(options, true)
  let messageId = option(options, 'messageId')
  const randomBytes = option(options, 'randomBytes')
  if (messageId === undefined) {
    const random = randomBytes === undefined ? cryptoSuite.randomBytes : randomBytes
    if (typeof random !== 'function') invalid()
    try {
      messageId = random(MESSAGE_ID_BYTES)
    } catch {
      invalid()
    }
  }
  if (!isBuffer(messageId, MESSAGE_ID_BYTES)) invalid()

  const total = Math.max(1, Math.ceil(messageLength / MAX_FRAGMENT_DATA))
  const frames = new Array(total)
  for (let index = 0; index < total; index++) {
    const start = index * MAX_FRAGMENT_DATA
    const end = Math.min(start + MAX_FRAGMENT_DATA, messageLength)
    const frame = b4a.allocUnsafeSlow(FRAGMENT_HEADER_SIZE + end - start)
    frame.set(messageId, 0)
    writeUint16BE(frame, index, 16)
    writeUint16BE(frame, total, 18)
    frame.set(message.subarray(start, end), FRAGMENT_HEADER_SIZE)
    frames[index] = frame
  }
  return frames
}

export class Reassembler {
  #now
  #epochExpiresAt
  #maxMessageBytes
  #maxMessages
  #maxBufferedBytes
  #maxCompletedIds
  #messageTimeout
  #observe
  #messages
  #completed
  #bufferedBytes
  #lastNow
  #destroyed
  #mutating

  constructor(options) {
    options = optionsObject(options)
    const now = option(options, 'now')
    if (typeof now !== 'function') invalid()
    this.#now = now
    this.#epochExpiresAt = timeValue(option(options, 'epochExpiresAt'))
    this.#maxMessageBytes = positiveLimit(
      option(options, 'maxMessageBytes') ?? MAX_MESSAGE_BYTES,
      MAX_MESSAGE_BYTES
    )
    this.#maxMessages = positiveLimit(option(options, 'maxMessages') ?? MAX_MESSAGES, MAX_MESSAGES)
    this.#maxBufferedBytes = positiveLimit(
      option(options, 'maxBufferedBytes') ?? MAX_BUFFERED_BYTES,
      MAX_BUFFERED_BYTES
    )
    this.#maxCompletedIds = positiveLimit(
      option(options, 'maxCompletedIds') ?? MAX_COMPLETED_IDS,
      MAX_COMPLETED_IDS
    )
    this.#messageTimeout = timeoutValue(option(options, 'messageTimeout') ?? MESSAGE_TIMEOUT)
    const observe = option(options, TEST_ONLY_FRAGMENT_OBSERVER)
    if (observe !== undefined && typeof observe !== 'function') invalid()
    this.#observe = observe || null
    this.#messages = new Map()
    this.#completed = new Set()
    this.#bufferedBytes = 0
    this.#lastNow = null
    this.#destroyed = false
    this.#mutating = false
  }

  get stats() {
    return Object.freeze({
      destroyed: this.#destroyed,
      messages: this.#messages.size,
      bufferedBytes: this.#bufferedBytes,
      completedIds: this.#completed.size
    })
  }

  pushAuthenticated(value) {
    return this.#mutate(() => this.#pushAuthenticated(value))
  }

  expire(at) {
    return this.#mutate(() => {
      this.#assertOpen()
      const current = at === undefined ? this.#readNow() : this.#observeTime(at)
      return this.#expireAt(current)
    })
  }

  destroy() {
    if (this.#destroyed) return
    return this.#mutate(() => this.#destroyAll())
  }

  #pushAuthenticated(value) {
    this.#assertOpen()
    const current = this.#readNow()
    this.#expireAt(current)
    const length = bufferLength(value)
    if (length < FRAGMENT_HEADER_SIZE) invalid()

    const messageId = value.subarray(0, MESSAGE_ID_BYTES)
    const key = idKey(messageId)
    if (this.#completed.has(key)) throw PrivateRouteError.REPLAY()
    const existing = this.#messages.get(key)
    if (length > MAX_ROUTE_PAYLOAD) {
      if (existing) this.#remove(existing)
      invalid()
    }

    const index = readUint16BE(value, 16)
    const total = readUint16BE(value, 18)
    const dataLength = length - FRAGMENT_HEADER_SIZE
    if (total === 0 || total > MAX_FRAGMENTS || index >= total) {
      if (existing) this.#remove(existing)
      invalid()
    }
    if (index < total - 1 && dataLength !== MAX_FRAGMENT_DATA) {
      if (existing) this.#remove(existing)
      invalid()
    }
    if (total > 1 && index === total - 1 && dataLength === 0) {
      if (existing) this.#remove(existing)
      invalid()
    }

    if (existing && existing.total !== total) {
      this.#remove(existing)
      invalid()
    }

    const maximumBytes = (total - 1) * MAX_FRAGMENT_DATA + dataLength
    if (!Number.isSafeInteger(maximumBytes)) {
      if (existing) this.#remove(existing)
      invalid()
    }
    if (
      total > Math.ceil(this.#maxMessageBytes / MAX_FRAGMENT_DATA) ||
      (index === total - 1 && maximumBytes > this.#maxMessageBytes)
    ) {
      if (existing) this.#remove(existing)
      limit()
    }

    if (existing && existing.parts.has(index)) {
      const accepted = existing.parts.get(index)
      if (same(accepted, value.subarray(FRAGMENT_HEADER_SIZE))) throw PrivateRouteError.REPLAY()
      this.#remove(existing)
      invalid()
    }

    if (!existing) {
      if (this.#completed.size >= this.#maxCompletedIds) limit()
      if (this.#messages.size >= this.#maxMessages) limit()
    }
    if (this.#bufferedBytes + dataLength > this.#maxBufferedBytes) limit()

    let owned
    try {
      owned = copy(value.subarray(FRAGMENT_HEADER_SIZE))
    } catch (err) {
      if (existing) this.#remove(existing)
      throw err
    }
    let state = existing
    if (!state) {
      state = {
        key,
        total,
        startedAt: current,
        parts: new Map(),
        bytes: 0
      }
      this.#messages.set(key, state)
    }
    state.parts.set(index, owned)
    state.bytes += dataLength
    this.#bufferedBytes += dataLength
    this.#notify(owned)

    if (state.parts.size !== total) return null
    if (this.#completed.size >= this.#maxCompletedIds) {
      this.#remove(state)
      limit()
    }
    return this.#complete(state)
  }

  #complete(state) {
    if (state.bytes > this.#maxMessageBytes) limit()
    let message = null
    try {
      message = b4a.allocUnsafeSlow(state.bytes)
      let offset = 0
      for (let index = 0; index < state.total; index++) {
        const part = state.parts.get(index)
        if (!part) invalid()
        message.set(part, offset)
        offset += part.byteLength
      }
      if (offset !== state.bytes) invalid()
    } catch (err) {
      clear(message)
      this.#remove(state)
      if (err instanceof PrivateRouteError) throw err
      invalid()
    }

    this.#completed.add(state.key)
    this.#remove(state)
    return message
  }

  #notify(owned) {
    if (this.#observe === null) return
    try {
      this.#observe(owned)
    } catch {
      this.#destroyAll()
      invalid()
    }
  }

  #mutate(operation) {
    if (this.#mutating) invalid()
    this.#mutating = true
    try {
      return operation()
    } finally {
      this.#mutating = false
    }
  }

  #assertOpen() {
    if (this.#destroyed) throw PrivateRouteError.CIRCUIT_STATE()
  }

  #readNow() {
    let current
    try {
      current = this.#now()
    } catch {
      this.#destroyAll()
      invalid()
    }
    return this.#observeTime(current)
  }

  #observeTime(current) {
    if (!Number.isSafeInteger(current) || current < 0) {
      this.#destroyAll()
      invalid()
    }
    if (this.#lastNow !== null && current < this.#lastNow) {
      this.#destroyAll()
      invalid()
    }
    this.#lastNow = current
    if (current >= this.#epochExpiresAt) {
      this.#destroyAll()
      throw PrivateRouteError.CIRCUIT_STATE()
    }
    return current
  }

  #expireAt(current) {
    let expired = 0
    for (const state of this.#messages.values()) {
      if (current - state.startedAt < this.#messageTimeout) continue
      this.#remove(state)
      expired++
    }
    return expired
  }

  #remove(state) {
    if (!this.#messages.delete(state.key)) return
    for (const part of state.parts.values()) clear(part)
    this.#bufferedBytes -= state.bytes
    state.parts.clear()
    state.bytes = 0
  }

  #destroyAll() {
    for (const state of this.#messages.values()) {
      for (const part of state.parts.values()) clear(part)
      state.parts.clear()
      state.bytes = 0
    }
    this.#messages.clear()
    this.#completed.clear()
    this.#bufferedBytes = 0
    this.#destroyed = true
  }
}
