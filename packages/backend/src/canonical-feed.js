import {
  CANONICAL_FEED_CONTRACT_VERSION,
} from './canonical-feed-contract.js'

const CANONICAL_AVAILABILITY = new Set(['playable', 'unavailable', 'unknown'])

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

function firstStringOrNull(...values) {
  const value = firstString(...values)
  return value.length > 0 ? value : null
}

function toNumber(value, fallback = 0) {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function normalizeAvailability(value) {
  if (typeof value !== 'string') return 'unknown'
  const normalized = value.trim().toLowerCase()
  return CANONICAL_AVAILABILITY.has(normalized) ? normalized : 'unknown'
}

function reconcileAvailability(rawAvailability, rawByteAvailability, rawPlaybackSupport) {
  const playbackHint = typeof rawPlaybackSupport === 'string' ? rawPlaybackSupport.trim().toLowerCase() : ''
  const fromPlaybackHint = playbackHint === 'playable' || playbackHint === 'verified' || playbackHint === 'ready'
    ? 'playable'
    : playbackHint === 'unavailable' || playbackHint === 'blocked' || playbackHint === 'unsupported'
      ? 'unavailable'
      : null

  const availabilityCandidates = [rawAvailability, rawByteAvailability, fromPlaybackHint].map(normalizeAvailability)
  if (availabilityCandidates.includes('playable')) return 'playable'
  if (availabilityCandidates.includes('unavailable')) return 'unavailable'
  return 'unknown'
}

function normalizeChannelObject(rawChannel = {}, fallback = {}) {
  const channelKey = firstStringOrNull(
    rawChannel.channelKey,
    rawChannel.driveKey,
    fallback.channelKey,
    fallback.driveKey,
    fallback.channel,
    rawChannel.key,
  )
  const driveKey = firstStringOrNull(
    rawChannel.driveKey,
    rawChannel.channelKey,
    fallback.driveKey,
    fallback.channelKey,
    channelKey,
  )

  return {
    channelKey,
    driveKey,
    name: rawChannel.name ?? fallback.name ?? null,
    description: rawChannel.description ?? fallback.description ?? null,
    avatar: rawChannel.avatar ?? rawChannel.avatarUrl ?? fallback.avatar ?? null,
    icon: rawChannel.icon ?? fallback.icon ?? null,
    thumbnail: rawChannel.thumbnail ?? fallback.thumbnail ?? null,
    videoCount: toNumberOrNull(rawChannel.videoCount ?? fallback.videoCount),
    lastSeen: toNumberOrNull(rawChannel.lastSeen ?? fallback.lastSeen),
    manifestUpdatedAt: toNumberOrNull(rawChannel.manifestUpdatedAt ?? fallback.manifestUpdatedAt),
  }
}

function normalizeDirectPlaybackRefs(raw = {}) {
  return {
    blobId: firstStringOrNull(raw.blobId, raw.videoBlobId, raw.sourceBlobId, raw.refBlobId),
    blobsCoreKey: firstStringOrNull(raw.blobsCoreKey, raw.blobCoreKey, raw.contentKey, raw.refCoreKey),
    mimeType: firstStringOrNull(raw.mimeType, raw.mediaType, raw.type),
  }
}

function normalizeThumbnailRefs(raw = {}) {
  return {
    thumbnail: raw.thumbnail ?? raw.thumbnailUrl ?? null,
    thumbnailUrl: raw.thumbnailUrl ?? raw.thumbnail ?? null,
    thumbnailBlobId: firstStringOrNull(raw.thumbnailBlobId, raw.previewBlobId),
    thumbnailBlobsCoreKey: firstStringOrNull(raw.thumbnailBlobsCoreKey, raw.previewBlobsCoreKey),
    thumbnailMimeType: firstStringOrNull(raw.thumbnailMimeType, raw.previewMimeType),
  }
}

/**
 * Normalize a raw video record into the canonical feed video shape.
 *
 * This is the shared normalization layer for local uploads, public feed entries,
 * and restart-style preview restoration.
 *
 * @param {Object} rawVideo
 * @param {Object} [options]
 * @param {'local-upload'|'public-feed'|'preview-hydration'|string} [options.source]
 * @param {Object} [options.channel]
 * @param {Object} [options.channelMeta]
 * @param {string} [options.channelKey]
 * @param {string} [options.driveKey]
 * @param {string} [options.publicBeeKey]
 * @returns {import('./canonical-feed-contract.js').CanonicalFeedVideo}
 */
export function normalizeCanonicalFeedVideo(rawVideo = {}, options = {}) {
  const source = options.source || rawVideo.source || 'public-feed'
  const rawChannel = rawVideo.channel || options.channel || rawVideo.channelMeta || options.channelMeta || {}
  const channel = normalizeChannelObject(rawChannel, {
    channelKey: options.channelKey || rawVideo.channelKey || rawVideo.driveKey,
    driveKey: options.driveKey || rawVideo.driveKey || rawVideo.channelKey,
    name: rawVideo.channelName,
    description: rawVideo.channelDescription,
    avatar: rawVideo.channelAvatar,
    icon: rawVideo.channelIcon,
    thumbnail: rawVideo.channelThumbnail,
    videoCount: rawVideo.channelVideoCount,
    lastSeen: rawVideo.channelLastSeen,
    manifestUpdatedAt: rawVideo.channelManifestUpdatedAt || rawVideo.manifestUpdatedAt,
  })

  const channelKey = firstStringOrNull(
    rawVideo.channelKey,
    rawVideo.driveKey,
    options.channelKey,
    options.driveKey,
    channel.channelKey,
    channel.driveKey,
  ) || ''
  const driveKey = firstStringOrNull(
    rawVideo.driveKey,
    rawVideo.channelKey,
    options.driveKey,
    options.channelKey,
    channel.driveKey,
    channel.channelKey,
    channelKey,
  ) || channelKey
  const directRefs = normalizeDirectPlaybackRefs(rawVideo)
  const thumbnailRefs = normalizeThumbnailRefs(rawVideo)
  const resolvedAvailability = reconcileAvailability(
    rawVideo.availability,
    rawVideo.byteAvailability,
    rawVideo.playbackSupport,
  )

  return {
    id: firstString(rawVideo.id, rawVideo.videoId, rawVideo.path, rawVideo.slug),
    path: firstStringOrNull(rawVideo.path, rawVideo.videoPath, rawVideo.legacyPath),
    title: firstString(rawVideo.title, rawVideo.name, rawVideo.videoTitle, rawVideo.displayName, rawVideo.filename) || 'Untitled',
    description: rawVideo.description ?? rawVideo.videoDescription ?? null,
    uploadedAt: toNumber(rawVideo.uploadedAt ?? rawVideo.createdAt ?? rawVideo.addedAt ?? rawVideo.lastSeen ?? 0),
    duration: toNumberOrNull(rawVideo.duration ?? rawVideo.length ?? rawVideo.seconds),
    ...thumbnailRefs,
    ...directRefs,
    availability: resolvedAvailability,
    byteAvailability: resolvedAvailability,
    channelKey,
    driveKey,
    publicBeeKey: firstStringOrNull(rawVideo.publicBeeKey, options.publicBeeKey),
    channel,
    source,
  }
}

/**
 * Normalize a local upload payload into the canonical feed video shape.
 *
 * @param {Object} rawVideo
 * @param {Object} [channel]
 * @returns {import('./canonical-feed-contract.js').CanonicalFeedVideo}
 */
export function normalizeCanonicalFeedVideoFromLocalUpload(rawVideo = {}, channel = {}) {
  return normalizeCanonicalFeedVideo(rawVideo, {
    source: 'local-upload',
    channel,
    channelKey: rawVideo.channelKey || rawVideo.driveKey,
    driveKey: rawVideo.driveKey || rawVideo.channelKey,
    publicBeeKey: rawVideo.publicBeeKey || null,
  })
}

/**
 * Normalize a public feed entry or preview manifest item into the canonical feed video shape.
 *
 * @param {Object} rawVideo
 * @param {Object} [feedEntry]
 * @returns {import('./canonical-feed-contract.js').CanonicalFeedVideo}
 */
export function normalizeCanonicalFeedVideoFromPublicFeed(rawVideo = {}, feedEntry = {}) {
  return normalizeCanonicalFeedVideo(rawVideo, {
    source: 'public-feed',
    channel: feedEntry.channel || rawVideo.channel,
    channelMeta: feedEntry.channelMeta || rawVideo.channelMeta,
    channelKey: feedEntry.channelKey || feedEntry.driveKey || rawVideo.channelKey || rawVideo.driveKey,
    driveKey: feedEntry.driveKey || feedEntry.channelKey || rawVideo.driveKey || rawVideo.channelKey,
    publicBeeKey: feedEntry.publicBeeKey || rawVideo.publicBeeKey || null,
  })
}

/**
 * Normalize preview-hydrated feed video metadata after restart.
 * This keeps the direct blob refs and the full channel object intact so
 * restored previews can survive a refresh without losing renderable metadata.
 *
 * @param {Object} rawVideo
 * @param {Object} [feedEntry]
 * @returns {import('./canonical-feed-contract.js').CanonicalFeedVideo}
 */
export function normalizeCanonicalFeedVideoFromPreviewHydration(rawVideo = {}, feedEntry = {}) {
  return normalizeCanonicalFeedVideo(rawVideo, {
    source: 'preview-hydration',
    channel: feedEntry.channel || rawVideo.channel,
    channelMeta: feedEntry.channelMeta || rawVideo.channelMeta,
    channelKey: feedEntry.channelKey || feedEntry.driveKey || rawVideo.channelKey || rawVideo.driveKey,
    driveKey: feedEntry.driveKey || feedEntry.channelKey || rawVideo.driveKey || rawVideo.channelKey,
    publicBeeKey: feedEntry.publicBeeKey || rawVideo.publicBeeKey || null,
  })
}

/**
 * Normalize a list of raw videos into canonical feed videos.
 *
 * @param {Object[]} videos
 * @param {Object} [options]
 * @returns {import('./canonical-feed-contract.js').CanonicalFeedVideo[]}
 */
export function normalizeCanonicalFeedVideos(videos = [], options = {}) {
  if (!Array.isArray(videos)) return []
  return videos.map((video) => normalizeCanonicalFeedVideo(video, options))
}

export const CANONICAL_FEED_VERSION = CANONICAL_FEED_CONTRACT_VERSION
