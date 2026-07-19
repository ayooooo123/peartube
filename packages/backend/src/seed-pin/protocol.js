import b4a from 'b4a'
import c from 'compact-encoding'
import crypto from 'hypercore-crypto'
import IdentityKey from 'keet-identity-key'

import {
  CHANNEL_ROOT_DESCRIPTOR_SCHEMA,
  SIGNED_CHANNEL_ROOT_DESCRIPTOR_SCHEMA,
} from '../channel-descriptor.js'
import {
  DURABLE_MANIFEST_VERSION,
  MAX_DURABLE_MANIFEST_ROW_ID_BYTES,
} from './manifest.js'
import { SEED_PIN_REQUEST_VERSION } from './auth.js'
import {
  MAX_SEED_PIN_PROOF_BYTES,
  canonicalSeedPinProofBytes,
} from './proof.js'
export { MAX_SEED_PIN_PROOF_CHAIN } from './proof.js'

export const SEED_PIN_PROTOCOL = 'peartube/seed-pin/1'
export const SEED_PIN_PROTOCOL_VERSION = 1
export const MAX_SEED_PIN_FRAME_BYTES = 256 * 1024
export const MAX_SEED_PIN_REFS = 256
export const MAX_SEED_PIN_PROOF_HEX_BYTES = MAX_SEED_PIN_PROOF_BYTES * 2
export const MAX_SEED_PIN_ERROR_BYTES = 256

export const MAX_STATUS_EXPIRY_WINDOW_MS = 5 * 60 * 1000
const MAX_SCHEMA_BYTES = 128
const MAX_PROFILE_STRING_BYTES = 4 * 1024
const MAX_PROFILE_KEY_BYTES = 128
const MAX_PROFILE_ENTRIES = 64
const MAX_PROFILE_NODES = 256
const MAX_PROFILE_TOTAL_STRING_BYTES = 32 * 1024
const STATUS_AUTH_DOMAIN = b4a.from('peartube.seed-pin.status/v1\0')
const HEX_32_PATTERN = /^[0-9a-f]{64}$/
const HEX_PROOF_PATTERN = /^(?:[0-9a-f]{2})+$/
const REF_KINDS = Object.freeze(['media', 'thumbnail', 'artwork'])
const PIN_STATES = Object.freeze([
  'accepted',
  'pinning',
  'complete',
  'failed',
  'retryable',
  'cancelled',
  'released',
  'admitting',
  'retryable-admission',
  'rejected',
])
const REF_STATES = Object.freeze(['pending', 'pinning', 'complete', 'failed'])
const ARTWORK_ROLES = Object.freeze(['avatar', 'poster', 'banner', 'backdrop'])

export const SEED_PIN_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_AUTH: 'INVALID_AUTH',
  EXPIRED: 'EXPIRED',
  IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
  CHANNEL_MISMATCH: 'CHANNEL_MISMATCH',
  LIVE_PEER_MISMATCH: 'LIVE_PEER_MISMATCH',
  REPLAY_CONFLICT: 'REPLAY_CONFLICT',
  POLICY_REJECTED: 'POLICY_REJECTED',
  CAPACITY_EXCEEDED: 'CAPACITY_EXCEEDED',
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  INTERNAL: 'INTERNAL',
  BUSY: 'BUSY',
  WORKER_UNAVAILABLE: 'WORKER_UNAVAILABLE',
})

export const SEED_PIN_STATUS_STATES = PIN_STATES
export const SEED_PIN_REF_STATES = REF_STATES

const ERROR_CODE_SET = new Set(Object.values(SEED_PIN_ERROR_CODES))
const INVALID_WIRE = Symbol('invalid seed pin wire message')

export class SeedPinVerificationLimiter {
  constructor ({ maxConcurrent = 8 } = {}) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
      throw new RangeError('maxConcurrent must be a positive safe integer')
    }
    this.maxConcurrent = maxConcurrent
    this.active = 0
  }

  tryAcquire () {
    if (this.active >= this.maxConcurrent) return null
    this.active++
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
    }
  }
}

function isRecord (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertExactFields (value, fields, name) {
  if (!isRecord(value)) throw new TypeError(`${name} must be a plain object`)
  const allowed = new Set(fields)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError(`${name} contains unsupported field ${String(key)}`)
    }
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw new TypeError(`${name}.${field} is required`)
    }
  }
}

function assertSafeInteger (value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a safe integer between ${min} and ${max}`)
  }
  return value
}

function assertUtf8 (value, name, minBytes, maxBytes) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`)
  const bytes = b4a.from(value)
  if (bytes.byteLength < minBytes || bytes.byteLength > maxBytes) {
    throw new RangeError(`${name} must be between ${minBytes} and ${maxBytes} UTF-8 bytes`)
  }
  if (b4a.toString(bytes) !== value) throw new TypeError(`${name} must contain valid UTF-8`)
  return value
}

function assertHex32 (value, name) {
  if (typeof value !== 'string' || !HEX_32_PATTERN.test(value)) {
    throw new TypeError(`${name} must be canonical lowercase 32-byte hex`)
  }
  return value
}

function assertProofHex (value, name) {
  assertUtf8(value, name, 2, MAX_SEED_PIN_PROOF_HEX_BYTES)
  if (!HEX_PROOF_PATTERN.test(value)) {
    throw new TypeError(`${name} must be nonempty canonical lowercase hex`)
  }
  return value
}

function normalizeBytes32 (value, name) {
  if (!(value instanceof Uint8Array) && !b4a.isBuffer(value)) {
    throw new TypeError(`${name} must be a 32-byte Buffer or Uint8Array`)
  }
  if (value.byteLength !== 32) throw new TypeError(`${name} must be exactly 32 bytes`)
  return b4a.from(value)
}

function normalizeHex32 (value, name) {
  if (typeof value === 'string') return assertHex32(value, name)
  return b4a.toString(normalizeBytes32(value, name), 'hex')
}

function enumIndex (values, value, name) {
  const index = values.indexOf(value)
  if (index === -1) throw new TypeError(`${name} is unsupported`)
  return index
}

function enumCodec (values, name) {
  return {
    preencode (state, value) {
      c.uint.preencode(state, enumIndex(values, value, name))
    },
    encode (state, value) {
      c.uint.encode(state, enumIndex(values, value, name))
    },
    decode (state) {
      const index = c.uint.decode(state)
      if (!Number.isSafeInteger(index) || index < 0 || index >= values.length) {
        throw new TypeError(`${name} is unsupported`)
      }
      return values[index]
    },
  }
}

function safeUintCodec (name, options) {
  return {
    preencode (state, value) {
      c.uint.preencode(state, assertSafeInteger(value, name, options))
    },
    encode (state, value) {
      c.uint.encode(state, assertSafeInteger(value, name, options))
    },
    decode (state) {
      return assertSafeInteger(c.uint.decode(state), name, options)
    },
  }
}

function boundedStringCodec (name, minBytes, maxBytes, validator = null) {
  const validate = (value) => {
    assertUtf8(value, name, minBytes, maxBytes)
    if (validator) validator(value, name)
    return value
  }
  return {
    preencode (state, value) {
      c.string.preencode(state, validate(value))
    },
    encode (state, value) {
      c.string.encode(state, validate(value))
    },
    decode (state) {
      const length = c.uint.decode(state)
      if (!Number.isSafeInteger(length) || length < minBytes || length > maxBytes) {
        throw new RangeError(`${name} length is out of bounds`)
      }
      if (state.end - state.start < length) throw new Error('Out of bounds')
      const start = state.start
      state.start += length
      const value = b4a.toString(state.buffer, 'utf8', start, state.start)
      return validate(value)
    },
  }
}

function optionalCodec (encoding, name) {
  return {
    preencode (state, value) {
      if (value !== null) {
        if (value === undefined) throw new TypeError(`${name} must be null or a value`)
        c.bool.preencode(state, true)
        encoding.preencode(state, value)
      } else {
        c.bool.preencode(state, false)
      }
    },
    encode (state, value) {
      c.bool.encode(state, value !== null)
      if (value !== null) encoding.encode(state, value)
    },
    decode (state) {
      return c.bool.decode(state) ? encoding.decode(state) : null
    },
  }
}

const versionEncoding = safeUintCodec('version', { min: 1, max: SEED_PIN_PROTOCOL_VERSION })
const correlationEncoding = safeUintCodec('correlationId', { min: 1 })
const safeIntegerEncoding = safeUintCodec('integer')
const positiveIntegerEncoding = safeUintCodec('positive integer', { min: 1 })
const hex32Encoding = boundedStringCodec('hex key', 64, 64, assertHex32)
const rowIdEncoding = boundedStringCodec('rowId', 1, MAX_DURABLE_MANIFEST_ROW_ID_BYTES)
const schemaEncoding = boundedStringCodec('schema', 1, MAX_SCHEMA_BYTES)
const proofEncoding = boundedStringCodec('proof', 2, MAX_SEED_PIN_PROOF_HEX_BYTES, assertProofHex)
const errorEncoding = boundedStringCodec('error', 1, MAX_SEED_PIN_ERROR_BYTES)
const refKindEncoding = enumCodec(REF_KINDS, 'ref kind')
const pinStateEncoding = enumCodec(PIN_STATES, 'pin state')
const refStateEncoding = enumCodec(REF_STATES, 'ref state')
const errorCodeEncoding = enumCodec(Object.values(SEED_PIN_ERROR_CODES), 'error code')
const optionalSafeIntegerEncoding = optionalCodec(safeIntegerEncoding, 'optional integer')
const optionalErrorCodeEncoding = optionalCodec(errorCodeEncoding, 'optional error code')
const optionalErrorEncoding = optionalCodec(errorEncoding, 'optional error')

function createStructuredBudget () {
  return { nodes: 0, stringBytes: 0 }
}

function countStructuredNode (budget) {
  if (++budget.nodes > MAX_PROFILE_NODES) throw new RangeError('structured value has too many nodes')
}

function checkStructuredString (value, name, maxBytes, budget) {
  assertUtf8(value, name, 0, maxBytes)
  budget.stringBytes += b4a.byteLength(value)
  if (budget.stringBytes > MAX_PROFILE_TOTAL_STRING_BYTES) {
    throw new RangeError('structured value strings are too large')
  }
}

function preencodeStructured (state, value, budget, depth = 0) {
  if (depth > 8) throw new RangeError('structured value is too deep')
  countStructuredNode(budget)
  if (value === null) return c.uint.preencode(state, 0)
  if (value === false) return c.uint.preencode(state, 1)
  if (value === true) return c.uint.preencode(state, 2)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('structured number must be finite')
    c.uint.preencode(state, 3)
    return c.float64.preencode(state, value)
  }
  if (typeof value === 'string') {
    checkStructuredString(value, 'structured string', MAX_PROFILE_STRING_BYTES, budget)
    c.uint.preencode(state, 4)
    return c.string.preencode(state, value)
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_PROFILE_ENTRIES) throw new RangeError('structured array has too many entries')
    c.uint.preencode(state, 5)
    c.uint.preencode(state, value.length)
    for (const entry of value) preencodeStructured(state, entry, budget, depth + 1)
    return
  }
  if (!isRecord(value)) throw new TypeError('structured value must contain plain JSON values')
  const keys = Object.keys(value).sort()
  if (keys.length > MAX_PROFILE_ENTRIES) throw new RangeError('structured object has too many entries')
  if (Reflect.ownKeys(value).length !== keys.length) throw new TypeError('structured object has unsupported keys')
  c.uint.preencode(state, 6)
  c.uint.preencode(state, keys.length)
  for (const key of keys) {
    if (value[key] === undefined) throw new TypeError('structured object cannot contain undefined')
    checkStructuredString(key, 'structured key', MAX_PROFILE_KEY_BYTES, budget)
    c.string.preencode(state, key)
    preencodeStructured(state, value[key], budget, depth + 1)
  }
}

function encodeStructured (state, value, depth = 0) {
  if (value === null) return c.uint.encode(state, 0)
  if (value === false) return c.uint.encode(state, 1)
  if (value === true) return c.uint.encode(state, 2)
  if (typeof value === 'number') {
    c.uint.encode(state, 3)
    return c.float64.encode(state, value === 0 ? 0 : value)
  }
  if (typeof value === 'string') {
    c.uint.encode(state, 4)
    return c.string.encode(state, value)
  }
  if (Array.isArray(value)) {
    c.uint.encode(state, 5)
    c.uint.encode(state, value.length)
    for (const entry of value) encodeStructured(state, entry, depth + 1)
    return
  }
  const keys = Object.keys(value).sort()
  c.uint.encode(state, 6)
  c.uint.encode(state, keys.length)
  for (const key of keys) {
    c.string.encode(state, key)
    encodeStructured(state, value[key], depth + 1)
  }
}

function decodeStructuredString (state, name, maxBytes, budget) {
  const value = boundedStringCodec(name, 0, maxBytes).decode(state)
  budget.stringBytes += b4a.byteLength(value)
  if (budget.stringBytes > MAX_PROFILE_TOTAL_STRING_BYTES) {
    throw new RangeError('structured value strings are too large')
  }
  return value
}

function decodeStructured (state, budget, depth = 0) {
  if (depth > 8) throw new RangeError('structured value is too deep')
  countStructuredNode(budget)
  const type = c.uint.decode(state)
  if (type === 0) return null
  if (type === 1) return false
  if (type === 2) return true
  if (type === 3) {
    const value = c.float64.decode(state)
    if (!Number.isFinite(value)) throw new TypeError('structured number must be finite')
    return value === 0 ? 0 : value
  }
  if (type === 4) return decodeStructuredString(state, 'structured string', MAX_PROFILE_STRING_BYTES, budget)
  if (type === 5) {
    const count = c.uint.decode(state)
    assertSafeInteger(count, 'structured array count', { max: MAX_PROFILE_ENTRIES })
    const value = new Array(count)
    for (let index = 0; index < count; index++) value[index] = decodeStructured(state, budget, depth + 1)
    return value
  }
  if (type === 6) {
    const count = c.uint.decode(state)
    assertSafeInteger(count, 'structured object count', { max: MAX_PROFILE_ENTRIES })
    const value = {}
    let previous = null
    for (let index = 0; index < count; index++) {
      const key = decodeStructuredString(state, 'structured key', MAX_PROFILE_KEY_BYTES, budget)
      if (previous !== null && key <= previous) throw new TypeError('structured object keys are not canonical')
      previous = key
      value[key] = decodeStructured(state, budget, depth + 1)
    }
    return value
  }
  throw new TypeError('structured value type is unsupported')
}

const structuredEncoding = {
  preencode (state, value) {
    preencodeStructured(state, value, createStructuredBudget())
  },
  encode (state, value) {
    encodeStructured(state, value)
  },
  decode (state) {
    return decodeStructured(state, createStructuredBudget())
  },
}

const durabilityRefEncoding = {
  preencode (state, value) {
    assertExactFields(value, ['coreKey', 'start', 'end', 'kind'], 'durability ref')
    hex32Encoding.preencode(state, value.coreKey)
    safeIntegerEncoding.preencode(state, value.start)
    positiveIntegerEncoding.preencode(state, value.end)
    if (value.end <= value.start) throw new RangeError('durability ref end must be greater than start')
    refKindEncoding.preencode(state, value.kind)
  },
  encode (state, value) {
    hex32Encoding.encode(state, value.coreKey)
    safeIntegerEncoding.encode(state, value.start)
    positiveIntegerEncoding.encode(state, value.end)
    refKindEncoding.encode(state, value.kind)
  },
  decode (state) {
    const coreKey = hex32Encoding.decode(state)
    const start = safeIntegerEncoding.decode(state)
    const end = positiveIntegerEncoding.decode(state)
    if (end <= start) throw new RangeError('durability ref end must be greater than start')
    return { coreKey, start, end, kind: refKindEncoding.decode(state) }
  },
}

function preencodeRefArray (state, refs) {
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > MAX_SEED_PIN_REFS) {
    throw new RangeError(`refs must contain between 1 and ${MAX_SEED_PIN_REFS} entries`)
  }
  c.uint.preencode(state, refs.length)
  for (const ref of refs) durabilityRefEncoding.preencode(state, ref)
}

function encodeRefArray (state, refs) {
  c.uint.encode(state, refs.length)
  for (const ref of refs) durabilityRefEncoding.encode(state, ref)
}

function decodeRefArray (state) {
  const count = c.uint.decode(state)
  assertSafeInteger(count, 'ref count', { min: 1, max: MAX_SEED_PIN_REFS })
  const refs = new Array(count)
  for (let index = 0; index < count; index++) refs[index] = durabilityRefEncoding.decode(state)
  return refs
}

function assertOptionalIndex (value, name, refCount) {
  if (value === null) return
  assertSafeInteger(value, name, { max: refCount - 1 })
}

function preencodeAssets (state, assets, refCount) {
  assertExactFields(assets, ['media', 'thumbnail', 'artwork'], 'manifest.assets')
  assertExactFields(assets.artwork, ARTWORK_ROLES, 'manifest.assets.artwork')
  if (!Array.isArray(assets.media) || assets.media.length === 0 || assets.media.length > refCount) {
    throw new RangeError('manifest.assets.media count is out of bounds')
  }
  c.uint.preencode(state, assets.media.length)
  for (const index of assets.media) safeUintCodec('media ref index', { max: refCount - 1 }).preencode(state, index)
  assertOptionalIndex(assets.thumbnail, 'thumbnail ref index', refCount)
  optionalSafeIntegerEncoding.preencode(state, assets.thumbnail)
  for (const role of ARTWORK_ROLES) {
    assertOptionalIndex(assets.artwork[role], `${role} ref index`, refCount)
    optionalSafeIntegerEncoding.preencode(state, assets.artwork[role])
  }
}

function encodeAssets (state, assets) {
  c.uint.encode(state, assets.media.length)
  for (const index of assets.media) c.uint.encode(state, index)
  optionalSafeIntegerEncoding.encode(state, assets.thumbnail)
  for (const role of ARTWORK_ROLES) optionalSafeIntegerEncoding.encode(state, assets.artwork[role])
}

function decodeAssets (state, refCount) {
  const mediaCount = c.uint.decode(state)
  assertSafeInteger(mediaCount, 'media ref count', { min: 1, max: refCount })
  const media = new Array(mediaCount)
  for (let index = 0; index < mediaCount; index++) {
    media[index] = assertSafeInteger(c.uint.decode(state), 'media ref index', { max: refCount - 1 })
  }
  const thumbnail = optionalSafeIntegerEncoding.decode(state)
  assertOptionalIndex(thumbnail, 'thumbnail ref index', refCount)
  const artwork = {}
  for (const role of ARTWORK_ROLES) {
    artwork[role] = optionalSafeIntegerEncoding.decode(state)
    assertOptionalIndex(artwork[role], `${role} ref index`, refCount)
  }
  return { media, thumbnail, artwork }
}

const manifestEncoding = {
  preencode (state, value) {
    assertExactFields(value, ['version', 'channelKey', 'rowId', 'refs', 'assets', 'requestId'], 'manifest')
    if (value.version !== DURABLE_MANIFEST_VERSION) throw new TypeError('unsupported manifest version')
    versionEncoding.preencode(state, value.version)
    hex32Encoding.preencode(state, value.channelKey)
    rowIdEncoding.preencode(state, value.rowId)
    preencodeRefArray(state, value.refs)
    preencodeAssets(state, value.assets, value.refs.length)
    hex32Encoding.preencode(state, value.requestId)
  },
  encode (state, value) {
    versionEncoding.encode(state, value.version)
    hex32Encoding.encode(state, value.channelKey)
    rowIdEncoding.encode(state, value.rowId)
    encodeRefArray(state, value.refs)
    encodeAssets(state, value.assets)
    hex32Encoding.encode(state, value.requestId)
  },
  decode (state) {
    const version = versionEncoding.decode(state)
    const channelKey = hex32Encoding.decode(state)
    const rowId = rowIdEncoding.decode(state)
    const refs = decodeRefArray(state)
    const assets = decodeAssets(state, refs.length)
    const requestId = hex32Encoding.decode(state)
    return { version, channelKey, rowId, refs, assets, requestId }
  },
}

const descriptorEncoding = {
  preencode (state, value) {
    assertExactFields(value, [
      'schema', 'channelId', 'identityPublicKey', 'metadataKey', 'mediaKey',
      'seq', 'createdAt', 'updatedAt', 'profile', 'capabilities',
    ], 'channel descriptor')
    if (value.schema !== CHANNEL_ROOT_DESCRIPTOR_SCHEMA) throw new TypeError('unsupported channel descriptor schema')
    schemaEncoding.preencode(state, value.schema)
    hex32Encoding.preencode(state, value.channelId)
    hex32Encoding.preencode(state, value.identityPublicKey)
    hex32Encoding.preencode(state, value.metadataKey)
    hex32Encoding.preencode(state, value.mediaKey)
    safeIntegerEncoding.preencode(state, value.seq)
    safeIntegerEncoding.preencode(state, value.createdAt)
    safeIntegerEncoding.preencode(state, value.updatedAt)
    structuredEncoding.preencode(state, value.profile)
    structuredEncoding.preencode(state, value.capabilities)
  },
  encode (state, value) {
    schemaEncoding.encode(state, value.schema)
    hex32Encoding.encode(state, value.channelId)
    hex32Encoding.encode(state, value.identityPublicKey)
    hex32Encoding.encode(state, value.metadataKey)
    hex32Encoding.encode(state, value.mediaKey)
    safeIntegerEncoding.encode(state, value.seq)
    safeIntegerEncoding.encode(state, value.createdAt)
    safeIntegerEncoding.encode(state, value.updatedAt)
    structuredEncoding.encode(state, value.profile)
    structuredEncoding.encode(state, value.capabilities)
  },
  decode (state) {
    const value = {
      schema: schemaEncoding.decode(state),
      channelId: hex32Encoding.decode(state),
      identityPublicKey: hex32Encoding.decode(state),
      metadataKey: hex32Encoding.decode(state),
      mediaKey: hex32Encoding.decode(state),
      seq: safeIntegerEncoding.decode(state),
      createdAt: safeIntegerEncoding.decode(state),
      updatedAt: safeIntegerEncoding.decode(state),
      profile: structuredEncoding.decode(state),
      capabilities: structuredEncoding.decode(state),
    }
    if (value.schema !== CHANNEL_ROOT_DESCRIPTOR_SCHEMA) throw new TypeError('unsupported channel descriptor schema')
    return value
  },
}

const signedDescriptorEncoding = {
  preencode (state, value) {
    assertExactFields(value, ['schema', 'descriptor', 'proof', 'attestation'], 'signed descriptor')
    if (value.schema !== SIGNED_CHANNEL_ROOT_DESCRIPTOR_SCHEMA) throw new TypeError('unsupported signed descriptor schema')
    schemaEncoding.preencode(state, value.schema)
    descriptorEncoding.preencode(state, value.descriptor)
    proofEncoding.preencode(state, value.proof)
    proofEncoding.preencode(state, value.attestation)
  },
  encode (state, value) {
    schemaEncoding.encode(state, value.schema)
    descriptorEncoding.encode(state, value.descriptor)
    proofEncoding.encode(state, value.proof)
    proofEncoding.encode(state, value.attestation)
  },
  decode (state) {
    const value = {
      schema: schemaEncoding.decode(state),
      descriptor: descriptorEncoding.decode(state),
      proof: proofEncoding.decode(state),
      attestation: proofEncoding.decode(state),
    }
    if (value.schema !== SIGNED_CHANNEL_ROOT_DESCRIPTOR_SCHEMA) throw new TypeError('unsupported signed descriptor schema')
    return value
  },
}

const seedPinRequestEncoding = {
  preencode (state, value) {
    assertExactFields(value, ['version', 'manifest', 'requestId', 'expiresAt', 'signedDescriptor', 'attestation'], 'seed pin request')
    if (value.version !== SEED_PIN_REQUEST_VERSION) throw new TypeError('unsupported seed pin request version')
    versionEncoding.preencode(state, value.version)
    manifestEncoding.preencode(state, value.manifest)
    hex32Encoding.preencode(state, value.requestId)
    positiveIntegerEncoding.preencode(state, value.expiresAt)
    signedDescriptorEncoding.preencode(state, value.signedDescriptor)
    proofEncoding.preencode(state, value.attestation)
  },
  encode (state, value) {
    versionEncoding.encode(state, value.version)
    manifestEncoding.encode(state, value.manifest)
    hex32Encoding.encode(state, value.requestId)
    positiveIntegerEncoding.encode(state, value.expiresAt)
    signedDescriptorEncoding.encode(state, value.signedDescriptor)
    proofEncoding.encode(state, value.attestation)
  },
  decode (state) {
    return {
      version: versionEncoding.decode(state),
      manifest: manifestEncoding.decode(state),
      requestId: hex32Encoding.decode(state),
      expiresAt: positiveIntegerEncoding.decode(state),
      signedDescriptor: signedDescriptorEncoding.decode(state),
      attestation: proofEncoding.decode(state),
    }
  },
}

const statusAuthorizationEncoding = {
  preencode (state, value) {
    assertExactFields(value, [
      'version', 'requestId', 'identityPublicKey', 'devicePublicKey',
      'expiresAt', 'deviceProof', 'attestation',
    ], 'status authorization')
    versionEncoding.preencode(state, value.version)
    hex32Encoding.preencode(state, value.requestId)
    hex32Encoding.preencode(state, value.identityPublicKey)
    hex32Encoding.preencode(state, value.devicePublicKey)
    positiveIntegerEncoding.preencode(state, value.expiresAt)
    proofEncoding.preencode(state, value.deviceProof)
    proofEncoding.preencode(state, value.attestation)
  },
  encode (state, value) {
    versionEncoding.encode(state, value.version)
    hex32Encoding.encode(state, value.requestId)
    hex32Encoding.encode(state, value.identityPublicKey)
    hex32Encoding.encode(state, value.devicePublicKey)
    positiveIntegerEncoding.encode(state, value.expiresAt)
    proofEncoding.encode(state, value.deviceProof)
    proofEncoding.encode(state, value.attestation)
  },
  decode (state) {
    return {
      version: versionEncoding.decode(state),
      requestId: hex32Encoding.decode(state),
      identityPublicKey: hex32Encoding.decode(state),
      devicePublicKey: hex32Encoding.decode(state),
      expiresAt: positiveIntegerEncoding.decode(state),
      deviceProof: proofEncoding.decode(state),
      attestation: proofEncoding.decode(state),
    }
  },
}

const statusRefEncoding = {
  preencode (state, value) {
    assertExactFields(value, ['coreKey', 'start', 'end', 'kind', 'state', 'bytesPinned'], 'status ref')
    durabilityRefEncoding.preencode(state, {
      coreKey: value.coreKey,
      start: value.start,
      end: value.end,
      kind: value.kind,
    })
    refStateEncoding.preencode(state, value.state)
    safeIntegerEncoding.preencode(state, value.bytesPinned)
  },
  encode (state, value) {
    durabilityRefEncoding.encode(state, value)
    refStateEncoding.encode(state, value.state)
    safeIntegerEncoding.encode(state, value.bytesPinned)
  },
  decode (state) {
    return {
      ...durabilityRefEncoding.decode(state),
      state: refStateEncoding.decode(state),
      bytesPinned: safeIntegerEncoding.decode(state),
    }
  },
}

const pinStatusEncoding = {
  preencode (state, value) {
    assertExactFields(value, [
      'requestId', 'state', 'acceptedAt', 'updatedAt', 'completedAt',
      'errorCode', 'error', 'refs',
    ], 'pin status')
    hex32Encoding.preencode(state, value.requestId)
    pinStateEncoding.preencode(state, value.state)
    safeIntegerEncoding.preencode(state, value.acceptedAt)
    safeIntegerEncoding.preencode(state, value.updatedAt)
    optionalSafeIntegerEncoding.preencode(state, value.completedAt)
    optionalErrorCodeEncoding.preencode(state, value.errorCode)
    optionalErrorEncoding.preencode(state, value.error)
    if (!Array.isArray(value.refs) || value.refs.length > MAX_SEED_PIN_REFS) {
      throw new RangeError('status refs are out of bounds')
    }
    c.uint.preencode(state, value.refs.length)
    for (const ref of value.refs) statusRefEncoding.preencode(state, ref)
  },
  encode (state, value) {
    hex32Encoding.encode(state, value.requestId)
    pinStateEncoding.encode(state, value.state)
    safeIntegerEncoding.encode(state, value.acceptedAt)
    safeIntegerEncoding.encode(state, value.updatedAt)
    optionalSafeIntegerEncoding.encode(state, value.completedAt)
    optionalErrorCodeEncoding.encode(state, value.errorCode)
    optionalErrorEncoding.encode(state, value.error)
    c.uint.encode(state, value.refs.length)
    for (const ref of value.refs) statusRefEncoding.encode(state, ref)
  },
  decode (state) {
    const value = {
      requestId: hex32Encoding.decode(state),
      state: pinStateEncoding.decode(state),
      acceptedAt: safeIntegerEncoding.decode(state),
      updatedAt: safeIntegerEncoding.decode(state),
      completedAt: optionalSafeIntegerEncoding.decode(state),
      errorCode: optionalErrorCodeEncoding.decode(state),
      error: optionalErrorEncoding.decode(state),
      refs: null,
    }
    const count = c.uint.decode(state)
    assertSafeInteger(count, 'status ref count', { max: MAX_SEED_PIN_REFS })
    value.refs = new Array(count)
    for (let index = 0; index < count; index++) value.refs[index] = statusRefEncoding.decode(state)
    return value
  },
}

function requestMessageEncoding (requestEncoding, name) {
  return {
    preencode (state, value) {
      assertExactFields(value, ['version', 'correlationId', 'requestId', 'request'], name)
      versionEncoding.preencode(state, value.version)
      correlationEncoding.preencode(state, value.correlationId)
      hex32Encoding.preencode(state, value.requestId)
      requestEncoding.preencode(state, value.request)
    },
    encode (state, value) {
      versionEncoding.encode(state, value.version)
      correlationEncoding.encode(state, value.correlationId)
      hex32Encoding.encode(state, value.requestId)
      requestEncoding.encode(state, value.request)
    },
    decode (state) {
      return {
        version: versionEncoding.decode(state),
        correlationId: correlationEncoding.decode(state),
        requestId: hex32Encoding.decode(state),
        request: requestEncoding.decode(state),
      }
    },
  }
}

function responseMessageEncoding (name) {
  return {
    preencode (state, value) {
      assertExactFields(value, ['version', 'correlationId', 'requestId', 'ok', 'code', 'error', 'status'], name)
      versionEncoding.preencode(state, value.version)
      correlationEncoding.preencode(state, value.correlationId)
      hex32Encoding.preencode(state, value.requestId)
      c.bool.preencode(state, value.ok)
      optionalErrorCodeEncoding.preencode(state, value.code)
      optionalErrorEncoding.preencode(state, value.error)
      optionalCodec(pinStatusEncoding, 'optional status').preencode(state, value.status)
    },
    encode (state, value) {
      versionEncoding.encode(state, value.version)
      correlationEncoding.encode(state, value.correlationId)
      hex32Encoding.encode(state, value.requestId)
      c.bool.encode(state, value.ok)
      optionalErrorCodeEncoding.encode(state, value.code)
      optionalErrorEncoding.encode(state, value.error)
      optionalCodec(pinStatusEncoding, 'optional status').encode(state, value.status)
    },
    decode (state) {
      return {
        version: versionEncoding.decode(state),
        correlationId: correlationEncoding.decode(state),
        requestId: hex32Encoding.decode(state),
        ok: c.bool.decode(state),
        code: optionalErrorCodeEncoding.decode(state),
        error: optionalErrorEncoding.decode(state),
        status: optionalCodec(pinStatusEncoding, 'optional status').decode(state),
      }
    },
  }
}

function safeWireEncoding (inner, name) {
  return Object.freeze({
    preencode (state, value) {
      const before = state.end
      inner.preencode(state, value)
      if (state.end - before > MAX_SEED_PIN_FRAME_BYTES) {
        throw new RangeError(`${name} exceeds maximum frame size`)
      }
    },
    encode (state, value) {
      inner.encode(state, value)
    },
    decode (state) {
      const start = state.start
      const end = state.end
      if (end - start > MAX_SEED_PIN_FRAME_BYTES) {
        state.start = end
        return { [INVALID_WIRE]: true, name }
      }
      try {
        const value = inner.decode(state)
        if (state.start !== end) throw new TypeError(`${name} has trailing bytes`)
        const canonical = c.encode(inner, value)
        if (!b4a.equals(canonical, state.buffer.subarray(start, end))) {
          throw new TypeError(`${name} is not canonical`)
        }
        return value
      } catch {
        state.start = end
        return { [INVALID_WIRE]: true, name }
      }
    },
  })
}

export const PIN_REQUEST_ENCODING = safeWireEncoding(
  requestMessageEncoding(seedPinRequestEncoding, 'pin request message'),
  'pin request message',
)
export const PIN_RESPONSE_ENCODING = safeWireEncoding(
  responseMessageEncoding('pin response message'),
  'pin response message',
)
export const STATUS_REQUEST_ENCODING = safeWireEncoding(
  requestMessageEncoding(statusAuthorizationEncoding, 'status request message'),
  'status request message',
)
export const STATUS_RESPONSE_ENCODING = safeWireEncoding(
  responseMessageEncoding('status response message'),
  'status response message',
)

export function isInvalidSeedPinWireMessage (value) {
  return Boolean(value?.[INVALID_WIRE])
}

export function seedPinAuthorizationDigest (request) {
  return b4a.toString(crypto.data(c.encode(seedPinRequestEncoding, request)), 'hex')
}

function encodeUint64 (value) {
  assertSafeInteger(value, 'expiresAt', { min: 1 })
  const output = b4a.alloc(8)
  const high = Math.floor(value / 0x100000000)
  const low = value - high * 0x100000000
  output[0] = high >>> 24
  output[1] = high >>> 16
  output[2] = high >>> 8
  output[3] = high
  output[4] = low >>> 24
  output[5] = low >>> 16
  output[6] = low >>> 8
  output[7] = low
  return output
}

function encodeStatusAuthorizationPayload ({ requestId, identityPublicKey, devicePublicKey, expiresAt }) {
  return b4a.concat([
    STATUS_AUTH_DOMAIN,
    b4a.from(assertHex32(requestId, 'requestId'), 'hex'),
    b4a.from(assertHex32(identityPublicKey, 'identityPublicKey'), 'hex'),
    b4a.from(assertHex32(devicePublicKey, 'devicePublicKey'), 'hex'),
    encodeUint64(expiresAt),
  ])
}

function canonicalProofBytes (value, name) {
  let bytes
  if (typeof value === 'string') bytes = b4a.from(assertProofHex(value, name), 'hex')
  else if (value instanceof Uint8Array || b4a.isBuffer(value)) bytes = b4a.from(value)
  else throw new TypeError(`${name} must be proof bytes or lowercase hex`)
  return canonicalSeedPinProofBytes(bytes, name)
}

function matchingReceipt (left, right) {
  if (!left?.receipt || !right?.receipt) return false
  return b4a.equals(left.receipt, right.receipt)
}

export function createSeedPinStatusRequest ({
  requestId,
  expiresAt,
  identityPublicKey,
  deviceKeyPair,
  deviceProof,
}) {
  const normalizedRequestId = assertHex32(requestId, 'requestId')
  const normalizedExpiresAt = assertSafeInteger(expiresAt, 'expiresAt', { min: 1 })
  const identityHex = normalizeHex32(identityPublicKey, 'identityPublicKey')
  const devicePublicKey = normalizeBytes32(deviceKeyPair?.publicKey, 'deviceKeyPair.publicKey')
  if (!(deviceKeyPair?.secretKey instanceof Uint8Array) && !b4a.isBuffer(deviceKeyPair?.secretKey)) {
    throw new TypeError('deviceKeyPair.secretKey must be exactly 64 bytes')
  }
  if (deviceKeyPair.secretKey.byteLength !== 64) {
    throw new TypeError('deviceKeyPair.secretKey must be exactly 64 bytes')
  }
  const deviceHex = b4a.toString(devicePublicKey, 'hex')
  const proof = canonicalProofBytes(deviceProof, 'deviceProof')
  const proofVerification = IdentityKey.verify(proof, null, {
    expectedIdentity: b4a.from(identityHex, 'hex'),
    expectedDevice: devicePublicKey,
  })
  if (!proofVerification) throw new Error('device proof verification failed')
  const payload = encodeStatusAuthorizationPayload({
    requestId: normalizedRequestId,
    identityPublicKey: identityHex,
    devicePublicKey: deviceHex,
    expiresAt: normalizedExpiresAt,
  })
  const attestation = IdentityKey.attestData(payload, {
    publicKey: devicePublicKey,
    secretKey: deviceKeyPair.secretKey,
  }, proof)
  const selfVerification = IdentityKey.verify(attestation, payload, {
    expectedIdentity: b4a.from(identityHex, 'hex'),
    expectedDevice: devicePublicKey,
  })
  if (!selfVerification || !matchingReceipt(selfVerification, proofVerification)) {
    throw new Error('device key pair produced an invalid status attestation')
  }
  return Object.freeze({
    version: SEED_PIN_PROTOCOL_VERSION,
    requestId: normalizedRequestId,
    identityPublicKey: identityHex,
    devicePublicKey: deviceHex,
    expiresAt: normalizedExpiresAt,
    deviceProof: b4a.toString(proof, 'hex'),
    attestation: b4a.toString(canonicalProofBytes(attestation, 'attestation'), 'hex'),
  })
}

export function verifySeedPinStatusRequest (request, { remotePublicKey, now }) {
  try {
    const remote = normalizeBytes32(remotePublicKey, 'remotePublicKey')
    assertSafeInteger(now, 'now')
    assertExactFields(request, [
      'version', 'requestId', 'identityPublicKey', 'devicePublicKey',
      'expiresAt', 'deviceProof', 'attestation',
    ], 'status request')
    if (request.version !== SEED_PIN_PROTOCOL_VERSION) throw new TypeError('unsupported status request version')
    const requestId = assertHex32(request.requestId, 'requestId')
    const identityPublicKey = assertHex32(request.identityPublicKey, 'identityPublicKey')
    const devicePublicKey = assertHex32(request.devicePublicKey, 'devicePublicKey')
    const expiresAt = assertSafeInteger(request.expiresAt, 'expiresAt', { min: 1 })
    if (expiresAt <= now) throw new Error('status request has expired')
    if (expiresAt - now > MAX_STATUS_EXPIRY_WINDOW_MS) {
      throw new Error('status request expiry is too far in the future')
    }
    if (!b4a.equals(remote, b4a.from(devicePublicKey, 'hex'))) {
      throw new Error('status requester device does not match live remote key')
    }
    const proof = canonicalProofBytes(request.deviceProof, 'deviceProof')
    const proofVerification = IdentityKey.verify(proof, null, {
      expectedIdentity: b4a.from(identityPublicKey, 'hex'),
      expectedDevice: remote,
    })
    if (!proofVerification) throw new Error('status device proof verification failed')
    const payload = encodeStatusAuthorizationPayload({
      requestId,
      identityPublicKey,
      devicePublicKey,
      expiresAt,
    })
    const attestation = canonicalProofBytes(request.attestation, 'attestation')
    const verification = IdentityKey.verify(attestation, payload, {
      expectedIdentity: b4a.from(identityPublicKey, 'hex'),
      expectedDevice: remote,
    })
    if (!verification || !matchingReceipt(verification, proofVerification)) {
      throw new Error('status attestation verification failed')
    }
    return Object.freeze({
      valid: true,
      version: SEED_PIN_PROTOCOL_VERSION,
      requestId,
      expiresAt,
      identityPublicKey,
      devicePublicKey,
    })
  } catch (error) {
    return Object.freeze({ valid: false, error: error?.message || String(error) })
  }
}

export function seedPinSuccessResponse (correlationId, requestId, status) {
  return {
    version: SEED_PIN_PROTOCOL_VERSION,
    correlationId,
    requestId,
    ok: true,
    code: null,
    error: null,
    status,
  }
}

const STABLE_ERROR_MESSAGES = Object.freeze({
  [SEED_PIN_ERROR_CODES.INVALID_REQUEST]: 'Invalid seed pin request',
  [SEED_PIN_ERROR_CODES.INVALID_AUTH]: 'Seed pin authorization failed',
  [SEED_PIN_ERROR_CODES.EXPIRED]: 'Seed pin authorization expired',
  [SEED_PIN_ERROR_CODES.IDENTITY_MISMATCH]: 'Seed pin identity mismatch',
  [SEED_PIN_ERROR_CODES.CHANNEL_MISMATCH]: 'Seed pin channel mismatch',
  [SEED_PIN_ERROR_CODES.LIVE_PEER_MISMATCH]: 'Seed pin live peer mismatch',
  [SEED_PIN_ERROR_CODES.REPLAY_CONFLICT]: 'Seed pin request conflicts with an existing request',
  [SEED_PIN_ERROR_CODES.POLICY_REJECTED]: 'Seed pin request rejected by policy',
  [SEED_PIN_ERROR_CODES.CAPACITY_EXCEEDED]: 'Seed pin capacity unavailable',
  [SEED_PIN_ERROR_CODES.NOT_FOUND]: 'Seed pin request not found',
  [SEED_PIN_ERROR_CODES.FORBIDDEN]: 'Seed pin status is forbidden',
  [SEED_PIN_ERROR_CODES.BUSY]: 'Seed pin request is busy',
  [SEED_PIN_ERROR_CODES.INTERNAL]: 'Seed pin service unavailable',
  [SEED_PIN_ERROR_CODES.WORKER_UNAVAILABLE]: 'Seed pin worker is unavailable',
})

export function seedPinErrorResponse (correlationId, requestId, code) {
  if (!ERROR_CODE_SET.has(code)) code = SEED_PIN_ERROR_CODES.INTERNAL
  return {
    version: SEED_PIN_PROTOCOL_VERSION,
    correlationId,
    requestId,
    ok: false,
    code,
    error: STABLE_ERROR_MESSAGES[code],
    status: null,
  }
}
