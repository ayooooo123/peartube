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
