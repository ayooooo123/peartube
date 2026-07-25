import b4a from 'b4a'

import { encodeCanonical, toHex } from '../publisher/canonical.js'
import { createApplicationEnvelope, verifyApplicationEnvelope } from '../records/application-envelope.js'

export const ARCHIVE_REQUEST_RECORD_TYPE = 'peartube.archive.request.v1'
export const MAX_ARCHIVE_REQUEST_RANGES = 64
export const MAX_ARCHIVE_REQUEST_BYTES = 1024 * 1024 * 1024 * 1024

function hex32(value, name) {
  return toHex(value, 32, name)
}

function int(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const next = Number(value)
  if (!Number.isSafeInteger(next) || next < min || next > max) throw new Error(`${name} must be a bounded safe integer`)
  return next
}

function normalizeRange(range = {}) {
  const start = int(range.start, 'range.start')
  const end = int(range.end, 'range.end', 1)
  if (end <= start) throw new Error('invalid archive request range')
  return { coreKey: hex32(range.coreKey, 'coreKey'), start, end }
}

function normalizeBody(input = {}) {
  const ranges = input.ranges || []
  if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > MAX_ARCHIVE_REQUEST_RANGES) {
    throw new Error('archive request ranges are required and bounded')
  }
  const issuedAt = int(input.issuedAt || 0, 'issuedAt')
  const expiresAt = int(input.expiresAt, 'expiresAt', 1)
  const retentionUntil = int(input.retentionUntil, 'retentionUntil', 1)
  if (expiresAt <= issuedAt) throw new Error('archive request must expire after issue')
  if (retentionUntil <= expiresAt) throw new Error('archive retention must extend beyond request expiry')
  const nonce = String(input.nonce || '')
  if (nonce.length > 128) throw new Error('archive request nonce is too long')
  return {
    version: 1,
    requesterId: hex32(input.requesterId, 'requesterId'),
    publicationId: hex32(input.publicationId, 'publicationId'),
    renditionId: hex32(input.renditionId, 'renditionId'),
    ranges: ranges.map(normalizeRange).sort((a, b) => a.coreKey.localeCompare(b.coreKey) || a.start - b.start || a.end - b.end),
    requestedBytes: int(input.requestedBytes, 'requestedBytes', 1, MAX_ARCHIVE_REQUEST_BYTES),
    retentionUntil,
    issuedAt,
    expiresAt,
    nonce,
  }
}

export function createArchiveRequest(input = {}) {
  const body = normalizeBody(input)
  const envelope = createApplicationEnvelope({
    recordType: ARCHIVE_REQUEST_RECORD_TYPE,
    body: encodeCanonical(body),
    keyPair: input.keyPair,
    issuedAt: body.issuedAt,
    expiresAt: body.expiresAt,
  })
  return { requestId: hex32(envelope.recordId, 'recordId'), body, envelope }
}

export async function verifyArchiveRequest(envelope, options = {}) {
  let body
  try {
    body = normalizeBody(JSON.parse(b4a.toString(envelope?.body || b4a.alloc(0))))
  } catch {
    return false
  }
  const verified = await verifyApplicationEnvelope(envelope, {
    recordType: ARCHIVE_REQUEST_RECORD_TYPE,
    now: options.now,
    allowedSigners: [b4a.from(body.requesterId, 'hex')],
  })
  if (!verified) return false
  const signer = envelope.signer ? hex32(envelope.signer, 'signer') : null
  if (signer !== body.requesterId) return false
  return { requestId: hex32(envelope.recordId, 'recordId'), body, envelope }
}
