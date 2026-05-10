import b4a from 'b4a'
import { buildWriterKeyName } from './source-id.js'

const ARCHIVE_DESCRIPTION_MARKER_PREFIX = '\n\n[peartube-archive-source]'

function buildSourceMarker(source) {
  return [
    ARCHIVE_DESCRIPTION_MARKER_PREFIX,
    `type=${source.type}`,
    `id=${source.identifier}`,
    `url=${source.url}`
  ].join('\n')
}

function defaultChannelName(source) {
  if (source.label) return source.label
  if (source.creatorName) return source.creatorName
  if (source.channelName) return source.channelName
  if (source.uploader) return source.uploader
  if (source.kind === 'handle') return source.identifier
  if (source.kind === 'channel') return `YouTube channel ${source.identifier.slice(0, 12)}`
  if (source.kind === 'playlist') return `YouTube playlist ${source.identifier.slice(0, 12)}`
  return `YouTube ${source.identifier}`
}

function defaultChannelDescription(source) {
  return `Auto-archived from ${source.url} by a PearTube relay.${buildSourceMarker(source)}`
}

async function resolvePublicBeeKey(channel) {
  let publicBeeKey = channel?.publicBeeKey
    ? (b4a.isBuffer(channel.publicBeeKey) ? b4a.toString(channel.publicBeeKey, 'hex') : String(channel.publicBeeKey))
    : null

  if (!publicBeeKey && typeof channel?.getPublicBeeKey === 'function') {
    const resolved = await channel.getPublicBeeKey().catch(() => null)
    if (resolved) publicBeeKey = b4a.isBuffer(resolved) ? b4a.toString(resolved, 'hex') : String(resolved)
  }

  if (!publicBeeKey) {
    const meta = await channel?.getMetadata?.().catch(() => null)
    if (meta?.publicBeeKey) publicBeeKey = String(meta.publicBeeKey)
  }

  return typeof publicBeeKey === 'string' && publicBeeKey.length > 0 ? publicBeeKey : null
}

async function listChannelPreviewVideos(channelEntry, limit = 3) {
  const channel = channelEntry?.channel || channelEntry
  if (!channel || typeof channel.listVideos !== 'function') return []
  const videos = await channel.listVideos().catch(() => [])
  const channelMeta = await channel.getMetadata?.().catch(() => null)
  const channelName = channelEntry?.channelName || channelMeta?.name || null
  if (!Array.isArray(videos)) return []
  return videos
    .filter((video) => video?.id && video?.blobId && video?.blobsCoreKey)
    .slice(0, limit)
    .map((video) => ({
      id: String(video.id),
      title: video?.title ? String(video.title) : 'Untitled',
      description: video?.description || '',
      path: video?.path || `/videos/${video.id}.mp4`,
      uploadedAt: Number(video?.uploadedAt || 0) || 0,
      duration: Number(video?.duration || 0) || 0,
      size: Number(video?.size || 0) || 0,
      mimeType: video?.mimeType || 'video/mp4',
      availability: 'playable',
      blobId: String(video.blobId),
      blobsCoreKey: String(video.blobsCoreKey),
      thumbnailBlobId: video?.thumbnailBlobId || null,
      thumbnailBlobsCoreKey: video?.thumbnailBlobsCoreKey || null,
      thumbnailMimeType: video?.thumbnailMimeType || null,
      channelName
    }))
}

async function announceArchiveChannel(runtime, channelEntry, logger, sourceId, options = {}) {
  const { channel, channelKey } = channelEntry || {}
  if (!channel || !channelKey) return

  const publicBeeKey = await resolvePublicBeeKey(channel)
  channelEntry.publicBeeKey = publicBeeKey

  if (!publicBeeKey) return

  const previewVideos = Array.isArray(options.previewVideos)
    ? options.previewVideos.filter(Boolean).map((video) => ({
        ...video,
        channelName: video?.channelName || channelEntry.channelName || null,
      }))
    : await listChannelPreviewVideos(channelEntry)

  try {
    if (previewVideos.length > 0) {
      await runtime.publicFeed?.submitChannel?.(channelKey, publicBeeKey, {
        channelName: channelEntry.channelName || null,
        previewVideos,
      })
    } else {
      await runtime.publicFeed?.submitChannel?.(channelKey, publicBeeKey, {
        channelName: channelEntry.channelName || null,
      })
    }
  } catch (err) {
    logger?.archive?.debug?.('Public-feed submit failed', {
      sourceId,
      error: err?.message || String(err)
    })
  }
  try {
    await runtime.cacheManager?.pinChannel?.(channelKey, publicBeeKey)
  } catch (err) {
    logger?.archive?.debug?.('Pin channel failed', {
      sourceId,
      error: err?.message || String(err)
    })
  }
  try {
    const seedEntry = previewVideos.length > 0
      ? { driveKey: channelKey, publicBeeKey, previewVideos }
      : { driveKey: channelKey, publicBeeKey }
    await runtime.seeder?.seedChannel?.(seedEntry)
  } catch (err) {
    logger?.archive?.debug?.('Seed channel failed', {
      sourceId,
      error: err?.message || String(err)
    })
  }
}

/**
 * Loads the per-source PearTube channel for this relay (creating it on first use).
 * The channel keypair is deterministic from the relay's persistent corestore primaryKey
 * and the source identifier, so restarting the relay reopens the same channel.
 */
export { resolvePublicBeeKey, announceArchiveChannel }

export function createArchivePublisher({ ctx, uploadManager, runtime, fs, logger, state = null, createChannelFn = null }) {
  if (!ctx) throw new Error('ctx is required')
  if (!uploadManager) throw new Error('uploadManager is required')
  if (!runtime) throw new Error('runtime is required')
  if (!fs) throw new Error('fs is required')

  const channelCache = new Map()

  async function ensureSourceChannel(source) {
    if (channelCache.has(source.sourceId)) return channelCache.get(source.sourceId)

    const writerKeyName = buildWriterKeyName(source.sourceId)
    const createChannel = createChannelFn || (await import('@peartube/backend/storage')).createChannel

    const created = await createChannel(ctx, {
      encrypt: false,
      writerKeyName
    })

    const channel = created.channel
    const channelKey = created.channelKeyHex

    if (!channel.writable) {
      throw new Error(`archive channel for source ${source.sourceId} is not writable`)
    }

    let publicBeeKey = null
    try {
      const meta = await channel.getMetadata().catch(() => null)
      const isFresh = !meta || (typeof meta === 'object' && Object.keys(meta).length === 0)
      if (isFresh) {
        await channel.updateMetadata({
          name: defaultChannelName(source),
          description: defaultChannelDescription(source),
          avatar: null,
          createdAt: Date.now(),
          createdBy: source.sourceId
        })
        await channel.ensureLocalBlobDrive({ deviceName: 'archive' }).catch(() => {})
      }

      publicBeeKey = await resolvePublicBeeKey(channel)
    } catch (err) {
      logger?.archive?.warn?.('Channel metadata setup failed', {
        sourceId: source.sourceId,
        error: err?.message || String(err)
      })
    }

    const entry = {
      channel,
      channelKey,
      publicBeeKey,
      channelName: defaultChannelName(source)
    }

    await announceArchiveChannel(runtime, entry, logger, source.sourceId)

    if (state && typeof state.putSource === 'function') {
      try {
        const existing = await state.getSource(source.sourceId)
        await state.putSource(source.sourceId, {
          ...(existing || {}),
          url: source.url,
          type: source.type,
          label: source.label || null,
          channelKey,
          publicBeeKey: entry.publicBeeKey || existing?.publicBeeKey || null
        })
      } catch (err) {
        logger?.archive?.debug?.('Persist source channel keys failed', {
          sourceId: source.sourceId,
          error: err?.message || String(err)
        })
      }
    }

    channelCache.set(source.sourceId, entry)
    return entry
  }

  async function publishVideo({ source, ytEntry, files }) {
    const sourceForChannel = {
      ...source,
      creatorName: ytEntry?.uploader || source?.creatorName || null
    }
    const channelEntry = await ensureSourceChannel(sourceForChannel)
    const { channel } = channelEntry

    if (!files?.videoFile) {
      throw new Error('videoFile required to publish')
    }

    const stat = fs.statSync(files.videoFile)
    const fileSize = Number.isFinite(stat?.size) ? Number(stat.size) : 0

    const result = await uploadManager.uploadFromPath(
      channel,
      files.videoFile,
      {
        title: ytEntry.title || files.videoFile.split('/').pop() || 'Untitled',
        description: ytEntry.webpageUrl
          ? `Source: ${ytEntry.webpageUrl}`
          : '',
        duration: Number.isFinite(ytEntry.duration) ? Number(ytEntry.duration) : 0,
        category: 'archive'
      },
      fs
    )

    if (!result?.success) {
      throw new Error(result?.error || 'upload failed')
    }

    if (files.thumbnailFile) {
      try {
        const thumbBuffer = fs.readFileSync(files.thumbnailFile)
        await uploadManager.setThumbnailFromBuffer(channel, result.videoId, thumbBuffer, 'image/jpeg')
      } catch (err) {
        logger?.archive?.debug?.('Thumbnail attach failed', {
          videoId: result.videoId,
          error: err?.message || String(err)
        })
      }
    }

    await announceArchiveChannel(runtime, channelEntry, logger, source.sourceId)

    return {
      videoId: result.videoId,
      bytes: fileSize,
      channelKey: channelEntry.channelKey,
      publicBeeKey: channelEntry.publicBeeKey
    }
  }

  return {
    ensureSourceChannel,
    publishVideo
  }
}
