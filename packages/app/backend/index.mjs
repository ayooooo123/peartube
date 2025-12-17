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
import b4a from 'b4a'

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

// Helps confirm which backend bundle is actually running on device.
const BACKEND_BUNDLE_VERSION = 'mw-sync-debug-2025-12-15'
console.log('[Backend] Bundle version:', BACKEND_BUNDLE_VERSION)

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
        // HRPC `event-video-stats` expects `{ stats: VideoStats }` where VideoStats matches the schema:
        // status/progress/totalBlocks/downloadedBlocks/totalBytes/downloadedBytes/peerCount/speedMBps/uploadSpeedMBps/elapsed/isComplete
        rpc.eventVideoStats({
          stats: {
            // Ensure identifiers are always present for routing on the client side.
            videoId: videoPath,
            channelKey: driveKey,
            // The backend VideoStatsTracker already produces schema-compatible fields.
            ...stats
          }
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

function emitLog(level, message) {
  if (!rpc) return
  try {
    rpc.eventLog({ level, message, timestamp: Date.now() })
  } catch {}
}

emitLog('info', `[Backend] Bundle version: ${BACKEND_BUNDLE_VERSION}`)

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
    try {
      for await (const name of drive.readdir('/thumbnails')) {
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
      // /thumbnails may not exist
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
  const channelKey = req?.channelKey || ''
  console.log('[HRPC] listVideos:', channelKey?.slice(0, 16))
  emitLog('info', `[HRPC] listVideos start ${channelKey?.slice(0, 16)}`)

  // Always respond quickly; never let listVideos hang the client.
  if (!channelKey) return { videos: [] }

  let rawVideos = []
  try {
    rawVideos = await api.listVideos(channelKey)
  } catch (e) {
    console.log('[HRPC] listVideos failed:', e?.message)
    emitLog('error', `[HRPC] listVideos api.listVideos failed: ${e?.message || e}`)
    return { videos: [] }
  }

  // IMPORTANT: Keep listVideos fast. Thumbnails are fetched lazily by the UI via getVideoThumbnail.
  // Doing per-video thumbnail resolution here can easily trigger the app-side listVideos timeout on mobile.
  // IMPORTANT: HRPC encoding expects `id` and `title` as strings. If we return malformed items,
  // HRPC can fail to encode and the request will never resolve on the client (leading to timeouts).
  const videos = (rawVideos || [])
    .map((v) => {
      const id = v?.id ? String(v.id) : ''
      if (!id) return null

      const title = v?.title ? String(v.title) : 'Untitled'
      const createdAt = Number(v?.createdAt || v?.uploadedAt || Date.now()) || 0

      return {
        id,
        title,
        description: v?.description ? String(v.description) : null,
        path: v?.path ? String(v.path) : null,
        duration: Number(v?.duration || 0) || 0,
        thumbnail: v?.thumbnail ? String(v.thumbnail) : null,
        channelKey: v?.channelKey || channelKey,
        channelName: v?.channelName ? String(v.channelName) : '',
        createdAt,
        views: Number(v?.views || 0) || 0,
        category: v?.category ? String(v.category) : null
      }
    })
    .filter(Boolean)

  emitLog('info', `[HRPC] listVideos done ${channelKey?.slice(0, 16)} count=${videos.length}`)
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
  const channel = await identityManager.getActiveChannel?.()
  if (!channel) throw new Error('No active channel')
  const blobDriveKey = await channel.ensureLocalBlobDrive({ deviceName: active.name || '' })
  const blobDrive = await channel.getBlobDrive(blobDriveKey)

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
    blobDrive,
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

  console.log('[HRPC] Upload result:', JSON.stringify({ success: result?.success, videoId: result?.videoId, hasMetadata: !!result?.metadata }))

  // Record the video in the channel's multi-writer metadata log
  if (result?.success && result?.metadata) {
    console.log('[HRPC] Adding video to channel metadata log...')
    try {
      await channel.addVideo({
        id: result.videoId,
        title: req.title,
        description: req.description || '',
        path: result.metadata.path,
        mimeType: result.metadata.mimeType,
        size: result.metadata.size,
        uploadedAt: result.metadata.uploadedAt,
        category: req.category || '',
        thumbnail: result.metadata.thumbnail,
        blobDriveKey
      })
      console.log('[HRPC] Video added to channel successfully')
    } catch (addErr) {
      console.error('[HRPC] Failed to add video to channel:', addErr?.message, addErr?.stack)
    }
  } else {
    console.error('[HRPC] Upload failed or no metadata:', result?.error)
  }

  console.log('[HRPC] Returning upload response')
  return {
    video: {
      id: result?.videoId || '',
      title: req.title,
      description: req.description || '',
      channelKey: active.driveKey
    }
  }
})

rpc.onDownloadVideo(async (req) => {
  console.log('[HRPC] downloadVideo:', req.channelKey?.slice(0, 16), req.videoId)

  try {
    // Resolve to correct blob source for multi-writer channels (or legacy drive)
    const meta = await api.getVideoData(req.channelKey, req.videoId)
    const sourceDriveKey = meta?.blobDriveKey || req.channelKey
    const drive = await loadDrive(ctx, sourceDriveKey, { waitForSync: true, syncTimeout: 15000 })
    const videoPath = meta?.path || req.videoId

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
  const channel = await identityManager.getActiveChannel?.()
  if (!channel) return { success: false, error: 'No active channel' }
  try {
    await channel.deleteVideo(req.videoId)
    return { success: true }
  } catch (e) {
    return { success: false, error: e?.message || 'Delete failed' }
  }
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

// Multi-device pairing
rpc.onCreateDeviceInvite(async (req) => {
  console.log('[HRPC] createDeviceInvite:', req.channelKey?.slice(0, 16))
  const res = await api.createDeviceInvite(req.channelKey)
  return { inviteCode: res.inviteCode }
})

rpc.onPairDevice(async (req) => {
  console.log('[HRPC] pairDevice')
  const res = await api.pairDevice(req.inviteCode, req.deviceName || '')
  // If this device doesn't have an identity yet, create one that points at the paired channel.
  try {
    const existing = identityManager.getIdentities?.() || []
    if (existing.length === 0 && res?.channelKey) {
      await identityManager.addPairedChannelIdentity?.(res.channelKey, 'Paired Channel')
    }
  } catch (e) {
    console.log('[HRPC] addPairedChannelIdentity skipped:', e?.message)
  }
  return { success: Boolean(res.success), channelKey: res.channelKey }
})

rpc.onListDevices(async (req) => {
  console.log('[HRPC] listDevices:', req.channelKey?.slice(0, 16))
  const res = await api.listDevices(req.channelKey)
  // HRPC schema expects Device[]; backend returns writer records (keyHex, role, deviceName...)
  return { devices: res.devices || [] }
})

// ============================================
// Search / Comments / Reactions / Recommendations
// ============================================

rpc.onSearchVideos(async (req) => {
  const channelKey = req.channelKey
  const query = req.query || ''
  const topK = typeof req.topK === 'number' ? req.topK : 10
  const federated = req.federated !== false
  const results = await api.searchVideos(channelKey, query, { topK, federated })

  return {
    results: (results || []).map((r) => ({
      id: r.id,
      score: typeof r.score === 'number' ? String(r.score) : (r.score ? String(r.score) : ''),
      metadata: r.metadata ? JSON.stringify(r.metadata) : ''
    }))
  }
})

rpc.onIndexVideoVectors(async (req) => {
  const res = await api.indexVideoVectors(req.channelKey, req.videoId)
  return { success: Boolean(res?.success), error: res?.error || '' }
})

// Comments
rpc.onAddComment(async (req) => {
  const res = await api.addComment(req.channelKey, req.videoId, req.text, req.parentId || null)
  return { success: Boolean(res?.success), commentId: res?.commentId || '', error: res?.error || '' }
})

rpc.onListComments(async (req) => {
  const res = await api.listComments(req.channelKey, req.videoId, { page: req.page || 0, limit: req.limit || 50 })
  const comments = (res?.comments || []).map((c) => ({
    videoId: c.videoId,
    commentId: c.commentId,
    text: c.text,
    authorKeyHex: c.authorKeyHex,
    timestamp: c.timestamp || 0,
    parentId: c.parentId || ''
  }))
  return { success: Boolean(res?.success), comments, error: res?.error || '' }
})

rpc.onHideComment(async (req) => {
  const res = await api.hideComment(req.channelKey, req.videoId, req.commentId)
  return { success: Boolean(res?.success), error: res?.error || '' }
})

rpc.onRemoveComment(async (req) => {
  const res = await api.removeComment(req.channelKey, req.videoId, req.commentId)
  return { success: Boolean(res?.success), error: res?.error || '' }
})

// Reactions
rpc.onAddReaction(async (req) => {
  const res = await api.addReaction(req.channelKey, req.videoId, req.reactionType)
  return { success: Boolean(res?.success), error: res?.error || '' }
})

rpc.onRemoveReaction(async (req) => {
  const res = await api.removeReaction(req.channelKey, req.videoId)
  return { success: Boolean(res?.success), error: res?.error || '' }
})

rpc.onGetReactions(async (req) => {
  const res = await api.getReactions(req.channelKey, req.videoId)
  const countsObj = res?.counts || {}
  const counts = Object.entries(countsObj).map(([reactionType, count]) => ({
    reactionType,
    count: typeof count === 'number' ? count : 0
  }))
  return {
    success: Boolean(res?.success),
    counts,
    userReaction: res?.userReaction || '',
    error: res?.error || ''
  }
})

// Recommendations
rpc.onLogWatchEvent(async (req) => {
  const res = await api.logWatchEvent(req.channelKey, req.videoId, {
    duration: req.duration || 0,
    completed: Boolean(req.completed),
    share: Boolean(req.share)
  })
  return { success: Boolean(res?.success), error: res?.error || '' }
})

rpc.onGetRecommendations(async (req) => {
  const res = await api.getRecommendations(req.channelKey, { limit: req.limit || 10 })
  const recommendations = (res?.recommendations || []).map((r) => ({
    videoId: r.videoId,
    score: typeof r.score === 'number' ? String(r.score) : (r.score ? String(r.score) : ''),
    reason: r.reason || ''
  }))
  return { success: Boolean(res?.success), recommendations, error: res?.error || '' }
})

rpc.onGetVideoRecommendations(async (req) => {
  const res = await api.getVideoRecommendations(req.channelKey, req.videoId, req.limit || 5)
  const recommendations = (res?.recommendations || []).map((r) => ({
    videoId: r.videoId,
    score: typeof r.score === 'number' ? String(r.score) : (r.score ? String(r.score) : ''),
    reason: r.reason || ''
  }))
  return { success: Boolean(res?.success), recommendations, error: res?.error || '' }
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
      // Ensure identifiers exist (schema supports these fields too)
      videoId: req.videoId,
      channelKey: req.channelKey,
      // Prefer the backend's schema-shaped stats object.
      ...(stats || {})
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
  const active = identityManager.getActiveIdentity()
  if (!active?.driveKey) return { success: false }

  const channel = await identityManager.getActiveChannel?.()
  if (!channel) return { success: false }

  const meta = await api.getVideoData(active.driveKey, req.videoId)
  const sourceDriveKey = meta?.blobDriveKey || null
  if (!sourceDriveKey) return { success: false }

  const drive = await loadDrive(ctx, sourceDriveKey, { waitForSync: true, syncTimeout: 8000 })

  const result = await uploadManager.setThumbnailFromBuffer(
    drive,
    req.videoId,
    Buffer.from(req.imageData || '', 'base64'),
    req.mimeType
  )

  // Keep channel metadata in sync by re-reading blob-drive metadata
  if (result.success && meta?.id) {
    const metaBuf = await drive.get(`/videos/${meta.id}.json`).catch(() => null)
    if (metaBuf) {
      const updated = JSON.parse(metaBuf.toString('utf-8'))
      await channel.addVideo({ ...updated, channelKey: active.driveKey, blobDriveKey: sourceDriveKey })
    }
  }

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
