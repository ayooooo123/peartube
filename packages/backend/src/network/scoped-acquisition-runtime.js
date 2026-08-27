import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  MAX_ACQUISITION_ASSIGNMENT_TTL_MS,
  MAX_ACQUISITION_CLOCK_SKEW_MS,
  MAX_ACQUISITION_OFFER_TTL_MS,
  MAX_ACQUISITION_REQUEST_TTL_MS,
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
} from './frame.js'

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
  if (localId !== scopedLocalId) fail('acquisition signer must be the local Noise identity')

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
  const replayNonces = new Map()
  const replayRecords = new Map()
  const requestRate = new Map()
  let terms = null
  let policyGeneration = null
  let discoveryServer = false
  let discoveryClient = false
  let started = false
  let closed = false

  async function readTerms() {
    const value = typeof policy.networkTerms === 'function'
      ? await policy.networkTerms()
      : policy
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('acquisition network policy terms are required')
    return value
  }

  async function invalidateAssignments(reasonCode) {
    const pending = [...assignments.values()]
    assignments.clear()
    for (const state of pending) {
      if (state.timer) cancelTimer(state.timer)
      try {
        await scopedNetwork.releaseAcquisitionAssignment({ assignmentId: state.assignment.assignmentId })
      } catch {
        // Policy invalidation still reaches the manager if transport teardown already won the race.
      }
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
    }
  }

  async function refreshPolicy() {
    const next = await readTerms()
    const generation = Number(next.generation)
    if (!Number.isSafeInteger(generation) || generation < 0) fail('policy generation must be a non-negative safe integer')
    if (policyGeneration !== null && generation !== policyGeneration) {
      localOffers.clear()
      remoteOffers.clear()
      offerIdsByRequest.clear()
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

  async function armAssignment(assignment, peerId, role) {
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
    const delay = Math.max(1, assignment.deadline - safeNow(now))
    state.timer = schedule(() => expireAssignment(state).catch(() => {}), delay)
    state.timer?.unref?.()
    return state
  }

  async function expireAssignment(state) {
    if (closed || assignments.get(state.assignment.assignmentId) !== state) return
    if (state.terminal !== null) return releaseAssignment(state)
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
    if (request.requesterId !== peerId || request.requesterTransportKey !== peerId) fail('request Noise identity mismatch')
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
    if (!retained) fail('offer audience request is not local')
    if (offer.acquirerId !== peerId || offer.acquirerTransportKey !== peerId) fail('offer Noise identity mismatch')
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
    if (assignment.requesterId !== peerId || assignment.requesterTransportKey !== peerId ||
        assignment.acquirerId !== localId || assignment.acquirerTransportKey !== localId) fail('assignment audience mismatch')
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
    const decoded = await decodeAcquisitionProgress(frame.payload, { now: current, transportPeerId: peerId })
    const progress = publicRecord(decoded, 'recordId')
    const state = progressStateFor(progress.assignmentId, peerId, 'requester')
    validateProgress(progress, state, current)
    rememberReplay(decoded, current)
    acceptProgress(progress, state)
    await manager.onProgress({ progress, peerId })
    return { status: 'accepted', sequence: progress.sequence }
  }

  async function handleResult(frame, peerId, current) {
    const decoded = await decodeAcquisitionResult(frame.payload, { now: current, transportPeerId: peerId })
    const result = publicRecord(decoded, 'recordId')
    const state = progressStateFor(result.assignmentId, peerId, 'requester')
    validateResult(result, state, current)
    rememberReplay(decoded, current)
    state.terminal = 'result'
    try {
      await manager.onResult({ result, peerId })
      return { status: 'accepted', assignmentId: result.assignmentId }
    } finally {
      await releaseAssignment(state)
    }
  }

  async function handleCancellation(frame, peerId, current) {
    const decoded = await decodeAcquisitionCancellation(frame.payload, { now: current, transportPeerId: peerId })
    const cancellation = publicRecord(decoded, 'recordId')
    let actorRole
    let state = null
    if (cancellation.assignmentId !== null) {
      state = assignments.get(cancellation.assignmentId)
      if (!state || state.peerId !== peerId) fail('cancellation assignment audience mismatch')
      if (state.terminal !== null) fail('assignment is terminal', 'ACQUISITION_REPLAY')
      actorRole = peerId === state.assignment.requesterId ? 'requester' : peerId === state.assignment.acquirerId ? 'worker' : null
      if (cancellation.requestId !== state.assignment.requestId || cancellation.lastProgressSequence !== state.lastProgressSequence) {
        fail('cancellation assignment state mismatch')
      }
    } else {
      const request = localRequests.get(cancellation.requestId) || remoteRequests.get(cancellation.requestId)
      if (!request || request.peerId && request.peerId !== peerId) fail('cancellation request audience mismatch')
      actorRole = peerId === request.request.requesterId ? 'requester' : 'worker'
    }
    if (cancellation.actorId !== peerId || !acquisitionCancellationAllowed(cancellation.reasonCode, actorRole)) {
      fail('cancellation actor or reason is not authorized')
    }
    rememberReplay(decoded, current)
    if (state) await releaseAssignment(state)
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
    fail('unsupported acquisition frame type')
  }

  async function start() {
    if (closed) fail('acquisition network is closed')
    if (started) return { status: 'active', providerDiscovery: discoveryServer }
    const currentTerms = await refreshPolicy()
    started = true
    if (policyAllowsPublicAcquisition(currentTerms)) await retainDiscovery({ server: true, client: false })
    return { status: 'active', providerDiscovery: discoveryServer }
  }

  async function publishRequest(input = {}) {
    if (closed) fail('acquisition network is closed')
    if (!started) await start()
    await refreshPolicy()
    const issuedAt = safeNow(now)
    const expiresAt = Number(input.expiresAt ?? issuedAt + Math.min(MAX_ACQUISITION_REQUEST_TTL_MS, input.budget?.maxWallClockMs || MAX_ACQUISITION_REQUEST_TTL_MS))
    const body = {
      version: 1,
      requesterId: localId,
      requesterTransportKey: localId,
      publisherId: input.publisherId,
      sourceRef: input.sourceRef,
      publicationIntentDigest: input.publicationIntentDigest,
      output: input.output,
      budget: input.budget,
      resultHoldUntil: input.resultHoldUntil,
    }
    const payload = encodeAcquisitionRequest({ body, keyPair, nonce: crypto.randomBytes(32), issuedAt, expiresAt })
    const decoded = await decodeAcquisitionRequest(payload, { now: issuedAt, transportPeerId: localId })
    const request = publicRecord(decoded, 'requestId')
    localRequests.set(request.requestId, { request, decoded, peerId: null })
    await retainDiscovery({ server: policyAllowsPublicAcquisition(terms), client: true })
    const delivery = scopedNetwork.publishAcquisitionFrame({ purpose: 'acquisition-discovery', type: 'acquisition-request', payload })
    return { request, delivery }
  }

  async function publishOffer(input = {}) {
    if (closed) fail('acquisition network is closed')
    const currentTerms = await refreshPolicy()
    if (!policyAllowsPublicAcquisition(currentTerms)) fail('public acquisition consent is disabled', 'ACQUISITION_POLICY_REJECTED')
    const peerId = hex32(input.peerId, 'peerId')
    const retained = remoteRequests.get(hex32(input.requestId, 'requestId'))
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
      version: 1,
      requestId: retained.request.requestId,
      acquirerId: localId,
      acquirerTransportKey: localId,
      policyEpoch: currentTerms.generation,
      acceptedBudget,
      availableUntil,
      resultHoldUntil: Math.min(Number(input.resultHoldUntil ?? retained.request.resultHoldUntil), retained.request.resultHoldUntil),
      sourceCapabilityDigest: input.sourceCapabilityDigest,
    }
    const payload = encodeAcquisitionOffer({ body, keyPair, nonce: crypto.randomBytes(32), issuedAt, expiresAt: availableUntil })
    const decoded = await decodeAcquisitionOffer(payload, { now: issuedAt, transportPeerId: localId })
    const offer = publicRecord(decoded, 'offerId')
    validateOfferAgainstRequest(offer, retained.request, issuedAt)
    rememberOffer(offer.requestId, offer.offerId)
    localOffers.set(offer.offerId, { offer, decoded, peerId })
    const delivery = scopedNetwork.publishAcquisitionFrame({ purpose: 'acquisition-discovery', type: 'acquisition-offer', peerId, payload })
    return { offer, delivery }
  }

  async function assign(input = {}) {
    if (closed) fail('acquisition network is closed')
    await refreshPolicy()
    const requestState = localRequests.get(hex32(input.requestId, 'requestId'))
    const offerState = remoteOffers.get(hex32(input.offerId, 'offerId'))
    if (!requestState || !offerState || offerState.offer.requestId !== requestState.request.requestId) fail('assignment request or offer is unknown')
    const issuedAt = safeNow(now)
    const budget = input.budget || minimumBudget(requestState.request.budget, offerState.offer.acceptedBudget)
    const deadline = Math.min(
      Number(input.deadline ?? issuedAt + budget.maxWallClockMs),
      issuedAt + budget.maxWallClockMs,
      issuedAt + MAX_ACQUISITION_ASSIGNMENT_TTL_MS,
    )
    const body = {
      version: 1,
      requestId: requestState.request.requestId,
      offerId: offerState.offer.offerId,
      requesterId: localId,
      requesterTransportKey: localId,
      acquirerId: offerState.offer.acquirerId,
      acquirerTransportKey: offerState.offer.acquirerTransportKey,
      publisherId: requestState.request.publisherId,
      publicationIntentDigest: requestState.request.publicationIntentDigest,
      budget,
      deadline,
      resultHoldUntil: Math.min(requestState.request.resultHoldUntil, offerState.offer.resultHoldUntil),
    }
    const payload = encodeAcquisitionAssignment({ body, keyPair, nonce: crypto.randomBytes(32), issuedAt, expiresAt: deadline })
    const decoded = await decodeAcquisitionAssignment(payload, { now: issuedAt, transportPeerId: localId })
    const assignment = publicRecord(decoded, 'assignmentId')
    validateAssignmentContext(assignment, requestState.request, offerState.offer, issuedAt)
    await armAssignment(assignment, offerState.peerId, 'requester')
    const delivery = scopedNetwork.publishAcquisitionFrame({
      purpose: 'acquisition-discovery',
      type: 'acquisition-assignment',
      peerId: offerState.peerId,
      payload,
    })
    return { assignment, delivery }
  }

  async function progress(input = {}) {
    if (closed) fail('acquisition network is closed')
    await refreshPolicy()
    const assignmentId = hex32(input.assignmentId, 'assignmentId')
    const state = assignments.get(assignmentId)
    if (!state || state.role !== 'worker') fail('worker assignment is not retained')
    const issuedAt = safeNow(now)
    const body = {
      version: 1,
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
    const decoded = await decodeAcquisitionProgress(payload, { now: issuedAt, transportPeerId: localId })
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
      version: 1,
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
    const decoded = await decodeAcquisitionResult(payload, { now: issuedAt, transportPeerId: localId })
    const record = publicRecord(decoded, 'recordId')
    validateResult(record, state, issuedAt)
    const delivery = scopedNetwork.publishAcquisitionFrame({ purpose: 'acquisition', type: 'acquisition-result', assignmentId, peerId: state.peerId, payload })
    state.terminal = 'result'
    return { result: record, delivery }
  }

  async function releaseAssignment(state) {
    if (!state || assignments.get(state.assignment.assignmentId) !== state) return false
    assignments.delete(state.assignment.assignmentId)
    if (state.timer) cancelTimer(state.timer)
    await scopedNetwork.releaseAcquisitionAssignment({ assignmentId: state.assignment.assignmentId })
    return true
  }
  function cancellationContext(input) {
    const assignmentId = input.assignmentId == null ? null : hex32(input.assignmentId, 'assignmentId')
    const state = assignmentId === null ? null : assignments.get(assignmentId)
    const requestId = hex32(input.requestId || state?.assignment.requestId, 'requestId')
    const actorRole = state?.role === 'worker' ? 'worker' : 'requester'
    const peerId = state?.peerId ?? (input.peerId == null ? null : hex32(input.peerId, 'peerId'))
    const reasonCode = String(input.reasonCode || (actorRole === 'worker' ? 'worker-cancelled' : 'requester-cancelled'))
    return { assignmentId, state, requestId, actorRole, peerId, reasonCode }
  }


  async function cancel(input = {}, internal = {}) {
    if (closed && !internal.closing) fail('acquisition network is closed')
    if (!internal.skipPolicy) await refreshPolicy()
    const { assignmentId, state, requestId, actorRole, peerId, reasonCode } = cancellationContext(input)
    if (!acquisitionCancellationAllowed(reasonCode, actorRole)) fail('cancellation reason is not authorized for actor')
    const issuedAt = safeNow(now)
    const body = {
      version: 1,
      requestId,
      assignmentId,
      actorId: localId,
      reasonCode,
      lastProgressSequence: Number(input.lastProgressSequence ?? state?.lastProgressSequence ?? 0),
    }
    const expiresAt = issuedAt + MAX_ACQUISITION_OFFER_TTL_MS
    const payload = encodeAcquisitionCancellation({ body, keyPair, nonce: crypto.randomBytes(32), issuedAt, expiresAt })
    const decoded = await decodeAcquisitionCancellation(payload, { now: issuedAt, transportPeerId: localId })
    const cancellation = publicRecord(decoded, 'recordId')
    const purpose = assignmentId === null ? 'acquisition-discovery' : 'acquisition'
    const delivery = scopedNetwork.publishAcquisitionFrame({
      purpose,
      type: 'acquisition-cancel',
      assignmentId,
      peerId,
      payload,
    })
    if (state) await releaseAssignment(state)
    if (internal.notifyManager) await manager.onCancellation({ cancellation, peerId })
    return { cancellation, delivery }
  }

  async function close() {
    if (closed) return { status: 'closed' }
    closed = true
    const active = [...assignments.values()]
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
    publishRequest,
    publishOffer,
    assign,
    progress,
    result,
    cancel,
    close,
  }
}
