export function getMissingChannelMetaRequests(feedEntries, channelMeta, limit = Infinity) {
  const requests = []
  const seen = new Set()

  for (const entry of feedEntries || []) {
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
    if (visible.length >= limit) break
  }

  return visible
}

export function getFeedVideoLoadEntries(feedEntries, limit = 15) {
  return getVisibleSeededFeedEntries(feedEntries, limit)
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
