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
    archiveStatus: source.archiveStatus || source.retentionStatus || null,
    localComplete: !!source.localComplete,
    cached: !!source.cached,
    retained: !!source.retained,
    available: source.available !== false,
    verified: !!source.verified || source.verificationStatus === 'verified',
    formatSupported: source.formatSupported !== false,
    playbackSupported: source.playbackSupported !== false,
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

export function selectMediaSource(entity = {}, policy = {}) {
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

  const selectedSource = scored[0]?.source || null
  const alternateSources = scored.slice(1).map(({ source }) => source)
  return {
    selectedSource,
    alternateSources,
    sources: scored.map(({ source }) => source),
    sourceCount: scored.length,
    unavailableReason: selectedSource === null ? 'no-playable-source' : null,
  }
}
