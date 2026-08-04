import { AVAILABILITY_STATES, availabilityScoreForState } from '../assets/availability.js'

export function sourceAvailabilityScore(source = {}) {
  if (source.availability) return availabilityScoreForState(source.availability.state)
  return 0
}

/**
 * Hard rejections, evaluated before any scoring. A source that fails one of
 * these is not "worse" — it cannot play at all, so it never competes and never
 * becomes a failover target.
 */
export const PLAYBACK_REJECTION_CODES = Object.freeze([
  'BLOCKED_BY_MODERATION',
  'BLOCKED_BY_LOCAL_POLICY',
  'UNAUTHORIZED_PUBLICATION',
  'UNSUPPORTED_CODEC',
  'UNSUPPORTED_CONTAINER',
  'STALE_MANIFEST',
  'INCOMPLETE_PUBLICATION',
  'INCOMPLETE_COLLECTION_BINDING',
  'NO_AVAILABLE_COPY',
  'STALE_AVAILABILITY',
  'UNCONFIRMED_AVAILABILITY',
])

export const PLAYBACK_RANKING_CODES = Object.freeze([
  'DEPRIORITIZED_BY_LOCAL_PREFERENCE',
  'LOWER_LOCAL_SCORE',
  'LOCAL_SCORE_TIE_BREAK',
  'DEPRIORITIZED_BY_LOCAL_ORDER',
])

export const PLAYBACK_SELECTION_CODES = Object.freeze([
  'SELECTED_BY_LOCAL_PREFERENCE',
  'SELECTED_BY_HIGHEST_SCORE',
  'SELECTED_BY_LOCAL_TIE_BREAK',
  'SELECTED_BY_LOCAL_ORDER',
])

const REJECTION_RANK = new Map(PLAYBACK_REJECTION_CODES.map((code, index) => [code, index]))

/**
 * Weights for the playback score. Every input is a local playability fact.
 * Publisher popularity, paid placement, and promotional ranking are absent by
 * construction: there is nowhere to put them.
 */
export const PLAYBACK_SOURCE_SCORE_WEIGHTS = Object.freeze({
  localCompleteness: 500,
  startupReachability: 300,
  peerEvidence: 200,
  formatSupport: 100,
  startupLatency: -1,
  userOverride: 1_000,
})

const BLOCKING_DECISIONS = new Set(['block', 'blocked', 'deny', 'denied', 'reject', 'rejected', 'hidden'])

function decisionBlocks(value) {
  if (value === true) return true
  const candidate = typeof value === 'string' ? value : value?.decision || value?.action || value?.state
  return typeof candidate === 'string' && BLOCKING_DECISIONS.has(candidate.toLowerCase())
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function supportsAll(supported, required) {
  if (!Array.isArray(required) || required.length === 0) return true
  if (!Array.isArray(supported)) return true
  return required.every(item => supported.includes(item))
}

/**
 * Device capability and local policy gate. `capabilities` describes what this
 * device can actually decode; an absent capability list means the caller has
 * not constrained that dimension and the source passes.
 */
function rejectionCodesFor(source, capabilities, now) {
  const codes = []
  if (decisionBlocks(source.moderationDecision)) codes.push('BLOCKED_BY_MODERATION')
  if (decisionBlocks(source.localPolicyDecision) || source.blocked === true) codes.push('BLOCKED_BY_LOCAL_POLICY')
  if (source.publicationAuthorized !== true || !nonEmptyString(source.renditionId)) codes.push('UNAUTHORIZED_PUBLICATION')

  if (!supportsAll(capabilities.codecs, source.codecs)) codes.push('UNSUPPORTED_CODEC')
  if (nonEmptyString(source.container) && Array.isArray(capabilities.containers) && !capabilities.containers.includes(source.container)) {
    codes.push('UNSUPPORTED_CONTAINER')
  }

  if (source.manifestStale === true || source.superseded === true) codes.push('STALE_MANIFEST')
  if (source.incomplete === true || source.manifestComplete === false) codes.push('INCOMPLETE_PUBLICATION')
  if (source.collectionMemberBound === false) codes.push('INCOMPLETE_COLLECTION_BINDING')

  const state = source.availability?.state
  const expiresAt = Number(source.availability?.expiresAt)
  if (state === AVAILABILITY_STATES.unavailable) codes.push('NO_AVAILABLE_COPY')
  else if (Number.isFinite(now) && Number.isFinite(expiresAt) && expiresAt > 0 && now > expiresAt) codes.push('STALE_AVAILABILITY')
  // Not having asked a peer yet is not a reason to refuse: the catalog names
  // the core, holding it is how bytes arrive, and trying is how anyone finds
  // out. Only a decided negative - no copy, or an expired assessment - keeps a
  // source out of the running.

  return codes.sort((left, right) => REJECTION_RANK.get(left) - REJECTION_RANK.get(right))
}

// `-0` is a real hazard here: a zero-latency source would otherwise report a
// component that deep-equals differently from every other zero on the wire.
function weigh(value, weight) {
  return value * weight || 0
}

function playbackScoreComponents(source) {
  const availability = source.availability || null
  const required = Math.max(1, Number(availability?.requiredRangeCount) || 1)
  const reachable = Math.max(0, Math.min(required, Number(availability?.reachableRangeCount) || 0))
  const completePeers = Math.max(0, Number(availability?.completePeerCount) || 0)
  const latencyMs = Math.min(5_000, Math.max(0, Number(source.expectedStartupLatencyMs) || 0))
  return {
    scoreLocalCompleteness: weigh(availability?.offlinePlayable === true ? 1 : 0, PLAYBACK_SOURCE_SCORE_WEIGHTS.localCompleteness),
    scoreStartupReachability: weigh(reachable / required, PLAYBACK_SOURCE_SCORE_WEIGHTS.startupReachability),
    scorePeerEvidence: weigh(Math.min(1, completePeers / 2), PLAYBACK_SOURCE_SCORE_WEIGHTS.peerEvidence),
    scoreFormatSupport: weigh(source.formatSupport === false ? 0 : 1, PLAYBACK_SOURCE_SCORE_WEIGHTS.formatSupport),
    scoreStartupLatency: weigh(latencyMs, PLAYBACK_SOURCE_SCORE_WEIGHTS.startupLatency),
    scoreUserOverride: weigh(source.preferred === true ? 1 : 0, PLAYBACK_SOURCE_SCORE_WEIGHTS.userOverride),
  }
}

export function scorePlaybackSource(source = {}) {
  return Object.values(playbackScoreComponents(source)).reduce((total, value) => total + value, 0)
}

/**
 * Two sources are interchangeable only when they carry the same work, the same
 * edition/cut, and the same collection position. Failover walks this
 * equivalence set and nothing else, so it can never quietly substitute a
 * different episode.
 *
 * This fails closed: a source with no resolved entity has no identity to
 * compare, so it is equivalent to nothing — not even to another anonymous
 * source — and can never become a failover target.
 */
export function sourceEquivalenceKey(source = {}) {
  const entityId = String(source.entityId || '')
  if (entityId.length === 0) return null
  return [
    entityId,
    String(source.editionId || ''),
    String(source.collectionMemberId || ''),
  ].join('\n')
}

export function areSourcesEquivalent(left, right) {
  const key = sourceEquivalenceKey(left)
  return key !== null && key === sourceEquivalenceKey(right)
}

// A user override is a score input, so "did the override change the outcome?"
// can only be answered against the score without it.
function rankingCodesFor(candidate, winner) {
  if (winner.preferred === true && candidate.preferred !== true && candidate.baseScore > winner.baseScore) {
    return ['DEPRIORITIZED_BY_LOCAL_PREFERENCE']
  }
  if (candidate.score < winner.score) return ['LOWER_LOCAL_SCORE']
  if (candidate.score === winner.score) return ['LOCAL_SCORE_TIE_BREAK']
  return ['DEPRIORITIZED_BY_LOCAL_ORDER']
}

function selectionCodesFor(winner, eligible) {
  const overridden = eligible.some(candidate => candidate !== winner && candidate.baseScore > winner.baseScore)
  if (winner.preferred === true && overridden) return ['SELECTED_BY_LOCAL_PREFERENCE']
  if (overridden) return ['SELECTED_BY_LOCAL_ORDER']
  const ties = eligible.filter(candidate => candidate.score === winner.score).length
  return ties > 1 ? ['SELECTED_BY_LOCAL_TIE_BREAK'] : ['SELECTED_BY_HIGHEST_SCORE']
}

/**
 * The one playback selector. Eligibility is decided before scoring, scoring
 * ranks only what can actually play, and the ordering is total and
 * deterministic so the same inputs always produce the same Play target.
 *
 * `candidates` is ordered: eligible by descending playback score first, then
 * every rejected source by publication id. `failoverOrder` is the eligible
 * tail that Play may fall back to, restricted to sources equivalent to the
 * winner.
 */
export function selectPlaybackSource(sources = [], context = {}) {
  const capabilities = context.capabilities || {}
  const now = Number.isFinite(Number(context.now)) ? Number(context.now) : null
  const evaluated = (Array.isArray(sources) ? sources : []).map(input => {
    const source = input || {}
    const rejectionReasonCodes = rejectionCodesFor(source, capabilities, now)
    const components = playbackScoreComponents(source)
    return {
      source,
      publicationId: String(source.publicationId || ''),
      preferred: source.preferred === true,
      eligible: rejectionReasonCodes.length === 0,
      rejectionReasonCodes,
      components,
      score: Object.values(components).reduce((total, value) => total + value, 0),
      baseScore: Object.entries(components)
        .filter(([name]) => name !== 'scoreUserOverride')
        .reduce((total, [, value]) => total + value, 0),
    }
  })

  const eligible = evaluated
    .filter(candidate => candidate.eligible)
    .sort((left, right) => (
      right.score - left.score ||
      left.publicationId.localeCompare(right.publicationId)
    ))
  const rejected = evaluated
    .filter(candidate => !candidate.eligible)
    .sort((left, right) => left.publicationId.localeCompare(right.publicationId))

  const requested = nonEmptyString(context.selectedPublicationId)
    ? eligible.find(candidate => candidate.publicationId === context.selectedPublicationId)
    : null
  const winner = requested || eligible[0] || null

  const failoverOrder = winner
    ? eligible.filter(candidate => candidate !== winner && areSourcesEquivalent(candidate.source, winner.source))
    : []

  const candidates = [...eligible, ...rejected].map(candidate => ({
    publicationId: candidate.publicationId,
    eligible: candidate.eligible,
    selected: candidate === winner,
    score: candidate.score,
    ...candidate.components,
    selectionReasonCodes: candidate === winner ? selectionCodesFor(winner, eligible) : [],
    rejectionReasonCodes: candidate === winner
      ? []
      : (candidate.eligible ? rankingCodesFor(candidate, winner) : candidate.rejectionReasonCodes),
    source: candidate.source,
  }))

  return {
    selected: winner ? winner.source : null,
    selectedPublicationId: winner ? winner.publicationId : null,
    candidates,
    failoverOrder: failoverOrder.map(candidate => candidate.source),
  }
}
