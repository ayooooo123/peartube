import b4a from 'b4a'

import { PrivateRouteError } from './errors.js'
import { CELL_CLASS, DIRECTION, PROTOCOL_VERSION } from './protocol.js'

export const CONTROL_NAMESPACE = Object.freeze({
  LINK: 0x00,
  ACTOR: 0x01
})

export const LINK_CONTROL_KIND = Object.freeze({
  LINK_PING: 0,
  LINK_PONG: 1,
  STREAM_ACK: 2
})

export const ACTOR_CONTROL_KIND = Object.freeze({
  REGISTER_STAGE: 0,
  REGISTER_STAGED: 1,
  REGISTER_PREPARE: 2,
  REGISTER_PREPARED: 3,
  REGISTER_FINALIZE: 4,
  REGISTER_FINALIZED: 5,
  REGISTER_ABORT: 6,
  REGISTER_ABORTED: 7,
  ACTIVATE_CREATE: 8,
  ACTIVATE_CREATED: 9,
  CIRCUIT_DESTROY: 10,
  CIRCUIT_DESTROYED: 11,
  ERROR: 12
})

export const ACTOR_ERROR_CODE = Object.freeze({
  UNAUTHORIZED: 0,
  CIRCUIT_LIMIT: 1,
  CIRCUIT_STATE: 2,
  ROUTE_UNAVAILABLE: 3
})

export const CIRCUIT_DESTROY_REASON = Object.freeze({
  REQUESTED: 0,
  EXPIRED: 1,
  REVOKED: 2,
  TRANSPORT_LOST: 3,
  ACK_TIMEOUT: 4
})

export const LINK_CONTROL_BODY_SIZE = 44
export const REMOTE_CONTROL_FRAGMENT_HEADER_SIZE = 22
export const MAX_REMOTE_CONTROL_FRAGMENT_DATA = 1123
export const MAX_REMOTE_CONTROL_OBJECT = 8192
export const MAX_REMOTE_CONTROL_FRAGMENTS = 8
export const REMOTE_CONTROL_FRAGMENT_TIMEOUT = 5_000
export const MAX_COMPLETED_REMOTE_CONTROL_IDS = 64
export const ACTOR_CONTROL_HEADER_SIZE = 54
export const ACTOR_CONTROL_BODY_MAX = MAX_REMOTE_CONTROL_OBJECT - ACTOR_CONTROL_HEADER_SIZE

const MAX_UINT64 = (1n << 64n) - 1n
const REPLY_KIND = new Map([
  [ACTOR_CONTROL_KIND.REGISTER_STAGE, ACTOR_CONTROL_KIND.REGISTER_STAGED],
  [ACTOR_CONTROL_KIND.REGISTER_PREPARE, ACTOR_CONTROL_KIND.REGISTER_PREPARED],
  [ACTOR_CONTROL_KIND.REGISTER_FINALIZE, ACTOR_CONTROL_KIND.REGISTER_FINALIZED],
  [ACTOR_CONTROL_KIND.REGISTER_ABORT, ACTOR_CONTROL_KIND.REGISTER_ABORTED],
  [ACTOR_CONTROL_KIND.ACTIVATE_CREATE, ACTOR_CONTROL_KIND.ACTIVATE_CREATED],
  [ACTOR_CONTROL_KIND.CIRCUIT_DESTROY, ACTOR_CONTROL_KIND.CIRCUIT_DESTROYED]
])
const REGISTRATION_KINDS = new Set([
  ACTOR_CONTROL_KIND.REGISTER_STAGE,
  ACTOR_CONTROL_KIND.REGISTER_STAGED,
  ACTOR_CONTROL_KIND.REGISTER_PREPARE,
  ACTOR_CONTROL_KIND.REGISTER_PREPARED,
  ACTOR_CONTROL_KIND.REGISTER_FINALIZE,
  ACTOR_CONTROL_KIND.REGISTER_FINALIZED,
  ACTOR_CONTROL_KIND.REGISTER_ABORT,
  ACTOR_CONTROL_KIND.REGISTER_ABORTED
])
const ACTOR_KINDS = new Set(Object.values(ACTOR_CONTROL_KIND))
const ACTOR_ERROR_CODES = new Set(Object.values(ACTOR_ERROR_CODE))
const DESTROY_REASONS = new Set(Object.values(CIRCUIT_DESTROY_REASON))
const LINK_KINDS = new Set(Object.values(LINK_CONTROL_KIND))
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

function circuitState() {
  throw PrivateRouteError.CIRCUIT_STATE()
}

function object(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
    return value
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  }
}

function option(value, name) {
  try {
    return value[name]
  } catch {
    invalid()
  }
}

function length(value) {
  try {
    return b4a.isBuffer(value) ? bufferByteLength.call(value) : -1
  } catch {
    return -1
  }
}

function fixed(value, size) {
  return length(value) === size
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) bufferFill.call(value, 0)
  } catch {}
}

function copy(value) {
  const size = length(value)
  if (size < 0) invalid()
  let result = null
  try {
    result = b4a.allocUnsafeSlow(size)
    bufferSet.call(result, value)
    return result
  } catch {
    clear(result)
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

function same(left, right) {
  if (length(left) !== length(right) || length(left) < 0) return false
  try {
    return b4a.equals(left, right)
  } catch {
    return false
  }
}

function allZero(value) {
  const size = length(value)
  if (size < 0) return false
  for (let index = 0; index < size; index++) if (value[index] !== 0) return false
  return true
}

function u64(value, nonzero = false) {
  return typeof value === 'bigint' && value >= (nonzero ? 1n : 0n) && value <= MAX_UINT64
}

function knownDirection(value) {
  return value === DIRECTION.FORWARD || value === DIRECTION.REVERSE
}

function writeU16(output, value, offset) {
  output[offset] = value >>> 8
  output[offset + 1] = value
}

function readU16(input, offset) {
  return input[offset] * 0x100 + input[offset + 1]
}

function writeU64(output, value, offset) {
  for (let index = offset + 7; index >= offset; index--) {
    output[index] = Number(value & 0xffn)
    value >>= 8n
  }
}

function readU64(input, offset) {
  let value = 0n
  for (let index = offset; index < offset + 8; index++) {
    value = (value << 8n) | BigInt(input[index])
  }
  return value
}

function hex(value) {
  try {
    return b4a.toString(value, 'hex')
  } catch {
    invalid()
  }
}

function outerHeader(value) {
  object(value)
  const cellClass = option(value, 'class')
  const direction = option(value, 'direction')
  const circuitId = option(value, 'circuitId')
  if (cellClass !== CELL_CLASS.CONTROL || !knownDirection(direction) || !fixed(circuitId, 16)) {
    invalid()
  }
  return { direction, circuitId }
}

function opposite(direction) {
  if (!knownDirection(direction)) invalid()
  return direction === DIRECTION.FORWARD ? DIRECTION.REVERSE : DIRECTION.FORWARD
}

function validateFragment(frame) {
  const size = length(frame)
  if (
    size < REMOTE_CONTROL_FRAGMENT_HEADER_SIZE ||
    size > REMOTE_CONTROL_FRAGMENT_HEADER_SIZE + MAX_REMOTE_CONTROL_FRAGMENT_DATA
  ) {
    invalid()
  }
  const index = readU16(frame, 16)
  const total = readU16(frame, 18)
  const objectLength = readU16(frame, 20)
  const canonicalTotal = Math.max(1, Math.ceil(objectLength / MAX_REMOTE_CONTROL_FRAGMENT_DATA))
  const expectedSize =
    index + 1 === total
      ? objectLength - index * MAX_REMOTE_CONTROL_FRAGMENT_DATA
      : MAX_REMOTE_CONTROL_FRAGMENT_DATA
  if (
    total < 1 ||
    total > MAX_REMOTE_CONTROL_FRAGMENTS ||
    total !== canonicalTotal ||
    index >= total ||
    objectLength > MAX_REMOTE_CONTROL_OBJECT ||
    size - REMOTE_CONTROL_FRAGMENT_HEADER_SIZE !== expectedSize
  ) {
    invalid()
  }
  return { index, total, objectLength }
}

function fragmentMessage(message, options) {
  const size = length(message)
  object(options)
  const messageId = option(options, 'messageId')
  if (size < 0 || size > MAX_REMOTE_CONTROL_OBJECT || !fixed(messageId, 16)) invalid()
  const total = Math.max(1, Math.ceil(size / MAX_REMOTE_CONTROL_FRAGMENT_DATA))
  if (total > MAX_REMOTE_CONTROL_FRAGMENTS) invalid()
  const result = []
  let current = null
  try {
    for (let index = 0; index < total; index++) {
      const start = index * MAX_REMOTE_CONTROL_FRAGMENT_DATA
      const end = Math.min(size, start + MAX_REMOTE_CONTROL_FRAGMENT_DATA)
      const partSize = end - start
      current = b4a.allocUnsafeSlow(REMOTE_CONTROL_FRAGMENT_HEADER_SIZE + partSize)
      put(current, messageId, 0)
      writeU16(current, index, 16)
      writeU16(current, total, 18)
      writeU16(current, size, 20)
      if (partSize > 0) {
        put(current, slice(message, start, end), REMOTE_CONTROL_FRAGMENT_HEADER_SIZE)
      }
      result.push(current)
      current = null
    }
    return result
  } catch (err) {
    clear(current)
    for (const frame of result) clear(frame)
    if (err instanceof PrivateRouteError) throw err
    invalid()
  }
}

export class RemoteControlFragmentCodec {
  #now
  #schedule
  #cancel
  #active = null
  #completed = new Set()
  #destroyed = false
  #busy = false
  #lastNow = null
  #timer = null

  constructor(options = {}) {
    object(options)
    const now = option(options, 'now')
    const schedule = option(options, 'schedule')
    const cancel = option(options, 'cancel')
    if (
      typeof now !== 'function' ||
      (schedule === undefined) !== (cancel === undefined) ||
      (schedule !== undefined && (typeof schedule !== 'function' || typeof cancel !== 'function'))
    ) {
      invalid()
    }
    this.#now = now
    this.#schedule = schedule || null
    this.#cancel = cancel || null
  }

  get bufferedBytes() {
    return this.#active ? this.#active.bytes : 0
  }

  get stats() {
    return Object.freeze({
      destroyed: this.#destroyed,
      bufferedBytes: this.bufferedBytes,
      active: this.#active ? 1 : 0,
      completedIds: this.#completed.size,
      timers: this.#timer === null ? 0 : 1
    })
  }

  fragment(message, options) {
    if (this.#destroyed) circuitState()
    return fragmentMessage(message, options)
  }

  pushAuthenticated(frame) {
    if (this.#destroyed) circuitState()
    if (this.#busy) this.#rejectReentrancy()
    this.#busy = true
    try {
      return this.#push(frame)
    } finally {
      this.#busy = false
    }
  }

  #push(frame) {
    let shape
    try {
      shape = validateFragment(frame)
    } catch {
      if (!this.#clearActive(true)) this.#failClosed()
      invalid()
    }
    const messageId = copy(slice(frame, 0, 16))
    const key = hex(messageId)
    if (this.#completed.has(key)) {
      clear(messageId)
      if (!this.#clearActive(true)) this.#failClosed()
      replay()
    }
    let now
    try {
      now = this.#readNow()
    } catch (err) {
      clear(messageId)
      throw err
    }
    if (this.#destroyed) {
      clear(messageId)
      circuitState()
    }
    if (!this.#active) {
      if (shape.index !== 0 || now > Number.MAX_SAFE_INTEGER - REMOTE_CONTROL_FRAGMENT_TIMEOUT) {
        clear(messageId)
        if (!this.#clearActive(true)) this.#failClosed()
        invalid()
      }
      this.#active = {
        key,
        id: messageId,
        total: shape.total,
        objectLength: shape.objectLength,
        next: 0,
        parts: [],
        bytes: 0,
        deadline: now + REMOTE_CONTROL_FRAGMENT_TIMEOUT
      }
      this.#startTimer()
      if (this.#destroyed || !this.#active) circuitState()
    } else {
      clear(messageId)
      if (
        now >= this.#active.deadline ||
        this.#active.key !== key ||
        this.#active.total !== shape.total ||
        this.#active.objectLength !== shape.objectLength ||
        shape.index !== this.#active.next
      ) {
        if (!this.#clearActive(true)) this.#failClosed()
        invalid()
      }
    }
    let part = null
    try {
      part = copy(slice(frame, REMOTE_CONTROL_FRAGMENT_HEADER_SIZE))
      this.#active.parts.push(part)
      this.#active.bytes += length(part)
      this.#active.next++
    } catch (err) {
      clear(part)
      if (!this.#clearActive(true)) this.#failClosed()
      if (err instanceof PrivateRouteError) throw err
      invalid()
    }
    if (this.#active.next !== this.#active.total) return null
    if (this.#completed.size >= MAX_COMPLETED_REMOTE_CONTROL_IDS) {
      if (!this.#clearActive(true)) this.#failClosed()
      limit()
    }
    let result = null
    const completedKey = this.#active.key
    try {
      result = b4a.concat(this.#active.parts, this.#active.objectLength)
      if (length(result) !== this.#active.objectLength) invalid()
      this.#completed.add(completedKey)
      if (!this.#clearActive(true)) {
        clear(result)
        this.#failClosed()
      }
      if (this.#destroyed) {
        clear(result)
        circuitState()
      }
      return result
    } catch (err) {
      clear(result)
      this.#clearActive(true)
      if (err instanceof PrivateRouteError) throw err
      invalid()
    }
  }

  expire() {
    if (this.#busy) this.#rejectReentrancy()
    if (this.#destroyed || !this.#active) return false
    this.#busy = true
    try {
      const now = this.#readNow()
      if (this.#destroyed || !this.#active) circuitState()
      if (now < this.#active.deadline) return false
      if (!this.#clearActive(true)) this.#failClosed()
      if (this.#destroyed) circuitState()
      if (this.#active) this.#failClosed()
      return true
    } finally {
      this.#busy = false
    }
  }

  destroy() {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#clearActive(true)
    this.#completed.clear()
  }

  #readNow() {
    let now
    try {
      now = this.#now()
    } catch {
      this.#failClosed()
    }
    if (!Number.isSafeInteger(now) || now < 0 || (this.#lastNow !== null && now < this.#lastNow)) {
      this.#failClosed()
    }
    this.#lastNow = now
    return now
  }

  #startTimer() {
    if (this.#schedule === null || this.#timer !== null || !this.#active) return
    const timer = { handle: null }
    this.#timer = timer
    let synchronous = true
    let calledSynchronously = false
    let handle
    try {
      const delay = this.#active.deadline - this.#lastNow
      handle = this.#schedule(delay, () => {
        if (synchronous) {
          calledSynchronously = true
          return
        }
        if (this.#timer !== timer) return
        if (this.#destroyed || !this.#active) return
        if (this.#busy) {
          this.#destroyed = true
          this.#clearActive(true)
          this.#completed.clear()
          return
        }
        this.#busy = true
        this.#timer = null
        try {
          const now = this.#readNow()
          if (this.#destroyed || !this.#active) circuitState()
          if (now >= this.#active.deadline) this.#clearActive(false)
          else this.#startTimer()
        } catch {
          this.#destroyed = true
          this.#clearActive(true)
          this.#completed.clear()
        } finally {
          this.#busy = false
        }
      })
    } catch {
      this.#timer = null
      this.#failClosed()
    } finally {
      synchronous = false
    }
    if (handle === undefined || handle === null) {
      this.#timer = null
      this.#failClosed()
    }
    timer.handle = handle
    if (calledSynchronously) {
      if (this.#timer === timer) this.#failClosed()
      this.#cancelDetached(handle)
      if (this.#destroyed) circuitState()
      this.#failClosed()
    }
    if (this.#destroyed || this.#timer !== timer || !this.#active) {
      if (!this.#cancelDetached(handle)) this.#failClosed()
      this.#destroyed = true
      this.#clearActive(true)
      this.#completed.clear()
      circuitState()
    }
  }

  #clearActive(cancelTimer) {
    let cancelled = true
    if (this.#timer !== null) {
      const handle = this.#timer.handle
      this.#timer = null
      if (cancelTimer && this.#cancel !== null && handle !== null) {
        try {
          this.#cancel(handle)
        } catch {
          cancelled = false
        }
      }
    }
    if (this.#active) {
      clear(this.#active.id)
      for (const part of this.#active.parts) clear(part)
      this.#active.parts.length = 0
      this.#active.bytes = 0
      this.#active = null
    }
    return cancelled
  }

  #cancelDetached(handle) {
    if (this.#cancel === null) return true
    try {
      this.#cancel(handle)
      return true
    } catch {
      return false
    }
  }

  #failClosed() {
    this.#destroyed = true
    this.#clearActive(true)
    this.#completed.clear()
    invalid()
  }

  #rejectReentrancy() {
    this.#destroyed = true
    this.#clearActive(true)
    this.#completed.clear()
    circuitState()
  }
}

function actorShape(value, copyBody = false) {
  object(value)
  const version = option(value, 'version')
  const kind = option(value, 'kind')
  const flags = option(value, 'flags')
  const requestId = option(value, 'requestId')
  const actorId = option(value, 'actorId')
  const circuitId = option(value, 'circuitId')
  const generation = option(value, 'generation')
  const body = option(value, 'body')
  const bodyLength = length(body)
  if (
    version !== PROTOCOL_VERSION ||
    !ACTOR_KINDS.has(kind) ||
    flags !== 0 ||
    !u64(requestId, true) ||
    !fixed(actorId, 16) ||
    allZero(actorId) ||
    !fixed(circuitId, 16) ||
    !u64(generation) ||
    bodyLength < 0 ||
    bodyLength > ACTOR_CONTROL_BODY_MAX
  ) {
    invalid()
  }
  if (REGISTRATION_KINDS.has(kind)) {
    if (!allZero(circuitId) || generation !== 0n) invalid()
  } else if (kind !== ACTOR_CONTROL_KIND.ERROR) {
    if (allZero(circuitId) || generation === 0n) invalid()
  } else if (allZero(circuitId) !== (generation === 0n)) {
    invalid()
  }
  if (
    kind === ACTOR_CONTROL_KIND.CIRCUIT_DESTROY &&
    (bodyLength !== 1 || !DESTROY_REASONS.has(body[0]))
  ) {
    invalid()
  }
  if (kind === ACTOR_CONTROL_KIND.CIRCUIT_DESTROYED && bodyLength !== 0) invalid()
  if (kind === ACTOR_CONTROL_KIND.ERROR && (bodyLength !== 33 || !ACTOR_ERROR_CODES.has(body[0]))) {
    invalid()
  }
  const normalized = {
    version,
    kind,
    flags,
    requestId,
    actorId,
    circuitId,
    generation,
    body
  }
  if (!copyBody) return normalized
  let ownedActorId = null
  let ownedCircuitId = null
  let ownedBody = null
  try {
    ownedActorId = copy(actorId)
    ownedCircuitId = copy(circuitId)
    ownedBody = copy(body)
    return {
      ...normalized,
      actorId: ownedActorId,
      circuitId: ownedCircuitId,
      body: ownedBody
    }
  } catch (err) {
    clear(ownedActorId)
    clear(ownedCircuitId)
    clear(ownedBody)
    if (err instanceof PrivateRouteError) throw err
    invalid()
  }
}

export class ActorControlCodec {
  encode(value) {
    const actor = actorShape(value)
    let output = null
    try {
      output = b4a.allocUnsafeSlow(ACTOR_CONTROL_HEADER_SIZE + length(actor.body))
      output[0] = actor.version
      output[1] = actor.kind
      output[2] = actor.flags
      output[3] = 0
      writeU64(output, actor.requestId, 4)
      put(output, actor.actorId, 12)
      put(output, actor.circuitId, 28)
      writeU64(output, actor.generation, 44)
      writeU16(output, length(actor.body), 52)
      if (length(actor.body) > 0) put(output, actor.body, ACTOR_CONTROL_HEADER_SIZE)
      return output
    } catch (err) {
      clear(output)
      if (err instanceof PrivateRouteError) throw err
      invalid()
    }
  }

  decode(message) {
    const size = length(message)
    if (size < ACTOR_CONTROL_HEADER_SIZE || size > MAX_REMOTE_CONTROL_OBJECT) invalid()
    if (message[3] !== 0) invalid()
    const bodyLength = readU16(message, 52)
    if (size !== ACTOR_CONTROL_HEADER_SIZE + bodyLength) invalid()
    return actorShape(
      {
        version: message[0],
        kind: message[1],
        flags: message[2],
        requestId: readU64(message, 4),
        actorId: slice(message, 12, 28),
        circuitId: slice(message, 28, 44),
        generation: readU64(message, 44),
        body: slice(message, ACTOR_CONTROL_HEADER_SIZE)
      },
      true
    )
  }
}

export function validateActorReply(request, reply, requestDigest32) {
  const expected = actorShape(request)
  const actual = actorShape(reply, true)
  if (!REPLY_KIND.has(expected.kind) || !fixed(requestDigest32, 32)) {
    clear(actual.actorId)
    clear(actual.circuitId)
    clear(actual.body)
    invalid()
  }
  if (
    actual.requestId !== expected.requestId ||
    !same(actual.actorId, expected.actorId) ||
    !same(actual.circuitId, expected.circuitId) ||
    actual.generation !== expected.generation ||
    (actual.kind !== REPLY_KIND.get(expected.kind) && actual.kind !== ACTOR_CONTROL_KIND.ERROR)
  ) {
    clear(actual.actorId)
    clear(actual.circuitId)
    clear(actual.body)
    invalid()
  }
  if (actual.kind === ACTOR_CONTROL_KIND.ERROR && !same(slice(actual.body, 1), requestDigest32)) {
    clear(actual.actorId)
    clear(actual.circuitId)
    clear(actual.body)
    invalid()
  }
  return actual
}

function linkShape(value, outer, copyValues = false) {
  object(value)
  const header = outerHeader(outer)
  const version = option(value, 'version')
  const kind = option(value, 'kind')
  const flags = option(value, 'flags')
  const direction = option(value, 'direction')
  const circuitId = option(value, 'circuitId')
  const generation = option(value, 'generation')
  if (
    version !== PROTOCOL_VERSION ||
    !LINK_KINDS.has(kind) ||
    flags !== 0 ||
    direction !== header.direction ||
    !fixed(circuitId, 16) ||
    !same(circuitId, header.circuitId) ||
    !u64(generation)
  ) {
    invalid()
  }
  if (kind === LINK_CONTROL_KIND.STREAM_ACK) {
    const acknowledgedDirection = option(value, 'acknowledgedDirection')
    const counter = option(value, 'counter')
    if (
      generation === 0n ||
      !knownDirection(acknowledgedDirection) ||
      direction !== opposite(acknowledgedDirection) ||
      !u64(counter)
    ) {
      invalid()
    }
    const normalized = {
      version,
      kind,
      flags,
      direction,
      circuitId,
      generation,
      acknowledgedDirection,
      counter
    }
    if (!copyValues) return normalized
    return { ...normalized, circuitId: copy(circuitId) }
  }
  const challenge = option(value, 'challenge')
  if (generation !== 0n || !fixed(challenge, 16) || allZero(challenge)) invalid()
  const normalized = {
    version,
    kind,
    flags,
    direction,
    circuitId,
    generation,
    challenge
  }
  if (!copyValues) return normalized
  let ownedCircuitId = null
  let ownedChallenge = null
  try {
    ownedCircuitId = copy(circuitId)
    ownedChallenge = copy(challenge)
    return { ...normalized, circuitId: ownedCircuitId, challenge: ownedChallenge }
  } catch (err) {
    clear(ownedCircuitId)
    clear(ownedChallenge)
    if (err instanceof PrivateRouteError) throw err
    invalid()
  }
}

export class LinkControlCodec {
  encode(value, outer) {
    const link = linkShape(value, outer)
    let output = null
    try {
      output = b4a.allocUnsafeSlow(LINK_CONTROL_BODY_SIZE)
      output[0] = link.version
      output[1] = link.kind
      output[2] = link.flags
      output[3] = link.direction
      put(output, link.circuitId, 4)
      writeU64(output, link.generation, 20)
      if (link.kind === LINK_CONTROL_KIND.STREAM_ACK) {
        writeU64(output, link.counter, 28)
        bufferFill.call(output, 0, 36, 44)
      } else {
        put(output, link.challenge, 28)
      }
      return output
    } catch (err) {
      clear(output)
      if (err instanceof PrivateRouteError) throw err
      invalid()
    }
  }

  decode(message, outer) {
    if (!fixed(message, LINK_CONTROL_BODY_SIZE)) invalid()
    const kind = message[1]
    let value
    if (kind === LINK_CONTROL_KIND.STREAM_ACK) {
      for (let index = 36; index < 44; index++) if (message[index] !== 0) invalid()
      value = {
        version: message[0],
        kind,
        flags: message[2],
        direction: message[3],
        circuitId: slice(message, 4, 20),
        generation: readU64(message, 20),
        acknowledgedDirection: opposite(message[3]),
        counter: readU64(message, 28)
      }
    } else {
      value = {
        version: message[0],
        kind,
        flags: message[2],
        direction: message[3],
        circuitId: slice(message, 4, 20),
        generation: readU64(message, 20),
        challenge: slice(message, 28, 44)
      }
    }
    return linkShape(value, outer, true)
  }
}

export class RemoteControlMux {
  #link = new LinkControlCodec()

  encodeLink(value, outer) {
    const body = this.#link.encode(value, outer)
    let output = null
    try {
      output = b4a.allocUnsafeSlow(1 + LINK_CONTROL_BODY_SIZE)
      output[0] = CONTROL_NAMESPACE.LINK
      put(output, body, 1)
      return output
    } catch (err) {
      clear(output)
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      clear(body)
    }
  }

  encodeActorFragment(frame) {
    validateFragment(frame)
    let output = null
    try {
      output = b4a.allocUnsafeSlow(1 + length(frame))
      output[0] = CONTROL_NAMESPACE.ACTOR
      put(output, frame, 1)
      return output
    } catch (err) {
      clear(output)
      if (err instanceof PrivateRouteError) throw err
      invalid()
    }
  }

  decode(payload, outer) {
    const size = length(payload)
    outerHeader(outer)
    if (size < 1) invalid()
    if (payload[0] === CONTROL_NAMESPACE.LINK) {
      if (size !== 1 + LINK_CONTROL_BODY_SIZE) invalid()
      return Object.freeze({
        namespace: CONTROL_NAMESPACE.LINK,
        message: this.#link.decode(slice(payload, 1), outer)
      })
    }
    if (payload[0] === CONTROL_NAMESPACE.ACTOR) {
      const fragment = slice(payload, 1)
      validateFragment(fragment)
      return Object.freeze({
        namespace: CONTROL_NAMESPACE.ACTOR,
        fragment: copy(fragment)
      })
    }
    invalid()
  }
}
