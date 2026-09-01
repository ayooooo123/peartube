import b4a from 'b4a'

import { CELL_SIZE, MAX_CELL_PAYLOAD, CellCodec } from './cell-codec.js'
import { PrivateRouteError } from './errors.js'
import { isLinkTicketChecker } from './link-setup.js'
import {
  abortM3Install,
  beginM3Install,
  commitM3Install,
  createM3ForwardingOwner,
  releaseM3InstalledPair,
  validateM3Install
} from './m3-adjacency-runtime.js'
import { CELL_CLASS, CIRCUIT_STATE, DIRECTION } from './protocol.js'

export const DEFAULT_MAX_CIRCUITS = 128
export const DEFAULT_MAX_CIRCUITS_PER_SOURCE = 32
export const DEFAULT_MAX_CIRCUIT_QUEUED_BYTES = 256 * 1024
export const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024
export const DEFAULT_HALF_OPEN_TIMEOUT = 5_000

// Deep test import only. RelayService compares against a separate private copy.
export const RELAY_DESTROY_PAYLOAD = b4a.from([0xff, 0x44, 0x45, 0x53, 0x54, 0x52, 0x4f, 0x59])
export const TEST_ONLY_RELAY_OBSERVER = Symbol('test-only-relay-observer')

const DESTROY_PAYLOAD = b4a.from(RELAY_DESTROY_PAYLOAD)
const STATE_NAME = Object.freeze(['CREATE', 'CREATED', 'OPEN', 'DRAINING', 'DESTROYED'])
const MAX_TIME = Number.MAX_SAFE_INTEGER
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const bufferArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get
const bufferByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get
const bufferByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get
const bufferSubarray = Uint8Array.prototype.subarray
const bufferFill = Uint8Array.prototype.fill
const bufferSet = Uint8Array.prototype.set

function invalidRoute() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function invalidCell() {
  throw PrivateRouteError.CELL_INVALID()
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

function copyBuffer(value, fail = invalidCell) {
  const length = bufferLength(value)
  if (length < 0) fail()
  try {
    const copy = b4a.allocUnsafeSlow(length)
    bufferSet.call(copy, value)
    return copy
  } catch {
    fail()
  }
}

function same(left, right) {
  const length = bufferLength(left)
  if (length < 0 || length !== bufferLength(right)) return false
  for (let index = 0; index < length; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) bufferFill.call(value, 0)
  } catch {
    // Best-effort zeroization only.
  }
}

function overlaps(left, right) {
  if (!b4a.isBuffer(left) || !b4a.isBuffer(right)) return false
  try {
    if (bufferArrayBuffer.call(left) !== bufferArrayBuffer.call(right)) return false
    const leftStart = bufferByteOffset.call(left)
    const leftEnd = leftStart + bufferLength(left)
    const rightStart = bufferByteOffset.call(right)
    const rightEnd = rightStart + bufferLength(right)
    return leftStart < rightEnd && rightStart < leftEnd
  } catch {
    return false
  }
}

function clearAdapterOutput(value, inputs) {
  if (!inputs.some((input) => overlaps(value, input))) clear(value)
}

function aliasesInput(value, inputs) {
  return inputs.some((input) => overlaps(value, input))
}

function canonicalHex(value, size) {
  if (!fixed(value, size)) invalidCell()
  const copy = copyBuffer(value)
  try {
    return b4a.toString(copy, 'hex')
  } catch {
    invalidCell()
  } finally {
    clear(copy)
  }
}

function identityHex(value) {
  return canonicalHex(value, 32)
}

function localIdHex(value) {
  return canonicalHex(value, 16)
}

function mapKey(peer, localId) {
  return `${identityHex(peer)}:${localIdHex(localId)}`
}

function limit(value, fallback, allowZero = false) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) invalidRoute()
  return value
}

function readPublicLocalId(packet) {
  if (!fixed(packet, CELL_SIZE)) invalidCell()
  try {
    return bufferSubarray.call(packet, 12, 28)
  } catch {
    invalidCell()
  }
}

function readPublicClass(packet) {
  try {
    return packet[1]
  } catch {
    invalidCell()
  }
}

function knownClass(value) {
  return (
    value === CELL_CLASS.CONTROL || value === CELL_CLASS.STREAM || value === CELL_CLASS.DATAGRAM
  )
}

function contextList(state) {
  const result = []
  for (const cellClass of [CELL_CLASS.CONTROL, CELL_CLASS.STREAM, CELL_CLASS.DATAGRAM]) {
    const pair = state.contexts && state.contexts[cellClass]
    if (!safeObject(pair)) invalidRoute()
    for (const direction of ['tx', 'rx']) {
      const context = pair[direction]
      if (
        !safeObject(context) ||
        !fixed(context.key, 32) ||
        !fixed(context.noncePrefix, 16) ||
        !safeObject(context.counter)
      ) {
        invalidRoute()
      }
      result.push(context)
    }
  }
  return result
}

function validateTicket(state, identity) {
  if (
    !safeObject(state) ||
    !fixed(state.circuitId, 16) ||
    typeof state.epoch !== 'bigint' ||
    state.epoch < 0n ||
    !fixed(state.localIdentity, 32) ||
    !same(state.localIdentity, identity) ||
    !fixed(state.peerIdentity, 32) ||
    same(state.peerIdentity, identity) ||
    !fixed(state.localId, 16) ||
    !fixed(state.peerLocalId, 16) ||
    typeof state.expiresAt !== 'bigint' ||
    state.expiresAt < 0n
  ) {
    invalidRoute()
  }
  contextList(state)
}

function privateCode(err, allowed) {
  try {
    if (!(err instanceof PrivateRouteError)) return null
    return allowed.has(err.code) ? err.code : null
  } catch {
    return null
  }
}

const RECEIVE_CODES = new Set([
  'CELL_INVALID',
  'CIRCUIT_LIMIT',
  'COUNTER_INVALID',
  'COUNTER_GAP',
  'COUNTER_EXHAUSTED',
  'REPLAY'
])

export class RelayService {
  #identity
  #takeTicket
  #codec
  #hash
  #now
  #lastNow
  #send
  #onControl
  #observe
  #maxCircuits
  #maxCircuitsPerSource
  #maxCircuitQueuedBytes
  #maxQueuedBytes
  #halfOpenTimeout
  #previousBindings
  #nextBindings
  #records
  #sourceCircuits
  #queuedBytes
  #destroying
  #installingM3
  #m3InstallViolated

  constructor(options) {
    if (!safeObject(options)) invalidRoute()
    const identity = option(options, 'identity')
    const checker = option(options, 'ticketChecker')
    const crypto = option(options, 'crypto')
    const now = option(options, 'now')
    const send = option(options, 'send')
    const padding = option(options, 'padding')
    const onControl = option(options, 'onControl')
    const observe = option(options, TEST_ONLY_RELAY_OBSERVER)
    let hash
    try {
      hash = crypto && crypto.hash
    } catch {
      invalidRoute()
    }

    if (
      !fixed(identity, 32) ||
      !isLinkTicketChecker(checker) ||
      typeof hash !== 'function' ||
      typeof now !== 'function' ||
      typeof send !== 'function' ||
      (onControl !== undefined && typeof onControl !== 'function') ||
      (observe !== undefined && typeof observe !== 'function')
    ) {
      invalidRoute()
    }

    let take
    try {
      take = checker.take
    } catch {
      invalidRoute()
    }
    if (typeof take !== 'function') invalidRoute()

    this.#identity = copyBuffer(identity, invalidRoute)
    this.#takeTicket = take.bind(checker)
    this.#codec = new CellCodec({ crypto, cellSize: CELL_SIZE, padding })
    this.#hash = hash.bind(crypto)
    this.#now = now
    this.#lastNow = null
    this.#send = send
    this.#onControl = onControl || null
    this.#observe = observe || null
    this.#maxCircuits = limit(option(options, 'maxCircuits'), DEFAULT_MAX_CIRCUITS, true)
    const configuredPerSource = option(options, 'maxCircuitsPerSource')
    this.#maxCircuitsPerSource =
      configuredPerSource === undefined
        ? Math.min(DEFAULT_MAX_CIRCUITS_PER_SOURCE, this.#maxCircuits)
        : limit(configuredPerSource, DEFAULT_MAX_CIRCUITS_PER_SOURCE, true)
    if (this.#maxCircuitsPerSource > this.#maxCircuits) invalidRoute()
    this.#maxCircuitQueuedBytes = limit(
      option(options, 'maxCircuitQueuedBytes'),
      DEFAULT_MAX_CIRCUIT_QUEUED_BYTES,
      true
    )
    this.#maxQueuedBytes = limit(option(options, 'maxQueuedBytes'), DEFAULT_MAX_QUEUED_BYTES, true)
    this.#halfOpenTimeout = limit(
      option(options, 'halfOpenTimeout'),
      DEFAULT_HALF_OPEN_TIMEOUT,
      true
    )
    this.#previousBindings = new Map()
    this.#nextBindings = new Map()
    this.#records = new Set()
    this.#sourceCircuits = new Map()
    this.#queuedBytes = 0
    this.#destroying = false
    this.#installingM3 = false
    this.#m3InstallViolated = false
  }

  get activeCircuits() {
    return this.#records.size
  }

  get queuedBytes() {
    return this.#queuedBytes
  }

  install(previousTicket, nextTicket) {
    let previous = null
    let next = null
    try {
      previous = this.#takeTicket(previousTicket)
      next = this.#takeTicket(nextTicket)
      validateTicket(previous, this.#identity)
      validateTicket(next, this.#identity)

      if (
        !same(previous.circuitId, next.circuitId) ||
        previous.epoch !== next.epoch ||
        previous.expiresAt !== next.expiresAt ||
        same(previous.peerIdentity, next.peerIdentity) ||
        same(previous.localId, next.localId)
      ) {
        invalidRoute()
      }

      const current = this.#readTime()
      if (previous.expiresAt <= BigInt(current)) invalidRoute()
      if (current > MAX_TIME - this.#halfOpenTimeout) invalidRoute()
      if (this.#records.size >= this.#maxCircuits) throw PrivateRouteError.CIRCUIT_LIMIT()

      const sourceKey = identityHex(previous.peerIdentity)
      if ((this.#sourceCircuits.get(sourceKey) || 0) >= this.#maxCircuitsPerSource) {
        throw PrivateRouteError.CIRCUIT_LIMIT()
      }

      const previousKey = mapKey(previous.peerIdentity, previous.localId)
      const nextKey = mapKey(next.peerIdentity, next.localId)
      if (
        this.#previousBindings.has(previousKey) ||
        this.#nextBindings.has(previousKey) ||
        this.#previousBindings.has(nextKey) ||
        this.#nextBindings.has(nextKey)
      ) {
        invalidRoute()
      }

      const record = {
        previous,
        next,
        previousKey,
        nextKey,
        sourceKey,
        state: CIRCUIT_STATE.CREATE,
        installedAt: current,
        halfOpenDeadline: current + this.#halfOpenTimeout,
        queue: [],
        queuedBytes: 0,
        busy: false,
        transitioning: false,
        flushing: false,
        destroyed: false
      }
      this.#previousBindings.set(previousKey, record)
      this.#nextBindings.set(nextKey, record)
      this.#records.add(record)
      this.#sourceCircuits.set(sourceKey, (this.#sourceCircuits.get(sourceKey) || 0) + 1)
      return undefined
    } catch (err) {
      if (previous) this.#clearTicket(previous)
      if (next) this.#clearTicket(next)
      throw err
    }
  }

  installM3(previousRuntime, nextRuntime) {
    if (this.#installingM3) {
      this.#m3InstallViolated = true
      invalidRoute()
    }
    this.#installingM3 = true
    this.#m3InstallViolated = false
    let plan = null
    let record = null
    let committed = false
    try {
      plan = beginM3Install(previousRuntime, nextRuntime)
      const current = this.#readTime()
      if (this.#m3InstallViolated) invalidRoute()
      if (current > MAX_TIME - this.#halfOpenTimeout) invalidRoute()
      validateM3Install(plan, this.#identity, this.#maxCircuits, current)
      const previous = plan.previous
      const next = plan.next
      const expiresAt = previous.expiresAt < next.expiresAt ? previous.expiresAt : next.expiresAt
      if (expiresAt <= BigInt(current)) invalidRoute()
      if (this.#records.size >= this.#maxCircuits) throw PrivateRouteError.CIRCUIT_LIMIT()

      const sourceKey = identityHex(previous.peerIdentity)
      if ((this.#sourceCircuits.get(sourceKey) || 0) >= this.#maxCircuitsPerSource) {
        throw PrivateRouteError.CIRCUIT_LIMIT()
      }
      const previousKey = mapKey(previous.peerIdentity, previous.localId)
      const nextKey = mapKey(next.peerIdentity, next.localId)
      if (
        this.#previousBindings.has(previousKey) ||
        this.#nextBindings.has(previousKey) ||
        this.#previousBindings.has(nextKey) ||
        this.#nextBindings.has(nextKey)
      ) {
        invalidRoute()
      }

      record = {
        previous: null,
        next: null,
        previousKey,
        nextKey,
        sourceKey,
        state: CIRCUIT_STATE.CREATE,
        installedAt: current,
        halfOpenDeadline: current + this.#halfOpenTimeout,
        queue: [],
        queuedBytes: 0,
        busy: false,
        transitioning: false,
        flushing: false,
        destroyed: false,
        m3: true
      }
      this.#previousBindings.set(previousKey, record)
      this.#nextBindings.set(nextKey, record)
      this.#records.add(record)
      this.#sourceCircuits.set(sourceKey, (this.#sourceCircuits.get(sourceKey) || 0) + 1)

      const forwardingOwner = createM3ForwardingOwner(() => this.#destroyRecord(record, false))
      const moved = commitM3Install(plan, expiresAt, forwardingOwner)
      committed = true
      record.previous = moved.previous
      record.next = moved.next
      const service = this
      return Object.freeze({
        diagnostics() {
          if (record.destroyed) throw PrivateRouteError.ERR_DESTROYED()
          return Object.freeze({ state: STATE_NAME[record.state], expiresAt })
        },
        destroy() {
          if (record.destroyed) return false
          service.#destroyRecord(record, false)
          return true
        }
      })
    } catch (err) {
      if (record && !committed) this.#removePendingM3Record(record)
      if (plan && !committed) abortM3Install(plan)
      if (record && committed) this.#destroyRecord(record, false)
      throw err
    } finally {
      this.#installingM3 = false
      this.#m3InstallViolated = false
    }
  }

  state(peer, localId) {
    const binding = this.#findBinding(peer, localId)
    if (!binding) throw PrivateRouteError.CIRCUIT_STATE()
    return binding.record.state
  }

  created(peer, localId) {
    const binding = this.#findBinding(peer, localId)
    if (!binding) throw PrivateRouteError.CIRCUIT_STATE()
    this.#transition(binding.record, CIRCUIT_STATE.CREATE, CIRCUIT_STATE.CREATED)
  }

  open(peer, localId) {
    const binding = this.#findBinding(peer, localId)
    if (!binding) throw PrivateRouteError.CIRCUIT_STATE()
    this.#transition(binding.record, CIRCUIT_STATE.CREATED, CIRCUIT_STATE.OPEN)
  }

  receive(peer, packet) {
    const peerHex = identityHex(peer)
    const localId = readPublicLocalId(packet)
    const bindingKey = `${peerHex}:${localIdHex(localId)}`
    let fromPrevious = true
    let record = this.#previousBindings.get(bindingKey)
    if (!record) {
      fromPrevious = false
      record = this.#nextBindings.get(bindingKey)
    }
    if (!record || record.destroyed) invalidCell()

    if (record.busy) {
      this.#destroyRecord(record, true)
      invalidCell()
    }

    record.busy = true
    try {
      this.#checkRecordTime(record, this.#readTime())
      const inbound = fromPrevious ? record.previous : record.next
      const cellClass = readPublicClass(packet)
      if (!knownClass(cellClass)) invalidCell()
      const context = inbound.contexts[cellClass].rx
      const direction = fromPrevious ? DIRECTION.FORWARD : DIRECTION.REVERSE
      const deliveries = this.#codec.open(
        {
          key: context.key,
          noncePrefix: context.noncePrefix,
          receiver: context.counter,
          expectedClass: cellClass,
          expectedDirection: direction,
          expectedEpoch: inbound.epoch,
          expectedCircuitId: inbound.localId
        },
        packet
      )

      if (cellClass === CELL_CLASS.DATAGRAM) {
        try {
          this.#handlePayload(record, fromPrevious, cellClass, deliveries)
        } finally {
          clear(deliveries)
        }
      } else {
        for (const payload of deliveries) {
          try {
            this.#handlePayload(record, fromPrevious, cellClass, payload)
          } finally {
            clear(payload)
          }
        }
      }
      return undefined
    } catch (err) {
      this.#destroyRecord(record, true)
      const code = privateCode(err, RECEIVE_CODES)
      if (code !== null) throw new PrivateRouteError(code)
      invalidCell()
    } finally {
      record.busy = false
    }
  }

  expire(at) {
    const current = this.#readTime(at)
    let failure = null
    for (const record of Array.from(this.#records)) {
      try {
        for (const ticket of [record.previous, record.next]) {
          ticket.contexts[CELL_CLASS.CONTROL].rx.counter.expire(current)
          ticket.contexts[CELL_CLASS.STREAM].rx.counter.expire(current)
        }
      } catch (err) {
        this.#destroyRecord(record, true)
        if (failure === null) {
          const code = privateCode(
            err,
            new Set(['COUNTER_INVALID', 'COUNTER_GAP', 'COUNTER_EXHAUSTED'])
          )
          failure = new PrivateRouteError(code || 'CELL_INVALID')
        }
        continue
      }
      if (current >= record.halfOpenDeadline && record.state !== CIRCUIT_STATE.OPEN) {
        this.#destroyRecord(record, true)
      } else if (BigInt(current) >= record.previous.expiresAt) {
        this.#destroyRecord(record, true)
      }
    }
    if (failure) throw failure
  }

  transportClosed(peer) {
    const peerHex = identityHex(peer)
    for (const record of Array.from(this.#records)) {
      if (
        peerHex === identityHex(record.previous.peerIdentity) ||
        peerHex === identityHex(record.next.peerIdentity)
      ) {
        this.#destroyRecord(record, true)
      }
    }
  }

  destroy(peer, localId) {
    const binding = this.#findBinding(peer, localId)
    if (!binding) return false
    this.#destroyRecord(binding.record, true)
    return true
  }

  flush() {
    for (const record of Array.from(this.#records)) {
      if (record.destroyed || record.flushing) continue
      record.flushing = true
      try {
        while (!record.destroyed && record.queue.length > 0) {
          const item = record.queue[0]
          let attempt = null
          let accepted
          try {
            attempt = copyBuffer(item.packet)
            accepted = this.#send(item.peer, attempt)
          } catch {
            clear(attempt)
            this.#destroyRecord(record, true)
            invalidCell()
          }
          clear(attempt)
          if (record.destroyed) break
          if (record.queue[0] !== item) {
            this.#destroyRecord(record, true)
            invalidCell()
          }
          if (accepted === false) break
          record.queue.shift()
          record.queuedBytes -= CELL_SIZE
          this.#queuedBytes -= CELL_SIZE
          clear(item.packet)
        }
      } finally {
        record.flushing = false
      }
    }
  }

  #handlePayload(record, fromPrevious, cellClass, payload) {
    if (cellClass === CELL_CLASS.CONTROL) {
      if (same(payload, DESTROY_PAYLOAD)) {
        this.#destroyRecord(record, true)
        return
      }
      if (this.#onControl) {
        let borrowed = null
        let consumed
        let callbackSucceeded = false
        const capability = { live: true, used: false, batch: null }
        try {
          borrowed = copyBuffer(payload)
          consumed = this.#onControl({
            direction: fromPrevious ? DIRECTION.FORWARD : DIRECTION.REVERSE,
            byteLength: bufferLength(payload),
            payload: borrowed,
            forward: (payloads) => this.#stageControlBatch(record, false, payloads, capability),
            reply: (payloads) => this.#stageControlBatch(record, true, payloads, capability)
          })
          callbackSucceeded = true
        } catch {
          invalidCell()
        } finally {
          capability.live = false
          clear(borrowed)
          if (!callbackSucceeded) this.#clearControlBatch(capability)
        }
        if (capability.used) {
          try {
            this.#requireLive(record)
            this.#commitControlBatch(record, fromPrevious, capability)
          } finally {
            this.#clearControlBatch(capability)
          }
          return
        }
        this.#requireLive(record)
        if (consumed === true) return
      }
    } else if (record.state !== CIRCUIT_STATE.OPEN || bufferLength(payload) !== 1100) {
      invalidCell()
    }

    const outbound = fromPrevious ? record.next : record.previous
    const context = outbound.contexts[cellClass].tx
    const direction = fromPrevious ? DIRECTION.FORWARD : DIRECTION.REVERSE
    const beforeHash = this.#observe ? this.#payloadHash(payload) : null
    this.#requireLive(record)
    let sealed = null
    try {
      sealed = this.#codec.seal({
        key: context.key,
        noncePrefix: context.noncePrefix,
        senderCounter: context.counter,
        class: cellClass,
        direction,
        epoch: outbound.epoch,
        circuitId: outbound.peerLocalId,
        payload
      })
      this.#requireLive(record, sealed)
      if (this.#observe) {
        const afterHash = this.#payloadHash(payload)
        const frame = copyBuffer(payload)
        this.#requireLive(record, sealed)
        try {
          this.#safeObserve({
            type: 'forward',
            class: cellClass,
            direction,
            byteLength: bufferLength(payload),
            beforeHash,
            afterHash,
            frame
          })
        } finally {
          clear(frame)
        }
        this.#requireLive(record, sealed)
      }
      this.#transmit(record, outbound.peerIdentity, sealed)
      sealed = null
    } finally {
      clear(sealed)
    }
  }

  #stageControlBatch(record, reply, payloads, capability) {
    if (!capability.live || record.destroyed) {
      this.#destroyRecord(record, true)
      throw PrivateRouteError.CIRCUIT_STATE()
    }
    if (capability.used) {
      this.#destroyRecord(record, true)
      throw PrivateRouteError.CIRCUIT_STATE()
    }
    capability.used = true

    let values
    try {
      values = b4a.isBuffer(payloads) ? [payloads] : Array.isArray(payloads) ? payloads : null
    } catch {
      invalidCell()
    }
    if (values === null || values.length < 1 || values.length > 8) invalidCell()

    const owned = []
    try {
      const count = values.length
      for (let index = 0; index < count; index++) {
        let value
        try {
          value = values[index]
        } catch {
          invalidCell()
        }
        const size = bufferLength(value)
        if (size < 0 || size > MAX_CELL_PAYLOAD) invalidCell()
        owned.push(copyBuffer(value))
      }
      capability.batch = { reply, values: owned }
      return undefined
    } catch (err) {
      for (const value of owned) clear(value)
      throw err
    }
  }

  #commitControlBatch(record, fromPrevious, capability) {
    const batch = capability.batch
    if (!batch || !Array.isArray(batch.values)) invalidCell()
    const packets = []
    try {
      this.#requireLive(record)
      const outbound = batch.reply
        ? fromPrevious
          ? record.previous
          : record.next
        : fromPrevious
          ? record.next
          : record.previous
      const direction = batch.reply
        ? fromPrevious
          ? DIRECTION.REVERSE
          : DIRECTION.FORWARD
        : fromPrevious
          ? DIRECTION.FORWARD
          : DIRECTION.REVERSE
      const context = outbound.contexts[CELL_CLASS.CONTROL].tx
      for (const value of batch.values) {
        packets.push(
          this.#codec.seal({
            key: context.key,
            noncePrefix: context.noncePrefix,
            senderCounter: context.counter,
            class: CELL_CLASS.CONTROL,
            direction,
            epoch: outbound.epoch,
            circuitId: outbound.peerLocalId,
            payload: value
          })
        )
      }
      this.#requireLive(record)
      for (let index = 0; index < packets.length; index++) {
        const packet = packets[index]
        packets[index] = null
        this.#transmit(record, outbound.peerIdentity, packet)
      }
      return undefined
    } finally {
      for (const packet of packets) clear(packet)
    }
  }

  #clearControlBatch(capability) {
    const batch = capability.batch
    if (!batch || !Array.isArray(batch.values)) return
    for (const value of batch.values) clear(value)
    batch.values.length = 0
    capability.batch = null
  }

  #transmit(record, peer, packet) {
    this.#requireLive(record, packet)
    let queued = null
    let accepted
    try {
      queued = copyBuffer(packet)
      this.#requireLive(record, packet)
      accepted = this.#send(peer, packet)
    } catch {
      clear(queued)
      clear(packet)
      invalidCell()
    }
    if (record.destroyed || accepted !== false) {
      clear(queued)
      return
    }

    if (
      record.queuedBytes + CELL_SIZE > this.#maxCircuitQueuedBytes ||
      this.#queuedBytes + CELL_SIZE > this.#maxQueuedBytes
    ) {
      clear(queued)
      throw PrivateRouteError.CIRCUIT_LIMIT()
    }
    record.queue.push({ peer: copyBuffer(peer), packet: queued })
    record.queuedBytes += CELL_SIZE
    this.#queuedBytes += CELL_SIZE
  }

  #removePendingM3Record(record) {
    this.#previousBindings.delete(record.previousKey)
    this.#nextBindings.delete(record.nextKey)
    this.#records.delete(record)
    const sourceCount = this.#sourceCircuits.get(record.sourceKey) || 0
    if (sourceCount <= 1) this.#sourceCircuits.delete(record.sourceKey)
    else this.#sourceCircuits.set(record.sourceKey, sourceCount - 1)
    record.destroyed = true
    record.state = CIRCUIT_STATE.DESTROYED
  }

  #destroyRecord(record, notify) {
    if (!record || record.destroyed) return
    record.destroyed = true
    record.state = CIRCUIT_STATE.DESTROYED

    const notices = []
    if (notify) {
      this.#presealDestroy(notices, record.previous, DIRECTION.REVERSE)
      this.#presealDestroy(notices, record.next, DIRECTION.FORWARD)
    }

    this.#previousBindings.delete(record.previousKey)
    this.#nextBindings.delete(record.nextKey)
    this.#records.delete(record)
    const sourceCount = this.#sourceCircuits.get(record.sourceKey) || 0
    if (sourceCount <= 1) this.#sourceCircuits.delete(record.sourceKey)
    else this.#sourceCircuits.set(record.sourceKey, sourceCount - 1)
    for (const item of record.queue) clear(item.packet)
    this.#queuedBytes -= record.queuedBytes
    record.queue.length = 0
    record.queuedBytes = 0

    const contexts = this.#contexts(record)
    if (record.m3) {
      releaseM3InstalledPair(record.previous, record.next)
    } else {
      this.#clearTicket(record.previous)
      this.#clearTicket(record.next)
    }
    this.#safeObserve({ type: 'zeroized', contexts, queuedBytes: this.#queuedBytes })

    if (this.#destroying) {
      for (const notice of notices) clear(notice.packet)
      return
    }
    this.#destroying = true
    try {
      for (const notice of notices) {
        try {
          this.#send(notice.peer, notice.packet)
        } catch {
          // Cleanup is complete and must not be rolled back by transport failure.
        }
      }
    } finally {
      this.#destroying = false
    }
  }

  #presealDestroy(notices, ticket, direction) {
    try {
      const context = ticket.contexts[CELL_CLASS.CONTROL].tx
      const packet = this.#codec.seal({
        key: context.key,
        noncePrefix: context.noncePrefix,
        senderCounter: context.counter,
        class: CELL_CLASS.CONTROL,
        direction,
        epoch: ticket.epoch,
        circuitId: ticket.peerLocalId,
        payload: DESTROY_PAYLOAD
      })
      notices.push({ peer: copyBuffer(ticket.peerIdentity), packet })
    } catch {
      // A spent counter cannot prevent local cleanup.
    }
  }

  #clearTicket(ticket) {
    if (!safeObject(ticket)) return
    let contexts = []
    try {
      contexts = contextList(ticket)
    } catch {
      contexts = []
    }
    for (const context of contexts) {
      clear(context.key)
      clear(context.noncePrefix)
      try {
        if (typeof context.counter.destroy === 'function') context.counter.destroy()
      } catch {
        // Best effort; ticket capability supplied the counter implementation.
      }
    }
    clear(ticket.circuitId)
    clear(ticket.localId)
    clear(ticket.peerLocalId)
  }

  #contexts(record) {
    return [...contextList(record.previous), ...contextList(record.next)]
  }

  #findBinding(peer, localId) {
    const key = mapKey(peer, localId)
    const previous = this.#previousBindings.get(key)
    if (previous) return { record: previous, fromPrevious: true }
    const next = this.#nextBindings.get(key)
    return next ? { record: next, fromPrevious: false } : null
  }

  #transition(record, expected, next) {
    if (record.destroyed || record.state !== expected || record.transitioning) {
      this.#destroyRecord(record, true)
      throw PrivateRouteError.CIRCUIT_STATE()
    }
    record.transitioning = true
    try {
      this.#checkRecordTime(record, this.#readTime())
    } catch (err) {
      this.#destroyRecord(record, true)
      if (privateCode(err, new Set(['INVALID_ROUTE'])) !== null) throw err
      throw PrivateRouteError.CIRCUIT_STATE()
    } finally {
      record.transitioning = false
    }
    if (record.destroyed || record.state !== expected) {
      this.#destroyRecord(record, true)
      throw PrivateRouteError.CIRCUIT_STATE()
    }
    record.state = next
  }

  #requireLive(record, owned = null) {
    if (!record.destroyed) return
    clear(owned)
    invalidCell()
  }

  #safeObserve(event) {
    if (!this.#observe) return
    try {
      this.#observe(event)
    } catch {
      // Test-only observation cannot affect protocol behavior.
    }
  }

  #payloadHash(payload) {
    let value = null
    const parts = [payload]
    try {
      value = this.#hash(parts)
      if (!fixed(value, 32)) invalidCell()
      if (aliasesInput(value, parts)) invalidCell()
      return copyBuffer(value)
    } catch (err) {
      if (err instanceof PrivateRouteError) throw err
      invalidCell()
    } finally {
      clearAdapterOutput(value, parts)
    }
  }

  #readTime(explicit) {
    let value = explicit
    if (value === undefined) {
      try {
        value = this.#now()
      } catch {
        this.#destroyAll()
        invalidRoute()
      }
    }
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIME) {
      this.#destroyAll()
      invalidRoute()
    }
    if (this.#lastNow !== null && value < this.#lastNow) {
      this.#destroyAll()
      invalidRoute()
    }
    this.#lastNow = value
    return value
  }

  #checkRecordTime(record, current) {
    if (
      BigInt(current) >= record.previous.expiresAt ||
      (record.state !== CIRCUIT_STATE.OPEN && current >= record.halfOpenDeadline)
    ) {
      throw PrivateRouteError.CIRCUIT_STATE()
    }
  }

  #destroyAll() {
    for (const record of Array.from(this.#records)) this.#destroyRecord(record, true)
  }
}
