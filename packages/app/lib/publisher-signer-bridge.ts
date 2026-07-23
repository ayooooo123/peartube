// @ts-nocheck

import {
  decodeUnsignedRecord,
  deriveRecordId,
  deriveSigningDigest,
  verifySignedEnvelope,
} from '@peartube/backend/records'

function bytesFromHex(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function normalizeBytes(value, name = 'bytes') {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string' && /^(?:[0-9a-f]{2})+$/i.test(value)) {
    return bytesFromHex(value)
  }
  throw new Error(`${name} must be bytes or hex`)
}

export function constantTimeEqual(left, right) {
  const a = normalizeBytes(left, 'left')
  const b = normalizeBytes(right, 'right')
  if (a.byteLength === 0 || b.byteLength === 0) return a.byteLength === b.byteLength
  let diff = a.byteLength ^ b.byteLength
  const len = Math.max(a.byteLength, b.byteLength)
  for (let i = 0; i < len; i++) {
    diff |= a[i % a.byteLength] ^ b[i % b.byteLength]
  }
  return diff === 0
}

function canonicalSummary(value) {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalSummary).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalSummary(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function assertShellCaller(caller) {
  if (caller !== 'shell') throw new Error('shell-owned signer required')
}

function assertIntentFields(intent, request, now) {
  if (!intent) throw new Error('unknown or consumed intent')
  if (intent.expiresAt > 0 && now > intent.expiresAt) throw new Error('signing intent expired')
  if (intent.publisherId !== request.publisherId) throw new Error('publisher mismatch')
  if (intent.recordType !== request.recordType) throw new Error('record type mismatch')
  if (!constantTimeEqual(intent.unsignedBytes, request.unsignedBytes)) throw new Error('unsigned bytes mismatch')
  if (!constantTimeEqual(intent.candidateRecordId, request.candidateRecordId)) throw new Error('candidate record id mismatch')
  if (canonicalSummary(intent.displaySummary) !== canonicalSummary(request.displaySummary)) throw new Error('display summary mismatch')
}

export function createPublisherSignerBridge(options = {}) {
  const vault = options.vault
  if (!vault?.signDigest || !vault?.getPublicKey) throw new Error('vault with getPublicKey and signDigest is required')
  const intents = new Map()
  const now = options.now || (() => Date.now())

  return {
    registerIntent(intent = {}) {
      if (!intent.intentId) throw new Error('intentId is required')
      if (!intent.publisherId) throw new Error('publisherId is required')
      if (!intent.recordType) throw new Error('recordType is required')
      const unsignedBytes = normalizeBytes(intent.unsignedBytes, 'unsignedBytes')
      const decoded = decodeUnsignedRecord(unsignedBytes)
      const recomputedRecordId = deriveRecordId(decoded)
      const candidateRecordId = normalizeBytes(intent.candidateRecordId || recomputedRecordId, 'candidateRecordId')
      if (!constantTimeEqual(recomputedRecordId, candidateRecordId)) throw new Error('candidate record id mismatch')
      if (decoded.recordType !== intent.recordType) throw new Error('record type mismatch')
      const stored = {
        intentId: intent.intentId,
        publisherId: intent.publisherId,
        recordType: intent.recordType,
        unsignedBytes,
        candidateRecordId,
        displaySummary: intent.displaySummary || null,
        expiresAt: Number(intent.expiresAt || decoded.expiresAt || 0) || 0,
      }
      intents.set(stored.intentId, stored)
      return {
        intentId: stored.intentId,
        publisherId: stored.publisherId,
        recordType: stored.recordType,
        candidateRecordId: stored.candidateRecordId,
        displaySummary: stored.displaySummary,
        expiresAt: stored.expiresAt,
      }
    },

    async signPreparedOperation(request = {}) {
      assertShellCaller(request.caller)
      const intent = intents.get(request.intentId)
      assertIntentFields(intent, request, now())

      const decoded = decodeUnsignedRecord(normalizeBytes(request.unsignedBytes, 'unsignedBytes'))
      const recomputedRecordId = deriveRecordId(decoded)
      const candidateRecordId = normalizeBytes(request.candidateRecordId, 'candidateRecordId')
      if (!constantTimeEqual(recomputedRecordId, candidateRecordId)) throw new Error('candidate record id mismatch')
      if (decoded.recordType !== request.recordType) throw new Error('record type mismatch')

      // The display summary is compared to the shell intent for user-visible
      // continuity, but summary is never signature authority; only canonical
      // unsigned bytes and the recomputed record id feed the signing digest.
      const publicKey = await vault.getPublicKey({ publisherId: request.publisherId })
      const signed = await vault.signDigest({
        publisherId: request.publisherId,
        intentId: request.intentId,
        recordType: request.recordType,
        recordId: recomputedRecordId,
        signingDigest: deriveSigningDigest(recomputedRecordId),
        publicKey,
      })
      intents.delete(request.intentId)
      return {
        ...decoded,
        recordId: recomputedRecordId,
        signer: signed.signer || publicKey,
        signature: signed.signature,
      }
    },

    consumeIntent(intentId) {
      const intent = intents.get(intentId)
      intents.delete(intentId)
      return intent || null
    },
  }
}

export async function verifyBridgeSignedOperation(envelope, options = {}) {
  return verifySignedEnvelope(envelope, options)
}
