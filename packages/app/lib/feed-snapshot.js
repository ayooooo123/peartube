const FEED_SNAPSHOT_VERSION = 1
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_LIMIT = 50

const VIDEO_FIELDS = [
  'id',
  'path',
  'title',
  'creatorName',
  'description',
  'duration',
  'uploadedAt',
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
]

function copyDefinedFields(source, fields) {
  const out = {}
  for (const field of fields) {
    if (source?.[field] !== undefined) out[field] = source[field]
  }
  return out
}

function snapshotKeyForVideo(video) {
  const channelKey = video?.channelKey || video?.driveKey || ''
  const identifier = video?.id || video?.path || ''
  if (!identifier) return null
  return `${channelKey}:${identifier}`
}

const LOOPBACK_HTTP_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//i

function shouldSnapshotThumbnailValue(value) {
  return typeof value === 'string' && value.length > 0 && !LOOPBACK_HTTP_RE.test(value)
}

function hasDirectBlobRef(video) {
  return typeof video?.blobId === 'string' && video.blobId.length > 0 &&
    typeof video?.blobsCoreKey === 'string' && /^[a-f0-9]{64}$/i.test(video.blobsCoreKey)
}

function hasDirectBlobReadinessProof(video) {
  return video?.readyForPlayback === true ||
    (video?.hasHeadBlock === true && (Number(video?.contiguousBlocks || 0) || 0) > 0)
}

export function createFeedSnapshot({
  videos = [],
  channelMeta = {},
  identityDriveKey = undefined,
  now = Date.now(),
  limit = DEFAULT_LIMIT,
} = {}) {
  const seen = new Set()
  const snapshotVideos = []

  for (const video of videos || []) {
    if (!video) continue
    const key = snapshotKeyForVideo(video)
    if (!key || seen.has(key)) continue
    seen.add(key)

    const channelKey = video.channelKey || video.driveKey || null
    const localVideo = identityDriveKey && channelKey === identityDriveKey
    const playable = localVideo || (hasDirectBlobRef(video)
      ? hasDirectBlobReadinessProof(video)
      : video.availability === 'playable')
    if (!playable) continue

    const safeVideo = copyDefinedFields(video, VIDEO_FIELDS)
    safeVideo.channelKey = channelKey || safeVideo.channelKey
    safeVideo.driveKey = video.driveKey || channelKey || safeVideo.driveKey
    safeVideo.availability = localVideo ? 'playable' : playable ? (video.availability || 'playable') : video.availability

    // Loopback blob-server URLs are per-process/per-port. Persist blob refs,
    // but force mobile to re-resolve the current http://127.0.0.1:<port>/...
    // thumbnail URL on launch instead of restoring a stale URL.
    if (shouldSnapshotThumbnailValue(video.thumbnail)) safeVideo.thumbnail = video.thumbnail
    if (shouldSnapshotThumbnailValue(video.thumbnailUrl)) safeVideo.thumbnailUrl = video.thumbnailUrl

    const channelName = video.channel?.name || channelMeta?.[channelKey]?.name || null
    if (channelName) safeVideo.channel = { name: channelName }

    snapshotVideos.push(safeVideo)
    if (snapshotVideos.length >= limit) break
  }

  return {
    version: FEED_SNAPSHOT_VERSION,
    savedAt: now,
    videos: snapshotVideos,
  }
}

export function restoreFeedSnapshot(snapshot, {
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  limit = DEFAULT_LIMIT,
} = {}) {
  if (!snapshot || snapshot.version !== FEED_SNAPSHOT_VERSION) return []
  const savedAt = Number(snapshot.savedAt || 0)
  if (!savedAt || now - savedAt > maxAgeMs) return []
  if (!Array.isArray(snapshot.videos)) return []

  const seen = new Set()
  const restored = []
  for (const video of snapshot.videos) {
    if (!video) continue
    const key = snapshotKeyForVideo(video)
    if (!key || seen.has(key)) continue
    seen.add(key)
    restored.push({
      ...video,
      __feedSource: 'snapshot',
    })
    if (restored.length >= limit) break
  }
  return restored
}

export function getSnapshotChannelKeys(videos = []) {
  return Array.from(new Set(
    (videos || [])
      .map((video) => video?.channelKey || video?.driveKey)
      .filter(Boolean)
  ))
}
