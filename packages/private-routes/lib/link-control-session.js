import b4a from 'b4a'

import {
  ASYNC_CIRCUIT_STATE,
  destroyAsyncRouteControlSession,
  isAsyncRouteControlSession,
  readAsyncRouteControlCircuitState,
  stopAsyncRouteControlSession
} from './async-route-control-session.js'
import { PrivateRouteError } from './errors.js'
import { CELL_CLASS, DIRECTION, PROTOCOL_VERSION } from './protocol.js'
import {
  CIRCUIT_DESTROY_REASON,
  CONTROL_NAMESPACE,
  LINK_CONTROL_KIND,
  RemoteControlMux
} from './remote-control.js'

export const LINK_PING_AFTER = 500
export const LINK_UNRESPONSIVE_AFTER = 1_500
export const STREAM_ACK_TIMEOUT = 5_000
export const LINK_CIRCUIT_TEARDOWN_TIMEOUT = 5_000
export const DEFAULT_MAX_UNACKNOWLEDGED_STREAMS = 64
export const DEFAULT_MAX_UNACKNOWLEDGED_BYTES = 64 * 1_146
export const DEFAULT_MAX_STREAM_SPACES = 64
export const DEFAULT_MAX_CONTROL_SENDS = 64

const MAX_UINT64 = (1n << 64n) - 1n
const MAX_EVENT_PAYLOAD = 1_146
const DEFAULT_MAX_AUTHENTICATED_EVENTS = 64
const CONSUMERS = new WeakMap()
const EVENTS = new WeakMap()
const SESSIONS = new WeakMap()
const CIRCUIT_DIRECTION_CAPABILITIES = new WeakMap()
const CIRCUIT_TEARDOWNS = new WeakMap()

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function unavailable() {
  return PrivateRouteError.ROUTE_UNAVAILABLE()
}

function isObject(value) {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  } catch {
    return false
  }
}

function fixed(value, size) {
  try {
    return b4a.isBuffer(value) && value.byteLength === size
  } catch {
    return false
  }
}

function same(left, right) {
  try {
    return fixed(left, right.byteLength) && b4a.equals(left, right)
  } catch {
    return false
  }
}

function allZero(value) {
  try {
    for (const byte of value) if (byte !== 0) return false
    return true
  } catch {
    return true
  }
}

function u64(value, nonzero = false) {
  return typeof value === 'bigint' && value >= (nonzero ? 1n : 0n) && value <= MAX_UINT64
}

function knownDirection(value) {
  return value === DIRECTION.FORWARD || value === DIRECTION.REVERSE
}

function knownClass(value) {
  return (
    value === CELL_CLASS.CONTROL || value === CELL_CLASS.STREAM || value === CELL_CLASS.DATAGRAM
  )
}

function opposite(value) {
  if (!knownDirection(value)) invalid()
  return value === DIRECTION.FORWARD ? DIRECTION.REVERSE : DIRECTION.FORWARD
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) b4a.fill(value, 0)
  } catch {}
}

function bound(value, fallback) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > fallback) invalid()
  return value
}

function teardownState(value) {
  const state = CIRCUIT_TEARDOWNS.get(value)
  if (!state || state.closed) throw unavailable()
  return state
}

function teardownNow(state) {
  let current
  try {
    current = state.now()
  } catch {
    throw unavailable()
  }
  if (!Number.isSafeInteger(current) || current < 0 || current < state.lastNow) throw unavailable()
  state.lastNow = current
  return current
}

function removeTeardownRecord(state, record, stop) {
  if (!record.active) return false
  record.active = false
  state.records.delete(record)
  if (record.timer !== null) {
    const timer = record.timer
    record.timer = null
    try {
      state.cancel(timer)
    } catch {}
  }
  if (!stop) return true
  let cleanup
  try {
    cleanup = Promise.resolve(stopAsyncRouteControlSession(record.session)).catch(() => false)
  } catch {
    cleanup = Promise.resolve(false)
  }
  state.cleanups.add(cleanup)
  cleanup.finally(() => state.cleanups.delete(cleanup))
  return true
}

function armCircuitTeardown(state, record) {
  let arming = true
  let synchronous = false
  let timer
  const expire = () => {
    if (arming) {
      synchronous = true
      return
    }
    if (!record.active || record.timer !== timer) return
    record.timer = null
    removeTeardownRecord(state, record, true)
  }
  try {
    timer = state.schedule(expire, LINK_CIRCUIT_TEARDOWN_TIMEOUT)
  } catch {
    arming = false
    removeTeardownRecord(state, record, true)
    throw unavailable()
  }
  arming = false
  if (synchronous || timer === undefined || timer === null || !record.active) {
    try {
      state.cancel(timer)
    } catch {}
    removeTeardownRecord(state, record, true)
    throw unavailable()
  }
  record.timer = timer
}

export function createOpenCircuitDirectionCapability(options = {}) {
  if (!isObject(options)) invalid()
  const { link, direction, session } = options
  if (
    !isObject(link) ||
    !knownDirection(direction) ||
    !isAsyncRouteControlSession(session) ||
    readAsyncRouteControlCircuitState(session) !== ASYNC_CIRCUIT_STATE.OPEN
  )
    invalid()
  const capability = Object.freeze({})
  CIRCUIT_DIRECTION_CAPABILITIES.set(capability, { link, direction, session })
  return capability
}

export class LinkCircuitTeardown {
  constructor(options = {}) {
    if (!isObject(options)) invalid()
    const { now, schedule, cancel } = options
    if (typeof now !== 'function' || typeof schedule !== 'function' || typeof cancel !== 'function')
      invalid()
    CIRCUIT_TEARDOWNS.set(this, {
      now,
      schedule,
      cancel,
      lastNow: 0,
      maxDirections: bound(options.maxDirections, DEFAULT_MAX_STREAM_SPACES),
      records: new Set(),
      cleanups: new Set(),
      closed: false,
      closePromise: null
    })
  }

  get stats() {
    const state = CIRCUIT_TEARDOWNS.get(this)
    if (!state) throw unavailable()
    let live = 0
    let destroying = 0
    let timers = 0
    for (const record of state.records) {
      if (record.phase === 'LIVE') live++
      else destroying++
      if (record.timer !== null) timers++
    }
    return Object.freeze({ live, destroying, timers })
  }

  add(capability) {
    const state = teardownState(this)
    const value = CIRCUIT_DIRECTION_CAPABILITIES.get(capability)
    if (
      !value ||
      !isAsyncRouteControlSession(value.session) ||
      readAsyncRouteControlCircuitState(value.session) !== ASYNC_CIRCUIT_STATE.OPEN
    )
      invalid()
    if (state.records.size >= state.maxDirections) throw PrivateRouteError.CIRCUIT_LIMIT()
    for (const record of state.records) {
      if (record.link === value.link && record.direction === value.direction) invalid()
      if (record.session === value.session) invalid()
    }
    state.records.add({
      link: value.link,
      direction: value.direction,
      session: value.session,
      phase: 'LIVE',
      active: true,
      timer: null
    })
    CIRCUIT_DIRECTION_CAPABILITIES.delete(capability)
    return true
  }

  fail(link, direction) {
    const state = teardownState(this)
    if (!isObject(link) || !knownDirection(direction)) invalid()
    teardownNow(state)
    let matched = false
    for (const record of state.records) {
      if (record.link !== link || record.direction !== direction || record.phase !== 'LIVE')
        continue
      matched = true
      record.phase = 'DESTROYING'
      armCircuitTeardown(state, record)
      let destroying
      try {
        destroying = destroyAsyncRouteControlSession(
          record.session,
          CIRCUIT_DESTROY_REASON.TRANSPORT_LOST
        )
      } catch {
        removeTeardownRecord(state, record, true)
        continue
      }
      Promise.resolve(destroying).then(
        () => removeTeardownRecord(state, record, false),
        () => removeTeardownRecord(state, record, true)
      )
    }
    return matched
  }

  close() {
    const state = CIRCUIT_TEARDOWNS.get(this)
    if (!state) return Promise.resolve(true)
    if (state.closePromise) return state.closePromise
    state.closed = true
    for (const record of Array.from(state.records)) removeTeardownRecord(state, record, true)
    state.closePromise = Promise.allSettled(Array.from(state.cleanups)).then(() => true)
    return state.closePromise
  }
}

function readNow(state) {
  let current
  try {
    current = state.now()
  } catch {
    throw unavailable()
  }
  if (!Number.isSafeInteger(current) || current < 0 || current < state.lastNow) throw unavailable()
  if (state.closed) throw unavailable()
  state.lastNow = current
  return current
}

function cancelSlot(state, slot) {
  if (state[slot] === null) return
  const timer = state[slot]
  state[slot] = null
  try {
    state.cancel(timer)
  } catch {
    throw unavailable()
  }
}

function clearStreams(state) {
  for (const space of state.streams.values()) space.records.length = 0
  state.streams.clear()
  state.inboundStreams.clear()
  state.pendingStreams = 0
  state.pendingBytes = 0
}

function destroyConsumer(consumer) {
  const state = CONSUMERS.get(consumer)
  if (!state || state.destroyed) return
  state.destroyed = true
  for (const event of state.events) {
    const record = EVENTS.get(event)
    if (record) clear(record.value.payload)
    EVENTS.delete(event)
  }
  state.events.clear()
  clear(state.circuitId)
  CONSUMERS.delete(consumer)
}

function closeState(state, reason = 'ROUTE_UNAVAILABLE') {
  if (state.closed) return false
  state.closed = true
  state.reason = reason

  try {
    state.cancelPending()
  } catch {}
  for (const direction of [DIRECTION.FORWARD, DIRECTION.REVERSE]) {
    try {
      state.notifyCircuit(direction, reason)
    } catch {}
  }
  try {
    cancelSlot(state, 'livenessTimer')
  } catch {}
  try {
    cancelSlot(state, 'ackTimer')
  } catch {}
  clear(state.challenge)
  state.challenge = null
  clearStreams(state)
  for (const record of state.sendRecords) {
    record.active = false
    clear(record.payload)
    record.payload = null
  }
  state.sendRecords.clear()
  destroyConsumer(state.control)
  try {
    state.closeLink(reason)
  } catch {}
  clear(state.circuitId)
  return true
}

function armTimer(state, slot, delay, operation) {
  if (state.closed) return
  let arming = true
  let synchronous = false
  let fired = false
  let timer
  const callback = () => {
    if (arming) {
      synchronous = true
      return
    }
    if (fired) {
      closeState(state)
      return
    }
    fired = true
    if (state[slot] !== timer || state.closed) return
    state[slot] = null
    try {
      operation()
    } catch {
      closeState(state)
    }
  }
  try {
    timer = state.schedule(callback, delay)
  } catch {
    arming = false
    throw unavailable()
  }
  arming = false
  if (synchronous || state.closed) {
    try {
      state.cancel(timer)
    } catch {}
    throw unavailable()
  }
  state[slot] = timer
}

function scheduleLiveness(state) {
  if (state.closed) return
  const current = readNow(state)
  const closeAt = state.lastActivity + LINK_UNRESPONSIVE_AFTER
  const dueAt = Math.min(state.nextPingAt, closeAt)
  armTimer(state, 'livenessTimer', Math.max(0, dueAt - current), () => runLiveness(state))
}

function sendPayload(state, payload) {
  if (state.closed) {
    clear(payload)
    throw unavailable()
  }
  if (state.sendRecords.size >= state.maxControlSends) {
    clear(payload)
    closeState(state, 'CIRCUIT_LIMIT')
    throw unavailable()
  }
  const record = { payload, active: true }
  state.sendRecords.add(record)
  let sending
  try {
    sending = state.sendControl(payload)
  } catch {
    state.sendRecords.delete(record)
    record.active = false
    clear(payload)
    closeState(state)
    throw unavailable()
  }
  Promise.resolve(sending).then(
    (sent) => {
      if (!record.active) return
      record.active = false
      state.sendRecords.delete(record)
      clear(record.payload)
      record.payload = null
      if (sent !== true && !state.closed) closeState(state)
    },
    () => {
      if (!record.active) return
      record.active = false
      state.sendRecords.delete(record)
      clear(record.payload)
      record.payload = null
      if (!state.closed) closeState(state)
    }
  )
  return true
}

function sendLink(state, value) {
  let payload = null
  try {
    payload = state.mux.encodeLink(value, {
      class: CELL_CLASS.CONTROL,
      direction: value.direction,
      circuitId: state.circuitId
    })
    return sendPayload(state, payload)
  } catch {
    clear(payload)
    closeState(state)
    throw unavailable()
  }
}

function sendPing(state) {
  let challenge = null
  try {
    challenge = state.randomBytes(16)
    if (state.closed) throw unavailable()
    if (!fixed(challenge, 16) || allZero(challenge)) throw unavailable()
    clear(state.challenge)
    state.challenge = b4a.from(challenge)
    state.nextPingAt = state.lastNow + LINK_PING_AFTER
    sendLink(state, {
      version: PROTOCOL_VERSION,
      kind: LINK_CONTROL_KIND.LINK_PING,
      flags: 0,
      direction: state.heartbeatDirection,
      circuitId: state.circuitId,
      generation: 0n,
      challenge
    })
  } catch {
    closeState(state)
  } finally {
    clear(challenge)
  }
}

function runLiveness(state) {
  if (state.closed) return
  const current = readNow(state)
  const idle = current - state.lastActivity
  if (idle >= LINK_UNRESPONSIVE_AFTER) {
    closeState(state)
    return
  }
  if (current >= state.nextPingAt) sendPing(state)
  if (!state.closed) scheduleLiveness(state)
}

function streamKey(direction, generation) {
  return `${direction}:${generation}`
}

function oldestStream(state) {
  let oldest = null
  for (const space of state.streams.values()) {
    const record = space.records[0]
    if (record && (!oldest || record.deadline < oldest.deadline)) oldest = record
  }
  return oldest
}

function enforceDeadlines(state, current) {
  if (current - state.lastActivity >= LINK_UNRESPONSIVE_AFTER) {
    closeState(state)
    throw unavailable()
  }
  const oldest = oldestStream(state)
  if (oldest && current >= oldest.deadline) {
    closeState(state, 'ACK_TIMEOUT')
    throw unavailable()
  }
}

function scheduleAck(state) {
  if (state.closed) return
  cancelSlot(state, 'ackTimer')
  const oldest = oldestStream(state)
  if (!oldest) return
  const current = readNow(state)
  armTimer(state, 'ackTimer', Math.max(0, oldest.deadline - current), () => {
    const now = readNow(state)
    const next = oldestStream(state)
    if (!next) return
    if (now >= next.deadline) closeState(state, 'ACK_TIMEOUT')
    else scheduleAck(state)
  })
}

function acknowledge(state, message) {
  const key = streamKey(message.acknowledgedDirection, message.generation)
  const space = state.streams.get(key)
  if (!space || (space.highestAck !== null && message.counter <= space.highestAck))
    throw unavailable()
  if (space.highestSent === null || message.counter > space.highestSent) throw unavailable()
  if (!space.records.some((record) => record.counter === message.counter)) throw unavailable()
  let released = 0
  while (space.records.length > 0 && space.records[0].counter <= message.counter) {
    const record = space.records.shift()
    state.pendingStreams--
    state.pendingBytes -= record.bytes
    released++
  }
  if (released === 0) throw unavailable()
  space.highestAck = message.counter
  scheduleAck(state)
}

function receiveLink(state, message) {
  if (message.kind === LINK_CONTROL_KIND.LINK_PING) {
    return sendLink(state, {
      version: PROTOCOL_VERSION,
      kind: LINK_CONTROL_KIND.LINK_PONG,
      flags: 0,
      direction: opposite(message.direction),
      circuitId: state.circuitId,
      generation: 0n,
      challenge: message.challenge
    })
  }
  if (message.kind === LINK_CONTROL_KIND.LINK_PONG) {
    if (
      !state.challenge ||
      message.direction !== opposite(state.heartbeatDirection) ||
      !same(message.challenge, state.challenge)
    ) {
      throw unavailable()
    }
    clear(state.challenge)
    state.challenge = null
    return true
  }
  acknowledge(state, message)
  return true
}

function readEvent(event, consumer) {
  const consumerState = CONSUMERS.get(consumer)
  const eventState = isObject(event) ? EVENTS.get(event) : null
  if (!consumerState || !eventState || eventState.consumer !== consumer || eventState.consumed)
    invalid()
  eventState.consumed = true
  EVENTS.delete(event)
  consumerState.events.delete(event)
  return eventState.value
}

export function createLinkControlBoundary(options = {}) {
  if (!isObject(options)) invalid()
  const { link, epoch, circuitId } = options
  if (!isObject(link) || !u64(epoch) || !fixed(circuitId, 16) || allZero(circuitId)) invalid()
  const expectedCircuitId = b4a.from(circuitId)
  const consumer = Object.freeze({})
  const state = {
    link,
    epoch,
    circuitId: expectedCircuitId,
    events: new Set(),
    session: null,
    destroyed: false
  }
  CONSUMERS.set(consumer, state)

  return Object.freeze({
    consumer,
    pushAuthenticated(value) {
      if (state.destroyed || !isObject(value)) invalid()
      const generation = value.generation
      const counter = value.counter
      const payload = value.payload
      const deliver = value.deliver === undefined ? true : value.deliver
      if (
        value.link !== link ||
        value.epoch !== epoch ||
        !same(value.circuitId, expectedCircuitId) ||
        !knownClass(value.class) ||
        !knownDirection(value.direction) ||
        !u64(generation) ||
        (value.class !== CELL_CLASS.CONTROL && !u64(generation, true)) ||
        !u64(counter) ||
        typeof deliver !== 'boolean' ||
        !b4a.isBuffer(payload) ||
        payload.byteLength > MAX_EVENT_PAYLOAD ||
        state.events.size >= DEFAULT_MAX_AUTHENTICATED_EVENTS
      ) {
        invalid()
      }
      const event = Object.freeze({})
      EVENTS.set(event, {
        consumer,
        consumed: false,
        value: {
          class: value.class,
          direction: value.direction,
          generation,
          counter,
          deliver,
          payload: b4a.from(payload)
        }
      })
      state.events.add(event)
      return event
    },
    destroy() {
      destroyConsumer(consumer)
    }
  })
}

export class LinkControlSession {
  constructor(options = {}) {
    if (!isObject(options)) invalid()
    const {
      control,
      circuitId,
      epoch,
      heartbeatDirection,
      now,
      schedule,
      cancel,
      randomBytes,
      sendControl,
      cancelPending,
      notifyCircuit,
      closeLink
    } = options
    if (
      !CONSUMERS.has(control) ||
      !fixed(circuitId, 16) ||
      allZero(circuitId) ||
      !u64(epoch) ||
      !knownDirection(heartbeatDirection) ||
      typeof now !== 'function' ||
      typeof schedule !== 'function' ||
      typeof cancel !== 'function' ||
      typeof randomBytes !== 'function' ||
      typeof sendControl !== 'function' ||
      typeof cancelPending !== 'function' ||
      typeof notifyCircuit !== 'function' ||
      typeof closeLink !== 'function'
    ) {
      invalid()
    }
    const authority = CONSUMERS.get(control)
    if (authority.epoch !== epoch || !same(authority.circuitId, circuitId)) invalid()
    if (authority.session !== null) throw PrivateRouteError.CIRCUIT_STATE()
    const state = {
      control,
      circuitId: b4a.from(circuitId),
      epoch,
      heartbeatDirection,
      now,
      schedule,
      cancel,
      randomBytes,
      sendControl,
      cancelPending,
      notifyCircuit,
      closeLink,
      maxPendingStreams: bound(options.maxPendingStreams, DEFAULT_MAX_UNACKNOWLEDGED_STREAMS),
      maxPendingBytes: bound(options.maxPendingBytes, DEFAULT_MAX_UNACKNOWLEDGED_BYTES),
      maxStreamSpaces: bound(options.maxStreamSpaces, DEFAULT_MAX_STREAM_SPACES),
      maxControlSends: bound(options.maxControlSends, DEFAULT_MAX_CONTROL_SENDS),
      mux: new RemoteControlMux(),
      streams: new Map(),
      inboundStreams: new Map(),
      lastNow: -1,
      lastActivity: 0,
      nextPingAt: 0,
      livenessTimer: null,
      ackTimer: null,
      challenge: null,
      sendRecords: new Set(),
      pendingStreams: 0,
      pendingBytes: 0,
      closed: false,
      reason: null
    }
    authority.session = this
    SESSIONS.set(this, state)
    try {
      state.lastActivity = readNow(state)
      state.nextPingAt = state.lastActivity + LINK_PING_AFTER
      if (state.nextPingAt > Number.MAX_SAFE_INTEGER) throw unavailable()
      scheduleLiveness(state)
    } catch {
      closeState(state)
      throw unavailable()
    }
  }

  get closed() {
    return SESSIONS.get(this).closed
  }

  get pendingStreams() {
    return SESSIONS.get(this).pendingStreams
  }

  get pendingBytes() {
    return SESSIONS.get(this).pendingBytes
  }

  get pendingSends() {
    return SESSIONS.get(this).sendRecords.size
  }

  trackStream(direction, generation, counter, bytes) {
    const state = SESSIONS.get(this)
    if (state.closed) throw unavailable()
    try {
      if (
        !knownDirection(direction) ||
        !u64(generation, true) ||
        !u64(counter) ||
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        bytes > MAX_EVENT_PAYLOAD
      ) {
        invalid()
      }
      const key = streamKey(direction, generation)
      let space = state.streams.get(key)
      if (!space) {
        if (counter !== 0n) throw PrivateRouteError.COUNTER_GAP()
        if (state.streams.size >= state.maxStreamSpaces) throw PrivateRouteError.CIRCUIT_LIMIT()
        space = {
          direction,
          generation,
          nextCounter: 0n,
          highestSent: null,
          highestAck: null,
          records: []
        }
        state.streams.set(key, space)
      }
      if (counter < space.nextCounter) throw PrivateRouteError.REPLAY()
      if (counter !== space.nextCounter) throw PrivateRouteError.COUNTER_GAP()
      if (
        state.pendingStreams >= state.maxPendingStreams ||
        state.pendingBytes + bytes > state.maxPendingBytes
      ) {
        throw PrivateRouteError.CIRCUIT_LIMIT()
      }
      const current = readNow(state)
      enforceDeadlines(state, current)
      if (current > Number.MAX_SAFE_INTEGER - STREAM_ACK_TIMEOUT) throw unavailable()
      space.records.push({ counter, bytes, deadline: current + STREAM_ACK_TIMEOUT })
      space.highestSent = counter
      space.nextCounter = counter + 1n
      state.pendingStreams++
      state.pendingBytes += bytes
      scheduleAck(state)
      if (state.closed) throw unavailable()
      return true
    } catch (err) {
      closeState(state, err && err.code === 'CIRCUIT_LIMIT' ? 'CIRCUIT_LIMIT' : 'ROUTE_UNAVAILABLE')
      throw err instanceof PrivateRouteError ? err : unavailable()
    }
  }

  receiveAuthenticated(event, handlers = {}) {
    const state = SESSIONS.get(this)
    if (state.closed || !isObject(handlers)) throw unavailable()
    let value = null
    let decoded = null
    try {
      value = readEvent(event, state.control)
      const current = readNow(state)
      enforceDeadlines(state, current)
      if (!value.deliver) return true
      state.lastActivity = current
      state.nextPingAt = current + LINK_PING_AFTER
      if (state.nextPingAt > Number.MAX_SAFE_INTEGER) throw unavailable()
      cancelSlot(state, 'livenessTimer')
      if (state.closed) throw unavailable()
      scheduleLiveness(state)
      if (state.closed) throw unavailable()

      if (value.class === CELL_CLASS.CONTROL) {
        decoded = state.mux.decode(value.payload, {
          class: CELL_CLASS.CONTROL,
          direction: value.direction,
          circuitId: state.circuitId
        })
        if (decoded.namespace === CONTROL_NAMESPACE.LINK) return receiveLink(state, decoded.message)
        if (typeof handlers.dispatchActor !== 'function') invalid()
        const dispatched = handlers.dispatchActor(decoded.fragment, {
          direction: value.direction,
          generation: value.generation,
          counter: value.counter
        })
        if (state.closed) throw unavailable()
        return dispatched === true
      }
      if (value.class === CELL_CLASS.STREAM) {
        if (typeof handlers.enqueueStream !== 'function') invalid()
        const key = streamKey(value.direction, value.generation)
        let inbound = state.inboundStreams.get(key)
        if (!inbound) {
          if (state.inboundStreams.size >= state.maxStreamSpaces) {
            throw PrivateRouteError.CIRCUIT_LIMIT()
          }
          if (value.counter !== 0n) throw PrivateRouteError.COUNTER_GAP()
          inbound = { nextCounter: 0n, blocked: false }
          state.inboundStreams.set(key, inbound)
        }
        if (value.counter < inbound.nextCounter) throw PrivateRouteError.REPLAY()
        if (value.counter !== inbound.nextCounter) throw PrivateRouteError.COUNTER_GAP()
        inbound.nextCounter++
        if (inbound.blocked) return false
        let owned = b4a.from(value.payload)
        let accepted = false
        try {
          accepted =
            handlers.enqueueStream(owned, {
              class: CELL_CLASS.STREAM,
              direction: value.direction,
              generation: value.generation,
              counter: value.counter
            }) === true
          if (state.closed) throw unavailable()
          if (accepted) owned = null
        } finally {
          clear(owned)
        }
        if (!accepted) {
          inbound.blocked = true
          return false
        }
        sendLink(state, {
          version: PROTOCOL_VERSION,
          kind: LINK_CONTROL_KIND.STREAM_ACK,
          flags: 0,
          direction: opposite(value.direction),
          circuitId: state.circuitId,
          generation: value.generation,
          acknowledgedDirection: value.direction,
          counter: value.counter
        })
        return true
      }
      if (typeof handlers.enqueueDatagram !== 'function') invalid()
      let owned = b4a.from(value.payload)
      let accepted = false
      try {
        accepted =
          handlers.enqueueDatagram(owned, {
            class: CELL_CLASS.DATAGRAM,
            direction: value.direction,
            generation: value.generation,
            counter: value.counter
          }) === true
        if (state.closed) throw unavailable()
        if (accepted) owned = null
        return accepted
      } finally {
        clear(owned)
      }
    } catch (err) {
      closeState(state)
      throw err instanceof PrivateRouteError ? err : unavailable()
    } finally {
      if (decoded && decoded.message) {
        clear(decoded.message.circuitId)
        clear(decoded.message.challenge)
      }
      if (decoded && decoded.fragment) clear(decoded.fragment)
      if (value) clear(value.payload)
    }
  }

  close(reason = 'ROUTE_UNAVAILABLE') {
    return closeState(SESSIONS.get(this), reason)
  }
}

// Package-internal provenance read for CompiledRouteDuplex. Aggregate link
// counters cannot prove a generation-scoped drain.
export function readLinkControlStreamProgress(session, direction, generation) {
  const state = SESSIONS.get(session)
  if (!state || state.closed || !knownDirection(direction) || !u64(generation, true)) invalid()
  const space = state.streams.get(streamKey(direction, generation))
  if (!space) {
    return Object.freeze({
      highestSent: null,
      highestAck: null,
      pendingStreams: 0,
      pendingBytes: 0
    })
  }
  let pendingBytes = 0
  for (const record of space.records) pendingBytes += record.bytes
  return Object.freeze({
    highestSent: space.highestSent,
    highestAck: space.highestAck,
    pendingStreams: space.records.length,
    pendingBytes
  })
}
