import test from 'brittle'
import crypto from 'hypercore-crypto'

import { createPublicationBatch } from '../src/assets/index.js'
import { createPublisherCatalogPage } from '../src/discovery/publisher-protocol.js'
import { createPublisherManager } from '../src/discovery/publisher-manager.js'

const publisher = crypto.keyPair(Buffer.alloc(32, 1))
const publisherId = Buffer.from(publisher.publicKey).toString('hex')

function sealedBatch(sequence) {
  const builder = createPublicationBatch({ publisherId, sequence })
  builder.addClaim({
    claimType: 'EntityMetadataClaim',
    claimId: `${sequence}`.repeat(64).slice(0, 64),
    subjectRefs: [`work:${sequence}`],
    payload: { title: `Title ${sequence}` },
  })
  return builder.seal()
}

function page(cursor, nextCursor, sequence) {
  return createPublisherCatalogPage({
    publisherId,
    pageCursor: cursor,
    nextCursor,
    catalogHead: `${sequence}`.repeat(64).slice(0, 64),
    batches: [sealedBatch(sequence)],
    keyPair: publisher,
  })
}

test('publisher manager follows one publisher lazily, persists cursor, and ingests batches', async (t) => {
  const pages = new Map([['0', page('0', '1', 1)], ['1', page('1', null, 2)]])
  const ingested = []
  const manager = createPublisherManager({ ingestBatch: async batch => ingested.push(batch.catalogDigest) })
  const result = await manager.syncPublisher({ publisherId, startCursor: '0', fetchPage: async cursor => pages.get(cursor) })
  t.is(result.status, 'complete')
  t.is(result.nextCursor, null)
  t.is(manager.getCheckpoint(publisherId).cursor, null)
  t.is(ingested.length, 2)
})

test('publisher manager rejects forks/stale cursors and stops discovery on unsubscribe', async (t) => {
  const manager = createPublisherManager()
  await manager.followPublisher(publisherId)
  t.is(manager.isFollowing(publisherId), true)
  await manager.unfollowPublisher(publisherId)
  t.is(manager.isFollowing(publisherId), false)

  const bad = page('not-requested', null, 1)
  const result = await manager.syncPublisher({ publisherId, startCursor: '0', fetchPage: async () => bad })
  t.is(result.status, 'quarantined')
  t.is(result.errorCode, 'STALE_OR_FORKED_CURSOR')
})
