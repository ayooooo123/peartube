import test from 'brittle'

import { createApi } from '../src/api.js'

function createMetaDb (identities = []) {
  const values = new Map([
    ['identities', { value: identities }]
  ])
  return {
    async get (key) { return values.get(key) || null },
    async put (key, value) { values.set(key, { value }) }
  }
}

function createChannel () {
  const comments = []
  const reactions = new Map()
  return {
    writable: true,
    publicBee: null,
    localWriterKeyHex: 'writer-a',
    async getMetadata () { return { commentsDbKey: 'channel-db' } },
    comments: {
      async addComment (videoId, text, parentId) {
        const commentId = `comment-${comments.length + 1}`
        comments.push({ videoId, text, parentId: parentId || null, commentId })
        return { success: true, commentId }
      },
      async listComments (videoId) {
        return comments.filter(comment => comment.videoId === videoId)
      },
      async hideComment (videoId, commentId) {
        const comment = comments.find(item => item.videoId === videoId && item.commentId === commentId)
        if (!comment) throw new Error('Comment not found')
        comment.hidden = true
        return { success: true }
      },
      async removeComment (videoId, commentId) {
        const index = comments.findIndex(item => item.videoId === videoId && item.commentId === commentId)
        if (index === -1) throw new Error('Comment not found')
        comments.splice(index, 1)
        return { success: true }
      }
    },
    reactions: {
      async addReaction (videoId, reactionType) {
        reactions.set(videoId, reactionType)
        return { success: true }
      },
      async removeReaction (videoId) {
        reactions.delete(videoId)
        return { success: true }
      },
      async getReactions (videoId) {
        const reactionType = reactions.get(videoId)
        return {
          counts: reactionType ? { [reactionType]: 1 } : {},
          userReaction: reactionType || null
        }
      }
    }
  }
}

test('comments API uses HyperDB channel managers instead of removed comments autobase module', async (t) => {
  t.plan(11)

  let loadChannelCalls = 0
  const channel = createChannel()
  const api = createApi({
    ctx: {
      metaDb: createMetaDb([{ channelKey: 'channel-a' }]),
      channels: new Map(),
      swarm: { connections: new Set() }
    },
    loadChannel: async (_ctx, channelKey) => {
      loadChannelCalls += 1
      return channel
    }
  })

  t.not(api._getCommentsAutobase, undefined, 'compatibility helper should still exist')
  const compat = await api._getCommentsAutobase('channel-a')
  t.is(compat, channel, 'compatibility helper resolves to loaded HyperDB channel')

  const added = await api.addComment('channel-a', 'video-a', 'hello', null)
  t.alike(added, { success: true, commentId: 'comment-1', queued: false })

  const listed = await api.listComments('channel-a', 'video-a')
  t.is(listed.success, true)
  t.is(listed.comments.length, 1)
  t.is(listed.comments[0].text, 'hello')

  const reacted = await api.addReaction('channel-a', 'video-a', 'like')
  t.alike(reacted, { success: true })

  const reactions = await api.getReactions('channel-a', 'video-a')
  t.alike(reactions, { success: true, counts: { like: 1 }, userReaction: 'like' })

  const debug = await api.getCommentsDebugInfo('channel-a')
  t.is(debug.success, true)
  t.is(debug.commentsConnected, true)
  t.ok(loadChannelCalls >= 1)
})
