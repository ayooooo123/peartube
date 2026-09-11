import test from 'brittle'
import crypto from 'hypercore-crypto'

import { createIndexFeedPage } from '../src/indexing/feed-contract.js'
import { createIndexFeedManager } from '../src/indexing/feed-manager.js'
import { createIndexPublisherFollowReconciler } from '../src/indexing/publisher-follow-reconciler.js'

const curator = crypto.keyPair(Buffer.alloc(32, 51))
const attacker = crypto.keyPair(Buffer.alloc(32, 52))
const curatorId = Buffer.from(curator.publicKey).toString('hex')
const publisherId = 'a1'.repeat(32)
const publicationId = 'b2'.repeat(32)

function signedPage(keyPair = curator, cursor = '0') {
  return createIndexFeedPage({
    curatorId,
    pageCursor: cursor,
    nextCursor: null,
    records: [{
      kind: 'publication-reference',
      entityRef: 'work:index-hint',
      publicationId,
      publisherId,
      title: 'UNAUTHENTICATED INDEX TITLE',
    }],
    keyPair,
    expiresAt: 100,
  })
}

test('authenticated index introductions add removable publisher follow reasons', async (t) => {
  const calls = []
  let manager
  const scopedNetwork = {
    async addPublisherFollowReason(input) {
      calls.push(['add', input])
      return { status: 'scheduled' }
    },
    async removePublisherFollowReason(input) {
      calls.push(['remove', input])
      return { status: 'removed' }
    },
  }
  const reconciler = createIndexPublisherFollowReconciler({
    getScopedNetwork: () => scopedNetwork,
    getRecords: () => manager?.getRecords?.() || [],
  })
  manager = createIndexFeedManager({
    now: () => 10,
    onAcceptedRecord: reconciler.onAcceptedRecord,
    onRecordsRemoved: reconciler.onRecordsRemoved,
  })
  await manager.subscribe(curatorId)

  t.is((await manager.syncFeed({
    curatorId,
    fetchPage: async () => signedPage(),
  })).status, 'complete')
  t.alike(calls, [[
    'add',
    { publisherId, reason: `index:${curatorId}` },
  ]], 'only the verified signed page triggers publisher resolution')

  const invalid = await manager.syncFeed({
    curatorId,
    startCursor: '1',
    fetchPage: async () => signedPage(attacker, '1'),
  })
  t.is(invalid.status, 'quarantined')
  t.alike(manager.getRecords(), [], 'an invalid continuation removes retained index effects')
  t.alike(calls.at(-1), [
    'remove',
    { publisherId, reason: `index:${curatorId}` },
  ])
})

test('persisted authenticated index introductions reconcile after restart', async (t) => {
  const records = [{
    indexId: curatorId,
    publisherId,
    publicationId,
  }]
  const calls = []
  const reconciler = createIndexPublisherFollowReconciler({
    getScopedNetwork: () => ({
      async addPublisherFollowReason(input) { calls.push(input) },
    }),
    getRecords: () => records,
  })

  await reconciler.reconcile()
  t.alike(calls, [{ publisherId, reason: `index:${curatorId}` }])
})

test('ring buffer eviction removes publisher follow only when no retained hint names that publisher', async (t) => {
  const publisherP = '11'.repeat(32)
  const publisherQ = '22'.repeat(32)
  const calls = []
  let manager
  const scopedNetwork = {
    async addPublisherFollowReason(input) {
      calls.push(['add', input])
      return { status: 'scheduled' }
    },
    async removePublisherFollowReason(input) {
      calls.push(['remove', input])
      return { status: 'removed' }
    },
  }
  const reconciler = createIndexPublisherFollowReconciler({
    getScopedNetwork: () => scopedNetwork,
    getRecords: () => manager?.getRecords?.() || [],
  })
  manager = createIndexFeedManager({
    now: () => 10,
    maxStoredRecords: 1,
    onAcceptedRecord: reconciler.onAcceptedRecord,
    onRecordsRemoved: reconciler.onRecordsRemoved,
  })
  await manager.subscribe(curatorId)

  const page1 = createIndexFeedPage({
    curatorId,
    pageCursor: '0',
    nextCursor: null,
    records: [{
      kind: 'publication-reference',
      entityRef: 'work:p',
      publicationId: '33'.repeat(32),
      publisherId: publisherP,
      title: 'P Title',
    }],
    keyPair: curator,
    expiresAt: 100,
  })
  await manager.syncFeed({ curatorId, fetchPage: async () => page1 })
  t.alike(calls, [
    ['add', { publisherId: publisherP, reason: `index:${curatorId}` }],
  ])

  const page2 = createIndexFeedPage({
    curatorId,
    pageCursor: '1',
    nextCursor: null,
    records: [{
      kind: 'publication-reference',
      entityRef: 'work:q',
      publicationId: '44'.repeat(32),
      publisherId: publisherQ,
      title: 'Q Title',
    }],
    keyPair: curator,
    expiresAt: 100,
  })
  await manager.syncFeed({ curatorId, startCursor: '1', fetchPage: async () => page2 })

  t.alike(calls, [
    ['add', { publisherId: publisherP, reason: `index:${curatorId}` }],
    ['add', { publisherId: publisherQ, reason: `index:${curatorId}` }],
    ['remove', { publisherId: publisherP, reason: `index:${curatorId}` }],
  ])
})

test('ring buffer eviction preserves follow when another retained hint still names that publisher', async (t) => {
  const publisherP = '11'.repeat(32)
  const publisherQ = '22'.repeat(32)
  const calls = []
  let manager
  const scopedNetwork = {
    async addPublisherFollowReason(input) {
      calls.push(['add', input])
      return { status: 'scheduled' }
    },
    async removePublisherFollowReason(input) {
      calls.push(['remove', input])
      return { status: 'removed' }
    },
  }
  const reconciler = createIndexPublisherFollowReconciler({
    getScopedNetwork: () => scopedNetwork,
    getRecords: () => manager?.getRecords?.() || [],
  })
  manager = createIndexFeedManager({
    now: () => 10,
    maxStoredRecords: 2,
    onAcceptedRecord: reconciler.onAcceptedRecord,
    onRecordsRemoved: reconciler.onRecordsRemoved,
  })
  await manager.subscribe(curatorId)

  const page1 = createIndexFeedPage({
    curatorId,
    pageCursor: '0',
    nextCursor: null,
    records: [{
      kind: 'publication-reference',
      entityRef: 'work:p1',
      publicationId: '33'.repeat(32),
      publisherId: publisherP,
      title: 'P Title 1',
    }],
    keyPair: curator,
    expiresAt: 100,
  })
  await manager.syncFeed({ curatorId, fetchPage: async () => page1 })

  const page2 = createIndexFeedPage({
    curatorId,
    pageCursor: '1',
    nextCursor: null,
    records: [{
      kind: 'publication-reference',
      entityRef: 'work:p2',
      publicationId: '44'.repeat(32),
      publisherId: publisherP,
      title: 'P Title 2',
    }],
    keyPair: curator,
    expiresAt: 100,
  })
  await manager.syncFeed({ curatorId, startCursor: '1', fetchPage: async () => page2 })

  const page3 = createIndexFeedPage({
    curatorId,
    pageCursor: '2',
    nextCursor: null,
    records: [{
      kind: 'publication-reference',
      entityRef: 'work:q',
      publicationId: '55'.repeat(32),
      publisherId: publisherQ,
      title: 'Q Title',
    }],
    keyPair: curator,
    expiresAt: 100,
  })
  await manager.syncFeed({ curatorId, startCursor: '2', fetchPage: async () => page3 })

  const removals = calls.filter(([action]) => action === 'remove')
  t.is(removals.length, 0, 'publisher P follow was preserved because another hint still names P')
})
