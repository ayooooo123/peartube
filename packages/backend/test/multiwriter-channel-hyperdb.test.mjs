import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Corestore from 'corestore'
import { MultiWriterChannel } from '../src/channel/multi-writer-channel.js'

async function withChannel(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-channel-hyperdb-'))
  const store = new Corestore(dir)
  let channel = null
  try {
    await store.ready()
    channel = new MultiWriterChannel(store, { key: null, encrypt: false })
    await channel.ready()
    await fn(channel)
  } finally {
    await channel?.close?.().catch(() => {})
    await store?.close?.().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
}

test('MultiWriterChannel opens remote read-only channels without committing bootstrap records', async () => {
  const dirA = mkdtempSync(join(tmpdir(), 'peartube-mw-owner-'))
  const dirB = mkdtempSync(join(tmpdir(), 'peartube-mw-viewer-'))
  const storeA = new Corestore(dirA)
  const storeB = new Corestore(dirB)
  await storeA.ready()
  await storeB.ready()

  let owner = null
  let viewer = null
  try {
    owner = new MultiWriterChannel(storeA, { name: 'owner' })
    await owner.ready()
    await owner.updateMetadata({ name: 'Owner channel' })

    viewer = new MultiWriterChannel(storeB, { key: owner.key })
    await viewer.ready()

    assert.equal(viewer.writable, false)
    assert.ok(viewer.keyHex)
  } finally {
    await viewer?.close?.().catch(() => {})
    await owner?.close?.().catch(() => {})
    await storeA.close().catch(() => {})
    await storeB.close().catch(() => {})
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})

test('MultiWriterChannel stores channel state in HyperDB, not Autobase views', async (t) => {
  await withChannel(async (channel) => {
    assert.ok(channel.db, 'channel HyperDB instance is opened')
    assert.equal('base' in channel, false, 'Autobase handle is removed')
    assert.equal('view' in channel, false, 'raw Hyperbee view is removed')

    await channel.updateMetadata({ name: 'HyperDB Root', description: 'typed channel', avatar: 'avatar.png' })
    await channel.updateMetadata({ description: 'updated typed channel' })

    const meta = await channel.getMetadata()
    assert.equal(meta.name, 'HyperDB Root')
    assert.equal(meta.description, 'updated typed channel')
    assert.equal(meta.avatar, 'avatar.png')
    assert.equal(meta.schemaVersion, 1)
  })
})

test('MultiWriterChannel video CRUD uses HyperDB collections and uploadedAt index', async () => {
  await withChannel(async (channel) => {
    await channel.addVideo({ id: 'old', title: 'Old', uploadedAt: 100, description: 'before' })
    await channel.addVideo({ id: 'new', title: 'New', uploadedAt: 200 })

    assert.equal((await channel.getVideo('old')).title, 'Old')
    assert.deepEqual((await channel.listVideos()).map((video) => video.id), ['new', 'old'])

    await channel.updateVideo('old', { title: 'Old Updated', category: 'demo' })
    const updated = await channel.getVideo('old')
    assert.equal(updated.title, 'Old Updated')
    assert.equal(updated.description, 'before')
    assert.equal(updated.category, 'demo')

    await channel.deleteVideo('new')
    assert.equal(await channel.getVideo('new'), null)
    assert.deepEqual((await channel.listVideos()).map((video) => video.id), ['old'])
  })
})

test('MultiWriterChannel comments and reactions live in the same HyperDB channel database', async () => {
  await withChannel(async (channel) => {
    assert.equal('commentsAutobase' in channel, false, 'separate comments Autobase is removed')
    await channel.addVideo({ id: 'video-1', title: 'Video', uploadedAt: 1 })

    const first = await channel.comments.addComment('video-1', 'first')
    await new Promise((resolve) => setTimeout(resolve, 2))
    const second = await channel.comments.addComment('video-1', 'second')

    const comments = await channel.comments.listComments('video-1')
    assert.deepEqual(comments.map((comment) => comment.commentId), [second.commentId, first.commentId])
    assert.deepEqual(comments.map((comment) => comment.text), ['second', 'first'])

    await channel.comments.hideComment('video-1', first.commentId)
    assert.deepEqual((await channel.comments.listComments('video-1')).map((comment) => comment.commentId), [second.commentId])

    await channel.reactions.addReaction('video-1', 'like')
    assert.deepEqual(await channel.reactions.getReactions('video-1'), {
      counts: { like: 1 },
      userReaction: 'like',
    })

    await channel.reactions.addReaction('video-1', 'dislike')
    assert.deepEqual(await channel.reactions.getReactions('video-1'), {
      counts: { dislike: 1 },
      userReaction: 'dislike',
    })

    await channel.reactions.removeReaction('video-1')
    assert.deepEqual(await channel.reactions.getReactions('video-1'), {
      counts: {},
      userReaction: null,
    })
  })
})
