const HARD_REJECTION_REASONS = Object.freeze({
  UNAUTHORIZED_PUBLICATION: true,
  UNCONFIRMED_AVAILABILITY: true,
  BLOCKED_BY_LOCAL_POLICY: true,
  BLOCKED_BY_MODERATION: true,
  STALE_AVAILABILITY: true,
  INCOMPLETE_PUBLICATION: true,
  NO_AVAILABLE_COPY: true,
})

export function isMediaSourcePlayable(source = {}) {
  return typeof source.publicationId === 'string' && source.publicationId.length > 0 &&
    typeof source.renditionId === 'string' && source.renditionId.length > 0 &&
    source.availabilityState === 'available' &&
    source.stale !== true &&
    source.incomplete !== true &&
    Array.isArray(source.rejectionReasonCodes) &&
    !source.rejectionReasonCodes.some(code => HARD_REJECTION_REASONS[code] === true)
}

function normalizeSource(source = {}) {
  const publicationId = source.publicationId == null ? null : String(source.publicationId)
  const renditionId = source.renditionId == null ? null : String(source.renditionId)
  return {
    ...source,
    publicationId,
    renditionId,
    playable: isMediaSourcePlayable({ ...source, publicationId, renditionId }),
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
