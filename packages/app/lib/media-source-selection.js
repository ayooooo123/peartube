import { effectiveAvailabilityState, isAvailabilityPlayable } from './media-availability.js'

/**
 * The hard-gate vocabulary of the one backend playback selector
 * (`selectPlaybackSource`). A source carrying any of these codes cannot play on
 * this device at all: it is never selected, and Play never fails over to it.
 * The app mirrors the list so it can refuse a source without a round trip,
 * never so it can re-derive a verdict the backend already reached.
 */
export const HARD_REJECTION_REASON_CODES = Object.freeze([
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

const HARD_REJECTIONS = new Set(HARD_REJECTION_REASON_CODES)

function hasHardRejection(codes) {
  return Array.isArray(codes) && codes.some(code => HARD_REJECTIONS.has(code))
}

function assessedAvailability(source) {
  const availability = source?.availability
  return availability !== null && typeof availability === 'object' && !Array.isArray(availability)
    ? availability
    : null
}

// `eligible === false` is the backend's hard-gate verdict and is final. An
// absent flag only means the source never went through the selector.
function backendIneligible(source) {
  return source?.eligible === false
}

export function isMediaSourcePlayable(source = {}) {
  if (backendIneligible(source)) return false
  const assessed = assessedAvailability(source)
  const reachable = assessed
    ? isAvailabilityPlayable(assessed)
    : source.availabilityState === 'available'
  return typeof source.publicationId === 'string' && source.publicationId.length > 0 &&
    typeof source.renditionId === 'string' && source.renditionId.length > 0 &&
    reachable &&
    source.stale !== true &&
    source.incomplete !== true &&
    Array.isArray(source.rejectionReasonCodes) &&
    !hasHardRejection(source.rejectionReasonCodes)
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function nonArrayObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function firstNonEmptyString(values, fallback = null) {
  for (const value of values) {
    if (nonEmptyString(value)) return value
  }
  return fallback
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function truthy(value) {
  return value === true || value === 'true' || value === 'yes'
}

function sourceTimestampMs(source) {
  for (const field of ['lastVerifiedAt', 'observedAt', 'publishedAt', 'uploadedAt', 'createdAt', 'updatedAt']) {
    const value = source?.[field]
    if (finiteNumber(value)) return value
    if (nonEmptyString(value)) {
      const parsed = Date.parse(value)
      if (!Number.isNaN(parsed)) return parsed
    }
  }
  return 0
}

function sourceId(source, fallback = 'source') {
  return firstNonEmptyString([
    source?.publicationId,
    source?.sourceId,
    source?.manifestId,
    source?.renditionId,
    source?.videoId,
    source?.id,
    source?.path,
  ], fallback)
}

function sourcePublisherName(source) {
  return firstNonEmptyString([
    source?.publisherName,
    source?.sourceProviderName,
    source?.providerName,
    source?.publisher?.name,
    source?.channelName,
    source?.channel?.name,
    source?.uploaderName,
  ], null)
}

function sourcePublisherId(source) {
  return firstNonEmptyString([
    source?.publisherId,
    source?.issuerIdentityKey,
    source?.channelKey,
    source?.driveKey,
    source?.publicBeeKey,
    source?.channel?.key,
  ], null)
}

function sourceModerationPenalty(source) {
  const action = source?.moderation?.action || source?.policyDecision?.action || source?.decision
  if (action === 'blocked' || action === 'hidden' || action === 'not-downloaded') return -1000
  if (action === 'blurred') return -60
  return 0
}

// The assessed availability object is authoritative when present. The legacy
// status strings below only describe sources that predate the four-state
// contract (local files, cached blobs, publisher-claimed status).
function legacyAvailabilityStatus(source) {
  const legacy = typeof source?.availability === 'string' ? source.availability : null
  return source?.availabilityStatus || legacy || source?.retentionStatus || null
}

// The backend playback score, when the backend produced one. It is reported,
// never recomputed, and never mixed with the legacy heuristic below.
function backendScore(source) {
  return finiteNumber(source?.score) ? source.score : null
}

/* -------------------------------------------------------------------------
 * Legacy local heuristic.
 *
 * This exists only for sources that never passed through the backend playback
 * selector and therefore carry no `selected` / `eligible` / score at all:
 * on-device files, cached blobs, and the older channel/video record shape that
 * predates the media graph. Anything the backend evaluated is ranked by the
 * backend, and this heuristic must never be allowed to disagree with it.
 * ---------------------------------------------------------------------- */

function legacyAvailabilityScore(source) {
  const assessed = assessedAvailability(source)
  if (assessed) {
    if (assessed.offlinePlayable === true) return 260
    const state = effectiveAvailabilityState(assessed)
    if (state === 'healthy') return 140
    if (state === 'limited') return 90
    return -160
  }
  const status = legacyAvailabilityStatus(source) || source?.archiveStatus
  if (truthy(source?.localComplete) || truthy(source?.isLocal) || status === 'local' || status === 'complete-local') return 260
  if (truthy(source?.cached) || truthy(source?.retained) || status === 'cached' || status === 'retained') return 220
  if (truthy(source?.archived) || status === 'archived' || status === 'pledged') return 170
  if (truthy(source?.available) || status === 'available' || status === 'online' || status === 'seeded') return 140
  if (status === 'partial') return 90
  if (status === 'unavailable' || status === 'missing' || status === 'blocked') return -160
  return 0
}

function legacyFormatScore(source) {
  let score = 0
  if (source?.formatSupported === false) score -= 180
  if (source?.playbackSupported === false) score -= 180
  if (source?.verified === true || source?.verificationStatus === 'verified') score += 70
  if (source?.fingerprintAgreement === true) score += 40
  if (source?.isPreferred === true || source?.preferred === true) score += 35
  if (finiteNumber(source?.height)) score += Math.min(45, Math.max(0, source.height / 60))
  if (finiteNumber(source?.bitrate)) score += Math.min(35, Math.max(0, source.bitrate / 200000))
  return score
}

function legacyPolicyBonus(source, policy) {
  let bonus = 0
  if (nonEmptyString(policy.preferredPublicationId) && source.publicationId === policy.preferredPublicationId) bonus += 1000
  if (nonEmptyString(policy.preferredRenditionId) && source.renditionId === policy.preferredRenditionId) bonus += 700
  if (nonEmptyString(policy.preferredPublisherId) && source.publisherId === policy.preferredPublisherId) bonus += 180
  if (policy.allowUnavailable === true && (source.availabilityStatus === 'unavailable' || source.availabilityStatus === 'missing')) bonus += 120
  bonus += Math.min(30, sourceTimestampMs(source) / 100000000000)
  return bonus
}

export function normalizeMediaSource(source = {}, entity = {}) {
  if (!nonArrayObject(source)) return null

  const publicationId = firstNonEmptyString([
    source.publicationId,
    source.id,
    source.manifest?.publicationId,
    source.publication?.id,
    source.publication?.publicationId,
  ], null)
  const rendition = nonArrayObject(source.rendition) ? source.rendition : nonArrayObject(source.selectedRendition) ? source.selectedRendition : null
  const renditionId = firstNonEmptyString([
    source.renditionId,
    rendition?.renditionId,
    rendition?.id,
    source.playbackRenditionId,
  ], null)
  const videoId = firstNonEmptyString([source.videoId, source.video?.id, source.item?.videoId], null)
  const id = firstNonEmptyString([source.id, videoId, publicationId, renditionId, source.path], null)
  if (!nonEmptyString(id)) return null

  const publisherId = sourcePublisherId(source)
  const publisherName = sourcePublisherName(source)
  const channelKey = firstNonEmptyString([source.channelKey, source.driveKey, source.channel?.key, publisherId], null)
  const playbackItemKey = firstNonEmptyString([videoId, source.path, source.video?.id, renditionId, publicationId, id], 'unknown')
  const playbackKey = firstNonEmptyString([
    source.playbackKey,
    entity?.playbackKey,
  ], `${channelKey || publisherId || entity?.localEntityId || 'publisher'}:${playbackItemKey}`)

  return {
    id,
    publicationId,
    manifestId: firstNonEmptyString([source.manifestId, source.manifest?.id], null),
    renditionId,
    publisherId,
    publisherName,
    sourceProviderName: publisherName,
    channelKey,
    driveKey: firstNonEmptyString([source.driveKey, source.channelKey], null),
    videoId,
    path: firstNonEmptyString([source.path, source.filePath, source.video?.path], null),
    publicBeeKey: firstNonEmptyString([source.publicBeeKey, source.video?.publicBeeKey], null),
    playbackKey,
    availability: nonArrayObject(source.availability) ? source.availability : null,
    availabilityStatus: legacyAvailabilityStatus(source),
    availabilityState: source.availabilityState || null,
    archiveStatus: source.archiveStatus || source.retentionStatus || null,
    localComplete: !!source.localComplete,
    cached: !!source.cached,
    retained: !!source.retained,
    available: source.available !== false,
    verified: !!source.verified || source.verificationStatus === 'verified',
    formatSupported: source.formatSupported !== false,
    playbackSupported: source.playbackSupported !== false,
    stale: source.stale === true,
    incomplete: source.incomplete === true,
    // Backend selection verdict, carried through untouched. `eligible` stays
    // null when the source never reached the selector so the legacy heuristic
    // can still be told apart from a genuine backend "no".
    selected: source.selected === true,
    eligible: typeof source.eligible === 'boolean' ? source.eligible : null,
    selectionReasonCodes: asArray(source.selectionReasonCodes),
    rejectionReasonCodes: asArray(source.rejectionReasonCodes),
    score: backendScore(source),
    playable: isMediaSourcePlayable({ ...source, publicationId, renditionId }),
    playbackRef: publicationId && renditionId ? { publicationId, renditionId } : null,
    height: finiteNumber(source.height) ? source.height : finiteNumber(rendition?.height) ? rendition.height : null,
    bitrate: finiteNumber(source.bitrate) ? source.bitrate : finiteNumber(rendition?.bitrate) ? rendition.bitrate : null,
    publishedAt: source.publishedAt || source.uploadedAt || source.createdAt || null,
    provenance: asArray(source.provenance),
    moderation: source.moderation || source.policyDecision || null,
    raw: source,
  }
}

function collectCandidateSources(entity = {}) {
  const sources = []
  for (const field of ['selectedSource', 'preferredSource']) {
    if (nonArrayObject(entity[field])) sources.push(entity[field])
  }
  for (const field of ['sources', 'publicationSources', 'publications', 'alternateSources']) {
    for (const source of asArray(entity[field])) sources.push(source)
  }
  if (nonArrayObject(entity.item)) sources.push(entity.item)
  if (nonEmptyString(entity.videoId) || nonEmptyString(entity.publicationId) || nonEmptyString(entity.path)) sources.push(entity)
  return sources
}

/**
 * The score the app reports for a source. When the backend playback selector
 * scored it, that number is passed through verbatim; there is exactly one
 * ranking and the app is not it. Only unevaluated legacy sources fall back to
 * the on-device heuristic.
 */
export function scoreMediaSource(source, policy = {}) {
  if (!nonArrayObject(source)) return Number.NEGATIVE_INFINITY
  const backend = backendScore(source)
  if (backend !== null) return backend
  return legacyAvailabilityScore(source) +
    legacyFormatScore(source) +
    sourceModerationPenalty(source) +
    legacyPolicyBonus(source, policy)
}

function isMediaSourceAllowed(source, policy) {
  const raw = source.raw || source
  if (backendIneligible(source)) return false
  if (hasHardRejection(source.rejectionReasonCodes)) return false
  if (source.stale || source.incomplete) return false
  if (source.formatSupported === false || source.playbackSupported === false) return false
  if (sourceModerationPenalty(source) <= -1000) return false
  const assessed = assessedAvailability(source)
  if (assessed && !isAvailabilityPlayable(assessed)) return false
  if (!assessed && source.availabilityState && source.availabilityState !== 'available') return false
  if (raw.available === false && !source.availabilityStatus) return false
  if (
    policy.allowUnavailable !== true &&
    (source.availabilityStatus === 'unavailable' ||
      source.availabilityStatus === 'missing' ||
      source.availabilityStatus === 'blocked')
  ) return false
  return true
}

// An explicit local preference is a user override, which is the same input the
// backend selector takes as `selectedPublicationId`. It outranks the backend's
// default pick, but it can never resurrect a source that failed a hard gate.
function preferenceRank(source, policy) {
  let rank = 0
  if (nonEmptyString(policy.preferredPublicationId) && source.publicationId === policy.preferredPublicationId) rank += 4
  if (nonEmptyString(policy.preferredRenditionId) && source.renditionId === policy.preferredRenditionId) rank += 2
  if (nonEmptyString(policy.preferredPublisherId) && source.publisherId === policy.preferredPublisherId) rank += 1
  return rank
}

function selectStrictMediaSource(sources, preferences) {
  const normalized = sources.map(source => {
    const publicationId = source?.publicationId == null ? null : String(source.publicationId)
    const renditionId = source?.renditionId == null ? null : String(source.renditionId)
    return {
      ...source,
      publicationId,
      renditionId,
      playable: isMediaSourcePlayable({ ...source, publicationId, renditionId }),
      score: finiteNumber(source?.score) ? source.score : 0,
      playbackRef: publicationId && renditionId ? { publicationId, renditionId } : null,
    }
  })
  const preferredPublicationId = preferences.publicationId == null ? null : String(preferences.publicationId)
  const preferred = normalized.find(source => source.playable && source.publicationId === preferredPublicationId)
  if (preferred) return preferred
  const candidates = normalized.filter(source => source.playable && source.playbackRef)
  // The backend already resolved Play to one source. Obey it instead of
  // re-ranking; the sort below only covers sources it never evaluated.
  const backendSelected = candidates.find(source => source.selected === true)
  if (backendSelected) return backendSelected
  return candidates
    .sort((left, right) => right.score - left.score || left.publicationId.localeCompare(right.publicationId))[0] || null
}

export function selectMediaSource(entity = {}, policy = {}) {
  if (Array.isArray(entity)) return selectStrictMediaSource(entity, policy)

  const normalized = []
  const seen = new Set()
  for (const candidate of collectCandidateSources(entity)) {
    const source = normalizeMediaSource(candidate, entity)
    if (source === null) continue
    const key = [
      source.publicationId || '',
      source.renditionId || '',
      source.playbackKey || '',
      source.id || '',
      source.videoId || '',
      source.path || '',
    ].join(':')
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(source)
  }

  // Ordering, strongest tier first: a source has to clear every hard gate, then
  // an explicit local preference wins, then the backend's own `selected` verdict
  // wins, and only then does a score break the remaining ties.
  const ranked = normalized
    .map((source, index) => ({
      source,
      index,
      allowed: isMediaSourceAllowed(source, policy),
      preference: preferenceRank(source, policy),
      backendSelected: source.selected === true,
      score: scoreMediaSource(source, policy),
    }))
    .sort((left, right) => {
      if (left.allowed !== right.allowed) return left.allowed ? -1 : 1
      if (left.preference !== right.preference) return right.preference - left.preference
      if (left.backendSelected !== right.backendSelected) return left.backendSelected ? -1 : 1
      if (right.score !== left.score) return right.score - left.score
      const leftId = sourceId(left.source)
      const rightId = sourceId(right.source)
      if (leftId < rightId) return -1
      if (leftId > rightId) return 1
      return left.index - right.index
    })

  const selectedEntry = ranked[0]?.allowed ? ranked[0] : null
  const selectedSource = selectedEntry?.source || null
  return {
    selectedSource,
    alternateSources: ranked.filter(entry => entry !== selectedEntry).map(({ source }) => source),
    sources: ranked.map(({ source }) => source),
    sourceCount: ranked.length,
    unavailableReason: selectedSource === null ? 'no-playable-source' : null,
  }
}

export function switchMediaSource(state = {}, source = {}) {
  const selected = selectStrictMediaSource([source], {})
  if (!selected?.playable || !selected.playbackRef) {
    return { ...state, sourceSwitchError: 'source-not-playable' }
  }
  return {
    ...state,
    selectedSource: selected,
    playbackRef: selected.playbackRef,
  }
}
