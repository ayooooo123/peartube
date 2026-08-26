import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  INDEX_FEED_CAPABILITY,
  INDEX_FEED_PAGE_RECORD_TYPE,
  createIndexFeedPage,
  verifyIndexFeedPage,
} from '../src/indexing/feed-contract.js'
import {
  MODERATION_FEED_PAGE_RECORD_TYPE,
  createModerationFeedPage,
  verifyModerationFeedPage,
} from '../src/moderation/feed-contract.js'
import { PROTOCOL_ERROR_CODES } from '../src/network/version.js'
import { encodeCanonical } from '../src/publisher/canonical.js'
import { createApplicationEnvelope } from '../src/records/application-envelope.js'

const MODERATION_FEED_CAPABILITY = 'moderation-feed:v1'

function signedEnvelope(recordType, body, keyPair, encodedBody = encodeCanonical(body)) {
  return createApplicationEnvelope({
    recordType,
    body: encodedBody,
    keyPair,
    issuedAt: body.issuedAt,
    expiresAt: 1_000,
  })
}

test('signed index pages reject malformed, oversized, noncanonical, incompatible, and arbitrary JSON bodies', async t => {
  const curator = crypto.keyPair(b4a.alloc(32, 91))
  const curatorId = b4a.toString(curator.publicKey, 'hex')
  const valid = createIndexFeedPage({
    curatorId,
    pageCursor: '0',
    nextCursor: '1',
    records: [{
      kind: 'publication-reference',
      entityRef: 'work:bounded',
      publicationId: 'a'.repeat(64),
      publisherId: 'b'.repeat(64),
      tags: ['bounded'],
      ranking: { score: 0.5, methodology: 'manual' },
      model: { id: 'human', version: '1' },
    }],
    keyPair: curator,
    issuedAt: 10,
    expiresAt: 1_000,
  })
  const bodies = [
    { ...valid.body, unknown: true },
    { ...valid.body, version: 2 },
    { ...valid.body, nextCursor: '0' },
    { ...valid.body, issuedAt: '10' },
    { ...valid.body, records: Array.from({ length: 129 }, () => valid.body.records[0]) },
    { ...valid.body, records: [{ ...valid.body.records[0], kind: 'execute-arbitrary-json' }] },
    { ...valid.body, records: [{ ...valid.body.records[0], entityRef: 'x'.repeat(513) }] },
    { ...valid.body, records: [{ ...valid.body.records[0], arbitrary: { nested: true } }] },
    { ...valid.body, records: [{ ...valid.body.records[0], ranking: { score: 0.5, methodology: 'manual', payload: {} } }] },
    { ...valid.body, records: [{ ...valid.body.records[0], tags: ['z', 'a'] }] },
  ]
  for (const body of bodies) {
    t.absent(await verifyIndexFeedPage(
      signedEnvelope(INDEX_FEED_PAGE_RECORD_TYPE, body, curator),
      { curatorId, now: 20 },
    ))
  }
  t.absent(await verifyIndexFeedPage(
    signedEnvelope(
      INDEX_FEED_PAGE_RECORD_TYPE,
      valid.body,
      curator,
      b4a.from(JSON.stringify(valid.body)),
    ),
    { curatorId, now: 20 },
  ), 'a valid signature cannot make a noncanonical body admissible')

  const incompatible = {
    ...valid.body,
    requiredCapabilities: [INDEX_FEED_CAPABILITY, 'unknown-index:v1'].sort(),
  }
  try {
    await verifyIndexFeedPage(
      signedEnvelope(INDEX_FEED_PAGE_RECORD_TYPE, incompatible, curator),
      { curatorId, now: 20 },
    )
    t.fail('incompatible signed page must be rejected')
  } catch (error) {
    t.is(error.code, PROTOCOL_ERROR_CODES.CAPABILITY_UNSUPPORTED)
  }
})

test('signed moderation pages reject malformed, oversized, noncanonical, incompatible, and unknown records', async t => {
  const moderator = crypto.keyPair(b4a.alloc(32, 92))
  const moderatorId = b4a.toString(moderator.publicKey, 'hex')
  const valid = createModerationFeedPage({
    moderatorId,
    pageCursor: '0',
    nextCursor: '1',
    records: [{
      action: 'hide',
      targetType: 'publication',
      targetId: 'a'.repeat(64),
      label: 'bounded',
      reason: 'signed moderation evidence',
    }],
    keyPair: moderator,
    issuedAt: 10,
    expiresAt: 1_000,
  })
  const bodies = [
    { ...valid.body, unknown: true },
    { ...valid.body, version: 2 },
    { ...valid.body, nextCursor: '0' },
    { ...valid.body, records: Array.from({ length: 129 }, () => valid.body.records[0]) },
    { ...valid.body, records: [{ ...valid.body.records[0], action: 'run-code' }] },
    { ...valid.body, records: [{ ...valid.body.records[0], targetType: 'unknown-authority' }] },
    { ...valid.body, records: [{ ...valid.body.records[0], targetId: 'x'.repeat(513) }] },
    { ...valid.body, records: [{ ...valid.body.records[0], arbitrary: { nested: true } }] },
  ]
  for (const body of bodies) {
    t.absent(await verifyModerationFeedPage(
      signedEnvelope(MODERATION_FEED_PAGE_RECORD_TYPE, body, moderator),
      { moderatorId, now: 20 },
    ))
  }
  t.absent(await verifyModerationFeedPage(
    signedEnvelope(
      MODERATION_FEED_PAGE_RECORD_TYPE,
      valid.body,
      moderator,
      b4a.from(JSON.stringify(valid.body)),
    ),
    { moderatorId, now: 20 },
  ))

  const incompatible = {
    ...valid.body,
    requiredCapabilities: [MODERATION_FEED_CAPABILITY, 'unknown-moderation:v1'].sort(),
  }
  try {
    await verifyModerationFeedPage(
      signedEnvelope(MODERATION_FEED_PAGE_RECORD_TYPE, incompatible, moderator),
      { moderatorId, now: 20 },
    )
    t.fail('incompatible signed page must be rejected')
  } catch (error) {
    t.is(error.code, PROTOCOL_ERROR_CODES.CAPABILITY_UNSUPPORTED)
  }
})
