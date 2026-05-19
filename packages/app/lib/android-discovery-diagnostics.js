export function getAndroidDiscoveryPermissionRequests({ platformOS, platformVersion, permissions = {} } = {}) {
  if (platformOS !== 'android') return []
  const requests = []
  if (Number(platformVersion || 0) >= 33) {
    if (permissions.POST_NOTIFICATIONS) requests.push(permissions.POST_NOTIFICATIONS)
    if (permissions.NEARBY_WIFI_DEVICES) requests.push(permissions.NEARBY_WIFI_DEVICES)
  }
  return requests
}

export function classifyFeedDiscoveryState({
  ready = false,
  entries = [],
  videos = [],
  peerCount = 0,
  swarmStatus = null,
  permissionStatus = null,
  hasCachedSnapshot = false,
} = {}) {
  if (!ready) return { state: 'backend-starting', recoverable: true }
  if (permissionStatus?.nearbyWifi === 'denied' || permissionStatus?.nearbyWifi === 'never_ask_again') {
    return { state: 'permission-degraded', recoverable: true, reason: 'nearby-wifi-denied' }
  }
  if (Array.isArray(videos) && videos.length > 0) {
    return { state: 'content-ready', recoverable: false }
  }
  if (Array.isArray(entries) && entries.length > 0) {
    if (
      Number(peerCount || 0) > 0 ||
      Number(swarmStatus?.peers || 0) > 0 ||
      Number(swarmStatus?.swarmConnections || 0) > 0 ||
      Number(swarmStatus?.feedConnections || 0) > 0 ||
      Number(swarmStatus?.feedEntries || 0) > 0 ||
      Number(swarmStatus?.channels || 0) > 0
    ) {
      return { state: 'hydrating', recoverable: true }
    }
    return hasCachedSnapshot
      ? { state: 'cached-fallback', recoverable: true, reason: 'zero-peers-with-entries' }
      : { state: 'discovery-waiting', recoverable: true, reason: 'zero-peers-with-entries' }
  }
  const boundary = swarmStatus?.doctor?.recommendedBoundary || null
  if (boundary && boundary !== 'content-playback-or-ui') {
    return { state: 'network-degraded', recoverable: true, reason: boundary }
  }
  if (hasCachedSnapshot) return { state: 'cached-fallback', recoverable: true, reason: 'zero-peers-no-entries' }
  return { state: 'discovery-waiting', recoverable: true, reason: 'zero-peers-no-entries' }
}
