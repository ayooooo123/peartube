/**
 * VideoStatsTracker - Real-time video loading stats
 *
 * Uses Hyperdrive's built-in monitor for efficient event-driven updates.
 * Tracks P2P download progress for video prefetching.
 */

/**
 * @typedef {import('./types.js').VideoStatsData} VideoStatsData
 * @typedef {import('./types.js').VideoStats} VideoStats
 */

let instanceCounter = 0;

export class VideoStatsTracker {
  constructor() {
    /** @type {Map<string, VideoStatsData>} key: `${driveKey}:${videoPath}` -> stats */
    this.videoStats = new Map();
    /** @type {Map<string, {monitor: any, cleanup: () => void}>} key -> monitor data */
    this.videoMonitors = new Map();
    /** @type {((driveKey: string, videoPath: string, stats: VideoStats) => void) | null} */
    this.onStatsUpdate = null;

    this._instanceId = ++instanceCounter;
    console.log('[VideoStats] Initialized, instance #' + this._instanceId);
  }

  /**
   * Set callback for stats updates
   * @param {(driveKey: string, videoPath: string, stats: VideoStats) => void} callback
   */
  setOnStatsUpdate(callback) {
    // Add marker to identify which callback this is
    const marker = callback?._statsMarker || 'unknown';
    console.log('[VideoStats] instance #' + this._instanceId + ' setOnStatsUpdate called, marker:', marker);
    this.onStatsUpdate = callback;
  }

  /**
   * Get stats key from driveKey and videoPath
   * @param {string} driveKey
   * @param {string} videoPath
   * @returns {string}
   */
  getKey(driveKey, videoPath) {
    const normalized = this.normalizeVideoId(videoPath);
    const suffix = normalized || videoPath || '';
    return `${driveKey}:${suffix}`;
  }

  /**
   * Normalize a video identifier for stats keys.
   * Accepts id or path variants like /videos/<id>.mp4 or videos/<id>.mp4.
   * @param {string} videoPath
   * @returns {string}
   */
  normalizeVideoId(videoPath) {
    if (!videoPath) return '';
    const raw = String(videoPath);
    const cleaned = raw.split('?')[0].split('#')[0];
    const match = cleaned.match(/(?:^|\/)videos\/([^.\/]+)(?:\.[^\/]+)?$/);
    if (match?.[1]) return match[1];
    const base = cleaned.split('/').pop() || cleaned;
    return base.replace(/\.[^./]+$/, '');
  }

  /**
   * Update video stats
   * @param {string} driveKey
   * @param {string} videoPath
   * @param {Partial<VideoStatsData>} updates
   */
  updateStats(driveKey, videoPath, updates) {
    const key = this.getKey(driveKey, videoPath);
    const existing = this.videoStats.get(key) || {
      driveKey,
      videoPath,
      status: 'idle',
      totalBlocks: 0,
      downloadedBlocks: 0,
      totalBytes: 0,
      downloadedBytes: 0,
      peerCount: 0,
      startTime: null,
      lastUpdate: Date.now(),
      initialBlocks: 0
    };
    this.videoStats.set(key, { ...existing, ...updates, lastUpdate: Date.now() });
  }

  /**
   * Get video stats for display
   * @param {string} driveKey
   * @param {string} videoPath
   * @returns {VideoStats | null}
   */
  getStats(driveKey, videoPath) {
    const key = this.getKey(driveKey, videoPath);
    const stats = this.videoStats.get(key);
    if (!stats) return null;

    // Get live speeds from monitor if available
    const monitorData = this.videoMonitors.get(key);
    const downloadSpeed = monitorData?.monitor?.downloadSpeed?.() || 0;
    const uploadSpeed = monitorData?.monitor?.uploadSpeed?.() || 0;

    // Calculate progress including initial blocks
    const totalDownloaded = stats.initialBlocks + stats.downloadedBlocks;
    const progress = stats.totalBlocks > 0
      ? Math.round((totalDownloaded / stats.totalBlocks) * 100)
      : 0;
    const elapsed = stats.startTime ? (Date.now() - stats.startTime) / 1000 : 0;

    return {
      status: stats.status,
      progress,
      totalBlocks: stats.totalBlocks,
      downloadedBlocks: totalDownloaded,
      downloadedBytes: Math.round((totalDownloaded / stats.totalBlocks) * stats.totalBytes) || 0,
      totalBytes: stats.totalBytes,
      peerCount: stats.peerCount,
      speedMBps: (downloadSpeed / (1024 * 1024)).toFixed(2),
      uploadSpeedMBps: (uploadSpeed / (1024 * 1024)).toFixed(2),
      elapsed: Math.round(elapsed),
      isComplete: totalDownloaded >= stats.totalBlocks && stats.totalBlocks > 0,
      error: stats.error
    };
  }

  /**
   * Register a monitor for a video
   * @param {string} driveKey
   * @param {string} videoPath
   * @param {any} monitor - Hyperdrive monitor
   * @param {() => void} [cleanup] - Cleanup function
   */
  registerMonitor(driveKey, videoPath, monitor, cleanup) {
    const key = this.getKey(driveKey, videoPath);
    this.videoMonitors.set(key, {
      monitor,
      cleanup: cleanup || (() => {})
    });
  }

  /**
   * Clean up monitor when done
   * @param {string} driveKey
   * @param {string} videoPath
   */
  cleanupMonitor(driveKey, videoPath) {
    const key = this.getKey(driveKey, videoPath);
    const monitorData = this.videoMonitors.get(key);
    if (monitorData) {
      if (monitorData.cleanup) monitorData.cleanup();
      if (monitorData.monitor?.close) {
        monitorData.monitor.close().catch(() => {});
      }
      this.videoMonitors.delete(key);
    }
  }

  /**
   * Emit stats update to callback
   * @param {string} driveKey
   * @param {string} videoPath
   */
  emitStats(driveKey, videoPath) {
    const marker = this.onStatsUpdate?._statsMarker || 'unknown';
    console.log('[VideoStats] instance #' + this._instanceId + ' emitStats, callback marker:', marker);
    if (!this.onStatsUpdate) {
      console.log('[VideoStats] emitStats: no callback set');
      return;
    }
    const stats = this.getStats(driveKey, videoPath);
    if (stats) {
      console.log('[VideoStats] Emitting stats:', stats.progress + '% complete');
      try {
        this.onStatsUpdate(driveKey, videoPath, stats);
      } catch (e) {
        console.log('[VideoStats] Error emitting stats:', e.message);
      }
    } else {
      console.log('[VideoStats] emitStats: no stats found for', videoPath?.slice(0, 30));
    }
  }

  /**
   * Check if a video has stats being tracked
   * @param {string} driveKey
   * @param {string} videoPath
   * @returns {boolean}
   */
  hasStats(driveKey, videoPath) {
    return this.videoStats.has(this.getKey(driveKey, videoPath));
  }

  /**
   * Remove stats for a video
   * @param {string} driveKey
   * @param {string} videoPath
   */
  removeStats(driveKey, videoPath) {
    const key = this.getKey(driveKey, videoPath);
    this.cleanupMonitor(driveKey, videoPath);
    this.videoStats.delete(key);
  }

  /**
   * Clear all stats
   */
  clear() {
    for (const [key] of this.videoMonitors) {
      const [driveKey, videoPath] = key.split(':');
      this.cleanupMonitor(driveKey, videoPath);
    }
    this.videoStats.clear();
    this.videoMonitors.clear();
  }
}
