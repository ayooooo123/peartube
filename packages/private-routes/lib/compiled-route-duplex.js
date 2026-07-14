import b4a from 'b4a'

import { PrivateRouteError } from './errors.js'
import { CELL_CLASS, DIRECTION } from './protocol.js'
import { MAX_ROUTE_PAYLOAD, ROUTE_FRAME_SIZE, RoutePayloadCodec } from './route-payload.js'
import { UDX_LINK_CLOSE, UDX_LINK_STATS, UDX_SEND_CELL } from './udx-adapter.js'
import { UdxCellEndpoint } from './udx-cell-endpoint.js'

export const MAX_COMPILED_STREAM_FRAGMENTS = 8
export const MAX_COMPILED_STREAM_WRITE = MAX_ROUTE_PAYLOAD * MAX_COMPILED_STREAM_FRAGMENTS
export const DEFAULT_MAX_COMPILED_QUEUED_BYTES = MAX_COMPILED_STREAM_WRITE
export const DEFAULT_MAX_COMPILED_QUEUED_FRAGMENTS = MAX_COMPILED_STREAM_FRAGMENTS
export const DEFAULT_MAX_COMPILED_READ_BYTES = MAX_COMPILED_STREAM_WRITE
export const DEFAULT_MAX_COMPILED_READ_FRAGMENTS = MAX_COMPILED_STREAM_FRAGMENTS
export const DEFAULT_MAX_COMPILED_DATAGRAM_BYTES = MAX_COMPILED_STREAM_WRITE
export const DEFAULT_MAX_COMPILED_DATAGRAMS = MAX_COMPILED_STREAM_FRAGMENTS
export const DEFAULT_COMPILED_LOW_WATER_MARK = 1

const MAX_UINT64 = (1n << 64n) - 1n
const DUPLEXES = new WeakMap()
const CLAIMED_GENERATIONS = new WeakMap()
const routeStats = Object.getOwnPropertyDescriptor(RoutePayloadCodec.prototype, 'stats').get
const routeSeal = RoutePayloadCodec.prototype.seal
const routeOpen = RoutePayloadCodec.prototype.open
const routeDestroy = RoutePayloadCodec.prototype.destroy
const linkStats = UdxCellEndpoint.prototype[UDX_LINK_STATS]
const sendCell = UdxCellEndpoint.prototype[UDX_SEND_CELL]
const closeLink = UdxCellEndpoint.prototype[UDX_LINK_CLOSE]
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get
const subarray = Uint8Array.prototype.subarray

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function unavailable() {
  return PrivateRouteError.ROUTE_UNAVAILABLE()
}

function stateError() {
  return PrivateRouteError.CIRCUIT_STATE()
}

function isObject(value) {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  } catch {
    return false
  }
}

function bufferLength(value) {
  try {
    return b4a.isBuffer(value) ? byteLength.call(value) : -1
  } catch {
    return -1
  }
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) b4a.fill(value, 0)
  } catch {}
}

function u64(value, nonzero = false) {
  return typeof value === 'bigint' && value >= (nonzero ? 1n : 0n) && value <= MAX_UINT64
}

function bound(value, fallback, minimum = 1) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > fallback) invalid()
  return value
}

function direction(value) {
  if (value !== DIRECTION.FORWARD && value !== DIRECTION.REVERSE) invalid()
  return value
}

function opposite(value) {
  return value === DIRECTION.FORWARD ? DIRECTION.REVERSE : DIRECTION.FORWARD
}

function stateFor(duplex, open = false) {
  let state = null
  try {
    state = DUPLEXES.get(duplex)
  } catch {}
  if (!state) invalid()
  if (open && state.closed) throw stateError()
  return state
}

function genuineRoutePayload(value) {
  try {
    const stats = routeStats.call(value)
    return stats && stats.destroyed === false
  } catch {
    return false
  }
}

function genuineLink(endpoint, handle) {
  try {
    const stats = linkStats.call(endpoint, handle)
    return stats && stats.closed === false
  } catch {
    return false
  }
}

function rejectDrains(state, error) {
  for (const record of state.drains) record.reject(error)
  state.drains.clear()
}

function clearInbound(state) {
  for (const value of state.readQueue) clear(value)
  for (const value of state.datagrams) clear(value)
  state.readQueue.length = 0
  state.datagrams.length = 0
  state.readBytes = 0
  state.datagramBytes = 0
}

function cancelPoll(state) {
  if (state.pollTimer === null) return
  const timer = state.pollTimer
  state.pollTimer = null
  try {
    state.cancel(timer)
  } catch {}
}

function beginClose(state, error = unavailable()) {
  if (state.closed) return state.destroyPromise
  state.closed = true
  state.reason = error
  cancelPoll(state)
  rejectDrains(state, error)
  clearInbound(state)
  state.queuedBytes = 0
  state.queuedFragments = 0
  for (const record of state.sends) record.active = false
  const waits = Array.from(state.sends, (record) => record.wait)
  state.sends.clear()
  try {
    routeDestroy.call(state.routePayload)
  } catch {}
  try {
    closeLink.call(state.endpoint, state.handle)
  } catch {}
  state.destroyPromise = Promise.allSettled(waits).then(() => true)
  return state.destroyPromise
}

function fail(state, error = unavailable()) {
  beginClose(state, error)
  return error
}

function completeSend(state, record, sent) {
  if (!record.active) return
  record.active = false
  state.sends.delete(record)
  state.queuedBytes -= record.bytes
  state.queuedFragments--
  if (state.queuedBytes < 0 || state.queuedFragments < 0) {
    fail(state)
    return
  }
  if (sent !== true) {
    fail(state)
    return
  }
  checkDrains(state)
}

function enqueueOutbound(state, cellClass, payload, bytes) {
  let sending
  try {
    sending = sendCell.call(state.endpoint, state.handle, {
      class: cellClass,
      direction: state.direction,
      generation: state.generation,
      payload
    })
  } catch (err) {
    throw fail(state, err instanceof PrivateRouteError ? err : unavailable())
  }
  const record = { bytes, active: true, wait: null }
  state.queuedBytes += bytes
  state.queuedFragments++
  state.sends.add(record)
  record.wait = Promise.resolve(sending).then(
    (sent) => {
      completeSend(state, record, sent)
      return sent === true
    },
    () => {
      completeSend(state, record, false)
      return false
    }
  )
  return true
}

function sealAndEnqueue(state, cellClass, payload) {
  let frame = null
  try {
    frame = routeSeal.call(state.routePayload, {
      direction: state.direction,
      class: cellClass,
      payload
    })
    if (bufferLength(frame) !== ROUTE_FRAME_SIZE) invalid()
    enqueueOutbound(state, cellClass, frame, bufferLength(payload))
    if (cellClass === CELL_CLASS.STREAM) state.streamCount++
    return true
  } catch (err) {
    const error = err instanceof PrivateRouteError ? err : PrivateRouteError.INVALID_ROUTE()
    fail(state, error)
    throw error
  } finally {
    clear(frame)
  }
}

function linkState(state) {
  let stats
  try {
    stats = linkStats.call(state.endpoint, state.handle)
  } catch {
    throw fail(state)
  }
  if (!stats || stats.closed) throw fail(state)
  return stats
}

function armPoll(state) {
  if (state.closed || state.drains.size === 0 || state.pollTimer !== null) return
  let arming = true
  let synchronous = false
  let timer
  const poll = () => {
    if (arming) {
      synchronous = true
      return
    }
    if (state.pollTimer !== timer || state.closed) return
    state.pollTimer = null
    checkDrains(state)
  }
  try {
    timer = state.schedule(poll, 1)
  } catch {
    arming = false
    fail(state)
    return
  }
  arming = false
  if (synchronous || timer === undefined || timer === null) {
    try {
      state.cancel(timer)
    } catch {}
    fail(state)
    return
  }
  state.pollTimer = timer
}

function checkDrains(state) {
  if (state.closed || state.drains.size === 0) return
  let stats
  try {
    stats = linkState(state)
  } catch {
    return
  }
  for (const record of Array.from(state.drains)) {
    const newer = state.streamCount - record.sentCount
    const acknowledged = record.counter === null || BigInt(stats.pendingStreams) <= newer
    if (!acknowledged || state.queuedBytes >= state.lowWaterMark) continue
    state.drains.delete(record)
    record.resolve(true)
  }
  armPoll(state)
}

function write(state, payload) {
  if (state.closed) throw stateError()
  const size = bufferLength(payload)
  if (size < 0 || size > MAX_COMPILED_STREAM_WRITE) invalid()
  if (size === 0) return true
  const fragments = Math.ceil(size / MAX_ROUTE_PAYLOAD)
  if (
    state.queuedFragments + fragments > state.maxQueuedFragments ||
    state.queuedBytes + size > state.maxQueuedBytes
  ) {
    return false
  }
  for (let offset = 0; offset < size; offset += MAX_ROUTE_PAYLOAD) {
    sealAndEnqueue(
      state,
      CELL_CLASS.STREAM,
      subarray.call(payload, offset, Math.min(size, offset + MAX_ROUTE_PAYLOAD))
    )
  }
  return true
}

function sendDatagram(state, payload) {
  if (state.closed) throw stateError()
  const size = bufferLength(payload)
  if (size < 0 || size > MAX_ROUTE_PAYLOAD) invalid()
  if (
    state.queuedFragments >= state.maxQueuedFragments ||
    state.queuedBytes + size > state.maxQueuedBytes
  ) {
    return false
  }
  return sealAndEnqueue(state, CELL_CLASS.DATAGRAM, payload)
}

function read(state) {
  if (state.closed) throw stateError()
  const value = state.readQueue.shift()
  if (!value) return null
  state.readBytes -= value.byteLength
  return value
}

function receiveDatagram(state) {
  if (state.closed) throw stateError()
  const value = state.datagrams.shift()
  if (!value) return null
  state.datagramBytes -= value.byteLength
  return value
}

function drain(state) {
  if (state.closed) return Promise.reject(stateError())
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  const record = {
    generation: state.generation,
    sentCount: state.streamCount,
    counter: state.streamCount === 0n ? null : state.streamCount - 1n,
    resolve,
    reject
  }
  state.drains.add(record)
  checkDrains(state)
  return promise
}

export function createCompiledRouteDuplex(options = {}) {
  if (!isObject(options)) invalid()
  let endpoint
  let handle
  let routePayload
  let generation
  let sendDirection
  let schedule
  let cancel
  try {
    endpoint = options.endpoint
    handle = options.handle
    routePayload = options.routePayload
    generation = options.generation
    sendDirection = options.direction
    schedule = options.schedule
    cancel = options.cancel
  } catch {
    invalid()
  }
  if (
    !isObject(endpoint) ||
    !isObject(handle) ||
    !genuineRoutePayload(routePayload) ||
    !u64(generation, true) ||
    !genuineLink(endpoint, handle) ||
    typeof schedule !== 'function' ||
    typeof cancel !== 'function'
  ) {
    invalid()
  }
  sendDirection = direction(sendDirection)
  const maxQueuedBytes = bound(
    options.maxQueuedBytes,
    DEFAULT_MAX_COMPILED_QUEUED_BYTES,
    MAX_ROUTE_PAYLOAD
  )
  const maxQueuedFragments = bound(
    options.maxQueuedFragments,
    DEFAULT_MAX_COMPILED_QUEUED_FRAGMENTS
  )
  const lowWaterMark =
    options.lowWaterMark === undefined ? DEFAULT_COMPILED_LOW_WATER_MARK : options.lowWaterMark
  if (!Number.isSafeInteger(lowWaterMark) || lowWaterMark < 1 || lowWaterMark > maxQueuedBytes)
    invalid()
  const maxReadBytes = bound(
    options.maxReadBytes,
    DEFAULT_MAX_COMPILED_READ_BYTES,
    MAX_ROUTE_PAYLOAD
  )
  const maxReadFragments = bound(options.maxReadFragments, DEFAULT_MAX_COMPILED_READ_FRAGMENTS)
  const maxDatagramBytes = bound(
    options.maxDatagramBytes,
    DEFAULT_MAX_COMPILED_DATAGRAM_BYTES,
    MAX_ROUTE_PAYLOAD
  )
  const maxDatagrams = bound(options.maxDatagrams, DEFAULT_MAX_COMPILED_DATAGRAMS)
  let generations = CLAIMED_GENERATIONS.get(handle)
  if (!generations) {
    generations = new Set()
    CLAIMED_GENERATIONS.set(handle, generations)
  }
  const claim = generation.toString()
  if (generations.has(claim)) throw PrivateRouteError.UNAUTHORIZED()
  generations.add(claim)
  const state = {
    endpoint,
    handle,
    routePayload,
    generation,
    direction: sendDirection,
    receiveDirection: opposite(sendDirection),
    schedule,
    cancel,
    maxQueuedBytes,
    maxQueuedFragments,
    lowWaterMark,
    maxReadBytes,
    maxReadFragments,
    maxDatagramBytes,
    maxDatagrams,
    streamCount: 0n,
    queuedBytes: 0,
    queuedFragments: 0,
    readBytes: 0,
    readQueue: [],
    datagramBytes: 0,
    datagrams: [],
    sends: new Set(),
    drains: new Set(),
    pollTimer: null,
    closed: false,
    reason: null,
    destroyPromise: null
  }
  const duplex = Object.freeze({
    write(payload) {
      return write(state, payload)
    },
    read() {
      return read(state)
    },
    sendDatagram(payload) {
      return sendDatagram(state, payload)
    },
    receiveDatagram() {
      return receiveDatagram(state)
    },
    drain() {
      return drain(state)
    },
    destroy() {
      return beginClose(state, stateError())
    }
  })
  DUPLEXES.set(duplex, state)
  return duplex
}

export function receiveCompiledRouteCell(duplex, handle, frame, metadata = {}) {
  const state = stateFor(duplex, true)
  if (
    handle !== state.handle ||
    !isObject(metadata) ||
    metadata.direction !== state.receiveDirection ||
    metadata.generation !== state.generation ||
    !u64(metadata.counter) ||
    bufferLength(frame) !== ROUTE_FRAME_SIZE
  ) {
    throw fail(state, PrivateRouteError.UNAUTHORIZED())
  }
  if (
    state.readQueue.length >= state.maxReadFragments ||
    state.readBytes + MAX_ROUTE_PAYLOAD > state.maxReadBytes
  ) {
    return false
  }
  let opened = null
  let accepted = false
  try {
    opened = routeOpen.call(state.routePayload, { direction: state.receiveDirection }, frame)
    if (Array.isArray(opened)) {
      let bytes = 0
      for (const value of opened) {
        if (!value || value.class !== CELL_CLASS.STREAM || bufferLength(value.payload) < 0)
          invalid()
        bytes += value.payload.byteLength
      }
      if (
        state.readQueue.length + opened.length > state.maxReadFragments ||
        state.readBytes + bytes > state.maxReadBytes
      ) {
        throw PrivateRouteError.CIRCUIT_LIMIT()
      }
      for (const value of opened) {
        state.readQueue.push(value.payload)
        state.readBytes += value.payload.byteLength
      }
      accepted = true
      return true
    }
    if (!opened || opened.class !== CELL_CLASS.DATAGRAM || bufferLength(opened.payload) < 0)
      invalid()
    if (
      state.datagrams.length >= state.maxDatagrams ||
      state.datagramBytes + opened.payload.byteLength > state.maxDatagramBytes
    ) {
      return false
    }
    state.datagrams.push(opened.payload)
    state.datagramBytes += opened.payload.byteLength
    accepted = true
    return true
  } catch (err) {
    const error = err instanceof PrivateRouteError ? err : PrivateRouteError.INVALID_ROUTE()
    throw fail(state, error)
  } finally {
    if (!accepted) {
      if (Array.isArray(opened)) {
        for (const value of opened) clear(value && value.payload)
      } else {
        clear(opened && opened.payload)
      }
    }
    if (accepted) clear(frame)
  }
}

export function failCompiledRouteDuplex(duplex) {
  return beginClose(stateFor(duplex), unavailable())
}

export function replaceCompiledRouteDuplex(duplex, nextGeneration) {
  const state = stateFor(duplex, true)
  if (!u64(nextGeneration, true) || nextGeneration <= state.generation) invalid()
  return beginClose(state, unavailable())
}

export function isCompiledRouteDuplex(value) {
  try {
    return DUPLEXES.has(value)
  } catch {
    return false
  }
}

export function readCompiledRouteDuplexStats(duplex) {
  const state = stateFor(duplex)
  return Object.freeze({
    generation: state.generation,
    closed: state.closed,
    queuedBytes: state.queuedBytes,
    queuedFragments: state.queuedFragments,
    readBytes: state.readBytes,
    readFragments: state.readQueue.length,
    datagramBytes: state.datagramBytes,
    datagrams: state.datagrams.length,
    drains: state.drains.size,
    timers: state.pollTimer === null ? 0 : 1
  })
}
