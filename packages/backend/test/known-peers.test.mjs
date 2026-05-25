import test from 'node:test'
import assert from 'node:assert/strict'

import { getExplicitPeerList, getDialableKnownPeers, dialKnownPeers } from '../src/known-peers.js'

const keyA = 'aa'.repeat(32)
const keyB = 'bb'.repeat(32)

test('getExplicitPeerList accepts relayPeers and knownPeers from network and swarmOptions', () => {
  const peers = getExplicitPeerList({
    network: { relayPeers: [keyA], knownPeers: keyB },
    swarmOptions: { relayPeers: `${keyA},${keyB}` },
  }).map((entry) => entry.key)

  assert.deepEqual(peers, [keyA, keyB, keyA, keyB])
})

test('getDialableKnownPeers returns explicit relays before persisted peers', async () => {
  const cached = [{ key: keyB, lastSeen: 1 }]
  const ctx = {
    network: { relayPeers: [keyA] },
    metaDb: {
      async get(key) {
        assert.equal(key, 'known-peers-v1')
        return { value: cached }
      },
    },
  }

  const peers = await getDialableKnownPeers(ctx)
  assert.equal(peers.length, 2)
  assert.equal(peers[0].key, keyA)
  assert.equal(peers[0].source, 'explicit')
  assert.equal(typeof peers[0].lastSeen, 'number')
  assert.deepEqual(peers[1], cached[0])
})

test('dialKnownPeers direct-dials valid unique public keys with a bounded fanout', () => {
  const calls = []
  const swarm = {
    joinPeer(publicKey) {
      calls.push(Buffer.from(publicKey).toString('hex'))
    },
  }

  const dialed = dialKnownPeers(swarm, [
    { key: keyA },
    { key: keyA },
    { key: 'not-a-key' },
    { key: keyB },
  ], { limit: 1 })

  assert.equal(dialed, 1)
  assert.deepEqual(calls, [keyA])
})
