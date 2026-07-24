function normalizeSource(source = {}) {
  const publicationId = source.publicationId == null ? null : String(source.publicationId)
  const renditionId = source.renditionId == null ? null : String(source.renditionId)
  return {
    ...source,
    publicationId,
    renditionId,
    playable: source.playable === true,
    score: Number.isFinite(source.score) ? source.score : 0,
    playbackRef: publicationId && renditionId ? { publicationId, renditionId } : null,
  }
}

export function selectMediaSource(sources = [], preferences = {}) {
  const normalized = sources.map(normalizeSource)
  const preferredPublicationId = preferences.publicationId == null ? null : String(preferences.publicationId)
  const preferred = normalized.find(source => source.playable && source.publicationId === preferredPublicationId)
  if (preferred) return preferred
  return normalized
    .filter(source => source.playable && source.playbackRef)
    .sort((a, b) => b.score - a.score || a.publicationId.localeCompare(b.publicationId))[0] || null
}

export function switchMediaSource(state = {}, source = {}) {
  const selected = normalizeSource(source)
  if (!selected.playable || !selected.playbackRef) return { ...state, sourceSwitchError: 'source-not-playable' }
  return { ...state, selectedSource: selected, playbackRef: selected.playbackRef }
}
