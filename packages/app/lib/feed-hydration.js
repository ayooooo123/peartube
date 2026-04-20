function getFeedEntryPriority(entry) {
  if (entry?.source === 'local') return 0
  if ((entry?.peerCount ?? 0) > 0) return 1
  if (entry?.publicBeeKey) return 2
  return 3
}

function getVideoIdentityKey(video) {
  return `${video?.channelKey || video?.driveKey || ''}:${video?.id || video?.path || ''}`
}

function sortFeedVideos(videos, limit = 50) {
  return Array.from(videos)
    .sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0))
    .slice(0, limit)
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

export function preserveRenderableFeedEntries(previousEntries = [], nextEntries = [], feedVideos = [], identityDriveKey = null) {
  const merged = new Map()

  for (const entry of nextEntries || []) {
    const channelKey = entry?.channelKey || entry?.driveKey || null
    if (!channelKey) continue
    merged.set(channelKey, entry)
  }

  for (const entry of previousEntries || []) {
    const channelKey = entry?.channelKey || entry?.driveKey || null
    if (!channelKey || merged.has(channelKey)) continue

    const hasRenderableCachedVideo = (feedVideos || []).some((video) => {
      const videoChannelKey = video?.channelKey || video?.driveKey || null
      if (videoChannelKey !== channelKey) return false
      if (video?._feedSource === 'preview') return false
      return shouldRenderFeedVideo({ video, identityDriveKey })
    })

    if (!hasRenderableCachedVideo) continue

    merged.set(channelKey, {
      ...entry,
      channelKey,
      driveKey: channelKey,
      peerCount: 0,
      previewVideos: [],
    })
  }

  return Array.from(merged.values())
}

function canUseFeedPreviewVideos(entry, identityDriveKey) {
  const channelKey = entry?.channelKey || entry?.driveKey || null
  if (!channelKey) return false
  if (identityDriveKey && channelKey === identityDriveKey) return true
  if (entry?.source === 'local') return true
  return (entry?.peerCount ?? 0) > 0
}

export function filterRenderableFeedVideos(feedVideos, feedEntries, identityDriveKey, limit = 50) {
  const entryByChannel = new Map(
    getVisibleSeededFeedEntries(feedEntries, Infinity)
      .map((entry) => [entry?.channelKey || entry?.driveKey, entry])
      .filter(([channelKey]) => Boolean(channelKey)),
  )

  const filtered = (feedVideos || []).filter((video) => {
    const channelKey = video?.channelKey || video?.driveKey || null
    if (!channelKey) return false
    if (!shouldRenderFeedVideo({ video, identityDriveKey })) return false
    const entry = entryByChannel.get(channelKey)
    if (!entry) return false
    if (canUseFeedPreviewVideos(entry, identityDriveKey)) return true

    // Cached/playable hydrated cards should remain visible even when the source
    // channel currently has zero live peers. Only preview-only cards need the
    // stricter live-peer gating, otherwise locally cached playable videos vanish
    // from Discover between sessions.
    return video?._feedSource !== 'preview'
  })

  return sortFeedVideos(filtered, limit)
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
        _feedSource: 'preview',
      })
    }
  }

  return sortFeedVideos(videos, limit)
}

export function applyConfirmedFeedVideoBatches(prevVideos, batches, limit = 50) {
  const confirmedChannelKeys = new Set(
    (batches || [])
      .filter((batch) => batch?.confirmed && (batch?.channelKey || null))
      .map((batch) => batch.channelKey),
  )

  const byKey = new Map()
  for (const video of prevVideos || []) {
    const channelKey = video?.channelKey || video?.driveKey || null
    if (channelKey && confirmedChannelKeys.has(channelKey)) continue
    byKey.set(getVideoIdentityKey(video), video)
  }

  for (const batch of batches || []) {
    for (const video of batch?.videos || []) {
      byKey.set(getVideoIdentityKey(video), video)
    }
  }

  return sortFeedVideos(byKey.values(), limit)
}

export function applyHydratedFeedVideoBatches(
  prevVideos,
  batches,
  feedEntries,
  channelMeta,
  identityDriveKey,
  limit = 50,
) {
  const entryByChannel = new Map(
    getVisibleSeededFeedEntries(feedEntries, Infinity)
      .map((entry) => [entry?.channelKey || entry?.driveKey, entry])
      .filter(([channelKey]) => Boolean(channelKey)),
  )

  const replaceChannelKeys = new Set(
    (batches || [])
      .filter((batch) => batch?.channelKey)
      .filter((batch) => {
        if (batch?.confirmed) return true
        const entry = entryByChannel.get(batch.channelKey)
        if (!entry) return false
        if (!canUseFeedPreviewVideos(entry, identityDriveKey)) return false
        return Array.isArray(batch?.videos) && batch.videos.length > 0
      })
      .map((batch) => batch.channelKey),
  )

  const byKey = new Map()
  for (const video of prevVideos || []) {
    const channelKey = video?.channelKey || video?.driveKey || null
    if (channelKey && replaceChannelKeys.has(channelKey)) continue
    byKey.set(getVideoIdentityKey(video), video)
  }

  for (const batch of batches || []) {
    for (const video of batch?.videos || []) {
      byKey.set(getVideoIdentityKey(video), video)
    }
  }

  return reconcilePreviewFeedVideos(
    Array.from(byKey.values()),
    feedEntries,
    channelMeta,
    identityDriveKey,
    limit,
  )
}

export function applyConfirmedFeedEntryBatches(prevEntries, batches) {
  const confirmedByChannel = new Map(
    (batches || [])
      .filter((batch) => batch?.confirmed && (batch?.channelKey || null))
      .map((batch) => [batch.channelKey, batch]),
  )

  if (confirmedByChannel.size === 0) return prevEntries || []

  return (prevEntries || []).map((entry) => {
    const channelKey = entry?.channelKey || entry?.driveKey || null
    const batch = channelKey ? confirmedByChannel.get(channelKey) : null
    if (!batch) return entry

    return {
      ...entry,
      previewVideos: (batch.videos || []).map((video) => ({
        id: video.id,
        title: video.title,
        uploadedAt: video.uploadedAt,
        duration: video.duration,
        thumbnail: video.thumbnail,
        blobId: video.blobId,
        blobsCoreKey: video.blobsCoreKey,
        mimeType: video.mimeType,
        availability: video.availability,
        thumbnailBlobId: video.thumbnailBlobId,
        thumbnailBlobsCoreKey: video.thumbnailBlobsCoreKey,
        thumbnailMimeType: video.thumbnailMimeType,
      })),
    }
  })
}

export function reconcilePreviewFeedVideos(prevVideos, feedEntries, channelMeta, identityDriveKey, limit = 50) {
  const previewVideos = getFeedPreviewVideos(feedEntries, channelMeta, identityDriveKey, limit)
  const byKey = new Map()

  for (const video of prevVideos || []) {
    const channelKey = video?.channelKey || video?.driveKey || null
    if (video?._feedSource === 'preview' && channelKey) {
      continue
    }
    byKey.set(getVideoIdentityKey(video), video)
  }

  for (const video of previewVideos) {
    const key = getVideoIdentityKey(video)
    const existing = byKey.get(key)
    if (existing && existing?._feedSource !== 'preview') {
      continue
    }
    byKey.set(key, video)
  }

  return sortFeedVideos(byKey.values(), limit)
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
