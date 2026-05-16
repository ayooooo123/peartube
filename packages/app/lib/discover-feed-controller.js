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

function hasNonEmpty(value) {
  if (Array.isArray(value)) return value.length > 0
  return value !== undefined && value !== null && value !== ''
}

function getEntryKey(entry) {
  return entry?.channelKey || entry?.driveKey || ''
}

function getEntryFreshness(entry) {
  return Number(entry?.manifestUpdatedAt || entry?.lastSeen || 0) || 0
}

function mergeFeedEntry(previous, incoming) {
  if (!previous) return incoming
  if (!incoming) return previous

  const previousFreshness = getEntryFreshness(previous)
  const incomingFreshness = getEntryFreshness(incoming)
  const incomingIsNewer = incomingFreshness >= previousFreshness
  const merged = { ...previous, ...incoming }

  if (!hasNonEmpty(incoming.previewVideos) || !incomingIsNewer) {
    merged.previewVideos = previous.previewVideos || []
  }

  if (!hasNonEmpty(incoming.channelName) || !incomingIsNewer) {
    merged.channelName = previous.channelName || incoming.channelName || null
  }

  if (!hasNonEmpty(incoming.manifestUpdatedAt) || !incomingIsNewer) {
    merged.manifestUpdatedAt = previous.manifestUpdatedAt || incoming.manifestUpdatedAt || 0
  }

  if (!hasNonEmpty(incoming.publicBeeKey)) {
    merged.publicBeeKey = previous.publicBeeKey || incoming.publicBeeKey || null
  }

  return merged
}

export function mergeVerticalFeedEntries(previousEntries = [], incomingEntries = []) {
  const byKey = new Map()
  const order = []

  for (const entry of previousEntries || []) {
    const key = getEntryKey(entry)
    if (!key) continue
    byKey.set(key, entry)
    order.push(key)
  }

  for (const entry of incomingEntries || []) {
    const key = getEntryKey(entry)
    if (!key) continue
    if (!byKey.has(key)) order.push(key)
    byKey.set(key, mergeFeedEntry(byKey.get(key), entry))
  }

  return order.map((key) => byKey.get(key)).filter(Boolean)
}

export function hasRichVerticalFeedSnapshot(entries = [], videos = []) {
  return Boolean(
    (videos || []).length > 0 ||
    (entries || []).some((entry) => Array.isArray(entry?.previewVideos) && entry.previewVideos.length > 0)
  )
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
      channel: entry.channel || { name: entry.channelName || 'Channel' },
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
  inflightPlaybackWarmups = null,
}) {
  const nextVideos = (videos || []).slice(activeIndex + 1, activeIndex + 1 + windowSize)

  await Promise.allSettled(nextVideos.map(async (video) => {
    const { cacheKey, playbackRequest } = makePlaybackRequest(video)
    if (cacheKey && getCachedVideoUrl(cacheKey)) return null
    if (cacheKey && inflightPlaybackWarmups?.current?.has?.(cacheKey)) return null
    if (cacheKey) inflightPlaybackWarmups?.current?.add?.(cacheKey)
    try {
      const result = await preparePlayback?.(playbackRequest)
      if (result?.url && cacheKey) setCachedVideoUrl(cacheKey, result.url)
      return result?.url || null
    } finally {
      if (cacheKey) inflightPlaybackWarmups?.current?.delete?.(cacheKey)
    }
  }))
}
