import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

import Protomux from 'protomux'

import { PublicFeedManager } from '../src/public-feed.js'
import { NETWORK_TOPIC_STRING } from '../src/types.js'
const DRIVE_KEY = '11'.repeat(32)
const PUBLIC_BEE_KEY = '22'.repeat(32)

function createSwarm() {
  return {
    connections: new Set(),
    joinCalls: [],
    join(topic, opts) {
      this.joinCalls.push({ topic, opts })
      return {
        flushed() {
          return Promise.resolve()
        }
      }
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

test('handleConnection pairs and opens one feed channel per connection', () => {
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
    createChannel() {
      return {
        messages: [{ send(msg) { sent.push(msg) } }],
        open() {},
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
