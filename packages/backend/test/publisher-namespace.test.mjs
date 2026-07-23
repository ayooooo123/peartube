import assert from 'node:assert/strict'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import test from 'brittle'

import {
  createPublisherNamespaceDescriptor,
  createRootTransition,
  derivePublisherId,
  verifyPublisherRootTransition,
} from '../src/publisher/namespace.js'

function keyPair(seedByte) {
  return crypto.keyPair(b4a.alloc(32, seedByte))
}

function hex(buf) {
  return b4a.toString(buf, 'hex')
}

test('publisher namespace genesis is deterministic and separates stable publisher id from active root', (t) => {
  const root = keyPair(1)
  const catalog = keyPair(2)
  const recoveryA = keyPair(3)
  const recoveryB = keyPair(4)

  const descriptor = createPublisherNamespaceDescriptor({
    activeRootKey: root.publicKey,
    catalogBootstrapKey: catalog.publicKey,
    catalogEpoch: 0,
    policySequence: 0,
    profileRef: { type: 'hypercore', key: catalog.publicKey, path: '/profile.json' },
    recoveryKeys: [recoveryB.publicKey, recoveryA.publicKey],
    recoveryThreshold: 2,
  })
  const again = createPublisherNamespaceDescriptor({
    activeRootKey: root.publicKey,
    catalogBootstrapKey: catalog.publicKey,
    catalogEpoch: 0,
    policySequence: 0,
    profileRef: { path: '/profile.json', key: catalog.publicKey, type: 'hypercore' },
    recoveryKeys: [recoveryA.publicKey, recoveryB.publicKey],
    recoveryThreshold: 2,
  })

  assert.deepEqual(descriptor, again)
  assert.equal(descriptor.version, 1)
  assert.equal(descriptor.publisherId, derivePublisherId(root.publicKey))
  assert.equal(descriptor.activeRootKey, hex(root.publicKey))
  assert.equal(descriptor.catalogBootstrapKey, hex(catalog.publicKey))
  assert.deepEqual(descriptor.recoveryKeys, [hex(recoveryA.publicKey), hex(recoveryB.publicKey)].sort())
  t.pass('namespace descriptor is canonical')
})

test('root rotation keeps publisher id stable and requires old-root authority', async (t) => {
  const oldRoot = keyPair(10)
  const newRoot = keyPair(11)
  const catalog = keyPair(12)
  const attacker = keyPair(13)
  const current = createPublisherNamespaceDescriptor({
    activeRootKey: oldRoot.publicKey,
    catalogBootstrapKey: catalog.publicKey,
    recoveryKeys: [],
    recoveryThreshold: 0,
  })

  const transition = createRootTransition({
    current,
    newRootKey: newRoot.publicKey,
    keyPairs: [oldRoot],
  })
  const verified = await verifyPublisherRootTransition({ current, transition })

  assert.equal(verified.valid, true)
  assert.equal(verified.next.publisherId, current.publisherId)
  assert.equal(verified.next.activeRootKey, hex(newRoot.publicKey))
  assert.equal(verified.next.previousRoot, hex(oldRoot.publicKey))
  assert.equal(verified.next.catalogEpoch, current.catalogEpoch + 1)

  const forged = createRootTransition({
    current,
    newRootKey: attacker.publicKey,
    keyPairs: [attacker],
  })
  const rejected = await verifyPublisherRootTransition({ current, transition: forged })
  assert.equal(rejected.valid, false)
  assert.equal(rejected.reason, 'unauthorized-transition')
  t.pass('root transition enforced')
})

test('root recovery requires the configured quorum and sorts signatures deterministically', async (t) => {
  const oldRoot = keyPair(20)
  const newRoot = keyPair(21)
  const catalog = keyPair(22)
  const recoveryA = keyPair(23)
  const recoveryB = keyPair(24)
  const recoveryC = keyPair(25)
  const current = createPublisherNamespaceDescriptor({
    activeRootKey: oldRoot.publicKey,
    catalogBootstrapKey: catalog.publicKey,
    recoveryKeys: [recoveryC.publicKey, recoveryA.publicKey, recoveryB.publicKey],
    recoveryThreshold: 2,
  })

  const transition = createRootTransition({
    current,
    newRootKey: newRoot.publicKey,
    keyPairs: [recoveryB, recoveryA],
    mode: 'recovery',
  })
  const verified = await verifyPublisherRootTransition({ current, transition })
  assert.equal(verified.valid, true)
  assert.equal(verified.next.activeRootKey, hex(newRoot.publicKey))
  assert.deepEqual(
    transition.envelope.signatures.map(entry => hex(entry.signer)),
    [hex(recoveryA.publicKey), hex(recoveryB.publicKey)].sort(),
  )

  const underThreshold = createRootTransition({
    current,
    newRootKey: newRoot.publicKey,
    keyPairs: [recoveryA],
    mode: 'recovery',
  })
  const rejected = await verifyPublisherRootTransition({ current, transition: underThreshold })
  assert.equal(rejected.valid, false)
  assert.equal(rejected.reason, 'unauthorized-transition')
  t.pass('recovery quorum enforced')
})
