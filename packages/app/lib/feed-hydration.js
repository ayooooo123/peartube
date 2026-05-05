function getFeedEntryPriority(entry) {
  if (entry?.source === 'local') return 0
  if ((entry?.peerCount ?? 0) > 0) return 1
  if (entry?.publicBeeKey) return 2
  return 3
}

export function getMissingChannelMetaRequests(feedEntries, channelMeta, limit = Infinity) {
  const requests = []
  const seen = new Set()

  for (const entry of getVisibleSeededFeedEntries(feedEntries, Infinity)) {
    const channelKey = entry?.channelKey || entry?.driveKey
    if (!channelKey || seen.has(channelKey)) continue
    seen.add(channelKey)
    if (channelMeta?.[channelKey]) continue

    requests.push({
      channelKey,
      publicBeeKey: entry?.publicBeeKey || undefined,
    })

    if (requests.length >= limit) break
  }

  return requests
}

export function getVisibleSeededFeedEntries(feedEntries, limit = Infinity) {
  const visible = []
  const seen = new Set()

  for (const entry of feedEntries || []) {
    const channelKey = entry?.channelKey || entry?.driveKey
    if (!channelKey || seen.has(channelKey)) continue
    seen.add(channelKey)
    visible.push(entry)
  }

  return visible
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const priority = getFeedEntryPriority(a.entry) - getFeedEntryPriority(b.entry)
      return priority !== 0 ? priority : a.index - b.index
    })
    .slice(0, limit)
    .map(({ entry }) => entry)
}

export function getFeedVideoLoadEntries(feedEntries, limit = 15) {
  return getVisibleSeededFeedEntries(feedEntries, limit)
}

function canUseFeedPreviewVideos(entry, identityDriveKey) {
  const channelKey = entry?.channelKey || entry?.driveKey || null
  if (!channelKey) return false
  if (identityDriveKey && channelKey === identityDriveKey) return true
  if (entry?.source === 'local') return true
  return (entry?.peerCount ?? 0) > 0
}

export function getFeedPreviewVideos(feedEntries, channelMeta, identityDriveKey, limit = 15) {
  const videos = []
  const seen = new Set()

  for (const entry of getVisibleSeededFeedEntries(feedEntries, Infinity)) {
    if (!canUseFeedPreviewVideos(entry, identityDriveKey)) continue

    const channelKey = entry?.channelKey || entry?.driveKey
    const publicBeeKey = entry?.publicBeeKey || undefined
    const channelName =
      channelMeta?.[channelKey]?.name ||
      entry?.channelName ||
      (identityDriveKey && channelKey === identityDriveKey ? 'Your channel' : 'Unknown')

    for (const preview of entry?.previewVideos || []) {
      const videoKey = `${channelKey}:${preview?.id || preview?.path || ''}`
      if (!preview?.id || seen.has(videoKey)) continue
      if (!shouldRenderFeedVideo({
        video: { ...preview, channelKey },
        identityDriveKey,
      })) continue

      seen.add(videoKey)
      videos.push({
        ...preview,
        channelKey,
        driveKey: channelKey,
        publicBeeKey,
        channel: { name: channelName },
      })
    }
  }

  return videos
    .sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0))
    .slice(0, limit)
}

export function getFeedVideoHydrationMode({ feedEntries, swarmStatus }) {
  if (!Array.isArray(feedEntries) || feedEntries.length === 0) return 'off'

  // Use backend-provided per-entry peerCount as a network readiness signal too.
  // On mobile, getSwarmStatus can lag or time out while getPublicFeed already knows
  // that peer-discovered channels have reachable peers. If we ignore entry peerCount,
  // hydration stays stuck in local-only mode and never joins/fetches remote videos.
  const entryPeerSignal = feedEntries.some((entry) => (entry?.peerCount ?? 0) > 0)

  if (
    entryPeerSignal ||
    (swarmStatus?.feedConnections ?? 0) > 0 ||
    (swarmStatus?.peers ?? 0) > 0
  ) {
    return 'network'
  }

  return 'local-only'
}

export function shouldAutoLoadFeedVideos({ feedEntries, swarmStatus }) {
  return getFeedVideoHydrationMode({ feedEntries, swarmStatus }) !== 'off'
}

export function shouldRenderFeedVideo({ video, identityDriveKey }) {
  const channelKey = video?.channelKey || video?.driveKey || null
  if (identityDriveKey && channelKey === identityDriveKey) return true
  return video?.availability === 'playable'
}

export function isConfirmedFeedHydrationResult({ entry, resolved, videos = [] }) {
  if (!resolved) return false
  if (Array.isArray(videos) && videos.length > 0) return true
  const previewVideos = Array.isArray(entry?.previewVideos) ? entry.previewVideos : []
  const manifestUpdatedAt = Number(entry?.manifestUpdatedAt || 0) || 0
  return manifestUpdatedAt > 0 && previewVideos.length === 0
}

export function mergeHydratedFeedVideos({
  previousVideos = /** @type {any[]} */ ([]),
  incomingVideos = /** @type {any[]} */ ([]),
  refreshedChannelKeys = /** @type {string[]} */ ([]),
  identityDriveKey = undefined,
  limit = 50,
}) {
  const refreshed = new Set((refreshedChannelKeys || []).filter(Boolean))
  const byKey = new Map()

  for (const video of previousVideos || []) {
    if (!video) continue
    const channelKey = video?.channelKey || video?.driveKey || null
    if (channelKey && refreshed.has(channelKey)) continue
    const identifier = video?.id || video?.path || ''
    if (!identifier) continue
    const key = `${channelKey || ''}:${identifier}`
    byKey.set(key, video)
  }

  for (const video of incomingVideos || []) {
    if (!video) continue
    if (!shouldRenderFeedVideo({ video, identityDriveKey })) continue
    const channelKey = video?.channelKey || video?.driveKey || null
    const identifier = video?.id || video?.path || ''
    if (!identifier) continue
    const key = `${channelKey || ''}:${identifier}`
    byKey.set(key, {
      ...video,
      __feedSource: video?.__feedSource === 'preview' ? 'preview' : 'hydrated',
    })
  }

  return Array.from(byKey.values())
    .filter(Boolean)
    .sort((a, b) => (b?.uploadedAt || 0) - (a?.uploadedAt || 0))
    .slice(0, limit)
}

export function shouldKeepFeedVideoForVisibleEntries({ video, seededFeedChannelKeys, snapshotChannelKeys }) {
  const channelKey = video?.channelKey || video?.driveKey || null
  if (!channelKey) return false
  if (!seededFeedChannelKeys || seededFeedChannelKeys.size === 0) return true
  if (seededFeedChannelKeys.has(channelKey)) return true
  return video?.__feedSource === 'snapshot' && snapshotChannelKeys?.has(channelKey)
}

export function mergePreviewFeedVideos({
  previousVideos = [],
  previewVideos = [],
  limit = 50,
}) {
  const byKey = new Map()

  for (const video of previousVideos || []) {
    if (!video || video?.__feedSource === 'preview') continue
    const channelKey = video?.channelKey || video?.driveKey || null
    const identifier = video?.id || video?.path || ''
    if (!identifier) continue
    const key = `${channelKey || ''}:${identifier}`
    byKey.set(key, video)
  }

  for (const video of previewVideos || []) {
    if (!video) continue
    const channelKey = video?.channelKey || video?.driveKey || null
    const identifier = video?.id || video?.path || ''
    if (!identifier) continue
    const key = `${channelKey || ''}:${identifier}`
    if (byKey.has(key)) continue
    byKey.set(key, {
      ...video,
      __feedSource: 'preview',
    })
  }

  return Array.from(byKey.values())
    .filter(Boolean)
    .sort((a, b) => (b?.uploadedAt || 0) - (a?.uploadedAt || 0))
    .slice(0, limit)
}
