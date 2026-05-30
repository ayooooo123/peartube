type CacheEntry = {
  url: string
  expiresAt: number
  readyForPlayback?: boolean
}

const VIDEO_URL_CACHE_TTL_MS = 2 * 60 * 1000
const videoUrlCache = new Map<string, CacheEntry>()

export function makeVideoUrlCacheKey(
  channelKey?: string,
  videoRef?: string,
  blobId?: string,
  blobsCoreKey?: string,
): string | null {
  const normalizedChannelKey = typeof channelKey === 'string' ? channelKey.trim() : ''
  const normalizedVideoRef = typeof videoRef === 'string' ? videoRef.trim() : ''
  if (!normalizedChannelKey || !normalizedVideoRef) return null
  return `${normalizedChannelKey}:${normalizedVideoRef}:${blobId || ''}:${blobsCoreKey || ''}`
}

export function getCachedVideoUrl(cacheKey: string, options: { requireReady?: boolean } = {}): string | null {
  const now = Date.now()
  const cached = videoUrlCache.get(cacheKey)
  if (!cached) return null
  if (cached.expiresAt <= now) {
    videoUrlCache.delete(cacheKey)
    return null
  }
  if (options.requireReady && !cached.readyForPlayback) return null
  return cached.url
}

export function setCachedVideoUrl(cacheKey: string, url: string, readyForPlayback?: boolean): void {
  videoUrlCache.set(cacheKey, {
    url,
    readyForPlayback,
    expiresAt: Date.now() + VIDEO_URL_CACHE_TTL_MS,
  })
}
