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

function stateRepository() {
  let state = null
  return {
    async load() { return state == null ? null : structuredClone(state) },
    async save(next) { state = structuredClone(next) },
  }
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

test('index subscriptions and multi-page checkpoints survive restart and duplicate first pages advance', async (t) => {
  const repository = stateRepository()
  const first = createIndexFeedManager({
    now: () => 10,
    maxRecordsPerSync: 1,
    stateRepository: repository,
  })
  await first.ready
  await first.subscribe(curatorId)
  const pages = new Map([
    ['0', page('0', '1', { entityRef: 'work:first', publicationId: 'c'.repeat(64) })],
    ['1', page('1', null, { entityRef: 'work:second', publicationId: 'd'.repeat(64) })],
  ])
  t.is((await first.syncFeed({ curatorId, fetchPage: async cursor => pages.get(cursor) })).status, 'partial')
  t.is(first.getCheckpoint(curatorId).cursor, '1')

  const restarted = createIndexFeedManager({
    now: () => 10,
    maxRecordsPerSync: 4,
    stateRepository: repository,
  })
  await restarted.ready
  const resumedCursors = []
  const resumed = await restarted.syncFeed({
    curatorId,
    fetchPage: async cursor => {
      resumedCursors.push(cursor)
      return pages.get(cursor)
    },
  })
  t.is(resumed.status, 'complete')
  t.alike(resumedCursors, ['1'], 'restart resumes the persisted next cursor')
  t.is(restarted.getRecords().length, 2)

  const duplicateCursors = []
  const duplicate = await restarted.syncFeed({
    curatorId,
    startCursor: '0',
    fetchPage: async cursor => {
      duplicateCursors.push(cursor)
      return pages.get(cursor)
    },
  })
  t.is(duplicate.status, 'complete')
  t.alike(duplicateCursors, ['0', '1'], 'a duplicate completed page advances instead of terminating sync')

  await restarted.unsubscribe(curatorId)
  t.is(restarted.getCheckpoint(curatorId), null)
  t.alike(restarted.getRecords(), [], 'unsubscribe clears accepted records and checkpoints')
})

test('index feed cumulative global and publisher budgets survive restart and expire honestly', async (t) => {
  const repository = stateRepository()
  let clock = 10
  const options = {
    now: () => clock,
    stateRepository: repository,
    budgetWindowMs: 5,
    maxRecordsGlobalPerWindow: 1,
    maxRecordsPerIndexPerWindow: 8,
    maxRecordsPerPublisherPerWindow: 1,
  }
  const first = createIndexFeedManager(options)
  await first.ready
  await first.subscribe(curatorId)
  t.is((await first.syncFeed({
    curatorId,
    startCursor: '0',
    fetchPage: async () => page('0', null, { publicationId: 'e'.repeat(64) }),
  })).status, 'complete')

  const restarted = createIndexFeedManager(options)
  await restarted.ready
  const sameWindow = await restarted.syncFeed({
    curatorId,
    startCursor: '1',
    fetchPage: async () => page('1', null, {
      entityRef: 'work:budget-two',
      publicationId: 'f'.repeat(64),
    }),
  })
  t.is(sameWindow.status, 'partial')
  t.ok(
    sameWindow.errorCode === 'GLOBAL_WINDOW_BUDGET_EXCEEDED' ||
    sameWindow.errorCode === 'PUBLISHER_WINDOW_BUDGET_EXCEEDED',
    'restart cannot reset a cumulative admission window',
  )

  clock = 16
  const expired = createIndexFeedManager(options)
  await expired.ready
  t.is((await expired.syncFeed({
    curatorId,
    startCursor: '1',
    fetchPage: async () => page('1', null, {
      entityRef: 'work:budget-two',
      publicationId: 'f'.repeat(64),
    }),
  })).status, 'complete', 'an expired window recovers after restart')
})
