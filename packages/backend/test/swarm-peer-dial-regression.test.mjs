import assert from 'node:assert/strict'
import test from 'node:test'
import b4a from 'b4a'

import { swarmQueuePeer, swarmRememberPeer } from '../src/swarm-peer-dial.js'

test('swarmRememberPeer does not fabricate Hyperswarm peer info when peer is unknown', () => {
  const publicKey = b4a.alloc(32, 7)
  const keyHex = b4a.toString(publicKey, 'hex')
  const swarm = {
    peers: new Map(),
  }

  const remembered = swarmRememberPeer(swarm, {
    publicKey,
    relayAddresses: [{ host: 'relay.test', port: 49737 }],
  }, b4a.alloc(32, 8))

  assert.equal(remembered.publicKey, publicKey)
  assert.equal(remembered.relayAddresses.length, 1)
  assert.equal(swarm.peers.has(keyHex), false)
})

test('swarmQueuePeer queues through public joinPeer and avoids private priority mutation', () => {
  const publicKey = b4a.alloc(32, 9)
  const peerInfo = {
    publicKey,
    queued: false,
    explicit: false,
    _updatePriority() {
      throw new Error('caller must not mutate Hyperswarm internals directly')
    },
  }
  const swarm = {
    joinPeerCalls: [],
    joinPeer(key) {
      this.joinPeerCalls.push(key)
    },
  }

  assert.equal(swarmQueuePeer(swarm, peerInfo), true)
  assert.deepEqual(swarm.joinPeerCalls, [publicKey])
  assert.equal(peerInfo.queued, true)
  assert.equal(peerInfo.explicit, true)
})
