import b4a from 'b4a'
import {
  RECORD_LIMITS, assertBytes, assertInput, assertUint, compareBytes, encodePreimage, equalBytes, fail,
  fieldSize, readField, readVarint, utf8, varintLength, writeField, writeVarint
} from './canonical.js'

const VARIANT = 2
const SIGNATURE_DOMAIN = 'peartube/multisigned-record-signature/v1'

function normalizeUnsigned (value) {
  if (!value || typeof value !== 'object') fail('envelope must be an object')
  const recordTypeBytes = utf8(value.recordType, 'recordType', RECORD_LIMITS.maxRecordTypeBytes)
  assertUint(value.schemaMajor, 'schemaMajor', 255); assertUint(value.schemaMinor, 'schemaMinor', 255)
  assertBytes(value.issuerIdentityKey, 32, 'issuerIdentityKey')
  assertUint(value.policyEpoch, 'policyEpoch'); assertUint(value.issuerSequence, 'issuerSequence'); assertUint(value.signedAt, 'signedAt')
  if (!(b4a.isBuffer(value.canonicalBody) || value.canonicalBody instanceof Uint8Array) || value.canonicalBody.byteLength > RECORD_LIMITS.maxBodyBytes) fail('canonicalBody exceeds its byte limit')
  if (value.bodyLength !== undefined && value.bodyLength !== value.canonicalBody.byteLength) fail('bodyLength does not match canonicalBody')
  return recordTypeBytes
}

export function encodeUnsignedMultiSignedEnvelope (value) {
  const recordTypeBytes = normalizeUnsigned(value)
  const length = 1 + fieldSize(recordTypeBytes) + varintLength(value.schemaMajor) + varintLength(value.schemaMinor) + 32 +
    varintLength(value.policyEpoch) + varintLength(value.issuerSequence) + varintLength(value.signedAt) +
    varintLength(value.canonicalBody.byteLength) + value.canonicalBody.byteLength
  if (length + 33 + RECORD_LIMITS.maxSignatures * 96 > RECORD_LIMITS.maxEnvelopeBytes) fail('envelope exceeds its byte limit')
  const out = b4a.allocUnsafe(length); let offset = 0
  out[offset++] = VARIANT; offset = writeField(out, offset, recordTypeBytes)
  offset = writeVarint(out, offset, value.schemaMajor); offset = writeVarint(out, offset, value.schemaMinor)
  out.set(value.issuerIdentityKey, offset); offset += 32
  offset = writeVarint(out, offset, value.policyEpoch); offset = writeVarint(out, offset, value.issuerSequence); offset = writeVarint(out, offset, value.signedAt)
  offset = writeVarint(out, offset, value.canonicalBody.byteLength); out.set(value.canonicalBody, offset)
  return out
}

function assertSignatures (signatures) {
  if (!Array.isArray(signatures) || signatures.length === 0 || signatures.length > RECORD_LIMITS.maxSignatures) fail('signatures count is out of bounds')
  let previous = null
  for (const entry of signatures) {
    assertBytes(entry?.signerKey, 32, 'signerKey'); assertBytes(entry?.signature, 64, 'signature')
    if (previous) {
      const order = compareBytes(previous, entry.signerKey)
      if (order === 0) fail('signature signers must be distinct')
      if (order > 0) fail('signature signers must be lexicographically ordered')
    }
    previous = entry.signerKey
  }
}

export function encodeMultiSignedEnvelope (value) {
  const unsigned = encodeUnsignedMultiSignedEnvelope(value)
  assertBytes(value.transitionId, 32, 'transitionId'); assertSignatures(value.signatures)
  const out = b4a.allocUnsafe(unsigned.byteLength + 32 + varintLength(value.signatures.length) + value.signatures.length * 96)
  out.set(unsigned); let offset = unsigned.byteLength; out.set(value.transitionId, offset); offset += 32
  offset = writeVarint(out, offset, value.signatures.length)
  for (const entry of value.signatures) { out.set(entry.signerKey, offset); offset += 32; out.set(entry.signature, offset); offset += 64 }
  return out
}
function readFixed (state, name, length) {
  if (state.offset + length > state.buffer.byteLength) fail(`truncated ${name}`)
  const value = state.buffer.subarray(state.offset, state.offset + length); state.offset += length; return value
}
function decodeUnsigned (state) {
  if (readVarint(state, 'variant', 255) !== VARIANT) fail('unknown envelope variant')
  const recordType = b4a.toString(readField(state, 'recordType', RECORD_LIMITS.maxRecordTypeBytes))
  const schemaMajor = readVarint(state, 'schemaMajor', 255)
  const schemaMinor = readVarint(state, 'schemaMinor', 255)
  const issuerIdentityKey = readFixed(state, 'issuerIdentityKey', 32)
  const policyEpoch = readVarint(state, 'policyEpoch')
  const issuerSequence = readVarint(state, 'issuerSequence')
  const signedAt = readVarint(state, 'signedAt')
  const canonicalBody = readField(state, 'canonicalBody', RECORD_LIMITS.maxBodyBytes)
  return { recordType, schemaMajor, schemaMinor, issuerIdentityKey, policyEpoch, issuerSequence, signedAt, bodyLength: canonicalBody.byteLength, canonicalBody }
}

export function decodeUnsignedMultiSignedEnvelope (input) {
  assertInput(input)
  const state = { buffer: input, offset: 0 }
  const value = decodeUnsigned(state)
  if (state.offset !== input.byteLength) fail('trailing bytes')
  if (!equalBytes(encodeUnsignedMultiSignedEnvelope(value), input)) fail('non-canonical envelope encoding')
  return value
}

export function decodeMultiSignedEnvelope (input) {
  assertInput(input)
  const state = { buffer: input, offset: 0 }
  const unsigned = decodeUnsigned(state)
  const transitionId = readFixed(state, 'transitionId', 32)
  const count = readVarint(state, 'signatures count', RECORD_LIMITS.maxSignatures)
  if (count === 0) fail('signatures count is out of bounds')
  if (state.offset + count * 96 > input.byteLength) fail('truncated signatures')
  const signatures = new Array(count)
  for (let i = 0; i < count; i++) signatures[i] = { signerKey: readFixed(state, 'signerKey', 32), signature: readFixed(state, 'signature', 64) }
  const value = { ...unsigned, transitionId, signatures }
  if (state.offset !== input.byteLength) fail('trailing bytes')
  assertSignatures(signatures)
  if (!equalBytes(encodeMultiSignedEnvelope(value), input)) fail('non-canonical envelope encoding')
  return value
}

export function multiSignedRecordSignaturePreimage (value) { return encodePreimage(SIGNATURE_DOMAIN, value.recordType, value.transitionId) }
export function prepareMultiSignedEnvelope (value, { hash } = {}) {
  if (typeof hash !== 'function') fail('hash function is required')
  const normalized = { ...value, bodyLength: value?.canonicalBody?.byteLength }
  const transitionId = hash(encodeUnsignedMultiSignedEnvelope(normalized)); assertBytes(transitionId, 32, 'hash output')
  return { ...normalized, transitionId }
}
export function attachMultiSignedEnvelopeSignatures (prepared, signatures) {
  assertBytes(prepared?.transitionId, 32, 'transitionId'); assertSignatures(signatures)
  return { ...prepared, signatures }
}
export function verifyMultiSignedEnvelope (value, { hash, verifySignature, authorization } = {}) {
  if (!authorization || typeof authorization !== 'object') fail('explicit authorization context is required')
  if (typeof hash !== 'function' || typeof verifySignature !== 'function') fail('crypto providers are required')
  const decoded = decodeMultiSignedEnvelope(encodeMultiSignedEnvelope(value))
  const candidate = hash(encodeUnsignedMultiSignedEnvelope(decoded)); assertBytes(candidate, 32, 'hash output')
  if (!equalBytes(candidate, decoded.transitionId)) fail('transitionId mismatch')
  if (!equalBytes(authorization.issuerIdentityKey, decoded.issuerIdentityKey)) fail('issuer authorization mismatch')
  if (authorization.policyEpoch !== decoded.policyEpoch) fail('policy epoch is stale')
  if (authorization.expectedSequence !== decoded.issuerSequence) fail('issuer sequence mismatch')
  const policy = authorization.signerPolicy
  if (!policy || !Array.isArray(policy.requiredSignerKeys) || !Array.isArray(policy.quorumSignerKeys)) fail('complete signer policy is required')
  assertUint(policy.quorum, 'signer policy quorum', RECORD_LIMITS.maxSignatures)
  if (policy.requiredSignerKeys.length + policy.quorumSignerKeys.length > RECORD_LIMITS.maxSignatures) fail('signer policy is out of bounds')
  const required = new Map()
  const quorum = new Map()
  for (const signerKey of policy.requiredSignerKeys) {
    assertBytes(signerKey, 32, 'required signerKey')
    const id = b4a.toString(signerKey, 'hex')
    if (required.has(id)) fail('required signer keys must be distinct')
    required.set(id, false)
  }
  for (const signerKey of policy.quorumSignerKeys) {
    assertBytes(signerKey, 32, 'quorum signerKey')
    const id = b4a.toString(signerKey, 'hex')
    if (required.has(id)) fail('required and quorum signer sets overlap')
    if (quorum.has(id)) fail('quorum signer keys must be distinct')
    quorum.set(id, false)
  }
  if (policy.quorum > quorum.size) fail('signer policy quorum is out of bounds')
  let quorumCount = 0
  for (const entry of decoded.signatures) {
    const id = b4a.toString(entry.signerKey, 'hex')
    if (required.has(id)) required.set(id, true)
    else if (quorum.has(id)) { quorum.set(id, true); quorumCount++ }
    else fail('extra signer is not authorized')
    if (verifySignature(entry.signature, multiSignedRecordSignaturePreimage(decoded), entry.signerKey) !== true) fail('signature verification failed')
  }
  for (const present of required.values()) if (!present) fail('required signer is missing')
  if (quorumCount !== policy.quorum) fail('exact signer quorum is not met')
  if (typeof authorization.claimReplay !== 'function' || authorization.claimReplay(decoded.transitionId, decoded) !== true) fail('transition replay rejected')
  return { valid: true, envelope: decoded }
}
