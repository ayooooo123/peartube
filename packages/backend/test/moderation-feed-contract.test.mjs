import test from 'brittle'
import crypto from 'hypercore-crypto'

import { createModerationFeedPage, verifyModerationFeedPage } from '../src/moderation/feed-contract.js'

const mod = crypto.keyPair(Buffer.alloc(32, 1))
const moderatorId = Buffer.from(mod.publicKey).toString('hex')

test('moderation feed page signs bounded block/allow records with expiry', async (t) => {
  const page = createModerationFeedPage({ moderatorId, pageCursor: '0', nextCursor: null, records: [{ action: 'block', targetType: 'publication', targetId: 'a'.repeat(64), label: 'spam', reason: 'test' }], keyPair: mod, issuedAt: 10, expiresAt: 100 })
  const verified = await verifyModerationFeedPage(page.envelope, { moderatorId, now: 20 })
  t.ok(verified)
  t.is(verified.body.records[0].action, 'block')
  t.is(verified.body.records[0].targetType, 'publication')
})

test('moderation feed rejects oversized pages, replayed pages, and wrong signers', async (t) => {
  t.exception(() => createModerationFeedPage({ moderatorId, pageCursor: '0', records: Array.from({ length: 129 }, () => ({ action: 'block', targetType: 'work', targetId: 'w' })), keyPair: mod }), /too many/)
  const other = crypto.keyPair(Buffer.alloc(32, 2))
  const wrong = createModerationFeedPage({ moderatorId, pageCursor: '0', records: [{ action: 'block', targetType: 'work', targetId: 'w' }], keyPair: other })
  t.absent(await verifyModerationFeedPage(wrong.envelope, { moderatorId }))
})
