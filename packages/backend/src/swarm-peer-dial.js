import b4a from 'b4a'

export function peerPublicKey(peer) {
  if (!peer) return null
  if (typeof peer === 'string' && /^[a-f0-9]{64}$/i.test(peer)) return b4a.from(peer, 'hex')
  if (b4a.isBuffer(peer) || peer instanceof Uint8Array) return peer
  const publicKey =
    peer.publicKey ||
    peer.remotePublicKey ||
    peer.key ||
    peer.value?.publicKey ||
    peer.value?.remotePublicKey ||
    peer.value?.key ||
    peer.peer?.publicKey ||
    peer.peer?.remotePublicKey ||
    peer[1]?.publicKey ||
    peer[1]?.remotePublicKey ||
    peer[1]?.key
  if (typeof publicKey === 'string' && /^[a-f0-9]{64}$/i.test(publicKey)) return b4a.from(publicKey, 'hex')
  if (publicKey && (b4a.isBuffer(publicKey) || publicKey instanceof Uint8Array)) return publicKey
  return null
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


export function swarmRememberPeer(swarm, peer, topic = null) {
  if (!swarm || !peer) return null
  const publicKey = peerPublicKey(peer)
  const keyHex = publicKey ? b4a.toString(publicKey, 'hex') : null
  if (!publicKey || !keyHex) return null
  let peerInfo = swarm.peers?.get?.(keyHex) || null
  if (!peerInfo && swarm.peers && typeof swarm.peers.get === 'function') {
    try { peerInfo = swarm.peers.get(publicKey) || null } catch { peerInfo = null }
  }
  if (!peerInfo) {
    peerInfo = {
      publicKey,
      relayAddresses: Array.isArray(peer.relayAddresses) ? peer.relayAddresses : [],
      topics: [],
    }
    try { swarm.peers?.set?.(keyHex, peerInfo) } catch { /* diagnostics only */ }
  }
  const relayAddresses = Array.isArray(peer.relayAddresses) ? peer.relayAddresses : []
  if (relayAddresses.length > 0 && (!Array.isArray(peerInfo.relayAddresses) || peerInfo.relayAddresses.length === 0)) {
    peerInfo.relayAddresses = relayAddresses
  }
  if (topic) {
    if (typeof peerInfo._topic === 'function') peerInfo._topic(topic)
    else {
      if (!Array.isArray(peerInfo.topics)) peerInfo.topics = []
      if (!peerInfo.topics.some((seen) => b4a.equals(seen, topic))) peerInfo.topics.push(topic)
    }
  }
  return peerInfo
}

export function swarmQueuePeer(swarm, peerInfo) {
  if (!swarm || !peerInfo) return false
  peerInfo.explicit = true
  if (typeof peerInfo._updatePriority === 'function') {
    try { peerInfo._updatePriority() } catch { /* best effort */ }
  }
  if (typeof swarm.joinPeer === 'function' && peerInfo.publicKey) {
    swarm.joinPeer(peerInfo.publicKey)
    peerInfo.queued = true
    return true
  }
  return false
}
