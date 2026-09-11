import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { episodeWorkIdentifier } from '../channel/structured-content.js'
import {
  MAX_INDEX_QUERY_DEADLINE_MS,
  MAX_INDEX_QUERY_RESULTS,
  MAX_INDEX_QUERY_TEXT_BYTES,
  decodeIndexQueryPage,
  encodeIndexQueryPage,
  normalizeIndexQuerySelectors,
} from '../indexer/query-codec.js'
import { encodeIndexServiceAnnouncement, verifyIndexServiceAnnouncement } from '../indexer/service-announcement.js'

export const INDEX_FEDERATION_PRIVATE = Symbol('index-federation-private')

const DEFAULT_MAX_SERVICES = 33
const MAX_SERVICES = 33
const DEFAULT_MAX_FANOUT = 8
const MAX_FANOUT = 8
const CURSOR_PREFIX = 'fed:v1:'
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
const CANONICAL_INDEXER_ID = /^[0-9a-f]{64}$/
const LOCAL_SERVICE_IDENTITIES = new WeakMap()

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

function ordinal(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${name} must be a positive integer`)
  return value
}


function localServiceIdentity(service, queryIndexService) {
  let byQuery = LOCAL_SERVICE_IDENTITIES.get(service)
  if (!byQuery) {
    byQuery = new WeakMap()
    LOCAL_SERVICE_IDENTITIES.set(service, byQuery)
  }
  let identity = byQuery.get(queryIndexService)
  if (!identity) {
    identity = Symbol('local-index-service-incarnation')
    byQuery.set(queryIndexService, identity)
  }
  return identity
}

// Title shards, the wire selector, and result acceptance must all derive the
// same routing key: the normalized lowercase first token of the title. The
// index service matches and stores full tokens, so a mixed-case or multiword
// title must never be compared bytewise against shard bounds. Full query token
// lists travel on the private locator so verification binds every requested token.
function titleQueryTokens(title) {
  return title.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []
}

function titleRoutingKey(title) {
  return titleQueryTokens(title)[0] || title
}

// A movie is named directly by its provider id; an episode is named by its
// show's id plus its place in the show. Locating either is the same
// exact-external-ref index lookup against the same coordinate the archive
// signed — only the coordinate an episode is keyed by has to be composed here
// rather than passed through, because a caller holds the show and the ordinals
// separately and never the joined string.
function normalizeSearchSelector(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('search selector must be an object')
  const kind = boundedText(value.kind, MAX_KIND_BYTES, 'selector kind')
  const episodic = kind === 'episode'
  const byTitle = Object.hasOwn(value, 'title')
  if (byTitle) {
    exactFields(
      value,
      episodic ? ['title', 'kind', 'season', 'episode'] : ['title', 'kind'],
      'search selector',
    )
    return Object.freeze({
      title: boundedText(value.title, MAX_INDEX_QUERY_TEXT_BYTES, 'selector title'),
      kind,
      ...(episodic ? { season: ordinal(value.season, 'selector season'), episode: ordinal(value.episode, 'selector episode') } : {}),
    })
  }

  exactFields(
    value,
    episodic ? ['namespace', 'identifier', 'kind', 'season', 'episode'] : ['namespace', 'identifier', 'kind'],
    'search selector',
  )
  const identifier = episodic
    ? episodeWorkIdentifier(
        boundedText(value.identifier, MAX_INDEX_QUERY_TEXT_BYTES, 'selector identifier'),
        ordinal(value.season, 'selector season'),
        ordinal(value.episode, 'selector episode'),
      )
    : value.identifier
  const protocolSelector = normalizeIndexQuerySelectors([{
    type: 'exact-external-ref',
    namespace: value.namespace,
    identifier,
  }])[0]
  return Object.freeze({
    namespace: protocolSelector.namespace,
    identifier: protocolSelector.identifier,
    kind,
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
    candidate.publicationSourceRecordRef,
    candidate.publicationId,
    candidate.candidateManifestId,
    candidate.renditionId,
    candidate.assetId,
    candidate.discovery?.type ?? null,
    candidate.discovery?.token ?? null,
  ])
}

function externalObservation(indexerId, observedAtMs, result, selector) {
  if (result.type === 'title-token') {
    const routingKey = selector.title ? titleRoutingKey(selector.title) : null
    if (routingKey === null || !result.token.startsWith(routingKey)) return null
    // Observations may be serialized into federation continuation cursors.
    // Keep only edge facts here — never the request's queryTokens (derived
    // from the live selector when the private locator is issued).
    return Object.freeze({
      publisherId: result.publisherId,
      sourceRecordRef: result.sourceRecordRef,
      workEntityId: result.targetId,
      externalRef: null,
      discovery: Object.freeze({
        type: 'title-token',
        token: result.token,
        targetId: result.targetId,
      }),
      sourceIndexer: Object.freeze({ indexerId, observedAtMs }),
    })
  }
  const workKind = selector.kind === 'movie' || selector.kind === 'series' || selector.kind === 'episode' || selector.kind === 'all' || selector.kind === 'any'
  if (
    result.type !== 'external-ref' ||
    result.namespace !== selector.namespace ||
    result.identifier !== selector.identifier ||
    (result.entityKind !== selector.kind && !(workKind && result.entityKind === 'work'))
  ) return null
  return Object.freeze({
    publisherId: result.publisherId,
    sourceRecordRef: result.sourceRecordRef,
    workEntityId: result.entityId,
    externalRef: Object.freeze({ namespace: result.namespace, identifier: result.identifier }),
    discovery: Object.freeze({ type: 'external-ref' }),
    sourceIndexer: Object.freeze({ indexerId, observedAtMs }),
  })
}

// Private locator discovery is always rebuilt from the current normalized
// selector. Continuation cursors are plain base64 JSON (not MACed); never
// trust queryTokens or discovery type from resumed observations.
function buildLocatorDiscovery(selector, external) {
  if (selector.title) {
    const queryTokens = titleQueryTokens(selector.title)
    const routingKey = queryTokens[0] || null
    if (
      external.discovery?.type !== 'title-token' ||
      routingKey === null ||
      typeof external.discovery.token !== 'string' ||
      !external.discovery.token.startsWith(routingKey) ||
      typeof external.discovery.targetId !== 'string' ||
      external.discovery.targetId !== external.workEntityId
    ) {
      fail('index observation does not match the search selector')
    }
    return Object.freeze({
      type: 'title-token',
      token: external.discovery.token,
      targetId: external.discovery.targetId,
      queryTokens: Object.freeze(queryTokens.slice()),
    })
  }
  if (external.discovery?.type !== 'external-ref' || external.externalRef == null) {
    fail('index observation does not match the search selector')
  }
  return Object.freeze({ type: 'external-ref' })
}

function compareStrings(left, right) {
  return b4a.compare(b4a.from(left, 'utf8'), b4a.from(right, 'utf8'))
}

function inRange(key, start, end) {
  if (start !== null && compareStrings(key, start) < 0) return false
  if (end !== null && compareStrings(key, end) >= 0) return false
  return true
}

function isEligibleService(service, selector) {
  if (service.isLocal === true) return true
  if (!service.announcement || typeof service.announcement !== 'object') {
    return false
  }
  const announcement = service.announcement
  const dimensions = Array.isArray(announcement.dimensions) ? announcement.dimensions : []
  const capabilities = Array.isArray(announcement.queryCapabilities) ? announcement.queryCapabilities : []
  const shardRanges = Array.isArray(announcement.shardRanges) ? announcement.shardRanges : []

  if (selector.namespace && selector.identifier) {
    if (!dimensions.includes('external-ref')) return false
    if (!capabilities.includes('exact-external-ref') ||
        !capabilities.includes('publication-by-work') ||
        !capabilities.includes('rendition-by-publication')) {
      return false
    }
    const externalRanges = shardRanges.filter(r => r && r.dimension === 'external-ref')
    if (externalRanges.length > 0) {
      const compositeKey = `${selector.namespace}:${selector.identifier}`
      const matches = externalRanges.some(r => inRange(compositeKey, r.start, r.end) || inRange(selector.identifier, r.start, r.end))
      if (!matches) return false
    }
    return true
  }

  if (selector.title) {
    const routingKey = titleRoutingKey(selector.title)
    if (dimensions.includes('text') && capabilities.includes('text-prefix')) {
      const textRanges = shardRanges.filter(r => r && r.dimension === 'text')
      if (textRanges.length > 0) {
        const matches = textRanges.some(r => inRange(routingKey, r.start, r.end))
        if (!matches) return false
      }
      return true
    }
    return false
  }

  return false
}


// Continuation state is bound to the exact normalized query, including the
// title and episode ordinals that a namespace/identifier/kind fingerprint
// would collapse — a cursor minted for one title must never resume another.
// Digest keeps the cursor payload bounded while covering every normalized field.
function selectorFingerprint(selector) {
  return b4a.toString(crypto.hash(b4a.from(JSON.stringify(selector))), 'hex')
}


function normalizeServices(services, maximum) {
  if (!Array.isArray(services) || services.length > maximum) fail('services exceed their bounded limit')
  const seen = new Set()
  const normalized = []
  for (const service of services) {
    if (!service || typeof service !== 'object' || Array.isArray(service)) fail('index service must be an object')
    const indexerId = boundedText(service.indexerId, MAX_INDEXER_ID_BYTES, 'indexerId')
    if (service.isLocal !== true && !CANONICAL_INDEXER_ID.test(indexerId)) continue
    if (seen.has(indexerId)) fail('index services must have distinct indexerIds')
    const queryIndexService = service.queryIndexService
    if (typeof queryIndexService !== 'function') fail('index service queryIndexService is required')
    seen.add(indexerId)
    const announcement = service.announcement && typeof service.announcement === 'object' ? service.announcement : null
    const identity = service.isLocal === true
      ? localServiceIdentity(service, queryIndexService)
      : null
    const incarnation = service.isLocal === true
      ? Object.freeze({ kind: 'local', identity, indexerId })
      : null
    normalized.push(Object.freeze({
      indexerId,
      announcement,
      isLocal: service.isLocal === true,
      identity,
      incarnation,
      queryIndexService: queryIndexService.bind(service),
    }))
  }
  return Object.freeze(normalized)
}

export function createIndexFederation({ services, cache = new Map(), limits = {}, now = Date.now } = {}) {
  const maximumServices = boundedInteger(limits.maxServices, DEFAULT_MAX_SERVICES, MAX_SERVICES, 'maxServices')
  const maximumFanout = boundedInteger(limits.maxFanout, DEFAULT_MAX_FANOUT, MAX_FANOUT, 'maxFanout')
  const servicesProvider = typeof services === 'function' ? services : null
  const staticServices = servicesProvider === null ? normalizeServices(services, maximumServices) : null
  const resolveConfiguredServices = servicesProvider === null
    ? () => staticServices
    : () => normalizeServices(servicesProvider(maximumServices), maximumServices)
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
  let continuations = null
  let continuationRows = 0
  const maximumContinuationRows = maximumCachedCandidates + 3 * maximumFanout * maximumCandidates + 1
  let closed = false
  const activeControllers = new Set()
  const drainWaiters = new Set()

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
    if (continuations) {
      for (const [token, entry] of continuations) {
        if (entry.inFlight || entry.expiresAt > time) continue
        dropContinuation(token, entry)
      }
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

  function continuationCost(state) {
    let cost = 1 + (state.pending?.length || 0)
    for (const entry of state.c.values()) {
      cost += (entry?.obs?.length || 0) + (entry?.pubs?.length || 0)
    }
    return cost
  }

  function dropContinuation(token, entry) {
    if (continuations?.get(token) !== entry) return false
    continuations.delete(token)
    continuationRows -= entry.cost
    if (continuationRows < 0) fail('continuation row accounting underflow')
    return true
  }

  function restoreContinuation(token, entry) {
    continuations ??= new Map()
    const existing = continuations.get(token)
    if (existing && existing !== entry) fail('continuation reference collision during restore')
    if (existing === entry) {
      entry.inFlight = false
      return
    }
    entry.inFlight = false
    continuations.set(token, entry)
    continuationRows += entry.cost
  }

  function issueContinuation(state, { avoidToken = null } = {}) {
    const cost = continuationCost(state)
    if (cost > maximumContinuationRows) fail('continuation exceeds its retained row budget')
    continuations ??= new Map()

    // Reserve the token first; roll back capacity evictions if replacement fails.
    let token = null
    for (let attempt = 0; attempt < 4; attempt++) {
      const candidate = `${CURSOR_PREFIX}${randomToken()}`
      if (candidate !== avoidToken && !continuations.has(candidate)) { token = candidate; break }
    }
    if (token === null) fail('continuation reference allocation failed')
    const expiresAt = currentTime() + candidateTtlMs
    if (!Number.isSafeInteger(expiresAt)) fail('continuation expiry exceeds the safe time bound')

    const evicted = []
    try {
      for (const [candidate, entry] of continuations) {
        if (continuationRows + cost <= maximumContinuationRows) break
        if (candidate === avoidToken || entry.inFlight) continue
        dropContinuation(candidate, entry)
        evicted.push([candidate, entry])
      }
      if (continuationRows + cost > maximumContinuationRows) fail('continuation retained row capacity is exhausted')
      continuations.set(token, { state, cost, expiresAt, inFlight: false })
      continuationRows += cost
    } catch (error) {
      for (const [evictedToken, evictedEntry] of evicted.reverse()) restoreContinuation(evictedToken, evictedEntry)
      throw error
    }
    return token
  }

  function resolveContinuation(token, fingerprint) {
    const entry = continuations?.get(token)
    if (!entry || entry.expiresAt <= currentTime()) fail('invalid or expired cursor')
    if (entry.inFlight) fail('continuation cursor is already in use')
    if (entry.state.f !== fingerprint) fail('cursor fingerprint mismatch')
    return entry
  }

  function validateContinuationServices(entry, eligibleServices) {
    const expected = entry.state.e
    if (!Array.isArray(expected) || expected.length !== eligibleServices.length) {
      fail('cursor service eligibility changed')
    }
    for (let index = 0; index < expected.length; index++) {
      const current = eligibleServices[index].incarnation
      const previous = expected[index]
      if (
        previous?.kind !== current.kind ||
        previous.identity !== current.identity ||
        previous.indexerId !== current.indexerId
      ) fail('cursor service identity mismatch')
    }
    if (!(entry.state.c instanceof Map)) fail('cursor service state is invalid')
    const identities = new Set(eligibleServices.map(service => service.identity))
    for (const identity of entry.state.c.keys()) {
      if (!identities.has(identity)) fail('cursor service state is invalid')
    }
  }

  function claimContinuation(entry) {
    if (entry.inFlight) fail('continuation cursor is already in use')
    entry.inFlight = true
  }

  function releaseContinuationClaim(token, entry) {
    if (continuations?.get(token) === entry) entry.inFlight = false
  }

  function completeContinuation(token, entry, state) {
    if (!dropContinuation(token, entry)) fail('continuation cursor was not retained')
    entry.inFlight = false
    if (state === null) return null
    try {
      return issueContinuation(state, { avoidToken: token })
    } catch (error) {
      restoreContinuation(token, entry)
      throw error
    }
  }

  function issueCandidate(locator, external, publication, rendition, sourceIndexers) {
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
        entityId: external.workEntityId,
        title: publication.normalizedTitle,
        releaseYear: publication.releaseYear,
        externalRefs: Object.freeze(external.externalRef ? [external.externalRef] : []),
        episode: null,
      }),
      edition: Object.freeze({
        entityId: null,
        label: null,
        kind: null,
      }),
      publication: Object.freeze({
        publicationId: publication.publicationId,
        publisherId: locator.publisherId,
        manifestId: publication.manifestId,
        catalogEpoch: null,
        catalogHead: null,
      }),
      rendition: Object.freeze({
        renditionId: rendition.renditionId,
        container: rendition.format,
        videoCodec: rendition.codec,
        width: null,
        height: null,
        resolutionLabel: rendition.dimensions,
        hdrFormats: Object.freeze([]),
        audioTracks: Object.freeze([]),
        subtitleTracks: Object.freeze([]),
        byteLength: rendition.byteLength,
      }),
      asset: Object.freeze({
        assetId: rendition.assetId,
        coreKey: null,
        blockLength: null,
        byteLength: rendition.byteLength,
      }),
      provenance: Object.freeze({
        sourceKind: null,
        releaseName: publication.provenanceSummary,
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

  function resolveCandidateRecord(candidateRef) {
    if (typeof candidateRef !== 'string' || !CANDIDATE_REF.test(candidateRef)) return null
    const time = currentTime()
    pruneCandidateCache(time)
    const record = cache.get(candidateRef)
    if (record?.owner !== owner || record.expiresAt <= time) return null
    return record
  }

  function resolveCandidate(candidateRef) {
    return resolveCandidateRecord(candidateRef)?.candidate ?? null
  }

  function nextQueryId() {
    const bytes = b4a.from(randomBytes(32))
    if (bytes.byteLength !== 32) fail('random source must return 32 bytes')
    return b4a.toString(bytes, 'hex')
  }

  async function queryPages(service, selectors, requestedLimit, deadlineAt, signal, expectedRevision, budget, initialCursor = null) {
    const results = []
    const cursors = new Set()
    let cursor = initialCursor
    let sourceRevision = expectedRevision
    let nextServiceCursor = null
    let stale = false

    while (budget.remaining > 0 && results.length < requestedLimit) {
      if (signal.aborted) throw abortError(signal.reason)
      const remaining = deadlineAt - currentTime()
      if (remaining <= 0) throw deadlineError()
      const query = {
        queryId: nextQueryId(),
        selectors,
        limit: Math.min(MAX_INDEX_QUERY_RESULTS, requestedLimit - results.length),
        cursor,
        sourceRevision,
        deadlineMs: Math.min(configuredDeadlineMs, remaining),
      }
      budget.remaining--
      const work = service.queryIndexService({ indexerId: service.indexerId, query, signal })
      const rawPage = await raceAbort(work, signal)
      const page = decodeIndexQueryPage(encodeIndexQueryPage(rawPage))
      if (page.queryId !== query.queryId) fail('index page queryId does not match its request')
      if (page.results.length > query.limit) fail('index page exceeds its requested limit')
      if (sourceRevision !== null && page.sourceRevision !== sourceRevision) {
        stale = true
        break
      }
      sourceRevision = page.sourceRevision
      results.push(...page.results)
      if (page.nextCursor === null) {
        nextServiceCursor = null
        break
      }
      nextServiceCursor = page.nextCursor
      if (results.length >= requestedLimit) {
        break
      }
      if (cursors.has(page.nextCursor)) fail('index pagination repeated a cursor')
      cursors.add(page.nextCursor)
      cursor = page.nextCursor
    }
    return { results, sourceRevision, nextCursor: nextServiceCursor, stale }
  }

  async function queryPublicationRenditions({
    service,
    publication,
    external,
    selector,
    neededLimit,
    deadlineAt,
    signal,
    sourceRevision,
    budget,
    renditionCursor
  }) {
    const renditionsResult = await queryPages(
      service,
      [{
        type: 'rendition-by-publication',
        publisherId: publication.publisherId,
        publicationId: publication.publicationId,
      }],
      neededLimit,
      deadlineAt,
      signal,
      sourceRevision,
      budget,
      renditionCursor,
    )
    if (renditionsResult.stale) {
      return { stale: true, nextCursor: null, candidates: [], sourceRevision }
    }
    const nextSourceRevision = renditionsResult.sourceRevision || sourceRevision
    const candidates = []
    for (const rendition of renditionsResult.results) {
      if (
        rendition.type !== 'rendition' ||
        rendition.publisherId !== publication.publisherId ||
        rendition.publicationId !== publication.publicationId ||
        rendition.sourceRecordRef !== publication.sourceRecordRef
      ) fail('index rendition traversal returned a mismatched result')
      candidates.push({
        locator: Object.freeze({
          publisherId: external.publisherId,
          sourceRecordRef: external.sourceRecordRef,
          publicationSourceRecordRef: publication.sourceRecordRef,
          publicationId: publication.publicationId,
          candidateManifestId: publication.manifestId,
          renditionId: rendition.renditionId,
          assetId: rendition.assetId,
          discovery: buildLocatorDiscovery(selector, external),
        }),
        external,
        publication,
        rendition,
        sourceIndexer: external.sourceIndexer,
      })
      if (candidates.length >= neededLimit) break
    }
    return {
      stale: false,
      nextCursor: renditionsResult.nextCursor,
      candidates,
      sourceRevision: nextSourceRevision
    }
  }

  async function queryWorkPublications({
    service,
    external,
    neededLimit,
    deadlineAt,
    signal,
    sourceRevision,
    budget,
    cursor = null
  }) {
    const pubsResult = await queryPages(
      service,
      [{
        type: 'publication-by-work',
        publisherId: external.publisherId,
        workEntityId: external.workEntityId,
      }],
      neededLimit,
      deadlineAt,
      signal,
      sourceRevision,
      budget,
      cursor,
    )
    if (pubsResult.stale) {
      return { stale: true, sourceRevision, nextCursor: null, publications: [] }
    }
    for (const pub of pubsResult.results) {
      if (
        pub.type !== 'publication' ||
        pub.publisherId !== external.publisherId ||
        pub.workEntityId !== external.workEntityId
      ) fail('index publication traversal returned a mismatched result')
    }
    return {
      stale: false,
      sourceRevision: pubsResult.sourceRevision || sourceRevision,
      nextCursor: pubsResult.nextCursor,
      publications: pubsResult.results
    }
  }

  async function queryDiscoveryObservations({
    service,
    selector,
    requestedLimit,
    deadlineAt,
    signal,
    sourceRevision,
    budget,
    discoveryCursor,
    observedAtMs
  }) {
    const selectors = selector.title
      ? [{ type: 'title-token-prefix', prefix: titleRoutingKey(selector.title) }]
      : [{ type: 'exact-external-ref', namespace: selector.namespace, identifier: selector.identifier }]
    const discovery = await queryPages(
      service,
      selectors,
      requestedLimit,
      deadlineAt,
      signal,
      sourceRevision,
      budget,
      discoveryCursor,
    )
    const observations = []
    for (const res of discovery.results) {
      const obs = externalObservation(service.indexerId, observedAtMs, res, selector)
      if (obs) observations.push(obs)
    }
    return {
      stale: discovery.stale,
      sourceRevision: discovery.sourceRevision || sourceRevision,
      nextCursor: discovery.nextCursor,
      observations
    }
  }

  function buildNextServiceState({
    renditionCursor,
    pubIndex,
    pendingPublications,
    pubCursor,
    publicationsStarted,
    obsIndex,
    pendingObservations,
    discoveryCursor,
    sourceRevision,
    stale
  }) {
    const hasMoreRenditions = renditionCursor !== null || pubIndex < pendingPublications.length
    const hasMorePublications = pubCursor !== null || (!publicationsStarted && obsIndex < pendingObservations.length) || (obsIndex + 1) < pendingObservations.length
    const hasMoreDiscovery = discoveryCursor !== null
    if (!hasMoreRenditions && !hasMorePublications && !hasMoreDiscovery) return null

    return {
      dc: discoveryCursor,
      obs: pendingObservations.slice(obsIndex),
      oi: 0,
      pc: pubCursor,
      ps: publicationsStarted,
      pubs: pendingPublications.slice(pubIndex),
      pi: 0,
      rc: renditionCursor,
      rev: sourceRevision,
      stale,
    }
  }

  function readSavedCursor(savedState, field, fallback) {
    return savedState?.[field] ?? fallback
  }

  function loadServiceState(savedState) {
    return {
      stale: Boolean(savedState?.stale),
      discoveryCursor: readSavedCursor(savedState, 'dc', null),
      pendingObservations: Array.isArray(savedState?.obs) ? savedState.obs.slice() : [],
      obsIndex: readSavedCursor(savedState, 'oi', 0),
      pubCursor: readSavedCursor(savedState, 'pc', null),
      pendingPublications: Array.isArray(savedState?.pubs) ? savedState.pubs.slice() : [],
      pubIndex: readSavedCursor(savedState, 'pi', 0),
      renditionCursor: readSavedCursor(savedState, 'rc', null),
      publicationsStarted: savedState?.ps === true,
      sourceRevision: readSavedCursor(savedState, 'rev', null),
    }
  }

  async function drainPendingRenditions({ service, selector, requestedLimit, deadlineAt, signal, candidates, budget, state }) {
    while (state.pubIndex < state.pendingPublications.length && candidates.length < requestedLimit && budget.remaining > 0) {
      const publication = state.pendingPublications[state.pubIndex]
      const external = state.pendingObservations[state.obsIndex]
      const result = await queryPublicationRenditions({
        service,
        publication,
        external,
        selector,
        neededLimit: requestedLimit - candidates.length,
        deadlineAt,
        signal,
        sourceRevision: state.sourceRevision,
        budget,
        renditionCursor: state.renditionCursor,
      })
      if (result.stale) {
        state.stale = true
        state.pubIndex++
        state.renditionCursor = null
        continue
      }
      state.sourceRevision = result.sourceRevision
      state.renditionCursor = result.nextCursor
      candidates.push(...result.candidates)
      if (state.renditionCursor !== null) break
      state.pubIndex++
    }
  }

  function applyPublicationsFetch(state, result) {
    state.sourceRevision = result.sourceRevision
    state.pubCursor = result.nextCursor
    state.publicationsStarted = true
    state.pendingPublications = result.publications
    state.pubIndex = 0
    state.renditionCursor = null
  }

  async function fetchObservationPublications({ service, requestedLimit, deadlineAt, signal, candidates, budget, cursor, state }) {
    const external = state.pendingObservations[state.obsIndex]
    const result = await queryWorkPublications({
      service,
      external,
      neededLimit: requestedLimit - candidates.length,
      deadlineAt,
      signal,
      sourceRevision: state.sourceRevision,
      budget,
      cursor,
    })
    applyPublicationsFetch(state, result)
    return result
  }

  async function fetchCurrentObservationPublications({ service, requestedLimit, deadlineAt, signal, candidates, budget, state }) {
    if ((!state.publicationsStarted || state.pubCursor !== null) && state.obsIndex < state.pendingObservations.length) {
      const result = await fetchObservationPublications({
        service,
        requestedLimit,
        deadlineAt,
        signal,
        candidates,
        budget,
        cursor: state.pubCursor,
        state,
      })
      if (result.stale) {
        state.stale = true
        state.obsIndex++
        state.pubCursor = null
        state.publicationsStarted = false
        state.pendingPublications = []
        state.pubIndex = 0
        return true
      }
      return true
    }
    return false
  }

  async function fetchDiscoveryObservations({ service, selector, requestedLimit, deadlineAt, signal, candidates, budget, state, savedState, observedAtMs }) {
    if (state.discoveryCursor !== null || (savedState === null && state.pendingObservations.length === 0)) {
      const discovery = await queryDiscoveryObservations({
        service,
        selector,
        requestedLimit,
        deadlineAt,
        signal,
        sourceRevision: state.sourceRevision,
        budget,
        discoveryCursor: state.discoveryCursor,
        observedAtMs,
      })
      if (discovery.stale) state.stale = true
      state.sourceRevision = discovery.sourceRevision
      state.discoveryCursor = discovery.nextCursor
      state.pendingObservations = discovery.observations
      state.obsIndex = 0
      state.pubCursor = null
      state.publicationsStarted = false
      state.pendingPublications = []
      state.pubIndex = 0
      state.renditionCursor = null

      if (state.pendingObservations.length > 0 && budget.remaining > 0) {
        const result = await fetchObservationPublications({
          service,
          requestedLimit,
          deadlineAt,
          signal,
          candidates,
          budget,
          cursor: null,
          state,
        })
        if (result.stale) state.stale = true
        return true
      }
    }
    return false
  }

  async function queryService(service, selector, requestedLimit, deadlineAt, signal, savedState = null) {
    const candidates = []
    const budget = { remaining: maximumPages }
    const state = loadServiceState(savedState)
    const observedAtMs = currentTime()

    while (candidates.length < requestedLimit && budget.remaining > 0) {
      await drainPendingRenditions({ service, selector, requestedLimit, deadlineAt, signal, candidates, budget, state })

      if (candidates.length >= requestedLimit || budget.remaining === 0) break

      if (await fetchCurrentObservationPublications({ service, requestedLimit, deadlineAt, signal, candidates, budget, state })) continue

      state.obsIndex++
      state.publicationsStarted = false
      if (state.obsIndex < state.pendingObservations.length) {
        const pubsResult = await fetchObservationPublications({
          service,
          requestedLimit,
          deadlineAt,
          signal,
          candidates,
          budget,
          cursor: null,
          state,
        })
        if (pubsResult.stale) state.stale = true
        continue
      }

      if (await fetchDiscoveryObservations({ service, selector, requestedLimit, deadlineAt, signal, candidates, budget, state, savedState, observedAtMs })) continue

      break
    }

    const nextState = buildNextServiceState(state)

    return { candidates, sourceRevision: state.sourceRevision, nextState, stale: state.stale }
  }

  function validateSearchParams(selectorValue, limit, maximumCandidates, signal) {
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
    return selector
  }

  function resolveEligibleIndexServices(configuredServices, selector, time) {
    const eligibleServices = []
    for (const service of configuredServices) {
      // Authenticate before either routing or deriving cursor provenance. Static
      // adapters must cross this boundary again as their signed lifetime elapses.
      if (!service.isLocal) {
        const expectedIndexerId = b4a.from(service.indexerId, 'hex')
        if (!verifyIndexServiceAnnouncement(service.announcement, { now: time, expectedIndexerId })) continue
      }
      if (!isEligibleService(service, selector)) continue
      if (service.isLocal) {
        eligibleServices.push(service)
        continue
      }
      const identity = b4a.toString(crypto.hash(encodeIndexServiceAnnouncement(service.announcement)), 'hex')
      eligibleServices.push(Object.freeze({
        ...service,
        identity,
        incarnation: Object.freeze({ kind: 'announced', identity, indexerId: service.indexerId }),
      }))
    }
    return eligibleServices
  }

  function selectFanoutServices(eligibleServices, continuation, maximumFanout) {
    const serviceOffset = continuation?.s ?? 0
    const savedCursors = continuation?.c ?? new Map()
    const pendingCandidates = continuation?.pending
    const fanoutCount = pendingCandidates?.length ? 0 : Math.min(maximumFanout, eligibleServices.length)
    const selectedServices = []
    let nextOffset = serviceOffset
    for (let i = 0; i < eligibleServices.length && selectedServices.length < fanoutCount; i++) {
      const idx = (serviceOffset + i) % eligibleServices.length
      nextOffset = (idx + 1) % eligibleServices.length
      const service = eligibleServices[idx]
      if (savedCursors.has(service.identity) && savedCursors.get(service.identity) === null) continue
      selectedServices.push(service)
    }
    return { selectedServices, nextOffset, savedCursors, pendingCandidates }
  }

  function aggregateServiceOutcomes(settled, selectedServices, savedCursors, pendingCandidates) {
    let partial = false
    let stale = false
    let respondingServices = 0
    const merged = new Map()
    if (pendingCandidates) {
      for (const observation of pendingCandidates) merged.set(identityKey(observation.locator), observation)
    }
    const nextServiceStates = new Map(savedCursors)

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]
      const service = selectedServices[i]
      if (outcome.status !== 'fulfilled') {
        partial = true
        continue
      }
      respondingServices++
      const serviceResult = outcome.value
      if (serviceResult.stale) stale = true
      nextServiceStates.set(service.identity, serviceResult.nextState)
      for (const observation of (serviceResult.candidates || [])) {
        const key = identityKey(observation.locator)
        const existing = merged.get(key)
        if (existing) {
          if (!existing.indexerIds.has(observation.sourceIndexer.indexerId)) {
            existing.indexerIds.add(observation.sourceIndexer.indexerId)
            existing.sourceIndexers.push(observation.sourceIndexer)
          }
        } else {
          merged.set(key, {
            ...observation,
            indexerIds: new Set([observation.sourceIndexer.indexerId]),
            sourceIndexers: [observation.sourceIndexer],
          })
        }
      }
    }
    return { partial, stale, respondingServices, merged, nextServiceStates }
  }

  function packageSearchResults({
    merged,
    serviceLimit,
    eligibleServices,
    nextServiceStates,
    fingerprint,
    nextOffset,
    continuationEntry,
    continuationToken,
    partial,
    stale,
    selectedServices,
    respondingServices
  }) {
    const results = []
    let pending = null
    for (const value of merged.values()) {
      if (results.length >= serviceLimit) {
        (pending ??= []).push(value)
        continue
      }
      results.push(issueCandidate(
        value.locator,
        value.external,
        value.publication,
        value.rendition,
        value.sourceIndexers,
      ))
    }

    const hasContinuation = pending !== null || eligibleServices.some(service =>
      !nextServiceStates.has(service.identity) || nextServiceStates.get(service.identity) !== null)

    let nextCursor = null
    const nextState = hasContinuation ? {
      f: fingerprint,
      s: nextOffset,
      c: nextServiceStates,
      e: eligibleServices.map(service => service.incarnation),
      pending,
    } : null

    let continuationCommitted = false
    if (continuationEntry) {
      nextCursor = completeContinuation(continuationToken, continuationEntry, nextState)
      continuationCommitted = true
    } else if (nextState !== null) {
      nextCursor = issueContinuation(nextState)
    }

    return {
      continuationCommitted,
      response: Object.freeze({
        candidates: Object.freeze(results),
        nextCursor,
        diagnostics: Object.freeze({
          partial,
          stale,
          queriedServices: selectedServices.length,
          respondingServices,
          totalEligibleServices: eligibleServices.length,
        }),
      }),
    }
  }

  function restoreSearchContinuation(cursorValue, fingerprint, eligibleServices) {
    if (cursorValue === null) return { token: null, entry: null, continuation: null }
    const token = cursorValue
    const entry = resolveContinuation(cursorValue, fingerprint)
    validateContinuationServices(entry, eligibleServices)
    claimContinuation(entry)
    return { token, entry, continuation: entry.state }
  }

  function releaseUncommittedContinuation(continuationEntry, continuationToken, continuationCommitted) {
    if (continuationEntry && !continuationCommitted) releaseContinuationClaim(continuationToken, continuationEntry)
  }

  function emptySearchResponse(continuationEntry, continuationToken, continuationCommitted) {
    releaseUncommittedContinuation(continuationEntry, continuationToken, continuationCommitted)
    return Object.freeze({
      candidates: Object.freeze([]),
      nextCursor: null,
      diagnostics: Object.freeze({
        partial: false,
        stale: false,
        queriedServices: 0,
        respondingServices: 0,
        totalEligibleServices: 0,
      }),
    })
  }

  function abortSearchSetup(controller, signal, onCallerAbort, continuationEntry, continuationToken, continuationCommitted) {
    activeControllers.delete(controller)
    signal?.removeEventListener('abort', onCallerAbort)
    releaseUncommittedContinuation(continuationEntry, continuationToken, continuationCommitted)
  }

  function drainSearchWaiters() {
    if (activeControllers.size === 0) {
      for (const resolve of drainWaiters) resolve()
      drainWaiters.clear()
    }
  }

  async function search({ selector: selectorValue, limit = maximumCandidates, cursor: cursorValue = null, signal } = {}) {
    if (closed) fail('index federation is closed')
    const selector = validateSearchParams(selectorValue, limit, maximumCandidates, signal)
    if (signal?.aborted) throw abortError(signal.reason)
    const time = currentTime()
    pruneCandidateCache(time)

    const eligibleServices = resolveEligibleIndexServices(resolveConfiguredServices(), selector, time)
    const fingerprint = selectorFingerprint(selector)
    const { token: continuationToken, entry: continuationEntry, continuation } = restoreSearchContinuation(cursorValue, fingerprint, eligibleServices)
    let continuationCommitted = false

    if (eligibleServices.length === 0) {
      return emptySearchResponse(continuationEntry, continuationToken, continuationCommitted)
    }

    const { selectedServices, nextOffset, savedCursors, pendingCandidates } = selectFanoutServices(
      eligibleServices,
      continuation,
      maximumFanout
    )

    const controller = new AbortController()
    activeControllers.add(controller)
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
    } catch (error) {
      abortSearchSetup(controller, signal, onCallerAbort, continuationEntry, continuationToken, continuationCommitted)
      throw error
    }

    try {
      const deadlineAt = currentTime() + configuredDeadlineMs
      if (!Number.isSafeInteger(deadlineAt)) fail('search deadline exceeds the safe time bound')
      const serviceLimit = Math.min(limit, maximumCachedCandidates)
      const settled = await Promise.allSettled(selectedServices.map(service => {
        const saved = savedCursors.get(service.identity) || null
        return queryService(service, selector, serviceLimit, deadlineAt, controller.signal, saved)
      }))
      if (callerAborted || signal?.aborted) throw abortError(signal?.reason)
      if (closed) fail('index federation is closed')

      const { partial, stale, respondingServices, merged, nextServiceStates } = aggregateServiceOutcomes(
        settled,
        selectedServices,
        savedCursors,
        pendingCandidates
      )

      const packaged = packageSearchResults({
        merged,
        serviceLimit,
        eligibleServices,
        nextServiceStates,
        fingerprint,
        nextOffset,
        continuationEntry,
        continuationToken,
        partial,
        stale,
        selectedServices,
        respondingServices
      })
      continuationCommitted = packaged.continuationCommitted
      return packaged.response
    } finally {
      releaseUncommittedContinuation(continuationEntry, continuationToken, continuationCommitted)
      active = false
      if (timer !== undefined) cancelScheduled(timer)
      signal?.removeEventListener('abort', onCallerAbort)
      activeControllers.delete(controller)
      drainSearchWaiters()
    }
  }

  async function close() {
    if (closed) return false
    closed = true
    for (const controller of activeControllers) controller.abort(new Error('index federation closed'))
    if (activeControllers.size > 0) {
      await new Promise(resolve => drainWaiters.add(resolve))
    }
    for (const candidateRef of [...ownedRefs.keys()]) {
      const record = cache.get(candidateRef)
      if (record?.owner === owner) cache.delete(candidateRef)
      ownedRefs.delete(candidateRef)
    }
    continuations?.clear()
    continuationRows = 0
    return true
  }

  const privateApi = Object.freeze({ resolveCandidateRecord })
  return Object.freeze({ search, resolveCandidate, close, [INDEX_FEDERATION_PRIVATE]: privateApi })
}
