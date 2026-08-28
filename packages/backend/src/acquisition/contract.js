import b4a from 'b4a'
import crypto from 'hypercore-crypto'

export const ACQUISITION_SCHEMA_VERSION = 1
export const MAX_ACQUISITION_BYTES = 500 * 1024 * 1024 * 1024
export const ACQUISITION_STATES = Object.freeze([
  'queued',
  'acquiring',
  'verifying',
  'publishing',
  'completed',
  'failed',
  'cancelled'
])
export const TERMINAL_ACQUISITION_STATES = Object.freeze(['completed', 'failed', 'cancelled'])
export const ACQUISITION_EVENT_TYPES = Object.freeze([
  'acquisition.queued',
  'acquisition.acquiring',
  'acquisition.verifying',
  'acquisition.publishing',
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

function text (value, name, maxBytes, { pattern = null, code = 'ACQUISITION_REQUEST_INVALID', nullable = false } = {}) {
  if (value == null && nullable) return null
  if (typeof value !== 'string' || value !== value.normalize('NFC') || value !== value.trim() || !value ||
      b4a.byteLength(value) > maxBytes || containsControlCharacter(value) || LOCATOR.test(value) || (pattern && !pattern.test(value))) {
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

export function normalizeAcquisitionRequest (input) {
  assertNoPrivateSourceMaterial(input, 'acquisition request')
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
    result.sourceFileName = text(input.sourceFileName, 'sourceFileName', 255, { pattern: SOURCE_FILE_NAME, code: 'ACQUISITION_REQUEST_INVALID' })
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
    result[key] = typeof value === 'string'
      ? text(value, `mediaContext.${key}`, 512, { code })
      : uint(value, `mediaContext.${key}`, { code })
  }
  return Object.keys(result).length === 0 ? null : Object.freeze(result)
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
    title: input.title == null ? null : text(input.title, 'title', 512, { code: 'ACQUISITION_JOB_INVALID' }),
    sourceFileName: input.sourceFileName == null
      ? null
      : text(input.sourceFileName, 'sourceFileName', 255, { pattern: SOURCE_FILE_NAME, code: 'ACQUISITION_JOB_INVALID' }),
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
  if (typeof result.recoverable !== 'boolean') fail('ACQUISITION_JOB_INVALID', 'recoverable must be a boolean')
  if (result.bytesAcquired > result.expectedBytes) fail('ACQUISITION_JOB_INVALID', 'bytesAcquired exceeds expectedBytes')
  if (result.state === 'completed' && (!result.publicationId || !result.manifestId || !result.renditionId || !result.assetId)) {
    fail('ACQUISITION_JOB_INVALID', 'completed acquisition lacks immutable publication identifiers')
  }
  if (result.state !== 'failed' && result.state !== 'cancelled' && result.errorCode !== null) {
    fail('ACQUISITION_JOB_INVALID', 'only failed or cancelled acquisitions may expose an errorCode')
  }
  assertNoPrivateSourceMaterial(result, 'public acquisition job')
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
