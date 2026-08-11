import AbortController from 'abort-controller'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import sodium from 'sodium-universal'
import * as defaultFs from '#fs'
import * as defaultPath from '#path'
import process from '#process'

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
const SPOOL_FIELDS = new Set(['path', 'complete', 'mimeType', 'byteLength', 'sha256', 'etag'])
const RETENTION_CLASSES = new Set(['contribution-cache', 'archive-pin'])
const SOURCE_KINDS = new Set(['public-torrent', 'release', 'folder', 'archive'])
const TERMINAL = new Set(TERMINAL_INGEST_JOB_STATES)
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const NAMESPACE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/
const TOKEN = /^[a-z0-9][a-z0-9._+-]{0,63}$/
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/
const LOCATOR = /^(?:[a-z][a-z0-9+.-]*:(?:\/\/)?|\/\/)/i
const SENSITIVE_FIELD = /(?:url|uri|href|link|magnet|cookie|authorization|credential|secret|password|passkey|debrid|headers?|capability|spool|localpath|filepath|torrentfile|privateinfohash|tracker(?:url|id|announce)?)/i
const SENSITIVE_VALUE = /(?:[a-z][a-z0-9+.-]*:\/\/|\bmagnet:|\b(?:passkey|authkey|torrent[_-]?pass|private[_-]?infohash|tracker(?:url|id))\s*[:=])/i
const MAX_SAFE_MEDIA_BYTES = 5 * 1024 * 1024 * 1024
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

function text (value, name, maximum, { required = true, lower = false, pattern = null } = {}) {
  if (value == null && !required) return null
  if (typeof value !== 'string') fail('INGEST_REQUEST_INVALID', `${name} must be a string`)
  let normalized = value.normalize('NFC').trim()
  if (lower) normalized = normalized.toLowerCase()
  if (!normalized || byteLength(normalized) > maximum || /[\u0000-\u001f\u007f-\u009f]/.test(normalized) || LOCATOR.test(normalized)) {
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

function normalizeExpected (input, measuredBytes) {
  onlyFields(input, EXPECTED_FIELDS, 'expected')
  const byteLength = integer(input.byteLength, 'expected.byteLength', { minimum: 1, maximum: MAX_SAFE_MEDIA_BYTES })
  if (byteLength !== measuredBytes) fail('INGEST_REQUEST_INVALID', 'expected byte length must equal measured byte length')
  const result = { byteLength }
  const sha256 = normalizeSha256(input.sha256, 'expected.sha256')
  if (sha256) result.sha256 = sha256
  if (input.etag != null) result.etag = text(input.etag, 'expected.etag', 256)
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

export function fingerprintIngestRequest (request) {
  return hashHex('peartube.companion.ingest.request.v1', canonicalize(normalizeIngestRequest(request)))
}

function normalizedFingerprint (request) {
  return hashHex('peartube.companion.ingest.request.v1', canonicalize(request))
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
  if (state === 'acquiring') return 'ACQUISITION_FAILED'
  if (state === 'verifying') return 'VERIFICATION_FAILED'
  if (state === 'publishing') return 'PUBLICATION_FAILED'
  return 'INGEST_FAILED'
}

export function createIngestManager ({
  store,
  publisher,
  spoolRoot,
  fs = defaultFs,
  path = defaultPath,
  canIngest = () => true,
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

  const ephemeral = new Map()
  const active = new Map()
  let started = false
  let closing = false
  let closed = false

  function jobIdFor (idempotencyKey, fingerprint) {
    return `ing_${hashHex('peartube.companion.ingest.job.v1', `${idempotencyKey}\u0000${fingerprint}`).slice(0, 32)}`
  }

  function buildJob (idempotencyKey, request, fingerprint) {
    const jobId = jobIdFor(idempotencyKey, fingerprint)
    const timestamp = now()
    return {
      schemaVersion: 1,
      jobId,
      state: 'queued',
      version: 0,
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

  async function channelFor (job) {
    const sourceIdentity = sourceIdentityFor(job)
    return publisher.ensureAnonymousChannel({
      channelName: sourceIdentity.creatorName,
      sourceIdentity
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
    if (channelInfo && typeof publisher.publishCatalog === 'function') await publisher.publishCatalog(channelInfo)
    if (job.retentionClass === 'archive-pin' && channelInfo && typeof publisher.retainAssets === 'function') {
      await publisher.retainAssets({
        ...channelInfo,
        previewVideos: [{
          id: job.publicationFence.videoId,
          immutablePublication: metadata?.immutablePublication || null
        }]
      })
    }
  }

  async function publishSpool (job, spool, signal) {
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
        channel: channelInfo.channel,
        filePath: spool.filePath,
        videoId: job.publicationFence.videoId,
        signal,
        title: measured.title || sourceVideoId,
        description: '',
        mimeType: spool.mimeType,
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

  async function verifySpool (job, spool, signal) {
    const hasher = job.request.expected.sha256 ? sha256State() : null
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
          const digest = hasher?.digest()
          if (job.request.expected.sha256 && digest !== job.request.expected.sha256) fail('HASH_MISMATCH', 'spool SHA-256 does not match')
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
        hasher?.update(b4a.from(chunk))
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
    try {
      if (!job || job.state !== 'queued') return job
      const attachment = ephemeral.get(jobId)
      if (!attachment?.spool) return job
      if (!canIngest()) fail('STORAGE_ADMISSION_DENIED', 'storage admission denied', 507)
      job = await store.transition(jobId, { expectedVersion: job.version, from: 'queued', to: 'acquiring' })
      const spool = normalizeSpoolDescriptor(attachment.descriptor, job.request, { spoolRoot, fs, path })
      if (entry.controller.signal.aborted) fail('CANCELLED', 'ingest was cancelled', 499)
      job = await store.transition(jobId, { expectedVersion: job.version, from: 'acquiring', to: 'verifying' })
      job = await verifySpool(job, spool, entry.controller.signal)
      if (entry.controller.signal.aborted) fail('CANCELLED', 'ingest was cancelled', 499)
      job = await store.transition(jobId, { expectedVersion: job.version, from: 'verifying', to: 'publishing' })
      if (entry.controller.signal.aborted) fail('CANCELLED', 'ingest was cancelled', 499)
      const result = await publishSpool(job, spool, entry.controller.signal)
      job = await store.completePublication(jobId, { expectedVersion: job.version, result })
      return job
    } catch (error) {
      if (closing || entry.closing) return store.getJob(jobId)
      const cancelled = entry.cancelled || error?.code === 'CANCELLED' || error?.code === 'ABORT_ERR'
      const current = await store.getJob(jobId)
      if (current?.state === 'publishing') {
        try {
          const resolved = await lookupPublication(current)
          if (resolved) {
            await exposePublication(current, resolved.channelInfo, resolved.metadata)
            return await store.completePublication(jobId, { expectedVersion: current.version, result: resolved.result })
          }
        } catch {}
      }
      if (cancelled) return await markTerminal(jobId, 'cancelled', 'CANCELLED', false)
      const code = publicationErrorCode(error, current?.state || job?.state)
      logger?.archive?.warn?.('Companion ingest job failed', { jobId, state: current?.state || null, errorCode: code })
      return await markTerminal(jobId, 'failed', code, current?.state === 'publishing')
    } finally {
      const final = await store.getJob(jobId).catch(() => null)
      if (closing || TERMINAL.has(final?.state)) cleanupAttachment(jobId)
    }
  }

  function schedule (jobId) {
    if (!started || closing || active.has(jobId) || !ephemeral.get(jobId)?.spool) return
    const entry = { controller: new AbortController(), cancelled: false, closing: false, promise: null }
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
      ingestSpoolLease = null
    } = {}) {
      if (closed || closing) fail('INGEST_MANAGER_CLOSED', 'ingest manager is closed', 503)
      if (ingestSpoolLease != null && spool == null) fail('SPOOL_OWNERSHIP_INVALID', 'ingest spool ownership handoff failed', 500)
      const key = text(idempotencyKey, 'idempotencyKey', 128, { pattern: ID })
      const normalized = normalizeIngestRequest(request)
      const fingerprint = normalizedFingerprint(normalized)
      const idempotencyDigest = hashHex('peartube.companion.ingest.idempotency.v1', key)

      const existing = await store.findByIdempotency(idempotencyDigest)
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'idempotency key is already bound to another request', 409)
        const attached = ephemeral.get(existing.jobId)
        let incomingSpool = null
        if (spool != null) {
          incomingSpool = normalizeSpoolDescriptor(spool, normalized, { spoolRoot, fs, path })
          if (!TERMINAL.has(existing.state) && !attached?.spool) {
            acceptSpoolLease(ingestSpoolLease, incomingSpool)
            ephemeral.set(existing.jobId, { ...attached, descriptor: spool, spool: incomingSpool, sourceCapability: attached?.sourceCapability || null })
            incomingSpool = null
            schedule(existing.jobId)
          } else if (incomingSpool.filePath === attached?.spool?.filePath) {
            acceptSpoolLease(ingestSpoolLease, incomingSpool)
            incomingSpool = null
          }
        }
        if (incomingSpool) discardUnacceptedSpool(ingestSpoolLease, incomingSpool, existing.jobId)
        if (!TERMINAL.has(existing.state) && !ephemeral.get(existing.jobId)?.sourceCapability && sourceCapability != null) {
          const current = ephemeral.get(existing.jobId) || {}
          ephemeral.set(existing.jobId, { ...current, sourceCapability: normalizeSourceCapability(sourceCapability) })
        }
        return publicJob(await store.getJob(existing.jobId))
      }

      const normalizedSpool = spool == null ? null : normalizeSpoolDescriptor(spool, normalized, { spoolRoot, fs, path })
      const capability = normalizeSourceCapability(sourceCapability)
      const initial = buildJob(key, normalized, fingerprint)
      const outcome = await store.createOrReplay({ idempotencyDigest, requestFingerprint: fingerprint, job: initial })
      if (!TERMINAL.has(outcome.job.state) && (normalizedSpool || capability)) {
        const attached = ephemeral.get(outcome.job.jobId) || {}
        if (normalizedSpool && !attached.spool) acceptSpoolLease(ingestSpoolLease, normalizedSpool)
        else if (normalizedSpool && normalizedSpool.filePath === attached.spool?.filePath) acceptSpoolLease(ingestSpoolLease, normalizedSpool)
        ephemeral.set(outcome.job.jobId, {
          descriptor: attached.spool ? attached.descriptor : spool,
          spool: attached.spool || normalizedSpool,
          sourceCapability: attached.sourceCapability || capability
        })
        if (normalizedSpool && attached.spool && normalizedSpool.filePath !== attached.spool.filePath) {
          discardUnacceptedSpool(ingestSpoolLease, normalizedSpool, outcome.job.jobId)
        }
        schedule(outcome.job.jobId)
      } else if (normalizedSpool) {
        discardUnacceptedSpool(ingestSpoolLease, normalizedSpool, outcome.job.jobId)
      }
      return publicJob(outcome.job)
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

    async cancelJob (jobId) {
      const job = await store.getJob(jobId)
      if (!job) return null
      if (TERMINAL.has(job.state)) return publicJob(job)
      const running = active.get(jobId)
      if (running) {
        running.cancelled = true
        running.controller.abort()
        await running.promise.catch(() => {})
      } else {
        await markTerminal(jobId, 'cancelled', 'CANCELLED', false)
        cleanupAttachment(jobId)
      }
      return publicJob(await store.getJob(jobId))
    },

    async start () {
      if (closed || closing) fail('INGEST_MANAGER_CLOSED', 'ingest manager is closed', 503)
      if (started) return this
      fs.mkdirSync(spoolRoot, { recursive: true })
      if (ephemeral.size === 0) {
        fs.rmSync(spoolRoot, { recursive: true, force: true })
        fs.mkdirSync(spoolRoot, { recursive: true })
      }
      started = true
      for (const job of await store.listActive()) await recover(job)
      return this
    },

    async close () {
      if (closed) return
      closing = true
      for (const entry of active.values()) {
        entry.closing = true
        entry.controller.abort()
      }
      await Promise.all([...active.values()].map(entry => entry.promise.catch(() => {})))
      for (const jobId of [...ephemeral.keys()]) cleanupAttachment(jobId)
      await store.close?.()
      started = false
      closed = true
    }
  })
}
