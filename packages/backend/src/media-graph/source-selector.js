function safeScore(value) {
  const next = Number(value || 0)
  if (!Number.isFinite(next)) return 0
  return next
}

export function scorePublicationSource(source = {}) {
  return (
    safeScore(source.metadataConfidence) * 2 +
    safeScore(source.publisherTrust) * 10 +
    safeScore(source.availabilityScore) * 4 +
    safeScore(source.formatSupport) * 3 -
    safeScore(source.moderationPenalty) * 20
  )
}

export function selectPublicationSources(sources = []) {
  return sources
    .map(source => ({ ...source, score: scorePublicationSource(source) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return String(a.publicationId || '').localeCompare(String(b.publicationId || ''))
    })
}
