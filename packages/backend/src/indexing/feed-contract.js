import b4a from 'b4a'

import { encodeCanonical, toHex } from '../publisher/canonical.js'
import { createApplicationEnvelope, verifyApplicationEnvelope } from '../records/application-envelope.js'
import {
  assertProtocolCompatibility,
  createProtocolAdvertisement
} from '../network/version.js'

export const INDEX_FEED_PAGE_RECORD_TYPE = 'peartube.index.feed-page.v1'
export const MAX_INDEX_FEED_RECORDS = 128
export const INDEX_FEED_CAPABILITY = 'index-feed:v1'
const INDEX_PAGE_FIELDS = Object.freeze([
  'version', 'curatorId', 'pageCursor', 'nextCursor', 'records', 'issuedAt',
  'minimumProtocolMajor', 'protocolMinor', 'requiredCapabilities',
])
const INDEX_RECORD_FIELDS = Object.freeze([
  'kind', 'entityRef', 'publicationId', 'publisherId', 'catalogBlockHint',
  'rootTransitionProofDigest', 'title', 'creator', 'collectionId', 'tags',
  'ranking', 'model', 'sourceId', 'playable',
])
const INDEX_RECORD_KINDS = new Set([
  'publication-reference',
  'collection-membership',
  'equivalence-evidence',
  'contribution-evidence',
  'movie',
  'series',
  'creator-video',
])

function hex32(value, name) {
  return toHex(value, 32, name)
}

function boundedString(value, name, max = 4096, required = false) {
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

function normalizeRanking(value) {
  if (value == null) return null
  exactFields(value, ['score', 'methodology'], 'ranking')
  if (typeof value.score !== 'number' || !Number.isFinite(value.score) ||
      value.score < -1_000_000 || value.score > 1_000_000) {
    throw new Error('ranking score is invalid')
  }
  return {
    score: value.score,
    methodology: boundedString(value.methodology, 'ranking methodology', 128, true),
  }
}

function normalizeModel(value) {
  if (value == null) return null
  exactFields(value, ['id', 'version'], 'model')
  return {
    id: boundedString(value.id, 'model id', 128, true),
    version: boundedString(value.version, 'model version', 128, true),
  }
}

function normalizeRecord(record = {}) {
  exactFields({
    catalogBlockHint: null,
    rootTransitionProofDigest: null,
    title: null,
    creator: null,
    collectionId: null,
    tags: [],
    ranking: null,
    model: null,
    sourceId: null,
    playable: false,
    ...record,
  }, INDEX_RECORD_FIELDS, 'index record')
  const kind = boundedString(record.kind, 'kind', 128, true)
  if (!INDEX_RECORD_KINDS.has(kind)) throw new Error('unsupported index record kind')
  if (record.catalogBlockHint != null &&
      (!Number.isSafeInteger(record.catalogBlockHint) || record.catalogBlockHint < 0)) {
    throw new Error('catalogBlockHint is invalid')
  }
  if (record.tags != null && (!Array.isArray(record.tags) || record.tags.length > 64)) {
    throw new Error('tags are invalid')
  }
  const tags = Array.from(new Set(
    (record.tags || []).map(tag => boundedString(tag, 'tag', 128, true))
  )).sort()
  return {
    kind,
    entityRef: boundedString(record.entityRef, 'entityRef', 512, true),
    publicationId: hex32(record.publicationId, 'publicationId'),
    publisherId: hex32(record.publisherId, 'publisherId'),
    catalogBlockHint: record.catalogBlockHint ?? null,
    rootTransitionProofDigest: record.rootTransitionProofDigest == null ? null : hex32(record.rootTransitionProofDigest, 'rootTransitionProofDigest'),
    title: boundedString(record.title, 'title', 512),
    creator: boundedString(record.creator, 'creator', 512),
    collectionId: boundedString(record.collectionId, 'collectionId', 512),
    tags,
    ranking: normalizeRanking(record.ranking),
    model: normalizeModel(record.model),
    sourceId: boundedString(record.sourceId, 'sourceId', 256),
    playable: record.playable === true,
  }
}

function normalizePageBody(body) {
  exactFields(body, INDEX_PAGE_FIELDS, 'index page')
  if (body.version !== 1 || !Number.isSafeInteger(body.issuedAt) || body.issuedAt < 0) {
    throw new Error('index page version or timestamp is invalid')
  }
  if (!Array.isArray(body.records) || body.records.length > MAX_INDEX_FEED_RECORDS) {
    throw new Error('too many index records')
  }
  const pageCursor = boundedString(body.pageCursor, 'pageCursor', 256, true)
  const nextCursor = body.nextCursor == null
    ? null
    : boundedString(body.nextCursor, 'nextCursor', 256, true)
  if (nextCursor === pageCursor) throw new Error('index page cursor must advance')
  return {
    version: 1,
    curatorId: hex32(body.curatorId, 'curatorId'),
    pageCursor,
    nextCursor,
    records: body.records.map(normalizeRecord),
    issuedAt: body.issuedAt,
    ...createProtocolAdvertisement(body, {
      requiredCapabilities: [INDEX_FEED_CAPABILITY],
    }),
  }
}

export function createIndexFeedPage(input = {}) {
  const records = input.records || []
  if (!Array.isArray(records) || records.length > MAX_INDEX_FEED_RECORDS) throw new Error('too many index records')
  const compatibility = createProtocolAdvertisement(input, {
    requiredCapabilities: [INDEX_FEED_CAPABILITY],
  })
  const body = {
    version: 1,
    curatorId: hex32(input.curatorId, 'curatorId'),
    pageCursor: boundedString(input.pageCursor, 'pageCursor', 256, true),
    nextCursor: input.nextCursor == null ? null : boundedString(input.nextCursor, 'nextCursor', 256, true),
    records: records.map(normalizeRecord),
    issuedAt: Number(input.issuedAt || 0),
    ...compatibility,
  }
  const envelope = createApplicationEnvelope({ recordType: INDEX_FEED_PAGE_RECORD_TYPE, body: encodeCanonical(body), keyPair: input.keyPair, issuedAt: input.issuedAt, expiresAt: input.expiresAt })
  envelope.recordIdHex = hex32(envelope.recordId, 'recordId')
  return { pageId: envelope.recordIdHex, body, envelope }
}

export async function verifyIndexFeedPage(envelope, options = {}) {
  let body
  try { body = JSON.parse(b4a.toString(envelope.body)) } catch { return false }
  let curatorId
  try { curatorId = hex32(body?.curatorId, 'curatorId') } catch { return false }
  if (options.curatorId && curatorId !== hex32(options.curatorId, 'curatorId')) return false
  const ok = await verifyApplicationEnvelope(envelope, { recordType: INDEX_FEED_PAGE_RECORD_TYPE, now: options.now, allowedSigners: [b4a.from(curatorId, 'hex')] })
  if (!ok) return false
  const signer = envelope.signer ? hex32(envelope.signer, 'signer') : null
  if (signer !== curatorId) return false
  assertProtocolCompatibility(body, {
    protocolMajor: options.protocolMajor,
    supportedCapabilities: options.supportedCapabilities || [INDEX_FEED_CAPABILITY],
    mandatoryCapabilities: [INDEX_FEED_CAPABILITY],
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
