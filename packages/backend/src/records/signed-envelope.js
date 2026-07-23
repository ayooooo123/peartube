import b4a from 'b4a'
import c from 'compact-encoding'
import crypto from 'hypercore-crypto'

export const SIGNED_ENVELOPE_VERSION = 1
export const MAX_SIGNED_BODY_BYTES = 64 * 1024
export const MAX_RECORD_TYPE_BYTES = 128
export const RECORD_ID_DOMAIN = 'peartube.signed-envelope.record-id.v1'
export const SIGNATURE_DOMAIN = 'peartube.signed-envelope.signature.v1'

const RECORD_TYPE_RE = /^[a-z0-9][a-z0-9._:-]*$/i

export function toHex(value, name = 'buffer') {
  return b4a.toString(normalizeBuffer(value, name), 'hex')
}

export function normalizeBuffer(value, name = 'buffer') {
  if (b4a.isBuffer(value) || value instanceof Uint8Array) return b4a.from(value)
  if (typeof value === 'string') {
    if (!/^(?:[0-9a-f]{2})+$/i.test(value)) throw new Error(`${name} must be hex`)
    return b4a.from(value, 'hex')
  }
  throw new Error(`${name} must be a buffer or hex string`)
}

export function normalizeFixed(value, size, name) {
  const buf = normalizeBuffer(value, name)
  if (buf.byteLength !== size) throw new Error(`${name} must be ${size} bytes`)
  return buf
}

export function normalizePublicKey(value, name = 'signer') {
  return normalizeFixed(value, 32, name)
}

export function normalizeSignature(value, name = 'signature') {
  return normalizeFixed(value, 64, name)
}

export function normalizeRecordType(recordType) {
  if (typeof recordType !== 'string' || recordType.length === 0) {
    throw new Error('recordType is required')
  }
  const bytes = b4a.byteLength(recordType)
  if (bytes > MAX_RECORD_TYPE_BYTES) throw new Error('recordType exceeds maximum length')
  if (!RECORD_TYPE_RE.test(recordType)) throw new Error('recordType must be domain separated')
  return recordType
}

function normalizeTimestamp(value, name) {
  const next = value == null ? 0 : Number(value)
  if (!Number.isSafeInteger(next) || next < 0) throw new Error(`${name} must be a non-negative safe integer`)
  return next
}

function normalizeNonce(value) {
  if (value == null) return null
  return normalizeFixed(value, 32, 'nonce')
}

export function normalizeUnsignedRecord(input = {}, options = {}) {
  const body = normalizeBuffer(input.body ?? b4a.alloc(0), 'body')
  const maxBodyBytes = options.maxBodyBytes ?? MAX_SIGNED_BODY_BYTES
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0) throw new Error('maxBodyBytes must be a non-negative safe integer')
  if (body.byteLength > maxBodyBytes) throw new Error('body length exceeds maximum')

  const issuedAt = normalizeTimestamp(input.issuedAt, 'issuedAt')
  const expiresAt = normalizeTimestamp(input.expiresAt, 'expiresAt')
  if (expiresAt > 0 && issuedAt > 0 && expiresAt < issuedAt) throw new Error('expiresAt must be greater than issuedAt')

  return {
    version: SIGNED_ENVELOPE_VERSION,
    recordType: normalizeRecordType(input.recordType),
    issuedAt,
    expiresAt,
    nonce: normalizeNonce(input.nonce),
    body,
    bodyLength: body.byteLength,
  }
}

export function encodeUnsignedRecord(input = {}, options = {}) {
  const record = normalizeUnsignedRecord(input, options)
  return b4a.concat([
    c.encode(c.uint, record.version),
    c.encode(c.string, record.recordType),
    c.encode(c.uint, record.issuedAt),
    c.encode(c.uint, record.expiresAt),
    c.encode(c.bool, Boolean(record.nonce)),
    record.nonce ? c.encode(c.fixed32, record.nonce) : b4a.alloc(0),
    c.encode(c.uint, record.bodyLength),
    record.body,
  ])
}

export function decodeUnsignedRecordFromState(state, options = {}) {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_SIGNED_BODY_BYTES
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0) throw new Error('maxBodyBytes must be a non-negative safe integer')

  const version = c.uint.decode(state)
  if (version !== SIGNED_ENVELOPE_VERSION) throw new Error(`unsupported signed envelope version: ${version}`)
  const recordType = normalizeRecordType(c.string.decode(state))
  const issuedAt = normalizeTimestamp(c.uint.decode(state), 'issuedAt')
  const expiresAt = normalizeTimestamp(c.uint.decode(state), 'expiresAt')
  const hasNonce = c.bool.decode(state)
  const nonce = hasNonce ? c.fixed32.decode(state) : null
  const bodyLength = c.uint.decode(state)
  if (bodyLength > maxBodyBytes) throw new Error('body length exceeds maximum')
  if (state.end - state.start < bodyLength) throw new Error('body length exceeds available frame bytes')
  const body = state.buffer.subarray(state.start, state.start + bodyLength)
  state.start += bodyLength
  const unsigned = normalizeUnsignedRecord({ recordType, issuedAt, expiresAt, nonce, body }, { maxBodyBytes })
  return {
    ...unsigned,
    recordId: deriveRecordId(unsigned),
  }
}

export function decodeUnsignedRecord(buffer, options = {}) {
  const frame = normalizeBuffer(buffer, 'encoded unsigned record')
  const state = c.state(0, frame.byteLength, frame)
  const record = decodeUnsignedRecordFromState(state, options)
  if (state.start !== state.end) throw new Error('trailing bytes after unsigned record')
  return record
}

export function hashDomain(domain, payload) {
  return crypto.hash(b4a.concat([
    c.encode(c.string, domain),
    c.encode(c.uint, payload.byteLength),
    payload,
  ]))
}

export function deriveRecordId(input = {}, options = {}) {
  return hashDomain(RECORD_ID_DOMAIN, encodeUnsignedRecord(input, options))
}

export function deriveSigningDigest(recordId) {
  return hashDomain(SIGNATURE_DOMAIN, normalizeFixed(recordId, 32, 'recordId'))
}

export function createSignedEnvelope(input = {}) {
  const unsigned = normalizeUnsignedRecord(input)
  const keyPair = input.keyPair
  if (!keyPair?.publicKey || !keyPair?.secretKey) throw new Error('keyPair with publicKey and secretKey is required')
  const signer = normalizePublicKey(keyPair.publicKey, 'keyPair.publicKey')
  const recordId = deriveRecordId(unsigned)
  const signature = crypto.sign(deriveSigningDigest(recordId), keyPair.secretKey)
  return {
    ...unsigned,
    recordId,
    signer,
    signature,
  }
}

export function encodeSignedEnvelope(envelope, options = {}) {
  const unsigned = normalizeUnsignedRecord(envelope, options)
  const computedRecordId = deriveRecordId(unsigned, options)
  const recordId = envelope.recordId ? normalizeFixed(envelope.recordId, 32, 'recordId') : computedRecordId
  if (!b4a.equals(recordId, computedRecordId)) throw new Error('recordId mismatch')
  const signer = normalizePublicKey(envelope.signer, 'signer')
  const signature = normalizeSignature(envelope.signature, 'signature')
  return b4a.concat([
    encodeUnsignedRecord(unsigned, options),
    c.encode(c.fixed32, recordId),
    c.encode(c.fixed32, signer),
    c.encode(c.fixed64, signature),
  ])
}

export function decodeSignedEnvelope(buffer, options = {}) {
  const frame = normalizeBuffer(buffer, 'signed envelope')
  const state = c.state(0, frame.byteLength, frame)
  const unsigned = decodeUnsignedRecordFromState(state, options)
  const recordId = c.fixed32.decode(state)
  const signer = c.fixed32.decode(state)
  const signature = c.fixed64.decode(state)
  if (state.start !== state.end) throw new Error('trailing bytes after signed envelope')
  if (!b4a.equals(recordId, unsigned.recordId)) throw new Error('recordId mismatch')
  return {
    ...unsigned,
    recordId,
    signer,
    signature,
  }
}

export function hasAuthorizationContext(options = {}) {
  return Boolean(options.allowedSigners || options.authorizeSigner)
}

export function isSignerAuthorized(signer, options = {}) {
  if (!hasAuthorizationContext(options)) {
    throw new Error('explicit authorization context is required')
  }
  if (typeof options.authorizeSigner === 'function') {
    return Boolean(options.authorizeSigner(signer))
  }
  const signerHex = toHex(signer, 'signer')
  for (const allowed of options.allowedSigners || []) {
    if (toHex(allowed, 'allowed signer') === signerHex) return true
  }
  return false
}

function replayKey(envelope) {
  if (!envelope.nonce) return null
  return `${toHex(envelope.signer, 'signer')}:${toHex(envelope.nonce, 'nonce')}`
}

export async function verifySignedEnvelope(envelope, options = {}) {
  const normalized = {
    ...normalizeUnsignedRecord(envelope, options),
    recordId: normalizeFixed(envelope.recordId, 32, 'recordId'),
    signer: normalizePublicKey(envelope.signer, 'signer'),
    signature: normalizeSignature(envelope.signature, 'signature'),
  }

  if (options.recordType && normalized.recordType !== options.recordType) return false
  if (options.requireNonce && !normalized.nonce) return false
  if (!isSignerAuthorized(normalized.signer, options)) return false

  const now = options.now == null ? 0 : normalizeTimestamp(options.now, 'now')
  if (now > 0) {
    if (normalized.issuedAt > 0 && normalized.issuedAt > now) return false
    if (normalized.expiresAt > 0 && normalized.expiresAt < now) return false
  }

  const computedRecordId = deriveRecordId(normalized, options)
  if (!b4a.equals(computedRecordId, normalized.recordId)) return false
  const ok = crypto.verify(deriveSigningDigest(normalized.recordId), normalized.signature, normalized.signer)
  if (!ok) return false

  const key = replayKey(normalized)
  if (key && options.replayCache) {
    if (options.replayCache.has(key)) return false
    if (options.consumeNonce) options.replayCache.add(key)
  }

  return true
}
