import b4a from 'b4a'

import { PrivateRouteError } from './errors.js'

export const MAX_FAULT_OUTPUTS = 64
export const MAX_PENDING_PACKETS = 100_000
export const MAX_VIRTUAL_DELAY = 24 * 60 * 60 * 1000
export const TEST_ONLY_PACKET_OBSERVER = Symbol('test-only-packet-observer')

const DEFAULT_MAX_DELIVERIES = 100_000
const bufferByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const bufferFill = Uint8Array.prototype.fill
const bufferSet = Uint8Array.prototype.set

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

function identity(value) {
  if (typeof value !== 'string' || value.length === 0) invalid()
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
  #packetObserver
  #inFault = false
  #flushing = false
  #violation = false
  #nodes = new Map()
  #queue = []
  #head = 0
  #sequence = 0
  #packetSequence = 0
  #sendSequence = 0
  #edgeKeys = new Map()
  #edges = []
  #views = new Map()

  constructor(options = {}) {
    options = optionsObject(options)
    const now = option(options, 'now')
    const fault = option(options, 'fault')
    const packetObserver = option(options, TEST_ONLY_PACKET_OBSERVER)

    this.#now = safeTime(now === undefined ? 0 : now)
    if (fault !== undefined && typeof fault !== 'function') limit()
    if (packetObserver !== undefined && typeof packetObserver !== 'function') limit()
    this.#fault = fault
    this.#packetObserver = packetObserver
  }

  get now() {
    return this.#now
  }

  register(name, handler) {
    if (this.#inFault) this.#violate()
    name = identity(name)
    if (typeof handler !== 'function' || this.#nodes.has(name)) invalid()
    this.#nodes.set(name, handler)
    this.#views.set(name, [])
  }

  send(from, to, packet) {
    if (this.#inFault) this.#violate()
    const ownsViolation = !this.#flushing
    if (ownsViolation) this.#violation = false
    from = identity(from)
    to = identity(to)
    if (from === to || !this.#nodes.has(from) || !this.#nodes.has(to)) invalid()
    if (bufferLength(packet) < 0) invalid()

    let source = null
    const prepared = []
    try {
      source = copy(packet)
      const sendId = `send-${++this.#sendSequence}`
      let result
      if (this.#fault === undefined) {
        result = undefined
      } else {
        const event = Object.freeze({ from, to, packet: source, time: this.#now, packetId: sendId })
        this.#inFault = true
        try {
          result = this.#fault(event)
        } finally {
          this.#inFault = false
        }
        if (this.#violation) limit()
      }

      this.#prepareFaultResult(result, source, prepared)
      clear(source)
      source = null

      if (this.#pending() + prepared.length > MAX_PENDING_PACKETS) {
        this.#clearQueue()
        limit()
      }

      for (const value of prepared) {
        value.from = from
        value.to = to
        value.sequence = this.#sequence++
        value.packetId = `packet-${++this.#packetSequence}`
        this.#insert(value)
      }
      prepared.length = 0
    } catch {
      clear(source)
      for (const value of prepared) clear(value.packet)
      limit()
    } finally {
      this.#inFault = false
      if (ownsViolation) this.#violation = false
    }
  }

  advance(ms) {
    if (this.#inFault) this.#violate()
    ms = safeTime(ms)
    if (ms > Number.MAX_SAFE_INTEGER - this.#now) limit()
    this.#now += ms
    return this.#now
  }

  flush(options = {}) {
    if (this.#inFault || this.#flushing) this.#violate()
    this.#flushing = true
    this.#violation = false
    try {
      options = optionsObject(options)
      const configured = option(options, 'maxDeliveries')
      const maxDeliveries = deliveryLimit(
        configured === undefined ? DEFAULT_MAX_DELIVERIES : configured
      )
      let deliveries = 0

      while (this.#pending() > 0) {
        const next = this.#queue[this.#head]
        if (next.deliverAt > this.#now) break
        if (deliveries >= maxDeliveries) {
          this.#clearQueue()
          limit()
        }

        this.#head++
        deliveries++
        const packet = this.#takePacket(next)
        this.#record(next)
        this.#deliver(next, packet)
        if (this.#violation) limit()
        this.#compact()
      }

      return deliveries
    } finally {
      this.#flushing = false
      this.#violation = false
    }
  }

  edges() {
    return frozenArray(this.#edges.map(([from, to]) => frozenArray([from, to])))
  }

  directPeers(name) {
    name = identity(name)
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
    name = identity(name)
    const events = this.#views.get(name)
    if (events === undefined) invalid()
    return frozenArray(events.slice())
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
      if (length < 1 || length > MAX_FAULT_OUTPUTS) limit()
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
    const owned = copy(packet)
    return {
      from: null,
      to: null,
      packet: owned,
      byteLength: bufferLength(owned),
      deliverAt: this.#now + delay,
      sequence: -1,
      packetId: null
    }
  }

  #insert(value) {
    if (this.#head > 0) this.#compact(true)
    const queue = this.#queue
    const last = queue[queue.length - 1]
    if (last === undefined || compare(last, value) <= 0) {
      queue.push(value)
      return
    }

    let lower = 0
    let upper = queue.length
    while (lower < upper) {
      const middle = (lower + upper) >>> 1
      if (compare(queue[middle], value) <= 0) lower = middle + 1
      else upper = middle
    }
    queue.splice(lower, 0, value)
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
      try {
        this.#packetObserver(packet)
      } catch {
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
    if (destinations === undefined) {
      destinations = new Set()
      this.#edgeKeys.set(value.from, destinations)
    }
    if (!destinations.has(value.to)) {
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
    this.#views.get(value.from).push(outgoing)
    this.#views.get(value.to).push(incoming)
  }

  #pending() {
    return this.#queue.length - this.#head
  }

  #compact(force = false) {
    if (this.#head === 0) return
    if (!force && this.#head < 1024 && this.#head * 2 < this.#queue.length) return
    this.#queue = this.#queue.slice(this.#head)
    this.#head = 0
  }

  #clearQueue() {
    for (let i = this.#head; i < this.#queue.length; i++) clear(this.#queue[i].packet)
    this.#queue = []
    this.#head = 0
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
