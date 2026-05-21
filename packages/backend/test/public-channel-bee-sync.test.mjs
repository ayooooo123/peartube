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
  publicBee.bee = {
    createReadStream() {
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

test('MultiWriterChannel video mutations do not scan all videos for logical clocks', async (t) => {
  const channel = Object.create(MultiWriterChannel.prototype)
  channel._lastVideoLogicalClock = 0
  channel.base = { local: { key: Buffer.from('cc'.repeat(32), 'hex') } }
  channel.publicBee = null

  let appendedAdd = null
  let appendedUpdate = null
  let safeUpdates = 0

  channel.listVideos = async () => {
    throw new Error('listVideos should not be called to compute logicalClock')
  }
  channel.appendOp = async (op) => {
    if (op.type === 'add-video') appendedAdd = op
    if (op.type === 'update-video') appendedUpdate = op
  }
  channel._safeUpdate = async () => {
    safeUpdates += 1
  }
  channel.getVideo = async (id) => ({
    id,
    title: 'Existing',
    logicalClock: 100,
  })

  await channel.addVideo({ id: 'video-1', title: 'New video' })
  await channel.updateVideo('video-1', { title: 'Updated video' })

  t.is(appendedAdd?.type, 'add-video')
  t.is(appendedAdd?.id, 'video-1')
  t.ok(Number.isSafeInteger(appendedAdd?.logicalClock), 'addVideo assigns a logical clock')
  t.is(appendedUpdate?.type, 'update-video')
  t.is(appendedUpdate?.id, 'video-1')
  t.ok(appendedUpdate?.logicalClock > appendedAdd?.logicalClock, 'updateVideo clock advances without scanning')
  t.is(safeUpdates, 2)
})
