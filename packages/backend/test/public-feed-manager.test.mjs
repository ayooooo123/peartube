import assert from 'node:assert/strict'
import { Duplex } from 'node:stream'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

import Protomux from 'protomux'

import { PublicFeedManager } from '../src/public-feed.js'
import { NETWORK_TOPIC_STRING } from '../src/types.js'
import { SIGNED_CHANNEL_ROOT_DESCRIPTOR_SCHEMA, CHANNEL_ROOT_DESCRIPTOR_SCHEMA } from '../src/channel-descriptor.js'
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
    fallbackJoinPeerCalls: [],
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
      this.fallbackJoinPeerCalls.push(publicKey)
      return {}
    },
    _upsertPeer(publicKey, relayAddresses) {
      const keyHex = b4a.toString(publicKey, 'hex')
      let peerInfo = this.peers.get(keyHex)
      if (!peerInfo) {
        peerInfo = {
          publicKey,
          relayAddresses,
          topics: [],
          _topic(topic) {
            if (topic && !this.topics.some((seen) => b4a.equals(seen, topic))) this.topics.push(topic)
          },
          _updatePriority() { return !this.queued }
        }
        this.peers.set(keyHex, peerInfo)
        return peerInfo
      }
      if (relayAddresses) peerInfo.relayAddresses = relayAddresses
      return peerInfo
    },
    _handlePeer(peer, topic) {
      const peerInfo = this._upsertPeer(peer.publicKey, peer.relayAddresses)
      if (!peerInfo) return peerInfo
      if (topic) peerInfo._topic(topic)
      if (peerInfo._updatePriority()) this._enqueue(peerInfo)
      return peerInfo
    },
    _enqueue(peerInfo) {
      peerInfo.queued = true
      this.joinPeerCalls.push(peerInfo.publicKey)
      return true
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

test('PublicFeedManager records peers discovered on the shared topic without app-level redialing', () => {
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())
  const publicKey = b4a.alloc(32, 7)

  try {
    assert.equal(manager.handleDiscoveredPeer({ publicKey }, NETWORK_TOPIC), true)
    assert.equal(swarm.joinPeerCalls.length, 0)
    const stats = manager.getStats().directPeerDial
    assert.equal(stats.discoveredPeers, 1)
    assert.equal(stats.queued, 0)
    assert.equal(stats.pending, 0)
    assert.equal(stats.peers[0].key, b4a.toString(publicKey, 'hex').slice(0, 16))
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

test('PublicFeedManager keeps discovered relay address hints as Hyperswarm diagnostics', () => {
  const publicKey = b4a.alloc(32, 14)
  const keyHex = b4a.toString(publicKey, 'hex')
  const relayAddresses = [{ host: '167.86.111.230', port: 49737 }]
  const swarm = createSwarm()
  swarm._handlePeer({ publicKey, relayAddresses }, NETWORK_TOPIC)
  const manager = new PublicFeedManager(swarm, createMetaDb())
  swarm.joinPeerCalls.length = 0

  try {
    assert.equal(manager.handleDiscoveredPeer({ publicKey, relayAddresses }, NETWORK_TOPIC), true)
    assert.equal(swarm.joinPeerCalls.length, 0)
    assert.equal(swarm.peers.get(keyHex).relayAddresses, relayAddresses)
    assert.deepEqual(swarm.peers.get(keyHex).topics, [NETWORK_TOPIC])
    assert.equal(manager.getStats().directPeerDial.peers[0].swarm.relayAddresses, 1)
  } finally {
    manager.stop()
  }
})

test('PublicFeedManager does not recurse through the storage peer emitter wrapper', () => {
  const publicKey = b4a.alloc(32, 16)
  const keyHex = b4a.toString(publicKey, 'hex')
  const relayAddresses = [
    { host: '167.86.111.230', port: 49737 },
    { host: '150.136.237.154', port: 38619 },
    { host: '193.123.77.4', port: 49737 },
  ]
  const swarm = createSwarm()
  const listeners = new Map()
  let emitted = 0
  const originalHandlePeer = swarm._handlePeer

  swarm.on = (event, listener) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(listener)
    return swarm
  }
  swarm.emit = (event, ...args) => {
    emitted++
    for (const listener of listeners.get(event) || []) listener(...args)
    return true
  }
  swarm._handlePeer = function wrappedHandlePeer(peer, topic) {
    const result = originalHandlePeer.call(this, peer, topic)
    this.emit('peer', peer, topic)
    return result
  }

  const manager = new PublicFeedManager(swarm, createMetaDb())
  swarm.on('peer', (peer, topic) => {
    manager.handleDiscoveredPeer(peer, topic)
  })

  try {
    swarm._handlePeer({ publicKey, relayAddresses }, NETWORK_TOPIC)

    const stats = manager.getStats().directPeerDial
    assert.equal(emitted, 1)
    assert.equal(stats.queued, 0)
    assert.equal(stats.failed, 0)
    assert.equal(stats.discoveredPeers, 1)
    assert.equal(stats.peers[0].lastError, null)
    assert.equal(swarm.peers.get(keyHex).relayAddresses, relayAddresses)
    assert.equal(stats.peers[0].swarm.relayAddresses, 3)
  } finally {
    manager.stop()
  }
})

test('PublicFeedManager reports active peer connections only from swarm.connections', () => {
  const publicKey = b4a.alloc(32, 8)
  const keyHex = b4a.toString(publicKey, 'hex')
  const swarm = createSwarm()
  swarm.peers.set(keyHex, { publicKey, connected: true, connectedTime: Date.now() })
  swarm._allConnections = new Set([{ remotePublicKey: publicKey, opened: true }])
  swarm.connections.add({ remotePublicKey: publicKey })
  const manager = new PublicFeedManager(swarm, createMetaDb())

  try {
    assert.equal(manager.handleDiscoveredPeer({ publicKey }), true)
    assert.equal(swarm.joinPeerCalls.length, 0)
    assert.equal(manager.getStats().directPeerDial.peers[0].connected, true)
  } finally {
    manager.stop()
  }
})

test('PublicFeedManager treats swarm.peers and _allConnections as diagnostics, not sockets', () => {
  const publicKey = b4a.alloc(32, 18)
  const keyHex = b4a.toString(publicKey, 'hex')
  const swarm = createSwarm()
  swarm.peers.set(keyHex, { publicKey, connected: true, connectedTime: Date.now() })
  swarm._allConnections = new Set([{ remotePublicKey: publicKey, opened: true }])
  const manager = new PublicFeedManager(swarm, createMetaDb())

  try {
    assert.equal(manager.handleDiscoveredPeer({ publicKey }), true)
    const stats = manager.getStats().directPeerDial
    assert.equal(stats.peers[0].connected, false)
  } finally {
    manager.stop()
  }
})

test('PublicFeedManager does not treat stale Hyperswarm _allConnections keys as active sockets', () => {
  const publicKey = b4a.alloc(32, 9)
  const swarm = createSwarm()
  swarm._allConnections = new Set([publicKey])
  const manager = new PublicFeedManager(swarm, createMetaDb())

  try {
    assert.equal(manager.handleDiscoveredPeer({ publicKey }), true)
    assert.equal(swarm.joinPeerCalls.length, 0)
    assert.equal(manager.getStats().directPeerDial.peers[0].connected, false)
  } finally {
    manager.stop()
  }
})

test('PublicFeedManager does not treat pending Hyperswarm _allConnections entries as active sockets', () => {
  const publicKey = b4a.alloc(32, 19)
  const swarm = createSwarm()
  swarm._allConnections = new Set([{ remotePublicKey: publicKey, opened: false }])
  const manager = new PublicFeedManager(swarm, createMetaDb())

  try {
    assert.equal(manager.handleDiscoveredPeer({ publicKey }), true)
    assert.equal(swarm.joinPeerCalls.length, 0)
    assert.equal(manager.getStats().directPeerDial.peers[0].connected, false)
  } finally {
    manager.stop()
  }
})

test('direct peer diagnostics stay scoped to public counters', () => {
  const publicKey = b4a.alloc(32, 13)
  const keyHex = b4a.toString(publicKey, 'hex')
  const swarm = createSwarm()
  swarm.connecting = 1
  swarm._allConnections = new Set([{}])
  swarm._queue = { length: 2 }
  const peerInfo = {
    publicKey,
    attempts: 2,
    queued: true,
    waiting: true,
    explicit: true,
    relayAddresses: [b4a.alloc(32, 1)],
    topics: [b4a.alloc(32, 2)],
    connectedTime: -1,
    disconnectedTime: 123,
  }
  swarm.peers.set(keyHex, peerInfo)
  swarm.explicitPeers = new Set([peerInfo])
  const manager = new PublicFeedManager(swarm, createMetaDb())

  try {
    assert.equal(manager.handleDiscoveredPeer({ publicKey }), true)
    const stats = manager.getStats().directPeerDial
    assert.equal(stats.swarmConnecting, 1)
    assert.equal(stats.swarmConnections, 0)
    assert.equal(stats.peers[0].discoveredRelayAddresses, 0)
    assert.equal(stats.peers[0].connected, false)
  } finally {
    manager.stop()
  }
})


test('PublicFeedManager preserves relay-address hints without joinPeer fallback', () => {
  const publicKey = b4a.alloc(32, 21)
  const keyHex = b4a.toString(publicKey, 'hex')
  const relayAddresses = [{ host: 'relay.test', port: 49737 }]
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())

  try {
    assert.equal(manager.handleDiscoveredPeer({ publicKey, relayAddresses }, NETWORK_TOPIC), true)
    assert.equal(swarm.fallbackJoinPeerCalls.length, 0)
    assert.equal(swarm.joinPeerCalls.length, 0)
    assert.equal(swarm.peers.has(keyHex), false)
    const stats = manager.getStats().directPeerDial
    assert.equal(stats.discoveredPeers, 1)
    assert.equal(stats.peers[0].discoveredRelayAddresses, 1)
  } finally {
    manager.stop()
  }
})

test('PublicFeedManager leaves pending Hyperswarm peer candidates untouched', () => {
  const publicKey = b4a.alloc(32, 23)
  const keyHex = b4a.toString(publicKey, 'hex')
  const swarm = createSwarm()
  let priorityUpdates = 0
  const peerInfo = {
    publicKey,
    queued: true,
    waiting: false,
    explicit: false,
    relayAddresses: [{ host: 'relay.test', port: 49737 }],
    topics: [NETWORK_TOPIC],
    _updatePriority() {
      priorityUpdates++
      return false
    },
  }
  swarm.peers.set(keyHex, peerInfo)
  const manager = new PublicFeedManager(swarm, createMetaDb())

  try {
    assert.equal(manager.handleDiscoveredPeer({ publicKey, relayAddresses: peerInfo.relayAddresses }, NETWORK_TOPIC), true)
    assert.equal(swarm.joinPeerCalls.length, 0)
    assert.equal(peerInfo.explicit, false)
    assert.equal(priorityUpdates, 0)
    const stats = manager.getStats().directPeerDial
    assert.equal(stats.peers[0].connected, false)
  } finally {
    manager.stop()
  }
})

test('PublicFeedManager has no app-level foreground peer recovery loop', () => {
  const publicKey = b4a.alloc(32, 22)
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())

  try {
    assert.equal(manager.handleDiscoveredPeer({ publicKey, relayAddresses: [{ host: 'relay.test', port: 1 }] }, NETWORK_TOPIC), true)
    const statsBeforeRecovery = manager.getStats().directPeerDial
    assert.equal(statsBeforeRecovery.peers[0].connected, false)
    assert.equal(typeof manager.runBoundedPeerRecovery, 'undefined')
    assert.equal(swarm.joinPeerCalls.length, 0)
  } finally {
    manager.stop()
  }
})

test('PublicFeedManager.start reuses the storage-owned PearTube network topic', async () => {
  const swarm = createSwarm()
  swarm.peerPoolDiscovery = { source: 'storage-peer-pool' }
  const manager = new PublicFeedManager(swarm, createMetaDb())

  try {
    await manager.start()
    assert.equal(swarm.joinCalls.length, 0)
    assert.equal(swarm.statusCalls.length, 1)
    assert.equal(b4a.toString(swarm.statusCalls[0], 'hex'), b4a.toString(crypto.data(b4a.from(NETWORK_TOPIC_STRING, 'utf-8')), 'hex'))
    assert.equal(manager.feedDiscovery, swarm.peerPoolDiscovery)
    assert.equal(manager._ownsFeedDiscovery, false)
  } finally {
    manager.stop()
  }
})

test('PublicFeedManager exposes startup timing boundaries for discovery and feed open', async () => {
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())
  const publicKey = b4a.alloc(32, 21)
  const conn = createConnection()
  conn.remotePublicKey = publicKey
  const originalFrom = Protomux.from

  Protomux.from = () => ({
    pair() {},
    createChannel(opts) {
      return {
        messages: [{ send() {} }],
        open() {
          opts.onopen()
        }
      }
    }
  })

  try {
    await manager.start()
    manager.handleDiscoveredPeer({ publicKey }, NETWORK_TOPIC)
    manager.handleConnection(conn, { publicKey })
    manager.handleMessage({ type: 'HAVE_FEED', keys: [] }, conn)

    const events = manager.getStats().startupTiming.events.map((event) => event.name)
    assert.equal(events.includes('manager-created'), true)
    assert.equal(events.includes('public-feed-start-called'), true)
    assert.equal(events.includes('public-feed-topic-owned-by-storage'), true)
    assert.equal(events.includes('feed-peer-discovered'), true)
    assert.equal(events.includes('feed-socket-connected'), true)
    assert.equal(events.includes('protomux-feed-open'), true)
    assert.equal(events.includes('first-have-feed-received'), true)
  } finally {
    Protomux.from = originalFrom
    manager.stop()
  }
})

test('discovered peer diagnostics become connected when the Hyperswarm socket arrives', () => {
  const publicKey = b4a.alloc(32, 14)
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())

  try {
    assert.equal(manager.handleDiscoveredPeer({ publicKey }), true)
    assert.equal(swarm.joinPeerCalls.length, 0)

    const discoveredStats = manager.getStats().directPeerDial
    assert.equal(discoveredStats.peers[0].connected, false)

    const conn = createConnection()
    conn.remotePublicKey = publicKey
    swarm.connections.add(conn)
    manager.handleConnection(conn, { publicKey })

    const connectedStats = manager.getStats().directPeerDial
    assert.equal(connectedStats.peers[0].connected, true)
    assert.equal(connectedStats.connected, 1)
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
  const managerA = new PublicFeedManager(createSwarm(), createMetaDb(), { requireSignedPeerEntries: false })
  const managerB = new PublicFeedManager(createSwarm(), createMetaDb(), { requireSignedPeerEntries: false })
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

test('broadcastSubmitChannel sends only on open feed connections', () => {
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())
  const unopenedConn = createConnection()
  const openConn = createConnection()
  const unopenedSent = []
  const openSent = []

  manager.peerChannels.set(unopenedConn, { messages: [{ send: (msg) => unopenedSent.push(msg) }] })
  manager.peerChannels.set(openConn, { messages: [{ send: (msg) => openSent.push(msg) }] })
  manager.feedConnections.add(openConn)

  try {
    const stats = manager.getStats()
    assert.equal(stats.feedChannelCandidates, 2)
    assert.equal(stats.peerCount, 1)
    assert.equal(stats.feedConnections, 1)

    manager.broadcastSubmitChannel(DRIVE_KEY, null, PUBLIC_BEE_KEY)

    assert.equal(unopenedSent.length, 0)
    assert.equal(openSent.length, 1)
    assert.equal(openSent[0].type, 'SUBMIT_CHANNEL')
    assert.equal(openSent[0].key, DRIVE_KEY)
  } finally {
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


test('restored discovered entries are marked discovery-only and previews require availability probes', async () => {
  const metaDb = createPersistedMetaDb({
    'discovered-channels-v2': [{
      driveKey: DRIVE_KEY,
      publicBeeKey: PUBLIC_BEE_KEY,
      channelName: 'Cached Channel',
      previewVideos: [{
        id: 'cached-mkv',
        title: 'Cached MKV',
        availability: 'playable',
        playbackSupport: 'unverified-container',
        blobId: '0:8:0:1024',
        blobsCoreKey: '44'.repeat(32),
      }],
    }],
  })
  const manager = new PublicFeedManager(createSwarm(), metaDb)

  try {
    await manager.start()
    const feed = manager.getFeed()
    assert.equal(feed.length, 1)
    assert.equal(feed[0].discoveryOnly, true)
    assert.equal(feed[0].restoredFromCache, true)
    assert.equal(feed[0].requiresAvailabilityProbe, true)
    assert.equal(feed[0].restoredFrom, 'discovered-channels-v2')
    assert.equal(feed[0].previewVideos[0].availability, 'unknown')
    assert.equal(feed[0].previewVideos[0].byteAvailability, 'unknown')
    assert.equal(feed[0].previewVideos[0].playbackSupport, 'unverified-container')
    assert.equal(feed[0].previewVideos[0].containerSupport, 'unverified-container')
    assert.equal(feed[0].previewVideos[0].requiresAvailabilityProbe, true)
  } finally {
    manager.stop()
  }
})

test('restored relay catalog entries are visible but discovery-only until re-probed', async () => {
  const metaDb = createPersistedMetaDb({
    'public-feed-relay-catalog-v1': {
      entries: [{
        driveKey: 'aa'.repeat(32),
        publicBeeKey: 'bb'.repeat(32),
        source: 'relay-cache',
        relayServing: true,
        relayRole: 'cache',
        previewVideos: [{
          id: 'relay-cached-video',
          availability: 'playable',
          blobId: '0:4:0:512',
          blobsCoreKey: 'cc'.repeat(32),
        }],
      }],
    },
  })
  const manager = new PublicFeedManager(createSwarm(), metaDb)

  try {
    await manager.start()
    const feed = manager.getFeed()
    assert.equal(feed.length, 1)
    assert.equal(feed[0].source, 'relay-cache')
    assert.equal(feed[0].relayServing, true)
    assert.equal(feed[0].discoveryOnly, true)
    assert.equal(feed[0].restoredFromCache, true)
    assert.equal(feed[0].requiresAvailabilityProbe, true)
    assert.equal(feed[0].previewVideos[0].availability, 'unknown')
    assert.equal(feed[0].previewVideos[0].byteAvailability, 'unknown')
  } finally {
    manager.stop()
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

test('handle HAVE_FEED accepts migrated signed descriptors without explicit publicBeeKey', () => {
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())
  const conn = createConnection()

  try {
    manager.handleMessage({
      type: 'HAVE_FEED',
      entries: [{
        driveKey: DRIVE_KEY,
        signedDescriptor: {
          schema: SIGNED_CHANNEL_ROOT_DESCRIPTOR_SCHEMA,
          descriptor: {
            schema: CHANNEL_ROOT_DESCRIPTOR_SCHEMA,
            channelId: DRIVE_KEY,
            identityPublicKey: DRIVE_KEY,
            metadataKey: PUBLIC_BEE_KEY,
            mediaKey: '33'.repeat(32),
            seq: 1,
          },
          proof: 'aa',
          attestation: 'bb',
        },
        channelName: 'Migrated channel',
      }],
    }, conn)

    const feed = manager.getFeed()
    assert.equal(feed.length, 1)
    assert.equal(feed[0].publicBeeKey, PUBLIC_BEE_KEY)
    assert.equal(feed[0].channelName, 'Migrated channel')
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
