import assert from 'node:assert/strict'
import test from 'node:test'

import { PublicFeedManager } from '../src/public-feed.js'

const key = (fill) => Buffer.alloc(32, fill).toString('hex')

function manager () {
  return new PublicFeedManager({ join: () => ({ flushed: async () => {} }) }, null)
}

test('public feed preserves signed channel root descriptor on local submit, persistence, and gossip', async () => {
  const feed = manager()
  const signedDescriptor = {
    schema: 'peartube.channel.root.signed.v1',
    descriptor: {
      schema: 'peartube.channel.root.v1',
      channelId: key(9),
      identityPublicKey: key(9),
      metadataKey: key(1),
      mediaKey: key(2),
      seq: 3,
      createdAt: 10,
      updatedAt: 20
    },
    proof: 'aa',
    attestation: 'bb'
  }

  feed.addEntry(key(1), 'local', key(1), { signedDescriptor })
  const entry = feed.getFeed().find(e => e.driveKey === key(1))
  assert.deepEqual(entry.signedDescriptor, signedDescriptor)

  const serialized = feed._serializeEntry(entry)
  assert.deepEqual(serialized.signedDescriptor, signedDescriptor)

  const messages = []
  const conn = {}
  feed.peerChannels.set(conn, { messages: [{ send: (msg) => messages.push(msg) }] })
  feed.broadcastSubmitChannel(key(1), null, key(1), { signedDescriptor })
  assert.deepEqual(messages[0].signedDescriptor, signedDescriptor)
})

test('public feed applies newer signed descriptors but rejects lower descriptor seq', () => {
  const feed = manager()
  const oldDescriptor = {
    schema: 'peartube.channel.root.signed.v1',
    descriptor: { schema: 'peartube.channel.root.v1', channelId: key(7), identityPublicKey: key(7), seq: 5, metadataKey: key(1), mediaKey: key(2) },
    proof: 'aa',
    attestation: 'bb'
  }
  const staleDescriptor = {
    schema: 'peartube.channel.root.signed.v1',
    descriptor: { schema: 'peartube.channel.root.v1', channelId: key(7), identityPublicKey: key(7), seq: 4, metadataKey: key(3), mediaKey: key(4) },
    proof: 'cc',
    attestation: 'dd'
  }
  const newerDescriptor = {
    schema: 'peartube.channel.root.signed.v1',
    descriptor: { schema: 'peartube.channel.root.v1', channelId: key(7), identityPublicKey: key(7), seq: 6, metadataKey: key(5), mediaKey: key(6) },
    proof: 'ee',
    attestation: 'ff'
  }

  feed.addEntry(key(1), 'peer', key(1), { signedDescriptor: oldDescriptor })
  assert.equal(feed._applyEntrySnapshot(key(1), { signedDescriptor: staleDescriptor }), false)
  assert.deepEqual(feed.entries.get(key(1)).signedDescriptor, oldDescriptor)

  assert.equal(feed._applyEntrySnapshot(key(1), { signedDescriptor: newerDescriptor }), true)
  assert.deepEqual(feed.entries.get(key(1)).signedDescriptor, newerDescriptor)
})
