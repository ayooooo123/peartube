import assert from 'node:assert/strict'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import test from 'brittle'

import {
  applyCatalogOperation,
  createPublisherCatalogState,
  getCatalogPublications,
} from '../src/publisher/catalog.js'
import {
  materializeCatalogView,
} from '../src/publisher/catalog-view.js'
import { createAuthorizationState } from '../src/publisher/authorization.js'

function keyPair(seedByte) {
  return crypto.keyPair(b4a.alloc(32, seedByte))
}

function hex(buf) {
  return b4a.toString(buf, 'hex')
}

function publicationOperation({ writer, sequence, publicationId, manifestId, title, bodySeed = sequence }) {
  return {
    type: 'catalog:append',
    writerKey: writer.publicKey,
    policyEpoch: 0,
    writerSequence: sequence,
    publicationId,
    manifestId,
    claims: [{ type: 'title', value: title }],
    bodyHash: b4a.alloc(32, bodySeed),
  }
}

test('publisher catalog ingests authorized device writer operations idempotently', (t) => {
  const root = keyPair(1)
  const writer = keyPair(2)
  const auth = createAuthorizationState({
    rootKey: root.publicKey,
    writers: [{ writerKey: writer.publicKey, capabilities: ['catalog:append'] }],
  })
  let state = createPublisherCatalogState({ publisherId: 'ptpub:test', authorizationState: auth })
  const op = publicationOperation({ writer, sequence: 1, publicationId: 'pub:one', manifestId: 'manifest:one', title: 'Episode One' })

  const first = applyCatalogOperation(state, op)
  assert.equal(first.accepted, true)
  state = first.state
  const replay = applyCatalogOperation(state, op)
  assert.equal(replay.accepted, true)
  assert.equal(replay.reason, 'already-accepted')
  assert.deepEqual(getCatalogPublications(replay.state).map(item => item.publicationId), ['pub:one'])
  t.pass('authorized catalog operation accepted once')
})

test('publisher catalog rejects unknown writers and sequence reuse with different bytes', (t) => {
  const root = keyPair(10)
  const writer = keyPair(11)
  const attacker = keyPair(12)
  const auth = createAuthorizationState({
    rootKey: root.publicKey,
    writers: [{ writerKey: writer.publicKey, capabilities: ['catalog:append'] }],
  })
  let state = createPublisherCatalogState({ publisherId: 'ptpub:test', authorizationState: auth })
  state = applyCatalogOperation(state, publicationOperation({ writer, sequence: 1, publicationId: 'pub:one', manifestId: 'manifest:one', title: 'One', bodySeed: 1 })).state

  const unknown = applyCatalogOperation(state, publicationOperation({ writer: attacker, sequence: 1, publicationId: 'pub:bad', manifestId: 'manifest:bad', title: 'Bad', bodySeed: 2 }))
  assert.equal(unknown.accepted, false)
  assert.equal(unknown.reason, 'unknown-writer')

  const reused = applyCatalogOperation(state, publicationOperation({ writer, sequence: 1, publicationId: 'pub:other', manifestId: 'manifest:other', title: 'Other', bodySeed: 3 }))
  assert.equal(reused.accepted, false)
  assert.equal(reused.reason, 'sequence-reuse-different-bytes')
  t.pass('catalog authorization failure paths preserved')
})

test('catalog view materializes deterministic ordering and digest independent of arrival order', (t) => {
  const root = keyPair(20)
  const writerA = keyPair(21)
  const writerB = keyPair(22)
  const auth = createAuthorizationState({
    rootKey: root.publicKey,
    writers: [
      { writerKey: writerA.publicKey, capabilities: ['catalog:append'] },
      { writerKey: writerB.publicKey, capabilities: ['catalog:append'] },
    ],
  })
  const opA = publicationOperation({ writer: writerA, sequence: 2, publicationId: 'pub:b', manifestId: 'manifest:b', title: 'B', bodySeed: 4 })
  const opB = publicationOperation({ writer: writerB, sequence: 1, publicationId: 'pub:a', manifestId: 'manifest:a', title: 'A', bodySeed: 5 })

  let left = createPublisherCatalogState({ publisherId: 'ptpub:test', authorizationState: auth })
  left = applyCatalogOperation(applyCatalogOperation(left, opA).state, opB).state
  let right = createPublisherCatalogState({ publisherId: 'ptpub:test', authorizationState: auth })
  right = applyCatalogOperation(applyCatalogOperation(right, opB).state, opA).state

  const leftView = materializeCatalogView(left)
  const rightView = materializeCatalogView(right)
  assert.deepEqual(leftView.publications.map(item => item.publicationId), ['pub:a', 'pub:b'])
  assert.deepEqual(rightView.publications.map(item => item.publicationId), ['pub:a', 'pub:b'])
  assert.deepEqual(leftView.viewHeadDigest, rightView.viewHeadDigest)
  assert.equal(leftView.writerHeads[hex(writerA.publicKey)], 2)
  assert.equal(leftView.writerHeads[hex(writerB.publicKey)], 1)
  t.pass('catalog projection deterministic')
})
