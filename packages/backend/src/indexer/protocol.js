import b4a from 'b4a'
import c from 'compact-encoding'
import Protomux from 'protomux'

import { MAX_PEER_FRAME_BYTES } from '../network/frame.js'
import {
  INDEX_QUERY_CAPABILITY,
  SCOPED_NETWORK_PROTOCOL,
  createScopedProtocolSession,
  encodeScopedHello,
} from '../network/scoped-runtime.js'
import { deriveIndexTopic } from '../network/topics.js'
import { PROTOCOL_MAJOR } from '../network/version.js'
import {
  INDEX_SERVICE_QUERY_CAPABILITIES,
  verifyIndexServiceAnnouncement,
} from './service-announcement.js'

export const INDEX_SERVICE_PROTOCOL = `${SCOPED_NETWORK_PROTOCOL}/${PROTOCOL_MAJOR}/index`

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

function liveRemoteKey(connection) {
  const key = connection?.remotePublicKey
  if ((!b4a.isBuffer(key) && !(key instanceof Uint8Array)) || key.byteLength !== 32) {
    fail('connection must expose the live 32-byte remote transport key')
  }
  return b4a.from(key)
}

function normalizeMaxFrameBytes(value) {
  const next = Number(value ?? MAX_PEER_FRAME_BYTES)
  if (!Number.isSafeInteger(next) || next < 32 || next > MAX_PEER_FRAME_BYTES) {
    fail('maxFrameBytes is outside the scoped protocol bound')
  }
  return next
}

export function attachIndexServiceProtocol({ connection, announcement, indexStore, limits = {} } = {}) {
  if (!connection || typeof connection !== 'object') fail('connection is required')
  if (!indexStore || typeof indexStore !== 'object') fail('indexStore is required')
  if (!(limits.sequenceState instanceof Map)) fail('limits.sequenceState Map is required')
  const remotePublicKey = liveRemoteKey(connection)
  const currentTime = nowFrom(limits)
  const supportedQueryCapabilities = limits.supportedQueryCapabilities || INDEX_SERVICE_QUERY_CAPABILITIES
  const nextSequenceState = new Map(limits.sequenceState)
  if (!verifyIndexServiceAnnouncement(announcement, {
    sequenceState: nextSequenceState,
    now: currentTime,
    supportedDimensions: limits.supportedDimensions,
    supportedQueryCapabilities,
  })) {
    fail('index service announcement is invalid, unsupported, or expired')
  }
  if (!b4a.equals(remotePublicKey, announcement.transportPublicKey)) fail('transport public key mismatch')

  const maxFrameBytes = normalizeMaxFrameBytes(limits.maxFrameBytes)
  const topic = deriveIndexTopic({ protocolMajor: PROTOCOL_MAJOR, indexerId: b4a.toString(announcement.indexerId, 'hex') })
  const mux = limits.muxFactory ? limits.muxFactory(connection) : Protomux.from(connection)
  if (!mux || typeof mux.createChannel !== 'function') fail('Protomux is unavailable for index service connection')

  let channel = null
  let closed = false
  let expiryTimer = null

  const protocolSession = createScopedProtocolSession({
    peerId: b4a.toString(remotePublicKey, 'hex'),
    purpose: 'index',
    topic,
    protocolMajor: PROTOCOL_MAJOR,
    requiredCapability: INDEX_QUERY_CAPABILITY,
    maxFrameBytes,
    admission: limits.admission,
    onActivate: limits.onActivate,
    onFrame() {
      fail('index query dispatch is not available in the handshake protocol')
    },
    onClose(reason) {
      close(reason)
    },
  })

  function clearExpiry() {
    if (expiryTimer === null) return
    const clearTimer = limits.clearTimeout || clearTimeout
    clearTimer(expiryTimer)
    expiryTimer = null
  }

  function close(reason = 'closed') {
    if (closed) return false
    closed = true
    clearExpiry()
    protocolSession.close(reason)
    try { channel?.close?.() } catch {}
    limits.onClose?.(reason)
    return true
  }

  const message = {
    encoding: c.buffer,
    autoBatch: false,
    onmessage(encoded) {
      protocolSession.receive(encoded).catch(error => close(error.code || error.message))
    },
  }

  channel = mux.createChannel({
    protocol: INDEX_SERVICE_PROTOCOL,
    id: topic,
    handshake: c.buffer,
    messages: [message],
    async onopen(encoded) {
      try {
        await protocolSession.acceptHello(encoded)
      } catch (error) {
        close(error.code || error.message)
      }
    },
    onclose() {
      close('channel-closed')
    },
  })
  if (!channel) fail('index service channel could not be created')

  const setTimer = limits.setTimeout || setTimeout
  if (typeof setTimer !== 'function') fail('setTimeout must be a function')
  const scheduleExpiry = () => {
    if (closed) return
    const remaining = announcement.expiresAt - nowFrom(limits)
    if (remaining < 0) {
      close('announcement-expired')
      return
    }
    expiryTimer = setTimer(scheduleExpiry, Math.min(remaining + 1, 0x7fffffff))
    expiryTimer?.unref?.()
  }

  const localHello = encodeScopedHello({
    purpose: 'index',
    topic,
    protocolMajor: PROTOCOL_MAJOR,
    capabilities: [INDEX_QUERY_CAPABILITY],
    maxFrameBytes,
  })
  const sequenceKey = b4a.toString(announcement.indexerId, 'hex')
  const hadPreviousSequence = limits.sequenceState.has(sequenceKey)
  const previousSequence = limits.sequenceState.get(sequenceKey)
  if (hadPreviousSequence && announcement.sequence <= previousSequence) {
    close('index-service-sequence-raced')
    fail('index service announcement sequence was superseded during setup')
  }
  limits.sequenceState.set(sequenceKey, announcement.sequence)
  try {
    channel.open(localHello)
    scheduleExpiry()
  } catch (error) {
    if (limits.sequenceState.get(sequenceKey) === announcement.sequence) {
      if (hadPreviousSequence) limits.sequenceState.set(sequenceKey, previousSequence)
      else limits.sequenceState.delete(sequenceKey)
    }
    close('index-service-setup-failed')
    throw error
  }

  return {
    get state() { return closed ? 'closed' : protocolSession.state === 'active' ? 'active' : 'handshaking' },
    get maxFrameBytes() { return protocolSession.maxFrameBytes },
    get channel() { return channel },
    receive(encoded) { return protocolSession.receive(encoded) },
    close,
  }
}
