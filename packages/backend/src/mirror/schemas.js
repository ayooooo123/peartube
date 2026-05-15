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

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

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

function bytesToHex(bytes) {
  return Array.from(bytes || [], (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function fromJsonValue(value) {
  if (value && typeof value === 'object') {
    if (value.__u8) return bytesFromHex(value.__u8)
    if (value.__bigint) return BigInt(value.__bigint)
    if (Array.isArray(value)) return value.map(fromJsonValue)
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, fromJsonValue(child)]))
  }
  return value
}

function toJsonValue(value) {
  if (typeof value === 'bigint') return { __bigint: value.toString() }
  if (value instanceof Uint8Array) return { __u8: bytesToHex(value) }
  if (value instanceof ArrayBuffer) return { __u8: bytesToHex(new Uint8Array(value)) }
  if (Array.isArray(value)) return value.map(toJsonValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toJsonValue(child)]))
  }
  return value
}

function encodeJson(value) {
  return textEncoder.encode(JSON.stringify(toJsonValue(value)))
}

function decodeJson(buffer) {
  return fromJsonValue(JSON.parse(textDecoder.decode(toBuffer(buffer))))
}

function jsonEncoding(name) {
  return {
    preencode(state, value) {
      c.buffer.preencode(state, encodeJson({ name, value }))
    },
    encode(state, value) {
      c.buffer.encode(state, encodeJson({ name, value }))
    },
    decode(state) {
      const decoded = decodeJson(c.buffer.decode(state))
      return decoded.value
    },
  }
}

export const V1VideoDescriptor = jsonEncoding('V1VideoDescriptor')
export const V1AvailabilityProof = jsonEncoding('V1AvailabilityProof')
export const V1MirrorRequest = jsonEncoding('V1MirrorRequest')
export const PeartubeLogEntry = jsonEncoding('PeartubeLogEntry')
export const DescriptorAddedPayload = jsonEncoding('DescriptorAddedPayload')
export const ProofAddedPayload = jsonEncoding('ProofAddedPayload')
export const QuarantinedPayload = jsonEncoding('QuarantinedPayload')
export const TombstonedPayload = jsonEncoding('TombstonedPayload')

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

export function encodeDescriptorAddedPayload(payload) {
  return c.encode(DescriptorAddedPayload, payload)
}

export function encodeProofAddedPayload(payload) {
  return c.encode(ProofAddedPayload, payload)
}

export function encodeQuarantinedPayload(payload) {
  return c.encode(QuarantinedPayload, payload)
}

export function encodeTombstonedPayload(payload) {
  return c.encode(TombstonedPayload, payload)
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
  encodeDescriptorAddedPayload,
  encodeProofAddedPayload,
  encodeQuarantinedPayload,
  encodeTombstonedPayload,
  decodeLogEntry,
  decodeDescriptor,
  decodeProof,
  decodeMirrorRequest,
  decodeDescriptorAddedPayload,
  decodeProofAddedPayload,
  decodeQuarantinedPayload,
  decodeTombstonedPayload,
}
