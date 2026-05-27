import assert from 'node:assert/strict'
import test from 'node:test'
import b4a from 'b4a'

import { swarmQueuePeer } from '../src/swarm-peer-dial.js'

test('swarmQueuePeer does not perform app-level joinPeer requeue by default', () => {
  const publicKey = b4a.alloc(32, 31)
  const peerInfo = {
    publicKey,
    queued: true,
    waiting: true,
    explicit: false,
  }
  const swarm = {
    joinPeerCalls: [],
    joinPeer(key) {
      this.joinPeerCalls.push(key)
    },
  }

  assert.equal(swarmQueuePeer(swarm, peerInfo), false)
  assert.deepEqual(swarm.joinPeerCalls, [])
  assert.equal(peerInfo.explicit, false)
  assert.equal(peerInfo.queued, true)
  assert.equal(peerInfo.waiting, true)
})
