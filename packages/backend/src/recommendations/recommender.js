/**
 * Recommendation Engine
 *
 * Generates video recommendations based on watch patterns, vector similarity, and co-watch patterns.
 */

import { SemanticFinder } from '../search/semantic-finder.js'
import { WatchEventLogger } from './watch-events.js'

/**
 * Recommendation engine
 */
export class Recommender {
  /**
   * @param {import('../channel/multi-writer-channel.js').MultiWriterChannel} channel - Channel instance
   * @param {SemanticFinder} semanticFinder - Semantic finder for vector similarity
   * @param {WatchEventLogger} watchLogger - Watch event logger
   */
  constructor(channel, semanticFinder, watchLogger) {
    this.channel = channel
    this.semanticFinder = semanticFinder
    this.watchLogger = watchLogger
  }

  /**
   * Generate recommendations for a user
   * @param {Object} [options]
   * @param {number} [options.limit=10] - Number of recommendations
   * @param {string[]} [options.excludeVideoIds] - Video IDs to exclude
   * @returns {Promise<Array<{videoId: string, score: number, reason: string}>>}
   */
  async generateRecommendations(options = {}) {
    const { limit = 10, excludeVideoIds = [] } = options

    // Get user's watch history
    const watchEvents = this.watchLogger.getLocalEvents({ limit: 50 })
    const watchedVideoIds = new Set(watchEvents.map(e => e.videoId))

    // Get all videos in channel
    const allVideos = await this.channel.listVideos()
    const candidateVideos = allVideos.filter(v => 
      !watchedVideoIds.has(v.id) && !excludeVideoIds.includes(v.id)
    )

    if (candidateVideos.length === 0) {
      return []
    }

    const recommendations = []

    // Strategy 1: Similar videos (vector similarity)
    if (watchEvents.length > 0 && this.semanticFinder) {
      // Get most recently watched video
      const recentVideo = watchEvents[0]
      const recentVideoData = allVideos.find(v => v.id === recentVideo.videoId)

      if (recentVideoData) {
        const query = `${recentVideoData.title || ''} ${recentVideoData.description || ''}`
        const similar = await this.semanticFinder.search(query, limit * 2)

        for (const result of similar) {
          if (!watchedVideoIds.has(result.id) && !excludeVideoIds.includes(result.id)) {
            recommendations.push({
              videoId: result.id,
              score: result.score * 0.6, // Weight vector similarity
              reason: 'similar_content'
            })
          }
        }
      }
    }

    // Strategy 2: Popular videos (based on watch stats)
    const popularVideos = await this._getPopularVideos(candidateVideos, limit)
    for (const video of popularVideos) {
      if (!recommendations.find(r => r.videoId === video.id)) {
        recommendations.push({
          videoId: video.id,
          score: video.popularityScore * 0.4, // Weight popularity
          reason: 'popular'
        })
      }
    }

    // Strategy 3: Co-watch patterns (videos watched by users who watched similar videos)
    // Simplified: just boost videos from same channel
    for (const video of candidateVideos) {
      if (!recommendations.find(r => r.videoId === video.id)) {
        recommendations.push({
          videoId: video.id,
          score: 0.2, // Base score
          reason: 'channel_content'
        })
      }
    }

    // Deduplicate and sort by score
    const deduplicated = new Map()
    for (const rec of recommendations) {
      const existing = deduplicated.get(rec.videoId)
      if (!existing || existing.score < rec.score) {
        deduplicated.set(rec.videoId, rec)
      } else {
        // Merge scores
        existing.score = (existing.score + rec.score) / 2
      }
    }

    const sorted = Array.from(deduplicated.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    return sorted
  }

  /**
   * Get popular videos based on watch statistics
   * @param {Array} videos - Candidate videos
   * @param {number} limit - Number of videos to return
   * @returns {Promise<Array<{id: string, popularityScore: number}>>}
   */
  async _getPopularVideos(videos, limit) {
    const statsPromises = videos.map(async (video) => {
      const stats = await this.watchLogger.getWatchStats(video.id)
      return {
        id: video.id,
        popularityScore: stats.totalWatches * 0.5 + stats.completionRate * 0.5
      }
    })

    const stats = await Promise.all(statsPromises)
    return stats
      .sort((a, b) => b.popularityScore - a.popularityScore)
      .slice(0, limit)
  }

  /**
   * Get recommendations for a specific video
   * @param {string} videoId - Video ID
   * @param {number} [limit=5] - Number of recommendations
   * @returns {Promise<Array<{videoId: string, score: number, reason: string}>>}
   */
  async getVideoRecommendations(videoId, limit = 5) {
    const video = await this.channel.getVideo(videoId)
    if (!video) {
      return []
    }

    // Use semantic similarity
    if (this.semanticFinder) {
      const query = `${video.title || ''} ${video.description || ''}`
      const similar = await this.semanticFinder.search(query, limit + 1) // +1 to exclude self

      return similar
        .filter(r => r.id !== videoId)
        .slice(0, limit)
        .map(r => ({
          videoId: r.id,
          score: r.score,
          reason: 'similar_content'
        }))
    }

    return []
  }
}
