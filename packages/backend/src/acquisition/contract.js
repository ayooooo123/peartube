import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { ARTWORK_RENDITION_PURPOSES } from '../assets/rendition.js'

export const ACQUISITION_SCHEMA_VERSION = 1
export const MAX_ACQUISITION_BYTES = 500 * 1024 * 1024 * 1024
export const ACQUISITION_STATES = Object.freeze([
  'queued',
  'acquiring',
  'verifying',
  'publishing',
  'verified',
  'completed',
  'failed',
  'cancelled'
])
export const TERMINAL_ACQUISITION_STATES = Object.freeze(['verified', 'completed', 'failed', 'cancelled'])
export const ACQUISITION_EVENT_TYPES = Object.freeze([
  'acquisition.queued',
  'acquisition.acquiring',
  'acquisition.verifying',
  'acquisition.publishing',
  'acquisition.verified',
  'acquisition.completed',
  'acquisition.failed',
  'acquisition.cancelled',
  'acquisition.progress',
  'acquisition.restarted',
  'acquisition.source-grant-attached'
])

const REQUEST_FIELDS = new Set(['schemaVersion', 'resolutionRef', 'publisherId', 'retentionClass', 'retentionUntil', 'sourceFileName'])
// What the durable job knows about the work it is fetching. It is publisher
// metadata, never source material: an operator surface has to be able to name
// a transfer, and `acquisitionId` names a machine.
export const PUBLICATION_MEDIA_FIELDS = new Set([
  'kind',
  'namespace',
  'identifier',
  'title',
  'season',
  'episode',
  'releaseYear',
  'workEntityId'
])
export const PUBLICATION_ENRICHMENT_FIELDS = Object.freeze([
  'description', 'tags', 'creatorName', 'creatorHandle', 'duration', 'artworkRoles'
])
export const PUBLICATION_METADATA_FIELDS = new Set([
  'title', 'sourceFileName', 'mediaContext', ...PUBLICATION_ENRICHMENT_FIELDS
])
const PUBLICATION_TEXT_LIMITS = Object.freeze([
  ['description', 2048], ['creatorName', 256], ['creatorHandle', 256]
])
const PUBLIC_JOB_FIELDS = new Set([
  'schemaVersion',
  'acquisitionId',
  'state',
  'retentionClass',
  'title',
  'sourceFileName',
  'mediaContext',
  'bytesAcquired',
  'expectedBytes',
  'publicationId',
  'manifestId',
  'renditionId',
  'assetId',
  'errorCode',
  'recoverable',
  'createdAt',
  'updatedAt'
])
const EVENT_FIELDS = new Set([
  'schemaVersion',
  'eventId',
  'acquisitionId',
  'type',
  'state',
  'sequence',
  'at',
  'bytesAcquired',
  'expectedBytes',
  'errorCode',
  'publicationId'
])
const RETENTION_CLASSES = new Set(['contribution-cache', 'archive-pin'])
const STATES = new Set(ACQUISITION_STATES)
const EVENT_TYPES = new Set(ACQUISITION_EVENT_TYPES)
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const RESOLUTION_REF = /^[A-Za-z0-9_-]{43}$/
const LOCATOR = /^(?:[a-z][a-z0-9+.-]*:(?:\/\/)?|\/\/)/i
const TITLE_LOCATOR = /(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|\bmagnet:)/i
const SENSITIVE_FIELD = /(?:url|uri|href|link|magnet|torrent|cookie|authorization|credential|secret|password|passkey|debrid|headers?|adapter|source(?:capability|descriptor|grant|token|url|path)|grant|token|localpath|filepath|privateinfohash|tracker(?:url|id|announce)?)/i
// The name the source called the file. It is a label, never a locator: no
// separator, no scheme, no control characters. Keeping it is what lets an
// operator tell two versions of one work apart.
const SOURCE_FILE_NAME = /^[^/\\]{1,255}$/
const SENSITIVE_VALUE = /(?:[a-z][a-z0-9+.-]*:\/\/|\bmagnet:|\b(?:passkey|authkey|torrent[_-]?pass|private[_-]?infohash|tracker(?:url|id)|authorization|cookie)\s*[:=])/i

export class AcquisitionContractError extends Error {
  constructor (code, message = code, statusCode = 400) {
    super(`${code}: ${message}`)
    this.name = 'AcquisitionContractError'
    this.code = code
    this.statusCode = statusCode
  }
}

export function acquisitionError (code, message = code, statusCode = 400) {
  return new AcquisitionContractError(code, message, statusCode)
}

function fail (code, message, statusCode = 400) {
  throw acquisitionError(code, message, statusCode)
}

function isObject (value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function onlyFields (value, fields, name, code) {
  if (!isObject(value)) fail(code, `${name} must be an object`)
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) fail(code, `${name} contains unknown field ${key}`)
  }
}

function containsControlCharacter (value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 31 || (code >= 127 && code <= 159)) return true
  }
  return false
}

function text (value, name, maxBytes, { pattern = null, code = 'ACQUISITION_REQUEST_INVALID', nullable = false, allowLocator = false, title = false } = {}) {
  if (value == null && nullable) return null
  const containsLocator = title ? TITLE_LOCATOR.test(value) : LOCATOR.test(value)
  if (typeof value !== 'string' || value !== value.normalize('NFC') || value !== value.trim() || !value ||
      b4a.byteLength(value) > maxBytes || containsControlCharacter(value) ||
      (!allowLocator && containsLocator) || (pattern && !pattern.test(value))) {
    fail(code, `${name} is invalid`)
  }
  return value
}

function uint (value, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER, code = 'ACQUISITION_REQUEST_INVALID' } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code, `${name} is invalid`)
  return value
}

export function normalizePrincipalId (principal, name = 'principal') {
  const value = typeof principal === 'string' ? principal : (principal?.principalId ?? principal?.id)
  return text(value, name, 128, { pattern: ID, code: 'ACQUISITION_PRINCIPAL_INVALID' })
}

export function assertNoPrivateSourceMaterial (value, name = 'public acquisition record', depth = 0, state = { nodes: 0, seen: new Set() }) {
  if (depth > 16 || ++state.nodes > 512) fail('ACQUISITION_SECRET_REJECTED', `${name} exceeds its bounds`)
  if (typeof value === 'string') {
    if (b4a.byteLength(value) > 4096 || LOCATOR.test(value) || SENSITIVE_VALUE.test(value)) {
      fail('ACQUISITION_SECRET_REJECTED', `${name} contains prohibited source material`)
    }
    return value
  }
  if (!value || typeof value !== 'object') return value
  if (state.seen.has(value)) fail('ACQUISITION_SECRET_REJECTED', `${name} contains a cycle`)
  state.seen.add(value)
  try {
    const entries = Array.isArray(value) ? value.map((child, index) => [String(index), child]) : Object.entries(value)
    if (entries.length > 128) fail('ACQUISITION_SECRET_REJECTED', `${name} exceeds its bounds`)
    for (const [key, child] of entries) {
      if (!Array.isArray(value)) {
        const compact = key.replaceAll('-', '').replaceAll('_', '').toLowerCase()
        if (SENSITIVE_FIELD.test(compact)) fail('ACQUISITION_SECRET_REJECTED', `${name} contains prohibited field ${key}`)
      }
      assertNoPrivateSourceMaterial(child, name, depth + 1, state)
    }
  } finally {
    state.seen.delete(value)
  }
  return value
}

export function normalizePublicTitle (value, code = 'ACQUISITION_JOB_INVALID') {
  return value == null ? null : text(value, 'title', 512, { code, title: true })
}

export function normalizeAcquisitionRequest (input) {
  const privateChecked = input && typeof input === 'object'
    ? { ...input }
    : input
  if (privateChecked && typeof privateChecked === 'object') delete privateChecked.sourceFileName
  assertNoPrivateSourceMaterial(privateChecked, 'acquisition request')
  onlyFields(input, REQUEST_FIELDS, 'request', 'ACQUISITION_REQUEST_INVALID')
  if (input.schemaVersion !== ACQUISITION_SCHEMA_VERSION) fail('ACQUISITION_REQUEST_INVALID', 'schemaVersion must be 1')
  if (!RETENTION_CLASSES.has(input.retentionClass)) fail('ACQUISITION_REQUEST_INVALID', 'retentionClass is invalid')
  const result = {
    schemaVersion: ACQUISITION_SCHEMA_VERSION,
    resolutionRef: text(input.resolutionRef, 'resolutionRef', 43, { pattern: RESOLUTION_REF }),
    publisherId: text(input.publisherId, 'publisherId', 128, { pattern: ID }),
    retentionClass: input.retentionClass
  }
  if (input.retentionUntil !== undefined) result.retentionUntil = uint(input.retentionUntil, 'retentionUntil')
  if (input.sourceFileName !== undefined && input.sourceFileName !== null) {
    result.sourceFileName = text(input.sourceFileName, 'sourceFileName', 255, {
      pattern: SOURCE_FILE_NAME,
      code: 'ACQUISITION_REQUEST_INVALID',
      allowLocator: true
    })
  }
  return Object.freeze(result)
}

function canonicalize (value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function canonicalAcquisitionRequest (request) {
  return canonicalize(normalizeAcquisitionRequest(request))
}

function hashHex (domain, value) {
  return b4a.toString(crypto.hash(b4a.from(`${domain}\u0000${value}`)), 'hex')
}

export function fingerprintAcquisitionRequest (request) {
  return hashHex('peartube.acquisition.request.v1', canonicalAcquisitionRequest(request))
}

function idempotencyKey (value) {
  return text(value, 'idempotencyKey', 128, { pattern: ID, code: 'IDEMPOTENCY_KEY_INVALID' })
}

export function acquisitionIdForRequest ({ principal, idempotencyKey: key, request } = {}) {
  const principalId = normalizePrincipalId(principal)
  const normalized = normalizeAcquisitionRequest(request)
  const fingerprint = fingerprintAcquisitionRequest(normalized)
  return `acq_${hashHex('peartube.acquisition.id.v1', `${principalId}\u0000${normalized.publisherId}\u0000${idempotencyKey(key)}\u0000${fingerprint}`).slice(0, 32)}`
}

export function idempotencyDigestFor ({ principal, publisherId, idempotencyKey: key } = {}) {
  const principalId = normalizePrincipalId(principal)
  const publisher = text(publisherId, 'publisherId', 128, { pattern: ID })
  return hashHex('peartube.acquisition.idempotency.v1', `${principalId}\u0000${publisher}\u0000${idempotencyKey(key)}`)
}

function nullableIdentifier (value, name) {
  return value == null ? null : text(value, name, 128, { pattern: ID, code: 'ACQUISITION_JOB_INVALID' })
}

// A media coordinate is either a bounded label or a non-negative ordinal, and
// nothing else may ride along. The whitelist is the same one the durable store
// enforces, so a projection can never widen what persistence accepted.
export function normalizePublicMediaContext (input, code = 'ACQUISITION_JOB_INVALID') {
  if (input == null) return null
  if (typeof input !== 'object' || Array.isArray(input)) fail(code, 'mediaContext is invalid')
  const result = {}
  for (const [key, value] of Object.entries(input)) {
    if (!PUBLICATION_MEDIA_FIELDS.has(key)) fail(code, `mediaContext field ${key} is not permitted`)
    const entityIdentifier = key === 'identifier' || key === 'workEntityId'
    result[key] = key === 'season' || key === 'episode' || key === 'releaseYear'
      ? uint(value, `mediaContext.${key}`, { code })
      : text(value, `mediaContext.${key}`, entityIdentifier ? 128 : 512, {
          code,
          ...(entityIdentifier ? { pattern: ID, allowLocator: true } : {})
        })
  }
  return Object.keys(result).length === 0 ? null : Object.freeze(result)
}

function normalizePublicationTags (tagsInput, code) {
  if (tagsInput == null) return undefined
  if (!Array.isArray(tagsInput) || tagsInput.length > 24) fail(code, 'publication tags are invalid')
  const tags = new Set()
  for (const tag of tagsInput) {
    if (SENSITIVE_VALUE.test(tag)) fail(code, 'publication tag contains source material')
    tags.add(text(tag, 'tag', 80, { code }))
  }
  return Object.freeze([...tags])
}

function normalizeArtworkRoles (rolesInput, code) {
  if (rolesInput == null) return undefined
  if (!Array.isArray(rolesInput) ||
      rolesInput.length > ARTWORK_RENDITION_PURPOSES.size ||
      rolesInput.some(role => !ARTWORK_RENDITION_PURPOSES.has(role)) ||
      new Set(rolesInput).size !== rolesInput.length) {
    fail(code, 'publication artwork roles are invalid')
  }
  return Object.freeze([...rolesInput].sort())
}

export function normalizePublicationMetadata (input, code = 'ACQUISITION_JOB_INVALID') {
  if (input == null) return null
  onlyFields(input, PUBLICATION_METADATA_FIELDS, 'publication metadata', code)
  const output = {}
  if (Object.hasOwn(input, 'title')) output.title = normalizePublicTitle(input.title, code)
  if (Object.hasOwn(input, 'sourceFileName')) {
    output.sourceFileName = input.sourceFileName == null ? null : text(input.sourceFileName, 'sourceFileName', 255, {
      pattern: SOURCE_FILE_NAME, code, allowLocator: true
    })
  }
  if (Object.hasOwn(input, 'mediaContext')) output.mediaContext = normalizePublicMediaContext(input.mediaContext, code)
  for (const [field, maximum] of PUBLICATION_TEXT_LIMITS) {
    if (input[field] != null) {
      if (SENSITIVE_VALUE.test(input[field])) fail(code, 'publication metadata contains source material')
      output[field] = text(input[field], field, maximum, { code })
    }
  }
  if (input.tags != null) {
    output.tags = normalizePublicationTags(input.tags, code)
  }
  if (input.artworkRoles != null) {
    output.artworkRoles = normalizeArtworkRoles(input.artworkRoles, code)
  }
  if (input.duration != null) output.duration = uint(input.duration, 'duration', { minimum: 1, maximum: 10_000_000, code })
  return Object.freeze(output)
}

function validateAcquisitionJobInvariants (result) {
  if (typeof result.recoverable !== 'boolean') fail('ACQUISITION_JOB_INVALID', 'recoverable must be a boolean')
  if (result.bytesAcquired > result.expectedBytes) fail('ACQUISITION_JOB_INVALID', 'bytesAcquired exceeds expectedBytes')
  if (result.state === 'completed' && (!result.publicationId || !result.manifestId || !result.renditionId || !result.assetId)) {
    fail('ACQUISITION_JOB_INVALID', 'completed acquisition lacks immutable publication identifiers')
  }
  if (result.state === 'verified' && (result.publicationId || result.manifestId || result.renditionId || result.assetId)) {
    fail('ACQUISITION_JOB_INVALID', 'verified acquisition-only jobs must not carry publication identifiers')
  }
  if (result.state !== 'failed' && result.state !== 'cancelled' && result.errorCode !== null) {
    fail('ACQUISITION_JOB_INVALID', 'only failed or cancelled acquisitions may expose an errorCode')
  }
}

export function normalizeAcquisitionJob (input) {
  onlyFields(input, PUBLIC_JOB_FIELDS, 'acquisition job', 'ACQUISITION_JOB_INVALID')
  if (input.schemaVersion !== ACQUISITION_SCHEMA_VERSION) fail('ACQUISITION_JOB_INVALID', 'schemaVersion must be 1')
  if (!STATES.has(input.state)) fail('ACQUISITION_JOB_INVALID', 'state is invalid')
  if (!RETENTION_CLASSES.has(input.retentionClass)) fail('ACQUISITION_JOB_INVALID', 'retentionClass is invalid')
  const result = {
    schemaVersion: ACQUISITION_SCHEMA_VERSION,
    acquisitionId: text(input.acquisitionId, 'acquisitionId', 128, { pattern: ID, code: 'ACQUISITION_JOB_INVALID' }),
    state: input.state,
    retentionClass: input.retentionClass,
    title: normalizePublicTitle(input.title),
    sourceFileName: input.sourceFileName == null
      ? null
      : text(input.sourceFileName, 'sourceFileName', 255, { pattern: SOURCE_FILE_NAME, code: 'ACQUISITION_JOB_INVALID', allowLocator: true }),
    mediaContext: normalizePublicMediaContext(input.mediaContext),
    bytesAcquired: uint(input.bytesAcquired, 'bytesAcquired', { maximum: MAX_ACQUISITION_BYTES, code: 'ACQUISITION_JOB_INVALID' }),
    expectedBytes: uint(input.expectedBytes, 'expectedBytes', { minimum: 1, maximum: MAX_ACQUISITION_BYTES, code: 'ACQUISITION_JOB_INVALID' }),
    publicationId: nullableIdentifier(input.publicationId, 'publicationId'),
    manifestId: nullableIdentifier(input.manifestId, 'manifestId'),
    renditionId: nullableIdentifier(input.renditionId, 'renditionId'),
    assetId: nullableIdentifier(input.assetId, 'assetId'),
    errorCode: input.errorCode == null ? null : text(input.errorCode, 'errorCode', 64, { pattern: ERROR_CODE, code: 'ACQUISITION_JOB_INVALID' }),
    recoverable: input.recoverable,
    createdAt: uint(input.createdAt, 'createdAt', { code: 'ACQUISITION_JOB_INVALID' }),
    updatedAt: uint(input.updatedAt, 'updatedAt', { code: 'ACQUISITION_JOB_INVALID' })
  }
  validateAcquisitionJobInvariants(result)
  assertNoPrivateSourceMaterial({ ...result, title: null, sourceFileName: null, mediaContext: null }, 'public acquisition job')
  return Object.freeze(result)
}

function publicMetadataOf (job) {
  const metadata = job?.publicationMetadata || {}
  return {
    title: metadata.title ?? null,
    sourceFileName: metadata.sourceFileName ?? null,
    mediaContext: metadata.mediaContext ?? null
  }
}

function publicPublicationOf (job) {
  const publication = job?.publication || {}
  return {
    publicationId: publication.publicationId ?? null,
    manifestId: publication.manifestId ?? null,
    renditionId: publication.renditionId ?? null,
    assetId: publication.assetId ?? null
  }
}

export function projectAcquisitionJob (job) {
  return normalizeAcquisitionJob({
    schemaVersion: ACQUISITION_SCHEMA_VERSION,
    acquisitionId: job?.acquisitionId,
    state: job?.state,
    retentionClass: job?.retentionClass,
    ...publicMetadataOf(job),
    bytesAcquired: job?.bytesAcquired,
    expectedBytes: job?.expectedBytes,
    ...publicPublicationOf(job),
    errorCode: job?.errorCode ?? null,
    recoverable: job?.recoverable === true,
    createdAt: job?.createdAt,
    updatedAt: job?.updatedAt
  })
}

export function normalizeAcquisitionEvent (input) {
  onlyFields(input, EVENT_FIELDS, 'acquisition event', 'ACQUISITION_EVENT_INVALID')
  if (input.schemaVersion !== ACQUISITION_SCHEMA_VERSION) fail('ACQUISITION_EVENT_INVALID', 'schemaVersion must be 1')
  if (!EVENT_TYPES.has(input.type)) fail('ACQUISITION_EVENT_INVALID', 'event type is invalid')
  if (!STATES.has(input.state)) fail('ACQUISITION_EVENT_INVALID', 'event state is invalid')
  const result = {
    schemaVersion: ACQUISITION_SCHEMA_VERSION,
    eventId: text(input.eventId, 'eventId', 256, { code: 'ACQUISITION_EVENT_INVALID' }),
    acquisitionId: text(input.acquisitionId, 'acquisitionId', 128, { pattern: ID, code: 'ACQUISITION_EVENT_INVALID' }),
    type: input.type,
    state: input.state,
    sequence: uint(input.sequence, 'sequence', { code: 'ACQUISITION_EVENT_INVALID' }),
    at: uint(input.at, 'at', { code: 'ACQUISITION_EVENT_INVALID' }),
    bytesAcquired: uint(input.bytesAcquired, 'bytesAcquired', { maximum: MAX_ACQUISITION_BYTES, code: 'ACQUISITION_EVENT_INVALID' }),
    expectedBytes: uint(input.expectedBytes, 'expectedBytes', { minimum: 1, maximum: MAX_ACQUISITION_BYTES, code: 'ACQUISITION_EVENT_INVALID' }),
    errorCode: input.errorCode == null ? null : text(input.errorCode, 'errorCode', 64, { pattern: ERROR_CODE, code: 'ACQUISITION_EVENT_INVALID' }),
    publicationId: nullableIdentifier(input.publicationId, 'publicationId')
  }
  if (result.bytesAcquired > result.expectedBytes) fail('ACQUISITION_EVENT_INVALID', 'bytesAcquired exceeds expectedBytes')
  assertNoPrivateSourceMaterial(result, 'public acquisition event')
  return Object.freeze(result)
}

export function acquisitionEventForJob (job, type, sequence = job.version) {
  return normalizeAcquisitionEvent({
    schemaVersion: ACQUISITION_SCHEMA_VERSION,
    eventId: `${job.acquisitionId}:${sequence}`,
    acquisitionId: job.acquisitionId,
    type,
    state: job.state,
    sequence,
    at: job.updatedAt,
    bytesAcquired: job.bytesAcquired,
    expectedBytes: job.expectedBytes,
    errorCode: job.errorCode ?? null,
    publicationId: job.publication?.publicationId ?? null
  })
}

export const COORDINATION_ROLES = Object.freeze(['requester', 'worker'])
export const COORDINATION_PHASES = Object.freeze([
  'requested',
  'assigned',
  'acquiring',
  'verifying',
  'result-ready',
  'completed',
  'cancelled',
  'failed'
])
const HEX64 = /^[0-9a-f]{64}$/
const MAX_SUPERSEDED_REQUEST_IDS = 8
const COORDINATION_OUTPUT_PURPOSE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const COORDINATION_FORMAT = /^[A-Za-z0-9][A-Za-z0-9!#$&^_./+-]{0,63}$/

function normalizeCoordinationBudget (input, code = 'COORDINATION_RECORD_INVALID') {
  if (input == null) return null
  if (!isObject(input)) fail(code, 'budget must be an object')
  return Object.freeze({
    maxSourceBytes: uint(input.maxSourceBytes, 'budget.maxSourceBytes', { minimum: 1, code }),
    maxOutputBytes: uint(input.maxOutputBytes, 'budget.maxOutputBytes', { minimum: 1, code }),
    maxNetworkBytes: uint(input.maxNetworkBytes, 'budget.maxNetworkBytes', { minimum: 1, code }),
    maxWallClockMs: uint(input.maxWallClockMs, 'budget.maxWallClockMs', { minimum: 1, code })
  })
}

function normalizeCoordinationOutput (input, code = 'COORDINATION_RECORD_INVALID') {
  if (input == null) return null
  if (!isObject(input)) fail(code, 'output must be an object')
  if (!Array.isArray(input.formats) || input.formats.length < 1 || input.formats.length > 8) {
    fail(code, 'output.formats must be a bounded nonempty array')
  }
  const formats = Object.freeze(input.formats.map((format, index) =>
    text(format, `output.formats[${index}]`, 64, { pattern: COORDINATION_FORMAT, code })))
  if (new Set(formats).size !== formats.length) fail(code, 'output.formats must be distinct')
  const sorted = [...formats].sort()
  if (formats.some((format, index) => format !== sorted[index])) fail(code, 'output.formats must be sorted')
  return Object.freeze({
    purpose: text(input.purpose, 'output.purpose', 64, { pattern: COORDINATION_OUTPUT_PURPOSE, code }),
    formats
  })
}

function normalizeSupersededRequestIds (input, code = 'COORDINATION_RECORD_INVALID') {
  if (input == null) return Object.freeze([])
  if (!Array.isArray(input) || input.length > MAX_SUPERSEDED_REQUEST_IDS) {
    fail(code, `supersededRequestIds must be an array of at most ${MAX_SUPERSEDED_REQUEST_IDS}`)
  }
  const ids = input.map((value, index) =>
    text(value, `supersededRequestIds[${index}]`, 64, { pattern: HEX64, code }))
  if (new Set(ids).size !== ids.length) fail(code, 'supersededRequestIds must be distinct')
  return Object.freeze(ids)
}

/**
 * Canonical non-secret request intent used to re-sign envelopes after crash.
 * Never carries grant credentials, raw origin URLs, nonces, or signatures.
 */
export function normalizeRequestIntent (input, code = 'COORDINATION_RECORD_INVALID') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(code, 'request intent must be an object')
  }
  assertNoPrivateSourceMaterial(input, 'request intent')
  const sourceRef = text(input.sourceRef, 'sourceRef', 43, { pattern: RESOLUTION_REF, code })
  const publisherId = text(input.publisherId, 'publisherId', 64, { pattern: HEX64, code })
  const publicationIntentDigest = text(input.publicationIntentDigest, 'publicationIntentDigest', 64, { pattern: HEX64, code })
  const budget = normalizeCoordinationBudget(input.budget, code)
  const output = normalizeCoordinationOutput(input.output, code)
  if (!budget) fail(code, 'request intent budget is required')
  if (!output) fail(code, 'request intent output is required')
  const generation = uint(input.generation ?? input.epoch, 'generation', { minimum: 0, code })
  const resultHoldUntil = uint(input.resultHoldUntil, 'resultHoldUntil', { minimum: 1, code })
  const deadline = input.deadline == null
    ? null
    : uint(input.deadline, 'deadline', { minimum: 1, code })
  return Object.freeze({
    sourceRef,
    publisherId,
    publicationIntentDigest,
    budget,
    output,
    generation,
    resultHoldUntil,
    deadline
  })
}

export function requestIntentFromCoordination (record) {
  if (!record) return null
  if (record.sourceRef == null || record.publisherId == null || record.publicationIntentDigest == null) return null
  if (record.budget == null || record.output == null || record.resultHoldUntil == null) return null
  return normalizeRequestIntent({
    sourceRef: record.sourceRef,
    publisherId: record.publisherId,
    publicationIntentDigest: record.publicationIntentDigest,
    budget: record.budget,
    output: record.output,
    generation: record.requestGeneration ?? record.epoch,
    resultHoldUntil: record.resultHoldUntil,
    deadline: record.deadline
  })
}

function validateCoordinationRequirements (input, fields) {
  if (input.role === 'requester' && input.phase === 'requested') {
    // Crash recovery of an open request requires the full non-secret intent.
    if (!fields.sourceRef || !fields.publisherId || !fields.publicationIntentDigest || !fields.budget || !fields.output || fields.resultHoldUntil == null) {
      fail('COORDINATION_RECORD_INVALID', 'requested-phase coordination requires durable request intent')
    }
  }
  if (fields.assignmentId != null) {
    // Assigned work must name both application authorities and exact negotiated budget
    // so post-restart result validation can bind acquirerId without MAX_SAFE_INTEGER fillers.
    if (!fields.requesterId || !fields.acquirerId || !fields.peerId || !fields.budget || fields.resultHoldUntil == null || !fields.publisherId || !fields.publicationIntentDigest) {
      fail('COORDINATION_RECORD_INVALID', 'assigned coordination requires durable assignment identities and budget')
    }
  }
}

function normalizeCoordinationProgress (progressInput) {
  if (progressInput == null) return null
  if (typeof progressInput !== 'object' || Array.isArray(progressInput)) {
    fail('COORDINATION_RECORD_INVALID', 'progress must be an object')
  }
  return Object.freeze({
    sequence: uint(progressInput.sequence, 'progress.sequence', { minimum: 1, code: 'COORDINATION_RECORD_INVALID' }),
    phase: text(progressInput.phase, 'progress.phase', 32, { code: 'COORDINATION_RECORD_INVALID' }),
    sourceBytes: uint(progressInput.sourceBytes, 'progress.sourceBytes', { code: 'COORDINATION_RECORD_INVALID' }),
    outputBytes: uint(progressInput.outputBytes, 'progress.outputBytes', { code: 'COORDINATION_RECORD_INVALID' }),
    verifiedBlocks: uint(progressInput.verifiedBlocks, 'progress.verifiedBlocks', { code: 'COORDINATION_RECORD_INVALID' }),
    totalBlocks: uint(progressInput.totalBlocks, 'progress.totalBlocks', { code: 'COORDINATION_RECORD_INVALID' }),
    observedAt: uint(progressInput.observedAt, 'progress.observedAt', { minimum: 1, code: 'COORDINATION_RECORD_INVALID' }),
    errorCode: progressInput.errorCode == null ? null : text(progressInput.errorCode, 'progress.errorCode', 64, { pattern: ERROR_CODE, code: 'COORDINATION_RECORD_INVALID' })
  })
}

function normalizeCoordinationAsset (asset, idx) {
  if (!asset || typeof asset !== 'object') fail('COORDINATION_RECORD_INVALID', `asset ${idx} must be an object`)
  return Object.freeze({
    purpose: text(asset.purpose, `assets[${idx}].purpose`, 64, { code: 'COORDINATION_RECORD_INVALID' }),
    format: text(asset.format, `assets[${idx}].format`, 64, { code: 'COORDINATION_RECORD_INVALID' }),
    renditionId: text(asset.renditionId, `assets[${idx}].renditionId`, 64, { pattern: HEX64, code: 'COORDINATION_RECORD_INVALID' }),
    core: Object.freeze({
      kind: text(asset.core?.kind, `assets[${idx}].core.kind`, 64, { code: 'COORDINATION_RECORD_INVALID' }),
      key: text(asset.core?.key, `assets[${idx}].core.key`, 64, { pattern: HEX64, code: 'COORDINATION_RECORD_INVALID' }),
      assetId: text(asset.core?.assetId, `assets[${idx}].core.assetId`, 64, { pattern: HEX64, code: 'COORDINATION_RECORD_INVALID' }),
      treeHash: text(asset.core?.treeHash, `assets[${idx}].core.treeHash`, 64, { pattern: HEX64, code: 'COORDINATION_RECORD_INVALID' }),
      length: uint(asset.core?.length, `assets[${idx}].core.length`, { minimum: 1, code: 'COORDINATION_RECORD_INVALID' }),
      byteLength: uint(asset.core?.byteLength, `assets[${idx}].core.byteLength`, { minimum: 1, code: 'COORDINATION_RECORD_INVALID' }),
      blockSize: uint(asset.core?.blockSize, `assets[${idx}].core.blockSize`, { minimum: 1, code: 'COORDINATION_RECORD_INVALID' })
    })
  })
}

function normalizeCoordinationResult (resultInput) {
  if (resultInput == null) return null
  if (typeof resultInput !== 'object' || Array.isArray(resultInput)) {
    fail('COORDINATION_RECORD_INVALID', 'result must be an object')
  }
  const completedAt = uint(resultInput.completedAt, 'result.completedAt', { minimum: 1, code: 'COORDINATION_RECORD_INVALID' })
  const availabilityUntil = uint(resultInput.availabilityUntil, 'result.availabilityUntil', { minimum: completedAt, code: 'COORDINATION_RECORD_INVALID' })
  const acquiredBytes = uint(resultInput.acquiredBytes, 'result.acquiredBytes', { minimum: 1, code: 'COORDINATION_RECORD_INVALID' })
  let sourceIdentity = null
  if (resultInput.sourceIdentity != null) {
    if (!['sha256', 'etag'].includes(resultInput.sourceIdentity.kind)) fail('COORDINATION_RECORD_INVALID', 'sourceIdentity.kind is invalid')
    sourceIdentity = Object.freeze({
      kind: resultInput.sourceIdentity.kind,
      value: text(resultInput.sourceIdentity.value, 'sourceIdentity.value', 64, { pattern: HEX64, code: 'COORDINATION_RECORD_INVALID' })
    })
  }
  const assets = Array.isArray(resultInput.assets)
    ? Object.freeze(resultInput.assets.map(normalizeCoordinationAsset))
    : Object.freeze([])
  return Object.freeze({
    acquiredBytes,
    completedAt,
    availabilityUntil,
    sourceIdentity,
    assets
  })
}

function normalizeCoordinationError (errorInput) {
  if (errorInput == null) return null
  if (typeof errorInput !== 'object' || Array.isArray(errorInput)) {
    fail('COORDINATION_RECORD_INVALID', 'error must be an object')
  }
  return Object.freeze({
    code: text(errorInput.code, 'error.code', 64, { pattern: ERROR_CODE, code: 'COORDINATION_RECORD_INVALID' }),
    message: text(errorInput.message, 'error.message', 255, { code: 'COORDINATION_RECORD_INVALID' })
  })
}

export function normalizeCoordinationRecord (input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('COORDINATION_RECORD_INVALID', 'coordination record must be an object')
  }
  assertNoPrivateSourceMaterial(input, 'coordination record')
  if (input.schemaVersion !== 1) fail('COORDINATION_RECORD_INVALID', 'schemaVersion must be 1')
  const acquisitionId = text(input.acquisitionId, 'acquisitionId', 128, { pattern: ID, code: 'COORDINATION_RECORD_INVALID' })
  if (!COORDINATION_ROLES.includes(input.role)) fail('COORDINATION_RECORD_INVALID', 'role must be requester or worker')
  if (!COORDINATION_PHASES.includes(input.phase)) fail('COORDINATION_RECORD_INVALID', 'phase is invalid')
  const requestId = text(input.requestId, 'requestId', 64, { pattern: HEX64, code: 'COORDINATION_RECORD_INVALID' })
  const offerId = input.offerId == null ? null : text(input.offerId, 'offerId', 64, { pattern: HEX64, code: 'COORDINATION_RECORD_INVALID' })
  const assignmentId = input.assignmentId == null ? null : text(input.assignmentId, 'assignmentId', 64, { pattern: HEX64, code: 'COORDINATION_RECORD_INVALID' })
  const peerId = input.peerId == null ? null : text(input.peerId, 'peerId', 64, { pattern: HEX64, code: 'COORDINATION_RECORD_INVALID' })
  const requesterId = input.requesterId == null ? null : text(input.requesterId, 'requesterId', 64, { pattern: HEX64, code: 'COORDINATION_RECORD_INVALID' })
  const acquirerId = input.acquirerId == null ? null : text(input.acquirerId, 'acquirerId', 64, { pattern: HEX64, code: 'COORDINATION_RECORD_INVALID' })
  const sourceRef = input.sourceRef == null ? null : text(input.sourceRef, 'sourceRef', 43, { pattern: RESOLUTION_REF, code: 'COORDINATION_RECORD_INVALID' })
  const publisherId = input.publisherId == null ? null : text(input.publisherId, 'publisherId', 64, { pattern: HEX64, code: 'COORDINATION_RECORD_INVALID' })
  const publicationIntentDigest = input.publicationIntentDigest == null
    ? null
    : text(input.publicationIntentDigest, 'publicationIntentDigest', 64, { pattern: HEX64, code: 'COORDINATION_RECORD_INVALID' })
  const budget = normalizeCoordinationBudget(input.budget)
  const output = normalizeCoordinationOutput(input.output)
  const resultHoldUntil = input.resultHoldUntil == null
    ? null
    : uint(input.resultHoldUntil, 'resultHoldUntil', { minimum: 1, code: 'COORDINATION_RECORD_INVALID' })
  const supersededRequestIds = normalizeSupersededRequestIds(input.supersededRequestIds)
  const epoch = uint(input.epoch, 'epoch', { minimum: 0, code: 'COORDINATION_RECORD_INVALID' })
  // Request generation is the requester's local policy revision. It is kept
  // separately from epoch, which becomes the worker's negotiated policy epoch
  // once an offer is assigned. Legacy requester records used epoch for both
  // values while peers incorrectly shared one revision, so that is a safe
  // restart migration fallback for records without the appended field.
  const requestGeneration = input.requestGeneration == null
    ? (input.role === 'requester' ? epoch : null)
    : uint(input.requestGeneration, 'requestGeneration', { minimum: 0, code: 'COORDINATION_RECORD_INVALID' })
  const deadline = uint(input.deadline, 'deadline', { minimum: 1, code: 'COORDINATION_RECORD_INVALID' })
  const createdAt = uint(input.createdAt, 'createdAt', { minimum: 1, code: 'COORDINATION_RECORD_INVALID' })
  const updatedAt = uint(input.updatedAt, 'updatedAt', { minimum: 1, code: 'COORDINATION_RECORD_INVALID' })

  validateCoordinationRequirements(input, {
    sourceRef,
    publisherId,
    publicationIntentDigest,
    budget,
    output,
    resultHoldUntil,
    assignmentId,
    requesterId,
    acquirerId,
    peerId,
  })

  const progress = normalizeCoordinationProgress(input.progress)
  const result = normalizeCoordinationResult(input.result)
  const error = normalizeCoordinationError(input.error)

  return Object.freeze({
    schemaVersion: 1,
    acquisitionId,
    role: input.role,
    phase: input.phase,
    requestId,
    offerId,
    assignmentId,
    peerId,
    requesterId,
    acquirerId,
    sourceRef,
    publisherId,
    publicationIntentDigest,
    budget,
    output,
    resultHoldUntil,
    supersededRequestIds,
    requestGeneration,
    epoch,
    deadline,
    progress,
    result,
    error,
    createdAt,
    updatedAt
  })
}
