const discoverFeedCache = {
  feedEntries: [],
  feedVideos: [],
  channelMeta: {},
  peerCount: 0,
  lastFeedRefresh: null,
  swarmStatus: null,
}

function cloneArray(value) {
  return Array.isArray(value) ? value.map((item) => ({ ...item })) : []
}

function cloneObject(value) {
  return value && typeof value === 'object' ? { ...value } : {}
}

function cloneSwarmStatus(value) {
  return value && typeof value === 'object' ? { ...value } : null
}

export function createInitialDiscoverFeedCacheState() {
  return {
    feedEntries: cloneArray(discoverFeedCache.feedEntries),
    feedVideos: cloneArray(discoverFeedCache.feedVideos),
    channelMeta: cloneObject(discoverFeedCache.channelMeta),
    peerCount: Number(discoverFeedCache.peerCount || 0) || 0,
    lastFeedRefresh: discoverFeedCache.lastFeedRefresh ?? null,
    swarmStatus: cloneSwarmStatus(discoverFeedCache.swarmStatus),
  }
}

export function snapshotDiscoverFeedCache(nextState = {}) {
  if ('feedEntries' in nextState) {
    discoverFeedCache.feedEntries = cloneArray(nextState.feedEntries)
  }
  if ('feedVideos' in nextState) {
    discoverFeedCache.feedVideos = cloneArray(nextState.feedVideos)
  }
  if ('channelMeta' in nextState) {
    discoverFeedCache.channelMeta = cloneObject(nextState.channelMeta)
  }
  if ('peerCount' in nextState) {
    discoverFeedCache.peerCount = Number(nextState.peerCount || 0) || 0
  }
  if ('lastFeedRefresh' in nextState) {
    discoverFeedCache.lastFeedRefresh = nextState.lastFeedRefresh ?? null
  }
  if ('swarmStatus' in nextState) {
    discoverFeedCache.swarmStatus = cloneSwarmStatus(nextState.swarmStatus)
  }

  return createInitialDiscoverFeedCacheState()
}

export function resetDiscoverFeedCache() {
  discoverFeedCache.feedEntries = []
  discoverFeedCache.feedVideos = []
  discoverFeedCache.channelMeta = {}
  discoverFeedCache.peerCount = 0
  discoverFeedCache.lastFeedRefresh = null
  discoverFeedCache.swarmStatus = null
}
