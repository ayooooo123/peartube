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
      version: 1,
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
    if (value.version !== 1) fail('catalog page request version is unsupported')
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
    return { version: 1, cursor, previousPageDigest, expectedHeadDigest, catalogEpoch, limit }
  }

  function normalizeCatalogResponse(payload, request) {
    const value = decodeCanonicalCatalogPayload(payload, 'catalog page response')
    if (value.version !== 1 || value.catalogEpoch !== request.catalogEpoch ||
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
    if (!Number.isSafeInteger(headLength) || headLength < 0 || headLength > MAX_CATALOG_HEAD_DISTANCE) fail('catalog head distance exceeds bounded limit')
    if (!Array.isArray(value.entries) || value.entries.length > request.limit) fail('catalog page record bound exceeded')
    let prior = request.cursor
    const entries = value.entries.map(entry => {
      const operationId = normalizeCatalogCursor(entry?.operationId, 'operationId')
      const sourceWriterKey = exactBuffer(entry?.sourceWriterKey, 32, 'sourceWriterKey')
      const frame = b4a.from(entry?.frame || [])
      const operation = decodePublisherCatalogFrame(frame)
      const derivedId = b4a.toString(operation.recordId || operation.transitionId, 'hex')
      if (derivedId !== operationId || (prior !== null && operationId <= prior)) fail('catalog page ordering or provenance is invalid')
      prior = operationId
      return { operationId, sourceWriterKey, frame }
    })
    if (entries.length === 0 && nextCursor !== null) fail('empty catalog page cannot advance')
    if (nextCursor !== null && nextCursor !== entries.at(-1)?.operationId) fail('catalog page cursor linkage is invalid')
    const unsigned = {
      version: 1,
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

  async function serveCatalogPage(scope, tracked, frame) {
    if (!tracked?.namespaceProofServed) fail('namespace proof is mandatory before catalog pages')
    const provider = publisherPageProviders.get(scope.publisherId)
    if (!provider) fail('catalog page provider is unavailable')
    const request = normalizeCatalogRequest(frame.payload)
    if (request.catalogEpoch !== provider.catalogEpoch) fail('catalog page epoch mismatch')
    // A null predecessor restarts a walk; later pages must retain digest linkage.
    if (request.previousPageDigest === null) tracked.catalogServeDigest = null
    else if (request.previousPageDigest !== tracked.catalogServeDigest) fail('catalog page linkage mismatch')
    const head = await provider.catalog.getViewHead()
    const headDigest = hex32(head?.digest, 'headDigest')
    if (request.expectedHeadDigest !== null && request.expectedHeadDigest !== headDigest) fail('catalog head changed before cursor resume')
    const page = await provider.catalog.listAcceptedPage({ cursor: request.cursor, limit: request.limit })
    if (!page || !Array.isArray(page.entries) || page.entries.length > request.limit) fail('catalog provider returned an invalid page')
    const entries = page.entries.map(entry => ({
      operationId: normalizeCatalogCursor(entry?.operationId, 'operationId'),
      sourceWriterKey: exactBuffer(entry?.sourceWriterKey, 32, 'sourceWriterKey'),
      frame: b4a.from(entry?.frame || []),
    }))
    // Never split a page across authorization dependencies; the full logical page is atomic.
    const nextCursor = normalizeCatalogCursor(page.nextCursor)
    const unsigned = {
      version: 1,
      requestedCursor: request.cursor,
      nextCursor,
      previousPageDigest: request.previousPageDigest,
      expectedHeadDigest: request.expectedHeadDigest,
      catalogEpoch: provider.catalogEpoch,
      headLength: Number(head?.length),
      headDigest,
      authorizationStateDigest: hex32(head?.authorizationStateDigest, 'authorizationStateDigest'),
      entries,
    }
    const response = { ...unsigned, pageDigest: b4a.toString(pageDigest(unsigned), 'hex') }
    const payload = canonicalCatalogPayload(response, 'catalog page response')
    const entriesServed = entries
    const nextPages = tracked.catalogServePages + 1
    const nextRecords = tracked.catalogServeRecords + entriesServed.length
    const nextBytes = tracked.catalogServeBytes + payload.byteLength
    if (nextPages > MAX_CATALOG_SESSION_PAGES || nextRecords > MAX_CATALOG_SESSION_RECORDS ||
        nextBytes > MAX_CATALOG_SESSION_BYTES || nextRecords * 2 > MAX_CATALOG_VERIFICATION_WORK) {
      fail('catalog provider cumulative session budget exceeded')
    }
    if (!sendScopedFrame(tracked, 'publisher', 'catalog-page-response', payload)) fail('catalog page response send failed')
    tracked.catalogServePages = nextPages
    tracked.catalogServeRecords = nextRecords
    tracked.catalogServeBytes = nextBytes
    tracked.catalogServeDigest = response.pageDigest
    return { status: 'sent', records: entriesServed.length, nextCursor }
  }

  async function acceptCatalogPage(scope, tracked, frame) {
    const pending = scope.catalogPagePending
    if (!pending) fail('unexpected catalog page response')
    try {
      const response = normalizeCatalogResponse(frame.payload, pending.request)
      if (scope.catalogHeadDigest && scope.catalogHeadDigest !== response.headDigest) {
        // A signed newer head is catalog growth; retarget rather than treating it as equivocation.
        if (scope.advertisedCatalogHead && scope.advertisedCatalogHead === response.headDigest) {
          // Adopt only the signed locator head.
          scope.catalogHeadDigest = scope.advertisedCatalogHead
          scope.catalogAuthorizationStateDigest = null
          scope.catalogCursor = null
          scope.catalogResumeCursor = null
          scope.catalogPreviousPageDigest = null
          scope.catalogComplete = false
        } else {
          fail('catalog head equivocation detected')
        }
      }
      if (scope.advertisedCatalogHead && scope.advertisedCatalogHead !== response.headDigest) {
        fail('catalog response does not match the signed advertised head', 'PUBLISHER_CATALOG_ADVERTISED_HEAD_MISMATCH')
      }
      const nextPages = tracked.catalogAcceptPages + 1
      const nextRecords = tracked.catalogAcceptRecords + response.entries.length
      const nextBytes = tracked.catalogAcceptBytes + frame.payload.byteLength
      const nextWork = tracked.catalogAcceptVerificationWork + response.entries.length * 2
      if (nextPages > MAX_CATALOG_SESSION_PAGES || nextRecords > MAX_CATALOG_SESSION_RECORDS ||
          nextBytes > MAX_CATALOG_SESSION_BYTES || nextWork > MAX_CATALOG_VERIFICATION_WORK ||
          response.headLength - tracked.catalogAcceptInitialHeadLength > MAX_CATALOG_HEAD_DISTANCE) {
        fail('catalog consumer cumulative session budget exceeded')
      }
      const additions = {
        pages: 1,
        records: response.entries.length,
        bytes: frame.payload.byteLength,
        work: response.entries.length * 2,
      }
      scope.catalogComplete = false
      await reserveCatalogBudget(scope, tracked.peerId, additions)
      let ingestResult = { accepted: 0, rejected: 0 }
      if (response.entries.length > 0) {
        ingestResult = await scope.binding.catalog.ingestAcceptedPage(response.entries)
        if (ingestResult?.accepted !== response.entries.length || Number(ingestResult?.rejected || 0) !== 0) {
          fail('catalog page contained an inadmissible operation', 'PUBLISHER_CATALOG_PAGE_INGEST_REJECTED')
        }
      }
      tracked.catalogAcceptPages = nextPages
      tracked.catalogAcceptRecords = nextRecords
      tracked.catalogAcceptBytes = nextBytes
      tracked.catalogAcceptVerificationWork = nextWork
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
    if (frame.type === 'catalog-page-request') return serveCatalogPage(scope, tracked, frame)
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

  async function verifyCatalogCompletion(scope) {
    const catalog = scope.binding?.catalog
    if (typeof catalog?.getViewHead !== 'function') {
      fail('verified catalog head is unavailable', 'PUBLISHER_CATALOG_HEAD_UNAVAILABLE')
    }
    const head = await catalog.getViewHead()
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
    if (scope.advertisedLocatorSignerId) {
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
    scope.catalogComplete = true
    await persistPublisherSyncState(scope)
    return head
  }

  async function syncPublisherCatalog(scope) {
    if (!scope || scope.closed || !scope.modes.has('followed')) return { status: 'not-followed' }
    if (scope.catalogSyncing) return scope.catalogSyncing
    scope.catalogSyncing = (async () => {
      await ensurePublisherNamespaceProof(scope)
      let cursor = scope.catalogResumeCursor ?? null
      if (cursor === null) {
        scope.catalogHeadDigest = scope.advertisedCatalogHead || null
        scope.catalogAuthorizationStateDigest = null
      }
      let previousPageDigest = null
      let pages = 0
      do {
        const response = await requestCatalogPage(scope, {
          version: 1,
          cursor,
          previousPageDigest,
          expectedHeadDigest: scope.advertisedCatalogHead || (cursor === null ? null : scope.catalogHeadDigest),
          catalogEpoch: scope.descriptor.catalogEpoch,
          limit: MAX_CATALOG_PAGE_RECORDS,
        })
        pages++
        cursor = response.nextCursor
        previousPageDigest = response.pageDigest
      } while (cursor !== null)
      await verifyCatalogCompletion(scope)
      await onCatalogUpdate?.({ publisherId: scope.publisherId })
      return { status: 'synced', pages, records: scope.catalogVerifiedRecords, cursor: scope.catalogResumeCursor }
    })().finally(() => { scope.catalogSyncing = null })
    return scope.catalogSyncing
  }


  async function restoreLocalPublisherScopes () {
    if (!policy.contributionAllowed) return
    if (typeof catalogRegistry?.getWritableBindings !== 'function') return
    const bindings = await catalogRegistry.getWritableBindings()
    if (!Array.isArray(bindings) || bindings.length > 64) fail('writable catalog restore exceeds its bound')
    for (const binding of bindings) {
      const publisherId = hex32(binding?.publisherId, 'publisherId')
      const catalog = binding?.catalog
      if (!catalog?.writable || typeof catalog.listProjections !== 'function') continue
      const [publications, claims] = await Promise.all([
        catalog.listProjections('publication', { limit: 1 }),
        catalog.listProjections('claim', { limit: 1 }),
      ])
      if ((publications?.items?.length || 0) === 0 && (claims?.items?.length || 0) === 0) continue
      await publishLocalPublisherCatalog({ publisherId })
    }
  }
  function normalizeFollowReason(reason) {
    const value = String(reason || '')
    if (value.length < 1 || value.length > 256 || !/^[a-z0-9][a-z0-9:_-]*$/.test(value)) {
      fail('invalid publisher follow reason')
    }
    return value
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
    if (existing) {
      const currentEpoch = Number(existing.scope.descriptor.catalogEpoch)
      if (locator.catalogEpoch < currentEpoch || locator.catalogEpoch > currentEpoch + 1) return skip('locator epoch out of range')
      const identical = locator.catalogEpoch === currentEpoch &&
        b4a.equals(existing.scope.topic, locatorTopic) &&
        locator.catalogBootstrapKey === b4a.toString(existing.scope.descriptor.catalogBootstrapKey, 'hex') &&
        locator.catalogHead === existing.scope.advertisedCatalogHead &&
        locator.authorizationChainDigest === existing.scope.advertisedAuthorizationStateDigest
      if (identical) {
        // An unchanged locator retries an unfinished walk only while its session is live.
        const live = [...existing.scope.sessions.values()]
          .some(session => !session.closed && session.state === 'active')
        existing.scope.idleLocatorTicks = live ? 0 : (existing.scope.idleLocatorTicks || 0) + 1
        if (existing.scope.catalogComplete !== true && live) {
          void syncPublisherCatalog(existing.scope).catch(error => {
            recordProtocolError(existing.scope, 'locator-retry', error)
          })
          return skip('locator unchanged; retrying an unfinished catalog walk')
        }
        // Rebuild after two idle ticks only when a transport exists, preserving the attempt cap.
        const stalled = !live && existing.scope.idleLocatorTicks >= 2 && getActiveConnectionCount() > 0
        if (!stalled) {
          return skip(live ? 'locator identical to current scope' : 'locator identical; no live session yet')
        }
        bootstrapFollowAttempts.delete(publisherId)
      }
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
    const work = followBootstrapLocator({ publisherId })
      .then(async result => {
        if (!publisherFollowReasons.get(publisherId)?.size) {
          await unfollowPublisher({ publisherId })
          return null
        }
        reasonFollowedPublishers.add(publisherId)
        return result
      })
      .finally(() => publisherFollowWork.delete(publisherId))
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
  async function followPublisher ({
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
      if (descriptor.catalogEpoch > existing.scope.descriptor.catalogEpoch) {
        // Promote the already-authenticated candidate for the new epoch before
        // closing the prior epoch channel. Closing first can tear down the
        // shared transport while the peer is still proving the replacement.
        previousFollow = existing
        followedPublishers.delete(id)
      } else {
        if (authoritativeLocator &&
            Number(authoritativeLocator.issuedAt) >= Number(existing.scope.advertisedLocatorIssuedAt || 0)) {
          existing.scope.advertisedCatalogHead = authoritativeLocator.catalogHead
          existing.scope.advertisedAuthorizationStateDigest = authoritativeLocator.authorizationChainDigest
          existing.scope.advertisedLocatorSignerId = authoritativeLocator.signerId
          existing.scope.advertisedLocatorIssuedAt = authoritativeLocator.issuedAt
          // Same reason as on first follow: a publisher that has appended now
          // serves a head this scope is not walking toward, and the page
          // response would be rejected as equivocation. Retarget the walk at
          // the newly advertised head and drop the cursor for the old one.
          if (existing.scope.catalogHeadDigest !== authoritativeLocator.catalogHead) {
            existing.scope.catalogHeadDigest = authoritativeLocator.catalogHead
            existing.scope.catalogAuthorizationStateDigest = null
            existing.scope.catalogCursor = null
            existing.scope.catalogResumeCursor = null
            existing.scope.catalogPreviousPageDigest = null
          }
          existing.scope.catalogComplete = false
          void syncPublisherCatalog(existing.scope).catch(error => {
            recordProtocolError(existing.scope, 'bootstrap-refresh', error)
          })
        }
        return { ...existing.result, status: 'already-following' }
      }
    }
    if (!catalogRegistry?.bindNamespace) fail('catalog registry cannot bind verified namespaces')
    const binding = await catalogRegistry.bindNamespace(descriptor, { verifiedNamespaceProof })
    if (hex32(binding.catalogBootstrapKey, 'catalogBootstrapKey') !== b4a.toString(descriptor.catalogBootstrapKey, 'hex')) fail('catalog binding mismatch')
    await publisherManager.followPublisher(id)
    await binding.catalog?.openVerifiedPageView?.()
    const saved = await publisherSyncStateRepository?.load?.(id)
    const restored = saved?.version === 1 && saved.publisherId === id &&
      saved.catalogEpoch === descriptor.catalogEpoch
      ? saved
      : null
    // A fresher signed head invalidates a persisted cursor for the superseded head.
    const advertisedHead = authoritativeLocator?.catalogHead || null
    const resumable = !advertisedHead || !restored?.headDigest || restored.headDigest === advertisedHead
    const topic = derivePublisherTopic({ publisherId: id, catalogEpoch: descriptor.catalogEpoch })
    const { scope } = joinScope({
      purpose: 'publisher',
      topic,
      scopeId: id,
      mode: 'followed',
      publisherId: id,
      descriptor,
      binding,
      namespaceProofVerified: null,
      catalogPagePending: null,
      catalogSyncing: null,
      catalogCursor: null,
      catalogResumeCursor: resumable ? (restored?.cursor || null) : null,
      catalogPreviousPageDigest: null,
      catalogHeadDigest: resumable ? (restored?.headDigest || advertisedHead) : advertisedHead,
      catalogAuthorizationStateDigest: resumable ? (restored?.authorizationStateDigest || null) : null,
      advertisedCatalogHead: authoritativeLocator?.catalogHead || null,
      advertisedAuthorizationStateDigest: authoritativeLocator?.authorizationChainDigest || null,
      advertisedLocatorSignerId: authoritativeLocator?.signerId || null,
      advertisedLocatorIssuedAt: authoritativeLocator?.issuedAt || null,
      catalogComplete: restored?.complete === true &&
        (!authoritativeLocator || restored?.headDigest === authoritativeLocator.catalogHead),
      catalogBudget: restoreCatalogBudget(restored?.budget),
      catalogInitialHeadLength: 0,
      catalogVerifiedPages: 0,
      catalogVerifiedRecords: 0,
      catalogVerifiedBytes: 0,
      catalogVerificationWork: 0,
    })
    scope.publisherId = id
    scope.descriptor = descriptor
    scope.binding = binding
    Object.assign(scope, {
      namespaceProofVerified: null,
      catalogPagePending: null,
      catalogSyncing: null,
      catalogCursor: null,
      catalogResumeCursor: restored?.cursor || null,
      catalogPreviousPageDigest: null,
      catalogHeadDigest: restored?.headDigest || authoritativeLocator?.catalogHead || null,
      catalogAuthorizationStateDigest: restored?.authorizationStateDigest || null,
      advertisedCatalogHead: authoritativeLocator?.catalogHead || null,
      advertisedAuthorizationStateDigest: authoritativeLocator?.authorizationChainDigest || null,
      advertisedLocatorSignerId: authoritativeLocator?.signerId || null,
      advertisedLocatorIssuedAt: authoritativeLocator?.issuedAt || null,
      catalogComplete: restored?.complete === true &&
        (!authoritativeLocator || restored?.headDigest === authoritativeLocator.catalogHead),
      catalogBudget: restoreCatalogBudget(restored?.budget),
      catalogInitialHeadLength: 0,
      catalogVerifiedPages: 0,
      catalogVerifiedRecords: 0,
      catalogVerifiedBytes: 0,
      catalogVerificationWork: 0,
    })
    const result = { status: 'following', publisherId: id, catalogBootstrapKey: hex32(binding.catalogBootstrapKey, 'catalogBootstrapKey'), topic: stableScopeDiagnostic(scope) }
    followedPublishers.set(id, { scope, result })
    if (previousFollow) {
      await leaveScope(previousFollow.scope, 'followed')
    }
    if ([...scope.sessions.values()].some(session => !session.closed && session.state === 'active')) {
      void syncPublisherCatalog(scope).catch(error => {
        recordProtocolError(scope, 'bootstrap-promotion', error)
      })
    }
    return result
  }

  // Bootstrap metadata only identifies an untrusted candidate. A caller may
  // supply the bounded namespace proof collected from that publisher topic;
  // this is the sole route from candidate metadata to catalog binding.
  async function followBootstrapLocator ({ publisherId, proof = null } = {}) {
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
    try {
      namespaceProof = proof || await requestNamespaceProof(scope)
      verified = verifyPublisherNamespaceProof({ locator, ...namespaceProof })
    } catch (error) {
      await leaveScope(scope, 'candidate')
      const rejected = new Error(error?.message || 'namespace proof rejected')
      rejected.code = 'PUBLISHER_NAMESPACE_PROOF_REJECTED'
      throw rejected
    }
    const result = await followPublisher({
      publisherId: id,
      namespaceDescriptor: verified.descriptor,
      verifiedNamespaceProof: verified.descriptor.catalogEpoch > 0 ? namespaceProof : null,
      verifiedBootstrapLocator: locator,
      locatorAuthority: verifiedLocatorAuthority,
    })
    await leaveScope(scope, 'candidate')
    return result
  }

  async function providePublisherNamespaceProof ({ locator, proof } = {}) {
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

  async function provideLocalPublisherNamespaceProof ({ publisherId, descriptor, catalog } = {}) {
    const id = hex32(publisherId, 'publisherId')
    let genesis = null
    const transitions = []
    if (typeof catalog?.listAcceptedPage !== 'function') fail('local catalog accepted pages are unavailable for namespace proof')
    let cursor = null
    let scanned = 0
    do {
      const page = await catalog.listAcceptedPage({ cursor, limit: MAX_CATALOG_PAGE_RECORDS })
      if (!page || !Array.isArray(page.entries) || page.entries.length > MAX_CATALOG_PAGE_RECORDS) fail('local catalog namespace proof page is invalid')
      for (const entry of page.entries) {
        const operation = decodePublisherCatalogFrame(entry.frame)
        scanned++
        if (scanned > MAX_CATALOG_SESSION_RECORDS) fail('local catalog namespace proof scan exceeds bounded limit')
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
    publisherProofProviders.set(id, { genesis, transitions })
    publisherPageProviders.set(id, { catalog, catalogEpoch: descriptor.catalogEpoch })
    const topic = derivePublisherTopic({ publisherId: id, catalogEpoch: descriptor.catalogEpoch })
    const { scope } = joinScope({ purpose: 'publisher', topic, scopeId: id, mode: 'local', publisherId: id, proofPending: null })
    return { status: 'provided', publisherId: id, topic: stableScopeDiagnostic(scope) }
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

  async function publishLocalPublisherCatalog ({ publisherId, retentionClass: requestedRetentionClass } = {}) {
    const retentionClass = normalizeRetentionClass(requestedRetentionClass)
    if (!retentionClassAllowed(retentionClass) || !policy.uploadAllowed) {
      if (retentionClass === 'contribution-cache') {
        fail('explicit contribution upload permission is required')
      }
      fail('explicit archive upload permission is required')
    }
    if (policy.status !== 'active') fail('runtime is not active')
    const id = hex32(publisherId, 'publisherId')
    const existing = localPublishers.get(id)
    if (existing) {
      existing.scope.retentionClasses ??= new Set()
      existing.scope.retentionClasses.add(retentionClass)
      await rejoinScopeDiscovery(existing.scope)
      return rebindLocalPublisherCatalog({ publisherId: id })
    }
    if (!catalogRegistry?.resolve) fail('catalog registry is unavailable')
    const binding = await catalogRegistry.resolve(b4a.from(id, 'hex'))
    await binding.catalog?.ready?.()
    if (typeof binding.catalog?.listProjections !== 'function') fail('local catalog projection is unavailable')
    const [publications, claims] = await Promise.all([
      binding.catalog.listProjections('publication', { limit: 1 }),
      binding.catalog.listProjections('claim', { limit: 1 })
    ])
    if ((publications?.items?.length || 0) === 0 && (claims?.items?.length || 0) === 0) {
      fail('local catalog has no accepted publication or claim')
    }
    const descriptorEntry = await binding.catalog?.view?.get?.('state/descriptor')
    const descriptor = normalizeNamespace(descriptorEntry?.value || binding.namespaceDescriptor, protocolMajor, {
      verifiedNamespaceProof: descriptorEntry?.value ? true : null,
    })
    if (b4a.toString(descriptor.publisherId, 'hex') !== id) fail('local catalog namespace mismatch')
    if (hex32(binding.catalogBootstrapKey, 'catalogBootstrapKey') !== b4a.toString(descriptor.catalogBootstrapKey, 'hex')) fail('local catalog binding mismatch')
    binding.namespaceDescriptor = descriptor
    const topic = derivePublisherTopic({ publisherId: id, catalogEpoch: descriptor.catalogEpoch })
    const { scope } = joinScope({
      purpose: 'publisher',
      topic,
      scopeId: id,
      mode: 'local',
      publisherId: id,
      descriptor,
      binding,
      retentionClasses: new Set([retentionClass]),
    })
    scope.publisherId = id
    scope.descriptor = descriptor
    scope.binding = binding
    scope.retentionClasses ??= new Set()
    scope.retentionClasses.add(retentionClass)
    if (typeof binding.catalog?.listAcceptedPage === 'function') {
      await provideLocalPublisherNamespaceProof({ publisherId: id, descriptor, catalog: binding.catalog })
    }
    const result = {
      status: 'published',
      publisherId: id,
      catalogBootstrapKey: hex32(binding.catalogBootstrapKey, 'catalogBootstrapKey'),
      catalogEpoch: descriptor.catalogEpoch,
      topic: stableScopeDiagnostic(scope),
    }
    localPublishers.set(id, { scope, result })
    if (hasBootstrapLocatorKeyPair) await bootstrapRuntime.refreshLocalBootstrapLocator(id)
    return result
  }

  async function rebindLocalPublisherCatalog ({ publisherId } = {}) {
    if (policy.status !== 'active') fail('runtime is not active')
    const id = hex32(publisherId, 'publisherId')
    const existing = localPublishers.get(id)
    if (!existing) return publishLocalPublisherCatalog({ publisherId: id })
    const binding = await catalogRegistry.resolve(b4a.from(id, 'hex'))
    await binding.catalog?.ready?.()
    const descriptorEntry = await binding.catalog?.view?.get?.('state/descriptor')
    const descriptor = normalizeNamespace(descriptorEntry?.value || binding.namespaceDescriptor, protocolMajor, {
      verifiedNamespaceProof: descriptorEntry?.value ? true : null,
    })
    const previous = existing.scope.descriptor
    const changed = descriptor.catalogEpoch !== previous.catalogEpoch ||
      !b4a.equals(descriptor.publisherRootKey, previous.publisherRootKey) ||
      !b4a.equals(descriptor.catalogBootstrapKey, previous.catalogBootstrapKey)
    if (!changed) {
      binding.namespaceDescriptor = descriptor
      existing.scope.descriptor = descriptor
      existing.scope.binding = binding
      await provideLocalPublisherNamespaceProof({ publisherId: id, descriptor, catalog: binding.catalog })
      if (hasBootstrapLocatorKeyPair) await bootstrapRuntime.refreshLocalBootstrapLocator(id)
      existing.result = {
        ...existing.result,
        catalogEpoch: descriptor.catalogEpoch,
        topic: stableScopeDiagnostic(existing.scope),
      }
      return { ...existing.result, status: 'refreshed' }
    }

    bootstrapRuntime.removeLocalLocator(id)
    publisherProofProviders.delete(id)
    publisherPageProviders.delete(id)
    localPublishers.delete(id)
    existing.scope.retired = true
    existing.scope.modes.add('rotation-drain')
    // Batch new epoch, locator, and old-channel retirement per connection.
    const result = await withBatchedConnectionWrites(async () => {
      const published = await publishLocalPublisherCatalog({ publisherId: id })
      await leaveScope(existing.scope, 'local')
      return published
    })
    const timer = schedulePublisherRotationDrain(() => {
      publisherRotationDrainTimers.delete(timer)
      void leaveScope(existing.scope, 'rotation-drain')
    }, publisherRotationDrainMs)
    timer.unref?.()
    publisherRotationDrainTimers.add(timer)
    return { ...result, status: 'rebound' }
  }

  async function resolveLocalPublisherCatalog ({ publisherId } = {}) {
    const id = hex32(publisherId, 'publisherId')
    if (!catalogRegistry?.resolve) return { status: 'unavailable', publisherId: id }
    try {
      const binding = await catalogRegistry.resolve(b4a.from(id, 'hex'))
      await binding.catalog?.ready?.()
      const descriptorEntry = await binding.catalog?.view?.get?.('state/descriptor')
      const descriptor = binding.namespaceDescriptor || (descriptorEntry?.value ? normalizeNamespace(descriptorEntry.value, protocolMajor) : null)
      return {
        status: 'available',
        catalogBootstrapKey: hex32(binding.catalogBootstrapKey, 'catalogBootstrapKey'),
        catalogEpoch: descriptor?.catalogEpoch ?? null,
        writable: Boolean(binding.catalog?.writable),
      }
    } catch {
      return { status: 'unavailable', publisherId: id }
    }
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
    closeFollowState, closeLocalState,
  }
}
