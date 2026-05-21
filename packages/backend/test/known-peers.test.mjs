import test from 'node:test'
import assert from 'node:assert/strict'

import { dialKnownPeers, getExplicitPeerList } from '../src/known-peers.js'

const keyA = 'aa'.repeat(32)
const keyB = 'bb'.repeat(32)

test('dialKnownPeers dedupes repeated keys and ignores invalid entries', () => {
  const calls = []
  const swarm = {
    joinPeer(publicKey) {
      calls.push(Buffer.from(publicKey).toString('hex'))
    }
  }

  const count = dialKnownPeers(swarm, [
    { key: keyA },
    { key: keyA.toUpperCase() },
    { key: 'not-a-key' },
    { key: keyB },
  ])

  assert.equal(count, 2)
  assert.deepEqual(calls, [keyA, keyB])
})

test('getExplicitPeerList accepts relayPeers and knownPeers from network and swarmOptions', () => {
  const peers = getExplicitPeerList({
    network: { relayPeers: [keyA], knownPeers: keyB },
    swarmOptions: { relayPeers: `${keyA},${keyB}` },
  }).map((entry) => entry.key)

  assert.deepEqual(peers, [keyA, keyB, keyA, keyB])
})