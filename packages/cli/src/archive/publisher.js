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
  if (source.kind === 'handle') return source.identifier
  if (source.kind === 'channel') return `YouTube channel ${source.identifier.slice(0, 12)}`
  if (source.kind === 'playlist') return `YouTube playlist ${source.identifier.slice(0, 12)}`
  return `YouTube ${source.identifier}`
}

function defaultChannelDescription(source) {
  return `Auto-archived from ${source.url} by a PearTube relay.${buildSourceMarker(source)}`
}

/**
 * Loads the per-source PearTube channel for this relay (creating it on first use).
 * The channel keypair is deterministic from the relay's persistent corestore primaryKey
 * and the source identifier, so restarting the relay reopens the same channel.
 */
export function createArchivePublisher({ ctx, uploadManager, runtime, fs, logger, state = null }) {
  if (!ctx) throw new Error('ctx is required')
  if (!uploadManager) throw new Error('uploadManager is required')
  if (!runtime) throw new Error('runtime is required')
  if (!fs) throw new Error('fs is required')

  const channelCache = new Map()

  async function ensureSourceChannel(source) {
    if (channelCache.has(source.sourceId)) return channelCache.get(source.sourceId)

    const writerKeyName = buildWriterKeyName(source.sourceId)
    const { createChannel } = await import('@peartube/backend/storage')

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

      publicBeeKey = channel.publicBeeKey
        ? (b4a.isBuffer(channel.publicBeeKey) ? b4a.toString(channel.publicBeeKey, 'hex') : String(channel.publicBeeKey))
        : null
      if (!publicBeeKey) {
        const refreshed = await channel.getMetadata().catch(() => null)
        publicBeeKey = refreshed?.publicBeeKey || null
      }
    } catch (err) {
      logger?.archive?.warn?.('Channel metadata setup failed', {
        sourceId: source.sourceId,
        error: err?.message || String(err)
      })
    }

    if (publicBeeKey) {
      try {
        await runtime.publicFeed?.submitChannel?.(channelKey, publicBeeKey)
      } catch (err) {
        logger?.archive?.debug?.('Public-feed submit failed', {
          sourceId: source.sourceId,
          error: err?.message || String(err)
        })
      }
      try {
        await runtime.cacheManager?.pinChannel?.(channelKey, publicBeeKey)
      } catch (err) {
        logger?.archive?.debug?.('Pin channel failed', {
          sourceId: source.sourceId,
          error: err?.message || String(err)
        })
      }
      try {
        await runtime.seeder?.seedChannel?.({ driveKey: channelKey, publicBeeKey })
      } catch (err) {
        logger?.archive?.debug?.('Seed channel failed', {
          sourceId: source.sourceId,
          error: err?.message || String(err)
        })
      }
    }

    if (state && typeof state.putSource === 'function') {
      try {
        const existing = await state.getSource(source.sourceId)
        await state.putSource(source.sourceId, {
          ...(existing || {}),
          url: source.url,
          type: source.type,
          label: source.label || null,
          channelKey,
          publicBeeKey: publicBeeKey || existing?.publicBeeKey || null
        })
      } catch (err) {
        logger?.archive?.debug?.('Persist source channel keys failed', {
          sourceId: source.sourceId,
          error: err?.message || String(err)
        })
      }
    }

    const entry = { channel, channelKey, publicBeeKey }
    channelCache.set(source.sourceId, entry)
    return entry
  }

  async function publishVideo({ source, ytEntry, files }) {
    const channelEntry = await ensureSourceChannel(source)
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
