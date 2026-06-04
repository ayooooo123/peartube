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
  if (source.creatorName) return source.creatorName
  if (source.label) return source.label
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

function normalizeText(value, maxLength = 5000) {
  return String(value || '').split('').map((char) => {
    const code = char.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : char
  }).join('').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function readYtDlpInfoFile(fs, infoFile) {
  if (!infoFile || typeof fs?.readFileSync !== 'function') return null
  try {
    if (typeof fs.existsSync === 'function' && !fs.existsSync(infoFile)) return null
    const parsed = JSON.parse(String(fs.readFileSync(infoFile, 'utf8') || '{}'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function creatorNameFromInfo(info) {
  return normalizeText(info?.channel || info?.uploader || info?.uploader_id || '', 160) || null
}

function titleFromInfo(info) {
  return normalizeText(info?.title || info?.fulltitle || '', 240) || null
}

function durationFromInfo(info) {
  const duration = Number(info?.duration)
  return Number.isFinite(duration) && duration > 0 ? duration : null
}

function sourceUrlFromInfo(info, fallback) {
  return normalizeText(info?.webpage_url || info?.original_url || info?.url || fallback || '', 1000) || null
}

function thumbnailUrlFromInfo(info) {
  return normalizeText(info?.thumbnail || '', 1000) || null
}

function thumbnailMimeTypeForPath(filePath) {
  const lower = String(filePath || '').toLowerCase()
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.png')) return 'image/png'
  return 'image/jpeg'
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

  const channelOptions = previewVideos.length > 0
    ? {
        channelName: channelEntry.channelName || null,
        previewVideos,
        videoCount: previewVideos.length,
        manifestUpdatedAt: Date.now()
      }
    : {
        channelName: channelEntry.channelName || null,
        videoCount: 0,
        manifestUpdatedAt: Date.now()
      }

  try {
    await runtime.publicFeed?.submitChannel?.(channelKey, publicBeeKey, channelOptions)
  } catch (err) {
    logger?.archive?.debug?.('Public-feed submit failed', {
      sourceId,
      error: err?.message || String(err)
    })
  }
  try {
    if (previewVideos.length > 0 && typeof runtime.cacheManager?.addChannel === 'function') {
      await runtime.cacheManager.addChannel(channelKey, publicBeeKey, 'private', {
        previewVideos,
        videoCount: previewVideos.length,
        manifestUpdatedAt: channelOptions.manifestUpdatedAt
      })
    } else {
      await runtime.cacheManager?.pinChannel?.(channelKey, publicBeeKey)
    }
  } catch (err) {
    logger?.archive?.debug?.('Cache archive channel failed', {
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
  try {
    if (previewVideos.length > 0 && typeof runtime.publishRelayCatalogEntry === 'function') {
      await runtime.publishRelayCatalogEntry({
        schema: 'peartube.relayCatalog',
        catalogVersion: 1,
        driveKey: channelKey,
        channelKey,
        publicBeeKey,
        source: 'archive-job',
        retentionClass: 'private',
        relayRole: 'cache',
        relayServing: true,
        lastDecisionReason: 'archive-completed',
        lastSeenAt: channelOptions.manifestUpdatedAt,
        mirroredAt: channelOptions.manifestUpdatedAt,
        previewVideos,
        videoCount: previewVideos.length,
        manifestUpdatedAt: channelOptions.manifestUpdatedAt
      })
    }
  } catch (err) {
    logger?.archive?.debug?.('Relay catalog publish failed', {
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
    const info = readYtDlpInfoFile(fs, files?.infoFile)
    const importedTitle = titleFromInfo(info) || ytEntry?.title || files?.videoFile?.split('/')?.pop() || 'Untitled'
    const importedCreatorName = creatorNameFromInfo(info) || ytEntry?.uploader || source?.creatorName || null
    const importedDuration = durationFromInfo(info) ?? (Number.isFinite(ytEntry?.duration) ? Number(ytEntry.duration) : 0)
    const importedSourceUrl = sourceUrlFromInfo(info, ytEntry?.webpageUrl || source?.url)
    const importedThumbnailUrl = thumbnailUrlFromInfo(info)
    const sourceForChannel = {
      ...source,
      creatorName: importedCreatorName
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
        title: importedTitle,
        description: importedSourceUrl
          ? `Source: ${importedSourceUrl}`
          : '',
        duration: importedDuration || 0,
        category: 'archive',
        sourceType: info ? 'yt-dlp' : 'archive',
        sourceUrl: importedSourceUrl,
        sourceVideoId: normalizeText(info?.id || ytEntry?.id || '', 160) || null,
        creatorName: importedCreatorName,
        thumbnailUrl: importedThumbnailUrl
      },
      fs
    )

    if (!result?.success) {
      throw new Error(result?.error || 'upload failed')
    }

    if (files.thumbnailFile) {
      try {
        const thumbBuffer = fs.readFileSync(files.thumbnailFile)
        const thumbnailMimeType = thumbnailMimeTypeForPath(files.thumbnailFile)
        const thumbnailResult = await uploadManager.setThumbnailFromBuffer(channel, result.videoId, thumbBuffer, thumbnailMimeType)
        if (thumbnailResult?.success) {
          result.metadata = {
            ...(result.metadata || {}),
            thumbnailBlobId: thumbnailResult.thumbnailBlobId || result.metadata?.thumbnailBlobId || null,
            thumbnailBlobsCoreKey: channel.blobsKeyHex || result.metadata?.thumbnailBlobsCoreKey || null,
            thumbnailMimeType
          }
        }
      } catch (err) {
        logger?.archive?.debug?.('Thumbnail attach failed', {
          videoId: result.videoId,
          error: err?.message || String(err)
        })
      }
    }

    const metadata = result.metadata || {}
    const previewVideo = {
      id: String(result.videoId),
      title: importedTitle,
      description: importedSourceUrl ? `Source: ${importedSourceUrl}` : '',
      path: metadata.path || `/videos/${result.videoId}.mp4`,
      uploadedAt: Number(metadata.uploadedAt || 0) || Date.now(),
      duration: Number(metadata.duration || importedDuration || 0) || 0,
      size: Number(metadata.size || fileSize || 0) || 0,
      mimeType: metadata.mimeType || 'video/mp4',
      availability: 'playable',
      blobId: metadata.blobId || null,
      blobsCoreKey: metadata.blobsCoreKey || null,
      thumbnailBlobId: metadata.thumbnailBlobId || null,
      thumbnailBlobsCoreKey: metadata.thumbnailBlobsCoreKey || null,
      thumbnailMimeType: metadata.thumbnailMimeType || null,
      thumbnailUrl: metadata.thumbnailUrl || importedThumbnailUrl || null,
      channelName: channelEntry.channelName || importedCreatorName || null
    }

    await announceArchiveChannel(runtime, channelEntry, logger, source.sourceId, { previewVideos: [previewVideo] })

    return {
      videoId: result.videoId,
      bytes: fileSize,
      channelKey: channelEntry.channelKey,
      publicBeeKey: channelEntry.publicBeeKey,
      title: importedTitle,
      channelName: channelEntry.channelName || importedCreatorName || null
    }
  }

  return {
    ensureSourceChannel,
    publishVideo
  }
}
