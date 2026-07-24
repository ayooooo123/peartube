import assert from 'node:assert/strict'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import test from 'brittle'

import {
  createMediaClaimEnvelope,
  createMediaEntityRef,
  decodeMediaClaimBody,
  deriveMediaEntityId,
  encodeMediaClaimBody,
  verifyMediaClaimEnvelope,
} from '../src/media-graph/index.js'

function keyPair(seedByte) {
  return crypto.keyPair(b4a.alloc(32, seedByte))
}

function fixedHex(byte) {
  return b4a.toString(b4a.alloc(32, byte), 'hex')
}

test('media entity references are canonical across locator and variant ordering', (t) => {
  const mediaHash = fixedHex(1)
  const posterHash = fixedHex(2)
  const variantA = { codec: 'av1', bitrate: 700000, contentHash: fixedHex(4), width: 1280, height: 720 }
  const variantB = { codec: 'h264', bitrate: 1500000, contentHash: fixedHex(3), width: 1920, height: 1080 }

  const left = createMediaEntityRef({
    type: 'video',
    contentHash: mediaHash,
    locators: [
      { protocol: 'hypercore', key: fixedHex(5), path: '/media/original.mp4' },
      { protocol: 'https', url: 'https://example.invalid/media/original.mp4' },
    ],
    metadata: { title: 'Demo', durationMs: 1234 },
    thumbnails: [{ role: 'poster', contentHash: posterHash }],
    variants: [variantB, variantA, variantA],
  })
  const right = createMediaEntityRef({
    type: 'video',
    contentHash: mediaHash,
    locators: [
      { url: 'https://example.invalid/media/original.mp4', protocol: 'https' },
      { path: '/media/original.mp4', key: fixedHex(5), protocol: 'hypercore' },
    ],
    metadata: { durationMs: 1234, title: 'Demo' },
    thumbnails: [{ contentHash: posterHash, role: 'poster' }],
    variants: [variantA, variantB],
  })

  assert.deepEqual(left, right)
  assert.equal(left.id, deriveMediaEntityId(right))
  assert.deepEqual(left.variants.map(variant => variant.contentHash), [fixedHex(3), fixedHex(4)])
  t.pass('entity ref is deterministic')
})

test('media entity references reject malformed hashes and ambiguous locators', (t) => {
  assert.throws(() => createMediaEntityRef({ type: 'video', contentHash: 'abc', locators: [] }), /contentHash/i)
  assert.throws(() => createMediaEntityRef({
    type: 'video',
    contentHash: fixedHex(1),
    locators: [{ protocol: 'hypercore', path: '/missing-key' }],
  }), /locator.key/i)
  assert.throws(() => createMediaEntityRef({
    type: 'video',
    contentHash: fixedHex(1),
    locators: [{ protocol: 'https', key: fixedHex(2), url: 'https://example.invalid' }],
  }), /https locator/i)
  t.pass('malformed refs rejected')
})

test('media claim bodies encode bounded deterministic publisher claims', async (t) => {
  const publisher = keyPair(10)
  const device = keyPair(11)
  const ref = createMediaEntityRef({
    type: 'video',
    contentHash: fixedHex(6),
    locators: [{ protocol: 'hypercore', key: fixedHex(7), path: '/original.mp4' }],
    metadata: { title: 'Claimed Demo' },
  })

  const body = encodeMediaClaimBody({
    publisherId: b4a.alloc(32, 8),
    media: ref,
    authorDeviceKey: device.publicKey,
    sequence: 3,
    createdAt: 1000,
    claims: [
      { type: 'origin', value: 'camera-roll' },
      { type: 'license', value: 'private' },
    ],
  })
  const decoded = decodeMediaClaimBody(body)

  assert.equal(decoded.media.id, ref.id)
  assert.equal(decoded.sequence, 3)
  assert.deepEqual(decoded.claims.map(claim => claim.type), ['license', 'origin'])
  assert.deepEqual(body, encodeMediaClaimBody({
    createdAt: 1000,
    claims: [
      { value: 'private', type: 'license' },
      { value: 'camera-roll', type: 'origin' },
    ],
    sequence: 3,
    authorDeviceKey: device.publicKey,
    media: ref,
    publisherId: b4a.alloc(32, 8),
  }))

  const envelope = createMediaClaimEnvelope({ body, keyPair: publisher, issuedAt: 1001 })
  t.is(await verifyMediaClaimEnvelope(envelope, {
    publisherId: b4a.alloc(32, 8),
    allowedSigners: [publisher.publicKey],
    mediaId: ref.id,
  }), true)
  t.is(await verifyMediaClaimEnvelope(envelope, {
    publisherId: b4a.alloc(32, 9),
    allowedSigners: [publisher.publicKey],
    mediaId: ref.id,
  }), false)
  t.is(await verifyMediaClaimEnvelope(envelope, {
    publisherId: b4a.alloc(32, 8),
    allowedSigners: [device.publicKey],
    mediaId: ref.id,
  }), false)
})
