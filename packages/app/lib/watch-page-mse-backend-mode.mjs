export function getWatchPageKey(channelKey, videoId) {
  return `${channelKey}::${videoId}`
}

export function shouldUseMseBackendForWatch(activeWatchKey, currentWatchKey) {
  return activeWatchKey === currentWatchKey
}
