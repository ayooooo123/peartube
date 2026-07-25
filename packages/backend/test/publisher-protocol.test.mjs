import test from 'brittle'
import crypto from 'hypercore-crypto'

import { createPublicationBatch } from '../src/assets/index.js'
import {
  PUBLISHER_CATALOG_PAGE_CAPABILITY,
  PUBLISHER_CATALOG_PAGE_RECORD_TYPE,
  createPublisherCatalogPage,
  verifyPublisherCatalogPage
} from '../src/discovery/publisher-protocol.js'
import { PROTOCOL_ERROR_CODES } from '../src/network/index.js'
import { encodeCanonical } from '../src/publisher/canonical.js'
import { createApplicationEnvelope } from '../src/records/application-envelope.js'

const publisher = crypto.keyPair(Buffer.alloc(32, 1))

function batch(id = 'one') {
  const builder = createPublicationBatch({
    publisherId: Buffer.from(publisher.publicKey).toString('hex'),
    sequence: id === 'one' ? 1 : 2,
  })
  builder.addClaim({
    claimType: 'EntityMetadataClaim',
    claimId: (id === 'one' ? '1' : '2').repeat(64).slice(0, 64),
    subjectRefs: [`work:${id}`],
    payload: { title: `Title ${id}` },
  })
  return builder.seal()
}

test('publisher catalog page signs bounded atomic batches and resumes by cursor', async (t) => {
  const page = createPublisherCatalogPage({
    publisherId: Buffer.from(publisher.publicKey).toString('hex'),
    pageCursor: '0',
    nextCursor: '1',
    catalogHead: 'a'.repeat(64),
    batches: [batch('one')],
    keyPair: publisher,
    issuedAt: 10,
  })
  const verified = await verifyPublisherCatalogPage(page.envelope, { publisherId: Buffer.from(publisher.publicKey).toString('hex'), now: 20 })
  t.is(verified.body.nextCursor, '1')
  t.is(verified.body.batches[0].catalogDigest, batch('one').digest)
  t.is(verified.body.batches[0].entries[0].claimType, 'EntityMetadataClaim')
})

test('publisher catalog pages advertise canonical requirements and fail closed on unknown capabilities', async (t) => {
  const page = createPublisherCatalogPage({
    publisherId: Buffer.from(publisher.publicKey).toString('hex'),
    pageCursor: '0',
    nextCursor: null,
    catalogHead: 'a'.repeat(64),
    batches: [batch('one')],
    keyPair: publisher,
    issuedAt: 10,
    protocolMinor: 4,
    requiredCapabilities: ['z-catalog-page:v1', 'a-catalog-page:v1', 'z-catalog-page:v1'],
  })
  t.alike(page.body.requiredCapabilities, [
    'a-catalog-page:v1',
    PUBLISHER_CATALOG_PAGE_CAPABILITY,
    'z-catalog-page:v1',
  ])
  try {
    await verifyPublisherCatalogPage(page.envelope, {
      publisherId: Buffer.from(publisher.publicKey).toString('hex'),
      now: 20,
    })
    t.fail('unknown required publisher catalog capability must be rejected')
  } catch (error) {
    t.is(error.code, PROTOCOL_ERROR_CODES.CAPABILITY_UNSUPPORTED)
  }

  t.ok(await verifyPublisherCatalogPage(page.envelope, {
    publisherId: Buffer.from(publisher.publicKey).toString('hex'),
    now: 20,
    supportedCapabilities: [
      PUBLISHER_CATALOG_PAGE_CAPABILITY,
      'a-catalog-page:v1',
      'z-catalog-page:v1',
    ],
  }), 'compatible minor page verifies when requirements are supported')
})

test('publisher catalog verifier requires its surface capability and never opts online pages into legacy omission', async (t) => {
  const valid = createPublisherCatalogPage({
    publisherId: Buffer.from(publisher.publicKey).toString('hex'),
    pageCursor: '0',
    nextCursor: null,
    catalogHead: 'a'.repeat(64),
    batches: [],
    keyPair: publisher,
    issuedAt: 10,
  })
  const missingCapability = { ...valid.body, requiredCapabilities: [] }
  const missingCapabilityEnvelope = createApplicationEnvelope({
    recordType: PUBLISHER_CATALOG_PAGE_RECORD_TYPE,
    body: encodeCanonical(missingCapability),
    keyPair: publisher,
    issuedAt: missingCapability.issuedAt,
  })
  try {
    await verifyPublisherCatalogPage(missingCapabilityEnvelope, {
      publisherId: missingCapability.publisherId,
      now: 20,
    })
    t.fail('mandatory catalog-page capability must be advertised')
  } catch (error) {
    t.is(error.code, PROTOCOL_ERROR_CODES.ADVERTISEMENT_REQUIRED)
  }

  const {
    minimumProtocolMajor: _minimumProtocolMajor,
    protocolMinor: _protocolMinor,
    requiredCapabilities: _requiredCapabilities,
    ...legacyBody
  } = valid.body
  const legacyEnvelope = createApplicationEnvelope({
    recordType: PUBLISHER_CATALOG_PAGE_RECORD_TYPE,
    body: encodeCanonical(legacyBody),
    keyPair: publisher,
    issuedAt: legacyBody.issuedAt,
  })
  try {
    await verifyPublisherCatalogPage(legacyEnvelope, {
      publisherId: legacyBody.publisherId,
      now: 20,
      legacyCompatibility: {
        minimumProtocolMajor: 1,
        protocolMinor: 0,
        requiredCapabilities: [PUBLISHER_CATALOG_PAGE_CAPABILITY],
      },
    })
    t.fail('online catalog pages cannot opt into legacy omission')
  } catch (error) {
    t.is(error.code, PROTOCOL_ERROR_CODES.ADVERTISEMENT_REQUIRED)
  }
})

test('publisher catalog page rejects stale heads, oversized pages, forks, and wrong signers', async (t) => {
  t.exception(() => createPublisherCatalogPage({ publisherId: Buffer.from(publisher.publicKey).toString('hex'), pageCursor: '0', nextCursor: '1', catalogHead: 'x', batches: [], keyPair: publisher }), /catalogHead/)
  t.exception(() => createPublisherCatalogPage({ publisherId: Buffer.from(publisher.publicKey).toString('hex'), pageCursor: '0', nextCursor: '1', catalogHead: 'a'.repeat(64), batches: Array.from({ length: 65 }, () => batch('one')), keyPair: publisher }), /too many/)
  const other = crypto.keyPair(Buffer.alloc(32, 2))
  const page = createPublisherCatalogPage({ publisherId: Buffer.from(publisher.publicKey).toString('hex'), pageCursor: '0', nextCursor: null, catalogHead: 'a'.repeat(64), batches: [], keyPair: other })
  t.absent(await verifyPublisherCatalogPage(page.envelope, { publisherId: Buffer.from(publisher.publicKey).toString('hex') }))
})
