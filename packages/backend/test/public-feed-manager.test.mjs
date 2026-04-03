import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import Protomux from 'protomux'

import { PublicFeedManager } from '../src/public-feed.js'

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

function createConnection() {
  return new EventEmitter()
}

test('PublicFeedManager.start restores cache without joining a feed topic', async () => {
  const swarm = createSwarm()
  const manager = new PublicFeedManager(swarm, createMetaDb())

  try {
    await manager.start()
    assert.equal(swarm.joinCalls.length, 0)
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
    assert.deepEqual(sent[0], {
      type: 'HAVE_FEED',
      keys: [DRIVE_KEY],
      entries: [{
        driveKey: DRIVE_KEY,
        publicBeeKey: PUBLIC_BEE_KEY
      }]
    })
    assert.deepEqual(sent[1], { type: 'NEED_FEED' })
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
