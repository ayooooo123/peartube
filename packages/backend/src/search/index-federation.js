import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  MAX_INDEX_QUERY_DEADLINE_MS,
  MAX_INDEX_QUERY_RESULTS,
  decodeIndexQueryPage,
  encodeIndexQueryPage,
  normalizeIndexQuerySelectors,
} from '../indexer/query-codec.js'

const DEFAULT_MAX_SERVICES = 8
const MAX_SERVICES = 32
const DEFAULT_MAX_PAGES_PER_SERVICE = 4
const MAX_PAGES_PER_SERVICE = 16
const DEFAULT_DEADLINE_MS = 5_000
const DEFAULT_CANDIDATE_TTL_MS = 30_000
const MAX_CANDIDATE_TTL_MS = 5 * 60_000
const DEFAULT_MAX_CACHED_CANDIDATES = 1_024
const MAX_CACHED_CANDIDATES = 4_096
const CANDIDATE_REF_BYTES = 32
const MAX_INDEXER_ID_BYTES = 256
const MAX_KIND_BYTES = 256
const CANDIDATE_REF = /^[A-Za-z0-9_-]{43}$/

function fail(message) {
  const error = new Error(message)
  error.code = 'INDEX_FEDERATION_REJECTED'
  throw error
}

function boundedInteger(value, fallback, maximum, name) {
  const normalized = Number(value ?? fallback)
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > maximum) {
    fail(`${name} is outside its bounded limit`)
  }
  return normalized
}

function boundedText(value, maximum, name) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.normalize('NFC') !== value ||
    b4a.byteLength(value) > maximum ||
    /\p{Cc}/u.test(value)
  ) fail(`${name} must be bounded canonical text`)
  return value
}

function exactFields(value, fields, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`)
  const allowed = new Set(fields)
  for (const field of Object.keys(value)) if (!allowed.has(field)) fail(`${name} has unsupported fields`)
  for (const field of fields) if (!Object.hasOwn(value, field)) fail(`${name} must have exact fields`)
}

function normalizeSearchSelector(value) {
  exactFields(value, ['namespace', 'identifier', 'kind'], 'search selector')
  const protocolSelector = normalizeIndexQuerySelectors([{
    type: 'exact-external-ref',
    namespace: value.namespace,
    identifier: value.identifier,
  }])[0]
  return Object.freeze({
    namespace: protocolSelector.namespace,
    identifier: protocolSelector.identifier,
    kind: boundedText(value.kind, MAX_KIND_BYTES, 'selector kind'),
  })
}

function abortError(reason) {
  if (reason instanceof Error) return reason
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function deadlineError() {
  const error = new Error('Index federation deadline exceeded')
  error.name = 'TimeoutError'
  error.code = 'INDEX_FEDERATION_DEADLINE'
  return error
}

function raceAbort(work, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal.reason))
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => finish(reject, abortError(signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(work).then(
      value => finish(resolve, value),
      error => finish(reject, error),
    )
  })
}

function identityKey(candidate) {
  return JSON.stringify([
    candidate.publisherId,
    candidate.sourceRecordRef,
    candidate.publicationId,
    candidate.renditionId,
    candidate.assetId,
  ])
}

function observationFromResult(indexerId, observedAtMs, result, selector) {
  if (
    result.type !== 'external-ref' ||
    result.namespace !== selector.namespace ||
    result.identifier !== selector.identifier ||
    result.entityKind !== selector.kind
  ) return null
  return {
    locator: {
      publisherId: result.publisherId,
      sourceRecordRef: result.sourceRecordRef,
      publicationId: null,
      renditionId: null,
      assetId: null,
    },
    workEntityId: result.entityId,
    externalRef: Object.freeze({
      namespace: result.namespace,
      identifier: result.identifier,
    }),
    sourceIndexer: Object.freeze({ indexerId, observedAtMs }),
  }
}

function normalizeServices(services, maximum) {
  if (!Array.isArray(services) || services.length > maximum) fail('services exceed their bounded limit')
  const seen = new Set()
  return Object.freeze(services.map(service => {
    if (!service || typeof service !== 'object' || Array.isArray(service)) fail('index service must be an object')
    const indexerId = boundedText(service.indexerId, MAX_INDEXER_ID_BYTES, 'indexerId')
    if (seen.has(indexerId)) fail('index services must have distinct indexerIds')
    if (typeof service.queryIndexService !== 'function') fail('index service queryIndexService is required')
    seen.add(indexerId)
    return Object.freeze({
      indexerId,
      queryIndexService: service.queryIndexService.bind(service),
    })
  }))
}

export function createIndexFederation({ services, cache = new Map(), limits = {}, now = Date.now } = {}) {
  const maximumServices = boundedInteger(limits.maxServices, DEFAULT_MAX_SERVICES, MAX_SERVICES, 'maxServices')
  const configuredServices = normalizeServices(services, maximumServices)
  const maximumPages = boundedInteger(
    limits.maxPagesPerService,
    DEFAULT_MAX_PAGES_PER_SERVICE,
    MAX_PAGES_PER_SERVICE,
    'maxPagesPerService',
  )
  const maximumCandidates = boundedInteger(
    limits.maxCandidates,
    MAX_INDEX_QUERY_RESULTS,
    MAX_INDEX_QUERY_RESULTS,
    'maxCandidates',
  )
  const configuredDeadlineMs = boundedInteger(
    limits.deadlineMs,
    DEFAULT_DEADLINE_MS,
    MAX_INDEX_QUERY_DEADLINE_MS,
    'deadlineMs',
  )
  const candidateTtlMs = boundedInteger(
    limits.candidateTtlMs,
    DEFAULT_CANDIDATE_TTL_MS,
    MAX_CANDIDATE_TTL_MS,
    'candidateTtlMs',
  )
  const maximumCachedCandidates = boundedInteger(
    limits.maxCachedCandidates,
    DEFAULT_MAX_CACHED_CANDIDATES,
    MAX_CACHED_CANDIDATES,
    'maxCachedCandidates',
  )
  const randomBytes = limits.randomBytes || crypto.randomBytes
  const schedule = limits.setTimeout || setTimeout
  const cancelScheduled = limits.clearTimeout || clearTimeout
  if (typeof now !== 'function') fail('now must be a function')
  if (typeof randomBytes !== 'function') fail('randomBytes must be a function')
  if (typeof schedule !== 'function' || typeof cancelScheduled !== 'function') fail('timer adapter is invalid')
  if (
    !cache ||
    typeof cache.get !== 'function' ||
    typeof cache.set !== 'function' ||
    typeof cache.has !== 'function' ||
    typeof cache.delete !== 'function'
  ) fail('candidate cache must be Map-compatible')

  const owner = Object.freeze({})
  const ownedRefs = new Map()

  function currentTime() {
    const value = Number(now())
    if (!Number.isSafeInteger(value) || value < 0) fail('current time must be a non-negative safe integer')
    return value
  }

  function pruneCandidateCache(time = currentTime()) {
    for (const [candidateRef, expiresAt] of ownedRefs) {
      const record = cache.get(candidateRef)
      if (expiresAt > time && record?.owner === owner) continue
      ownedRefs.delete(candidateRef)
      if (record?.owner === owner) cache.delete(candidateRef)
    }
  }

  function evictOldestCandidate() {
    const oldest = ownedRefs.keys().next()
    if (oldest.done) return
    const candidateRef = oldest.value
    const record = cache.get(candidateRef)
    ownedRefs.delete(candidateRef)
    if (record?.owner === owner) cache.delete(candidateRef)
  }

  function randomToken() {
    const bytes = b4a.from(randomBytes(CANDIDATE_REF_BYTES))
    if (bytes.byteLength !== CANDIDATE_REF_BYTES) fail('random source must return 32 bytes')
    return b4a.toString(bytes, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  }

  function issueCandidate(locator, workEntityId, externalRef, sourceIndexers) {
    pruneCandidateCache()
    while (ownedRefs.size >= maximumCachedCandidates) evictOldestCandidate()
    let candidateRef = null
    for (let attempt = 0; attempt < 4; attempt++) {
      const token = randomToken()
      if (!cache.has(token)) {
        candidateRef = token
        break
      }
    }
    if (candidateRef === null) fail('candidate reference allocation failed')
    const expiresAt = currentTime() + candidateTtlMs
    if (!Number.isSafeInteger(expiresAt)) fail('candidate expiry exceeds the safe time bound')
    const projected = Object.freeze({
      schemaVersion: 2,
      candidateRef,
      work: Object.freeze({
        entityId: workEntityId,
        title: null,
        releaseYear: null,
        externalRefs: Object.freeze([externalRef]),
        episode: null,
      }),
      edition: Object.freeze({
        entityId: null,
        label: null,
        kind: null,
      }),
      publication: Object.freeze({
        publicationId: null,
        publisherId: locator.publisherId,
        manifestId: null,
        catalogEpoch: null,
        catalogHead: null,
      }),
      rendition: Object.freeze({
        renditionId: null,
        container: null,
        videoCodec: null,
        width: null,
        height: null,
        resolutionLabel: null,
        hdrFormats: Object.freeze([]),
        audioTracks: Object.freeze([]),
        subtitleTracks: Object.freeze([]),
        byteLength: null,
      }),
      asset: Object.freeze({
        assetId: null,
        coreKey: null,
        blockLength: null,
        byteLength: null,
      }),
      provenance: Object.freeze({
        sourceKind: null,
        releaseName: null,
        publicInfohash: null,
      }),
      availability: Object.freeze({
        peers: null,
        completeSeeders: null,
        observedAtMs: null,
        expiresAtMs: null,
      }),
      verification: Object.freeze({ state: 'unverified' }),
      sourceIndexers: Object.freeze(sourceIndexers.slice()),
    })
    cache.set(candidateRef, Object.freeze({
      owner,
      expiresAt,
      candidate: projected,
      locator: Object.freeze({ ...locator }),
    }))
    ownedRefs.set(candidateRef, expiresAt)
    return projected
  }

  function resolveCandidate(candidateRef) {
    if (typeof candidateRef !== 'string' || !CANDIDATE_REF.test(candidateRef)) return null
    const time = currentTime()
    pruneCandidateCache(time)
    const record = cache.get(candidateRef)
    if (record?.owner !== owner || record.expiresAt <= time) return null
    return record.candidate
  }

  function nextQueryId() {
    const bytes = b4a.from(randomBytes(32))
    if (bytes.byteLength !== 32) fail('random source must return 32 bytes')
    return b4a.toString(bytes, 'hex')
  }

  async function queryService(service, selector, requestedLimit, deadlineAt, signal) {
    const observations = []
    const cursors = new Set()
    let cursor = null
    let sourceRevision = null

    for (let pageNumber = 0; pageNumber < maximumPages && observations.length < requestedLimit; pageNumber++) {
      if (signal.aborted) throw abortError(signal.reason)
      const remaining = deadlineAt - currentTime()
      if (remaining <= 0) throw deadlineError()
      const remainingMs = Math.min(configuredDeadlineMs, remaining)
      const query = {
        queryId: nextQueryId(),
        selectors: [{ type: 'exact-external-ref', namespace: selector.namespace, identifier: selector.identifier }],
        limit: Math.min(MAX_INDEX_QUERY_RESULTS, requestedLimit - observations.length),
        cursor,
        deadlineMs: remainingMs,
      }
      const work = service.queryIndexService({ indexerId: service.indexerId, query, signal })
      const rawPage = await raceAbort(work, signal)
      const validatedPage = decodeIndexQueryPage(encodeIndexQueryPage(rawPage))
      if (validatedPage.queryId !== query.queryId) fail('index page queryId does not match its request')
      if (validatedPage.results.length > query.limit) fail('index page exceeds its requested limit')
      if (sourceRevision !== null && validatedPage.sourceRevision !== sourceRevision) {
        fail('index pagination changed source revision')
      }
      sourceRevision = validatedPage.sourceRevision
      const observedAtMs = currentTime()
      for (const result of validatedPage.results) {
        const observation = observationFromResult(service.indexerId, observedAtMs, result, selector)
        if (observation) observations.push(observation)
      }
      if (validatedPage.nextCursor === null || observations.length >= requestedLimit) break
      if (cursors.has(validatedPage.nextCursor)) fail('index pagination repeated a cursor')
      cursors.add(validatedPage.nextCursor)
      cursor = validatedPage.nextCursor
    }
    return observations
  }

  async function search({ selector: selectorValue, limit = maximumCandidates, signal } = {}) {
    const selector = normalizeSearchSelector(selectorValue)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumCandidates) {
      fail('search limit is outside its bounded limit')
    }
    if (signal !== undefined && (
      !signal ||
      typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function'
    )) fail('search signal must be an AbortSignal')
    if (signal?.aborted) throw abortError(signal.reason)
    pruneCandidateCache()
    if (configuredServices.length === 0) return []

    const controller = new AbortController()
    let callerAborted = false
    let active = true
    const onCallerAbort = () => {
      callerAborted = true
      controller.abort(abortError(signal.reason))
    }
    signal?.addEventListener('abort', onCallerAbort, { once: true })
    let timer
    try {
      timer = schedule(() => {
        if (!active) return
        controller.abort(deadlineError())
      }, configuredDeadlineMs)
      timer?.unref?.()
    } catch (error) {
      signal?.removeEventListener('abort', onCallerAbort)
      throw error
    }

    try {
      const deadlineAt = currentTime() + configuredDeadlineMs
      if (!Number.isSafeInteger(deadlineAt)) fail('search deadline exceeds the safe time bound')
      const serviceLimit = Math.min(limit, maximumCachedCandidates)
      const settled = await Promise.allSettled(configuredServices.map(service =>
        queryService(service, selector, serviceLimit, deadlineAt, controller.signal)
      ))
      if (callerAborted || signal?.aborted) throw abortError(signal?.reason)

      const merged = new Map()
      for (const outcome of settled) {
        if (outcome.status !== 'fulfilled') continue
        for (const observation of outcome.value) {
          const key = identityKey(observation.locator)
          const existing = merged.get(key)
          if (existing) {
            existing.workEntityIds.add(observation.workEntityId)
            if (!existing.indexerIds.has(observation.sourceIndexer.indexerId)) {
              existing.indexerIds.add(observation.sourceIndexer.indexerId)
              existing.sourceIndexers.push(observation.sourceIndexer)
            }
          } else if (merged.size < serviceLimit) {
            merged.set(key, {
              locator: observation.locator,
              externalRef: observation.externalRef,
              workEntityIds: new Set([observation.workEntityId]),
              indexerIds: new Set([observation.sourceIndexer.indexerId]),
              sourceIndexers: [observation.sourceIndexer],
            })
          }
        }
      }

      const results = []
      for (const value of merged.values()) {
        const workEntityId = value.workEntityIds.size === 1
          ? value.workEntityIds.values().next().value
          : null
        results.push(issueCandidate(
          value.locator,
          workEntityId,
          value.externalRef,
          value.sourceIndexers,
        ))
      }
      return results
    } finally {
      active = false
      cancelScheduled(timer)
      signal?.removeEventListener('abort', onCallerAbort)
    }
  }

  return Object.freeze({ search, resolveCandidate })
}
