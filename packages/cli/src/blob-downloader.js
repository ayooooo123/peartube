import b4a from 'b4a'
import { loadPublicBee } from '@peartube/backend/storage'
import { normalizeBlobRefInput } from '@peartube/backend/blob-ref'

const VIDEO_DOWNLOAD_TIMEOUT_MS = 60_000
const DOWNLOAD_PROGRESS_IDLE_MS = 10_000
const BLOB_DOWNLOAD_TIMEOUT = 'BLOB_DOWNLOAD_TIMEOUT'

function parseBlobId(blobId) {
  const normalized = normalizeBlobRefInput(blobId)
  if (!normalized) throw new Error('Invalid blobId format')
  return normalized
}

function timeoutPromise(timeoutMs) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`Blob download timeout (${timeoutMs}ms)`)
      err.code = BLOB_DOWNLOAD_TIMEOUT
      reject(err)
    }, timeoutMs)
    timer?.unref?.()
  })
}

function isBlobDownloadTimeout(err) {
  return err?.code === BLOB_DOWNLOAD_TIMEOUT || /^Blob download (?:idle )?timeout \(.*\)$/.test(err?.message || '')
}


function createIdleProgressGuard({ timeoutMs, onTimeout }) {
  let timer = null
  let settled = false
  let rejectGuard = null

  const promise = new Promise((_, reject) => {
    rejectGuard = reject
  })

  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const bump = () => {
    if (settled) return
    clear()
    timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { onTimeout?.() } catch {
        // Best effort cleanup only.
      }
      const err = new Error(`Blob download idle timeout (${timeoutMs}ms without progress)`)
      err.code = BLOB_DOWNLOAD_TIMEOUT
      rejectGuard(err)
    }, timeoutMs)
    timer?.unref?.()
  }

  const stop = () => {
    settled = true
    clear()
  }

  bump()
  return { promise, bump, stop }
}

function isDiscoveryMirror(options) {
  return options?.source === 'discovered' || options?.source === 'relay-cache'
}

function getVideoKey(video) {
  return String(video?.id || video?.path || video?.videoId || video?.blobId || '')
}

function addDownloadRef(refs, video, { coreKeyField = 'blobsCoreKey', blobIdField = 'blobId', kind = 'video' } = {}) {
  const coreKey = video?.[coreKeyField]
  const blobId = video?.[blobIdField]
  if (!coreKey || !blobId) return false
  const key = `${String(coreKey).toLowerCase()}:${String(blobId)}`
  if (refs.has(key)) return false
  refs.set(key, {
    kind,
    videoId: getVideoKey(video) || '<unknown-video>',
    coreKey: String(coreKey),
    blobId,
    sourceVideo: video
  })
  return true
}

function addVideoDownloadRefs(refs, videos) {
  if (!Array.isArray(videos)) return 0
  let added = 0
  for (const video of videos) {
    if (!video || typeof video !== 'object') continue
    if (addDownloadRef(refs, video, { kind: 'video' })) added += 1
    if (addDownloadRef(refs, video, {
      coreKeyField: 'thumbnailBlobsCoreKey',
      blobIdField: 'thumbnailBlobId',
      kind: 'thumbnail'
    })) added += 1
  }
  return added
}

function addSuccessfulPreviewVideo(previews, ref) {
  if (ref?.kind !== 'video') return false
  return addPreviewVideo(previews, ref.sourceVideo)
}

function addUnavailableVideo(unavailableVideos, ref, err) {
  if (ref?.kind !== 'video') return false
  const video = ref.sourceVideo
  if (!video?.id || !video?.blobId || !video?.blobsCoreKey) return false
  const id = getVideoKey(video)
  if (unavailableVideos.some((existing) => getVideoKey(existing) === id)) return false
  unavailableVideos.push({
    id: String(video.id),
    title: video?.title ? String(video.title) : 'Untitled',
    uploadedAt: Number(video?.uploadedAt || 0) || 0,
    duration: Number(video?.duration || 0) || 0,
    thumbnail: video?.thumbnail || null,
    blobId: String(video.blobId),
    blobsCoreKey: String(video.blobsCoreKey),
    mimeType: video?.mimeType || 'video/mp4',
    availability: 'unavailable',
    byteAvailability: 'unavailable',
    unavailableReason: err?.message || (err ? String(err) : 'Blob unavailable'),
    thumbnailBlobId: video?.thumbnailBlobId || null,
    thumbnailBlobsCoreKey: video?.thumbnailBlobsCoreKey || null,
    thumbnailMimeType: video?.thumbnailMimeType || null
  })
  return true
}

function addPreviewVideo(previews, video) {
  if (!video?.id || !video?.blobId || !video?.blobsCoreKey) return false
  const id = getVideoKey(video)
  if (previews.some((existing) => getVideoKey(existing) === id)) return false
  previews.push({
    id: String(video.id),
    title: video?.title ? String(video.title) : 'Untitled',
    uploadedAt: Number(video?.uploadedAt || 0) || 0,
    duration: Number(video?.duration || 0) || 0,
    thumbnail: video?.thumbnail || null,
    blobId: String(video.blobId),
    blobsCoreKey: String(video.blobsCoreKey),
    mimeType: video?.mimeType || 'video/mp4',
    availability: 'playable',
    thumbnailBlobId: video?.thumbnailBlobId || null,
    thumbnailBlobsCoreKey: video?.thumbnailBlobsCoreKey || null,
    thumbnailMimeType: video?.thumbnailMimeType || null
  })
  return true
}

async function downloadBlobRef(ctx, ref) {
  const { blockOffset, blockLength } = parseBlobId(ref.blobId)
  const blobsCoreKey = b4a.from(ref.coreKey, 'hex')
  const blobsCore = ctx.store.get(blobsCoreKey)
  await blobsCore.ready()

  let discoveryHandle = null
  if (ctx.swarm && !ctx.swarm.destroyed && blobsCore.discoveryKey) {
    try {
      discoveryHandle = ctx.swarm.join(blobsCore.discoveryKey, { server: true, client: true })
    } catch {
      // Discovery joins are opportunistic for relay prefetching.
    }
  }

  const download = blobsCore.download({
    start: blockOffset,
    end: blockOffset + blockLength
  })

  const idleGuard = createIdleProgressGuard({
    timeoutMs: DOWNLOAD_PROGRESS_IDLE_MS,
    onTimeout: () => {
      try { download.destroy?.() } catch {
      // Best effort cleanup only.
    }
    }
  })
  const onDownload = () => idleGuard.bump()
  const onAppend = () => idleGuard.bump()
  blobsCore.on?.('download', onDownload)
  blobsCore.on?.('append', onAppend)

  try {
    await Promise.race([
      download.done(),
      timeoutPromise(VIDEO_DOWNLOAD_TIMEOUT_MS),
      idleGuard.promise
    ])
  } catch (err) {
    try { download.destroy?.() } catch {
      // Best effort cleanup only.
    }
    throw err
  } finally {
    idleGuard.stop()
    blobsCore.off?.('download', onDownload)
    blobsCore.off?.('append', onAppend)
    try { await discoveryHandle?.destroy?.() } catch {
      // Best effort cleanup only.
    }
    try { await discoveryHandle?.close?.() } catch {
      // Best effort cleanup only.
    }
  }

  if (Number.isFinite(ref.blobId?.byteLength)) return Number(ref.blobId.byteLength)

  const avgBytesPerBlock = blobsCore.length > 0 ? (blobsCore.byteLength / blobsCore.length) : 0
  return Math.floor(blockLength * avgBytesPerBlock)
}

export async function downloadChannelBlobs(ctx, publicBeeKey, driveKey, logger = {}, options = {}, dependencies = {}) {
  const loadBee = dependencies.loadPublicBee || loadPublicBee
  const logInfo = typeof logger.info === 'function' ? logger.info.bind(logger) : () => {}
  const logDebug = typeof logger.debug === 'function' ? logger.debug.bind(logger) : () => {}
  const logError = typeof logger.error === 'function' ? logger.error.bind(logger) : () => {}

  const stats = {
    videosFound: 0,
    videosDownloaded: 0,
    blobsFound: 0,
    blobsDownloaded: 0,
    blobsFailed: 0,
    thumbnailsDownloaded: 0,
    bytesDownloaded: 0,
    previewVideos: [],
    unavailableVideos: [],
    videoCount: 0,
    lastError: null
  }

  try {
    if (!ctx || ctx.store?.closed) {
      logError('[blob-downloader] Skipping channel download: invalid context or closed store', { driveKey })
      return stats
    }

    if (!publicBeeKey || typeof publicBeeKey !== 'string') {
      logDebug('[blob-downloader] Skipping channel with missing publicBeeKey', { driveKey })
      return stats
    }

    const bee = await loadBee(ctx, publicBeeKey)
    const videos = await bee.listVideos().catch(() => [])
    const refs = new Map()

    addVideoDownloadRefs(refs, options.previewVideos)
    addVideoDownloadRefs(refs, options.videos)
    addVideoDownloadRefs(refs, options.catalogEntry?.previewVideos)
    addVideoDownloadRefs(refs, options.feedEntry?.previewVideos)

    if (Array.isArray(videos)) {
      stats.videosFound = videos.length
      stats.videoCount = Math.max(stats.videoCount, videos.length)
      addVideoDownloadRefs(refs, videos)
    }

    if (refs.size === 0) {
      logDebug('[blob-downloader] No blob refs found for channel', { driveKey })
      return stats
    }

    stats.blobsFound = refs.size

    for (const ref of refs.values()) {
      try {
        stats.bytesDownloaded += await downloadBlobRef(ctx, ref)
        stats.blobsDownloaded += 1
        if (ref.kind === 'video') {
          stats.videosDownloaded += 1
          addSuccessfulPreviewVideo(stats.previewVideos, ref)
        }
        if (ref.kind === 'thumbnail') stats.thumbnailsDownloaded += 1
      } catch (err) {
        stats.blobsFailed += 1
        stats.lastError = err?.message || String(err)
        if (ref.kind === 'video') addUnavailableVideo(stats.unavailableVideos, ref, err)
        const logUnavailable = isDiscoveryMirror(options) && isBlobDownloadTimeout(err)
        const logFailure = logUnavailable && typeof logger.warn === 'function'
          ? logger.warn.bind(logger)
          : logError
        logFailure(logUnavailable ? '[blob-downloader] Blob download unavailable' : '[blob-downloader] Blob download failed', {
          driveKey,
          videoId: ref.videoId || ref.sourceVideo?.id || '<unknown-video>',
          kind: ref.kind,
          error: stats.lastError
        })
      }
    }

    stats.videoCount = Math.max(stats.videoCount, stats.previewVideos.length, stats.unavailableVideos.length, stats.videosDownloaded)

    logInfo('[blob-downloader] Channel blob download complete', {
      driveKey,
      videosDownloaded: stats.videosDownloaded,
      videosTotal: stats.videosFound || stats.videoCount,
      blobsDownloaded: stats.blobsDownloaded,
      blobsFound: stats.blobsFound,
      bytesDownloaded: stats.bytesDownloaded
    })

    return stats
  } catch (err) {
    logError('[blob-downloader] Channel blob download failed', {
      driveKey,
      error: err?.message || String(err)
    })
    return stats
  }
}

export async function downloadAllCachedChannels(ctx, cacheManager, logger = {}) {
  const logError = typeof logger.error === 'function' ? logger.error.bind(logger) : () => {}

  const totals = {
    videosFound: 0,
    videosDownloaded: 0,
    blobsFound: 0,
    blobsDownloaded: 0,
    thumbnailsDownloaded: 0,
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
      const stats = await downloadChannelBlobs(ctx, channel.publicBeeKey, channel.driveKey, logger, channel)
      totals.videosFound += stats.videosFound
      totals.videosDownloaded += stats.videosDownloaded
      totals.blobsFound += stats.blobsFound || 0
      totals.blobsDownloaded += stats.blobsDownloaded || 0
      totals.thumbnailsDownloaded += stats.thumbnailsDownloaded || 0
      totals.bytesDownloaded += stats.bytesDownloaded

      if (channel.driveKey) {
        await cacheManager.updateChannelSize(channel.driveKey, stats.bytesDownloaded)
      }
    } catch (err) {
      logError('[blob-downloader] Cached channel download failed', {
        driveKey: channel.driveKey,
        error: err?.message || String(err)
      })
    }
  }

  return totals
}

export { parseBlobId, addVideoDownloadRefs }
