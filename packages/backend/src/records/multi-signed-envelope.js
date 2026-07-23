import b4a from 'b4a'
import c from 'compact-encoding'
import crypto from 'hypercore-crypto'

import {
  MAX_SIGNED_BODY_BYTES,
  decodeUnsignedRecordFromState,
  encodeUnsignedRecord,
  hashDomain,
  isSignerAuthorized,
  normalizePublicKey,
  normalizeSignature,
  normalizeUnsignedRecord,
  toHex,
} from './signed-envelope.js'

export const MAX_MULTI_SIGNATURES = 16
export const TRANSITION_ID_DOMAIN = 'peartube.multi-signed-envelope.transition-id.v1'
export const MULTI_SIGNATURE_DOMAIN = 'peartube.multi-signed-envelope.signature.v1'

export function deriveTransitionId(input = {}, options = {}) {
  return hashDomain(TRANSITION_ID_DOMAIN, encodeUnsignedRecord(input, options))
}

export function deriveTransitionSigningDigest(transitionId) {
  return hashDomain(MULTI_SIGNATURE_DOMAIN, normalizePublicKey(transitionId, 'transitionId'))
}

function normalizeSignatureEntry(entry) {
  return {
    signer: normalizePublicKey(entry?.signer, 'signature.signer'),
    signature: normalizeSignature(entry?.signature, 'signature.signature'),
  }
}

function normalizeSignatureEntries(entries, options = {}) {
  if (!Array.isArray(entries)) throw new Error('signatures must be an array')
  if (entries.length > MAX_MULTI_SIGNATURES) throw new Error('too many signatures')
  const normalized = entries.map(normalizeSignatureEntry)
  normalized.sort((left, right) => toHex(left.signer).localeCompare(toHex(right.signer)))
  for (let i = 1; i < normalized.length; i++) {
    if (b4a.equals(normalized[i - 1].signer, normalized[i].signer)) {
      throw new Error('duplicate signer')
    }
  }
  if (options.requireSignatures !== false && normalized.length === 0) throw new Error('at least one signature is required')
  return normalized
}

function createSignatureEntriesFromKeyPairs(keyPairs, transitionId) {
  if (!Array.isArray(keyPairs)) throw new Error('keyPairs must be an array')
  if (keyPairs.length > MAX_MULTI_SIGNATURES) throw new Error('too many signatures')
  const digest = deriveTransitionSigningDigest(transitionId)
  return normalizeSignatureEntries(keyPairs.map((keyPair) => {
    if (!keyPair?.publicKey || !keyPair?.secretKey) throw new Error('keyPair with publicKey and secretKey is required')
    return {
      signer: keyPair.publicKey,
      signature: crypto.sign(digest, keyPair.secretKey),
    }
  }))
}

export function createMultiSignedEnvelope(input = {}) {
  const unsigned = normalizeUnsignedRecord(input)
  const transitionId = deriveTransitionId(unsigned)
  const signatures = input.keyPairs
    ? createSignatureEntriesFromKeyPairs(input.keyPairs, transitionId)
    : normalizeSignatureEntries(input.signatures || [])

  return {
    ...unsigned,
    transitionId,
    signatures,
  }
}

export function encodeMultiSignedEnvelope(envelope, options = {}) {
  const unsigned = normalizeUnsignedRecord(envelope, options)
  const computedTransitionId = deriveTransitionId(unsigned, options)
  const transitionId = envelope.transitionId ? normalizePublicKey(envelope.transitionId, 'transitionId') : computedTransitionId
  if (!b4a.equals(transitionId, computedTransitionId)) throw new Error('transitionId mismatch')
  const signatures = normalizeSignatureEntries(envelope.signatures || [])
  const chunks = [
    encodeUnsignedRecord(unsigned, options),
    c.encode(c.fixed32, transitionId),
    c.encode(c.uint, signatures.length),
  ]
  for (const entry of signatures) {
    chunks.push(c.encode(c.fixed32, entry.signer))
    chunks.push(c.encode(c.fixed64, entry.signature))
  }
  return b4a.concat(chunks)
}

export function decodeMultiSignedEnvelope(buffer, options = {}) {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_SIGNED_BODY_BYTES
  const frame = b4a.from(buffer)
  const state = c.state(0, frame.byteLength, frame)
  const unsigned = decodeUnsignedRecordFromState(state, { maxBodyBytes })
  const transitionId = c.fixed32.decode(state)
  if (!b4a.equals(transitionId, deriveTransitionId(unsigned, { maxBodyBytes }))) throw new Error('transitionId mismatch')
  const count = c.uint.decode(state)
  if (count > MAX_MULTI_SIGNATURES) throw new Error('too many signatures')
  const signatures = []
  for (let i = 0; i < count; i++) {
    signatures.push({
      signer: c.fixed32.decode(state),
      signature: c.fixed64.decode(state),
    })
  }
  if (state.start !== state.end) throw new Error('trailing bytes after multi-signed envelope')
  return {
    ...unsigned,
    transitionId,
    signatures: normalizeSignatureEntries(signatures),
  }
}

export async function verifyMultiSignedEnvelope(envelope, options = {}) {
  const normalized = {
    ...normalizeUnsignedRecord(envelope, options),
    transitionId: normalizePublicKey(envelope.transitionId, 'transitionId'),
    signatures: normalizeSignatureEntries(envelope.signatures || []),
  }
  if (options.recordType && normalized.recordType !== options.recordType) return false
  const computedTransitionId = deriveTransitionId(normalized, options)
  if (!b4a.equals(computedTransitionId, normalized.transitionId)) return false

  const now = options.now == null ? 0 : Number(options.now)
  if (now > 0) {
    if (!Number.isSafeInteger(now) || now < 0) return false
    if (normalized.issuedAt > 0 && normalized.issuedAt > now) return false
    if (normalized.expiresAt > 0 && normalized.expiresAt < now) return false
  }

  const threshold = options.threshold == null ? 1 : Number(options.threshold)
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > MAX_MULTI_SIGNATURES) return false
  if (normalized.signatures.length < threshold) return false

  const digest = deriveTransitionSigningDigest(normalized.transitionId)
  let accepted = 0
  for (const entry of normalized.signatures) {
    if (!isSignerAuthorized(entry.signer, options)) return false
    if (!crypto.verify(digest, entry.signature, entry.signer)) return false
    accepted++
  }

  return accepted >= threshold
}
