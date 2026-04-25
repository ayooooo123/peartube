function emptyStats() {
  return {
    videosFound: 0,
    videosDownloaded: 0,
    bytesDownloaded: 0
  }
}

function getEngineAdapter(ctx) {
  return ctx?.engineAdapter || ctx?.api?.engineAdapter || null
}

export async function downloadChannelBlobs(ctx, _publicBeeKey, driveKey, logger = {}) {
  const logDebug = typeof logger.debug === 'function' ? logger.debug.bind(logger) : () => {}
  const logError = typeof logger.error === 'function' ? logger.error.bind(logger) : () => {}
  const stats = emptyStats()

  if (!ctx || ctx.store?.closed) {
    logError('[blob-downloader] Skipping engine channel download: invalid context or closed store', driveKey)
    return stats
  }

  if (!driveKey || typeof driveKey !== 'string') {
    logDebug('[blob-downloader] Skipping engine channel download: missing driveKey')
    return stats
  }

  try {
    const adapter = getEngineAdapter(ctx)
    const videos = adapter?.listVideosForUiChannel
      ? await adapter.listVideosForUiChannel(driveKey).catch(() => [])
      : []

    stats.videosFound = Array.isArray(videos) ? videos.length : 0
    // Engine/Hyperdrive replication is range/playback driven now. There is no
    // PublicBee -> Hyperblobs prefetch pass left to perform from the CLI.
    logDebug('[blob-downloader] Engine channel prefetch is a no-op', driveKey)
    return stats
  } catch (err) {
    logError('[blob-downloader] Engine channel prefetch failed', driveKey, err?.message || err)
    return stats
  }
}

export async function downloadAllCachedChannels(ctx, cacheManager, logger = {}) {
  const totals = emptyStats()
  const channels = cacheManager?.getChannels?.()
  if (!Array.isArray(channels) || channels.length === 0) return totals

  for (const channel of channels) {
    if (!channel || typeof channel !== 'object') continue
    const driveKey = channel.driveKey || channel.channelKey
    if (!driveKey) continue

    const stats = await downloadChannelBlobs(ctx, channel.publicBeeKey || null, driveKey, logger)
    totals.videosFound += stats.videosFound
    totals.videosDownloaded += stats.videosDownloaded
    totals.bytesDownloaded += stats.bytesDownloaded
    await cacheManager.updateChannelSize?.(driveKey, stats.bytesDownloaded)
  }

  return totals
}

export function parseBlobId() {
  throw new Error('Legacy Hyperblobs blob IDs were removed; use @peartube/engine playback URLs')
}
