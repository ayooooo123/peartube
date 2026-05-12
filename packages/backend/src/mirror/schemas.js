import c from 'compact-encoding'

export const SourceType = {
  YOUTUBE: 0,
  TIKTOK: 1,
  DIRECT_URL: 2,
  OTHER: 3,
}

export const MirrorMode = {
  ARCHIVE: 0,
  SEED: 1,
  SEED_AND_PUBLISH: 2,
}

export const DescriptorFlags = {
  PUBLIC: 1 << 0,
  BLIND: 1 << 1,
  MIRRORED: 1 << 2,
  SEEDED: 1 << 3,
  QUARANTINED: 1 << 4,
  TOMBSTONED: 1 << 5,
  EXTERNAL_SOURCE: 1 << 6,
}

export const QuarantineReason = {
  BAD_SIGNATURE: 0,
  STALE: 1,
  UNREACHABLE: 2,
  SAMPLE_FAILED: 3,
  SPAM_SUSPECTED: 4,
  DUPLICATE: 5,
  POLICY_VIOLATION: 6,
}

export const TombstoneReason = {
  EXPIRED: 0,
  REVOKED: 1,
  UNAVAILABLE: 2,
  REPEATED_FAILURE: 3,
  SPAM_CONFIRMED: 4,
  SUPERSEDED: 5,
}

export const WorkerPhase = {
  IDLE: 0,
  DISCOVERY: 1,
  MIRRORING: 2,
  SEEDING: 3,
  PROOF_EMISSION: 4,
  EXPIRY: 5,
}

export const DescriptorState = {
  DISCOVERED: 0,
  VERIFIED: 1,
  ACTIVE: 2,
  QUARANTINED: 3,
  TOMBSTONED: 4,
}

export const ProofKind = {
  FETCH: 0,
  SAMPLE: 1,
  REHYDRATE: 2,
  SEED: 3,
  RELAY_SERVE: 4,
}

export const EventType = {
  DESCRIPTOR_ADDED: 1,
  PROOF_ADDED: 2,
  QUARANTINED: 3,
  TOMBSTONED: 4,
}

export const V1VideoDescriptor = c.struct([
  ['version', c.uint8],
  ['descriptorId', c.fixed32],
  ['contentRoot', c.fixed32],
  ['dasRoot', c.fixed32],
  ['swarmTopic', c.fixed32],
  ['sourceRefHash', c.fixed32],
  ['sourceType', c.uint8],
  ['mirrorOrigin', c.uint8],
  ['contentBytes', c.uint64],
  ['segmentCount', c.uint32],
  ['durationMs', c.uint64],
  ['publishAt', c.uint64],
  ['expiresAt', c.uint64],
  ['availabilityEpoch', c.uint32],
  ['publisherIdentity', c.fixed32],
  ['parentDescriptorId', c.fixed32],
  ['titleHash', c.fixed32],
  ['descriptionHash', c.fixed32],
  ['languageTag', c.string],
  ['codecProfile', c.uint8],
  ['flags', c.uint16],
  ['signer', c.fixed32],
  ['signature', c.fixed64],
])

export const V1AvailabilityProof = c.struct([
  ['version', c.uint8],
  ['proofId', c.fixed32],
  ['descriptorId', c.fixed32],
  ['contentRoot', c.fixed32],
  ['dasRoot', c.fixed32],
  ['relayId', c.fixed32],
  ['reachable', c.bool],
  ['proofKind', c.uint8],
  ['sampleCount', c.uint16],
  ['sampleWindowMs', c.uint32],
  ['observedAt', c.uint64],
  ['expiresAt', c.uint64],
  ['servedBytes', c.uint64],
  ['latencyMs', c.uint32],
  ['activePeers', c.uint16],
  ['chainHead', c.fixed32],
  ['evidence', c.buffer],
  ['signer', c.fixed32],
  ['signature', c.fixed64],
])

export const V1MirrorRequest = c.struct([
  ['version', c.uint8],
  ['requestId', c.fixed32],
  ['requestedBy', c.fixed32],
  ['sourceUrl', c.string],
  ['sourceType', c.uint8],
  ['mirrorMode', c.uint8],
  ['priority', c.uint8],
  ['maxDownloadBytes', c.uint64],
  ['maxDurationMs', c.uint32],
  ['allowDescriptorPublish', c.bool],
  ['allowPublicSourceUrl', c.bool],
  ['retainForMs', c.uint64],
  ['targetTopic', c.fixed32],
  ['notesHash', c.fixed32],
  ['expectedTitleHash', c.fixed32],
  ['expectedDescriptionHash', c.fixed32],
])

export const PeartubeLogEntry = c.struct([
  ['version', c.uint8],
  ['entryType', c.uint8],
  ['entryId', c.fixed32],
  ['prevEntryId', c.fixed32],
  ['actorId', c.fixed32],
  ['observedAt', c.uint64],
  ['payload', c.buffer],
  ['signer', c.fixed32],
  ['signature', c.fixed64],
])

export const DescriptorAddedPayload = c.struct([
  ['descriptor', V1VideoDescriptor],
  ['reason', c.uint8],
  ['parentEventId', c.fixed32],
  ['localSeenAt', c.uint64],
  ['initialState', c.uint8],
])

export const ProofAddedPayload = c.struct([
  ['proof', V1AvailabilityProof],
  ['localSeenAt', c.uint64],
  ['confidence', c.uint8],
  ['stateAfterProof', c.uint8],
  ['failureCountReset', c.bool],
])

export const QuarantinedPayload = c.struct([
  ['descriptorId', c.fixed32],
  ['reasonCode', c.uint8],
  ['reasonTextHash', c.fixed32],
  ['firstObservedAt', c.uint64],
  ['lastObservedAt', c.uint64],
  ['failureCount', c.uint16],
  ['relatedProofId', c.fixed32],
  ['quarantineUntil', c.uint64],
])

export const TombstonedPayload = c.struct([
  ['descriptorId', c.fixed32],
  ['reasonCode', c.uint8],
  ['reasonTextHash', c.fixed32],
  ['tombstonedAt', c.uint64],
  ['retentionExpiredAt', c.uint64],
  ['lastProofId', c.fixed32],
  ['purgeEligibleAt', c.uint64],
])

const textEncoder = new TextEncoder()

function bytesFromHex(hex) {
  const clean = String(hex || '').replace(/[^0-9a-f]/gi, '').toLowerCase()
  const out = new Uint8Array(Math.ceil(clean.length / 2))
  for (let i = 0; i < out.length; i++) {
    const start = i * 2
    out[i] = parseInt(clean.slice(start, start + 2).padEnd(2, '0'), 16) || 0
  }
  return out
}

function ensureBytes(value, size) {
  const out = new Uint8Array(size)
  if (value instanceof Uint8Array) out.set(value.slice(0, size))
  else if (typeof value === 'string') out.set(bytesFromHex(value).slice(0, size))
  else if (value?.buffer instanceof ArrayBuffer) out.set(new Uint8Array(value.buffer, value.byteOffset || 0, Math.min(value.byteLength || 0, size)))
  return out
}

export function toFixed32(value) {
  return ensureBytes(value, 32)
}

export function toFixed64(value) {
  return ensureBytes(value, 64)
}

export function toBuffer(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return textEncoder.encode(String(value ?? ''))
}

export function encodeDescriptor(descriptor) {
  return c.encode(V1VideoDescriptor, descriptor)
}

export function encodeProof(proof) {
  return c.encode(V1AvailabilityProof, proof)
}

export function encodeMirrorRequest(request) {
  return c.encode(V1MirrorRequest, request)
}

export function encodeLogEntry(entry) {
  return c.encode(PeartubeLogEntry, entry)
}

export function decodeLogEntry(buffer) {
  return c.decode(PeartubeLogEntry, buffer)
}

export function decodeDescriptor(buffer) {
  return c.decode(V1VideoDescriptor, buffer)
}

export function decodeProof(buffer) {
  return c.decode(V1AvailabilityProof, buffer)
}

export function decodeMirrorRequest(buffer) {
  return c.decode(V1MirrorRequest, buffer)
}

export function decodeDescriptorAddedPayload(buffer) {
  return c.decode(DescriptorAddedPayload, buffer)
}

export function decodeProofAddedPayload(buffer) {
  return c.decode(ProofAddedPayload, buffer)
}

export function decodeQuarantinedPayload(buffer) {
  return c.decode(QuarantinedPayload, buffer)
}

export function decodeTombstonedPayload(buffer) {
  return c.decode(TombstonedPayload, buffer)
}

export default {
  SourceType,
  MirrorMode,
  DescriptorFlags,
  QuarantineReason,
  TombstoneReason,
  WorkerPhase,
  DescriptorState,
  ProofKind,
  EventType,
  V1VideoDescriptor,
  V1AvailabilityProof,
  V1MirrorRequest,
  PeartubeLogEntry,
  DescriptorAddedPayload,
  ProofAddedPayload,
  QuarantinedPayload,
  TombstonedPayload,
  toFixed32,
  toFixed64,
  toBuffer,
  encodeDescriptor,
  encodeProof,
  encodeMirrorRequest,
  encodeLogEntry,
  decodeLogEntry,
  decodeDescriptor,
  decodeProof,
  decodeMirrorRequest,
  decodeDescriptorAddedPayload,
  decodeProofAddedPayload,
  decodeQuarantinedPayload,
  decodeTombstonedPayload,
}
