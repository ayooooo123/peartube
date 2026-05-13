const ROLE_MOBILE = 'mobile'
const ROLE_RELAY = 'relay'
const ROLE_HYBRID = 'hybrid'

const TRANSITION_RANK = {
  discovered: 0,
  verified: 1,
  active: 2,
  quarantined: 3,
  tombstoned: 4,
}

const DEFAULT_POLICY = {
  minDescriptorFreshnessMs: 10 * 60 * 1000,
  longTailWindowMs: 12 * 60 * 60 * 1000,
  proofFreshnessMs: 20 * 60 * 1000,
  minReachableCopies: 2,
  mobile: {
    maxFanout: 2,
    maxRequestsPerWindow: 4,
    syncIntervalMs: 20 * 60 * 1000,
    maxBytesPerDay: 50 * 1024 * 1024,
    proofIntervalMs: 45 * 60 * 1000,
    refreshIntervalMs: 90 * 60 * 1000,
  },
  relay: {
    maxFanout: 16,
    maxRequestsPerWindow: 64,
    syncIntervalMs: 2 * 60 * 1000,
    maxBytesPerDay: 5 * 1024 * 1024 * 1024,
    proofIntervalMs: 10 * 60 * 1000,
    refreshIntervalMs: 20 * 60 * 1000,
  },
}

function safeNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function safeBigInt(value, fallback = 0n) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.max(0, Math.floor(value)))
  if (typeof value === 'string' && value.trim()) {
    try { return BigInt(value) } catch {}
  }
  return fallback
}

function toHex(bytes) {
  if (!bytes) return ''
  if (typeof bytes === 'string') return bytes.toLowerCase().replace(/^0x/, '')
  if (bytes instanceof Uint8Array) return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  if (bytes instanceof ArrayBuffer) return toHex(new Uint8Array(bytes))
  return String(bytes)
}

function stableStringify(value) {
  if (value === null || value === undefined) return String(value)
  if (value instanceof Uint8Array) return `u8:${toHex(value)}`
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function hashText(input) {
  const str = stableStringify(input)
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function nowMs(value = Date.now()) {
  return safeBigInt(value, BigInt(Date.now()))
}

function normalizeRole(role) {
  if (role === ROLE_RELAY || role === ROLE_MOBILE || role === ROLE_HYBRID) return role
  return ROLE_HYBRID
}

function cloneDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return null
  return {
    ...descriptor,
    descriptorId: toHex(descriptor.descriptorId),
    contentRoot: toHex(descriptor.contentRoot),
    dasRoot: toHex(descriptor.dasRoot),
    swarmTopic: toHex(descriptor.swarmTopic),
    sourceRefHash: toHex(descriptor.sourceRefHash),
    publisherIdentity: toHex(descriptor.publisherIdentity),
    parentDescriptorId: toHex(descriptor.parentDescriptorId),
    signer: toHex(descriptor.signer),
    signature: toHex(descriptor.signature),
    publishAt: safeBigInt(descriptor.publishAt, 0n),
    expiresAt: safeBigInt(descriptor.expiresAt, 0n),
    availabilityEpoch: safeNumber(descriptor.availabilityEpoch, 0),
    flags: safeNumber(descriptor.flags, 0),
  }
}

function descriptorIdOf(value) {
  return toHex(value?.descriptorId || value?.id || value?.driveKey || value)
}

function compareEventOrder(a, b) {
  const timeA = safeBigInt(a?.observedAt || a?.localSeenAt || a?.ts || 0n, 0n)
  const timeB = safeBigInt(b?.observedAt || b?.localSeenAt || b?.ts || 0n, 0n)
  if (timeA > timeB) return 1
  if (timeA < timeB) return -1
  const eventA = toHex(a?.eventId || a?.entryId || a?.proofId || '')
  const eventB = toHex(b?.eventId || b?.entryId || b?.proofId || '')
  return eventA.localeCompare(eventB)
}

function transitionRank(state) {
  return TRANSITION_RANK[String(state || 'discovered').toLowerCase()] ?? 0
}

function isNewerThan(current, next) {
  if (!current) return true
  const cmp = compareEventOrder(next, current)
  if (cmp > 0) return true
  if (cmp < 0) return false
  const currentRank = transitionRank(current.state)
  const nextRank = transitionRank(next.state)
  return nextRank >= currentRank
}

function mergeDescriptor(current, incoming) {
  if (!current) return cloneDescriptor(incoming)
  const merged = cloneDescriptor(current)
  const next = cloneDescriptor(incoming)
  for (const key of Object.keys(next)) {
    if (next[key] === null || next[key] === undefined || next[key] === '') continue
    if (merged[key] === null || merged[key] === undefined || merged[key] === '') {
      merged[key] = next[key]
      continue
    }
    if (typeof next[key] === 'bigint' && next[key] > merged[key]) merged[key] = next[key]
    else if (typeof next[key] === 'number' && next[key] > merged[key]) merged[key] = next[key]
  }
  return merged
}

function identityAgeScore(identity = {}, now = Date.now()) {
  const createdAt = safeBigInt(identity.createdAt || 0n, 0n)
  const ageMs = createdAt > 0n ? Math.max(0n, nowMs(now) - createdAt) : 0n
  return Math.min(40, Number(ageMs / BigInt(24 * 60 * 60 * 1000)))
}

export function createSybilPolicy(options = {}) {
  const base = {
    minProofs: safeNumber(options.minProofs, 1),
    maxFailurePenalty: safeNumber(options.maxFailurePenalty, 45),
    maxQuarantinePenalty: safeNumber(options.maxQuarantinePenalty, 35),
    maxTombstonePenalty: safeNumber(options.maxTombstonePenalty, 50),
    maxSpamPenalty: safeNumber(options.maxSpamPenalty, 20),
  }

  return {
    scoreIdentity(identity = {}, now = Date.now()) {
      const age = identityAgeScore(identity, now)
      const validProofs = Math.min(30, safeNumber(identity.validProofCount, 0) * 6)
      const successfulSeals = Math.min(15, safeNumber(identity.successfulSealCount, 0) * 3)
      const serviceScore = Math.min(15, Math.floor(safeNumber(identity.usefulWorkScore, 0) / 25))
      const failures = Math.min(base.maxFailurePenalty, safeNumber(identity.failureCount, 0) * 9)
      const quarantines = Math.min(base.maxQuarantinePenalty, safeNumber(identity.quarantineCount, 0) * 7)
      const tombstones = Math.min(base.maxTombstonePenalty, safeNumber(identity.tombstoneCount, 0) * 10)
      const spam = Math.min(base.maxSpamPenalty, safeNumber(identity.spamScore, 0) * 4)
      const freshness = Math.max(0, 10 - Math.floor(Math.max(0, safeNumber(identity.lastProofAgeMs, Infinity)) / (60 * 60 * 1000)))
      const score = 20 + age + validProofs + successfulSeals + serviceScore + freshness - failures - quarantines - tombstones - spam
      return Math.max(0, Math.min(100, score))
    },
    allowsFanout(identity, peerCount = 0, now = Date.now()) {
      const score = this.scoreIdentity(identity, now)
      const scaledFanout = Math.max(1, Math.floor(score / 10))
      return Math.min(Math.max(1, peerCount || 1), scaledFanout)
    },
    allowsRequest(identity, inFlight = 0, now = Date.now()) {
      const score = this.scoreIdentity(identity, now)
      const allowance = Math.max(1, Math.floor(score / 15))
      return inFlight < allowance
    },
  }
}

export function createUsefulWorkLedger(options = {}) {
  const byPeer = new Map()
  const byDescriptor = new Map()
  const totals = {
    verifiedDescriptors: 0,
    refreshedDescriptors: 0,
    sampledDescriptors: 0,
    bytesServed: 0n,
    longTailServed: 0,
    proofsAccepted: 0,
    proofsRejected: 0,
  }

  function bucket(map, key) {
    if (!map.has(key)) map.set(key, { count: 0, score: 0, bytes: 0n, lastAt: 0n })
    return map.get(key)
  }

  function reward(kind, amount = 1, context = {}) {
    const descriptorId = descriptorIdOf(context.descriptorId || context.descriptor || '')
    const peerId = toHex(context.peerId || context.identityId || '')
    const at = safeBigInt(context.at || Date.now(), nowMs())
    let scoreDelta = 0

    switch (kind) {
      case 'descriptor-verified':
        scoreDelta = 10 * amount
        totals.verifiedDescriptors += amount
        break
      case 'descriptor-refreshed':
        scoreDelta = 6 * amount
        totals.refreshedDescriptors += amount
        break
      case 'availability-sampled':
        scoreDelta = 5 * amount
        totals.sampledDescriptors += amount
        break
      case 'bytes-served':
        scoreDelta = Math.max(1, Math.floor(Number(amount) / (64 * 1024)))
        totals.bytesServed += safeBigInt(amount, 0n)
        break
      case 'long-tail-served':
        scoreDelta = 12 * amount
        totals.longTailServed += amount
        break
      case 'proof-accepted':
        scoreDelta = 8 * amount
        totals.proofsAccepted += amount
        break
      case 'proof-rejected':
        scoreDelta = -6 * amount
        totals.proofsRejected += amount
        break
      default:
        scoreDelta = 0
    }

    if (descriptorId) {
      const d = bucket(byDescriptor, descriptorId)
      d.count += amount
      d.score += scoreDelta
      d.lastAt = at > d.lastAt ? at : d.lastAt
      if (kind === 'bytes-served') d.bytes += safeBigInt(amount, 0n)
    }

    if (peerId) {
      const p = bucket(byPeer, peerId)
      p.count += amount
      p.score += scoreDelta
      p.lastAt = at > p.lastAt ? at : p.lastAt
      if (kind === 'bytes-served') p.bytes += safeBigInt(amount, 0n)
    }

    return scoreDelta
  }

  function scoreUsefulWork() {
    const byteScore = Number(totals.bytesServed / BigInt(1024 * 1024))
    return Math.max(0, totals.verifiedDescriptors * 10 + totals.refreshedDescriptors * 6 + totals.sampledDescriptors * 5 + totals.longTailServed * 12 + totals.proofsAccepted * 8 + byteScore + totals.proofsRejected * -2)
  }

  function snapshot() {
    return {
      totals: {
        ...totals,
        bytesServed: totals.bytesServed,
      },
      byPeer: Array.from(byPeer.entries()),
      byDescriptor: Array.from(byDescriptor.entries()),
      usefulWorkScore: scoreUsefulWork(),
    }
  }

  return { reward, scoreUsefulWork, snapshot, byPeer, byDescriptor, totals }
}

export function createAvailabilityPlanner(options = {}) {
  const minCopies = Math.max(1, safeNumber(options.minReachableCopies, DEFAULT_POLICY.minReachableCopies))
  const longTailWindowMs = Math.max(60 * 60 * 1000, safeNumber(options.longTailWindowMs, DEFAULT_POLICY.longTailWindowMs))
  const proofFreshnessMs = Math.max(5 * 60 * 1000, safeNumber(options.proofFreshnessMs, DEFAULT_POLICY.proofFreshnessMs))
  const descriptorFreshnessMs = Math.max(60 * 1000, safeNumber(options.minDescriptorFreshnessMs, DEFAULT_POLICY.minDescriptorFreshnessMs))

  function isLongTail(descriptor = {}, now = Date.now()) {
    const lastSeenAt = safeBigInt(descriptor.lastSeenAt || descriptor.publishAt || 0n, 0n)
    const seenWindow = nowMs(now) - lastSeenAt
    const peerCount = safeNumber(descriptor.peerCount, 0)
    const videoCount = safeNumber(descriptor.videoCount, 0)
    return seenWindow >= BigInt(longTailWindowMs) || peerCount <= minCopies || videoCount <= 3
  }

  function hasReachability(descriptor = {}, now = Date.now()) {
    const proofAt = safeBigInt(descriptor.lastProofAt || 0n, 0n)
    const expiresAt = safeBigInt(descriptor.expiresAt || 0n, 0n)
    if (expiresAt > 0n && nowMs(now) > expiresAt) return false
    if (proofAt > 0n && nowMs(now) - proofAt > BigInt(proofFreshnessMs)) return false
    return Boolean(descriptor.reachable !== false)
  }

  function shouldAdmit(descriptor = {}, now = Date.now()) {
    if (!descriptorIdOf(descriptor)) return false
    if (descriptor.tombstoned) return false
    if (descriptor.quarantined && !descriptor.quarantineExpired) return false
    return hasReachability(descriptor, now)
  }

  function shouldForward(descriptor = {}, now = Date.now()) {
    if (!shouldAdmit(descriptor, now)) return false
    const freshness = safeBigInt(descriptor.publishAt || 0n, 0n)
    if (freshness > 0n && nowMs(now) - freshness > BigInt(descriptorFreshnessMs)) return false
    return true
  }

  function needsRefresh(descriptor = {}, now = Date.now()) {
    const lastRefreshAt = safeBigInt(descriptor.lastRefreshAt || 0n, 0n)
    const proofAt = safeBigInt(descriptor.lastProofAt || 0n, 0n)
    if (lastRefreshAt === 0n) return true
    if (nowMs(now) - lastRefreshAt >= BigInt(descriptorFreshnessMs)) return true
    if (proofAt > 0n && nowMs(now) - proofAt >= BigInt(proofFreshnessMs)) return true
    return isLongTail(descriptor, now)
  }

  return { minCopies, longTailWindowMs, proofFreshnessMs, descriptorFreshnessMs, isLongTail, hasReachability, shouldAdmit, shouldForward, needsRefresh }
}

export function createResourcePolicy(options = {}) {
  const role = normalizeRole(options.role)
  const profile = role === ROLE_RELAY ? DEFAULT_POLICY.relay : DEFAULT_POLICY.mobile
  const batteryFloor = safeNumber(options.batteryFloor, role === ROLE_RELAY ? 5 : 25)
  const bandwidthFloor = safeNumber(options.bandwidthFloor, role === ROLE_RELAY ? 0 : 5)
  const maxConcurrentSync = safeNumber(options.maxConcurrentSync, role === ROLE_RELAY ? 8 : 1)
  const maxConcurrentProofs = safeNumber(options.maxConcurrentProofs, role === ROLE_RELAY ? 4 : 1)
  const maxConcurrentFetches = safeNumber(options.maxConcurrentFetches, role === ROLE_RELAY ? 8 : 1)

  function budgetFor(resource = {}) {
    const battery = safeNumber(resource.batteryPercent, 100)
    const bandwidth = safeNumber(resource.bandwidthScore, 100)
    const thermal = safeNumber(resource.thermalScore, 0)
    const charging = Boolean(resource.isCharging)

    const mobilePenalty = role === ROLE_MOBILE ? Math.max(0, 30 - battery) + Math.max(0, 20 - bandwidth) + Math.max(0, thermal) : 0
    const base = role === ROLE_RELAY ? 100 : 50
    const credit = Math.max(0, base - mobilePenalty + (charging ? 10 : 0))

    return {
      role,
      syncIntervalMs: profile.syncIntervalMs,
      proofIntervalMs: profile.proofIntervalMs,
      refreshIntervalMs: profile.refreshIntervalMs,
      maxFanout: profile.maxFanout,
      maxRequestsPerWindow: profile.maxRequestsPerWindow,
      maxBytesPerDay: profile.maxBytesPerDay,
      batteryFloor,
      bandwidthFloor,
      maxConcurrentSync,
      maxConcurrentProofs,
      maxConcurrentFetches,
      credit,
      canSync: battery >= batteryFloor && bandwidth >= bandwidthFloor,
      canEmitProof: battery >= Math.max(10, batteryFloor - 5) && bandwidth >= bandwidthFloor,
      canFetch: battery >= Math.max(10, batteryFloor - 10) && bandwidth >= bandwidthFloor,
    }
  }

  return { role, profile, budgetFor }
}

export function createConcurrentState(options = {}) {
  return {
    descriptors: new Map(),
    peers: new Map(),
    events: new Map(),
    tombstones: new Map(),
    quarantines: new Map(),
    causalWatermark: 0n,
    lastAppliedAt: nowMs(options.now || Date.now()),
  }
}

function normalizeTransition(input = {}) {
  const state = String(input.state || input.nextState || 'discovered').toLowerCase()
  return {
    state,
    eventId: input.eventId || input.entryId || input.proofId || input.id || '',
    observedAt: safeBigInt(input.observedAt || input.localSeenAt || Date.now(), nowMs()),
    descriptorId: descriptorIdOf(input.descriptorId || input.descriptor || input),
    descriptor: input.descriptor || null,
    reason: input.reason || input.reasonCode || null,
    proofId: input.proofId || input.lastProofId || null,
    quarantineUntil: safeBigInt(input.quarantineUntil || 0n, 0n),
    tombstonedAt: safeBigInt(input.tombstonedAt || 0n, 0n),
    signatureValid: input.signatureValid !== false,
    reachable: input.reachable !== false,
  }
}

function resolveConflict(current, incoming) {
  if (!current) return incoming
  const newer = isNewerThan(current, incoming)
  if (!newer) return current
  const mergedDescriptor = mergeDescriptor(current.descriptor, incoming.descriptor)
  const next = {
    ...current,
    ...incoming,
    descriptor: mergedDescriptor,
    firstSeenAt: current.firstSeenAt || incoming.firstSeenAt || incoming.observedAt,
    lastSeenAt: maxBigInt(current.lastSeenAt, incoming.observedAt),
    lastUpdatedAt: incoming.observedAt,
    conflictCount: (current.conflictCount || 0) + (current.descriptor && incoming.descriptor && hashText(current.descriptor) !== hashText(incoming.descriptor) ? 1 : 0),
    duplicateCount: current.duplicateCount || 0,
  }

  const currentRank = transitionRank(current.state)
  const incomingRank = transitionRank(incoming.state)
  if (incomingRank >= currentRank) {
    next.state = incoming.state
  }
  if (incoming.state === 'quarantined') {
    next.quarantineUntil = maxBigInt(current.quarantineUntil, incoming.quarantineUntil)
  }
  if (incoming.state === 'tombstoned') {
    next.tombstonedAt = maxBigInt(current.tombstonedAt, incoming.tombstonedAt || incoming.observedAt)
  }
  return next
}

function maxBigInt(...values) {
  return values.reduce((acc, value) => {
    const next = safeBigInt(value, 0n)
    return next > acc ? next : acc
  }, 0n)
}

export function applyConcurrentUpdate(state, input = {}, options = {}) {
  const next = normalizeTransition(input)
  const id = next.descriptorId
  if (!id) return { applied: false, reason: 'missing-descriptor-id', state }

  const eventKey = toHex(next.eventId)
  if (eventKey && state.events.has(eventKey)) {
    const record = state.events.get(eventKey)
    record.duplicateCount = (record.duplicateCount || 0) + 1
    return { applied: false, reason: 'duplicate-event', state, record }
  }

  const current = state.descriptors.get(id) || null
  const record = resolveConflict(current, next)
  record.eventId = next.eventId
  record.lastUpdatedAt = next.observedAt
  record.state = record.state || next.state

  if (next.state === 'quarantined') {
    record.quarantined = true
    state.quarantines.set(id, record)
    state.tombstones.delete(id)
  } else if (next.state === 'tombstoned') {
    record.tombstoned = true
    state.tombstones.set(id, record)
    state.quarantines.delete(id)
  } else {
    record.quarantined = false
    record.tombstoned = false
    if (next.signatureValid) {
      state.quarantines.delete(id)
      if (record.state !== 'tombstoned') state.tombstones.delete(id)
    }
  }

  state.descriptors.set(id, record)
  state.events.set(eventKey || hashText(next), record)
  state.causalWatermark = record.lastUpdatedAt > state.causalWatermark ? record.lastUpdatedAt : state.causalWatermark
  state.lastAppliedAt = record.lastUpdatedAt

  return { applied: true, record, state }
}

export function createUniversalCore(options = {}) {
  const role = normalizeRole(options.role)
  const sybil = createSybilPolicy(options.sybil)
  const usefulWork = createUsefulWorkLedger(options.usefulWork)
  const availability = createAvailabilityPlanner(options.availability)
  const resources = createResourcePolicy({ role, ...options.resources })
  const state = options.state || createConcurrentState(options)

  function scorePeer(peer = {}, now = Date.now()) {
    const identityScore = sybil.scoreIdentity(peer.identity || peer, now)
    const useful = Math.max(0, safeNumber(peer.usefulWorkScore, 0))
    const reachability = availability.shouldAdmit(peer.descriptor || peer, now) ? 10 : 0
    const resourceFit = resources.budgetFor(peer.resources || peer).credit
    return Math.max(0, Math.min(100, identityScore + Math.floor(useful / 10) + reachability + Math.floor(resourceFit / 10)))
  }

  function registerPeer(peer = {}) {
    const id = toHex(peer.peerId || peer.identity?.publicKey || peer.identityId || hashText(peer))
    const score = scorePeer(peer)
    const record = {
      ...peer,
      peerId: id,
      score,
      lastSeenAt: nowMs(peer.lastSeenAt || Date.now()),
      fanoutBudget: sybil.allowsFanout(peer.identity || peer, resources.profile.maxFanout),
      requestBudget: sybil.allowsRequest(peer.identity || peer, peer.inFlightRequests || 0),
    }
    state.peers.set(id, record)
    return record
  }

  function recordUsefulWork(kind, amount = 1, context = {}) {
    return usefulWork.reward(kind, amount, context)
  }

  function ingestDescriptor(descriptor, context = {}) {
    const normalized = cloneDescriptor(descriptor)
    if (!normalized) return { accepted: false, reason: 'invalid-descriptor' }
    if (!availability.shouldAdmit(normalized, context.now || Date.now())) {
      return { accepted: false, reason: 'unreachable-or-stale' }
    }
    const result = applyConcurrentUpdate(state, {
      descriptorId: normalized.descriptorId,
      descriptor: normalized,
      state: availability.shouldForward(normalized, context.now || Date.now()) ? 'active' : 'verified',
      eventId: context.eventId || normalized.signature || normalized.descriptorId,
      observedAt: context.observedAt || normalized.publishAt || nowMs(),
      signatureValid: context.signatureValid !== false,
      reachable: true,
    }, context)

    if (result.applied) recordUsefulWork('descriptor-verified', 1, { descriptorId: normalized.descriptorId, peerId: context.peerId, at: context.observedAt || Date.now() })
    return { accepted: result.applied, record: result.record, state }
  }

  function ingestProof(proof, context = {}) {
    const descriptorId = descriptorIdOf(proof?.descriptorId || proof?.descriptor || '')
    if (!descriptorId) return { accepted: false, reason: 'missing-descriptor-id' }
    const reachable = Boolean(proof?.reachable !== false && proof?.signatureValid !== false)
    const result = applyConcurrentUpdate(state, {
      descriptorId,
      descriptor: context.descriptor || proof.descriptor || { descriptorId },
      state: reachable ? 'active' : 'quarantined',
      eventId: context.eventId || proof.proofId || proof.signature || descriptorId,
      observedAt: proof.observedAt || context.observedAt || Date.now(),
      proofId: proof.proofId,
      quarantineUntil: proof.quarantineUntil || 0n,
      tombstonedAt: proof.tombstonedAt || 0n,
      signatureValid: proof.signatureValid !== false,
      reachable,
    }, context)

    if (reachable && result.applied) {
      recordUsefulWork('proof-accepted', 1, { descriptorId, peerId: context.peerId, at: context.observedAt || Date.now() })
    } else {
      recordUsefulWork('proof-rejected', 1, { descriptorId, peerId: context.peerId, at: context.observedAt || Date.now() })
    }
    return { accepted: result.applied, record: result.record, state }
  }

  function shouldSyncPeer(peer = {}, now = Date.now()) {
    const peerRecord = state.peers.get(toHex(peer.peerId || peer.identity?.publicKey || '')) || registerPeer(peer)
    return resources.budgetFor(peer.resources || peer).canSync && peerRecord.score >= 20 && sybil.allowsRequest(peer.identity || peer, peer.inFlightRequests || 0, now)
  }

  function chooseFanoutPeers(peers = [], now = Date.now()) {
    const ranked = Array.isArray(peers)
      ? peers.map((peer) => ({ peer, score: scorePeer(peer, now) }))
          .sort((a, b) => b.score - a.score)
      : []
    const limit = sybil.allowsFanout(options.identity || {}, resources.profile.maxFanout, now)
    return ranked.slice(0, limit).map((entry) => entry.peer)
  }

  function planRefresh(descriptor, now = Date.now()) {
    const record = descriptor || {}
    const longTail = availability.isLongTail(record, now)
    const needsRefresh = availability.needsRefresh(record, now)
    const proofDue = safeBigInt(record.lastProofAt || 0n, 0n) === 0n || nowMs(now) - safeBigInt(record.lastProofAt || 0n, 0n) >= BigInt(resources.profile.proofIntervalMs)
    const fetchDue = needsRefresh || longTail
    const rotateEpoch = fetchDue || proofDue
    return {
      longTail,
      needsRefresh,
      proofDue,
      fetchDue,
      rotateEpoch,
      nextSyncAt: Number(nowMs(now) + BigInt(resources.profile.syncIntervalMs)),
      nextProofAt: Number(nowMs(now) + BigInt(resources.profile.proofIntervalMs)),
      nextRefreshAt: Number(nowMs(now) + BigInt(resources.profile.refreshIntervalMs)),
    }
  }

  function usefulWorkSnapshot() {
    return usefulWork.snapshot()
  }

  function stateSnapshot() {
    return {
      role,
      peers: Array.from(state.peers.values()),
      descriptors: Array.from(state.descriptors.values()),
      quarantines: Array.from(state.quarantines.values()),
      tombstones: Array.from(state.tombstones.values()),
      causalWatermark: state.causalWatermark,
      lastAppliedAt: state.lastAppliedAt,
    }
  }

  return {
    role,
    state,
    sybil,
    usefulWork,
    availability,
    resources,
    scorePeer,
    registerPeer,
    recordUsefulWork,
    ingestDescriptor,
    ingestProof,
    shouldSyncPeer,
    chooseFanoutPeers,
    planRefresh,
    usefulWorkSnapshot,
    stateSnapshot,
  }
}

export default {
  ROLE_MOBILE,
  ROLE_RELAY,
  ROLE_HYBRID,
  createSybilPolicy,
  createUsefulWorkLedger,
  createAvailabilityPlanner,
  createResourcePolicy,
  createConcurrentState,
  applyConcurrentUpdate,
  createUniversalCore,
}
