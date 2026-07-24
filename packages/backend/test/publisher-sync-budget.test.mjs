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

test('publisher sync budgets return structured partial state without eager allocation', async (t) => {
  const page = createPublisherCatalogPage({
    publisherId,
    pageCursor: '0',
    nextCursor: '1',
    catalogHead: 'a'.repeat(64),
    batches: [sealedBatch(1)],
    keyPair: publisher,
  })
  const manager = createPublisherManager({ maxPagesPerSync: 1, maxBatchesPerSync: 1, maxRetainedBatches: 1 })
  const result = await manager.syncPublisher({ publisherId, startCursor: '0', fetchPage: async () => page })
  t.is(result.status, 'partial')
  t.is(result.nextCursor, '1')
  t.is(manager.getCheckpoint(publisherId).cursor, '1')
})
