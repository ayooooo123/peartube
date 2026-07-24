import b4a from 'b4a'

import {
  createSignedEnvelope,
  decodeSignedEnvelope,
  encodeSignedEnvelope,
  normalizeBuffer,
  verifySignedEnvelope,
} from '../records/signed-envelope.js'
import {
  encodeCanonical,
  normalizeBytes,
  normalizeNonNegativeInteger,
  sortPlain,
  toHex,
} from '../publisher/canonical.js'
import { createEntityReference, createMediaEntityRef } from './entity-ref.js'

export const MEDIA_CLAIM_RECORD_TYPE = 'media.graph.claim.v1'
export const TASK3_MEDIA_CLAIM_RECORD_TYPE = 'peartube.media-claim.v1'
export const MEDIA_CLAIM_BODY_VERSION = 1
export const CLAIM_TYPES = [
  'EntityMetadataClaim',
  'ExternalReferenceClaim',
  'EquivalentEntityClaim',
  'EditionOfClaim',
  'RecordingOfClaim',
  'ContributionClaim',
  'CollectionStructureClaim',
  'CollectionMembershipClaim',
  'SupersedesClaim',
  'RetractionClaim',
  'ModerationClaim',
  'AvailabilityObservation',
]

function normalizeClaim(claim = {}) {
  if (typeof claim.type !== 'string' || !/^[a-z0-9][a-z0-9._:-]*$/i.test(claim.type)) {
    throw new Error('claim.type must be a domain string')
  }
  if (claim.value == null || typeof claim.value === 'object') throw new Error('claim.value must be scalar')
  const value = String(claim.value)
  if (value.length === 0 || value.length > 2048) throw new Error('claim.value must be bounded')
  return { type: claim.type.toLowerCase(), value }
}

function normalizeClaims(claims = []) {
  if (!Array.isArray(claims)) throw new Error('claims must be an array')
  const keyed = new Map()
  for (const claim of claims.map(normalizeClaim)) keyed.set(`${claim.type}\0${claim.value}`, claim)
  return Array.from(keyed.keys()).sort().map(key => keyed.get(key))
}

export function normalizeMediaClaimBody(input = {}) {
  return {
    version: MEDIA_CLAIM_BODY_VERSION,
    publisherId: toHex(input.publisherId, 32, 'publisherId'),
    authorDeviceKey: toHex(input.authorDeviceKey, 32, 'authorDeviceKey'),
    sequence: normalizeNonNegativeInteger(input.sequence, 'sequence', 0),
    createdAt: normalizeNonNegativeInteger(input.createdAt, 'createdAt', 0),
    media: createMediaEntityRef(input.media),
    claims: normalizeClaims(input.claims || []),
    attachments: sortPlain(input.attachments || []),
  }
}

export function encodeMediaClaimBody(input = {}) {
  return encodeCanonical(normalizeMediaClaimBody(input))
}

export function decodeMediaClaimBody(buffer) {
  const parsed = JSON.parse(b4a.toString(normalizeBytes(buffer, null, 'media claim body'), 'utf8'))
  return normalizeMediaClaimBody(parsed)
}

export function createMediaClaimEnvelope(input = {}) {
  const body = input.body ? normalizeBuffer(input.body, 'body') : encodeMediaClaimBody(input)
  return createSignedEnvelope({
    recordType: MEDIA_CLAIM_RECORD_TYPE,
    body,
    keyPair: input.keyPair,
    nonce: input.nonce,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  })
}

export function encodeMediaClaimEnvelope(envelope, options = {}) {
  return encodeSignedEnvelope(envelope, options)
}

export function decodeMediaClaimEnvelope(buffer, options = {}) {
  return decodeSignedEnvelope(buffer, options)
}

export async function verifyMediaClaimEnvelope(envelope, options = {}) {
  const verified = await verifySignedEnvelope(envelope, {
    ...options,
    recordType: MEDIA_CLAIM_RECORD_TYPE,
  })
  if (!verified) return false

  let body
  try {
    body = decodeMediaClaimBody(envelope.body)
  } catch {
    return false
  }

  if (options.publisherId && body.publisherId !== toHex(options.publisherId, 32, 'publisherId')) return false
  if (options.mediaId && body.media.id !== String(options.mediaId)) return false
  if (options.authorDeviceKey && body.authorDeviceKey !== toHex(options.authorDeviceKey, 32, 'authorDeviceKey')) return false
  return true
}

function normalizeClaimType(claimType) {
  if (!CLAIM_TYPES.includes(claimType)) throw new Error('claimType is unsupported')
  return claimType
}

function normalizeBoundedArray(value, name, max) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  if (value.length === 0 || value.length > max) throw new Error(`${name} length exceeds maximum`)
  return value
}

function normalizeEvidenceRefs(evidenceRefs = []) {
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length > 64) throw new Error('evidenceRefs length exceeds maximum')
  return evidenceRefs.map(ref => sortPlain(ref))
}

function assertPayloadBound(payload) {
  if (encodeCanonical(payload || {}).byteLength > 64 * 1024) throw new Error('payload exceeds maximum size')
}

function assertNonNegativePosition(position = {}) {
  for (const value of Object.values(position || {})) {
    const next = Number(value)
    if (!Number.isSafeInteger(next) || next < 0) throw new Error('position values must be non-negative safe integers')
  }
}

function normalizeClaimPayload(claimType, payload = {}) {
  const normalized = sortPlain(payload || {})
  assertPayloadBound(normalized)
  if (claimType === 'ContributionClaim') {
    if (!normalized.agentRef) throw new Error('ContributionClaim requires agentRef')
    if (createEntityReference(normalized.agentRef).entityKind !== 'agent') throw new Error('ContributionClaim requires agentRef')
    createEntityReference(normalized.subjectRef)
  } else if (claimType === 'CollectionMembershipClaim') {
    if (createEntityReference(normalized.collectionRef).entityKind !== 'collection') throw new Error('CollectionMembershipClaim requires collectionRef')
    createEntityReference(normalized.memberRef)
    assertNonNegativePosition(normalized.position)
  } else if (claimType === 'CollectionStructureClaim') {
    if (createEntityReference(normalized.collectionRef).entityKind !== 'collection') throw new Error('CollectionStructureClaim requires collectionRef')
    const expectedSlots = Number(normalized.expectedSlots || 0)
    if (!Number.isSafeInteger(expectedSlots) || expectedSlots < 0 || expectedSlots > 100000) throw new Error('expectedSlots must be between 0 and 100000')
  } else if (claimType === 'RetractionClaim') {
    if (!Array.isArray(normalized.targetClaimIds) || normalized.targetClaimIds.length === 0) throw new Error('RetractionClaim requires targetClaimIds')
  }
  return normalized
}

export function normalizeClaimBody(input = {}) {
  const claimType = normalizeClaimType(input.claimType)
  return {
    claimType,
    subjectRefs: normalizeBoundedArray(input.subjectRefs || [], 'subjectRefs', 64).map(createEntityReference),
    payload: normalizeClaimPayload(claimType, input.payload || {}),
    evidenceRefs: normalizeEvidenceRefs(input.evidenceRefs || []),
    confidence: normalizeNonNegativeInteger(input.confidence, 'confidence', 0),
    issuerSequence: normalizeNonNegativeInteger(input.issuerSequence, 'issuerSequence', 0),
    policyEpoch: normalizeNonNegativeInteger(input.policyEpoch, 'policyEpoch', 0),
  }
}

export function encodeClaimBody(input = {}) {
  return encodeCanonical(normalizeClaimBody(input))
}

export function decodeClaimBody(buffer) {
  const parsed = JSON.parse(b4a.toString(normalizeBytes(buffer, null, 'claim body'), 'utf8'))
  return normalizeClaimBody(parsed)
}

export function createMediaClaim(input = {}) {
  const claimType = normalizeClaimType(input.claimType)
  if (claimType !== 'AvailabilityObservation' && input.expiresAt != null && Number(input.expiresAt) > 0) {
    throw new Error(`${claimType} does not expire`)
  }
  const body = normalizeClaimBody(input)
  const envelope = createSignedEnvelope({
    recordType: TASK3_MEDIA_CLAIM_RECORD_TYPE,
    body: encodeClaimBody(body),
    keyPair: input.keyPair,
    nonce: input.nonce,
    issuedAt: input.signedAt,
    expiresAt: claimType === 'AvailabilityObservation' ? input.expiresAt : 0,
  })
  return {
    claimId: b4a.toString(envelope.recordId, 'hex'),
    body,
    envelope,
  }
}

function signerHex(envelope) {
  return envelope?.signer ? b4a.toString(normalizeBytes(envelope.signer, 32, 'signer'), 'hex') : null
}

export async function verifyMediaClaim(envelope, options = {}) {
  const verified = await verifySignedEnvelope(envelope, {
    ...options,
    recordType: TASK3_MEDIA_CLAIM_RECORD_TYPE,
  })
  if (!verified) return false
  let body
  try {
    body = decodeClaimBody(envelope.body)
  } catch {
    return false
  }
  if (body.claimType === 'RetractionClaim' && Array.isArray(options.targetClaims)) {
    const issuer = signerHex(envelope)
    const targets = new Map(options.targetClaims.map(claim => [claim.claimId, claim]))
    for (const targetClaimId of body.payload.targetClaimIds || []) {
      const target = targets.get(targetClaimId)
      if (!target || signerHex(target.envelope) !== issuer) return false
    }
  }
  return true
}
