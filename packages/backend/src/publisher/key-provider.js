import b4a from 'b4a'

import {
  MAX_SIGNED_BODY_BYTES,
  decodeUnsignedRecord,
  deriveRecordId,
  encodeUnsignedRecord,
  verifySignedEnvelope,
} from '../records/index.js'
import {
  normalizeNonNegativeInteger,
  sortPlain,
  toHex,
} from './canonical.js'

export const MAX_PREPARED_ROOT_OPERATION_BYTES = MAX_SIGNED_BODY_BYTES

function normalizeBody(body) {
  if (b4a.isBuffer(body) || body instanceof Uint8Array) return b4a.from(body)
  if (typeof body === 'string') return b4a.from(body)
  throw new Error('body must be bytes or string')
}

function cloneSummary(summary) {
  return summary == null ? null : sortPlain(summary)
}

function normalizeRecordType(recordType) {
  if (typeof recordType !== 'string' || !/^[a-z0-9][a-z0-9._:-]*$/i.test(recordType)) {
    throw new Error('invalid recordType')
  }
  return recordType
}

function nowFrom(options) {
  const now = options.now || (() => Date.now())
  return normalizeNonNegativeInteger(now(), 'now', 0)
}

function normalizePrepared(prepared = {}) {
  if (!prepared.publisherId) throw new Error('publisherId is required')
  const unsignedBytes = b4a.from(prepared.unsignedBytes || [])
  const decoded = decodeUnsignedRecord(unsignedBytes, { maxBodyBytes: MAX_PREPARED_ROOT_OPERATION_BYTES })
  const computedRecordId = deriveRecordId(decoded, { maxBodyBytes: MAX_PREPARED_ROOT_OPERATION_BYTES })
  const candidateRecordId = b4a.from(prepared.candidateRecordId || [])
  if (!b4a.equals(candidateRecordId, computedRecordId)) throw new Error('candidate-record-id-mismatch')
  return { ...prepared, decoded, unsignedBytes, candidateRecordId }
}

export function createPublisherKeyProvider(options = {}) {
  return {
    preparePublisherRootOperation(input = {}) {
      const body = normalizeBody(input.body || b4a.alloc(0))
      if (body.byteLength > MAX_PREPARED_ROOT_OPERATION_BYTES) throw new Error('body length exceeds maximum')
      const issuedAt = normalizeNonNegativeInteger(input.issuedAt, 'issuedAt', nowFrom(options))
      const expiresAt = input.expiresAt != null
        ? normalizeNonNegativeInteger(input.expiresAt, 'expiresAt', 0)
        : issuedAt + normalizeNonNegativeInteger(input.expiresInMs, 'expiresInMs', 5 * 60 * 1000)
      const recordType = normalizeRecordType(input.recordType)
      const unsigned = {
        recordType,
        body,
        issuedAt,
        expiresAt,
      }
      const unsignedBytes = encodeUnsignedRecord(unsigned, { maxBodyBytes: MAX_PREPARED_ROOT_OPERATION_BYTES })
      const candidateRecordId = deriveRecordId(unsigned, { maxBodyBytes: MAX_PREPARED_ROOT_OPERATION_BYTES })
      return {
        publisherId: input.publisherId,
        recordType,
        unsignedBytes,
        candidateRecordId,
        recordId: candidateRecordId,
        bodyLength: body.byteLength,
        issuedAt,
        expiresAt,
        displaySummary: cloneSummary(input.displaySummary),
      }
    },

    async submitPublisherRootOperation(input = {}) {
      try {
        const prepared = normalizePrepared(input.prepared)
        const signer = b4a.from(input.signer || [])
        const signature = b4a.from(input.signature || [])
        const envelope = {
          ...prepared.decoded,
          recordId: prepared.candidateRecordId,
          signer,
          signature,
        }
        const valid = await verifySignedEnvelope(envelope, {
          recordType: prepared.recordType,
          allowedSigners: input.allowedSigners || [],
          now: options.now ? nowFrom(options) : 0,
          maxBodyBytes: MAX_PREPARED_ROOT_OPERATION_BYTES,
        }).catch(() => false)
        if (!valid) return { valid: false, reason: 'signature-verification-failed' }
        return {
          valid: true,
          publisherId: prepared.publisherId,
          recordType: prepared.recordType,
          recordId: prepared.candidateRecordId,
          recordIdHex: toHex(prepared.candidateRecordId, 32, 'recordId'),
          signer,
          envelope,
        }
      } catch (error) {
        return { valid: false, reason: error?.message || 'invalid-prepared-operation' }
      }
    },
  }
}
