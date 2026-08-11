import {
  scorePublicationSource,
  scorePublicationSourceComponents,
} from './source-selector.js'

export const MAX_SOURCE_DIAGNOSTICS = 64
export const MAX_INTRODUCTION_DIAGNOSTIC_IDS = 16
export const MAX_CLAIM_DIAGNOSTIC_IDS = 32

const MAX_PUBLIC_ID_LENGTH = 256
const ARCHIVE_STATES = new Set(['archived', 'pledged', 'unarchived', 'unavailable', 'unknown'])
const CACHE_STATES = new Set(['cached', 'partial', 'not-cached', 'evicted', 'unavailable', 'unknown'])
const AVAILABILITY_STATES = new Set(['available', 'unavailable', 'stale', 'unknown'])
const BLOCKING_DECISIONS = new Set(['block', 'blocked', 'deny', 'denied', 'reject', 'rejected'])

function insertPublicId(ids, value, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PUBLIC_ID_LENGTH) return

  let low = 0
  let high = ids.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (ids[middle] < value) low = middle + 1
    else high = middle
  }
  if (ids[low] === value || (ids.length === max && low === max)) return
  ids.splice(low, 0, value)
  if (ids.length > max) ids.pop()
}

function boundedPublicIds(max, ...values) {
  const ids = []
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) insertPublicId(ids, item, max)
    } else {
      insertPublicId(ids, value, max)
    }
  }
  return ids
}

function normalizeState(value, allowed) {
  const candidate = typeof value === 'string' ? value : value?.state
  if (typeof candidate !== 'string') return undefined
  const state = candidate.toLowerCase()
  return allowed.has(state) ? state : undefined
}

function decisionBlocks(value) {
  if (value === true) return true
  const candidate = typeof value === 'string'
    ? value
    : value?.decision || value?.action || value?.state
  return typeof candidate === 'string' && BLOCKING_DECISIONS.has(candidate.toLowerCase())
}

function finiteNumber(value) {
  try {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  } catch {
    return null
  }
}

function localAvailabilityState(source, archiveState, cacheState) {
  const explicit = normalizeState(source.availabilityState, AVAILABILITY_STATES)
  if (explicit) return explicit

  const peerState = normalizeState(source.peerAvailability, AVAILABILITY_STATES)
  if (archiveState === 'archived' || cacheState === 'cached' || cacheState === 'partial' || peerState === 'available') {
    return 'available'
  }

  const archiveUnavailable = archiveState === 'unarchived' || archiveState === 'unavailable'
  const cacheUnavailable = cacheState === 'not-cached' || cacheState === 'evicted' || cacheState === 'unavailable'
  if (archiveUnavailable && cacheUnavailable && peerState === 'unavailable') return 'unavailable'
  return peerState
}

function sourceScore(source) {
  return scorePublicationSource(source)
}

function sourceIsStale(source, availabilityState, now) {
  if (source.stale === true || availabilityState === 'stale') return true
  const expiresAt = finiteNumber(source.availabilityExpiresAt)
  return expiresAt != null && expiresAt > 0 && now != null && expiresAt <= now
}

function sourceIsIncomplete(source) {
  return source.incomplete === true || source.manifestComplete === false || source.manifestState === 'incomplete'
}

function authorizationRejectionReasonCodes(source, stale, incomplete, availabilityState) {
  const reasons = []
  if (source.publicationAuthorized !== true || typeof source.renditionId !== 'string' || source.renditionId.length === 0) {
    reasons.push('UNAUTHORIZED_PUBLICATION')
  }
  if (decisionBlocks(source.localPolicyDecision) || source.blocked === true) reasons.push('BLOCKED_BY_LOCAL_POLICY')
  if (decisionBlocks(source.moderationDecision)) reasons.push('BLOCKED_BY_MODERATION')
  if (stale) reasons.push('STALE_AVAILABILITY')
  if (incomplete) reasons.push('INCOMPLETE_PUBLICATION')
  if (availabilityState === 'unavailable') reasons.push('NO_AVAILABLE_COPY')
  else if (availabilityState !== 'available') reasons.push('UNCONFIRMED_AVAILABILITY')
  return reasons
}

function rejectionReasonCodes(source, context, score, stale, incomplete, availabilityState) {
  const reasons = []
  if (decisionBlocks(source.localPolicyDecision) || source.blocked === true) reasons.push('BLOCKED_BY_LOCAL_POLICY')
  if (decisionBlocks(source.moderationDecision)) reasons.push('BLOCKED_BY_MODERATION')
  if (stale) reasons.push('STALE_AVAILABILITY')
  if (incomplete) reasons.push('INCOMPLETE_PUBLICATION')
  if (availabilityState === 'unavailable') reasons.push('NO_AVAILABLE_COPY')
  if (
    context.preferenceChangedWinner &&
    source.preferred !== true &&
    context.selectedScore != null &&
    score > context.selectedScore
  ) {
    reasons.push('DEPRIORITIZED_BY_LOCAL_PREFERENCE')
  }

  if (context.selectedScore == null) {
    if (reasons.length === 0) reasons.push('DEPRIORITIZED_BY_LOCAL_ORDER')
  } else if (score < context.selectedScore) {
    reasons.push('LOWER_LOCAL_SCORE')
  } else if (score === context.selectedScore) {
    reasons.push('LOCAL_SCORE_TIE_BREAK')
  } else if (reasons.length === 0) {
    reasons.push('DEPRIORITIZED_BY_LOCAL_ORDER')
  }
  return reasons
}

function createSelectionContext(sources, selectedIndex) {
  if (selectedIndex < 0 || selectedIndex >= sources.length) {
    return {
      selectedSource: null,
      selectedScore: null,
      highest: false,
      matchingScores: 0,
      preferenceChangedWinner: false,
    }
  }

  const selectedSource = sources[selectedIndex] || {}
  const selectedScore = sourceScore(selectedSource)
  let highest = true
  let matchingScores = 0
  let preferenceChangedWinner = false
  for (const input of sources) {
    const source = input || {}
    const score = sourceScore(source)
    if (score === selectedScore) matchingScores++
    else if (score > selectedScore) {
      highest = false
      if (selectedSource.preferred === true && source.preferred !== true) preferenceChangedWinner = true
    }
  }
  return { selectedSource, selectedScore, highest, matchingScores, preferenceChangedWinner }
}

function selectionReasonCodes(context) {
  if (context.preferenceChangedWinner) return ['SELECTED_BY_LOCAL_PREFERENCE']
  if (context.highest && context.matchingScores > 1) return ['SELECTED_BY_LOCAL_TIE_BREAK']
  if (context.highest) return ['SELECTED_BY_HIGHEST_SCORE']
  return ['SELECTED_BY_LOCAL_ORDER']
}

export function projectSourceSelectionDiagnostics(sources = [], options = {}) {
  if (!Array.isArray(sources) || sources.length === 0) return []

  const now = finiteNumber(options.now)
  const evaluations = sources.map(input => {
    const source = input || {}
    const archiveState = normalizeState(source.archiveState, ARCHIVE_STATES)
    const cacheState = normalizeState(source.cacheState, CACHE_STATES)
    const availabilityState = localAvailabilityState(source, archiveState, cacheState)
    const stale = sourceIsStale(source, availabilityState, now)
    const incomplete = sourceIsIncomplete(source)
    const authorizationReasons = options.requireAuthorization === true
      ? authorizationRejectionReasonCodes(source, stale, incomplete, availabilityState)
      : []
    return { source, archiveState, cacheState, availabilityState, stale, incomplete, authorizationReasons }
  })

  let selectedIndex = typeof options.selectedPublicationId === 'string'
    ? sources.findIndex(source =>
        (source?.publication?.publicationId ?? source?.publicationId) === options.selectedPublicationId
      )
    : 0
  if (options.requireAuthorization === true && evaluations[selectedIndex]?.authorizationReasons.length !== 0) {
    selectedIndex = evaluations.findIndex(evaluation => evaluation.authorizationReasons.length === 0)
  }

  const context = createSelectionContext(sources, selectedIndex)
  return evaluations.slice(0, MAX_SOURCE_DIAGNOSTICS).map((evaluation, index) => {
    const { source, archiveState, cacheState, availabilityState, stale, incomplete, authorizationReasons } = evaluation
    const selected = index === selectedIndex
    const rankingReasons = selected
      ? []
      : rejectionReasonCodes(source, context, sourceScore(source), stale, incomplete, availabilityState)
    const item = {
      publicationId: typeof (source.publication?.publicationId ?? source.publicationId) === 'string'
        ? (source.publication?.publicationId ?? source.publicationId)
        : '',
      selected,
      selectionReasonCodes: selected ? selectionReasonCodes(context) : [],
      rejectionReasonCodes: selected
        ? []
        : [...new Set([...authorizationReasons, ...rankingReasons])],
      introductionPublisherIds: boundedPublicIds(
        MAX_INTRODUCTION_DIAGNOSTIC_IDS,
        source.publisherId,
        source.publication?.publisherId,
        source.introductionPublisherIds,
      ),
      introductionIndexIds: boundedPublicIds(
        MAX_INTRODUCTION_DIAGNOSTIC_IDS,
        source.indexFeedId,
        source.indexFeedIds,
        source.introductionIndexIds,
        source.sourceIndexers?.map(indexer => indexer?.indexerId),
      ),
      moderationFeedIds: boundedPublicIds(
        MAX_INTRODUCTION_DIAGNOSTIC_IDS,
        source.moderationFeedId,
        source.moderationFeedIds,
      ),
      claimConflictIds: boundedPublicIds(MAX_CLAIM_DIAGNOSTIC_IDS, source.claimConflictIds),
      provenanceClaimIds: boundedPublicIds(MAX_CLAIM_DIAGNOSTIC_IDS, source.provenanceClaimIds),
      ...scorePublicationSourceComponents(source),
      stale,
      incomplete,
    }
    if (archiveState) item.archiveState = archiveState
    if (cacheState) item.cacheState = cacheState
    if (availabilityState) item.availabilityState = availabilityState
    return item
  })
}
