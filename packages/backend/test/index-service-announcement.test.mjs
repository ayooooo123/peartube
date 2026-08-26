import test from 'brittle'
import b4a from 'b4a'
import c from 'compact-encoding'
import crypto from 'hypercore-crypto'

import {
  IndexServiceAnnouncementV1,
  INDEX_SERVICE_ANNOUNCEMENT_RECORD_TYPE,
  MAX_INDEX_SERVICE_ANNOUNCEMENT_BYTES,
  MAX_INDEX_SERVICE_CAPABILITIES,
  MAX_INDEX_SERVICE_DIMENSIONS,
  MAX_INDEX_SERVICE_RANGES,
  createIndexServiceAnnouncement,
  decodeIndexServiceAnnouncement,
  deriveIndexerId,
  encodeIndexServiceAnnouncement,
  signIndexServiceAnnouncement,
  verifyIndexServiceAnnouncement,
} from '../src/indexer/service-announcement.js'

const NOW = 1_700_000_000_000

function keyPair(fill) {
  return crypto.keyPair(b4a.alloc(32, fill))
}

function fixture(overrides = {}, signer = keyPair(1)) {
  return createIndexServiceAnnouncement({
    indexerId: deriveIndexerId(signer.publicKey),
    transportPublicKey: b4a.alloc(32, 2),
    dimensions: ['external-ref'],
    shardRanges: [{ dimension: 'external-ref', start: null, end: null }],
    queryCapabilities: ['exact-external-ref'],
    policyDigest: b4a.alloc(32, 3),
    sequence: 7,
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    ...overrides,
  }, signer)
}

test('index service announcement has a canonical bounded round trip', async t => {
  const signed = fixture()
  const encoded = encodeIndexServiceAnnouncement(signed)
  const decoded = decodeIndexServiceAnnouncement(encoded)

  t.is(IndexServiceAnnouncementV1.version, 1)
  t.alike(IndexServiceAnnouncementV1.encode(IndexServiceAnnouncementV1.decode(encoded)), encoded)
  t.ok(encoded.byteLength <= MAX_INDEX_SERVICE_ANNOUNCEMENT_BYTES)
  t.alike(encodeIndexServiceAnnouncement(decoded), encoded)
  t.alike(decoded.dimensions, ['external-ref'])
  t.alike(decoded.shardRanges, [{ dimension: 'external-ref', start: null, end: null }])
  t.alike(decoded.queryCapabilities, ['exact-external-ref'])
  t.ok(await verifyIndexServiceAnnouncement(decoded, { now: NOW + 1 }))

  const resigned = signIndexServiceAnnouncement({ ...decoded, envelope: undefined }, keyPair(1))
  t.alike(encodeIndexServiceAnnouncement(resigned), encoded)
})

test('announcement verification rejects tampering, signature changes, and the wrong record domain or indexer binding', async t => {
  const signed = fixture()
  const tamperedTransport = { ...signed, transportPublicKey: b4a.alloc(32, 9) }
  t.is(await verifyIndexServiceAnnouncement(tamperedTransport, { now: NOW + 1 }), false)

  const badSignature = b4a.from(signed.envelope.signature)
  badSignature[0] ^= 0xff
  t.is(await verifyIndexServiceAnnouncement({
    ...signed,
    envelope: { ...signed.envelope, signature: badSignature },
  }, { now: NOW + 1 }), false)

  t.is(await verifyIndexServiceAnnouncement({
    ...signed,
    indexerId: b4a.alloc(32, 8),
  }, { now: NOW + 1 }), false)

  t.is(await verifyIndexServiceAnnouncement({
    ...signed,
    envelope: { ...signed.envelope, recordType: `${INDEX_SERVICE_ANNOUNCEMENT_RECORD_TYPE}.other` },
  }, { now: NOW + 1 }), false)
})

test('announcement transport authentication compares the live key with the signed key', async t => {
  const signed = fixture()
  t.ok(await verifyIndexServiceAnnouncement(signed, {
    now: NOW + 1,
    remotePublicKey: signed.transportPublicKey,
  }))
  t.is(await verifyIndexServiceAnnouncement(signed, {
    now: NOW + 1,
    remotePublicKey: b4a.alloc(32, 99),
  }), false)
})

test('announcement expiry is inclusive at the boundary and rejects future issuance', async t => {
  const signed = fixture()
  t.ok(await verifyIndexServiceAnnouncement(signed, { now: signed.expiresAt }))
  t.is(await verifyIndexServiceAnnouncement(signed, { now: signed.expiresAt + 1 }), false)
  t.is(await verifyIndexServiceAnnouncement(signed, { now: signed.issuedAt - 1 }), false)
  t.exception(() => fixture({ expiresAt: NOW }), /expiresAt/)
})

test('announcement sequence state rejects replay and accepts only a monotonic successor', async t => {
  const sequenceState = new Map()
  const first = fixture({ sequence: 7 })
  t.ok(await verifyIndexServiceAnnouncement(first, { now: NOW + 1, sequenceState }))
  t.is(await verifyIndexServiceAnnouncement(first, { now: NOW + 1, sequenceState }), false)
  t.is(await verifyIndexServiceAnnouncement(fixture({ sequence: 6 }), { now: NOW + 1, sequenceState }), false)
  t.ok(await verifyIndexServiceAnnouncement(fixture({ sequence: 8 }), { now: NOW + 1, sequenceState }))
  t.is(sequenceState.get(b4a.toString(first.indexerId, 'hex')), 8)
})

test('announcement rejects duplicate, unsupported, and over-limit dimensions', t => {
  t.exception(() => fixture({ dimensions: ['external-ref', 'external-ref'] }), /distinct/)
  t.exception(() => fixture({ dimensions: ['everything'] }), /unsupported dimension/)
  t.exception(() => fixture({
    dimensions: Array.from({ length: MAX_INDEX_SERVICE_DIMENSIONS + 1 }, (_, index) => `dimension-${index}`),
  }), /dimensions.*limit/)
})

test('announcement rejects duplicate, unsupported, and over-limit shard ranges', t => {
  const duplicate = { dimension: 'external-ref', start: 'a', end: 'z' }
  t.exception(() => fixture({ shardRanges: [duplicate, duplicate] }), /ranges must be distinct/)
  t.exception(() => fixture({ shardRanges: [{ dimension: 'entity', start: null, end: null }] }), /declared dimension/)
  t.exception(() => fixture({
    shardRanges: Array.from({ length: MAX_INDEX_SERVICE_RANGES + 1 }, (_, index) => ({
      dimension: 'external-ref', start: `a${index}`, end: `b${index}`,
    })),
  }), /ranges.*limit/)
})

test('announcement rejects duplicate, unsupported, and over-limit query capabilities', t => {
  t.exception(() => fixture({ queryCapabilities: ['exact-external-ref', 'exact-external-ref'] }), /distinct/)
  t.exception(() => fixture({ queryCapabilities: ['arbitrary-code'] }), /unsupported query capability/)
  t.exception(() => fixture({
    queryCapabilities: Array.from({ length: MAX_INDEX_SERVICE_CAPABILITIES + 1 }, (_, index) => `capability-${index}`),
  }), /capabilities.*limit/)
})

test('announcement rejects malformed and noncanonical shard bounds', t => {
  t.exception(() => fixture({ shardRanges: [{ dimension: 'external-ref', start: 'z', end: 'a' }] }), /greater than start/)
  t.exception(() => fixture({ shardRanges: [{ dimension: 'external-ref', start: 'a', end: 'a' }] }), /greater than start/)
  t.exception(() => fixture({ shardRanges: [{ dimension: 'external-ref', start: '', end: null }] }), /bounded string/)
  t.exception(() => fixture({ shardRanges: [{ dimension: 'external-ref', start: 'e\u0301', end: 'z' }] }), /NFC/)
})

test('announcement decode and fields enforce byte ceilings before allocation or signing', t => {
  t.exception(() => decodeIndexServiceAnnouncement(b4a.alloc(MAX_INDEX_SERVICE_ANNOUNCEMENT_BYTES + 1)), /maximum/)
  t.exception(() => fixture({
    shardRanges: [{ dimension: 'external-ref', start: 'a'.repeat(513), end: null }],
  }), /bounded string/)
  t.exception(() => fixture({ queryCapabilities: [`x${'a'.repeat(128)}`] }), /bounded string|unsupported/)

  const signed = fixture()
  const encoded = encodeIndexServiceAnnouncement(signed)
  const trailing = b4a.concat([encoded, c.encode(c.uint, 0)])
  t.exception(() => decodeIndexServiceAnnouncement(trailing), /trailing|mismatch|maximum/)
})
