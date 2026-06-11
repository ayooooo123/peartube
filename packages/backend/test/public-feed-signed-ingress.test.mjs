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


test('public feed rejects inbound relay-cache-like SUBMIT_CHANNEL without signed descriptor', async () => {
  const manager = new PublicFeedManager(createSwarm(), createMetaDb())
  const conn = {}
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
    }, conn)
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(manager.entries.has(key(1)), false)
    assert.equal(manager.peerFeedKeys.get(conn)?.has(key(1)), undefined)
    assert.equal(manager.getFeed().length, 0)
  } finally {
    manager.stop()
  }
})


test('public feed rejects inbound relay-cache-like HAVE_FEED entries without signed descriptors', async () => {
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

    assert.equal(manager.entries.has(key(4)), false)
    assert.equal(manager.getFeed().length, 0)
  } finally {
    manager.stop()
  }
})

test('public feed treats relay-served playable preview entries as locally backed for outbound gossip', () => {
  const manager = new PublicFeedManager(createSwarm(), createMetaDb())
  try {
    assert.equal(manager._isLocallyBackedEntry({
      driveKey: key(11),
      publicBeeKey: key(12),
      source: 'peer',
      relayRole: 'cache',
      relayServing: true,
      discoveryOnly: true,
      restoredFromCache: true,
      requiresAvailabilityProbe: true,
      previewVideos: [{
        id: 'relay-restored-playable',
        blobId: '0:8:0:1024',
        blobsCoreKey: key(13),
        availability: 'playable',
        byteAvailability: 'playable',
        readyForPlayback: false,
        hasHeadBlock: false,
        contiguousBlocks: 0,
      }],
    }), true)
  } finally {
    manager.stop()
  }
})

test('public feed re-sends relay-cache HAVE_FEED after snapshot enrichment', async () => {
  const manager = new PublicFeedManager(createSwarm(), createMetaDb())
  const conn = {}
  const sent = []
  try {
    manager.peerChannels.set(conn, {
      messages: [{
        send(msg) { sent.push(msg) },
      }],
    })
    manager.entries.set(key(14), {
      driveKey: key(14),
      publicBeeKey: key(15),
      source: 'peer',
      relayRole: 'cache',
      relayServing: true,
      discoveryOnly: true,
      restoredFromCache: true,
      requiresAvailabilityProbe: true,
    })
    manager.feedSnapshotProvider = async (entries) => entries.map((entry) => ({
      ...entry,
      previewVideos: [{
        id: 'relay-snapshot-video',
        blobId: '0:8:0:1024',
        blobsCoreKey: key(16),
        availability: 'playable',
        byteAvailability: 'playable',
      }],
    }))

    manager.sendHaveFeed(conn)
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(sent.length, 2)
    assert.equal(sent[0].entries.length, 1)
    assert.equal(sent[0].entries[0].previewVideos, undefined)
    assert.equal(sent[1].entries.length, 1)
    assert.equal(sent[1].entries[0].previewVideos.length, 1)
  } finally {
    manager.stop()
  }
})

test('public feed counts already-known async verified HAVE_FEED entries for the peer connection', async () => {
  const manager = new PublicFeedManager(createSwarm(), createMetaDb())
  const signed = await signedDescriptor({ channelId: key(7), metadataKey: key(8), mediaKey: key(9) })
  const conn = {}

  try {
    manager.addEntry(key(7), 'peer', key(8), {
      driveKey: key(7),
      publicBeeKey: key(8),
      signedDescriptor: signed,
      previewVideos: [{
        id: 'cached-video',
        blobId: '0:1:0:128',
        blobsCoreKey: key(10),
        availability: 'playable',
      }],
    })

    manager.handleMessage({
      type: 'HAVE_FEED',
      entries: [{
        driveKey: key(7),
        publicBeeKey: key(8),
        signedDescriptor: signed,
        previewVideos: [{
          id: 'cached-video',
          blobId: '0:1:0:128',
          blobsCoreKey: key(10),
          availability: 'playable',
        }],
      }],
    }, conn)
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(manager.peerFeedKeys.get(conn)?.has(key(7)), true)
    assert.equal(manager.entryPeerCounts.get(key(7)), 1)
    assert.equal(manager.getStats().totalEntries, 1)
    assert.equal(manager.getFeed().length, 1)
  } finally {
    manager.stop()
  }
})
