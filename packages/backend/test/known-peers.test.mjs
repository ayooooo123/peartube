import test from 'node:test'
import assert from 'node:assert/strict'

import { createKnownPeerCache, loadKnownPeers } from '../src/known-peers.js'

const keyA = 'aa'.repeat(32)
const keyB = 'bb'.repeat(32)

test('known peer cache records connected peers for diagnostics only', async () => {
  const writes = []
  const cache = createKnownPeerCache({
    async put(key, value) {
      writes.push({ key, value })
    },
  }, { selfKeyHex: keyB })

  cache.record(Buffer.from(keyA, 'hex'))
  cache.record(Buffer.from(keyB, 'hex'))
  await cache.flush()

  assert.equal(writes.length, 1)
  assert.equal(writes[0].key, 'known-peers-v1')
  assert.equal(writes[0].value.length, 1)
  assert.equal(writes[0].value[0].key, keyA)
})

test('loadKnownPeers returns sorted persisted diagnostics without dialing policy', async () => {
  const cached = [
    { key: keyA, lastSeen: 1 },
    { key: 'not-a-key', lastSeen: 999 },
    { key: keyB, lastSeen: 2 },
  ]

  const peers = await loadKnownPeers({
    async get(key) {
      assert.equal(key, 'known-peers-v1')
      return { value: cached }
    },
  })

  assert.deepEqual(peers, [cached[2], cached[0]])
})
