import b4a from 'b4a'
import c from 'compact-encoding'
import crypto from 'hypercore-crypto'

import {
  createApplicationEnvelope,
  decodeApplicationEnvelope,
  deriveApplicationRecordId,
  deriveApplicationSigningDigest,
  encodeApplicationEnvelope,
  normalizeFixed,
} from '../records/application-envelope.js'
import { PROTOCOL_MAJOR } from '../network/version.js'

export const INDEX_SERVICE_ANNOUNCEMENT_VERSION = 1
export const INDEX_SERVICE_ANNOUNCEMENT_RECORD_TYPE = 'peartube.index-service-announcement.v1'
export const INDEXER_ID_DOMAIN = 'peartube.indexer.id.v1'
export const MAX_INDEX_SERVICE_ANNOUNCEMENT_BYTES = 20 * 1024
export const MAX_INDEX_SERVICE_ANNOUNCEMENT_BODY_BYTES = 16 * 1024
export const MAX_INDEX_SERVICE_DIMENSIONS = 4
export const MAX_INDEX_SERVICE_RANGES = 64
export const MAX_INDEX_SERVICE_CAPABILITIES = 16
export const MAX_INDEX_SERVICE_SHARD_KEY_BYTES = 512

export const INDEX_SERVICE_DIMENSIONS = Object.freeze([
  'entity',
  'external-ref',
  'publisher',
  'text',
])

export const INDEX_SERVICE_QUERY_CAPABILITIES = Object.freeze([
  'exact-asset',
  'exact-entity',
  'exact-external-ref',
  'exact-publication',
  'publisher-prefix',
  'text-prefix',
])

const DIMENSIONS = new Set(INDEX_SERVICE_DIMENSIONS)
const QUERY_CAPABILITIES = new Set(INDEX_SERVICE_QUERY_CAPABILITIES)
const MAX_DIMENSION_BYTES = 32
const MAX_QUERY_CAPABILITY_BYTES = 128

function fail(message) {
  throw new Error(message)
}

function safeInteger(value, name, { positive = false } = {}) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < (positive ? 1 : 0)) {
    fail(`${name} must be a ${positive ? 'positive' : 'non-negative'} safe integer`)
  }
  return number
}

function boundedString(value, name, maxBytes) {
  if (typeof value !== 'string' || value.length === 0) fail(`${name} must be a bounded string`)
  if (value.normalize('NFC') !== value) fail(`${name} must be NFC normalized`)
  const encoded = b4a.from(value, 'utf8')
  if (encoded.byteLength === 0 || encoded.byteLength > maxBytes) fail(`${name} must be a bounded string`)
  if (!b4a.equals(b4a.from(b4a.toString(encoded, 'utf8'), 'utf8'), encoded)) fail(`${name} must be canonical UTF-8`)
  return value
}

function compareStrings(left, right) {
  return b4a.compare(b4a.from(left, 'utf8'), b4a.from(right, 'utf8'))
}

function normalizeDistinct(values, name, maximum, normalize) {
  if (!Array.isArray(values) || values.length === 0 || values.length > maximum) {
    fail(`${name} exceed bounded limit`)
  }
  const result = values.map(normalize)
  const seen = new Set()
  for (const value of result) {
    if (seen.has(value)) fail(`${name} must be distinct`)
    seen.add(value)
  }
  return result.sort(compareStrings)
}

function normalizeDimension(value) {
  const dimension = boundedString(value, 'dimension', MAX_DIMENSION_BYTES)
  if (!DIMENSIONS.has(dimension)) fail(`unsupported dimension: ${dimension}`)
  return dimension
}

function normalizeQueryCapability(value) {
  const capability = boundedString(value, 'query capability', MAX_QUERY_CAPABILITY_BYTES)
  if (!QUERY_CAPABILITIES.has(capability)) fail(`unsupported query capability: ${capability}`)
  return capability
}

function normalizeBound(value, name) {
  if (value == null) return null
  return boundedString(value, name, MAX_INDEX_SERVICE_SHARD_KEY_BYTES)
}

function compareNullable(left, right, nullFirst) {
  if (left === right) return 0
  if (left === null) return nullFirst ? -1 : 1
  if (right === null) return nullFirst ? 1 : -1
  return compareStrings(left, right)
}

function compareRanges(left, right) {
  return compareStrings(left.dimension, right.dimension) ||
    compareNullable(left.start, right.start, true) ||
    compareNullable(left.end, right.end, false)
}

function rangeKey(range) {
  return `${range.dimension}\u0000${range.start === null ? '-' : `s${range.start}`}\u0000${range.end === null ? '+' : `e${range.end}`}`
}

function normalizeRanges(values, dimensions) {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_INDEX_SERVICE_RANGES) {
    fail('shard ranges exceed bounded limit')
  }
  const dimensionSet = new Set(dimensions)
  const seen = new Set()
  const covered = new Set()
  const ranges = values.map((value, index) => {
    if (!value || typeof value !== 'object') fail(`shardRanges[${index}] must be an object`)
    const dimension = normalizeDimension(value.dimension)
    if (!dimensionSet.has(dimension)) fail('shard range must reference a declared dimension')
    const start = normalizeBound(value.start, `shardRanges[${index}].start`)
    const end = normalizeBound(value.end, `shardRanges[${index}].end`)
    if (start !== null && end !== null && compareStrings(end, start) <= 0) {
      fail('shard range end must be greater than start')
    }
    const range = { dimension, start, end }
    const key = rangeKey(range)
    if (seen.has(key)) fail('shard ranges must be distinct')
    seen.add(key)
    covered.add(dimension)
    return range
  }).sort(compareRanges)
  for (const dimension of dimensions) {
    if (!covered.has(dimension)) fail(`declared dimension has no shard range: ${dimension}`)
  }
  return ranges
}

function normalizeBody(input = {}) {
  const version = Number(input.version ?? INDEX_SERVICE_ANNOUNCEMENT_VERSION)
  if (version !== INDEX_SERVICE_ANNOUNCEMENT_VERSION) fail(`unsupported index service announcement version: ${version}`)
  const protocolMajor = safeInteger(input.protocolMajor ?? PROTOCOL_MAJOR, 'protocolMajor', { positive: true })
  if (protocolMajor !== PROTOCOL_MAJOR) fail(`unsupported protocol major: ${protocolMajor}`)
  const protocolMinor = safeInteger(input.protocolMinor ?? 0, 'protocolMinor')
  if (protocolMinor > 255) fail('protocolMinor must be at most 255')
  const indexerId = normalizeFixed(input.indexerId, 32, 'indexerId')
  const transportPublicKey = normalizeFixed(input.transportPublicKey, 32, 'transportPublicKey')
  const policyDigest = normalizeFixed(input.policyDigest, 32, 'policyDigest')
  const dimensions = normalizeDistinct(input.dimensions, 'dimensions', MAX_INDEX_SERVICE_DIMENSIONS, normalizeDimension)
  const queryCapabilities = normalizeDistinct(
    input.queryCapabilities,
    'query capabilities',
    MAX_INDEX_SERVICE_CAPABILITIES,
    normalizeQueryCapability,
  )
  const shardRanges = normalizeRanges(input.shardRanges, dimensions)
  const sequence = safeInteger(input.sequence, 'sequence')
  const issuedAt = safeInteger(input.issuedAt, 'issuedAt', { positive: true })
  const expiresAt = safeInteger(input.expiresAt, 'expiresAt', { positive: true })
  if (expiresAt <= issuedAt) fail('expiresAt must be greater than issuedAt')
  return {
    version,
    protocolMajor,
    protocolMinor,
    indexerId,
    transportPublicKey,
    dimensions,
    shardRanges,
    queryCapabilities,
    policyDigest,
    sequence,
    issuedAt,
    expiresAt,
  }
}

function encodeStringArray(values) {
  return b4a.concat([
    c.encode(c.uint, values.length),
    ...values.map(value => c.encode(c.string, value)),
  ])
}

function encodeRange(range) {
  return b4a.concat([
    c.encode(c.string, range.dimension),
    c.encode(c.bool, range.start !== null),
    range.start === null ? b4a.alloc(0) : c.encode(c.string, range.start),
    c.encode(c.bool, range.end !== null),
    range.end === null ? b4a.alloc(0) : c.encode(c.string, range.end),
  ])
}

export function encodeIndexServiceAnnouncementBody(input = {}) {
  const body = normalizeBody(input)
  const encoded = b4a.concat([
    c.encode(c.uint, body.version),
    c.encode(c.uint, body.protocolMajor),
    c.encode(c.uint, body.protocolMinor),
    c.encode(c.fixed32, body.indexerId),
    c.encode(c.fixed32, body.transportPublicKey),
    encodeStringArray(body.dimensions),
    c.encode(c.uint, body.shardRanges.length),
    ...body.shardRanges.map(encodeRange),
    encodeStringArray(body.queryCapabilities),
    c.encode(c.fixed32, body.policyDigest),
    c.encode(c.uint, body.sequence),
    c.encode(c.uint, body.issuedAt),
    c.encode(c.uint, body.expiresAt),
  ])
  if (encoded.byteLength > MAX_INDEX_SERVICE_ANNOUNCEMENT_BODY_BYTES) fail('announcement body exceeds maximum')
  return encoded
}

function decodeString(state, name, maximum) {
  return boundedString(c.string.decode(state), name, maximum)
}

function decodeStringArray(state, name, maximum, normalize) {
  const count = c.uint.decode(state)
  if (count === 0 || count > maximum) fail(`${name} exceed bounded limit`)
  const values = []
  for (let index = 0; index < count; index++) values.push(normalize(decodeString(state, `${name}[${index}]`, name === 'dimensions' ? MAX_DIMENSION_BYTES : MAX_QUERY_CAPABILITY_BYTES)))
  return values
}

export function decodeIndexServiceAnnouncementBody(input) {
  const encoded = b4a.from(input || [])
  if (encoded.byteLength === 0 || encoded.byteLength > MAX_INDEX_SERVICE_ANNOUNCEMENT_BODY_BYTES) fail('announcement body exceeds maximum')
  const state = c.state(0, encoded.byteLength, encoded)
  const version = c.uint.decode(state)
  const protocolMajor = c.uint.decode(state)
  const protocolMinor = c.uint.decode(state)
  const indexerId = c.fixed32.decode(state)
  const transportPublicKey = c.fixed32.decode(state)
  const dimensions = decodeStringArray(state, 'dimensions', MAX_INDEX_SERVICE_DIMENSIONS, normalizeDimension)
  const rangeCount = c.uint.decode(state)
  if (rangeCount === 0 || rangeCount > MAX_INDEX_SERVICE_RANGES) fail('shard ranges exceed bounded limit')
  const shardRanges = []
  for (let index = 0; index < rangeCount; index++) {
    const dimension = decodeString(state, `shardRanges[${index}].dimension`, MAX_DIMENSION_BYTES)
    const start = c.bool.decode(state) ? decodeString(state, `shardRanges[${index}].start`, MAX_INDEX_SERVICE_SHARD_KEY_BYTES) : null
    const end = c.bool.decode(state) ? decodeString(state, `shardRanges[${index}].end`, MAX_INDEX_SERVICE_SHARD_KEY_BYTES) : null
    shardRanges.push({ dimension, start, end })
  }
  const queryCapabilities = decodeStringArray(state, 'query capabilities', MAX_INDEX_SERVICE_CAPABILITIES, normalizeQueryCapability)
  const policyDigest = c.fixed32.decode(state)
  const sequence = c.uint.decode(state)
  const issuedAt = c.uint.decode(state)
  const expiresAt = c.uint.decode(state)
  if (state.start !== state.end) fail('trailing bytes after announcement body')
  const body = normalizeBody({
    version,
    protocolMajor,
    protocolMinor,
    indexerId,
    transportPublicKey,
    dimensions,
    shardRanges,
    queryCapabilities,
    policyDigest,
    sequence,
    issuedAt,
    expiresAt,
  })
  if (!b4a.equals(encodeIndexServiceAnnouncementBody(body), encoded)) fail('announcement body is noncanonical')
  return body
}

export function deriveIndexerId(signingPublicKey) {
  const publicKey = normalizeFixed(signingPublicKey, 32, 'signing public key')
  return crypto.hash(b4a.concat([b4a.from(INDEXER_ID_DOMAIN, 'utf8'), publicKey]))
}

export function signIndexServiceAnnouncement(input = {}, signer) {
  if (!signer?.publicKey || !signer?.secretKey) fail('signer with publicKey and secretKey is required')
  const derivedIndexerId = deriveIndexerId(signer.publicKey)
  if (input.indexerId != null && !b4a.equals(normalizeFixed(input.indexerId, 32, 'indexerId'), derivedIndexerId)) {
    fail('indexerId does not match signing key domain')
  }
  const body = normalizeBody({ ...input, indexerId: derivedIndexerId })
  const envelope = createApplicationEnvelope({
    recordType: INDEX_SERVICE_ANNOUNCEMENT_RECORD_TYPE,
    body: encodeIndexServiceAnnouncementBody(body),
    keyPair: signer,
    issuedAt: body.issuedAt,
    expiresAt: body.expiresAt,
  })
  return { ...body, envelope }
}

export function createIndexServiceAnnouncement(input = {}, signer) {
  return signIndexServiceAnnouncement(input, signer)
}

export function encodeIndexServiceAnnouncement(input = {}) {
  if (!input.envelope) fail('signed announcement envelope is required')
  const body = normalizeBody(input)
  const encodedBody = encodeIndexServiceAnnouncementBody(body)
  if (!b4a.equals(encodedBody, b4a.from(input.envelope.body || []))) fail('announcement envelope body mismatch')
  if (input.envelope.recordType !== INDEX_SERVICE_ANNOUNCEMENT_RECORD_TYPE) fail('announcement record domain mismatch')
  if (input.envelope.issuedAt !== body.issuedAt || input.envelope.expiresAt !== body.expiresAt) fail('announcement envelope time mismatch')
  const encoded = encodeApplicationEnvelope(input.envelope, { maxBodyBytes: MAX_INDEX_SERVICE_ANNOUNCEMENT_BODY_BYTES })
  if (encoded.byteLength > MAX_INDEX_SERVICE_ANNOUNCEMENT_BYTES) fail('announcement exceeds maximum')
  return encoded
}

export function decodeIndexServiceAnnouncement(input) {
  const encoded = b4a.from(input || [])
  if (encoded.byteLength === 0 || encoded.byteLength > MAX_INDEX_SERVICE_ANNOUNCEMENT_BYTES) fail('announcement exceeds maximum')
  const envelope = decodeApplicationEnvelope(encoded, { maxBodyBytes: MAX_INDEX_SERVICE_ANNOUNCEMENT_BODY_BYTES })
  if (envelope.recordType !== INDEX_SERVICE_ANNOUNCEMENT_RECORD_TYPE) fail('announcement record domain mismatch')
  const body = decodeIndexServiceAnnouncementBody(envelope.body)
  if (envelope.issuedAt !== body.issuedAt || envelope.expiresAt !== body.expiresAt) fail('announcement envelope time mismatch')
  const announcement = { ...body, envelope }
  if (!b4a.equals(encodeIndexServiceAnnouncement(announcement), encoded)) fail('announcement is noncanonical')
  return announcement
}

function allowedBy(values, allowed) {
  if (allowed == null) return true
  const set = allowed instanceof Set ? allowed : new Set(allowed)
  return values.every(value => set.has(value))
}

export function verifyIndexServiceAnnouncement(input, options = {}) {
  try {
    const canonical = encodeIndexServiceAnnouncement(input)
    const announcement = decodeIndexServiceAnnouncement(canonical)
    const envelope = announcement.envelope
    const now = safeInteger(typeof options.now === 'function' ? options.now() : (options.now ?? Date.now()), 'now')
    if (announcement.issuedAt > now || announcement.expiresAt < now) return false
    if (!b4a.equals(deriveIndexerId(envelope.signer), announcement.indexerId)) return false
    if (options.expectedIndexerId && !b4a.equals(normalizeFixed(options.expectedIndexerId, 32, 'expectedIndexerId'), announcement.indexerId)) return false
    if (options.remotePublicKey && !b4a.equals(normalizeFixed(options.remotePublicKey, 32, 'remotePublicKey'), announcement.transportPublicKey)) return false
    if (!allowedBy(announcement.dimensions, options.supportedDimensions)) return false
    if (!allowedBy(announcement.queryCapabilities, options.supportedQueryCapabilities)) return false
    const recordId = deriveApplicationRecordId(envelope, { maxBodyBytes: MAX_INDEX_SERVICE_ANNOUNCEMENT_BODY_BYTES })
    if (!b4a.equals(recordId, envelope.recordId)) return false
    if (!crypto.verify(deriveApplicationSigningDigest(recordId), envelope.signature, envelope.signer)) return false
    if (options.sequenceState != null) {
      if (!(options.sequenceState instanceof Map)) fail('sequenceState must be a Map')
      const key = b4a.toString(announcement.indexerId, 'hex')
      const previous = options.sequenceState.get(key)
      if (previous != null && announcement.sequence <= previous) return false
      options.sequenceState.set(key, announcement.sequence)
    }
    return true
  } catch {
    return false
  }
}

export const IndexServiceAnnouncementV1 = Object.freeze({
  version: INDEX_SERVICE_ANNOUNCEMENT_VERSION,
  encode: encodeIndexServiceAnnouncement,
  decode: decodeIndexServiceAnnouncement,
  create: createIndexServiceAnnouncement,
  sign: signIndexServiceAnnouncement,
  verify: verifyIndexServiceAnnouncement,
})
