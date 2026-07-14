import b4a from 'b4a'

export const CONTROL_BODY_MAX = 64 * 1024

export const CONTROL_COMMAND = Object.freeze({
  CONFIGURE: 'configure',
  START: 'start',
  FAULT: 'fault',
  REVOKE: 'revoke',
  SNAPSHOT: 'snapshot',
  STOP: 'stop'
})

export const CONTROL_EVENT = Object.freeze({
  CONFIGURED: 'configured',
  READY: 'ready',
  SNAPSHOT: 'snapshot',
  CLOSED: 'closed',
  ERROR: 'error'
})

export const CONTROL_FAULT = Object.freeze({
  CLOSE_SOCKET: 'close-socket',
  DELAY_CREATED: 'delay-created',
  SPOOF_SOURCE: 'spoof-source',
  REPLAY: 'replay',
  OVERFLOW_QUEUE: 'overflow-queue',
  RETRY: 'retry'
})

const COMMANDS = new Set(Object.values(CONTROL_COMMAND))
const EVENTS = new Set(Object.values(CONTROL_EVENT))
const FAULTS = new Set(Object.values(CONTROL_FAULT))
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get

function invalid(message = 'invalid process control frame') {
  return new TypeError(message)
}

function bufferLength(value) {
  try {
    return b4a.isBuffer(value) ? byteLength.call(value) : -1
  } catch {
    return -1
  }
}

function plain(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || b4a.isBuffer(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validString(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

function canonicalValue(value, seen) {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (!validString(value)) throw invalid()
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw invalid()
    return value
  }
  if (typeof value === 'bigint') return { $bigint: value.toString() }
  const size = bufferLength(value)
  if (size >= 0) return { $bytes: b4a.toString(value, 'hex') }
  if (typeof value !== 'object' || value === null || seen.has(value)) throw invalid()
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry, seen))
    if (!plain(value)) throw invalid()
    const output = {}
    for (const key of Object.keys(value).sort()) {
      if (FORBIDDEN_KEYS.has(key) || key.startsWith('$')) throw invalid()
      output[key] = canonicalValue(value[key], seen)
    }
    return output
  } finally {
    seen.delete(value)
  }
}

function revive(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') {
    if (!validString(value)) throw invalid()
    return value
  }
  if (Array.isArray(value)) return value.map(revive)
  if (!plain(value)) throw invalid()
  const keys = Object.keys(value)
  if (keys.length === 1 && keys[0] === '$bytes') {
    const encoded = value.$bytes
    if (typeof encoded !== 'string' || encoded.length % 2 !== 0 || !/^[0-9a-f]*$/.test(encoded)) {
      throw invalid()
    }
    return b4a.from(encoded, 'hex')
  }
  if (keys.length === 1 && keys[0] === '$bigint') {
    const encoded = value.$bigint
    if (typeof encoded !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(encoded)) throw invalid()
    return BigInt(encoded)
  }
  const output = {}
  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key) || key.startsWith('$')) throw invalid()
    output[key] = revive(value[key])
  }
  return output
}

function exactKeys(value, keys) {
  if (!plain(value)) throw invalid('invalid process control record')
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length) throw invalid('invalid process control record')
  for (let index = 0; index < actual.length; index++) {
    if (actual[index] !== expected[index]) throw invalid('invalid process control record')
  }
  return value
}

export function encodeCanonical(value) {
  const encoded = b4a.from(JSON.stringify(canonicalValue(value, new Set())))
  if (encoded.byteLength < 1 || encoded.byteLength > CONTROL_BODY_MAX) throw invalid()
  return encoded
}

export function decodeCanonical(encoded) {
  if (bufferLength(encoded) < 1 || encoded.byteLength > CONTROL_BODY_MAX) throw invalid()
  let parsed = null
  let value = null
  let canonical = null
  try {
    parsed = JSON.parse(b4a.toString(encoded))
    value = revive(parsed)
    canonical = encodeCanonical(value)
    if (!b4a.equals(canonical, encoded)) throw invalid('non-canonical process control frame')
    return value
  } catch (err) {
    if (err instanceof TypeError && err.message.includes('process control')) throw err
    throw invalid()
  } finally {
    if (canonical) canonical.fill(0)
  }
}

export function encodeControlFrame(value) {
  const body = encodeCanonical(value)
  const frame = b4a.allocUnsafe(4 + body.byteLength)
  frame[0] = body.byteLength >>> 24
  frame[1] = body.byteLength >>> 16
  frame[2] = body.byteLength >>> 8
  frame[3] = body.byteLength
  frame.set(body, 4)
  body.fill(0)
  return frame
}

export function validateControlCommand(value) {
  if (!plain(value) || !COMMANDS.has(value.command)) throw invalid('invalid process command')
  switch (value.command) {
    case CONTROL_COMMAND.CONFIGURE:
      exactKeys(value, ['command', 'projection'])
      if (!plain(value.projection)) throw invalid('invalid process command')
      break
    case CONTROL_COMMAND.FAULT:
      exactKeys(value, ['command', 'fault'])
      if (!FAULTS.has(value.fault)) throw invalid('invalid process command')
      break
    case CONTROL_COMMAND.REVOKE:
      exactKeys(value, ['command', 'grantDigest32'])
      if (bufferLength(value.grantDigest32) !== 32) throw invalid('invalid process command')
      break
    default:
      exactKeys(value, ['command'])
  }
  return value
}

export function validateControlEvent(value) {
  if (!plain(value) || !EVENTS.has(value.event)) throw invalid('invalid process event')
  return value
}

export class ControlFrameDecoder {
  #header = b4a.alloc(4)
  #headerOffset = 0
  #body = null
  #bodyOffset = 0
  #destroyed = false

  push(chunk) {
    if (this.#destroyed || bufferLength(chunk) < 0) throw invalid()
    const records = []
    let offset = 0
    while (offset < chunk.byteLength) {
      if (this.#body === null) {
        const available = Math.min(4 - this.#headerOffset, chunk.byteLength - offset)
        this.#header.set(chunk.subarray(offset, offset + available), this.#headerOffset)
        this.#headerOffset += available
        offset += available
        if (this.#headerOffset < 4) continue
        const size =
          this.#header[0] * 0x1000000 +
          (this.#header[1] << 16) +
          (this.#header[2] << 8) +
          this.#header[3]
        this.#header.fill(0)
        this.#headerOffset = 0
        if (size < 1 || size > CONTROL_BODY_MAX) throw invalid()
        this.#body = b4a.allocUnsafe(size)
      }
      const available = Math.min(
        this.#body.byteLength - this.#bodyOffset,
        chunk.byteLength - offset
      )
      this.#body.set(chunk.subarray(offset, offset + available), this.#bodyOffset)
      this.#bodyOffset += available
      offset += available
      if (this.#bodyOffset !== this.#body.byteLength) continue
      const body = this.#body
      this.#body = null
      this.#bodyOffset = 0
      try {
        records.push(decodeCanonical(body))
      } finally {
        body.fill(0)
      }
    }
    return records
  }

  destroy() {
    if (this.#destroyed) return false
    this.#destroyed = true
    this.#header.fill(0)
    if (this.#body) this.#body.fill(0)
    this.#body = null
    this.#headerOffset = 0
    this.#bodyOffset = 0
    return true
  }
}

export class ControlLifecycle {
  #state = 'NEW'
  #closed = false
  #configured = false
  #ready = false

  get state() {
    return this.#state
  }

  accept(value) {
    const command = validateControlCommand(value).command
    if (this.#state === 'STOPPING' || this.#state === 'CLOSED') throw invalid('command after stop')
    if (command === CONTROL_COMMAND.CONFIGURE) {
      if (this.#state !== 'NEW') throw invalid('duplicate or late configuration')
      this.#state = 'CONFIGURED'
      return command
    }
    if (command === CONTROL_COMMAND.START) {
      if (this.#state !== 'CONFIGURED') throw invalid('start before configuration')
      this.#state = 'STARTED'
      return command
    }
    if (command === CONTROL_COMMAND.STOP) {
      if (this.#state !== 'CONFIGURED' && this.#state !== 'STARTED') {
        throw invalid('stop before configuration')
      }
      this.#state = 'STOPPING'
      return command
    }
    if (
      (command === CONTROL_COMMAND.FAULT || command === CONTROL_COMMAND.REVOKE) &&
      this.#state === 'CONFIGURED'
    ) {
      return command
    }
    if (this.#state !== 'STARTED') throw invalid('command before start')
    return command
  }

  emit(value) {
    const event = validateControlEvent(value).event
    if (this.#closed) throw invalid('event after closed')
    switch (event) {
      case CONTROL_EVENT.CONFIGURED:
        if (this.#state !== 'CONFIGURED' || this.#configured) {
          throw invalid('unexpected configured event')
        }
        this.#configured = true
        break
      case CONTROL_EVENT.READY:
        if (this.#state !== 'STARTED' || !this.#configured || this.#ready) {
          throw invalid('unexpected ready event')
        }
        this.#ready = true
        break
      case CONTROL_EVENT.SNAPSHOT:
        if (this.#state !== 'STARTED' || !this.#ready) throw invalid('unexpected snapshot event')
        break
      case CONTROL_EVENT.ERROR:
        if (!this.#configured || this.#state === 'STOPPING') throw invalid('unexpected error event')
        break
      case CONTROL_EVENT.CLOSED:
        if (this.#state !== 'STOPPING') throw invalid('closed before stop')
        this.#closed = true
        this.#state = 'CLOSED'
        break
      default:
        throw invalid('invalid process event')
    }
    return event
  }
}
