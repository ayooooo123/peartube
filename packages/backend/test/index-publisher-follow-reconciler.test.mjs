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
