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

function availabilityScore(source) {
  const status = source?.availabilityStatus || source?.availability || source?.retentionStatus || source?.archiveStatus
  if (truthy(source?.localComplete) || truthy(source?.isLocal) || status === 'local' || status === 'complete-local') return 260
  if (truthy(source?.cached) || truthy(source?.retained) || status === 'cached' || status === 'retained') return 220
  if (truthy(source?.archived) || status === 'archived' || status === 'pledged') return 170
  if (truthy(source?.available) || status === 'available' || status === 'online' || status === 'seeded') return 140
  if (status === 'partial') return 90
  if (status === 'unavailable' || status === 'missing' || status === 'blocked') return -160
  return 0
}

function formatScore(source) {
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
    availabilityStatus: source.availabilityStatus || source.availability || source.retentionStatus || null,
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
    rejectionReasonCodes: asArray(source.rejectionReasonCodes),
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

export function scoreMediaSource(source, policy = {}) {
  if (!nonArrayObject(source)) return Number.NEGATIVE_INFINITY
  let score = availabilityScore(source) + formatScore(source) + sourceModerationPenalty(source)
  if (nonEmptyString(policy.preferredPublicationId) && source.publicationId === policy.preferredPublicationId) score += 1000
  if (nonEmptyString(policy.preferredRenditionId) && source.renditionId === policy.preferredRenditionId) score += 700
  if (nonEmptyString(policy.preferredPublisherId) && source.publisherId === policy.preferredPublisherId) score += 180
  if (policy.allowUnavailable === true && (source.availabilityStatus === 'unavailable' || source.availabilityStatus === 'missing')) score += 120
  score += Math.min(30, sourceTimestampMs(source) / 100000000000)
  return score
}

function isMediaSourceAllowed(source, policy) {
  const raw = source.raw || source
  if (source.stale || source.incomplete) return false
  if (source.formatSupported === false || source.playbackSupported === false) return false
  if (source.rejectionReasonCodes.some(code => HARD_REJECTION_REASONS[code] === true)) return false
  if (sourceModerationPenalty(source) <= -1000) return false
  if (source.availabilityState && source.availabilityState !== 'available') return false
  if (raw.available === false && !source.availabilityStatus) return false
  if (
    policy.allowUnavailable !== true &&
    (source.availabilityStatus === 'unavailable' ||
      source.availabilityStatus === 'missing' ||
      source.availabilityStatus === 'blocked')
  ) return false
  return true
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
  return normalized
    .filter(source => source.playable && source.playbackRef)
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

  const scored = normalized
    .map((source, index) => ({ source, index, score: scoreMediaSource(source, policy) }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      const leftId = sourceId(left.source)
      const rightId = sourceId(right.source)
      if (leftId < rightId) return -1
      if (leftId > rightId) return 1
      return left.index - right.index
    })

  const selectedEntry = scored.find(({ source }) => isMediaSourceAllowed(source, policy))
  const selectedSource = selectedEntry?.source || null
  return {
    selectedSource,
    alternateSources: scored.filter(entry => entry !== selectedEntry).map(({ source }) => source),
    sources: scored.map(({ source }) => source),
    sourceCount: scored.length,
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
