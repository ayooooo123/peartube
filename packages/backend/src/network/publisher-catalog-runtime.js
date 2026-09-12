import b4a from 'b4a'
import c from 'compact-encoding'
import crypto from 'hypercore-crypto'

import { MAX_PEER_FRAME_BYTES } from './frame.js'
import { derivePublisherTopic } from './topics.js'
import { verifyPublisherNamespaceProof } from '../publisher/namespace-proof.js'
import { encodePublisherNamespaceDescriptor } from '../publisher/namespace.js'
import { decodePublisherCatalogFrame } from '../publisher/catalog-view.js'
import { decodePublisherOperationBody } from '../publisher/canonical.js'
import { createPublisherManager } from '../discovery/publisher-manager.js'
import { createAbortController } from '../abort-controller.js'
import { PUBLISHER_CATALOG_CAPABILITY } from '../publisher/namespace.js'

const MAX_CATALOG_PAGE_RECORDS = 64
const MAX_CATALOG_SESSION_PAGES = 128
const MAX_CATALOG_SESSION_RECORDS = 4096
const MAX_CATALOG_SESSION_BYTES = 4 * 1024 * 1024
const MAX_CATALOG_HEAD_DISTANCE = 4096
const MAX_CATALOG_VERIFICATION_WORK = 8192
const DEFAULT_CATALOG_BUDGET_WINDOW_MS = 60_000
const CATALOG_PAGE_TIMEOUT_MS = 10_000

function fail (message, code = 'SCOPED_NETWORK_REJECTED') {
  const error = new Error(message)
  error.code = code
  throw error
}

export function createPublisherCatalogRuntime (context) {
  const {
    options, catalogRegistry, protocolMajor, now, onCatalogUpdate,
    publisherProofProviders, publisherPageProviders, publisherSyncStateRepository,
    followedPublishers, publisherFollowReasons, publisherFollowWork, reasonFollowedPublishers,
    localPublishers, bootstrapFollowAttempts, publisherRotationDrainTimers,
    schedulePublisherRotationDrain, cancelPublisherRotationDrain, publisherRotationDrainMs,
    verifiedLocatorAuthority, bootstrapManager, bootstrapRuntime, hasBootstrapLocatorKeyPair,
    sendScopedFrame, joinScope, findScope, leaveScope, rejoinScopeDiscovery, withBatchedConnectionWrites,
    stableScopeDiagnostic, recordProtocolError, normalizeNamespace, normalizeRetentionClass,
    retentionClassAllowed, hex32, exactBuffer, isPeerConnected, getActiveConnectionCount, policy,
  } = context
  const publisherManager = options.publisherManager || createPublisherManager({
    supportedCapabilities: [PUBLISHER_CATALOG_CAPABILITY],
    ingestBatch: options.ingestPublisherBatch,
  })
  // Publisher admission barrier: one close-only cancellation signal; terminal
  // policy.status stays the live source of admission truth.
  const admissionController = createAbortController()
  const admissionSignal = admissionController.signal
  const admissionWork = new Set()

  function admissionClosedError () {
    const error = new Error('runtime is closed')
    error.code = 'SCOPED_NETWORK_CLOSED'
    return error
  }

  function assertAdmissionOpen () {
    if (policy.status === 'closed') throw admissionClosedError()
    admissionSignal.throwIfAborted()
  }

  // Once-only finish/remove-listener race (same shape as source-verifier
  // raceAbort). onHandoff fires synchronously when the work value wins so
  // lease ownership is decided before any late-arrival continuation runs.
  function raceAdmission (work, onHandoff = null) {
    if (admissionSignal.aborted) {
      // Every caller evaluates work before entering this helper, so the early
      // path must absorb the already-started promise: its late rejection would
      // otherwise float unhandled while the registry tears down around it.
      Promise.resolve(work).then(() => {}, () => {})
      return Promise.reject(admissionSignal.reason)
    }
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        admissionSignal.removeEventListener('abort', onAbort)
        if (callback === resolve && onHandoff) onHandoff(value)
        callback(value)
      }
      const onAbort = () => finish(reject, admissionSignal.reason)
      admissionSignal.addEventListener('abort', onAbort, { once: true })
      Promise.resolve(work).then(value => finish(resolve, value), error => finish(reject, error))
    })
  }

  // Race a non-cancellable external lease/page factory against close. A value
  // has ONE owner: the waiting body after a successful handoff (its existing
  // finally releases it), or this late-disposal continuation when cancellation
  // wins before handoff — released exactly once, never admitted, and never
  // closing a provided, borrowed, or registry-retained catalog.
  function raceOwned (rawPromise, release) {
    let handedOff = false
    const work = Promise.resolve(rawPromise)
    const raced = raceAdmission(work, () => { handedOff = true })
    work.then(
      value => {
        if (handedOff) return
        void Promise.resolve().then(() => release(value)).catch(() => {})
      },
      () => {}
    )
    return raced
  }

  // Registers a nonrejecting completion entry BEFORE invoking the factory, so
  // a synchronous reentrant close observes the admission; the original result
  // promise still settles to its caller and closeAdmissions drains the entry.
  function trackAdmission (start) {
    let settle
    const tracked = new Promise(resolve => { settle = resolve })
    tracked.then(() => { admissionWork.delete(tracked) })
    admissionWork.add(tracked)
    let result
    try {
      result = start()
    } catch (error) {
      settle()
      throw error
    }
    Promise.resolve(result).then(() => settle(), () => settle())
    return result
  }

  // Aborts synchronously; closeRuntime awaits the returned drain promise
  // before any map clear or scope snapshot.
  function closeAdmissions () {
    if (!admissionSignal.aborted) admissionController.abort(admissionClosedError())
    return (async () => {
      while (admissionWork.size > 0) {
        await Promise.allSettled([...admissionWork])
      }
    })()
  }

  const catalogAdmissionLimits = Object.freeze({
    pages: Math.min(MAX_CATALOG_SESSION_PAGES, Number(options.catalogAdmissionLimits?.pages ?? MAX_CATALOG_SESSION_PAGES)),
    records: Math.min(MAX_CATALOG_SESSION_RECORDS, Number(options.catalogAdmissionLimits?.records ?? MAX_CATALOG_SESSION_RECORDS)),
    bytes: Math.min(MAX_CATALOG_SESSION_BYTES, Number(options.catalogAdmissionLimits?.bytes ?? MAX_CATALOG_SESSION_BYTES)),
    work: Math.min(MAX_CATALOG_VERIFICATION_WORK, Number(options.catalogAdmissionLimits?.work ?? MAX_CATALOG_VERIFICATION_WORK)),
    headDistance: Math.min(MAX_CATALOG_HEAD_DISTANCE, Number(options.catalogAdmissionLimits?.headDistance ?? MAX_CATALOG_HEAD_DISTANCE)),
  })
  const catalogBudgetWindowMs = Number(options.catalogAdmissionLimits?.windowMs ?? DEFAULT_CATALOG_BUDGET_WINDOW_MS)
  if (Object.values(catalogAdmissionLimits).some(limit => !Number.isSafeInteger(limit) || limit < 1) ||
      !Number.isSafeInteger(catalogBudgetWindowMs) || catalogBudgetWindowMs < 1) fail('catalog admission limits are invalid')

  function freshCatalogBudget(current = Number(now())) {
    return { windowStartedAt: current, pages: 0, records: 0, bytes: 0, work: 0, peers: {} }
  }

  function restoreCatalogBudget(value) {
    const current = Number(now())
    if (!value || !Number.isSafeInteger(value.windowStartedAt) ||
        current < value.windowStartedAt || current - value.windowStartedAt >= catalogBudgetWindowMs) {
      return freshCatalogBudget(current)
    }
    const budget = freshCatalogBudget(value.windowStartedAt)
    for (const field of ['pages', 'records', 'bytes', 'work']) {
      const amount = Number(value[field])
      budget[field] = Number.isSafeInteger(amount) && amount >= 0 ? amount : 0
    }
    if (value.peers && typeof value.peers === 'object' && !Array.isArray(value.peers)) {
      for (const [peerId, peer] of Object.entries(value.peers).slice(0, 128)) {
        if (!/^[0-9a-f]{64}$/.test(peerId) || !peer || typeof peer !== 'object') continue
        budget.peers[peerId] = {}
        for (const field of ['pages', 'records', 'bytes', 'work']) {
          const amount = Number(peer[field])
          budget.peers[peerId][field] = Number.isSafeInteger(amount) && amount >= 0 ? amount : 0
        }
      }
    }
    return budget
  }

  function addCatalogBudget(value, peerId, additions) {
    const budget = restoreCatalogBudget(value)
    const peer = { pages: 0, records: 0, bytes: 0, work: 0, ...(budget.peers[peerId] || {}) }
    for (const field of ['pages', 'records', 'bytes', 'work']) {
      budget[field] += additions[field]
      peer[field] += additions[field]
      if (budget[field] > catalogAdmissionLimits[field] || peer[field] > catalogAdmissionLimits[field]) {
        fail('catalog consumer cumulative window budget exceeded', 'PUBLISHER_CATALOG_WINDOW_BUDGET_EXCEEDED')
      }
    }
    budget.peers[peerId] = peer
    return budget
  }

  let catalogGlobalBudget = freshCatalogBudget()
  const catalogGlobalBudgetReady = (async () => {
    catalogGlobalBudget = restoreCatalogBudget(
      await publisherSyncStateRepository?.loadGlobal?.()
    )
  })()

  async function reserveCatalogBudget(scope, peerId, additions) {
    await catalogGlobalBudgetReady
    const publisherBudget = addCatalogBudget(scope.catalogBudget, peerId, additions)
    const globalBudget = addCatalogBudget(catalogGlobalBudget, peerId, additions)
    // Charge invalid verification work before reduction so retries are never free.
    scope.catalogBudget = publisherBudget
    catalogGlobalBudget = globalBudget
    await Promise.all([
      persistPublisherSyncState(scope),
      publisherSyncStateRepository?.saveGlobal?.(catalogGlobalBudget),
    ])
  }

  async function persistPublisherSyncState(scope) {
    if (!publisherSyncStateRepository?.save) return
    await publisherSyncStateRepository.save(scope.publisherId, {
      version: 2,
      publisherId: scope.publisherId,
      catalogEpoch: scope.descriptor.catalogEpoch,
      cursor: scope.catalogResumeCursor,
      headDigest: scope.catalogHeadDigest,
      authorizationStateDigest: scope.catalogAuthorizationStateDigest,
      complete: scope.catalogComplete === true,
      budget: scope.catalogBudget,
    })
  }
  function encodeNamespaceProof(proof) {
    const payload = c.encode(c.any, proof)
    if (payload.byteLength > MAX_PEER_FRAME_BYTES - 1024) fail('namespace proof exceeds frame bound')
    return payload
  }

  function decodeNamespaceProof(payload) {
    const proof = c.decode(c.any, payload)
    if (!b4a.equals(c.encode(c.any, proof), payload)) fail('namespace proof response is noncanonical')
    if (!proof || typeof proof !== 'object' || !proof.genesis || !Array.isArray(proof.transitions)) {
      fail('namespace proof response is invalid')
    }
    return proof
  }

  function canonicalCatalogPayload(value, name) {
    const payload = c.encode(c.any, value)
    if (payload.byteLength > MAX_PEER_FRAME_BYTES - 1024) fail(`${name} exceeds frame bound`)
    return payload
  }

  function decodeCanonicalCatalogPayload(payload, name) {
    if (!b4a.isBuffer(payload) || payload.byteLength > MAX_PEER_FRAME_BYTES - 1024) fail(`${name} exceeds frame bound`)
    const value = c.decode(c.any, payload)
    if (!value || typeof value !== 'object' || !b4a.equals(c.encode(c.any, value), payload)) fail(`${name} is noncanonical`)
    return value
  }

  function pageDigest(value) {
    return crypto.hash(canonicalCatalogPayload(value, 'catalog page'))
  }

  function normalizeCatalogCursor(value, name = 'catalog cursor') {
    if (value === null) return null
    const text = String(value || '').toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(text)) fail(`${name} is invalid`)
    return text
  }

  function normalizeCatalogRequest(payload) {
    const value = decodeCanonicalCatalogPayload(payload, 'catalog page request')
    if (value.version !== 2) fail('catalog page request version is unsupported', 'PUBLISHER_CATALOG_SYNC_V2_REQUIRED')
    const cursor = normalizeCatalogCursor(value.cursor)
    const previousPageDigest = value.previousPageDigest == null
      ? null
      : hex32(value.previousPageDigest, 'previousPageDigest')
    const expectedHeadDigest = value.expectedHeadDigest == null
      ? null
      : hex32(value.expectedHeadDigest, 'expectedHeadDigest')
    const catalogEpoch = Number(value.catalogEpoch)
    const limit = Number(value.limit)
    if (!Number.isSafeInteger(catalogEpoch) || catalogEpoch < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CATALOG_PAGE_RECORDS) {
      fail('catalog page request bounds are invalid')
    }
    return { version: 2, cursor, previousPageDigest, expectedHeadDigest, catalogEpoch, limit }
  }

  function normalizeCatalogResponse(payload, request) {
    const value = decodeCanonicalCatalogPayload(payload, 'catalog page response')
    if (value.version !== 2 || value.catalogEpoch !== request.catalogEpoch ||
        normalizeCatalogCursor(value.requestedCursor, 'requestedCursor') !== request.cursor ||
        (value.previousPageDigest == null ? null : hex32(value.previousPageDigest, 'previousPageDigest')) !== request.previousPageDigest ||
        (value.expectedHeadDigest == null ? null : hex32(value.expectedHeadDigest, 'expectedHeadDigest')) !== request.expectedHeadDigest) {
      fail('catalog page response does not match its request')
    }
    const nextCursor = normalizeCatalogCursor(value.nextCursor)
    const headDigest = hex32(value.headDigest, 'headDigest')
    const authorizationStateDigest = hex32(value.authorizationStateDigest, 'authorizationStateDigest')
    const pageDigestHex = hex32(value.pageDigest, 'pageDigest')
    const headLength = Number(value.headLength)
    // This is physical Hyperbee history, not the number of operations to ingest.
    if (!Number.isSafeInteger(headLength) || headLength < 0) fail('catalog head length is invalid')
    if (!Array.isArray(value.entries) || value.entries.length > request.limit) fail('catalog page record bound exceeded')
    let prior = request.cursor
    const seen = new Set()
    const entries = value.entries.map(entry => {
      const operationId = normalizeCatalogCursor(entry?.operationId, 'operationId')
      const sourceWriterKey = exactBuffer(entry?.sourceWriterKey, 32, 'sourceWriterKey')
      const frame = b4a.from(entry?.frame || [])
      const operation = decodePublisherCatalogFrame(frame)
      const derivedId = b4a.toString(operation.recordId || operation.transitionId, 'hex')
      if (derivedId !== operationId || operationId === prior || seen.has(operationId)) fail('catalog page ordering or provenance is invalid')
      seen.add(operationId)
      prior = operationId
      return { operationId, sourceWriterKey, frame }
    })
    if (entries.length === 0 && nextCursor !== null) fail('empty catalog page cannot advance')
    if (nextCursor !== null && nextCursor !== entries.at(-1)?.operationId) fail('catalog page cursor linkage is invalid')
    const unsigned = {
      version: 2,
      requestedCursor: request.cursor,
      nextCursor,
      previousPageDigest: request.previousPageDigest,
      expectedHeadDigest: request.expectedHeadDigest,
      catalogEpoch: request.catalogEpoch,
      headLength,
      headDigest,
      authorizationStateDigest,
      entries,
    }
    if (b4a.toString(pageDigest(unsigned), 'hex') !== pageDigestHex) fail('catalog page digest mismatch')
    return { ...unsigned, pageDigest: pageDigestHex }
  }

  async function acquireServeCatalog (provider, publisherId) {
    if (provider.catalog) return { catalog: provider.catalog, lease: null }
    if (typeof catalogRegistry?.acquireWritableBinding !== 'function') {
      fail('catalog page provider is unavailable')
    }
    let lease = null
    try {
      lease = await raceOwned(
        catalogRegistry.acquireWritableBinding(b4a.from(publisherId, 'hex'), { signal: admissionSignal }),
        value => value?.release?.(),
      )
      const catalog = lease?.binding?.catalog || null
      if (!catalog) fail('catalog page provider is unavailable')
      return { catalog, lease }
    } catch (error) {
      // The lease was handed off to this frame but the handoff failed: release
      // it here exactly once; the caller's finally sees lease=null.
      const owned = lease
      lease = null
      await owned?.release?.()
      throw error
    }
  }

  function createPageResponseEncoder(request, provider, head, headDigest) {
    const FRAME_BOUND_BYTES = MAX_PEER_FRAME_BYTES - 1024
    return function encodePageFits(list, nextCursor) {
      const unsigned = {
        version: 2,
        requestedCursor: request.cursor,
        nextCursor,
        previousPageDigest: request.previousPageDigest,
        expectedHeadDigest: request.expectedHeadDigest,
        catalogEpoch: provider.catalogEpoch,
        headLength: Number(head?.length),
        headDigest,
        authorizationStateDigest: hex32(head?.authorizationStateDigest, 'authorizationStateDigest'),
        entries: list,
      }
      const pageDigestHex = b4a.toString(crypto.hash(c.encode(c.any, unsigned)), 'hex')
      const payload = c.encode(c.any, { ...unsigned, pageDigest: pageDigestHex })
      if (payload.byteLength > FRAME_BOUND_BYTES) return null
      return { response: { ...unsigned, pageDigest: pageDigestHex }, payload }
    }
  }

  function normalizePageEntries(rawEntries) {
    return rawEntries.map(entry => ({
      operationId: normalizeCatalogCursor(entry?.operationId, 'operationId'),
      sourceWriterKey: exactBuffer(entry?.sourceWriterKey, 32, 'sourceWriterKey'),
      frame: b4a.from(entry?.frame || []),
    }))
  }

  async function fitCatalogPage(listPage, request, encodePageFits, initialPage) {
    let entries = normalizePageEntries(initialPage.entries)
    let built = encodePageFits(entries, initialPage.nextCursor)
    let low = 1
    let high = entries.length
    let trimmed = null
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const candidate = await raceAdmission(listPage({ cursor: request.cursor, limit: mid }))
      if (!candidate || !Array.isArray(candidate.entries) || candidate.entries.length > mid) {
        fail('catalog provider returned an invalid page')
      }
      const candidateEntries = normalizePageEntries(candidate.entries)
      const candidateBuilt = encodePageFits(candidateEntries, candidate.nextCursor)
      if (candidateBuilt !== null) {
        built = candidateBuilt
        trimmed = candidate
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    if (built === null) fail('catalog page exceeds frame bound')
    const trimmedCursor = trimmed === null
      ? initialPage.nextCursor
      : normalizeCatalogCursor(trimmed.nextCursor)
    return { built, trimmedCursor }
  }

  function assertServeSessionBudget(tracked, recordsCount, byteLength) {
    const nextPages = tracked.catalogServePages + 1
    const nextRecords = tracked.catalogServeRecords + recordsCount
    const nextBytes = tracked.catalogServeBytes + byteLength
    if (nextPages > MAX_CATALOG_SESSION_PAGES || nextRecords > MAX_CATALOG_SESSION_RECORDS ||
        nextBytes > MAX_CATALOG_SESSION_BYTES || nextRecords * 2 > MAX_CATALOG_VERIFICATION_WORK) {
      fail('catalog provider cumulative session budget exceeded')
    }
    return { nextPages, nextRecords, nextBytes }
  }

  async function serveCatalogPage(scope, tracked, frame) {
    if (!tracked?.namespaceProofServed) fail('namespace proof is mandatory before catalog pages')
    const provider = publisherPageProviders.get(scope.publisherId)
    if (!provider) fail('catalog page provider is unavailable')
    const request = normalizeCatalogRequest(frame.payload)
    if (request.catalogEpoch !== provider.catalogEpoch) fail('catalog page epoch mismatch')
    if (request.previousPageDigest === null) tracked.catalogServeDigest = null
    else if (request.previousPageDigest !== tracked.catalogServeDigest) fail('catalog page linkage mismatch')

    let lease = null
    try {
      const acquired = await acquireServeCatalog(provider, scope.publisherId)
      lease = acquired.lease
      const catalog = acquired.catalog
      const head = await raceAdmission(catalog.getViewHead())
      assertAdmissionOpen()
      const headDigest = hex32(head?.digest, 'headDigest')
      const encodePageFits = createPageResponseEncoder(request, provider, head, headDigest)

      const listPage = (catalog.listCausalPage || catalog.listAcceptedPage)?.bind(catalog)
      if (!listPage) fail('catalog causal sync is unsupported', 'PUBLISHER_CATALOG_SYNC_V2_REQUIRED')
      const page = await raceAdmission(listPage({ cursor: request.cursor, limit: request.limit }))
      assertAdmissionOpen()
      if (!page || !Array.isArray(page.entries) || page.entries.length > request.limit) {
        fail('catalog provider returned an invalid page')
      }

      const { built, trimmedCursor } = await raceAdmission(fitCatalogPage(listPage, request, encodePageFits, page))
      assertAdmissionOpen()
      const entriesServed = built.response.entries
      const payload = built.payload
      const response = built.response

      const { nextPages, nextRecords, nextBytes } = assertServeSessionBudget(tracked, entriesServed.length, payload.byteLength)
      if (!sendScopedFrame(tracked, 'publisher', 'catalog-page-response', payload)) {
        fail('catalog page response send failed')
      }
      tracked.catalogServePages = nextPages
      tracked.catalogServeRecords = nextRecords
      tracked.catalogServeBytes = nextBytes
      tracked.catalogServeDigest = response.pageDigest
      return { status: 'sent', records: entriesServed.length, nextCursor: trimmedCursor }
    } finally {
      await lease?.release?.()
    }
  }

  function assertCatalogHeadConsistency(scope, response) {
    if (scope.catalogHeadDigest && scope.catalogHeadDigest !== response.headDigest) {
      if (scope.advertisedCatalogHead && scope.advertisedCatalogHead === response.headDigest) {
        scope.catalogHeadDigest = scope.advertisedCatalogHead
        scope.catalogAuthorizationStateDigest = null
        scope.catalogCursor = scope.catalogResumeCursor
        scope.catalogPreviousPageDigest = null
        scope.catalogComplete = false
      } else {
        fail('catalog head equivocation detected')
      }
    }
    if (scope.advertisedCatalogHead && scope.advertisedCatalogHead !== response.headDigest) {
      fail('catalog response does not match the signed advertised head', 'PUBLISHER_CATALOG_ADVERTISED_HEAD_MISMATCH')
    }
  }

  function assertAcceptSessionBudget(tracked, response, payloadLength) {
    const nextPages = tracked.catalogAcceptPages + 1
    const nextRecords = tracked.catalogAcceptRecords + response.entries.length
    const nextBytes = tracked.catalogAcceptBytes + payloadLength
    const nextWork = tracked.catalogAcceptVerificationWork + response.entries.length * 2
    const initialHeadLength = tracked.catalogAcceptInitialHeadLength ?? response.headLength
    if (nextPages > MAX_CATALOG_SESSION_PAGES || nextRecords > MAX_CATALOG_SESSION_RECORDS ||
        nextBytes > MAX_CATALOG_SESSION_BYTES || nextWork > MAX_CATALOG_VERIFICATION_WORK ||
        response.headLength < initialHeadLength ||
        response.headLength - initialHeadLength > catalogAdmissionLimits.headDistance) {
      fail('catalog consumer cumulative session budget exceeded')
    }
    return { nextPages, nextRecords, nextBytes, nextWork, initialHeadLength }
  }

  async function ingestAcceptedCatalogPage(scope, response) {
    if (response.entries.length > 0) {
      const ingestResult = await scope.binding.catalog.ingestAcceptedPage(response.entries, {
        deferRebuild: response.nextCursor !== null,
      })
      if (Number(ingestResult?.rejected || 0) !== 0 || Number(ingestResult?.accepted || 0) !== response.entries.length) {
        fail('catalog page contained an inadmissible operation', 'PUBLISHER_CATALOG_PAGE_INGEST_REJECTED')
      }
    } else if (response.nextCursor === null) {
      await scope.binding.catalog.finalizeAcceptedPages?.()
    }
  }

  async function acceptCatalogPage(scope, tracked, frame) {
    const pending = scope.catalogPagePending
    if (!pending) fail('unexpected catalog page response')
    try {
      const response = normalizeCatalogResponse(frame.payload, pending.request)
      assertCatalogHeadConsistency(scope, response)
      const { nextPages, nextRecords, nextBytes, nextWork, initialHeadLength } = assertAcceptSessionBudget(tracked, response, frame.payload.byteLength)

      const additions = {
        pages: 1,
        records: response.entries.length,
        bytes: frame.payload.byteLength,
        work: response.entries.length * 2,
      }
      scope.catalogComplete = false
      await reserveCatalogBudget(scope, tracked.peerId, additions)

      await ingestAcceptedCatalogPage(scope, response)

      tracked.catalogAcceptPages = nextPages
      tracked.catalogAcceptRecords = nextRecords
      tracked.catalogAcceptBytes = nextBytes
      tracked.catalogAcceptVerificationWork = nextWork
      tracked.catalogAcceptInitialHeadLength = initialHeadLength
      scope.catalogVerifiedPages++
      scope.catalogVerifiedRecords += response.entries.length
      scope.catalogVerifiedBytes += frame.payload.byteLength
      scope.catalogVerificationWork += response.entries.length * 2
      scope.catalogHeadDigest ||= response.headDigest
      scope.catalogAuthorizationStateDigest ||= response.authorizationStateDigest
      scope.catalogCursor = response.nextCursor
      scope.catalogResumeCursor = response.entries.at(-1)?.operationId || scope.catalogResumeCursor
      scope.catalogPreviousPageDigest = response.pageDigest
      await persistPublisherSyncState(scope)
      clearTimeout(pending.timer)
      scope.catalogPagePending = null
      pending.resolve(response)
      return { status: 'accepted', records: response.entries.length }
    } catch (error) {
      clearTimeout(pending.timer)
      scope.catalogPagePending = null
      pending.reject(error)
      throw error
    }
  }

  async function handlePublisherProofFrame(scope, tracked, frame) {
    if (scope.retired) return { status: 'rejected', reason: 'publisher-epoch-retired' }
    if (frame.type === 'namespace-proof-request') {
      const proof = publisherProofProviders.get(scope.publisherId)
      if (!proof) return { status: 'rejected', reason: 'namespace-proof-unavailable' }
      if (!sendScopedFrame(tracked, 'publisher', 'namespace-proof-response', encodeNamespaceProof(proof))) {
        return { status: 'rejected', reason: 'namespace-proof-send-failed' }
      }
      tracked.namespaceProofServed = true
      return { status: 'sent' }
    }
    if (frame.type === 'namespace-proof-response') {
      const pending = scope.proofPending
      if (!pending) return { status: 'rejected', reason: 'unexpected-namespace-proof' }
      clearTimeout(pending.timer)
      scope.proofPending = null
      pending.resolve(decodeNamespaceProof(frame.payload))
      return { status: 'accepted' }
    }
    if (frame.type === 'catalog-page-request') {
      return trackAdmission(() => serveCatalogPage(scope, tracked, frame))
    }
    if (frame.type === 'catalog-page-response') return acceptCatalogPage(scope, tracked, frame)
    return { status: 'rejected', reason: 'publisher-frame-type-not-allowed' }
  }

  async function awaitActiveScopedSession (scope, timeoutMs = 1_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const active = [...scope.sessions.values()].find(session => !session.closed && session.state === 'active')
      if (active) return active
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return null
  }

  async function requestNamespaceProof(scope) {
    if (scope.proofPending?.promise) return scope.proofPending.promise
    const tracked = await awaitActiveScopedSession(scope)
    if (!tracked) return Promise.reject(Object.assign(new Error('publisher proof peer unavailable'), { code: 'PUBLISHER_PROOF_PEER_UNAVAILABLE' }))
    let resolve, reject
    const promise = new Promise((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject })
    const timer = setTimeout(() => {
      if (scope.proofPending?.promise === promise) scope.proofPending = null
      reject(Object.assign(new Error('publisher proof timed out'), { code: 'PUBLISHER_PROOF_TIMEOUT' }))
    }, 10_000)
    timer.unref?.()
    scope.proofPending = { promise, resolve, reject, timer }
    if (!sendScopedFrame(tracked, 'publisher', 'namespace-proof-request', b4a.alloc(0))) {
      clearTimeout(timer)
      scope.proofPending = null
      reject(Object.assign(new Error('publisher proof request failed'), { code: 'PUBLISHER_PROOF_REQUEST_FAILED' }))
    }
    return promise
  }

  async function ensurePublisherNamespaceProof(scope) {
    const active = await awaitActiveScopedSession(scope)
    if (!active) fail('publisher proof peer unavailable', 'PUBLISHER_PROOF_PEER_UNAVAILABLE')
    if (scope.namespaceProofVerified && active.namespaceProofReceived) return scope.namespaceProofVerified
    const proof = await requestNamespaceProof(scope)
    assertAdmissionOpen()
    const descriptor = scope.descriptor
    const verified = verifyPublisherNamespaceProof({
      locator: {
        publisherId: scope.publisherId,
        catalogBootstrapKey: b4a.toString(descriptor.catalogBootstrapKey, 'hex'),
        catalogEpoch: descriptor.catalogEpoch,
      },
      ...proof,
    })
    if (!b4a.equals(encodePublisherNamespaceDescriptor(verified.descriptor), encodePublisherNamespaceDescriptor(descriptor))) {
      fail('namespace proof does not match followed descriptor')
    }
    scope.namespaceProofVerified = verified
    active.namespaceProofReceived = true
    return verified
  }

  async function requestCatalogPage(scope, request) {
    if (scope.catalogPagePending) return scope.catalogPagePending.promise
    const tracked = await awaitActiveScopedSession(scope)
    if (!tracked) fail('publisher catalog peer unavailable', 'PUBLISHER_CATALOG_PEER_UNAVAILABLE')
    let resolve, reject
    const promise = new Promise((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject })
    const timer = setTimeout(() => {
      if (scope.catalogPagePending?.promise === promise) scope.catalogPagePending = null
      reject(Object.assign(new Error('publisher catalog page timed out'), { code: 'PUBLISHER_CATALOG_PAGE_TIMEOUT' }))
    }, CATALOG_PAGE_TIMEOUT_MS)
    timer.unref?.()
    scope.catalogPagePending = { promise, resolve, reject, timer, request }
    if (!sendScopedFrame(tracked, 'publisher', 'catalog-page-request', canonicalCatalogPayload(request, 'catalog page request'))) {
      clearTimeout(timer)
      scope.catalogPagePending = null
      reject(Object.assign(new Error('publisher catalog page request failed'), { code: 'PUBLISHER_CATALOG_PAGE_REQUEST_FAILED' }))
    }
    return promise
  }

  async function assertAdvertisedLocatorSigner(catalog, scope) {
    if (!scope.advertisedLocatorSignerId) return
    const authorization = await catalog.getAuthorizationState()
    const writer = authorization?.writers?.find(candidate =>
      candidate?.signerKey === scope.advertisedLocatorSignerId
    )
    if (!writer || writer.revocation ||
        writer.firstAcceptedSequence > writer.lastAcceptedSequence ||
        writer.expiresAt < scope.advertisedLocatorIssuedAt ||
        !writer.capabilities?.includes('announce')) {
      fail('signed locator is not authorized by the reconstructed catalog', 'PUBLISHER_CATALOG_LOCATOR_SIGNER_UNAUTHORIZED')
    }
  }

  function registerCompletedMirror(scope, catalog) {
    if (!scope.namespaceProofVerified || typeof catalog.listAcceptedPage !== 'function') return
    const existingPageProvider = publisherPageProviders.get(scope.publisherId)
    if (!existingPageProvider || existingPageProvider.catalogEpoch <= scope.descriptor.catalogEpoch) {
      publisherProofProviders.set(scope.publisherId, {
        genesis: scope.namespaceProofVerified.genesis,
        transitions: scope.namespaceProofVerified.transitions,
      })
      publisherPageProviders.set(scope.publisherId, {
        catalog,
        catalogEpoch: scope.descriptor.catalogEpoch,
      })
    }
  }

  async function verifyCatalogCompletion(scope) {
    const catalog = scope.binding?.catalog
    if (typeof catalog?.getViewHead !== 'function') {
      fail('verified catalog head is unavailable', 'PUBLISHER_CATALOG_HEAD_UNAVAILABLE')
    }
    const head = await catalog.getViewHead()
    assertAdmissionOpen()
    const localDigest = hex32(head?.digest, 'local catalog head digest')
    const localAuthorizationDigest = hex32(
      head?.authorizationStateDigest,
      'local authorization state digest',
    )
    if (localDigest !== scope.catalogHeadDigest ||
        localAuthorizationDigest !== scope.catalogAuthorizationStateDigest) {
      fail('terminal catalog page did not reconstruct its claimed head', 'PUBLISHER_CATALOG_TRUNCATED')
    }
    if (scope.advertisedCatalogHead && localDigest !== scope.advertisedCatalogHead) {
      fail('terminal catalog page did not reconstruct the signed advertised head', 'PUBLISHER_CATALOG_ADVERTISED_HEAD_MISMATCH')
    }
    await assertAdvertisedLocatorSigner(catalog, scope)
    assertAdmissionOpen()
    scope.catalogComplete = true
    registerCompletedMirror(scope, catalog)
    await persistPublisherSyncState(scope)
    return head
  }

  async function syncPublisherCatalog(scope) {
    if (!scope || scope.closed || !scope.modes.has('followed')) return { status: 'not-followed' }
    if (policy.status === 'closed') return { status: 'not-followed' }
    if (scope.catalogSyncing) return scope.catalogSyncing
    scope.catalogSyncing = trackAdmission(() =>
      (async () => {
        await raceAdmission(ensurePublisherNamespaceProof(scope))
        assertAdmissionOpen()
        let cursor = scope.catalogResumeCursor ?? null
        if (cursor === null) {
          scope.catalogHeadDigest = scope.advertisedCatalogHead || null
          scope.catalogAuthorizationStateDigest = null
        }
        let previousPageDigest = null
        let pages = 0
        do {
          const response = await raceAdmission(requestCatalogPage(scope, {
            version: 2,
            cursor,
            previousPageDigest,
            expectedHeadDigest: scope.advertisedCatalogHead || (cursor === null ? null : scope.catalogHeadDigest),
            catalogEpoch: scope.descriptor.catalogEpoch,
            limit: MAX_CATALOG_PAGE_RECORDS,
          }))
          assertAdmissionOpen()
          pages++
          cursor = response.nextCursor
          previousPageDigest = response.pageDigest
        } while (cursor !== null)
        await raceAdmission(verifyCatalogCompletion(scope))
        assertAdmissionOpen()
        await raceAdmission(Promise.resolve(onCatalogUpdate?.({ publisherId: scope.publisherId })))
        assertAdmissionOpen()
        return { status: 'synced', pages, records: scope.catalogVerifiedRecords, cursor: scope.catalogResumeCursor }
      })().finally(() => { scope.catalogSyncing = null })
    )
    return scope.catalogSyncing
  }


  async function hasCatalogProjections(catalog) {
    if (!catalog || typeof catalog.listProjections !== 'function' || catalog.writable !== true) {
      return false
    }
    const [publications, claims] = await Promise.all([
      catalog.listProjections('publication', { limit: 1 }),
      catalog.listProjections('claim', { limit: 1 }),
    ])
    const publicationCount = publications?.items?.length || 0
    const claimCount = claims?.items?.length || 0
    return publicationCount > 0 || claimCount > 0
  }

  async function processBindingPage(page, candidateIds) {
    const pageErrors = page?.errors || []
    if (Array.isArray(pageErrors) && pageErrors.length > 0) {
      const first = pageErrors[0]
      fail(first?.error || 'writable catalog restore discovery incomplete', first?.error || 'PUBLISHER_WRITABLE_DISCOVERY_INCOMPLETE')
    }
    for (const binding of page?.items || []) {
      const publisherId = hex32(binding?.publisherId, 'publisherId')
      if (candidateIds.includes(publisherId)) continue
      if (!(await raceAdmission(hasCatalogProjections(binding?.catalog)))) continue
      assertAdmissionOpen()
      candidateIds.push(publisherId)
      await publishLocalPublisherCatalog({ publisherId, binding })
    }
  }

  function restoreLocalPublisherScopes () {
    return trackAdmission(restoreLocalPublisherScopesAdmission)
  }

  async function restoreLocalPublisherScopesAdmission () {
    if (!policy.contributionAllowed) return
    if (typeof catalogRegistry?.listBindingPage !== 'function') return

    // Page every persisted writable under transient leases. Consume each page fully
    // (projection check + advertise) before release. Runtime keeps publisher IDs only;
    // catalogs are not retained from closed page handles.
    const candidateIds = []
    let cursor = null
    do {
      const page = await raceOwned(
        catalogRegistry.listBindingPage({
          cursor,
          limit: 16,
          writableOnly: true,
          signal: admissionSignal,
        }),
        value => value?.release?.(),
      )
      try {
        // The handed-off page is owned from here on: the guard lives inside the
        // try so a same-turn close after handoff still releases through the
        // finally instead of skipping it.
        assertAdmissionOpen()
        await processBindingPage(page, candidateIds)
      } finally {
        await page?.release?.()
      }
      cursor = page?.nextCursor || null
    } while (cursor)
  }
  function normalizeFollowReason(reason) {
    const value = String(reason || '')
    if (value.length < 1 || value.length > 256 || !/^[a-z0-9][a-z0-9:_-]*$/.test(value)) {
      fail('invalid publisher follow reason')
    }
    return value
  }

  function evaluateExistingPublisherFollow(publisherId, existing, locator, locatorTopic, skip) {
    const currentEpoch = Number(existing.scope.descriptor.catalogEpoch)
    if (locator.catalogEpoch < currentEpoch || locator.catalogEpoch > currentEpoch + 1) {
      skip('locator epoch out of range')
      return false
    }
    const identical = locator.catalogEpoch === currentEpoch &&
      b4a.equals(existing.scope.topic, locatorTopic) &&
      locator.catalogBootstrapKey === b4a.toString(existing.scope.descriptor.catalogBootstrapKey, 'hex') &&
      locator.catalogHead === existing.scope.advertisedCatalogHead &&
      locator.authorizationChainDigest === existing.scope.advertisedAuthorizationStateDigest
    if (!identical) return true

    const live = [...existing.scope.sessions.values()]
      .some(session => !session.closed && session.state === 'active')
    existing.scope.idleLocatorTicks = live ? 0 : (existing.scope.idleLocatorTicks || 0) + 1
    if (existing.scope.catalogComplete !== true && live) {
      void syncPublisherCatalog(existing.scope).catch(error => {
        recordProtocolError(existing.scope, 'locator-retry', error)
      })
      skip('locator unchanged; retrying an unfinished catalog walk')
      return false
    }
    const stalled = !live && existing.scope.idleLocatorTicks >= 2 && getActiveConnectionCount() > 0
    if (!stalled) {
      skip(live ? 'locator identical to current scope' : 'locator identical; no live session yet')
      return false
    }
    bootstrapFollowAttempts.delete(publisherId)
    return true
  }

  function scheduleReasonedPublisherFollow(publisherId) {
    // Every return below silently decides a discovered publisher will never be
    // followed, which surfaces only as a permanently empty catalog.
    const skip = (why) => console.log('[ScopedNetwork] follow not scheduled:', publisherId.slice(0, 16), why)
    if (policy.status !== 'active') return skip(`status=${policy.status}`)
    if (publisherFollowWork.has(publisherId)) return skip('follow already in flight')
    const locator = bootstrapManager.getLocator?.(publisherId)
    if (!publisherFollowReasons.get(publisherId)?.size) return skip('no follow reasons')
    if (!locator) return skip('no locator retained')
    const existing = followedPublishers.get(publisherId)
    const locatorTopic = derivePublisherTopic({ publisherId, catalogEpoch: locator.catalogEpoch })
    if (existing && !evaluateExistingPublisherFollow(publisherId, existing, locator, locatorTopic, skip)) {
      return
    }
    const fingerprint = [
      locator.catalogEpoch,
      b4a.toString(locatorTopic, 'hex'),
      locator.catalogBootstrapKey,
      locator.catalogHead,
      locator.authorizationChainDigest,
    ].join(':')
    const prior = bootstrapFollowAttempts.get(publisherId)
    const attempts = prior?.fingerprint === fingerprint ? prior.attempts : 0
    if (attempts >= 4) return skip(`attempt cap reached (${attempts})`)
    bootstrapFollowAttempts.set(publisherId, { fingerprint, attempts: attempts + 1 })
    const work = trackAdmission(() =>
      followBootstrapLocator({ publisherId })
        .then(async result => {
          assertAdmissionOpen()
          if (!publisherFollowReasons.get(publisherId)?.size) {
            await unfollowPublisher({ publisherId })
            return null
          }
          reasonFollowedPublishers.add(publisherId)
          return result
        })
        .finally(() => publisherFollowWork.delete(publisherId))
    )
    publisherFollowWork.set(publisherId, work)
    // Following is how a discovered publisher becomes a visible catalog. When
    // it fails there is otherwise no trace anywhere: the peer stays connected,
    // the locator stays accepted, and every catalog surface stays empty.
    void work.then(
      result => console.log('[ScopedNetwork] publisher follow ok:', publisherId.slice(0, 16), result?.status || 'followed'),
      error => console.log('[ScopedNetwork] publisher follow FAILED:', publisherId.slice(0, 16), error?.code || error?.message || error)
    )
  }

  async function addPublisherFollowReason({ publisherId, reason } = {}) {
    if (policy.status === 'closed') throw admissionClosedError()
    const id = hex32(publisherId, 'publisherId')
    const normalizedReason = normalizeFollowReason(reason)
    let reasons = publisherFollowReasons.get(id)
    if (!reasons) {
      if (publisherFollowReasons.size >= 4096) fail('publisher follow reason limit exceeded')
      reasons = new Set()
      publisherFollowReasons.set(id, reasons)
    }
    if (reasons.size >= 64 && !reasons.has(normalizedReason)) fail('publisher follow reason limit exceeded')
    reasons.add(normalizedReason)
    scheduleReasonedPublisherFollow(id)
    return { status: 'scheduled', publisherId: id, reasons: [...reasons].sort() }
  }

  async function removePublisherFollowReason({ publisherId, reason } = {}) {
    const id = hex32(publisherId, 'publisherId')
    const normalizedReason = normalizeFollowReason(reason)
    const reasons = publisherFollowReasons.get(id)
    reasons?.delete(normalizedReason)
    if (reasons?.size === 0) publisherFollowReasons.delete(id)
    if (!publisherFollowReasons.has(id) && reasonFollowedPublishers.has(id) && !publisherFollowWork.has(id)) {
      reasonFollowedPublishers.delete(id)
      await unfollowPublisher({ publisherId: id })
    }
    return { status: 'removed', publisherId: id, reasons: [...(publisherFollowReasons.get(id) || [])].sort() }
  }

  function getPublisherFollowReasons({ publisherId } = {}) {
    const id = hex32(publisherId, 'publisherId')
    return [...(publisherFollowReasons.get(id) || [])].sort()
  }
  function handleExistingFollow(existing, descriptor, authoritativeLocator, id) {
    if (descriptor.catalogEpoch > existing.scope.descriptor.catalogEpoch) {
      followedPublishers.delete(id)
      return { action: 'promote', previousFollow: existing }
    }
    if (authoritativeLocator &&
        Number(authoritativeLocator.issuedAt) >= Number(existing.scope.advertisedLocatorIssuedAt || 0)) {
      existing.scope.advertisedCatalogHead = authoritativeLocator.catalogHead
      existing.scope.advertisedAuthorizationStateDigest = authoritativeLocator.authorizationChainDigest
      existing.scope.advertisedLocatorSignerId = authoritativeLocator.signerId
      existing.scope.advertisedLocatorIssuedAt = authoritativeLocator.issuedAt
      if (existing.scope.catalogHeadDigest !== authoritativeLocator.catalogHead) {
        existing.scope.catalogHeadDigest = authoritativeLocator.catalogHead
        existing.scope.catalogAuthorizationStateDigest = null
        existing.scope.catalogCursor = null
        existing.scope.catalogResumeCursor = null
        existing.scope.catalogPreviousPageDigest = null
        existing.scope.catalogPendingEntries = []
      }
      existing.scope.catalogComplete = false
      void syncPublisherCatalog(existing.scope).catch(error => {
        recordProtocolError(existing.scope, 'bootstrap-refresh', error)
      })
    }
    return { action: 'already-following', result: { ...existing.result, status: 'already-following' } }
  }

  async function bindAndLoadFollowedPublisher(id, descriptor, verifiedNamespaceProof) {
    if (!catalogRegistry?.bindNamespace) fail('catalog registry cannot bind verified namespaces')
    const binding = await catalogRegistry.bindNamespace(descriptor, { verifiedNamespaceProof })
    if (hex32(binding.catalogBootstrapKey, 'catalogBootstrapKey') !== b4a.toString(descriptor.catalogBootstrapKey, 'hex')) {
      fail('catalog binding mismatch')
    }
    await publisherManager.followPublisher(id)
    await binding.catalog?.openVerifiedPageView?.()
    const saved = await publisherSyncStateRepository?.load?.(id)
    const restored = saved?.version === 2 && saved.publisherId === id &&
      saved.catalogEpoch === descriptor.catalogEpoch
      ? saved
      : null
    return { binding, restored }
  }

  function buildFollowedScopeProps(restored, authoritativeLocator) {
    const locator = authoritativeLocator || {}
    const resumable = restored !== null
    const advertisedHead = locator.catalogHead || null
    return {
      namespaceProofVerified: null,
      catalogPagePending: null,
      catalogSyncing: null,
      catalogCursor: null,
      catalogResumeCursor: resumable ? restored?.cursor || null : null,
      catalogPreviousPageDigest: null,
      catalogHeadDigest: resumable ? restored?.headDigest || advertisedHead : advertisedHead,
      catalogAuthorizationStateDigest: resumable ? restored?.authorizationStateDigest || null : null,
      advertisedCatalogHead: advertisedHead,
      advertisedAuthorizationStateDigest: locator.authorizationChainDigest || null,
      advertisedLocatorSignerId: locator.signerId || null,
      advertisedLocatorIssuedAt: locator.issuedAt || null,
      catalogComplete: restored?.complete === true &&
        (!authoritativeLocator || restored?.headDigest === locator.catalogHead),
      catalogBudget: restoreCatalogBudget(restored?.budget),
      catalogInitialHeadLength: 0,
      catalogVerifiedPages: 0,
      catalogVerifiedRecords: 0,
      catalogVerifiedBytes: 0,
      catalogVerificationWork: 0,
      catalogPendingEntries: [],
    }
  }

  async function followPublisherAdmission ({
    publisherId,
    namespaceDescriptor,
    verifiedNamespaceProof = null,
    verifiedBootstrapLocator = null,
    locatorAuthority = null,
  } = {}) {
    if (policy.status !== 'active') fail('runtime is not active')
    const id = hex32(publisherId, 'publisherId')
    const descriptor = normalizeNamespace(namespaceDescriptor, protocolMajor, { verifiedNamespaceProof })
    if (b4a.toString(descriptor.publisherId, 'hex') !== id) fail('namespace publisherId mismatch')

    const existing = followedPublishers.get(id)
    let previousFollow = null
    const authoritativeLocator = locatorAuthority === verifiedLocatorAuthority
      ? verifiedBootstrapLocator
      : null

    if (existing) {
      const followResolution = handleExistingFollow(existing, descriptor, authoritativeLocator, id)
      if (followResolution.action === 'already-following') return followResolution.result
      previousFollow = followResolution.previousFollow
    }

    const { binding, restored } = await raceAdmission(
      bindAndLoadFollowedPublisher(id, descriptor, verifiedNamespaceProof),
    )
    assertAdmissionOpen()
    const topic = derivePublisherTopic({ publisherId: id, catalogEpoch: descriptor.catalogEpoch })
    const scopeProps = buildFollowedScopeProps(restored, authoritativeLocator)

    const { scope } = joinScope({
      purpose: 'publisher',
      topic,
      scopeId: id,
      mode: 'followed',
      publisherId: id,
      descriptor,
      binding,
      ...scopeProps,
    })
    scope.publisherId = id
    scope.descriptor = descriptor
    scope.binding = binding
    Object.assign(scope, scopeProps)

    const result = {
      status: 'following',
      publisherId: id,
      catalogBootstrapKey: hex32(binding.catalogBootstrapKey, 'catalogBootstrapKey'),
      topic: stableScopeDiagnostic(scope),
    }
    followedPublishers.set(id, { scope, result })
    if (previousFollow) {
      await leaveScope(previousFollow.scope, 'followed')
    }
    assertAdmissionOpen()
    if ([...scope.sessions.values()].some(session => !session.closed && session.state === 'active')) {
      void syncPublisherCatalog(scope).catch(error => {
        recordProtocolError(scope, 'bootstrap-promotion', error)
      })
    }
    return result
  }

  function followPublisher (args = {}) {
    return trackAdmission(() => followPublisherAdmission(args))
  }

  // Bootstrap metadata only identifies an untrusted candidate. A caller may
  // supply the bounded namespace proof collected from that publisher topic;
  // this is the sole route from candidate metadata to catalog binding.
  async function followBootstrapLocatorAdmission ({ publisherId, proof = null } = {}) {
    if (policy.status === 'closed') throw admissionClosedError()
    const id = hex32(publisherId, 'publisherId')
    const locator = bootstrapManager.getLocator?.(id)
    if (!locator) fail('bootstrap locator is unavailable', 'BOOTSTRAP_LOCATOR_UNAVAILABLE')
    const topic = derivePublisherTopic({ publisherId: id, catalogEpoch: locator.catalogEpoch })
    const { scope } = joinScope({
      purpose: 'publisher', topic, scopeId: id, mode: 'candidate', publisherId: id,
      candidateLocator: locator, proofPending: null,
    })
    let verified
    let namespaceProof
    let proofVerified = false
    let failure = null
    let operationFailed = false
    let result
    try {
      namespaceProof = proof || await raceAdmission(requestNamespaceProof(scope))
      assertAdmissionOpen()
      verified = verifyPublisherNamespaceProof({ locator, ...namespaceProof })
      proofVerified = true
      result = await followPublisher({
        publisherId: id,
        namespaceDescriptor: verified.descriptor,
        verifiedNamespaceProof: verified.descriptor.catalogEpoch > 0 ? namespaceProof : null,
        verifiedBootstrapLocator: locator,
        locatorAuthority: verifiedLocatorAuthority,
      })
    } catch (error) {
      if (admissionSignal.aborted && !proofVerified) {
        failure = admissionSignal.reason || admissionClosedError()
      } else {
        failure = proofVerified
          ? error
          : new Error(error?.message || 'namespace proof rejected')
        if (!proofVerified) failure.code = 'PUBLISHER_NAMESPACE_PROOF_REJECTED'
      }
      operationFailed = true
    }
    try {
      await leaveScope(scope, 'candidate')
    } catch (cleanupError) {
      // Preserve the proof or promotion failure that caused this attempt to
      // fail. A cleanup failure is actionable only when the operation itself
      // otherwise succeeded.
      if (!failure) throw cleanupError
    }
    if (operationFailed) throw failure
    assertAdmissionOpen()
    return result
  }

  function followBootstrapLocator (args = {}) {
    return trackAdmission(() => followBootstrapLocatorAdmission(args))
  }

  async function providePublisherNamespaceProof ({ locator, proof } = {}) {
    if (policy.status === 'closed') throw admissionClosedError()
    const id = hex32(locator?.publisherId, 'locator publisherId')
    const verified = verifyPublisherNamespaceProof({ locator, ...(proof || {}) })
    const topic = derivePublisherTopic({ publisherId: id, catalogEpoch: locator.catalogEpoch })
    // The proof response deliberately carries only signed operations. The
    // descriptor is reconstructed from those operations, avoiding an
    // unauthenticated duplicate descriptor representation on the wire.
    publisherProofProviders.set(id, { genesis: proof?.genesis, transitions: proof?.transitions })
    const { scope } = joinScope({
      purpose: 'publisher', topic, scopeId: id, mode: 'candidate', publisherId: id,
      candidateLocator: locator, proofPending: null,
    })
    return { status: 'provided', publisherId: id, catalogEpoch: verified.descriptor.catalogEpoch, topic: stableScopeDiagnostic(scope) }
  }

  function createLocalCatalogInspectionBinding (publisherId, binding) {
    const initialCatalog = binding?.catalog
    const localWriterKey = initialCatalog?.localWriterKey
      ? b4a.from(initialCatalog.localWriterKey)
      : null
    // Bootstrap refresh reads the head and authorization state together; share
    // one lease across those parallel reads so the locator cannot mix snapshots.
    let inspection = null
    async function inspectAdmission (method) {
      if (!inspection) {
        const current = { lease: null, users: 0, promise: null }
        current.promise = (async () => {
          if (typeof catalogRegistry?.acquireWritableBinding === 'function') {
            current.lease = await raceOwned(
              catalogRegistry.acquireWritableBinding(b4a.from(publisherId, 'hex'), { signal: admissionSignal }),
              value => value?.release?.(),
            )
            assertAdmissionOpen()
            return current.lease?.binding || null
          }
          if (typeof catalogRegistry?.resolve === 'function') {
            const resolved = await raceAdmission(catalogRegistry.resolve(b4a.from(publisherId, 'hex')))
            assertAdmissionOpen()
            return resolved
          }
          return binding
        })()
        inspection = current
      }
      const current = inspection
      current.users++
      try {
        const inspectedBinding = await current.promise
        const catalog = inspectedBinding?.catalog
        if (typeof catalog?.[method] !== 'function') fail('local catalog inspection is unavailable')
        return await raceAdmission(catalog[method]())
      } finally {
        current.users--
        if (current.users === 0) {
          if (inspection === current) inspection = null
          await current.promise.catch(() => {})
          await current.lease?.release?.()
        }
      }
    }
    const inspect = method => trackAdmission(() => inspectAdmission(method))
    return {
      publisherId: binding.publisherId,
      genesisRootKey: binding.genesisRootKey,
      catalogBootstrapKey: binding.catalogBootstrapKey,
      namespaceDescriptor: binding.namespaceDescriptor,
      catalog: {
        localWriterKey,
        getViewHead: () => inspect('getViewHead'),
        getAuthorizationState: () => inspect('getAuthorizationState'),
      },
    }
  }

  async function scanNamespaceProofOperations(activeCatalog) {
    let genesis = null
    const transitions = []
    let cursor = null
    let scanned = 0
    do {
      const page = await raceAdmission(activeCatalog.listAcceptedPage({ cursor, limit: MAX_CATALOG_PAGE_RECORDS }))
      assertAdmissionOpen()
      if (!page || !Array.isArray(page.entries) || page.entries.length > MAX_CATALOG_PAGE_RECORDS) {
        fail('local catalog namespace proof page is invalid')
      }
      for (const entry of page.entries) {
        const operation = decodePublisherCatalogFrame(entry.frame)
        scanned++
        if (scanned > MAX_CATALOG_SESSION_RECORDS) {
          fail('local catalog namespace proof scan exceeds bounded limit')
        }
        if (operation.recordType === 'publisher.namespace' && !operation.transitionId) genesis ||= operation
        else if (operation.recordType === 'publisher.root-transition') transitions.push(operation)
      }
      cursor = page.nextCursor ?? null
    } while (cursor !== null)
    if (!genesis) fail('local catalog has no namespace genesis proof')
    transitions.sort((left, right) => {
      const leftEpoch = decodePublisherOperationBody(left.recordType, left.canonicalBody).newCatalogEpoch
      const rightEpoch = decodePublisherOperationBody(right.recordType, right.canonicalBody).newCatalogEpoch
      return leftEpoch - rightEpoch || left.issuerSequence - right.issuerSequence ||
        b4a.compare(left.transitionId, right.transitionId)
    })
    return { genesis, transitions }
  }

  function provideLocalPublisherNamespaceProof (args = {}) {
    return trackAdmission(() => provideLocalPublisherNamespaceProofAdmission(args))
  }

  async function provideLocalPublisherNamespaceProofAdmission ({ publisherId, descriptor, catalog } = {}) {
    if (policy.status === 'closed') throw admissionClosedError()
    const id = hex32(publisherId, 'publisherId')
    let lease = null
    let activeCatalog = catalog || null
    try {
      if (!activeCatalog) {
        if (typeof catalogRegistry?.acquireWritableBinding !== 'function') {
          fail('local catalog accepted pages are unavailable for namespace proof')
        }
        lease = await raceOwned(
          catalogRegistry.acquireWritableBinding(b4a.from(id, 'hex'), { signal: admissionSignal }),
          value => value?.release?.(),
        )
        assertAdmissionOpen()
        activeCatalog = lease?.binding?.catalog || null
      }
      if (typeof activeCatalog?.listAcceptedPage !== 'function') fail('local catalog accepted pages are unavailable for namespace proof')
      const { genesis, transitions } = await raceAdmission(scanNamespaceProofOperations(activeCatalog))
      assertAdmissionOpen()
      publisherProofProviders.set(id, { genesis, transitions })
      // Local providers are ID-based: no live catalog retained past the lease.
      publisherPageProviders.set(id, {
        publisherId: id,
        catalogEpoch: descriptor.catalogEpoch,
        local: true,
      })
      const topic = derivePublisherTopic({ publisherId: id, catalogEpoch: descriptor.catalogEpoch })
      const { scope } = joinScope({ purpose: 'publisher', topic, scopeId: id, mode: 'local', publisherId: id, proofPending: null })
      return { status: 'provided', publisherId: id, topic: stableScopeDiagnostic(scope) }
    } finally {
      await lease?.release?.()
    }
  }


  async function unfollowPublisher ({ publisherId } = {}) {
    const id = hex32(publisherId, 'publisherId')
    const followed = followedPublishers.get(id)
    followedPublishers.delete(id)
    reasonFollowedPublishers.delete(id)
    await publisherManager.unfollowPublisher(id)
    const released = followed ? await leaveScope(followed.scope, 'followed') : false
    if (followed && !localPublishers.has(id)) await catalogRegistry?.release?.(b4a.from(id, 'hex'))
    await publisherSyncStateRepository?.clear?.(id)
    return { status: 'unfollowed', publisherId: id, released }
  }

  function assertPublishUploadPolicy(retentionClass) {
    if (!retentionClassAllowed(retentionClass) || !policy.uploadAllowed) {
      if (retentionClass === 'contribution-cache') {
        fail('explicit contribution upload permission is required')
      }
      fail('explicit archive upload permission is required')
    }
  }

  async function acquireLocalPublisherBinding(id, providedBinding) {
    let lease = null
    let binding = providedBinding
    try {
      if (!binding) {
        if (typeof catalogRegistry?.acquireWritableBinding === 'function') {
          lease = await raceOwned(
            catalogRegistry.acquireWritableBinding(b4a.from(id, 'hex'), { signal: admissionSignal }),
            value => value?.release?.(),
          )
          assertAdmissionOpen()
          binding = lease?.binding || null
        } else if (typeof catalogRegistry?.resolve === 'function') {
          binding = await raceAdmission(catalogRegistry.resolve(b4a.from(id, 'hex')))
          assertAdmissionOpen()
        }
      }
      if (!binding) fail('catalog registry is unavailable')
      return { binding, lease }
    } catch (error) {
      // The lease was handed off to this frame but the handoff failed: release
      // it here exactly once; the caller's finally sees lease=null.
      const owned = lease
      lease = null
      await owned?.release?.()
      throw error
    }
  }

  async function validateLocalPublisherCatalog(binding, id) {
    await raceAdmission(binding.catalog?.ready?.())
    assertAdmissionOpen()
    const listProjections = binding.catalog?.listProjections
    if (typeof listProjections !== 'function') fail('local catalog projection is unavailable')
    const [publications, claims] = await raceAdmission(Promise.all([
      listProjections.call(binding.catalog, 'publication', { limit: 1 }),
      listProjections.call(binding.catalog, 'claim', { limit: 1 }),
    ]))
    assertAdmissionOpen()
    const publicationCount = publications?.items?.length || 0
    const claimCount = claims?.items?.length || 0
    if (publicationCount === 0 && claimCount === 0) {
      fail('local catalog has no accepted publication or claim')
    }
    const descriptor = await raceAdmission(readLocalBindingDescriptor(binding))
    assertAdmissionOpen()
    if (b4a.toString(descriptor.publisherId, 'hex') !== id) fail('local catalog namespace mismatch')
    if (hex32(binding.catalogBootstrapKey, 'catalogBootstrapKey') !== b4a.toString(descriptor.catalogBootstrapKey, 'hex')) {
      fail('local catalog binding mismatch')
    }
    return descriptor
  }

  async function registerLocalPublisherScope(id, descriptor, binding, scope) {
    if (!scope.modes.has('followed')) {
      scope.binding = createLocalCatalogInspectionBinding(id, binding)
    }
    if (typeof binding.catalog?.listAcceptedPage === 'function') {
      await provideLocalPublisherNamespaceProof({ publisherId: id, descriptor, catalog: binding.catalog })
    } else {
      assertAdmissionOpen()
      publisherPageProviders.set(id, {
        publisherId: id,
        catalogEpoch: descriptor.catalogEpoch,
        local: true,
      })
    }
    assertAdmissionOpen()
    const result = {
      status: 'published',
      publisherId: id,
      catalogBootstrapKey: hex32(binding.catalogBootstrapKey, 'catalogBootstrapKey'),
      catalogEpoch: descriptor.catalogEpoch,
      topic: stableScopeDiagnostic(scope),
    }
    localPublishers.set(id, { scope, result })
    if (hasBootstrapLocatorKeyPair) {
      try {
        await raceAdmission(bootstrapRuntime.refreshLocalBootstrapLocator(id))
      } catch (error) {
        console.log('[ScopedNetwork] local bootstrap locator refresh deferred:', error?.code || error?.message || error)
      }
    }
    return result
  }

  async function publishLocalPublisherCatalogAdmission ({ publisherId, retentionClass: requestedRetentionClass, binding: providedBinding = null } = {}) {
    const retentionClass = normalizeRetentionClass(requestedRetentionClass)
    assertPublishUploadPolicy(retentionClass)
    if (policy.status !== 'active') fail('runtime is not active')
    const id = hex32(publisherId, 'publisherId')
    const existing = localPublishers.get(id)
    if (existing) {
      existing.scope.retentionClasses ??= new Set()
      existing.scope.retentionClasses.add(retentionClass)
      await raceAdmission(rejoinScopeDiscovery(existing.scope))
      assertAdmissionOpen()
      return rebindLocalPublisherCatalog({ publisherId: id })
    }

    let lease = null
    try {
      const acquired = await acquireLocalPublisherBinding(id, providedBinding)
      lease = acquired.lease
      assertAdmissionOpen()
      const binding = acquired.binding
      const descriptor = await raceAdmission(validateLocalPublisherCatalog(binding, id))
      assertAdmissionOpen()

      const topic = derivePublisherTopic({ publisherId: id, catalogEpoch: descriptor.catalogEpoch })
      const { scope } = joinScope({
        purpose: 'publisher',
        topic,
        scopeId: id,
        mode: 'local',
        publisherId: id,
        descriptor,
        retentionClasses: new Set([retentionClass]),
      })
      scope.publisherId = id
      scope.descriptor = descriptor
      scope.localPublisher = true
      scope.retentionClasses ??= new Set()
      scope.retentionClasses.add(retentionClass)
      return await registerLocalPublisherScope(id, descriptor, binding, scope)
    } finally {
      await lease?.release?.()
    }
  }

  function publishLocalPublisherCatalog (args = {}) {
    return trackAdmission(() => publishLocalPublisherCatalogAdmission(args))
  }

  async function readLocalBindingDescriptor(binding) {
    const descriptorEntry = await binding.catalog?.view?.get?.('state/descriptor')
    return normalizeNamespace(descriptorEntry?.value || binding.namespaceDescriptor, protocolMajor, {
      verifiedNamespaceProof: descriptorEntry?.value ? true : null,
    })
  }

  async function refreshExistingLocalScope(id, existing, descriptor, binding) {
    existing.scope.descriptor = descriptor
    existing.scope.localPublisher = true
    if (!existing.scope.modes.has('followed')) {
      existing.scope.binding = createLocalCatalogInspectionBinding(id, binding)
    }
    await provideLocalPublisherNamespaceProof({ publisherId: id, descriptor, catalog: binding.catalog })
    assertAdmissionOpen()
    if (hasBootstrapLocatorKeyPair) {
      try {
        await raceAdmission(bootstrapRuntime.refreshLocalBootstrapLocator(id))
      } catch (error) {
        console.log('[ScopedNetwork] local bootstrap locator refresh deferred:', error?.code || error?.message || error)
      }
    }
    assertAdmissionOpen()
    existing.result = {
      ...existing.result,
      catalogEpoch: descriptor.catalogEpoch,
      topic: stableScopeDiagnostic(existing.scope),
    }
    return { ...existing.result, status: 'refreshed' }
  }

  async function rotateLocalPublisherScope(id, existing) {
    bootstrapRuntime.removeLocalLocator(id)
    publisherProofProviders.delete(id)
    publisherPageProviders.delete(id)
    localPublishers.delete(id)
    existing.scope.retired = true
    existing.scope.modes.add('rotation-drain')
    const result = await withBatchedConnectionWrites(async () => {
      const published = await publishLocalPublisherCatalog({ publisherId: id })
      await leaveScope(existing.scope, 'local')
      return published
    })
    assertAdmissionOpen()
    const timer = schedulePublisherRotationDrain(() => {
      publisherRotationDrainTimers.delete(timer)
      void leaveScope(existing.scope, 'rotation-drain')
    }, publisherRotationDrainMs)
    timer.unref?.()
    publisherRotationDrainTimers.add(timer)
    return { ...result, status: 'rebound' }
  }

  async function rebindLocalPublisherCatalogAdmission ({ publisherId } = {}) {
    if (policy.status !== 'active') fail('runtime is not active')
    const id = hex32(publisherId, 'publisherId')
    const existing = localPublishers.get(id)
    if (!existing) return publishLocalPublisherCatalog({ publisherId: id })

    let lease = null
    try {
      const acquired = await acquireLocalPublisherBinding(id, null)
      lease = acquired.lease
      assertAdmissionOpen()
      const binding = acquired.binding
      await raceAdmission(binding.catalog?.ready?.())
      assertAdmissionOpen()
      const descriptor = await raceAdmission(readLocalBindingDescriptor(binding))
      assertAdmissionOpen()
      const previous = existing.scope.descriptor
      const changed = descriptor.catalogEpoch !== previous.catalogEpoch ||
        !b4a.equals(descriptor.publisherRootKey, previous.publisherRootKey) ||
        !b4a.equals(descriptor.catalogBootstrapKey, previous.catalogBootstrapKey)
      if (!changed) {
        return await refreshExistingLocalScope(id, existing, descriptor, binding)
      }

      await lease?.release?.()
      lease = null
      assertAdmissionOpen()
      return await rotateLocalPublisherScope(id, existing)
    } finally {
      await lease?.release?.()
    }
  }

  function rebindLocalPublisherCatalog (args = {}) {
    return trackAdmission(() => rebindLocalPublisherCatalogAdmission(args))
  }

  async function inspectResolvedBinding(binding) {
    await raceAdmission(binding.catalog?.ready?.())
    assertAdmissionOpen()
    const descriptorEntry = await raceAdmission(binding.catalog?.view?.get?.('state/descriptor'))
    assertAdmissionOpen()
    const descriptor = binding.namespaceDescriptor || (descriptorEntry?.value ? normalizeNamespace(descriptorEntry.value, protocolMajor) : null)
    return {
      status: 'available',
      catalogBootstrapKey: hex32(binding.catalogBootstrapKey, 'catalogBootstrapKey'),
      catalogEpoch: descriptor?.catalogEpoch ?? null,
      writable: binding.catalog?.writable === true,
    }
  }

  async function resolveLocalPublisherCatalogAdmission ({ publisherId } = {}) {
    const id = hex32(publisherId, 'publisherId')
    let lease = null
    try {
      const acquired = await acquireLocalPublisherBinding(id, null)
      lease = acquired.lease
      return await inspectResolvedBinding(acquired.binding)
    } catch {
      return { status: 'unavailable', publisherId: id }
    } finally {
      await lease?.release?.()
    }
  }

  function resolveLocalPublisherCatalog (args = {}) {
    return trackAdmission(() => resolveLocalPublisherCatalogAdmission(args))
  }

  function closeFollowState () {
    followedPublishers.clear()
    publisherFollowReasons.clear()
    publisherFollowWork.clear()
    reasonFollowedPublishers.clear()
  }
  function closeLocalState () {
    for (const timer of publisherRotationDrainTimers) cancelPublisherRotationDrain(timer)
    publisherRotationDrainTimers.clear()
    localPublishers.clear()
  }

  return {
    handlePublisherProofFrame, syncPublisherCatalog, restoreLocalPublisherScopes,
    scheduleReasonedPublisherFollow, addPublisherFollowReason, removePublisherFollowReason, getPublisherFollowReasons,
    followPublisher, followBootstrapLocator, providePublisherNamespaceProof, provideLocalPublisherNamespaceProof,
    unfollowPublisher, publishLocalPublisherCatalog, rebindLocalPublisherCatalog, resolveLocalPublisherCatalog,
    closeFollowState, closeLocalState, closeAdmissions,
  }
}
