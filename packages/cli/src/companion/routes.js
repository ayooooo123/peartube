import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  CompanionContractError,
  COMPANION_CONTRACT_LIMITS,
  decodeId,
  decodeIngestJobBody,
  decodeOpenStreamBody,
  decodeSearchQuery,
  errorBody
} from './contracts.js'

const TOKEN_BYTES = 32
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const DEFAULT_LEASE_TTL_MS = 60_000
const DEFAULT_MAX_LEASES = 1024
const SENSITIVE_STATUS_FIELD = /(?:secret|password|credential|authorization|cookie|token|capability|privatekey|signingkey|clientkey|mac|nonce)/i
const LOCATOR_FIELD = /(?:urls?|uris?|links?|href|magnet|torrent)$/i
const LOCATOR_VALUE = /(?:[a-z][a-z0-9+.-]*:(?:\/\/)?[^\s]|\/\/[^\s])/i

function base64Url (bytes) {
  return b4a.toString(bytes, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function digestToken (token) {
  return b4a.toString(crypto.hash(b4a.from(token)), 'hex')
}

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

function backendFailure (error) {
  const raw = typeof error?.code === 'string' ? error.code.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') : ''
  if (raw === 'CANDIDATE_EXPIRED') return contractError(410, 'CANDIDATE_EXPIRED', 'Candidate reference expired')
  if (raw === 'SOURCE_NOT_CURRENT') return contractError(409, 'SOURCE_NOT_CURRENT', 'Candidate source is no longer current')
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
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || !TOKEN_PATTERN.test(candidate.candidateRef || '')) {
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

function onlyCapabilityQuery (values) {
  for (const [key] of values) {
    if (key !== 'cap') throw contractError(400, 'UNKNOWN_FIELD', 'Unknown stream query field', key)
  }
  const caps = values.getAll('cap')
  if (caps.length !== 1) {
    throw contractError(400, caps.length > 1 ? 'DUPLICATE_FIELD' : 'INVALID_FIELD', 'Stream capability is required', 'cap')
  }
  return caps[0]
}

function rejectQuery (values) {
  for (const [field] of values) {
    throw contractError(400, 'UNKNOWN_FIELD', 'Route does not accept query fields', field)
  }
}

function allow (methods) {
  throw Object.assign(contractError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed'), { allow: methods.join(', ') })
}

export function createStreamLeaseStore ({
  now = Date.now,
  randomBytes = crypto.randomBytes,
  ttlMs = DEFAULT_LEASE_TTL_MS,
  maxEntries = DEFAULT_MAX_LEASES
} = {}) {
  if (typeof now !== 'function' || typeof randomBytes !== 'function') throw new TypeError('lease clock and random source are required')
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 10 * 60_000) throw new TypeError('lease ttl must be between 1 and 600000 milliseconds')
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 65_536) throw new TypeError('lease capacity must be between 1 and 65536')

  const leases = new Map()

  function purgeExpired (at = now()) {
    for (const [digest, lease] of leases) {
      if (lease.expiresAt <= at) leases.delete(digest)
    }
  }

  function issue ({ clientIdentity, publicationId, renditionId, assetId }) {
    clientIdentity = decodeId(clientIdentity, 'clientIdentity')
    publicationId = decodeId(publicationId, 'publicationId')
    renditionId = decodeId(renditionId, 'renditionId')
    assetId = decodeId(assetId, 'assetId')
    const issuedAt = now()
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new TypeError('lease clock returned an invalid time')
    purgeExpired(issuedAt)
    if (leases.size >= maxEntries) {
      throw contractError(503, 'LEASE_CAPACITY_EXHAUSTED', 'Stream capability capacity is exhausted')
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      const bytes = b4a.from(randomBytes(TOKEN_BYTES))
      if (bytes.byteLength !== TOKEN_BYTES) throw new TypeError('lease random source must return 32 bytes')
      const token = base64Url(bytes)
      const digest = digestToken(token)
      if (leases.has(digest)) continue
      const expiresAt = issuedAt + ttlMs
      leases.set(digest, Object.freeze({ clientIdentity, publicationId, renditionId, assetId, issuedAt, expiresAt }))
      return { token, expiresAt, publicationId, renditionId }
    }
    throw new Error('Could not issue a unique stream capability')
  }

  function authorize (token, { clientIdentity, publicationId, renditionId, method }) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw contractError(403, 'CAPABILITY_INVALID', 'Invalid stream capability')
    const digest = digestToken(token)
    const lease = leases.get(digest)
    if (!lease) throw contractError(403, 'CAPABILITY_INVALID', 'Invalid stream capability')
    const at = now()
    if (lease.expiresAt <= at) {
      leases.delete(digest)
      throw contractError(410, 'CAPABILITY_EXPIRED', 'Stream capability expired')
    }
    if (
      lease.clientIdentity !== clientIdentity ||
      lease.publicationId !== publicationId ||
      lease.renditionId !== renditionId ||
      (method !== 'GET' && method !== 'HEAD')
    ) throw contractError(403, 'CAPABILITY_SCOPE_MISMATCH', 'Stream capability scope mismatch')
    return lease
  }

  return Object.freeze({
    issue,
    authorize,
    size () { purgeExpired(); return leases.size },
    debugEntries () {
      return [...leases.entries()].map(([digest, lease]) => JSON.stringify({ digest, ...lease }))
    }
  })
}

export function createCompanionRouter ({ service, config = {}, clock = Date.now, leases = null } = {}) {
  if (!service) throw new TypeError('service is required')
  if (typeof clock !== 'function') throw new TypeError('clock is required')
  const leaseStore = leases || createStreamLeaseStore({ now: clock })

  async function search (input, url) {
    const query = decodeSearchQuery(url.searchParams)
    if (query.selector.kind === 'episode') unavailable('Episode index search')
    if (typeof service.searchIndexCandidates !== 'function') unavailable('Index search')
    const delegatedSelector = query.selector.namespace
      ? {
          namespace: query.selector.namespace,
          identifier: query.selector.identifier,
          kind: query.selector.kind
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
    const grant = leaseStore.issue({ clientIdentity: input.clientIdentity, ...scope })
    return routeResponse(200, {
      url: `/api/v2/stream/${encodeURIComponent(scope.publicationId)}/${encodeURIComponent(scope.renditionId)}?cap=${grant.token}`,
      expiresAt: grant.expiresAt,
      publicationId: scope.publicationId,
      renditionId: scope.renditionId
    })
  }

  async function stream (input, url, publicationPart, renditionPart) {
    const publicationId = decodedSegment(publicationPart, 'publicationId')
    const renditionId = decodedSegment(renditionPart, 'renditionId')
    const token = onlyCapabilityQuery(url.searchParams)
    const lease = leaseStore.authorize(token, {
      clientIdentity: input.clientIdentity,
      publicationId,
      renditionId,
      method: input.method
    })
    if (typeof service.streamAsset !== 'function') unavailable('Asset streaming')
    const delegated = await callBackend(service.streamAsset.bind(service), [{
      clientIdentity: input.clientIdentity,
      publicationId,
      renditionId,
      assetId: lease.assetId,
      method: input.method,
      headers: input.headers || {},
      signal: input.signal
    }], input.signal)
    if (delegated && Number.isSafeInteger(delegated.statusCode) && delegated.statusCode >= 100 && delegated.statusCode <= 599) {
      return routeResponse(delegated.statusCode, delegated.body, delegated.headers || {})
    }
    return routeResponse(200, delegated)
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
    const job = await callBackend(service.submitIngestJob.bind(service), [value, { signal: input.signal }], input.signal)
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
      match = path.match(/^\/api\/v2\/stream\/([^/]+)\/([^/]+)$/)
      if (match) {
        if (method !== 'GET' && method !== 'HEAD') allow(['GET', 'HEAD'])
        return await stream({ ...input, method }, url, match[1], match[2])
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
      const headers = error?.allow ? { allow: error.allow } : {}
      return routeResponse(known.statusCode, errorBody(known), headers)
    }
  }

  return Object.freeze({ dispatch, leases: leaseStore })
}
