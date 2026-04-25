import b4a from 'b4a'
import { loadPublicBee } from '@peartube/backend/storage'

const VIDEO_DOWNLOAD_TIMEOUT_MS = 60_000

function parseBlobId(blobId) {
  if (blobId && typeof blobId === 'object') {
    const value = blobId
    const blockOffset = Number(value.blockOffset)
    const blockLength = Number(value.blockLength)
    const byteOffset = Number(value.byteOffset)
    const byteLength = Number(value.byteLength)

    if (
      Number.isFinite(blockOffset) &&
      Number.isFinite(blockLength) &&
      Number.isFinite(byteOffset) &&
      Number.isFinite(byteLength)
    ) {
      return { blockOffset, blockLength, byteOffset, byteLength }
    }
    throw new Error('Invalid blobId object')
  }

  if (typeof blobId === 'string') {
    const parts = blobId.split(':').map(Number)
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      throw new Error('Invalid blobId string format')
    }

    return {
      blockOffset: parts[0],
      blockLength: parts[1],
      byteOffset: parts[2],
      byteLength: parts[3]
    }
  }

  throw new Error('Unsupported blobId type')
}

function timeoutPromise(timeoutMs) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Blob download timeout (${timeoutMs}ms)`)), timeoutMs)
  })
}

export async function downloadChannelBlobs(ctx, publicBeeKey, driveKey, logger = {}) {
  const logInfo = typeof logger.info === 'function' ? logger.info.bind(logger) : () => {}
  const logDebug = typeof logger.debug === 'function' ? logger.debug.bind(logger) : () => {}
  const logError = typeof logger.error === 'function' ? logger.error.bind(logger) : () => {}

  const stats = {
    videosFound: 0,
    videosDownloaded: 0,
    bytesDownloaded: 0
  }

  try {
    if (!ctx || ctx.store?.closed) {
      logError('[blob-downloader] Skipping channel download: invalid context or closed store', driveKey)
      return stats
    }

    if (!publicBeeKey || typeof publicBeeKey !== 'string') {
      logDebug('[blob-downloader] Skipping channel with missing publicBeeKey', driveKey)
      return stats
    }

    const bee = await loadPublicBee(ctx, publicBeeKey)
    const videos = await bee.listVideos().catch(() => [])

    if (!Array.isArray(videos) || videos.length === 0) {
      logDebug('[blob-downloader] No videos found for channel', driveKey)
      return stats
    }

    stats.videosFound = videos.length

    for (const video of videos) {
      if (!video || typeof video !== 'object') continue
      if (!video.blobsCoreKey || !video.blobId) continue

      try {
        const { blockOffset, blockLength } = parseBlobId(video.blobId)
        const blobsCoreKey = b4a.from(video.blobsCoreKey, 'hex')
        const blobsCore = ctx.store.get(blobsCoreKey)
        await blobsCore.ready()

        if (ctx.swarm && !ctx.swarm.destroyed && blobsCore.discoveryKey) {
          try {
            ctx.swarm.join(blobsCore.discoveryKey)
          } catch {}
        }

        const download = blobsCore.download({
          start: blockOffset,
          end: blockOffset + blockLength
        })

        await Promise.race([
          download.done(),
          timeoutPromise(VIDEO_DOWNLOAD_TIMEOUT_MS)
        ])

        const avgBytesPerBlock = blobsCore.length > 0 ? (blobsCore.byteLength / blobsCore.length) : 0
        stats.bytesDownloaded += Math.floor(blockLength * avgBytesPerBlock)
        stats.videosDownloaded += 1
      } catch (err) {
        logError(
          '[blob-downloader] Video blob download failed',
          driveKey,
          video.id || video.videoPath || video.path || '<unknown-video>',
          err?.message || err
        )
      }
    }

    logInfo(
      '[blob-downloader] Channel blob download complete',
      driveKey,
      `videos: ${stats.videosDownloaded}/${stats.videosFound}`,
      `bytes: ${stats.bytesDownloaded}`
    )

    return stats
  } catch (err) {
    logError('[blob-downloader] Channel blob download failed', driveKey, err?.message || err)
    return stats
  }
}

export async function downloadAllCachedChannels(ctx, cacheManager, logger = {}) {
  const logError = typeof logger.error === 'function' ? logger.error.bind(logger) : () => {}

  const totals = {
    videosFound: 0,
    videosDownloaded: 0,
    bytesDownloaded: 0
  }

  const channels = cacheManager?.getChannels?.()
  if (!Array.isArray(channels) || channels.length === 0) {
    return totals
  }

  for (const channel of channels) {
    if (!channel || typeof channel !== 'object') continue
    if (!channel.publicBeeKey) continue

    try {
      const stats = await downloadChannelBlobs(ctx, channel.publicBeeKey, channel.driveKey, logger)
      totals.videosFound += stats.videosFound
      totals.videosDownloaded += stats.videosDownloaded
      totals.bytesDownloaded += stats.bytesDownloaded

      if (channel.driveKey) {
        await cacheManager.updateChannelSize(channel.driveKey, stats.bytesDownloaded)
      }
    } catch (err) {
      logError('[blob-downloader] Cached channel download failed', channel.driveKey, err?.message || err)
    }
  }

  return totals
}

export { parseBlobId }
