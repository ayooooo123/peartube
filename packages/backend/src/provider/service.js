import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { normalizePublicMediaContext, normalizePublicationMetadata, PUBLICATION_ENRICHMENT_FIELDS } from '../acquisition/contract.js'
import { episodeWorkIdentifier } from '../channel/structured-content.js'
import {
  PROVIDER_ERROR_CODES,
  ProviderError,
  mapProviderError,
  providerError,
} from './errors.js'

const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/
const PUBLISHER_ID = /^[0-9a-f]{64}$/
const ACQUISITION_CURSOR = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const PUBLIC_ACQUISITION_STATES = new Set([
  'queued',
  'acquiring',
  'verifying',
  'publishing',
  'completed',
  'failed',
  'cancelled',
])
const ACTIVE_ACQUISITION_STATES = Object.freeze([
  'queued',
  'acquiring',
  'verifying',
  'publishing',
])
const RETENTION_CLASSES = new Set(['contribution-cache', 'archive-pin'])
const SENSITIVE_POLICY_FIELD = /(?:authorization|cookie|credential|header|locator|password|path|secret|source(?:ref(?:erence)?|url)|token|url|uri)/i
const PROVIDER_INTERNALS = new WeakMap()

export function issueLocalProviderResolution(providerService, input) {
  const internals = PROVIDER_INTERNALS.get(providerService)
  if (!internals) throw new TypeError('providerService is not a local ProviderService instance')
  return internals.issueLocalResolution(input)
}
const DEFAULT_REFERENCE_LEASE_MS = 6 * 60_000
const DEFAULT_CURSOR_LEASE_MS = 3 * 60_000
const DEFAULT_MAX_LEASES = 369
const MAX_SEARCH_RESULTS = 64
const MAX_TEXT_BYTES = 512
const MAX_IDEMPOTENCY_KEY_BYTES = 256
const MAX_POLICY_DEPTH = 6
const MAX_POLICY_FIELDS = 144
const LOCAL_RESOLUTION_OPTIONAL = Object.freeze([
  'idempotencyKey',
  'sourceFileName',
  'description',
  'tags',
  'creatorName',
  'creatorHandle',
  'duration',
  'artworkRoles',
])
function fail(code, message, options) {
  throw providerError(code, message, options)
}

function object(value, name, field = name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(PROVIDER_ERROR_CODES.INVALID_FIELD, `${name} must be an object`, { field })
  }
  return value
}

function exactFields(value, required, optional, name) {
  object(value, name)
  const allowed = new Set([...required, ...optional])
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) fail(PROVIDER_ERROR_CODES.INVALID_FIELD, `${name}.${field} is unsupported`, { field })
  }
  for (const field of required) {
    if (!Object.hasOwn(value, field)) fail(PROVIDER_ERROR_CODES.INVALID_FIELD, `${name}.${field} is required`, { field })
  }
  return value
}

function text(value, name, maximum = MAX_TEXT_BYTES, { nullable = false } = {}) {
  if (value === null && nullable) return null
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.normalize('NFC') !== value ||
    b4a.byteLength(value) > maximum ||
    /\p{Cc}/u.test(value)
  ) fail(PROVIDER_ERROR_CODES.INVALID_FIELD, `${name} must be bounded canonical text`, { field: name })
  return value
}

function nullableText(value, name, maximum = MAX_TEXT_BYTES) {
  return value == null ? null : text(value, name, maximum)
}

function uint(value, name, { nullable = false, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null && nullable) return null
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail(PROVIDER_ERROR_CODES.INVALID_FIELD, `${name} must be a bounded non-negative integer`, { field: name })
  }

  return value
}
function acquisitionCursor(value) {
  if (typeof value !== 'string' || !ACQUISITION_CURSOR.test(value)) {
    fail(PROVIDER_ERROR_CODES.INVALID_CURSOR, 'cursor is invalid', { field: 'cursor' })
  }
  return value
}

function opaqueToken(value, name, code = PROVIDER_ERROR_CODES.INVALID_FIELD) {
  if (typeof value !== 'string' || !OPAQUE_TOKEN.test(value)) fail(code, `${name} is invalid`, { field: name })
  return value
}

function normalizeSelector(value) {
  object(value, 'selector')
  const byTitle = Object.hasOwn(value, 'title')
  const episodic = value.kind === 'episode'
  if (byTitle) {
    exactFields(
      value,
      episodic ? ['title', 'kind', 'season', 'episode'] : ['title'],
      episodic ? ['year'] : ['kind', 'year'],
      'selector',
    )
  } else {
    exactFields(
      value,
      episodic ? ['namespace', 'identifier', 'kind', 'season', 'episode'] : ['namespace', 'identifier', 'kind'],
      [],
      'selector',
    )
  }
  const selector = byTitle
    ? {
        title: text(value.title, 'selector.title'),
        ...(value.kind ? { kind: text(value.kind, 'selector.kind', 64) } : {}),
        ...(value.year == null ? {} : { year: uint(value.year, 'selector.year') }),
      }
    : {
        namespace: text(value.namespace, 'selector.namespace', 64),
        identifier: text(value.identifier, 'selector.identifier'),
        kind: text(value.kind, 'selector.kind', 64),
      }
  if (episodic) {
    if (!Number.isSafeInteger(value.season) || value.season < 1) fail(PROVIDER_ERROR_CODES.INVALID_FIELD, 'selector.season is invalid', { field: 'season' })
    if (!Number.isSafeInteger(value.episode) || value.episode < 1) fail(PROVIDER_ERROR_CODES.INVALID_FIELD, 'selector.episode is invalid', { field: 'episode' })
    selector.season = value.season
    selector.episode = value.episode
  }
  return Object.freeze(selector)
}

function localSelector(selector) {
  if (selector.title) {
    const prefix = selector.title.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/u)?.[0]
    if (!prefix) fail(PROVIDER_ERROR_CODES.INVALID_FIELD, 'selector.title has no searchable token', { field: 'title' })
    return Object.freeze({ type: 'title-token-prefix', prefix })
  }
  return Object.freeze({
    type: 'exact-external-ref',
    namespace: selector.namespace,
    identifier: selector.kind === 'episode'
      ? episodeWorkIdentifier(selector.identifier, selector.season, selector.episode)
      : selector.identifier,
  })
}

function mediaContext(selector, candidate = null) {
  const context = selector.title
    ? { ...(selector.kind ? { kind: selector.kind } : {}), title: selector.title, ...(selector.year == null ? {} : { releaseYear: selector.year }) }
    : { kind: selector.kind, namespace: selector.namespace, identifier: selector.identifier }
  if (selector.kind === 'episode') {
    context.season = selector.season
    context.episode = selector.episode
  }
  const workEntityId = nullableText(candidate?.work?.entityId, 'work.entityId', 128)
  if (workEntityId !== null) context.workEntityId = workEntityId
  const releaseYear = candidate?.work?.releaseYear
  if (releaseYear !== undefined && releaseYear !== null) context.releaseYear = uint(releaseYear, 'work.releaseYear')
  return Object.freeze(context)
}

function base64url(bytes) {
  return b4a.toString(bytes, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function positiveLimit(value, fallback, maximum, name) {
  const normalized = value === undefined ? fallback : value
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > maximum) {
    fail(PROVIDER_ERROR_CODES.INVALID_FIELD, `${name} is outside its bound`, { field: name })
  }
  return normalized
}

function normalizePrincipal(value) {
  object(value, 'principal')
  const principalId = text(value.principalId ?? value.id, 'principal.principalId', 256)
  const publisherId = text(value.publisherId, 'principal.publisherId', 64)
  if (!PUBLISHER_ID.test(publisherId)) fail(PROVIDER_ERROR_CODES.INVALID_FIELD, 'principal.publisherId is invalid', { field: 'principal.publisherId' })
  return Object.freeze({ ...value, principalId, publisherId })
}

function normalizeAcquisitionRequest(value) {
  exactFields(
    value,
    ['schemaVersion', 'resolutionRef', 'publisherId', 'retentionClass'],
    ['retentionUntil', 'sourceFileName'],
    'request',
  )
  if (value.schemaVersion !== 1) fail(PROVIDER_ERROR_CODES.INVALID_FIELD, 'request.schemaVersion is invalid', { field: 'schemaVersion' })
  const publisherId = text(value.publisherId, 'request.publisherId', 64)
  if (!PUBLISHER_ID.test(publisherId)) fail(PROVIDER_ERROR_CODES.INVALID_FIELD, 'request.publisherId is invalid', { field: 'publisherId' })
  const retentionClass = text(value.retentionClass, 'request.retentionClass', 64)
  if (!RETENTION_CLASSES.has(retentionClass)) fail(PROVIDER_ERROR_CODES.INVALID_FIELD, 'request.retentionClass is invalid', { field: 'retentionClass' })
  return Object.freeze({
    schemaVersion: 1,
    resolutionRef: opaqueToken(value.resolutionRef, 'request.resolutionRef'),
    publisherId,
    retentionClass,
    ...(Object.hasOwn(value, 'retentionUntil') ? { retentionUntil: uint(value.retentionUntil, 'request.retentionUntil') } : {}),
    ...(Object.hasOwn(value, 'sourceFileName') && value.sourceFileName != null ? { sourceFileName: text(value.sourceFileName, 'request.sourceFileName', 255) } : {}),
  })
}

function publicAcquisition(value) {
  object(value, 'acquisition')
  if (value.schemaVersion !== 1) fail(PROVIDER_ERROR_CODES.ACQUISITION_UNAVAILABLE, 'Acquisition record version is unsupported')
  const state = text(value.state, 'acquisition.state', 32)
  if (!PUBLIC_ACQUISITION_STATES.has(state)) fail(PROVIDER_ERROR_CODES.ACQUISITION_UNAVAILABLE, 'Acquisition state is invalid')
  const retentionClass = text(value.retentionClass, 'acquisition.retentionClass', 64)
  if (!RETENTION_CLASSES.has(retentionClass)) fail(PROVIDER_ERROR_CODES.ACQUISITION_UNAVAILABLE, 'Acquisition retention class is invalid')
  return Object.freeze({
    schemaVersion: 1,
    acquisitionId: text(value.acquisitionId, 'acquisition.acquisitionId', 128),
    state,
    retentionClass,
    // An operator console names a transfer by its work, not by its job id. The
    // durable record already carries publisher metadata; refusing to project it
    // is what left every row reading `Acquisition ing_…`.
    title: nullableText(value.title, 'acquisition.title'),
    sourceFileName: nullableText(value.sourceFileName, 'acquisition.sourceFileName', 255),
    mediaContext: normalizePublicMediaContext(value.mediaContext),
    bytesAcquired: uint(value.bytesAcquired, 'acquisition.bytesAcquired'),
    expectedBytes: uint(value.expectedBytes, 'acquisition.expectedBytes'),
    publicationId: nullableText(value.publicationId, 'acquisition.publicationId', 128),
    manifestId: nullableText(value.manifestId, 'acquisition.manifestId', 128),
    renditionId: nullableText(value.renditionId, 'acquisition.renditionId', 128),
    assetId: nullableText(value.assetId, 'acquisition.assetId', 128),
    errorCode: nullableText(value.errorCode, 'acquisition.errorCode', 64),
    recoverable: Boolean(value.recoverable),
    createdAt: uint(value.createdAt, 'acquisition.createdAt'),
    updatedAt: uint(value.updatedAt, 'acquisition.updatedAt'),
  })
}

function publicAvailability(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const output = {}
  for (const field of ['peers', 'completeSeeders', 'observedAtMs', 'expiresAtMs']) {
    if (value[field] !== undefined && value[field] !== null) output[field] = uint(value[field], `availability.${field}`)
  }
  return Object.keys(output).length === 0 ? null : Object.freeze(output)
}

function publicRendition(value) {
  object(value, 'rendition')
  const core = value.core && typeof value.core === 'object' ? value.core : {}
  return Object.freeze({
    renditionId: text(value.renditionId, 'rendition.renditionId', 128),
    assetId: nullableText(core.assetId ?? value.assetId, 'rendition.assetId', 128),
    purpose: nullableText(value.purpose, 'rendition.purpose', 128),
    mimeType: nullableText(value.format ?? value.mimeType, 'rendition.mimeType', 128),
    byteLength: core.byteLength == null && value.byteLength == null
      ? null
      : uint(core.byteLength ?? value.byteLength, 'rendition.byteLength'),
  })
}

function publicPublicationRecord(record) {
  const publication = object(record.publication, 'publication')
  const manifest = object(record.manifest, 'manifest')
  const renditions = Array.isArray(manifest.body?.renditions) ? manifest.body.renditions : []
  return Object.freeze({
    schemaVersion: 1,
    publicationId: text(publication.publicationId, 'publication.publicationId', 128),
    publisherId: text(publication.publisherId ?? manifest.body?.publisherId, 'publication.publisherId', 128),
    manifestId: text(publication.manifestId ?? manifest.body?.manifestId, 'publication.manifestId', 128),
    workEntityId: nullableText(publication.workEntityId, 'publication.workEntityId', 128),
    title: nullableText(manifest.body?.title ?? publication.normalizedTitle ?? publication.title, 'publication.title'),
    sourceFileName: manifest.body?.sourceFileName == null
      ? null
      : text(manifest.body.sourceFileName, 'publication.sourceFileName', 255, { allowLocator: true }),
    renditions: Object.freeze(renditions.map(publicRendition)),
  })
}

function clonePublicPolicy(value, depth = 0, count = { value: 0 }) {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return text(value, 'policy value', 4096)
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) fail(PROVIDER_ERROR_CODES.POLICY_UNAVAILABLE, 'Policy contains an invalid number')
    return value
  }
  if (depth >= MAX_POLICY_DEPTH) fail(PROVIDER_ERROR_CODES.POLICY_UNAVAILABLE, 'Policy exceeds its depth bound')
  if (Array.isArray(value)) {
    if (value.length > MAX_POLICY_FIELDS) fail(PROVIDER_ERROR_CODES.POLICY_UNAVAILABLE, 'Policy exceeds its item bound')
    return Object.freeze(value.map(entry => clonePublicPolicy(entry, depth + 1, count)))
  }
  if (!value || typeof value !== 'object') fail(PROVIDER_ERROR_CODES.POLICY_UNAVAILABLE, 'Policy contains an unsupported value')
  const output = {}
  for (const [key, entry] of Object.entries(value)) {
    if (++count.value > MAX_POLICY_FIELDS) fail(PROVIDER_ERROR_CODES.POLICY_UNAVAILABLE, 'Policy exceeds its field bound')
    if (SENSITIVE_POLICY_FIELD.test(key)) fail(PROVIDER_ERROR_CODES.POLICY_UNAVAILABLE, 'Policy contains a private field')
    output[text(key, 'policy field', 128)] = clonePublicPolicy(entry, depth + 1, count)
  }
  return Object.freeze(output)
}

function publicStatus(value) {
  value = object(value, 'status')
  const output = {
    schemaVersion: 1,
    ready: Boolean(value.ready),
    searchAvailable: value.searchAvailable === undefined ? true : Boolean(value.searchAvailable),
    acquisitionAvailable: value.acquisitionAvailable === undefined ? true : Boolean(value.acquisitionAvailable),
    streamingAvailable: value.streamingAvailable === undefined ? true : Boolean(value.streamingAvailable),
  }
  for (const field of ['activeAcquisitions', 'queuedAcquisitions', 'updatedAt']) {
    if (value[field] !== undefined && value[field] !== null) output[field] = uint(value[field], `status.${field}`)
  }
  if (value.acquisitionsByState !== undefined && value.acquisitionsByState !== null) {
    object(value.acquisitionsByState, 'status.acquisitionsByState')
    output.acquisitionsByState = Object.freeze(Object.fromEntries(
      [...PUBLIC_ACQUISITION_STATES].map(state => [
        state,
        uint(value.acquisitionsByState[state] ?? 0, `status.acquisitionsByState.${state}`),
      ]),
    ))
  }
  return Object.freeze(output)
}

function publicStream(value, trusted) {
  value = object(value, 'stream')
  const output = {
    schemaVersion: 1,
    publicationId: trusted.publicationId,
    renditionId: trusted.renditionId,
    assetId: trusted.assetId,
    byteLength: trusted.byteLength,
    mimeType: trusted.mimeType,
    url: text(value.url, 'stream.url', 2048),
  }
  if (value.etag !== undefined && value.etag !== null) output.etag = text(value.etag, 'stream.etag', 256)
  return Object.freeze(output)
}

function candidateFacts(candidate, selector) {
  object(candidate, 'candidate')
  const publisherId = nullableText(candidate.publication?.publisherId, 'candidate.publication.publisherId', 128)
  const publicationId = nullableText(candidate.publication?.publicationId, 'candidate.publication.publicationId', 128)
  const renditionId = nullableText(candidate.rendition?.renditionId, 'candidate.rendition.renditionId', 128)
  const assetId = nullableText(candidate.asset?.assetId, 'candidate.asset.assetId', 128)
  const expectedBytesValue = candidate.rendition?.byteLength ?? candidate.asset?.byteLength
  return Object.freeze({
    title: nullableText(candidate.work?.title ?? candidate.publication?.title, 'candidate.title'),
    mediaContext: mediaContext(selector, candidate),
    publisherId,
    publicationId,
    renditionId,
    assetId,
    expectedBytes: expectedBytesValue == null ? null : uint(expectedBytesValue, 'candidate.expectedBytes'),
    availability: publicAvailability(candidate.availability),
  })
}

function queryFingerprint(selector) {
  return b4a.toString(crypto.hash(b4a.from(JSON.stringify(selector))), 'hex')
}
function textMatchesTokens(str, queryTokens) {
  if (!str || typeof str !== 'string') return false
  const targetTokens = str.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []
  if (targetTokens.length === 0) return false
  return queryTokens.every(qToken => targetTokens.some(tToken => tToken.startsWith(qToken)))
}

function matchExternalReference(job, selector) {
  const ctx = job.publicationMetadata?.mediaContext || job.mediaContext || null
  if (!ctx || ctx.namespace !== selector.namespace || ctx.identifier !== selector.identifier) {
    return false
  }
  if (selector.kind && ctx.kind && selector.kind !== ctx.kind) {
    return false
  }
  if (selector.season !== undefined && selector.season !== null) {
    if (ctx.season !== selector.season) return false
  } else if (ctx.season !== undefined && ctx.season !== null) {
    return false
  }
  if (selector.episode !== undefined && selector.episode !== null) {
    if (ctx.episode !== selector.episode) return false
  } else if (ctx.episode !== undefined && ctx.episode !== null) {
    return false
  }
  return true
}

function matchJobText(job, selector) {
  const queryTokens = selector.title ? selector.title.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [] : []
  if (queryTokens.length === 0) return false
  const title = job.publicationMetadata?.title || job.title || null
  const sourceFileName = job.request?.sourceFileName || job.publicationMetadata?.sourceFileName || job.sourceFileName || null
  return textMatchesTokens(title, queryTokens) || textMatchesTokens(sourceFileName, queryTokens)
}

function matchMediaContext(ctx, selector) {
  if (selector.kind && ctx?.kind && selector.kind !== ctx.kind) {
    return false
  }
  if (selector.season !== undefined && selector.season !== null) {
    if (ctx?.season !== undefined && ctx?.season !== null && ctx.season !== selector.season) return false
  }
  if (selector.episode !== undefined && selector.episode !== null) {
    if (ctx?.episode !== undefined && ctx?.episode !== null && ctx.episode !== selector.episode) return false
  }
  return true
}

function matchTitleSelector(job, selector) {
  if (!matchJobText(job, selector)) return false
  const ctx = job.publicationMetadata?.mediaContext || job.mediaContext || null
  return matchMediaContext(ctx, selector)
}

function requireAdapter(adapter, method, name) {
  if (!adapter || typeof adapter[method] !== 'function') throw new TypeError(`${name}.${method} is required`)
}
function requireAdapters(adapter, methods, name) {
  for (const method of methods) requireAdapter(adapter, method, name)
}

function requireOptionalAdapter(adapter, methods, name) {
  if (adapter === null) return
  if (typeof adapter === 'function') return
  if (methods.every(method => typeof adapter?.[method] === 'function')) return
  throw new TypeError(`${name} must implement ${methods.join(' or ')}`)
}

function validateProviderDependencies({ verifiedQueryView, indexVerificationRuntime, acquisitionManager, streamOpener, policy, acquisitionPolicy, publicationLookup, statusSource, now, randomBytes }) {
  requireAdapters(verifiedQueryView, ['query', 'getEntity', 'getPublication', 'getManifest', 'getRendition', 'authorizeRendition', 'isVisible'], 'verifiedQueryView')
  requireAdapters(indexVerificationRuntime, ['searchIndexCandidates', 'verifyIndexCandidate'], 'indexVerificationRuntime')
  requireAdapters(acquisitionManager, ['findRequest', 'request', 'attachGrant', 'get', 'list', 'cancel', 'migrateLegacyIngest'], 'acquisitionManager')
  requireOptionalAdapter(streamOpener, ['openStream'], 'streamOpener')
  requireOptionalAdapter(policy, ['getPolicy', 'setPolicy'], 'policy')
  requireOptionalAdapter(acquisitionPolicy, ['getPolicy', 'setPolicy'], 'acquisitionPolicy')
  requireOptionalAdapter(publicationLookup, ['getPublication'], 'publicationLookup')
  requireOptionalAdapter(statusSource, ['getStatus'], 'statusSource')
  if (typeof now !== 'function' || typeof randomBytes !== 'function') throw new TypeError('provider clock and entropy adapters are required')
}


export function createProviderService({
  verifiedQueryView,
  indexVerificationRuntime,
  acquisitionManager,
  streamOpener,
  policy = null,
  acquisitionPolicy = null,
  publicationLookup = null,
  statusSource = null,
  now = Date.now,
  randomBytes = crypto.randomBytes,
  limits = {},
} = {}) {
  validateProviderDependencies({
    verifiedQueryView,
    indexVerificationRuntime,
    acquisitionManager,
    streamOpener,
    policy,
    acquisitionPolicy,
    publicationLookup,
    statusSource,
    now,
    randomBytes,
  })

  const referenceLeaseMs = positiveLimit(limits.referenceLeaseMs, DEFAULT_REFERENCE_LEASE_MS, 6 * 60_000, 'referenceLeaseMs')
  const cursorLeaseMs = positiveLimit(limits.cursorLeaseMs, DEFAULT_CURSOR_LEASE_MS, 60 * 60_000, 'cursorLeaseMs')
  const maxReferences = positiveLimit(limits.maxReferences, DEFAULT_MAX_LEASES, 4096, 'maxReferences')
  const maxCursors = positiveLimit(limits.maxCursors, DEFAULT_MAX_LEASES, 4096, 'maxCursors')
  const references = new Map()
  const cursors = new Map()

  function currentTime() {
    const value = Number(now())
    if (!Number.isSafeInteger(value) || value < 0) fail(PROVIDER_ERROR_CODES.STATUS_UNAVAILABLE, 'Provider clock is invalid')
    return value
  }

  function prune(map, time = currentTime()) {
    for (const [token, record] of map) {
      if (record.inFlight || record.expiresAt > time) continue
      map.delete(token)
    }
  }

  function issue(map, maximum, record, avoidToken = null) {
    prune(map)
    if (map.size >= maximum) fail(PROVIDER_ERROR_CODES.PROVIDER_OVERLOADED, 'Provider lease capacity is exhausted', { retryable: true })
    for (let attempt = 0; attempt < 6; attempt++) {
      const bytes = b4a.from(randomBytes(32))
      if (bytes.byteLength !== 32) fail(PROVIDER_ERROR_CODES.STATUS_UNAVAILABLE, 'Provider entropy source is invalid')
      const token = base64url(bytes)
      if (token === avoidToken || map.has(token)) continue
      map.set(token, { ...record, inFlight: false })
      return token
    }
    fail(PROVIDER_ERROR_CODES.PROVIDER_OVERLOADED, 'Provider lease allocation failed', { retryable: true })
  }

  function localResolutionIdentity(record) {
    return {
      kind: record.kind,
      title: record.title,
      sourceFileName: record.sourceFileName ?? null,
      mediaContext: record.mediaContext ?? null,
      publisherId: record.publisherId ?? null,
      publicationId: record.publicationId ?? null,
      renditionId: record.renditionId ?? null,
      expectedBytes: record.expectedBytes ?? null,
      availability: record.availability ?? null,
      private: record.private ?? null,
    }
  }

  function localEnrichment(input) {
    const output = {}
    for (const field of PUBLICATION_ENRICHMENT_FIELDS) {
      if (input[field] != null) output[field] = input[field]
    }
    return normalizePublicationMetadata(output, PROVIDER_ERROR_CODES.INVALID_FIELD)
  }

  function issueReference(record, preferredRef = null) {
    const expiresAt = currentTime() + referenceLeaseMs
    if (preferredRef === null) {
      const ref = issue(references, maxReferences, { ...record, expiresAt })
      return { ref, expiresAt }
    }
    opaqueToken(preferredRef, 'local resolution ref')
    prune(references)
    const existing = references.get(preferredRef)
    if (existing) {
      const { expiresAt: ignored, ...existingRecord } = existing
      // Identity fields decide binding collisions. Enrichment (description/tags/
      // creatorName/...) may differ across entrypoints; first-bound wins.
      if (JSON.stringify(localResolutionIdentity(existingRecord)) !== JSON.stringify(localResolutionIdentity(record))) {
        fail(PROVIDER_ERROR_CODES.INVALID_FIELD, 'local resolution idempotency key is already bound')
      }
      references.set(preferredRef, Object.freeze({ ...existingRecord, expiresAt }))
      return { ref: preferredRef, expiresAt, record: existingRecord }
    }
    if (references.size >= maxReferences) {
      fail(PROVIDER_ERROR_CODES.PROVIDER_OVERLOADED, 'Provider lease capacity is exhausted', { retryable: true })
    }
    references.set(preferredRef, Object.freeze({ ...record, expiresAt }))
    return { ref: preferredRef, expiresAt, record }
  }

  function issueLocalResolution(input = {}) {
    exactFields(
      input,
      ['title', 'selector', 'publisherId', 'expectedBytes'],
      LOCAL_RESOLUTION_OPTIONAL,
      'local resolution',
    )
    const selector = normalizeSelector(input.selector)
    const publisherId = text(input.publisherId, 'local resolution.publisherId', 64)
    if (!PUBLISHER_ID.test(publisherId)) fail(PROVIDER_ERROR_CODES.INVALID_FIELD, 'local resolution publisherId is invalid', { field: 'publisherId' })
    const expectedBytes = uint(input.expectedBytes, 'local resolution.expectedBytes')
    if (expectedBytes < 1) fail(PROVIDER_ERROR_CODES.INVALID_FIELD, 'local resolution expectedBytes is invalid', { field: 'expectedBytes' })
    const enrichment = localEnrichment(input)
    const record = {
      kind: 'acquirable',
      title: text(input.title, 'local resolution.title'),
      sourceFileName: input.sourceFileName == null
        ? null
        : text(input.sourceFileName, 'local resolution.sourceFileName', 255),
      mediaContext: mediaContext(selector),
      publisherId,
      publicationId: null,
      renditionId: null,
      expectedBytes,
      availability: null,
      private: Object.freeze({ local: true }),
      ...enrichment,
    }
    const idempotency = input.idempotencyKey === undefined
      ? null
      : text(input.idempotencyKey, 'local resolution.idempotencyKey', MAX_IDEMPOTENCY_KEY_BYTES)
    const preferredRef = idempotency === null
      ? null
      : base64url(crypto.hash(b4a.from(`peartube.provider.local-resolution.v1\u0000${publisherId}\u0000${idempotency}`))).slice(0, 43)
    const lease = issueReference(record, preferredRef)
    const bound = lease.record || record
    return resolution({ ...bound, expiresAt: lease.expiresAt }, lease.ref)
  }

  function reference(ref) {
    opaqueToken(ref, 'ref')
    const record = references.get(ref)
    if (!record) fail(PROVIDER_ERROR_CODES.RESOLUTION_NOT_FOUND, 'Resolution reference was not found')
    if (record.expiresAt <= currentTime()) {
      references.delete(ref)
      fail(PROVIDER_ERROR_CODES.RESOLUTION_EXPIRED, 'Resolution reference expired')
    }
    return record
  }

  function cursor(token, fingerprint) {
    opaqueToken(token, 'cursor', PROVIDER_ERROR_CODES.INVALID_CURSOR)
    const record = cursors.get(token)
    if (!record || record.fingerprint !== fingerprint) fail(PROVIDER_ERROR_CODES.INVALID_CURSOR, 'Search cursor is invalid')
    if (record.inFlight) fail(PROVIDER_ERROR_CODES.INVALID_CURSOR, 'Search cursor is already in use')
    if (record.expiresAt <= currentTime()) {
      cursors.delete(token)
      fail(PROVIDER_ERROR_CODES.CURSOR_EXPIRED, 'Search cursor expired')
    }
    record.inFlight = true
    return record
  }

  function issueCursor(input, recordsArg, offsetArg) {
    let fingerprint
    let records
    let offset
    let federationCursor = null
    let seenKeys = null
    let partial = false
    let stale = false
    let avoidToken = null

    if (input && typeof input === 'object' && !Array.isArray(input)) {
      fingerprint = input.fingerprint
      records = input.records || []
      offset = input.offset || 0
      federationCursor = input.federationCursor || null
      seenKeys = input.seenKeys || null
      partial = Boolean(input.partial)
      stale = Boolean(input.stale)
      avoidToken = input.avoidToken || null
    } else {
      fingerprint = input
      records = recordsArg || []
      offset = offsetArg || 0
    }

    const hasMoreLocal = offset < records.length
    const hasMoreRemote = Boolean(federationCursor)
    if (!hasMoreLocal && !hasMoreRemote) return null
    const expiresAt = currentTime() + cursorLeaseMs
    const keys = seenKeys instanceof Set ? seenKeys : new Set(records.map(r => r.key))
    return issue(cursors, maxCursors, {
      fingerprint,
      records,
      offset,
      federationCursor,
      seenKeys: keys,
      partial,
      stale,
      expiresAt,
    }, avoidToken)
  }

  function releaseCursor(token, record) {
    if (cursors.get(token) !== record) return false
    cursors.delete(token)
    record.inFlight = false
    return true
  }

  function restoreCursor(token, record) {
    const existing = cursors.get(token)
    if (existing && existing !== record) fail(PROVIDER_ERROR_CODES.INVALID_CURSOR, 'Search cursor reference collided during restore')
    if (existing === record) {
      record.inFlight = false
      return
    }
    record.inFlight = false
    cursors.set(token, record)
  }

  function completeCursor(token, record, nextState, { restoreOnIssueFailure = true } = {}) {
    if (!releaseCursor(token, record)) fail(PROVIDER_ERROR_CODES.INVALID_CURSOR, 'Search cursor was not retained')
    if (nextState === null) return null
    try {
      return issueCursor({ ...nextState, avoidToken: token })
    } catch (error) {
      if (restoreOnIssueFailure) restoreCursor(token, record)
      throw error
    }
  }

  async function extraPublication(publicationId) {
    if (publicationLookup === null) return null
    return typeof publicationLookup === 'function'
      ? publicationLookup({ publicationId })
      : publicationLookup.getPublication({ publicationId })
  }

  async function resolveVerifiedManifest(publicationId, projection) {
    const extra = await extraPublication(publicationId)
    if (extra?.publicationId && extra.publicationId !== publicationId) {
      fail(PROVIDER_ERROR_CODES.PUBLICATION_NOT_VERIFIED, 'Publication lookup returned a different publication')
    }
    const publication = extra?.publication || extra || projection
    const manifest = extra?.manifest || await verifiedQueryView.getManifest({ publicationId })
    if (!manifest || manifest.publicationId !== publicationId) {
      fail(PROVIDER_ERROR_CODES.PUBLICATION_NOT_VERIFIED, 'Publication manifest is not verified')
    }
    return { extra, publication, manifest }
  }

  async function resolveVerifiedRendition(publicationId, renditionId, extra, manifest) {
    const available = Array.isArray(manifest.body?.renditions) ? manifest.body.renditions : []
    const selectedId = renditionId || extra?.rendition?.renditionId || available[0]?.renditionId || null
    const detailed = selectedId === null ? null : await verifiedQueryView.getRendition({ publicationId, renditionId: selectedId })
    const rendition = detailed?.rendition || extra?.rendition || available.find(item => item.renditionId === selectedId) || null
    if (selectedId !== null && (!rendition || rendition.renditionId !== selectedId)) {
      fail(PROVIDER_ERROR_CODES.PUBLICATION_NOT_VERIFIED, 'Publication rendition is not verified')
    }
    return rendition
  }

  async function verifiedPublication(publicationId, renditionId = null) {
    const projection = await verifiedQueryView.getPublication({ publicationId })
    if (!projection) return null
    const { extra, publication, manifest } = await resolveVerifiedManifest(publicationId, projection)
    const rendition = await resolveVerifiedRendition(publicationId, renditionId, extra, manifest)
    return Object.freeze({ publication: { ...projection, ...publication }, manifest, rendition })
  }
  function firstPresent(values) { return values.find(value => value !== null && value !== undefined) ?? null }


  async function publishedSearchByIdentifier(selector) {
    const page = await verifiedQueryView.query({ selectors: [localSelector(selector)], limit: MAX_SEARCH_RESULTS })
    const entityIds = [...new Set((page?.results ?? []).map(row => row?.entityId).filter(Boolean))]
    const entities = await Promise.all(entityIds.map(entityId => verifiedQueryView.getEntity({ entityKind: null, entityId })))
    const output = []
    for (const entity of entities) {
      if (!entity) continue
      for (const publication of entity.publications || []) {
        const manifest = publication.manifest || await verifiedQueryView.getManifest({ publicationId: publication.publicationId })
        if (!manifest) continue
        const renditions = Array.isArray(manifest.body?.renditions) ? manifest.body.renditions : []
        for (const rendition of renditions) {
          output.push({
            key: `${publication.publicationId}:${rendition.renditionId}`,
            kind: 'published',
            title: firstPresent([manifest.body?.title, publication.normalizedTitle]),
            sourceFileName: firstPresent([manifest.body?.sourceFileName, publication.sourceFileName]),
            mediaContext: mediaContext(selector),
            publisherId: firstPresent([publication.publisherId, manifest.body?.publisherId]),
            publicationId: publication.publicationId,
            renditionId: rendition.renditionId,
            expectedBytes: rendition.core?.byteLength ?? null,
            availability: null,
            private: Object.freeze({ publication, manifest, rendition }),
          })
          if (output.length >= MAX_SEARCH_RESULTS) return output
        }
      }
    }
    return output
  }

  async function collectTitleSearchCandidates() {
    let candidates = []
    if (typeof verifiedQueryView.listEntities === 'function') {
      candidates = (await verifiedQueryView.listEntities()) || []
    }
    if (typeof verifiedQueryView.getClaims === 'function') {
      try {
        const claims = await verifiedQueryView.getClaims()
        const claimEntityIds = new Set()
        for (const claim of claims || []) {
          const collectionId = claim?.body?.payload?.collectionRef?.entityId
          const agentId = claim?.body?.payload?.agentRef?.entityId
          if (collectionId) claimEntityIds.add(collectionId)
          if (agentId) claimEntityIds.add(agentId)
        }
        const missingIds = [...claimEntityIds].filter(id => !candidates.some(e => e?.entityId === id))
        if (missingIds.length > 0 && typeof verifiedQueryView.getEntity === 'function') {
          const extra = await Promise.all(missingIds.map(entityId => verifiedQueryView.getEntity({ entityId })))
          candidates.push(...extra.filter(Boolean))
        }
      } catch {
        // best-effort
      }
    }
    return candidates
  }

  const WORK_LIKE_KINDS = ['work', 'movie', 'series', 'episode']

  function kindMatchesSelector(entityKind, kind) {
    if (WORK_LIKE_KINDS.includes(kind)) return WORK_LIKE_KINDS.includes(entityKind)
    return entityKind === kind
  }

  function episodeNumbersMatch(entity, manifest, selector) {
    const season = entity.resolved?.metadata?.season ?? manifest?.body?.season
    const episode = entity.resolved?.metadata?.episode ?? manifest?.body?.episode
    if (season != null && season !== selector.season) return false
    if (episode != null && episode !== selector.episode) return false
    return true
  }

  function matchEntityKindAndAttributes(entity, manifest, selector) {
    const entityKind = entity.entityKind || 'work'
    if (selector.kind && selector.kind !== 'all' && selector.kind !== 'any' &&
        !kindMatchesSelector(entityKind, selector.kind)) {
      return false
    }

    if (selector.year != null) {
      const releaseYear = firstPresent([entity.resolved?.metadata?.releaseYear, manifest?.body?.releaseYear])
      if (releaseYear != null && releaseYear !== selector.year) return false
    }

    if (selector.kind === 'episode' && !episodeNumbersMatch(entity, manifest, selector)) return false
    return true
  }

  function matchEntityQuery(entity, manifest, queryWords, expectedTitle) {
    if (queryWords.length === 0) return true
    const resolved = entity.resolved || {}
    const metadata = resolved.metadata || {}
    const body = manifest?.body || {}
    const title = firstPresent([metadata.title, metadata.displayName, body.title])
    const subtitle = firstPresent([metadata.subtitle, metadata.overview, body.description])
    const creatorName = firstPresent([metadata.creatorName, metadata.author])
    const entityKind = entity.entityKind || 'work'
    const entityId = entity.entityId || ''
    const searchable = [title, subtitle, creatorName, entityKind, entityId].filter(Boolean).join(' ').toLowerCase().normalize('NFKC')
    if (queryWords.every(word => searchable.includes(word))) return true
    return typeof title === 'string' && title.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ') === expectedTitle
  }

  function matchSearchEntity(entity, selector, queryWords, expectedTitle) {
    if (!entity) return false
    const manifest = entity.publications?.[0]?.manifest
    if (!matchEntityKindAndAttributes(entity, manifest, selector)) return false
    return matchEntityQuery(entity, manifest, queryWords, expectedTitle)
  }

  async function formatEntityPublications(entity, selector, output) {
    for (const publication of entity.publications) {
      const manifest = publication.manifest || (typeof verifiedQueryView.getManifest === 'function' ? await verifiedQueryView.getManifest({ publicationId: publication.publicationId }) : null)
      const renditions = Array.isArray(manifest?.body?.renditions) ? manifest.body.renditions : []
      for (const rendition of renditions) {
        output.push({
          key: `${publication.publicationId}:${rendition.renditionId}`,
          kind: 'published',
          title: firstPresent([manifest?.body?.title, publication.normalizedTitle, entity.resolved?.metadata?.title]),
          sourceFileName: firstPresent([manifest?.body?.sourceFileName, publication.sourceFileName]),
          mediaContext: mediaContext(selector),
          publisherId: firstPresent([publication.publisherId, manifest?.body?.publisherId]),
          publicationId: publication.publicationId,
          renditionId: rendition.renditionId,
          expectedBytes: rendition.core?.byteLength ?? null,
          availability: null,
          private: Object.freeze({ publication, manifest, rendition, entity }),
        })
        if (output.length >= MAX_SEARCH_RESULTS) return true
      }
    }
    return false
  }

  function formatLocalEntityRow(entity) {
    const entityTitle = firstPresent([entity.resolved?.metadata?.title, entity.resolved?.metadata?.displayName, entity.entityId])
    const entitySubtitle = firstPresent([
      entity.resolved?.metadata?.subtitle,
      entity.resolved?.metadata?.overview,
      entity.entityKind === 'collection' ? 'Collection' : (entity.entityKind === 'creator' || entity.entityKind === 'agent') ? 'Creator' : null,
    ])
    return {
      key: `entity:${entity.entityId}`,
      kind: 'local-entity',
      title: entityTitle,
      subtitle: entitySubtitle,
      sourceFileName: null,
      mediaContext: {
        kind: entity.entityKind || 'work',
        title: entityTitle,
        workEntityId: entity.entityId,
      },
      publisherId: null,
      publicationId: null,
      renditionId: null,
      expectedBytes: null,
      availability: null,
      localEntity: true,
      entityKind: entity.entityKind || 'work',
      private: Object.freeze({ entity, localEntity: true }),
    }
  }

  async function publishedSearchByTitle(selector) {
    const expectedTitle = selector.title.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ')
    const queryWords = expectedTitle.split(' ').filter(Boolean)
    const candidates = await collectTitleSearchCandidates()
    const matches = candidates.filter(entity => matchSearchEntity(entity, selector, queryWords, expectedTitle))

    const output = []
    for (const entity of matches) {
      if (Array.isArray(entity.publications) && entity.publications.length > 0) {
        if (await formatEntityPublications(entity, selector, output)) return output
      } else {
        output.push(formatLocalEntityRow(entity))
        if (output.length >= MAX_SEARCH_RESULTS) return output
      }
    }
    return output
  }

  async function publishedSearch(selector) {
    if (selector.namespace && selector.identifier) {
      return publishedSearchByIdentifier(selector)
    }
    if (selector.title) {
      return publishedSearchByTitle(selector)
    }
    return []
  }

  function acquirableSearch(selector, candidates) {
    const output = []
    const queryTokens = selector.title ? (selector.title.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) : []
    for (const candidate of candidates || []) {
      const facts = candidateFacts(candidate, selector)
      if (!candidate.candidateRef || !OPAQUE_TOKEN.test(candidate.candidateRef)) continue
      if (selector.title && queryTokens.length > 0) {
        const candidateTitle = facts.title || candidate.work?.title || ''
        if (!textMatchesTokens(candidateTitle, queryTokens)) continue
      }
      output.push({
        key: facts.publicationId && facts.renditionId
          ? `${facts.publicationId}:${facts.renditionId}`
          : `candidate:${candidate.candidateRef}`,
        kind: 'acquirable',
        ...facts,
        private: Object.freeze({ candidateRef: candidate.candidateRef }),
      })
      if (output.length >= MAX_SEARCH_RESULTS) break
    }
    return output
  }
  async function loadActiveAcquisitionJobs() {
    if (!acquisitionManager) return []
    try {
      if (typeof acquisitionManager.listActive === 'function') {
        const raw = await acquisitionManager.listActive()
        return Array.isArray(raw) ? raw : []
      }
      if (typeof acquisitionManager.list === 'function') {
        const page = await acquisitionManager.list({ states: ACTIVE_ACQUISITION_STATES, limit: MAX_SEARCH_RESULTS })
        const raw = page?.items || page || []
        return Array.isArray(raw) ? raw : []
      }
    } catch {
      return []
    }
    return []
  }

  function formatInFlightJob(job, selector) {
    const metadata = job.publicationMetadata || {}
    const request = job.request || {}
    const publication = job.publication || {}
    const title = firstPresent([
      metadata.title,
      job.title,
      request.sourceFileName,
      metadata.sourceFileName,
      job.sourceFileName,
    ])
    const publisherId = firstPresent([
      job.publisherId,
      request.publisherId,
      metadata.publisherId,
    ])
    const pubId = publication.publicationId || job.publicationId || null
    const rendId = publication.renditionId || job.renditionId || null
    const sourceFileName = firstPresent([
      metadata.sourceFileName,
      request.sourceFileName,
      job.sourceFileName,
    ])

    return {
      key: pubId && rendId ? `${pubId}:${rendId}` : `acquisition:${job.acquisitionId}`,
      kind: 'acquirable',
      title,
      expectedBytes: job.expectedBytes ?? null,
      mediaContext: mediaContext(selector),
      publisherId: publisherId || null,
      ...(pubId ? { publicationId: pubId } : {}),
      ...(rendId ? { renditionId: rendId } : {}),
      availability: null,
      ...(sourceFileName ? { sourceFileName } : {}),
      private: Object.freeze({
        acquisitionId: job.acquisitionId,
        inFlight: true,
      }),
    }
  }

  async function inFlightAcquisitionSearch(selector) {
    const jobs = await loadActiveAcquisitionJobs()
    const output = []
    for (const job of jobs) {
      if (!job || !job.acquisitionId) continue
      if (job.state && !ACTIVE_ACQUISITION_STATES.includes(job.state)) continue
      const matched = selector.title
        ? matchTitleSelector(job, selector)
        : matchExternalReference(job, selector)
      if (!matched) continue
      output.push(formatInFlightJob(job, selector))
      if (output.length >= MAX_SEARCH_RESULTS) break
    }
    return output
  }

  function createReferenceLease(record, isLocalEntity) {
    return issueReference({
      kind: isLocalEntity ? 'local-entity' : record.kind,
      title: record.title,
      sourceFileName: record.sourceFileName || null,
      mediaContext: record.mediaContext,
      publisherId: record.publisherId || null,
      publicationId: record.publicationId || null,
      renditionId: record.renditionId || null,
      expectedBytes: record.expectedBytes ?? null,
      availability: record.availability || null,
      private: record.private,
    })
  }

  function publicHit(record) {
    const isLocalEntity = record.private?.localEntity === true || record.kind === 'local-entity'
    const lease = createReferenceLease(record, isLocalEntity)
    const hasExpectedBytes = record.expectedBytes !== null && record.expectedBytes !== undefined
    return Object.freeze({
      schemaVersion: 1,
      ref: lease.ref,
      title: record.title,
      ...(record.sourceFileName ? { sourceFileName: record.sourceFileName } : {}),
      mediaContext: record.mediaContext,
      kind: isLocalEntity ? 'local-entity' : record.kind,
      published: !isLocalEntity && record.kind === 'published' && Boolean(record.publicationId),
      acquirable: record.kind === 'acquirable',
      ...(record.publicationId ? { publicationId: record.publicationId } : {}),
      ...(record.renditionId ? { renditionId: record.renditionId } : {}),
      ...(record.availability ? { availability: record.availability } : {}),
      ...(hasExpectedBytes ? { expectedBytes: record.expectedBytes } : {}),
      ...(isLocalEntity ? { localEntity: true, entityKind: record.mediaContext?.kind || 'entity' } : {}),
    })
  }

  function serveStoredCursorRecords({ token, stored, fingerprint, limit }) {
    const end = Math.min(stored.records.length, stored.offset + limit)
    const slice = stored.records.slice(stored.offset, end)
    const candidates = Object.freeze(slice.map(publicHit))
    const nextCursor = completeCursor(token, stored, {
      fingerprint,
      records: stored.records,
      offset: end,
      federationCursor: stored.federationCursor,
      seenKeys: stored.seenKeys,
      partial: stored.partial,
      stale: stored.stale,
    })
    return Object.freeze({
      candidates,
      nextCursor,
      diagnostics: Object.freeze({
        partial: stored.partial,
        stale: stored.stale,
      }),
      partial: stored.partial,
      stale: stored.stale,
    })
  }

  function rollbackCursorOnFailure({ token, stored, upstreamConsumed }) {
    if (cursors.get(token) === stored) {
      if (upstreamConsumed) releaseCursor(token, stored)
      else restoreCursor(token, stored)
    } else if (!upstreamConsumed) {
      restoreCursor(token, stored)
    }
  }

  async function fetchFederationPage({ selector, stored, signal }) {
    let remoteValue = null
    let partialDiagnostic = stored.partial
    let staleDiagnostic = stored.stale
    let upstreamConsumed = false
    try {
      remoteValue = await indexVerificationRuntime.searchIndexCandidates({
        selector,
        limit: MAX_SEARCH_RESULTS,
        signal,
        cursor: stored.federationCursor,
      })
      upstreamConsumed = true
      if (remoteValue?.diagnostics?.partial || remoteValue?.partial) partialDiagnostic = true
      if (remoteValue?.diagnostics?.stale || remoteValue?.stale) staleDiagnostic = true
    } catch (error) {
      if (signal?.aborted) throw error
      partialDiagnostic = true
      remoteValue = { candidates: [], nextCursor: stored.federationCursor }
    }
    return { remoteValue, partialDiagnostic, staleDiagnostic, upstreamConsumed }
  }

  function processFederationPageRecords({
    token,
    stored,
    fingerprint,
    selector,
    remoteValue,
    partialDiagnostic,
    staleDiagnostic,
    upstreamConsumed,
    limit,
  }) {
    const remoteCandidates = Array.isArray(remoteValue) ? remoteValue : (remoteValue?.candidates || [])
    const acquirable = acquirableSearch(selector, remoteCandidates)
    const newRecords = []
    const seenKeys = new Set(stored.seenKeys)
    for (const record of acquirable) {
      if (seenKeys.has(record.key)) continue
      seenKeys.add(record.key)
      newRecords.push(record)
      if (newRecords.length >= MAX_SEARCH_RESULTS) break
    }

    const nextFedCursor = remoteValue && !Array.isArray(remoteValue) ? (remoteValue.nextCursor || null) : null
    const end = Math.min(newRecords.length, limit)
    const slice = newRecords.slice(0, end)
    const candidates = Object.freeze(slice.map(publicHit))
    const nextState = {
      fingerprint,
      records: newRecords,
      offset: end,
      federationCursor: nextFedCursor,
      seenKeys,
      partial: partialDiagnostic,
      stale: staleDiagnostic,
    }
    const nextCursor = completeCursor(token, stored, nextState, {
      restoreOnIssueFailure: !upstreamConsumed,
    })

    return Object.freeze({
      candidates,
      nextCursor,
      diagnostics: Object.freeze({
        partial: partialDiagnostic,
        stale: staleDiagnostic,
      }),
      partial: partialDiagnostic,
      stale: staleDiagnostic,
    })
  }

  async function searchWithCursor({ token, fingerprint, selector, limit, signal }) {
    const stored = cursor(token, fingerprint)
    let upstreamConsumed = false
    let committed = false
    try {
      if (stored.offset < stored.records.length) {
        const result = serveStoredCursorRecords({ token, stored, fingerprint, limit })
        committed = true
        return result
      }

      if (stored.federationCursor) {
        const fed = await fetchFederationPage({ selector, stored, signal })
        upstreamConsumed = fed.upstreamConsumed
        const result = processFederationPageRecords({
          token,
          stored,
          fingerprint,
          selector,
          remoteValue: fed.remoteValue,
          partialDiagnostic: fed.partialDiagnostic,
          staleDiagnostic: fed.staleDiagnostic,
          upstreamConsumed,
          limit,
        })
        committed = true
        return result
      }

      const nextCursor = completeCursor(token, stored, null)
      committed = true
      return Object.freeze({
        candidates: Object.freeze([]),
        nextCursor,
        diagnostics: Object.freeze({
          partial: stored.partial,
          stale: stored.stale,
        }),
        partial: stored.partial,
        stale: stored.stale,
      })
    } catch (error) {
      if (!committed) {
        rollbackCursorOnFailure({ token, stored, upstreamConsumed })
      }
      throw error
    }
  }

  function mergeInitialSearchRecords(published, inFlight, acquirable) {
    const records = []
    const seen = new Set()
    for (const record of [...published, ...inFlight, ...acquirable]) {
      if (seen.has(record.key)) continue
      seen.add(record.key)
      records.push(record)
      if (records.length >= MAX_SEARCH_RESULTS) break
    }
    return { records: Object.freeze(records), seen }
  }

  function deriveFederationDiagnostics(remoteResult, remoteValue) {
    const partial = remoteResult.status === 'rejected' || Boolean(remoteValue?.diagnostics?.partial ?? remoteValue?.partial)
    const stale = Boolean(remoteValue?.diagnostics?.stale ?? remoteValue?.stale)
    const cursor = remoteValue && !Array.isArray(remoteValue) ? (remoteValue.nextCursor || null) : null
    return { partial, stale, cursor }
  }

  async function searchInitial({ selector, limit, fingerprint, signal }) {
    const [publishedResult, remoteResult, inFlightResult] = await Promise.allSettled([
      publishedSearch(selector),
      indexVerificationRuntime.searchIndexCandidates({ selector, limit: MAX_SEARCH_RESULTS, signal }),
      inFlightAcquisitionSearch(selector),
    ])
    if (publishedResult.status === 'rejected' && remoteResult.status === 'rejected' && inFlightResult.status === 'rejected') {
      throw mapProviderError(remoteResult.reason || inFlightResult.reason || publishedResult.reason, PROVIDER_ERROR_CODES.SOURCE_UNAVAILABLE, 'No verified search source is available', { retryable: true })
    }
    const published = publishedResult.status === 'fulfilled' ? publishedResult.value : []
    const inFlight = inFlightResult.status === 'fulfilled' ? inFlightResult.value : []
    const remoteValue = remoteResult.status === 'fulfilled' ? remoteResult.value : null
    const remoteCandidates = Array.isArray(remoteValue) ? remoteValue : (remoteValue?.candidates || [])
    const acquirable = acquirableSearch(selector, remoteCandidates)
    const { records: boundedRecords, seen } = mergeInitialSearchRecords(published, inFlight, acquirable)

    const end = Math.min(boundedRecords.length, limit)
    const { partial: partialDiagnostic, stale: staleDiagnostic, cursor: fedCursor } = deriveFederationDiagnostics(remoteResult, remoteValue)

    const nextCursor = issueCursor({
      fingerprint,
      records: boundedRecords,
      offset: end,
      federationCursor: fedCursor,
      seenKeys: seen,
      partial: partialDiagnostic,
      stale: staleDiagnostic,
    })

    return Object.freeze({
      candidates: Object.freeze(boundedRecords.slice(0, end).map(publicHit)),
      nextCursor,
      diagnostics: Object.freeze({
        partial: partialDiagnostic,
        stale: staleDiagnostic,
      }),
      partial: partialDiagnostic,
      stale: staleDiagnostic,
    })
  }

  async function search(request = {}) {
    exactFields(request, ['selector'], ['limit', 'cursor', 'signal'], 'request')
    const selector = normalizeSelector(request.selector)
    const limit = positiveLimit(request.limit, 20, MAX_SEARCH_RESULTS, 'limit')
    const fingerprint = queryFingerprint(selector)

    if (request.cursor !== undefined && request.cursor !== null) {
      return searchWithCursor({ token: request.cursor, fingerprint, selector, limit, signal: request.signal })
    }

    return searchInitial({ selector, limit, fingerprint, signal: request.signal })
  }

// Labels a resolution carries when the record has them: what the work is
// called, and what the source called its file.
function resolutionLabels(record) {
  const labels = {}
  if (record.sourceFileName) labels.sourceFileName = record.sourceFileName
  if (record.title) labels.title = record.title
  if (record.description) labels.description = record.description
  if (Array.isArray(record.tags) && record.tags.length > 0) labels.tags = record.tags
  if (record.creatorName) labels.creatorName = record.creatorName
  if (record.creatorHandle) labels.creatorHandle = record.creatorHandle
  if (Number.isSafeInteger(record.duration) && record.duration > 0) labels.duration = record.duration
  if (Array.isArray(record.artworkRoles) && record.artworkRoles.length > 0) labels.artworkRoles = record.artworkRoles
  return labels
}
  function resolutionIdentifiers(record, overrides) {
    const publisherId = overrides.publisherId || record.publisherId
    const publicationId = overrides.publicationId || record.publicationId
    const renditionId = overrides.renditionId || record.renditionId
    const availability = overrides.availability || record.availability
    return {
      ...(publisherId ? { publisherId } : {}),
      ...(publicationId ? { publicationId } : {}),
      ...(renditionId ? { renditionId } : {}),
      ...(availability ? { measuredFacts: Object.freeze({ availability }) } : {}),
    }
  }

  function resolution(record, ref, overrides = {}) {
    const kind = overrides.kind || record.kind
    const expectedBytes = overrides.expectedBytes ?? record.expectedBytes
    const hasExpectedBytes = expectedBytes !== null && expectedBytes !== undefined
    return Object.freeze({
      schemaVersion: 1,
      resolutionRef: ref,
      expiresAt: record.expiresAt,
      kind,
      mediaContext: record.mediaContext,
      ...resolutionLabels(record),
      ...resolutionIdentifiers(record, overrides),
      ...(hasExpectedBytes ? { expected: Object.freeze({ byteLength: expectedBytes }) } : {}),
      acquisitionAvailable: kind === 'acquirable',
      ...(record.private?.local === true ? { deferredInput: true } : {}),
      ...(overrides.denialCode ? { denialCode: overrides.denialCode } : {}),
    })
  }

  async function resolvePublishedRecord(record, ref) {
    if (record.publicationId) {
      const published = await verifiedPublication(record.publicationId, record.renditionId)
      if (!published) return resolution(record, ref, { kind: 'unavailable', denialCode: 'PUBLICATION_UNAVAILABLE' })
    }
    return resolution(record, ref, { kind: 'published' })
  }

  async function fetchInFlightJob(record) {
    if (!record.private.acquisitionId) return null
    if (typeof acquisitionManager?.getPublicProjection === 'function') {
      try {
        return await acquisitionManager.getPublicProjection({ acquisitionId: record.private.acquisitionId })
      } catch {
        // ignore get error, fallback to record
      }
    } else if (typeof acquisitionManager?.get === 'function') {
      try {
        return await acquisitionManager.get({ acquisitionId: record.private.acquisitionId })
      } catch {
        // ignore get error, fallback to record
      }
    }
    return null
  }

  async function resolveInFlightRecord(record, ref) {
    const visible = await verifiedQueryView.isVisible({
      kind: 'acquisition-candidate',
      publisherId: record.publisherId,
      externalRefs: record.mediaContext?.namespace
        ? [{ namespace: record.mediaContext.namespace, identifier: record.mediaContext.identifier }]
        : [],
    })
    if (!visible) return resolution(record, ref, { kind: 'unavailable', denialCode: PROVIDER_ERROR_CODES.MODERATION_BLOCKED })
    const job = await fetchInFlightJob(record)
    if (job?.state === 'completed' && job?.publicationId) {
      const published = await verifiedPublication(job.publicationId, job.renditionId)
      if (published) {
        return resolution(record, ref, {
          kind: 'published',
          publisherId: job.publisherId || record.publisherId,
          publicationId: job.publicationId,
          renditionId: job.renditionId,
        })
      }
    }
    return resolution(record, ref, {
      kind: 'acquirable',
      publisherId: record.publisherId || job?.publisherId || null,
      expectedBytes: record.expectedBytes ?? job?.expectedBytes ?? null,
    })
  }

  async function resolveLocalRecord(record, ref) {
    const visible = await verifiedQueryView.isVisible({
      kind: 'acquisition-candidate',
      publisherId: record.publisherId,
      externalRefs: record.mediaContext.namespace
        ? [{ namespace: record.mediaContext.namespace, identifier: record.mediaContext.identifier }]
        : [],
    })
    return visible
      ? resolution(record, ref)
      : resolution(record, ref, { kind: 'unavailable', denialCode: PROVIDER_ERROR_CODES.MODERATION_BLOCKED })
  }

  async function resolveCandidateRefRecord(record, ref) {
    let verified
    try {
      verified = await indexVerificationRuntime.verifyIndexCandidate({ candidateRef: record.private.candidateRef })
    } catch (error) {
      if (error instanceof ProviderError) throw error
      return resolution(record, ref, { kind: 'unavailable', denialCode: PROVIDER_ERROR_CODES.SOURCE_UNAVAILABLE })
    }
    const visible = await verifiedQueryView.isVisible({
      kind: 'acquisition-candidate',
      publisherId: verified.publication?.publisherId,
      publicationId: verified.publication?.publicationId,
      workEntityId: verified.work?.entityId,
      externalRefs: verified.work?.externalRefs || [],
    })
    if (!visible) return resolution(record, ref, { kind: 'unavailable', denialCode: PROVIDER_ERROR_CODES.MODERATION_BLOCKED })
    const facts = candidateFacts(verified, record.mediaContext)
    const published = facts.publicationId ? await verifiedPublication(facts.publicationId, facts.renditionId) : null
    if (published) return resolution(record, ref, {
      kind: 'published',
      publisherId: facts.publisherId,
      publicationId: facts.publicationId,
      renditionId: facts.renditionId,
    })
    return resolution(record, ref, {
      kind: 'acquirable',
      publisherId: facts.publisherId,
      publicationId: facts.publicationId,
      renditionId: facts.renditionId,
      availability: facts.availability,
      expectedBytes: facts.expectedBytes,
    })
  }

  async function resolve({ ref } = {}) {
    const record = reference(ref)
    if (record.private?.localEntity === true || record.kind === 'local-entity') {
      return resolution(record, ref, { kind: 'local' })
    }
    if (record.kind === 'published') {
      return resolvePublishedRecord(record, ref)
    }
    if (record.private?.inFlight === true) {
      return resolveInFlightRecord(record, ref)
    }
    if (record.private?.local === true) {
      return resolveLocalRecord(record, ref)
    }
    return resolveCandidateRefRecord(record, ref)
  }

  async function requestAcquisition({ idempotencyKey, request, principal } = {}) {
    const key = text(idempotencyKey, 'idempotencyKey', MAX_IDEMPOTENCY_KEY_BYTES)
    const normalizedRequest = normalizeAcquisitionRequest(request)
    const normalizedPrincipal = normalizePrincipal(principal)
    if (normalizedRequest.publisherId !== normalizedPrincipal.publisherId) {
      fail(PROVIDER_ERROR_CODES.ACQUISITION_FORBIDDEN, 'Acquisition publisher scope does not match the principal')
    }
    try {
      if (await acquisitionManager.findRequest({ idempotencyKey: key, request: normalizedRequest, principal: normalizedPrincipal })) {
        return publicAcquisition(await acquisitionManager.request({
          idempotencyKey: key,
          request: normalizedRequest,
          principal: normalizedPrincipal,
        }))
      }
    } catch (error) {
      throw mapProviderError(error, PROVIDER_ERROR_CODES.ACQUISITION_UNAVAILABLE, 'Acquisition replay failed', { retryable: true })
    }
    const resolved = await resolve({ ref: normalizedRequest.resolutionRef })
    if (resolved.kind === 'published') fail(PROVIDER_ERROR_CODES.ACQUISITION_UNAVAILABLE, 'Publication is already available')
    if (resolved.denialCode === PROVIDER_ERROR_CODES.MODERATION_BLOCKED) {
      fail(PROVIDER_ERROR_CODES.MODERATION_BLOCKED, 'Acquisition is blocked by local moderation')
    }
    if (resolved.kind !== 'acquirable') fail(PROVIDER_ERROR_CODES.SOURCE_UNAVAILABLE, 'Acquisition source is unavailable', { retryable: true })
    try {
      return publicAcquisition(await acquisitionManager.request({
        idempotencyKey: key,
        request: normalizedRequest,
        principal: normalizedPrincipal,
      }))
    } catch (error) {
      throw mapProviderError(error, PROVIDER_ERROR_CODES.ACQUISITION_UNAVAILABLE, 'Acquisition request failed', { retryable: true })
    }
  }

  async function attachSourceGrant({ acquisitionId, grant, principal } = {}) {
    const id = text(acquisitionId, 'acquisitionId', 128)
    const normalizedPrincipal = normalizePrincipal(principal)
    if (!grant || typeof grant !== 'object' || Array.isArray(grant)) {
      fail(PROVIDER_ERROR_CODES.INVALID_FIELD, 'grant must be an object', { field: 'grant' })
    }
    try {
      return publicAcquisition(await acquisitionManager.attachGrant({ acquisitionId: id, grant, principal: normalizedPrincipal }))
    } catch (error) {
      throw mapProviderError(error, PROVIDER_ERROR_CODES.ACQUISITION_UNAVAILABLE, 'Source grant was not accepted')
    }
  }

  async function getAcquisition({ acquisitionId, principal } = {}) {
    const value = await acquisitionManager.get({
      acquisitionId: text(acquisitionId, 'acquisitionId', 128),
      principal: normalizePrincipal(principal),
    })
    return value === null ? null : publicAcquisition(value)
  }

  async function listAcquisitions({ cursor: cursorValue = null, limit = 64, states = null, principal } = {}) {
    if (cursorValue !== null) acquisitionCursor(cursorValue)
    const boundedLimit = positiveLimit(limit, 64, MAX_SEARCH_RESULTS, 'limit')
    if (states !== null) {
      if (!Array.isArray(states) || states.length === 0 || states.length > PUBLIC_ACQUISITION_STATES.size) {
        fail(PROVIDER_ERROR_CODES.INVALID_FIELD, 'states must be a bounded array', { field: 'states' })
      }
      for (const state of states) if (!PUBLIC_ACQUISITION_STATES.has(state)) fail(PROVIDER_ERROR_CODES.INVALID_FIELD, 'states contains an invalid state', { field: 'states' })
    }
    const page = await acquisitionManager.list({
      cursor: cursorValue,
      limit: boundedLimit,
      states,
      principal: normalizePrincipal(principal),
    })
    object(page, 'acquisition page')
    const nextCursor = page.cursor == null ? null : acquisitionCursor(page.cursor)
    return Object.freeze({
      items: Object.freeze((page.items || []).map(publicAcquisition)),
      cursor: nextCursor,
    })
  }

  async function cancelAcquisition({ acquisitionId, principal } = {}) {
    const value = await acquisitionManager.cancel({
      acquisitionId: text(acquisitionId, 'acquisitionId', 128),
      principal: normalizePrincipal(principal),
    })
    return value === null ? null : publicAcquisition(value)
  }
  async function retryAcquisition({ acquisitionId, principal } = {}) {
    const value = await acquisitionManager.retry({
      acquisitionId: text(acquisitionId, 'acquisitionId', 128),
      principal: normalizePrincipal(principal),
    })
    return value === null ? null : publicAcquisition(value)
  }


  // Clearing a finished acquisition is a durable delete, so it says what it did
  // rather than returning a job projection that no longer exists.
  async function forgetAcquisition({ acquisitionId, principal } = {}) {
    const result = await acquisitionManager.forget({
      acquisitionId: text(acquisitionId, 'acquisitionId', 128),
      principal: normalizePrincipal(principal),
    })
    return Object.freeze({
      acquisitionId: result?.acquisitionId || null,
      forgotten: result?.forgotten === true,
      state: result?.state || null,
    })
  }

  async function getPublication({ publicationId } = {}) {
    const record = await verifiedPublication(text(publicationId, 'publicationId', 128))
    return record === null ? null : publicPublicationRecord(record)
  }

  async function resolveStreamTarget(input, principal) {
    if (input.acquisitionId !== undefined) {
      if (!principal) fail(PROVIDER_ERROR_CODES.ACQUISITION_FORBIDDEN, 'principal is required for acquisition playback')
      const acquisition = await getAcquisition({ acquisitionId: input.acquisitionId, principal })
      if (!acquisition || acquisition.state !== 'completed' || !acquisition.publicationId) {
        fail(PROVIDER_ERROR_CODES.ACQUISITION_NOT_COMPLETED, 'Acquisition has no completed publication')
      }
      return { publicationId: acquisition.publicationId, renditionId: acquisition.renditionId }
    }
    if (input.ref !== undefined || input.candidateRef !== undefined) {
      const ref = input.candidateRef || input.ref
      const resolved = await resolve({ ref })
      if (resolved.kind !== 'published' || !resolved.publicationId) {
        fail(PROVIDER_ERROR_CODES.ACQUISITION_REQUIRED, 'A completed publication is required before streaming')
      }
      return { publicationId: resolved.publicationId, renditionId: input.renditionId || resolved.renditionId || null }
    }
    return {
      publicationId: input.publicationId || null,
      renditionId: input.renditionId || null,
    }
  }

  async function authorizeStreamRendition(publicationId, record) {
    const coreLength = record.rendition.core?.length
    if (!Number.isSafeInteger(coreLength) || coreLength < 1 || !await verifiedQueryView.authorizeRendition({
      publicationId,
      renditionId: record.rendition.renditionId,
      start: 0,
      end: coreLength,
      operation: 'stream',
    })) fail(PROVIDER_ERROR_CODES.MODERATION_BLOCKED, 'Publication is not authorized for streaming')
  }

  async function executeStreamOpen(record, principal, signal) {
    try {
      const request = {
        publication: record.publication,
        manifest: record.manifest,
        rendition: record.rendition,
        principal,
        signal,
      }
      return typeof streamOpener === 'function' ? await streamOpener(request) : await streamOpener.openStream(request)
    } catch (error) {
      throw mapProviderError(error, PROVIDER_ERROR_CODES.STREAM_UNAVAILABLE, 'Verified stream could not be opened', { retryable: true })
    }
  }

  async function openStream(input = {}) {
    object(input, 'input')
    const principal = input.principal === undefined ? null : normalizePrincipal(input.principal)
    const target = await resolveStreamTarget(input, principal)
    const publicationId = target.publicationId
    const renditionId = target.renditionId
    if (!publicationId) fail(PROVIDER_ERROR_CODES.INVALID_FIELD, 'publicationId, ref, or acquisitionId is required', { field: 'publicationId' })

    const record = await verifiedPublication(text(publicationId, 'publicationId', 128), renditionId)
    if (!record || !record.rendition) fail(PROVIDER_ERROR_CODES.PUBLICATION_NOT_FOUND, 'Verified publication was not found')

    await authorizeStreamRendition(publicationId, record)
    const opened = await executeStreamOpen(record, principal, input.signal)

    return publicStream(opened, {
      publicationId,
      renditionId: record.rendition.renditionId,
      assetId: record.rendition.core?.assetId || null,
      byteLength: record.rendition.core?.byteLength ?? null,
      mimeType: record.rendition.format || null,
    })
  }

  async function getStatus() {
    if (statusSource === null) return publicStatus({ ready: true })
    try {
      const value = typeof statusSource === 'function' ? await statusSource() : await statusSource.getStatus()
      return publicStatus(value)
    } catch (error) {
      throw mapProviderError(error, PROVIDER_ERROR_CODES.STATUS_UNAVAILABLE, 'Provider status is unavailable', { retryable: true })
    }
  }

  async function getPolicy() {
    if (policy === null) fail(PROVIDER_ERROR_CODES.POLICY_UNAVAILABLE, 'Provider policy is unavailable')
    const value = await policy.getPolicy()
    const revision = typeof policy.getRevision === 'function' ? await policy.getRevision() : value?.revision
    return clonePublicPolicy(revision === undefined ? value : { ...value, revision })
  }

  async function setPolicy({ policy: nextPolicy, expectedRevision } = {}) {
    if (policy === null) fail(PROVIDER_ERROR_CODES.POLICY_UNAVAILABLE, 'Provider policy is unavailable')
    if (nextPolicy === undefined) fail(PROVIDER_ERROR_CODES.INVALID_FIELD, 'policy is required', { field: 'policy' })
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail(PROVIDER_ERROR_CODES.INVALID_FIELD, 'expectedRevision is required', { field: 'expectedRevision' })
    return clonePublicPolicy(await policy.setPolicy(nextPolicy, { expectedRevision }))
  }

  async function getAcquisitionPolicy() {
    if (acquisitionPolicy === null) fail(PROVIDER_ERROR_CODES.POLICY_UNAVAILABLE, 'Acquisition policy is unavailable')
    const value = await acquisitionPolicy.getPolicy()
    const revision = typeof acquisitionPolicy.getRevision === 'function' ? await acquisitionPolicy.getRevision() : 0
    return clonePublicPolicy({ ...value, revision })
  }

  async function setAcquisitionPolicy({ policy: nextPolicy, consent, expectedRevision } = {}) {
    if (acquisitionPolicy === null) fail(PROVIDER_ERROR_CODES.POLICY_UNAVAILABLE, 'Acquisition policy is unavailable')
    if (nextPolicy === undefined) fail(PROVIDER_ERROR_CODES.INVALID_FIELD, 'policy is required', { field: 'policy' })
    if (consent === undefined) fail(PROVIDER_ERROR_CODES.INVALID_FIELD, 'explicit consent is required', { field: 'consent' })
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail(PROVIDER_ERROR_CODES.INVALID_FIELD, 'expectedRevision is required', { field: 'expectedRevision' })
    return clonePublicPolicy(await acquisitionPolicy.setPolicy(nextPolicy, { consent, expectedRevision }))
  }

  async function migrateLegacyIngest({
    legacyStore,
    legacyPrincipalId = 'local',
    legacyPublisherId = 'local',
    now: migrationNow = undefined,
  } = {}) {
    if (!legacyStore || typeof legacyStore !== 'object' || Array.isArray(legacyStore)) {
      fail(PROVIDER_ERROR_CODES.INVALID_FIELD, 'legacyStore is required', { field: 'legacyStore' })
    }
    const input = {
      legacyStore,
      legacyPrincipalId: text(legacyPrincipalId, 'legacyPrincipalId', 256),
      legacyPublisherId: text(legacyPublisherId, 'legacyPublisherId', 256),
    }
    if (migrationNow !== undefined) {
      if (typeof migrationNow !== 'function' && (!Number.isSafeInteger(migrationNow) || migrationNow < 0)) {
        fail(PROVIDER_ERROR_CODES.INVALID_FIELD, 'migration now is invalid', { field: 'now' })
      }
      input.now = migrationNow
    }
    const result = object(await acquisitionManager.migrateLegacyIngest(input), 'legacy migration result')
    return Object.freeze({
      migrated: uint(result.migrated, 'legacy migration migrated'),
      skipped: uint(result.skipped, 'legacy migration skipped'),
    })
  }

  const service = Object.freeze({
    search,
    resolve,
    requestAcquisition,
    attachSourceGrant,
    getAcquisition,
    listAcquisitions,
    cancelAcquisition,
    retryAcquisition,
    forgetAcquisition,
    getPublication,
    openStream,
    getStatus,
    getPolicy,
    setPolicy,
    getAcquisitionPolicy,
    setAcquisitionPolicy,
    migrateLegacyIngest,
  })
  PROVIDER_INTERNALS.set(service, Object.freeze({ issueLocalResolution }))
  return service
}
