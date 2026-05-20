import assert from 'node:assert/strict'
import test from 'node:test'
import b4a from 'b4a'

import { swarmQueuePeer, swarmRememberPeer } from '../src/swarm-peer-dial.js'

function createSwarm() {
  return {
    keyPair: { publicKey: b4a.alloc(32, 0) },
    peers: new Map(),
    enqueueCalls: [],
    joinPeerCalls: [],
    _upsertPeer(publicKey, relayAddresses) {
      const keyHex = b4a.toString(publicKey, 'hex')
      let peerInfo = this.peers.get(keyHex)
      if (!peerInfo) {
        peerInfo = {
          publicKey,
          relayAddresses,
          topics: [],
          queued: false,
          _topic(topic) {
            if (!this.topics.some((seen) => b4a.equals(seen, topic))) this.topics.push(topic)
          },
          _updatePriority() {
            return !this.queued
          },
        }
        this.peers.set(keyHex, peerInfo)
        return peerInfo
      }
      if (relayAddresses !== undefined) peerInfo.relayAddresses = relayAddresses
      return peerInfo
    },
    _enqueue(peerInfo) {
      this.enqueueCalls.push(peerInfo)
      peerInfo.queued = true
    },
    joinPeer(publicKey) {
      this.joinPeerCalls.push(publicKey)
    },
  }
}

test('swarmQueuePeer promotes peer info and queues via public joinPeer without private enqueue', () => {
  const publicKey = b4a.alloc(32, 2)
  const swarm = createSwarm()
  const peerInfo = swarm._upsertPeer(publicKey, [{ host: '127.0.0.1', port: 49737 }])

  assert.equal(swarmQueuePeer(swarm, peerInfo), true)
  assert.equal(swarm.enqueueCalls.length, 0)
  assert.equal(peerInfo.explicit, true)
  assert.equal(peerInfo.queued, true)
  assert.equal(swarm.joinPeerCalls.length, 1)
  assert.equal(swarm.joinPeerCalls[0], publicKey)
})

test('swarmRememberPeer preserves existing relay hints when rediscovery lacks hints', () => {
  const publicKey = b4a.alloc(32, 3)
  const relayAddresses = [{ host: '167.86.111.230', port: 49737 }]
  const swarm = createSwarm()
  const initial = swarmRememberPeer(swarm, { publicKey, relayAddresses }, b4a.alloc(32, 4))

  assert.equal(initial.relayAddresses, relayAddresses)
  const rediscovered = swarmRememberPeer(swarm, { publicKey }, b4a.alloc(32, 4))

  assert.equal(rediscovered, initial)
  assert.equal(rediscovered.relayAddresses, relayAddresses)
})

test('swarmRememberPeer installs a public-key peer candidate without private Hyperswarm upsert', () => {
  const publicKey = b4a.alloc(32, 5)
  const swarm = createSwarm()
  delete swarm._upsertPeer

  const remembered = swarmRememberPeer(swarm, { publicKey }, b4a.alloc(32, 6))
  assert.equal(remembered.publicKey, publicKey)
  assert.equal(swarm.peers.get(b4a.toString(publicKey, 'hex')), remembered)
  assert.equal(remembered.topics.length, 1)
})
