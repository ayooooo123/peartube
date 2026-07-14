import b4a from 'b4a'

import { BOOTSTRAP_CLASS, BOOTSTRAP_SIZE } from './bootstrap-envelope.js'
import { MAX_CELL_PAYLOAD, CellCodec } from './cell-codec.js'
import { cryptoSuite } from './crypto-suite.js'
import { PrivateRouteError } from './errors.js'
import { createLinkControlBoundary, LinkControlSession } from './link-control-session.js'
import {
  LINK_BOOTSTRAP_SESSION_INVALIDATE,
  LinkBootstrapSession
} from './link-bootstrap-session.js'
import {
  readLinkHandle,
  subscribeLinkHandleClose,
  unsubscribeLinkHandleClose
} from './topology-grant.js'
import {
  UDX_LINK_CLOSE,
  UDX_LINK_OPEN,
  UDX_LINK_STATS,
  UDX_SEND_CELL,
  UDX_SEND_DISPATCH,
  UdxAdapter
} from './udx-adapter.js'
import { CELL_CLASS, DIRECTION } from './protocol.js'

export const DEFAULT_MAX_UDX_QUEUED_PACKETS = 64
export const DEFAULT_MAX_UDX_QUEUED_BYTES = BOOTSTRAP_SIZE * DEFAULT_MAX_UDX_QUEUED_PACKETS
export const DEFAULT_MAX_UDX_INBOUND_PACKETS = 64
export const DEFAULT_MAX_UDX_INBOUND_BYTES = BOOTSTRAP_SIZE * DEFAULT_MAX_UDX_INBOUND_PACKETS
export const DEFAULT_MAX_UDX_INBOUND_PACKETS_PER_PEER = 8
export const DEFAULT_MAX_UDX_INBOUND_BYTES_PER_PEER =
  BOOTSTRAP_SIZE * DEFAULT_MAX_UDX_INBOUND_PACKETS_PER_PEER
const ENDPOINTS = new WeakMap()
const SEND_HANDLES = new WeakMap()
const ROUTE_GENERATION_BYTES = 8
const STREAM_LOGICAL_COUNTER_BYTES = 8
const MAX_DATAGRAM_PAYLOAD = MAX_CELL_PAYLOAD - ROUTE_GENERATION_BYTES
const MAX_STREAM_PAYLOAD = MAX_CELL_PAYLOAD - ROUTE_GENERATION_BYTES - STREAM_LOGICAL_COUNTER_BYTES
const MAX_UINT64 = (1n << 64n) - 1n

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

function readUint64BE(buffer, offset) {
  let value = 0n
  for (let index = offset; index < offset + 8; index++) {
    value = (value << 8n) | BigInt(buffer[index])
  }
  return value
}

function writeUint64BE(buffer, value, offset) {
  for (let index = offset + 7; index >= offset; index--) {
    buffer[index] = Number(value & 0xffn)
    value >>= 8n
  }
}

function frameEstablished(cellClass, generation, logicalCounter, payload) {
  const prefix =
    ROUTE_GENERATION_BYTES + (cellClass === CELL_CLASS.STREAM ? STREAM_LOGICAL_COUNTER_BYTES : 0)
  const framed = b4a.allocUnsafeSlow(prefix + payload.byteLength)
  writeUint64BE(framed, generation, 0)
  if (cellClass === CELL_CLASS.STREAM) {
    writeUint64BE(framed, logicalCounter, ROUTE_GENERATION_BYTES)
  }
  framed.set(payload, prefix)
  return framed
}

function opposite(direction) {
  return direction === DIRECTION.FORWARD ? DIRECTION.REVERSE : DIRECTION.FORWARD
}

function establishedOptions(value) {
  if (!isObject(value) || !isObject(value.linkState)) invalid()
  const { linkState, mode, now, schedule, cancel, randomBytes } = value
  if (
    (mode !== 'initiate' && mode !== 'accept') ||
    !b4a.isBuffer(linkState.circuitId) ||
    linkState.circuitId.byteLength !== 16 ||
    typeof linkState.epoch !== 'bigint' ||
    !isObject(linkState.contexts) ||
    typeof now !== 'function' ||
    typeof schedule !== 'function' ||
    typeof cancel !== 'function' ||
    typeof randomBytes !== 'function'
  ) {
    invalid()
  }
  for (const cellClass of [CELL_CLASS.CONTROL, CELL_CLASS.STREAM, CELL_CLASS.DATAGRAM]) {
    const pair = linkState.contexts[cellClass]
    if (!isObject(pair) || !isObject(pair.tx) || !isObject(pair.rx)) invalid()
  }
  return { linkState, mode, now, schedule, cancel, randomBytes }
}

function receiveEstablished(state, authority, packet) {
  const cellClass = packet[1]
  const direction = packet[2]
  const counter = readUint64BE(packet, 28)
  const expectedDirection = opposite(authority.heartbeatDirection)
  const context = authority.linkState.contexts[cellClass]
  if (!context || direction !== expectedDirection) throw PrivateRouteError.CELL_INVALID()
  const before = cellClass === CELL_CLASS.DATAGRAM ? null : context.rx.counter.next
  const delivery = authority.cellCodec.open(
    {
      key: context.rx.key,
      noncePrefix: context.rx.noncePrefix,
      receiver: context.rx.counter,
      expectedClass: cellClass,
      expectedDirection,
      expectedEpoch: authority.linkState.epoch,
      expectedCircuitId: authority.linkState.circuitId
    },
    packet
  )
  const values = cellClass === CELL_CLASS.DATAGRAM ? [delivery] : delivery
  if (values.length === 0) {
    const event = authority.linkBoundary.pushAuthenticated({
      link: authority,
      epoch: authority.linkState.epoch,
      circuitId: authority.linkState.circuitId,
      class: cellClass,
      direction,
      generation: cellClass === CELL_CLASS.CONTROL ? 0n : 1n,
      counter,
      deliver: false,
      payload: b4a.alloc(0)
    })
    return authority.linkControl.receiveAuthenticated(event)
  }
  let accepted = true
  try {
    for (let index = 0; index < values.length; index++) {
      const payload = values[index]
      if (cellClass !== CELL_CLASS.CONTROL && payload.byteLength < ROUTE_GENERATION_BYTES) invalid()
      const generation = cellClass === CELL_CLASS.CONTROL ? 0n : readUint64BE(payload, 0)
      if (cellClass !== CELL_CLASS.CONTROL && generation === 0n) invalid()
      if (
        cellClass === CELL_CLASS.STREAM &&
        payload.byteLength < ROUTE_GENERATION_BYTES + STREAM_LOGICAL_COUNTER_BYTES
      ) {
        invalid()
      }
      const logicalCounter =
        cellClass === CELL_CLASS.STREAM ? readUint64BE(payload, ROUTE_GENERATION_BYTES) : counter
      const prefix =
        cellClass === CELL_CLASS.CONTROL
          ? 0
          : ROUTE_GENERATION_BYTES +
            (cellClass === CELL_CLASS.STREAM ? STREAM_LOGICAL_COUNTER_BYTES : 0)
      const applicationPayload =
        cellClass === CELL_CLASS.CONTROL ? payload : payload.subarray(prefix)
      const deliveredCounter =
        cellClass === CELL_CLASS.STREAM
          ? logicalCounter
          : cellClass === CELL_CLASS.DATAGRAM
            ? counter
            : before + BigInt(index)
      const event = authority.linkBoundary.pushAuthenticated({
        link: authority,
        epoch: authority.linkState.epoch,
        circuitId: authority.linkState.circuitId,
        class: cellClass,
        direction,
        generation,
        counter: deliveredCounter,
        payload: applicationPayload
      })
      const current = authority.linkControl.receiveAuthenticated(event, {
        dispatchActor(fragment, metadata) {
          return state.onCell(fragment, authority.handle, metadata) === true
        },
        enqueueStream(owned, metadata) {
          return state.onCell(owned, authority.handle, metadata) === true
        },
        enqueueDatagram(owned, metadata) {
          return state.onCell(owned, authority.handle, metadata) === true
        }
      })
      if (!current) accepted = false
    }
  } finally {
    for (const payload of values) clear(payload)
  }
  return accepted
}

function installLinkControl(state, record, value) {
  const options = establishedOptions(value)
  const heartbeatDirection = options.mode === 'initiate' ? DIRECTION.FORWARD : DIRECTION.REVERSE
  const boundary = createLinkControlBoundary({
    link: record,
    epoch: options.linkState.epoch,
    circuitId: options.linkState.circuitId
  })
  const codec = new CellCodec({ crypto: cryptoSuite, cellSize: BOOTSTRAP_SIZE })
  record.linkState = options.linkState
  record.cellCodec = codec
  record.linkBoundary = boundary
  record.heartbeatDirection = heartbeatDirection
  record.streamCounters = new Map()
  const linkControl = new LinkControlSession({
    control: boundary.consumer,
    circuitId: options.linkState.circuitId,
    epoch: options.linkState.epoch,
    heartbeatDirection,
    now: options.now,
    schedule: options.schedule,
    cancel: options.cancel,
    randomBytes: options.randomBytes,
    sendControl(payload) {
      const context = options.linkState.contexts[CELL_CLASS.CONTROL].tx
      const direction = payload[4]
      if (direction !== heartbeatDirection && direction !== opposite(heartbeatDirection)) invalid()
      let packet = null
      try {
        packet = codec.seal({
          key: context.key,
          noncePrefix: context.noncePrefix,
          senderCounter: context.counter,
          class: CELL_CLASS.CONTROL,
          direction,
          epoch: options.linkState.epoch,
          circuitId: options.linkState.circuitId,
          payload
        })
        return state.endpoint.send(record.handle, packet)
      } finally {
        clear(packet)
      }
    },
    cancelPending() {
      if (record.phase === 'OPEN') record.phase = 'CLOSING'
      for (const queued of state.queue) {
        if (queued.authority === record) queued.cancelled = true
      }
      if (state.dispatching && state.dispatching.authority === record) {
        state.dispatching.cancelled = true
      }
    },
    notifyCircuit(direction, reason) {
      state.onLinkFailure(record.handle, direction, reason)
    },
    closeLink() {
      state.endpoint[UDX_LINK_CLOSE](record.handle)
    }
  })
  if (state.closing || record.phase !== 'OPEN' || record.endpoint !== state.endpoint) {
    linkControl.close()
    throw unavailable()
  }
  record.linkControl = linkControl
}

function detachAbort(record) {
  const signal = record.signal
  const abort = record.abort
  const removeAbort = record.removeAbort
  record.signal = null
  record.abort = null
  record.removeAbort = null
  if (!signal || !abort || !removeAbort) return
  try {
    removeAbort.call(signal, 'abort', abort)
  } catch {}
}

function releasePacket(record) {
  clear(record.packet)
  record.packet = null
}

function rejectCaller(record, error) {
  if (record.settled) return
  record.settled = true
  detachAbort(record)
  record.reject(error)
  return true
}

function rejectRecord(record, error) {
  if (!rejectCaller(record, error)) return
  releasePacket(record)
}

function settleRecord(record, value) {
  if (record.settled) return
  record.settled = true
  releasePacket(record)
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
  const linkControl = record.linkControl
  record.linkControl = null
  if (linkControl) {
    try {
      linkControl.close()
    } catch {}
  }
  if (record.closeSubscription) {
    unsubscribeLinkHandleClose(record.closeSubscription)
    record.closeSubscription = null
  }
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
    rejectCaller(state.dispatching, unavailable())
  }
  if (state.sources.get(record.source) === record.handle) state.sources.delete(record.source)
  state.handles.delete(record.linkHandle)
  state.records.delete(record)
  SEND_HANDLES.delete(record.handle)
  record.endpoint = null
  record.peer = null
  record.peerKey = null
  record.linkHandle = null
  record.linkState = null
  record.cellCodec = null
  record.linkBoundary = null
  record.streamCounters = null
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
      releasePacket(record)
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
    if (state.closing || record.cancelled || !validateRecord(state, record.authority)) {
      releaseNative(false)
      return
    }
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
  const completions = Array.from(state.receiveRecords, (record) => record.completion)
  if (completions.length === 0) return
  await Promise.allSettled(completions)
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
  let settleOwnership
  const ownership = new Promise((resolve) => {
    settleOwnership = resolve
  })
  const record = { packet: owned, peerKey, completion: null, active: true }
  record.completion = ownership.finally(() => releaseReceive(state, record))
  state.receiveRecords.add(record)
  state.inboundPackets++
  state.inboundBytes += BOOTSTRAP_SIZE
  peer.packets++
  peer.bytes += BOOTSTRAP_SIZE
  state.inboundPeers.set(peerKey, peer)
  // A handler promise owns its packet until settlement. The exact endpoint
  // close promise is recognized below; another handler promise must not await
  // that close because an indirect promise cycle cannot be identified safely.
  try {
    const result =
      owned[1] === BOOTSTRAP_CLASS
        ? state.onBootstrap(owned, sendHandle)
        : authority.linkControl
          ? receiveEstablished(state, authority, owned)
          : state.onCell(owned, sendHandle)
    if (result === state.closePromise) settleOwnership()
    Promise.resolve(result).then(settleOwnership, settleOwnership)
  } catch {
    settleOwnership()
  }
}

export class UdxCellEndpoint {
  constructor(options = {}) {
    if (!isObject(options)) invalid()
    const adapter = options.adapter || new UdxAdapter()
    const { host, port, onBootstrap, onCell, onLinkFailure } = options
    if (
      !adapter ||
      typeof adapter.create !== 'function' ||
      !numericHost(host) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 0xffff ||
      typeof onBootstrap !== 'function' ||
      typeof onCell !== 'function' ||
      typeof onLinkFailure !== 'function'
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
      onLinkFailure,
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
      session: null,
      linkControl: null,
      linkBoundary: null,
      linkState: null,
      cellCodec: null,
      heartbeatDirection: null,
      streamCounters: null,
      closeSubscription: null
    }
    SEND_HANDLES.set(sendHandle, record)
    state.handles.set(linkHandle, sendHandle)
    state.sources.set(source, sendHandle)
    state.records.add(record)
    try {
      record.closeSubscription = subscribeLinkHandleClose(linkHandle, () => {
        invalidateRecord(state, record)
      })
    } catch (err) {
      invalidateRecord(state, record)
      throw err
    }
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
    if (authority.phase === 'CLOSING') return Promise.reject(stateError())
    if (!b4a.isBuffer(packet) || packet.byteLength !== BOOTSTRAP_SIZE || !isObject(options)) {
      return Promise.reject(PrivateRouteError.INVALID_ROUTE())
    }
    if (packet[1] !== BOOTSTRAP_CLASS && authority.phase !== 'OPEN') {
      return Promise.reject(stateError())
    }
    let signal
    let onDispatch
    let addAbort = null
    let removeAbort = null
    let aborted = false
    try {
      signal = options.signal
      onDispatch = options[UDX_SEND_DISPATCH]
      if (signal !== undefined) {
        if (!isObject(signal)) throw PrivateRouteError.INVALID_ROUTE()
        addAbort = signal.addEventListener
        removeAbort = signal.removeEventListener
        aborted = signal.aborted
      }
    } catch {
      if (state.closing) return Promise.reject(stateError())
      if (!validateRecord(state, authority)) {
        return Promise.reject(PrivateRouteError.UNAUTHORIZED())
      }
      return Promise.reject(PrivateRouteError.INVALID_ROUTE())
    }
    if (state.closing) return Promise.reject(stateError())
    if (!validateRecord(state, authority)) {
      return Promise.reject(PrivateRouteError.UNAUTHORIZED())
    }
    if (
      signal !== undefined &&
      (typeof addAbort !== 'function' || typeof removeAbort !== 'function')
    ) {
      return Promise.reject(PrivateRouteError.INVALID_ROUTE())
    }
    if (onDispatch !== undefined && typeof onDispatch !== 'function') {
      return Promise.reject(PrivateRouteError.INVALID_ROUTE())
    }
    if (aborted) return Promise.reject(unavailable())
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
        removeAbort,
        onDispatch,
        abort: null,
        admitted: false,
        resolve,
        reject,
        settled: false,
        cancelled: false
      }
      record.abort = () => {
        record.cancelled = true
        if (removeQueued(state, record) || !record.admitted) rejectRecord(record, unavailable())
        else rejectCaller(record, unavailable())
      }
      if (signal) {
        let abortedAfter = false
        try {
          addAbort.call(signal, 'abort', record.abort, { once: true })
          abortedAfter = signal.aborted
        } catch {
          const error = state.closing
            ? stateError()
            : validateRecord(state, authority)
              ? unavailable()
              : PrivateRouteError.UNAUTHORIZED()
          rejectRecord(record, error)
          return
        }
        if (abortedAfter && !record.settled) record.abort()
      }
      if (record.settled) return
      if (state.closing) {
        rejectRecord(record, stateError())
        return
      }
      if (!validateRecord(state, authority)) {
        rejectRecord(record, PrivateRouteError.UNAUTHORIZED())
        return
      }
      if (
        state.reservedPackets >= state.maxQueuedPackets ||
        state.reservedBytes + BOOTSTRAP_SIZE > state.maxQueuedBytes
      ) {
        rejectRecord(record, PrivateRouteError.CIRCUIT_LIMIT())
        return
      }
      record.admitted = true
      state.queue.push(record)
      state.queuedBytes += BOOTSTRAP_SIZE
      state.reservedPackets++
      state.reservedBytes += BOOTSTRAP_SIZE
      pump(state)
    })
  }

  [UDX_LINK_OPEN](handle, established) {
    const state = ENDPOINTS.get(this)
    const record = isObject(handle) ? SEND_HANDLES.get(handle) : null
    if (state.closing || !validateRecord(state, record)) throw PrivateRouteError.UNAUTHORIZED()
    if (record.phase === 'OPEN' || record.linkControl) throw stateError()
    record.phase = 'OPEN'
    if (established !== undefined) {
      try {
        installLinkControl(state, record, established)
      } catch (err) {
        invalidateRecord(state, record)
        throw err
      }
    }
  }

  [UDX_LINK_CLOSE](handle) {
    const state = ENDPOINTS.get(this)
    const record = isObject(handle) ? SEND_HANDLES.get(handle) : null
    if (record && record.endpoint === this) invalidateRecord(state, record)
  }

  [UDX_SEND_CELL](handle, value) {
    const state = ENDPOINTS.get(this)
    const record = isObject(handle) ? SEND_HANDLES.get(handle) : null
    if (
      state.closing ||
      !validateRecord(state, record) ||
      record.phase !== 'OPEN' ||
      !record.linkControl ||
      !isObject(value)
    ) {
      return Promise.reject(PrivateRouteError.UNAUTHORIZED())
    }
    const cellClass = value.class
    const direction = value.direction
    const generation = value.generation
    const payload = value.payload
    if (
      (cellClass !== CELL_CLASS.STREAM && cellClass !== CELL_CLASS.DATAGRAM) ||
      direction !== record.heartbeatDirection ||
      typeof generation !== 'bigint' ||
      generation < 1n ||
      generation > MAX_UINT64 ||
      !b4a.isBuffer(payload) ||
      payload.byteLength >
        (cellClass === CELL_CLASS.STREAM ? MAX_STREAM_PAYLOAD : MAX_DATAGRAM_PAYLOAD)
    ) {
      return Promise.reject(PrivateRouteError.INVALID_ROUTE())
    }
    const context = record.linkState.contexts[cellClass].tx
    let logical = null
    let logicalKey = null
    let logicalState = null
    if (cellClass === CELL_CLASS.STREAM) {
      logicalKey = `${direction}:${generation}`
      logicalState = record.streamCounters.get(logicalKey) || { next: 0n, closed: false }
      if (logicalState.closed) return Promise.reject(PrivateRouteError.COUNTER_EXHAUSTED())
      logical = logicalState.next
    }
    let packet = null
    let framed = null
    try {
      framed = frameEstablished(cellClass, generation, logical, payload)
      packet = record.cellCodec.seal({
        key: context.key,
        noncePrefix: context.noncePrefix,
        senderCounter: context.counter,
        class: cellClass,
        direction,
        epoch: record.linkState.epoch,
        circuitId: record.linkState.circuitId,
        payload: framed
      })
      if (cellClass === CELL_CLASS.STREAM) {
        record.linkControl.trackStream(direction, generation, logical, payload.byteLength)
        if (logical === MAX_UINT64) logicalState.closed = true
        else logicalState.next = logical + 1n
        record.streamCounters.set(logicalKey, logicalState)
      }
      const sending = this.send(handle, packet)
      return sending.catch((err) => {
        if (record.linkControl) record.linkControl.close()
        throw err
      })
    } catch (err) {
      if (record.linkControl) record.linkControl.close()
      return Promise.reject(err instanceof PrivateRouteError ? err : unavailable())
    } finally {
      clear(packet)
      clear(framed)
    }
  }

  [UDX_LINK_STATS](handle) {
    const state = ENDPOINTS.get(this)
    const record = isObject(handle) ? SEND_HANDLES.get(handle) : null
    if (!validateRecord(state, record) || !record.linkControl) {
      throw PrivateRouteError.UNAUTHORIZED()
    }
    return {
      pendingStreams: record.linkControl.pendingStreams,
      pendingBytes: record.linkControl.pendingBytes,
      pendingSends: record.linkControl.pendingSends,
      closed: record.linkControl.closed
    }
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
        state.onLinkFailure = null
        state.udx = null
      }
    })()
    return state.closePromise
  }
}
