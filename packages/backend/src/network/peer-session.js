import b4a from 'b4a'
import { createNetworkAdmission } from './admission.js'

function sameTopic(a, b) {
  return b4a.equals(b4a.from(a || []), b4a.from(b || []))
}

let nextPeerId = 1

function createSession({ purpose, topic, protocolMajor = 1, features = [], localLimits = {}, admission, peerId, remote = null }) {
  const handlers = new Map()
  const session = {
    peerId: peerId || `peer-${nextPeerId++}`,
    purpose,
    topic,
    protocolMajor,
    features: new Set(features),
    localLimits: { maxFrameBytes: 64 * 1024, ...localLimits },
    negotiatedLimits: null,
    state: 'noise-authenticated',
    remote,
    handle(type, handler) {
      handlers.set(type, handler)
    },
    async handshake(remoteHello = {}) {
      if (session.state === 'closed') throw new Error('session closed')
      const proposedPurpose = remoteHello.purpose || purpose
      const proposedTopic = remoteHello.topic || topic
      const proposedMajor = remoteHello.protocolMajor || protocolMajor
      if (proposedPurpose !== purpose) throw new Error('purpose mismatch')
      if (!sameTopic(proposedTopic, topic)) throw new Error('topic mismatch')
      if (proposedMajor !== protocolMajor) throw new Error('major mismatch')
      const remoteLimits = session.remote?.localLimits || remoteHello.limits || {}
      session.negotiatedLimits = {
        maxFrameBytes: Math.min(session.localLimits.maxFrameBytes, remoteLimits.maxFrameBytes || session.localLimits.maxFrameBytes),
      }
      session.state = 'active'
      if (session.remote) {
        session.remote.negotiatedLimits = { ...session.negotiatedLimits }
        session.remote.state = 'active'
      }
      return { purpose, topic, protocolMajor, limits: session.negotiatedLimits, features: Array.from(session.features) }
    },
    async request({ type, payload = b4a.alloc(0), verify = false } = {}) {
      if (session.state !== 'active') throw new Error('handshake required')
      const remote = session.remote
      const handler = remote?.getHandler(type)
      if (!handler) throw new Error('unknown handler')
      const reservation = admission.reserve({ peerId: session.peerId, bytes: payload.byteLength || 0, verify })
      if (!reservation.accepted) throw new Error(reservation.reason)
      try {
        const response = await handler(payload, { peerId: session.peerId, purpose })
        reservation.release('complete')
        return response || { type: 'ok', payload: b4a.alloc(0) }
      } catch (error) {
        reservation.release('error')
        throw error
      }
    },
    reserveForTest({ bytes = 0, verify = false } = {}) {
      return admission.reserve({ peerId: session.peerId, bytes, verify })
    },
    getHandler(type) {
      return handlers.get(type)
    },
    close(reason = 'closed') {
      session.state = 'closed'
      admission.disconnect(session.peerId)
      session.closeReason = reason
    },
  }
  return session
}

export function createPeerSessionPair(options = {}) {
  const admission = options.admission?.reserve ? options.admission : createNetworkAdmission(options.admission || {})
  const base = {
    purpose: options.purpose || 'asset',
    topic: options.topic || b4a.alloc(32),
    protocolMajor: options.protocolMajor || 1,
    features: options.features || [],
  }
  const client = createSession({ ...base, localLimits: options.localLimits || {}, admission })
  const server = createSession({ ...base, localLimits: options.remoteLimits || options.localLimits || {}, admission })
  client.remote = server
  server.remote = client
  return { client, server, admission }
}
