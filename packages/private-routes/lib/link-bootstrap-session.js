import b4a from 'b4a'

import {
  BOOTSTRAP_DEADLINE,
  BootstrapEnvelopeCodec,
  BootstrapRequestTable,
  isBootstrapEnvelopeCodecForLink
} from './bootstrap-envelope.js'
import { PrivateRouteError } from './errors.js'
import { destroyEstablishedLinkState, isLinkTicketChecker } from './link-setup.js'
import { BOOTSTRAP_TYPE } from './protocol.js'
import { readLinkHandle } from './topology-grant.js'
import { UDX_LINK_CLOSE, UDX_LINK_OPEN, UDX_SEND_DISPATCH } from './udx-adapter.js'

const SESSIONS = new WeakMap()
const ESTABLISHED = new WeakMap()
const MODES = new Set(['initiate', 'accept'])
const MAX_TIMER_DELAY = 0x7fff_ffff
const RETRY_INTERVAL = 250
const ZERO_DIGEST = b4a.alloc(32)
export const LINK_BOOTSTRAP_SESSION_INVALIDATE = Symbol('link-bootstrap-session-invalidate')

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
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function copy(value) {
  return b4a.isBuffer(value) ? b4a.from(value) : value
}

function clearRequest(state) {
  if (!state.request) return
  deepClear(state.request)
  state.request = null
}

function deepClear(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (b4a.isBuffer(value)) {
    try {
      b4a.fill(value, 0)
    } catch {}
    return
  }
  for (const item of Object.values(value)) deepClear(item, seen)
}

function currentTime(state) {
  let value
  try {
    value = state.now()
  } catch {
    throw unavailable()
  }
  if (!Number.isSafeInteger(value) || value < 0 || value < state.lastNow) throw unavailable()
  state.lastNow = value
  return value
}

function cancelTimer(state) {
  if (state.timer === null) return
  const timer = state.timer
  state.timer = null
  try {
    state.cancel(timer)
  } catch {
    throw unavailable()
  }
}

function detachAbort(state) {
  const signal = state.signal
  const abort = state.abort
  state.signal = null
  state.abort = null
  if (!signal || !abort) return true
  try {
    signal.removeEventListener('abort', abort)
    return true
  } catch {
    return false
  }
}

function closeSendHandle(state) {
  if (!state.endpoint || !state.sendHandle) return
  try {
    state.endpoint[UDX_LINK_CLOSE](state.sendHandle)
  } catch {}
}

function refreshAuthority(state) {
  if (state.state === 'TOMBSTONE' || state.closed || !state.linkHandle) return
  try {
    readLinkHandle(state.linkHandle)
  } catch {
    state.session[LINK_BOOTSTRAP_SESSION_INVALIDATE]()
  }
}

function armTimer(state) {
  const current = currentTime(state)
  const remaining = state.deadlineAt - current
  const delay = Math.min(
    MAX_TIMER_DELAY,
    state.mode === 'initiate' ? RETRY_INTERVAL : MAX_TIMER_DELAY,
    Math.max(0, remaining)
  )
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
      fail(state, unavailable(), true)
      return
    }
    fired = true
    state.timer = null
    if (state.state !== 'CREATING') return
    try {
      if (currentTime(state) < state.deadlineAt) {
        armTimer(state)
        dispatchCreate(state)
      } else fail(state, unavailable(), true)
    } catch {
      fail(state, unavailable(), true)
    }
  }
  try {
    timer = state.schedule(callback, delay)
  } catch {
    arming = false
    throw unavailable()
  }
  arming = false
  if (synchronous || state.state !== 'CREATING') {
    try {
      state.cancel(timer)
    } catch {}
    throw unavailable()
  }
  state.timer = timer
}

function dispatchCreate(state) {
  if (
    state.mode !== 'initiate' ||
    state.state !== 'CREATING' ||
    state.sendPending ||
    !state.request
  ) {
    return false
  }
  state.sendPending = true
  try {
    state.endpoint
      .send(state.sendHandle, state.request.packet, {
        signal: state.signal || undefined,
        [UDX_SEND_DISPATCH]: () => {
          state.dispatched = true
        }
      })
      .then(
        () => {
          state.sendPending = false
          if (state.state !== 'CREATING') return
          state.createSent = true
          if (state.signal && state.signal.aborted) return fail(state, unavailable(), true)
          if (state.stagedReject) return fail(state, unavailable(), false)
          if (!state.stagedTicket) return
          const ticket = state.stagedTicket
          state.stagedTicket = null
          try {
            const established = install(state, ticket)
            finishOpen(state, established)
          } catch {
            try {
              state.linkSetup.revoke(ticket)
            } catch {}
            fail(state, unavailable(), false)
          }
        },
        () => {
          state.sendPending = false
          if (state.state === 'CREATING') fail(state, unavailable(), false)
        }
      )
  } catch {
    state.sendPending = false
    fail(state, unavailable(), false)
    return false
  }
  return true
}

function install(state, ticket) {
  let linkState
  try {
    linkState = state.linkSetup.checker.take(ticket)
    state.endpoint[UDX_LINK_OPEN](state.sendHandle, {
      linkState,
      mode: state.mode,
      now: state.now,
      schedule: state.schedule,
      cancel: state.cancel,
      randomBytes: state.randomBytes
    })
  } catch {
    destroyEstablishedLinkState(linkState)
    throw unavailable()
  }
  const established = Object.freeze({})
  ESTABLISHED.set(established, { linkState, state })
  state.established = established
  state.state = 'OPEN'
  return established
}

function clearEstablished(state) {
  if (!state.established) return
  const record = ESTABLISHED.get(state.established)
  ESTABLISHED.delete(state.established)
  if (record) destroyEstablishedLinkState(record.linkState)
  state.established = null
}

function finishOpen(state, established) {
  try {
    cancelTimer(state)
  } catch {
    clearEstablished(state)
    fail(state, unavailable(), false)
    return
  }
  state.pending = 0
  state.sendPending = false
  state.pendingSetup = null
  clearRequest(state)
  deepClear(state.setup)
  state.setup = null
  if (!detachAbort(state)) {
    clearEstablished(state)
    fail(state, unavailable(), false)
    return
  }
  const resolve = state.resolve
  state.resolve = null
  state.reject = null
  if (resolve) resolve(established)
}

function sendCancel(state) {
  if (!state.request || !state.dispatched || state.closed) return null
  let packet
  try {
    packet = state.codec.encode({
      type: BOOTSTRAP_TYPE.LINK_CANCEL,
      requestId: state.request.requestId,
      epoch: state.link.epoch,
      rejectedType: BOOTSTRAP_TYPE.LINK_CREATE,
      requestPacket: state.request.packet
    })
    const sending = state.endpoint.send(state.sendHandle, packet).catch(() => {})
    state.cancelSends.add(sending)
    void sending.finally(() => state.cancelSends.delete(sending))
    return sending
  } catch {
    // Cancellation remains local if the authenticated peer notification cannot be sent.
    return null
  } finally {
    if (packet) b4a.fill(packet, 0)
  }
}

function fail(state, error, notify) {
  if (state.state === 'TOMBSTONE') return
  const cancelling = notify ? sendCancel(state) : null
  try {
    cancelTimer(state)
  } catch {}
  if (state.request) {
    try {
      state.table.cancel(state.request.token)
    } catch {}
  }
  if (state.pendingSetup) {
    try {
      state.linkSetup.abort(state.pendingSetup)
    } catch {}
  }
  if (state.responderTicket) {
    try {
      state.linkSetup.revoke(state.responderTicket)
    } catch {}
  }
  if (state.stagedTicket) {
    try {
      state.linkSetup.revoke(state.stagedTicket)
    } catch {}
  }
  state.pendingSetup = null
  state.responderTicket = null
  state.stagedTicket = null
  state.stagedReject = false
  clearRequest(state)
  state.pending = 0
  state.sendPending = false
  deepClear(state.setup)
  state.setup = null
  clearEstablished(state)
  state.state = 'TOMBSTONE'
  const reject = state.reject
  state.resolve = null
  state.reject = null
  detachAbort(state)
  if (reject) reject(error instanceof PrivateRouteError ? error : unavailable())
  if (cancelling) void cancelling.finally(() => closeSendHandle(state))
  else closeSendHandle(state)
}

function acceptCreated(state, packet, decoded) {
  if (state.state !== 'CREATING' || !state.pendingSetup) return
  if (decoded.type === BOOTSTRAP_TYPE.LINK_REJECT) {
    if (state.createSent) fail(state, unavailable(), false)
    else state.stagedReject = true
    return
  }
  let ticket
  try {
    ticket = state.linkSetup.complete(state.pendingSetup, decoded.body)
    state.pendingSetup = null
    if (state.createSent) {
      const established = install(state, ticket)
      finishOpen(state, established)
    } else {
      state.stagedTicket = ticket
      ticket = null
    }
  } catch {
    if (ticket) {
      try {
        state.linkSetup.revoke(ticket)
      } catch {}
    }
    fail(state, unavailable(), false)
  } finally {
    if (b4a.isBuffer(packet)) b4a.fill(packet, 0)
  }
}

function responderPacket(state, decoded, requestPacket) {
  let accepted
  try {
    accepted = state.linkSetup.respond(decoded.body, state.setup)
    deepClear(state.setup)
    state.setup = null
    state.responderTicket = accepted.ticket
    const packet = state.codec.encode({
      type: BOOTSTRAP_TYPE.LINK_CREATED,
      requestId: decoded.requestId,
      epoch: decoded.epoch,
      body: accepted.message,
      requestPacket
    })
    return { packet }
  } catch (err) {
    if (accepted && accepted.ticket) {
      try {
        state.linkSetup.revoke(accepted.ticket)
      } catch {}
    }
    state.responderTicket = null
    throw err
  } finally {
    if (accepted) deepClear(accepted.message)
  }
}

export class LinkBootstrapSession {
  constructor(options = {}) {
    if (!isObject(options)) invalid()
    const {
      mode,
      endpoint,
      sendHandle,
      linkHandle,
      codec,
      linkSetup,
      setup,
      now,
      schedule,
      cancel,
      randomBytes
    } = options
    if (
      !MODES.has(mode) ||
      !endpoint ||
      typeof endpoint.send !== 'function' ||
      !isObject(sendHandle) ||
      !(codec instanceof BootstrapEnvelopeCodec) ||
      !linkSetup ||
      typeof linkSetup.initiate !== 'function' ||
      typeof linkSetup.respond !== 'function' ||
      typeof linkSetup.complete !== 'function' ||
      typeof linkSetup.abort !== 'function' ||
      typeof linkSetup.revoke !== 'function' ||
      !isLinkTicketChecker(linkSetup.checker) ||
      !isObject(setup) ||
      typeof now !== 'function' ||
      typeof schedule !== 'function' ||
      typeof cancel !== 'function' ||
      typeof randomBytes !== 'function'
    ) {
      invalid()
    }
    if (!isBootstrapEnvelopeCodecForLink(codec, linkHandle)) {
      throw PrivateRouteError.UNAUTHORIZED()
    }
    let link
    try {
      link = readLinkHandle(linkHandle)
    } catch {
      throw PrivateRouteError.UNAUTHORIZED()
    }
    const state = {
      session: this,
      mode,
      endpoint,
      sendHandle,
      linkHandle,
      codec,
      linkSetup,
      setup: Object.fromEntries(Object.entries(setup).map(([key, value]) => [key, copy(value)])),
      link,
      now,
      schedule,
      cancel,
      randomBytes,
      table: new BootstrapRequestTable({ now, schedule, cancel, randomBytes }),
      state: 'IDLE',
      pending: 0,
      sendPending: false,
      pendingSetup: null,
      responderTicket: null,
      stagedTicket: null,
      stagedReject: false,
      createSent: false,
      established: null,
      request: null,
      dispatched: false,
      deadlineAt: 0,
      timer: null,
      cancelSends: new Set(),
      lastNow: -1,
      signal: null,
      abort: null,
      resolve: null,
      reject: null,
      closed: false,
      closePromise: null
    }
    SESSIONS.set(this, state)
  }

  get state() {
    const state = SESSIONS.get(this)
    refreshAuthority(state)
    return state.state
  }

  get pending() {
    const state = SESSIONS.get(this)
    refreshAuthority(state)
    return state.pending
  }

  get established() {
    const state = SESSIONS.get(this)
    refreshAuthority(state)
    return state.established
  }

  open(options = {}) {
    const state = SESSIONS.get(this)
    if (!isObject(options)) return Promise.reject(PrivateRouteError.INVALID_ROUTE())
    if (state.mode !== 'initiate' || state.state !== 'IDLE' || state.closed) {
      return Promise.reject(stateError())
    }
    const signal = options.signal
    if (
      signal !== undefined &&
      (!isObject(signal) ||
        typeof signal.addEventListener !== 'function' ||
        typeof signal.removeEventListener !== 'function')
    ) {
      return Promise.reject(PrivateRouteError.INVALID_ROUTE())
    }
    if (signal && signal.aborted) {
      deepClear(state.setup)
      state.setup = null
      state.state = 'TOMBSTONE'
      closeSendHandle(state)
      return Promise.reject(unavailable())
    }
    state.state = 'CREATING'
    state.pending = 1
    state.signal = signal || null
    let started = null
    const promise = new Promise((resolve, reject) => {
      state.resolve = resolve
      state.reject = reject
    })
    try {
      const startedAt = currentTime(state)
      if (startedAt > Number.MAX_SAFE_INTEGER - BOOTSTRAP_DEADLINE) throw unavailable()
      state.deadlineAt = startedAt + BOOTSTRAP_DEADLINE
      started = state.linkSetup.initiate(state.setup)
      state.pendingSetup = started.pending
      const request = state.table.begin({
        peerIdentity32: state.link.peerIdentity32,
        epoch: state.link.epoch,
        encode: (requestId) =>
          state.codec.encode({
            type: BOOTSTRAP_TYPE.LINK_CREATE,
            requestId,
            epoch: state.link.epoch,
            body: started.message,
            requestDigest32: ZERO_DIGEST
          }),
        onResponse: (packet, decoded) => acceptCreated(state, packet, decoded)
      })
      state.request = request
      state.abort = () => fail(state, unavailable(), true)
      if (signal) {
        try {
          signal.addEventListener('abort', state.abort, { once: true })
        } catch {
          throw unavailable()
        }
        if (state.state !== 'CREATING' || signal.aborted) {
          if (state.state === 'CREATING') fail(state, unavailable(), true)
          throw unavailable()
        }
      }
      armTimer(state)
      dispatchCreate(state)
    } catch {
      fail(state, unavailable(), false)
    } finally {
      if (started) deepClear(started.message)
    }
    return promise
  }

  async receive(packet) {
    const state = SESSIONS.get(this)
    if (state.closed || state.state === 'TOMBSTONE') return false
    const source = { host: state.link.peerAddress.host, port: state.link.peerAddress.port }
    let decoded = null
    try {
      decoded = state.codec.receive(packet, source)
      if (!decoded) return false
      if (
        decoded.type === BOOTSTRAP_TYPE.LINK_CREATED ||
        decoded.type === BOOTSTRAP_TYPE.LINK_REJECT
      ) {
        if (state.mode !== 'initiate') return false
        return state.table.acceptResponse(state.link.peerIdentity32, decoded, packet)
      }
      if (decoded.type === BOOTSTRAP_TYPE.LINK_CANCEL) {
        if (state.mode !== 'accept' || state.state === 'OPEN') return false
        const accepted = state.table.acceptCancel(state.link.peerIdentity32, decoded)
        if (accepted && state.state === 'CREATING') fail(state, unavailable(), false)
        return accepted
      }
      if (decoded.type !== BOOTSTRAP_TYPE.LINK_CREATE || state.mode !== 'accept') return false
      if (state.state === 'IDLE') {
        state.state = 'CREATING'
        state.pending = 1
        const startedAt = currentTime(state)
        if (startedAt > Number.MAX_SAFE_INTEGER - BOOTSTRAP_DEADLINE) throw unavailable()
        state.deadlineAt = startedAt + BOOTSTRAP_DEADLINE
        armTimer(state)
      }
      let response
      response = state.table.respond(state.link.peerIdentity32, decoded, packet, () =>
        responderPacket(state, decoded, packet)
      )
      try {
        await state.endpoint.send(state.sendHandle, response)
        if (state.state === 'CREATING' && state.responderTicket) {
          const ticket = state.responderTicket
          state.responderTicket = null
          const established = install(state, ticket)
          finishOpen(state, established)
          return established
        }
        return true
      } finally {
        if (response) b4a.fill(response, 0)
      }
    } catch {
      fail(state, unavailable(), false)
      return false
    } finally {
      deepClear(decoded)
    }
  }

  close() {
    const state = SESSIONS.get(this)
    if (state.closePromise) return state.closePromise
    state.closePromise = (async () => {
      if (state.state === 'CREATING') fail(state, unavailable(), true)
      else {
        try {
          cancelTimer(state)
        } catch {}
        clearEstablished(state)
        state.state = 'TOMBSTONE'
      }
      state.closed = true
      await Promise.allSettled(Array.from(state.cancelSends))
      closeSendHandle(state)
      try {
        state.table.destroy()
      } catch {}
      try {
        state.codec.destroy()
      } catch {}
      deepClear(state.setup)
      state.setup = null
      deepClear(state.link)
      state.link = null
      state.linkHandle = null
      state.endpoint = null
      state.sendHandle = null
      state.linkSetup = null
      state.now = null
      state.schedule = null
      state.cancel = null
    })()
    return state.closePromise
  }

  [LINK_BOOTSTRAP_SESSION_INVALIDATE]() {
    const state = SESSIONS.get(this)
    if (!state.closed && state.state !== 'TOMBSTONE') fail(state, unavailable(), false)
    state.closed = true
    try {
      state.table.destroy()
    } catch {}
    try {
      state.codec.destroy()
    } catch {}
    deepClear(state.setup)
    state.setup = null
    deepClear(state.link)
    state.link = null
    state.linkHandle = null
    state.session = null
    state.endpoint = null
    state.sendHandle = null
    state.codec = null
    state.table = null
    state.linkSetup = null
    state.now = null
    state.schedule = null
    state.cancel = null
    state.randomBytes = null
    state.cancelSends.clear()
    if (!state.closePromise) state.closePromise = Promise.resolve()
  }
}

export function readEstablishedLink(value) {
  const record = isObject(value) ? ESTABLISHED.get(value) : null
  if (!record) throw PrivateRouteError.UNAUTHORIZED()
  try {
    readLinkHandle(record.state.linkHandle)
  } catch {
    const session = record.state.session
    if (session) session[LINK_BOOTSTRAP_SESSION_INVALIDATE]()
    throw PrivateRouteError.UNAUTHORIZED()
  }
  return record.linkState
}
