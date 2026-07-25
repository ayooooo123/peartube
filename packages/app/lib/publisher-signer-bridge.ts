// @ts-nocheck

import * as ed25519 from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'
import { hashPublisherBytes } from './publisher-mobile-crypto'
import {
  decodeUnsignedMultiSignedEnvelope,
  decodeUnsignedSignedEnvelope,
  encodeUnsignedMultiSignedEnvelope,
  encodeUnsignedSignedEnvelope,
  multiSignedRecordSignaturePreimage,
  signedRecordSignaturePreimage,
} from '@peartube/backend/records'

ed25519.hashes.sha512 = sha512

const ROOT_RECORD_TYPES = new Set([
  'publisher.namespace',
  'publisher.writer-admission',
  'publisher.writer-revocation',
  'publisher.root-transition',
])
const ROOT_TRANSITION_RECORD_TYPE = 'publisher.root-transition'
const RECORD_ID_BYTES = 32
const PUBLIC_KEY_BYTES = 32
const SIGNATURE_BYTES = 64
const MAX_INTENT_TTL_MS = 5 * 60_000

function signerError(code) {
  const error = new Error(`Publisher signer error: ${code}`)
  error.code = code
  return error
}

function bytes(value, length) {
  if (!(value instanceof Uint8Array) || (length !== undefined && value.byteLength !== length)) {
    throw signerError('PUBLISHER_SIGNER_INVALID_PREPARED')
  }
  return value
}

export function constantTimeEqual(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index++) difference |= left[index] ^ right[index]
  return difference === 0
}

function assertRootRecordType(recordType) {
  if (!ROOT_RECORD_TYPES.has(recordType)) throw signerError('PUBLISHER_SIGNER_RECORD_TYPE_FORBIDDEN')
}

export function publisherRootSignaturePreimage(request = {}) {
  assertRootRecordType(request.recordType)
  const transition = request.recordType === ROOT_TRANSITION_RECORD_TYPE
  const expectedKeys = transition ? ['recordType', 'transitionId'] : ['recordId', 'recordType']
  const keys = Object.keys(request).sort()
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw signerError('PUBLISHER_SIGNER_INVALID_PREPARED')
  }
  return transition
    ? multiSignedRecordSignaturePreimage({
      recordType: request.recordType,
      transitionId: bytes(request.transitionId, RECORD_ID_BYTES),
    })
    : signedRecordSignaturePreimage({
      recordType: request.recordType,
      recordId: bytes(request.recordId, RECORD_ID_BYTES),
    })
}

function randomIntentId(randomBytes) {
  return Array.from(randomBytes(16), (value) => value.toString(16).padStart(2, '0')).join('')
}

function decodeCanonicalUnsigned(recordType, unsignedBytes) {
  try {
    const transition = recordType === ROOT_TRANSITION_RECORD_TYPE
    const decoded = transition
      ? decodeUnsignedMultiSignedEnvelope(unsignedBytes)
      : decodeUnsignedSignedEnvelope(unsignedBytes)
    const reencoded = transition
      ? encodeUnsignedMultiSignedEnvelope(decoded)
      : encodeUnsignedSignedEnvelope(decoded)
    if (!constantTimeEqual(reencoded, unsignedBytes) || decoded.recordType !== recordType) {
      throw signerError('PUBLISHER_SIGNER_MISMATCH')
    }
    if (!transition && decoded.expiresAt != null) {
      throw signerError('PUBLISHER_SIGNER_INVALID_PREPARED')
    }
    return decoded
  } catch (error) {
    if (error?.code) throw error
    throw signerError('PUBLISHER_SIGNER_INVALID_PREPARED')
  }
}

function clearIntent(intent) {
  intent.body.fill(0)
  intent.signerPublicKey.fill(0)
}

export function createPublisherSignerBridge(options = {}) {
  const vault = options.vault
  if (!vault?.getPublicKey || !vault?.signProtocolRecord) throw signerError('PUBLISHER_SIGNER_VAULT_UNAVAILABLE')
  const intents = new Map()
  const now = options.now || (() => Date.now())
  const hash = options.hash || hashPublisherBytes
  const randomBytes = options.randomBytes || ((length) => {
    const output = new Uint8Array(length)
    if (!globalThis.crypto?.getRandomValues) throw signerError('PUBLISHER_SIGNER_VAULT_UNAVAILABLE')
    globalThis.crypto.getRandomValues(output)
    return output
  })

  return {
    async beginUserIntent(request = {}) {
      if (request.userInitiated !== true) throw signerError('PUBLISHER_SIGNER_BACKGROUND_FORBIDDEN')
      if (!request.publisherId) throw signerError('PUBLISHER_SIGNER_INVALID_INTENT')
      assertRootRecordType(request.recordType)
      const currentTime = now()
      if (!Number.isSafeInteger(request.intentExpiresAt) || request.intentExpiresAt <= currentTime || request.intentExpiresAt > currentTime + MAX_INTENT_TTL_MS) {
        throw signerError('PUBLISHER_SIGNER_INVALID_INTENT')
      }
      const body = bytes(request.body)
      let signerPublicKey
      try {
        signerPublicKey = bytes(
          await vault.getPublicKey({ publisherId: request.publisherId }),
          PUBLIC_KEY_BYTES,
        )
      } catch {
        throw signerError('PUBLISHER_SIGNER_VAULT_UNAVAILABLE')
      }
      const intentId = randomIntentId(randomBytes)
      if (intents.has(intentId)) throw signerError('PUBLISHER_SIGNER_REPLAY')
      intents.set(intentId, {
        intentId,
        publisherId: request.publisherId,
        recordType: request.recordType,
        body: body.slice(),
        displaySummaryJson: request.displaySummaryJson ?? null,
        intentExpiresAt: request.intentExpiresAt,
        signerPublicKey: signerPublicKey.slice(),
      })
      return { intentId, signerPublicKey: signerPublicKey.slice() }
    },

    async signPreparedRecord(intentId, prepared = {}) {
      const intent = intents.get(intentId)
      if (!intent) throw signerError('PUBLISHER_SIGNER_UNKNOWN_INTENT')
      try {
        if (now() >= intent.intentExpiresAt) throw signerError('PUBLISHER_SIGNER_EXPIRED')
        if (
          prepared.intentId !== intentId ||
          !prepared.success ||
          prepared.publisherId !== intent.publisherId ||
          prepared.recordType !== intent.recordType ||
          prepared.displaySummaryJson !== intent.displaySummaryJson ||
          prepared.intentExpiresAt !== intent.intentExpiresAt ||
          !constantTimeEqual(prepared.signerPublicKey, intent.signerPublicKey)
        ) {
          throw signerError('PUBLISHER_SIGNER_MISMATCH')
        }
        const unsignedBytes = bytes(prepared.unsignedBytes)
        const candidateRecordId = bytes(prepared.candidateRecordId, RECORD_ID_BYTES)
        const recomputedId = hash(unsignedBytes)
        if (!constantTimeEqual(recomputedId, candidateRecordId)) throw signerError('PUBLISHER_SIGNER_MISMATCH')
        const decoded = decodeCanonicalUnsigned(intent.recordType, unsignedBytes)
        if (
          !constantTimeEqual(decoded.canonicalBody, intent.body) ||
          decoded.bodyLength !== prepared.bodyLength ||
          decoded.signedAt !== prepared.issuedAt ||
          (intent.recordType !== ROOT_TRANSITION_RECORD_TYPE && !constantTimeEqual(decoded.signerKey, intent.signerPublicKey))
        ) {
          throw signerError('PUBLISHER_SIGNER_MISMATCH')
        }

        const protocolRequest = intent.recordType === ROOT_TRANSITION_RECORD_TYPE
          ? { recordType: intent.recordType, transitionId: candidateRecordId }
          : { recordType: intent.recordType, recordId: candidateRecordId }
        let signed
        try {
          signed = await vault.signProtocolRecord({ publisherId: intent.publisherId, ...protocolRequest })
        } catch {
          throw signerError('PUBLISHER_SIGNER_VAULT_UNAVAILABLE')
        }
        let signerPublicKey
        let signature
        try {
          signerPublicKey = bytes(signed?.signerPublicKey, PUBLIC_KEY_BYTES)
          signature = bytes(signed?.signature, SIGNATURE_BYTES)
        } catch {
          throw signerError('PUBLISHER_SIGNER_SIGNATURE_SUBSTITUTION')
        }
        if (!constantTimeEqual(signerPublicKey, intent.signerPublicKey)) {
          throw signerError('PUBLISHER_SIGNER_SIGNATURE_SUBSTITUTION')
        }
        const preimage = publisherRootSignaturePreimage(protocolRequest)
        const valid = ed25519.verify(signature, preimage, signerPublicKey)
        preimage.fill(0)
        if (!valid) throw signerError('PUBLISHER_SIGNER_SIGNATURE_SUBSTITUTION')

        return {
          intentId,
          publisherId: intent.publisherId,
          recordType: intent.recordType,
          unsignedBytes: unsignedBytes.slice(),
          candidateRecordId: candidateRecordId.slice(),
          displaySummaryJson: intent.displaySummaryJson,
          signer: signerPublicKey.slice(),
          signerPublicKey: signerPublicKey.slice(),
          signature: signature.slice(),
        }
      } finally {
        intents.delete(intentId)
        clearIntent(intent)
      }
    },

    completeIntent(intentId) {
      const intent = intents.get(intentId)
      intents.delete(intentId)
      if (intent) clearIntent(intent)
    },

    cancelIntent(intentId) {
      const intent = intents.get(intentId)
      intents.delete(intentId)
      if (intent) clearIntent(intent)
    },
  }
}
