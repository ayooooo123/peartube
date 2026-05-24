import test from 'node:test'
import assert from 'node:assert/strict'

import { getExplicitPeerList, getCachedPeerList } from '../src/known-peers.js'

const keyA = 'aa'.repeat(32)
const keyB = 'bb'.repeat(32)

test('getExplicitPeerList accepts relayPeers and knownPeers from network and swarmOptions', () => {
  const peers = getExplicitPeerList({
    network: { relayPeers: [keyA], knownPeers: keyB },
    swarmOptions: { relayPeers: `${keyA},${keyB}` },
  }).map((entry) => entry.key)

  assert.deepEqual(peers, [keyA, keyB, keyA, keyB])
})

test('getCachedPeerList loads persisted peers for diagnostics without joining them directly', async () => {
  const cached = [{ key: keyA, lastSeen: 2 }, { key: keyB, lastSeen: 1 }]
  const ctx = {
    metaDb: {
      async get(key) {
        assert.equal(key, 'known-peers-v1')
        return { value: cached }
      },
    },
  }

  assert.deepEqual(await getCachedPeerList(ctx), cached)
})
