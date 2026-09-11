/**
 * Build the playback handoff payload for a channel catalog card.
 *
 * `thumbnailUrl` is nullable and optional: pass the freshly resolved artwork
 * URL when the loader has one. A `null`, `undefined`, or empty value never
 * overwrites the item's stored thumbnail; the item's own `thumbnailUrl`
 * survives the spread untouched.
 *
 * @param {Object} input
 * @param {Record<string, any>} input.item - video record from the channel catalog
 * @param {string} input.channelKey
 * @param {string} input.publicBeeKey - route-level bee key; falls back to the item's own
 * @param {string|null} [input.thumbnailUrl]
 * @param {string} input.channelName
 */
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
