import b4a from 'b4a'

import { PrivateRouteError } from './errors.js'

export const MAX_COUNTER = (1n << 64n) - 1n
export const ROTATE_AT = MAX_COUNTER - 1024n

// Imported only by this module's tests. It is intentionally absent from the
// package entry point so production callers cannot depend on owned buffers.
export const TEST_ONLY_BUFFER_OBSERVER = Symbol('test-only-buffer-observer')

const MAX_WINDOW = 4096
const MAX_BUFFERED_PAYLOAD = 1146
const bufferByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const bufferFill = Uint8Array.prototype.fill
const bufferSet = Uint8Array.prototype.set

function invalid() {
  throw PrivateRouteError.COUNTER_INVALID()
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
    return b4a.isBuffer(value) ? bufferByteLength.call(value) : -1
  } catch {
    return -1
  }
}

function counterValue(value, maximum = MAX_COUNTER) {
  if (typeof value !== 'bigint' || value < 0n || value > maximum) invalid()
  return value
}

function counterMaximum(value) {
  return counterValue(value === undefined ? MAX_COUNTER : value)
}

function rotationAt(maximum) {
  return maximum > 1024n ? maximum - 1024n : 0n
}

function windowSize(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_WINDOW) invalid()
  return value
}

function isTime(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function timeValue(value) {
  if (!isTime(value)) invalid()
  return value
}

function clearPayload(payload) {
  try {
    if (b4a.isBuffer(payload)) bufferFill.call(payload, 0)
  } catch {
    // Best-effort zeroization only.
  }
}

export class SenderCounter {
  #value
  #maximum
  #rotateAt
  #closed

  constructor(options) {
    options = optionsObject(options, true)
    const configured = option(options, 'initial')
    this.#maximum = counterMaximum(option(options, 'maximum'))
    this.#rotateAt = rotationAt(this.#maximum)

    this.#value = counterValue(configured === undefined ? 0n : configured, this.#maximum)
    this.#closed = false
  }

  // While open, value is the next counter that next() will emit. Once MAX is
  // emitted and the sender closes, it remains MAX and never wraps.
  get value() {
    return this.#value
  }

  get needsRotation() {
    return this.#value >= this.#rotateAt
  }

  get closed() {
    return this.#closed
  }

  next() {
    if (this.#closed) throw PrivateRouteError.COUNTER_EXHAUSTED()

    const counter = this.#value
    if (counter === this.#maximum) this.#closed = true
    else this.#value = counter + 1n

    return counter
  }

  destroy() {
    this.#value = 0n
    this.#closed = true
  }
}

export class OrderedReceiver {
  #window
  #gapTimeout
  #now
  #next
  #maximum
  #rotateAt
  #buffer
  #gapStartedAt
  #lastObservedAt
  #closed
  #mutating
  #observeBuffered

  constructor(options) {
    options = optionsObject(options)

    const window = option(options, 'window')
    const gapTimeout = option(options, 'gapTimeout')
    const now = option(options, 'now')
    const configured = option(options, 'initial')
    const observeBuffered = option(options, TEST_ONLY_BUFFER_OBSERVER)

    this.#window = BigInt(windowSize(window))
    this.#gapTimeout = timeValue(gapTimeout)
    if (typeof now !== 'function') invalid()
    if (observeBuffered !== undefined && typeof observeBuffered !== 'function') invalid()
    this.#now = now
    this.#maximum = counterMaximum(option(options, 'maximum'))
    this.#rotateAt = rotationAt(this.#maximum)
    this.#next = counterValue(configured === undefined ? 0n : configured, this.#maximum)
    this.#buffer = new Map()
    this.#gapStartedAt = null
    this.#lastObservedAt = null
    this.#closed = false
    this.#mutating = false
    this.#observeBuffered = observeBuffered || null
  }

  get next() {
    return this.#next
  }

  get needsRotation() {
    return this.#next >= this.#rotateAt
  }

  get closed() {
    return this.#closed
  }

  get buffered() {
    return this.#buffer.size
  }

  pushAuthenticated(counter, payload) {
    return this.#mutate(() =>
      this.#pushAuthenticated(counterValue(counter, this.#maximum), payload)
    )
  }

  expire(at) {
    return this.#mutate(() => {
      if (this.#closed) throw PrivateRouteError.COUNTER_EXHAUSTED()
      const current = at === undefined ? this.#readNow() : this.#clockValue(at)
      return this.#expireAt(current)
    })
  }

  destroy() {
    return this.#mutate(() => {
      this.#clearBuffered()
      this.#next = 0n
      this.#closed = true
    })
  }

  #pushAuthenticated(counter, payload) {
    if (this.#closed) throw PrivateRouteError.COUNTER_EXHAUSTED()

    if (this.#gapStartedAt !== null) this.#expireAt(this.#readNow())
    if (counter < this.#next || this.#buffer.has(counter)) throw PrivateRouteError.REPLAY()

    if (counter > this.#next) {
      if (counter - this.#next >= this.#window) this.#failGap()
      if (this.#gapTimeout === 0) this.#failGap()

      const startsGap = this.#gapStartedAt === null
      const startedAt = startsGap ? this.#readNow() : this.#gapStartedAt
      const owned = this.#copyForBuffer(payload)
      this.#buffer.set(counter, owned)
      if (startsGap) {
        this.#gapStartedAt = startedAt
        this.#lastObservedAt = startedAt
      }
      this.#notifyObserver(owned)
      return []
    }

    const delivered = [payload]
    if (counter === this.#maximum) {
      this.#closeExhausted()
      return delivered
    }

    this.#next = counter + 1n
    while (this.#buffer.has(this.#next)) {
      const buffered = this.#takeBuffered(this.#next)
      delivered.push(buffered)

      if (this.#next === this.#maximum) {
        this.#closeExhausted()
        return delivered
      }
      this.#next++
    }

    if (this.#buffer.size === 0) {
      this.#gapStartedAt = null
      this.#lastObservedAt = null
    }
    return delivered
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

  #readNow() {
    let current
    try {
      current = this.#now()
    } catch {
      return this.#failClock()
    }
    return this.#clockValue(current)
  }

  #clockValue(current) {
    if (!isTime(current)) return this.#failClock()
    return current
  }

  #failClock() {
    if (this.#gapStartedAt !== null) this.#failInvalid()
    invalid()
  }

  #expireAt(current) {
    if (this.#gapStartedAt === null) return false
    if (current < this.#lastObservedAt) this.#failInvalid()
    this.#lastObservedAt = current
    if (current - this.#gapStartedAt < this.#gapTimeout) return false
    this.#failGap()
  }

  #copyForBuffer(payload) {
    const length = bufferLength(payload)
    if (length >= 0) {
      if (length > MAX_BUFFERED_PAYLOAD) this.#failInvalid()
      let owned = null
      try {
        owned = b4a.allocUnsafeSlow(length)
        if (bufferLength(owned) !== length) this.#failInvalid()
        bufferSet.call(owned, payload)
        return owned
      } catch {
        clearPayload(owned)
        this.#failInvalid()
      }
    }

    if (typeof payload !== 'string') this.#failInvalid()
    try {
      if (b4a.byteLength(payload) > MAX_BUFFERED_PAYLOAD) this.#failInvalid()
    } catch (err) {
      if (err instanceof PrivateRouteError) throw err
      this.#failInvalid()
    }
    return payload
  }

  #notifyObserver(owned) {
    if (this.#observeBuffered === null) return
    try {
      this.#observeBuffered(owned)
    } catch {
      this.#failInvalid()
    }
  }

  #takeBuffered(counter) {
    const owned = this.#buffer.get(counter)
    if (!b4a.isBuffer(owned)) {
      this.#buffer.delete(counter)
      return owned
    }

    let delivered = null
    try {
      const length = bufferLength(owned)
      if (length < 0) this.#failInvalid()
      delivered = b4a.allocUnsafeSlow(length)
      if (bufferLength(delivered) !== length) this.#failInvalid()
      bufferSet.call(delivered, owned)
    } catch {
      clearPayload(delivered)
      this.#failInvalid()
    }
    this.#buffer.delete(counter)
    clearPayload(owned)
    return delivered
  }

  #clearBuffered() {
    for (const payload of this.#buffer.values()) clearPayload(payload)
    this.#buffer.clear()
    this.#gapStartedAt = null
    this.#lastObservedAt = null
  }

  #failGap() {
    this.#clearBuffered()
    this.#closed = true
    throw PrivateRouteError.COUNTER_GAP()
  }

  #failInvalid() {
    this.#clearBuffered()
    this.#closed = true
    invalid()
  }

  #closeExhausted() {
    this.#clearBuffered()
    this.#next = this.#maximum
    this.#closed = true
  }
}

export class DatagramReplayWindow {
  #window
  #mask
  #highest
  #maximum
  #rotateAt
  #bitmap
  #closed

  constructor(options) {
    options = optionsObject(options)
    const window = windowSize(option(options, 'window'))
    this.#maximum = counterMaximum(option(options, 'maximum'))
    this.#rotateAt = rotationAt(this.#maximum)

    this.#window = BigInt(window)
    this.#mask = (1n << this.#window) - 1n
    this.#highest = null
    this.#bitmap = 0n
    this.#closed = false
  }

  get floor() {
    if (this.#highest === null || this.#highest < this.#window) return 0n
    return this.#highest - this.#window + 1n
  }

  get highest() {
    return this.#highest
  }

  get needsRotation() {
    return this.#highest !== null && this.#highest >= this.#rotateAt
  }

  get closed() {
    return this.#closed
  }

  get buffered() {
    let bitmap = this.#bitmap
    let count = 0
    while (bitmap !== 0n) {
      bitmap &= bitmap - 1n
      count++
    }
    return count
  }

  acceptAuthenticated(value) {
    const counter = counterValue(value, this.#maximum)
    if (this.#closed) throw PrivateRouteError.COUNTER_EXHAUSTED()

    if (this.#highest === null) {
      this.#highest = counter
      this.#bitmap = 1n
      if (counter === this.#maximum) this.#closed = true
      return true
    }

    if (counter > this.#highest) {
      const shift = counter - this.#highest
      this.#bitmap = shift >= this.#window ? 1n : ((this.#bitmap << shift) | 1n) & this.#mask
      this.#highest = counter
      if (counter === this.#maximum) this.#closed = true
      return true
    }

    if (counter < this.floor) throw PrivateRouteError.REPLAY()

    const bit = 1n << (this.#highest - counter)
    if ((this.#bitmap & bit) !== 0n) throw PrivateRouteError.REPLAY()

    this.#bitmap |= bit
    return true
  }

  destroy() {
    this.#highest = null
    this.#bitmap = 0n
    this.#closed = true
  }
}
