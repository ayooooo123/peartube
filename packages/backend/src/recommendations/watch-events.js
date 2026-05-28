/**
 * Watch Event Logging
 */

import b4a from 'b4a'
import crypto from 'hypercore-crypto'

export class WatchEventLogger {
  constructor(channel) {
    this.channel = channel
    this.localEvents = []
  }

  async logWatchEvent(videoId, options = {}) {
    const { duration = 0, completed = false, share = false } = options
    const watcherKeyHex = this.channel.localWriterKeyHex
    if (!watcherKeyHex) throw new Error('Channel not ready')
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
    this.localEvents.push(event)
    if (share) {
      await this.channel.addWatchEvent({
        ...event,
        watcherKeyHex: null
      })
    }
    return { success: true }
  }

  getLocalEvents(options = {}) {
    const { videoId, limit } = options
    let events = this.localEvents
    if (videoId) events = events.filter((event) => event.videoId === videoId)
    events = [...events].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    if (limit) events = events.slice(0, limit)
    return events
  }

  async getWatchStats(videoId = null) {
    const sharedEvents = await this.channel.listWatchEvents(videoId)
    const localFiltered = videoId
      ? this.localEvents.filter((event) => event.videoId === videoId)
      : this.localEvents
    const all = [...sharedEvents, ...localFiltered]
    const totalWatches = all.length
    const totalDuration = all.reduce((sum, event) => sum + (event.duration || 0), 0)
    const completedWatches = all.filter((event) => event.completed).length
    return {
      totalWatches,
      totalDuration,
      completionRate: totalWatches > 0 ? completedWatches / totalWatches : 0,
      averageDuration: totalWatches > 0 ? totalDuration / totalWatches : 0
    }
  }
}
