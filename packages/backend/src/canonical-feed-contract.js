/**
 * Canonical feed contract for Home, Discover, and Shorts.
 *
 * The universal core is the source of truth for this schema.
 * App surfaces may adapt layout and controls, but they must not narrow the model.
 */

/**
 * @typedef {Object} CanonicalFeedChannel
 * @property {string} [channelKey]
 * @property {string} [driveKey]
 * @property {string | null} [name]
 * @property {string | null} [description]
 * @property {string | null} [avatar]
 * @property {string | null} [icon]
 * @property {string | null} [thumbnail]
 * @property {number | null} [videoCount]
 * @property {number | null} [lastSeen]
 * @property {number | null} [manifestUpdatedAt]
 */

/**
 * @typedef {Object} CanonicalFeedVideo
 * @property {string} id
 * @property {string | null} [path]
 * @property {string} title
 * @property {string | null} [description]
 * @property {number} uploadedAt
 * @property {number | null} [duration]
 * @property {string | null} [thumbnail]
 * @property {string | null} [thumbnailUrl]
 * @property {string | null} [thumbnailBlobId]
 * @property {string | null} [thumbnailBlobsCoreKey]
 * @property {string | null} [thumbnailMimeType]
 * @property {string | null} [blobId]
 * @property {string | null} [blobsCoreKey]
 * @property {string | null} [mimeType]
 * @property {'playable' | 'unavailable' | 'unknown' | null} [availability]
 * @property {'playable' | 'unavailable' | 'unknown' | null} [byteAvailability]
 * @property {boolean} [hasHeadBlock]
 * @property {number} [contiguousBlocks]
 * @property {boolean} [readyForPlayback]
 * @property {string} channelKey
 * @property {string | null} [driveKey]
 * @property {string | null} [publicBeeKey]
 * @property {string | null} [sourcePlatform]
 * @property {string | null} [sourcePlatformLabel]
 * @property {string | null} [sourceUrl]
 * @property {string | null} [sourceId]
 * @property {string | null} [sourceCreatorName]
 * @property {string | null} [sourceCreatorHandle]
 * @property {string | null} [sourceCreatorUrl]
 * @property {number | null} [sourcePublishedAt]
 * @property {number | null} [sourceViewCount]
 * @property {number | null} [sourceLikeCount]
 * @property {number | null} [sourceCommentCount]
 * @property {number | null} [sourceArchivedAt]
 * @property {string | null} [sourceRelayId]
 * @property {string | null} [sourceMetadataJson]
 * @property {CanonicalFeedChannel} [channel]
 */

/**
 * @typedef {Object} CanonicalFeedEntry
 * @property {string} channelKey
 * @property {string | null} [driveKey]
 * @property {string | null} [publicBeeKey]
 * @property {'peer' | 'local' | 'relay-cache' | string} source
 * @property {string | null} [relayRole]
 * @property {boolean} [relayServing]
 * @property {number} [peerCount]
 * @property {number} [videoCount]
 * @property {number} [lastSeen]
 * @property {number} [manifestUpdatedAt]
 * @property {string | null} [previewVideosHash]
 * @property {CanonicalFeedChannel} [channel]
 * @property {CanonicalFeedVideo[]} [previewVideos]
 */

export const CANONICAL_FEED_CONTRACT_VERSION = 1

export const CANONICAL_FEED_CHANNEL_FIELDS = Object.freeze([
  'channelKey',
  'driveKey',
  'name',
  'description',
  'avatar',
  'icon',
  'thumbnail',
  'videoCount',
  'lastSeen',
  'manifestUpdatedAt',
])

export const CANONICAL_FEED_VIDEO_FIELDS = Object.freeze([
  'id',
  'path',
  'title',
  'description',
  'uploadedAt',
  'duration',
  'thumbnail',
  'thumbnailUrl',
  'thumbnailBlobId',
  'thumbnailBlobsCoreKey',
  'thumbnailMimeType',
  'blobId',
  'blobsCoreKey',
  'mimeType',
  'availability',
  'byteAvailability',
  'hasHeadBlock',
  'contiguousBlocks',
  'readyForPlayback',
  'channelKey',
  'driveKey',
  'publicBeeKey',
  'sourcePlatform',
  'sourcePlatformLabel',
  'sourceUrl',
  'sourceId',
  'sourceCreatorName',
  'sourceCreatorHandle',
  'sourceCreatorUrl',
  'sourcePublishedAt',
  'sourceViewCount',
  'sourceLikeCount',
  'sourceCommentCount',
  'sourceArchivedAt',
  'sourceRelayId',
  'sourceMetadataJson',
  'channel',
])

export const CANONICAL_FEED_ENTRY_FIELDS = Object.freeze([
  'channelKey',
  'driveKey',
  'publicBeeKey',
  'source',
  'relayRole',
  'relayServing',
  'peerCount',
  'videoCount',
  'lastSeen',
  'manifestUpdatedAt',
  'previewVideosHash',
  'channel',
  'previewVideos',
])

function copyDefinedFields(source, fields) {
  const out = {}
  for (const field of fields) {
    if (source?.[field] !== undefined) out[field] = source[field]
  }
  return out
}

function normalizeNumber(value, fallback = null) {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

export function createCanonicalFeedChannel(channel = {}) {
  const normalized = copyDefinedFields(channel, CANONICAL_FEED_CHANNEL_FIELDS)
  normalized.channelKey = channel.channelKey || channel.driveKey || normalized.channelKey || ''
  normalized.driveKey = channel.driveKey || channel.channelKey || normalized.driveKey || normalized.channelKey || ''
  normalized.name = channel.name ?? normalized.name ?? null
  normalized.description = channel.description ?? normalized.description ?? null
  normalized.avatar = channel.avatar ?? normalized.avatar ?? null
  normalized.icon = channel.icon ?? normalized.icon ?? null
  normalized.thumbnail = channel.thumbnail ?? normalized.thumbnail ?? null
  normalized.videoCount = normalizeNumber(channel.videoCount, normalized.videoCount ?? null)
  normalized.lastSeen = normalizeNumber(channel.lastSeen, normalized.lastSeen ?? null)
  normalized.manifestUpdatedAt = normalizeNumber(channel.manifestUpdatedAt, normalized.manifestUpdatedAt ?? null)
  return normalized
}

export function createCanonicalFeedVideo(video = {}) {
  const normalized = copyDefinedFields(video, CANONICAL_FEED_VIDEO_FIELDS)
  normalized.id = video.id ? String(video.id) : normalized.id || ''
  normalized.path = video.path ?? normalized.path ?? null
  normalized.title = video.title ? String(video.title) : normalized.title || ''
  normalized.description = video.description ?? normalized.description ?? null
  normalized.uploadedAt = normalizeNumber(video.uploadedAt, normalized.uploadedAt ?? 0) || 0
  normalized.duration = normalizeNumber(video.duration, normalized.duration ?? null)
  normalized.thumbnail = video.thumbnail ?? normalized.thumbnail ?? null
  normalized.thumbnailUrl = video.thumbnailUrl ?? normalized.thumbnailUrl ?? null
  normalized.thumbnailBlobId = video.thumbnailBlobId ?? normalized.thumbnailBlobId ?? null
  normalized.thumbnailBlobsCoreKey = video.thumbnailBlobsCoreKey ?? normalized.thumbnailBlobsCoreKey ?? null
  normalized.thumbnailMimeType = video.thumbnailMimeType ?? normalized.thumbnailMimeType ?? null
  normalized.blobId = video.blobId ?? normalized.blobId ?? null
  normalized.blobsCoreKey = video.blobsCoreKey ?? normalized.blobsCoreKey ?? null
  normalized.mimeType = video.mimeType ?? normalized.mimeType ?? null
  normalized.availability = video.availability ?? normalized.availability ?? null
  normalized.byteAvailability = video.byteAvailability ?? normalized.byteAvailability ?? normalized.availability ?? null
  normalized.hasHeadBlock = Boolean(video.hasHeadBlock ?? normalized.hasHeadBlock)
  normalized.contiguousBlocks = normalizeNumber(video.contiguousBlocks, normalized.contiguousBlocks ?? 0) || 0
  normalized.readyForPlayback = Boolean(video.readyForPlayback ?? normalized.readyForPlayback)
  normalized.channelKey = video.channelKey || video.driveKey || normalized.channelKey || ''
  normalized.driveKey = video.driveKey || video.channelKey || normalized.driveKey || normalized.channelKey || ''
  normalized.publicBeeKey = video.publicBeeKey ?? normalized.publicBeeKey ?? null
  normalized.sourcePlatform = video.sourcePlatform ?? normalized.sourcePlatform ?? null
  normalized.sourcePlatformLabel = video.sourcePlatformLabel ?? normalized.sourcePlatformLabel ?? null
  normalized.sourceUrl = video.sourceUrl ?? normalized.sourceUrl ?? null
  normalized.sourceId = video.sourceId ?? normalized.sourceId ?? null
  normalized.sourceCreatorName = video.sourceCreatorName ?? normalized.sourceCreatorName ?? null
  normalized.sourceCreatorHandle = video.sourceCreatorHandle ?? normalized.sourceCreatorHandle ?? null
  normalized.sourceCreatorUrl = video.sourceCreatorUrl ?? normalized.sourceCreatorUrl ?? null
  normalized.sourcePublishedAt = normalizeNumber(video.sourcePublishedAt, normalized.sourcePublishedAt ?? null)
  normalized.sourceViewCount = normalizeNumber(video.sourceViewCount, normalized.sourceViewCount ?? null)
  normalized.sourceLikeCount = normalizeNumber(video.sourceLikeCount, normalized.sourceLikeCount ?? null)
  normalized.sourceCommentCount = normalizeNumber(video.sourceCommentCount, normalized.sourceCommentCount ?? null)
  normalized.sourceArchivedAt = normalizeNumber(video.sourceArchivedAt, normalized.sourceArchivedAt ?? null)
  normalized.sourceRelayId = video.sourceRelayId ?? normalized.sourceRelayId ?? null
  normalized.sourceMetadataJson = video.sourceMetadataJson ?? normalized.sourceMetadataJson ?? null
  normalized.channel = video.channel ? createCanonicalFeedChannel(video.channel) : normalized.channel ? createCanonicalFeedChannel(normalized.channel) : undefined
  return normalized
}

export function createCanonicalFeedEntry(entry = {}) {
  const normalized = copyDefinedFields(entry, CANONICAL_FEED_ENTRY_FIELDS)
  normalized.channelKey = entry.channelKey || entry.driveKey || normalized.channelKey || ''
  normalized.driveKey = entry.driveKey || entry.channelKey || normalized.driveKey || normalized.channelKey || ''
  normalized.publicBeeKey = entry.publicBeeKey ?? normalized.publicBeeKey ?? null
  normalized.source = entry.source || normalized.source || 'peer'
  normalized.relayRole = entry.relayRole ?? normalized.relayRole ?? null
  normalized.relayServing = Boolean(entry.relayServing ?? normalized.relayServing)
  normalized.peerCount = normalizeNumber(entry.peerCount, normalized.peerCount ?? 0) || 0
  normalized.videoCount = normalizeNumber(entry.videoCount, normalized.videoCount ?? 0) || 0
  normalized.lastSeen = normalizeNumber(entry.lastSeen, normalized.lastSeen ?? 0) || 0
  normalized.manifestUpdatedAt = normalizeNumber(entry.manifestUpdatedAt, normalized.manifestUpdatedAt ?? 0) || 0
  normalized.previewVideosHash = entry.previewVideosHash ?? normalized.previewVideosHash ?? null
  normalized.channel = entry.channel ? createCanonicalFeedChannel(entry.channel) : normalized.channel ? createCanonicalFeedChannel(normalized.channel) : undefined
  normalized.previewVideos = Array.isArray(entry.previewVideos)
    ? entry.previewVideos.map((video) => createCanonicalFeedVideo(video))
    : Array.isArray(normalized.previewVideos)
      ? normalized.previewVideos.map((video) => createCanonicalFeedVideo(video))
      : []
  return normalized
}

export function createCanonicalFeedEnvelope({
  version = CANONICAL_FEED_CONTRACT_VERSION,
  savedAt = Date.now(),
  identityDriveKey = undefined,
  entries = [],
  videos = [],
  channelMetaByKey = {},
} = {}) {
  const normalizedEntries = Array.isArray(entries) ? entries.map((entry) => createCanonicalFeedEntry(entry)) : []
  const normalizedVideos = Array.isArray(videos) ? videos.map((video) => createCanonicalFeedVideo(video)) : []
  const normalizedChannelMetaByKey = {}

  for (const [key, value] of Object.entries(channelMetaByKey || {})) {
    normalizedChannelMetaByKey[key] = createCanonicalFeedChannel({
      channelKey: key,
      ...(value || {}),
    })
  }

  return {
    version,
    savedAt,
    identityDriveKey,
    entries: normalizedEntries,
    videos: normalizedVideos,
    channelMetaByKey: normalizedChannelMetaByKey,
  }
}
