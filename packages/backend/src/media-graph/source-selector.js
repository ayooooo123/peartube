import { availabilityScoreForState } from '../assets/availability.js'

/**
 * Availability is an assessed, expiring local observation. A publisher's
 * claimed status never reaches the score: sources carry the assessment made by
 * `assessAvailability`, and an unreachable source scores zero no matter how
 * trusted its publisher is.
 */
export function sourceAvailabilityScore(source = {}) {
  if (source.availability) return availabilityScoreForState(source.availability.state)
  return 0
}

function safeScore(value) {
  const next = Number(value || 0)
  if (!Number.isFinite(next)) return 0
  return Math.max(Number.MIN_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, next))
}

export const PUBLICATION_SOURCE_SCORE_WEIGHTS = Object.freeze({
  metadataConfidence: 2,
  publisherTrust: 10,
  availabilityScore: 4,
  formatSupport: 3,
  moderationPenalty: -20,
})

export function scorePublicationSource(source = {}) {
  return (
    safeScore(source.metadataConfidence) * PUBLICATION_SOURCE_SCORE_WEIGHTS.metadataConfidence +
    safeScore(source.publisherTrust) * PUBLICATION_SOURCE_SCORE_WEIGHTS.publisherTrust +
    safeScore(source.availabilityScore) * PUBLICATION_SOURCE_SCORE_WEIGHTS.availabilityScore +
    safeScore(source.formatSupport) * PUBLICATION_SOURCE_SCORE_WEIGHTS.formatSupport +
    safeScore(source.moderationPenalty) * PUBLICATION_SOURCE_SCORE_WEIGHTS.moderationPenalty
  )
}

export function scorePublicationSourceComponents(source = {}) {
  return {
    scoreMetadataConfidence: safeScore(source.metadataConfidence) * PUBLICATION_SOURCE_SCORE_WEIGHTS.metadataConfidence,
    scorePublisherTrust: safeScore(source.publisherTrust) * PUBLICATION_SOURCE_SCORE_WEIGHTS.publisherTrust,
    scoreAvailability: safeScore(source.availabilityScore) * PUBLICATION_SOURCE_SCORE_WEIGHTS.availabilityScore,
    scoreFormatSupport: safeScore(source.formatSupport) * PUBLICATION_SOURCE_SCORE_WEIGHTS.formatSupport,
    scoreModerationPenalty: safeScore(source.moderationPenalty) * PUBLICATION_SOURCE_SCORE_WEIGHTS.moderationPenalty,
  }
}

export function selectPublicationSources(sources = []) {
  return sources
    .map(source => ({ ...source, score: scorePublicationSource(source) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return String(a.publicationId || '').localeCompare(String(b.publicationId || ''))
    })
}
