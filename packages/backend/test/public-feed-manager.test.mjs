import assert from 'node:assert/strict'
import { Duplex } from 'node:stream'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

import Protomux from 'protomux'

import { PublicFeedManager } from '../src/public-feed.js'
import { NETWORK_TOPIC_STRING } from '../src/types.js'
const DRIVE_KEY = '11'.repeat(32)
const PUBLIC_BEE_KEY = '22'.repeat(32)
const NETWORK_TOPIC = crypto.data(b4a.from(NETWORK_TOPIC_STRING, 'utf-8'))
const OTHER_TOPIC = b4a.alloc(32, 99)

function createSwarm() {
  return {
    keyPair: { publicKey: b4a.alloc(32, 0) },
    connections: new Set(),
    peers: new Map(),
    joinCalls: [],
    joinPeerCalls: [],
    join(topic, opts) {
      this.joinCalls.push({ topic, opts })
      return {
        flushed() {
          return Promise.resolve()
        }
      }
    },
    joinPeer(publicKey) {
      this.joinPeerCalls.push(publicKey)
      return {}
    }
  }
}

function createMetaDb() {
  return {
    async get() {
      return null
    },
    async put() {}
  }
}

function createPersistedMetaDb(seed = {}) {
  const state = new Map(Object.entries(seed))
  return {
    async get(key) {
      return state.has(key) ? { value: state.get(key) } : null
    },
    async put(key, value) {
      state.set(key, value)
    },
    async del(key) {
      state.delete(key)
    },
    state,
  }
}

function createConnection() {
  return new EventEmitter()
}

class MemoryDuplex extends Duplex {
  constructor() {
    super()
    this.other = null
    this.userData = null
    this.remotePublicKey = null
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    this.other?.push(chunk)
    callback()
  }

  _final(callback) {
    this.other?.push(null)
    callback()
  }
}

function createMemoryConnectionPair() {
  const a = new MemoryDuplex()
  const b = new MemoryDuplex()
  a.other = b
  b.other = a
  a.remotePublicKey = b4a.alloc(32, 2)
  b.remotePublicKey = b4a.alloc(32, 1)
  return [a, b]
}

test('PublicFeedManager explicitly dials peers discovered on the shared topic', () => {
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())
  const publicKey = b4a.alloc(32, 7)

  try {
    assert.equal(manager.handleDiscoveredPeer({ publicKey }, NETWORK_TOPIC), true)
    assert.equal(swarm.joinPeerCalls.length, 1)
    assert.equal(b4a.toString(swarm.joinPeerCalls[0], 'hex'), b4a.toString(publicKey, 'hex'))
  } finally {
    manager.stop()
  }
})

test('PublicFeedManager ignores peers discovered on non-app topics', () => {
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())
  const publicKey = b4a.alloc(32, 17)

  try {
    assert.equal(manager.handleDiscoveredPeer({ publicKey }, OTHER_TOPIC), false)
    assert.equal(swarm.joinPeerCalls.length, 0)
    assert.equal(manager.getStats().directPeerDial.discoveredPeers, 0)
  } finally {
    manager.stop()
  }
})

test('PublicFeedManager directly dials discovered peers that are known but not connected', () => {
  const publicKey = b4a.alloc(32, 13)
  const keyHex = b4a.toString(publicKey, 'hex')
  const swarm = createSwarm()
  swarm.peers.set(keyHex, { publicKey })
  const manager = new PublicFeedManager(swarm, createMetaDb())

  try {
    assert.equal(manager.handleDiscoveredPeer({ publicKey }), true)
    assert.equal(swarm.joinPeerCalls.length, 1)
    assert.equal(b4a.toString(swarm.joinPeerCalls[0], 'hex'), keyHex)
  } finally {
    manager.stop()
  }
})

test('PublicFeedManager skips direct dials for actively connected peers across swarm shapes', () => {
  const publicKey = b4a.alloc(32, 8)
  const keyHex = b4a.toString(publicKey, 'hex')
  const cases = [
    (swarm) => { swarm.peers = new Map([[keyHex, { publicKey, connected: true }]]) },
    (swarm) => { swarm.peers = new Map([[publicKey, { publicKey, connected: true }]]) },
    (swarm) => { swarm.peers = new Set([{ publicKey, connected: true }]) },
    (swarm) => { swarm.peers = new Set([{ publicKey, stream: {} }]) },
    (swarm) => { swarm.connections.add({ remotePublicKey: publicKey }) },
    (swarm) => { swarm._allConnections = { has: (key) => b4a.equals(key, publicKey) } },
    (swarm) => { swarm.peers.set(keyHex, { publicKey, connectedTime: Date.now() }) },
  ]

  for (const setup of cases) {
    const swarm = createSwarm()
    setup(swarm)
    const manager = new PublicFeedManager(swarm, createMetaDb())

    try {
      assert.equal(manager.handleDiscoveredPeer({ publicKey }), false)
      assert.equal(swarm.joinPeerCalls.length, 0)
    } finally {
      manager.stop()
    }
  }
})

test('PublicFeedManager.start remembers existing discovered swarm peers for direct dialing', async () => {
  const publicKey = b4a.alloc(32, 14)
  const keyHex = b4a.toString(publicKey, 'hex')
  const swarm = createSwarm()
  swarm.peers.set(keyHex, { publicKey, topics: [NETWORK_TOPIC] })
  const manager = new PublicFeedManager(swarm, createMetaDb())

  try {
    await manager.start()
    assert.equal(swarm.joinPeerCalls.length, 1)
    assert.equal(b4a.toString(swarm.joinPeerCalls[0], 'hex'), keyHex)
  } finally {
    manager.stop()
  }
})

test('periodic gossip re-dials remembered shared-topic peers when sockets dropped', () => {
  const publicKey = b4a.alloc(32, 10)
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())
  let now = 1000
  manager._now = () => now

  try {
    assert.equal(manager.handleDiscoveredPeer({ publicKey }), true)
    assert.equal(swarm.joinPeerCalls.length, 1)
    now += manager._directPeerPendingTimeoutMs + 1
    assert.equal(manager._redialDiscoveredPeers(), 1)
    assert.equal(swarm.joinPeerCalls.length, 2)
  } finally {
    manager.stop()
  }
})

test('forceRedialDiscoveredPeers keeps trying known discovered peers after pending dial windows expire', () => {
  const publicKey = b4a.alloc(32, 11)
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())
  let now = 1000
  manager._now = () => now

  try {
    assert.equal(manager.handleDiscoveredPeer({ publicKey }), true)
    assert.equal(manager._redialDiscoveredPeers(), 0)
    now += manager._directPeerPendingTimeoutMs + 1
    assert.equal(manager._redialDiscoveredPeers(), 1)
    now += manager._directPeerPendingTimeoutMs + 1
    assert.equal(manager._redialDiscoveredPeers(), 1)
    now += manager._directPeerPendingTimeoutMs + 1
    assert.equal(manager._redialDiscoveredPeers(), 1)
    assert.equal(swarm.joinPeerCalls.length, 4)

    assert.equal(manager.forceRedialDiscoveredPeers(), 0)
    assert.equal(swarm.joinPeerCalls.length, 4)
    now += manager._directPeerPendingTimeoutMs + 1
    assert.equal(manager.forceRedialDiscoveredPeers(), 1)
    assert.equal(swarm.joinPeerCalls.length, 5)

    const stats = manager.getStats().directPeerDial
    assert.equal(stats.discoveredPeers, 1)
    assert.equal(stats.queued, 5)
    assert.equal(stats.lastReason, 'queued')
    assert.equal(stats.peers[0].attempts, 5)
  } finally {
    manager.stop()
  }
})

test('forceRedialDiscoveredPeers harvests swarm.peers candidates when no peer event was remembered', () => {
  const publicKey = b4a.alloc(32, 13)
  const swarm = createSwarm()
  swarm.peers.set(b4a.toString(publicKey, 'hex'), { publicKey, topics: [NETWORK_TOPIC] })
  const manager = new PublicFeedManager(swarm, createMetaDb())

  try {
    assert.equal(manager.forceRedialDiscoveredPeers(), 1)
    assert.equal(swarm.joinPeerCalls.length, 1)
    const stats = manager.getStats().directPeerDial
    assert.equal(stats.discoveredPeers, 1)
    assert.equal(stats.queued, 1)
    assert.equal(stats.peers[0].key, b4a.toString(publicKey, 'hex').slice(0, 16))
  } finally {
    manager.stop()
  }
})

test('forceRedialDiscoveredPeers skips swarm.peers candidates from non-app topics', () => {
  const publicKey = b4a.alloc(32, 18)
  const swarm = createSwarm()
  swarm.peers.set(b4a.toString(publicKey, 'hex'), { publicKey, topics: [OTHER_TOPIC] })
  const manager = new PublicFeedManager(swarm, createMetaDb())

  try {
    assert.equal(manager.forceRedialDiscoveredPeers(), 0)
    assert.equal(swarm.joinPeerCalls.length, 0)
    assert.equal(manager.getStats().directPeerDial.discoveredPeers, 0)
  } finally {
    manager.stop()
  }
})

test('direct peer dial diagnostics expose skipped joinPeer failures', () => {
  const publicKey = b4a.alloc(32, 12)
  const swarm = createSwarm()
  swarm.joinPeer = () => { throw new Error('dial unavailable') }
  const manager = new PublicFeedManager(swarm, createMetaDb())

  try {
    assert.equal(manager.handleDiscoveredPeer({ publicKey }), false)
    const stats = manager.getStats().directPeerDial
    assert.equal(stats.discoveredPeers, 1)
    assert.equal(stats.failed, 1)
    assert.equal(stats.lastReason, 'joinPeer-error')
    assert.equal(stats.peers[0].lastError, 'dial unavailable')
  } finally {
    manager.stop()
  }
})

test('direct peer dial diagnostics include Hyperswarm queue state', () => {
  const publicKey = b4a.alloc(32, 13)
  const keyHex = b4a.toString(publicKey, 'hex')
  const swarm = createSwarm()
  swarm.connecting = 1
  swarm._allConnections = new Set([{}])
  swarm.explicitPeers = new Set([publicKey])
  swarm._queue = { length: 2 }
  swarm.peers.set(keyHex, {
    publicKey,
    attempts: 2,
    queued: true,
    waiting: true,
    explicit: true,
    relayAddresses: [b4a.alloc(32, 1)],
    topics: [b4a.alloc(32, 2)],
    connectedTime: -1,
    disconnectedTime: 123,
  })
  const manager = new PublicFeedManager(swarm, createMetaDb())

  try {
    assert.equal(manager.handleDiscoveredPeer({ publicKey }), true)
    const stats = manager.getStats().directPeerDial
    assert.equal(stats.swarmConnecting, 1)
    assert.equal(stats.swarmAllConnections, 1)
    assert.equal(stats.swarmExplicitPeers, 1)
    assert.equal(stats.swarmQueueSize, 2)
    assert.deepEqual(stats.peers[0].swarm, {
      attempts: 2,
      queued: true,
      waiting: true,
      explicit: true,
      banned: false,
      proven: false,
      client: false,
      connectedTime: -1,
      disconnectedTime: 123,
      relayAddresses: 1,
      topics: 1,
    })
  } finally {
    manager.stop()
  }
})

test('PublicFeedManager.start joins shared PearTube network topic for feed-peer discovery', async () => {
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())

  try {
    await manager.start()
    assert.equal(swarm.joinCalls.length, 1)
    assert.equal(b4a.toString(swarm.joinCalls[0].topic, 'hex'), b4a.toString(crypto.data(b4a.from(NETWORK_TOPIC_STRING, 'utf-8')), 'hex'))
    assert.deepEqual(swarm.joinCalls[0].opts, { server: true, client: true })
  } finally {
    manager.stop()
  }
})

test('discovered peer dials remain pending until the Hyperswarm socket arrives', () => {
  const publicKey = b4a.alloc(32, 14)
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())
  manager._now = () => 12345

  try {
    assert.equal(manager.handleDiscoveredPeer({ publicKey }), true)
    assert.equal(swarm.joinPeerCalls.length, 1)
    assert.equal(manager.handleDiscoveredPeer({ publicKey }), false)
    assert.equal(swarm.joinPeerCalls.length, 1)

    const pendingStats = manager.getStats().directPeerDial
    assert.equal(pendingStats.pending, 1)
    assert.equal(pendingStats.lastReason, 'dial-already-pending')
    assert.equal(pendingStats.peers[0].pending, true)
    assert.equal(pendingStats.peers[0].connected, false)

    const conn = createConnection()
    conn.remotePublicKey = publicKey
    manager.handleConnection(conn, { publicKey })

    const connectedStats = manager.getStats().directPeerDial
    assert.equal(connectedStats.pending, 0)
    assert.equal(connectedStats.peers[0].pending, false)
    assert.equal(connectedStats.lastReason, 'connected')
    assert.equal(connectedStats.connected, 1)
  } finally {
    manager.stop()
  }
})

test('expired pending discovered peer dials are retried', () => {
  const publicKey = b4a.alloc(32, 15)
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())
  let now = 1000
  manager._now = () => now

  try {
    assert.equal(manager.handleDiscoveredPeer({ publicKey }), true)
    assert.equal(manager._redialDiscoveredPeers(), 0)
    assert.equal(swarm.joinPeerCalls.length, 1)

    now += manager._directPeerPendingTimeoutMs + 1
    assert.equal(manager._redialDiscoveredPeers(), 1)
    assert.equal(swarm.joinPeerCalls.length, 2)
    assert.equal(manager.getStats().directPeerDial.pending, 1)
  } finally {
    manager.stop()
  }
})

test('handleConnection immediately opens Protomux feed channel for connected discovered peer', () => {
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())
  const conn = createConnection()
  const pairCalls = []
  const createChannelCalls = []

  const originalFrom = Protomux.from
  Protomux.from = () => ({
    pair(opts, factory) {
      pairCalls.push(opts)
      return factory
    },
    createChannel(opts) {
      createChannelCalls.push(opts)
      return {
        messages: [{ send() {} }],
        open() {}
      }
    }
  })

  try {
    manager.handleConnection(conn, {})
    manager.handleConnection(conn, {})

    assert.equal(pairCalls.length, 1)
    assert.equal(createChannelCalls.length, 1)
  } finally {
    Protomux.from = originalFrom
    manager.stop()
  }
})

test('real Protomux feed channel exchanges local feed entries between two managers', async () => {
  const managerA = new PublicFeedManager(createSwarm(), createMetaDb())
  const managerB = new PublicFeedManager(createSwarm(), createMetaDb())
  const [connA, connB] = createMemoryConnectionPair()
  let updatesB = 0

  managerB.setOnFeedUpdate(() => { updatesB++ })
  managerA.addEntry(DRIVE_KEY, 'local', PUBLIC_BEE_KEY)

  try {
    managerA.handleConnection(connA, { publicKey: connA.remotePublicKey })
    managerB.handleConnection(connB, { publicKey: connB.remotePublicKey })

    const deadline = Date.now() + 2000
    let received = null
    while (Date.now() < deadline) {
      received = managerB.getFeed().find((entry) => entry.driveKey === DRIVE_KEY)
      if (received?.publicBeeKey === PUBLIC_BEE_KEY) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    assert.ok(received, 'peer B should receive peer A feed entry over real Protomux messages')
    assert.equal(received.publicBeeKey, PUBLIC_BEE_KEY)
    assert.equal(received.source, 'peer')
    assert.equal(updatesB > 0, true)
  } finally {
    managerA.stop()
    managerB.stop()
    connA.destroy()
    connB.destroy()
  }
})

test('periodic gossip does not send on feed channels before they open', () => {
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())
  const conn = createConnection()
  const sent = []

  manager.addEntry(DRIVE_KEY, 'local', PUBLIC_BEE_KEY)

  const originalFrom = Protomux.from
  Protomux.from = () => ({
    pair() {},
    createChannel() {
      return {
        messages: [{
          send(msg) {
            sent.push(msg)
          }
        }],
        open() {}
      }
    }
  })

  try {
    manager.handleConnection(conn, {})

    assert.equal(manager.peerChannels.size, 1)
    assert.equal(manager.feedConnections.size, 0)
    assert.equal(manager.requestFeedsFromPeers(), 0)
    manager.sendHaveFeed(conn)
    assert.equal(sent.length, 1, 'direct send still works for diagnostics/manual open paths')
    sent.length = 0

    const openConns = manager._openFeedConnections()
    assert.deepEqual(openConns, [])
    for (const openConn of openConns) manager.sendHaveFeed(openConn)
    assert.equal(sent.length, 0)
  } finally {
    Protomux.from = originalFrom
    manager.stop()
  }
})

test('feed channel open sends HAVE_FEED immediately', () => {
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())
  const conn = createConnection()
  const sent = []

  manager.addEntry(DRIVE_KEY, 'local', PUBLIC_BEE_KEY)

  const originalFrom = Protomux.from
  Protomux.from = () => ({
    pair() {},
    createChannel(opts) {
      return {
        messages: [{
          send(msg) {
            sent.push(msg)
          }
        }],
        open() {
          opts.onopen()
        }
      }
    }
  })

  try {
    manager.handleConnection(conn, {})

    assert.equal(sent.length, 2)
    assert.equal(sent[0].type, 'HAVE_FEED')
    assert.deepEqual(sent[0].keys, [DRIVE_KEY])
    assert.equal(sent[0].entries[0].driveKey, DRIVE_KEY)
    assert.equal(sent[0].entries[0].publicBeeKey, PUBLIC_BEE_KEY)
    assert.deepEqual(sent[1], { type: 'NEED_FEED' })
  } finally {
    Protomux.from = originalFrom
    manager.stop()
  }
})

test('feed channel open includes serving manifest snapshots when available', async () => {
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())
  const conn = createConnection()
  const sent = []

  manager.addEntry(DRIVE_KEY, 'local', PUBLIC_BEE_KEY)
  manager.setFeedSnapshotProvider(async () => [{
    driveKey: DRIVE_KEY,
    publicBeeKey: PUBLIC_BEE_KEY,
    channelName: 'Manifest Channel',
    videoCount: 2,
    manifestUpdatedAt: 42,
    previewVideos: [{
      id: 'preview-1',
      title: 'Manifest Video',
      uploadedAt: 42,
      blobId: '0:8:0:1024',
      blobsCoreKey: '33'.repeat(32),
      mimeType: 'video/mp4',
      availability: 'playable',
    }],
  }])

  const originalFrom = Protomux.from
  Protomux.from = () => ({
    pair() {},
    createChannel(opts) {
      return {
        messages: [{
          send(msg) {
            sent.push(msg)
          }
        }],
        open() {
          opts.onopen()
        }
      }
    }
  })

  try {
    manager.handleConnection(conn, {})
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(sent.length, 3)
    assert.equal(sent[0].type, 'HAVE_FEED')
    assert.equal(sent[0].entries[0].driveKey, DRIVE_KEY)
    assert.equal(sent[0].entries[0].publicBeeKey, PUBLIC_BEE_KEY)
    assert.deepEqual(sent[1], { type: 'NEED_FEED' })
    assert.equal(sent[2].type, 'HAVE_FEED')
    assert.equal(sent[2].entries[0].channelName, 'Manifest Channel')
    assert.equal(sent[2].entries[0].videoCount, 2)
    assert.equal(sent[2].entries[0].manifestUpdatedAt, 42)
    assert.equal(sent[2].entries[0].previewVideos[0].id, 'preview-1')
  } finally {
    Protomux.from = originalFrom
    manager.stop()
  }
})

test('getFeed keeps cached peer entries with publicBeeKey even when peerCount is zero', () => {
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())

  try {
    manager.addEntry(DRIVE_KEY, 'peer', PUBLIC_BEE_KEY)
    const feed = manager.getFeed()
    assert.equal(feed.length, 1)
    assert.equal(feed[0].driveKey, DRIVE_KEY)
    assert.equal(feed[0].publicBeeKey, PUBLIC_BEE_KEY)
    assert.equal(feed[0].peerCount, 0)
  } finally {
    manager.stop()
  }
})

test('keyed peer entries survive persistence and restart even when peerCount is zero', async () => {
  const metaDb = createPersistedMetaDb()
  const first = new PublicFeedManager(createSwarm(), metaDb)

  try {
    first.addEntry(DRIVE_KEY, 'peer', PUBLIC_BEE_KEY, {
      channelName: 'Persisted Channel',
      manifestUpdatedAt: 55,
      previewVideos: [{
        id: 'preview-persisted',
        title: 'Persisted preview',
        uploadedAt: 55,
        availability: 'playable',
      }],
    })

    await first._persistDiscoveredNow()

    const persisted = metaDb.state.get('discovered-channels-v2')
    assert.equal(Array.isArray(persisted), true)
    assert.equal(persisted.length, 1)
    assert.equal(persisted[0].driveKey, DRIVE_KEY)
    assert.equal(persisted[0].publicBeeKey, PUBLIC_BEE_KEY)
  } finally {
    first.stop()
  }

  const second = new PublicFeedManager(createSwarm(), metaDb)
  try {
    await second.start()
    const feed = second.getFeed()
    assert.equal(feed.length, 1)
    assert.equal(feed[0].driveKey, DRIVE_KEY)
    assert.equal(feed[0].publicBeeKey, PUBLIC_BEE_KEY)
    assert.equal(feed[0].peerCount, 0)
  } finally {
    second.stop()
  }
})

test('addEntry accepts legacy peer entries without publicBeeKey', () => {
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())

  try {
    const added = manager.addEntry(DRIVE_KEY, 'peer')
    assert.equal(added, true)
    const entry = manager.entries.get(DRIVE_KEY)
    assert.ok(entry)
    assert.equal(entry.publicBeeKey, null)
    assert.equal(entry.source, 'peer')
  } finally {
    manager.stop()
  }
})

test('availability hint request is answered on the existing feed channel', async () => {
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())
  const conn = createConnection()
  const sent = []

  manager.setAvailabilityHintProvider(async (requests) => requests.map((req) => ({
    driveKey: req.driveKey,
    id: req.id,
    availability: 'playable',
    contiguousBlocks: 12,
    hasHeadBlock: true,
    lastSeenAt: 123,
    activelyServing: true,
  })))

  const originalFrom = Protomux.from
  Protomux.from = () => ({
    pair() {},
    createChannel() {
      return {
        messages: [{ send(msg) { sent.push(msg) } }],
        open() {},
      }
    }
  })

  try {
    manager.handleConnection(conn, {})
    manager.handleMessage({
      type: 'AVAILABILITY_HINT_REQUEST',
      requestId: 'req-1',
      requests: [{ driveKey: DRIVE_KEY, id: 'v1', blobsCoreKey: '33'.repeat(32), blobId: '1:2:3:4' }],
    }, conn)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const response = sent.find((msg) => msg.type === 'AVAILABILITY_HINT_RESPONSE')
    assert.ok(response)
    assert.equal(response.requestId, 'req-1')
    assert.equal(response.hints[0].availability, 'playable')
  } finally {
    Protomux.from = originalFrom
    manager.stop()
  }
})

test('requestFeedsFromPeers sends NEED_FEED so peers reply with their feed', () => {
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())
  const conn = createConnection()
  const sent = []

  const originalFrom = Protomux.from
  Protomux.from = () => ({
    pair() {},
    createChannel(opts) {
      return {
        messages: [{ send(msg) { sent.push(msg) } }],
        open() { opts.onopen() },
      }
    }
  })

  try {
    manager.handleConnection(conn, {})
    const count = manager.requestFeedsFromPeers()
    assert.equal(count, 1)
    assert.deepEqual(sent[sent.length - 1], { type: 'NEED_FEED' })
  } finally {
    Protomux.from = originalFrom
    manager.stop()
  }
})

test('periodic feed gossip resends HAVE_FEED and NEED_FEED on existing client connections', async () => {
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())
  const conn = createConnection()
  const sent = []

  manager._gossipIntervalMs = 10
  manager.addEntry(DRIVE_KEY, 'local', PUBLIC_BEE_KEY)

  const originalFrom = Protomux.from
  Protomux.from = () => ({
    pair() {},
    createChannel(opts) {
      return {
        messages: [{ send(msg) { sent.push(msg) } }],
        open() { opts.onopen() },
      }
    }
  })

  try {
    await manager.start()
    manager.handleConnection(conn, {})
    sent.length = 0

    await new Promise((resolve) => setTimeout(resolve, 35))

    assert.ok(sent.some((msg) => msg.type === 'HAVE_FEED'), 'gossip loop should re-announce local feed entries')
    assert.ok(sent.some((msg) => msg.type === 'NEED_FEED'), 'gossip loop should request peer feed refresh')
  } finally {
    Protomux.from = originalFrom
    manager.stop()
  }
})

test('periodic feed gossip re-dials discovered peers after their connection closes', async () => {
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())
  const publicKey = b4a.alloc(32, 9)
  const keyHex = b4a.toString(publicKey, 'hex')
  const conn = createConnection()
  let now = 1000

  manager._gossipIntervalMs = 10
  manager._now = () => now

  try {
    await manager.start()
    assert.equal(manager.handleDiscoveredPeer({ publicKey }), true)
    assert.equal(swarm.joinPeerCalls.length, 1)

    swarm.peers.set(keyHex, { publicKey })
    manager.handleConnection(conn, {})
    conn.emit('close')
    swarm.peers.delete(keyHex)
    now += manager._directPeerPendingTimeoutMs + 1

    await new Promise((resolve) => setTimeout(resolve, 35))

    assert.ok(swarm.joinPeerCalls.length >= 2, 'gossip loop should re-dial a remembered peer after disconnect')
    assert.equal(b4a.toString(swarm.joinPeerCalls.at(-1), 'hex'), keyHex)
  } finally {
    manager.stop()
  }
})

test('peer entries with publicBeeKey survive peer disconnect at peerCount zero', () => {
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())
  const conn = createConnection()

  try {
    manager.addEntry(DRIVE_KEY, 'peer', PUBLIC_BEE_KEY)
    manager.peerFeedKeys.set(conn, new Set([DRIVE_KEY]))
    manager.entryPeerCounts.set(DRIVE_KEY, 1)

    manager._clearPeerFeedKeys(conn)

    const entry = manager.entries.get(DRIVE_KEY)
    assert.ok(entry)
    assert.equal(entry.source, 'peer')
    assert.equal(manager.entryPeerCounts.has(DRIVE_KEY), false)
  } finally {
    manager.stop()
  }
})

test('peer disconnect notifies listeners when a cached keyed entry loses live announcers', () => {
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())
  const conn = createConnection()
  let updates = 0

  manager.setOnFeedUpdate(() => {
    updates += 1
  })

  try {
    manager.addEntry(DRIVE_KEY, 'peer', PUBLIC_BEE_KEY)
    manager.peerFeedKeys.set(conn, new Set([DRIVE_KEY]))
    manager.entryPeerCounts.set(DRIVE_KEY, 1)

    manager._clearPeerFeedKeys(conn)

    assert.equal(updates, 1)
    assert.equal(manager.getFeed()[0]?.peerCount, 0)
  } finally {
    manager.stop()
  }
})

test('handle HAVE_FEED stores serving manifest data on the entry', () => {
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())
  const conn = createConnection()

  try {
    manager.handleMessage({
      type: 'HAVE_FEED',
      entries: [{
        driveKey: DRIVE_KEY,
        publicBeeKey: PUBLIC_BEE_KEY,
        channelName: 'Manifest Channel',
        videoCount: 3,
        manifestUpdatedAt: 99,
        previewVideos: [{
          id: 'preview-2',
          title: 'Preview',
          uploadedAt: 99,
          blobId: '0:8:0:1024',
          blobsCoreKey: '44'.repeat(32),
          mimeType: 'video/mp4',
          availability: 'playable',
        }],
      }],
    }, conn)

    const feed = manager.getFeed()
    assert.equal(feed.length, 1)
    assert.equal(feed[0].channelName, 'Manifest Channel')
    assert.equal(feed[0].videoCount, 3)
    assert.equal(feed[0].manifestUpdatedAt, 99)
    assert.equal(feed[0].previewVideos[0].id, 'preview-2')
  } finally {
    manager.stop()
  }
})

test('requestAvailabilityHints merges playable responses from feed peers (including relayed peers on same channel)', async () => {
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())
  const conn = createConnection()
  const sent = []

  const originalFrom = Protomux.from
  Protomux.from = () => ({
    pair() {},
    createChannel() {
      return {
        messages: [{ send(msg) { sent.push(msg) } }],
        open() {},
      }
    }
  })

  try {
    manager.handleConnection(conn, {})
    manager.feedConnections.add(conn)
    const promise = manager.requestAvailabilityHints([
      { driveKey: DRIVE_KEY, id: 'v1', blobsCoreKey: '33'.repeat(32), blobId: '1:2:3:4' }
    ], { timeoutMs: 100, maxPeers: 1 })

    const request = sent.find((msg) => msg.type === 'AVAILABILITY_HINT_REQUEST')
    assert.ok(request)
    manager.handleMessage({
      type: 'AVAILABILITY_HINT_RESPONSE',
      requestId: request.requestId,
      hints: [{ driveKey: DRIVE_KEY, id: 'v1', availability: 'playable', hasHeadBlock: true, contiguousBlocks: 8 }]
    }, conn)

    const hints = await promise
    assert.equal(hints.length, 1)
    assert.equal(hints[0].availability, 'playable')
  } finally {
    Protomux.from = originalFrom
    manager.stop()
  }
})


test('relay catalog entries stay visible and do not become published channels', async (t) => {
  const feed = new PublicFeedManager({
    connections: new Set(),
    peers: new Set(),
    join() { return { flushed: async () => {} } },
  }, {
    async get() { return null },
    async put() {},
  })

  await feed.submitRelayCatalogEntry({
    driveKey: 'aa'.repeat(32),
    publicBeeKey: 'bb'.repeat(32),
    previewVideos: [{
      id: 'relay-video',
      blobId: '0:4:0:512',
      blobsCoreKey: 'cc'.repeat(32),
      availability: 'playable',
    }],
  })

  assert.equal(feed.isChannelPublished('aa'.repeat(32)), false)
  const entries = feed.getFeed()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].source, 'relay-cache')
  assert.equal(entries[0].relayRole, 'cache')
  assert.equal(entries[0].relayServing, true)
  assert.equal(entries[0].peerCount, 0)
})
