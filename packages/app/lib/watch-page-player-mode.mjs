export function getWatchPageKey(channelKey, videoId) {
  return `${channelKey}::${videoId}`
}

export function shouldUseMsePlayerForWatch(activeWatchKey, currentWatchKey) {
  return activeWatchKey === currentWatchKey
}
