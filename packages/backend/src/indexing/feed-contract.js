import b4a from 'b4a'

import { encodeCanonical, toHex } from '../publisher/canonical.js'
import { createSignedEnvelope, verifySignedEnvelope } from '../records/signed-envelope.js'

export const INDEX_FEED_PAGE_RECORD_TYPE = 'peartube.index.feed-page.v1'
export const MAX_INDEX_FEED_RECORDS = 128

function hex32(value, name) {
  return toHex(value, 32, name)
}

function boundedString(value, name, max = 4096, required = false) {
  if (value == null && !required) return null
  const next = String(value || '')
  if (!next || next.length > max) throw new Error(`${name} must be bounded string`)
  return next
}

function normalizeRecord(record = {}) {
  return {
    kind: boundedString(record.kind, 'kind', 128, true),
    entityRef: boundedString(record.entityRef, 'entityRef', 512, true),
    publicationId: hex32(record.publicationId, 'publicationId'),
    publisherId: hex32(record.publisherId, 'publisherId'),
    catalogBlockHint: Number.isSafeInteger(record.catalogBlockHint) && record.catalogBlockHint >= 0 ? record.catalogBlockHint : null,
    rootTransitionProofDigest: record.rootTransitionProofDigest == null ? null : hex32(record.rootTransitionProofDigest, 'rootTransitionProofDigest'),
    title: boundedString(record.title, 'title', 512),
    creator: boundedString(record.creator, 'creator', 512),
    collectionId: boundedString(record.collectionId, 'collectionId', 512),
    tags: Array.isArray(record.tags) ? record.tags.slice(0, 64).map(tag => boundedString(tag, 'tag', 128, true)).sort() : [],
    ranking: record.ranking || null,
    model: record.model || null,
    sourceId: record.sourceId || null,
    playable: record.playable === true,
  }
}

export function createIndexFeedPage(input = {}) {
  const records = input.records || []
  if (!Array.isArray(records) || records.length > MAX_INDEX_FEED_RECORDS) throw new Error('too many index records')
  const body = {
    version: 1,
    curatorId: hex32(input.curatorId, 'curatorId'),
    pageCursor: boundedString(input.pageCursor, 'pageCursor', 256, true),
    nextCursor: input.nextCursor == null ? null : boundedString(input.nextCursor, 'nextCursor', 256, true),
    records: records.map(normalizeRecord),
    issuedAt: Number(input.issuedAt || 0),
  }
  const envelope = createSignedEnvelope({ recordType: INDEX_FEED_PAGE_RECORD_TYPE, body: encodeCanonical(body), keyPair: input.keyPair, issuedAt: input.issuedAt, expiresAt: input.expiresAt })
  envelope.recordIdHex = hex32(envelope.recordId, 'recordId')
  return { pageId: envelope.recordIdHex, body, envelope }
}

export async function verifyIndexFeedPage(envelope, options = {}) {
  let body
  try { body = JSON.parse(b4a.toString(envelope.body)) } catch { return false }
  if (options.curatorId && body.curatorId !== hex32(options.curatorId, 'curatorId')) return false
  const ok = await verifySignedEnvelope(envelope, { recordType: INDEX_FEED_PAGE_RECORD_TYPE, now: options.now, allowedSigners: [b4a.from(body.curatorId, 'hex')] })
  if (!ok) return false
  const signer = envelope.signer ? hex32(envelope.signer, 'signer') : null
  if (signer !== body.curatorId) return false
  return { pageId: hex32(envelope.recordId, 'recordId'), body, envelope }
}
