import b4a from 'b4a'

import { BOOTSTRAP_CLASS, BOOTSTRAP_SIZE } from './bootstrap-envelope.js'
import { PrivateRouteError } from './errors.js'
import {
  LINK_BOOTSTRAP_SESSION_INVALIDATE,
  LinkBootstrapSession
} from './link-bootstrap-session.js'
import { readLinkHandle } from './topology-grant.js'
import { UDX_LINK_CLOSE, UDX_LINK_OPEN, UDX_SEND_DISPATCH, UdxAdapter } from './udx-adapter.js'

export const DEFAULT_MAX_UDX_QUEUED_PACKETS = 64
export const DEFAULT_MAX_UDX_QUEUED_BYTES = BOOTSTRAP_SIZE * DEFAULT_MAX_UDX_QUEUED_PACKETS
export const DEFAULT_MAX_UDX_INBOUND_PACKETS = 64
export const DEFAULT_MAX_UDX_INBOUND_BYTES = BOOTSTRAP_SIZE * DEFAULT_MAX_UDX_INBOUND_PACKETS
export const DEFAULT_MAX_UDX_INBOUND_PACKETS_PER_PEER = 8
export const DEFAULT_MAX_UDX_INBOUND_BYTES_PER_PEER =
  BOOTSTRAP_SIZE * DEFAULT_MAX_UDX_INBOUND_PACKETS_PER_PEER
export const DEFAULT_UDX_RECEIVE_CLOSE_TIMEOUT = 5_000

const ENDPOINTS = new WeakMap()
const SEND_HANDLES = new WeakMap()

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

function numericHost(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  if (/^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$/.test(host)) {
    return host.split('.').every((part) => Number(part) <= 255)
  }
  if (!/^[0-9a-f:]+$/.test(host) || host.includes('%') || host.includes('.')) return false
  const marker = host.indexOf('::')
  if (marker !== -1 && marker !== host.lastIndexOf('::')) return false
  const left = (marker === -1 ? host : host.slice(0, marker)).split(':').filter(Boolean)
  const right = (marker === -1 ? '' : host.slice(marker + 2)).split(':').filter(Boolean)
  if (![...left, ...right].every((part) => /^[0-9a-f]{1,4}$/.test(part))) return false
  return marker === -1 ? left.length === 8 : left.length + right.length < 8
}

function bound(value, fallback) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > fallback) invalid()
  return value
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) b4a.fill(value, 0)
  } catch {}
}

function detachAbort(record) {
  const signal = record.signal
  const abort = record.abort
  record.signal = null
  record.abort = null
  if (!signal || !abort) return
  try {
    signal.removeEventListener('abort', abort)
  } catch {}
}

function rejectRecord(record, error) {
  if (record.settled) return
  record.settled = true
  clear(record.packet)
  record.packet = null
  detachAbort(record)
  record.reject(error)
}

function settleRecord(record, value) {
  if (record.settled) return
  record.settled = true
  clear(record.packet)
  record.packet = null
  detachAbort(record)
  record.resolve(value)
}

function removeQueued(state, record) {
  const index = state.queue.indexOf(record)
  if (index === -1) return false
  state.queue.splice(index, 1)
  state.queuedBytes -= BOOTSTRAP_SIZE
  state.reservedPackets--
  state.reservedBytes -= BOOTSTRAP_SIZE
  return true
}

function rejectQueue(state, error) {
  const queued = state.queue.splice(0)
  state.queuedBytes = 0
  for (const record of queued) {
    state.reservedPackets--
    state.reservedBytes -= BOOTSTRAP_SIZE
    rejectRecord(record, error)
  }
}

function invalidateRecord(state, record) {
  if (!record || record.phase === 'CLOSED') return
  record.phase = 'CLOSED'
  if (record.session) {
    record.session[LINK_BOOTSTRAP_SESSION_INVALIDATE]()
    record.session = null
  }
  for (let index = state.queue.length - 1; index >= 0; index--) {
    const queued = state.queue[index]
    if (queued.authority !== record) continue
    state.queue.splice(index, 1)
    state.queuedBytes -= BOOTSTRAP_SIZE
    state.reservedPackets--
    state.reservedBytes -= BOOTSTRAP_SIZE
    rejectRecord(queued, PrivateRouteError.UNAUTHORIZED())
  }
  if (state.dispatching && state.dispatching.authority === record) {
    state.dispatching.cancelled = true
  }
  if (state.sources.get(record.source) === record.handle) state.sources.delete(record.source)
  state.handles.delete(record.linkHandle)
  state.records.delete(record)
  SEND_HANDLES.delete(record.handle)
  record.endpoint = null
  record.peer = null
  record.peerKey = null
  record.linkHandle = null
}

function validateRecord(state, record) {
  if (!record || record.endpoint !== state.endpoint || record.phase === 'CLOSED') return false
  try {
    readLinkHandle(record.linkHandle)
    return true
  } catch {
    invalidateRecord(state, record)
    return false
  }
}

function pump(state) {
  if (state.dispatching || state.queue.length === 0 || state.closing) return
  const record = state.queue.shift()
  state.queuedBytes -= BOOTSTRAP_SIZE
  if (record.settled) {
    pump(state)
    return
  }
  if (!validateRecord(state, record.authority)) {
    state.reservedPackets--
    state.reservedBytes -= BOOTSTRAP_SIZE
    rejectRecord(record, PrivateRouteError.UNAUTHORIZED())
    pump(state)
    return
  }
  state.dispatching = record
  state.inFlight++
  let releaseNative
  const native = new Promise((resolve) => {
    releaseNative = resolve
  })
  const completion = native
    .then((result) => result)
    .then(
      (sent) => {
        if (record.cancelled || sent !== true) rejectRecord(record, unavailable())
        else settleRecord(record, true)
      },
      () => rejectRecord(record, unavailable())
    )
    .finally(() => {
      state.nativeWaits.delete(completion)
      state.inFlight--
      state.reservedPackets--
      state.reservedBytes -= BOOTSTRAP_SIZE
      state.dispatching = null
      if (!state.closing) pump(state)
    })
  state.nativeWaits.add(completion)
  try {
    if (record.onDispatch) record.onDispatch()
    releaseNative(state.socket.send(record.packet, record.peer.port, record.peer.host))
  } catch {
    releaseNative(false)
  }
}

function releaseReceive(state, record) {
  if (!record.active) return
  record.active = false
  state.receiveRecords.delete(record)
  state.inboundPackets--
  state.inboundBytes -= BOOTSTRAP_SIZE
  const peer = state.inboundPeers.get(record.peerKey)
  if (peer) {
    peer.packets--
    peer.bytes -= BOOTSTRAP_SIZE
    if (peer.packets === 0) state.inboundPeers.delete(record.peerKey)
  }
  clear(record.packet)
  record.packet = null
}

async function waitForReceives(state) {
  const completions = Array.from(state.receiveRecords, (record) => record.completion).filter(
    Boolean
  )
  if (completions.length === 0) return
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, state.receiveCloseTimeout)
  })
  await Promise.race([Promise.allSettled(completions), timeout])
  if (timer !== null) clearTimeout(timer)
  for (const record of Array.from(state.receiveRecords)) releaseReceive(state, record)
}

function receive(state, packet, from) {
  if (state.closing || !b4a.isBuffer(packet) || packet.byteLength !== BOOTSTRAP_SIZE) return
  let source
  try {
    source = `${from.host}:${from.port}`
  } catch {
    return
  }
  const sendHandle = state.sources.get(source)
  if (!sendHandle) return
  const authority = SEND_HANDLES.get(sendHandle)
  if (!validateRecord(state, authority)) return
  if (packet[0] !== 0) return
  if (packet[1] !== BOOTSTRAP_CLASS && packet[1] > 2) return
  if (packet[1] !== BOOTSTRAP_CLASS && authority.phase !== 'OPEN') return
  const peerKey = authority.peerKey
  const peer = state.inboundPeers.get(peerKey) || { packets: 0, bytes: 0 }
  if (
    state.inboundPackets >= state.maxInboundPackets ||
    state.inboundBytes + BOOTSTRAP_SIZE > state.maxInboundBytes ||
    peer.packets >= state.maxInboundPacketsPerPeer ||
    peer.bytes + BOOTSTRAP_SIZE > state.maxInboundBytesPerPeer
  ) {
    return
  }
  const owned = b4a.from(packet)
  const record = { packet: owned, peerKey, completion: null, active: true }
  state.receiveRecords.add(record)
  state.inboundPackets++
  state.inboundBytes += BOOTSTRAP_SIZE
  peer.packets++
  peer.bytes += BOOTSTRAP_SIZE
  state.inboundPeers.set(peerKey, peer)
  try {
    const result =
      owned[1] === BOOTSTRAP_CLASS
        ? state.onBootstrap(owned, sendHandle)
        : state.onCell(owned, sendHandle)
    record.completion = Promise.resolve(result)
      .catch(() => {})
      .finally(() => releaseReceive(state, record))
  } catch {
    releaseReceive(state, record)
  }
}

export class UdxCellEndpoint {
  constructor(options = {}) {
    if (!isObject(options)) invalid()
    const adapter = options.adapter || new UdxAdapter()
    const { host, port, onBootstrap, onCell } = options
    if (
      !adapter ||
      typeof adapter.create !== 'function' ||
      !numericHost(host) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 0xffff ||
      typeof onBootstrap !== 'function' ||
      typeof onCell !== 'function'
    ) {
      invalid()
    }
    let udx
    let socket
    try {
      udx = adapter.create()
      socket = udx.createSocket()
    } catch {
      throw unavailable()
    }
    if (
      !socket ||
      typeof socket.bind !== 'function' ||
      typeof socket.send !== 'function' ||
      typeof socket.close !== 'function' ||
      typeof socket.on !== 'function'
    ) {
      invalid()
    }
    const state = {
      endpoint: this,
      udx,
      socket,
      host,
      port,
      onBootstrap,
      onCell,
      maxQueuedPackets: bound(options.maxQueuedPackets, DEFAULT_MAX_UDX_QUEUED_PACKETS),
      maxQueuedBytes: bound(options.maxQueuedBytes, DEFAULT_MAX_UDX_QUEUED_BYTES),
      maxInboundPackets: bound(options.maxInboundPackets, DEFAULT_MAX_UDX_INBOUND_PACKETS),
      maxInboundBytes: bound(options.maxInboundBytes, DEFAULT_MAX_UDX_INBOUND_BYTES),
      maxInboundPacketsPerPeer: bound(
        options.maxInboundPacketsPerPeer,
        DEFAULT_MAX_UDX_INBOUND_PACKETS_PER_PEER
      ),
      maxInboundBytesPerPeer: bound(
        options.maxInboundBytesPerPeer,
        DEFAULT_MAX_UDX_INBOUND_BYTES_PER_PEER
      ),
      receiveCloseTimeout: bound(options.receiveCloseTimeout, DEFAULT_UDX_RECEIVE_CLOSE_TIMEOUT),
      handles: new WeakMap(),
      records: new Set(),
      sources: new Map(),
      queue: [],
      queuedBytes: 0,
      reservedPackets: 0,
      reservedBytes: 0,
      dispatching: null,
      inFlight: 0,
      nativeWaits: new Set(),
      receiveRecords: new Set(),
      inboundPackets: 0,
      inboundBytes: 0,
      inboundPeers: new Map(),
      bound: false,
      closing: false,
      closePromise: null
    }
    socket.on('message', (packet, from) => receive(state, packet, from))
    socket.on('error', () => {
      void this.close().catch(() => {})
    })
    ENDPOINTS.set(this, state)
  }

  get queuedPackets() {
    return ENDPOINTS.get(this).queue.length
  }

  get queuedBytes() {
    return ENDPOINTS.get(this).queuedBytes
  }

  get inFlightSends() {
    return ENDPOINTS.get(this).inFlight
  }

  async bind() {
    const state = ENDPOINTS.get(this)
    if (state.closing) throw stateError()
    if (state.bound) return true
    try {
      const result = state.socket.bind(state.port, state.host)
      if (result && typeof result.then === 'function') await result
      state.bound = true
      return true
    } catch {
      throw unavailable()
    }
  }

  openLink(linkHandle, sessionOptions) {
    const state = ENDPOINTS.get(this)
    if (state.closing || !state.bound) throw stateError()
    if (sessionOptions !== undefined && !isObject(sessionOptions)) invalid()
    if (state.handles.has(linkHandle)) {
      const sendHandle = state.handles.get(linkHandle)
      const record = SEND_HANDLES.get(sendHandle)
      if (validateRecord(state, record)) {
        if (sessionOptions === undefined) return sendHandle
        if (record.session) throw stateError()
        try {
          const session = new LinkBootstrapSession({
            ...sessionOptions,
            endpoint: this,
            sendHandle,
            linkHandle
          })
          record.session = session
          return session
        } catch (err) {
          invalidateRecord(state, record)
          throw err
        }
      }
    }
    let link
    try {
      link = readLinkHandle(linkHandle)
    } catch {
      throw PrivateRouteError.UNAUTHORIZED()
    }
    if (link.localAddress.host !== state.host || link.localAddress.port !== state.port) {
      throw PrivateRouteError.UNAUTHORIZED()
    }
    const source = `${link.peerAddress.host}:${link.peerAddress.port}`
    if (state.sources.has(source)) {
      const existingHandle = state.sources.get(source)
      const existing = SEND_HANDLES.get(existingHandle)
      if (validateRecord(state, existing)) throw PrivateRouteError.CIRCUIT_STATE()
    }
    const sendHandle = Object.freeze({})
    const record = {
      endpoint: this,
      handle: sendHandle,
      linkHandle,
      peer: { host: link.peerAddress.host, port: link.peerAddress.port },
      peerKey: b4a.toString(link.peerIdentity32, 'hex'),
      source,
      phase: 'PENDING',
      session: null
    }
    SEND_HANDLES.set(sendHandle, record)
    state.handles.set(linkHandle, sendHandle)
    state.sources.set(source, sendHandle)
    state.records.add(record)
    if (sessionOptions === undefined) return sendHandle
    try {
      const session = new LinkBootstrapSession({
        ...sessionOptions,
        endpoint: this,
        sendHandle,
        linkHandle
      })
      record.session = session
      return session
    } catch (err) {
      invalidateRecord(state, record)
      throw err
    }
  }

  send(handle, packet, options = {}) {
    const state = ENDPOINTS.get(this)
    if (state.closing) return Promise.reject(stateError())
    if (!state.bound) return Promise.reject(stateError())
    const authority = isObject(handle) ? SEND_HANDLES.get(handle) : null
    if (!authority || authority.endpoint !== this) {
      return Promise.reject(PrivateRouteError.UNAUTHORIZED())
    }
    if (!validateRecord(state, authority)) {
      return Promise.reject(PrivateRouteError.UNAUTHORIZED())
    }
    if (!b4a.isBuffer(packet) || packet.byteLength !== BOOTSTRAP_SIZE || !isObject(options)) {
      return Promise.reject(PrivateRouteError.INVALID_ROUTE())
    }
    if (packet[1] !== BOOTSTRAP_CLASS && authority.phase !== 'OPEN') {
      return Promise.reject(stateError())
    }
    const signal = options.signal
    const onDispatch = options[UDX_SEND_DISPATCH]
    if (
      signal !== undefined &&
      (!isObject(signal) ||
        typeof signal.addEventListener !== 'function' ||
        typeof signal.removeEventListener !== 'function')
    ) {
      return Promise.reject(PrivateRouteError.INVALID_ROUTE())
    }
    if (onDispatch !== undefined && typeof onDispatch !== 'function') {
      return Promise.reject(PrivateRouteError.INVALID_ROUTE())
    }
    if (signal && signal.aborted) return Promise.reject(unavailable())
    if (
      state.reservedPackets >= state.maxQueuedPackets ||
      state.reservedBytes + BOOTSTRAP_SIZE > state.maxQueuedBytes
    ) {
      return Promise.reject(PrivateRouteError.CIRCUIT_LIMIT())
    }
    return new Promise((resolve, reject) => {
      const record = {
        packet: b4a.from(packet),
        peer: authority.peer,
        authority,
        signal,
        onDispatch,
        abort: null,
        resolve,
        reject,
        settled: false,
        cancelled: false
      }
      record.abort = () => {
        record.cancelled = true
        if (removeQueued(state, record)) rejectRecord(record, unavailable())
      }
      state.queue.push(record)
      state.queuedBytes += BOOTSTRAP_SIZE
      state.reservedPackets++
      state.reservedBytes += BOOTSTRAP_SIZE
      if (signal) {
        try {
          signal.addEventListener('abort', record.abort, { once: true })
        } catch {
          if (removeQueued(state, record)) rejectRecord(record, unavailable())
          return
        }
        if (signal.aborted && !record.settled) record.abort()
      }
      pump(state)
    })
  }

  [UDX_LINK_OPEN](handle) {
    const state = ENDPOINTS.get(this)
    const record = isObject(handle) ? SEND_HANDLES.get(handle) : null
    if (state.closing || !validateRecord(state, record)) throw PrivateRouteError.UNAUTHORIZED()
    record.phase = 'OPEN'
  }

  [UDX_LINK_CLOSE](handle) {
    const state = ENDPOINTS.get(this)
    const record = isObject(handle) ? SEND_HANDLES.get(handle) : null
    if (record && record.endpoint === this) invalidateRecord(state, record)
  }

  close() {
    const state = ENDPOINTS.get(this)
    if (state.closePromise) return state.closePromise
    state.closing = true
    rejectQueue(state, stateError())
    for (const record of Array.from(state.records)) invalidateRecord(state, record)
    const nativeWaits = Array.from(state.nativeWaits)
    state.closePromise = (async () => {
      await Promise.allSettled(nativeWaits)
      await waitForReceives(state)
      try {
        await state.socket.close()
      } catch {
        throw unavailable()
      } finally {
        state.sources.clear()
        state.handles = new WeakMap()
        state.onBootstrap = null
        state.onCell = null
        state.udx = null
      }
    })()
    return state.closePromise
  }
}
