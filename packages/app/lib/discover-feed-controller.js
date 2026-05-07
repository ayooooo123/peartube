import {
  getFeedPreviewVideos,
  getVisibleSeededFeedEntries,
  shouldRenderFeedVideo,
} from './feed-hydration.js'

export function withFeedTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

export function mergeUniqueFeedVideos(previousVideos = [], incomingVideos = [], limit = 80) {
  const byKey = new Map()

  for (const video of [...(previousVideos || []), ...(incomingVideos || [])]) {
    if (!video) continue
    const channelKey = video.channelKey || video.driveKey || ''
    const identifier = video.id || video.path || ''
    if (!identifier) continue
    byKey.set(`${channelKey}:${identifier}`, video)
  }

  return Array.from(byKey.values()).slice(0, limit)
}

export function getVerticalFeedPreviewVideos(entries, { identityDriveKey, channelMeta = {}, limit = 40 } = {}) {
  const visibleEntries = getVisibleSeededFeedEntries(entries || [], Infinity)
  const previewVideos = getFeedPreviewVideos(
    visibleEntries,
    channelMeta,
    identityDriveKey,
    limit,
  )

  return previewVideos
    .filter((video) => shouldRenderFeedVideo({ video, identityDriveKey }))
    .slice(0, limit)
}

export function mapHydratedVerticalFeedVideos(entry, videoList, { identityDriveKey } = {}) {
  const channelKey = entry?.channelKey || entry?.driveKey
  if (!channelKey || !Array.isArray(videoList)) return []

  return videoList
    .filter((video) => shouldRenderFeedVideo({
      video: { ...video, channelKey },
      identityDriveKey,
    }))
    .map((video) => ({
      ...video,
      channelKey,
      publicBeeKey: entry.publicBeeKey || undefined,
      channel: { name: entry.channelName || 'Channel' },
    }))
}

export function clearHydratedFeedChannels(hydratedChannelsRef) {
  hydratedChannelsRef?.current?.clear?.()
}

export async function warmNextPlaybackUrls({
  videos,
  activeIndex,
  makePlaybackRequest,
  getCachedVideoUrl,
  setCachedVideoUrl,
  preparePlayback,
  windowSize = 4,
}) {
  const nextVideos = (videos || []).slice(activeIndex + 1, activeIndex + 1 + windowSize)

  await Promise.allSettled(nextVideos.map(async (video) => {
    const { cacheKey, playbackRequest } = makePlaybackRequest(video)
    if (cacheKey && getCachedVideoUrl(cacheKey)) return null
    const result = await preparePlayback?.(playbackRequest)
    if (result?.url && cacheKey) setCachedVideoUrl(cacheKey, result.url)
    return result?.url || null
  }))
}
