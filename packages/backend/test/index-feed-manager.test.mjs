import test from 'brittle'
import crypto from 'hypercore-crypto'

import { createIndexFeedPage } from '../src/indexing/feed-contract.js'
import { createIndexFeedManager } from '../src/indexing/feed-manager.js'

const curator = crypto.keyPair(Buffer.alloc(32, 1))
const curatorId = Buffer.from(curator.publicKey).toString('hex')

function page(cursor = '0', nextCursor = null, extra = {}) {
  return createIndexFeedPage({
    curatorId,
    pageCursor: cursor,
    nextCursor,
    records: [{ kind: 'publication-reference', entityRef: 'work:a', publicationId: 'a'.repeat(64), publisherId: 'b'.repeat(64), title: 'Alpha', tags: ['demo'], ...extra }],
    keyPair: curator,
    expiresAt: 100,
  })
}

test('index feed manager ingests only explicit subscriptions and persists cursors lazily', async (t) => {
  const manager = createIndexFeedManager({ now: () => 10 })
  const ignored = await manager.syncFeed({ curatorId, startCursor: '0', fetchPage: async () => page() })
  t.is(ignored.status, 'not-subscribed')
  manager.subscribe(curatorId)
  const result = await manager.syncFeed({ curatorId, startCursor: '0', fetchPage: async () => page('0', null) })
  t.is(result.status, 'complete')
  t.is(manager.getRecords().length, 1)
  t.is(manager.getCheckpoint(curatorId).cursor, null)
})

test('index feed manager quarantines stale/forked pages and bounds spam without media downloads', async (t) => {
  const opened = []
  const manager = createIndexFeedManager({ now: () => 10, maxRecordsPerSync: 1, openMedia: ref => opened.push(ref) })
  manager.subscribe(curatorId)
  const partial = await manager.syncFeed({ curatorId, startCursor: '0', fetchPage: async () => page('0', '1') })
  t.is(partial.status, 'partial')
  t.is(partial.nextCursor, '1')
  const forked = await manager.syncFeed({ curatorId, startCursor: '1', fetchPage: async () => page('wrong', null) })
  t.is(forked.status, 'quarantined')
  t.alike(opened, [])
})

test('index feed manager quarantines unsupported requirements before projecting records', async (t) => {
  const manager = createIndexFeedManager({ now: () => 10 })
  manager.subscribe(curatorId)
  const incompatible = createIndexFeedPage({
    curatorId,
    pageCursor: '0',
    nextCursor: null,
    records: [{
      kind: 'publication-reference',
      entityRef: 'work:future',
      publicationId: 'c'.repeat(64),
      publisherId: 'b'.repeat(64),
    }],
    requiredCapabilities: ['future-global-discovery:v1'],
    keyPair: curator,
    expiresAt: 100,
  })

  const result = await manager.syncFeed({
    curatorId,
    startCursor: '0',
    fetchPage: async () => incompatible,
  })
  t.is(result.status, 'quarantined')
  t.is(result.errorCode, 'PROTOCOL_CAPABILITY_UNSUPPORTED')
  t.alike(manager.getRecords(), [], 'no record is projected and no deleted global-feed fallback is attempted')
})
