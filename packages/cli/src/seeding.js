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
    blobAvailability: {
      playable: 0,
      available: 0,
      unavailable: 0,
      missing: 0,
      unknown: 0,
      videos: []
    },
    lastSeededAt: null,
    lastError: null
  }
}

function cloneStats(stats) {
  return { ...stats }
}

function addCoreKey(set, value, kind = 'blob') {
  if (!isValidHexKey(value)) return false
  const key = value.toLowerCase()
  if (!set.has(key)) set.set(key, kind)
  return true
}

function addPreviewCoreKeys(set, previews) {
  if (!Array.isArray(previews)) return 0
  let added = 0
  for (const video of previews) {
    if (addCoreKey(set, video?.blobsCoreKey, 'blob')) added += 1
    if (addCoreKey(set, video?.thumbnailBlobsCoreKey, 'thumbnail')) added += 1
  }
  return added
}

function getVideoKey(video) {
  return String(video?.id || video?.path || video?.videoId || video?.blobId || '')
}

function mergeBlobAvailability(target, source) {
  if (!source) return target
  target.playable += Number(source.playable || 0)
  target.available += Number(source.available || 0)
  target.unavailable += Number(source.unavailable || 0)
  target.missing += Number(source.missing || 0)
  target.unknown += Number(source.unknown || 0)
  if (Array.isArray(source.videos)) target.videos.push(...source.videos)
  return target
}

function parseBlockBlobId(blobId) {
  if (typeof blobId !== 'string') return null
  const parts = blobId.split(':').map((part) => Number(part))
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null
  return { blockOffset: parts[0], blockLength: parts[1] }
}

function pushPreview(previews, video) {
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

function getVideoRefKey(video) {
  const id = getVideoKey(video)
  if (!id || !video?.blobsCoreKey || !video?.blobId) return null
  return `${id}:${String(video.blobsCoreKey).toLowerCase()}:${String(video.blobId)}`
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

  async function inspectVideoBlobAvailability(video, core) {
    const id = getVideoKey(video)
    const blob = parseBlockBlobId(video?.blobId)
    const result = {
      id,
      blobsCoreKey: video?.blobsCoreKey || null,
      blobId: video?.blobId || null,
      availability: 'unknown',
      contiguousBlocks: 0,
      hasHeadBlock: false
    }
    if (!id || !core || !blob) return result

    const start = blob.blockOffset
    const end = blob.blockOffset + blob.blockLength
    try {
      const fullyCached = await core.has?.(start, end)
      if (fullyCached) {
        result.availability = 'playable'
        result.contiguousBlocks = blob.blockLength
        result.hasHeadBlock = true
      } else {
        result.availability = 'unavailable'
        result.contiguousBlocks = 0
        const headEnd = Math.min(end, start + Math.max(1, Math.min(32, blob.blockLength || 32)))
        const hasHead = await core.has?.(start, headEnd).catch?.(() => false)
        result.hasHeadBlock = Boolean(hasHead)
      }
      return result
    } catch (err) {
      result.error = err?.message || String(err)
      return result
    }
  }

  async function collectBlobAvailability(videos, blobCores) {
    const availability = emptyStats().blobAvailability
    const seen = new Set()
    for (const video of videos) {
      const id = getVideoKey(video)
      if (!id || !video?.blobsCoreKey || !video?.blobId) continue
      const key = `${id}:${video.blobsCoreKey}:${video.blobId}`
      if (seen.has(key)) continue
      seen.add(key)
      const core = blobCores.get(String(video.blobsCoreKey).toLowerCase()) || null
      const detail = await inspectVideoBlobAvailability(video, core)
      if (detail.availability === 'playable') {
        availability.playable += 1
        availability.available += 1
      } else if (detail.availability === 'unavailable') {
        availability.unavailable += 1
        availability.missing += 1
      } else {
        availability.unknown += 1
      }
      availability.videos.push(detail)
    }
    return availability
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
      const blobCoreKeys = new Map()
      const blobCores = new Map()
      const previewVideos = []
      const availabilityVideos = []

      // Seed every core reference we know, not only what PublicBee.listVideos() returns.
      // Playback often starts from public-feed/catalog previews; if those refs are
      // newer than a slow/stale PublicBee read, the relay still needs to advertise
      // the exact blob cores the phone will dial.
      addPreviewCoreKeys(blobCoreKeys, channel?.previewVideos)
      addPreviewCoreKeys(blobCoreKeys, channel?.videos)
      addPreviewCoreKeys(blobCoreKeys, channel?.catalogEntry?.previewVideos)
      addPreviewCoreKeys(blobCoreKeys, channel?.feedEntry?.previewVideos)

      if (Array.isArray(channel?.previewVideos)) {
        availabilityVideos.push(...channel.previewVideos)
        for (const video of channel.previewVideos) {
          if (previewVideos.length >= 3) break
          pushPreview(previewVideos, video)
        }
      }
      if (Array.isArray(channel?.videos)) availabilityVideos.push(...channel.videos)
      if (Array.isArray(channel?.catalogEntry?.previewVideos)) availabilityVideos.push(...channel.catalogEntry.previewVideos)
      if (Array.isArray(channel?.feedEntry?.previewVideos)) availabilityVideos.push(...channel.feedEntry.previewVideos)

      if (Array.isArray(videos)) {
        stats.videos = Math.max(videos.length, previewVideos.length)
        availabilityVideos.push(...videos)
        for (const video of videos) {
          addCoreKey(blobCoreKeys, video?.blobsCoreKey, 'blob')
          addCoreKey(blobCoreKeys, video?.thumbnailBlobsCoreKey, 'thumbnail')
          if (previewVideos.length < 3) pushPreview(previewVideos, video)
        }
      }

      for (const [keyHex, kind] of blobCoreKeys) {
        const core = await resolveBlobCore(keyHex)
        if (core?.discoveryKey) {
          blobCores.set(keyHex, core)
          retainDiscovery(core.discoveryKey, `${kind}:${keyHex.slice(0, 16)}`)
          try { blindPeer?.addCore?.(core, { announce: true, referrer: b4a.from(publicBeeKey, 'hex') }) } catch {}
          stats.blobCores += 1
        }
      }

      stats.blobAvailability = await collectBlobAvailability(availabilityVideos, blobCores)
      stats.videos = Math.max(stats.videos, stats.blobAvailability.videos.length)
      const playableRefs = new Set(
        stats.blobAvailability.videos
          .filter((video) => video?.availability === 'playable')
          .map(getVideoRefKey)
          .filter(Boolean)
      )
      const playablePreviewVideos = previewVideos.filter((video) => playableRefs.has(getVideoRefKey(video)))

      stats.channels = 1
      stats.discoveryHandles = handles.size
      stats.lastSeededAt = Date.now()
      seededChannels.set(driveKey, {
        driveKey,
        publicBeeKey,
        videos: stats.videos,
        publicBeeCores: stats.publicBeeCores,
        blobCores: stats.blobCores,
        blobAvailability: stats.blobAvailability,
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
        relayServing: false,
        channelName: meta?.name || channel?.channelName || null,
        videoCount: stats.videos,
        manifestUpdatedAt: Number(meta?.updatedAt || meta?.createdAt || 0) || Date.now(),
        previewVideos: playablePreviewVideos
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

  async function seedFeedEntries(entries = []) {
    const seen = new Set()
    for (const entry of entries || []) {
      const driveKey = entry?.driveKey || entry?.channelKey
      const publicBeeKey = entry?.publicBeeKey || null
      if (!driveKey || !publicBeeKey || seen.has(driveKey)) continue
      seen.add(driveKey)
      await seedChannel({
        driveKey,
        publicBeeKey,
        previewVideos: Array.isArray(entry?.previewVideos) ? entry.previewVideos : [],
        feedEntry: entry,
        catalogEntry: entry?.schema === 'peartube.relayCatalog' ? entry : entry?.catalogEntry
      })
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
      mergeBlobAvailability(stats.blobAvailability, channel.blobAvailability)
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
    seedFeedEntries,
    getStats,
    close
  }
}
