/**
 * Reactions Manager
 *
 * Manages reactions (likes, dislikes, emojis) for videos in a multi-writer channel.
 * Reactions are stored in Autobase and aggregated in the view.
 */

import b4a from 'b4a'
import { prefixedKey } from './util.js'

const CURRENT_SCHEMA_VERSION = 1

/**
 * Reactions manager for a multi-writer channel
 */
export class ReactionsManager {
  /**
   * @param {import('./multi-writer-channel.js').MultiWriterChannel} channel - Parent channel
   */
  constructor(channel) {
    this.channel = channel
  }

  /**
   * Add a reaction to a video
   * @param {string} videoId - Video ID
   * @param {string} reactionType - Reaction type (e.g., 'like', 'dislike', 'heart', etc.)
   * @returns {Promise<{success: boolean}>}
   */
  async addReaction(videoId, reactionType) {
    if (!reactionType || typeof reactionType !== 'string') {
      throw new Error('Reaction type is required')
    }

    const authorKeyHex = this.channel.localWriterKeyHex
    if (!authorKeyHex) {
      throw new Error('Channel not ready')
    }

    await this.channel.appendOp({
      type: 'add-reaction',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      videoId,
      reactionType,
      authorKeyHex,
      timestamp: Date.now()
    })

    // Wait for the view to be updated
    await this.channel.base.update()

    return { success: true }
  }

  /**
   * Remove a reaction from a video
   * @param {string} videoId - Video ID
   * @returns {Promise<{success: boolean}>}
   */
  async removeReaction(videoId) {
    const authorKeyHex = this.channel.localWriterKeyHex
    if (!authorKeyHex) {
      throw new Error('Channel not ready')
    }

    await this.channel.appendOp({
      type: 'remove-reaction',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      videoId,
      authorKeyHex
    })

    // Wait for the view to be updated
    await this.channel.base.update()

    return { success: true }
  }

  /**
   * Get reactions for a video
   * @param {string} videoId - Video ID
   * @returns {Promise<{counts: Record<string, number>, userReaction: string|null}>}
   */
  async getReactions(videoId) {
    // Wait for peer connections if swarm available but no peers yet
    const swarm = this.channel.swarm
    if (swarm && swarm.connections?.size === 0) {
      await new Promise(resolve => setTimeout(resolve, 1500))
    }

    // Ensure view is up to date with longer timeout
    try {
      await Promise.race([
        this.channel.base.update({ wait: true }),
        new Promise((resolve) => setTimeout(resolve, 5000)) // Increased from 1s
      ])
    } catch {}

    const prefix = prefixedKey('reactions', `${videoId}/`)
    const start = `${prefix}`
    const end = `${prefix}\xff`

    const counts = {}
    let userReaction = null
    const authorKeyHex = this.channel.localWriterKeyHex

    for await (const { key, value } of this.channel.view.createReadStream({ gt: start, lt: end })) {
      if (value && value.reactionType) {
        counts[value.reactionType] = (counts[value.reactionType] || 0) + 1

        // Check if this is the current user's reaction
        if (authorKeyHex && value.authorKeyHex === authorKeyHex) {
          userReaction = value.reactionType
        }
      }
    }

    return { counts, userReaction }
  }

  /**
   * Get reaction counts for multiple videos
   * @param {string[]} videoIds - Array of video IDs
   * @returns {Promise<Record<string, {counts: Record<string, number>, userReaction: string|null}>>}
   */
  async getReactionsBatch(videoIds) {
    // Ensure view is up to date
    try {
      await Promise.race([
        this.channel.base.update(),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ])
    } catch {}

    const results = {}
    const authorKeyHex = this.channel.localWriterKeyHex

    for (const videoId of videoIds) {
      results[videoId] = { counts: {}, userReaction: null }
    }

    // Scan all reactions
    const prefix = prefixedKey('reactions', '')
    const start = `${prefix}`
    const end = `${prefix}\xff`

    for await (const { key, value } of this.channel.view.createReadStream({ gt: start, lt: end })) {
      if (value && value.videoId && value.reactionType) {
        const videoId = value.videoId
        if (results[videoId]) {
          results[videoId].counts[value.reactionType] = (results[videoId].counts[value.reactionType] || 0) + 1

          // Check if this is the current user's reaction
          if (authorKeyHex && value.authorKeyHex === authorKeyHex) {
            results[videoId].userReaction = value.reactionType
          }
        }
      }
    }

    return results
  }
}
