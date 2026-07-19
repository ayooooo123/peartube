/* eslint-disable no-empty */
/**
 * PearTube shared app handler adapters.
 *
 * This mirrors the app-side mobile handler layer so backend bootstrap can
 * attach it without crossing workspace package boundaries inside Pear's
 * symlinked node_modules layout.
 */

import { resolveCompatPlaybackUrl } from './transcode/playback-compat-runtime.mjs'

function isPearTubeLoopbackBlobUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    const url = new URL(value)
    const hostname = url.hostname
    if (url.protocol !== 'http:') return false
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return false
    return Boolean(url.searchParams.get('key') && url.searchParams.get('blob'))
  } catch {
    return false
  }
}

function shouldResolveNativeCompat(player, url) {
  // Android ExoPlayer can stream PearTube blobs directly. Running the optional
  // compat layer first forces a backend HTTP/ffmpeg self-probe against the same
  // loopback URL; under libqjs that probe can wedge before its timeout, so
  // direct playback never gets bytes.
  if (player === 'exoplayer' && isPearTubeLoopbackBlobUrl(url)) return false
  return true
}

/**
 * @param {Object} B - Backend object to attach handlers to
 * @param {Object} deps - Dependencies from the backend context
 */
function safeJson(value) {
  if (value == null) return null
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function normalizeSeedingStatus(s) {
  const maxStorageGB = Number.isFinite(Number(s?.maxStorageGB))
    ? Number(s.maxStorageGB)
    : Number.isFinite(Number(s?.config?.maxStorageGB))
      ? Number(s.config.maxStorageGB)
      : 10
  const activeSeeds = Number.isFinite(Number(s?.activeSeeds))
    ? Number(s.activeSeeds)
    : Array.isArray(s?.seeds)
      ? s.seeds.length
      : 0
  return {
    status: {
      enabled: Boolean(s?.config?.autoSeedWatched),
      usedStorage: Math.max(0, Number(s?.storageUsedBytes || 0) || 0),
      maxStorage: Math.max(0, maxStorageGB * 1024 * 1024 * 1024),
      seedingCount: Math.max(0, activeSeeds)
    }
  }
}

export function attachMobileHandlers(B, deps) {
  const { api, identityManager, uploadManager, ctx, initializeIdentityFromMnemonic, rpc, fs, path, generateAndStoreThumbnail, transcoder, castTranscoder, player } = deps

  const refreshPublishedChannelFeed = async (driveKey) => {
    if (!driveKey || typeof api?.isChannelPublished !== 'function' || typeof api?.submitToFeed !== 'function') return
    try {
      const status = await api.isChannelPublished(driveKey)
      if (!status?.published) return
      const result = await api.submitToFeed(driveKey)
      if (result?.success === false) {
        console.log('[Backend] uploadVideo feed gossip refresh skipped:', result.error || 'submitToFeed failed')
      }
    } catch (err) {
      console.log('[Backend] uploadVideo feed gossip refresh failed (non-fatal):', err?.message)
    }
  }

  B.createIdentity = async (r) => {
    const result = await identityManager.createIdentity(r.name || 'New Channel', true)
    if (result.mnemonic) {
      try { const { needsRestart } = await initializeIdentityFromMnemonic(result.mnemonic); if (needsRestart) console.log('[Backend] Identity key file written') } catch (e) { console.error('[Backend] initializeIdentityFromMnemonic failed:', e.message) }
    }
    return { identity: { publicKey: result.publicKey, driveKey: result.driveKey, name: r.name || 'New Channel', seedPhrase: result.mnemonic || '', isActive: true } }
  }
  B.getIdentity = async () => ({ identity: identityManager.getActiveIdentity() || null })
  B.getIdentities = async () => {
    const identities = identityManager.getIdentities()
    const active = identityManager.getActiveIdentity()
    return { identities: identities.map(i => ({ ...i, isActive: active?.publicKey === i.publicKey })) }
  }
  B.setActiveIdentity = async (r) => { await identityManager.setActiveIdentity(r.publicKey); return { success: true } }
  B.recoverIdentity = async (r) => {
    try {
      const result = await identityManager.recoverIdentity(r.seedPhrase, r.name)
      if (r.seedPhrase) { try { await initializeIdentityFromMnemonic(r.seedPhrase) } catch {} }
      return { identity: result }
    } catch { return { identity: null } }
  }
  B.bootstrapDevice = async (r) => { const result = await identityManager.bootstrapDevice(r.mnemonic); return { proof: result.proof, identityPublicKey: result.identityPublicKey } }
  B.attestDevice = async (r) => ({ proof: await identityManager.attestDevice(r.identityKeyPair, r.devicePublicKey, r.proof || null) })
  B.verifyAttestation = async (r) => {
    try { const result = await identityManager.verifyAttestation(r.proof); return { valid: result.valid, identityPublicKey: result.identityPublicKey || '', devicePublicKey: result.devicePublicKey || '' } }
    catch { return { valid: false, identityPublicKey: '', devicePublicKey: '' } }
  }

  B.getChannel = async (r) => ({ channel: await api.getChannel(r.publicKey || '') })
  B.getContentCatalog = async (r) => api.getContentCatalog(r)
  B.getContentItems = async (r) => api.getContentItems(r)
  B.updateChannel = async (r) => {
    const a = identityManager.getActiveIdentity(); if (!a?.driveKey) return { success: false, error: 'No active channel' }
    try { return await api.updateChannel(a.driveKey, { name: r.name, description: r.description, avatar: r.avatar }) } catch (err) { return { success: false, error: err?.message } }
  }
  B.updateVideoMetadata = async (r) => {
    const a = identityManager.getActiveIdentity(); if (!a?.driveKey) return { success: false, error: 'No active channel' }
    try { return await api.updateVideoMetadata(r.channelKey || a.driveKey, r.videoId, { title: r.title, description: r.description, category: r.category }) } catch (err) { return { success: false, error: err?.message } }
  }
  B.updateChannelAvatar = async (r) => {
    const a = identityManager.getActiveIdentity(); if (!a?.driveKey) return { success: false, error: 'No active channel' }
    try { return await api.updateChannelAvatar(a.driveKey, Buffer.from(r.imageData, 'base64'), r.mimeType || 'image/jpeg') } catch (err) { return { success: false, error: err?.message } }
  }
  B.getChannelMeta = async (r) => { const m = await api.getChannelMeta(r.channelKey, r.publicBeeKey || null); return { name: m.name, description: m.description, videoCount: m.videoCount || 0 } }

  B.listVideos = async (r) => {
    const ck = r?.channelKey || ''; if (!ck) return { videos: [] }
    let raw = []; try { raw = await api.listVideos(ck, r.publicBeeKey) } catch (err) { return { success: false, error: err?.message || String(err), stale: true, videos: [] } }
    return { videos: (raw || []).map((v) => {
      const id = v?.id ? String(v.id) : ''; if (!id) return null
      return {
        id,
        title: v?.title ? String(v.title) : 'Untitled',
        description: v?.description ? String(v.description) : null,
        path: v?.path ? String(v.path) : null,
        duration: Number(v?.duration || 0) || 0,
        thumbnail: v?.thumbnail ? String(v.thumbnail) : null,
        channelKey: v?.channelKey || ck,
        channelName: v?.channelName ? String(v.channelName) : '',
        size: Number(v?.size || 0) || 0,
        uploadedAt: Number(v?.uploadedAt || v?.createdAt || 0) || 0,
        createdAt: Number(v?.createdAt || v?.uploadedAt || Date.now()) || 0,
        views: Number(v?.views || 0) || 0,
        category: v?.category ? String(v.category) : null,
        blobId: v?.blobId ? String(v.blobId) : null,
        blobsCoreKey: v?.blobsCoreKey ? String(v.blobsCoreKey) : null,
        mimeType: v?.mimeType ? String(v.mimeType) : null,
        availability: v?.availability ? String(v.availability) : null,
        byteAvailability: v?.byteAvailability ? String(v.byteAvailability) : null,
        hasHeadBlock: Boolean(v?.hasHeadBlock),
        contiguousBlocks: Number(v?.contiguousBlocks || 0) || 0,
        readyForPlayback: Boolean(v?.readyForPlayback),
        playbackSupport: v?.playbackSupport ? String(v.playbackSupport) : null,
        thumbnailBlobId: v?.thumbnailBlobId ? String(v.thumbnailBlobId) : null,
        thumbnailBlobsCoreKey: v?.thumbnailBlobsCoreKey ? String(v.thumbnailBlobsCoreKey) : null,
        thumbnailMimeType: v?.thumbnailMimeType ? String(v.thumbnailMimeType) : null,
        publicBeeKey: v?.publicBeeKey ? String(v.publicBeeKey) : (r?.publicBeeKey ? String(r.publicBeeKey) : null),
      }
    }).filter(Boolean) }
  }
  B.getVideoUrl = async (r) => {
    const res = await api.getVideoUrl(
      r.channelKey,
      r.videoId,
      r.publicBeeKey,
      r.blobId,
      r.blobsCoreKey,
      r.mimeType
    )
    return { url: res.url }
  }
  B.preparePlayback = async (r) => {
    const prepared = await api.preparePlayback(
      r.channelKey,
      r.videoId,
      r.publicBeeKey,
      r.blobId,
      r.blobsCoreKey,
      r.mimeType
    )
    // Optional OS-native-player compatibility layer: when the backend was given
    // a `castTranscoder` + `player`, route codecs the player can't decode through
    // a local-HLS transcode. Best-effort — any failure keeps the direct URL.
    if (castTranscoder && player && prepared?.url && shouldResolveNativeCompat(player, prepared.url)) {
      try {
        const sourceKey = r.blobsCoreKey && r.blobId ? `${r.blobsCoreKey}:${r.blobId}` : null
        const compat = await resolveCompatPlaybackUrl({
          player,
          directUrl: prepared.url,
          sourceKey,
          castTranscoder,
        })
        if (compat?.transcoded && compat.url) {
          return { ...prepared, url: compat.url, compatTranscoded: true, compatMode: compat.mode }
        }
      } catch { /* best-effort: fall through to the direct URL */ }
    }
    return prepared
  }
  B.setPlaybackActive = async (r = {}) => api.setPlaybackActive(r)
  B.startLivestream = async (r = {}) => api.startLivestream(r)
  B.stopLivestream = async (r) => api.stopLivestream(r.videoId)
  B.getLivestreamStatus = async (r) => api.getLivestreamStatus(r.videoId)
  B.prepareLivePlayback = async (r) => api.prepareLivePlayback(r.liveCoreKey)
  B.getVideoData = async (r) => ({ video: (await api.getVideoData(r.channelKey, r.videoId, r.publicBeeKey, r.blobId, r.blobsCoreKey, r.mimeType)) || { id: r.videoId, title: 'Unknown' } })
  B.getVideoMetadata = async (r) => ({ video: (await api.getVideoData(r.channelKey, r.videoId)) || { id: r.videoId, title: 'Unknown' } })
  // ensureLocal: download the thumbnail blocks before returning the blob-server
  // HTTP URL. Android image clients are much less tolerant than ExoPlayer of a
  // response that stalls while Hypercore fetches blocks, but the product path
  // should still be the same loopback blob server desktop/video use — not a
  // data: URL or filesystem cache workaround.
  B.getVideoThumbnail = async (r) => { const res = await api.getVideoThumbnail(r.channelKey, r.videoId, { thumbnailBlobId: r.thumbnailBlobId || null, thumbnailBlobsCoreKey: r.thumbnailBlobsCoreKey || null, thumbnailMimeType: r.thumbnailMimeType || null }, { ensureLocal: true }); return { url: res.url || null, exists: res.exists || false, dataUrl: null } }
  B.setVideoThumbnail = async () => ({ success: false, error: 'setVideoThumbnail is disabled. Use setVideoThumbnailFromFile.' })
  B.deleteVideo = async (r) => {
    let ch; try { ch = await identityManager.getActiveChannel?.() } catch (e) { return { success: false, error: e?.message } }
    if (!ch) return { success: false, error: 'No active channel' }; if (!ch.writable) return { success: false, error: 'Channel is read-only' }
    try { await ch.deleteVideo(r.videoId); return { success: true } } catch (e) { return { success: false, error: e?.message } }
  }
  B.prefetchVideo = async (r) => api.prefetchVideo(r.channelKey, r.videoId, r.publicBeeKey)
  B.getVideoStats = async (r) => ({ stats: { videoId: r.videoId, channelKey: r.channelKey, ...(await api.getVideoStats(r.channelKey, r.videoId) || {}) } })

  B.subscribeChannel = async (r) => { await api.subscribeChannel(r.channelKey); return { success: true } }
  B.unsubscribeChannel = async (r) => { await api.unsubscribeChannel(r.channelKey); return { success: true } }
  B.getSubscriptions = async () => { const s = await api.getSubscriptions(); return { subscriptions: s.map(i => ({ channelKey: i.driveKey, channelName: i.name })) } }
  B.joinChannel = async (r) => { await api.subscribeChannel(r.channelKey); return { success: true } }

  B.getPublicFeed = async () => {
    const r = await api.getPublicFeed()
    const entries = Array.isArray(r?.entries) ? r.entries : []
    const stats = r?.stats && typeof r.stats === 'object' ? r.stats : {}
    const visibleEntries = entries.length
    const feedConnections = Number(stats.feedConnections ?? stats.peerCount ?? 0) || 0
    return {
      entries: entries.map(e => ({
        channelKey: e.driveKey || e.channelKey,
        driveKey: e.driveKey || e.channelKey,
        source: e.source || 'peer',
        publicBeeKey: e.publicBeeKey || null,
        channelName: e.channelName || e.name || null,
        videoCount: e.videoCount || 0,
        peerCount: e.peerCount || 0,
        lastSeen: e.lastSeen || 0,
        manifestUpdatedAt: e.manifestUpdatedAt || 0,
        isLive: Array.isArray(e.liveStreams) && e.liveStreams.length > 0,
        liveStreams: Array.isArray(e.liveStreams) ? e.liveStreams.map((s) => ({
          videoId: s.videoId,
          liveCoreKey: s.liveCoreKey,
          title: s.title || null,
          startedAt: Number(s.startedAt || 0) || 0,
        })) : [],
        previewVideos: Array.isArray(e.previewVideos) ? e.previewVideos.map((v) => ({
          ...v,
          byteAvailability: v?.byteAvailability ?? null,
          hasHeadBlock: Boolean(v?.hasHeadBlock),
          contiguousBlocks: Number(v?.contiguousBlocks || 0) || 0,
          readyForPlayback: Boolean(v?.readyForPlayback),
        })) : [],
      })),
      stats: {
        ...stats,
        peerCount: feedConnections,
        feedConnections,
        feedEntries: Number(stats.feedEntries ?? stats.totalEntries ?? visibleEntries) || visibleEntries,
        totalEntries: Number(stats.totalEntries ?? visibleEntries) || visibleEntries,
        channelsLoaded: Number(stats.channelsLoaded ?? visibleEntries) || visibleEntries,
      },
    }
  }
  B.getCanonicalFeed = B.getPublicFeed
  B.refreshFeed = async () => { await api.refreshFeed(); return { success: true } }
  B.submitToFeed = async () => {
    const a = identityManager.getActiveIdentity();
    if (!a?.driveKey) return { success: false, error: 'No active channel to publish' }
    return api.submitToFeed(a.driveKey)
  }
  B.unpublishFromFeed = async () => { const a = identityManager.getActiveIdentity(); if (a?.driveKey) await api.unpublishFromFeed(a.driveKey); return { success: true } }
  B.isChannelPublished = async () => { const a = identityManager.getActiveIdentity(); return a?.driveKey ? api.isChannelPublished(a.driveKey) : { published: false } }
  B.hideChannel = async (r) => { await api.hideChannel(r.channelKey); return { success: true } }

  B.getStatus = async () => ({ status: { ready: true, hasIdentity: identityManager.getActiveIdentity() !== null, blobServerPort: ctx.blobServer?.port || ctx.blobServerPort || 0 } })
  B.getBlobServerPort = async () => ({ port: ctx.blobServer?.port || ctx.blobServerPort || 0 })
  B.getSwarmStatus = async () => {
    const s = await api.getSwarmStatus()
    return {
      connected: s.swarmConnections > 0,
      peerCount: s.swarmConnections || 0,
      swarmConnections: s.swarmConnections || 0,
      swarmPeers: s.swarmPeers || 0,
      feedConnections: s.feedConnections || 0,
      feedEntries: s.feedEntries || 0,
      channelsLoaded: s.channelsLoaded || 0,
      swarmOffline: Boolean(s.swarmOffline),
      swarmOfflineReason: s.swarmOfflineReason ?? null,
      swarmListenResolved: Boolean(s.swarmListenResolved),
      peerPoolJoined: Boolean(s.peerPoolJoined),
      publicFeedDiscoveryJoined: Boolean(s.publicFeedDiscoveryJoined),
      feedTopicHex: s.feedTopicHex ?? null,
      networkJson: safeJson(s.network),
      startupTimingJson: safeJson(s.startupTiming),
      doctorJson: safeJson(s.doctor),
      directPeerDialJson: safeJson(s.doctor?.feed?.directPeerDial),
      recommendedBoundary: s.recommendedBoundary ?? s.doctor?.recommendedBoundary ?? null,
      network: s.network ?? null,
      startupTiming: s.startupTiming ?? null,
      doctor: s.doctor ?? null,
      directPeerDial: s.doctor?.feed?.directPeerDial ?? null,
    }
  }

  B.getSeedingStatus = async () => normalizeSeedingStatus(await api.getSeedingStatus())
  B.setSeedingConfig = async (r) => { await api.setSeedingConfig(r.config || {}); return { success: true } }
  B.pinChannel = async (r) => api.pinChannel(r.channelKey)
  B.unpinChannel = async (r) => api.unpinChannel(r.channelKey)
  B.getPinnedChannels = async () => ({ channels: (await api.getPinnedChannels()).channels || [] })
  B.getStorageStats = async () => api.getStorageStats()
  B.setStorageLimit = async (r) => api.setStorageLimit(r.maxGB)
  B.clearCache = async () => api.clearCache()
  B.assessUploadOffload = async (r) => api.assessUploadOffload(r.channelKey, r.videoId)
  B.offloadUpload = async (r) => api.offloadUpload(r.channelKey, r.videoId)

  B.getTranscodeSettings = async () => api.getTranscodeSettings()
  B.setTranscodeSettings = async (r) => api.setTranscodeSettings(r || {})

  B.createDeviceInvite = async (r) => ({ inviteCode: (await api.createDeviceInvite(r.channelKey)).inviteCode })
  B.pairDevice = async (r) => {
    const res = await api.pairDevice(r.inviteCode, r.deviceName || '')
    try { const ex = identityManager.getIdentities?.() || []; if (ex.length === 0 && res?.channelKey) await identityManager.addPairedChannelIdentity?.(res.channelKey, 'Paired Channel') } catch {}
    return { success: Boolean(res.success), channelKey: res.channelKey }
  }
  B.listDevices = async (r) => ({ devices: (await api.listDevices(r.channelKey)).devices || [] })

  B.addComment = async (r) => { try { const res = await api.addComment?.(r.channelKey, r.videoId, r.text, r.parentId, r.publicBeeKey); return { success: Boolean(res?.success), commentId: res?.commentId || null, queued: false, error: res?.error || null } } catch (e) { return { success: false, error: e?.message } } }
  B.listComments = async (r) => {
    try {
      const res = await api.listComments?.(r.channelKey, r.videoId, { page: r.page || 0, limit: r.limit || 50, publicBeeKey: r.publicBeeKey })
      const comments = ((res?.comments) || []).map((c) => ({ videoId: String(c?.videoId || r.videoId || ''), commentId: String(c?.commentId || c?.id || ''), text: String(c?.text || ''), authorKeyHex: String(c?.authorKeyHex || c?.author || ''), timestamp: typeof c?.timestamp === 'number' ? c.timestamp : 0, parentId: c?.parentId ? String(c.parentId) : null, isAdmin: Boolean(c?.isAdmin) })).filter((c) => Boolean(c.videoId && c.commentId))
      return { success: Boolean(res?.success), comments, error: res?.error || null }
    } catch (e) { return { success: false, comments: [], error: e?.message } }
  }
  B.hideComment = async (r) => { try { const res = await api.hideComment?.(r.channelKey, r.videoId, r.commentId, r.publicBeeKey); return { success: Boolean(res?.success), error: res?.error || null } } catch (e) { return { success: false, error: e?.message } } }
  B.removeComment = async (r) => { try { const res = await api.removeComment?.(r.channelKey, r.videoId, r.commentId, r.publicBeeKey); return { success: Boolean(res?.success), queued: false, error: res?.error || null } } catch (e) { return { success: false, queued: false, error: e?.message } } }

  B.addReaction = async (r) => { try { const res = await api.addReaction?.(r.channelKey, r.videoId, r.reactionType, r.publicBeeKey); return { success: Boolean(res?.success), queued: false, error: res?.error || null } } catch (e) { return { success: false, queued: false, error: e?.message } } }
  B.removeReaction = async (r) => { try { const res = await api.removeReaction?.(r.channelKey, r.videoId, r.publicBeeKey); return { success: Boolean(res?.success), queued: false, error: res?.error || null } } catch (e) { return { success: false, queued: false, error: e?.message } } }
  B.getReactions = async (r) => {
    try {
      const res = await api.getReactions?.(r.channelKey, r.videoId, r.publicBeeKey)
      const counts = Object.entries((res?.counts && typeof res.counts === 'object') ? res.counts : {}).map(([t, c]) => ({ reactionType: String(t), count: typeof c === 'number' ? c : 0 }))
      return { success: Boolean(res?.success), counts, userReaction: res?.userReaction || null, error: res?.error || null }
    } catch (e) { return { success: false, counts: [], error: e?.message } }
  }

  B.pickVideoFile = async () => ({ filePath: null, cancelled: true })
  B.pickImageFile = async () => ({ filePath: null, cancelled: true })

  B.eventReady = () => {}; B.eventError = () => {}
  B.eventCastDeviceFound = () => {}; B.eventCastDeviceLost = () => {}
  B.eventCastPlaybackState = () => {}; B.eventCastTimeUpdate = () => {}
  B.eventUploadProgress = () => {}; B.eventFeedUpdate = () => {}
  B.eventLog = () => {}
  B.eventVideoStats = (data) => {
    try { rpc.eventVideoStats?.(data) } catch {}
  }
  B.eventTranscodeProgress = () => {}

  B.uploadVideo = async (r) => {
    const active = identityManager.getActiveIdentity()
    if (!active?.driveKey) throw new Error('No active identity')
    const channel = await identityManager.getActiveChannel?.()
    if (!channel?.blobs) throw new Error('Channel blobs not initialized')
    let filePath = r.filePath; if (!filePath) throw new Error('No file path provided')
    if (filePath.startsWith('file://')) filePath = filePath.slice(7)
    const ext = filePath.split('.').pop()?.toLowerCase() || 'mp4'
    const mimeType = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', avi: 'video/x-msvideo' }[ext] || 'video/mp4'
    const result = await uploadManager.uploadFromPath(channel, filePath, { title: r.title, description: r.description || '', mimeType, category: r.category || '' }, fs, (progress, bytesWritten, totalBytes, stats) => {
      rpc.eventUploadProgress({ videoId: 'upload', progress, bytesUploaded: bytesWritten, totalBytes, speed: stats?.speed ? Math.max(0, Math.round(stats.speed)) : 0, eta: stats?.eta ? Math.max(0, Math.round(stats.eta)) : 0 })
    })
    if (!result?.success) throw new Error(result?.error || 'Upload failed')
    try { api.invalidateChannelCaches?.(active.driveKey) } catch {}
    if (result?.videoId && !r.skipThumbnailGeneration) {
      try { const t = await generateAndStoreThumbnail(filePath, result.videoId, channel, { frameIndex: 300 }); if (t?.thumbnailBlobId) await channel.updateVideo(result.videoId, { thumbnailBlobId: t.thumbnailBlobId, thumbnailBlobsCoreKey: t.thumbnailBlobsCoreKey, thumbnailMimeType: t.thumbnailMimeType }) } catch {}
    }
    await refreshPublishedChannelFeed(active.driveKey)
    return { video: { id: result?.videoId || '', title: r.title, description: r.description || '', channelKey: active.driveKey } }
  }

  B.downloadVideo = async (r) => {
    try {
      const meta = await api.getVideoData(r.channelKey, r.videoId, r.publicBeeKey)
      if (!meta) return { success: false, error: 'Video metadata not found' }
      const title = (meta.title || 'video').replace(/[^a-zA-Z0-9\s\-_]/g, '').replace(/\s+/g, '_').slice(0, 50)
      const ext = meta.mimeType?.includes('webm') ? 'webm' : meta.mimeType?.includes('mkv') ? 'mkv' : 'mp4'
      const downloadsDir = path.join(deps.storagePath, 'Downloads')
      try { fs.statSync(downloadsDir) } catch { fs.mkdirSync(downloadsDir) }
      const destPath = r.destPath || path.join(downloadsDir, `${title}_${r.videoId}.${ext}`)
      const result = await api.downloadVideo(r.channelKey, r.videoId, destPath, fs, (progress, bytesWritten, totalBytes) => {
        try { rpc.eventDownloadProgress({ id: `${r.channelKey}:${r.videoId}`, progress, bytesDownloaded: bytesWritten, totalBytes }) } catch {}
      })
      return result?.success ? { success: true, filePath: destPath, size: result.size || 0 } : { success: false, error: result?.error || 'Download failed' }
    } catch (err) { return { success: false, error: err?.message } }
  }

  B.setVideoThumbnailFromFile = async (r) => {
    const a = identityManager.getActiveIdentity(); if (!a?.driveKey) return { success: false, error: 'No active identity' }
    const ch = await identityManager.getActiveChannel?.(); if (!ch?.blobs) return { success: false, error: 'Channel blobs not initialized' }
    let fp = r.filePath; if (!fp) return { success: false, error: 'No file path provided' }
    if (fp.startsWith('file://')) fp = fp.slice(7)
    try {
      const buf = fs.readFileSync(fp); const ext = path.extname(fp).toLowerCase()
      const mime = ext === '.webp' ? 'image/webp' : (ext === '.png' ? 'image/png' : 'image/jpeg')
      const res = await uploadManager.setThumbnailFromBuffer(ch, r.videoId, buf, mime)
      try { api.invalidateChannelCaches?.(a.driveKey) } catch {}
      return { success: res.success, error: res.error }
    } catch (err) { return { success: false, error: err?.message } }
  }

  B.transcodeStart = async (r) => {
    try {
      const onProgress = (sid, pct) => { try { rpc.eventTranscodeProgress?.({ sessionId: sid, percent: pct, bytesWritten: 0 }) } catch {} }
      const res = await transcoder.startTranscode(r.sourceUrl, { duration: r.duration || 0, title: r.title || '', onProgress })
      return { success: res.success, sessionId: res.sessionId || '', transcodeUrl: res.transcodeUrl || '', error: res.error || '' }
    } catch (err) { return { success: false, error: err?.message } }
  }
  B.transcodeStop = async (r) => { try { const res = await transcoder.stopTranscode(r.sessionId); return { success: res.success, error: res.error || '' } } catch (err) { return { success: false, error: err?.message } } }
  B.transcodeStatus = async (r) => { try { const s = await transcoder.getStatus(r.sessionId); return { status: s.status || '', progress: s.progress || 0, bytesWritten: s.bytesWritten || 0, error: s.error || '' } } catch (err) { return { status: 'error', progress: 0, bytesWritten: 0, error: err?.message } } }

  B.globalSearchVideos = async (r) => {
    try { const raw = await api.globalSearchVideos(r.query, { topK: r.topK || 20 }); return { results: (raw || []).map((i) => ({ id: String(i.id || ''), score: i.score != null ? String(i.score) : null, metadata: i.metadata ? JSON.stringify(i.metadata) : null })) } }
    catch { return { results: [] } }
  }
}
