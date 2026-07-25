import b4a from 'b4a'
import c from 'compact-encoding'
import crypto from 'hypercore-crypto'

import {
  RECORD_LIMITS,
  assertBytes,
  assertInput,
  assertUint,
  isBytes,
  readField,
  readVarint,
  utf8,
  varintLength,
  writeField,
  writeVarint
} from '../records/canonical.js'

const MAX_CANONICAL_DEPTH = 64
const MAX_CANONICAL_NODES = 100_000

export function normalizeBytes (value, size = 32, name = 'bytes') {
  if (b4a.isBuffer(value) || value instanceof Uint8Array) {
    const out = b4a.from(value)
    if (size != null && out.byteLength !== size) throw new Error(`${name} must be ${size} bytes`)
    return out
  }
  if (typeof value === 'string' && /^(?:[0-9a-f]{2})+$/i.test(value)) {
    const out = b4a.from(value, 'hex')
    if (size != null && out.byteLength !== size) throw new Error(`${name} must be ${size} bytes`)
    return out
  }
  throw new Error(`${name} must be bytes or hex`)
}

export function toHex (value, size = 32, name = 'bytes') {
  return b4a.toString(normalizeBytes(value, size, name), 'hex')
}

function canonicalizePlain (value, state, depth) {
  if (depth > MAX_CANONICAL_DEPTH) throw new Error('canonical value exceeds its depth limit')
  if (++state.nodes > MAX_CANONICAL_NODES) throw new Error('canonical value exceeds its node limit')
  if (value === null || value === undefined) return null
  if (b4a.isBuffer(value) || value instanceof Uint8Array) {
    state.bytes += value.byteLength * 2
    if (state.bytes > RECORD_LIMITS.maxBodyBytes) throw new Error('canonical value exceeds its byte limit')
    return toHex(value)
  }
  if (typeof value === 'string') {
    state.bytes += b4a.byteLength(value)
    if (state.bytes > RECORD_LIMITS.maxBodyBytes) throw new Error('canonical value exceeds its byte limit')
    return value
  }
  if (typeof value !== 'object') return value
  if (state.seen.has(value)) throw new Error('canonical value must not contain cycles')
  state.seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_CANONICAL_NODES - state.nodes) throw new Error('canonical array exceeds its node limit')
      const keys = Object.keys(value)
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        throw new Error('canonical arrays must not be sparse or contain named properties')
      }
      return Array.from(value, entry => canonicalizePlain(entry, state, depth + 1))
    }
    const out = {}
    for (const key of Object.keys(value).sort()) {
      state.bytes += b4a.byteLength(key)
      if (state.bytes > RECORD_LIMITS.maxBodyBytes) throw new Error('canonical value exceeds its byte limit')
      const next = value[key]
      if (next !== undefined) out[key] = canonicalizePlain(next, state, depth + 1)
    }
    return out
  } finally {
    state.seen.delete(value)
  }
}

export function sortPlain (value) {
  return canonicalizePlain(value, { bytes: 0, nodes: 0, seen: new Set() }, 0)
}

export function encodeCanonical (value) {
  const output = b4a.from(JSON.stringify(sortPlain(value)))
  if (output.byteLength > RECORD_LIMITS.maxBodyBytes) throw new Error('canonical value exceeds its byte limit')
  return output
}

export function hashCanonical (domain, value) {
  if (typeof domain !== 'string' || domain.length === 0 || b4a.byteLength(domain) > RECORD_LIMITS.maxRecordTypeBytes) {
    throw new Error('canonical hash domain is out of bounds')
  }
  const body = encodeCanonical(value)
  return crypto.hash(b4a.concat([
    c.encode(c.string, domain),
    c.encode(c.uint, body.byteLength),
    body
  ]))
}

export function normalizeNonNegativeInteger (value, name, fallback = 0) {
  const next = value == null ? fallback : Number(value)
  if (!Number.isSafeInteger(next) || next < 0) throw new Error(`${name} must be a non-negative safe integer`)
  return next
}

export function normalizeCapabilities (capabilities = []) {
  if (!Array.isArray(capabilities)) throw new Error('capabilities must be an array')
  return Array.from(new Set(capabilities.map(capability => {
    if (typeof capability !== 'string' || !/^[a-z0-9:._-]+$/i.test(capability)) {
      throw new Error('invalid capability')
    }
    return capability
  }))).sort()
}

export const PUBLISHER_RECORD_TYPES = Object.freeze({
  NAMESPACE: 'publisher.namespace',
  WRITER_ADMISSION: 'publisher.writer-admission',
  WRITER_REVOCATION: 'publisher.writer-revocation',
  ROOT_TRANSITION: 'publisher.root-transition',
  PUBLICATION: 'publisher.publication',
  CLAIM: 'publisher.claim',
  COLLECTION_RELEASE: 'publisher.collection-release',
  RETRACTION: 'publisher.retraction',
  OWNER_ACTION: 'publisher.owner-action',
  VIEW_HEAD: 'publisher.view-head'
})

export const WRITER_CAPABILITIES = Object.freeze(['announce', 'claim', 'moderate', 'publish'])

export const PUBLISHER_LIMITS = Object.freeze({
  maxProfileRefBytes: 2_048,
  maxRecoveryKeys: 15,
  maxCapabilities: WRITER_CAPABILITIES.length,
  maxRevocations: 32,
  maxPayloadBytes: 65_536,
  maxReasonBytes: 1_024,
  maxClaimTypeBytes: 64,
  maxOperationBytes: RECORD_LIMITS.maxEnvelopeBytes,
  maxApplyBatch: 128,
  maxJournalOperations: 4_096,
  maxSnapshotBytes: 8 * 1_048_576
})

const BODY_VERSION = 1
const TARGET_TYPES = Object.freeze(['claim', 'collection', 'publication'])
const OWNER_ACTIONS = Object.freeze(['feature', 'hide', 'restore', 'unfeature'])

function invalid (message) {
  throw new Error(`Invalid publisher operation: ${message}`)
}

export function assertExactFields (value, expected, name = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isBytes(value)) invalid(`${name} must be an object`)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  for (const field of actual) if (!wanted.includes(field)) invalid(`${name} has unknown field ${field}`)
  for (const field of wanted) if (!Object.hasOwn(value, field)) invalid(`${name} is missing field ${field}`)
  return value
}

function assertOptionalExactFields (value, required, optional, name = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isBytes(value)) invalid(`${name} must be an object`)
  const allowed = [...required, ...optional]
  for (const field of Object.keys(value)) if (!allowed.includes(field)) invalid(`${name} has unknown field ${field}`)
  for (const field of required) if (!Object.hasOwn(value, field)) invalid(`${name} is missing field ${field}`)
  return value
}

function boundedBytes (value, name, maxBytes, { allowEmpty = true } = {}) {
  if (!isBytes(value)) invalid(`${name} must be bytes`)
  if ((!allowEmpty && value.byteLength === 0) || value.byteLength > maxBytes) invalid(`${name} exceeds its byte limit`)
  return value
}

function enumValue (value, values, name) {
  if (!values.includes(value)) invalid(`${name} is unknown`)
  return value
}

function compareByteArrays (left, right) {
  return b4a.compare(left, right)
}

function assertOrderedDistinctKeys (keys, name, maximum) {
  if (!Array.isArray(keys) || keys.length > maximum) invalid(`${name} count is out of bounds`)
  let previous = null
  for (const key of keys) {
    assertBytes(key, 32, name)
    if (previous) {
      const order = compareByteArrays(previous, key)
      if (order === 0) invalid(`${name} must be distinct`)
      if (order > 0) invalid(`${name} must be lexicographically ordered`)
    }
    previous = key
  }
  return keys
}

function assertCapabilities (capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.length > PUBLISHER_LIMITS.maxCapabilities) invalid('capabilities count is out of bounds')
  let previous = ''
  for (const capability of capabilities) {
    enumValue(capability, WRITER_CAPABILITIES, 'capability')
    if (previous === capability) invalid('capabilities must be distinct')
    if (previous && previous > capability) invalid('capabilities must be lexicographically ordered')
    previous = capability
  }
  return capabilities
}

function assertRevocations (revocations) {
  if (!Array.isArray(revocations) || revocations.length === 0 || revocations.length > PUBLISHER_LIMITS.maxRevocations) invalid('revocations count is out of bounds')
  let previous = null
  for (const entry of revocations) {
    assertExactFields(entry, ['writerKey', 'acceptedThroughSequence'], 'revocation')
    assertBytes(entry.writerKey, 32, 'writerKey')
    assertUint(entry.acceptedThroughSequence, 'acceptedThroughSequence')
    if (previous) {
      const order = compareByteArrays(previous, entry.writerKey)
      if (order === 0) invalid('revocation writer keys must be distinct')
      if (order > 0) invalid('revocation writer keys must be lexicographically ordered')
    }
    previous = entry.writerKey
  }
  return revocations
}

function uintBytes (value, name) {
  assertUint(value, name)
  const output = b4a.allocUnsafe(varintLength(value))
  writeVarint(output, 0, value)
  return output
}

function fieldBytes (value, name, maxBytes, options) {
  const bytes = boundedBytes(value, name, maxBytes, options)
  const output = b4a.allocUnsafe(varintLength(bytes.byteLength) + bytes.byteLength)
  writeField(output, 0, bytes)
  return output
}

function stringField (value, name, maxBytes) {
  return fieldBytes(utf8(value, name, maxBytes), name, maxBytes, { allowEmpty: false })
}

function assemble (chunks) {
  let length = 0
  for (const chunk of chunks) length += chunk.byteLength
  if (length > RECORD_LIMITS.maxBodyBytes) invalid('body exceeds its byte limit')
  return b4a.concat(chunks, length)
}

function encodeWriterAdmission (body) {
  assertExactFields(body, ['writerKey', 'signerKey', 'capabilities', 'firstAcceptedSequence', 'expiresAt', 'admissionNonce'])
  assertBytes(body.writerKey, 32, 'writerKey')
  assertBytes(body.signerKey, 32, 'signerKey')
  assertCapabilities(body.capabilities)
  assertUint(body.firstAcceptedSequence, 'firstAcceptedSequence')
  assertUint(body.expiresAt, 'expiresAt')
  assertBytes(body.admissionNonce, 16, 'admissionNonce')
  const chunks = [b4a.from([BODY_VERSION]), body.writerKey, body.signerKey, uintBytes(body.capabilities.length, 'capabilities count')]
  for (const capability of body.capabilities) chunks.push(stringField(capability, 'capability', 16))
  chunks.push(uintBytes(body.firstAcceptedSequence, 'firstAcceptedSequence'), uintBytes(body.expiresAt, 'expiresAt'), body.admissionNonce)
  return assemble(chunks)
}

function encodeWriterRevocation (body) {
  assertExactFields(body, ['newPolicyEpoch', 'revocations'])
  assertUint(body.newPolicyEpoch, 'newPolicyEpoch')
  assertRevocations(body.revocations)
  const chunks = [b4a.from([BODY_VERSION]), uintBytes(body.newPolicyEpoch, 'newPolicyEpoch'), uintBytes(body.revocations.length, 'revocations count')]
  for (const entry of body.revocations) chunks.push(entry.writerKey, uintBytes(entry.acceptedThroughSequence, 'acceptedThroughSequence'))
  return assemble(chunks)
}

function assertRecoveryPolicy (recoveryKeys, recoveryThreshold) {
  assertOrderedDistinctKeys(recoveryKeys, 'recovery keys', PUBLISHER_LIMITS.maxRecoveryKeys)
  if (!Number.isSafeInteger(recoveryThreshold) || recoveryThreshold < 0 || recoveryThreshold > recoveryKeys.length) invalid('recovery threshold is out of bounds')
  if (recoveryKeys.length === 0 && recoveryThreshold !== 0) invalid('recovery threshold requires recovery keys')
  if (recoveryKeys.length > 0 && recoveryThreshold === 0) invalid('recovery threshold must be positive')
}

function encodeRootTransition (body) {
  assertExactFields(body, ['mode', 'previousRootKey', 'newRootKey', 'newCatalogEpoch', 'recoveryKeys', 'recoveryThreshold', 'profileRef'])
  enumValue(body.mode, ['recovery', 'rotation'], 'transition mode')
  assertBytes(body.previousRootKey, 32, 'previousRootKey')
  assertBytes(body.newRootKey, 32, 'newRootKey')
  assertUint(body.newCatalogEpoch, 'newCatalogEpoch')
  assertRecoveryPolicy(body.recoveryKeys, body.recoveryThreshold)
  boundedBytes(body.profileRef, 'profileRef', PUBLISHER_LIMITS.maxProfileRefBytes)
  const chunks = [
    b4a.from([BODY_VERSION, body.mode === 'rotation' ? 0 : 1]),
    body.previousRootKey,
    body.newRootKey,
    uintBytes(body.newCatalogEpoch, 'newCatalogEpoch'),
    uintBytes(body.recoveryKeys.length, 'recovery keys count')
  ]
  for (const key of body.recoveryKeys) chunks.push(key)
  chunks.push(uintBytes(body.recoveryThreshold, 'recoveryThreshold'), fieldBytes(body.profileRef, 'profileRef', PUBLISHER_LIMITS.maxProfileRefBytes))
  return assemble(chunks)
}

function encodePublication (body) {
  assertExactFields(body, ['publicationId', 'manifestId', 'payload'])
  assertBytes(body.publicationId, 32, 'publicationId')
  assertBytes(body.manifestId, 32, 'manifestId')
  return assemble([b4a.from([BODY_VERSION]), body.publicationId, body.manifestId, fieldBytes(body.payload, 'payload', PUBLISHER_LIMITS.maxPayloadBytes)])
}

function encodeClaim (body) {
  assertExactFields(body, ['claimId', 'claimType', 'payload'])
  assertBytes(body.claimId, 32, 'claimId')
  return assemble([b4a.from([BODY_VERSION]), body.claimId, stringField(body.claimType, 'claimType', PUBLISHER_LIMITS.maxClaimTypeBytes), fieldBytes(body.payload, 'payload', PUBLISHER_LIMITS.maxPayloadBytes)])
}

function encodeCollectionRelease (body) {
  assertExactFields(body, ['collectionId', 'releaseId', 'payload'])
  assertBytes(body.collectionId, 32, 'collectionId')
  assertBytes(body.releaseId, 32, 'releaseId')
  return assemble([b4a.from([BODY_VERSION]), body.collectionId, body.releaseId, fieldBytes(body.payload, 'payload', PUBLISHER_LIMITS.maxPayloadBytes)])
}

function encodeRetraction (body) {
  assertExactFields(body, ['targetType', 'targetId', 'reason'])
  enumValue(body.targetType, TARGET_TYPES, 'targetType')
  assertBytes(body.targetId, 32, 'targetId')
  return assemble([b4a.from([BODY_VERSION]), stringField(body.targetType, 'targetType', 16), body.targetId, fieldBytes(body.reason, 'reason', PUBLISHER_LIMITS.maxReasonBytes)])
}

function encodeOwnerAction (body) {
  assertExactFields(body, ['action', 'targetType', 'targetId', 'reason'])
  enumValue(body.action, OWNER_ACTIONS, 'owner action')
  enumValue(body.targetType, TARGET_TYPES, 'targetType')
  assertBytes(body.targetId, 32, 'targetId')
  return assemble([b4a.from([BODY_VERSION]), stringField(body.action, 'action', 16), stringField(body.targetType, 'targetType', 16), body.targetId, fieldBytes(body.reason, 'reason', PUBLISHER_LIMITS.maxReasonBytes)])
}

function encodeViewHead (body) {
  assertExactFields(body, ['viewKey', 'length', 'digest', 'authorizationStateDigest'])
  assertBytes(body.viewKey, 32, 'viewKey')
  assertUint(body.length, 'length')
  assertBytes(body.digest, 32, 'digest')
  assertBytes(body.authorizationStateDigest, 32, 'authorizationStateDigest')
  return assemble([b4a.from([BODY_VERSION]), body.viewKey, uintBytes(body.length, 'length'), body.digest, body.authorizationStateDigest])
}

export function encodePublisherOperationBody (recordType, body) {
  switch (recordType) {
    case PUBLISHER_RECORD_TYPES.WRITER_ADMISSION: return encodeWriterAdmission(body)
    case PUBLISHER_RECORD_TYPES.WRITER_REVOCATION: return encodeWriterRevocation(body)
    case PUBLISHER_RECORD_TYPES.ROOT_TRANSITION: return encodeRootTransition(body)
    case PUBLISHER_RECORD_TYPES.PUBLICATION: return encodePublication(body)
    case PUBLISHER_RECORD_TYPES.CLAIM: return encodeClaim(body)
    case PUBLISHER_RECORD_TYPES.COLLECTION_RELEASE: return encodeCollectionRelease(body)
    case PUBLISHER_RECORD_TYPES.RETRACTION: return encodeRetraction(body)
    case PUBLISHER_RECORD_TYPES.OWNER_ACTION: return encodeOwnerAction(body)
    case PUBLISHER_RECORD_TYPES.VIEW_HEAD: return encodeViewHead(body)
    default: invalid(`unknown record type ${recordType}`)
  }
}

function readFixed (state, name, length) {
  if (state.offset + length > state.buffer.byteLength) invalid(`truncated ${name}`)
  const value = state.buffer.subarray(state.offset, state.offset + length)
  state.offset += length
  return value
}

function readString (state, name, maximum) {
  const bytes = readField(state, name, maximum)
  const value = b4a.toString(bytes)
  if (b4a.toString(b4a.from(value), 'hex') !== b4a.toString(bytes, 'hex') || value.length === 0) invalid(`${name} is not canonical UTF-8`)
  return value
}

function finishDecode (recordType, input, state, body) {
  if (state.offset !== input.byteLength) invalid('trailing bytes')
  const canonical = encodePublisherOperationBody(recordType, body)
  if (!b4a.equals(canonical, input)) invalid('noncanonical body encoding')
  return body
}

export function decodePublisherOperationBody (recordType, input) {
  assertInput(input)
  if (input.byteLength > RECORD_LIMITS.maxBodyBytes) invalid('body exceeds its byte limit')
  const known = Object.values(PUBLISHER_RECORD_TYPES).includes(recordType) && recordType !== PUBLISHER_RECORD_TYPES.NAMESPACE
  if (!known) invalid(`unknown record type ${recordType}`)
  const state = { buffer: input, offset: 0 }
  if (readVarint(state, 'body version', 255) !== BODY_VERSION) invalid('unknown body version')
  let body
  switch (recordType) {
    case PUBLISHER_RECORD_TYPES.WRITER_ADMISSION: {
      const writerKey = readFixed(state, 'writerKey', 32)
      const signerKey = readFixed(state, 'signerKey', 32)
      const count = readVarint(state, 'capabilities count', PUBLISHER_LIMITS.maxCapabilities)
      const capabilities = new Array(count)
      for (let index = 0; index < count; index++) capabilities[index] = readString(state, 'capability', 16)
      body = { writerKey, signerKey, capabilities, firstAcceptedSequence: readVarint(state, 'firstAcceptedSequence'), expiresAt: readVarint(state, 'expiresAt'), admissionNonce: readFixed(state, 'admissionNonce', 16) }
      break
    }
    case PUBLISHER_RECORD_TYPES.WRITER_REVOCATION: {
      const newPolicyEpoch = readVarint(state, 'newPolicyEpoch')
      const count = readVarint(state, 'revocations count', PUBLISHER_LIMITS.maxRevocations)
      const revocations = new Array(count)
      for (let index = 0; index < count; index++) revocations[index] = { writerKey: readFixed(state, 'writerKey', 32), acceptedThroughSequence: readVarint(state, 'acceptedThroughSequence') }
      body = { newPolicyEpoch, revocations }
      break
    }
    case PUBLISHER_RECORD_TYPES.ROOT_TRANSITION: {
      const modeValue = readVarint(state, 'transition mode', 1)
      const previousRootKey = readFixed(state, 'previousRootKey', 32)
      const newRootKey = readFixed(state, 'newRootKey', 32)
      const newCatalogEpoch = readVarint(state, 'newCatalogEpoch')
      const count = readVarint(state, 'recovery keys count', PUBLISHER_LIMITS.maxRecoveryKeys)
      const recoveryKeys = new Array(count)
      for (let index = 0; index < count; index++) recoveryKeys[index] = readFixed(state, 'recoveryKey', 32)
      body = { mode: modeValue === 0 ? 'rotation' : 'recovery', previousRootKey, newRootKey, newCatalogEpoch, recoveryKeys, recoveryThreshold: readVarint(state, 'recoveryThreshold', count), profileRef: readField(state, 'profileRef', PUBLISHER_LIMITS.maxProfileRefBytes) }
      break
    }
    case PUBLISHER_RECORD_TYPES.PUBLICATION:
      body = { publicationId: readFixed(state, 'publicationId', 32), manifestId: readFixed(state, 'manifestId', 32), payload: readField(state, 'payload', PUBLISHER_LIMITS.maxPayloadBytes) }
      break
    case PUBLISHER_RECORD_TYPES.CLAIM:
      body = { claimId: readFixed(state, 'claimId', 32), claimType: readString(state, 'claimType', PUBLISHER_LIMITS.maxClaimTypeBytes), payload: readField(state, 'payload', PUBLISHER_LIMITS.maxPayloadBytes) }
      break
    case PUBLISHER_RECORD_TYPES.COLLECTION_RELEASE:
      body = { collectionId: readFixed(state, 'collectionId', 32), releaseId: readFixed(state, 'releaseId', 32), payload: readField(state, 'payload', PUBLISHER_LIMITS.maxPayloadBytes) }
      break
    case PUBLISHER_RECORD_TYPES.RETRACTION:
      body = { targetType: readString(state, 'targetType', 16), targetId: readFixed(state, 'targetId', 32), reason: readField(state, 'reason', PUBLISHER_LIMITS.maxReasonBytes) }
      break
    case PUBLISHER_RECORD_TYPES.OWNER_ACTION:
      body = { action: readString(state, 'action', 16), targetType: readString(state, 'targetType', 16), targetId: readFixed(state, 'targetId', 32), reason: readField(state, 'reason', PUBLISHER_LIMITS.maxReasonBytes) }
      break
    case PUBLISHER_RECORD_TYPES.VIEW_HEAD:
      body = { viewKey: readFixed(state, 'viewKey', 32), length: readVarint(state, 'length'), digest: readFixed(state, 'digest', 32), authorizationStateDigest: readFixed(state, 'authorizationStateDigest', 32) }
      break
  }
  return finishDecode(recordType, input, state, body)
}

export function requiredPublisherCapability (recordType, body = null) {
  switch (recordType) {
    case PUBLISHER_RECORD_TYPES.PUBLICATION:
    case PUBLISHER_RECORD_TYPES.COLLECTION_RELEASE:
      return 'publish'
    case PUBLISHER_RECORD_TYPES.RETRACTION:
      if (body?.targetType === 'claim') return 'claim'
      if (body?.targetType === 'publication' || body?.targetType === 'collection') return 'publish'
      return null
    case PUBLISHER_RECORD_TYPES.CLAIM:
      return 'claim'
    case PUBLISHER_RECORD_TYPES.OWNER_ACTION:
      return 'moderate'
    case PUBLISHER_RECORD_TYPES.VIEW_HEAD:
      return 'announce'
    default:
      return null
  }
}

export function isPublisherRecordType (recordType) {
  return Object.values(PUBLISHER_RECORD_TYPES).includes(recordType)
}

export const publisherCanonicalInternals = Object.freeze({
  BODY_VERSION,
  assertOptionalExactFields,
  assertOrderedDistinctKeys,
  assertRecoveryPolicy,
  boundedBytes,
  invalid,
  uintBytes,
  fieldBytes,
  readFixed,
  readString
})
