/**
 * Comments Channel Manager
 *
 * HyperDB-backed comments for a channel. Comments live in the same channel DB
 * as metadata/videos/writers; no separate CommentsAutobase is used.
 */

import crypto from 'hypercore-crypto'

function withinPage(items, page = 0, limit = 50) {
  const startIdx = page * limit
  return items.slice(startIdx, startIdx + limit)
}

export class CommentsChannel {
  constructor(channel) {
    this.channel = channel
  }

  async addComment(videoId, text, parentId = null, overrides = {}) {
    if (!text || typeof text !== 'string') throw new Error('Comment text is required')
    if (text.length > 5000) throw new Error('Comment text must be 5000 characters or less')

    const authorKeyHex = overrides.authorKeyHex || this.channel.localWriterKeyHex
    if (!authorKeyHex) throw new Error('Channel not ready')
    const commentId = overrides.commentId || crypto.randomBytes(16).toString('hex')
    const record = {
      videoId,
      commentId,
      text,
      authorKeyHex,
      timestamp: overrides.timestamp || Date.now(),
      parentId: parentId || null,
      hidden: Boolean(overrides.hidden),
      removed: Boolean(overrides.removed)
    }
    await this.channel.db.insert('@peartubeChannel/comments', record)
    await this.channel._flush()
    return { commentId, success: true }
  }

  async listComments(videoId, options = {}) {
    const { page = 0, limit = 50 } = options
    this.channel.db.update?.()
    const comments = await this.channel.db.find('@peartubeChannel/comments-by-video-timestamp', {
      gte: { videoId },
      lte: { videoId, timestamp: Number.MAX_SAFE_INTEGER }
    }, { reverse: true }).toArray()
    return withinPage(comments.filter((comment) => !comment.hidden && !comment.removed), page, limit)
  }

  async hideComment(videoId, commentId, overrides = {}) {
    const moderatorKeyHex = overrides.moderatorKeyHex || this.channel.localWriterKeyHex
    if (!moderatorKeyHex) throw new Error('Channel not ready')
    const writer = await this.channel._getWriter(moderatorKeyHex)
    if (writer && writer.role !== 'moderator' && writer.role !== 'owner') {
      throw new Error('Only moderators can hide comments')
    }
    const comment = await this.channel.db.get('@peartubeChannel/comments', { videoId, commentId })
    if (!comment) throw new Error('Comment not found')
    await this.channel.db.insert('@peartubeChannel/comments', {
      ...comment,
      hidden: true,
      hiddenBy: moderatorKeyHex,
      hiddenAt: overrides.timestamp || Date.now()
    })
    await this.channel._flush()
    return { success: true }
  }

  async removeComment(videoId, commentId, overrides = {}) {
    const actorKeyHex = overrides.authorKeyHex || overrides.moderatorKeyHex || this.channel.localWriterKeyHex
    if (!actorKeyHex) throw new Error('Channel not ready')
    const comment = await this.channel.db.get('@peartubeChannel/comments', { videoId, commentId })
    if (!comment) throw new Error('Comment not found')
    const writer = await this.channel._getWriter(actorKeyHex)
    const isModerator = writer && (writer.role === 'moderator' || writer.role === 'owner')
    const isAuthor = comment.authorKeyHex === actorKeyHex
    if (!isModerator && !isAuthor) throw new Error('Only moderators or comment authors can remove comments')
    await this.channel.db.delete('@peartubeChannel/comments', { videoId, commentId })
    await this.channel._flush()
    return { success: true }
  }
}
