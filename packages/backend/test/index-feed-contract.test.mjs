import test from 'brittle'
import crypto from 'hypercore-crypto'

import {
  INDEX_FEED_CAPABILITY,
  INDEX_FEED_PAGE_RECORD_TYPE,
  createIndexFeedPage,
  verifyIndexFeedPage
} from '../src/indexing/feed-contract.js'
import { PROTOCOL_ERROR_CODES } from '../src/network/index.js'
import { encodeCanonical } from '../src/publisher/canonical.js'
import { createApplicationEnvelope } from '../src/records/application-envelope.js'

const curator = crypto.keyPair(Buffer.alloc(32, 1))
const curatorId = Buffer.from(curator.publicKey).toString('hex')

function record(id = 'a') {
  return {
    kind: 'publication-reference',
    entityRef: `work:${id}`,
    publicationId: id.repeat(64).slice(0, 64),
    publisherId: 'b'.repeat(64),
    catalogBlockHint: 12,
    rootTransitionProofDigest: 'c'.repeat(64),
    title: `Title ${id}`,
    creator: 'Creator',
    tags: ['demo', 'video'],
    ranking: { score: 0.5, methodology: 'manual' },
    model: { id: 'human', version: '1' },
  }
}

test('index feed page signs bounded locator records with hints only', async (t) => {
  const page = createIndexFeedPage({ curatorId, pageCursor: '0', nextCursor: '1', records: [record('a')], keyPair: curator, issuedAt: 10, expiresAt: 100 })
  const verified = await verifyIndexFeedPage(page.envelope, { curatorId, now: 20 })
  t.ok(verified)
  t.is(verified.body.records[0].catalogBlockHint, 12)
  t.is(verified.body.records[0].rootTransitionProofDigest, 'c'.repeat(64))
  t.is(page.pageId, page.envelope.recordIdHex)
})
test('index pages advertise sorted requirements and reject unsupported capabilities before projection', async (t) => {
  const page = createIndexFeedPage({
    curatorId,
    pageCursor: '0',
    nextCursor: null,
    records: [record('a')],
    keyPair: curator,
    issuedAt: 10,
    expiresAt: 100,
    protocolMinor: 5,
    requiredCapabilities: ['z-index:v1', 'a-index:v1', 'z-index:v1'],
  })
  t.is(page.body.minimumProtocolMajor, 1)
  t.is(page.body.protocolMinor, 5)
  t.alike(page.body.requiredCapabilities, ['a-index:v1', INDEX_FEED_CAPABILITY, 'z-index:v1'])
  try {
    await verifyIndexFeedPage(page.envelope, {
      curatorId,
      now: 20,
      supportedCapabilities: [INDEX_FEED_CAPABILITY],
    })
    t.fail('unknown index capability must be rejected')
  } catch (error) {
    t.is(error.code, PROTOCOL_ERROR_CODES.CAPABILITY_UNSUPPORTED)
  }
  t.ok(await verifyIndexFeedPage(page.envelope, {
    curatorId,
    now: 20,
    supportedCapabilities: [INDEX_FEED_CAPABILITY, 'a-index:v1', 'z-index:v1'],
  }), 'compatible minor changes verify when all required capabilities are known')
})



test('index verifier requires its surface capability', async (t) => {
  const valid = createIndexFeedPage({
    curatorId,
    pageCursor: '0',
    nextCursor: null,
    records: [],
    keyPair: curator,
    issuedAt: 10,
    expiresAt: 100,
  })
  const body = { ...valid.body, requiredCapabilities: [] }
  const envelope = createApplicationEnvelope({
    recordType: INDEX_FEED_PAGE_RECORD_TYPE,
    body: encodeCanonical(body),
    keyPair: curator,
    issuedAt: body.issuedAt,
    expiresAt: 100,
  })
  try {
    await verifyIndexFeedPage(envelope, { curatorId, now: 20 })
    t.fail('mandatory index-feed capability must be advertised')
  } catch (error) {
    t.is(error.code, PROTOCOL_ERROR_CODES.ADVERTISEMENT_REQUIRED)
  }
})
test('index feed page rejects oversized pages, stale signatures, and wrong signers', async (t) => {
  t.exception(() => createIndexFeedPage({ curatorId, pageCursor: '0', nextCursor: null, records: Array.from({ length: 129 }, () => record('a')), keyPair: curator }), /too many/)
  const other = crypto.keyPair(Buffer.alloc(32, 2))
  const wrong = createIndexFeedPage({ curatorId, pageCursor: '0', nextCursor: null, records: [record('a')], keyPair: other, expiresAt: 100 })
  t.absent(await verifyIndexFeedPage(wrong.envelope, { curatorId, now: 20 }))
  const expired = createIndexFeedPage({ curatorId, pageCursor: '0', nextCursor: null, records: [record('a')], keyPair: curator, expiresAt: 1 })
  t.absent(await verifyIndexFeedPage(expired.envelope, { curatorId, now: 2 }))
})
