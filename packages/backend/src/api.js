import { normalizeEngineVideoId } from './engine-adapter.js'

export function createApi({ ctx = {}, engineAdapter, identityManager } = {}) {
  const subscriptions = new Set()
  const pinned = new Set()
  const hidden = new Set()
  const published = new Set()
  let storageLimitGB = 10
  let transcodeSettings = { videoToolboxDecodeEnabled: false, videoToolboxHwMapEnabled: false }

  const api = {
    async uploadVideo(channelKey, filePath, options = {}) {
      requireEngine(engineAdapter)
      return engineAdapter.uploadVideo(channelKey, filePath, options)
    },

    async listVideos(channelKey) {
      if (!channelKey || !engineAdapter || !(await engineAdapter.hasEngineChannel(channelKey))) return []
      return engineAdapter.listVideos(channelKey)
    },

    async getVideoData(channelKey, videoId) {
      if (!channelKey || !engineAdapter || !(await engineAdapter.hasEngineChannel(channelKey))) return null
      return engineAdapter.getVideoData(channelKey, videoId)
    },

    async getVideoUrl(channelKey, videoId) {
      requireEngine(engineAdapter)
      return engineAdapter.getVideoUrl(channelKey, videoId)
    },

    async preparePlayback(channelKey, videoId) {
      requireEngine(engineAdapter)
      return engineAdapter.preparePlayback(channelKey, videoId)
    },

    async getVideoThumbnail(channelKey, videoId) {
      if (!channelKey || !engineAdapter || !(await engineAdapter.hasEngineChannel(channelKey))) return { exists: false, url: null }
      const engine = await engineAdapter.ensureEngineForUiChannel(channelKey)
      try {
        const url = await engine.thumbnailUrl(normalizeEngineVideoId(videoId))
        return { exists: true, url }
      } catch {
        return { exists: false, url: null }
      }
    },

    async updateVideoMetadata(channelKey, videoId, updates = {}) {
      if (!channelKey || !engineAdapter || !(await engineAdapter.hasEngineChannel(channelKey))) return { success: false, error: 'Video not found' }
      const engine = await engineAdapter.ensureEngineForUiChannel(channelKey)
      const record = await engine.updateVideo(normalizeEngineVideoId(videoId), updates)
      return { success: true, video: engineAdapter.adaptVideo ? engineAdapter.adaptVideo(record, channelKey) : { ...record, channelKey } }
    },

    async deleteVideo(channelKey, videoId) {
      if (!channelKey || !engineAdapter || !(await engineAdapter.hasEngineChannel(channelKey))) return { success: false, error: 'Video not found' }
      const engine = await engineAdapter.ensureEngineForUiChannel(channelKey)
      return { success: await engine.deleteVideo(normalizeEngineVideoId(videoId)) }
    },

    async setVideoThumbnailFromFile(channelKey, videoId, filePath, { fs, mimeType = 'image/jpeg' } = {}) {
      if (!fs?.readFileSync) return { success: false, error: 'fs.readFileSync unavailable' }
      const engine = await engineAdapter.ensureEngineForUiChannel(channelKey)
      await engine.setVideoThumbnail(normalizeEngineVideoId(videoId), { bytes: fs.readFileSync(filePath), mimeType })
      return { success: true }
    },

    async getChannel(channelKey = '') {
      const active = identityManager?.getActiveIdentity?.()
      const identity = identityManager?.getIdentities?.().find((i) => i.driveKey === channelKey || i.publicKey === channelKey) || active
      if (!identity) return null
      const videos = await this.listVideos(identity.driveKey).catch(() => [])
      return {
        publicKey: identity.driveKey || identity.publicKey,
        name: identity.name || 'PearTube Channel',
        description: identity.description || '',
        avatar: identity.avatar || null,
        videoCount: videos.length,
        subscriberCount: 0
      }
    },

    async updateChannel(channelKey, updates = {}) {
      const result = await identityManager?.updateIdentityByDriveKey?.(channelKey, updates)
      return { success: Boolean(result), channel: await this.getChannel(channelKey), error: result ? null : 'Channel not found' }
    },

    async updateChannelAvatar(channelKey, imageBuffer, mimeType = 'image/jpeg') {
      const avatar = `data:${mimeType};base64,${Buffer.from(imageBuffer || []).toString('base64')}`
      return this.updateChannel(channelKey, { avatar })
    },

    async getChannelMeta(channelKey) {
      const channel = await this.getChannel(channelKey)
      return {
        name: channel?.name || 'PearTube Channel',
        description: channel?.description || '',
        avatar: channel?.avatar || null,
        videoCount: channel?.videoCount || 0
      }
    },

    async getPublicFeed() {
      const identities = identityManager?.getIdentities?.() || []
      const entries = []
      for (const identity of identities) {
        if (!identity?.driveKey || hidden.has(identity.driveKey)) continue
        const videos = await this.listVideos(identity.driveKey).catch(() => [])
        entries.push({
          driveKey: identity.driveKey,
          channelKey: identity.driveKey,
          source: 'local',
          publicBeeKey: null,
          channelName: identity.name || 'PearTube Channel',
          videoCount: videos.length,
          peerCount: 0,
          lastSeen: Date.now(),
          manifestUpdatedAt: Date.now(),
          previewVideos: videos.slice(0, 3),
        })
      }
      return { entries, stats: { totalEntries: entries.length, hiddenCount: hidden.size, peerCount: 0, keyedEntries: entries.length, unkeyedEntries: 0 } }
    },

    async refreshFeed() { return { success: true, requested: 0 } },
    async submitToFeed(channelKey) { if (channelKey) published.add(channelKey); return { success: true } },
    async unpublishFromFeed(channelKey) { published.delete(channelKey); return { success: true } },
    async isChannelPublished(channelKey) { return { published: published.has(channelKey) } },
    async hideChannel(channelKey) { if (channelKey) hidden.add(channelKey); return { success: true } },

    async subscribeChannel(channelKey) { if (channelKey) subscriptions.add(channelKey); return { success: true } },
    async unsubscribeChannel(channelKey) { subscriptions.delete(channelKey); return { success: true } },
    async getSubscriptions() { return [...subscriptions].map((driveKey) => ({ driveKey, name: driveKey.slice(0, 12) })) },

    async prefetchVideo() { return { success: true, cached: false, message: 'Engine playback is sparse/on-demand; prefetch skipped' } },
    getVideoStats(channelKey, videoId) { return { videoId, channelKey, status: 'playable', progress: 1, isComplete: true, peerCount: 0, swarmConnections: 0 } },
    async downloadVideo(channelKey, videoId) { const r = await this.getVideoUrl(channelKey, videoId); return { success: true, filePath: r.url, size: 0 } },

    getSwarmStatus() { return { connected: false, peerCount: 0, swarmConnections: 0, topic: 'engine' } },
    getSeedingStatus() { return { config: { autoSeedWatched: false }, storageUsedBytes: 0, maxStorageGB: storageLimitGB, activeSeeds: 0 } },
    async setSeedingConfig() { return { success: true } },
    async pinChannel(channelKey) { if (channelKey) pinned.add(channelKey); return { success: true } },
    async unpinChannel(channelKey) { pinned.delete(channelKey); return { success: true } },
    getPinnedChannels() { return { channels: [...pinned].map((channelKey) => ({ channelKey })) } },
    getStorageStats() { return { usedBytes: 0, limitBytes: storageLimitGB * 1024 * 1024 * 1024, maxStorageGB: storageLimitGB } },
    async setStorageLimit(maxGB) { storageLimitGB = Number(maxGB) || storageLimitGB; return { success: true } },
    async clearCache() { return { success: true } },

    getTranscodeSettings() { return transcodeSettings },
    async setTranscodeSettings(settings = {}) { transcodeSettings = { ...transcodeSettings, ...settings }; return transcodeSettings },

    async createDeviceInvite() { return { inviteCode: '' } },
    async pairDevice() { return { success: false, error: 'Device pairing removed in engine v0' } },
    async listDevices() { return { devices: [] } },

    async addComment() { return { success: false, error: 'Comments removed in engine v0' } },
    async listComments() { return { success: true, comments: [] } },
    async hideComment() { return { success: false, error: 'Comments removed in engine v0' } },
    async removeComment() { return { success: false, error: 'Comments removed in engine v0' } },
    async addReaction() { return { success: false, error: 'Reactions removed in engine v0' } },
    async removeReaction() { return { success: false, error: 'Reactions removed in engine v0' } },
    async getReactions() { return { success: true, counts: {}, userReaction: null } },

    async globalSearchVideos(query) { return searchLocal(identityManager, this, query) },
    async searchVideos(channelKey, query) { return (await this.listVideos(channelKey)).filter((v) => matches(v, query)) },
    async indexVideoVectors() { return { success: true, indexed: 0 } },
    async retrySyncChannel() { return { success: true } },
    async logWatchEvent() { return { success: true } },
    async getRecommendations() { return [] },
    async getVideoRecommendations() { return [] },
    invalidateChannelCaches() {},
  }

  return api
}

function requireEngine(engineAdapter) {
  if (!engineAdapter) throw new Error('Engine adapter not initialized')
}

async function searchLocal(identityManager, api, query) {
  const identities = identityManager?.getIdentities?.() || []
  const out = []
  for (const identity of identities) {
    const videos = await api.listVideos(identity.driveKey).catch(() => [])
    for (const video of videos) if (matches(video, query)) out.push({ id: video.id, score: 1, metadata: video })
  }
  return out
}

function matches(video, query = '') {
  const q = String(query || '').toLowerCase()
  if (!q) return true
  return `${video?.title || ''} ${video?.description || ''} ${video?.category || ''}`.toLowerCase().includes(q)
}
