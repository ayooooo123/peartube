import assert from 'node:assert/strict'
import test from 'node:test'
import b4a from 'b4a'

import { swarmQueuePeer } from '../src/swarm-peer-dial.js'

test('swarmQueuePeer clears stale queued/waiting flags before joinPeer requeue', () => {
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

  assert.equal(swarmQueuePeer(swarm, peerInfo), true)
  assert.deepEqual(swarm.joinPeerCalls, [publicKey])
  assert.equal(peerInfo.explicit, true)
  assert.equal(peerInfo.queued, false)
  assert.equal(peerInfo.waiting, false)
})
