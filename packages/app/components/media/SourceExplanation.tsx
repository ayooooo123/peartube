import React from 'react'

export type PublicationSource = {
  publicationId: string
  renditionId: string
  sourceProvider?: string | null
  publisherId?: string | null
  selected?: boolean | null
  eligible?: boolean | null
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

// Why the one automatic selection landed here. Play never asks the viewer to
// choose; these lines only explain a decision that already happened.
const SELECTED_REASONS: Readonly<Record<string, string>> = Object.freeze({
  SELECTED_BY_LOCAL_PREFERENCE: 'Playing this source because you picked it on this device.',
  SELECTED_BY_HIGHEST_SCORE: 'Playing this source because it has the strongest local playability score right now.',
  SELECTED_BY_LOCAL_TIE_BREAK: 'Playing this source after a repeatable local tie-break between equally ranked sources.',
  SELECTED_BY_LOCAL_ORDER: 'Playing this source because it comes first in the stable source order on this device.',
})

// Two very different answers share this map. A hard gate means the source
// cannot play on this device at all, so Play will never fail over to it. A
// ranking reason means the source is perfectly playable and simply lost.
const ALTERNATE_REASONS: Readonly<Record<string, string>> = Object.freeze({
  BLOCKED_BY_MODERATION: 'Cannot play here: the moderation rules you use on this device block this source.',
  BLOCKED_BY_LOCAL_POLICY: 'Cannot play here: your local policy for playback sources blocks this source.',
  UNAUTHORIZED_PUBLICATION: 'Cannot play here: this source is not backed by an authorized signed manifest.',
  DRM_UNSUPPORTED: 'Cannot play here: this device cannot unlock the protection applied to this source.',
  UNSUPPORTED_CODEC: 'Cannot play here: this device cannot decode the video or audio format of this source.',
  UNSUPPORTED_CONTAINER: 'Cannot play here: this device cannot read the file container this source uses.',
  STALE_MANIFEST: 'Cannot play here: the stored manifest for this source is stale and has to be refreshed first.',
  INCOMPLETE_PUBLICATION: 'Cannot play here: this publication record is missing parts that playback needs.',
  INCOMPLETE_COLLECTION_BINDING: 'Cannot play here: this source is not fully bound to the collection entry you opened.',
  NO_AVAILABLE_COPY: 'Cannot play right now: no peer is sharing a copy of this source at the moment. That can change when peers return.',
  STALE_AVAILABILITY: 'Cannot play right now: what this device knows about peers sharing this source is out of date. A fresh check may find peers again.',
  UNCONFIRMED_AVAILABILITY: 'Cannot play right now: no peer has been checked for this source yet on this device.',
  DEPRIORITIZED_BY_LOCAL_PREFERENCE: 'Playable, but the source you picked on this device was used instead.',
  LOWER_LOCAL_SCORE: 'Playable, but another source scored higher for playback on this device.',
  LOCAL_SCORE_TIE_BREAK: 'Playable, but an equally ranked source won the repeatable local tie-break.',
  DEPRIORITIZED_BY_LOCAL_ORDER: 'Playable, but another source comes earlier in the stable local order.',
})

function boundedCount(value: unknown, maximum = 64): number {
  return Array.isArray(value) ? Math.min(value.length, maximum) : 0
}

function countMessage(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}.` : `${count} ${plural}.`
}

// A source the backend ruled out before ranking never becomes a failover
// target, so the fallback copy has to say "cannot play" rather than "alternate"
// even when no recognised code came back with it.
function fallbackReason(source: PublicationSource, selected: boolean): string {
  if (selected) return 'Selected using source rules stored on this device.'
  if (source.eligible === false) return 'Cannot play here: this source was ruled out on this device before ranking.'
  return 'Available as an alternate under source rules stored on this device.'
}

function explainReasons(source: PublicationSource, selected: boolean): string {
  const codes = selected ? source.selectionReasonCodes : source.rejectionReasonCodes
  const messages = selected ? SELECTED_REASONS : ALTERNATE_REASONS
  if (!Array.isArray(codes) || codes.length === 0) return fallbackReason(source, selected)

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
  return fallbackReason(source, selected)
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
