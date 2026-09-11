import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  MAX_ACQUISITION_ASSIGNMENT_TTL_MS,
  MAX_ACQUISITION_CLOCK_SKEW_MS,
  MAX_ACQUISITION_OFFER_TTL_MS,
  MAX_ACQUISITION_REQUEST_TTL_MS,
  ACQUISITION_BODY_VERSION,
  acquisitionBudgetWidens,
  acquisitionCancellationAllowed,
  decodeAcquisitionAssignment,
  decodeAcquisitionCancellation,
  decodeAcquisitionOffer,
  decodeAcquisitionProgress,
  decodeAcquisitionRequest,
  decodeAcquisitionResult,
  encodeAcquisitionAssignment,
  encodeAcquisitionCancellation,
  encodeAcquisitionOffer,
  encodeAcquisitionProgress,
  encodeAcquisitionRequest,
  encodeAcquisitionResult,
  encodeAssetBlockRequest,
  decodeAssetBlockRequest,
  encodeAssetBlockResponse,
  decodeAssetBlockResponse,
  encodeAssetBlockError,
  decodeAssetBlockError,
} from './frame.js'
import {
  encodeVerifiedBlockProof,
  decodeVerifiedBlockProof,
} from './block-protocol.js'
import { createAssetSession } from '../assets/asset-session.js'
const DISCOVERY_FRAME_TYPES = new Set([
  'acquisition-request',
  'acquisition-offer',
  'acquisition-assignment',
  'acquisition-cancel',
])
const WORK_FRAME_TYPES = new Set([
  'acquisition-progress',
  'acquisition-result',
  'acquisition-cancel',
  'acquisition-block-request',
  'acquisition-block-proof',
  'acquisition-block-chunk',
  'acquisition-block-unavailable',
])
const REQUIRED_SCOPED_METHODS = [
  'retainAcquisitionDiscovery',
  'releaseAcquisitionDiscovery',
  'retainAcquisitionAssignment',
  'releaseAcquisitionAssignment',
  'publishAcquisitionFrame',
  'getLocalTransportPeerId',
]
const REQUIRED_MANAGER_CALLBACKS = [
  'onRequest',
  'onOffer',
  'onAssignment',
  'onProgress',
  'onResult',
  'onCancellation',
]
const MAX_OFFERS_PER_REQUEST = 32
const MAX_REPLAY_RECORDS = 8192
const PROGRESS_INTERVAL_MS = 1000

function fail(message, code = 'ACQUISITION_NETWORK_REJECTED') {
  const error = new Error(message)
  error.code = code
  throw error
}

function hex32(value, name) {
  const bytes = typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
    ? b4a.from(value, 'hex')
    : b4a.from(value || [])
  if (bytes.byteLength !== 32) fail(`${name} must be 32-byte lowercase hex`)
  return b4a.toString(bytes, 'hex')
}

function safeNow(now) {
  const value = Number(now())
  if (!Number.isSafeInteger(value) || value < 1) fail('current time must be a positive safe integer')
  return value
}

function publicRecord(decoded, idName) {
  return Object.freeze({
    [idName]: decoded[idName],
    ...decoded.body,
    issuedAt: decoded.envelope.issuedAt,
    expiresAt: decoded.envelope.expiresAt,
  })
}

function minimumBudget(left, right) {
  return {
    maxSourceBytes: Math.min(left.maxSourceBytes, right.maxSourceBytes),
    maxOutputBytes: Math.min(left.maxOutputBytes, right.maxOutputBytes),
    maxNetworkBytes: Math.min(left.maxNetworkBytes, right.maxNetworkBytes),
    maxWallClockMs: Math.min(left.maxWallClockMs, right.maxWallClockMs),
  }
}

// Teardown ordering contract: every registered import owns a non-null drain
// promise from the moment it enters the assignment Set, so cancel is always
// synchronous and drain always waits on real settled work. Direct Set
// iteration is safe during cancel: records leave the Set only in their async
// cleanup, never synchronously, and no new imports enter an invalidated
// assignment.
function cancelAssignmentImports(state) {
  for (const tracked of state.activeImports) tracked.cancel()
}

async function drainAssignmentImports(state) {
  for (const tracked of [...state.activeImports]) {
    await tracked.promise.catch(() => {})
  }
}


function policyAllowsPublicAcquisition(terms) {
  const control = [
    terms?.policyVersion,
    terms?.consentVersion,
    terms?.migrationRequired,
    terms?.enabled,
    terms?.acceptPublicRequests,
    terms?.requesterMode,
  ]
  if (JSON.stringify(control) !== '[1,1,false,true,true,"public"]') return false
  return [
    'maxConcurrentJobs',
    'maxConcurrentPerRequester',
    'maxRequestBytes',
    'remainingAcquireBytes24h',
    'maxJobRuntimeMs',
    'sourceGrantTtlMs',
    'publicRequestsPerMinute',
  ].every(field => Number.isSafeInteger(terms[field]) && terms[field] > 0)
}

export function createAcquisitionNetwork(options = {}) {
  const scopedNetwork = options.scopedNetwork
  for (const method of REQUIRED_SCOPED_METHODS) {
    if (typeof scopedNetwork?.[method] !== 'function') fail(`scopedNetwork.${method} is required`)
  }
  const manager = options.manager
  for (const callback of REQUIRED_MANAGER_CALLBACKS) {
    if (typeof manager?.[callback] !== 'function') fail(`manager.${callback} is required`)
  }
  const keyPair = options.keyPair
  if (!keyPair?.publicKey || !keyPair?.secretKey) fail('Noise signing keyPair is required')
  const localId = hex32(keyPair.publicKey, 'keyPair.publicKey')
  const scopedLocalId = hex32(scopedNetwork.getLocalTransportPeerId(), 'scoped transport key')
  const policy = options.policy || {}
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const schedule = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout
  const cancelTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout
  const networkId = String(options.networkId || 'peartube-main')
  const localRequests = new Map()
  const remoteRequests = new Map()
  const localOffers = new Map()
  const remoteOffers = new Map()
  const offerIdsByRequest = new Map()
  const assignments = new Map()
  const pendingBlockTransfers = new Map()
  const replayNonces = new Map()
  const replayRecords = new Map()
  const requestRate = new Map()
  let terms = null
  let policyGeneration = null
  let discoveryServer = false
  let discoveryClient = false
  let started = false
  let closed = false
  let assetStore = options.store || null

  async function readTerms() {
    let value
    if (typeof policy.networkTerms === 'function') {
      value = await policy.networkTerms()
    } else if (typeof policy.getPolicy === 'function') {
      const current = await policy.getPolicy()
      const revision = typeof policy.getRevision === 'function' ? Number(policy.getRevision()) : 0
      value = {
        ...current,
        generation: Number.isSafeInteger(current?.generation)
          ? current.generation
          : (Number.isSafeInteger(revision) ? Math.max(0, revision) : 0),
        remainingAcquireBytes24h: Number.isSafeInteger(current?.remainingAcquireBytes24h)
          ? current.remainingAcquireBytes24h
          : (Number.isSafeInteger(current?.maxAcquireBytesPer24h) ? current.maxAcquireBytesPer24h : 0),
      }
    } else {
      value = policy
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('acquisition network policy terms are required')
    if (typeof value.getPolicy === 'function' || typeof value.admit === 'function') {
      fail('acquisition network policy terms unresolved; compose networkTerms from the policy runtime')
    }
    return value
  }

  function teardownRequest(requestId) {
    const id = hex32(requestId, 'requestId')
    const offerIds = new Set(offerIdsByRequest.get(id) || [])
    for (const [offerId, entry] of localOffers) {
      if (entry.offer.requestId === id) offerIds.add(offerId)
    }
    for (const [offerId, entry] of remoteOffers) {
      if (entry.offer.requestId === id) offerIds.add(offerId)
    }

    localRequests.delete(id)
    remoteRequests.delete(id)
    for (const offerId of offerIds) {
      localOffers.delete(offerId)
      remoteOffers.delete(offerId)
    }
    offerIdsByRequest.delete(id)
    return id
  }

  function teardownAllRequests() {
    const requestIds = new Set([
      ...localRequests.keys(),
      ...remoteRequests.keys(),
      ...offerIdsByRequest.keys(),
    ])
    for (const entry of localOffers.values()) requestIds.add(entry.offer.requestId)
    for (const entry of remoteOffers.values()) requestIds.add(entry.offer.requestId)
    for (const requestId of requestIds) teardownRequest(requestId)
  }

  async function invalidateAssignments(reasonCode) {
    const pending = [...assignments.values()]
    // Cancel every tracked import and drop every expiry timer synchronously so
    // a stalled first teardown cannot keep unrelated transfers running.
    for (const state of pending) {
      assignments.delete(state.assignment.assignmentId)
      if (state.timer) cancelTimer(state.timer)
      cancelAssignmentImports(state)
    }
    // A throwing manager callback must not abandon later states: finish every
    // serial release/drain, then propagate the first original error identity.
    let failed = false
    let firstError = null
    for (const state of pending) {
      try {
        await scopedNetwork.releaseAcquisitionAssignment({ assignmentId: state.assignment.assignmentId })
      } catch {
        // Policy invalidation still reaches the manager if transport teardown already won the race.
      }
      try {
        await manager.onCancellation({
          cancellation: Object.freeze({
            version: 1,
            requestId: state.assignment.requestId,
            assignmentId: state.assignment.assignmentId,
            actorId: localId,
            reasonCode,
            lastProgressSequence: state.lastProgressSequence,
          }),
          peerId: state.peerId,
        })
      } catch (error) {
        if (!failed) {
          failed = true
          firstError = error
        }
      } finally {
        // The owned import drains settle even when the manager callback throws.
        await drainAssignmentImports(state)
      }
    }
    teardownAllRequests()
    if (failed) throw firstError
  }

  async function refreshPolicy() {
    const next = await readTerms()
    const generation = Number(next.generation)
    if (!Number.isSafeInteger(generation) || generation < 0) fail('policy generation must be a non-negative safe integer')
    if (policyGeneration !== null && generation !== policyGeneration) {
      await invalidateAssignments('policy-changed')
    }
    policyGeneration = generation
    terms = next
    return next
  }

  function pruneReplay(current) {
    for (const [key, expiresAt] of replayNonces) if (expiresAt + MAX_ACQUISITION_CLOCK_SKEW_MS < current) replayNonces.delete(key)
    for (const [key, expiresAt] of replayRecords) if (expiresAt + MAX_ACQUISITION_CLOCK_SKEW_MS < current) replayRecords.delete(key)
  }

  function rememberReplay(decoded, current) {
    pruneReplay(current)
    const signer = b4a.toString(decoded.envelope.signer, 'hex')
    const nonce = `${signer}:${b4a.toString(decoded.envelope.nonce, 'hex')}`
    const recordId = b4a.toString(decoded.envelope.recordId, 'hex')
    if (replayNonces.has(nonce) || replayRecords.has(recordId)) fail('acquisition replay rejected', 'ACQUISITION_REPLAY')
    if (replayRecords.size >= MAX_REPLAY_RECORDS || replayNonces.size >= MAX_REPLAY_RECORDS) {
      fail('acquisition replay window is full', 'ACQUISITION_REPLAY_WINDOW_FULL')
    }
    const expiry = Math.max(decoded.envelope.expiresAt, current)
    replayNonces.set(nonce, expiry)
    replayRecords.set(recordId, expiry)
  }

  async function retainDiscovery({ server = discoveryServer, client = discoveryClient } = {}) {
    if (!server && !client) return null
    discoveryServer = server
    discoveryClient = client
    return scopedNetwork.retainAcquisitionDiscovery({
      networkId,
      server,
      client,
      onPeer: event => options.onPeer?.(event),
      onPeerClose: event => options.onPeerClose?.(event),
      onFrame: handleFrame,
    })
  }

  function enforcePublisherPolicy(request, currentTerms) {
    const allowed = currentTerms.allowedPublisherIds
    if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(request.publisherId)) {
      fail('request publisher is not allowed by acquisition policy', 'ACQUISITION_POLICY_REJECTED')
    }
    if (request.budget.maxSourceBytes > currentTerms.maxRequestBytes ||
        request.budget.maxOutputBytes > currentTerms.maxRequestBytes ||
        request.budget.maxSourceBytes > currentTerms.remainingAcquireBytes24h) {
      fail('request exceeds acquisition policy byte budget', 'ACQUISITION_BUDGET_EXCEEDED')
    }
    if (request.budget.maxWallClockMs > currentTerms.maxJobRuntimeMs) {
      fail('request exceeds acquisition policy runtime', 'ACQUISITION_BUDGET_EXCEEDED')
    }
  }

  function consumeRequestRate(peerId, current, currentTerms) {
    const floor = current - 60_000
    const entries = (requestRate.get(peerId) || []).filter(timestamp => timestamp > floor)
    if (entries.length >= currentTerms.publicRequestsPerMinute) {
      fail('request rate exceeds acquisition policy', 'ACQUISITION_POLICY_REJECTED')
    }
    entries.push(current)
    requestRate.set(peerId, entries)
  }

  function offerCount(requestId) {
    return offerIdsByRequest.get(requestId)?.size || 0
  }

  function rememberOffer(requestId, offerId) {
    let ids = offerIdsByRequest.get(requestId)
    if (!ids) {
      ids = new Set()
      offerIdsByRequest.set(requestId, ids)
    }
    if (!ids.has(offerId) && ids.size >= MAX_OFFERS_PER_REQUEST) fail('request offer limit exceeded')
    ids.add(offerId)
  }

  function validateOfferAgainstRequest(offer, request, current) {
    if (offer.requestId !== request.requestId) fail('offer requestId mismatch')
    if (offer.issuedAt > request.expiresAt || current > request.expiresAt) fail('offer arrived after request expiry')
    if (offer.expiresAt > request.expiresAt || offer.resultHoldUntil > request.resultHoldUntil) fail('offer widens request lifetime')
    if (acquisitionBudgetWidens(offer.acceptedBudget, request.budget)) fail('offer widens request budget')
  }

  function validateAssignmentContext(assignment, request, offer, current) {
    if (assignment.requestId !== request.requestId || assignment.offerId !== offer.offerId) fail('assignment references do not match')
    if (assignment.policyEpoch !== offer.policyEpoch) fail('assignment policyEpoch mismatch')
    if (assignment.requesterId !== request.requesterId || assignment.requesterTransportKey !== request.requesterTransportKey ||
        assignment.acquirerId !== offer.acquirerId || assignment.acquirerTransportKey !== offer.acquirerTransportKey ||
        assignment.publisherId !== request.publisherId || assignment.publicationIntentDigest !== request.publicationIntentDigest) {
      fail('assignment identity or intent mismatch')
    }
    if (assignment.issuedAt > request.expiresAt || assignment.issuedAt > offer.expiresAt ||
        current > request.expiresAt || current > offer.expiresAt) fail('assignment was not issued while request and offer were live')
    if (acquisitionBudgetWidens(assignment.budget, request.budget) ||
        acquisitionBudgetWidens(assignment.budget, offer.acceptedBudget)) fail('assignment widens negotiated budget')
    if (assignment.deadline > assignment.issuedAt + assignment.budget.maxWallClockMs ||
        assignment.deadline > assignment.issuedAt + MAX_ACQUISITION_ASSIGNMENT_TTL_MS ||
        assignment.resultHoldUntil > request.resultHoldUntil ||
        assignment.resultHoldUntil > offer.resultHoldUntil) fail('assignment widens negotiated lifetime')
  }

  function progressStateFor(assignmentId, peerId, role) {
    const state = assignments.get(assignmentId)
    if (!state || state.peerId !== peerId || state.role !== role) fail('assignment audience mismatch')
    if (state.terminal !== null) fail('assignment is terminal', 'ACQUISITION_REPLAY')
    return state
  }

  function validateProgress(progress, state, current) {
    const assignment = state.assignment
    if (progress.acquirerId !== assignment.acquirerId || progress.assignmentId !== assignment.assignmentId) fail('progress assignment identity mismatch')
    if (current > assignment.deadline || progress.observedAt > assignment.deadline) fail('progress arrived after assignment deadline')
    if (progress.sourceBytes > assignment.budget.maxSourceBytes || progress.outputBytes > assignment.budget.maxOutputBytes) {
      fail('progress exceeds assignment budget', 'ACQUISITION_BUDGET_EXCEEDED')
    }
    if (progress.sequence <= state.lastProgressSequence) fail('progress sequence replay rejected', 'ACQUISITION_REPLAY')
    if (state.totalBlocks !== null && progress.totalBlocks !== 0 && progress.totalBlocks !== state.totalBlocks) {
      fail('progress totalBlocks changed')
    }
    if (progress.totalBlocks !== 0 && state.totalBlocks === null) state.totalBlocks = progress.totalBlocks
    const terminal = progress.phase === 'result-ready' || progress.phase === 'failed'
    const phaseChanged = state.lastProgressPhase !== null && progress.phase !== state.lastProgressPhase
    if (!terminal && !phaseChanged && state.lastProgressAt > 0 && progress.observedAt - state.lastProgressAt < PROGRESS_INTERVAL_MS) {
      fail('progress rate exceeds one frame per second')
    }
  }

  function acceptProgress(progress, state) {
    state.lastProgressSequence = progress.sequence
    state.lastProgressPhase = progress.phase
    state.lastProgressAt = progress.observedAt
  }

  function validateResult(result, state, current) {
    const assignment = state.assignment
    if (result.requestId !== assignment.requestId || result.offerId !== assignment.offerId ||
        result.assignmentId !== assignment.assignmentId || result.acquirerId !== assignment.acquirerId ||
        result.publicationIntentDigest !== assignment.publicationIntentDigest) fail('result assignment identity mismatch')
    if (result.acquiredBytes > assignment.budget.maxOutputBytes || result.completedAt > assignment.deadline || current > assignment.deadline) {
      fail('result exceeds assignment deadline or budget')
    }
    if (result.availabilityUntil > assignment.resultHoldUntil) fail('result availability widens assignment hold')
    for (const asset of result.assets) {
      if (asset.core.byteLength > assignment.budget.maxOutputBytes) fail('result asset exceeds assignment output budget')
    }
  }

  async function armAssignment(assignment, peerId, role, availabilityUntil = null) {
    const existing = assignments.get(assignment.assignmentId)
    if (existing) {
      if (existing.peerId !== peerId || existing.role !== role) fail('assignment audience changed')
      return existing
    }
    const state = {
      assignment,
      peerId,
      role,
      timer: null,
      lastProgressSequence: 0,
      lastProgressPhase: null,
      lastProgressAt: 0,
      totalBlocks: null,
      terminal: null,
      availabilityUntil,
      hold: null,
      pendingHold: null,
      activeImports: new Set(),
    }
    assignments.set(assignment.assignmentId, state)
    await scopedNetwork.retainAcquisitionAssignment({
      assignmentId: assignment.assignmentId,
      peerId,
      server: role === 'worker',
      client: role === 'requester',
      onPeer: event => options.onPeer?.(event),
      onPeerClose: event => options.onPeerClose?.(event),
      onFrame: handleFrame,
    })
    armAssignmentExpiry(state)
    return state
  }

  function armAssignmentExpiry(state) {
    if (state.timer !== null) cancelTimer(state.timer)
    const expiresAt = state.availabilityUntil ?? state.assignment.deadline
    state.timer = schedule(() => expireAssignment(state).catch(() => {}), Math.max(1, expiresAt - safeNow(now)))
    state.timer?.unref?.()
  }

  async function expireAssignment(state) {
    if (closed || assignments.get(state.assignment.assignmentId) !== state) return
    const expiresAt = state.availabilityUntil ?? state.assignment.deadline
    if (safeNow(now) < expiresAt) return armAssignmentExpiry(state)
    if (state.terminal !== null || state.availabilityUntil !== null) return releaseAssignment(state)
    const cancellation = await cancel({
      assignmentId: state.assignment.assignmentId,
      requestId: state.assignment.requestId,
      reasonCode: 'deadline-exceeded',
      lastProgressSequence: state.lastProgressSequence,
    }, { notifyManager: true, skipPolicy: true })
    return cancellation
  }

  async function handleRequest(frame, peerId, current) {
    const decoded = await decodeAcquisitionRequest(frame.payload, { now: current, transportPeerId: peerId })
    const request = publicRecord(decoded, 'requestId')
    if (request.requesterTransportKey !== peerId) fail('request transport key mismatch')
    if (current > request.expiresAt) fail('request session binding expired')
    if (!policyAllowsPublicAcquisition(terms)) fail('public acquisition consent is disabled', 'ACQUISITION_POLICY_REJECTED')
    enforcePublisherPolicy(request, terms)
    consumeRequestRate(peerId, current, terms)
    rememberReplay(decoded, current)
    remoteRequests.set(request.requestId, { request, decoded, peerId })
    await manager.onRequest({ request, peerId })
    return { status: 'accepted', requestId: request.requestId }
  }

  async function handleOffer(frame, peerId, current) {
    const decoded = await decodeAcquisitionOffer(frame.payload, { now: current, transportPeerId: peerId })
    const offer = publicRecord(decoded, 'offerId')
    const retained = localRequests.get(offer.requestId)
    if (!retained) {
      // Stale offers for rotated/superseded requestIds are not local after recovery.
      fail('offer audience request is not local or was superseded', 'ACQUISITION_REQUEST_SUPERSEDED')
    }
    if (offer.acquirerTransportKey !== peerId) fail('offer transport key mismatch')
    if (current > offer.expiresAt) fail('offer session binding expired')
    validateOfferAgainstRequest(offer, retained.request, current)
    rememberOffer(offer.requestId, offer.offerId)
    rememberReplay(decoded, current)
    remoteOffers.set(offer.offerId, { offer, decoded, peerId })
    await manager.onOffer({ offer, peerId })
    return { status: 'accepted', offerId: offer.offerId }
  }

  async function handleAssignment(frame, peerId, current) {
    const decoded = await decodeAcquisitionAssignment(frame.payload, { now: current, transportPeerId: peerId })
    const assignment = publicRecord(decoded, 'assignmentId')
    if (assignment.requesterTransportKey !== peerId ||
        assignment.acquirerTransportKey !== scopedLocalId) fail('assignment audience mismatch')
    if (current > assignment.deadline) fail('assignment session binding expired')
    if (assignment.policyEpoch !== terms.generation) fail('assignment policy epoch is stale', 'ACQUISITION_POLICY_CHANGED')
    const retainedRequest = remoteRequests.get(assignment.requestId)
    const retainedOffer = localOffers.get(assignment.offerId)
    if (!retainedRequest || retainedRequest.peerId !== peerId || !retainedOffer || retainedOffer.peerId !== peerId) {
      fail('assignment references unknown request or offer')
    }
    validateAssignmentContext(assignment, retainedRequest.request, retainedOffer.offer, current)
    rememberReplay(decoded, current)
    await armAssignment(assignment, peerId, 'worker')
    localOffers.delete(assignment.offerId)
    await manager.onAssignment({ assignment, peerId })
    return { status: 'accepted', assignmentId: assignment.assignmentId }
  }

  async function handleProgress(frame, peerId, current) {
    const unverified = await decodeAcquisitionProgress(frame.payload, { now: current })
    const candidate = publicRecord(unverified, 'recordId')
    const state = progressStateFor(candidate.assignmentId, peerId, 'requester')
    const decoded = await decodeAcquisitionProgress(frame.payload, {
      now: current,
      transportPeerId: peerId,
      expectedTransportKey: state.assignment.acquirerTransportKey
    })
    const progress = publicRecord(decoded, 'recordId')
    validateProgress(progress, state, current)
    rememberReplay(decoded, current)
    acceptProgress(progress, state)
    await manager.onProgress({ progress, peerId })
    return { status: 'accepted', sequence: progress.sequence }
  }

  async function handleResult(frame, peerId, current) {
    const unverified = await decodeAcquisitionResult(frame.payload, { now: current })
    const candidate = publicRecord(unverified, 'recordId')
    const state = progressStateFor(candidate.assignmentId, peerId, 'requester')
    const decoded = await decodeAcquisitionResult(frame.payload, {
      now: current,
      transportPeerId: peerId,
      expectedTransportKey: state.assignment.acquirerTransportKey
    })
    const result = publicRecord(decoded, 'recordId')
    validateResult(result, state, current)
    rememberReplay(decoded, current)
    state.terminal = 'result'
    state.availabilityUntil = result.availabilityUntil
    armAssignmentExpiry(state)
    try {
      await manager.onResult({ result, peerId })
      return { status: 'accepted', assignmentId: result.assignmentId }
    } finally {
      await releaseAssignment(state)
    }
  }

  async function handleCancellation(frame, peerId, current) {
    const unverified = await decodeAcquisitionCancellation(frame.payload, { now: current })
    const candidate = publicRecord(unverified, 'recordId')
    let actorRole = null
    let boundAppId = null
    let boundTransportKey = null
    let state = null
    let requestEntry = null

    if (candidate.assignmentId !== null) {
      state = assignments.get(candidate.assignmentId)
      if (!state || state.peerId !== peerId) fail('cancellation assignment audience mismatch')
      if (state.terminal !== null) fail('assignment is terminal', 'ACQUISITION_REPLAY')
      if (candidate.requestId !== state.assignment.requestId || candidate.lastProgressSequence !== state.lastProgressSequence) {
        fail('cancellation assignment state mismatch')
      }
      if (peerId === state.assignment.requesterTransportKey) {
        actorRole = 'requester'
        boundAppId = state.assignment.requesterId
        boundTransportKey = state.assignment.requesterTransportKey
      } else if (peerId === state.assignment.acquirerTransportKey) {
        actorRole = 'worker'
        boundAppId = state.assignment.acquirerId
        boundTransportKey = state.assignment.acquirerTransportKey
      } else {
        fail('cancellation transport peer is not bound to assignment')
      }
    } else {
      requestEntry = localRequests.get(candidate.requestId) || remoteRequests.get(candidate.requestId)
      if (!requestEntry) fail('cancellation request audience mismatch')
      if (peerId !== requestEntry.request.requesterTransportKey) fail('cancellation request audience mismatch')
      actorRole = 'requester'
      boundAppId = requestEntry.request.requesterId
      boundTransportKey = requestEntry.request.requesterTransportKey
    }

    if (!acquisitionCancellationAllowed(candidate.reasonCode, actorRole)) {
      fail('cancellation reason is not authorized for actor')
    }

    const decoded = await decodeAcquisitionCancellation(frame.payload, {
      now: current,
      transportPeerId: peerId,
      expectedTransportKey: boundTransportKey
    })
    const cancellation = publicRecord(decoded, 'recordId')

    if (cancellation.actorId !== boundAppId) {
      fail('cancellation actor is not bound application authority')
    }

    rememberReplay(decoded, current)
    if (state) await releaseAssignment(state)
    teardownRequest(cancellation.requestId)
    await manager.onCancellation({ cancellation, peerId })
    return { status: 'accepted', assignmentId: cancellation.assignmentId }
  }

  async function handleFrame(frame, context = {}) {
    if (closed) fail('acquisition network is closed')
    const peerId = hex32(context.peerId, 'peerId')
    const purpose = String(context.purpose || '')
    if (purpose === 'acquisition-discovery' && !DISCOVERY_FRAME_TYPES.has(frame.type)) fail('wrong acquisition discovery frame type')
    if (purpose === 'acquisition' && !WORK_FRAME_TYPES.has(frame.type)) fail('wrong acquisition work frame type')
    if (purpose !== 'acquisition-discovery' && purpose !== 'acquisition') fail('wrong acquisition frame purpose')
    await refreshPolicy()
    const current = safeNow(now)
    if (frame.type === 'acquisition-request') return handleRequest(frame, peerId, current)
    if (frame.type === 'acquisition-offer') return handleOffer(frame, peerId, current)
    if (frame.type === 'acquisition-assignment') return handleAssignment(frame, peerId, current)
    if (frame.type === 'acquisition-progress') return handleProgress(frame, peerId, current)
    if (frame.type === 'acquisition-result') return handleResult(frame, peerId, current)
    if (frame.type === 'acquisition-cancel') return handleCancellation(frame, peerId, current)
    if (frame.type === 'acquisition-block-request') return handleBlockRequest(frame, peerId, current, context)
    if (frame.type === 'acquisition-block-proof' || frame.type === 'acquisition-block-chunk' || frame.type === 'acquisition-block-unavailable') {
      return handleBlockResponse(frame, peerId, current, context)
    }
    fail('unsupported acquisition frame type')
  }

  function coreRefFromAsset (asset) {
    if (!asset || typeof asset !== 'object') fail('asset must be an object')
    return {
      kind: asset.kind || 'static-prologue-v1',
      assetId: hex32(asset.assetId, 'assetId'),
      key: hex32(asset.key, 'key'),
      treeHash: hex32(asset.treeHash, 'treeHash'),
      length: Number(asset.length),
      byteLength: Number(asset.byteLength),
      blockSize: Number(asset.blockSize),
    }
  }

  function sameCoreRef (a, b) {
    if (!a || !b) return false
    return a.kind === b.kind &&
      a.assetId === b.assetId &&
      a.key === b.key &&
      a.treeHash === b.treeHash &&
      a.length === b.length &&
      a.byteLength === b.byteLength &&
      a.blockSize === b.blockSize
  }

  function isExactHoldMatch (existing, coreRef, until, core) {
    if (!existing) return false
    if (existing.availabilityUntil !== until) return false
    if (!sameCoreRef(existing.asset, coreRef)) return false
    if (core !== null && existing.core !== core && existing.suppliedCore !== core) return false
    if (core === null && existing.suppliedCore != null) return false
    return true
  }

  function closeHeldAsset(hold) {
    if (hold.timer !== null) {
      cancelTimer(hold.timer)
      hold.timer = null
    }
    if (hold.closing === null) hold.closing = Promise.resolve().then(() => hold.session?.close())
    return hold.closing
  }
  async function drainPredecessorHold (predecessorPending, predecessorHold, state) {
    if (predecessorPending) {
      await predecessorPending.promise.catch(() => {})
    }
    if (predecessorHold) {
      if (state.hold === predecessorHold) state.hold = null
      await closeHeldAsset(predecessorHold).catch(() => {})
    }
  }

  function assertPendingHoldRetained (pending, state, id) {
    if (pending.cancelled || state.pendingHold !== pending || closed || assignments.get(id) !== state) {
      fail('worker assignment is not retained')
    }
  }

  function setupHoldTimer (hold, state) {
    const delay = Math.max(1, hold.availabilityUntil - safeNow(now))
    const timer = schedule(() => {
      if (state.hold === hold) {
        return closeHeldAsset(hold).finally(() => {
          if (state.hold === hold) state.hold = null
        }).catch(() => {})
      }
    }, delay)
    timer?.unref?.()
    hold.timer = timer
  }


  async function holdVerifiedAsset ({ assignmentId, asset, availabilityUntil, core = null } = {}) {
    if (closed) fail('acquisition network is closed')
    const id = hex32(assignmentId, 'assignmentId')
    const state = assignments.get(id)
    if (!state || state.role !== 'worker') fail('worker assignment is not retained')
    if (state.terminal !== null && state.terminal !== 'result') fail('assignment is terminal', 'ACQUISITION_REPLAY')

    const coreRef = coreRefFromAsset(asset)
    const until = Number(availabilityUntil)
    if (!Number.isSafeInteger(until)) fail('hold availabilityUntil is invalid')
    const current = safeNow(now)
    if (current >= until) fail('hold availability has already expired')
    if (until > state.assignment.resultHoldUntil) fail('hold availability exceeds assignment resultHoldUntil')

    if (state.pendingHold && isExactHoldMatch(state.pendingHold, coreRef, until, core)) {
      return await state.pendingHold.promise
    }

    if (!state.pendingHold && state.hold && isExactHoldMatch(state.hold, coreRef, until, core)) {
      return state.hold
    }

    // Reserve replacement ownership synchronously before awaits
    const predecessorPending = state.pendingHold
    const predecessorHold = state.hold
    let stopReadiness
    const stopped = new Promise(resolve => { stopReadiness = resolve })

    const pending = {
      assignmentId: id,
      asset: coreRef,
      availabilityUntil: until,
      suppliedCore: core,
      session: null,
      cancelled: false,
      promise: null,
      cancel() { this.cancelled = true; stopReadiness() },
    }
    state.pendingHold = pending

    if (predecessorPending) {
      predecessorPending.cancel()
    }
    if (predecessorHold?.timer) {
      cancelTimer(predecessorHold.timer)
      predecessorHold.timer = null
    }

    pending.promise = (async () => {
      let session = null
      let settledHold = null
      try {
        await drainPredecessorHold(predecessorPending, predecessorHold, state)
        assertPendingHoldRetained(pending, state, id)

        if (assetStore || core) {
          session = createAssetSession({ coreRef, store: assetStore, core, ownsCore: false })
          pending.session = session
          await Promise.race([session.ready(), stopped])
        }

        assertPendingHoldRetained(pending, state, id)

        if (state.terminal !== null && state.terminal !== 'result') {
          fail('assignment is terminal', 'ACQUISITION_REPLAY')
        }

        if (safeNow(now) >= until) {
          fail('hold availability has already expired')
        }

        const hold = {
          assignmentId: id,
          asset: coreRef,
          availabilityUntil: until,
          session,
          core: session?.core || null,
          suppliedCore: core,
          timer: null,
          closing: null,
        }

        setupHoldTimer(hold, state)
        settledHold = hold
        state.hold = hold
        return hold
      } finally {
        if (!settledHold && session) {
          await session.close().catch(() => {})
        }
        if (state.pendingHold === pending) {
          state.pendingHold = null
        }
      }
    })()

    return await pending.promise
  }

  function validateHeldBlockRequest (state, peerId, hold, current, request) {
    if (!state || state.peerId !== peerId || state.role !== 'worker') {
      fail('assignment audience mismatch')
    }
    if (state.terminal !== null && state.terminal !== 'result') {
      fail('assignment is terminal', 'ACQUISITION_REPLAY')
    }
    if (!hold || current >= hold.availabilityUntil) {
      fail('block request after assignment hold expired')
    }
    if (!hold?.core && !hold?.session) {
      fail('worker has no held verified asset for assignment')
    }
    const assetId = b4a.toString(request.assetId, 'hex')
    if (assetId !== hold.asset.assetId) {
      fail('block request asset does not match held result')
    }
  }

  async function serveVerifiedBlockRange ({ core, hold, request, assignmentId, peerId }) {
    for (let index = request.startBlock; index < request.endBlock; index++) {
      const proof = await core.proof({ block: { index, nodes: 0 }, upgrade: { start: 0, length: hold.asset.length } })
      const value = b4a.from(proof.block?.value || await core.get(index))
      const proofBytes = encodeVerifiedBlockProof({
        index,
        proof,
        value,
        coreKey: hold.asset.key,
        label: 'acquisition',
      })
      const proofPayload = encodeAssetBlockResponse({
        assetId: hold.asset.assetId,
        transferId: request.transferId,
        startBlock: request.startBlock,
        endBlock: request.endBlock,
        blockIndex: index,
        kind: 'proof',
        offset: 0,
        totalBytes: proofBytes.byteLength,
        chunk: proofBytes,
      })
      scopedNetwork.publishAcquisitionFrame({
        purpose: 'acquisition',
        type: 'acquisition-block-proof',
        assignmentId,
        peerId,
        payload: proofPayload,
      })
      // Chunk large blocks if needed.
      const maxChunk = 48 * 1024
      for (let offset = 0; offset < value.byteLength; offset += maxChunk) {
        const chunk = value.subarray(offset, Math.min(value.byteLength, offset + maxChunk))
        const chunkPayload = encodeAssetBlockResponse({
          assetId: hold.asset.assetId,
          transferId: request.transferId,
          startBlock: request.startBlock,
          endBlock: request.endBlock,
          blockIndex: index,
          kind: 'block',
          offset,
          totalBytes: value.byteLength,
          chunk,
        })
        scopedNetwork.publishAcquisitionFrame({
          purpose: 'acquisition',
          type: 'acquisition-block-chunk',
          assignmentId,
          peerId,
          payload: chunkPayload,
        })
      }
    }
  }

  async function handleBlockRequest (frame, peerId, current, context = {}) {
    const request = decodeAssetBlockRequest(frame.payload)
    const assignmentId = hex32(context.assignmentId || context.scopeId || frame.assignmentId, 'assignmentId')
    const state = assignments.get(assignmentId)
    const hold = state?.hold
    validateHeldBlockRequest(state, peerId, hold, current, request)

    const core = hold.core || await hold.session.ready()
    await serveVerifiedBlockRange({ core, hold, request, assignmentId, peerId })
    return { status: 'served', startBlock: request.startBlock, endBlock: request.endBlock }
  }

  // A response frame settles a pending transfer only when it matches the exact
  // peer, assignment, asset, and requested range the transfer was negotiated for.
  function matchBlockTransfer (decoded, peerId, assignmentId) {
    const entry = pendingBlockTransfers.get(String(decoded.transferId))
    if (!entry || entry.settled) return null
    if (entry.peerId !== peerId || entry.assignmentId !== assignmentId) return null
    if (b4a.toString(decoded.assetId, 'hex') !== entry.coreRef.assetId) return null
    if (decoded.startBlock !== entry.startBlock || decoded.endBlock !== entry.endBlock) return null
    return entry
  }

  // Once-only settlement: the map entry is deleted only while it is still the
  // registered entry, the transfer detaches from its owning import, and the
  // promise resolves or rejects exactly once.
  function settleBlockTransfer (entry, error = null, value = undefined) {
    if (!entry || entry.settled) return false
    entry.settled = true
    if (pendingBlockTransfers.get(entry.key) === entry) pendingBlockTransfers.delete(entry.key)
    entry.import?.activeTransfers?.delete(entry)
    if (error) entry.reject(error)
    else entry.resolve(value)
    return true
  }

  function rejectBlockTransfer (entry, message, code = 'ACQUISITION_NETWORK_REJECTED') {
    return settleBlockTransfer(entry, Object.assign(new Error(message), { code }))
  }

  function blockTransferAlive (entry) {
    return !entry.settled && !closed && assignments.get(entry.assignmentId) === entry.state
  }

  async function handleBlockResponse (frame, peerId, current, context = {}) {
    const assignmentId = hex32(context.assignmentId || context.scopeId || frame.assignmentId, 'assignmentId')
    if (frame.type === 'acquisition-block-unavailable') {
      const decoded = decodeAssetBlockError(frame.payload)
      const entry = matchBlockTransfer(decoded, peerId, assignmentId)
      if (entry) {
        settleBlockTransfer(entry, Object.assign(new Error('acquisition block unavailable'), {
          code: decoded.code || 'ASSET_BLOCK_UNAVAILABLE',
        }))
      }
      return { status: 'unavailable' }
    }
    const response = decodeAssetBlockResponse(frame.payload)
    const entry = matchBlockTransfer(response, peerId, assignmentId)
    if (!entry) return { status: 'ignored' }
    try {
      if (response.kind === 'proof') {
        const metadata = decodeVerifiedBlockProof(response.chunk, {
          index: response.blockIndex,
          coreKey: entry.coreRef.key,
          label: 'acquisition',
        })
        entry.proofs.set(response.blockIndex, metadata)
        entry.blocks.set(response.blockIndex, { totalBytes: metadata.byteLength, chunks: new Map(), received: 0 })
        return { status: 'proof' }
      }
      if (response.kind === 'block') {
        const proofEntry = entry.proofs.get(response.blockIndex)
        const assembly = entry.blocks.get(response.blockIndex)
        if (!proofEntry || !assembly) fail('block chunk arrived before proof')
        if (assembly.totalBytes !== response.totalBytes) fail('block chunk totalBytes mismatch')
        if (assembly.received !== response.offset) fail('block chunk offset mismatch')
        assembly.chunks.set(response.offset, response.chunk)
        assembly.received += response.chunk.byteLength
        if (assembly.received === assembly.totalBytes) {
          const value = b4a.allocUnsafe(assembly.totalBytes)
          for (const [offset, chunk] of [...assembly.chunks.entries()].sort((a, b) => a[0] - b[0])) {
            b4a.copy(chunk, value, offset)
          }
          await entry.session.verifyBlock({
            index: response.blockIndex,
            proof: proofEntry.proof,
            value,
            peerId: entry.peerId,
            transferId: entry.transferId,
            isActive: () => blockTransferAlive(entry),
          })
          // A cancelled transfer must not be resurrected by a proof that was
          // already in flight when the entry settled.
          if (entry.settled) return { status: 'ignored' }
          entry.verified.add(response.blockIndex)
          if (entry.verified.size >= (entry.endBlock - entry.startBlock)) {
            settleBlockTransfer(entry, null, {
              verifiedBlockIndexes: [...entry.verified].sort((a, b) => a - b),
              byteLength: entry.coreRef.byteLength,
            })
          }
        }
        return { status: 'block' }
      }
      return { status: 'ignored' }
    } catch (error) {
      // Invalid or malformed proof data fails only this matching peer and
      // assignment context; the owned session is quarantined by the engine.
      settleBlockTransfer(entry, error)
      return { status: 'rejected' }
    }
  }

  function assertImportLive (tracked) {
    if (tracked.cancelled) throw tracked.error
    if (closed) fail('acquisition network is closed')
    if (assignments.get(tracked.assignmentId) !== tracked.state) fail('requester assignment is not retained')
  }

  async function importVerifiedAsset ({ assignmentId, asset, peerId, signal = null } = {}) {
    if (closed) fail('acquisition network is closed')
    if (!assetStore) fail('acquisition asset store is required for verified import')
    const id = hex32(assignmentId, 'assignmentId')
    const state = assignments.get(id)
    if (!state || state.role !== 'requester') fail('requester assignment is not retained')
    if (state.peerId !== hex32(peerId, 'peerId')) fail('import peer does not match assignment')
    const coreRef = coreRefFromAsset(asset)

    // Track the import on the retained assignment synchronously, before its
    // scheduled run can open a session, bound to the exact assignment identity
    // so release, expiry, and close can cancel and drain it.
    let stopReadiness
    const stopped = new Promise(resolve => { stopReadiness = resolve })
    const activeTransfers = new Set()
    const tracked = {
      assignmentId: id,
      state,
      cancelled: false,
      error: null,
      promise: null,
      activeTransfers,
      cancel () {
        if (this.cancelled) return
        this.cancelled = true
        this.error = Object.assign(new Error('import aborted'), { code: 'ACQUISITION_CANCELLED' })
        // settleBlockTransfer only removes the entry currently being visited,
        // which is safe during direct Set iteration; async cleanup adds nothing.
        for (const entry of activeTransfers) {
          settleBlockTransfer(entry, this.error)
        }
        stopReadiness()
      },
    }

    const onAbort = () => tracked.cancel()
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    const run = async () => {
      let session = null
      let sessionClosed = false
      const closeOwnedSession = () => {
        if (!session || sessionClosed) return Promise.resolve()
        sessionClosed = true
        return session.close().catch(() => {})
      }
      try {
        assertImportLive(tracked)
        session = createAssetSession({ coreRef, store: assetStore })
        // Readiness has no signal option: race it with cancellation and never
        // await an uncooperative readiness before closing the owned session.
        await Promise.race([session.ready(), stopped])
        assertImportLive(tracked)

        // Local complete hit: every block already verified.
        let missing = []
        for (let index = 0; index < coreRef.length; index++) {
          let has = false
          try {
            // isActive cannot interrupt a stalled core.has: race every local
            // check with the cancellation and assert liveness before reading
            // the result, so a cancelled race is never read as a missing block.
            has = await Promise.race([
              session.hasVerifiedBlock(index, {
                isActive: () => { assertImportLive(tracked); return true },
              }),
              stopped,
            ])
          } catch {
            assertImportLive(tracked)
            // A genuine local check failure falls back to the network path.
          }
          assertImportLive(tracked)
          if (!has) missing.push(index)
        }
        if (missing.length === 0) {
          await closeOwnedSession()
          return { imported: true, byteLength: coreRef.byteLength, descriptor: coreRef }
        }

        // Pull missing contiguous runs from the assigned worker under assignment authority.
        while (missing.length > 0) {
          assertImportLive(tracked)
          const startBlock = missing[0]
          let endBlock = startBlock + 1
          while (missing.includes(endBlock)) endBlock++
          const transferId = crypto.randomBytes(8).readBigUInt64BE(0)
          const payload = encodeAssetBlockRequest({
            assetId: coreRef.assetId,
            transferId,
            startBlock,
            endBlock,
          })
          const outcome = await new Promise((resolve, reject) => {
            const entry = {
              key: String(transferId),
              import: tracked,
              assignmentId: id,
              state,
              peerId: hex32(peerId, 'peerId'),
              session,
              coreRef,
              startBlock,
              endBlock,
              transferId,
              proofs: new Map(),
              blocks: new Map(),
              verified: new Set(),
              settled: false,
              resolve,
              reject,
            }
            activeTransfers.add(entry)
            pendingBlockTransfers.set(entry.key, entry)
            let delivery = null
            try {
              delivery = scopedNetwork.publishAcquisitionFrame({
                purpose: 'acquisition',
                type: 'acquisition-block-request',
                assignmentId: id,
                peerId,
                payload,
              })
            } catch (error) {
              settleBlockTransfer(entry, error)
              return
            }
            if (!delivery || delivery.sent === 0) {
              rejectBlockTransfer(entry, 'acquisition block request was not delivered')
            }
          })
          assertImportLive(tracked)
          missing = missing.filter(index => index < startBlock || index >= endBlock || !outcome.verifiedBlockIndexes.includes(index))
        }

        for (let index = 0; index < coreRef.length; index++) {
          const has = await Promise.race([
            session.hasVerifiedBlock(index, {
              isActive: () => { assertImportLive(tracked); return true },
            }),
            stopped,
          ])
          // A cancelled race settles has as undefined: the cancellation guard
          // must throw before this exact check, so a cancelled import never
          // surfaces as a generic missing-block error.
          assertImportLive(tracked)
          if (!has) fail('imported asset missing verified block')
        }
        await closeOwnedSession()
        return { imported: true, byteLength: coreRef.byteLength, descriptor: coreRef }
      } finally {
        if (signal) signal.removeEventListener?.('abort', onAbort)
        await closeOwnedSession()
        state.activeImports.delete(tracked)
      }
    }

    // Set ownership synchronously: the drain promise and Set registration are
    // in place before the queued run executes or close can re-enter.
    tracked.promise = Promise.resolve().then(run)
    state.activeImports.add(tracked)
    return await tracked.promise
  }

  function validateRestoreAssignmentInput (input) {
    if (!input.requesterId || !input.acquirerId) fail('restore assignment requires durable requesterId and acquirerId')
    if (!input.budget || typeof input.budget !== 'object') fail('restore assignment requires durable negotiated budget')
    if (!input.requestId || !input.offerId) fail('restore assignment requires requestId and offerId')
    if (!input.publisherId || !input.publicationIntentDigest) fail('restore assignment requires publisher identity and intent')
    if (!Number.isSafeInteger(Number(input.deadline)) || Number(input.deadline) < 1) fail('restore assignment requires deadline')
    if (!Number.isSafeInteger(Number(input.resultHoldUntil)) || Number(input.resultHoldUntil) < 1) {
      fail('restore assignment requires resultHoldUntil')
    }
  }

  function validateRestoreAssignmentGenerations ({ input, role, currentTerms, policyEpoch }) {
    if (!Number.isSafeInteger(policyEpoch) || policyEpoch < 0) {
      fail('restore assignment policy generation is stale', 'ACQUISITION_POLICY_CHANGED')
    }
    if (role === 'worker' && policyEpoch !== currentTerms.generation) {
      fail('restore assignment policy epoch is stale for worker', 'ACQUISITION_POLICY_CHANGED')
    }
    if (role === 'requester') {
      const requestGeneration = Number(input.requestGeneration)
      if (!Number.isSafeInteger(requestGeneration) || requestGeneration !== currentTerms.generation) {
        fail('restore assignment request generation is stale', 'ACQUISITION_POLICY_CHANGED')
      }
    }
  }

  function parseRestoreAssignmentBudget (rawBudget) {
    const budget = {
      maxSourceBytes: Number(rawBudget.maxSourceBytes),
      maxOutputBytes: Number(rawBudget.maxOutputBytes),
      maxNetworkBytes: Number(rawBudget.maxNetworkBytes),
      maxWallClockMs: Number(rawBudget.maxWallClockMs),
    }
    for (const [key, value] of Object.entries(budget)) {
      if (!Number.isSafeInteger(value) || value < 1) fail(`restore assignment budget.${key} is invalid`)
    }
    return budget
  }

  function resolveRestoredResultAvailability (result, resultHoldUntil) {
    const availabilityUntil = result ? Number(result.availabilityUntil) : null
    if (availabilityUntil !== null &&
        (!Number.isSafeInteger(availabilityUntil) || availabilityUntil <= safeNow(now) || availabilityUntil > resultHoldUntil)) {
      fail('restored result availability is expired or exceeds the assignment hold')
    }
    return availabilityUntil
  }

  async function restoreWorkerAssetHold ({ role, result, assignmentId, resultHoldUntil }) {
    if (role !== 'worker' || !result?.assets?.[0]?.core) return
    const holdUntil = Number(result.availabilityUntil || resultHoldUntil)
    if (Number.isSafeInteger(holdUntil) && holdUntil >= safeNow(now) && holdUntil <= resultHoldUntil) {
      await holdVerifiedAsset({
        assignmentId,
        asset: result.assets[0].core,
        availabilityUntil: holdUntil,
      }).catch(() => {})
    }
  }

  async function restoreAssignment (input = {}) {
    if (closed) fail('acquisition network is closed')
    const currentTerms = await refreshPolicy()
    const assignmentId = hex32(input.assignmentId, 'assignmentId')
    const peerId = hex32(input.peerId, 'peerId')
    const role = input.role === 'worker' ? 'worker' : 'requester'

    validateRestoreAssignmentInput(input)
    const policyEpoch = Number(input.policyEpoch ?? input.epoch)
    validateRestoreAssignmentGenerations({ input, role, currentTerms, policyEpoch })
    const budget = parseRestoreAssignmentBudget(input.budget)

    const assignment = {
      assignmentId,
      requestId: hex32(input.requestId, 'requestId'),
      offerId: hex32(input.offerId, 'offerId'),
      deadline: Number(input.deadline),
      resultHoldUntil: Number(input.resultHoldUntil),
      publisherId: hex32(input.publisherId, 'publisherId'),
      publicationIntentDigest: hex32(input.publicationIntentDigest, 'publicationIntentDigest'),
      requesterId: hex32(input.requesterId, 'requesterId'),
      acquirerId: hex32(input.acquirerId, 'acquirerId'),
      policyEpoch,
      acquirerTransportKey: role === 'worker' ? scopedLocalId : peerId,
      requesterTransportKey: role === 'requester' ? scopedLocalId : peerId,
      budget,
    }

    const availabilityUntil = resolveRestoredResultAvailability(input.result, assignment.resultHoldUntil)
    await armAssignment(assignment, peerId, role, availabilityUntil)
    await restoreWorkerAssetHold({
      role,
      result: input.result,
      assignmentId,
      resultHoldUntil: assignment.resultHoldUntil,
    })

    return { assignmentId, role }
  }

  function dropLocalRequest (requestId) {
    if (requestId == null) return false
    const id = hex32(requestId, 'requestId')
    const existed = localRequests.has(id)
    teardownRequest(id)
    return existed
  }

  async function start() {
    if (closed) fail('acquisition network is closed')
    if (started) return { status: 'active', providerDiscovery: discoveryServer }
    const currentTerms = await refreshPolicy()
    started = true
    if (policyAllowsPublicAcquisition(currentTerms)) await retainDiscovery({ server: true, client: false })
    return { status: 'active', providerDiscovery: discoveryServer }
  }

  async function prepareRequest(input = {}) {
    if (closed) fail('acquisition network is closed')
    if (!started) await start()
    const currentTerms = await refreshPolicy()
    const issuedAt = safeNow(now)
    const expiresAt = Number(input.expiresAt ?? issuedAt + Math.min(MAX_ACQUISITION_REQUEST_TTL_MS, input.budget?.maxWallClockMs || MAX_ACQUISITION_REQUEST_TTL_MS))
    const generation = input.generation == null ? currentTerms.generation : Number(input.generation)
    if (!Number.isSafeInteger(generation) || generation !== currentTerms.generation) {
      fail('request policy generation is stale', 'ACQUISITION_POLICY_CHANGED')
    }
    const body = {
      version: ACQUISITION_BODY_VERSION,
      requesterId: localId,
      requesterTransportKey: scopedLocalId,
      publisherId: input.publisherId,
      sourceRef: input.sourceRef,
      publicationIntentDigest: input.publicationIntentDigest,
      generation,
      output: input.output,
      budget: input.budget,
      resultHoldUntil: input.resultHoldUntil,
    }
    const payload = encodeAcquisitionRequest({ body, keyPair, nonce: crypto.randomBytes(32), issuedAt, expiresAt })
    const decoded = await decodeAcquisitionRequest(payload, { now: issuedAt, transportPeerId: scopedLocalId })
    const request = publicRecord(decoded, 'requestId')
    return { request, decoded, payload }
  }

  async function dispatchRequest(prepared) {
    if (closed) fail('acquisition network is closed')
    const currentTerms = await refreshPolicy()
    if (prepared?.request?.generation !== currentTerms.generation) {
      fail('request policy generation is stale', 'ACQUISITION_POLICY_CHANGED')
    }
    // Persist-before-wire is the caller's duty; this only arms the live session map.
    localRequests.set(prepared.request.requestId, {
      request: prepared.request,
      decoded: prepared.decoded,
      payload: null, // nonce/signature bytes are intentionally not retained for crash recovery
      peerId: null,
    })
    await retainDiscovery({ server: policyAllowsPublicAcquisition(terms), client: true })
    const delivery = scopedNetwork.publishAcquisitionFrame({ purpose: 'acquisition-discovery', type: 'acquisition-request', payload: prepared.payload })
    return { request: prepared.request, delivery }
  }

  async function publishRequest(input = {}) {
    if (input.request && input.payload) return dispatchRequest(input)
    const prepared = await prepareRequest(input)
    return dispatchRequest(prepared)
  }

  async function publishOffer(input = {}) {
    if (closed) fail('acquisition network is closed')
    const currentTerms = await refreshPolicy()
    if (!policyAllowsPublicAcquisition(currentTerms)) fail('public acquisition consent is disabled', 'ACQUISITION_POLICY_REJECTED')
    const peerId = hex32(input.peerId, 'peerId')
    const requestId = hex32(input.requestId, 'requestId')
    const retained = remoteRequests.get(requestId)
    if (!retained || retained.peerId !== peerId) fail('offer request is not retained for peer')
    enforcePublisherPolicy(retained.request, currentTerms)
    if (offerCount(retained.request.requestId) >= MAX_OFFERS_PER_REQUEST) fail('request offer limit exceeded')
    let globalReservations = 0
    let requesterReservations = 0
    for (const offer of localOffers.values()) {
      globalReservations++
      if (offer.peerId === peerId) requesterReservations++
    }
    for (const assignment of assignments.values()) {
      if (assignment.role !== 'worker') continue
      globalReservations++
      if (assignment.peerId === peerId) requesterReservations++
    }
    if (globalReservations >= currentTerms.maxConcurrentJobs ||
        requesterReservations >= currentTerms.maxConcurrentPerRequester) {
      fail('acquisition concurrency policy is exhausted', 'ACQUISITION_POLICY_REJECTED')
    }
    const issuedAt = safeNow(now)
    const policyBudget = {
      maxSourceBytes: Math.min(currentTerms.maxRequestBytes, currentTerms.remainingAcquireBytes24h),
      maxOutputBytes: Math.min(currentTerms.maxRequestBytes, currentTerms.remainingAcquireBytes24h),
      maxNetworkBytes: Math.min(retained.request.budget.maxNetworkBytes, currentTerms.remainingAcquireBytes24h),
      maxWallClockMs: currentTerms.maxJobRuntimeMs,
    }
    const acceptedBudget = input.acceptedBudget || minimumBudget(retained.request.budget, policyBudget)
    if (acquisitionBudgetWidens(acceptedBudget, retained.request.budget) || acquisitionBudgetWidens(acceptedBudget, policyBudget)) {
      fail('offer widens request or policy budget')
    }
    const availableUntil = Math.min(
      Number(input.availableUntil ?? Number.MAX_SAFE_INTEGER),
      retained.request.expiresAt,
      issuedAt + Math.min(MAX_ACQUISITION_OFFER_TTL_MS, currentTerms.sourceGrantTtlMs, currentTerms.maxJobRuntimeMs),
    )
    const body = {
      version: ACQUISITION_BODY_VERSION,
      requestId: retained.request.requestId,
      acquirerId: localId,
      acquirerTransportKey: scopedLocalId,
      policyEpoch: currentTerms.generation,
      acceptedBudget,
      availableUntil,
      resultHoldUntil: Math.min(Number(input.resultHoldUntil ?? retained.request.resultHoldUntil), retained.request.resultHoldUntil),
      sourceCapabilityDigest: input.sourceCapabilityDigest,
    }
    const payload = encodeAcquisitionOffer({ body, keyPair, nonce: crypto.randomBytes(32), issuedAt, expiresAt: availableUntil })
    const decoded = await decodeAcquisitionOffer(payload, { now: issuedAt, transportPeerId: scopedLocalId })
    const offer = publicRecord(decoded, 'offerId')
    validateOfferAgainstRequest(offer, retained.request, issuedAt)
    rememberOffer(offer.requestId, offer.offerId)
    localOffers.set(offer.offerId, { offer, decoded, peerId })
    const delivery = scopedNetwork.publishAcquisitionFrame({ purpose: 'acquisition-discovery', type: 'acquisition-offer', peerId, payload })
    return { offer, delivery }
  }

  async function prepareAssignment(input = {}) {
    if (closed) fail('acquisition network is closed')
    const currentTerms = await refreshPolicy()
    const requestState = localRequests.get(hex32(input.requestId, 'requestId'))
    const offerState = remoteOffers.get(hex32(input.offerId, 'offerId'))
    if (!requestState || !offerState || offerState.offer.requestId !== requestState.request.requestId) fail('assignment request or offer is unknown')
    if (requestState.request.generation !== currentTerms.generation) {
      teardownRequest(requestState.request.requestId)
      fail('request policy generation is stale', 'ACQUISITION_POLICY_CHANGED')
    }
    const issuedAt = safeNow(now)
    const budget = input.budget || minimumBudget(requestState.request.budget, offerState.offer.acceptedBudget)
    const deadline = Math.min(
      Number(input.deadline ?? issuedAt + budget.maxWallClockMs),
      issuedAt + budget.maxWallClockMs,
      issuedAt + MAX_ACQUISITION_ASSIGNMENT_TTL_MS,
    )
    // The assignment negotiates the worker's offer epoch; the request's
    // generation remains a requester-local guard and is not substituted here.
    const epoch = offerState.offer.policyEpoch
    const body = {
      version: ACQUISITION_BODY_VERSION,
      requestId: requestState.request.requestId,
      offerId: offerState.offer.offerId,
      requesterId: localId,
      requesterTransportKey: scopedLocalId,
      acquirerId: offerState.offer.acquirerId,
      acquirerTransportKey: offerState.offer.acquirerTransportKey,
      publisherId: requestState.request.publisherId,
      publicationIntentDigest: requestState.request.publicationIntentDigest,
      policyEpoch: epoch,
      budget,
      deadline,
      resultHoldUntil: Math.min(requestState.request.resultHoldUntil, offerState.offer.resultHoldUntil),
    }
    const payload = encodeAcquisitionAssignment({ body, keyPair, nonce: crypto.randomBytes(32), issuedAt, expiresAt: deadline })
    const decoded = await decodeAcquisitionAssignment(payload, { now: issuedAt, transportPeerId: scopedLocalId })
    const assignment = publicRecord(decoded, 'assignmentId')
    validateAssignmentContext(assignment, requestState.request, offerState.offer, issuedAt)
    return { assignment, payload, peerId: offerState.peerId }
  }

  async function dispatchAssignment(prepared) {
    if (closed) fail('acquisition network is closed')
    const currentTerms = await refreshPolicy()
    const requestState = localRequests.get(prepared?.assignment?.requestId)
    if (!requestState || requestState.request.generation !== currentTerms.generation) {
      fail('assignment policy generation is stale', 'ACQUISITION_POLICY_CHANGED')
    }
    await armAssignment(prepared.assignment, prepared.peerId, 'requester')
    const delivery = scopedNetwork.publishAcquisitionFrame({
      purpose: 'acquisition-discovery',
      type: 'acquisition-assignment',
      peerId: prepared.peerId,
      payload: prepared.payload,
    })
    return { assignment: prepared.assignment, delivery }
  }

  async function assign(input = {}) {
    if (input.assignment && input.payload && input.peerId) {
      return dispatchAssignment(input)
    }
    const prepared = await prepareAssignment(input)
    return dispatchAssignment(prepared)
  }

  async function progress(input = {}) {
    if (closed) fail('acquisition network is closed')
    await refreshPolicy()
    const assignmentId = hex32(input.assignmentId, 'assignmentId')
    const state = assignments.get(assignmentId)
    if (!state || state.role !== 'worker') fail('worker assignment is not retained')
    const issuedAt = safeNow(now)
    const body = {
      version: ACQUISITION_BODY_VERSION,
      assignmentId,
      acquirerId: localId,
      sequence: input.sequence,
      phase: input.phase,
      sourceBytes: input.sourceBytes,
      outputBytes: input.outputBytes,
      verifiedBlocks: input.verifiedBlocks,
      totalBlocks: input.totalBlocks,
      observedAt: input.observedAt ?? issuedAt,
      errorCode: input.errorCode ?? null,
    }
    const payload = encodeAcquisitionProgress({ body, keyPair, nonce: crypto.randomBytes(32), issuedAt, expiresAt: state.assignment.deadline })
    const decoded = await decodeAcquisitionProgress(payload, { now: issuedAt, transportPeerId: scopedLocalId, expectedTransportKey: scopedLocalId })
    const record = publicRecord(decoded, 'recordId')
    validateProgress(record, state, issuedAt)
    acceptProgress(record, state)
    const delivery = scopedNetwork.publishAcquisitionFrame({ purpose: 'acquisition', type: 'acquisition-progress', assignmentId, peerId: state.peerId, payload })
    return { progress: record, delivery }
  }

  async function result(input = {}) {
    if (closed) fail('acquisition network is closed')
    await refreshPolicy()
    const assignmentId = hex32(input.assignmentId, 'assignmentId')
    const state = assignments.get(assignmentId)
    if (!state || state.role !== 'worker') fail('worker assignment is not retained')
    if (state.terminal !== null) fail('assignment is terminal', 'ACQUISITION_REPLAY')
    const issuedAt = safeNow(now)
    const body = {
      version: ACQUISITION_BODY_VERSION,
      requestId: state.assignment.requestId,
      offerId: state.assignment.offerId,
      assignmentId,
      acquirerId: localId,
      publicationIntentDigest: state.assignment.publicationIntentDigest,
      sourceIdentity: input.sourceIdentity,
      assets: input.assets,
      acquiredBytes: input.acquiredBytes,
      completedAt: input.completedAt ?? issuedAt,
      availabilityUntil: input.availabilityUntil,
    }
    const payload = encodeAcquisitionResult({ body, keyPair, nonce: crypto.randomBytes(32), issuedAt, expiresAt: body.availabilityUntil })
    const decoded = await decodeAcquisitionResult(payload, { now: issuedAt, transportPeerId: scopedLocalId, expectedTransportKey: scopedLocalId })
    const record = publicRecord(decoded, 'recordId')
    validateResult(record, state, issuedAt)
    const delivery = scopedNetwork.publishAcquisitionFrame({ purpose: 'acquisition', type: 'acquisition-result', assignmentId, peerId: state.peerId, payload })
    // No recipient is not a terminal result: the coordinator retains the exact
    // durable result and retries once the assignment peer is reachable again.
    if (delivery?.sent > 0) {
      state.terminal = 'result'
      state.availabilityUntil = record.availabilityUntil
      armAssignmentExpiry(state)
    }
    return { result: record, delivery }
  }

  async function releaseAssignment(state) {
    if (!state || assignments.get(state.assignment.assignmentId) !== state) return false
    assignments.delete(state.assignment.assignmentId)
    if (state.timer) {
      cancelTimer(state.timer)
      state.timer = null
    }
    // Cancel tracked imports before the awaited scope release so nothing keeps
    // running against a released assignment.
    cancelAssignmentImports(state)
    try {
      await scopedNetwork.releaseAcquisitionAssignment({ assignmentId: state.assignment.assignmentId })
    } finally {
      if (state.pendingHold) {
        state.pendingHold.cancel()
        await state.pendingHold.promise.catch(() => {})
        state.pendingHold = null
      }
      if (state.hold) {
        const hold = state.hold
        state.hold = null
        await closeHeldAsset(hold).catch(() => {})
      }
      await drainAssignmentImports(state)
    }
    return true
  }

  function assignmentForRequest(requestId) {
    for (const state of assignments.values()) {
      if (state.assignment.requestId === requestId) return state
    }
    return null
  }

  function resolveCancellationState (suppliedAssignmentId, suppliedRequestId) {
    if (suppliedAssignmentId !== null) {
      return assignments.get(suppliedAssignmentId) || null
    }
    if (suppliedRequestId !== null) {
      return assignmentForRequest(suppliedRequestId)
    }
    return null
  }

  function resolveCancellationActorRole (state, requestId) {
    if (state?.role === 'worker') return 'worker'
    if (state?.role === 'requester' || localRequests.has(requestId)) return 'requester'
    if (remoteRequests.has(requestId)) return 'worker'
    return 'requester'
  }

  function resolveCancellationPeerId (state, inputPeerId) {
    if (state?.peerId !== undefined && state?.peerId !== null) return state.peerId
    return inputPeerId == null ? null : hex32(inputPeerId, 'peerId')
  }

  function validateCancellationAuthorization (state, requestEntry, actorRole) {
    if (state && state.terminal !== null) {
      fail('assignment is terminal', 'ACQUISITION_REPLAY')
    }
    if (requestEntry && actorRole === 'requester' && requestEntry.request.requesterTransportKey !== scopedLocalId) {
      fail('cancellation requester identity is not local')
    }
  }

  function cancellationContext(input) {
    const suppliedAssignmentId = input.assignmentId == null ? null : hex32(input.assignmentId, 'assignmentId')
    const suppliedRequestId = input.requestId == null ? null : hex32(input.requestId, 'requestId')
    const state = resolveCancellationState(suppliedAssignmentId, suppliedRequestId)
    const requestId = suppliedRequestId || state?.assignment.requestId
    if (!requestId) fail('cancellation requestId is required')
    const assignmentId = state?.assignment.assignmentId || suppliedAssignmentId
    const requestEntry = localRequests.get(requestId) || remoteRequests.get(requestId)
    const actorRole = resolveCancellationActorRole(state, requestId)
    const peerId = resolveCancellationPeerId(state, input.peerId)
    const defaultReason = actorRole === 'worker' ? 'worker-cancelled' : 'requester-cancelled'
    const reasonCode = String(input.reasonCode || defaultReason)

    validateCancellationAuthorization(state, requestEntry, actorRole)
    return { assignmentId, state, requestId, actorRole, peerId, reasonCode }
  }


  async function cancel(input = {}, internal = {}) {
    if (closed && !internal.closing) fail('acquisition network is closed')
    if (!internal.skipPolicy) await refreshPolicy()
    const { assignmentId, state, requestId, actorRole, peerId, reasonCode } = cancellationContext(input)
    if (!acquisitionCancellationAllowed(reasonCode, actorRole)) fail('cancellation reason is not authorized for actor')
    const issuedAt = safeNow(now)
    const body = {
      version: ACQUISITION_BODY_VERSION,
      requestId,
      assignmentId,
      actorId: localId,
      reasonCode,
      lastProgressSequence: Number(input.lastProgressSequence ?? state?.lastProgressSequence ?? 0),
    }
    const expiresAt = issuedAt + MAX_ACQUISITION_OFFER_TTL_MS
    const payload = encodeAcquisitionCancellation({ body, keyPair, nonce: crypto.randomBytes(32), issuedAt, expiresAt })
    const decoded = await decodeAcquisitionCancellation(payload, { now: issuedAt, transportPeerId: scopedLocalId, expectedTransportKey: scopedLocalId })
    const cancellation = publicRecord(decoded, 'recordId')
    const purpose = assignmentId === null ? 'acquisition-discovery' : 'acquisition'
    try {
      const delivery = scopedNetwork.publishAcquisitionFrame({
        purpose,
        type: 'acquisition-cancel',
        assignmentId,
        peerId,
        payload,
      })
      return { cancellation, delivery }
    } finally {
      try {
        if (state) await releaseAssignment(state)
      } finally {
        teardownRequest(requestId)
        if (internal.notifyManager) await manager.onCancellation({ cancellation, peerId })
      }
    }
  }

  async function close() {
    if (closed) return { status: 'closed' }
    closed = true
    const active = [...assignments.values()]
    // Cancel every tracked import and reject every pending transfer before the
    // first awaited teardown, so a stalled first scope cannot keep unrelated
    // transfers running during terminal close.
    for (const state of active) cancelAssignmentImports(state)
    for (const entry of [...pendingBlockTransfers.values()]) {
      rejectBlockTransfer(entry, 'acquisition network is closed')
    }
    for (const state of active) {
      try {
        await cancel({
          assignmentId: state.assignment.assignmentId,
          requestId: state.assignment.requestId,
          reasonCode: 'shutdown',
          lastProgressSequence: state.lastProgressSequence,
        }, { closing: true, skipPolicy: true, notifyManager: true })
      } catch {
        await releaseAssignment(state).catch(() => {})
      }
    }
    if (discoveryServer || discoveryClient) await scopedNetwork.releaseAcquisitionDiscovery({ networkId })
    localRequests.clear()
    remoteRequests.clear()
    localOffers.clear()
    remoteOffers.clear()
    offerIdsByRequest.clear()
    replayNonces.clear()
    replayRecords.clear()
    requestRate.clear()
    return { status: 'closed' }
  }

  return {
    start,
    prepareRequest,
    dispatchRequest,
    publishRequest,
    publishOffer,
    prepareAssignment,
    dispatchAssignment,
    assign,
    progress,
    result,
    cancel,
    holdVerifiedAsset,
    importVerifiedAsset,
    restoreAssignment,
    dropLocalRequest,
    setAssetStore (store) { assetStore = store },
    close,
  }
}
