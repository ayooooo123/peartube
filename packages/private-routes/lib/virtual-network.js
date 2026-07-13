import b4a from 'b4a'

import { PrivateRouteError } from './errors.js'

export const MAX_FAULT_OUTPUTS = 64
export const MAX_PENDING_PACKETS = 100_000
export const MAX_PENDING_BYTES = 16 * 1024 * 1024
export const MAX_PACKET_BYTES = 64 * 1024
export const MAX_VIRTUAL_DELAY = 24 * 60 * 60 * 1000
export const MAX_NODES = 256
export const MAX_NODE_ID_CHARACTERS = 256
export const MAX_NODE_ID_BYTES = 1024
export const MAX_EDGES = 4096
export const MAX_TRACE_EVENTS = 4096
export const TEST_ONLY_LIMITS = Symbol('test-only-limits')
export const TEST_ONLY_INSERTION_HOOK = Symbol('test-only-insertion-hook')
export const TEST_ONLY_PACKET_OBSERVER = Symbol('test-only-packet-observer')

const DEFAULT_MAX_DELIVERIES = 100_000
const DEFAULT_LIMITS = Object.freeze({
  maxPendingPackets: MAX_PENDING_PACKETS,
  maxPendingBytes: MAX_PENDING_BYTES,
  maxPacketBytes: MAX_PACKET_BYTES,
  maxNodes: MAX_NODES,
  maxNodeIdCharacters: MAX_NODE_ID_CHARACTERS,
  maxNodeIdBytes: MAX_NODE_ID_BYTES,
  maxEdges: MAX_EDGES,
  maxTraceEvents: MAX_TRACE_EVENTS,
  maxSequence: Number.MAX_SAFE_INTEGER,
  maxPacketId: Number.MAX_SAFE_INTEGER
})
const bufferByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const bufferFill = Uint8Array.prototype.fill
const bufferSet = Uint8Array.prototype.set
const arrayPush = Array.prototype.push
const arraySort = Array.prototype.sort

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function limit() {
  throw PrivateRouteError.VIRTUAL_LIMIT()
}

function optionsObject(options, optional = false) {
  if (options === undefined && optional) return {}
  try {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) limit()
  } catch {
    limit()
  }
  return options
}

function option(options, name) {
  try {
    return options[name]
  } catch {
    limit()
  }
}

function bufferLength(value) {
  try {
    return b4a.isBuffer(value) ? bufferByteLength.call(value) : -1
  } catch {
    return -1
  }
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) bufferFill.call(value, 0)
  } catch {
    // Best-effort cleanup of test-harness packet copies.
  }
}

function allocate(size) {
  let value = null
  try {
    value = b4a.allocUnsafeSlow(size)
    if (bufferLength(value) !== size) limit()
    return value
  } catch {
    clear(value)
    limit()
  }
}

function copy(value) {
  let owned = null
  try {
    const size = bufferLength(value)
    if (size < 0) limit()
    owned = allocate(size)
    bufferSet.call(owned, value)
    return owned
  } catch {
    clear(owned)
    limit()
  }
}

function identity(value, limits) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > limits.maxNodeIdCharacters
  ) {
    invalid()
  }
  let bytes
  try {
    bytes = b4a.byteLength(value)
  } catch {
    invalid()
  }
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > limits.maxNodeIdBytes) invalid()
  return value
}

function readLimits(options) {
  const configured = option(options, TEST_ONLY_LIMITS)
  if (configured === undefined) return DEFAULT_LIMITS
  const values = optionsObject(configured)
  const limits = {}
  for (const [name, maximum] of Object.entries(DEFAULT_LIMITS)) {
    const value = option(values, name)
    const minimum = name === 'maxSequence' || name === 'maxPacketId' ? 0 : 1
    limits[name] = value === undefined ? maximum : boundedLimit(value, minimum, maximum)
  }
  return Object.freeze(limits)
}

function boundedLimit(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) limit()
  return value
}

function safeTime(value) {
  if (!Number.isSafeInteger(value) || value < 0) limit()
  return value
}

function boundedDelay(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_VIRTUAL_DELAY) limit()
  return value
}

function deliveryLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_MAX_DELIVERIES) limit()
  return value
}

function frozenArray(values) {
  return Object.freeze(values)
}

export class VirtualNetwork {
  #now
  #fault
  #limits
  #insertionHook
  #packetObserver
  #guarded = false
  #flushing = false
  #violation = false
  #nodes = new Map()
  #queue = []
  #head = 0
  #pendingBytes = 0
  #sequence = -1
  #packetIds = new Map()
  #edgeKeys = new Map()
  #edges = []
  #views = new Map()

  constructor(options = {}) {
    options = optionsObject(options)
    const now = option(options, 'now')
    const fault = option(options, 'fault')
    const insertionHook = option(options, TEST_ONLY_INSERTION_HOOK)
    const packetObserver = option(options, TEST_ONLY_PACKET_OBSERVER)

    this.#now = safeTime(now === undefined ? 0 : now)
    if (fault !== undefined && typeof fault !== 'function') limit()
    if (insertionHook !== undefined && typeof insertionHook !== 'function') limit()
    if (packetObserver !== undefined && typeof packetObserver !== 'function') limit()
    this.#limits = readLimits(options)
    this.#fault = fault
    this.#insertionHook = insertionHook
    this.#packetObserver = packetObserver
  }

  get now() {
    return this.#now
  }

  register(name, handler) {
    if (this.#guarded || this.#flushing) this.#violate()
    name = identity(name, this.#limits)
    if (typeof handler !== 'function' || this.#nodes.has(name)) invalid()
    if (this.#nodes.size >= this.#limits.maxNodes) limit()
    this.#nodes.set(name, handler)
    this.#views.set(name, [])
  }

  send(from, to, packet) {
    if (this.#guarded) this.#violate()
    const ownsViolation = !this.#flushing
    if (ownsViolation) this.#violation = false
    from = identity(from, this.#limits)
    to = identity(to, this.#limits)
    if (from === to || !this.#nodes.has(from) || !this.#nodes.has(to)) invalid()
    const packetBytes = bufferLength(packet)
    if (packetBytes < 0) invalid()
    if (packetBytes > this.#limits.maxPacketBytes) limit()

    let source = null
    const prepared = []
    try {
      source = copy(packet)
      let result
      if (this.#fault === undefined) {
        this.#prepareFaultResult(undefined, source, prepared)
      } else {
        const event = Object.freeze({
          from,
          to,
          packet: source,
          time: this.#now
        })
        this.#guarded = true
        try {
          result = this.#fault(event)
          this.#prepareFaultResult(result, source, prepared)
        } finally {
          this.#guarded = false
        }
        if (this.#violation) limit()
      }
      clear(source)
      source = null
      this.#enqueue(from, to, prepared)
      prepared.length = 0
    } catch {
      clear(source)
      for (const value of prepared) clear(value.packet)
      limit()
    } finally {
      this.#guarded = false
      if (ownsViolation) this.#violation = false
    }
  }

  advance(ms) {
    if (this.#guarded || this.#flushing) this.#violate()
    ms = safeTime(ms)
    if (ms > Number.MAX_SAFE_INTEGER - this.#now) limit()
    this.#now += ms
    return this.#now
  }

  flush(options = {}) {
    if (this.#guarded || this.#flushing) this.#violate()
    this.#flushing = true
    this.#violation = false
    try {
      let maxDeliveries
      this.#guarded = true
      try {
        options = optionsObject(options)
        const configured = option(options, 'maxDeliveries')
        maxDeliveries = deliveryLimit(
          configured === undefined ? DEFAULT_MAX_DELIVERIES : configured
        )
      } finally {
        this.#guarded = false
      }
      if (this.#violation) limit()
      let deliveries = 0

      while (this.#pending() > 0) {
        const next = this.#queue[this.#head]
        if (next.deliverAt > this.#now) break
        if (deliveries >= maxDeliveries) {
          this.#clearQueue()
          limit()
        }

        this.#head++
        this.#pendingBytes -= next.byteLength
        deliveries++
        const packet = this.#takePacket(next)
        try {
          this.#record(next)
        } catch {
          clear(packet)
          this.#clearQueue()
          limit()
        }
        this.#deliver(next, packet)
        if (this.#violation) limit()
        this.#compact()
      }

      return deliveries
    } finally {
      this.#guarded = false
      this.#flushing = false
      this.#violation = false
    }
  }

  edges() {
    return frozenArray(this.#edges.map(([from, to]) => frozenArray([from, to])))
  }

  directPeers(name) {
    name = identity(name, this.#limits)
    if (!this.#nodes.has(name)) invalid()
    const seen = new Set()
    const peers = []
    for (const [from, to] of this.#edges) {
      const peer = from === name ? to : to === name ? from : null
      if (peer !== null && !seen.has(peer)) {
        seen.add(peer)
        peers.push(peer)
      }
    }
    return frozenArray(peers)
  }

  view(name) {
    name = identity(name, this.#limits)
    const events = this.#views.get(name)
    if (events === undefined) invalid()
    return frozenArray(events.slice())
  }

  consumeView(name) {
    if (this.#guarded || this.#flushing) this.#violate()
    name = identity(name, this.#limits)
    const events = this.#views.get(name)
    if (events === undefined) invalid()
    const snapshot = frozenArray(events.slice())
    events.length = 0
    return snapshot
  }

  #prepareFaultResult(result, source, prepared) {
    if (result === 'drop') return
    if (result === undefined) {
      prepared.push(this.#preparePacket(source, 0))
      return
    }

    let array
    try {
      array = Array.isArray(result)
    } catch {
      limit()
    }
    if (array) {
      let length
      try {
        length = result.length
      } catch {
        limit()
      }
      if (!Number.isSafeInteger(length) || length < 1 || length > MAX_FAULT_OUTPUTS) limit()
      for (let i = 0; i < length; i++) {
        let value
        try {
          value = result[i]
        } catch {
          limit()
        }
        if (value === 'drop') continue
        const packet = this.#prepareFaultPacket(value, source)
        if (packet !== null) prepared.push(packet)
      }
      return
    }

    const packet = this.#prepareFaultPacket(result, source)
    if (packet !== null) prepared.push(packet)
  }

  #prepareFaultPacket(spec, source) {
    let isArray
    try {
      isArray = Array.isArray(spec)
      if (spec === null || typeof spec !== 'object' || isArray || bufferLength(spec) >= 0) limit()
    } catch {
      limit()
    }

    let drop
    let delay
    let packet
    try {
      drop = spec.drop
      delay = spec.delay
      packet = spec.packet
    } catch {
      limit()
    }
    if (drop === true) {
      if (delay !== undefined || packet !== undefined) limit()
      return null
    }
    if (drop !== undefined) limit()
    delay = delay === undefined ? 0 : boundedDelay(delay)
    packet = packet === undefined ? source : packet
    if (bufferLength(packet) < 0) limit()
    return this.#preparePacket(packet, delay)
  }

  #preparePacket(packet, delay) {
    if (delay > Number.MAX_SAFE_INTEGER - this.#now) limit()
    const byteLength = bufferLength(packet)
    if (byteLength < 0 || byteLength > this.#limits.maxPacketBytes) limit()
    const owned = copy(packet)
    return {
      from: null,
      to: null,
      packet: owned,
      byteLength,
      deliverAt: this.#now + delay,
      sequence: -1,
      packetId: null
    }
  }

  #enqueue(from, to, prepared) {
    const count = prepared.length
    if (count === 0) return

    let bytes = 0
    for (const value of prepared) {
      if (value.byteLength > Number.MAX_SAFE_INTEGER - bytes) {
        this.#clearQueue()
        limit()
      }
      bytes += value.byteLength
    }
    if (
      count > this.#limits.maxPendingPackets - this.#pending() ||
      bytes > this.#limits.maxPendingBytes - this.#pendingBytes
    ) {
      this.#clearQueue()
      limit()
    }

    const sequenceExhausted =
      this.#sequence === -1
        ? count - 1 > this.#limits.maxSequence
        : count > this.#limits.maxSequence - this.#sequence
    const packetId = this.#packetId(from, to)
    if (sequenceExhausted || count > this.#limits.maxPacketId - packetId) {
      this.#clearQueue()
      limit()
    }

    for (let i = 0; i < count; i++) {
      const value = prepared[i]
      value.from = from
      value.to = to
      value.sequence = this.#sequence + i + 1
      value.packetId = `packet-${packetId + i + 1}`
    }
    arraySort.call(prepared, compare)
    this.#guarded = true
    try {
      if (this.#insertionHook !== undefined) {
        for (let index = 0; index < prepared.length; index++) {
          this.#insertionHook(Object.freeze({ index, packet: prepared[index].packet }))
        }
      }
    } finally {
      this.#guarded = false
    }
    if (this.#violation) limit()

    this.#commitPrepared(prepared)
    this.#pendingBytes += bytes
    this.#sequence = this.#sequence === -1 ? count - 1 : this.#sequence + count
    this.#setPacketId(from, to, packetId + count)
  }

  #commitPrepared(prepared) {
    const pending = this.#pending()
    if (pending === 0) {
      this.#queue = []
      this.#head = 0
      for (const value of prepared) arrayPush.call(this.#queue, value)
      return
    }

    const last = this.#queue[this.#queue.length - 1]
    if (compare(last, prepared[0]) <= 0) {
      for (const value of prepared) arrayPush.call(this.#queue, value)
      return
    }

    const candidate = new Array(pending + prepared.length)
    let oldIndex = this.#head
    let newIndex = 0
    let outputIndex = 0
    while (oldIndex < this.#queue.length || newIndex < prepared.length) {
      if (
        newIndex < prepared.length &&
        (oldIndex >= this.#queue.length || compare(prepared[newIndex], this.#queue[oldIndex]) < 0)
      ) {
        candidate[outputIndex++] = prepared[newIndex++]
      } else {
        candidate[outputIndex++] = this.#queue[oldIndex++]
      }
    }
    this.#queue = candidate
    this.#head = 0
  }

  #packetId(from, to) {
    const destinations = this.#packetIds.get(from)
    return destinations === undefined ? 0 : destinations.get(to) || 0
  }

  #setPacketId(from, to, value) {
    let destinations = this.#packetIds.get(from)
    if (destinations === undefined) {
      destinations = new Map()
      this.#packetIds.set(from, destinations)
    }
    destinations.set(to, value)
  }

  #takePacket(value) {
    try {
      const packet = copy(value.packet)
      clear(value.packet)
      value.packet = null
      return packet
    } catch {
      clear(value.packet)
      value.packet = null
      this.#clearQueue()
      limit()
    }
  }

  #deliver(value, packet) {
    if (this.#packetObserver !== undefined) {
      let failed = false
      this.#guarded = true
      try {
        this.#packetObserver(packet)
      } catch {
        failed = true
      } finally {
        this.#guarded = false
      }
      if (failed || this.#violation) {
        clear(packet)
        this.#clearQueue()
        limit()
      }
    }

    let failed = false
    let error = null
    try {
      this.#nodes.get(value.to)(packet)
    } catch (cause) {
      failed = true
      error = cause
    } finally {
      clear(packet)
    }
    if (this.#violation) limit()
    // Handler exceptions are application failures: preserve their identity and
    // leave later packets queued so a test can inspect or resume deterministically.
    if (failed) throw error
  }

  #record(value) {
    let destinations = this.#edgeKeys.get(value.from)
    const newEdge = destinations === undefined || !destinations.has(value.to)
    const outgoingEvents = this.#views.get(value.from)
    const incomingEvents = this.#views.get(value.to)
    if (
      (newEdge && this.#edges.length >= this.#limits.maxEdges) ||
      outgoingEvents.length >= this.#limits.maxTraceEvents ||
      incomingEvents.length >= this.#limits.maxTraceEvents
    ) {
      limit()
    }

    if (destinations === undefined) {
      destinations = new Set()
      this.#edgeKeys.set(value.from, destinations)
    }
    if (newEdge) {
      destinations.add(value.to)
      this.#edges.push([value.from, value.to])
    }

    // #takePacket clears the queued copy, so use the handler copy's recorded
    // intrinsic length retained before dispatch.
    const byteLength = value.byteLength
    const outgoing = Object.freeze({
      peer: value.to,
      direction: 'outbound',
      byteLength,
      time: this.#now,
      packetId: value.packetId
    })
    const incoming = Object.freeze({
      peer: value.from,
      direction: 'inbound',
      byteLength,
      time: this.#now,
      packetId: value.packetId
    })
    outgoingEvents.push(outgoing)
    incomingEvents.push(incoming)
  }

  #pending() {
    return this.#queue.length - this.#head
  }

  #compact() {
    if (this.#head === 0) return
    if (this.#head < 1024 || this.#head * 2 < this.#queue.length) return
    this.#queue = this.#queue.slice(this.#head)
    this.#head = 0
  }

  #clearQueue() {
    for (let i = this.#head; i < this.#queue.length; i++) clear(this.#queue[i].packet)
    this.#queue = []
    this.#head = 0
    this.#pendingBytes = 0
  }

  #violate() {
    this.#violation = true
    this.#clearQueue()
    limit()
  }
}

function compare(a, b) {
  return a.deliverAt - b.deliverAt || a.sequence - b.sequence
}
