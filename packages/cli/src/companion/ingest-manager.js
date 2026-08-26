import AbortController from 'abort-controller'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import sodium from 'sodium-universal'
import * as defaultFs from '#fs'
import * as defaultPath from '#path'
import process from '#process'

import { reclaimStagingState } from '@peartube/backend/assets'

import { createSourceProviderRegistry } from './sources/index.js'
import { TERMINAL_INGEST_JOB_STATES } from './ingest-job-store.js'

const REQUEST_FIELDS = new Set(['retentionClass', 'mediaContext', 'measuredFacts', 'expected', 'bundleProvenance'])
const MOVIE_FIELDS = new Set(['kind', 'namespace', 'identifier'])
const EPISODE_FIELDS = new Set([
  'kind',
  'seriesNamespace',
  'seriesIdentifier',
  'seasonNumber',
  'episodeNumber',
  'providerEpisodeNamespace',
  'providerEpisodeIdentifier'
])
const MEASURED_FIELDS = new Set([
  'title',
  'byteLength',
  'durationMs',
  'container',
  'videoCodec',
  'width',
  'height',
  'resolutionLabel',
  'hdrFormats',
  'audioTracks',
  'subtitleTracks'
])
const AUDIO_FIELDS = new Set(['codec', 'channels', 'languages'])
const SUBTITLE_FIELDS = new Set(['format', 'language'])
const EXPECTED_FIELDS = new Set(['byteLength', 'sha256', 'etag'])
const BUNDLE_FIELDS = new Set([
  'sourceKind',
  'releaseName',
  'sourcePath',
  'fileIndex',
  'memberCount',
  'sourceRoot',
  'publicTrackerIndependent',
  'publicInfohash'
])
// Progress that has to be thrown away rather than resumed from — the staged
// prefix's own indictment. HASH_MISMATCH is the case that matters: those are
// exactly the bytes whose digest failed, so resuming from them recomputes the
// same wrong digest for as long as anyone keeps trying.
//
// These jobs stay RECOVERABLE, because corruption need not recur and a resubmit
// is worth making. They just cannot start where the last attempt stopped.
//
// One name, two mechanisms, because it is one decision about two substrates:
// on reopen it zeroes `bytesReceived`, which is where a SPOOLED job resumes
// from; in runJob's catch it reclaims the staging core, which is where a
// GRANTED job resumes from. A granted job reads its offset off the staged
// merkle tree, so zeroing the counter alone would leave it resuming into the
// same bytes.
const SOURCE_RESET_PROGRESS_ERRORS = new Set([
  'HASH_MISMATCH',
  'SPOOL_LENGTH_MISMATCH'
])

// A terminal failure about REACHING the source, as opposed to what the source
// turned out to be. A fresh grant genuinely answers these: the capability had
// expired, been revoked, or was refused. Everything else stays terminal, and the
// identity failures must: the job id is a hash of the request INCLUDING
// expected.etag, so a resubmit that lands on this job id necessarily carries the
// same identity - retrying it would retry against bytes we already know
// disagree. A genuinely different source produces a different job id.
const REVIVABLE_TERMINAL_ERRORS = new Set([
  'SOURCE_GRANT_UNAVAILABLE',
  'SOURCE_CAPABILITY_INVALID',
  'SOURCE_AUTH_FAILED'
])
// A failure that is the transport's fault, or the process's, is an
// INTERRUPTION: the bytes already on disk are still a truthful prefix of the
// title this job asked for, so the job keeps its progress and its grant and a
// resubmit resumes from `bytesReceived`.
//
// These are the failures that are themselves evidence the bytes CANNOT be
// completed into what was asked for: the source states a different identity or
// a different length than the request expects, or the spool handed over is not
// the shape a spool has. No retry changes any of them, so the job ends and its
// staging is cleaned up.
//
// A transport that carries its own verdict is believed rather than second-
// guessed: SourceCallbackError sets `recoverable === false` for exactly the
// statuses a retry cannot get past.
const PERMANENT_INGEST_ERRORS = new Set([
  'ETAG_MISMATCH',
  'SOURCE_ETAG_MISMATCH',
  'SOURCE_LENGTH_MISMATCH',
  'PUBLICATION_INVALID',
  'SPOOL_CHUNK_INVALID',
  'SPOOL_INCOMPLETE',
  'SPOOL_OWNERSHIP_INVALID',
  'SPOOL_PATH_INVALID',
  'SPOOL_TYPE_INVALID'
])
// Consent, and only consent. A job stops being a job because the caller
// cancelled it or because the retention policy that admitted it no longer does
// — never because a connection died or a viewer closed a tab.
const CONSENT_WITHDRAWN_ERRORS = new Set([
  'RETENTION_ADMISSION_DENIED',
  'STORAGE_ADMISSION_DENIED'
])
const SPOOL_FIELDS = new Set(['path', 'complete', 'mimeType', 'byteLength', 'sha256', 'etag'])
const RETENTION_CLASSES = new Set(['contribution-cache', 'archive-pin'])
const SOURCE_KINDS = new Set(['public-torrent', 'release', 'folder', 'archive'])
const TERMINAL = new Set(TERMINAL_INGEST_JOB_STATES)
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const NAMESPACE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/
const TOKEN = /^[a-z0-9][a-z0-9._+-]{0,63}$/
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/
const LOCATOR = /^(?:[a-z][a-z0-9+.-]*:(?=\S)|\/\/)/i
const SENSITIVE_FIELD = /(?:url|uri|href|link|magnet|cookie|authorization|credential|secret|password|passkey|debrid|headers?|capability|spool|localpath|filepath|torrentfile|privateinfohash|tracker(?:url|id|announce)?)/i
const SENSITIVE_VALUE = /(?:[a-z][a-z0-9+.-]*:\/\/|\bmagnet:|\b(?:passkey|authkey|torrent[_-]?pass|private[_-]?infohash|tracker(?:url|id))\s*[:=])/i
const MAX_SAFE_MEDIA_BYTES = 500 * 1024 * 1024 * 1024
const MAX_PROGRESS_INTERVAL = 4 * 1024 * 1024
const SHA256_BYTES = 32

export class IngestJobError extends Error {
  constructor (code, message = code, statusCode = 400) {
    super(`${code}: ${message}`)
    this.name = 'IngestJobError'
    this.code = code
    this.statusCode = statusCode
  }
}

function fail (code, message, statusCode = 400) {
  throw new IngestJobError(code, message, statusCode)
}

function isObject (value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function onlyFields (value, fields, name) {
  if (!isObject(value)) fail('INGEST_REQUEST_INVALID', `${name} must be an object`)
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) fail('INGEST_REQUEST_INVALID', `${name} contains unknown field ${key}`)
  }
  return value
}

function byteLength (value) {
  return b4a.byteLength(value)
}

function containsControlCharacter (value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 31 || (code >= 127 && code <= 159)) return true
  }
  return false
}

function text (value, name, maximum, { required = true, lower = false, pattern = null } = {}) {
  if (value == null && !required) return null
  if (typeof value !== 'string') fail('INGEST_REQUEST_INVALID', `${name} must be a string`)
  let normalized = value.normalize('NFC').trim()
  if (lower) normalized = normalized.toLowerCase()
  if (!normalized || byteLength(normalized) > maximum || containsControlCharacter(normalized) || LOCATOR.test(normalized)) {
    fail('INGEST_REQUEST_INVALID', `${name} must be a bounded non-locator string`)
  }
  if (pattern && !pattern.test(normalized)) fail('INGEST_REQUEST_INVALID', `${name} has an invalid format`)
  return normalized
}

function integer (value, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('INGEST_REQUEST_INVALID', `${name} must be a bounded integer`)
  }
  return value
}

function optionalInteger (value, name, options) {
  return value == null ? null : integer(value, name, options)
}

function assertNoSensitiveMaterial (value, depth = 0, state = { nodes: 0, seen: new Set() }) {
  if (depth > 16 || ++state.nodes > 512) fail('INGEST_REQUEST_INVALID', 'ingest request exceeds its bounds')
  if (typeof value === 'string') {
    if (byteLength(value) > 4096 || LOCATOR.test(value) || SENSITIVE_VALUE.test(value)) fail('INGEST_REQUEST_INVALID', 'ingest request contains prohibited locator material')
    return
  }
  if (!value || typeof value !== 'object') return
  if (state.seen.has(value)) fail('INGEST_REQUEST_INVALID', 'ingest request contains a cycle')
  state.seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > 128) fail('INGEST_REQUEST_INVALID', 'ingest request array exceeds its bound')
      for (const child of value) assertNoSensitiveMaterial(child, depth + 1, state)
      return
    }
    for (const [key, child] of Object.entries(value)) {
      const compact = key.replaceAll('-', '').replaceAll('_', '')
      if (key !== 'publicTrackerIndependent' && SENSITIVE_FIELD.test(compact)) {
        fail('INGEST_REQUEST_INVALID', `ingest request contains prohibited field ${key}`)
      }
      assertNoSensitiveMaterial(child, depth + 1, state)
    }
  } finally {
    state.seen.delete(value)
  }
}

function normalizeMediaContext (input) {
  if (!isObject(input)) fail('INGEST_REQUEST_INVALID', 'mediaContext must be an object')
  if (input.kind === 'movie') {
    onlyFields(input, MOVIE_FIELDS, 'mediaContext')
    return {
      kind: 'movie',
      namespace: text(input.namespace, 'mediaContext.namespace', 64, { lower: true, pattern: NAMESPACE }),
      identifier: text(input.identifier, 'mediaContext.identifier', 512)
    }
  }
  if (input.kind !== 'episode') fail('INGEST_REQUEST_INVALID', 'mediaContext.kind must be movie or episode')
  onlyFields(input, EPISODE_FIELDS, 'mediaContext')
  const hasProviderNamespace = input.providerEpisodeNamespace != null
  const hasProviderIdentifier = input.providerEpisodeIdentifier != null
  if (hasProviderNamespace !== hasProviderIdentifier) {
    fail('INGEST_REQUEST_INVALID', 'provider episode coordinates must be supplied together')
  }
  const result = {
    kind: 'episode',
    seriesNamespace: text(input.seriesNamespace, 'mediaContext.seriesNamespace', 64, { lower: true, pattern: NAMESPACE }),
    seriesIdentifier: text(input.seriesIdentifier, 'mediaContext.seriesIdentifier', 512),
    seasonNumber: integer(input.seasonNumber, 'mediaContext.seasonNumber', { minimum: 1, maximum: 100_000 }),
    episodeNumber: integer(input.episodeNumber, 'mediaContext.episodeNumber', { minimum: 1, maximum: 100_000 })
  }
  if (hasProviderNamespace) {
    result.providerEpisodeNamespace = text(input.providerEpisodeNamespace, 'mediaContext.providerEpisodeNamespace', 64, { lower: true, pattern: NAMESPACE })
    result.providerEpisodeIdentifier = text(input.providerEpisodeIdentifier, 'mediaContext.providerEpisodeIdentifier', 512)
  }
  return result
}

function normalizeTokenArray (values, name, maximum) {
  if (values == null) return []
  if (!Array.isArray(values) || values.length > maximum) fail('INGEST_REQUEST_INVALID', `${name} must be a bounded array`)
  const normalized = values.map((value, index) => text(value, `${name}[${index}]`, 64, { lower: true, pattern: TOKEN }))
  return [...new Set(normalized)].sort()
}

function normalizeAudioTrack (input, index) {
  onlyFields(input, AUDIO_FIELDS, `measuredFacts.audioTracks[${index}]`)
  const result = {}
  if (input.codec != null) result.codec = text(input.codec, `measuredFacts.audioTracks[${index}].codec`, 64, { lower: true, pattern: TOKEN })
  if (input.channels != null) result.channels = integer(input.channels, `measuredFacts.audioTracks[${index}].channels`, { minimum: 1, maximum: 64 })
  const languages = normalizeTokenArray(input.languages, `measuredFacts.audioTracks[${index}].languages`, 16)
  if (languages.length) result.languages = languages
  if (Object.keys(result).length === 0) fail('INGEST_REQUEST_INVALID', 'audio track must contain measured facts')
  return result
}

function normalizeSubtitleTrack (input, index) {
  onlyFields(input, SUBTITLE_FIELDS, `measuredFacts.subtitleTracks[${index}]`)
  const result = {}
  if (input.format != null) result.format = text(input.format, `measuredFacts.subtitleTracks[${index}].format`, 64, { lower: true, pattern: TOKEN })
  if (input.language != null) result.language = text(input.language, `measuredFacts.subtitleTracks[${index}].language`, 64, { lower: true, pattern: TOKEN })
  if (Object.keys(result).length === 0) fail('INGEST_REQUEST_INVALID', 'subtitle track must contain measured facts')
  return result
}

function normalizeMeasuredFacts (input) {
  onlyFields(input, MEASURED_FIELDS, 'measuredFacts')
  const result = {
    byteLength: integer(input.byteLength, 'measuredFacts.byteLength', { minimum: 1, maximum: MAX_SAFE_MEDIA_BYTES }),
    container: text(input.container, 'measuredFacts.container', 64, { lower: true, pattern: TOKEN })
  }
  if (input.title != null) result.title = text(input.title, 'measuredFacts.title', 256)
  const durationMs = optionalInteger(input.durationMs, 'measuredFacts.durationMs', { minimum: 0, maximum: 7 * 24 * 60 * 60 * 1000 })
  if (durationMs != null) result.durationMs = durationMs
  if (input.videoCodec != null) result.videoCodec = text(input.videoCodec, 'measuredFacts.videoCodec', 64, { lower: true, pattern: TOKEN })
  const width = optionalInteger(input.width, 'measuredFacts.width', { minimum: 1, maximum: 65_535 })
  const height = optionalInteger(input.height, 'measuredFacts.height', { minimum: 1, maximum: 65_535 })
  if ((width == null) !== (height == null)) fail('INGEST_REQUEST_INVALID', 'measured width and height must be supplied together')
  if (width != null) {
    result.width = width
    result.height = height
  }
  if (input.resolutionLabel != null) result.resolutionLabel = text(input.resolutionLabel, 'measuredFacts.resolutionLabel', 32, { lower: true, pattern: TOKEN })
  const hdrFormats = normalizeTokenArray(input.hdrFormats, 'measuredFacts.hdrFormats', 8)
  if (hdrFormats.length) result.hdrFormats = hdrFormats
  if (input.audioTracks != null) {
    if (!Array.isArray(input.audioTracks) || input.audioTracks.length > 16) fail('INGEST_REQUEST_INVALID', 'audioTracks must be a bounded array')
    result.audioTracks = input.audioTracks.map(normalizeAudioTrack)
  }
  if (input.subtitleTracks != null) {
    if (!Array.isArray(input.subtitleTracks) || input.subtitleTracks.length > 32) fail('INGEST_REQUEST_INVALID', 'subtitleTracks must be a bounded array')
    result.subtitleTracks = input.subtitleTracks.map(normalizeSubtitleTrack)
  }
  return result
}

function normalizeSha256 (value, name, required = false) {
  if (value == null && !required) return null
  if (typeof value !== 'string') fail('INGEST_REQUEST_INVALID', `${name} must be a SHA-256 digest`)
  const normalized = value.trim().toLowerCase().replace(/^sha256:/, '')
  if (!/^[0-9a-f]{64}$/.test(normalized)) fail('INGEST_REQUEST_INVALID', `${name} must be a SHA-256 digest`)
  return normalized
}

/**
 * `expected` is the request's claim about which bytes this job is for, and every
 * later check is against it.
 *
 * `sha256` is OPTIONAL, because a granted remote source cannot state one: a
 * whole-file digest of a debrid-backed title means pulling every byte of it
 * through client application first, which is the exact cost the granted path exists to
 * avoid. A local file still sends a real digest and is still verified against it
 * byte for byte — a digest that is PRESENT is never skipped.
 *
 * What is not optional is having SOME identity: a request with neither a digest
 * nor an ETag claims nothing about its content beyond a length, and nothing
 * downstream could ever catch it being handed the wrong title. So at least one
 * of the two is required.
 */
function normalizeExpected (input, measuredBytes) {
  onlyFields(input, EXPECTED_FIELDS, 'expected')
  const byteLength = integer(input.byteLength, 'expected.byteLength', { minimum: 1, maximum: MAX_SAFE_MEDIA_BYTES })
  if (byteLength !== measuredBytes) fail('INGEST_REQUEST_INVALID', 'expected byte length must equal measured byte length')
  const sha256 = normalizeSha256(input.sha256, 'expected.sha256')
  const result = { byteLength, sha256 }
  if (input.etag != null) result.etag = text(input.etag, 'expected.etag', 256)
  if (sha256 === null && result.etag === undefined) {
    fail('INGEST_REQUEST_INVALID', 'expected must carry a SHA-256 digest or an ETag')
  }
  return result
}

function normalizeSourcePath (value) {
  const source = text(value, 'bundleProvenance.sourcePath', 1024).replaceAll('\\', '/')
  if (source.startsWith('/') || source.includes('?') || source.includes('#') || /^[a-z]:/i.test(source)) {
    fail('INGEST_REQUEST_INVALID', 'bundle source path must be relative')
  }
  const parts = source.split('/').filter(part => part !== '' && part !== '.')
  if (!parts.length || parts.some(part => part === '..')) fail('INGEST_REQUEST_INVALID', 'bundle source path must not escape')
  return parts.join('/')
}

function normalizeBundleProvenance (input) {
  onlyFields(input, BUNDLE_FIELDS, 'bundleProvenance')
  if (!SOURCE_KINDS.has(input.sourceKind)) fail('INGEST_REQUEST_INVALID', 'bundle sourceKind must be public and bounded')
  const result = { sourceKind: input.sourceKind }
  if (input.releaseName != null) result.releaseName = text(input.releaseName, 'bundleProvenance.releaseName', 512)
  if (input.sourcePath != null) result.sourcePath = normalizeSourcePath(input.sourcePath)
  const fileIndex = optionalInteger(input.fileIndex, 'bundleProvenance.fileIndex', { minimum: 0, maximum: 100_000 })
  const memberCount = optionalInteger(input.memberCount, 'bundleProvenance.memberCount', { minimum: 1, maximum: 100_000 })
  if ((fileIndex == null) !== (memberCount == null)) fail('INGEST_REQUEST_INVALID', 'bundle fileIndex and memberCount must be supplied together')
  if (fileIndex != null) {
    if (fileIndex >= memberCount) fail('INGEST_REQUEST_INVALID', 'bundle fileIndex is outside memberCount')
    result.fileIndex = fileIndex
    result.memberCount = memberCount
  }
  if (input.sourceRoot != null) result.sourceRoot = normalizeSha256(input.sourceRoot, 'bundleProvenance.sourceRoot', true)
  if (input.publicInfohash != null) {
    if (input.sourceKind !== 'public-torrent' || input.publicTrackerIndependent !== true) {
      fail('INGEST_REQUEST_INVALID', 'publicInfohash requires explicit tracker-independent public attestation')
    }
    const infohash = String(input.publicInfohash).trim().toLowerCase()
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(infohash)) fail('INGEST_REQUEST_INVALID', 'publicInfohash must be a v1 or v2 infohash')
    result.publicInfohash = infohash
    result.publicTrackerIndependent = true
  } else if (input.publicTrackerIndependent != null) {
    fail('INGEST_REQUEST_INVALID', 'public tracker attestation requires publicInfohash')
  }
  return result
}

export function normalizeIngestRequest (input) {
  assertNoSensitiveMaterial(input)
  onlyFields(input, REQUEST_FIELDS, 'request')
  if (!RETENTION_CLASSES.has(input.retentionClass)) fail('INGEST_REQUEST_INVALID', 'retentionClass is invalid')
  const measuredFacts = normalizeMeasuredFacts(input.measuredFacts)
  const result = {
    retentionClass: input.retentionClass,
    mediaContext: normalizeMediaContext(input.mediaContext),
    measuredFacts,
    expected: normalizeExpected(input.expected, measuredFacts.byteLength)
  }
  if (input.bundleProvenance != null) result.bundleProvenance = normalizeBundleProvenance(input.bundleProvenance)
  return result
}

function canonicalize (value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function hashHex (domain, value) {
  return b4a.toString(crypto.hash(b4a.from(`${domain}\u0000${value}`)), 'hex')
}

export function canonicalIngestRequest (request) {
  return canonicalize(normalizeIngestRequest(request))
}

export function fingerprintIngestRequest (request) {
  return hashHex('peartube.companion.ingest.request.v1', canonicalIngestRequest(request))
}

function normalizedFingerprint (request) {
  return hashHex('peartube.companion.ingest.request.v1', canonicalize(request))
}

function jobIdFor (idempotencyKey, fingerprint) {
  return `ing_${hashHex('peartube.companion.ingest.job.v1', `${idempotencyKey}\u0000${fingerprint}`).slice(0, 32)}`
}

export function ingestJobIdForRequest (idempotencyKey, request) {
  const key = text(idempotencyKey, 'idempotencyKey', 128, { pattern: ID })
  const normalized = normalizeIngestRequest(request)
  return jobIdFor(key, normalizedFingerprint(normalized))
}

function publicJob (job) {
  if (!job) return null
  const publication = job.publication || {}
  return Object.freeze({
    schemaVersion: job.schemaVersion,
    jobId: job.jobId,
    state: job.state,
    retentionClass: job.retentionClass,
    bytesReceived: job.bytesReceived,
    expectedBytes: job.expectedBytes,
    publicationId: publication.publicationId || null,
    manifestId: publication.manifestId || null,
    renditionId: publication.renditionId || null,
    assetId: publication.assetId || null,
    coreKey: publication.coreKey || null,
    errorCode: job.errorCode || null,
    recoverable: job.recoverable === true,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  })
}

function normalizeSourceCapability (value) {
  if (value == null) return null
  if (typeof value !== 'string' || value.length < 16 || value.length > 256 || !/^[A-Za-z0-9._~-]+$/.test(value)) {
    fail('SOURCE_CAPABILITY_INVALID', 'source capability is invalid')
  }
  return value
}

function normalizeSpoolDescriptor (input, request, { spoolRoot, fs, path }) {
  onlyFields(input, SPOOL_FIELDS, 'spool')
  if (input.complete !== true) fail('SPOOL_INCOMPLETE', 'spool must be complete')
  const relative = text(input.path, 'spool.path', 1024)
  if (relative.startsWith('/') || relative.startsWith('\\') || relative.includes('\\') || /^[a-z]:/i.test(relative)) {
    fail('SPOOL_PATH_INVALID', 'spool path must be relative to companion storage')
  }
  const parts = relative.split('/')
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..')) {
    fail('SPOOL_PATH_INVALID', 'spool path must not escape companion storage')
  }
  fs.mkdirSync(spoolRoot, { recursive: true })
  let current = spoolRoot
  const rootStat = fs.lstatSync(spoolRoot)
  if (rootStat.isSymbolicLink?.() || !rootStat.isDirectory?.()) fail('SPOOL_PATH_INVALID', 'spool root is invalid')
  for (const part of parts) {
    current = path.join(current, part)
    let entry
    try {
      entry = fs.lstatSync(current)
    } catch {
      fail('SPOOL_PATH_INVALID', 'spool path does not exist')
    }
    if (entry.isSymbolicLink?.()) fail('SPOOL_PATH_INVALID', 'spool path must not contain symbolic links')
  }
  const stat = fs.statSync(current)
  if (!stat.isFile?.()) fail('SPOOL_TYPE_INVALID', 'spool must be a regular file')
  const currentUid = typeof process?.getuid === 'function' ? process.getuid() : null
  if (currentUid != null && Number.isInteger(stat.uid) && stat.uid !== currentUid) fail('SPOOL_PATH_INVALID', 'spool is not companion-owned')
  const byteLength = integer(input.byteLength, 'spool.byteLength', { minimum: 1, maximum: MAX_SAFE_MEDIA_BYTES })
  if (byteLength !== request.expected.byteLength || stat.size !== byteLength) fail('SPOOL_LENGTH_MISMATCH', 'spool length does not match expected media length')
  const mimeType = text(input.mimeType, 'spool.mimeType', 128, { lower: true, pattern: MIME_TYPE })
  const sha256 = normalizeSha256(input.sha256, 'spool.sha256')
  if (sha256 && request.expected.sha256 && sha256 !== request.expected.sha256) fail('HASH_MISMATCH', 'spool hash attestation does not match expected hash')
  const etag = input.etag == null ? null : text(input.etag, 'spool.etag', 256)
  if (request.expected.etag != null && etag !== request.expected.etag) fail('ETAG_MISMATCH', 'spool ETag does not match expected ETag')
  return Object.freeze({ filePath: current, relativePath: parts.join('/'), mimeType, byteLength, sha256, etag })
}

function sha256State () {
  const state = b4a.alloc(sodium.crypto_hash_sha256_STATEBYTES)
  sodium.crypto_hash_sha256_init(state)
  return {
    update (chunk) { sodium.crypto_hash_sha256_update(state, chunk) },
    digest () {
      const result = b4a.alloc(SHA256_BYTES)
      sodium.crypto_hash_sha256_final(state, result)
      return b4a.toString(result, 'hex')
    }
  }
}

function publicationIdentifier (value, field, required = true) {
  if (value == null && !required) return null
  if (typeof value !== 'string' ||
      value !== value.normalize('NFC').trim() ||
      byteLength(value) > 512 ||
      !TOKEN.test(value)) {
    fail('PUBLICATION_INVALID', `publication result has invalid ${field}`, 502)
  }
  return value
}

function publicationFromMetadata (job, channelInfo, metadata) {
  const immutable = metadata?.immutablePublication
  if (!immutable || typeof immutable !== 'object') return null
  return {
    videoId: publicationIdentifier(job.publicationFence.videoId, 'videoId'),
    publicationId: publicationIdentifier(immutable.publicationId, 'publicationId'),
    manifestId: publicationIdentifier(immutable.manifestId, 'manifestId'),
    renditionId: publicationIdentifier(immutable.renditionId, 'renditionId'),
    assetId: publicationIdentifier(immutable.assetId, 'assetId'),
    coreKey: publicationIdentifier(immutable.coreKey, 'coreKey'),
    channelKey: publicationIdentifier(channelInfo.channelKey, 'channelKey'),
    publicBeeKey: publicationIdentifier(channelInfo.publicBeeKey, 'publicBeeKey', false),
    publisherId: publicationIdentifier(channelInfo.publisherId, 'publisherId')
  }
}

function sourceIdentityFor (job) {
  const context = job.request.mediaContext
  const title = job.request.measuredFacts.title || (context.kind === 'movie'
    ? context.identifier
    : `${context.seriesIdentifier} S${context.seasonNumber}E${context.episodeNumber}`)
  return {
    sourceId: `companion-${hashHex('peartube.companion.ingest.work.v1', canonicalize(context)).slice(0, 32)}`,
    creatorName: title
  }
}

function publicationErrorCode (error, state) {
  if (error instanceof IngestJobError && ERROR_CODE.test(error.code)) return error.code
  // A source callback failure names itself. It used to be flattened into
  // ACQUISITION_FAILED, which told an operator nothing about whether the grant
  // had expired, the bucket was throttling, or the file was gone — and told the
  // recovery decision below nothing either.
  if (error?.name === 'SourceCallbackError' && ERROR_CODE.test(error.code || '')) return error.code
  if (state === 'acquiring') return 'ACQUISITION_FAILED'
  if (state === 'verifying') return 'VERIFICATION_FAILED'
  if (state === 'publishing') return 'PUBLICATION_FAILED'
  return 'INGEST_FAILED'
}

/**
 * Can a resubmit of this job get past this failure, or is the job over?
 */
function ingestFailureIsPermanent (error, code) {
  if (error?.name === 'SourceCallbackError') return error.recoverable === false
  return PERMANENT_INGEST_ERRORS.has(code)
}

export function createIngestManager ({
  store,
  publisher,
  spoolRoot,
  fs = defaultFs,
  path = defaultPath,
  sourceClient = null,
  sourceRegistry = null,
  // it with it. Both absent means block offload is unconfigured, no staging
  // state can exist, and reclamation is a no-op.
  assetStore = null,
  createStagingStore = null,
  canIngest = () => false,
  verifyChunkBytes = 256 * 1024,
  now = () => Date.now(),
  logger = null
} = {}) {
  if (!store) throw new TypeError('ingest manager requires a job store')
  if (!publisher || typeof publisher.ensureAnonymousChannel !== 'function' || typeof publisher.importVideo !== 'function') {
    throw new TypeError('ingest manager requires the archive publisher')
  }
  if (typeof spoolRoot !== 'string' || !spoolRoot) throw new TypeError('ingest manager requires companion spool storage')
  if (!Number.isSafeInteger(verifyChunkBytes) || verifyChunkBytes < 1 || verifyChunkBytes > 1024 * 1024) {
    throw new TypeError('verifyChunkBytes must be between 1 and 1048576')
  }
  if (sourceClient != null && (
    typeof sourceClient.head !== 'function' ||
    typeof sourceClient.getRange !== 'function' ||
    typeof sourceClient.revoke !== 'function' ||
    !Number.isSafeInteger(sourceClient.chunkBytes) ||
    sourceClient.chunkBytes < 1
  )) {
    throw new TypeError('sourceClient must implement bounded source callbacks')
  }
  const stagingOwned = Boolean(assetStore) && typeof createStagingStore === 'function'
  const registry = sourceRegistry || createSourceProviderRegistry({ fs, legacySourceClient: sourceClient })

  const ephemeral = new Map()
  const active = new Map()
  let started = false
  let closing = false
  const sourceSpoolRoot = path.join(spoolRoot, 'sources')
  let closed = false

  let mutations = Promise.resolve()

  function serializeMutation (operation) {
    const result = mutations.then(operation, operation)
    mutations = result.catch(() => {})
    return result
  }

  function assertSubmissionActive (signal) {
    if (closed || closing) fail('INGEST_MANAGER_CLOSED', 'ingest manager is closed', 503)
    if (signal?.aborted) fail('CANCELLED', 'ingest submission was cancelled', 499)
  }

  function buildJob (idempotencyKey, idempotencyDigest, request, fingerprint) {
    const jobId = jobIdFor(idempotencyKey, fingerprint)
    const timestamp = now()
    return {
      schemaVersion: 1,
      jobId,
      state: 'queued',
      version: 0,
      idempotencyDigest,
      requestFingerprint: fingerprint,
      request,
      retentionClass: request.retentionClass,
      bytesReceived: 0,
      expectedBytes: request.expected.byteLength,
      publicationFence: {
        version: 1,
        videoId: hashHex('peartube.companion.ingest.publication.v1', jobId).slice(0, 32)
      },
      publication: null,
      errorCode: null,
      recoverable: false,
      createdAt: timestamp,
      updatedAt: timestamp
    }
  }

  function cleanupSpool (spool, jobId = null) {
    if (!spool?.filePath) return
    try {
      const relativeParts = String(spool.relativePath || '').split('/')
      const parent = path.dirname(spool.filePath)
      if (relativeParts.length === 3 && relativeParts[0] === 'uploads' && parent && parent !== spoolRoot) {
        fs.rmSync(parent, { recursive: true, force: true })
      } else {
        fs.rmSync(spool.filePath, { force: true })
      }
    } catch (error) {
      logger?.archive?.warn?.('Companion ingest staging cleanup failed', { jobId, error: error?.code || 'CLEANUP_FAILED' })
    }
  }

  function acceptSpoolLease (lease, spool) {
    if (lease == null) return
    if (typeof lease.accept !== 'function' || lease.accept(spool) !== true) {
      fail('SPOOL_OWNERSHIP_INVALID', 'ingest spool ownership handoff failed', 500)
    }
  }

  function discardUnacceptedSpool (lease, spool, jobId) {
    if (lease == null) cleanupSpool(spool, jobId)
  }

  function cleanupAttachment (jobId) {
    const attachment = ephemeral.get(jobId)
    ephemeral.delete(jobId)
    cleanupSpool(attachment?.spool, jobId)
  }

  // A granted ingest keeps its part-read title in the staging core the asset
  // writer opened under this job id, NOT on the volume. So the thing to reclaim
  // when a job ends for good is that staging state, and the job id is the only
  // handle needed to find it again — after a restart, with nothing held in
  // memory.
  //
  // Best effort on purpose: a bucket that refuses a delete must not turn a
  // cancellation into a failure, and the startup sweep is the backstop, because
  // a terminal job's id is in `ids` and never in `keep`.
  async function reclaimStaging (jobId) {
    if (!stagingOwned) return
    try {
      const outcome = await reclaimStagingState({ store: assetStore, id: jobId, createStagingStore })
      if (outcome.blocks > 0 || outcome.reclaimed !== true) {
        logger?.archive?.info?.('Companion ingest staging state reclaimed', {
          jobId,
          blocks: outcome.blocks,
          deleted: outcome.deleted,
          orphaned: outcome.orphaned.length,
          reclaimed: outcome.reclaimed
        })
      }
    } catch (error) {
      logger?.archive?.warn?.('Companion ingest staging reclamation failed', {
        jobId,
        error: ERROR_CODE.test(error?.code || '') ? error.code : 'STAGING_RECLAIM_FAILED'
      })
    }
  }

  async function revokeAttachmentSource (jobId, attachment = ephemeral.get(jobId)) {
    if (!attachment?.sourceCapability) return
    try {
      if (sourceClient) await sourceClient.revoke({ capability: attachment.sourceCapability, jobId })
    } catch (error) {
      logger?.archive?.warn?.('Companion source grant revocation failed', {
        jobId,
        errorCode: ERROR_CODE.test(error?.code || '') ? error.code : 'SOURCE_REVOKE_FAILED'
      })
    }
  }

  async function channelFor (job) {
    const sourceIdentity = sourceIdentityFor(job)
    return publisher.ensureAnonymousChannel({
      channelName: sourceIdentity.creatorName,
      sourceIdentity,
      requireSourceChannel: true,
      retentionClass: job.retentionClass
    })
  }

  async function lookupPublication (job) {
    const durable = await store.getPublicationResult(job.publicationFence.videoId)
    if (durable?.jobId === job.jobId && durable.result) return { result: durable.result, channelInfo: null, metadata: null }
    const channelInfo = await channelFor(job)
    const metadata = await channelInfo.channel?.getVideo?.(job.publicationFence.videoId).catch(() => null)
    const result = publicationFromMetadata(job, channelInfo, metadata)
    return result ? { result, channelInfo, metadata } : null
  }

  async function exposePublication (job, channelInfo, metadata) {
    if (channelInfo && typeof publisher.publishCatalog === 'function') {
      await publisher.publishCatalog({ ...channelInfo, retentionClass: job.retentionClass })
    }
    if (job.retentionClass === 'archive-pin' &&
        channelInfo &&
        typeof publisher.retainAssets === 'function') {
      await publisher.retainAssets({
        retentionClass: job.retentionClass,
        ...channelInfo,
        previewVideos: [{
          id: job.publicationFence.videoId,
          immutablePublication: metadata?.immutablePublication || null,
          archivePledge: metadata?.archivePledge || null
        }]
      })
    }
  }

  // Where the bytes come from is the ONLY difference between a spooled ingest
  // and a granted one, so it is the only thing that varies here: `source` is
  // either `{ filePath, mimeType }` for a file this relay already holds, or
  // `{ sourceGrant, mimeType }` for an origin it reads ranges from.
  async function publishJob (job, source, signal) {
    const channelInfo = await channelFor(job)
    const existing = await channelInfo.channel?.getVideo?.(job.publicationFence.videoId).catch(() => null)
    let metadata = existing
    let result = publicationFromMetadata(job, channelInfo, existing)
    if (!result) {
      const context = job.request.mediaContext
      const measured = job.request.measuredFacts
      const sourceVideoId = context.kind === 'movie'
        ? context.identifier
        : (context.providerEpisodeIdentifier || `${context.seriesIdentifier}:${context.seasonNumber}:${context.episodeNumber}`)
      const imported = await publisher.importVideo({
        retentionClass: job.retentionClass,
        channel: channelInfo.channel,
        ...source,
        videoId: job.publicationFence.videoId,
        signal,
        title: measured.title || sourceVideoId,
        description: '',
        duration: measured.durationMs == null ? undefined : measured.durationMs / 1000,
        width: measured.width,
        height: measured.height,
        videoCodec: measured.videoCodec,
        contentKind: context.kind,
        mediaProvider: context.kind === 'movie' ? context.namespace : context.seriesNamespace,
        mediaId: context.kind === 'movie' ? context.identifier : context.seriesIdentifier,
        seasonNumber: context.kind === 'episode' ? context.seasonNumber : undefined,
        episodeNumber: context.kind === 'episode' ? context.episodeNumber : undefined,
        sourceType: job.request.bundleProvenance?.sourceKind || 'companion-ingest',
        sourceVideoId,
        publish: true
      })
      metadata = imported?.metadata || null
      result = publicationFromMetadata(job, channelInfo, metadata)
      if (!result) fail('PUBLICATION_INVALID', 'static publisher returned no immutable publication', 502)
    }
    await exposePublication(job, channelInfo, metadata)
    return result
  }

  // Ask the grant what it is serving. No byte of the title is spent here: the
  // total length, the identity and the media type all come from the HEAD, which
  // is what lets the retention budget and the storage gates be answered before
  // the first range is requested — the job the spool's `stat` used to do, done
  // earlier and from an authoritative source rather than from a copy.
  async function describeGrantedSource (job, attachment, signal) {
    const resolved = registry.resolveSourceClient(attachment)
    if (!resolved) fail('SOURCE_UNAVAILABLE', 'No usable source provider or callback capability available for this job', 503)
    const { client, params } = resolved
    const isDirect = Boolean(attachment?.sourceDescriptor)
    const etag = isDirect ? null : job.request.expected.etag
    const metadata = await client.head({
      ...params,
      jobId: job.jobId,
      etag: etag || undefined,
      length: isDirect ? undefined : job.expectedBytes,
      signal
    })
    const authoritativeEtag = isDirect ? metadata.etag : etag
    return {
      client,
      capability: resolved.type === 'legacy' ? params.capability : params,
      etag: authoritativeEtag,
      metadata,
    }
  }

  // Is what the grant serves what this job asked for? For direct source descriptors,
  // the client's direct probe is authoritative. For legacy grants, the stated expectation
  // must match what the remote callback serves.
  function verifyGrantedSource (job, granted) {
    if (granted.metadata.length !== job.expectedBytes) fail('SOURCE_LENGTH_MISMATCH', 'source length does not match')
    if (granted.etag && granted.metadata.etag !== granted.etag) fail('SOURCE_ETAG_MISMATCH', 'source ETag does not match')
  }

  // How far a granted ingest has got. The bytes arrive during publication now
  // rather than into a file beforehand, so this is where progress comes from.
  // One write per range, exactly the cadence the download loop used to keep —
  // the grant's range size IS the granularity — and forward only, because a
  // resumed attempt starts at the offset its staged prefix reached, which can be
  // behind what an earlier attempt reported.
  function grantedProgress (job) {
    let current = job
    let persisted = job.bytesReceived
    return {
      get job () { return current },
      async record (bytes) {
        if (bytes <= persisted) return
        try {
          current = await store.updateProgress(current.jobId, {
            expectedVersion: current.version,
            state: 'publishing',
            bytesReceived: bytes
          })
          persisted = bytes
        } catch {
          // A progress figure must never be the thing that fails an ingest. If
          // the version drifted — the job was cancelled from under this pass,
          // say — re-base on what is durable and keep the bytes flowing; the
          // abort check below is what actually stops this run.
          current = (await store.getJob(current.jobId).catch(() => null)) || current
          persisted = current.bytesReceived
        }
      }
    }
  }

  // Failures the ranged source raises in this manager's own vocabulary are
  // adopted as such, so a granted ingest and a spooled one classify a mismatched
  // digest identically. Everything else — a transport carrying its own verdict,
  // this manager's own consent errors — travels exactly as it was thrown.
  function adoptSourceFailure (error) {
    if (error instanceof IngestJobError) return error
    if (error?.code === 'HASH_MISMATCH') {
      return new IngestJobError('HASH_MISMATCH', 'granted source bytes do not match the expected digest')
    }
    return error
  }

  // The grant, in the shape the archive publisher opens ranges from.
  //
  // `jobId` is doing two jobs and must be the durable one for both: the grant
  // authorizes ranges against it, and the asset writer names the staging core
  // that carries a part-read title between attempts after it. That is what lets
  // a resumed attempt — even one on the far side of a relay restart — find the
  // prefix the last one left instead of downloading the title again.
  //
  // The consent and cancellation gates that used to run per range inside the
  // download loop run here, once per range, for the same reason: an hour-long
  // ingest has to notice that the operator withdrew permission.
  function grantedSourceFor (job, granted, progress, entry) {
    return {
      client: granted.client || sourceClient,
      capability: granted.capability,
      jobId: job.jobId,
      etag: granted.etag,
      length: job.expectedBytes,
      sha256: job.request.expected.sha256 ?? null,
      onProgress: async (bytes) => {
        if (entry.controller.signal.aborted) fail('CANCELLED', 'ingest was cancelled', 499)
        if (!canIngest(job.request)) fail('RETENTION_ADMISSION_DENIED', 'retention permission was withdrawn', 403)
        await progress.record(bytes)
      },
      onFailure: (error) => { entry.sourceFailure = adoptSourceFailure(error) }
    }
  }

  async function verifySpool (job, spool, signal) {
    const hasher = sha256State()
    const stream = fs.createReadStream(spool.filePath, { highWaterMark: verifyChunkBytes })
    let bytesReceived = 0
    let persistedAt = job.bytesReceived
    let current = job
    let pending = Promise.resolve()
    let settled = false

    return new Promise((resolve, reject) => {
      const finish = (error = null) => {
        if (settled) return
        settled = true
        signal?.removeEventListener?.('abort', abort)
        if (error) reject(error)
        else pending.then(() => {
          if (bytesReceived !== job.expectedBytes) fail('SPOOL_LENGTH_MISMATCH', 'spool ended at the wrong length')
          // A digest that was stated is always checked. One that was not stated
          // is not invented: a granted remote source cannot produce a whole-file
          // SHA-256 without first pulling the whole file, so its identity is
          // carried by the ETag matched on HEAD and on every single range, plus
          // the exact-length framing of each of those ranges. The read still
          // happens either way — it is what enforces the length above and feeds
          // the merkle tree the asset key comes from.
          const expected = job.request.expected.sha256
          const digest = hasher.digest()
          if (expected !== null && expected !== undefined && digest !== expected) {
            fail('HASH_MISMATCH', 'spool SHA-256 does not match')
          }
          resolve(current)
        }).catch(reject)
      }
      const abort = () => stream.destroy(new IngestJobError('CANCELLED', 'ingest was cancelled', 499))
      signal?.addEventListener?.('abort', abort, { once: true })
      stream.on('data', chunk => {
        if (chunk.byteLength > verifyChunkBytes) {
          stream.destroy(new IngestJobError('SPOOL_CHUNK_INVALID', 'spool emitted an oversized chunk'))
          return
        }
        bytesReceived += chunk.byteLength
        if (bytesReceived > job.expectedBytes) {
          stream.destroy(new IngestJobError('SPOOL_LENGTH_MISMATCH', 'spool exceeds expected length'))
          return
        }
        hasher.update(b4a.from(chunk))
        if (bytesReceived === job.expectedBytes || bytesReceived - persistedAt >= MAX_PROGRESS_INTERVAL) {
          stream.pause?.()
          const checkpoint = bytesReceived
          pending = pending.then(async () => {
            current = await store.updateProgress(job.jobId, {
              expectedVersion: current.version,
              state: 'verifying',
              bytesReceived: checkpoint
            })
            persistedAt = checkpoint
            stream.resume?.()
          })
          pending.catch(error => stream.destroy(error))
        }
      })
      stream.once('error', finish)
      stream.once('end', () => finish())
      if (signal?.aborted) abort()
    })
  }

  async function markTerminal (jobId, to, errorCode, recoverable = false) {
    const current = await store.getJob(jobId)
    if (!current || TERMINAL.has(current.state)) return current
    const timestampField = to === 'cancelled' ? 'cancelledAt' : 'failedAt'
    return store.transition(jobId, {
      expectedVersion: current.version,
      from: current.state,
      to,
      patch: {
        errorCode,
        recoverable,
        [timestampField]: now()
      }
    })
  }

  async function runJob (jobId, entry) {
    let job = await store.getJob(jobId)
    let attachment = ephemeral.get(jobId)
    try {
      if (!job || job.state !== 'queued') return job
      if (!attachment?.spool && !attachment?.sourceCapability && !attachment?.sourceDescriptor) return job
      if (!canIngest(job.request)) fail('STORAGE_ADMISSION_DENIED', 'retention admission denied', 507)
      job = await store.transition(jobId, { expectedVersion: job.version, from: 'queued', to: 'acquiring' })
      // A file this relay already holds is spooled and verified exactly as it
      // always was. A granted origin is never copied here at all: it is
      // described, checked against the request, and then read as ranges
      // straight into the asset core while it publishes. That is what lets a
      // title be larger than the volume archiving it — and it is why there is
      // no `sources/` spool any more.
      const spool = attachment.spool
        ? normalizeSpoolDescriptor(attachment.descriptor, job.request, { spoolRoot, fs, path })
        : null
      const granted = spool === null
        ? await describeGrantedSource(job, attachment, entry.controller.signal)
        : null
      if (entry.controller.signal.aborted) fail('CANCELLED', 'ingest was cancelled', 499)
      if (!canIngest(job.request)) fail('RETENTION_ADMISSION_DENIED', 'retention permission was withdrawn', 403)
      job = await store.transition(jobId, { expectedVersion: job.version, from: 'acquiring', to: 'verifying' })
      if (spool) job = await verifySpool(job, spool, entry.controller.signal)
      else verifyGrantedSource(job, granted)
      if (entry.controller.signal.aborted) fail('CANCELLED', 'ingest was cancelled', 499)
      if (!canIngest(job.request)) fail('RETENTION_ADMISSION_DENIED', 'retention permission was withdrawn', 403)
      job = await store.transition(jobId, { expectedVersion: job.version, from: 'verifying', to: 'publishing' })
      if (entry.controller.signal.aborted) fail('CANCELLED', 'ingest was cancelled', 499)
      if (!canIngest(job.request)) fail('RETENTION_ADMISSION_DENIED', 'retention permission was withdrawn', 403)
      const progress = spool ? null : grantedProgress(job)
      const result = spool
        ? await publishJob(job, { filePath: spool.filePath, mimeType: spool.mimeType }, entry.controller.signal)
        : await publishJob(job, {
          sourceGrant: grantedSourceFor(job, granted, progress, entry),
          mimeType: granted.metadata.mimeType
        }, entry.controller.signal)
      // A granted ingest records byte progress while it publishes, so the
      // version this pass started with is stale by the time it commits.
      job = await store.completePublication(jobId, { expectedVersion: (progress?.job || job).version, result })
      return job
    } catch (raised) {
      if (closing || entry.closing) return store.getJob(jobId)
      // A granted ingest's bytes flow through the upload manager, which reports
      // a failure as a message rather than as the exception it was. The latched
      // failure is that exception with its identity intact, so the decision
      // below is made on what actually went wrong rather than on a flattened
      // string that says only that publication failed.
      const error = entry.sourceFailure || raised
      // Consent, not liveness. A job is `cancelled` because somebody cancelled
      // it — `cancelJob` sets this before it aborts — and for no other reason.
      // It used to be cancelled by ANY abort reaching here, including one raised
      // downstream when a playback session's connection went away, and a
      // cancelled job's spool is deleted. So a viewer moving on could delete a
      // part-downloaded archive nobody had withdrawn consent for.
      const cancelled = entry.cancelled === true
      const current = await store.getJob(jobId)
      if (current?.state === 'publishing') {
        try {
          const resolved = await lookupPublication(current)
          if (resolved) {
            await exposePublication(current, resolved.channelInfo, resolved.metadata)
            return await store.completePublication(jobId, { expectedVersion: current.version, result: resolved.result })
          }
        } catch (publicationError) {
          // Fall through to the bounded terminal publication error below, but
          // not silently. This is a second failure, while finishing a job that
          // had already reached `publishing`, and swallowed it is
          // indistinguishable from the first — leaving PUBLICATION_FAILED with
          // its cause recorded nowhere at all. Two titles transferred every
          // byte and died here with nothing to explain them.
          logger?.archive?.warn?.('Companion publication could not be finished', {
            jobId,
            reason: publicationError?.message || String(publicationError),
            at: typeof publicationError?.stack === 'string'
              ? publicationError.stack.split('\n').slice(1, 3).map(line => line.trim()).join(' <- ')
              : null
          })
        }
      }
      if (cancelled) {
        const terminal = await markTerminal(jobId, 'cancelled', 'CANCELLED', false)
        await reclaimStaging(jobId)
        return terminal
      }
      const code = publicationErrorCode(error, current?.state || job?.state)
      // `recoverable` decides whether a resubmit resumes from what this job
      // already has or starts again. It used to key off the mere presence of a
      // source capability, which said nothing about whether a retry could get
      // past the failure. Now the failure itself decides.
      const withdrawn = CONSENT_WITHDRAWN_ERRORS.has(code)
      const resumable = !withdrawn && !ingestFailureIsPermanent(error, code)
      const recoverable = resumable && (
        Boolean(attachment?.sourceCapability) ||
        current?.state === 'publishing'
      )
      // A code that came from the job's STATE rather than from the error means
      // the error carried none of its own — an unexpected throw, where the
      // message is the only thing that can ever explain it. PUBLICATION_FAILED
      // is the clearest example: it says only "it broke while publishing".
      const uncoded = !(error?.code && ERROR_CODE.test(String(error.code)))
      logger?.archive?.warn?.('Companion ingest job failed', {
        jobId,
        state: current?.state || null,
        errorCode: code,
        recoverable,
        reason: error?.message || String(error),
        at: uncoded && typeof error?.stack === 'string'
          ? error.stack.split('\n').slice(1, 3).map(line => line.trim()).join(' <- ')
          : null
      })
      const terminal = await markTerminal(jobId, 'failed', code, recoverable)
      // Nothing will ever come back for the staged prefix of a job that cannot
      // be resumed, so it goes with the job. A recoverable one keeps it: that
      // prefix is the entire reason a resubmit is cheap.
      //
      // The second clause is a GUARD, not a live path. Today no job can hold
      // staging state and fail this way: archive-manager's ranged source sets
      // `resumable: digest === null`, so a grant that states a SHA-256 is read
      // in one pass from byte zero and never builds `resume` at all, and the two
      // spool-path producers of these codes never pass `resume` either. So the
      // combination cannot arise — while that gate holds.
      //
      // It is worth keeping because that gate is the tempting thing to relax:
      // it is the only reason a digest-bearing grant cannot resume, and the day
      // someone lets one resume, this line is what stops a condemned prefix
      // being resumed into forever. Relaxing `resumable: digest === null`
      // without this is the bug. See test/poisoned-progress.test.mjs, which
      // reaches the combination deliberately.
      if (!recoverable || SOURCE_RESET_PROGRESS_ERRORS.has(code)) await reclaimStaging(jobId)
      return terminal
    } finally {
      const final = await store.getJob(jobId).catch(() => null)
      attachment = ephemeral.get(jobId) || attachment
      if (TERMINAL.has(final?.state) || closing || entry.closing) {
        await revokeAttachmentSource(jobId, attachment)
        cleanupAttachment(jobId)
      }
    }
  }

  function schedule (jobId) {
    const attachment = ephemeral.get(jobId)
    if (!started || closing || active.has(jobId) || (!attachment?.spool && !attachment?.sourceCapability && !attachment?.sourceDescriptor)) return
    const entry = { controller: new AbortController(), cancelled: false, closing: false, sourceFailure: null, promise: null }
    entry.promise = runJob(jobId, entry).finally(() => {
      if (active.get(jobId) === entry) active.delete(jobId)
    })
    active.set(jobId, entry)
  }

  async function recover (job) {
    if (job.state === 'queued') {
      schedule(job.jobId)
      return
    }
    if (job.state === 'acquiring' || job.state === 'verifying') {
      await markTerminal(job.jobId, 'failed', 'SOURCE_REATTACH_REQUIRED', true)
      return
    }
    if (job.state !== 'publishing') return
    try {
      const resolved = await lookupPublication(job)
      if (!resolved) {
        await markTerminal(job.jobId, 'failed', 'PUBLICATION_RESULT_UNAVAILABLE', true)
        return
      }
      await exposePublication(job, resolved.channelInfo, resolved.metadata)
      await store.completePublication(job.jobId, { expectedVersion: job.version, result: resolved.result })
    } catch {
      await markTerminal(job.jobId, 'failed', 'PUBLICATION_RECOVERY_FAILED', true)
    }
  }

  return Object.freeze({
    async submitJob ({
      idempotencyKey,
      request,
      spool = null,
      sourceCapability = null,
      sourceDescriptor = null,
      ingestSpoolLease = null,
      signal = null
    } = {}) {
      assertSubmissionActive(signal)
      if (ingestSpoolLease != null && spool == null) fail('SPOOL_OWNERSHIP_INVALID', 'ingest spool ownership handoff failed', 500)
      const key = text(idempotencyKey, 'idempotencyKey', 128, { pattern: ID })

      let preppedRequest = request
      if (sourceDescriptor) {
        const resolved = registry.resolveSourceClient({ sourceDescriptor })
        if (!resolved) fail('SOURCE_UNAVAILABLE', 'No usable source provider configured for this descriptor', 503)
        const directProbed = await resolved.client.head({ ...resolved.params, signal })
        if (!Number.isSafeInteger(directProbed?.length) || directProbed.length <= 0) {
          fail('SOURCE_LENGTH_INVALID', 'Direct source provider returned invalid length', 502)
        }
        preppedRequest = {
          ...request,
          expected: {
            ...(request?.expected || {}),
            byteLength: directProbed.length,
            etag: directProbed.etag || request?.expected?.etag
          },
          measuredFacts: {
            ...(request?.measuredFacts || {}),
            byteLength: directProbed.length
          }
        }
      }

      const normalized = normalizeIngestRequest(preppedRequest)
      const fingerprint = normalizedFingerprint(normalized)
      const idempotencyDigest = hashHex('peartube.companion.ingest.idempotency.v1', key)

      return serializeMutation(async () => {
        assertSubmissionActive(signal)
        let existing = await store.findByIdempotency(idempotencyDigest)
        assertSubmissionActive(signal)
        if (existing) {
          if (existing.requestFingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'idempotency key is already bound to another request', 409)
          const incomingCapability = normalizeSourceCapability(sourceCapability)
          const incomingDescriptor = sourceDescriptor || null
          let incomingSpool = null
          let spoolAccepted = false
          let spoolAdopted = false
          let capabilityAdopted = false
          try {
            // A fresh capability is the caller re-authorizing this source, and
            // that has to be able to revive a job that failed for good. Without
            // this, one permanent failure memoizes forever: every later
            // submission gets the old failure back, so a title broken by a bug
            // stays unarchivable even after the bug is fixed. Retry is bounded
            // by whatever makes the caller ask again - for a relay that is a
            // human pressing play, not a loop.
            if (existing.state === 'failed' &&
              (existing.recoverable === true || REVIVABLE_TERMINAL_ERRORS.has(existing.errorCode)) &&
              (spool != null || incomingCapability || incomingDescriptor)) {
              const settling = active.get(existing.jobId)
              if (settling) {
                // The old run owns its attachment through async revocation and
                // cleanup. Wait until its finalizer and active-map deletion
                // finish before a fresh capability can be attached.
                await settling.promise.catch(() => {})
                assertSubmissionActive(signal)
                existing = await store.findByIdempotency(idempotencyDigest)
                if (!existing) fail('INGEST_PERSISTENCE_CORRUPT', 'idempotent ingest job disappeared', 500)
                if (existing.requestFingerprint !== fingerprint) {
                  fail('IDEMPOTENCY_CONFLICT', 'idempotency key is already bound to another request', 409)
                }
              }
            }
            if (spool != null) incomingSpool = normalizeSpoolDescriptor(spool, normalized, { spoolRoot, fs, path })
            const revivable = existing.recoverable === true ||
              REVIVABLE_TERMINAL_ERRORS.has(existing.errorCode)
            if (existing.state === 'failed' && revivable && (incomingSpool || incomingCapability || incomingDescriptor)) {
              existing = await store.reopenRecoverable(existing.jobId, {
                expectedVersion: existing.version,
                // A terminal failure keeps no progress worth trusting: whatever
                // ended it was, by definition, not a transport blip. A
                // recoverable one still resumes from its confirmed bytes.
                resetProgress: existing.recoverable !== true || SOURCE_RESET_PROGRESS_ERRORS.has(existing.errorCode),
                allowUnrecoverable: existing.recoverable !== true
              })
            }
            let attached = ephemeral.get(existing.jobId)
            if (TERMINAL.has(existing.state)) {
              if (incomingSpool) {
                discardUnacceptedSpool(ingestSpoolLease, incomingSpool, existing.jobId)
                incomingSpool = null
              }
              if (incomingCapability) await revokeAttachmentSource(existing.jobId, { sourceCapability: incomingCapability })
              return publicJob(existing)
            }
            if (incomingSpool != null) {
              if (!attached?.spool) {
                // Lease acceptance, attachment, and scheduling are one synchronous ownership handoff.
                assertSubmissionActive(signal)
                acceptSpoolLease(ingestSpoolLease, incomingSpool)
                spoolAccepted = true
                ephemeral.set(existing.jobId, {
                  ...attached,
                  descriptor: spool,
                  spool: incomingSpool,
                  sourceCapability: attached?.sourceCapability || null,
                  sourceDescriptor: attached?.sourceDescriptor || incomingDescriptor
                })
                spoolAdopted = true
                incomingSpool = null
              } else if (incomingSpool.filePath === attached.spool.filePath) {
                assertSubmissionActive(signal)
                acceptSpoolLease(ingestSpoolLease, incomingSpool)
                spoolAccepted = true
                spoolAdopted = true
                incomingSpool = null
              }
            }
            if (incomingSpool) {
              discardUnacceptedSpool(ingestSpoolLease, incomingSpool, existing.jobId)
              incomingSpool = null
            }
            attached = ephemeral.get(existing.jobId) || {}
            if (!attached.sourceCapability && incomingCapability != null) {
              ephemeral.set(existing.jobId, { ...attached, sourceCapability: incomingCapability })
              capabilityAdopted = true
            } else if (!attached.sourceDescriptor && incomingDescriptor != null) {
              ephemeral.set(existing.jobId, { ...attached, sourceDescriptor: incomingDescriptor })
            } else if (incomingCapability != null && incomingCapability !== attached.sourceCapability) {
              await revokeAttachmentSource(existing.jobId, { sourceCapability: incomingCapability })
            }
            if (ephemeral.has(existing.jobId)) schedule(existing.jobId)
            return publicJob(existing)
          } finally {
            if (incomingSpool && !spoolAdopted) {
              if (spoolAccepted) cleanupSpool(incomingSpool, existing.jobId)
              else discardUnacceptedSpool(ingestSpoolLease, incomingSpool, existing.jobId)
            }
            if (incomingCapability && !capabilityAdopted && !TERMINAL.has(existing.state)) {
              const attached = ephemeral.get(existing.jobId)
              if (attached?.sourceCapability !== incomingCapability) {
                await revokeAttachmentSource(existing.jobId, { sourceCapability: incomingCapability })
              }
            }
          }
        }

        if (!canIngest(normalized)) {
          fail('RETENTION_ADMISSION_DENIED', 'explicit retention consent and budget are required', 403)
        }

        const capability = normalizeSourceCapability(sourceCapability)
        const descriptor = sourceDescriptor || null
        const normalizedSpool = spool == null ? null : normalizeSpoolDescriptor(spool, normalized, { spoolRoot, fs, path })
        const initial = buildJob(key, idempotencyDigest, normalized, fingerprint)
        let spoolAccepted = false
        let spoolAdopted = false
        try {
          const outcome = await store.createOrReplay({ idempotencyDigest, requestFingerprint: fingerprint, job: initial })
          assertSubmissionActive(signal)
          if (!TERMINAL.has(outcome.job.state) && (normalizedSpool || capability || descriptor)) {
            const attached = ephemeral.get(outcome.job.jobId) || {}
            // Once accepted, this manager must attach and schedule without another abort checkpoint.
            assertSubmissionActive(signal)
            if (normalizedSpool && !attached.spool) {
              acceptSpoolLease(ingestSpoolLease, normalizedSpool)
              spoolAccepted = true
            } else if (normalizedSpool && normalizedSpool.filePath === attached.spool?.filePath) {
              acceptSpoolLease(ingestSpoolLease, normalizedSpool)
              spoolAccepted = true
              spoolAdopted = true
            }
            ephemeral.set(outcome.job.jobId, {
              descriptor: attached.spool ? attached.descriptor : spool,
              spool: attached.spool || normalizedSpool,
              sourceCapability: attached.sourceCapability || capability,
              sourceDescriptor: attached.sourceDescriptor || descriptor
            })
            if (normalizedSpool && !attached.spool) spoolAdopted = true
            if (normalizedSpool && attached.spool && normalizedSpool.filePath !== attached.spool.filePath) {
              discardUnacceptedSpool(ingestSpoolLease, normalizedSpool, outcome.job.jobId)
            }
            schedule(outcome.job.jobId)
          } else if (normalizedSpool) {
            discardUnacceptedSpool(ingestSpoolLease, normalizedSpool, outcome.job.jobId)
          }
          return publicJob(outcome.job)
        } catch (error) {
          if (normalizedSpool && !spoolAdopted) {
            if (spoolAccepted) cleanupSpool(normalizedSpool, initial.jobId)
            else discardUnacceptedSpool(ingestSpoolLease, normalizedSpool, initial.jobId)
          }
          throw error
        }
      })
    },

    async getJob (jobId) {
      let job = await store.getJob(jobId)
      const running = active.get(jobId)
      if (running && TERMINAL.has(job?.state)) {
        await running.promise.catch(() => {})
        job = await store.getJob(jobId)
      }
      return publicJob(job)
    },

    async getStatus () {
      const jobs = typeof store.listRecent === 'function'
        ? await store.listRecent(64)
        : await store.listActive()
      const jobsByState = {
        queued: 0,
        acquiring: 0,
        verifying: 0,
        publishing: 0,
        completed: 0,
        failed: 0,
        cancelled: 0
      }
      const lastErrors = []
      for (const job of jobs) {
        if (Object.prototype.hasOwnProperty.call(jobsByState, job.state)) jobsByState[job.state]++
        if (job.errorCode && lastErrors.length < 8) lastErrors.push(String(job.errorCode).slice(0, 64))
      }
      return { jobsByState, activeAcquisitions: active.size, lastErrors }
    },

    async cancelJob (jobId) {
      const decision = await serializeMutation(async () => {
        if (closed || closing) fail('INGEST_MANAGER_CLOSED', 'ingest manager is closed', 503)
        const job = await store.getJob(jobId)
        if (!job || TERMINAL.has(job.state)) return { job, running: null }
        const running = active.get(jobId)
        if (running) {
          running.cancelled = true
          running.controller.abort()
          return { job, running }
        }
        const cancelled = await markTerminal(jobId, 'cancelled', 'CANCELLED', false)
        await revokeAttachmentSource(jobId)
        cleanupAttachment(jobId)
        // A queued job can already own staging state — it may be the resubmit of
        // an attempt that got most of the way — so a cancellation that never
        // reaches runJob still has to hand it back.
        await reclaimStaging(jobId)
        return { job: cancelled, running: null }
      })
      if (decision.running) await decision.running.promise.catch(() => {})
      const current = await store.getJob(jobId)
      return publicJob(current || decision.job)
    },

    async cancelPolicyDeniedJobs () {
      const jobs = await store.listActive()
      let cancelled = 0
      for (const job of jobs) {
        if (canIngest(job.request)) continue
        const result = await this.cancelJob(job.jobId)
        if (result?.state === 'cancelled') cancelled++
      }
      return { cancelled }
    },

    /**
     * Which resume ids the staging sweep may consider, and which of them must
     * survive it.
     *
     * `ids` is every job this relay has ever recorded, because the sweep is
     * complete rather than best-effort: the bucket is never enumerated, so an id
     * that is left out is staging state nothing will ever reclaim. `keep` is the
     * jobs that have not settled and could still be resumed.
     *
     * A job whose ingest is RUNNING is in neither list. Reading a staged length
     * that is being appended to would not be reading a length at all, so it is
     * excluded from the set the sweep is handed rather than merely spared by it.
     */
    async stagingSweepPlan () {
      const ids = []
      const keep = []
      for (const entry of await store.listJobIds()) {
        if (active.has(entry.jobId)) continue
        ids.push(entry.jobId)
        if (!entry.terminal) keep.push(entry.jobId)
      }
      return { ids, keep }
    },

    async start () {
      if (closed || closing) fail('INGEST_MANAGER_CLOSED', 'ingest manager is closed', 503)
      if (started) return this
      fs.mkdirSync(spoolRoot, { recursive: true })
      if (ephemeral.size === 0) fs.rmSync(path.join(spoolRoot, 'uploads'), { recursive: true, force: true })
      // Nothing writes a source spool any more — a granted source streams its
      // ranges straight into the asset core — so anything still here is a
      // part-downloaded title from a relay that predates that, and it is dead
      // weight on the volume.
      fs.rmSync(sourceSpoolRoot, { recursive: true, force: true })
      started = true
      for (const job of await store.listActive()) {
        try {
          await recover(job)
        } catch (error) {
          logger?.archive?.warn?.('Companion ingest job recovery failed on boot', {
            jobId: job?.jobId,
            error: error?.message || String(error)
          })
        }
      }
      return this
    },
    async close () {
      if (closed) return
      closing = true
      for (const entry of active.values()) {
        entry.closing = true
        entry.controller.abort()
      }
      await mutations
      for (const entry of active.values()) {
        entry.closing = true
        entry.controller.abort()
      }
      await Promise.all([...active.values()].map(entry => entry.promise.catch(() => {})))
      await Promise.all([...ephemeral.keys()].map(jobId => revokeAttachmentSource(jobId)))
      for (const jobId of [...ephemeral.keys()]) cleanupAttachment(jobId)
      await store.close?.()
      started = false
      closed = true
    }
  })
}
