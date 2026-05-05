import type { VideoData } from '@peartube/core'

interface DiscoverFeedCacheSnapshot {
  feedEntries: any[]
  videos: VideoData[]
  savedAt: number
}

let discoverFeedCache: DiscoverFeedCacheSnapshot = {
  feedEntries: [],
  videos: [],
  savedAt: 0,
}

export function readDiscoverFeedCache(): DiscoverFeedCacheSnapshot {
  return {
    feedEntries: Array.isArray(discoverFeedCache.feedEntries) ? discoverFeedCache.feedEntries : [],
    videos: Array.isArray(discoverFeedCache.videos) ? discoverFeedCache.videos : [],
    savedAt: discoverFeedCache.savedAt || 0,
  }
}

export function writeDiscoverFeedCache(snapshot: Partial<DiscoverFeedCacheSnapshot>) {
  discoverFeedCache = {
    feedEntries: Array.isArray(snapshot.feedEntries) ? snapshot.feedEntries : discoverFeedCache.feedEntries,
    videos: Array.isArray(snapshot.videos) ? snapshot.videos : discoverFeedCache.videos,
    savedAt: typeof snapshot.savedAt === 'number' ? snapshot.savedAt : Date.now(),
  }
}

export function clearDiscoverFeedCache() {
  discoverFeedCache = {
    feedEntries: [],
    videos: [],
    savedAt: 0,
  }
}
