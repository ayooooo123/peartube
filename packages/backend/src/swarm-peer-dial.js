import b4a from 'b4a'

function toKeyBuffer(val) {
  if (!val) return null
  if (typeof val === 'string' && /^[a-f0-9]{64}$/i.test(val)) return b4a.from(val, 'hex')
  if (b4a.isBuffer(val) || val instanceof Uint8Array) return val
  return null
}

function extractPeerField(obj) {
  if (!obj || typeof obj !== 'object') return null
  return obj.publicKey || obj.remotePublicKey || obj.key || null
}

function extractCandidateKey(peer) {
  return (
    extractPeerField(peer) ||
    extractPeerField(peer.value) ||
    extractPeerField(peer.peer) ||
    extractPeerField(peer[1])
  )
}

export function peerPublicKey(peer) {
  const direct = toKeyBuffer(peer)
  if (direct) return direct
  if (!peer || typeof peer !== 'object') return null
  return toKeyBuffer(extractCandidateKey(peer))
}

export function peerKeyHex(peer) {
  const publicKey = peerPublicKey(peer)
  return publicKey ? b4a.toString(publicKey, 'hex') : null
}

export function peerMatchesKey(peer, keyHex) {
  const key = peerKeyHex(peer)
  return Boolean(key && key === keyHex)
}

export function swarmConnectionLike(entry) {
  const value = entry?.value || entry
  if (!value || typeof value !== 'object') return false
  return Boolean(
    value.stream ||
    value.rawStream ||
    value.opened ||
    value.open ||
    value.connected ||
    value.connectedTime >= 0
  )
}

export function swarmHasConnection(swarm, keyHex, _publicKey = null) {
  if (!swarm || !keyHex) return false
  const connections = swarm.connections
  if (connections && typeof connections[Symbol.iterator] === 'function') {
    for (const conn of connections) {
      if (peerMatchesKey(conn, keyHex)) return true
    }
  }
  return false
}


function lookupSwarmPeer(swarm, publicKey, keyHex, relayAddresses) {
  let peerInfo = swarm.peers?.get?.(keyHex) || null
  if (!peerInfo && swarm.peers && typeof swarm.peers.get === 'function') {
    try { peerInfo = swarm.peers.get(publicKey) || null } catch { peerInfo = null }
  }
  if (!peerInfo && typeof swarm._upsertPeer === 'function') {
    try { peerInfo = swarm._upsertPeer(publicKey, relayAddresses) || null } catch { peerInfo = null }
  }
  return peerInfo
}

function mergeRelayAddresses(peerInfo, relayAddresses) {
  if (relayAddresses.length > 0 && (!Array.isArray(peerInfo.relayAddresses) || peerInfo.relayAddresses.length === 0)) {
    peerInfo.relayAddresses = relayAddresses
  }
}

function attachPeerTopic(peerInfo, topic) {
  if (!topic) return
  if (typeof peerInfo._topic === 'function') {
    peerInfo._topic(topic)
    return
  }
  if (!Array.isArray(peerInfo.topics)) {
    peerInfo.topics = []
  }
  if (!peerInfo.topics.some((seen) => b4a.equals(seen, topic))) {
    peerInfo.topics.push(topic)
  }
}

export function swarmRememberPeer(swarm, peer, topic = null) {
  if (!swarm || !peer) return null
  const publicKey = peerPublicKey(peer)
  const keyHex = publicKey ? b4a.toString(publicKey, 'hex') : null
  if (!publicKey || !keyHex) return null
  const relayAddresses = Array.isArray(peer.relayAddresses) ? peer.relayAddresses : []
  const peerInfo = lookupSwarmPeer(swarm, publicKey, keyHex, relayAddresses)
  if (!peerInfo) {
    return {
      publicKey,
      relayAddresses,
      topics: topic ? [topic] : [],
      queued: false,
      waiting: false,
      explicit: false,
      synthetic: true,
    }
  }
  mergeRelayAddresses(peerInfo, relayAddresses)
  attachPeerTopic(peerInfo, topic)
  return peerInfo
}

export function swarmQueuePeer(_swarm, _peerInfo) {
  return false
}
