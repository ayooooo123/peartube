// Live API group, extracted from api.js.
import { createLiveBroadcastService, createLivePlaybackService } from '../live/index.js'

export function createLiveApi({ ctx, publicFeed }) {
  // Live services are lazy: most sessions never broadcast or watch live.
  let liveBroadcast = null
  let livePlayback = null
  function getLiveBroadcast() {
    if (!liveBroadcast) {
      const service = createLiveBroadcastService(ctx)
      ctx?.ownResource?.('live broadcast service', service, 'closeAll', 5000)
      liveBroadcast = service
    }
    return liveBroadcast
  }
  function getLivePlayback() {
    if (!livePlayback) {
      const service = createLivePlaybackService(ctx)
      ctx?.ownResource?.('live playback service', service, 'close', 5000)
      livePlayback = service
    }
    return livePlayback
  }

  // Re-announce the channel's full set of active live sessions on the feed
  // (an empty set clears the live badge network-wide). Best-effort: feed
  // gossip must never fail a broadcast lifecycle call.
  function announceChannelLiveStreams(channelKey) {
    if (!channelKey || !liveBroadcast || typeof publicFeed?.setChannelLiveStreams !== 'function') return
    try {
      const liveStreams = []
      for (const session of liveBroadcast.sessions.values()) {
        if (session.state !== 'live') continue
        if ((session.writer?.descriptor?.channelKey || null) !== channelKey) continue
        liveStreams.push({
          videoId: session.videoId,
          liveCoreKey: session.liveCoreKey,
          title: session.writer?.descriptor?.title || null,
          startedAt: session.startedAt,
        })
      }
      publicFeed.setChannelLiveStreams(channelKey, liveStreams)
    } catch (err) {
      console.log('[API] live feed announce skipped:', err?.message || err)
    }
  }

  function toLivestreamStatus(stats) {
    if (!stats) return undefined
    const status = {
      state: stats.state || 'unknown',
      videoId: stats.videoId || undefined,
      liveCoreKey: stats.liveCoreKey || undefined,
      mediaBlocks: Number(stats.mediaBlocks) || 0,
      durationMs: Math.max(0, Math.round((Number(stats.durationS) || 0) * 1000)),
      peerCount: Number(stats.peerCount) || 0,
      startedAt: Number(stats.startedAt) || 0,
    }
    if (stats.endedAt) status.endedAt = Number(stats.endedAt)
    return status
  }

  return {
    /**
     * Start a live broadcast session on a fresh single-writer core.
     * The fMP4 byte source attaches to the returned session through the
     * broadcast service (platform encoder integrations); this surface only
     * manages lifecycle.
     * @param {{channelKey?: string, title?: string, targetFragmentDurationMs?: number, width?: number, height?: number}} [options]
     * @returns {Promise<{success: boolean, videoId?: string, liveCoreKey?: string, error?: string}>}
     */
    async startLivestream(options = {}) {
      try {
        const targetMs = Number(options.targetFragmentDurationMs)
        const session = await getLiveBroadcast().startBroadcast({
          channelKey: options.channelKey || null,
          title: options.title || null,
          targetFragmentDuration: targetMs > 0 ? targetMs / 1000 : undefined,
          width: Number(options.width) || 0,
          height: Number(options.height) || 0,
        })
        console.log('[API] startLivestream:', session.videoId, 'core:', session.liveCoreKey.slice(0, 16))
        announceChannelLiveStreams(options.channelKey)
        return { success: true, videoId: session.videoId, liveCoreKey: session.liveCoreKey }
      } catch (err) {
        console.error('[API] startLivestream failed:', err?.message || err)
        return { success: false, error: err?.message || String(err) }
      }
    },

    /**
     * Seal a live broadcast: flush the trailing fragment, append the EOS
     * marker, keep seeding the core (it IS the recording).
     * @param {string} videoId
     */
    async stopLivestream(videoId) {
      try {
        const session = getLiveBroadcast().getSession(videoId)
        const stats = await getLiveBroadcast().stopBroadcast(videoId)
        announceChannelLiveStreams(session?.writer?.descriptor?.channelKey)
        return { success: true, status: toLivestreamStatus(stats) }
      } catch (err) {
        return { success: false, error: err?.message || String(err) }
      }
    },

    /**
     * Broadcaster-side status for an active or sealed session.
     * @param {string} videoId
     */
    async getLivestreamStatus(videoId) {
      const session = getLiveBroadcast().getSession(videoId)
      if (!session) return { error: 'No live session: ' + videoId }
      return { status: toLivestreamStatus(session.getStats()) }
    },

    /**
     * Backend-internal (not RPC-exposed): the live session object, for
     * platform encoder integrations to attach a byte source via
     * session.write()/notifyKeyframe().
     * @param {string} videoId
     */
    getLiveBroadcastSession(videoId) {
      return getLiveBroadcast().getSession(videoId)
    },

    /**
     * Resolve a local live-HLS playlist URL for a live core. Works for both
     * in-progress streams (sliding window) and sealed recordings (full DVR).
     * @param {string} liveCoreKey - live core key (hex)
     * @returns {Promise<{url?: string, isLive?: boolean, error?: string}>}
     */
    async prepareLivePlayback(liveCoreKey) {
      try {
        const url = await getLivePlayback().getPlaybackUrl(liveCoreKey)
        return { url, isLive: true }
      } catch (err) {
        return { error: err?.message || String(err) }
      }
    },
  }
}
