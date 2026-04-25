/**
 * Watch Event Logging
 *
 * Logs watch events for videos to enable recommendation generation.
 * Events are stored locally and optionally shared (with privacy controls).
 */

import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { prefixedKey } from '../channel/util.js'

const CURRENT_SCHEMA_VERSION = 1

/**
 * Watch event logger for a multi-writer channel
 */
export class WatchEventLogger {
  /**
   * @param {import('../channel/multi-writer-channel.js').MultiWriterChannel} channel - Parent channel
   */
  constructor(channel) {
    this.channel = channel
    this.localEvents = [] // Local event cache (not shared)
  }

  /**
   * Log a watch event
   * @param {string} videoId - Video ID
   * @param {Object} [options]
   * @param {number} [options.duration] - Watch duration in seconds
   * @param {boolean} [options.completed] - Whether video was completed
   * @param {boolean} [options.share=false] - Whether to share this event (privacy control)
   * @returns {Promise<{success: boolean}>}
   */
  async logWatchEvent(videoId, options = {}) {
    const { duration = 0, completed = false, share = false } = options

    const watcherKeyHex = this.channel.localWriterKeyHex
    if (!watcherKeyHex) {
      throw new Error('Channel not ready')
    }

    const eventId = b4a.toString(crypto.randomBytes(16), 'hex')
    const now = Date.now()
    const event = {
      eventId,
      videoId,
      channelKey: this.channel.keyHex,
      watcherKeyHex,
      duration,
      completed,
      timestamp: now
    }

    // Always store locally
    this.localEvents.push(event)

    // Only share if explicitly requested (privacy by default)
    if (share) {
      await this.channel.appendOp({
        type: 'log-watch-event',
        schemaVersion: CURRENT_SCHEMA_VERSION,
        eventId,
        videoId,
        channelKey: this.channel.keyHex,
        watcherKeyHex: null, // Don't share watcher identity
        duration,
        completed,
        timestamp: now
      })
    }

    return { success: true }
  }

  /**
   * Get local watch events
   * @param {Object} [options]
   * @param {string} [options.videoId] - Filter by video ID
   * @param {number} [options.limit] - Limit results
   * @returns {Array}
   */
  getLocalEvents(options = {}) {
    const { videoId, limit } = options
    let events = this.localEvents

    if (videoId) {
      events = events.filter(e => e.videoId === videoId)
    }

    // Sort by timestamp (newest first)
    events.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))

    if (limit) {
      events = events.slice(0, limit)
    }

    return events
  }

  /**
   * Get aggregated watch statistics (for recommendations)
   * @param {string} [videoId] - Filter by video ID
   * @returns {Promise<{totalWatches: number, totalDuration: number, completionRate: number}>}
   */
  async getWatchStats(videoId = null) {
    // Ensure view is up to date
    try {
      await Promise.race([
        this.channel.base.update(),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ])
    } catch {}

    const prefix = prefixedKey('watch-events', videoId ? `${videoId}/` : '')
    const start = `${prefix}`
    const end = `${prefix}\xff`

    let totalWatches = 0
    let totalDuration = 0
    let completedWatches = 0

    for await (const { value } of this.channel.view.createReadStream({ gt: start, lt: end })) {
      if (value && (!videoId || value.videoId === videoId)) {
        totalWatches++
        totalDuration += value.duration || 0
        if (value.completed) {
          completedWatches++
        }
      }
    }

    // Add local events
    const localFiltered = videoId
      ? this.localEvents.filter(e => e.videoId === videoId)
      : this.localEvents

    for (const event of localFiltered) {
      totalWatches++
      totalDuration += event.duration || 0
      if (event.completed) {
        completedWatches++
      }
    }

    const completionRate = totalWatches > 0 ? completedWatches / totalWatches : 0

    return {
      totalWatches,
      totalDuration,
      completionRate,
      averageDuration: totalWatches > 0 ? totalDuration / totalWatches : 0
    }
  }
}
