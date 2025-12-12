/**
 * PearTube Mobile Backend - Thin HRPC layer over @peartube/backend
 *
 * This is a minimal wrapper that:
 * 1. Initializes the backend using createBackendContext
 * 2. Registers HRPC handlers that delegate to backend API
 * 3. Handles mobile-specific concerns (BareKit IPC, single identity)
 */

import HRPC from '@peartube/spec'
import { createBackendContext } from '@peartube/backend/orchestrator'
import { loadDrive } from '@peartube/backend/storage'
import path from 'bare-path'
import fs from 'bare-fs'

// Get IPC from BareKit, args from Bare
const { IPC } = BareKit
const storagePath = Bare.argv[0] || ''

console.log('[Backend] Starting PearTube mobile backend')
console.log('[Backend] Storage path:', storagePath)

// Initialize storage directory
const storageDir = path.join(storagePath, 'peartube-data')
try {
  fs.mkdirSync(storageDir, { recursive: true })
} catch (e) {
  // Directory may already exist
}

// HRPC instance (initialized after backend)
let rpc = null

// Initialize backend
const backend = await createBackendContext({
  storagePath: storageDir,
  onFeedUpdate: () => {
    if (rpc) {
      try {
        rpc.eventFeedUpdate({})
      } catch (e) {
        console.log('[Backend] Failed to send feed update:', e.message)
      }
    }
  },
  onStatsUpdate: (driveKey, videoPath, stats) => {
    if (rpc) {
      try {
        rpc.eventVideoStats({
          videoId: videoPath,
          channelKey: driveKey,
          downloadedBytes: stats.downloadedBytes || 0,
          totalBytes: stats.totalBytes || 0,
          downloadProgress: stats.progress || 0,
          peerCount: stats.peerCount || 0,
          downloadSpeed: stats.speed || 0,
          uploadSpeed: stats.uploadSpeed || 0
        })
      } catch (e) {
        console.log('[Backend] Failed to send video stats:', e.message)
      }
    }
  }
})

const { ctx, api, identityManager, uploadManager, publicFeed, seedingManager, videoStats } = backend

const blobPort = ctx.blobServer?.port || ctx.blobServerPort || 0
console.log('[Backend] Backend initialized, blob server port:', blobPort, '(from blobServer.port:', ctx.blobServer?.port, ', from ctx.blobServerPort:', ctx.blobServerPort, ')')

// Create HRPC instance
rpc = new HRPC(IPC)
console.log('[Backend] HRPC initialized')

function getThumbnailMime(thumbPath) {
  const ext = thumbPath.split('.').pop()?.toLowerCase() || 'jpg'
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'image/jpeg'
}

// Migrate existing thumbnails to blob-backed entries (so URLs persist across restarts)
async function migrateThumbnails(drive) {
  try {
    for await (const name of drive.readdir('/thumbnails').catch(() => [])) {
      const thumbPath = `/thumbnails/${name}`
      const entry = await drive.entry(thumbPath).catch(() => null)
      if (entry && entry.value?.blob) continue

      const buf = await drive.get(thumbPath, { wait: true, timeout: 3000 }).catch(() => null)
      if (!buf) continue

      console.log('[Backend] Migrating inline thumbnail to blob:', thumbPath)
      await new Promise((resolve, reject) => {
        const ws = drive.createWriteStream(thumbPath)
        ws.on('error', reject)
        ws.on('close', resolve)
        ws.end(buf)
      })
    }
  } catch (e) {
    console.log('[Backend] Thumbnail migration skipped:', e?.message)
  }
}

const activeDriveForMigration = identityManager.getActiveDrive?.()
if (activeDriveForMigration) {
  migrateThumbnails(activeDriveForMigration)
}

// Restore cached public feed so restart doesn't start from empty
async function restoreFeedCache() {
  try {
    const cached = await ctx.metaDb.get('public-feed-cache').catch(() => null)
    const keys = cached?.value || []
    if (Array.isArray(keys) && keys.length) {
      console.log('[Backend] Restoring public feed cache, entries:', keys.length)
      for (const key of keys) {
        try {
          publicFeed.addEntry(key, 'peer')
        } catch {}
      }
    }
  } catch (e) {
    console.log('[Backend] Feed cache restore skipped:', e?.message)
  }
}

// Persist feed cache
async function persistFeedCache() {
  try {
    const entries = publicFeed.getFeed().map((e) => e.driveKey)
    await ctx.metaDb.put('public-feed-cache', entries)
    console.log('[Backend] Saved public feed cache:', entries.length)
  } catch (e) {
    console.log('[Backend] Feed cache save skipped:', e?.message)
  }
}

await restoreFeedCache()

// ============================================
// HRPC Handler Registration - Thin delegation layer
// ============================================

// Identity handlers
rpc.onCreateIdentity(async (req) => {
  console.log('[HRPC] createIdentity:', req.name)
  const result = await identityManager.createIdentity(req.name || 'New Channel', true)
  return {
    identity: {
      publicKey: result.publicKey,
      name: req.name || 'New Channel',
      seedPhrase: result.mnemonic || ''
    }
  }
})

rpc.onGetIdentity(async () => {
  console.log('[HRPC] getIdentity')
  const ident = identityManager.getActiveIdentity()
  return { identity: ident || null }
})

rpc.onGetIdentities(async () => {
  console.log('[HRPC] getIdentities')
  const identities = identityManager.getIdentities()
  const active = identityManager.getActiveIdentity()
  return {
    identities: identities.map(i => ({
      ...i,
      isActive: active?.publicKey === i.publicKey
    }))
  }
})

rpc.onSetActiveIdentity(async (req) => {
  console.log('[HRPC] setActiveIdentity:', req.publicKey?.slice(0, 16))
  await identityManager.setActiveIdentity(req.publicKey)
  return { success: true }
})

rpc.onRecoverIdentity(async (req) => {
  console.log('[HRPC] recoverIdentity')
  try {
    const result = await identityManager.recoverIdentity(req.seedPhrase, req.name)
    return { identity: result }
  } catch (e) {
    console.error('[HRPC] Recovery failed:', e.message)
    return { identity: null }
  }
})

// Channel handlers
rpc.onGetChannel(async (req) => {
  console.log('[HRPC] getChannel:', req.publicKey?.slice(0, 16))
  const channel = await api.getChannel(req.publicKey || '')
  return { channel }
})

rpc.onUpdateChannel(async (req) => {
  console.log('[HRPC] updateChannel')
  const active = identityManager.getActiveIdentity()
  if (active) {
    await api.updateChannel(active.driveKey, req.name, req.description)
  }
  return { channel: {} }
})

// Video handlers
rpc.onListVideos(async (req) => {
  console.log('[HRPC] listVideos:', req.channelKey?.slice(0, 16))
  const rawVideos = await api.listVideos(req.channelKey || '')

  const videos = await Promise.all(rawVideos.map(async (v) => {
    const channelKey = v.channelKey || req.channelKey
    let thumbnailUrl = ''

    if (v.thumbnail && channelKey) {
      try {
        let drive = ctx.drives.get(channelKey)
        if (!drive) {
          drive = await loadDrive(ctx, channelKey, { waitForSync: false, syncTimeout: 4000 }).catch(() => null)
          if (!drive) {
            const activeDrive = identityManager.getActiveDrive?.()
            if (activeDrive && b4a.toString(activeDrive.key, 'hex') === channelKey) {
              drive = activeDrive
            }
          }
        }

        if (drive) {
          const entry = await drive.entry(v.thumbnail).catch(() => null)
          const mime = getThumbnailMime(v.thumbnail)

          if (entry && entry.value?.blob) {
            const blobsCore = await drive.getBlobs()
            if (blobsCore) {
              thumbnailUrl = ctx.blobServer.getLink(blobsCore.core.key, {
                blob: entry.value.blob,
                type: mime,
                host: ctx.blobServerHost || '127.0.0.1',
                port: ctx.blobServer?.port || ctx.blobServerPort
              })
            }
          } else {
            // Inline thumbnail (no blob) - fall back to data URL so we don't mutate foreign drives
            const buf = await drive.get(v.thumbnail, { wait: true, timeout: 2000 }).catch(() => null)
            if (buf) {
              const base64 = b4a.from(buf).toString('base64')
              thumbnailUrl = `data:${mime};base64,${base64}`
            }
          }
        }
      } catch (e) {
        console.log('[HRPC] listVideos thumbnail resolve failed:', e?.message)
      }
    }

    return {
      ...v,
      thumbnail: thumbnailUrl,
      channelKey,
      channelName: v.channelName || ''
    }
  }))

  return { videos }
})

rpc.onGetVideoUrl(async (req) => {
  console.log('[HRPC] getVideoUrl:', req.channelKey?.slice(0, 16), req.videoId)
  const result = await api.getVideoUrl(req.channelKey, req.videoId)
  return { url: result.url }
})

rpc.onGetVideoData(async (req) => {
  console.log('[HRPC] getVideoData:', req.channelKey?.slice(0, 16), req.videoId)
  const video = await api.getVideoData(req.channelKey, req.videoId)
  return { video: video || { id: req.videoId, title: 'Unknown' } }
})

rpc.onUploadVideo(async (req) => {
  console.log('[HRPC] uploadVideo:', req.title, 'filePath:', req.filePath)
  const active = identityManager.getActiveIdentity()
  if (!active?.driveKey) {
    throw new Error('No active identity')
  }
  const drive = identityManager.getActiveDrive()
  if (!drive) {
    throw new Error('No active drive')
  }

  let filePath = req.filePath
  if (!filePath) {
    throw new Error('No file path provided')
  }

  // Handle file:// prefix
  if (filePath.startsWith('file://')) {
    filePath = filePath.slice(7)
  }

  const ext = filePath.split('.').pop()?.toLowerCase() || 'mp4'
  const mimeTypes = {
    'mp4': 'video/mp4',
    'm4v': 'video/mp4',
    'webm': 'video/webm',
    'mkv': 'video/x-matroska',
    'mov': 'video/quicktime',
    'avi': 'video/x-msvideo',
  }
  const mimeType = mimeTypes[ext] || 'video/mp4'
  console.log('[HRPC] Streaming upload from:', filePath, 'mime:', mimeType)

  // Use streaming upload - file streams directly to hyperdrive
  const result = await uploadManager.uploadFromPath(
    drive,
    filePath,
    {
      title: req.title,
      description: req.description || '',
      mimeType,
      category: req.category || ''
    },
    fs,  // Pass bare-fs for file reading
    (progress, bytesWritten, totalBytes) => {
      // Emit progress event
      rpc.eventUploadProgress({ progress })
    }
  )

  return {
    video: {
      id: result.videoId,
      title: req.title,
      description: req.description || '',
      channelKey: active.driveKey
    }
  }
})

rpc.onDownloadVideo(async (req) => {
  console.log('[HRPC] downloadVideo:', req.channelKey?.slice(0, 16), req.videoId)

  try {
    // Load drive and resolve video path
    const drive = await loadDrive(ctx, req.channelKey, { waitForSync: true, syncTimeout: 15000 })

    let videoPath = req.videoId
    // If an id was passed instead of a path, try to read metadata to find the path
    if (!videoPath.startsWith('/')) {
      const metaBuf = await drive.get(`/videos/${req.videoId}.json`).catch(() => null)
      if (metaBuf) {
        const meta = JSON.parse(metaBuf.toString('utf-8'))
        if (meta?.path) videoPath = meta.path
      } else {
        videoPath = `/videos/${req.videoId}`
      }
    }

    const entry = await drive.entry(videoPath, { wait: true, timeout: 10000 })
    if (!entry || !entry.value?.blob) {
      return { success: false, error: 'Video not found in drive' }
    }

    const totalBytes = entry.value.blob.byteLength || 0
    console.log('[HRPC] Video size:', totalBytes)

    const blobsCore = await drive.getBlobs()
    if (!blobsCore) {
      return { success: false, error: 'Unable to resolve blobs core' }
    }

    const videoExt = videoPath.split('.').pop()?.toLowerCase() || 'mp4'
    const videoMimeTypes = { 'mp4': 'video/mp4', 'webm': 'video/webm', 'mkv': 'video/x-matroska', 'mov': 'video/quicktime', 'avi': 'video/x-msvideo' }
    const mime = videoMimeTypes[videoExt] || 'video/mp4'
    const url = ctx.blobServer.getLink(blobsCore.core.key, {
      blob: entry.value.blob,
      type: mime,
      host: '127.0.0.1',
      port: ctx.blobServer?.port || ctx.blobServerPort
    })

    console.log('[HRPC] Direct blob URL:', url)

    return {
      success: true,
      filePath: url,
      size: totalBytes
    }
  } catch (err) {
    console.error('[HRPC] downloadVideo failed:', err?.message)
    return { success: false, error: err?.message || 'download failed' }
  }
})

// Delete video handler
rpc.onDeleteVideo(async (req) => {
  console.log('[HRPC] deleteVideo:', req.videoId)
  const drive = identityManager.getActiveDrive()
  if (!drive) {
    return { success: false, error: 'No active identity' }
  }
  const result = await api.deleteVideo(drive, req.videoId)
  return result
})

// Subscription handlers
rpc.onSubscribeChannel(async (req) => {
  console.log('[HRPC] subscribeChannel:', req.channelKey?.slice(0, 16))
  await api.subscribeChannel(req.channelKey)
  return { success: true }
})

rpc.onUnsubscribeChannel(async (req) => {
  console.log('[HRPC] unsubscribeChannel:', req.channelKey?.slice(0, 16))
  await api.unsubscribeChannel(req.channelKey)
  return { success: true }
})

rpc.onGetSubscriptions(async () => {
  console.log('[HRPC] getSubscriptions')
  const subs = await api.getSubscriptions()
  return {
    subscriptions: subs.map(s => ({
      channelKey: s.driveKey,
      channelName: s.name
    }))
  }
})

rpc.onJoinChannel(async (req) => {
  console.log('[HRPC] joinChannel:', req.channelKey?.slice(0, 16))
  await api.subscribeChannel(req.channelKey)
  return { success: true }
})

// Public Feed handlers
rpc.onGetPublicFeed(async () => {
  console.log('[HRPC] getPublicFeed')
  const result = await api.getPublicFeed()
  return {
    entries: result.entries.map(e => ({
      channelKey: e.driveKey || e.channelKey,
      channelName: e.name,
      videoCount: e.videoCount || 0,
      peerCount: e.peerCount || 0,
      lastSeen: e.lastSeen || 0
    }))
  }
})

rpc.onRefreshFeed(async () => {
  console.log('[HRPC] refreshFeed')
  await api.refreshFeed()
  return { success: true }
})

rpc.onSubmitToFeed(async () => {
  console.log('[HRPC] submitToFeed')
  const active = identityManager.getActiveIdentity()
  if (active?.driveKey) {
    await api.submitToFeed(active.driveKey)
  }
  return { success: true }
})

rpc.onUnpublishFromFeed(async () => {
  console.log('[HRPC] unpublishFromFeed')
  const active = identityManager.getActiveIdentity()
  if (active?.driveKey) {
    await api.unpublishFromFeed(active.driveKey)
  }
  return { success: true }
})

rpc.onIsChannelPublished(async () => {
  console.log('[HRPC] isChannelPublished')
  const active = identityManager.getActiveIdentity()
  if (active?.driveKey) {
    return api.isChannelPublished(active.driveKey)
  }
  return { published: false }
})

rpc.onHideChannel(async (req) => {
  console.log('[HRPC] hideChannel:', req.channelKey?.slice(0, 16))
  await api.hideChannel(req.channelKey)
  return { success: true }
})

rpc.onGetChannelMeta(async (req) => {
  console.log('[HRPC] getChannelMeta:', req.channelKey?.slice(0, 16))
  const meta = await api.getChannelMeta(req.channelKey)
  return {
    name: meta.name,
    description: meta.description,
    videoCount: meta.videoCount || 0
  }
})

rpc.onGetSwarmStatus(async () => {
  console.log('[HRPC] getSwarmStatus')
  const status = await api.getSwarmStatus()
  return {
    connected: status.swarmConnections > 0,
    peerCount: status.swarmConnections
  }
})

// Video prefetch and stats
rpc.onPrefetchVideo(async (req) => {
  console.log('[HRPC] prefetchVideo:', req.channelKey?.slice(0, 16), req.videoId)
  await api.prefetchVideo(req.channelKey, req.videoId)
  return { success: true }
})

rpc.onGetVideoStats(async (req) => {
  console.log('[HRPC] getVideoStats:', req.channelKey?.slice(0, 16), req.videoId)
  const stats = await api.getVideoStats(req.channelKey, req.videoId)
  return {
    stats: {
      videoId: req.videoId,
      channelKey: req.channelKey,
      downloadedBytes: stats.downloadedBytes || 0,
      totalBytes: stats.totalBytes || 0,
      downloadProgress: stats.progress || 0,
      peerCount: stats.peerCount || 0,
      downloadSpeed: stats.speed || 0,
      uploadSpeed: stats.uploadSpeed || 0
    }
  }
})

// Seeding handlers
rpc.onGetSeedingStatus(async () => {
  console.log('[HRPC] getSeedingStatus')
  const status = await api.getSeedingStatus()
  return {
    status: {
      enabled: status.config?.autoSeedWatched || false,
      usedStorage: status.storageUsedBytes || 0,
      maxStorage: (status.maxStorageGB || 10) * 1024 * 1024 * 1024,
      seedingCount: status.activeSeeds || 0
    }
  }
})

rpc.onSetSeedingConfig(async (req) => {
  console.log('[HRPC] setSeedingConfig')
  await api.setSeedingConfig(req.config || {})
  return { success: true }
})

rpc.onPinChannel(async (req) => {
  console.log('[HRPC] pinChannel:', req.channelKey?.slice(0, 16))
  await api.pinChannel(req.channelKey)
  return { success: true }
})

rpc.onUnpinChannel(async (req) => {
  console.log('[HRPC] unpinChannel:', req.channelKey?.slice(0, 16))
  await api.unpinChannel(req.channelKey)
  return { success: true }
})

rpc.onGetPinnedChannels(async () => {
  console.log('[HRPC] getPinnedChannels')
  const result = await api.getPinnedChannels()
  return { channels: result.channels || [] }
})

// Storage management handlers
rpc.onGetStorageStats(async () => {
  console.log('[HRPC] getStorageStats')
  return api.getStorageStats()
})

rpc.onSetStorageLimit(async (req) => {
  console.log('[HRPC] setStorageLimit:', req.maxGB)
  return await api.setStorageLimit(req.maxGB)
})

rpc.onClearCache(async () => {
  console.log('[HRPC] clearCache')
  return await api.clearCache()
})

// Thumbnail handlers
rpc.onGetVideoThumbnail(async (req) => {
  console.log('[HRPC] getVideoThumbnail:', req.channelKey?.slice(0, 16), req.videoId)
  const result = await api.getVideoThumbnail(req.channelKey, req.videoId)
  return { url: result.url || null, exists: result.exists || false, dataUrl: null }
})

rpc.onGetVideoMetadata(async (req) => {
  console.log('[HRPC] getVideoMetadata:', req.channelKey?.slice(0, 16), req.videoId)
  const video = await api.getVideoData(req.channelKey, req.videoId)
  return { video: video || { id: req.videoId, title: 'Unknown' } }
})

rpc.onSetVideoThumbnail(async (req) => {
  console.log('[HRPC] setVideoThumbnail')
  const drive = identityManager.getActiveDrive()
  if (!drive) {
    return { success: false }
  }

  const result = await uploadManager.setThumbnailFromBuffer(
    drive,
    req.videoId,
    Buffer.from(req.imageData || '', 'base64'),
    req.mimeType
  )
  return { success: result.success }
})

// Status handlers
rpc.onGetStatus(async () => {
  console.log('[HRPC] getStatus')
  const active = identityManager.getActiveIdentity()
  return {
    status: {
      ready: true,
      hasIdentity: active !== null,
      blobServerPort: ctx.blobServer?.port || ctx.blobServerPort || 0
    }
  }
})

rpc.onGetBlobServerPort(async () => {
  console.log('[HRPC] getBlobServerPort')
  return { port: ctx.blobServer?.port || ctx.blobServerPort || 0 }
})

// Desktop-specific handlers (stubs for mobile)
rpc.onPickVideoFile(async () => {
  console.log('[HRPC] pickVideoFile - not supported on mobile')
  return { filePath: null, cancelled: true }
})

rpc.onPickImageFile(async () => {
  console.log('[HRPC] pickImageFile - not supported on mobile')
  return { filePath: null, cancelled: true }
})

rpc.onSetVideoThumbnailFromFile(async () => {
  console.log('[HRPC] setVideoThumbnailFromFile - not supported on mobile')
  return { success: false }
})

// Event handlers (client -> server, usually no-ops)
rpc.onEventReady(() => {
  console.log('[HRPC] Client acknowledged ready')
})

rpc.onEventError((data) => {
  console.error('[HRPC] Client reported error:', data?.message)
})

rpc.onEventUploadProgress(() => {})
rpc.onEventFeedUpdate(() => {})
rpc.onEventLog(() => {})
rpc.onEventVideoStats(() => {})

console.log('[Backend] HRPC handlers registered')

// Send ready event
try {
  const port = ctx.blobServer?.port || ctx.blobServerPort || 0
  rpc.eventReady({ blobServerPort: port, blobServerHost: ctx.blobServerHost || '127.0.0.1' })
  console.log('[Backend] Sent eventReady via HRPC, blobServerPort:', port, 'host:', ctx.blobServerHost || '127.0.0.1')
} catch (e) {
  console.error('[Backend] Failed to send eventReady:', e.message)
}

// Keep discovery fresh: ask peers for feeds periodically and persist cache
setInterval(() => {
  try {
    publicFeed.requestFeedsFromPeers()
    persistFeedCache()
  } catch (e) {
    console.log('[Backend] Feed refresh tick failed:', e?.message)
  }
}, 30000)

// Persist feed when it changes
publicFeed.setOnFeedUpdate(() => {
  persistFeedCache()
  try {
    rpc?.eventFeedUpdate?.({})
  } catch {}
})
