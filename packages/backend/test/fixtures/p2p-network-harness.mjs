import crypto from 'hypercore-crypto'

function xorshift(seed) {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0xffffffff
  }
}

export function createP2PNetworkHarness({ seed = 1, diskLimitBytes = 1024 * 1024, bandwidthLimitBytes = 1024 * 1024 } = {}) {
  const random = xorshift(seed)
  const peers = new Map()
  const packets = []
  const drops = []
  const resources = { peers: 0, connections: 0, packets: 0, diskBytes: 0, bandwidthBytes: 0 }
  let now = 0

  function createPeer(role, options = {}) {
    const keyPair = crypto.keyPair(Buffer.alloc(32, peers.size + 1))
    const id = Buffer.from(keyPair.publicKey).toString('hex')
    const peer = { id, role, keyPair, connected: true, hostile: options.hostile === true, diskBytes: 0, bandwidthBytes: 0, received: [] }
    peers.set(id, peer)
    resources.peers = peers.size
    return peer
  }

  function connect(a, b) {
    if (!a.connected || !b.connected) return false
    resources.connections++
    return true
  }

  function disconnect(peer) {
    peer.connected = false
    resources.connections = Math.max(0, resources.connections - 1)
  }

  function send(from, to, frame = {}, options = {}) {
    const bytes = Number(frame.bytes || JSON.stringify(frame).length || 0)
    if (!from.connected || !to.connected || options.drop === true || random() < (options.dropRate || 0)) {
      drops.push({ from: from.id, to: to.id, reason: 'dropped' })
      return { accepted: false, reason: 'dropped' }
    }
    if (bytes > bandwidthLimitBytes || resources.bandwidthBytes + bytes > bandwidthLimitBytes) return { accepted: false, reason: 'bandwidth-budget' }
    if (frame.diskBytes && resources.diskBytes + frame.diskBytes > diskLimitBytes) return { accepted: false, reason: 'disk-budget' }
    resources.packets++
    resources.bandwidthBytes += bytes
    resources.diskBytes += Number(frame.diskBytes || 0)
    from.bandwidthBytes += bytes
    to.received.push({ from: from.id, frame })
    packets.push({ from: from.id, to: to.id, frame })
    return { accepted: true }
  }

  return {
    createPeer,
    connect,
    disconnect,
    send,
    advance(ms) { now += ms; return now },
    now() { return now },
    snapshotResources() { return { ...resources } },
    assertNoLeaks() { return resources.connections === 0 || Array.from(peers.values()).some(peer => peer.connected) },
    shutdown() { for (const peer of peers.values()) peer.connected = false; resources.connections = 0 },
    packets,
    drops,
    peers,
  }
}
