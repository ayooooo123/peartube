import { selectPlaybackSource } from './source-selector.js'

export const MAX_SOURCE_DIAGNOSTICS = 64
export const MAX_INTRODUCTION_DIAGNOSTIC_IDS = 16
export const MAX_CLAIM_DIAGNOSTIC_IDS = 32

const MAX_PUBLIC_ID_LENGTH = 256
const ARCHIVE_STATES = new Set(['archived', 'pledged', 'unarchived', 'unavailable', 'unknown'])
const CACHE_STATES = new Set(['cached', 'partial', 'not-cached', 'evicted', 'unavailable', 'unknown'])

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

/**
 * Project the selector's decision for display. This layer explains; it never
 * decides. Every `selected` flag and reason code here comes from
 * `selectPlaybackSource`, so Other Sources can never disagree with what Play
 * actually does.
 */
export function projectSourceSelectionDiagnostics(sources = [], options = {}) {
  if (!Array.isArray(sources) || sources.length === 0) return []

  // A source may carry its id nested under `publication`. The selector reads
  // the flat field, so lift it before selecting rather than diverge from the
  // one selector on which id a source has.
  const selection = options.selection || selectPlaybackSource(sources.map(input => {
    const source = input || {}
    if (typeof source.publicationId === 'string' && source.publicationId !== '') return source
    const nested = source.publication?.publicationId
    return typeof nested === 'string' && nested !== '' ? { ...source, publicationId: nested } : source
  }), {
    capabilities: options.capabilities,
    selectedPublicationId: options.selectedPublicationId,
    now: options.now,
  })

  return selection.candidates.slice(0, MAX_SOURCE_DIAGNOSTICS).map(candidate => {
    const source = candidate.source || {}
    const archiveState = normalizeState(source.archiveState, ARCHIVE_STATES)
    const cacheState = normalizeState(source.cacheState, CACHE_STATES)
    const item = {
      publicationId: candidate.publicationId ||
        (typeof source.publication?.publicationId === 'string' ? source.publication.publicationId : ''),
      selected: candidate.selected,
      eligible: candidate.eligible,
      selectionReasonCodes: candidate.selectionReasonCodes,
      rejectionReasonCodes: candidate.rejectionReasonCodes,
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
      scoreLocalCompleteness: candidate.scoreLocalCompleteness,
      scoreStartupReachability: candidate.scoreStartupReachability,
      scorePeerEvidence: candidate.scorePeerEvidence,
      scoreFormatSupport: candidate.scoreFormatSupport,
      scoreStartupLatency: candidate.scoreStartupLatency,
      scoreUserOverride: candidate.scoreUserOverride,
      stale: candidate.rejectionReasonCodes.includes('STALE_AVAILABILITY') ||
        candidate.rejectionReasonCodes.includes('STALE_MANIFEST'),
      incomplete: candidate.rejectionReasonCodes.includes('INCOMPLETE_PUBLICATION') ||
        candidate.rejectionReasonCodes.includes('INCOMPLETE_COLLECTION_BINDING'),
    }
    if (archiveState) item.archiveState = archiveState
    if (cacheState) item.cacheState = cacheState
    if (source.availabilityState) item.availabilityState = source.availabilityState
    return item
  })
}
