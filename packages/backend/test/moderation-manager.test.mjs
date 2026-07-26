import test from 'brittle'
import crypto from 'hypercore-crypto'

import { createModerationFeedPage } from '../src/moderation/feed-contract.js'
import { createModerationManager } from '../src/moderation/manager.js'

const mod = crypto.keyPair(Buffer.alloc(32, 1))
const moderatorId = Buffer.from(mod.publicKey).toString('hex')

function stateRepository() {
  let state = null
  return {
    async load() { return state == null ? null : structuredClone(state) },
    async save(next) { state = structuredClone(next) },
  }
}

test('moderation manager syncs only explicit subscriptions and persists restart cursors', async (t) => {
  const manager = createModerationManager({ now: () => 10 })
  const page = createModerationFeedPage({ moderatorId, pageCursor: '0', nextCursor: null, records: [{ action: 'block', targetType: 'publication', targetId: 'a'.repeat(64) }], keyPair: mod, expiresAt: 100 })
  t.is((await manager.syncFeed({ moderatorId, startCursor: '0', fetchPage: async () => page })).status, 'not-subscribed')
  manager.subscribe(moderatorId)
  t.is((await manager.syncFeed({ moderatorId, startCursor: '0', fetchPage: async () => page })).status, 'complete')
  t.is(manager.getRecords().length, 1)
  t.is(manager.getCheckpoint(moderatorId).cursor, null)
})

test('moderation subscriptions, records, and next cursor survive restart and unsubscribe clears them', async (t) => {
  const repository = stateRepository()
  const pages = new Map([
    ['0', createModerationFeedPage({
      moderatorId,
      pageCursor: '0',
      nextCursor: '1',
      records: [{ action: 'hide', targetType: 'work', targetId: 'work:first' }],
      keyPair: mod,
      expiresAt: 100,
    })],
    ['1', createModerationFeedPage({
      moderatorId,
      pageCursor: '1',
      nextCursor: null,
      records: [{ action: 'hide', targetType: 'work', targetId: 'work:second' }],
      keyPair: mod,
      expiresAt: 100,
    })],
  ])
  const first = createModerationManager({
    now: () => 10,
    maxRecordsPerSync: 1,
    stateRepository: repository,
  })
  await first.ready
  await first.subscribe(moderatorId)
  t.is((await first.syncFeed({ moderatorId, fetchPage: async cursor => pages.get(cursor) })).status, 'partial')
  t.is(first.getCheckpoint(moderatorId).cursor, '1')

  const restarted = createModerationManager({
    now: () => 10,
    maxRecordsPerSync: 4,
    stateRepository: repository,
  })
  await restarted.ready
  const cursors = []
  t.is((await restarted.syncFeed({
    moderatorId,
    fetchPage: async cursor => {
      cursors.push(cursor)
      return pages.get(cursor)
    },
  })).status, 'complete')
  t.alike(cursors, ['1'])
  t.is(restarted.getRecords().length, 2)

  await restarted.unsubscribe(moderatorId)
  t.is(restarted.getCheckpoint(moderatorId), null)
  t.alike(restarted.getRecords(), [])
})

function moderationPage(cursor, records) {
  return createModerationFeedPage({
    moderatorId,
    pageCursor: cursor,
    nextCursor: null,
    records,
    keyPair: mod,
    expiresAt: 1000,
  })
}

test('moderation cumulative global and publisher budgets survive restart and expire honestly', async (t) => {
  const repository = stateRepository()
  let clock = 10
  const options = {
    now: () => clock,
    stateRepository: repository,
    budgetWindowMs: 5,
    maxRecordsGlobalPerWindow: 1,
    maxRecordsPerModeratorPerWindow: 8,
    maxRecordsPerPublisherPerWindow: 1,
  }
  const first = createModerationManager(options)
  await first.ready
  await first.subscribe(moderatorId)
  t.is((await first.syncFeed({
    moderatorId,
    startCursor: '0',
    fetchPage: async () => moderationPage('0', [{
      action: 'hide',
      targetType: 'publisher',
      targetId: 'a'.repeat(64),
    }]),
  })).status, 'complete')

  const restarted = createModerationManager(options)
  await restarted.ready
  const sameWindow = await restarted.syncFeed({
    moderatorId,
    startCursor: '1',
    fetchPage: async () => moderationPage('1', [{
      action: 'hide',
      targetType: 'publisher',
      targetId: 'a'.repeat(64),
    }]),
  })
  t.is(sameWindow.status, 'partial')
  t.ok(
    sameWindow.errorCode === 'GLOBAL_WINDOW_BUDGET_EXCEEDED' ||
    sameWindow.errorCode === 'PUBLISHER_WINDOW_BUDGET_EXCEEDED',
    'restart cannot reset a cumulative moderation window',
  )

  clock = 16
  const expired = createModerationManager(options)
  await expired.ready
  t.is((await expired.syncFeed({
    moderatorId,
    startCursor: '1',
    fetchPage: async () => moderationPage('1', [{
      action: 'hide',
      targetType: 'publisher',
      targetId: 'a'.repeat(64),
    }]),
  })).status, 'rejected', 'expired window admits verification work; duplicate projection remains rejected')
  t.is(expired.getCheckpoint(moderatorId).cursor, null)
})

test('moderation rejected and duplicate records count toward the per-sync processing cap', async (t) => {
  let rejectedChecks = 0
  const rejected = createModerationManager({
    now: () => 10,
    maxRecordsPerSync: 2,
    acceptRecord() {
      rejectedChecks++
      return false
    },
  })
  await rejected.subscribe(moderatorId)
  const rejectedResult = await rejected.syncFeed({
    moderatorId,
    fetchPage: async () => moderationPage('0', [0, 1, 2].map(index => ({
      action: 'hide',
      targetType: 'work',
      targetId: `work:rejected-${index}`,
    }))),
  })
  t.is(rejectedResult.status, 'partial')
  t.is(rejectedResult.errorCode, 'SYNC_RECORD_BUDGET_EXCEEDED')
  t.is(rejectedChecks, 2, 'third rejected record is not processed')

  const duplicate = createModerationManager({ now: () => 10, maxRecordsPerSync: 2 })
  await duplicate.subscribe(moderatorId)
  const duplicateRecord = {
    action: 'hide',
    targetType: 'work',
    targetId: 'work:duplicate',
  }
  const duplicateResult = await duplicate.syncFeed({
    moderatorId,
    fetchPage: async () => moderationPage('0', [
      duplicateRecord,
      duplicateRecord,
      duplicateRecord,
    ]),
  })
  t.is(duplicateResult.status, 'partial')
  t.is(duplicateResult.errorCode, 'SYNC_RECORD_BUDGET_EXCEEDED')
  t.is(duplicateResult.ingested, 1)
  t.is(duplicateResult.duplicates, 1, 'third duplicate is not processed')
})
