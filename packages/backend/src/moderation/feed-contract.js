import b4a from 'b4a'

import { encodeCanonical, toHex } from '../publisher/canonical.js'
import { createApplicationEnvelope, verifyApplicationEnvelope } from '../records/application-envelope.js'
import {
  assertProtocolCompatibility,
  createProtocolAdvertisement,
} from '../network/version.js'

export const MODERATION_FEED_PAGE_RECORD_TYPE = 'peartube.moderation.feed-page.v1'
export const MAX_MODERATION_RECORDS = 128
export const MODERATION_FEED_CAPABILITY = 'moderation-feed:v1'
const MODERATION_PAGE_FIELDS = Object.freeze([
  'version', 'moderatorId', 'pageCursor', 'nextCursor', 'records', 'issuedAt',
  'minimumProtocolMajor', 'protocolMinor', 'requiredCapabilities',
])
const MODERATION_RECORD_FIELDS = Object.freeze([
  'action', 'targetType', 'targetId', 'label', 'reason',
])
const MODERATION_TARGET_TYPES = new Set([
  'publisher',
  'publication',
  'work',
  'recording',
  'edition',
  'collection',
  'agent',
  'creator',
  'claim-issuer',
  'curator',
  'index-feed',
  'rendition',
])

function hex32(value, name) {
  return toHex(value, 32, name)
}

function boundedString(value, name, max = 512, required = false) {
  if (value == null && !required) return null
  if (typeof value !== 'string' || !value || b4a.byteLength(value) > max) {
    throw new Error(`${name} must be bounded string`)
  }
  return value
}

function exactFields(value, expected, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  const actual = Object.keys(value).sort()
  const allowed = [...expected].sort()
  if (actual.length !== allowed.length || actual.some((field, index) => field !== allowed[index])) {
    throw new Error(`${name} fields are invalid`)
  }
}

function normalizeRecord(record = {}) {
  exactFields({ label: null, reason: null, ...record }, MODERATION_RECORD_FIELDS, 'moderation record')
  const action = boundedString(record.action, 'action', 64, true)
  if (!['allow', 'block', 'hide', 'not-seeded'].includes(action)) throw new Error('unsupported moderation action')
  const targetType = boundedString(record.targetType, 'targetType', 128, true)
  if (!MODERATION_TARGET_TYPES.has(targetType)) throw new Error('unsupported moderation target type')
  return {
    action,
    targetType,
    targetId: boundedString(record.targetId, 'targetId', 512, true),
    label: boundedString(record.label, 'label', 128),
    reason: boundedString(record.reason, 'reason', 1024),
  }
}

function normalizePageBody(body) {
  exactFields(body, MODERATION_PAGE_FIELDS, 'moderation page')
  if (body.version !== 1 || !Number.isSafeInteger(body.issuedAt) || body.issuedAt < 0) {
    throw new Error('moderation page version or timestamp is invalid')
  }
  if (!Array.isArray(body.records) || body.records.length > MAX_MODERATION_RECORDS) {
    throw new Error('too many moderation records')
  }
  const pageCursor = boundedString(body.pageCursor, 'pageCursor', 256, true)
  const nextCursor = body.nextCursor == null
    ? null
    : boundedString(body.nextCursor, 'nextCursor', 256, true)
  if (nextCursor === pageCursor) throw new Error('moderation page cursor must advance')
  return {
    version: 1,
    moderatorId: hex32(body.moderatorId, 'moderatorId'),
    pageCursor,
    nextCursor,
    records: body.records.map(normalizeRecord),
    issuedAt: body.issuedAt,
    ...createProtocolAdvertisement(body, {
      requiredCapabilities: [MODERATION_FEED_CAPABILITY],
    }),
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
    ...createProtocolAdvertisement(input, {
      requiredCapabilities: [MODERATION_FEED_CAPABILITY],
    }),
  }
  const envelope = createApplicationEnvelope({ recordType: MODERATION_FEED_PAGE_RECORD_TYPE, body: encodeCanonical(body), keyPair: input.keyPair, issuedAt: input.issuedAt, expiresAt: input.expiresAt })
  envelope.recordIdHex = hex32(envelope.recordId, 'recordId')
  return { pageId: envelope.recordIdHex, body, envelope }
}

export async function verifyModerationFeedPage(envelope, options = {}) {
  let body
  try { body = JSON.parse(b4a.toString(envelope.body)) } catch { return false }
  let moderatorId
  try { moderatorId = hex32(body?.moderatorId, 'moderatorId') } catch { return false }
  if (options.moderatorId && moderatorId !== hex32(options.moderatorId, 'moderatorId')) return false
  const ok = await verifyApplicationEnvelope(envelope, { recordType: MODERATION_FEED_PAGE_RECORD_TYPE, now: options.now, allowedSigners: [b4a.from(moderatorId, 'hex')] })
  if (!ok) return false
  const signer = envelope.signer ? hex32(envelope.signer, 'signer') : null
  if (signer !== moderatorId) return false
  assertProtocolCompatibility(body, {
    protocolMajor: options.protocolMajor,
    supportedCapabilities: options.supportedCapabilities || [MODERATION_FEED_CAPABILITY],
    mandatoryCapabilities: [MODERATION_FEED_CAPABILITY],
  })
  let normalized
  try {
    normalized = normalizePageBody(body)
    if (normalized.issuedAt !== Number(envelope.issuedAt) ||
        !b4a.equals(encodeCanonical(normalized), b4a.from(envelope.body))) return false
  } catch {
    return false
  }
  return { pageId: hex32(envelope.recordId, 'recordId'), body: normalized, envelope }
}
