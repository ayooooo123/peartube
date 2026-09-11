import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import AbortController from 'abort-controller'
import { deriveRenditionId } from '../assets/rendition.js'

import {
  acquisitionError,
  assertNoPrivateSourceMaterial,
  requestIntentFromCoordination
} from './contract.js'

function fail (code, message, statusCode = 409) {
  throw acquisitionError(code, message, statusCode)
}

function hex32 (value, name = 'id') {
  if (typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)) {
    return value.toLowerCase()
  }
  const bytes = b4a.from(value || [])
  if (bytes.byteLength !== 32) fail('COORDINATION_INVALID', `${name} must be 32 bytes or 64 hex characters`)
  return b4a.toString(bytes, 'hex')
}

function safeNow (now) {
  const value = Number(now())
  if (!Number.isSafeInteger(value) || value < 1) fail('COORDINATION_INVALID', 'current time must be a positive safe integer')
  return value
}

const TERMINAL_COORDINATION_PHASES = new Set(['completed', 'cancelled', 'failed'])
// Verified worker jobs are terminal acquisitions but still owe result delivery.
const RESULT_INELIGIBLE_JOB_STATES = new Set(['completed', 'cancelled', 'failed'])
const WORKER_RESULT_RETRY_MS = 1000
const WORKER_RESULT_PENDING = 'COORDINATION_RESULT_PENDING'
const WORKER_RESULT_EXPIRED = 'COORDINATION_RESULT_EXPIRED'

function publicationIntentDigestFor (request) {
  const raw = crypto.hash(b4a.from(`${request.publisherId}:${request.resolutionRef}:${request.retentionClass}`))
  return b4a.toString(raw, 'hex')
}

function resultAssetFormat (job) {
  const mime = job?.publicationMetadata?.mediaContext?.format
  if (typeof mime === 'string' && mime) return mime
  return 'application/octet-stream'
}

function resolveJobAvailabilityUntil (coord, current) {
  const holdUntil = Number(coord.resultHoldUntil || 0)
  if (!Number.isSafeInteger(holdUntil) || holdUntil < 1) return null
  if (current > holdUntil) return null
  const deadline = Number(coord.deadline || 0)
  if (Number.isSafeInteger(deadline) && deadline > 0 && current > deadline) return null
  return holdUntil
}

function resolveJobSourceIdentity (job) {
  const sourceIdentity = job.verifiedPrefix?.identity || job.expectedIdentity || null
  if (!sourceIdentity || typeof sourceIdentity.value !== 'string' || !sourceIdentity.value) {
    return null
  }
  if (sourceIdentity.kind === 'sha256' && /^[0-9a-f]{64}$/.test(sourceIdentity.value)) {
    return { kind: 'sha256', value: sourceIdentity.value }
  }
  if (sourceIdentity.kind === 'etag' && /^etag-[0-9a-f]{64}$/.test(sourceIdentity.value)) {
    return { kind: 'etag', value: sourceIdentity.value.slice(5) }
  }
  return null
}

function resultRecordFromJob (job, coord, current) {
  if (!job?.verifiedAsset) return null
  const availabilityUntil = resolveJobAvailabilityUntil(coord, current)
  if (availabilityUntil === null) return null
  const sourceIdentity = resolveJobSourceIdentity(job)
  if (!sourceIdentity) return null

  const format = resultAssetFormat(job)
  const core = {
    kind: 'static-prologue-v1',
    key: job.verifiedAsset.key,
    assetId: job.verifiedAsset.assetId,
    treeHash: job.verifiedAsset.treeHash,
    length: job.verifiedAsset.length,
    byteLength: job.verifiedAsset.byteLength,
    blockSize: job.verifiedAsset.blockSize
  }
  return {
    acquiredBytes: job.verifiedAsset.byteLength,
    completedAt: current,
    availabilityUntil,
    sourceIdentity,
    assets: [{
      purpose: 'original',
      format,
      renditionId: deriveRenditionId({ purpose: 'original', format, core }),
      core
    }]
  }
}

export function createAcquisitionCoordinator ({
  store,
  policy,
  provider,
  publisher,
  sourceGrants = null,
  network = null,
  autoSelect = true,
  freeDiskBytes = () => Number.MAX_SAFE_INTEGER,
  now = () => Date.now(),
  schedule = (fn, delay) => setTimeout(fn, delay),
  cancelTimer = timer => clearTimeout(timer)
} = {}) {
  if (!store || typeof store.saveCoordination !== 'function') {
    fail('COORDINATION_INVALID', 'store with coordination persistence is required')
  }
  if (!policy) fail('COORDINATION_INVALID', 'policy is required')
  if (!provider) fail('COORDINATION_INVALID', 'provider is required')
  if (!publisher) fail('COORDINATION_INVALID', 'publisher is required')

  let boundNetwork = network
  let managerInstance = null
  let closed = false
  let started = false
  let mutations = Promise.resolve()
  let workerResults = Promise.resolve()
  let reconciliation = null
  let retryTimer = null
  let retryPass = null
  let retryRequested = false
  let closing = null
  const lifetime = new AbortController()
  const pendingOffers = new Map()
  const remoteRequests = new Map()
  // Outbound progress coalesce: wire rejects same-phase frames <1s apart.
  const lastProgressSent = new Map()

  function assertOpen () {
    if (closed) fail('COORDINATION_CLOSED', 'acquisition coordinator is closed', 503)
  }

  function serialized (operation) {
    const result = mutations.then(operation, operation)
    mutations = result.catch(() => {})
    return result
  }

  function assertCoordinationOpen (coord, action) {
    if (TERMINAL_COORDINATION_PHASES.has(coord?.phase)) {
      fail('COORDINATION_TERMINAL', `${action} is not allowed for ${coord.phase} coordination`)
    }
  }

  function currentPolicyGeneration (terms) {
    const generation = Number(terms?.generation)
    if (!Number.isSafeInteger(generation) || generation < 0) {
      fail('COORDINATION_POLICY_CHANGED', 'policy generation is invalid')
    }
    return generation
  }

  function requesterGeneration (coord) {
    const generation = Number(coord?.requestGeneration ?? coord?.epoch)
    if (!Number.isSafeInteger(generation) || generation < 0) {
      fail('COORDINATION_POLICY_CHANGED', 'requester policy generation is invalid')
    }
    return generation
  }

  async function managerPrincipalForCoordination (coord) {
    if (typeof store.get !== 'function') {
      fail('COORDINATION_PRINCIPAL_UNAVAILABLE', 'durable acquisition job lookup is required for cancellation')
    }
    const job = await store.get(coord.acquisitionId)
    if (!job?.principalId || typeof job.principalId !== 'string') {
      fail('COORDINATION_PRINCIPAL_UNAVAILABLE', 'coordination has no durable acquisition principal')
    }
    return job.principalId
  }

  function forgetCoordinationMemory (coord) {
    if (!coord?.requestId) return
    pendingOffers.delete(coord.requestId)
    remoteRequests.delete(coord.requestId)
  }

  async function readPolicyTerms () {
    if (typeof policy.networkTerms === 'function') return policy.networkTerms()
    if (typeof policy.getPolicy === 'function') {
      const value = await policy.getPolicy()
      const revision = typeof policy.getRevision === 'function' ? Number(policy.getRevision()) : 0
      return {
        ...value,
        generation: Number.isSafeInteger(value?.generation) ? value.generation : (Number.isSafeInteger(revision) ? Math.max(1, revision) : 1),
        remainingAcquireBytes24h: Number.isSafeInteger(value?.remainingAcquireBytes24h)
          ? value.remainingAcquireBytes24h
          : (Number.isSafeInteger(value?.maxAcquireBytesPer24h) ? value.maxAcquireBytesPer24h : 0)
      }
    }
    return policy || {}
  }

  function attachNetwork (net) {
    boundNetwork = net
    return coordinator
  }

  function bindManager (mgr) {
    managerInstance = mgr
    return coordinator
  }

  function scheduleWorkerResultRetry () {
    if (closed) return
    retryRequested = true
    if (retryTimer !== null || retryPass) return
    retryTimer = schedule(() => {
      retryTimer = null
      if (closed) return
      retryRequested = false
      retryPass = retryWorkerResults().catch(() => {
        retryRequested = true
      }).finally(() => {
        retryPass = null
        if (retryRequested) scheduleWorkerResultRetry()
      })
      return retryPass
    }, WORKER_RESULT_RETRY_MS)
    retryTimer?.unref?.()
  }

  async function retryWorkerResults () {
    const active = await store.listActiveCoordinations()
    if (closed) return
    for (const coord of active) {
      if (closed) return
      if (coord.role !== 'worker' || coord.phase !== 'result-ready' ||
          coord.error?.code !== WORKER_RESULT_PENDING || !coord.result) continue
      if (coord.result.availabilityUntil <= safeNow(now)) {
        await expireWorkerCoordination(coord)
        continue
      }
      await dispatchWorkerResult(coord).catch(async () => {
        if (await currentWorkerResult(coord)) retryRequested = true
      })
    }
  }

  // Policy/job reads precede the final coordination read so cancellation during
  // either await cannot be overwritten by a stale result-ready snapshot.
  async function currentWorkerResult (expected) {
    if (closed) return null
    const terms = await readPolicyTerms()
    if (closed) return null
    const job = await store.get(expected.acquisitionId)
    if (closed) return null
    const coord = await store.getCoordination(expected.acquisitionId)
    if (closed || !coord || coord.role !== 'worker' ||
        coord.assignmentId !== expected.assignmentId ||
        TERMINAL_COORDINATION_PHASES.has(coord.phase)) return null
    if (job && (RESULT_INELIGIBLE_JOB_STATES.has(job.state) ||
        job.committedBytes > 0 || job.publication)) return null
    const generation = currentPolicyGeneration(terms)
    if (coord.epoch !== generation) {
      await cancelStaleCoordination(coord, generation)
      return null
    }
    if (coord.phase === 'result-ready' &&
        (!coord.result || coord.result.availabilityUntil <= safeNow(now))) {
      await expireWorkerCoordination(coord)
      return null
    }
    return coord
  }

  async function expireWorkerCoordination (coord) {
    if (closed) return null
    const terms = await readPolicyTerms()
    if (closed) return null
    const generation = currentPolicyGeneration(terms)
    const current = await store.getCoordination(coord.acquisitionId)
    if (closed || !current || current.role !== 'worker' ||
        current.assignmentId !== coord.assignmentId ||
        TERMINAL_COORDINATION_PHASES.has(current.phase)) {
      return current
    }
    if (current.epoch !== generation) {
      return await cancelStaleCoordination(current, generation)
    }
    const expiredResultReady = current.phase === 'result-ready' &&
      (!current.result || current.result.availabilityUntil <= safeNow(now))
    const expiredHold = Boolean(current.resultHoldUntil && safeNow(now) >= current.resultHoldUntil)
    if (!expiredResultReady && !expiredHold) {
      return current
    }
    try {
      const expired = await store.saveCoordination(current.acquisitionId, {
        ...current,
        phase: 'failed',
        error: {
          code: WORKER_RESULT_EXPIRED,
          message: 'Worker result hold expired before delivery'
        }
      })
      lastProgressSent.delete(current.acquisitionId)
      forgetCoordinationMemory(expired)
      return expired
    } catch (error) {
      if (error?.code === 'COORDINATION_TERMINAL') {
        return await store.getCoordination(current.acquisitionId)
      }
      throw error
    }
  }

  function dispatchWorkerResult (coord, job, recover = false) {
    // One result lane also serializes initial notifications against retry and
    // recovery passes; no per-assignment queue or timer survives delivery.
    const result = workerResults.then(() => sendWorkerResult(coord, job, recover))
    workerResults = result.catch(() => {})
    return result
  }

  function assertWorkerNetwork (net) {
    if (!net || typeof net.result !== 'function' || typeof net.holdVerifiedAsset !== 'function') {
      fail('COORDINATION_NETWORK_UNAVAILABLE', 'worker result transport and verified asset hold are required', 503)
    }
  }

  async function deliverWorkerResultToNetwork (net, coord, record) {
    await restoreNetworkSessions(coord)
    coord = await currentWorkerResult(coord)
    if (!coord || closed) return null
    if (net !== boundNetwork) fail('COORDINATION_NETWORK_UNAVAILABLE', 'worker result transport changed', 503)
    await net.holdVerifiedAsset({
      assignmentId: coord.assignmentId,
      asset: record.assets[0].core,
      availabilityUntil: record.availabilityUntil
    })
    coord = await currentWorkerResult(coord)
    if (!coord || closed) return null
    if (net !== boundNetwork) fail('COORDINATION_NETWORK_UNAVAILABLE', 'worker result transport changed', 503)
    const sent = await net.result({
      assignmentId: coord.assignmentId,
      sourceIdentity: record.sourceIdentity,
      assets: record.assets,
      acquiredBytes: record.acquiredBytes,
      completedAt: record.completedAt,
      availabilityUntil: record.availabilityUntil
    })
    coord = await currentWorkerResult(coord)
    if (!coord || closed) return null
    if (sent?.delivery?.sent === 0) {
      fail('COORDINATION_NETWORK_UNAVAILABLE', 'worker result recipient is unavailable', 503)
    }
    return coord
  }

  async function sendWorkerResult (expected, job, recover) {
    let coord = await currentWorkerResult(expected)
    if (!coord || closed) return null
    if (!recover && coord.phase === 'result-ready' &&
        coord.error?.code !== WORKER_RESULT_PENDING) return coord
    const record = coord.phase === 'result-ready'
      ? coord.result
      : resultRecordFromJob(job, coord, safeNow(now))
    if (!record || record.availabilityUntil <= safeNow(now)) {
      await expireWorkerCoordination(coord)
      return null
    }
    coord = await store.saveCoordination(coord.acquisitionId, {
      ...coord,
      phase: 'result-ready',
      result: record,
      error: { code: WORKER_RESULT_PENDING, message: 'Worker result delivery is pending' }
    })
    try {
      coord = await currentWorkerResult(coord)
      if (!coord || closed) return null
      const net = boundNetwork
      assertWorkerNetwork(net)
      coord = await deliverWorkerResultToNetwork(net, coord, record)
      if (!coord || closed) return null
      return await store.saveCoordination(coord.acquisitionId, { ...coord, error: null })
    } catch (error) {
      if (await currentWorkerResult(expected)) scheduleWorkerResultRetry()
      throw error
    }
  }
  function assertAssignableCoordination (coord) {
    if (!coord) fail('COORDINATION_NOT_FOUND', 'no coordination record found for acquisition', 404)
    assertCoordinationOpen(coord, 'assignment')
    if (coord.phase !== 'requested' && coord.phase !== 'assigned') {
      fail('COORDINATION_PHASE_INVALID', 'assignment requires an open request phase')
    }
  }

  async function validateAssignmentOfferPolicy ({ coord, offer, policyTerms, current }) {
    const policyGeneration = currentPolicyGeneration(policyTerms)
    const requestGeneration = requesterGeneration(coord)
    if (requestGeneration !== policyGeneration) {
      await cancelStaleCoordination(coord, policyGeneration)
      fail('COORDINATION_POLICY_CHANGED', 'assignment request policy generation is stale')
    }
    const offerPolicyEpoch = Number(offer.policyEpoch)
    if (!Number.isSafeInteger(offerPolicyEpoch) || offerPolicyEpoch < 0) {
      fail('COORDINATION_POLICY_CHANGED', 'offer policy epoch is invalid')
    }
    const wallClock = Number(offer.acceptedBudget?.maxWallClockMs || policyTerms?.maxJobRuntimeMs || 60_000)
    const deadline = Math.min(Number(offer.availableUntil || current + wallClock), current + wallClock)
    return { requestGeneration, offerPolicyEpoch, deadline }
  }

  function assertPreparedAssignmentEpoch (preparedEpoch, offerPolicyEpoch) {
    if (!Number.isSafeInteger(preparedEpoch) || preparedEpoch < 0 || preparedEpoch !== offerPolicyEpoch) {
      fail('COORDINATION_POLICY_CHANGED', 'prepared assignment policy epoch does not match the selected offer')
    }
  }

  function buildAssignmentClaimRecord ({
    coord,
    offer,
    offerId,
    prepared,
    requestGeneration,
    boundEpoch,
    deadline,
  }) {
    const finalAssignmentId = hex32(prepared.assignment.assignmentId, 'assignmentId')
    const targetPeerId = hex32(prepared.assignment.acquirerTransportKey || prepared.peerId, 'peerId')
    const publicationIntentDigest = coord.publicationIntentDigest || hex32(prepared.assignment.publicationIntentDigest, 'publicationIntentDigest')
    const budget = prepared.assignment.budget || offer.acceptedBudget || coord.budget
    const resultHoldUntil = prepared.assignment.resultHoldUntil || coord.resultHoldUntil
    const finalDeadline = Number(prepared.assignment.deadline || deadline)

    return {
      schemaVersion: 1,
      offerId,
      assignmentId: finalAssignmentId,
      peerId: targetPeerId,
      requesterId: hex32(prepared.assignment.requesterId, 'requesterId'),
      acquirerId: hex32(prepared.assignment.acquirerId, 'acquirerId'),
      sourceRef: coord.sourceRef,
      publisherId: coord.publisherId,
      publicationIntentDigest,
      budget,
      output: coord.output || null,
      resultHoldUntil,
      requestGeneration,
      epoch: boundEpoch,
      deadline: finalDeadline,
      progress: null,
      result: null,
      error: null,
    }
  }

  function resolveProgressPhase (event) {
    if (event.state === 'verified' || event.type === 'acquisition.verified') {
      return 'result-ready'
    }
    return event.state || event.phase || 'acquiring'
  }

  function resolveProgressBlocks (event, terminal) {
    const totalBlocks = Number(event.totalBlocks) ||
      Number(event.verifiedAsset?.length) ||
      Number(event.job?.verifiedAsset?.length) ||
      0
    const verifiedBlocks = Number(event.verifiedBlocks) || (terminal ? totalBlocks : 0)
    return { totalBlocks, verifiedBlocks }
  }

  function shouldEmitProgressUpdate ({ prior, current, phase, sequence, sourceBytes, outputBytes, terminal }) {
    const phaseChanged = !prior || prior.phase !== phase
    if (terminal || phaseChanged) return true
    if (prior && sequence <= prior.sequence) return false

    const intervalOk = !prior || (current - prior.at) >= 1000
    const bytesAdvanced = !prior || sourceBytes > prior.sourceBytes || outputBytes > prior.outputBytes
    return intervalOk && bytesAdvanced
  }


  const managerNetwork = Object.freeze({
    async publishRequest ({ acquisitionId, request }) {
      assertOpen()
      if (!boundNetwork) fail('COORDINATION_NETWORK_UNAVAILABLE', 'network is not configured', 503)
      return serialized(async () => {
        const current = safeNow(now)
        const policyTerms = await readPolicyTerms()
        const epoch = currentPolicyGeneration(policyTerms)
        const existing = await store.getCoordination(acquisitionId)
        if (existing) assertCoordinationOpen(existing, 'request publication')
        const maxWallClock = policyTerms?.maxJobRuntimeMs || 60_000
        const deadline = current + maxWallClock
        const publicationIntentDigest = publicationIntentDigestFor(request)
        const maxBytes = request.expectedBytes || policyTerms?.maxRequestBytes || (16 * 1024 * 1024)
        const budget = {
          maxSourceBytes: maxBytes,
          maxOutputBytes: maxBytes,
          maxNetworkBytes: maxBytes * 2,
          maxWallClockMs: maxWallClock
        }
        const output = request.output || { purpose: 'original', formats: ['application/octet-stream'] }
        const resultHoldUntil = deadline + 120_000
        const expiresAt = current + Math.min(300_000, maxWallClock)

        if (typeof boundNetwork.prepareRequest !== 'function' || typeof boundNetwork.dispatchRequest !== 'function') {
          fail('COORDINATION_NETWORK_UNAVAILABLE', 'network prepare/dispatch primitives are required', 503)
        }

        const prepared = await boundNetwork.prepareRequest({
          publisherId: hex32(request.publisherId, 'publisherId'),
          sourceRef: request.resolutionRef,
          publicationIntentDigest,
          generation: epoch,
          output,
          budget,
          resultHoldUntil,
          expiresAt
        })

        const requestId = hex32(prepared.request.requestId, 'requestId')
        if (prepared.request.generation !== epoch) {
          fail('COORDINATION_POLICY_CHANGED', 'prepared request policy generation is stale')
        }

        // Persist full non-secret request intent BEFORE wire dispatch.
        // Nonce/signature bytes are not durable; recovery re-signs from this intent.
        await store.saveCoordination(acquisitionId, {
          schemaVersion: 1,
          role: 'requester',
          phase: 'requested',
          requestId,
          offerId: null,
          assignmentId: null,
          peerId: null,
          sourceRef: request.resolutionRef,
          publisherId: hex32(request.publisherId, 'publisherId'),
          publicationIntentDigest,
          budget,
          output,
          resultHoldUntil,
          requestGeneration: epoch,
          epoch,
          deadline,
          progress: null,
          result: null,
          error: null,
          supersededRequestIds: []
        })

        return boundNetwork.dispatchRequest(prepared)
      })
    },

    async assign ({ acquisitionId, offer }) {
      assertOpen()
      if (!boundNetwork) fail('COORDINATION_NETWORK_UNAVAILABLE', 'network is not configured', 503)
      return serialized(async () => {
        const current = safeNow(now)
        const coord = await store.getCoordination(acquisitionId)
        assertAssignableCoordination(coord)
        if (coord.assignmentId != null) {
          // Concurrent offer lost the CAS race; return the durable winner.
          return { assignment: { assignmentId: coord.assignmentId }, claimed: false }
        }

        const offerId = hex32(offer.offerId || offer.id, 'offerId')
        const requestId = coord.requestId
        const policyTerms = await readPolicyTerms()
        const { requestGeneration, offerPolicyEpoch, deadline } = await validateAssignmentOfferPolicy({
          coord,
          offer,
          policyTerms,
          current,
        })

        if (typeof boundNetwork.prepareAssignment !== 'function' || typeof boundNetwork.dispatchAssignment !== 'function') {
          fail('COORDINATION_NETWORK_UNAVAILABLE', 'network assignment prepare/dispatch is required', 503)
        }

        const prepared = await boundNetwork.prepareAssignment({
          requestId,
          offerId,
          deadline,
          budget: offer.acceptedBudget
        })

        const boundEpoch = Number(prepared.assignment.policyEpoch)
        // Bind the assignment to the selected worker offer. This is deliberately
        // not compared with the requester's local requestGeneration.
        assertPreparedAssignmentEpoch(boundEpoch, offerPolicyEpoch)

        const claimRecord = buildAssignmentClaimRecord({
          coord,
          offer,
          offerId,
          prepared,
          requestGeneration,
          boundEpoch,
          deadline,
        })
        const claim = await store.claimCoordinationAssignment(acquisitionId, claimRecord)

        if (claim.claimed !== true) {
          return { assignment: { assignmentId: claim.record.assignmentId }, claimed: false }
        }

        forgetCoordinationMemory(coord)
        const assigned = await boundNetwork.dispatchAssignment(prepared)
        return { ...assigned, claimed: true }
      })
    },

    async progress (event) {
      assertOpen()
      if (!boundNetwork || !event?.acquisitionId) return
      const coord = await store.getCoordination(event.acquisitionId)
      if (coord?.role !== 'worker' || !coord?.assignmentId) return
      assertCoordinationOpen(coord, 'progress')

      const phase = resolveProgressPhase(event)
      const terminal = phase === 'result-ready' || phase === 'failed'
      const sequence = Number(event.version || event.sequence || 1)
      const sourceBytes = Number(event.sourceBytesRead || event.bytesAcquired || 0)
      const outputBytes = Number(event.bytesAcquired || 0)
      const current = safeNow(now)
      const prior = lastProgressSent.get(event.acquisitionId)

      if (!shouldEmitProgressUpdate({ prior, current, phase, sequence, sourceBytes, outputBytes, terminal })) {
        return
      }

      const { totalBlocks, verifiedBlocks } = resolveProgressBlocks(event, terminal)

      try {
        await boundNetwork.progress({
          assignmentId: coord.assignmentId,
          sequence,
          phase,
          sourceBytes,
          outputBytes,
          verifiedBlocks,
          totalBlocks,
          observedAt: current
        })
        lastProgressSent.set(event.acquisitionId, {
          at: current,
          phase,
          sequence,
          sourceBytes,
          outputBytes
        })
      } catch {
        // Rate-limit / transport faults are non-fatal; result path is authoritative.
      }
    },

    async result (event) {
      assertOpen()
      if (!event?.acquisitionId) return
      const coord = await store.getCoordination(event.acquisitionId)
      if (coord?.role !== 'worker' || !coord?.assignmentId) return
      assertCoordinationOpen(coord, 'result')
      const job = event.job || await store.get(event.acquisitionId)
      await dispatchWorkerResult(coord, job)
    },

    async cancel (event) {
      assertOpen()
      if (!event?.acquisitionId) return
      const coord = await store.getCoordination(event.acquisitionId)
      if (!coord) return
      if (!TERMINAL_COORDINATION_PHASES.has(coord.phase)) {
        // Persist cancellation BEFORE wire dispatch so restart cannot re-arm work
        // after a swallowed transport failure (manager.notify is best-effort).
        await store.saveCoordination(coord.acquisitionId, {
          ...coord,
          phase: 'cancelled',
          error: {
            code: 'CANCELLED',
            message: coord.role === 'worker' ? 'worker-cancelled' : 'requester-cancelled'
          }
        })
        lastProgressSent.delete(event.acquisitionId)
        forgetCoordinationMemory(coord)
      }
      if (!boundNetwork) return
      if (coord.assignmentId || coord.requestId) {
        try {
          await boundNetwork.cancel({
            assignmentId: coord.assignmentId,
            requestId: coord.requestId,
            reasonCode: coord.role === 'worker' ? 'worker-cancelled' : 'requester-cancelled'
          })
        } catch {
          // Delivery is best-effort/retriable; durable phase is already cancelled.
        }
      }
    }
  })

  const networkManager = Object.freeze({
    async onRequest ({ request, peerId }) {
      assertOpen()
      const current = safeNow(now)
      const policyTerms = await readPolicyTerms()
      if (policyTerms?.enabled !== true || policyTerms?.acceptPublicRequests !== true) return

      remoteRequests.set(request.requestId, { request, peerId })

      let canServe = false
      if (typeof provider.canOpen === 'function') {
        canServe = provider.canOpen({ ref: request.sourceRef }) === true
      } else if (sourceGrants && typeof sourceGrants.has === 'function') {
        canServe = sourceGrants.has({ ref: request.sourceRef }) === true
      }
      if (!canServe) return

      const acceptedBudget = {
        maxSourceBytes: Math.min(request.budget.maxSourceBytes, policyTerms.maxRequestBytes || request.budget.maxSourceBytes),
        maxOutputBytes: Math.min(request.budget.maxOutputBytes, policyTerms.maxRequestBytes || request.budget.maxOutputBytes),
        maxNetworkBytes: Math.min(request.budget.maxNetworkBytes, policyTerms.remainingAcquireBytes24h || request.budget.maxNetworkBytes),
        maxWallClockMs: Math.min(request.budget.maxWallClockMs, policyTerms.maxJobRuntimeMs || request.budget.maxWallClockMs)
      }

      if (freeDiskBytes() < acceptedBudget.maxOutputBytes) return

      const capabilityBytes = crypto.hash(b4a.from(`peartube.worker-capability.v1\u0000${request.sourceRef}`))
      const sourceCapabilityDigest = b4a.toString(capabilityBytes, 'hex')

      await boundNetwork.publishOffer({
        requestId: request.requestId,
        peerId,
        acceptedBudget,
        sourceCapabilityDigest,
        availableUntil: Math.min(request.expiresAt, current + (policyTerms.maxJobRuntimeMs || 60_000))
      })
    },

    async onOffer ({ offer, peerId }) {
      assertOpen()
      const requestId = hex32(offer.requestId, 'requestId')
      if (typeof store.isSupersededRequest === 'function' && await store.isSupersededRequest(requestId)) {
        // Stale callback after requestId rotation; never assign on a superseded id.
        return { status: 'rejected', reason: 'request-superseded' }
      }
      const coord = await store.getCoordinationByRequest(requestId)
      if (!coord || coord.role !== 'requester') return
      assertCoordinationOpen(coord, 'offer')
      if (coord.requestId !== requestId) return { status: 'rejected', reason: 'request-stale' }
      if (coord.assignmentId != null) return { status: 'ignored', reason: 'already-assigned' }

      const generation = currentPolicyGeneration(await readPolicyTerms())
      if (requesterGeneration(coord) !== generation) {
        return { status: 'rejected', reason: 'policy-epoch-stale' }
      }

      let requestOffers = pendingOffers.get(requestId)
      if (!requestOffers) {
        requestOffers = new Map()
        pendingOffers.set(requestId, requestOffers)
      }
      requestOffers.set(offer.offerId, { offer, peerId })

      if (autoSelect && coord.assignmentId === null) {
        await managerNetwork.assign({
          acquisitionId: coord.acquisitionId,
          offer: { ...offer, peerId }
        }).catch(() => {})
      }
    },

    async onAssignment ({ assignment, peerId }) {
      assertOpen()
      return serialized(async () => {
        const assignmentId = hex32(assignment.assignmentId, 'assignmentId')
        const requestId = hex32(assignment.requestId, 'requestId')
        const offerId = hex32(assignment.offerId, 'offerId')

        const policyTerms = await readPolicyTerms()
        const epoch = Number(assignment.policyEpoch)
        const currentGeneration = currentPolicyGeneration(policyTerms)
        if (epoch !== currentGeneration) {
          fail('COORDINATION_POLICY_CHANGED', 'assignment policy epoch is stale for worker', 409)
        }

        const retained = remoteRequests.get(requestId)
        if (!retained?.request) fail('COORDINATION_REQUEST_MISSING', 'assigned request is not retained', 409)
        const sourceRef = retained.request.sourceRef
        if (!sourceRef) fail('SOURCE_REF_MISSING', 'assigned request has no source reference', 400)

        if (!managerInstance || typeof managerInstance.acceptRemoteRequest !== 'function') {
          fail('COORDINATION_MANAGER_UNAVAILABLE', 'manager is not bound for worker execution', 503)
        }

        // Prepare durable job without notify/dispatch, bind coordination to the
        // real acquisitionId, then commit (notify + schedule).
        const prepared = await managerInstance.acceptRemoteRequest({
          idempotencyKey: `assignment_${assignmentId}`,
          request: {
            schemaVersion: 1,
            resolutionRef: sourceRef,
            publisherId: hex32(assignment.publisherId, 'publisherId'),
            retentionClass: 'contribution-cache'
          },
          principal: {
            principalId: 'worker-acquisition',
            isLocal: false,
            publisherIds: []
          }
        })

        const workerAcquisitionId = prepared.job.acquisitionId

        await store.saveCoordination(workerAcquisitionId, {
          schemaVersion: 1,
          role: 'worker',
          phase: 'assigned',
          requestId,
          offerId,
          assignmentId,
          peerId: hex32(peerId, 'peerId'),
          requesterId: hex32(assignment.requesterId, 'requesterId'),
          acquirerId: hex32(assignment.acquirerId, 'acquirerId'),
          sourceRef,
          publisherId: hex32(assignment.publisherId, 'publisherId'),
          publicationIntentDigest: hex32(assignment.publicationIntentDigest, 'publicationIntentDigest'),
          budget: assignment.budget || null,
          output: retained?.request?.output || null,
          resultHoldUntil: assignment.resultHoldUntil || null,
          requestGeneration: Number(retained.request.generation),
          epoch,
          deadline: assignment.deadline,
          progress: null,
          result: null,
          error: null
        })

        if (typeof managerInstance.commitPreparedRequest === 'function') {
          await managerInstance.commitPreparedRequest({ prepared, isRemote: true, publishNetwork: false })
        } else if (typeof managerInstance.dispatchQueuedJobs === 'function') {
          await managerInstance.dispatchQueuedJobs()
        }

        return prepared.job
      })
    },

    async onProgress ({ progress, peerId }) {
      assertOpen()
      return serialized(async () => {
        const assignmentId = hex32(progress.assignmentId, 'assignmentId')
        const coord = await store.getCoordinationByAssignment(assignmentId)
        if (!coord || coord.role !== 'requester') return
        if (coord.peerId !== hex32(peerId, 'peerId')) fail('COORDINATION_PEER_MISMATCH', 'progress from unauthorized peer')
        assertCoordinationOpen(coord, 'progress')
        await assertRequesterGeneration(coord, 'progress')
        if (coord.phase === 'result-ready') fail('COORDINATION_RESULT_ALREADY_RECORDED', 'progress cannot replace a durable result')

        assertNoPrivateSourceMaterial(progress, 'worker progress frame')

        await store.saveCoordination(coord.acquisitionId, {
          ...coord,
          phase: progress.phase === 'result-ready' ? 'result-ready' : (progress.phase || coord.phase),
          progress: {
            sequence: progress.sequence,
            phase: progress.phase,
            sourceBytes: progress.sourceBytes,
            outputBytes: progress.outputBytes,
            verifiedBlocks: progress.verifiedBlocks,
            totalBlocks: progress.totalBlocks,
            observedAt: progress.observedAt,
            errorCode: progress.errorCode
          }
        })
      })
    },

    async onResult ({ result, peerId }) {
      assertOpen()
      return serialized(async () => {
        const assignmentId = hex32(result.assignmentId, 'assignmentId')
        const coord = await store.getCoordinationByAssignment(assignmentId)
        if (!coord || coord.role !== 'requester') return
        if (coord.peerId !== hex32(peerId, 'peerId')) fail('COORDINATION_PEER_MISMATCH', 'result from unauthorized peer')
        assertCoordinationOpen(coord, 'result')
        if (coord.phase === 'result-ready') fail('COORDINATION_RESULT_ALREADY_RECORDED', 'result is already durable')
        await assertRequesterGeneration(coord, 'result')

        assertNoPrivateSourceMaterial(result, 'worker acquisition result')

        const currentCoord = await store.getCoordination(coord.acquisitionId)
        if (!currentCoord) return
        assertCoordinationOpen(currentCoord, 'result')
        if (currentCoord.phase === 'result-ready') fail('COORDINATION_RESULT_ALREADY_RECORDED', 'result is already durable')
        const updatedCoord = await store.saveCoordination(currentCoord.acquisitionId, {
          ...currentCoord,
          phase: 'result-ready',
          result: {
            acquiredBytes: result.acquiredBytes,
            completedAt: result.completedAt,
            availabilityUntil: result.availabilityUntil,
            sourceIdentity: result.sourceIdentity,
            assets: result.assets
          },
          error: null
        })

        const withResult = {
          ...updatedCoord,
          result: updatedCoord.result
        }
        const outcome = await applyRequesterTransferredResult(withResult, { peerId })
        if (outcome.status === 'error') throw outcome.error
        return outcome.coord
      })
    },

    async onCancellation ({ cancellation, peerId }) {
      assertOpen()
      const outcome = await serialized(async () => {
        let coord = null
        if (cancellation.assignmentId) {
          coord = await store.getCoordinationByAssignment(hex32(cancellation.assignmentId, 'assignmentId'))
        } else if (cancellation.requestId) {
          coord = await store.getCoordinationByRequest(hex32(cancellation.requestId, 'requestId'))
        }
        if (!coord) return null
        assertCoordinationOpen(coord, 'cancellation')

        const principal = managerInstance
          ? await managerPrincipalForCoordination(coord)
          : null
        const cancelled = await store.saveCoordination(coord.acquisitionId, {
          ...coord,
          phase: 'cancelled',
          error: { code: 'CANCELLED', message: `Cancelled by peer: ${cancellation.reasonCode}` }
        })
        forgetCoordinationMemory(cancelled)
        return { coord: cancelled, principal }
      })

      if (!outcome) return
      if (managerInstance) {
        if (typeof managerInstance.cancel !== 'function') {
          fail('COORDINATION_MANAGER_UNAVAILABLE', 'manager cancellation is not available', 503)
        }
        // The durable job principal is the authority boundary for the manager;
        // the wire requester identity is not a substitute for it.
        await managerInstance.cancel({
          acquisitionId: outcome.coord.acquisitionId,
          principal: outcome.principal
        })
      }
      return outcome.coord
    }
  })


  /**
   * Only coordination phase=completed when the manager job is actually completed.
   * acceptTransferredResult returns normally for failed/cancelled terminals too.
   */
  async function saveTransferredResultCoordination (acquisitionId, { phase, error }) {
    const latest = await store.getCoordination(acquisitionId)
    if (!latest) return null
    assertCoordinationOpen(latest, 'transferred result')
    return await store.saveCoordination(latest.acquisitionId, {
      ...latest,
      phase,
      error,
    })
  }

  function resolveTransferredJobOutcome (job) {
    if (job?.state === 'completed') {
      return {
        status: 'completed',
        phase: 'completed',
        error: null,
      }
    }
    if (job?.state === 'failed' || job?.state === 'cancelled') {
      const isCancelled = job.state === 'cancelled'
      const defaultCode = isCancelled ? 'CANCELLED' : 'TRANSFER_IMPORT_FAILED'
      return {
        status: job.state,
        phase: isCancelled ? 'cancelled' : 'failed',
        error: {
          code: String(job.errorCode || defaultCode).slice(0, 64),
          message: `manager job ended as ${job.state}`,
        },
      }
    }
    return {
      status: 'pending',
      phase: 'result-ready',
      error: {
        code: 'TRANSFER_NOT_COMPLETED',
        message: `manager job state is ${job?.state || 'unknown'}; coordination remains result-ready`,
      },
    }
  }

  async function handleTransferredResultError (acquisitionId, error) {
    const saved = await saveTransferredResultCoordination(acquisitionId, {
      phase: 'result-ready',
      error: {
        code: String(error?.code || 'TRANSFER_IMPORT_FAILED').slice(0, 64),
        message: String(error?.message || 'acceptTransferredResult failed').slice(0, 255),
      },
    })
    if (!saved) return { status: 'deferred', coord: null }
    return { status: 'error', coord: saved, error, job: null }
  }

  async function applyRequesterTransferredResult (coord, { peerId = null } = {}) {
    if (closed) return { status: 'deferred', coord: null }
    if (!managerInstance || typeof managerInstance.acceptTransferredResult !== 'function') {
      return { status: 'deferred', coord }
    }
    const currentCoord = await store.getCoordination(coord.acquisitionId)
    if (!currentCoord) return { status: 'deferred', coord: null }
    assertCoordinationOpen(currentCoord, 'transferred result')
    if (currentCoord.phase !== 'result-ready') {
      fail('COORDINATION_PHASE_INVALID', 'transferred result requires result-ready coordination')
    }
    await assertRequesterGeneration(currentCoord, 'transferred result')
    coord = currentCoord
    if (!coord?.result?.assets?.[0]?.core) {
      fail('COORDINATION_RESULT_INVALID', 'result lacks a verified asset core')
    }
    let job
    try {
      job = await managerInstance.acceptTransferredResult({
        acquisitionId: coord.acquisitionId,
        asset: coord.result.assets[0].core,
        sourceIdentity: coord.result.sourceIdentity,
        peerId: peerId || coord.peerId,
        signal: lifetime.signal
      })
    } catch (error) {
      return await handleTransferredResultError(coord.acquisitionId, error)
    }

    const outcome = resolveTransferredJobOutcome(job)
    const updated = await saveTransferredResultCoordination(coord.acquisitionId, {
      phase: outcome.phase,
      error: outcome.error,
    })
    if (!updated) return { status: 'deferred', coord: null }
    return { status: outcome.status, coord: updated, job }
  }

  async function cancelStaleCoordination (coord, generation) {
    const current = await store.getCoordination(coord.acquisitionId)
    if (!current || TERMINAL_COORDINATION_PHASES.has(current.phase)) return current
    const principal = managerInstance
      ? await managerPrincipalForCoordination(current)
      : null
    const cancelled = await store.saveCoordination(current.acquisitionId, {
      ...current,
      phase: 'cancelled',
      error: {
        code: 'COORDINATION_POLICY_CHANGED',
        message: `${current.role} policy generation is stale; current local policy generation is ${generation}`
      }
    })
    forgetCoordinationMemory(cancelled)
    if (managerInstance) {
      if (typeof managerInstance.cancel !== 'function') {
        fail('COORDINATION_MANAGER_UNAVAILABLE', 'manager cancellation is not available', 503)
      }
      await managerInstance.cancel({ acquisitionId: cancelled.acquisitionId, principal })
    }
    return cancelled
  }

  async function assertRequesterGeneration (coord, action) {
    if (coord?.role !== 'requester') return
    const generation = currentPolicyGeneration(await readPolicyTerms())
    if (requesterGeneration(coord) !== generation) {
      await cancelStaleCoordination(coord, generation)
      fail('COORDINATION_POLICY_CHANGED', `${action} uses a stale requester policy generation`)
    }
  }

  async function restoreNetworkSessions (coord) {
    if (!boundNetwork || typeof boundNetwork.restoreAssignment !== 'function') return
    if (!coord.assignmentId || !coord.peerId) return
    // Fail closed when assignment terms are incomplete — do not invent identities/budgets.
    if (!coord.requesterId || !coord.acquirerId || !coord.budget || coord.resultHoldUntil == null) return
    await boundNetwork.restoreAssignment({
      assignmentId: coord.assignmentId,
      requestId: coord.requestId,
      offerId: coord.offerId,
      peerId: coord.peerId,
      role: coord.role,
      deadline: coord.deadline,
      resultHoldUntil: coord.resultHoldUntil,
      policyEpoch: coord.epoch,
      requestGeneration: coord.requestGeneration ?? (coord.role === 'requester' ? coord.epoch : null),
      publisherId: coord.publisherId,
      publicationIntentDigest: coord.publicationIntentDigest,
      requesterId: coord.requesterId,
      acquirerId: coord.acquirerId,
      budget: coord.budget,
      result: coord.result
    }).catch(() => {})
  }

  /**
   * Crash recovery for requested-phase work: re-sign a fresh envelope from the
   * durable non-secret intent, atomically rotate requestId + reverse pointers,
   * then dispatch. Memory-only localRequests cannot survive restart.
   * Canonical deadline/resultHoldUntil are never widened on recovery.
   */
  async function assertRecoverableRequestWindow (coord, intent, current) {
    const deadline = Number(intent.deadline || coord.deadline || 0)
    const resultHoldUntil = Number(intent.resultHoldUntil || 0)
    // Insufficient remaining window → fail closed rather than grant a new lifetime.
    if (!Number.isSafeInteger(deadline) || deadline <= current ||
        !Number.isSafeInteger(resultHoldUntil) || resultHoldUntil <= current ||
        resultHoldUntil <= deadline) {
      await store.saveCoordination(coord.acquisitionId, {
        ...coord,
        phase: 'failed',
        error: { code: 'ACQUISITION_DEADLINE_EXCEEDED', message: 'Request recovery window exhausted' }
      }).catch(() => {})
      return null
    }

    const remainingMs = deadline - current
    const expiresAt = current + Math.min(300_000, remainingMs, intent.budget.maxWallClockMs, 5 * 60_000)
    if (expiresAt <= current || resultHoldUntil <= expiresAt) {
      await store.saveCoordination(coord.acquisitionId, {
        ...coord,
        phase: 'failed',
        error: { code: 'ACQUISITION_DEADLINE_EXCEEDED', message: 'Request recovery cannot form a valid envelope lifetime' }
      }).catch(() => {})
      return null
    }

    return { deadline, resultHoldUntil, expiresAt }
  }

  function cleanupRotatedRequest (oldRequestId, newRequestId) {
    if (oldRequestId && oldRequestId !== newRequestId) {
      pendingOffers.delete(oldRequestId)
      if (typeof boundNetwork.dropLocalRequest === 'function') {
        boundNetwork.dropLocalRequest(oldRequestId)
      }
    }
  }

  async function recoverRequested (coord) {
    if (!boundNetwork) return null
    if (typeof boundNetwork.prepareRequest !== 'function' || typeof boundNetwork.dispatchRequest !== 'function') {
      return null
    }
    if (typeof store.replaceCoordinationRequest !== 'function') return null

    const intent = requestIntentFromCoordination(coord)
    if (!intent) return null

    const current = safeNow(now)
    const policyGeneration = currentPolicyGeneration(await readPolicyTerms())
    if (intent.generation !== policyGeneration) {
      await cancelStaleCoordination(coord, policyGeneration)
      return null
    }

    const window = await assertRecoverableRequestWindow(coord, intent, current)
    if (!window) return null
    const { deadline, resultHoldUntil, expiresAt } = window

    const prepared = await boundNetwork.prepareRequest({
      publisherId: intent.publisherId,
      sourceRef: intent.sourceRef,
      publicationIntentDigest: intent.publicationIntentDigest,
      generation: intent.generation,
      output: intent.output,
      budget: intent.budget,
      resultHoldUntil,
      expiresAt
    })

    const oldRequestId = coord.requestId
    const newRequestId = hex32(prepared.request.requestId, 'requestId')
    if (prepared.request.generation !== intent.generation) {
      fail('COORDINATION_POLICY_CHANGED', 'recovered request policy generation is stale')
    }

    // Atomic replace of requestId and reverse pointers BEFORE any wire dispatch.
    // Keep original deadline/hold; only the live requestId rotates.
    const rotated = await store.replaceCoordinationRequest(coord.acquisitionId, {
      requestId: newRequestId,
      sourceRef: intent.sourceRef,
      publisherId: intent.publisherId,
      publicationIntentDigest: intent.publicationIntentDigest,
      budget: intent.budget,
      output: intent.output,
      resultHoldUntil,
      requestGeneration: intent.generation,
      epoch: intent.generation,
      deadline
    })

    cleanupRotatedRequest(oldRequestId, newRequestId)

    const dispatched = await boundNetwork.dispatchRequest(prepared)
    return { coordination: rotated, request: dispatched.request, previousRequestId: oldRequestId }
  }

  function reconcile () {
    assertOpen()
    if (reconciliation) return reconciliation
    reconciliation = runReconciliation().finally(() => { reconciliation = null })
    return reconciliation
  }

  async function handleReconciliationDeadlineExceeded (coord, current) {
    await store.saveCoordination(coord.acquisitionId, {
      ...coord,
      phase: 'failed',
      error: { code: 'ACQUISITION_DEADLINE_EXCEEDED', message: 'Assignment deadline exceeded' }
    })
    const job = await store.get(coord.acquisitionId)
    if (job && job.state !== 'completed' && job.state !== 'failed' && job.state !== 'cancelled' && job.state !== 'verified') {
      await store.transition(coord.acquisitionId, {
        expectedVersion: job.version,
        from: job.state,
        to: 'failed',
        patch: { errorCode: 'ACQUISITION_DEADLINE_EXCEEDED', recoverable: false, finishedAt: current }
      }).catch(() => {})
    }
  }

  async function reconcileWorkerCoordination (coord, current) {
    if (coord.phase === 'result-ready') {
      if (!coord.result || coord.result.availabilityUntil <= current) {
        await expireWorkerCoordination(coord)
        return
      }
      await dispatchWorkerResult(coord, null, true).catch(() => {})
      return
    }
    if (coord.phase === 'assigned' || coord.phase === 'acquiring' || coord.phase === 'verifying') {
      const job = await store.get(coord.acquisitionId)
      if (job?.state === 'verified' && job.verifiedAsset) {
        await dispatchWorkerResult(coord, job).catch(() => {})
      }
    }
  }

  async function reconcileRequesterCoordination (coord) {
    if (coord.phase === 'result-ready' && coord.result && managerInstance) {
      await applyRequesterTransferredResult(coord).catch(() => {})
      return
    }
    if (coord.phase === 'requested' && !coord.assignmentId) {
      // Never memory-republish retained envelopes; re-sign from durable intent.
      await recoverRequested(coord).catch(() => {})
    }
  }

  async function reconcileSingleCoordination (coord, policyGeneration, current) {
    const ownGeneration = coord.role === 'worker'
      ? Number(coord.epoch)
      : requesterGeneration(coord)
    if (ownGeneration !== policyGeneration) {
      await cancelStaleCoordination(coord, policyGeneration)
      return
    }
    if (coord.deadline > 0 && current > coord.deadline && coord.phase !== 'result-ready') {
      await handleReconciliationDeadlineExceeded(coord, current)
      return
    }

    if (coord.role !== 'worker') await restoreNetworkSessions(coord)
    if (closed) return

    if (coord.role === 'worker') {
      await reconcileWorkerCoordination(coord, current)
    } else if (coord.role === 'requester') {
      await reconcileRequesterCoordination(coord)
    }
  }

  async function runReconciliation () {
    const current = safeNow(now)
    const policyGeneration = currentPolicyGeneration(await readPolicyTerms())
    if (closed) return
    const active = await store.listActiveCoordinations()
    if (closed) return

    for (const coord of active) {
      if (closed) return
      await reconcileSingleCoordination(coord, policyGeneration, current)
    }
  }

  async function start () {
    assertOpen()
    if (started) return coordinator
    started = true
    await reconcile()
    return coordinator
  }

  function close () {
    if (closing) return closing
    closed = true
    // Abort before the drain so in-flight transferred imports settle cooperatively.
    lifetime.abort()
    if (retryTimer !== null) cancelTimer(retryTimer)
    retryTimer = null
    retryRequested = false
    pendingOffers.clear()
    remoteRequests.clear()
    lastProgressSent.clear()
    closing = Promise.all([mutations, workerResults, retryPass, reconciliation].map(work => Promise.resolve(work).catch(() => {}))).then(() => {})
    return closing
  }

  const coordinator = Object.freeze({
    managerNetwork,
    networkManager,
    attachNetwork,
    bindManager,
    start,
    reconcile,
    close,
    getCoordination: id => store.getCoordination(id),
    listActiveCoordinations: () => store.listActiveCoordinations()
  })

  return coordinator
}
