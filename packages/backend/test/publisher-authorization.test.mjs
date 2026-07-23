import assert from 'node:assert/strict'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import test from 'brittle'

import {
  applyPublisherOperation,
  createAuthorizationState,
  getWriterAuthorization,
} from '../src/publisher/authorization.js'

function keyPair(seedByte) {
  return crypto.keyPair(b4a.alloc(32, seedByte))
}

function hex(buf) {
  return b4a.toString(buf, 'hex')
}

test('publisher authorization admits monotonic device-writer catalog operations by capability', (t) => {
  const root = keyPair(1)
  const writer = keyPair(2)
  const state = createAuthorizationState({
    rootKey: root.publicKey,
    writers: [{ writerKey: writer.publicKey, capabilities: ['catalog:append'] }],
  })

  const first = applyPublisherOperation(state, {
    type: 'catalog:append',
    writerKey: writer.publicKey,
    policyEpoch: 0,
    writerSequence: 1,
    bodyHash: b4a.alloc(32, 9),
  })
  assert.equal(first.accepted, true)
  assert.equal(getWriterAuthorization(first.state, writer.publicKey).lastAcceptedSequence, 1)

  const duplicateDifferentBytes = applyPublisherOperation(first.state, {
    type: 'catalog:append',
    writerKey: writer.publicKey,
    policyEpoch: 0,
    writerSequence: 1,
    bodyHash: b4a.alloc(32, 10),
  })
  assert.equal(duplicateDifferentBytes.accepted, false)
  assert.equal(duplicateDifferentBytes.reason, 'sequence-reuse-different-bytes')

  const wrongCapability = applyPublisherOperation(first.state, {
    type: 'moderation:append',
    writerKey: writer.publicKey,
    policyEpoch: 0,
    writerSequence: 2,
    bodyHash: b4a.alloc(32, 11),
  })
  assert.equal(wrongCapability.accepted, false)
  assert.equal(wrongCapability.reason, 'missing-capability')
  t.pass('writer capability reducer enforced')
})

test('root revocation advances policy epoch and fixes accepted-through cutoff', (t) => {
  const root = keyPair(10)
  const writer = keyPair(11)
  const state = createAuthorizationState({
    rootKey: root.publicKey,
    writers: [{ writerKey: writer.publicKey, capabilities: ['catalog:append'] }],
  })

  const accepted = applyPublisherOperation(state, {
    type: 'catalog:append',
    writerKey: writer.publicKey,
    policyEpoch: 0,
    writerSequence: 3,
    bodyHash: b4a.alloc(32, 1),
  }).state

  const revoked = applyPublisherOperation(accepted, {
    type: 'writer:revoke',
    writerKey: root.publicKey,
    targetWriterKey: writer.publicKey,
    policyEpoch: 0,
    acceptedThroughSequence: 3,
    bodyHash: b4a.alloc(32, 2),
  })
  assert.equal(revoked.accepted, true)
  assert.equal(revoked.state.policyEpoch, 1)
  assert.equal(getWriterAuthorization(revoked.state, writer.publicKey).revoked, true)

  const delayedAtCutoff = applyPublisherOperation(revoked.state, {
    type: 'catalog:append',
    writerKey: writer.publicKey,
    policyEpoch: 0,
    writerSequence: 3,
    bodyHash: b4a.alloc(32, 1),
  })
  assert.equal(delayedAtCutoff.accepted, true)
  assert.equal(delayedAtCutoff.reason, 'already-accepted')

  const afterCutoff = applyPublisherOperation(revoked.state, {
    type: 'catalog:append',
    writerKey: writer.publicKey,
    policyEpoch: 0,
    writerSequence: 4,
    bodyHash: b4a.alloc(32, 3),
  })
  assert.equal(afterCutoff.accepted, false)
  assert.equal(afterCutoff.reason, 'writer-revoked')
  t.pass('revocation cutoff enforced')
})

test('authorization rejects stale policy epochs, unknown writers, and root-only actions from writers', (t) => {
  const root = keyPair(20)
  const writer = keyPair(21)
  const other = keyPair(22)
  const state = createAuthorizationState({
    rootKey: root.publicKey,
    writers: [{ writerKey: writer.publicKey, capabilities: ['catalog:append'] }],
  })
  const advanced = applyPublisherOperation(state, {
    type: 'writer:authorize',
    writerKey: root.publicKey,
    targetWriterKey: other.publicKey,
    capabilities: ['catalog:append'],
    policyEpoch: 0,
    bodyHash: b4a.alloc(32, 4),
  }).state

  assert.equal(advanced.policyEpoch, 1)
  assert.equal(applyPublisherOperation(advanced, {
    type: 'catalog:append',
    writerKey: other.publicKey,
    policyEpoch: 0,
    writerSequence: 1,
    bodyHash: b4a.alloc(32, 5),
  }).reason, 'stale-policy-epoch')

  assert.equal(applyPublisherOperation(state, {
    type: 'catalog:append',
    writerKey: other.publicKey,
    policyEpoch: 0,
    writerSequence: 1,
    bodyHash: b4a.alloc(32, 6),
  }).reason, 'unknown-writer')

  assert.equal(applyPublisherOperation(state, {
    type: 'writer:revoke',
    writerKey: writer.publicKey,
    targetWriterKey: other.publicKey,
    policyEpoch: 0,
    bodyHash: b4a.alloc(32, 7),
  }).reason, 'root-authority-required')
  t.pass('root-only and policy checks enforced')
})
