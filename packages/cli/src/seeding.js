/* eslint-disable no-empty */
import b4a from 'b4a'

function isValidHexKey(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

function emptyStats() {
  return {
    channels: 0,
    videos: 0,
    publicBeeCores: 0,
    blobCores: 0,
    discoveryHandles: 0,
    blindPeer: null,
    lastSeededAt: null,
    lastError: null
  }
}

function cloneStats(stats) {
  return { ...stats }
}

function addCoreKey(set, value) {
  if (!isValidHexKey(value)) return false
  set.add(value.toLowerCase())
  return true
}

export function createRelaySeeder({ ctx, loadPublicBee, logger = {}, blindPeer = null }) {
  if (!ctx) throw new Error('ctx is required')
  if (typeof loadPublicBee !== 'function') throw new Error('loadPublicBee is required')

  const handles = new Map()
  const seededChannels = new Map()
  const logInfo = typeof logger.info === 'function' ? logger.info.bind(logger) : () => {}
  const logWarn = typeof logger.warn === 'function' ? logger.warn.bind(logger) : () => {}
  const logDebug = typeof logger.debug === 'function' ? logger.debug.bind(logger) : () => {}

  function retainDiscovery(discoveryKey, label) {
    if (!ctx.swarm || ctx.swarm.destroyed || !discoveryKey) return null
    const discoveryKeyHex = Buffer.isBuffer(discoveryKey) || b4a.isBuffer(discoveryKey)
      ? b4a.toString(discoveryKey, 'hex')
      : String(discoveryKey)
    if (handles.has(discoveryKeyHex)) return handles.get(discoveryKeyHex)

    try {
      const handle = ctx.swarm.join(discoveryKey, { server: true, client: true })
      handles.set(discoveryKeyHex, handle)
      try {
        const flushed = handle?.flushed?.()
        if (flushed && typeof flushed.then === 'function') {
          flushed
            .then(() => logDebug('[relay-seeder] discovery flushed', { label, discoveryKey: discoveryKeyHex.slice(0, 16) }))
            .catch((err) => logDebug('[relay-seeder] discovery flush failed', { label, error: err?.message || String(err) }))
        }
      } catch (err) {
        logDebug('[relay-seeder] discovery flush setup failed', { label, error: err?.message || String(err) })
      }
      return handle
    } catch (err) {
      logWarn('[relay-seeder] failed to join discovery', { label, error: err?.message || String(err) })
      return null
    }
  }

  async function resolveBlobCore(keyHex) {
    if (!isValidHexKey(keyHex) || !ctx.store || typeof ctx.store.get !== 'function') return null
    try {
      const core = ctx.store.get(b4a.from(keyHex, 'hex'))
      await core?.ready?.()
      return core || null
    } catch (err) {
      logDebug('[relay-seeder] failed to resolve blob core', { key: keyHex.slice(0, 16), error: err?.message || String(err) })
      return null
    }
  }

  async function seedChannel(channel) {
    const driveKey = channel?.driveKey || channel?.channelKey
    const publicBeeKey = channel?.publicBeeKey || null
    const stats = emptyStats()

    if (!driveKey || !publicBeeKey) return stats

    try {
      const bee = await loadPublicBee(ctx, publicBeeKey)
      if (bee?.core?.discoveryKey) {
        retainDiscovery(bee.core.discoveryKey, `publicBee:${String(publicBeeKey).slice(0, 16)}`)
        try { blindPeer?.addCore?.(bee.core, { announce: true, referrer: b4a.from(publicBeeKey, 'hex') }) } catch {}
        stats.publicBeeCores = 1
      }

      const videos = await bee?.listVideos?.().catch(() => [])
      const meta = await bee?.getMetadata?.().catch(() => null)
      const blobCoreKeys = new Set()
      const previewVideos = []
      if (Array.isArray(videos)) {
        stats.videos = videos.length
        for (const video of videos) {
          addCoreKey(blobCoreKeys, video?.blobsCoreKey)
          addCoreKey(blobCoreKeys, video?.thumbnailBlobsCoreKey)
          if (previewVideos.length < 3 && video?.id && video?.blobId && video?.blobsCoreKey) {
            previewVideos.push({
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
          }
        }
      }

      for (const keyHex of blobCoreKeys) {
        const core = await resolveBlobCore(keyHex)
        if (core?.discoveryKey) {
          retainDiscovery(core.discoveryKey, `blob:${keyHex.slice(0, 16)}`)
          try { blindPeer?.addCore?.(core, { announce: true, referrer: b4a.from(publicBeeKey, 'hex') }) } catch {}
          stats.blobCores += 1
        }
      }

      stats.channels = 1
      stats.discoveryHandles = handles.size
      stats.lastSeededAt = Date.now()
      seededChannels.set(driveKey, {
        driveKey,
        publicBeeKey,
        videos: stats.videos,
        publicBeeCores: stats.publicBeeCores,
        blobCores: stats.blobCores,
        lastSeededAt: stats.lastSeededAt,
        lastError: null
      })
      logInfo('[relay-seeder] channel seeded', {
        driveKey,
        videos: stats.videos,
        blobCores: stats.blobCores,
        discoveryHandles: handles.size
      })
      stats.catalogEntry = {
        schema: 'peartube.relayCatalog',
        catalogVersion: 1,
        driveKey,
        publicBeeKey,
        source: 'relay-cache',
        relayRole: 'cache',
        relayServing: true,
        channelName: meta?.name || channel?.channelName || null,
        videoCount: stats.videos,
        manifestUpdatedAt: Number(meta?.updatedAt || meta?.createdAt || 0) || Date.now(),
        previewVideos
      }
      return stats
    } catch (err) {
      stats.lastError = err?.message || String(err)
      seededChannels.set(driveKey, {
        driveKey,
        publicBeeKey,
        videos: 0,
        publicBeeCores: 0,
        blobCores: 0,
        lastSeededAt: null,
        lastError: stats.lastError
      })
      logWarn('[relay-seeder] channel seed failed', { driveKey, error: stats.lastError })
      return stats
    }
  }

  async function seedCachedChannels(cacheManager) {
    const channels = cacheManager?.getChannels?.() || []
    const seen = new Set()
    for (const channel of channels) {
      const driveKey = channel?.driveKey || channel?.channelKey
      if (!driveKey || seen.has(driveKey)) continue
      seen.add(driveKey)
      await seedChannel(channel)
    }
    return getStats()
  }

  function getStats() {
    const stats = emptyStats()
    stats.channels = seededChannels.size
    stats.discoveryHandles = handles.size
    const blindPeerStats = blindPeer?.getStats?.() || null
    if (blindPeerStats) stats.blindPeer = blindPeerStats
    for (const channel of seededChannels.values()) {
      stats.videos += Number(channel.videos || 0)
      stats.publicBeeCores += Number(channel.publicBeeCores || 0)
      stats.blobCores += Number(channel.blobCores || 0)
      if (channel.lastSeededAt && (!stats.lastSeededAt || channel.lastSeededAt > stats.lastSeededAt)) {
        stats.lastSeededAt = channel.lastSeededAt
      }
      if (channel.lastError) stats.lastError = channel.lastError
    }
    return cloneStats(stats)
  }

  async function close() {
    for (const handle of handles.values()) {
      try {
        await handle?.destroy?.()
      } catch (err) {
        logDebug('[relay-seeder] discovery handle destroy failed', { error: err?.message || String(err) })
      }
      try {
        await handle?.close?.()
      } catch (err) {
        logDebug('[relay-seeder] discovery handle close failed', { error: err?.message || String(err) })
      }
    }
    handles.clear()
    seededChannels.clear()
  }

  return {
    retainDiscovery,
    seedChannel,
    seedCachedChannels,
    getStats,
    close
  }
}
