import b4a from 'b4a'

import { encodeCanonical, hashCanonical, toHex } from '../publisher/canonical.js'
import { createSignedEnvelope, verifySignedEnvelope } from '../records/signed-envelope.js'

export const PUBLISHER_CATALOG_PAGE_RECORD_TYPE = 'peartube.publisher-catalog-page.v1'
export const MAX_CATALOG_PAGE_BATCHES = 64

function fixedHex(value, name) {
  const next = String(value || '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(next)) throw new Error(`${name} must be 32-byte hex`)
  return next
}

function decodeBody(buffer) {
  try { return JSON.parse(b4a.toString(buffer, 'utf8')) } catch { return null }
}

function snapshotBatch(batch = {}) {
  const entries = Array.isArray(batch.entries) ? batch.entries : []
  return {
    batchId: batch.batchId || toHex(hashCanonical('peartube.publisher-catalog.batch-id.v1', batch)),
    catalogDigest: batch.catalogDigest || batch.digest || toHex(hashCanonical('peartube.publisher-catalog.batch-digest.v1', batch)),
    entries,
    pages: Array.isArray(batch.pages) ? batch.pages.map(page => ({ index: page.index, digest: page.digest })) : [],
    catalogCommit: batch.catalogCommit || null,
    manifests: batch.manifests || [],
    claims: batch.claims || [],
  }
}

export function createPublisherCatalogPage(input = {}) {
  const batches = (input.batches || []).map(snapshotBatch)
  if (batches.length > MAX_CATALOG_PAGE_BATCHES) throw new Error('too many catalog batches')
  const body = {
    version: 1,
    publisherId: fixedHex(input.publisherId, 'publisherId'),
    pageCursor: String(input.pageCursor || '0'),
    nextCursor: input.nextCursor === undefined ? null : input.nextCursor,
    catalogHead: fixedHex(input.catalogHead, 'catalogHead'),
    batches,
    issuedAt: Number(input.issuedAt || Date.now()),
  }
  const envelope = createSignedEnvelope({ recordType: PUBLISHER_CATALOG_PAGE_RECORD_TYPE, body: encodeCanonical(body), keyPair: input.keyPair, issuedAt: body.issuedAt })
  return { pageId: toHex(hashCanonical('peartube.publisher-catalog-page.id.v1', body)), body, envelope }
}

export async function verifyPublisherCatalogPage(envelope, options = {}) {
  const body = envelope?.body ? decodeBody(envelope.body) : null
  if (!body) return false
  if (options.publisherId && body.publisherId !== String(options.publisherId).toLowerCase()) return false
  const ok = await verifySignedEnvelope(envelope, { recordType: PUBLISHER_CATALOG_PAGE_RECORD_TYPE, allowedSigners: [b4a.from(body.publisherId, 'hex')], now: options.now || Date.now() })
  if (!ok) return false
  return { body, envelope }
}
