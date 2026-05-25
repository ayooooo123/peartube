import assert from 'node:assert/strict'
import test from 'node:test'

import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import IdentityKey from 'keet-identity-key'

import { createApi } from '../src/api.js'
import { PublicFeedManager } from '../src/public-feed.js'
import {
  createChannelRootDescriptor,
  signChannelRootDescriptor,
  verifySignedChannelRootDescriptor,
} from '../src/channel-descriptor.js'

const key = (byte) => Buffer.alloc(32, byte).toString('hex')

function createMetaDb () {
  const store = new Map()
  return {
    async get (k) {
      return store.has(k) ? store.get(k) : null
    },
    async put (k, v) {
      store.set(k, { value: v })
    },
  }
}

function createCtx () {
  return {
    metaDb: createMetaDb(),
    swarm: {
      keyPair: crypto.keyPair(),
      connections: new Set(),
      peers: new Map(),
    },
  }
}

async function signedDescriptor ({ deviceKeyPair, channelId = key(1), metadataKey = key(2), mediaKey = key(3), seq = 1 } = {}) {
  const identity = await IdentityKey.from({ mnemonic: IdentityKey.generateMnemonic() })
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

function createPublicBee ({ signed, videos = [] } = {}) {
  return {
    core: { length: 10 },
    async getMetadata () {
      return {
        name: 'Signed Feed Channel',
        signedDescriptor: signed,
      }
    },
    async listVideos () {
      return videos
    },
    async getVideo (id) {
      return videos.find((video) => video.id === id) || null
    },
  }
}

test('feed snapshots include signed channel descriptor so signed public feed ingress accepts them', async () => {
  const ctx = createCtx()
  const publicFeed = new PublicFeedManager(ctx.swarm, ctx.metaDb)
  const signed = await signedDescriptor({ deviceKeyPair: ctx.swarm.keyPair, channelId: key(1), metadataKey: key(2), mediaKey: key(3) })
  const api = createApi({
    ctx,
    publicFeed,
    loadPublicBee: async () => createPublicBee({ signed }),
  })

  const [snapshot] = await api.getFeedSnapshotEntries([{ driveKey: key(1), publicBeeKey: key(2) }])

  assert.ok(snapshot?.signedDescriptor, 'snapshot should carry channel root descriptor')
  assert.equal(snapshot.signedDescriptor.descriptor.channelId, key(1))
  assert.equal(snapshot.signedDescriptor.descriptor.metadataKey, key(2))
  assert.equal(snapshot.signedDescriptor.descriptor.mediaKey, key(3))
  assert.equal((await verifySignedChannelRootDescriptor(snapshot.signedDescriptor)).valid, true)

  const receivingFeed = new PublicFeedManager(ctx.swarm, createMetaDb())
  try {
    receivingFeed.handleMessage({ type: 'HAVE_FEED', entries: [snapshot] }, {})
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(receivingFeed.entries.has(key(1)), true)
    assert.equal(receivingFeed.entries.get(key(1)).publicBeeKey, key(2))
  } finally {
    receivingFeed.stop()
    publicFeed.stop()
  }
})
