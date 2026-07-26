const MAX_AVAILABILITY_RANGES = 128
const MAX_AVAILABILITY_PEERS = 256
const MAX_AVAILABILITY_REASONS = 8
const MAX_TRANSPORT_KEY_LENGTH = 128

/**
 * Versioned protocol constants. These are not user-tunable ranking knobs: the
 * consumer surface renders one availability contract, so every client must
 * agree on how much evidence "healthy" requires and how fast it decays.
 */
export const MIN_HEALTHY_PEERS = 2
export const AVAILABILITY_EVIDENCE_TTL_MS = 60_000

export const AVAILABILITY_STATES = Object.freeze({
  awaitingReplication: 'awaiting-replication',
  limited: 'limited',
  healthy: 'healthy',
  unavailable: 'unavailable',
})

/**
 * Bounded reason codes in canonical emission order. Order is priority, not
 * alphabetical, so truncation drops the least explanatory code first.
 */
export const AVAILABILITY_REASON_CODES = Object.freeze([
  'METADATA_ONLY',
  'NEVER_ASSESSED',
  'ASSESSMENT_BUDGET_EXCEEDED',
  'COMPLETE_PEER_EVIDENCE',
  'UNION_RANGE_COVERAGE',
  'INSUFFICIENT_INDEPENDENT_PEERS',
  'PARTIAL_RANGE_COVERAGE',
  'EVIDENCE_EXPIRED',
  'VALIDATION_MISMATCH',
  'PEER_TIMEOUT',
  'PEER_DISCONNECT',
  'LOCAL_COMPLETE_COPY',
  'ARCHIVE_PLEDGE_ONLY',
])

const REASON_RANK = new Map(AVAILABILITY_REASON_CODES.map((code, index) => [code, index]))

function normalizeRange(range = {}, coreLength) {
  const start = Number(range.start)
  const end = Number(range.end)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > coreLength) {
    throw new Error('invalid availability range')
  }
  return { start, end }
}

export function createAvailabilitySummary(input = {}) {
  const coreLength = Number(input.coreLength)
  if (!Number.isSafeInteger(coreLength) || coreLength < 0) throw new Error('coreLength must be non-negative integer')
  const ranges = input.ranges || []
  if (!Array.isArray(ranges) || ranges.length > MAX_AVAILABILITY_RANGES) throw new Error('too many availability ranges')
  return {
    renditionId: String(input.renditionId || ''),
    coreLength,
    ranges: ranges.map(range => normalizeRange(range, coreLength)).sort((a, b) => a.start - b.start || a.end - b.end),
  }
}

function covers(delivered = [], target = {}) {
  return delivered.some(range => Number(range.start) <= target.start && Number(range.end) >= target.end)
}

export function verifyAvailabilityDelivery(summary, proof = {}) {
  if (!summary || proof.renditionId !== summary.renditionId) return false
  const delivered = Array.isArray(proof.delivered) ? proof.delivered : []
  return summary.ranges.every(range => covers(delivered, range))
}

function boundedRanges(value, name) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > MAX_AVAILABILITY_RANGES) throw new Error(`${name} must be a bounded range array`)
  const ranges = []
  for (const entry of value) {
    const start = Number(entry?.start)
    const end = Number(entry?.end)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
      throw new Error(`${name} contains an invalid range`)
    }
    ranges.push({ start, end })
  }
  return ranges
}

function mergeRanges(ranges) {
  const sorted = ranges.slice().sort((left, right) => left.start - right.start || left.end - right.end)
  const merged = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end) {
      if (range.end > last.end) last.end = range.end
      continue
    }
    merged.push({ start: range.start, end: range.end })
  }
  return merged
}

function containedBy(merged, target) {
  return merged.some(range => range.start <= target.start && range.end >= target.end)
}

function coveredCount(merged, required) {
  let count = 0
  for (const range of required) {
    if (containedBy(merged, range)) count += 1
  }
  return count
}

function intersectRanges(left, right) {
  const result = []
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length && rightIndex < right.length) {
    const start = Math.max(left[leftIndex].start, right[rightIndex].start)
    const end = Math.min(left[leftIndex].end, right[rightIndex].end)
    if (start < end) result.push({ start, end })
    if (left[leftIndex].end < right[rightIndex].end) leftIndex += 1
    else rightIndex += 1
  }
  return result
}

function transportKey(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TRANSPORT_KEY_LENGTH) {
    throw new Error('peer transportKey must be a bounded string')
  }
  return value.toLowerCase()
}

function nonNegativeInteger(value) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) return 0
  return number
}

const CHALLENGE_SEVERITY = Object.freeze({ failed: 4, timeout: 3, pending: 2, passed: 1 })

function challengeStatus(value) {
  const status = String(value || 'pending')
  return Object.hasOwn(CHALLENGE_SEVERITY, status) ? status : 'pending'
}

/**
 * Collapse raw peer observations into transport identities. A transport
 * identity is the authenticated remote Noise public key: duplicate sockets from
 * one key count once, and the worst challenge outcome across those sockets
 * wins, so an adversary cannot launder a failed validation behind a second
 * connection.
 *
 * `challengeStatus: 'passed'` is the only proof gate: it means an unpredictable
 * local challenge sampled this peer's advertised blocks and every sampled block
 * hash-verified. `provenRanges` narrows that proof when the challenge could
 * only cover part of the advertisement; omitting it asserts the challenge
 * sampled across the whole advertised set.
 */
function normalizePeers(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > MAX_AVAILABILITY_PEERS) throw new Error('peers must be a bounded array')
  const identities = new Map()
  for (const peer of value) {
    const key = transportKey(peer?.transportKey)
    const status = challengeStatus(peer?.challengeStatus)
    const existing = identities.get(key)
    const normalized = existing || {
      transportKey: key,
      connected: false,
      advertisedRanges: [],
      provenRanges: [],
      provenScoped: false,
      advertisedAt: 0,
      challengeStatus: 'passed',
      verifiedAt: 0,
      archivist: false,
    }
    normalized.connected = normalized.connected || peer?.connected === true
    normalized.archivist = normalized.archivist || peer?.archivist === true
    normalized.advertisedRanges.push(...boundedRanges(peer?.advertisedRanges, 'advertisedRanges'))
    if (peer?.provenRanges != null) {
      normalized.provenScoped = true
      normalized.provenRanges.push(...boundedRanges(peer.provenRanges, 'provenRanges'))
    }
    normalized.advertisedAt = Math.max(normalized.advertisedAt, nonNegativeInteger(peer?.advertisedAt))
    if (CHALLENGE_SEVERITY[status] > CHALLENGE_SEVERITY[normalized.challengeStatus]) {
      normalized.challengeStatus = status
    }
    if (status === 'passed') normalized.verifiedAt = Math.max(normalized.verifiedAt, nonNegativeInteger(peer?.verifiedAt))
    identities.set(key, normalized)
  }
  for (const identity of identities.values()) {
    identity.advertisedRanges = mergeRanges(identity.advertisedRanges)
    identity.provenRanges = mergeRanges(identity.provenRanges)
    // Hash-verified reachability bounds what a peer may contribute: an
    // advertisement the local challenge never reached proves nothing.
    identity.evidenceRanges = identity.provenScoped
      ? intersectRanges(identity.advertisedRanges, identity.provenRanges)
      : identity.advertisedRanges
  }
  return [...identities.values()].sort((left, right) => left.transportKey.localeCompare(right.transportKey))
}

export function normalizeAvailabilityEvidence(input = {}) {
  const requiredRanges = mergeRanges(boundedRanges(input.requiredRanges, 'requiredRanges'))
  const localRanges = mergeRanges(boundedRanges(input.localRanges, 'localRanges'))
  return {
    publicationId: input.publicationId == null ? null : String(input.publicationId),
    renditionId: input.renditionId == null ? null : String(input.renditionId),
    requiredRanges,
    localRanges,
    peers: normalizePeers(input.peers),
    archivePledgeCount: nonNegativeInteger(input.archivePledgeCount ?? (Array.isArray(input.archivePledges) ? input.archivePledges.length : 0)),
    previouslyObserved: input.previouslyObserved === true,
    budgetExceeded: input.budgetExceeded === true,
  }
}

function orderReasons(reasons) {
  return [...new Set(reasons)]
    .filter(code => REASON_RANK.has(code))
    .sort((left, right) => REASON_RANK.get(left) - REASON_RANK.get(right))
    .slice(0, MAX_AVAILABILITY_REASONS)
}

/**
 * Why a peer contributes nothing right now. `null` means "we have not learned
 * anything yet" — a peer that only advertised, or one that vanished before any
 * challenge, proves neither reachability nor its absence.
 */
function exclusionReason(peer, fresh) {
  if (peer.challengeStatus === 'failed') return 'VALIDATION_MISMATCH'
  if (peer.challengeStatus === 'timeout') return 'PEER_TIMEOUT'
  if (peer.verifiedAt === 0) return null
  if (!peer.connected) return 'PEER_DISCONNECT'
  if (!fresh) return 'EVIDENCE_EXPIRED'
  return null
}

/**
 * Deterministic, point-in-time availability assessment.
 *
 * This is a local observation, not consensus, durability, or Sybil-proof
 * truth: multiple Noise keys held by one adversary still look independent, so
 * callers must never translate `healthy` into an SLA or durability claim.
 * Static archive pledges and a local complete copy are reported separately and
 * never advance network availability.
 */
export function assessAvailability(input = {}, options = {}) {
  const evidence = normalizeAvailabilityEvidence(input)
  const observedAt = nonNegativeInteger(options.now ?? input.now ?? Date.now())
  const requiredRangeCount = evidence.requiredRanges.length
  const offlinePlayable = requiredRangeCount > 0 &&
    coveredCount(evidence.localRanges, evidence.requiredRanges) === requiredRangeCount
  const archivePledged = evidence.archivePledgeCount > 0

  const base = {
    publicationId: evidence.publicationId,
    renditionId: evidence.renditionId,
    observedAt,
    expiresAt: observedAt,
    requiredRangeCount,
    reachableRangeCount: 0,
    independentPeerCount: 0,
    completePeerCount: 0,
    offlinePlayable,
    archivePledged,
  }

  // Metadata without an immutable rendition can never be Healthy: there is
  // nothing for a peer to serve.
  if (requiredRangeCount === 0) {
    return Object.freeze({
      ...base,
      state: AVAILABILITY_STATES.awaitingReplication,
      reasonCodes: orderReasons(['METADATA_ONLY', ...(archivePledged ? ['ARCHIVE_PLEDGE_ONLY'] : [])]),
    })
  }

  const exclusions = []
  const contributors = []
  for (const peer of evidence.peers) {
    const fresh = peer.verifiedAt > 0 && observedAt - peer.verifiedAt <= AVAILABILITY_EVIDENCE_TTL_MS
    const eligible = peer.connected &&
      peer.challengeStatus === 'passed' &&
      fresh &&
      peer.verifiedAt >= peer.advertisedAt
    if (!eligible) {
      const reason = exclusionReason(peer, fresh)
      if (reason) exclusions.push(reason)
      continue
    }
    contributors.push(peer)
  }

  const union = mergeRanges(contributors.flatMap(peer => peer.evidenceRanges))
  const reachableRangeCount = coveredCount(union, evidence.requiredRanges)
  const completePeers = contributors.filter(
    peer => coveredCount(peer.evidenceRanges, evidence.requiredRanges) === requiredRangeCount
  )

  const summary = {
    ...base,
    reachableRangeCount,
    independentPeerCount: contributors.length,
    completePeerCount: completePeers.length,
  }
  const localReasons = [
    ...(offlinePlayable ? ['LOCAL_COMPLETE_COPY'] : []),
    ...(archivePledged && contributors.length === 0 ? ['ARCHIVE_PLEDGE_ONLY'] : []),
  ]

  if (completePeers.length >= MIN_HEALTHY_PEERS) {
    // Healthy holds until the MIN_HEALTHY_PEERS-th freshest complete proof ages out.
    const expiries = completePeers
      .map(peer => peer.verifiedAt + AVAILABILITY_EVIDENCE_TTL_MS)
      .sort((left, right) => right - left)
    return Object.freeze({
      ...summary,
      state: AVAILABILITY_STATES.healthy,
      expiresAt: expiries[MIN_HEALTHY_PEERS - 1],
      reasonCodes: orderReasons(['COMPLETE_PEER_EVIDENCE', ...exclusions, ...localReasons]),
    })
  }

  if (contributors.length > 0 && reachableRangeCount === requiredRangeCount) {
    return Object.freeze({
      ...summary,
      state: AVAILABILITY_STATES.limited,
      expiresAt: Math.min(...contributors.map(peer => peer.verifiedAt + AVAILABILITY_EVIDENCE_TTL_MS)),
      reasonCodes: orderReasons([
        completePeers.length > 0 ? 'COMPLETE_PEER_EVIDENCE' : 'UNION_RANGE_COVERAGE',
        'INSUFFICIENT_INDEPENDENT_PEERS',
        ...exclusions,
        ...localReasons,
      ]),
    })
  }

  // A peer that merely advertised and has not been challenged yet proves
  // nothing in either direction. Only a decisive outcome — a served-and-
  // verified peer, an expired proof, a validation mismatch, a timeout, or a
  // disconnect — can downgrade a title to Unavailable.
  const observed = evidence.previouslyObserved || exclusions.length > 0 || contributors.length > 0
  if (!observed) {
    return Object.freeze({
      ...summary,
      state: AVAILABILITY_STATES.awaitingReplication,
      reasonCodes: orderReasons([
        evidence.budgetExceeded ? 'ASSESSMENT_BUDGET_EXCEEDED' : 'NEVER_ASSESSED',
        ...localReasons,
      ]),
    })
  }

  return Object.freeze({
    ...summary,
    state: AVAILABILITY_STATES.unavailable,
    reasonCodes: orderReasons([
      ...(contributors.length > 0 ? ['PARTIAL_RANGE_COVERAGE'] : []),
      ...exclusions,
      ...localReasons,
    ]),
  })
}

const AVAILABILITY_STATE_SCORE = Object.freeze({
  [AVAILABILITY_STATES.healthy]: 100,
  [AVAILABILITY_STATES.limited]: 40,
  [AVAILABILITY_STATES.awaitingReplication]: 0,
  [AVAILABILITY_STATES.unavailable]: 0,
})

export function availabilityScoreForState(state) {
  return AVAILABILITY_STATE_SCORE[String(state)] ?? 0
}

export function isPlayableAvailability(availability) {
  const state = String(availability?.state || '')
  return state === AVAILABILITY_STATES.healthy || state === AVAILABILITY_STATES.limited
}

/**
 * Required ranges for one immutable rendition. Block coverage — not byte
 * length — is what a peer must advertise and prove.
 */
export function requiredRangesForRendition(rendition) {
  const length = nonNegativeInteger(rendition?.core?.length ?? rendition?.coreLength)
  return length > 0 ? [{ start: 0, end: length }] : []
}
