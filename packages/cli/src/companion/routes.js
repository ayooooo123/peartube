import b4a from 'b4a'

import {
  CompanionContractError,
  COMPANION_CONTRACT_LIMITS,
  decodeAcquisitionBody,
  decodeContributeAcquisitionBody,
  decodeAcquisitionListQuery,
  decodeAcquisitionPolicyBody,
  decodeId,
  decodeOpenStreamBody,
  decodePolicyControlBody,
  decodeSearchQuery,
  decodeSourceGrantBody,
  errorBody
} from './contracts.js'
import { createStreamCapabilityStore } from './stream-capabilities.js'

const CANDIDATE_REF_PATTERN = /^[A-Za-z0-9_-]{43}$/
const ACQUISITION_STATES = new Set(['queued', 'acquiring', 'verifying', 'publishing', 'completed', 'failed', 'cancelled'])
const SENSITIVE_STATUS_FIELD = /(?:secret|password|credential|authorization|cookie|token|capability|privatekey|signingkey|clientkey|mac|nonce|source(?:grant|descriptor)|adapter|(?:local|file)path)/i
const LOCATOR_FIELD = /(?:urls?|uris?|links?|href|magnet|torrent)$/i
const LOCATOR_VALUE = /(?:(?:https?|magnet|ipfs|pear|blob|data|file|ftp|rtsp):(?:\/\/)?[^\s]|\/\/[^\s])/i

export const COMPANION_ROUTE_SCOPES = Object.freeze({
  search: 'search.read',
  stream: 'stream.open',
  status: 'status.read',
  publication: 'publication.read',
  policyRead: 'policy.read',
  policyWrite: 'policy.write',
  acquisitionRequest: 'acquisition.request',
  acquisitionRead: 'acquisition.read',
  acquisitionCancel: 'acquisition.cancel',
  acquisitionRetry: 'acquisition.retry',
  acquisitionGrant: 'acquisition.grant',
  acquisitionPolicyRead: 'acquisition-policy.read',
  acquisitionPolicyWrite: 'acquisition-policy.write'
})

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
  if (raw === 'ACQUISITION_TERMINAL' || raw === 'ACQUISITION_VERSION_CONFLICT' || raw === 'ACQUISITION_NOT_FAILED' || raw === 'ACQUISITION_NOT_RECOVERABLE' || raw === 'ACQUISITION_RETRY_LIMIT_EXCEEDED') return contractError(409, raw, 'Acquisition state conflict')
  if (raw === 'ACQUISITION_NOT_FOUND') return contractError(404, raw, 'Acquisition not found')
  if (raw === 'PRINCIPAL_MISMATCH' || raw === 'PUBLISHER_MISMATCH' || raw === 'FORBIDDEN') {
    return contractError(403, 'FORBIDDEN', 'Principal is not authorized for this acquisition')
  }
  if (raw === 'STORAGE_ADMISSION_DENIED') return contractError(507, raw, 'Insufficient storage for acquisition')
  if (raw === 'RETENTION_ADMISSION_DENIED') return contractError(503, raw, 'Retention policy is not ready')
  if (raw === 'ACQUISITION_MANAGER_CLOSED' || raw === 'ACQUISITION_PERSISTENCE_FAILED' || raw === 'ACQUISITION_PERSISTENCE_CORRUPT') {
    return contractError(503, raw, 'Acquisition service is unavailable')
  }
  if (raw === 'ACQUISITION_REQUEST_INVALID' || raw === 'SOURCE_GRANT_INVALID' ||
      raw === 'HASH_MISMATCH' || raw === 'ETAG_MISMATCH') {
    return contractError(400, raw, 'Invalid acquisition request')
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

function backendCandidate (candidate) {
  const candidateRef = candidate?.candidateRef || candidate?.ref
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || !CANDIDATE_REF_PATTERN.test(candidateRef || '')) {
    throw contractError(502, 'BACKEND_CONTRACT_INVALID', 'Candidate backend returned an invalid response')
  }
  const projected = { ...candidate, candidateRef }
  delete projected.ref
  return boundedPublicValue(projected, { stripUrls: true, stripSecrets: true })
}

function requirePrincipal (input, scope) {
  const value = input?.principal
  if (!value || typeof value !== 'object') throw contractError(401, 'AUTH_REQUIRED', 'Companion authentication is required')
  const scopes = value.scopes instanceof Set
    ? value.scopes
    : new Set(Array.isArray(value.scopes) ? value.scopes : [])
  const hasScope = Array.isArray(scope) ? scope.some(s => scopes.has(s)) : scopes.has(scope)
  if (!scopes.has('*') && !hasScope) {
    throw contractError(403, 'SCOPE_REQUIRED', 'Principal is not authorized for this route')
  }
  const publisherId = value.publisherId == null ? null : decodeId(value.publisherId, 'publisherId')
  const publisherIds = Array.isArray(value.publisherIds)
    ? value.publisherIds.map((id, index) => decodeId(id, `publisherIds.${index}`))
    : (publisherId === null ? [] : [publisherId])
  return Object.freeze({
    id: decodeId(value.id, 'principalId'),
    publisherId,
    publisherIds: Object.freeze(publisherIds),
    allowedPublisherIds: Object.freeze(publisherIds),
    isLocal: value.isLocal === true,
    scopes
  })
}

function safeInteger (value, field, { nullable = false } = {}) {
  if (nullable && value == null) return null
  if (!Number.isSafeInteger(value) || value < 0) {
    throw contractError(502, 'BACKEND_CONTRACT_INVALID', `Backend returned an invalid ${field}`)
  }
  return value
}

function publicAcquisition (value) {
  const acquisition = value?.acquisition || value
  if (!acquisition || typeof acquisition !== 'object' || Array.isArray(acquisition) ||
      acquisition.schemaVersion !== 1 || !ACQUISITION_STATES.has(acquisition.state) ||
      typeof acquisition.recoverable !== 'boolean') {
    throw contractError(502, 'BACKEND_CONTRACT_INVALID', 'Backend returned an invalid acquisition')
  }
  const nullableId = (field) => acquisition[field] == null ? null : decodeId(acquisition[field], field)
  const errorCode = acquisition.errorCode == null
    ? null
    : (/^[A-Z][A-Z0-9_]{0,63}$/.test(acquisition.errorCode) ? acquisition.errorCode : null)
  if (acquisition.errorCode != null && errorCode == null) {
    throw contractError(502, 'BACKEND_CONTRACT_INVALID', 'Backend returned an invalid acquisition error')
  }
  return Object.freeze({
    schemaVersion: 1,
    acquisitionId: decodeId(acquisition.acquisitionId, 'acquisitionId'),
    state: acquisition.state,
    retentionClass: decodeId(acquisition.retentionClass, 'retentionClass'),
    bytesAcquired: safeInteger(acquisition.bytesAcquired, 'bytesAcquired'),
    expectedBytes: safeInteger(acquisition.expectedBytes, 'expectedBytes', { nullable: true }),
    publicationId: nullableId('publicationId'),
    manifestId: nullableId('manifestId'),
    renditionId: nullableId('renditionId'),
    assetId: nullableId('assetId'),
    errorCode,
    recoverable: acquisition.recoverable,
    createdAt: safeInteger(acquisition.createdAt, 'createdAt'),
    updatedAt: safeInteger(acquisition.updatedAt, 'updatedAt')
  })
}

function acquisitionList (value) {
  const items = Array.isArray(value) ? value : value?.items || value?.acquisitions
  if (!Array.isArray(items) || items.length > COMPANION_CONTRACT_LIMITS.maxAcquisitions) {
    throw contractError(502, 'BACKEND_CONTRACT_INVALID', 'Backend returned an invalid acquisition list')
  }
  const next = Array.isArray(value) ? null : value?.nextCursor ?? value?.cursor ?? null
  const nextCursor = next == null
    ? null
    : (typeof next === 'string' && /^[A-Za-z0-9._~-]+$/.test(next) && b4a.byteLength(next) <= COMPANION_CONTRACT_LIMITS.maxCursorBytes
        ? next
        : (() => { throw contractError(502, 'BACKEND_CONTRACT_INVALID', 'Backend returned an invalid acquisition cursor') })())
  return { items: items.map(publicAcquisition), nextCursor }
}

function streamLease (value) {
  const candidate = value?.candidate || null
  const asset = value?.asset || value?.lease || value
  const publicationId = value?.publicationId || candidate?.publication?.publicationId
  const renditionId = value?.renditionId || candidate?.rendition?.renditionId
  const assetId = value?.assetId || asset?.assetId || candidate?.asset?.assetId
  if (!asset || typeof asset !== 'object') {
    throw contractError(502, 'BACKEND_CONTRACT_INVALID', 'Stream backend returned an invalid lease')
  }
  return {
    asset,
    publicationId: decodeId(publicationId, 'publicationId'),
    renditionId: decodeId(renditionId, 'renditionId'),
    assetId: decodeId(assetId, 'assetId')
  }
}
function localBlobUrl (value) {
  if (typeof value !== 'string' || b4a.byteLength(value) > 4096) {
    throw contractError(502, 'BACKEND_CONTRACT_INVALID', 'Stream backend returned an invalid local blob URL')
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw contractError(502, 'BACKEND_CONTRACT_INVALID', 'Stream backend returned an invalid local blob URL')
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' ||
      parsed.username || parsed.password || parsed.hash) {
    throw contractError(502, 'BACKEND_CONTRACT_INVALID', 'Stream backend returned a non-loopback blob URL')
  }
  return parsed.toString()
}

function publicStreamDescriptor (value) {
  if (value?.schemaVersion !== 1) return null
  return Object.freeze({
    schemaVersion: 1,
    streamId: decodeId(value.streamId, 'streamId'),
    publicationId: decodeId(value.publicationId, 'publicationId'),
    renditionId: decodeId(value.renditionId, 'renditionId'),
    assetId: decodeId(value.assetId, 'assetId'),
    byteLength: safeInteger(value.byteLength, 'byteLength'),
    mimeType: typeof value.mimeType === 'string' && b4a.byteLength(value.mimeType) <= 128 ? value.mimeType : 'application/octet-stream',
    capability: value.capability == null ? null : decodeId(value.capability, 'capability'),
    expiresAt: safeInteger(value.expiresAt, 'expiresAt', { nullable: true }),
    etag: value.etag == null || (typeof value.etag === 'string' && b4a.byteLength(value.etag) <= 256) ? value.etag ?? null : null,
    ...(value.url == null ? {} : { url: localBlobUrl(value.url) }),
  })
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
    // The principal authorizes the call; it is not part of the query. The
    // provider's search contract is a closed field list and refuses `principal`
    // outright, which turned every authenticated search into a 502.
    requirePrincipal(input, COMPANION_ROUTE_SCOPES.search)
    const query = decodeSearchQuery(url.searchParams)
    if (typeof service.search !== 'function') unavailable('Index search')
    const raw = await callBackend(service.search.bind(service), [{ ...query, signal: input.signal }], input.signal)
    const candidates = candidateList(raw).slice(0, query.limit).map(backendCandidate)
    const returnedCursor = raw && !Array.isArray(raw) ? (raw.nextCursor ?? raw.cursor) : null
    const cursor = returnedCursor == null
      ? null
      : (typeof returnedCursor === 'string' && /^[A-Za-z0-9._~-]+$/.test(returnedCursor) &&
          b4a.byteLength(returnedCursor) <= COMPANION_CONTRACT_LIMITS.maxCursorBytes
          ? returnedCursor
          : null)
    return routeResponse(200, { candidates, cursor })
  }

  async function openStream (input) {
    const principal = requirePrincipal(input, COMPANION_ROUTE_SCOPES.stream)
    const value = decodeOpenStreamBody(input.body)
    const operation = value.candidateRef ? service.openStream : service.openPublication
    if (typeof operation !== 'function') unavailable('Asset streaming')
    const localTransport = input.inProcess === true || principal.isLocal === true
    const opened = await callBackend(
      operation.bind(service),
      [{ ...value, principal, signal: input.signal, localTransport }],
      input.signal
    )
    const descriptor = publicStreamDescriptor(opened)
    if (descriptor) return routeResponse(200, descriptor)
    const lease = streamLease(opened)
    let grant
    try {
      grant = capabilityStore.issue({
        clientIdentity: principal.id,
        publicationId: lease.publicationId,
        renditionId: lease.renditionId,
        assetId: lease.assetId,
        asset: lease.asset,
        methods: ['GET', 'HEAD']
      })
    } catch (error) {
      await Promise.resolve(lease.asset.release?.()).catch(() => {})
      throw error
    }
    return routeResponse(200, {
      url: `/api/v2/stream/${encodeURIComponent(lease.publicationId)}/${encodeURIComponent(lease.renditionId)}?cap=${grant.token}`,
      expiresAt: grant.expiresAt,
      publicationId: lease.publicationId,
      renditionId: lease.renditionId
    })
  }

  async function publication (input, publicationPart) {
    const principal = requirePrincipal(input, COMPANION_ROUTE_SCOPES.publication)
    const publicationId = decodedSegment(publicationPart, 'publicationId')
    if (typeof service.getPublication !== 'function') unavailable('Publication lookup')
    const value = await callBackend(
      service.getPublication.bind(service),
      [{ publicationId, principal, signal: input.signal }],
      input.signal
    )
    const publication = value?.publication ?? value
    if (publication === null || publication === undefined) {
      throw contractError(404, 'PUBLICATION_NOT_FOUND', 'Publication not found')
    }
    return routeResponse(200, {
      publication: boundedPublicValue(publication, { stripUrls: true, stripSecrets: true })
    })
  }

  async function requestAcquisition (input) {
    const principal = requirePrincipal(input, COMPANION_ROUTE_SCOPES.acquisitionRequest)
    const value = decodeAcquisitionBody(input.body)
    if (typeof service.requestAcquisition !== 'function') unavailable('Acquisitions')
    const result = await callBackend(
      service.requestAcquisition.bind(service),
      [{ ...value, principal, signal: input.signal }],
      input.signal
    )
    return routeResponse(202, { acquisition: publicAcquisition(result) })
  }

  async function contributeAcquisition (input) {
    const principal = requirePrincipal(input, COMPANION_ROUTE_SCOPES.acquisitionRequest)
    const value = decodeContributeAcquisitionBody(input.body)
    if (typeof service.issueLocalResolution !== 'function') unavailable('Local resolution')
    if (typeof service.requestAcquisition !== 'function') unavailable('Acquisitions')
    const publisherId = value.publisherId || principal.publisherId
    if (typeof service.ensureAcquisitionPolicy === 'function') {
      await service.ensureAcquisitionPolicy(publisherId)
    }
    const resolution = service.issueLocalResolution({
      title: value.title,
      selector: value.selector,
      publisherId,
      idempotencyKey: value.idempotencyKey,
      expectedBytes: value.expectedBytes || 0,
      sourceFileName: value.sourceFileName || null
    })

    const request = {
      schemaVersion: 1,
      resolutionRef: resolution.resolutionRef,
      publisherId,
      retentionClass: value.retentionClass || 'contribution-cache',
      sourceFileName: value.sourceFileName || null
    }

    const result = await callBackend(
      service.requestAcquisition.bind(service),
      [{ idempotencyKey: value.idempotencyKey, request, principal, signal: input.signal }],
      input.signal
    )
    return routeResponse(202, { acquisition: publicAcquisition(result) })
  }

  async function listAcquisitions (input, url) {
    const principal = requirePrincipal(input, COMPANION_ROUTE_SCOPES.acquisitionRead)
    const query = decodeAcquisitionListQuery(url.searchParams)
    if (typeof service.listAcquisitions !== 'function') unavailable('Acquisitions')
    const result = await callBackend(
      service.listAcquisitions.bind(service),
      [{ ...query, principal, signal: input.signal }],
      input.signal
    )
    return routeResponse(200, acquisitionList(result))
  }

  async function getAcquisition (input, acquisitionPart) {
    const principal = requirePrincipal(input, COMPANION_ROUTE_SCOPES.acquisitionRead)
    const acquisitionId = decodedSegment(acquisitionPart, 'acquisitionId')
    if (typeof service.getAcquisition !== 'function') unavailable('Acquisitions')
    const result = await callBackend(
      service.getAcquisition.bind(service),
      [{ acquisitionId, principal, signal: input.signal }],
      input.signal
    )
    if (result == null) throw contractError(404, 'ACQUISITION_NOT_FOUND', 'Acquisition not found')
    return routeResponse(200, { acquisition: publicAcquisition(result) })
  }

  async function cancelAcquisition (input, acquisitionPart) {
    const principal = requirePrincipal(input, COMPANION_ROUTE_SCOPES.acquisitionCancel)
    const acquisitionId = decodedSegment(acquisitionPart, 'acquisitionId')
    if (typeof service.cancelAcquisition !== 'function') unavailable('Acquisitions')
    const result = await callBackend(
      service.cancelAcquisition.bind(service),
      [{ acquisitionId, principal, signal: input.signal }],
      input.signal
    )
    if (result == null) throw contractError(404, 'ACQUISITION_NOT_FOUND', 'Acquisition not found')
    return routeResponse(200, { acquisition: publicAcquisition(result) })
  }

  async function retryAcquisition (input, acquisitionPart) {
    const principal = requirePrincipal(input, COMPANION_ROUTE_SCOPES.acquisitionRetry)
    const acquisitionId = decodedSegment(acquisitionPart, 'acquisitionId')
    if (typeof service.retryAcquisition !== 'function') unavailable('Acquisitions')
    const result = await callBackend(
      service.retryAcquisition.bind(service),
      [{ acquisitionId, principal, signal: input.signal }],
      input.signal
    )
    if (result == null) throw contractError(404, 'ACQUISITION_NOT_FOUND', 'Acquisition not found')
    return routeResponse(200, { acquisition: publicAcquisition(result) })
  }

  async function attachSourceGrant (input, acquisitionPart) {
    const principal = requirePrincipal(input, COMPANION_ROUTE_SCOPES.acquisitionGrant)
    if (input.inProcess !== true && principal.isLocal !== true) {
      throw contractError(403, 'PRIVATE_ROUTE_REQUIRES_LOCAL_TRANSPORT', 'Source grants require a local protected transport')
    }
    const acquisitionId = decodedSegment(acquisitionPart, 'acquisitionId')
    const { grant } = decodeSourceGrantBody(input.body)
    if (typeof service.attachSourceGrant !== 'function') unavailable('Source grants')
    const result = await callBackend(
      service.attachSourceGrant.bind(service),
      [{ acquisitionId, grant, principal, signal: input.signal }],
      input.signal
    )
    return routeResponse(200, { acquisition: publicAcquisition(result) })
  }

  async function networkPolicy (input, method) {
    const write = method === 'PUT'
    const principal = requirePrincipal(input, write ? COMPANION_ROUTE_SCOPES.policyWrite : COMPANION_ROUTE_SCOPES.policyRead)
    const name = write ? 'setPolicy' : 'getPolicy'
    if (typeof service[name] !== 'function') unavailable('Network policy control')
    let args
    if (write) {
      const policy = decodePolicyControlBody(input.body)
      let expectedRevision = typeof input.body?.expectedRevision === 'number' ? input.body.expectedRevision : null
      if (expectedRevision === null && typeof service.getPolicy === 'function') {
        const current = await callBackend(service.getPolicy.bind(service), [{ principal, signal: input.signal }], input.signal)
        if (typeof current?.revision === 'number') expectedRevision = current.revision
      }
      args = { policy, expectedRevision: expectedRevision ?? 0, principal, signal: input.signal }
    } else {
      args = { principal, signal: input.signal }
    }
    const result = await callBackend(service[name].bind(service), [args], input.signal)
    return routeResponse(200, {
      policy: boundedPublicValue(result?.policy ?? result, { stripUrls: true, stripSecrets: true })
    })
  }

  async function acquisitionPolicy (input, method) {
    const write = method === 'PUT'
    const principal = requirePrincipal(
      input,
      write ? COMPANION_ROUTE_SCOPES.acquisitionPolicyWrite : COMPANION_ROUTE_SCOPES.acquisitionPolicyRead
    )
    const name = write ? 'setAcquisitionPolicy' : 'getAcquisitionPolicy'
    if (typeof service[name] !== 'function') unavailable('Acquisition policy control')
    const args = write
      ? { ...decodeAcquisitionPolicyBody(input.body), principal, signal: input.signal }
      : { principal, signal: input.signal }
    const result = await callBackend(service[name].bind(service), [args], input.signal)
    return routeResponse(200, {
      policy: boundedPublicValue(result?.policy ?? result, { stripUrls: true, stripSecrets: true })
    })
  }

  async function status (input) {
    const principal = requirePrincipal(input, COMPANION_ROUTE_SCOPES.status)
    const raw = typeof service.getStatus === 'function'
      ? await callBackend(service.getStatus.bind(service), [{ principal, signal: input.signal }], input.signal)
      : {}
    const state = input.serverState || {}
    const transport = { mode: state.transport || config.transport || 'tcp', enabled: state.enabled !== false }
    if (transport.mode === 'tcp') {
      if (typeof state.host === 'string') transport.host = state.host
      if (Number.isSafeInteger(state.port)) transport.port = state.port
    }
    return routeResponse(200, {
      apiVersion: 2,
      status: 'available',
      transport,
      auth: { mode: 'mac', clientId: principal.id },
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
        return await openStream(input)
      }
      if (path === '/api/v2/status') {
        if (method !== 'GET') allow(['GET'])
        rejectQuery(url.searchParams)
        return await status(input)
      }
      if (path === '/api/v2/policy') {
        if (method !== 'GET' && method !== 'PUT') allow(['GET', 'PUT'])
        rejectQuery(url.searchParams)
        return await networkPolicy(input, method)
      }
      if (path === '/api/v2/acquisition-policy') {
        if (method !== 'GET' && method !== 'PUT') allow(['GET', 'PUT'])
        rejectQuery(url.searchParams)
        return await acquisitionPolicy(input, method)
      }
      if (path === '/api/v2/acquisitions') {
        if (method === 'POST') {
          rejectQuery(url.searchParams)
          return await requestAcquisition(input)
        }
        if (method === 'GET') return await listAcquisitions(input, url)
        allow(['GET', 'POST'])
      }
      if (path === '/api/v2/acquisitions/contribute') {
        if (method !== 'POST') allow(['POST'])
        rejectQuery(url.searchParams)
        return await contributeAcquisition(input)
      }

      let match = path.match(/^\/api\/v2\/publications\/([^/]+)$/)
      if (match) {
        if (method !== 'GET') allow(['GET'])
        rejectQuery(url.searchParams)
        return await publication(input, match[1])
      }
      match = path.match(/^\/api\/v2\/acquisitions\/([^/]+)\/source-grants$/)
      if (match) {
        if (method !== 'POST') allow(['POST'])
        rejectQuery(url.searchParams)
        return await attachSourceGrant(input, match[1])
      }
      match = path.match(/^\/api\/v2\/acquisitions\/([^/]+)\/retry$/)
      if (match) {
        if (method !== 'POST') allow(['POST'])
        rejectQuery(url.searchParams)
        return await retryAcquisition(input, match[1])
      }
      match = path.match(/^\/api\/v2\/acquisitions\/([^/]+)$/)
      if (match) {
        rejectQuery(url.searchParams)
        if (method === 'GET') return await getAcquisition(input, match[1])
        if (method === 'DELETE') return await cancelAcquisition(input, match[1])
        allow(['GET', 'DELETE'])
      }
      throw contractError(404, 'NOT_FOUND', 'Companion route not found')
    } catch (error) {
      const known = error instanceof CompanionContractError ? error : backendFailure(error)
      if (known.backendDetail) logger?.archive?.warn?.('Companion request refused', known.backendDetail)
      const headers = error?.allow ? { allow: error.allow } : {}
      return routeResponse(known.statusCode, errorBody(known), headers)
    }
  }

  return Object.freeze({ dispatch, capabilities: capabilityStore })
}
