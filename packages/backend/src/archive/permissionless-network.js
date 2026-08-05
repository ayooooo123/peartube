import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  createArchiveChallenge,
  createArchiveChallengeEnvelope,
  createArchiveChallengeResponse,
  createArchivePossessionProof,
  verifyArchiveChallengeEnvelope,
  verifyArchiveChallengeResponse,
} from './challenge.js'
import { createArchivePledge, verifyArchivePledge } from './pledge.js'
import { createArchiveRequest, verifyArchiveRequest } from './request.js'

const DEFAULT_REQUEST_TTL_MS = 5 * 60 * 1000
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024 * 1024 * 1024
const MAX_SEEN_REQUESTS = 2048
// Long enough that a re-announcing requester cannot force repeated
// authorization work, short enough that a catalog which just synced is used on
// the next announcement rather than the one after it.
const DEFERRED_REQUEST_RETRY_MS = 5 * 1000
const DEFAULT_CHALLENGE_INTERVAL_MS = 5 * 60 * 1000
const DEFAULT_CHALLENGE_TIMEOUT_MS = 15 * 1000
const DEFAULT_REANNOUNCE_INTERVAL_MS = 15 * 1000
const MAX_CHALLENGE_REPLAYS = 2048
const MAX_TIMER_DELAY_MS = 0x7fffffff
const PARTICIPATION_STATE_VERSION = 1
const DEFAULT_MAX_ACTIVE_CHALLENGES_PER_PEER = 2

function boundedBytes(value, name, fallback = 0) {
  const next = value == null ? fallback : Number(value)
  if (!Number.isSafeInteger(next) || next < 0) throw new Error(`${name} must be a non-negative safe integer`)
  return next
}

function probability(value, fallback) {
  const next = value == null ? fallback : Number(value)
  if (!Number.isFinite(next) || next < 0 || next > 1) throw new Error('acceptanceProbability must be between zero and one')
  return next
}

function sameRanges(left = [], right = []) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  return left.every((range, index) => {
    const other = right[index]
    return range.coreKey === other?.coreKey && range.start === other.start && range.end === other.end
  })
}

function pledgeCoversSourceLocators(body, locators) {
  if (!Array.isArray(locators) || locators.length === 0 || locators.length > 64) return false
  return locators.every(locator => {
    if (!locator || typeof locator.coreKey !== 'string' ||
        !Number.isSafeInteger(locator.start) || locator.start < 0 ||
        !Number.isSafeInteger(locator.end) || locator.end <= locator.start ||
        (locator.renditionId != null && locator.renditionId !== body.renditionId)) return false
    return body.ranges.some(range =>
      range.coreKey === locator.coreKey &&
      range.start <= locator.start &&
      range.end >= locator.end
    )
  })
}

function decodeParticipationState(value) {
  if (value == null) return null
  if (value.version !== PARTICIPATION_STATE_VERSION || typeof value.enabled !== 'boolean') {
    throw new Error('archive participation state is invalid')
  }
  return {
    enabled: value.enabled,
    capacityBytes: boundedBytes(value.capacityBytes, 'capacityBytes'),
    maxRequestBytes: boundedBytes(value.maxRequestBytes, 'maxRequestBytes'),
    acceptanceProbability: probability(value.acceptanceProbability, 0.25),
  }
}

export async function authorizeArchiveRequestFromManifestStore(request, options = {}) {
  const body = request?.body
  const manifestStore = options.manifestStore
  const authorizeRendition = options.authorizeRendition
  if (!body || typeof manifestStore?.getManifest !== 'function' || typeof authorizeRendition !== 'function') return false
  let manifest = manifestStore.getManifest(body.publicationId)
  if (!manifest && typeof options.resolveManifest === 'function') {
    try {
      manifest = await options.resolveManifest(body.publicationId)
    } catch {
      manifest = null
    }
  }
  const rendition = manifest?.body?.renditions?.find(candidate => candidate.renditionId === body.renditionId)
  const core = rendition?.core
  if (!manifest || !core || !Number.isSafeInteger(core.length) || core.length < 1 ||
      !Number.isSafeInteger(core.byteLength) || core.byteLength < 1 ||
      !Array.isArray(body.ranges) || body.ranges.length !== 1) return false
  const range = body.ranges[0]
  if (range.coreKey !== core.key || range.start !== 0 || range.end !== core.length ||
      body.requestedBytes !== core.byteLength) return false
  const authorized = await authorizeRendition({
    manifest,
    renditionId: rendition.renditionId,
    start: 0,
    end: core.length,
  })
  if (!authorized) return false
  return {
    accepted: true,
    requestedBytes: core.byteLength,
    ranges: body.ranges,
  }
}

function rememberBounded(map, key, value) {
  map.set(key, value)
  while (map.size > MAX_SEEN_REQUESTS) map.delete(map.keys().next().value)
}

function boundedPositiveMs(value, name, fallback) {
  const next = value == null ? fallback : Number(value)
  if (!Number.isSafeInteger(next) || next < 1) throw new Error(`${name} must be a positive safe integer`)
  return next
}

function pickIndex(entropy, length) {
  if (!Number.isSafeInteger(length) || length < 1) throw new Error('selection length must be positive')
  const bytes = b4a.from(entropy)
  const value = (((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3]) >>> 0
  return value % length
}

function transportId(value, name = 'transportPeerId') {
  if (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) return value
  const bytes = b4a.from(value || [])
  if (bytes.byteLength !== 32) throw new Error(`${name} must be a 32-byte key`)
  return b4a.toString(bytes, 'hex')
}

export function createPermissionlessArchiveNetwork(options = {}) {
  if (!options.keyPair?.publicKey || !options.keyPair?.secretKey) throw new TypeError('archive participation requires a local signing keyPair')
  if (!options.scopedNetwork?.retainAuthorizedArchive || !options.scopedNetwork?.releaseAuthorizedArchive) {
    throw new TypeError('archive participation requires the scoped archive network')
  }
  const now = typeof options.now === 'function' ? options.now : Date.now
  const random = typeof options.random === 'function' ? options.random : Math.random
  const authorizeRequest = typeof options.authorizeRequest === 'function' ? options.authorizeRequest : async () => false
  const authorizeConsumerVisibility = typeof options.authorizeConsumerVisibility === 'function'
    ? options.authorizeConsumerVisibility
    : async () => false
  const archiveStore = options.archiveStore || null
  const diagnostics = options.diagnostics || null
  const archivePolicy = options.archivePolicy || null
  const participationRepository = options.participationRepository || null
  const peerScorer = options.peerScorer || null
  const scopedNetwork = options.scopedNetwork
  const publishRequest = typeof options.publishRequest === 'function'
    ? options.publishRequest
    : async (envelope, body) => scopedNetwork.publishArchiveRequest?.({
        envelope,
        publicationId: body?.publicationId || null,
      })
  const publishPledge = typeof options.publishPledge === 'function'
    ? options.publishPledge
    : async envelope => scopedNetwork.publishArchivePledge?.({ envelope })
  const publishChallenge = typeof options.publishChallenge === 'function'
    ? options.publishChallenge
    : async envelope => scopedNetwork.publishArchiveChallenge?.({ envelope })
  const publishChallengeProof = typeof options.publishChallengeProof === 'function'
    ? options.publishChallengeProof
    : async packet => scopedNetwork.publishArchiveChallengeProof?.(packet)
  const keyPair = options.keyPair
  const archivistId = b4a.toString(b4a.from(keyPair.publicKey), 'hex')

  const configuredParticipation = {
    enabled: options.enabled !== undefined,
    capacityBytes: options.capacityBytes !== undefined,
    maxRequestBytes: options.maxRequestBytes !== undefined,
    acceptanceProbability: options.acceptanceProbability !== undefined,
  }
  let enabled = options.enabled === true
  let capacityBytes = boundedBytes(options.capacityBytes, 'capacityBytes')
  let maxRequestBytes = boundedBytes(options.maxRequestBytes, 'maxRequestBytes', DEFAULT_MAX_REQUEST_BYTES)
  let acceptanceProbability = probability(options.acceptanceProbability, 0.25)
  const localRequests = new Map()
  const seenRequests = new Map()
  const deferredRequests = new Map()
  const localArchivistPledges = new Map()
  const receivedPledges = new Map()
  const pendingChallenges = new Map()
  const challengeReplayCache = new Set()
  const challengeRequestReplayCache = new Set()
  const lastChallengeByAuditorPledge = new Map()
  const passedChallenges = new Map()
  const retentionTimers = new Map()
  const localRequestTimers = new Map()
  const receivedRetentionTimers = new Map()
  const activeChallengeProofsByPeer = new Map()
  const challengeIntervalMs = boundedPositiveMs(options.challengeIntervalMs, 'challengeIntervalMs', DEFAULT_CHALLENGE_INTERVAL_MS)
  const challengeTimeoutMs = boundedPositiveMs(options.challengeTimeoutMs, 'challengeTimeoutMs', DEFAULT_CHALLENGE_TIMEOUT_MS)
  const maxActiveChallengesPerPeer = Math.min(
    32,
    boundedPositiveMs(
      options.maxActiveChallengesPerPeer,
      'maxActiveChallengesPerPeer',
      DEFAULT_MAX_ACTIVE_CHALLENGES_PER_PEER
    )
  )
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout
  const transportPeerId = transportId(
    options.transportPeerId || scopedNetwork.getLocalTransportPeerId?.() || keyPair.publicKey
  )
  let challengeTimer = null
  let reannounceTimer = null

  function cancelReannounceSchedule() {
    if (reannounceTimer !== null) clearTimer(reannounceTimer)
    reannounceTimer = null
  }

  function scheduleReannounceCycle() {
    if (reannounceTimer !== null || !discoveryRetained || localRequests.size === 0) return
    reannounceTimer = setTimer(() => {
      reannounceTimer = null
      void service.reannounceLocalRequests().finally(scheduleReannounceCycle)
    }, DEFAULT_REANNOUNCE_INTERVAL_MS)
    reannounceTimer?.unref?.()
  }
  let randomRejections = 0
  let pendingReservationBytes = 0
  let capacityRejections = 0
  let authorizationRejections = 0
  let service = null
  let discoveryRetained = false
  const onArchiveRequest = envelope => service.ingestRequest(envelope)
  const onArchivePledge = (envelope, context) => service.ingestPledge(envelope, context)
  const onArchiveChallenge = (envelope, context) => service.ingestChallenge(envelope, context)
  const onArchiveChallengeProof = (packet, context) => service.ingestChallengeProof(packet, context)

  async function persistParticipation() {
    await participationRepository?.save?.({
      version: PARTICIPATION_STATE_VERSION,
      enabled,
      capacityBytes,
      maxRequestBytes,
      acceptanceProbability,
    })
  }

  async function restoreParticipation() {
    const persisted = decodeParticipationState(await participationRepository?.load?.())
    await archivePolicy?.ready
    const policySnapshot = await archivePolicy?.snapshot?.()
    if (!configuredParticipation.capacityBytes) {
      if (policySnapshot) capacityBytes = boundedBytes(policySnapshot.totalBytes, 'capacityBytes')
      else if (persisted) capacityBytes = persisted.capacityBytes
    }
    if (persisted) {
      if (!configuredParticipation.enabled) enabled = persisted.enabled
      if (!configuredParticipation.maxRequestBytes) maxRequestBytes = persisted.maxRequestBytes
      if (!configuredParticipation.acceptanceProbability) acceptanceProbability = persisted.acceptanceProbability
    }
  }

  async function ensureDiscovery() {
    if (discoveryRetained || typeof scopedNetwork.retainArchiveDiscovery !== 'function') return
    await scopedNetwork.retainArchiveDiscovery({
      onPeer: () => void service.reannounceLocalRequests(),
      onRequest: onArchiveRequest,
      onPledge: onArchivePledge,
      onChallenge: onArchiveChallenge,
      onChallengeProof: onArchiveChallengeProof,
    })
    discoveryRetained = true
    scheduleReannounceCycle()
  }

  async function releaseDiscovery() {
    if (!discoveryRetained) return
    discoveryRetained = false
    cancelReannounceSchedule()
    await scopedNetwork.releaseArchiveDiscovery?.({
      onRequest: onArchiveRequest,
      onPledge: onArchivePledge,
      onChallenge: onArchiveChallenge,
      onChallengeProof: onArchiveChallengeProof,
    })
  }

  function reservedBytes() {
    let total = 0
    for (const record of localArchivistPledges.values()) total += record.bytes
    return total
  }

  function capacitySnapshot() {
    const reserved = reservedBytes()
    return {
      totalBytes: capacityBytes,
      reservedBytes: reserved,
      availableBytes: Math.max(0, capacityBytes - reserved),
      observedAt: now(),
    }
  }

  function recordCapacity() {
    try { diagnostics?.recordCapacity?.(capacitySnapshot()) } catch {}
  }

  function recordCapacityRejection() {
    try { diagnostics?.recordCapacityRejection?.({ reason: 'capacity-exceeded', ...capacitySnapshot() }) } catch {}
  }

  function trimReplayCache(cache) {
    while (cache.size > MAX_CHALLENGE_REPLAYS) {
      cache.delete(cache.values().next().value)
    }
  }

  function cancelChallengeSchedule() {
    if (challengeTimer !== null) clearTimer(challengeTimer)
    challengeTimer = null
  }

  function scheduleChallengeCycle() {
    if (challengeTimer !== null || !discoveryRetained ||
        ![...receivedPledges.values()].some(record => record.peerId && record.pledge.body.retentionUntil > now())) return
    challengeTimer = setTimer(() => {
      challengeTimer = null
      void service.runChallengeCycle().finally(scheduleChallengeCycle)
    }, challengeIntervalMs)
    challengeTimer?.unref?.()
  }

  function cancelRetentionTimer(pledgeId) {
    const timer = retentionTimers.get(pledgeId)
    if (timer != null) clearTimer(timer)
    retentionTimers.delete(pledgeId)
  }

  function cancelLocalRequestTimer(requestId) {
    const timer = localRequestTimers.get(requestId)
    if (timer != null) clearTimer(timer)
    localRequestTimers.delete(requestId)
  }

  function scheduleLocalRequestExpiry(request) {
    const requestId = request.requestId
    cancelLocalRequestTimer(requestId)
    const remaining = request.body.expiresAt - now()
    if (remaining <= 0) {
      if (localRequests.get(requestId) === request) localRequests.delete(requestId)
      return
    }
    const timer = setTimer(() => {
      localRequestTimers.delete(requestId)
      if (request.body.expiresAt > now()) scheduleLocalRequestExpiry(request)
      else if (localRequests.get(requestId) === request) localRequests.delete(requestId)
    }, Math.min(remaining, MAX_TIMER_DELAY_MS))
    timer?.unref?.()
    localRequestTimers.set(requestId, timer)
  }

  function rememberLocalRequest(request) {
    localRequests.set(request.requestId, request)
    scheduleLocalRequestExpiry(request)
    scheduleReannounceCycle()
    while (localRequests.size > MAX_SEEN_REQUESTS) {
      const oldest = localRequests.keys().next().value
      localRequests.delete(oldest)
      cancelLocalRequestTimer(oldest)
    }
  }

  function cancelReceivedRetentionTimer(pledgeId) {
    const timer = receivedRetentionTimers.get(pledgeId)
    if (timer != null) clearTimer(timer)
    receivedRetentionTimers.delete(pledgeId)
  }

  async function expireReceivedPledge(pledgeId, record) {
    if (receivedPledges.get(pledgeId) !== record) return
    receivedPledges.delete(pledgeId)
    cancelReceivedRetentionTimer(pledgeId)
    passedChallenges.delete(pledgeId)
    for (const [nonce, pending] of pendingChallenges) {
      if (pending.pledge.pledgeId !== pledgeId) continue
      clearTimer(pending.timeout)
      pendingChallenges.delete(nonce)
    }
    await scopedNetwork.releaseAuthorizedArchive({ archiveId: pledgeId }).catch(() => {})
    await archiveStore?.putObservation?.({
      pledgeId,
      status: 'pledge-expired',
      observedAt: now(),
    })
    cancelChallengeSchedule()
    scheduleChallengeCycle()
  }

  function scheduleReceivedRetentionExpiry(pledgeId, record) {
    cancelReceivedRetentionTimer(pledgeId)
    const remaining = record.pledge.body.retentionUntil - now()
    if (remaining <= 0) {
      void expireReceivedPledge(pledgeId, record)
      return
    }
    const timer = setTimer(() => {
      receivedRetentionTimers.delete(pledgeId)
      if (record.pledge.body.retentionUntil > now()) scheduleReceivedRetentionExpiry(pledgeId, record)
      else void expireReceivedPledge(pledgeId, record)
    }, Math.min(remaining, MAX_TIMER_DELAY_MS))
    timer?.unref?.()
    receivedRetentionTimers.set(pledgeId, timer)
  }

  async function expireLocalPledge(requestId, record) {
    if (localArchivistPledges.get(requestId) !== record) return
    localArchivistPledges.delete(requestId)
    cancelRetentionTimer(record.pledge.pledgeId)
    await scopedNetwork.releaseAuthorizedArchive({ archiveId: record.pledge.pledgeId }).catch(() => {})
    await archivePolicy?.release?.({ pledgeId: record.pledge.pledgeId }).catch(() => {})
    await archiveStore?.putObservation?.({
      pledgeId: record.pledge.pledgeId,
      status: 'pledge-expired',
      observedAt: now(),
    })
    recordCapacity()
  }

  function scheduleRetentionExpiry(requestId, record) {
    cancelRetentionTimer(record.pledge.pledgeId)
    const remaining = record.pledge.body.retentionUntil - now()
    if (remaining <= 0) {
      void expireLocalPledge(requestId, record)
      return
    }
    const timer = setTimer(() => {
      retentionTimers.delete(record.pledge.pledgeId)
      if (record.pledge.body.retentionUntil > now()) scheduleRetentionExpiry(requestId, record)
      else void expireLocalPledge(requestId, record)
    }, Math.min(remaining, MAX_TIMER_DELAY_MS))
    timer?.unref?.()
    retentionTimers.set(record.pledge.pledgeId, timer)
  }

  async function restoreLocalPledges() {
    await archivePolicy?.ready
    const snapshot = await archivePolicy?.snapshot?.()
    for (const reservation of snapshot?.reservations || []) {
      if (reservation.expiresAt <= now()) {
        await archivePolicy.release({ pledgeId: reservation.pledgeId })
        await scopedNetwork.releaseAuthorizedArchive({ archiveId: reservation.pledgeId }).catch(() => {})
        continue
      }
      const pledge = await verifyArchivePledge(reservation.pledgeEnvelope, { now: now() })
      if (!pledge || pledge.pledgeId !== reservation.pledgeId ||
          pledge.body.archivistId !== archivistId ||
          pledge.body.retentionUntil !== reservation.expiresAt) {
        throw new Error('persisted archive reservation pledge is invalid')
      }
      const requestId = pledge.body.nonce
      const record = { request: null, pledge, bytes: reservation.reservedBytes }
      let visible = false
      try {
        visible = await authorizeConsumerVisibility({ body: pledge.body }) === true
      } catch {
        visible = false
      }
      if (!visible) {
        await archivePolicy.release({ pledgeId: pledge.pledgeId }).catch(() => {})
        await scopedNetwork.releaseAuthorizedArchive({ archiveId: pledge.pledgeId }).catch(() => {})
        archiveStore?.putObservation?.({
          pledgeId: pledge.pledgeId,
          status: 'pledge-expired',
          observedAt: now(),
        })
        continue
      }
      try {
        for (const range of pledge.body.ranges) {
          await scopedNetwork.retainAuthorizedArchive({ pledge, ...range })
        }
      } catch (error) {
        await scopedNetwork.releaseAuthorizedArchive({ archiveId: pledge.pledgeId }).catch(() => {})
        throw error
      }
      localArchivistPledges.set(requestId, record)
      scheduleRetentionExpiry(requestId, record)
    }
    recordCapacity()
  }

  async function releasePersistedReservations() {
    await archivePolicy?.ready
    const snapshot = await archivePolicy?.snapshot?.()
    for (const reservation of snapshot?.reservations || []) {
      await archivePolicy.release({ pledgeId: reservation.pledgeId }).catch(() => {})
      await scopedNetwork.releaseAuthorizedArchive({ archiveId: reservation.pledgeId }).catch(() => {})
      archiveStore?.putObservation?.({
        pledgeId: reservation.pledgeId,
        status: 'pledge-expired',
        observedAt: now(),
      })
    }
    recordCapacity()
  }

  async function suspendLocalPledges() {
    for (const record of localArchivistPledges.values()) {
      cancelRetentionTimer(record.pledge.pledgeId)
      await scopedNetwork.releaseAuthorizedArchive({ archiveId: record.pledge.pledgeId }).catch(() => {})
    }
    localArchivistPledges.clear()
    recordCapacity()
  }

  async function suspendReceivedPledges(recordExpiry = false) {
    const archiveIds = [...receivedPledges.keys()]
    cancelChallengeSchedule()
    for (const pending of pendingChallenges.values()) clearTimer(pending.timeout)
    pendingChallenges.clear()
    passedChallenges.clear()
    for (const pledgeId of archiveIds) {
      cancelReceivedRetentionTimer(pledgeId)
      if (recordExpiry) {
        archiveStore?.putObservation?.({ pledgeId, status: 'pledge-expired', observedAt: now() })
      }
    }
    receivedPledges.clear()
    await Promise.allSettled(archiveIds.map(archiveId => scopedNetwork.releaseAuthorizedArchive({ archiveId })))
  }

  function clearLocalRequests() {
    for (const requestId of localRequests.keys()) cancelLocalRequestTimer(requestId)
    localRequests.clear()
  }

  async function recordChallengeOutcome(pending, status, failureCode = null, score = true) {
    if (!pending) return
    const observedAt = now()
    if (status === 'challenge-passed') {
      passedChallenges.set(pending.pledge.pledgeId, observedAt)
    } else if (status === 'challenge-failed' || status === 'challenge-expired') {
      passedChallenges.delete(pending.pledge.pledgeId)
    }
    await archiveStore?.putObservation?.({
      pledgeId: pending.pledge.pledgeId,
      status,
      observedAt,
      failureCode,
    })
    if (score && pending.peerId) {
      const kind = status === 'challenge-passed' ? 'proof-accepted' : 'proof-rejected'
      peerScorer?.usefulWork?.reward?.(kind, 1, {
        peerId: pending.peerId,
        descriptorId: pending.pledge.body.renditionId,
        at: observedAt,
      })
    }
  }
  async function expireChallenge(challengeNonce) {
    const pending = pendingChallenges.get(challengeNonce)
    if (!pending) return
    pendingChallenges.delete(challengeNonce)
    await recordChallengeOutcome(pending, 'challenge-failed', 'UNAVAILABLE')
  }

  async function releaseLocalPledges() {
    for (const record of localArchivistPledges.values()) {
      archiveStore?.putObservation?.({
        pledgeId: record.pledge.pledgeId,
        status: 'pledge-expired',
        observedAt: now(),
      })
      cancelRetentionTimer(record.pledge.pledgeId)
      await archivePolicy?.release?.({ pledgeId: record.pledge.pledgeId }).catch(() => {})
      await scopedNetwork.releaseAuthorizedArchive({ archiveId: record.pledge.pledgeId }).catch(() => {})
    }
    localArchivistPledges.clear()
    await suspendReceivedPledges(true)
    clearLocalRequests()
    recordCapacity()
  }

  service = {
    async setParticipation(policy = {}) {
      await ready
      const nextCapacity = policy.capacityBytes === undefined
        ? capacityBytes
        : boundedBytes(policy.capacityBytes, 'capacityBytes')
      const nextMaxRequestBytes = policy.maxRequestBytes === undefined
        ? maxRequestBytes
        : boundedBytes(policy.maxRequestBytes, 'maxRequestBytes')
      const nextAcceptanceProbability = policy.acceptanceProbability === undefined
        ? acceptanceProbability
        : probability(policy.acceptanceProbability, acceptanceProbability)
      const nextEnabled = policy.enabled === undefined ? enabled : policy.enabled === true
      const locallyReservedBytes = [...localArchivistPledges.values()]
        .reduce((total, record) => total + record.bytes, 0)
      if (nextCapacity < locallyReservedBytes) {
        await releaseLocalPledges()
      }
      if (nextCapacity !== capacityBytes) {
        const updated = await archivePolicy?.setCapacity?.(nextCapacity)
        if (updated?.accepted === false) return { ...this.getStatus(), errorCode: 'ARCHIVE_CAPACITY_EXHAUSTED' }
      }
      capacityBytes = nextCapacity
      maxRequestBytes = nextMaxRequestBytes
      acceptanceProbability = nextAcceptanceProbability
      enabled = nextEnabled
      await archivePolicy?.expire?.(now())
      await persistParticipation()
      if (enabled) {
        await ensureDiscovery()
      } else {
        await releaseLocalPledges()
        await releaseDiscovery()
      }
      recordCapacity()
      return this.getStatus()
    },

    async reannounceLocalRequests() {
      await ready
      if (!enabled || !discoveryRetained) return { status: 'skipped', reannounced: 0 }
      const currentTime = now()
      let reannounced = 0
      for (const request of localRequests.values()) {
        if (request.body.expiresAt <= currentTime) continue
        const activePledges = [...receivedPledges.values()].filter(record =>
          record.pledge.body.nonce === request.requestId &&
          record.pledge.body.retentionUntil > currentTime
        )
        if (activePledges.length === 0) {
          // The re-announcement is the same request, so it must carry the same
          // publication identity as the first announcement. Publishing the bare
          // envelope left the transport with nothing to check local visibility
          // against, and it refused every re-announcement as invisible media -
          // so a request that found no archivist on its first pass could never
          // find one later.
          const result = await publishRequest(request.envelope, request.body)
          if (result?.delivered > 0) reannounced++
        }
      }
      return { status: 'ok', reannounced }
    },

    async requestArchive(input = {}) {
      await ready
      await ensureDiscovery()
      const issuedAt = now()
      const expiresAt = input.expiresAt ?? issuedAt + DEFAULT_REQUEST_TTL_MS
      const retentionUntil = input.retentionUntil ?? issuedAt + DEFAULT_RETENTION_MS
      const nonce = input.nonce || b4a.toString(crypto.randomBytes(16), 'hex')
      const request = createArchiveRequest({
        ...input,
        requesterId: keyPair.publicKey,
        issuedAt,
        expiresAt,
        retentionUntil,
        nonce,
        keyPair,
      })
      rememberLocalRequest(request)
      await publishRequest(request.envelope, request.body)
      return { status: 'published', requestId: request.requestId, request }
    },

    async revalidateConsumerRequests(authorize) {
      await ready
      if (typeof authorize !== 'function') throw new TypeError('consumer archive authorization callback is required')
      let cancelledRequests = 0
      let releasedPledges = 0
      const hiddenRequestIds = new Set()
      for (const [requestId, request] of [...localRequests]) {
        let allowed = false
        try {
          allowed = await authorize(request)
        } catch {
          allowed = false
        }
        if (allowed) continue
        hiddenRequestIds.add(requestId)
        localRequests.delete(requestId)
        cancelLocalRequestTimer(requestId)
        cancelledRequests++
      }
      for (const [pledgeId, record] of [...receivedPledges]) {
        const requestId = record.pledge.body.nonce
        let allowed = !hiddenRequestIds.has(requestId)
        if (allowed) {
          const request = localRequests.get(requestId) || { body: record.pledge.body }
          try {
            allowed = await authorize(request)
          } catch {
            allowed = false
          }
        }
        if (allowed) continue
        await expireReceivedPledge(pledgeId, record)
        releasedPledges++
      }
      for (const [requestId, record] of [...localArchivistPledges]) {
        const request = record.request || { body: record.pledge.body }
        let allowed = false
        try {
          allowed = await authorize(request)
        } catch {
          allowed = false
        }
        if (allowed) continue
        await expireLocalPledge(requestId, record)
        releasedPledges++
      }
      return { cancelledRequests, releasedPledges }
    },

    async ingestRequest(envelope) {
      await ready
      const request = await verifyArchiveRequest(envelope, { now: now() })
      if (!request) return { status: 'rejected', reason: 'request-invalid' }
      if (!enabled) return { status: 'rejected', reason: 'participation-disabled' }
      if (seenRequests.has(request.requestId)) return { status: 'rejected', reason: 'request-replayed' }
      // A request can arrive before this device has synced the publisher
      // catalog that authorizes it. Recording it as seen at that moment
      // permanently blackholes it: every later re-announcement is refused as a
      // replay, so the archivist never pledges for content it would gladly
      // hold. Defer instead, and re-evaluate once the catalog can answer.
      const deferredAt = deferredRequests.get(request.requestId)
      if (deferredAt !== undefined && now() - deferredAt < DEFERRED_REQUEST_RETRY_MS) {
        return { status: 'rejected', reason: 'request-deferred' }
      }
      if (request.body.requesterId === archivistId) return { status: 'rejected', reason: 'self-request' }
      if (request.body.requestedBytes > maxRequestBytes ||
          reservedBytes() + pendingReservationBytes + request.body.requestedBytes > capacityBytes) {
        capacityRejections++
        recordCapacityRejection()
        return { status: 'rejected', reason: 'capacity-exceeded' }
      }

      let authorization
      try {
        authorization = await authorizeRequest(request)
      } catch {
        authorization = false
      }
      if (!authorization || authorization.accepted === false ||
          authorization.requestedBytes !== request.body.requestedBytes ||
          !sameRanges(authorization.ranges, request.body.ranges)) {
        authorizationRejections++
        rememberBounded(deferredRequests, request.requestId, now())
        return { status: 'rejected', reason: 'manifest-not-authorized' }
      }
      let visible = false
      try {
        visible = await authorizeConsumerVisibility(request) === true
      } catch {
        visible = false
      }
      if (!visible) {
        authorizationRejections++
        rememberBounded(deferredRequests, request.requestId, now())
        return { status: 'rejected', reason: 'consumer-not-visible' }
      }
      // Past every check that local state can still change the answer to, so
      // this request is now decided once and never re-rolled.
      deferredRequests.delete(request.requestId)
      rememberBounded(seenRequests, request.requestId, now())

      const sample = Number(random())
      if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new Error('random source must return a number in [0, 1)')
      if (sample >= acceptanceProbability) {
        randomRejections++
        return { status: 'rejected', reason: 'randomly-declined' }
      }
      if (reservedBytes() + pendingReservationBytes + request.body.requestedBytes > capacityBytes) {
        capacityRejections++
        recordCapacityRejection()
        return { status: 'rejected', reason: 'capacity-exceeded' }
      }
      pendingReservationBytes += request.body.requestedBytes

      const pledge = createArchivePledge({
        archivistId: keyPair.publicKey,
        publicationId: request.body.publicationId,
        renditionId: request.body.renditionId,
        ranges: request.body.ranges,
        retentionUntil: request.body.retentionUntil,
        uploadCeilingBytes: Math.min(request.body.requestedBytes * 4, Number.MAX_SAFE_INTEGER),
        issuedAt: now(),
        nonce: request.requestId,
        keyPair,
      })
      try {
        const reservation = await archivePolicy?.reserve?.({
          pledgeId: pledge.pledgeId,
          bytes: request.body.requestedBytes,
          expiresAt: pledge.body.retentionUntil,
          pledgeEnvelope: pledge.envelope,
        })
        if (reservation && reservation.accepted !== true) {
          capacityRejections++
          recordCapacityRejection()
          return { status: 'rejected', reason: 'capacity-exceeded' }
        }
        for (const range of pledge.body.ranges) {
          await scopedNetwork.retainAuthorizedArchive({ pledge, ...range })
        }
        const reconciled = await archivePolicy?.reconcile?.({
          pledgeId: pledge.pledgeId,
          actualBytes: request.body.requestedBytes,
          complete: true,
        })
        if (reconciled && reconciled.accepted !== true) throw new Error('archive reservation reconciliation failed')
        await archiveStore?.putPledge?.(pledge.envelope)
        const record = { request, pledge, bytes: request.body.requestedBytes }
        localArchivistPledges.set(request.requestId, record)
        scheduleRetentionExpiry(request.requestId, record)
        recordCapacity()
        await publishPledge(pledge.envelope)
        return { status: 'accepted', requestId: request.requestId, pledge }
      } catch (error) {
        localArchivistPledges.delete(request.requestId)
        cancelRetentionTimer(pledge.pledgeId)
        await archivePolicy?.release?.({ pledgeId: pledge.pledgeId }).catch(() => {})
        await scopedNetwork.releaseAuthorizedArchive({ archiveId: pledge.pledgeId }).catch(() => {})
        recordCapacity()
        return { status: 'rejected', reason: 'retention-failed', errorCode: String(error?.code || 'ARCHIVE_RETENTION_FAILED') }
      } finally {
        pendingReservationBytes = Math.max(0, pendingReservationBytes - request.body.requestedBytes)
      }
    },

    async ingestPledge(envelope, context = {}) {
      await ready
      const pledge = await verifyArchivePledge(envelope, { now: now() })
      if (!pledge) return { status: 'rejected', reason: 'pledge-invalid' }
      if (receivedPledges.has(pledge.pledgeId)) return { status: 'rejected', reason: 'pledge-replayed' }
      const request = localRequests.get(pledge.body.nonce)
      if (!request) return { status: 'rejected', reason: 'pledge-unsolicited' }
      if (pledge.body.publicationId !== request.body.publicationId ||
          pledge.body.renditionId !== request.body.renditionId ||
          pledge.body.retentionUntil !== request.body.retentionUntil ||
          !sameRanges(pledge.body.ranges, request.body.ranges)) {
        return { status: 'rejected', reason: 'pledge-request-mismatch' }
      }
      try {
        for (const range of pledge.body.ranges) {
          await scopedNetwork.retainAuthorizedArchive({ pledge, ...range, download: false })
        }
        await archiveStore?.putPledge?.(pledge.envelope)
        receivedPledges.set(pledge.pledgeId, {
          pledge,
          peerId: context.peerId === undefined
            ? pledge.body.archivistId
            : (/^[0-9a-f]{64}$/.test(context.peerId) ? context.peerId : null),
        })
        const record = receivedPledges.get(pledge.pledgeId)
        scheduleReceivedRetentionExpiry(pledge.pledgeId, record)
        scheduleChallengeCycle()
        recordCapacity()
        return { status: 'accepted', requestId: request.requestId, pledge }
      } catch (error) {
        await scopedNetwork.releaseAuthorizedArchive({ archiveId: pledge.pledgeId }).catch(() => {})
        recordCapacity()
        return { status: 'rejected', reason: 'scope-join-failed', errorCode: String(error?.code || 'ARCHIVE_SCOPE_FAILED') }
      }
    },

    async runChallengeCycle() {
      await ready
      if (!discoveryRetained) return { status: 'skipped', reason: 'archive-discovery-disabled' }
      if (pendingChallenges.size > 0) return { status: 'skipped', reason: 'challenge-pending' }
      const currentTime = now()
      const candidates = [...receivedPledges.values()].filter(record =>
        record.peerId && record.pledge.body.retentionUntil > currentTime
      )
      if (candidates.length === 0) return { status: 'skipped', reason: 'no-active-pledges' }
      const entropy = crypto.randomBytes(32)
      const selected = candidates[pickIndex(entropy, candidates.length)]
      const ranges = selected.pledge.body.ranges
      const range = ranges[pickIndex(entropy.subarray(4), ranges.length)]
      const index = range.start + pickIndex(entropy.subarray(8), range.end - range.start)
      const deadline = Math.min(selected.pledge.body.retentionUntil, currentTime + challengeTimeoutMs)
      if (deadline <= currentTime) return { status: 'skipped', reason: 'pledge-expired' }
      const challenge = createArchiveChallenge({
        pledgeEnvelope: selected.pledge.envelope,
        auditorEntropy: entropy,
        coreKey: range.coreKey,
        range: { start: index, end: index + 1 },
        deadline,
        auditorPublicKey: keyPair.publicKey,
      })
      const signed = createArchiveChallengeEnvelope({ challenge, keyPair, issuedAt: currentTime })
      const timeout = setTimer(() => void expireChallenge(challenge.challengeNonce), Math.max(1, deadline - currentTime))
      timeout?.unref?.()
      pendingChallenges.set(challenge.challengeNonce, { challenge, signed, pledge: selected.pledge, peerId: selected.peerId, timeout })
      await archiveStore?.putObservation?.({
        pledgeId: selected.pledge.pledgeId,
        status: 'challenge-issued',
        observedAt: currentTime,
      })
      try {
        const published = await publishChallenge(signed.envelope)
        if (published === undefined) throw new Error('archive challenge transport is unavailable')
        return { status: 'published', pledgeId: selected.pledge.pledgeId, challenge }
      } catch (error) {
        clearTimer(timeout)
        pendingChallenges.delete(challenge.challengeNonce)
        await recordChallengeOutcome({ pledge: selected.pledge, peerId: selected.peerId }, 'challenge-cancelled', 'ARCHIVE_CHALLENGE_PUBLISH_FAILED', false)
        return { status: 'rejected', reason: 'challenge-publish-failed', errorCode: String(error?.code || 'ARCHIVE_CHALLENGE_PUBLISH_FAILED') }
      }
    },

    async ingestChallenge(envelope, context = {}) {
      await ready
      const challenge = await verifyArchiveChallengeEnvelope(envelope, {
        now: now(),
        replayCache: challengeRequestReplayCache,
      })
      trimReplayCache(challengeRequestReplayCache)
      const record = [...localArchivistPledges.values()].find(candidate =>
        candidate.pledge.pledgeId === challenge.pledgeId
      )
      if (!record) return { status: 'rejected', reason: 'challenge-pledge-unknown' }
      if (challenge.deadline > now() + challengeTimeoutMs) {
        return { status: 'rejected', reason: 'challenge-deadline-unbounded' }
      }
      const limiterPeerId = /^[0-9a-f]{64}$/.test(context.peerId || '') ? context.peerId : challenge.auditorPublicKey
      if ((activeChallengeProofsByPeer.get(limiterPeerId) || 0) >= maxActiveChallengesPerPeer) {
        return { status: 'rejected', reason: 'challenge-peer-busy' }
      }
      const limiterKey = `${limiterPeerId}:${challenge.pledgeId}`
      const lastChallengeAt = lastChallengeByAuditorPledge.get(limiterKey)
      if (lastChallengeAt != null && now() - lastChallengeAt < challengeIntervalMs) {
        return { status: 'rejected', reason: 'challenge-rate-limited' }
      }
      lastChallengeByAuditorPledge.set(limiterKey, now())
      while (lastChallengeByAuditorPledge.size > MAX_SEEN_REQUESTS) {
        lastChallengeByAuditorPledge.delete(lastChallengeByAuditorPledge.keys().next().value)
      }
      activeChallengeProofsByPeer.set(limiterPeerId, (activeChallengeProofsByPeer.get(limiterPeerId) || 0) + 1)
      try {
        const index = challenge.range.start
        const proofBytes = await scopedNetwork.createAuthorizedArchiveChallengeProof({
          archiveId: record.pledge.pledgeId,
          coreKey: challenge.coreKey,
          index,
        })
        const proof = createArchivePossessionProof({ challenge, proofBytes })
        const response = createArchiveChallengeResponse({
          challenge,
          pledgeEnvelope: record.pledge.envelope,
          proof,
          transportPeerId,
          keyPair,
          issuedAt: now(),
        })
        const published = await publishChallengeProof({ envelope: response.envelope, proofBytes })
        if (published === undefined) throw new Error('archive challenge proof transport is unavailable')
        return { status: 'published', pledgeId: record.pledge.pledgeId }
      } catch (error) {
        return { status: 'rejected', reason: 'challenge-proof-failed', errorCode: String(error?.code || 'ARCHIVE_CHALLENGE_PROOF_FAILED') }
      } finally {
        const remaining = (activeChallengeProofsByPeer.get(limiterPeerId) || 0) - 1
        if (remaining > 0) activeChallengeProofsByPeer.set(limiterPeerId, remaining)
        else activeChallengeProofsByPeer.delete(limiterPeerId)
      }
    },

    async ingestChallengeProof(packet = {}, context = {}) {
      await ready
      if (!packet.envelope || !packet.proofBytes) return { status: 'rejected', reason: 'challenge-proof-invalid' }
      let claimed
      try { claimed = JSON.parse(b4a.toString(packet.envelope.body || [])) } catch {
        return { status: 'rejected', reason: 'challenge-proof-invalid' }
      }
      const pending = pendingChallenges.get(claimed.challengeNonce)
      if (!pending) return { status: 'rejected', reason: 'challenge-unsolicited' }
      if (context.peerId !== pending.peerId) return { status: 'rejected', reason: 'challenge-transport-mismatch' }
      const proofBytes = b4a.from(packet.proofBytes)
      const verified = await verifyArchiveChallengeResponse(packet.envelope, {
        challenge: pending.challenge,
        pledgeEnvelope: pending.pledge.envelope,
        transportPeerId: pending.peerId,
        now: now(),
        proofBytes,
        replayCache: challengeReplayCache,
        verifyProof: bytes => scopedNetwork.verifyAuthorizedArchiveChallengeProof({
          archiveId: pending.pledge.pledgeId,
          coreKey: pending.challenge.coreKey,
          index: pending.challenge.range.start,
          proofBytes: bytes,
        }),
      })
      if (!verified) {
        clearTimer(pending.timeout)
        pendingChallenges.delete(pending.challenge.challengeNonce)
        await recordChallengeOutcome(pending, 'challenge-failed', 'INVALID_PROOF')
        return { status: 'rejected', reason: 'challenge-proof-invalid' }
      }
      trimReplayCache(challengeReplayCache)
      clearTimer(pending.timeout)
      pendingChallenges.delete(pending.challenge.challengeNonce)
      await recordChallengeOutcome(pending, 'challenge-passed')
      return { status: 'accepted', pledgeId: pending.pledge.pledgeId }
    },

    getOffloadEvidence(publicationId, locators = []) {
      const currentTime = now()
      const freshnessMs = Math.min(
        Math.max(challengeIntervalMs * 2 + challengeTimeoutMs, 60_000),
        24 * 60 * 60 * 1000
      )
      const evidence = []
      for (const record of receivedPledges.values()) {
        const pledge = record.pledge
        const passedAt = passedChallenges.get(pledge.pledgeId)
        if (pledge.body.publicationId !== publicationId ||
            !pledgeCoversSourceLocators(pledge.body, locators) ||
            pledge.body.retentionUntil <= currentTime ||
            !Number.isSafeInteger(passedAt)) continue
        evidence.push({
          archivistId: pledge.body.archivistId,
          physicalDeviceId: record.peerId || pledge.body.archivistId,
          sameDevice: false,
          connected: scopedNetwork.isPeerConnected?.(record.peerId) === true,
          recent: currentTime - passedAt <= freshnessMs,
          passed: true,
          intentional: true,
        })
      }
      return evidence.sort((left, right) => left.archivistId.localeCompare(right.archivistId))
    },


    getStatus() {
      return {
        enabled,
        capacityBytes,
        maxRequestBytes,
        acceptanceProbability,
        reservedBytes: reservedBytes(),
        availableBytes: Math.max(0, capacityBytes - reservedBytes()),
        acceptedRequests: localArchivistPledges.size,
        knownRequests: localRequests.size,
        receivedPledges: receivedPledges.size,
        randomRejections,
        capacityRejections,
        authorizationRejections,
      }
    },

    async close() {
      enabled = false
      await ready
      await suspendLocalPledges()
      await suspendReceivedPledges()
      await releaseDiscovery()
      clearLocalRequests()
      seenRequests.clear()
      deferredRequests.clear()
      activeChallengeProofsByPeer.clear()
    },
  }
  const ready = (async () => {
    await restoreParticipation()
    if (enabled) await restoreLocalPledges()
    else await releasePersistedReservations()
    if (enabled) await ensureDiscovery()
  })()
  service.ready = ready
  recordCapacity()
  return service
}
