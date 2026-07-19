export function createChannelPlaybackPayload({
  item,
  channelKey,
  publicBeeKey,
  thumbnailUrl = null,
  channelName,
}) {
  return {
    ...item,
    publicBeeKey: publicBeeKey || item?.publicBeeKey || undefined,
    channelKey,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    channel: { name: channelName },
  }
}

export function stageWebChannelPlayback(target, payload) {
  if (!target || !payload) return payload
  target.__peartubePendingWatchVideo = payload
  if (typeof target.dispatchEvent === 'function') {
    const detail = { video: payload }
    const event = typeof CustomEvent === 'function'
      ? new CustomEvent('peartube:watch-video', { detail })
      : { type: 'peartube:watch-video', detail }
    target.dispatchEvent(event)
  }
  return payload
}

export function consumeStagedWebChannelPlayback(target, channelKey, videoId, ...legacyCollections) {
  const pending = target?.__peartubePendingWatchVideo
  const pendingChannelKey = pending?.channelKey || pending?.driveKey
  if (pending?.id === videoId && pendingChannelKey === channelKey) {
    delete target.__peartubePendingWatchVideo
    return pending
  }

  for (const collection of legacyCollections) {
    if (!Array.isArray(collection)) continue
    const found = collection.find((video) => (
      video?.id === videoId &&
      (video.channelKey === channelKey || video.driveKey === channelKey || (!video.channelKey && !video.driveKey))
    ))
    if (found) return { ...found, channelKey }
  }
  return null
}
