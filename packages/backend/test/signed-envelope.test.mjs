import assert from 'node:assert/strict'
import b4a from 'b4a'
import c from 'compact-encoding'
import crypto from 'hypercore-crypto'
import test from 'brittle'

import {
  MAX_SIGNED_BODY_BYTES,
  createSignedEnvelope,
  decodeSignedEnvelope,
  deriveRecordId,
  encodeSignedEnvelope,
  verifySignedEnvelope,
} from '../src/records/signed-envelope.js'
import {
  MAX_MULTI_SIGNATURES,
  createMultiSignedEnvelope,
  decodeMultiSignedEnvelope,
  deriveTransitionId,
  encodeMultiSignedEnvelope,
  verifyMultiSignedEnvelope,
} from '../src/records/multi-signed-envelope.js'

function keyPair(seedByte) {
  return crypto.keyPair(b4a.alloc(32, seedByte))
}

function hex(buf) {
  return b4a.toString(buf, 'hex')
}

test('SignedEnvelope derives a domain-separated canonical id and verifies only with explicit authorization', async (t) => {
  const publisher = keyPair(1)
  const body = b4a.from('catalog-operation-v1')

  const envelope = createSignedEnvelope({
    recordType: 'publisher.catalog.operation.v1',
    body,
    keyPair: publisher,
    issuedAt: 1000,
    expiresAt: 2000,
  })

  assert.deepEqual(envelope.recordId, deriveRecordId({
    recordType: 'publisher.catalog.operation.v1',
    body,
    issuedAt: 1000,
    expiresAt: 2000,
  }))
  assert.notDeepEqual(envelope.recordId, deriveRecordId({
    recordType: 'publisher.namespace.transition.v1',
    body,
    issuedAt: 1000,
    expiresAt: 2000,
  }))

  await assert.rejects(
    () => verifySignedEnvelope(envelope, { now: 1500 }),
    /authorization context/i,
  )

  t.is(await verifySignedEnvelope(envelope, {
    now: 1500,
    recordType: 'publisher.catalog.operation.v1',
    allowedSigners: [publisher.publicKey],
  }), true)
  t.is(await verifySignedEnvelope(envelope, {
    now: 1500,
    recordType: 'publisher.namespace.transition.v1',
    allowedSigners: [publisher.publicKey],
  }), false)
  t.is(await verifySignedEnvelope(envelope, {
    now: 2500,
    recordType: 'publisher.catalog.operation.v1',
    allowedSigners: [publisher.publicKey],
  }), false)
})

test('SignedEnvelope encodes bounded body length before body bytes and rejects oversized frames pre-body', async (t) => {
  const publisher = keyPair(2)
  const envelope = createSignedEnvelope({
    recordType: 'publisher.catalog.operation.v1',
    body: b4a.from('roundtrip'),
    keyPair: publisher,
  })
  const encoded = encodeSignedEnvelope(envelope)
  const decoded = decodeSignedEnvelope(encoded)

  assert.deepEqual(decoded.body, b4a.from('roundtrip'))
  assert.equal(decoded.bodyLength, 'roundtrip'.length)
  assert.deepEqual(decoded.recordId, envelope.recordId)
  t.is(await verifySignedEnvelope(decoded, { allowedSigners: [publisher.publicKey] }), true)

  const malicious = b4a.concat([
    c.encode(c.uint, 1),
    c.encode(c.string, 'publisher.catalog.operation.v1'),
    c.encode(c.uint, 0),
    c.encode(c.uint, 0),
    c.encode(c.bool, false),
    c.encode(c.uint, MAX_SIGNED_BODY_BYTES + 1),
  ])
  assert.throws(
    () => decodeSignedEnvelope(malicious, { maxBodyBytes: MAX_SIGNED_BODY_BYTES }),
    /body length exceeds/i,
  )
})

test('SignedEnvelope nonce replay is rejected when a replay cache is supplied', async (t) => {
  const publisher = keyPair(3)
  const replayCache = new Set()
  const envelope = createSignedEnvelope({
    recordType: 'publisher.peer.challenge.v1',
    body: b4a.from('challenge'),
    nonce: b4a.alloc(32, 7),
    keyPair: publisher,
  })

  t.is(await verifySignedEnvelope(envelope, {
    allowedSigners: [publisher.publicKey],
    requireNonce: true,
    replayCache,
    consumeNonce: true,
  }), true)
  t.is(await verifySignedEnvelope(envelope, {
    allowedSigners: [publisher.publicKey],
    requireNonce: true,
    replayCache,
    consumeNonce: true,
  }), false)
})

test('MultiSignedEnvelope derives one transition id and requires sorted unique capped signatures', async (t) => {
  const a = keyPair(10)
  const b = keyPair(11)
  const body = b4a.from('root-rotation')

  const envelope = createMultiSignedEnvelope({
    recordType: 'publisher.root.transition.v1',
    body,
    keyPairs: [b, a],
  })

  assert.deepEqual(envelope.transitionId, deriveTransitionId({
    recordType: 'publisher.root.transition.v1',
    body,
  }))
  assert.deepEqual(
    envelope.signatures.map(sig => hex(sig.signer)),
    [hex(a.publicKey), hex(b.publicKey)].sort(),
  )
  t.is(await verifyMultiSignedEnvelope(envelope, {
    recordType: 'publisher.root.transition.v1',
    threshold: 2,
    allowedSigners: [a.publicKey, b.publicKey],
  }), true)

  const decoded = decodeMultiSignedEnvelope(encodeMultiSignedEnvelope(envelope))
  assert.deepEqual(decoded.transitionId, envelope.transitionId)
  t.is(await verifyMultiSignedEnvelope(decoded, {
    recordType: 'publisher.root.transition.v1',
    threshold: 2,
    allowedSigners: [a.publicKey, b.publicKey],
  }), true)

  assert.throws(() => createMultiSignedEnvelope({
    recordType: 'publisher.root.transition.v1',
    body,
    keyPairs: [a, a],
  }), /duplicate signer/i)

  assert.throws(() => createMultiSignedEnvelope({
    recordType: 'publisher.root.transition.v1',
    body,
    keyPairs: Array.from({ length: MAX_MULTI_SIGNATURES + 1 }, (_, index) => keyPair(index + 20)),
  }), /too many signatures/i)
})
