/**
 * Reactions Manager
 *
 * HyperDB-backed reactions for videos. One reaction is stored per
 * (videoId, authorKeyHex), so changing reactions replaces the previous value.
 */

export class ReactionsManager {
  constructor(channel) {
    this.channel = channel
  }

  async addReaction(videoId, reactionType, overrides = {}) {
    if (!reactionType || typeof reactionType !== 'string') throw new Error('Reaction type is required')
    const authorKeyHex = overrides.authorKeyHex || this.channel.localWriterKeyHex
    if (!authorKeyHex) throw new Error('Channel not ready')
    await this.channel.db.insert('@peartubeChannel/reactions', {
      videoId,
      authorKeyHex,
      reactionType,
      timestamp: overrides.timestamp || Date.now()
    })
    await this.channel._flush()
    return { success: true }
  }

  async removeReaction(videoId, overrides = {}) {
    const authorKeyHex = overrides.authorKeyHex || this.channel.localWriterKeyHex
    if (!authorKeyHex) throw new Error('Channel not ready')
    await this.channel.db.delete('@peartubeChannel/reactions', { videoId, authorKeyHex })
    await this.channel._flush()
    return { success: true }
  }

  async getReactions(videoId) {
    this.channel.db.update?.()
    const rows = await this.channel.db.find('@peartubeChannel/reactions-by-video-type', {
      gte: { videoId },
      lte: { videoId, reactionType: '\xff' }
    }).toArray()
    const counts = {}
    let userReaction = null
    const authorKeyHex = this.channel.localWriterKeyHex
    for (const value of rows) {
      if (!value?.reactionType) continue
      counts[value.reactionType] = (counts[value.reactionType] || 0) + 1
      if (authorKeyHex && value.authorKeyHex === authorKeyHex) userReaction = value.reactionType
    }
    return { counts, userReaction }
  }

  async getReactionsBatch(videoIds) {
    const results = {}
    for (const videoId of videoIds || []) results[videoId] = await this.getReactions(videoId)
    return results
  }
}
