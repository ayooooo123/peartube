import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Corestore from 'corestore'
import { PublicChannelBee } from '../src/channel/public-channel-bee.js'

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

async function closeSilently(resource) {
  if (!resource || typeof resource.close !== 'function') return
  try {
    await resource.close()
  } catch {
    // best effort for temp resources
  }
}

async function withPublicDb(fn) {
  const dir = makeTempDir('peartube-public-hyperdb-')
  const store = new Corestore(dir)
  let publicDb = null

  try {
    await store.ready()
    publicDb = new PublicChannelBee(store, { name: `public-hyperdb-${Date.now()}-${Math.random()}` })
    await publicDb.ready()
    await fn(publicDb)
  } finally {
    await closeSilently(publicDb)
    await closeSilently(store)
    rmSync(dir, { recursive: true, force: true })
  }
}

test('PublicChannelBee uses HyperDB collections instead of raw Hyperbee key scans', async () => {
  await withPublicDb(async (publicDb) => {
    assert.ok(publicDb.db, 'HyperDB instance is opened')
    assert.equal(publicDb.bee, null, 'raw Hyperbee handle is not retained for application reads')

    await publicDb.setMetadata({
      name: 'HyperDB Channel',
      description: 'typed metadata',
      avatar: null,
      commentsAdminKey: 'aa'.repeat(32),
    })

    await publicDb.putVideo('older-video', {
      title: 'Older',
      description: 'first',
      uploadedAt: 100,
      commentsAdminKey: 'bb'.repeat(32),
    })
    await publicDb.putVideo('newer-video', {
      title: 'Newer',
      description: 'second',
      uploadedAt: 200,
    })

    const meta = await publicDb.getMetadata()
    assert.equal(meta.name, 'HyperDB Channel')
    assert.equal(meta.description, 'typed metadata')
    assert.equal(meta.commentsAdminKey, undefined)

    const newer = await publicDb.getVideo('newer-video')
    assert.equal(newer.id, 'newer-video')
    assert.equal(newer.title, 'Newer')

    const videos = await publicDb.listVideos({ timeoutMs: 100 })
    assert.deepEqual(videos.map((video) => video.id), ['newer-video', 'older-video'])
    assert.equal(videos[1].commentsAdminKey, undefined)
  })
})

test('PublicChannelBee applies HyperDB batched video changes', async () => {
  await withPublicDb(async (publicDb) => {
    await publicDb.putVideo('deleted-video', { title: 'Delete me', uploadedAt: 1 })
    await publicDb.applyVideoChanges([
      { type: 'put', id: 'kept-video', value: { title: 'Keep me', uploadedAt: 3 } },
      { type: 'put', id: 'updated-video', value: { title: 'Update me', uploadedAt: 2 } },
      { type: 'del', id: 'deleted-video' },
    ])

    const videos = await publicDb.listVideos()
    assert.deepEqual(videos.map((video) => video.id), ['kept-video', 'updated-video'])
    assert.equal(await publicDb.getVideo('deleted-video'), null)
  })
})
