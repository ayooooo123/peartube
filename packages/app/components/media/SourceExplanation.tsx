import React from 'react'

export type PublicationSource = {
  publicationId: string
  renditionId: string
  sourceProvider?: string | null
  publisherId?: string | null
  selected?: boolean | null
  selectionReasonCodes?: string[] | null
  rejectionReasonCodes?: string[] | null
  introductionPublisherIds?: string[] | null
  introductionIndexIds?: string[] | null
  moderationFeedIds?: string[] | null
  claimConflictIds?: string[] | null
  provenanceClaimIds?: string[] | null
  archiveState?: string | null
  cacheState?: string | null
  availabilityState?: string | null
  stale?: boolean | null
  incomplete?: boolean | null
}

export type SourceExplanationModel = {
  label: string
  reason: string
  introduction: string
  moderation: string
  conflict: string
  provenance: string
  archive: string
  cache: string
  availability: string
  offline: string
  completeness: string
}

const SELECTED_REASONS: Readonly<Record<string, string>> = Object.freeze({
  SELECTED_BY_LOCAL_PREFERENCE: 'Selected because it matches your local source preference.',
  SELECTED_BY_HIGHEST_SCORE: 'Selected because it has the strongest local quality, trust, availability, and format score.',
  SELECTED_BY_LOCAL_TIE_BREAK: 'Selected by a deterministic local tie-break between equally ranked sources.',
  SELECTED_BY_LOCAL_ORDER: 'Selected by the stable source order on this device.',
})

const ALTERNATE_REASONS: Readonly<Record<string, string>> = Object.freeze({
  BLOCKED_BY_LOCAL_POLICY: 'Blocked by your local policy for playback sources.',
  UNAUTHORIZED_PUBLICATION: 'The publication is not backed by an authorized signed manifest.',
  UNCONFIRMED_AVAILABILITY: 'No current playable copy has been confirmed.',
  BLOCKED_BY_MODERATION: 'Blocked by moderation rules selected on this device.',
  STALE_AVAILABILITY: 'Its availability information is out of date.',
  INCOMPLETE_PUBLICATION: 'Its publication record is incomplete.',
  NO_AVAILABLE_COPY: 'No available copy is currently known.',
  DEPRIORITIZED_BY_LOCAL_PREFERENCE: 'A source matching your local preference was chosen instead.',
  LOWER_LOCAL_SCORE: 'It has a lower local quality, trust, availability, or format score.',
  LOCAL_SCORE_TIE_BREAK: 'An equally ranked source won the deterministic local tie-break.',
  DEPRIORITIZED_BY_LOCAL_ORDER: 'Another source appears earlier in the stable local order.',
})

function boundedCount(value: unknown, maximum = 64): number {
  return Array.isArray(value) ? Math.min(value.length, maximum) : 0
}

function countMessage(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}.` : `${count} ${plural}.`
}

function explainReasons(source: PublicationSource, selected: boolean): string {
  const codes = selected ? source.selectionReasonCodes : source.rejectionReasonCodes
  const messages = selected ? SELECTED_REASONS : ALTERNATE_REASONS
  if (!Array.isArray(codes) || codes.length === 0) {
    return selected
      ? 'Selected using source rules stored on this device.'
      : 'Available as an alternate under source rules stored on this device.'
  }

  const seen = new Set<string>()
  const explanations: string[] = []
  const limit = Math.min(codes.length, 32)
  for (let index = 0; index < limit; index++) {
    const code = codes[index]
    if (typeof code !== 'string' || !Object.prototype.hasOwnProperty.call(messages, code)) continue
    const explanation = messages[code]
    if (explanation && !seen.has(explanation)) {
      seen.add(explanation)
      explanations.push(explanation)
    }
  }
  if (explanations.length > 0) return explanations.join(' ')
  return selected
    ? 'Selected using source rules stored on this device.'
    : 'Available as an alternate under source rules stored on this device.'
}

function explainArchive(state: string | null | undefined): string {
  switch (state) {
    case 'archived': return 'An archival copy is currently reported, but retention is not guaranteed.'
    case 'pledged': return 'An archival pledge is reported, but it is not a guarantee of retention.'
    case 'unarchived': return 'No archival copy is currently reported.'
    case 'unavailable': return 'The reported archival copy is unavailable.'
    default: return 'Archive state is unknown; retention is not guaranteed.'
  }
}

function explainCache(state: string | null | undefined): string {
  switch (state) {
    case 'cached': return 'A complete copy is cached on this device.'
    case 'partial': return 'Only part of this source is cached on this device.'
    case 'not-cached': return 'This source is not cached on this device.'
    case 'evicted': return 'The local cached copy was removed.'
    case 'unavailable': return 'The local cache copy is unavailable.'
    default: return 'Local cache state is unknown.'
  }
}

function explainAvailability(source: PublicationSource): string {
  if ((source.stale || source.availabilityState === 'stale') && source.availabilityState === 'unavailable') {
    return 'This source is currently unavailable, and its availability information is out of date.'
  }
  if (source.stale || source.availabilityState === 'stale') return 'Availability information is out of date.'
  switch (source.availabilityState) {
    case 'available': return 'A playable copy is currently available.'
    case 'unavailable': return 'This source is currently unavailable.'
    default: return 'Current availability is unknown.'
  }
}

function explainOffline(source: PublicationSource): string {
  if (source.cacheState === 'cached') return 'This source is available offline on this device.'
  if (source.cacheState === 'partial') return 'This source is not fully available offline; playback may need a connection.'
  if (source.availabilityState === 'unavailable' || source.cacheState === 'not-cached' || source.cacheState === 'evicted' || source.cacheState === 'unavailable') {
    return 'This source is not available offline on this device.'
  }
  return 'Offline availability has not been confirmed on this device.'
}

export function normalizeSourceExplanation(source: PublicationSource, index: number, selected = source.selected === true): SourceExplanationModel {
  const introductionCount = boundedCount(source.introductionPublisherIds, 16) + boundedCount(source.introductionIndexIds, 16)
  const moderationCount = boundedCount(source.moderationFeedIds, 16)
  const conflictCount = boundedCount(source.claimConflictIds, 32)
  const provenanceCount = boundedCount(source.provenanceClaimIds, 32)

  return {
    label: selected ? 'Selected source' : `Alternate source ${index + 1}`,
    reason: explainReasons(source, selected),
    introduction: introductionCount > 0
      ? countMessage(introductionCount, 'introduction path is recorded', 'introduction paths are recorded')
      : 'No introduction path is recorded.',
    moderation: moderationCount > 0
      ? countMessage(moderationCount, 'local moderation reference applies', 'local moderation references apply')
      : 'No local moderation reference is recorded.',
    conflict: conflictCount > 0
      ? countMessage(conflictCount, 'conflicting claim needs review', 'conflicting claims need review')
      : 'No conflicting claims are recorded.',
    provenance: provenanceCount > 0
      ? countMessage(provenanceCount, 'provenance claim is recorded', 'provenance claims are recorded')
      : 'No provenance claims are recorded.',
    archive: explainArchive(source.archiveState),
    cache: explainCache(source.cacheState),
    availability: explainAvailability(source),
    offline: explainOffline(source),
    completeness: source.incomplete ? 'This publication record is incomplete.' : 'This publication record is complete.',
  }
}

export function SourceExplanation({ explanation }: { explanation: SourceExplanationModel }) {
  return (
    <article aria-label={explanation.label}>
      <h3>{explanation.label}</h3>
      <p>{explanation.reason}</p>
      <p>{explanation.introduction}</p>
      <p>{explanation.moderation}</p>
      <p>{explanation.conflict}</p>
      <p>{explanation.provenance}</p>
      <p>{explanation.archive}</p>
      <p>{explanation.cache}</p>
      <p>{explanation.availability}</p>
      <p>{explanation.offline}</p>
      <p>{explanation.completeness}</p>
    </article>
  )
}
