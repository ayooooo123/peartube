// Recommendations API group, extracted from api.js.
import { Recommender } from '../recommendations/recommender.js'

export function createRecommendationsApi({
  ctx,
  ensureSemanticFinder,
  isMultiWriterChannelKey,
  loadChannel,
}) {
  return {
    /**
     * Log a watch event for recommendations
     * @param {string} channelKey
     * @param {string} videoId
     * @param {Object} [options]
     * @param {number} [options.duration]
     * @param {boolean} [options.completed]
     * @param {boolean} [options.share=false]
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async logWatchEvent(channelKey, videoId, options = {}) {
      try {
        const isMW = await isMultiWriterChannelKey(channelKey)
        if (!isMW) {
          return { success: false, error: 'Watch events only supported for multi-writer channels' }
        }

        const channel = await loadChannel(ctx, channelKey)
        if (!channel.watchLogger) {
          return { success: false, error: 'Watch logger not initialized' }
        }

        await channel.watchLogger.logWatchEvent(videoId, options)
        return { success: true }
      } catch (err) {
        console.error('[API] logWatchEvent error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Get video recommendations
     * @param {string} channelKey
     * @param {Object} [options]
     * @param {number} [options.limit=10]
     * @param {string[]} [options.excludeVideoIds]
     * @returns {Promise<{recommendations: Array, success: boolean, error?: string}>}
     */
    async getRecommendations(channelKey, options = {}) {
      try {
        const isMW = await isMultiWriterChannelKey(channelKey)
        if (!isMW) {
          return { success: false, recommendations: [], error: 'Recommendations only supported for multi-writer channels' }
        }

        const channel = await loadChannel(ctx, channelKey)
        if (!channel.watchLogger) {
          return { success: false, recommendations: [], error: 'Watch logger not initialized' }
        }

        // Ensure semantic finder is initialized with persistence
        await ensureSemanticFinder(ctx)

        // Initialize recommender
        const recommender = new Recommender(channel, ctx.semanticFinder, channel.watchLogger)
        const recommendations = await recommender.generateRecommendations(options)

        return { success: true, recommendations }
      } catch (err) {
        console.error('[API] getRecommendations error:', err.message)
        return { success: false, recommendations: [], error: err.message }
      }
    },

    /**
     * Get recommendations for a specific video
     * @param {string} channelKey
     * @param {string} videoId
     * @param {number} [limit=5]
     * @returns {Promise<{recommendations: Array, success: boolean, error?: string}>}
     */
    async getVideoRecommendations(channelKey, videoId, limit = 5) {
      try {
        const isMW = await isMultiWriterChannelKey(channelKey)
        if (!isMW) {
          return { success: false, recommendations: [], error: 'Recommendations only supported for multi-writer channels' }
        }

        const channel = await loadChannel(ctx, channelKey)

        // Ensure semantic finder is initialized with persistence
        await ensureSemanticFinder(ctx)

        // Initialize recommender (watch logger may be null, that's ok)
        const watchLogger = channel.watchLogger || null
        const recommender = new Recommender(channel, ctx.semanticFinder, watchLogger)
        const recommendations = await recommender.getVideoRecommendations(videoId, limit)

        return { success: true, recommendations }
      } catch (err) {
        console.error('[API] getVideoRecommendations error:', err.message)
        return { success: false, recommendations: [], error: err.message }
      }
    },
  }
}
