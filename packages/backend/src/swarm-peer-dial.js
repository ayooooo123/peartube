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

export function swarmHasConnection(swarm, keyHex, publicKey = null) {
  if (!swarm || !keyHex) return false
  const connections = swarm.connections
  if (connections && typeof connections[Symbol.iterator] === 'function') {
    for (const conn of connections) {
      if (peerMatchesKey(conn, keyHex)) return true
    }
  }
  const all = swarm._allConnections
  if (all && typeof all[Symbol.iterator] === 'function') {
    for (const entry of all) {
      if (entry && typeof entry === 'object' && swarmConnectionLike(entry) && peerMatchesKey(entry, keyHex)) return true
    }
  }
  const peers = swarm.peers
  if (peers && typeof peers.get === 'function') {
    let peerInfo = peers.get(keyHex)
    if (!peerInfo && publicKey) {
      try {
        peerInfo = peers.get(publicKey)
      } catch {
        peerInfo = null
      }
    }
    if (swarmConnectionLike(peerInfo)) return true
  }
  if (peers && typeof peers[Symbol.iterator] === 'function') {
    for (const peer of peers) {
      if (swarmConnectionLike(peer) && peerMatchesKey(peer, keyHex)) return true
    }
  }
  return false
}
