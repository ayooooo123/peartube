import b4a from 'b4a'

import { encodeCanonical, toHex } from '../publisher/canonical.js'
import { createSignedEnvelope, verifySignedEnvelope } from '../records/signed-envelope.js'

export const ARCHIVE_PLEDGE_RECORD_TYPE = 'peartube.archive.pledge.v1'
export const MAX_ARCHIVE_PLEDGE_RANGES = 64

function hex32(value, name) {
  return toHex(value, 32, name)
}

function int(value, name, min = 0) {
  const next = Number(value)
  if (!Number.isSafeInteger(next) || next < min) throw new Error(`${name} must be safe integer`)
  return next
}

function normalizeRange(range = {}) {
  const start = int(range.start, 'range.start')
  const end = int(range.end, 'range.end', 1)
  if (end <= start) throw new Error('invalid pledge range')
  return { coreKey: hex32(range.coreKey, 'coreKey'), start, end }
}

export function createArchivePledge(input = {}) {
  const ranges = input.ranges || []
  if (!Array.isArray(ranges) || ranges.length === 0) throw new Error('ranges are required')
  if (ranges.length > MAX_ARCHIVE_PLEDGE_RANGES) throw new Error('too many pledge ranges')
  const body = {
    version: 1,
    archivistId: hex32(input.archivistId, 'archivistId'),
    publicationId: hex32(input.publicationId, 'publicationId'),
    renditionId: hex32(input.renditionId, 'renditionId'),
    ranges: ranges.map(normalizeRange).sort((a, b) => a.coreKey.localeCompare(b.coreKey) || a.start - b.start || a.end - b.end),
    retentionUntil: int(input.retentionUntil, 'retentionUntil', 1),
    uploadCeilingBytes: int(input.uploadCeilingBytes, 'uploadCeilingBytes'),
    issuedAt: int(input.issuedAt || 0, 'issuedAt'),
    nonce: String(input.nonce || ''),
    policyEpoch: int(input.policyEpoch || 0, 'policyEpoch'),
  }
  const envelope = createSignedEnvelope({ recordType: ARCHIVE_PLEDGE_RECORD_TYPE, body: encodeCanonical(body), keyPair: input.keyPair, issuedAt: input.issuedAt, expiresAt: input.retentionUntil })
  return { pledgeId: hex32(envelope.recordId, 'recordId'), body, envelope }
}

export async function verifyArchivePledge(envelope, options = {}) {
  let body
  try { body = JSON.parse(b4a.toString(envelope.body)) } catch { return false }
  const allowedSigner = b4a.from(body.archivistId, 'hex')
  const verified = await verifySignedEnvelope(envelope, { recordType: ARCHIVE_PLEDGE_RECORD_TYPE, now: options.now, allowedSigners: [allowedSigner] })
  if (!verified) return false
  if (options.archivistId && body.archivistId !== hex32(options.archivistId, 'archivistId')) return false
  const signer = envelope.signer ? hex32(envelope.signer, 'signer') : null
  if (signer !== body.archivistId) return false
  if (options.now != null && body.retentionUntil < options.now) return false
  if (envelope.recordId && body.pledgeId === envelope.recordId) return false
  return { pledgeId: hex32(envelope.recordId, 'recordId'), body, envelope }
}
