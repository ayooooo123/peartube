import b4a from 'b4a'
import c from 'compact-encoding'
import Protomux from 'protomux'

import {
  MAX_PEER_FRAME_BYTES,
  encodePeerFrame,
} from '../network/frame.js'
import {
  INDEX_QUERY_CAPABILITY,
  SCOPED_NETWORK_PROTOCOL,
  createScopedProtocolSession,
  encodeScopedHello,
} from '../network/scoped-protocol.js'
import { deriveIndexerTopic } from '../network/topics.js'
import { PROTOCOL_MAJOR } from '../network/version.js'
import {
  INDEX_SERVICE_QUERY_CAPABILITIES,
  verifyIndexServiceAnnouncement,
} from './service-announcement.js'
import {
  INDEX_QUERY_ERROR_CODES,
  MAX_INDEX_QUERY_FRAME_BYTES,
} from './query-codec.js'
import { createIndexQueryDispatcher } from './query-dispatcher.js'
import {
  IndexQueryRemoteError,
  createIndexQueryRequester,
} from './query-requester.js'

export const INDEX_SERVICE_PROTOCOL = `${SCOPED_NETWORK_PROTOCOL}/${PROTOCOL_MAJOR}/index`
export const MIN_INDEX_QUERY_FRAME_BYTES = 512


function fail(message) {
  const error = new Error(message)
  error.code = 'INDEX_SERVICE_PROTOCOL_REJECTED'
  throw error
}

function nowFrom(limits) {
  const value = typeof limits.now === 'function' ? limits.now() : (limits.now ?? Date.now())
  if (!Number.isSafeInteger(value) || value < 0) fail('current time must be a non-negative safe integer')
  return value
}

function exactConnectionKey(connection, field, label) {
  const key = connection?.[field]
  if ((!b4a.isBuffer(key) && !(key instanceof Uint8Array)) || key.byteLength !== 32) {
    fail(`connection must expose the live 32-byte ${label} transport key`)
  }
  return b4a.from(key)
}

function exactConfiguredLocalKey(value) {
  if ((!b4a.isBuffer(value) && !(value instanceof Uint8Array)) || value.byteLength !== 32) {
    fail('limits.localTransportPublicKey must be the trusted 32-byte local transport key')
  }
  return b4a.from(value)
}

function normalizeMaxFrameBytes(value) {
  const next = Number(value ?? MAX_INDEX_QUERY_FRAME_BYTES)
  if (!Number.isSafeInteger(next) || next < MIN_INDEX_QUERY_FRAME_BYTES || next > MAX_PEER_FRAME_BYTES) {
    fail('maxFrameBytes is outside the scoped protocol bound')
  }
  return next
}


function verifyAnnouncement(announcement, limits) {
  if (!(limits.sequenceState instanceof Map)) fail('limits.sequenceState Map is required')
  const currentTime = nowFrom(limits)
  const nextSequenceState = new Map(limits.sequenceState)
  if (!verifyIndexServiceAnnouncement(announcement, {
    sequenceState: nextSequenceState,
    now: currentTime,
    supportedDimensions: limits.supportedDimensions,
    supportedQueryCapabilities: limits.supportedQueryCapabilities || INDEX_SERVICE_QUERY_CAPABILITIES,
  })) fail('index service announcement is invalid, unsupported, or expired')
  return currentTime
}

function commitSequence(announcement, sequenceState) {
  const sequenceKey = b4a.toString(announcement.indexerId, 'hex')
  const hadPreviousSequence = sequenceState.has(sequenceKey)
  const previousSequence = sequenceState.get(sequenceKey)
  if (hadPreviousSequence && announcement.sequence <= previousSequence) fail('index service announcement sequence was superseded during setup')
  sequenceState.set(sequenceKey, announcement.sequence)
  return () => {
    if (sequenceState.get(sequenceKey) !== announcement.sequence) return
    if (hadPreviousSequence) sequenceState.set(sequenceKey, previousSequence)
    else sequenceState.delete(sequenceKey)
  }
}

function setupContext(connection, announcement, limits, peerKey) {
  const maxFrameBytes = normalizeMaxFrameBytes(limits.maxFrameBytes)
  const topic = deriveIndexerTopic({ protocolMajor: PROTOCOL_MAJOR, indexerId: b4a.toString(announcement.indexerId, 'hex') })
  const mux = limits.muxFactory ? limits.muxFactory(connection) : Protomux.from(connection)
  if (!mux || typeof mux.createChannel !== 'function') fail('Protomux is unavailable for index service connection')
  return { maxFrameBytes, topic, mux, peerId: b4a.toString(peerKey, 'hex') }
}

function localHello(topic, maxFrameBytes) {
  return encodeScopedHello({
    purpose: 'index',
    topic,
    protocolMajor: PROTOCOL_MAJOR,
    capabilities: [INDEX_QUERY_CAPABILITY],
    maxFrameBytes,
  })
}
function sameQueryServiceIdentity(left, right) {
  return b4a.equals(left.indexerId, right.indexerId) &&
    b4a.equals(left.transportPublicKey, right.transportPublicKey)
}



export function attachIndexServiceProtocol({ connection, announcement, indexStore, limits = {} } = {}) {
  if (!connection || typeof connection !== 'object') fail('connection is required')
  if (!indexStore || typeof indexStore.queryIndexPage !== 'function') fail('indexStore.queryIndexPage is required')
  verifyAnnouncement(announcement, limits)
  const persistentSequenceState = limits.sequenceState
  const localPublicKey = exactConfiguredLocalKey(limits.localTransportPublicKey)
  if (!b4a.equals(localPublicKey, announcement.transportPublicKey)) fail('local transport public key does not match the service announcement')
  const remotePublicKey = exactConnectionKey(connection, 'remotePublicKey', 'remote')
  const context = setupContext(connection, announcement, limits, remotePublicKey)
  let configuredAnnouncement = announcement
  let dispatcher = null
  let channel = null
  let message = null
  let closed = false
  let expiryTimer = null
  let responseId = 0
  let rollbackSequence = () => {}

  function clearExpiry() {
    if (expiryTimer === null) return
    ;(limits.clearTimeout || clearTimeout)(expiryTimer)
    expiryTimer = null
  }

  function send(type, payload) {
    if (closed || !message) return 'closed'
    if (responseId >= 0xffffffff) {
      close('query-response-id-exhausted')
      return 'closed'
    }
    const frame = encodePeerFrame({ purpose: 'index', type, requestId: ++responseId, payload })
    if (frame.byteLength > protocolSession.maxFrameBytes) return 'frame-too-large'
    if (message.send(frame) === false) {
      close('query-response-send-failed')
      return 'closed'
    }
    return 'sent'
  }

  dispatcher = createIndexQueryDispatcher({ indexStore, announcement, limits, send })
  const protocolSession = createScopedProtocolSession({
    peerId: context.peerId,
    purpose: 'index',
    topic: context.topic,
    protocolMajor: PROTOCOL_MAJOR,
    requiredCapability: INDEX_QUERY_CAPABILITY,
    maxFrameBytes: context.maxFrameBytes,
    admission: limits.admission,
    onActivate: limits.onActivate,
    onFrame(frame) { return dispatcher.onFrame(frame) },
    onClose(reason) { close(reason) },
  })

  function close(reason = 'closed') {
    if (closed) return false
    closed = true
    clearExpiry()
    context.mux.unpair?.({ protocol: INDEX_SERVICE_PROTOCOL, id: context.topic })
    dispatcher.close(reason)
    protocolSession.close(reason)
    try { channel?.close?.() } catch {}
    limits.onClose?.(reason)
    return true
  }

  function acceptIncomingChannel() {
    if (closed || channel) return
    try {
      const fallbackMessage = {
        encoding: c.buffer,
        autoBatch: false,
        send() { return false },
        onmessage(encoded) { protocolSession.receive(encoded).catch(error => close(error.code || error.message)) },
      }
      channel = context.mux.createChannel({
        protocol: INDEX_SERVICE_PROTOCOL,
        id: context.topic,
        handshake: c.buffer,
        messages: [fallbackMessage],
        async onopen(encoded) {
          try { await protocolSession.acceptHello(encoded) } catch (error) { close(error.code || error.message) }
        },
        onclose(isRemote) { close(isRemote ? 'remote-channel-closed' : 'local-channel-closed') },
      })
      if (!channel) fail('index service channel could not accept the remote query client')
      message = channel.messages[0]
      channel.open(localHello(context.topic, context.maxFrameBytes))
    } catch (error) {
      rollbackSequence()
      close(error.code || 'index-service-channel-accept-failed')
    }
  }

  rollbackSequence = commitSequence(announcement, persistentSequenceState)
  const setTimer = limits.setTimeout || setTimeout
  const scheduleExpiry = () => {
    if (closed) return
    const remaining = configuredAnnouncement.expiresAt - nowFrom(limits)
    if (remaining < 0) return close('announcement-expired')
    expiryTimer = setTimer(scheduleExpiry, Math.min(remaining + 1, 0x7fffffff))
    expiryTimer?.unref?.()
  }
  function refreshAnnouncement(nextAnnouncement) {
    if (closed) fail('index service protocol is closed')
    verifyAnnouncement(nextAnnouncement, { ...limits, sequenceState: persistentSequenceState })
    if (!sameQueryServiceIdentity(configuredAnnouncement, nextAnnouncement)) {
      fail('index service announcement identity changed')
    }
    const previousAnnouncement = configuredAnnouncement
    const previousTimer = expiryTimer
    const rollback = commitSequence(nextAnnouncement, persistentSequenceState)
    configuredAnnouncement = nextAnnouncement
    expiryTimer = null
    try {
      scheduleExpiry()
      dispatcher.refreshAnnouncement(nextAnnouncement)
    } catch (error) {
      if (expiryTimer !== null) {
        try { (limits.clearTimeout || clearTimeout)(expiryTimer) } catch {}
      }
      configuredAnnouncement = previousAnnouncement
      expiryTimer = previousTimer
      rollback()
      throw error
    }
    if (previousTimer !== null) {
      try { (limits.clearTimeout || clearTimeout)(previousTimer) } catch {}
    }
    return true
  }

  try {
    context.mux.pair({ protocol: INDEX_SERVICE_PROTOCOL, id: context.topic }, acceptIncomingChannel)
    scheduleExpiry()
  } catch (error) {
    rollbackSequence()
    close('index-service-setup-failed')
    throw error
  }
  rollbackSequence = () => {}

  return {
    get state() { return closed ? 'closed' : protocolSession.state === 'active' ? 'active' : channel ? 'handshaking' : 'listening' },
    get maxFrameBytes() { return protocolSession.maxFrameBytes },
    get pendingCount() { return dispatcher.pendingCount },
    get channel() { return channel },
    receive(encoded) { return protocolSession.receive(encoded) },
    refreshAnnouncement,
    close,
  }
}
function createClientSession(connection, announcement, limits, onClosed) {
  const remotePublicKey = exactConnectionKey(connection, 'remotePublicKey', 'remote')
  if (!b4a.equals(remotePublicKey, announcement.transportPublicKey)) fail('remote transport public key does not match the service announcement')
  const context = setupContext(connection, announcement, limits, remotePublicKey)
  let channel = null
  let message = null
  let requester = null
  let closed = false
  let requestId = 0
  let readyResolve
  let readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  ready.catch(() => {})

  function send(type, payload) {
    if (closed || !message) return 'closed'
    if (requestId >= 0xffffffff) {
      close('query-request-id-exhausted')
      return 'closed'
    }
    const frame = encodePeerFrame({ purpose: 'index', type, requestId: ++requestId, payload })
    if (frame.byteLength > protocolSession.maxFrameBytes) return 'frame-too-large'
    if (message.send(frame) === false) {
      close('query-request-send-failed')
      return 'closed'
    }
    return 'sent'
  }

  const protocolSession = createScopedProtocolSession({
    peerId: context.peerId,
    purpose: 'index',
    topic: context.topic,
    protocolMajor: PROTOCOL_MAJOR,
    requiredCapability: INDEX_QUERY_CAPABILITY,
    maxFrameBytes: context.maxFrameBytes,
    admission: limits.admission,
    onFrame(frame) { return requester.onFrame(frame) },
    onClose(reason) { close(reason) },
  })
  requester = createIndexQueryRequester({ limits, send, ready })

  function close(reason = 'closed') {
    if (closed) return false
    closed = true
    readyReject(new IndexQueryRemoteError('', INDEX_QUERY_ERROR_CODES.CLOSED, 'query channel closed'))
    requester.close(reason)
    protocolSession.close(reason)
    try { channel?.close?.() } catch {}
    onClosed(connection)
    return true
  }

  message = {
    encoding: c.buffer,
    autoBatch: false,
    send() { return false },
    onmessage(encoded) { protocolSession.receive(encoded).catch(error => close(error.code || error.message)) },
  }
  channel = context.mux.createChannel({
    protocol: INDEX_SERVICE_PROTOCOL,
    id: context.topic,
    handshake: c.buffer,
    messages: [message],
    async onopen(encoded) {
      try {
        await protocolSession.acceptHello(encoded)
        readyResolve()
      } catch (error) {
        readyReject(error)
        close(error.code || error.message)
      }
    },
    onclose(isRemote) { close(isRemote ? 'remote-channel-closed' : 'local-channel-closed') },
  })
  if (!channel) fail('index query client channel could not be created')
  message = channel.messages[0]
  channel.open(localHello(context.topic, context.maxFrameBytes))

  return {
    get pendingCount() { return requester.pendingCount },
    query: requester.query,
    suspend: requester.suspend,
    resume: requester.resume,
    close,
  }
}

export function createIndexQueryClient({ announcement, limits = {} } = {}) {
  verifyAnnouncement(announcement, limits)
  const rollbackInitialSequence = commitSequence(announcement, limits.sequenceState)
  const persistentSequenceState = limits.sequenceState
  let configuredAnnouncement = announcement
  let configuredLimits = limits
  const sessions = new Map()
  let closed = false
  let suspended = false
  let expiryTimer = null

  function suspendClient(reason = 'client-suspended') {
    if (closed || suspended) return false
    suspended = true
    for (const session of sessions.values()) session.suspend(reason)
    return true
  }

  function resumeClient() {
    if (closed || !suspended) return false
    suspended = false
    for (const session of sessions.values()) session.resume()
    return true
  }

  function closeClient(reason = 'client-closed') {
    if (closed) return false
    closed = true
    if (expiryTimer !== null) {
      ;(configuredLimits.clearTimeout || clearTimeout)(expiryTimer)
      expiryTimer = null
    }
    for (const session of [...sessions.values()]) session.close(reason)
    sessions.clear()
    return true
  }

  function scheduleExpiry() {
    if (closed) return
    const remaining = configuredAnnouncement.expiresAt - nowFrom(configuredLimits)
    if (remaining < 0) return closeClient('announcement-expired')
    expiryTimer = (configuredLimits.setTimeout || setTimeout)(scheduleExpiry, Math.min(remaining + 1, 0x7fffffff))
    expiryTimer?.unref?.()
  }
  try {
    scheduleExpiry()
  } catch (error) {
    rollbackInitialSequence()
    throw error
  }

  function refreshAnnouncement(nextAnnouncement, nextLimits = configuredLimits) {
    if (closed) fail('index query client is closed')
    const candidateLimits = { ...nextLimits, sequenceState: persistentSequenceState }
    verifyAnnouncement(nextAnnouncement, candidateLimits)
    if (!sameQueryServiceIdentity(configuredAnnouncement, nextAnnouncement)) {
      fail('index query client announcement identity changed')
    }
    const previousAnnouncement = configuredAnnouncement
    const previousLimits = configuredLimits
    const previousTimer = expiryTimer
    const rollback = commitSequence(nextAnnouncement, persistentSequenceState)
    configuredAnnouncement = nextAnnouncement
    configuredLimits = candidateLimits
    expiryTimer = null
    try {
      scheduleExpiry()
    } catch (error) {
      if (expiryTimer !== null) {
        try { (configuredLimits.clearTimeout || clearTimeout)(expiryTimer) } catch {}
      }
      configuredAnnouncement = previousAnnouncement
      configuredLimits = previousLimits
      expiryTimer = previousTimer
      rollback()
      throw error
    }
    if (previousTimer !== null) {
      try { (previousLimits.clearTimeout || clearTimeout)(previousTimer) } catch {}
    }
    return true
  }

  function forget(connection) { sessions.delete(connection) }
  function sessionFor(connection) {
    if (closed) fail('index query client is closed')
    if (suspended) fail('index query client is suspended')
    let session = sessions.get(connection)
    if (!session) {
      session = createClientSession(connection, configuredAnnouncement, configuredLimits, forget)
      sessions.set(connection, session)
    }
    return session
  }

  return Object.freeze({
    queryIndex({ connection, query, signal } = {}) {
      if (!connection || typeof connection !== 'object') return Promise.reject(new TypeError('connection is required'))
      if (!query || typeof query !== 'object') return Promise.reject(new TypeError('query is required'))
      if (closed) return Promise.reject(new IndexQueryRemoteError(
        typeof query?.queryId === 'string' ? query.queryId : '',
        INDEX_QUERY_ERROR_CODES.CLOSED,
        'index query client is closed',
      ))
      if (suspended) return Promise.reject(new IndexQueryRemoteError(
        typeof query?.queryId === 'string' ? query.queryId : '',
        INDEX_QUERY_ERROR_CODES.CLOSED,
        'index query client is suspended',
      ))
      try { return sessionFor(connection).query(query, signal) } catch (error) { return Promise.reject(error) }
    },
    get pendingCount() {
      let count = 0
      for (const session of sessions.values()) count += session.pendingCount
      return count
    },
    suspend(reason = 'client-suspended') {
      return suspendClient(reason)
    },
    resume() {
      return resumeClient()
    },
    refreshAnnouncement,
    close(reason = 'client-closed') {
      return closeClient(reason)
    },
  })
}

