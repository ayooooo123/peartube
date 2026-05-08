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

function relayAddressesFromPeer(peer) {
  return Array.isArray(peer?.relayAddresses) && peer.relayAddresses.length > 0 ? peer.relayAddresses : null
}

function upsertPeerWithoutEmit(swarm, peer, publicKey, topic) {
  if (!swarm || !publicKey || !peer || typeof peer !== 'object') return null
  if (b4a.isBuffer(peer) || peer instanceof Uint8Array) return null

  const relayAddresses = relayAddressesFromPeer(peer)
  const keyHex = b4a.toString(publicKey, 'hex')
  const existing = swarm.peers?.get?.(keyHex) || null
  if (!relayAddresses) {
    if (existing && topic && typeof existing._topic === 'function') existing._topic(topic)
    return existing
  }

  if (typeof swarm._upsertPeer === 'function') {
    const peerInfo = swarm._upsertPeer(publicKey, relayAddresses)
    if (peerInfo && topic && typeof peerInfo._topic === 'function') peerInfo._topic(topic)
    return peerInfo
  }

  const handlePeer = swarm._peartubeHandlePeerWithoutEmit
  if (topic && typeof handlePeer === 'function') {
    return handlePeer.call(swarm, { publicKey, relayAddresses }, topic) || null
  }

  return null
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

export function ensureSwarmPeerConnection(swarm, peer, topic = null) {
  const publicKey = peerPublicKey(peer)
  if (!swarm || !publicKey) return { queued: false, reason: 'missing-peer' }
  const keyHex = b4a.toString(publicKey, 'hex')
  if (!keyHex || keyHex === b4a.toString(swarm.keyPair?.publicKey || [], 'hex')) {
    return { queued: false, reason: 'self-or-missing-key', keyHex, publicKey }
  }
  if (swarmHasConnection(swarm, keyHex)) {
    return { queued: false, reason: 'already-connected-peer', keyHex, publicKey }
  }

  try {
    const preservedPeerInfo = topic ? upsertPeerWithoutEmit(swarm, peer, publicKey, topic) : null

    const peerInfo = preservedPeerInfo || swarm.peers?.get?.(keyHex)
    if (peerInfo?.queued) {
      peerInfo.explicit = true
      swarm.explicitPeers?.add?.(peerInfo)
      return { queued: true, reason: 'queued', keyHex, publicKey }
    }
    if (peerInfo && typeof swarm._enqueue === 'function' && typeof peerInfo._updatePriority === 'function') {
      peerInfo.explicit = true
      swarm.explicitPeers?.add?.(peerInfo)
      if (!swarm._allConnections?.has?.(publicKey) && peerInfo._updatePriority()) {
        const queued = swarm._enqueue(peerInfo) !== false
        return { queued, reason: queued ? 'queued' : 'enqueue-skipped', keyHex, publicKey }
      }
      return { queued: false, reason: 'already-connecting', keyHex, publicKey }
    }

    if (typeof swarm.joinPeer === 'function') {
      swarm.joinPeer(publicKey)
      return { queued: true, reason: 'queued', keyHex, publicKey }
    }
    return { queued: false, reason: 'joinPeer-unavailable', keyHex, publicKey }
  } catch (err) {
    return {
      queued: false,
      reason: 'queue-error',
      keyHex,
      publicKey,
      errorMessage: err?.message || String(err),
      error: err?.stack || err?.message || String(err)
    }
  }
}
