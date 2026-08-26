import b4a from 'b4a'

import {
  CompanionContractError,
  COMPANION_CONTRACT_LIMITS,
  decodeId,
  decodeIngestJobBody,
  decodeOpenStreamBody,
  decodePolicyControlBody,
  decodeSearchQuery,
  errorBody
} from './contracts.js'
import { createStreamCapabilityStore } from './stream-capabilities.js'

const CANDIDATE_REF_PATTERN = /^[A-Za-z0-9_-]{43}$/
const SENSITIVE_STATUS_FIELD = /(?:secret|password|credential|authorization|cookie|token|capability|privatekey|signingkey|clientkey|mac|nonce)/i
const LOCATOR_FIELD = /(?:urls?|uris?|links?|href|magnet|torrent)$/i
const LOCATOR_VALUE = /(?:(?:https?|magnet|ipfs|pear|blob|data|file|ftp|rtsp):(?:\/\/)?[^\s]|\/\/[^\s])/i

function contractError (statusCode, code, message, field = null) {
  return new CompanionContractError(statusCode, code, message, field)
}

function unavailable (name) {
  throw contractError(501, 'CAPABILITY_UNAVAILABLE', `${name} capability is unavailable`)
}

function routeResponse (statusCode, body, headers = {}) {
  return { statusCode, headers, body }
}

function parseUrl (rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 4096 || !rawUrl.startsWith('/')) {
    throw contractError(400, 'INVALID_PATH', 'Invalid companion request path')
  }
  try {
    return new URL(rawUrl, 'http://companion.invalid')
  } catch {
    throw contractError(400, 'INVALID_PATH', 'Invalid companion request path')
  }
}

function decodedSegment (value, field) {
  try {
    return decodeId(decodeURIComponent(value), field)
  } catch (error) {
    if (error instanceof CompanionContractError) throw error
    throw contractError(400, 'INVALID_FIELD', `Invalid ${field}`, field)
  }
}

// The specific reason is deliberately NOT returned to the caller: a public relay
// should not narrate its validation to whoever is probing it. Swallowing it
// entirely, though, leaves an operator watching their own relay refuse a real
// archive with nothing to go on - that cost hours today. So the original code,
// message and field ride along on the contract error under `backendDetail`,
// where the request handler logs them locally. `backendDetail` is not part of
// any response body.
function backendFailure (error) {
  // An error with no code is the interesting case, not the boring one: it is an
  // unexpected throw that becomes an opaque BACKEND_ERROR on the wire, so the
  // stack is the only thing that will ever explain it.
  const detail = {
    code: typeof error?.code === 'string' ? error.code : null,
    reason: typeof error?.message === 'string' ? error.message.slice(0, 300) : null,
    field: typeof error?.field === 'string' ? error.field : null,
    at: typeof error?.stack === 'string' ? error.stack.split('\n').slice(1, 4).join(' | ').slice(0, 400) : null
  }
  const translated = translateBackendFailure(error)
  if (detail.code !== null || detail.reason !== null) translated.backendDetail = detail
  return translated
}

function translateBackendFailure (error) {
  const raw = typeof error?.code === 'string' ? error.code.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') : ''
  if (raw === 'CANDIDATE_EXPIRED') return contractError(410, 'CANDIDATE_EXPIRED', 'Candidate reference expired')
  if (raw === 'SOURCE_NOT_CURRENT') return contractError(409, 'SOURCE_NOT_CURRENT', 'Candidate source is no longer current')
  if (raw === 'SOURCE_INVALID') return contractError(502, raw, 'Candidate source failed verification')
  if (raw === 'SOURCE_MISMATCH') return contractError(409, raw, 'Candidate no longer matches its source')
  if (raw.startsWith('IMMUTABLE_PUBLICATION_')) {
    return contractError(502, raw, 'Immutable publication stream is invalid')
  }
  if (raw === 'IDEMPOTENCY_CONFLICT') return contractError(409, raw, 'Idempotency key is already bound to another request')
  if (raw === 'INGEST_JOB_TERMINAL' || raw === 'INGEST_VERSION_CONFLICT') return contractError(409, raw, 'Ingest job state conflict')
  if (raw === 'STORAGE_ADMISSION_DENIED') return contractError(507, raw, 'Insufficient storage for ingest')
  // Retention admission is a policy state, not a backend fault. It falls out of
  // the relay having no control policy yet - which is the normal condition for
  // the seconds between a restart and the operator's next policy push - and
  // reporting it as BACKEND_ERROR made a transient startup window look like the
  // relay had crashed. 503 says "not yet", which is what a caller can act on.
  if (raw === 'RETENTION_ADMISSION_DENIED') {
    return contractError(503, raw, 'Retention policy is not ready')
  }
  if (raw === 'INGEST_MANAGER_CLOSED' || raw === 'INGEST_PERSISTENCE_FAILED' || raw === 'INGEST_PERSISTENCE_CORRUPT') {
    return contractError(503, raw, 'Ingest service is unavailable')
  }
  if (raw === 'INGEST_REQUEST_INVALID' || raw === 'SOURCE_CAPABILITY_INVALID' ||
      raw === 'SPOOL_INCOMPLETE' || raw === 'SPOOL_PATH_INVALID' || raw === 'SPOOL_TYPE_INVALID' ||
      raw === 'SPOOL_LENGTH_MISMATCH' || raw === 'HASH_MISMATCH' || raw === 'ETAG_MISMATCH') {
    return contractError(400, raw, 'Invalid ingest request')
  }
  if (raw === 'UNAVAILABLE' || raw.endsWith('_UNAVAILABLE')) return contractError(503, 'BACKEND_UNAVAILABLE', 'Companion backend is unavailable')
  if (raw === 'UNSUPPORTED' || raw.endsWith('_UNSUPPORTED')) return contractError(501, 'CAPABILITY_UNAVAILABLE', 'Companion capability is unavailable')
  return contractError(502, 'BACKEND_ERROR', 'Companion backend request failed')
}

async function callBackend (fn, args, signal = null) {
  let onAbort = null
  try {
    if (!signal) return await fn(...args)
    if (signal.aborted) throw contractError(499, 'REQUEST_CANCELLED', 'Companion request was cancelled')
    const cancelled = new Promise((resolve, reject) => {
      onAbort = () => reject(contractError(499, 'REQUEST_CANCELLED', 'Companion request was cancelled'))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    return await Promise.race([
      Promise.resolve().then(() => fn(...args)),
      cancelled
    ])
  } catch (error) {
    if (error instanceof CompanionContractError) throw error
    throw backendFailure(error)
  } finally {
    if (onAbort) signal.removeEventListener?.('abort', onAbort)
  }
}

function boundedPublicValue (value, { stripUrls = false, stripSecrets = false } = {}, depth = 0, seen = new Set()) {
  if (depth > COMPANION_CONTRACT_LIMITS.maxJsonDepth) return null
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    if (stripUrls && LOCATOR_VALUE.test(value)) return null
    return b4a.byteLength(value) <= COMPANION_CONTRACT_LIMITS.maxJsonStringBytes ? value : value.slice(0, 1024)
  }
  if (typeof value !== 'object' || seen.has(value)) return null
  seen.add(value)
  if (Array.isArray(value)) {
    const result = value.slice(0, COMPANION_CONTRACT_LIMITS.maxJsonFields)
      .map(child => boundedPublicValue(child, { stripUrls, stripSecrets }, depth + 1, seen))
    seen.delete(value)
    return result
  }
  const result = {}
  let count = 0
  for (const [key, child] of Object.entries(value)) {
    if (count >= COMPANION_CONTRACT_LIMITS.maxJsonFields) break
    if ((stripUrls && LOCATOR_FIELD.test(key)) || (stripSecrets && (SENSITIVE_STATUS_FIELD.test(key) || LOCATOR_FIELD.test(key)))) continue
    Object.defineProperty(result, key, {
      value: boundedPublicValue(child, { stripUrls, stripSecrets }, depth + 1, seen),
      enumerable: true,
      configurable: true,
      writable: true
    })
    count++
  }
  seen.delete(value)
  return result
}

function candidateList (value) {
  const candidates = Array.isArray(value) ? value : value?.candidates
  if (!Array.isArray(candidates)) throw contractError(502, 'BACKEND_CONTRACT_INVALID', 'Search backend returned an invalid response')
  return candidates
}

function verifiedCandidate (value) {
  if (value?.success === false) {
    const error = new Error('Candidate verification failed')
    error.code = value.errorCode
    throw backendFailure(error)
  }
  const candidate = value?.candidate || value
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw contractError(502, 'BACKEND_CONTRACT_INVALID', 'Verification backend returned an invalid response')
  }
  return candidate
}

function exactCandidateScope (candidate) {
  return {
    publicationId: decodeId(candidate.publication?.publicationId, 'publicationId'),
    renditionId: decodeId(candidate.rendition?.renditionId, 'renditionId'),
    assetId: decodeId(candidate.asset?.assetId, 'assetId')
  }
}

function backendCandidate (candidate, expectedRef = null) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || !CANDIDATE_REF_PATTERN.test(candidate.candidateRef || '')) {
    throw contractError(502, 'BACKEND_CONTRACT_INVALID', 'Candidate backend returned an invalid response')
  }
  if (expectedRef !== null && candidate.candidateRef !== expectedRef) {
    throw contractError(502, 'BACKEND_CONTRACT_INVALID', 'Verification backend returned a mismatched candidate')
  }
  try {
    return { candidate, scope: exactCandidateScope(candidate) }
  } catch {
    throw contractError(502, 'BACKEND_CONTRACT_INVALID', 'Candidate backend returned an invalid response')
  }
}


function rejectQuery (values) {
  for (const [field] of values) {
    throw contractError(400, 'UNKNOWN_FIELD', 'Route does not accept query fields', field)
  }
}

function allow (methods) {
  throw Object.assign(contractError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed'), { allow: methods.join(', ') })
}

export function createCompanionRouter ({ service, config = {}, clock = Date.now, capabilities = null, logger = null } = {}) {
  if (!service) throw new TypeError('service is required')
  if (typeof clock !== 'function') throw new TypeError('clock is required')
  const capabilityStore = capabilities || createStreamCapabilityStore({ now: clock })
  async function search (input, url) {
    const query = decodeSearchQuery(url.searchParams)
    if (typeof service.searchIndexCandidates !== 'function') unavailable('Index search')
    // An exact selector is rebuilt field by field so a title selector's own
    // fields can never reach the backend as an exact one. An episode carries
    // its place in the show alongside the show's coordinates: without the
    // ordinals the backend can only find the series, which is not what was
    // asked for.
    const delegatedSelector = query.selector.namespace
      ? {
          namespace: query.selector.namespace,
          identifier: query.selector.identifier,
          kind: query.selector.kind,
          ...(query.selector.kind === 'episode'
            ? { season: query.selector.season, episode: query.selector.episode }
            : {})
        }
      : query.selector
    const options = { limit: query.limit, cursor: query.cursor, signal: input.signal }
    const raw = await callBackend(service.searchIndexCandidates.bind(service), [delegatedSelector, options], input.signal)
    const values = candidateList(raw)
    const candidates = values.slice(0, query.limit).map(value => {
      const { candidate } = backendCandidate(value)
      return boundedPublicValue(candidate, { stripUrls: true })
    })
    const returnedCursor = raw && !Array.isArray(raw) ? (raw.nextCursor ?? raw.cursor) : null
    const cursor = typeof returnedCursor === 'string' && /^[A-Za-z0-9._~-]+$/.test(returnedCursor) && b4a.byteLength(returnedCursor) <= COMPANION_CONTRACT_LIMITS.maxCursorBytes
      ? returnedCursor
      : null
    return routeResponse(200, { candidates, cursor })
  }

  async function openStream (input) {
    const { candidateRef } = decodeOpenStreamBody(input.body)
    if (typeof service.verifyIndexCandidate !== 'function') unavailable('Index verification')
    const raw = await callBackend(service.verifyIndexCandidate.bind(service), [candidateRef, { signal: input.signal }], input.signal)
    const candidate = verifiedCandidate(raw)
    const { scope } = backendCandidate(candidate, candidateRef)
    if (typeof service.openStreamAsset !== 'function') unavailable('Asset streaming')
    const asset = await callBackend(service.openStreamAsset.bind(service), [candidate, { signal: input.signal }], input.signal)
    if (!asset || typeof asset !== 'object' || Array.isArray(asset) || asset.assetId !== scope.assetId) {
      await Promise.resolve(asset?.release?.()).catch(() => {})
      throw contractError(502, 'BACKEND_CONTRACT_INVALID', 'Stream backend returned a mismatched asset')
    }
    let grant
    try {
      grant = capabilityStore.issue({
        clientIdentity: input.clientIdentity,
        ...scope,
        asset,
        methods: ['GET', 'HEAD']
      })
    } catch (error) {
      await Promise.resolve(asset.release?.()).catch(() => {})
      throw error
    }
    return routeResponse(200, {
      url: `/api/v2/stream/${encodeURIComponent(scope.publicationId)}/${encodeURIComponent(scope.renditionId)}?cap=${grant.token}`,
      expiresAt: grant.expiresAt,
      publicationId: scope.publicationId,
      renditionId: scope.renditionId
    })
  }


  async function publication (input, publicationPart) {
    const publicationId = decodedSegment(publicationPart, 'publicationId')
    if (typeof service.getPublication !== 'function') unavailable('Publication lookup')
    const value = await callBackend(service.getPublication.bind(service), [publicationId, { signal: input.signal }], input.signal)
    if (value === null || value === undefined) throw contractError(404, 'PUBLICATION_NOT_FOUND', 'Publication not found')
    return routeResponse(200, { publication: boundedPublicValue(value, { stripUrls: true }) })
  }

  async function submitJob (input) {
    const value = decodeIngestJobBody(input.body)
    if (typeof service.submitIngestJob !== 'function') unavailable('Ingest jobs')
    const job = await callBackend(service.submitIngestJob.bind(service), [
      value,
      { signal: input.signal, ingestSpoolLease: input.ingestSpoolLease || null }
    ], input.signal)
    return routeResponse(202, { job: boundedPublicValue(job, { stripUrls: true, stripSecrets: true }) })
  }

  async function getJob (input, jobPart) {
    const jobId = decodedSegment(jobPart, 'jobId')
    if (typeof service.getIngestJob !== 'function') unavailable('Ingest jobs')
    const job = await callBackend(service.getIngestJob.bind(service), [jobId, { signal: input.signal }], input.signal)
    if (job === null || job === undefined) throw contractError(404, 'JOB_NOT_FOUND', 'Ingest job not found')
    return routeResponse(200, { job: boundedPublicValue(job, { stripUrls: true, stripSecrets: true }) })
  }

  async function cancelJob (input, jobPart) {
    const jobId = decodedSegment(jobPart, 'jobId')
    if (typeof service.cancelIngestJob !== 'function') unavailable('Ingest jobs')
    const job = await callBackend(service.cancelIngestJob.bind(service), [jobId, { signal: input.signal }], input.signal)
    if (job === null || job === undefined) throw contractError(404, 'JOB_NOT_FOUND', 'Ingest job not found')
    return routeResponse(200, { job: boundedPublicValue(job, { stripUrls: true, stripSecrets: true }) })
  }

  async function applyNetworkPolicy (input) {
    const policy = decodePolicyControlBody(input.body)
    if (typeof service.applyNetworkPolicy !== 'function') unavailable('Network policy control')
    const applied = await callBackend(
      service.applyNetworkPolicy.bind(service),
      [policy, { signal: input.signal }],
      input.signal
    )
    return routeResponse(200, {
      policy: boundedPublicValue(applied, { stripUrls: true, stripSecrets: true })
    })
  }

  async function status (input) {
    const raw = typeof service.getStatus === 'function'
      ? await callBackend(service.getStatus.bind(service), [{ signal: input.signal }], input.signal)
      : {}
    const state = input.serverState || {}
    const transport = { mode: state.transport || config.transport || 'unix', enabled: state.enabled !== false }
    if (transport.mode === 'unix' && typeof state.socketPath === 'string') transport.socketPath = state.socketPath
    if (transport.mode === 'tcp') {
      if (typeof state.host === 'string') transport.host = state.host
      if (Number.isSafeInteger(state.port)) transport.port = state.port
    }
    return routeResponse(200, {
      apiVersion: 2,
      status: 'available',
      transport,
      auth: { mode: 'mac', clientId: config.client?.id || input.clientIdentity || null },
      diagnostics: boundedPublicValue(raw?.runtime || raw, { stripUrls: true, stripSecrets: true })
    })
  }

  async function dispatch (input = {}) {
    try {
      const method = typeof input.method === 'string' ? input.method.toUpperCase() : ''
      const url = parseUrl(input.url)
      const path = url.pathname
      if (path === '/api/v2/search') {
        if (method !== 'GET') allow(['GET'])
        return await search(input, url)
      }
      if (path === '/api/v2/streams/open') {
        if (method !== 'POST') allow(['POST'])
        rejectQuery(url.searchParams)
        return await openStream({ ...input, method })
      }
      if (path === '/api/v2/status') {
        if (method !== 'GET') allow(['GET'])
        rejectQuery(url.searchParams)
        return await status({ ...input, method })
      }
      if (path === '/api/v2/policy') {
        if (method !== 'PUT') allow(['PUT'])
        rejectQuery(url.searchParams)
        return await applyNetworkPolicy({ ...input, method })
      }
      if (path === '/api/v2/ingest/jobs') {
        if (method !== 'POST') allow(['POST'])
        rejectQuery(url.searchParams)
        return await submitJob({ ...input, method })
      }

      let match = path.match(/^\/api\/v2\/publications\/([^/]+)$/)
      if (match) {
        if (method !== 'GET') allow(['GET'])
        rejectQuery(url.searchParams)
        return await publication(input, match[1])
      }
      match = path.match(/^\/api\/v2\/ingest\/jobs\/([^/]+)$/)
      if (match) {
        rejectQuery(url.searchParams)
        if (method === 'GET') return await getJob(input, match[1])
        if (method === 'DELETE') return await cancelJob(input, match[1])
        allow(['GET', 'DELETE'])
      }
      throw contractError(404, 'NOT_FOUND', 'Companion route not found')
    } catch (error) {
      const known = error instanceof CompanionContractError ? error : backendFailure(error)
      // The caller gets a deliberately generic body; the operator gets the real
      // reason in their own logs.
      if (known.backendDetail) logger?.archive?.warn?.('Companion request refused', known.backendDetail)
      const headers = error?.allow ? { allow: error.allow } : {}
      return routeResponse(known.statusCode, errorBody(known), headers)
    }
  }

  return Object.freeze({ dispatch, capabilities: capabilityStore })
}
