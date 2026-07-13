import b4a from 'b4a'

import { PrivateRouteError } from './errors.js'

export const MAX_COUNTER = (1n << 64n) - 1n
export const ROTATE_AT = MAX_COUNTER - 1024n

// Bounds both ordered storage and datagram bitmap work to a small, fixed amount.
const MAX_WINDOW = 4096

function invalid() {
  throw PrivateRouteError.COUNTER_INVALID()
}

function optionsObject(options, optional = false) {
  if (options === undefined && optional) return {}
  if (options === null || typeof options !== 'object' || Array.isArray(options)) invalid()
  return options
}

function option(options, name) {
  try {
    return options[name]
  } catch {
    invalid()
  }
}

function counterValue(value) {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_COUNTER) invalid()
  return value
}

function windowSize(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_WINDOW) invalid()
  return value
}

function timeValue(value) {
  if (!Number.isSafeInteger(value) || value < 0) invalid()
  return value
}

function copyBuffered(payload) {
  return b4a.isBuffer(payload) ? b4a.from(payload) : payload
}

function clearPayload(payload) {
  if (b4a.isBuffer(payload)) payload.fill(0)
}

export class SenderCounter {
  constructor(options) {
    options = optionsObject(options, true)
    const configured = option(options, 'initial')

    this._value = counterValue(configured === undefined ? 0n : configured)
    this._closed = false
  }

  // While open, value is the next counter that next() will emit. Once MAX is
  // emitted and the sender closes, it remains MAX and never wraps.
  get value() {
    return this._value
  }

  get needsRotation() {
    return this._value >= ROTATE_AT
  }

  get closed() {
    return this._closed
  }

  next() {
    if (this._closed) throw PrivateRouteError.COUNTER_EXHAUSTED()

    const counter = this._value
    if (counter === MAX_COUNTER) this._closed = true
    else this._value = counter + 1n

    return counter
  }
}

export class OrderedReceiver {
  constructor(options) {
    options = optionsObject(options)

    const window = option(options, 'window')
    const gapTimeout = option(options, 'gapTimeout')
    const now = option(options, 'now')
    const configured = option(options, 'initial')

    this._window = BigInt(windowSize(window))
    this._gapTimeout = timeValue(gapTimeout)
    if (typeof now !== 'function') invalid()
    this._now = now
    this._next = counterValue(configured === undefined ? 0n : configured)
    this._buffer = new Map()
    this._gapStartedAt = null
    this._closed = false
    this._mutating = false
  }

  get next() {
    return this._next
  }

  get needsRotation() {
    return this._next >= ROTATE_AT
  }

  get closed() {
    return this._closed
  }

  get buffered() {
    return this._buffer.size
  }

  pushAuthenticated(counter, payload) {
    return this._mutate(() => this._pushAuthenticated(counterValue(counter), payload))
  }

  expire(at) {
    return this._mutate(() => {
      if (this._closed) throw PrivateRouteError.COUNTER_EXHAUSTED()
      const current = at === undefined ? this._readNow() : timeValue(at)
      return this._expireAt(current)
    })
  }

  _pushAuthenticated(counter, payload) {
    if (this._closed) throw PrivateRouteError.COUNTER_EXHAUSTED()

    if (this._gapStartedAt !== null) this._expireAt(this._readNow())
    if (counter < this._next || this._buffer.has(counter)) throw PrivateRouteError.REPLAY()

    if (counter > this._next) {
      if (counter - this._next >= this._window) this._failGap()

      const startedAt = this._gapStartedAt === null ? this._readNow() : this._gapStartedAt
      if (this._gapTimeout === 0) this._failGap()

      const owned = copyBuffered(payload)
      this._buffer.set(counter, owned)
      this._gapStartedAt = startedAt
      return []
    }

    const delivered = [payload]
    if (counter === MAX_COUNTER) {
      this._closeExhausted()
      return delivered
    }

    this._next = counter + 1n
    while (this._buffer.has(this._next)) {
      const buffered = this._takeBuffered(this._next)
      delivered.push(buffered)

      if (this._next === MAX_COUNTER) {
        this._closeExhausted()
        return delivered
      }
      this._next++
    }

    if (this._buffer.size === 0) this._gapStartedAt = null
    return delivered
  }

  _mutate(operation) {
    if (this._mutating) invalid()
    this._mutating = true
    try {
      return operation()
    } finally {
      this._mutating = false
    }
  }

  _readNow() {
    let current
    try {
      current = this._now()
    } catch {
      invalid()
    }
    return timeValue(current)
  }

  _expireAt(current) {
    if (this._gapStartedAt === null) return false
    if (current - this._gapStartedAt < this._gapTimeout) return false
    this._failGap()
  }

  _takeBuffered(counter) {
    const owned = this._buffer.get(counter)
    this._buffer.delete(counter)

    if (!b4a.isBuffer(owned)) return owned
    const delivered = b4a.from(owned)
    owned.fill(0)
    return delivered
  }

  _clearBuffered() {
    for (const payload of this._buffer.values()) clearPayload(payload)
    this._buffer.clear()
    this._gapStartedAt = null
  }

  _failGap() {
    this._clearBuffered()
    this._closed = true
    throw PrivateRouteError.COUNTER_GAP()
  }

  _closeExhausted() {
    this._clearBuffered()
    this._next = MAX_COUNTER
    this._closed = true
  }
}

export class DatagramReplayWindow {
  constructor(options) {
    options = optionsObject(options)
    const window = windowSize(option(options, 'window'))

    this._window = BigInt(window)
    this._mask = (1n << this._window) - 1n
    this._highest = null
    this._bitmap = 0n
    this._closed = false
  }

  get floor() {
    if (this._highest === null || this._highest < this._window) return 0n
    return this._highest - this._window + 1n
  }

  get highest() {
    return this._highest
  }

  get needsRotation() {
    return this._highest !== null && this._highest >= ROTATE_AT
  }

  get closed() {
    return this._closed
  }

  get buffered() {
    let bitmap = this._bitmap
    let count = 0
    while (bitmap !== 0n) {
      bitmap &= bitmap - 1n
      count++
    }
    return count
  }

  acceptAuthenticated(value) {
    const counter = counterValue(value)
    if (this._closed) throw PrivateRouteError.COUNTER_EXHAUSTED()

    if (this._highest === null) {
      this._highest = counter
      this._bitmap = 1n
      if (counter === MAX_COUNTER) this._closed = true
      return true
    }

    if (counter > this._highest) {
      const shift = counter - this._highest
      this._bitmap = shift >= this._window ? 1n : ((this._bitmap << shift) | 1n) & this._mask
      this._highest = counter
      if (counter === MAX_COUNTER) this._closed = true
      return true
    }

    if (counter < this.floor) throw PrivateRouteError.REPLAY()

    const bit = 1n << (this._highest - counter)
    if ((this._bitmap & bit) !== 0n) throw PrivateRouteError.REPLAY()

    this._bitmap |= bit
    return true
  }
}
