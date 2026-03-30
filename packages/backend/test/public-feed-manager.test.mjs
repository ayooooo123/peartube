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

    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0], {
      type: 'HAVE_FEED',
      keys: [DRIVE_KEY],
      entries: [{
        driveKey: DRIVE_KEY,
        publicBeeKey: PUBLIC_BEE_KEY
      }]
    })
  } finally {
    Protomux.from = originalFrom
    manager.stop()
  }
})
