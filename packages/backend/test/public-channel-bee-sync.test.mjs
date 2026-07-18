import test from 'brittle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Corestore from 'corestore'
import { PublicChannelBee } from '../src/channel/public-channel-bee.js'
import { MultiWriterChannel } from '../src/channel/multi-writer-channel.js'

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

async function closeSilently(resource) {
  if (!resource || typeof resource.close !== 'function') return
  try {
    await resource.close()
  } catch {
    // Best-effort cleanup for temporary Corestore resources.
  }
}

async function withPublicBee(fn) {
  const dir = makeTempDir('peartube-public-bee-sync-')
  const store = new Corestore(dir)
  let publicBee = null

  try {
    await store.ready()
    publicBee = new PublicChannelBee(store, { name: `public-sync-${Date.now()}-${Math.random()}` })
    await publicBee.ready()
    await fn(publicBee)
  } finally {
    await closeSilently(publicBee)
    await closeSilently(store)
    rmSync(dir, { recursive: true, force: true })
  }
}

function makeDelayedTimeoutStream(delayMs) {
  let rejectNext = null
  let timer = null

  const stream = {
    destroyed: false,
    destroyError: null,
    [Symbol.asyncIterator]() {
      return this
    },
    next() {
      return new Promise((resolve, reject) => {
        rejectNext = reject
        timer = setTimeout(() => {
          rejectNext = null
          reject(new Error('REQUEST_TIMEOUT: Request timed out'))
        }, delayMs)
      })
    },
    destroy(err) {
      this.destroyed = true
      this.destroyError = err || null
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (rejectNext) {
        const reject = rejectNext
        rejectNext = null
        reject(err || new Error('stream destroyed'))
      }
    },
  }

  return stream
}

test('listVideos returns promptly when a PublicBee video scan stalls', async (t) => {
  const stream = makeDelayedTimeoutStream(250)
  const publicBee = Object.create(PublicChannelBee.prototype)
  publicBee.waitForSync = async () => {}
  publicBee.db = {
    update() {},
    find() {
      return stream
    },
  }

  const started = Date.now()
  const videos = await publicBee.listVideos({ timeoutMs: 20 })
  const elapsed = Date.now() - started

  t.alike(videos, [])
  t.ok(stream.destroyed, 'stalled stream is destroyed')
  t.is(stream.destroyError?.message, 'PublicBee listVideos timed out after 20ms')
  t.ok(elapsed < 150, `listVideos returned after ${elapsed}ms`)
})

test('syncFromChannel keeps existing public videos when a channel unexpectedly reads empty', async (t) => {
  await withPublicBee(async (publicBee) => {
    await publicBee.putVideo('video-1', {
      title: 'Existing public video',
      uploadedAt: 1,
    })

    await publicBee.syncFromChannel({
      keyHex: 'aa'.repeat(32),
      view: { core: { length: 6 } },
      base: { local: { length: 5 } },
      async getMetadata() {
        return {
          name: 'Guarded Channel',
        }
      },
      async listVideos() {
        return []
      },
    })

    const videos = await publicBee.listVideos()
    t.is(videos.length, 1)
    t.is(videos[0]?.id, 'video-1')
    t.is(videos[0]?.title, 'Existing public video')
  })
})

test('syncFromChannel merges partial channel views without deleting missing public videos', async (t) => {
  await withPublicBee(async (publicBee) => {
    await publicBee.putVideo('video-1', {
      title: 'Existing public video',
      uploadedAt: 1,
    })
    await publicBee.putVideo('video-2', {
      title: 'Second existing public video',
      uploadedAt: 2,
    })

    await publicBee.syncFromChannel({
      keyHex: 'bb'.repeat(32),
      async getMetadata() {
        return { name: 'Partial Channel' }
      },
      async listVideos() {
        return [{
          id: 'video-1',
          title: 'Updated from partial view',
          uploadedAt: 3,
        }]
      },
    })

    const videos = await publicBee.listVideos()
    const byId = new Map(videos.map((video) => [video.id, video]))

    t.is(videos.length, 2)
    t.is(byId.get('video-1')?.title, 'Updated from partial view')
    t.is(byId.get('video-2')?.title, 'Second existing public video')
  })
})

test('syncFromChannel excludes replication-pending private drafts', async (t) => {
  await withPublicBee(async (publicBee) => {
    await publicBee.putVideo('pending', { title: 'Previously public', uploadedAt: 0 })
    await publicBee.syncFromChannel({
      keyHex: 'cc'.repeat(32),
      async getMetadata() {
        return { name: 'Private drafts' }
      },
      async listVideos() {
        return [
          { id: 'pending', title: 'Pending', publicationState: 'replicationPending', uploadedAt: 1 },
          { id: 'legacy', title: 'Legacy public default', uploadedAt: 2 },
          { id: 'published', title: 'Published', publicationState: 'published', uploadedAt: 3 },
        ]
      },
    })

    const videos = await publicBee.listVideos()
    t.alike(videos.map((video) => video.id), ['published', 'legacy'])
    t.absent(await publicBee.getVideo('pending'))
  })
})

test('syncVideos never stores replication-pending rows for direct snapshots', async (t) => {
  await withPublicBee(async (publicBee) => {
    await publicBee.putVideo('pending', { title: 'Previously public', uploadedAt: 1 })
    await publicBee.putVideo('unrelated', { title: 'Keep on partial sync', uploadedAt: 2 })

    await publicBee.syncVideos([
      { id: 'pending', title: 'Now private', publicationState: 'replicationPending', uploadedAt: 3 },
      { id: 'new-public', title: 'New public', uploadedAt: 4 },
    ], { destructive: false })

    t.alike((await publicBee.listVideos()).map((video) => video.id), ['new-public', 'unrelated'])
    t.absent(await publicBee.getVideo('pending'))

    await publicBee.syncVideos([
      { id: 'pending-direct', title: 'Never public', publicationState: 'replicationPending', uploadedAt: 5 },
      { id: 'complete-public', title: 'Complete public snapshot', uploadedAt: 6 },
    ])
    t.alike((await publicBee.listVideos()).map((video) => video.id), ['complete-public'])
    t.absent(await publicBee.getVideo('pending-direct'))
  })
})

test('syncVideos remains destructive by default for complete source snapshots', async (t) => {
  await withPublicBee(async (publicBee) => {
    await publicBee.putVideo('video-1', { title: 'Keep', uploadedAt: 1 })
    await publicBee.putVideo('video-2', { title: 'Delete', uploadedAt: 2 })

    await publicBee.syncVideos([{ id: 'video-1', title: 'Kept', uploadedAt: 3 }])

    const videos = await publicBee.listVideos()
    t.is(videos.length, 1)
    t.is(videos[0]?.id, 'video-1')
    t.is(videos[0]?.title, 'Kept')
  })
})
