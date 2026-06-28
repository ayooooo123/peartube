// Network lifecycle API group, extracted from api.js.
import {
  getNetworkStats,
  getNetworkStatsReadable,
  resumeNetworking,
  setPlaybackActive as storageSetPlaybackActive,
  suspendNetworking,
} from '../storage.js'

export function createNetworkLifecycleApi({
  onPlaybackActive,
  onPlaybackInactive,
} = {}) {
  return {
    /**
     * Suspend networking for mobile background state.
     * Call this when the app goes to background to save battery.
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async suspendNetwork() {
      try {
        await suspendNetworking()
        return { success: true }
      } catch (err) {
        console.error('[API] suspendNetwork error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Resume networking when app returns to foreground.
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async resumeNetwork() {
      try {
        await resumeNetworking()
        return { success: true }
      } catch (err) {
        console.error('[API] resumeNetwork error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Mirror app playback state into the backend so cache cleanup does not
     * clear blob ranges while a player or blob-server reader is active.
     * @param {{active?: boolean, ttlMs?: number}} [options]
     * @returns {{success: boolean, active: boolean, updatedAt: number, expiresAt: number}}
     */
    setPlaybackActive(options = {}) {
      const state = storageSetPlaybackActive(Boolean(options.active), { ttlMs: options.ttlMs })
      // Flush deferred cache eviction when playback ends. enforceQuota() skips
      // every clear while playback is active (isCacheClearBlocked), and its only
      // other trigger — addSeed — fires *during* playback, so the over-quota
      // evictions get deferred and nothing ever re-runs them. Without this hook
      // the seed cache grows unbounded past maxStorageGB.
      //
      // The sweep is debounced and cancelled the moment playback resumes, so
      // rapid open/close, seeking, and pause/resume never trigger eviction.
      if (state.active) {
        onPlaybackActive?.()
      } else {
        onPlaybackInactive?.()
      }
      return { success: true, ...state }
    },

    /**
     * Get network stats for debugging.
     * @returns {{stats: Object|null, readable: string}}
     */
    getNetworkDebugStats() {
      return {
        stats: getNetworkStats(),
        readable: getNetworkStatsReadable()
      }
    },
  }
}
