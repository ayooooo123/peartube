import test from 'node:test'
import assert from 'node:assert/strict'

import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import IdentityKey from 'keet-identity-key'

import { PublicFeedManager } from '../src/public-feed.js'
import {
  createChannelRootDescriptor,
  signChannelRootDescriptor,
} from '../src/channel-descriptor.js'

const key = (byte) => Buffer.alloc(32, byte).toString('hex')

function createSwarm() {
  return {
    keyPair: { publicKey: b4a.alloc(32, 0) },
    connections: new Set(),
    peers: new Map(),
    join() {
      return { flushed: async () => {} }
    },
    status() {
      return null
    },
  }
}

function createMetaDb() {
  const store = new Map()
  return {
    async get(k) {
      return store.has(k) ? store.get(k) : null
    },
    async put(k, v) {
      store.set(k, v)
    },
  }
}

async function signedDescriptor({ identityMnemonic = IdentityKey.generateMnemonic(), deviceKeyPair = crypto.keyPair(), channelId = key(1), metadataKey = key(2), mediaKey = key(3), seq = 1 } = {}) {
  const identity = await IdentityKey.from({ mnemonic: identityMnemonic })
  const proof = await identity.bootstrap(deviceKeyPair.publicKey)
  const descriptor = createChannelRootDescriptor({
    identityPublicKey: b4a.toString(identity.identityPublicKey, 'hex'),
    channelId,
    metadataKey,
    mediaKey,
    seq,
    createdAt: 1,
    updatedAt: 1,
  })
  return signChannelRootDescriptor({ descriptor, deviceKeyPair, deviceProof: proof })
}

test('public feed rejects peer HAVE_FEED entries without a verified signed descriptor', () => {
  const manager = new PublicFeedManager(createSwarm(), createMetaDb())
  try {
    manager.handleMessage({
      type: 'HAVE_FEED',
      entries: [{
        driveKey: key(1),
        publicBeeKey: key(2),
        channelName: 'spoofed unsigned channel',
      }],
    }, {})

    assert.equal(manager.entries.has(key(1)), false)
    assert.equal(manager.getFeed().length, 0)
  } finally {
    manager.stop()
  }
})

test('public feed accepts peer HAVE_FEED entries with matching verified descriptor', async () => {
  const manager = new PublicFeedManager(createSwarm(), createMetaDb())
  const signed = await signedDescriptor({ channelId: key(1), metadataKey: key(2), mediaKey: key(3) })

  try {
    manager.handleMessage({
      type: 'HAVE_FEED',
      entries: [{
        driveKey: key(1),
        publicBeeKey: key(2),
        channelName: 'verified channel',
        signedDescriptor: signed,
      }],
    }, {})
    await new Promise((resolve) => setImmediate(resolve))

    const entry = manager.entries.get(key(1))
    assert.ok(entry)
    assert.equal(entry.publicBeeKey, key(2))
    assert.equal(entry.signedDescriptor.descriptor.channelId, key(1))
  } finally {
    manager.stop()
  }
})

test('public feed rejects signed peer entries whose descriptor does not bind advertised keys', async () => {
  const manager = new PublicFeedManager(createSwarm(), createMetaDb())
  const signed = await signedDescriptor({ channelId: key(9), metadataKey: key(2), mediaKey: key(3) })

  try {
    manager.handleMessage({
      type: 'SUBMIT_CHANNEL',
      key: key(1),
      publicBeeKey: key(2),
      signedDescriptor: signed,
    }, {})
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(manager.entries.has(key(1)), false)
  } finally {
    manager.stop()
  }
})


test('public feed accepts relay-cache catalog entries without signed descriptors', async () => {
  const manager = new PublicFeedManager(createSwarm(), createMetaDb())
  try {
    manager.handleMessage({
      type: 'SUBMIT_CHANNEL',
      key: key(1),
      publicBeeKey: key(2),
      schema: 'peartube.relayCatalog',
      catalogVersion: 1,
      source: 'relay-cache',
      relayRole: 'cache',
      relayServing: true,
      previewVideos: [{
        id: 'relay-video',
        blobId: '0:4:0:512',
        blobsCoreKey: key(3),
        availability: 'playable',
      }],
    }, {})
    await new Promise((resolve) => setImmediate(resolve))

    const entry = manager.entries.get(key(1))
    assert.ok(entry)
    assert.equal(entry.source, 'relay-cache')
    assert.equal(entry.relayServing, true)
    assert.equal(entry.publicBeeKey, key(2))
    assert.equal(entry.previewVideos[0].availability, 'playable')
    assert.equal(manager.getFeed().length, 1)
  } finally {
    manager.stop()
  }
})


test('public feed accepts relay-cache HAVE_FEED catalog entries without signed descriptors', async () => {
  const manager = new PublicFeedManager(createSwarm(), createMetaDb())
  try {
    manager.handleMessage({
      type: 'HAVE_FEED',
      entries: [{
        driveKey: key(4),
        publicBeeKey: key(5),
        schema: 'peartube.relayCatalog',
        catalogVersion: 1,
        source: 'relay-cache',
        relayRole: 'cache',
        relayServing: true,
        channelName: 'Relay cached channel',
        previewVideos: [{
          id: 'relay-feed-video',
          blobId: '0:8:0:1024',
          blobsCoreKey: key(6),
          availability: 'playable',
        }],
      }],
    }, {})
    await new Promise((resolve) => setImmediate(resolve))

    const entry = manager.entries.get(key(4))
    assert.ok(entry)
    assert.equal(entry.source, 'peer')
    assert.equal(entry.relayServing, true)
    assert.equal(entry.publicBeeKey, key(5))
    assert.equal(entry.previewVideos[0].id, 'relay-feed-video')
    assert.equal(manager.getFeed().length, 1)
  } finally {
    manager.stop()
  }
})
