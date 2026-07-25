import b4a from 'b4a'
import {
  RECORD_LIMITS, assertBytes, assertInput, assertUint, encodePreimage, equalBytes, fail,
  fieldSize, readField, readVarint, utf8, varintLength, writeField, writeVarint
} from './canonical.js'

const VARIANT = 1
const SIGNATURE_DOMAIN = 'peartube/signed-record-signature/v1'

function normalizeUnsigned (value) {
  if (!value || typeof value !== 'object') fail('envelope must be an object')
  const recordTypeBytes = utf8(value.recordType, 'recordType', RECORD_LIMITS.maxRecordTypeBytes)
  assertUint(value.schemaMajor, 'schemaMajor', 255)
  assertUint(value.schemaMinor, 'schemaMinor', 255)
  assertBytes(value.issuerIdentityKey, RECORD_LIMITS.keyBytes, 'issuerIdentityKey')
  assertBytes(value.signerKey, RECORD_LIMITS.keyBytes, 'signerKey')
  assertUint(value.policyEpoch, 'policyEpoch')
  const hasSequence = value.issuerSequence !== undefined && value.issuerSequence !== null
  if (hasSequence) assertUint(value.issuerSequence, 'issuerSequence')
  assertUint(value.signedAt, 'signedAt')
  const hasExpiry = value.expiresAt !== undefined && value.expiresAt !== null
  if (hasExpiry) assertUint(value.expiresAt, 'expiresAt')
  if (!value.canonicalBody || value.canonicalBody.byteLength > RECORD_LIMITS.maxBodyBytes) fail('canonicalBody exceeds its byte limit')
  if (!(b4a.isBuffer(value.canonicalBody) || value.canonicalBody instanceof Uint8Array)) fail('canonicalBody must be bytes')
  if (value.bodyLength !== undefined && value.bodyLength !== value.canonicalBody.byteLength) fail('bodyLength does not match canonicalBody')
  return { recordTypeBytes, hasSequence, hasExpiry }
}

export function encodeUnsignedSignedEnvelope (value) {
  const { recordTypeBytes, hasSequence, hasExpiry } = normalizeUnsigned(value)
  const length = 1 + fieldSize(recordTypeBytes) + varintLength(value.schemaMajor) + varintLength(value.schemaMinor) +
    32 + 32 + varintLength(value.policyEpoch) + 1 + (hasSequence ? varintLength(value.issuerSequence) : 0) +
    varintLength(value.signedAt) + 1 + (hasExpiry ? varintLength(value.expiresAt) : 0) +
    varintLength(value.canonicalBody.byteLength) + value.canonicalBody.byteLength
  if (length + 96 > RECORD_LIMITS.maxEnvelopeBytes) fail('envelope exceeds its byte limit')
  const out = b4a.allocUnsafe(length)
  let offset = 0
  out[offset++] = VARIANT
  offset = writeField(out, offset, recordTypeBytes)
  offset = writeVarint(out, offset, value.schemaMajor)
  offset = writeVarint(out, offset, value.schemaMinor)
  out.set(value.issuerIdentityKey, offset); offset += 32
  out.set(value.signerKey, offset); offset += 32
  offset = writeVarint(out, offset, value.policyEpoch)
  out[offset++] = hasSequence ? 1 : 0
  if (hasSequence) offset = writeVarint(out, offset, value.issuerSequence)
  offset = writeVarint(out, offset, value.signedAt)
  out[offset++] = hasExpiry ? 1 : 0
  if (hasExpiry) offset = writeVarint(out, offset, value.expiresAt)
  offset = writeVarint(out, offset, value.canonicalBody.byteLength)
  out.set(value.canonicalBody, offset)
  return out
}

export function encodeSignedEnvelope (value) {
  const unsigned = encodeUnsignedSignedEnvelope(value)
  assertBytes(value.recordId, 32, 'recordId')
  assertBytes(value.signature, 64, 'signature')
  return b4a.concat([unsigned, value.recordId, value.signature])
}

function decodeUnsigned (state) {
  if (readVarint(state, 'variant', 255) !== VARIANT) fail('unknown envelope variant')
  const recordType = b4a.toString(readField(state, 'recordType', RECORD_LIMITS.maxRecordTypeBytes))
  const schemaMajor = readVarint(state, 'schemaMajor', 255)
  const schemaMinor = readVarint(state, 'schemaMinor', 255)
  const issuerIdentityKey = readFixed(state, 'issuerIdentityKey', 32)
  const signerKey = readFixed(state, 'signerKey', 32)
  const policyEpoch = readVarint(state, 'policyEpoch')
  const sequenceTag = readVarint(state, 'issuerSequence variant', 1)
  const issuerSequence = sequenceTag ? readVarint(state, 'issuerSequence') : undefined
  const signedAt = readVarint(state, 'signedAt')
  const expiryTag = readVarint(state, 'expiresAt variant', 1)
  const expiresAt = expiryTag ? readVarint(state, 'expiresAt') : undefined
  const canonicalBody = readField(state, 'canonicalBody', RECORD_LIMITS.maxBodyBytes)
  return { recordType, schemaMajor, schemaMinor, issuerIdentityKey, signerKey, policyEpoch, issuerSequence, signedAt, expiresAt, bodyLength: canonicalBody.byteLength, canonicalBody }
}
function readFixed (state, name, length) {
  if (state.offset + length > state.buffer.byteLength) fail(`truncated ${name}`)
  const value = state.buffer.subarray(state.offset, state.offset + length); state.offset += length; return value
}

export function decodeUnsignedSignedEnvelope (input) {
  assertInput(input)
  const state = { buffer: input, offset: 0 }
  const value = decodeUnsigned(state)
  if (state.offset !== input.byteLength) fail('trailing bytes')
  if (!equalBytes(encodeUnsignedSignedEnvelope(value), input)) fail('non-canonical envelope encoding')
  return value
}

export function decodeSignedEnvelope (input) {
  assertInput(input)
  const state = { buffer: input, offset: 0 }
  const value = decodeUnsigned(state)
  value.recordId = readFixed(state, 'recordId', 32)
  value.signature = readFixed(state, 'signature', 64)
  if (state.offset !== input.byteLength) fail('trailing bytes')
  if (!equalBytes(encodeSignedEnvelope(value), input)) fail('non-canonical envelope encoding')
  return value
}

export function signedRecordSignaturePreimage (value) {
  return encodePreimage(SIGNATURE_DOMAIN, value.recordType, value.recordId)
}

export function prepareSignedEnvelope (value, { hash } = {}) {
  if (typeof hash !== 'function') fail('hash function is required')
  const normalized = { ...value, bodyLength: value?.canonicalBody?.byteLength }
  const recordId = hash(encodeUnsignedSignedEnvelope(normalized))
  assertBytes(recordId, 32, 'hash output')
  return { ...normalized, recordId }
}

export function attachSignedEnvelopeSignature (prepared, signature) {
  assertBytes(prepared?.recordId, 32, 'recordId')
  assertBytes(signature, 64, 'signature')
  return { ...prepared, signature }
}

export function verifySignedEnvelope (value, { hash, verifySignature, authorization } = {}) {
  if (!authorization || typeof authorization !== 'object') fail('explicit authorization context is required')
  if (typeof hash !== 'function' || typeof verifySignature !== 'function') fail('crypto providers are required')
  const canonical = encodeSignedEnvelope(value)
  const decoded = decodeSignedEnvelope(canonical)
  const candidate = hash(encodeUnsignedSignedEnvelope(decoded))
  assertBytes(candidate, 32, 'hash output')
  if (!equalBytes(candidate, decoded.recordId)) fail('recordId mismatch')
  const verified = verifySignature(decoded.signature, signedRecordSignaturePreimage(decoded), decoded.signerKey)
  if (verified !== true) fail('signature verification failed')
  if (!equalBytes(authorization.issuerIdentityKey, decoded.issuerIdentityKey)) fail('issuer authorization mismatch')
  if (authorization.policyEpoch !== decoded.policyEpoch) fail('policy epoch is stale')
  if (typeof authorization.authorizeSequence !== 'function' || authorization.authorizeSequence(decoded) !== true) fail('issuer sequence is not authorized')
  if (typeof authorization.authorizeSigner !== 'function' || authorization.authorizeSigner(decoded) !== true) fail('signer is not authorized')
  assertUint(authorization.now, 'authorization now')
  const skew = authorization.maxClockSkew ?? 0
  assertUint(skew, 'maxClockSkew')
  if (decoded.expiresAt !== undefined && decoded.expiresAt < decoded.signedAt) fail('expiresAt precedes signedAt')
  if (decoded.signedAt > authorization.now && decoded.signedAt - authorization.now > skew) fail('record is future-issued')
  if (decoded.expiresAt !== undefined && authorization.now > decoded.expiresAt && authorization.now - decoded.expiresAt > skew) fail('record expired')
  if (typeof authorization.claimReplay !== 'function' || authorization.claimReplay(decoded.recordId, decoded) !== true) fail('record replay rejected')
  return { valid: true, envelope: decoded }
}
