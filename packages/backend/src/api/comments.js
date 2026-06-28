// Comments & reactions API group, extracted from api.js.
// Methods are spread into the main api object, so `this` resolves to that
// object (e.g. `this._getCommentsAutobase`, which stays defined in api.js).

export function createCommentsApi({ refreshSearchIndex }) {
  return {
    /**
     * Add a comment to a video
     * @param {string} channelKey
     * @param {string} videoId
     * @param {string} text
     * @param {string} [parentId]
     * @param {string} [publicBeeKey]
     * @returns {Promise<{success: boolean, commentId?: string, error?: string}>}
     */
    async addComment(channelKey, videoId, text, parentId = null, publicBeeKey = null) {
      // SYNC LOG - this should ALWAYS appear immediately
      console.log('[API] ====== addComment ENTERED ======')
      console.log('[API] addComment: channelKey:', channelKey?.slice(0, 16), 'videoId:', videoId?.slice(0, 16), 'publicBeeKey:', publicBeeKey?.slice(0, 16) || 'null')

      try {
        console.log('[API] addComment: loading HyperDB channel comments...')
        const channel = await this._getCommentsAutobase(channelKey, publicBeeKey)
        if (!channel?.comments) throw new Error('Comments not initialized')
        const result = await channel.comments.addComment(videoId, text, parentId)
        console.log('[API] addComment: comment added:', result.commentId?.slice(0, 8))
        await refreshSearchIndex(channelKey, videoId, { publicBeeKey })
        return { success: true, commentId: result.commentId, queued: false }
      } catch (err) {
        console.error('[API] addComment error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * List comments for a video
     * @param {string} channelKey
     * @param {string} videoId
     * @param {Object} [options]
     * @param {number} [options.page=0]
     * @param {number} [options.limit=50]
     * @param {string} [options.publicBeeKey]
     * @returns {Promise<{comments: Array, success: boolean, error?: string}>}
     */
    async listComments(channelKey, videoId, options = {}) {
      try {
        const channel = await this._getCommentsAutobase(channelKey, options.publicBeeKey)
        if (!channel?.comments) throw new Error('Comments not initialized')
        const comments = await channel.comments.listComments(videoId, options)
        return { success: true, comments }
      } catch (err) {
        console.error('[API] listComments error:', err.message)
        return { success: false, comments: [], error: err.message }
      }
    },

    /**
     * Hide a comment (moderator action)
     * @param {string} channelKey
     * @param {string} videoId
     * @param {string} commentId
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async hideComment(channelKey, videoId, commentId, publicBeeKey = null) {
      try {
        const channel = await this._getCommentsAutobase(channelKey, publicBeeKey)
        if (!channel?.comments) throw new Error('Comments not initialized')
        await channel.comments.hideComment(videoId, commentId)
        await refreshSearchIndex(channelKey, videoId, { publicBeeKey })
        return { success: true }
      } catch (err) {
        console.error('[API] hideComment error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Remove a comment (moderator or author)
     * @param {string} channelKey
     * @param {string} videoId
     * @param {string} commentId
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async removeComment(channelKey, videoId, commentId, publicBeeKey = null) {
      try {
        const channel = await this._getCommentsAutobase(channelKey, publicBeeKey)
        if (!channel?.comments) throw new Error('Comments not initialized')
        await channel.comments.removeComment(videoId, commentId)
        await refreshSearchIndex(channelKey, videoId, { publicBeeKey })
        return { success: true }
      } catch (err) {
        console.error('[API] removeComment error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ============================================
    // Reactions Operations (HyperDB channel-backed)
    // ============================================

    /**
     * Add a reaction to a video
     * @param {string} channelKey
     * @param {string} videoId
     * @param {string} reactionType
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async addReaction(channelKey, videoId, reactionType, publicBeeKey = null) {
      try {
        const channel = await this._getCommentsAutobase(channelKey, publicBeeKey)
        if (!channel?.reactions) throw new Error('Reactions not initialized')
        await channel.reactions.addReaction(videoId, reactionType)
        return { success: true }
      } catch (err) {
        console.error('[API] addReaction error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Remove a reaction from a video
     * @param {string} channelKey
     * @param {string} videoId
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async removeReaction(channelKey, videoId, publicBeeKey = null) {
      try {
        const channel = await this._getCommentsAutobase(channelKey, publicBeeKey)
        if (!channel?.reactions) throw new Error('Reactions not initialized')
        await channel.reactions.removeReaction(videoId)
        return { success: true }
      } catch (err) {
        console.error('[API] removeReaction error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Get reactions for a video
     * @param {string} channelKey
     * @param {string} videoId
     * @returns {Promise<{counts: Record<string, number>, userReaction: string|null, success: boolean, error?: string}>}
     */
    async getReactions(channelKey, videoId, publicBeeKey = null) {
      try {
        const channel = await this._getCommentsAutobase(channelKey, publicBeeKey)
        if (!channel?.reactions) throw new Error('Reactions not initialized')
        const result = await channel.reactions.getReactions(videoId)
        return { success: true, counts: result.counts || {}, userReaction: result.userReaction || null }
      } catch (err) {
        console.error('[API] getReactions error:', err.message)
        return { success: false, counts: {}, userReaction: null, error: err.message }
      }
    },
  }
}
