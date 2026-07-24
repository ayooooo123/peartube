import test from 'brittle'
import crypto from 'hypercore-crypto'

import { createIndexFeedPage, verifyIndexFeedPage } from '../src/indexing/feed-contract.js'

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

test('index feed page rejects oversized pages, stale signatures, and wrong signers', async (t) => {
  t.exception(() => createIndexFeedPage({ curatorId, pageCursor: '0', nextCursor: null, records: Array.from({ length: 129 }, () => record('a')), keyPair: curator }), /too many/)
  const other = crypto.keyPair(Buffer.alloc(32, 2))
  const wrong = createIndexFeedPage({ curatorId, pageCursor: '0', nextCursor: null, records: [record('a')], keyPair: other, expiresAt: 100 })
  t.absent(await verifyIndexFeedPage(wrong.envelope, { curatorId, now: 20 }))
  const expired = createIndexFeedPage({ curatorId, pageCursor: '0', nextCursor: null, records: [record('a')], keyPair: curator, expiresAt: 1 })
  t.absent(await verifyIndexFeedPage(expired.envelope, { curatorId, now: 2 }))
})
