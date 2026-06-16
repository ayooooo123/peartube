import type { VideoData } from '@peartube/core'

export interface DiscoverFeedCacheSnapshot {
  feedEntries: any[]
  videos: VideoData[]
  savedAt: number
}

const MAX_CACHE_AGE_MS = 30 * 60 * 1000
const MAX_FEED_ENTRIES = 80
const MAX_VIDEOS = 80
const SOURCE_METADATA_FIELDS = [
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
] as const

let cachedDiscoverFeed: DiscoverFeedCacheSnapshot | null = null

function copySourceMetadata(source: any) {
  const out: Record<string, any> = {}
  for (const field of SOURCE_METADATA_FIELDS) {
    if (source?.[field] !== undefined) out[field] = source[field]
  }
  return out
}

function safeFeedEntries(entries: any[] = []) {
  return entries
    .filter(Boolean)
    .slice(0, MAX_FEED_ENTRIES)
    .map((entry) => ({
      driveKey: entry.driveKey,
      channelKey: entry.channelKey,
      publicBeeKey: entry.publicBeeKey,
      channelName: entry.channelName ?? null,
      source: entry.source,
      peerCount: entry.peerCount,
      videoCount: entry.videoCount,
      lastSeen: entry.lastSeen,
      previewVideos: Array.isArray(entry.previewVideos) ? entry.previewVideos.slice(0, 12).map((video: any) => ({
        id: video.id,
        title: video.title,
        uploadedAt: video.uploadedAt,
        duration: video.duration,
        thumbnail: video.thumbnail ?? null,
        blobId: video.blobId ?? null,
        blobsCoreKey: video.blobsCoreKey ?? null,
        mimeType: video.mimeType ?? null,
        availability: video.availability,
        thumbnailBlobId: video.thumbnailBlobId ?? null,
        thumbnailBlobsCoreKey: video.thumbnailBlobsCoreKey ?? null,
        thumbnailMimeType: video.thumbnailMimeType ?? null,
        ...copySourceMetadata(video),
      })) : undefined,
    }))
}

function safeVideos(videos: VideoData[] = []) {
  return videos
    .filter((video) => video && (video.id || video.path) && (video.channelKey || (video as any).driveKey))
    .slice(0, MAX_VIDEOS)
    .map((video) => {
      const videoAny = video as any
      const channelName = videoAny.channel?.name
      return {
        id: video.id,
        path: video.path,
        title: video.title,
        description: video.description,
        channelKey: video.channelKey || videoAny.driveKey,
        driveKey: videoAny.driveKey || video.channelKey,
        publicBeeKey: videoAny.publicBeeKey || undefined,
        size: video.size,
        duration: video.duration,
        uploadedAt: video.uploadedAt,
        thumbnail: videoAny.thumbnail,
        thumbnailUrl: video.thumbnailUrl,
        thumbnailBlobId: videoAny.thumbnailBlobId || undefined,
        thumbnailBlobsCoreKey: videoAny.thumbnailBlobsCoreKey || undefined,
        thumbnailMimeType: videoAny.thumbnailMimeType || undefined,
        blobId: videoAny.blobId || undefined,
        blobsCoreKey: videoAny.blobsCoreKey || undefined,
        mimeType: videoAny.mimeType || undefined,
        availability: videoAny.availability,
        ...copySourceMetadata(videoAny),
        channel: channelName ? { name: channelName } : video.channel,
      } as VideoData
    })
}

export function readDiscoverFeedCache({ now = Date.now(), maxAgeMs = MAX_CACHE_AGE_MS } = {}): DiscoverFeedCacheSnapshot | null {
  if (!cachedDiscoverFeed) return null
  if (now - cachedDiscoverFeed.savedAt > maxAgeMs) return null
  return {
    feedEntries: [...cachedDiscoverFeed.feedEntries],
    videos: [...cachedDiscoverFeed.videos],
    savedAt: cachedDiscoverFeed.savedAt,
  }
}

export function writeDiscoverFeedCache({ feedEntries = [], videos = [], now = Date.now() }: {
  feedEntries?: any[]
  videos?: VideoData[]
  now?: number
}): DiscoverFeedCacheSnapshot | null {
  const safe = {
    feedEntries: safeFeedEntries(feedEntries),
    videos: safeVideos(videos),
    savedAt: now,
  }
  if (safe.feedEntries.length === 0 && safe.videos.length === 0) return cachedDiscoverFeed
  cachedDiscoverFeed = safe
  return readDiscoverFeedCache({ now })
}

export function clearDiscoverFeedCache() {
  cachedDiscoverFeed = null
}
