import b4a from 'b4a'

import { encodeCanonical, toHex } from '../publisher/canonical.js'
import { createApplicationEnvelope, verifyApplicationEnvelope } from '../records/application-envelope.js'

export const MODERATION_FEED_PAGE_RECORD_TYPE = 'peartube.moderation.feed-page.v1'
export const MAX_MODERATION_RECORDS = 128

function hex32(value, name) {
  return toHex(value, 32, name)
}

function boundedString(value, name, max = 512, required = false) {
  if (value == null && !required) return null
  const next = String(value || '')
  if (!next || next.length > max) throw new Error(`${name} must be bounded string`)
  return next
}

function normalizeRecord(record = {}) {
  const action = boundedString(record.action, 'action', 64, true)
  if (!['allow', 'block', 'hide', 'not-seeded'].includes(action)) throw new Error('unsupported moderation action')
  return {
    action,
    targetType: boundedString(record.targetType, 'targetType', 128, true),
    targetId: boundedString(record.targetId, 'targetId', 512, true),
    label: boundedString(record.label, 'label', 128),
    reason: boundedString(record.reason, 'reason', 1024),
  }
}

export function createModerationFeedPage(input = {}) {
  const records = input.records || []
  if (!Array.isArray(records) || records.length > MAX_MODERATION_RECORDS) throw new Error('too many moderation records')
  const body = {
    version: 1,
    moderatorId: hex32(input.moderatorId, 'moderatorId'),
    pageCursor: boundedString(input.pageCursor, 'pageCursor', 256, true),
    nextCursor: input.nextCursor == null ? null : boundedString(input.nextCursor, 'nextCursor', 256, true),
    records: records.map(normalizeRecord),
    issuedAt: Number(input.issuedAt || 0),
  }
  const envelope = createApplicationEnvelope({ recordType: MODERATION_FEED_PAGE_RECORD_TYPE, body: encodeCanonical(body), keyPair: input.keyPair, issuedAt: input.issuedAt, expiresAt: input.expiresAt })
  envelope.recordIdHex = hex32(envelope.recordId, 'recordId')
  return { pageId: envelope.recordIdHex, body, envelope }
}

export async function verifyModerationFeedPage(envelope, options = {}) {
  let body
  try { body = JSON.parse(b4a.toString(envelope.body)) } catch { return false }
  if (options.moderatorId && body.moderatorId !== hex32(options.moderatorId, 'moderatorId')) return false
  const ok = await verifyApplicationEnvelope(envelope, { recordType: MODERATION_FEED_PAGE_RECORD_TYPE, now: options.now, allowedSigners: [b4a.from(body.moderatorId, 'hex')] })
  if (!ok) return false
  return { pageId: hex32(envelope.recordId, 'recordId'), body, envelope }
}
