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

export function getFeedVideoLoadEntries(feedEntries, limit = 15) {
  const requests = []
  const seen = new Set()

  for (const entry of feedEntries || []) {
    const channelKey = entry?.channelKey || entry?.driveKey
    if (!channelKey || seen.has(channelKey)) continue
    seen.add(channelKey)
    requests.push(entry)
    if (requests.length >= limit) break
  }

  return requests
}

export function getFeedVideoHydrationMode({ feedEntries, swarmStatus }) {
  if (!Array.isArray(feedEntries) || feedEntries.length === 0) return 'off'

  if (
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
