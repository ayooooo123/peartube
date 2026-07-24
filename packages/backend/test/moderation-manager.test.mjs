import test from 'brittle'
import crypto from 'hypercore-crypto'

import { createModerationFeedPage } from '../src/moderation/feed-contract.js'
import { createModerationManager } from '../src/moderation/manager.js'

const mod = crypto.keyPair(Buffer.alloc(32, 1))
const moderatorId = Buffer.from(mod.publicKey).toString('hex')

test('moderation manager syncs only explicit subscriptions and persists restart cursors', async (t) => {
  const manager = createModerationManager({ now: () => 10 })
  const page = createModerationFeedPage({ moderatorId, pageCursor: '0', nextCursor: null, records: [{ action: 'block', targetType: 'publication', targetId: 'a'.repeat(64) }], keyPair: mod, expiresAt: 100 })
  t.is((await manager.syncFeed({ moderatorId, startCursor: '0', fetchPage: async () => page })).status, 'not-subscribed')
  manager.subscribe(moderatorId)
  t.is((await manager.syncFeed({ moderatorId, startCursor: '0', fetchPage: async () => page })).status, 'complete')
  t.is(manager.getRecords().length, 1)
  t.is(manager.getCheckpoint(moderatorId).cursor, null)
})
