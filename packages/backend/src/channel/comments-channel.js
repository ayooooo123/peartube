/**
 * Comments Channel Manager
 *
 * Manages comments for videos in a multi-writer channel.
 * Comments are stored in Autobase and materialized into a Hyperbee view.
 */

import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { prefixedKey } from './util.js'

const CURRENT_SCHEMA_VERSION = 1

/**
 * Comments manager for a multi-writer channel
 */
export class CommentsChannel {
  /**
   * @param {import('./multi-writer-channel.js').MultiWriterChannel} channel - Parent channel
   */
  constructor(channel) {
    this.channel = channel
  }

  /**
   * Add a comment to a video
   * @param {string} videoId - Video ID
   * @param {string} text - Comment text
   * @param {string} [parentId] - Parent comment ID for replies
   * @returns {Promise<{commentId: string, success: boolean}>}
   */
  async addComment(videoId, text, parentId = null) {
    if (!text || typeof text !== 'string') {
      throw new Error('Comment text is required')
    }
    if (text.length > 5000) {
      throw new Error('Comment text must be 5000 characters or less')
    }

    const commentId = b4a.toString(crypto.randomBytes(16), 'hex')
    const authorKeyHex = this.channel.localWriterKeyHex
    if (!authorKeyHex) {
      throw new Error('Channel not ready')
    }

    await this.channel.appendOp({
      type: 'add-comment',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      videoId,
      commentId,
      text,
      authorKeyHex,
      timestamp: Date.now(),
      parentId: parentId || null
    })

    // Wait for the view to be updated with the new comment
    await this.channel.base.update()

    return { commentId, success: true }
  }

  /**
   * List comments for a video
   * @param {string} videoId - Video ID
   * @param {Object} [options]
   * @param {number} [options.page=0] - Page number (0-indexed)
   * @param {number} [options.limit=50] - Comments per page
   * @returns {Promise<Array<{commentId: string, text: string, authorKeyHex: string, timestamp: number, parentId: string|null, hidden: boolean}>>}
   */
  async listComments(videoId, options = {}) {
    const { page = 0, limit = 50 } = options

    console.log('[Comments] listComments for videoId:', videoId)

    // Wait for peer connections if swarm available but no peers yet
    // This gives time for replication to start before we read
    const swarm = this.channel.swarm
    if (swarm && swarm.connections?.size === 0) {
      console.log('[Comments] No peers yet, waiting for connections...')
      await new Promise(resolve => setTimeout(resolve, 1500))
      console.log('[Comments] After wait, peers:', swarm.connections?.size || 0)
    }

    // Ensure view is up to date - use longer timeout and wait for remote data
    try {
      console.log('[Comments] Calling base.update with wait:true')
      await Promise.race([
        this.channel.base.update({ wait: true }),
        new Promise((resolve) => setTimeout(resolve, 5000)) // Increased from 2s to 5s
      ])
      console.log('[Comments] base.update complete')
    } catch (err) {
      console.log('[Comments] base.update error:', err?.message)
    }

    const comments = []
    const prefix = prefixedKey('comments', `${videoId}/`)
    const start = `${prefix}`
    const end = `${prefix}\xff`

    console.log('[Comments] Scanning range:', start, '->', end)

    for await (const { value } of this.channel.view.createReadStream({ gt: start, lt: end })) {
      console.log('[Comments] Found comment:', value?.commentId, value?.text?.slice(0, 30))
      if (value && !value.hidden) {
        comments.push(value)
      }
    }

    console.log('[Comments] Total comments found:', comments.length)

    // Sort by timestamp (newest first)
    comments.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))

    // Paginate
    const startIdx = page * limit
    const endIdx = startIdx + limit
    return comments.slice(startIdx, endIdx)
  }

  /**
   * Hide a comment (moderator action)
   * @param {string} videoId - Video ID
   * @param {string} commentId - Comment ID
   * @returns {Promise<{success: boolean}>}
   */
  async hideComment(videoId, commentId) {
    const moderatorKeyHex = this.channel.localWriterKeyHex
    if (!moderatorKeyHex) {
      throw new Error('Channel not ready')
    }

    // Check if user is a moderator
    const writer = await this.channel.view.get(prefixedKey('writers', moderatorKeyHex)).catch(() => null)
    if (!writer?.value || (writer.value.role !== 'moderator' && writer.value.role !== 'owner')) {
      throw new Error('Only moderators can hide comments')
    }

    await this.channel.appendOp({
      type: 'hide-comment',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      videoId,
      commentId,
      moderatorKeyHex,
      timestamp: Date.now()
    })

    // Wait for the view to be updated
    await this.channel.base.update()

    return { success: true }
  }

  /**
   * Remove a comment (moderator or author)
   * @param {string} videoId - Video ID
   * @param {string} commentId - Comment ID
   * @returns {Promise<{success: boolean}>}
   */
  async removeComment(videoId, commentId) {
    const authorKeyHex = this.channel.localWriterKeyHex
    if (!authorKeyHex) {
      throw new Error('Channel not ready')
    }

    // Get comment to check author
    const commentKey = prefixedKey('comments', `${videoId}/${commentId}`)
    const comment = await this.channel.view.get(commentKey).catch(() => null)

    if (!comment?.value) {
      throw new Error('Comment not found')
    }

    // Check if user is moderator or author
    const writer = await this.channel.view.get(prefixedKey('writers', authorKeyHex)).catch(() => null)
    const isModerator = writer?.value && (writer.value.role === 'moderator' || writer.value.role === 'owner')
    const isAuthor = comment.value.authorKeyHex === authorKeyHex

    if (!isModerator && !isAuthor) {
      throw new Error('Only moderators or comment authors can remove comments')
    }

    await this.channel.appendOp({
      type: 'remove-comment',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      videoId,
      commentId,
      moderatorKeyHex: isModerator ? authorKeyHex : null,
      authorKeyHex: isAuthor ? authorKeyHex : null
    })

    // Wait for the view to be updated
    await this.channel.base.update()

    return { success: true }
  }
}
