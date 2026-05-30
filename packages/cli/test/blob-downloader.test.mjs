import test from 'brittle'
import { EventEmitter } from 'node:events'
import { downloadChannelBlobs, addVideoDownloadRefs } from '../src/blob-downloader.js'

function createCore({ length = 10, byteLength = 100 } = {}) {
  const core = new EventEmitter()
  Object.assign(core, {
    length,
    byteLength,
    readyCalls: 0,
    downloads: [],
    discoveryKey: `discovery-${Math.random()}`,
    async ready() {
      this.readyCalls += 1
    },
    download(range) {
      this.downloads.push(range)
      return {
        async done() {}
      }
    }
  })
  return core
}

test('addVideoDownloadRefs collects video and thumbnail blob refs without duplicates', (t) => {
  const refs = new Map()
  const video = {
    id: 'video-1',
    blobsCoreKey: 'aa'.repeat(32),
    blobId: '0:2:0:20',
    thumbnailBlobsCoreKey: 'bb'.repeat(32),
    thumbnailBlobId: '2:1:20:5'
  }

  t.is(addVideoDownloadRefs(refs, [video, video]), 2)
  t.is(refs.size, 2)
  t.alike([...refs.values()].map((ref) => ref.kind), ['video', 'thumbnail'])
})

test('downloadChannelBlobs downloads feed preview refs when PublicBee has no videos', async (t) => {
  const videoCore = createCore({ length: 4, byteLength: 400 })
  const thumbnailCore = createCore({ length: 2, byteLength: 20 })
  const joins = []
  const ctx = {
    swarm: {
      join(discoveryKey, opts) {
        joins.push({ discoveryKey, opts })
      }
    },
    store: {
      get(key) {
        const keyHex = Buffer.isBuffer(key) ? key.toString('hex') : String(key)
        if (keyHex.startsWith('aa')) return videoCore
        if (keyHex.startsWith('bb')) return thumbnailCore
        throw new Error(`unexpected key ${keyHex}`)
      }
    }
  }

  const stats = await downloadChannelBlobs(
    ctx,
    'cc'.repeat(32),
    'chan-preview',
    { info() {}, debug() {}, error() {} },
    {
      previewVideos: [{
        id: 'preview-1',
        title: 'Preview 1',
        blobId: '1:2:100:200',
        blobsCoreKey: 'aa'.repeat(32),
        thumbnailBlobId: '0:1:0:10',
        thumbnailBlobsCoreKey: 'bb'.repeat(32)
      }]
    },
    {
      async loadPublicBee() {
        return {
          async listVideos() {
            return []
          }
        }
      }
    }
  )

  t.is(stats.videosFound, 0)
  t.is(stats.videoCount, 1)
  t.is(stats.blobsFound, 2)
  t.is(stats.blobsDownloaded, 2)
  t.is(stats.videosDownloaded, 1)
  t.is(stats.thumbnailsDownloaded, 1)
  t.is(stats.bytesDownloaded, 210)
  t.is(stats.previewVideos.length, 1)
  t.alike(videoCore.downloads, [{ start: 1, end: 3 }])
  t.alike(thumbnailCore.downloads, [{ start: 0, end: 1 }])
  t.is(joins.length, 2)
  t.ok(joins.every((join) => join.opts?.server === true && join.opts?.client === true))
})


test('downloadChannelBlobs only republishes successfully cached video previews', async (t) => {
  const playableCore = createCore({ length: 4, byteLength: 400 })
  const missingCore = new EventEmitter()
  Object.assign(missingCore, {
    discoveryKey: 'missing-discovery',
    async ready() {},
    download() {
      return {
        async done() { throw new Error('remote blocks unavailable') }
      }
    }
  })
  const ctx = {
    swarm: { join() {} },
    store: {
      get(key) {
        const keyHex = Buffer.isBuffer(key) ? key.toString('hex') : String(key)
        if (keyHex.startsWith('aa')) return playableCore
        if (keyHex.startsWith('cc')) return missingCore
        throw new Error(`unexpected key ${keyHex}`)
      }
    }
  }

  const stats = await downloadChannelBlobs(
    ctx,
    'ee'.repeat(32),
    'chan-partial',
    { info() {}, debug() {}, error() {} },
    {
      previewVideos: [
        {
          id: 'playable',
          title: 'Playable',
          blobId: '1:2:100:200',
          blobsCoreKey: 'aa'.repeat(32)
        },
        {
          id: 'hollow',
          title: 'Hollow',
          blobId: '1:2:100:200',
          blobsCoreKey: 'cc'.repeat(32)
        }
      ]
    },
    {
      async loadPublicBee() {
        return {
          async listVideos() {
            return []
          }
        }
      }
    }
  )

  t.is(stats.blobsFound, 2)
  t.is(stats.blobsDownloaded, 1)
  t.is(stats.videosDownloaded, 1)
  t.is(stats.previewVideos.length, 1)
  t.is(stats.previewVideos[0].id, 'playable')
})


test('downloadChannelBlobs abandons a stalled blob download after idle timeout', async (t) => {
  const previous = globalThis.setTimeout
  const timers = []
  globalThis.setTimeout = (fn, _ms) => {
    const timer = {
      fn,
      cleared: false,
      unref() {}
    }
    timers.push(timer)
    return timer
  }
  globalThis.clearTimeout = (timer) => {
    if (timer) timer.cleared = true
  }

  const stalledCore = createCore({ length: 4, byteLength: 400 })
  let destroyed = false
  stalledCore.download = function download(range) {
    this.downloads.push(range)
    return {
      destroy() { destroyed = true },
      done() { return new Promise(() => {}) }
    }
  }

  try {
    const ctx = {
      swarm: { join() {} },
      store: {
        get() { return stalledCore }
      }
    }

    const promise = downloadChannelBlobs(
      ctx,
      'ee'.repeat(32),
      'chan-stalled',
      { info() {}, debug() {}, error() {} },
      {
        previewVideos: [{
          id: 'stalled',
          title: 'Stalled',
          blobId: '1:2:100:200',
          blobsCoreKey: 'aa'.repeat(32)
        }]
      },
      {
        async loadPublicBee() {
          return {
            async listVideos() {
              return []
            }
          }
        }
      }
    )

    for (let i = 0; i < 20 && stalledCore.downloads.length === 0; i += 1) {
      await Promise.resolve()
    }
    t.is(stalledCore.downloads.length, 1, 'stalled download should have started')
    const idleTimer = timers.find((timer) => !timer.cleared)
    t.ok(idleTimer, 'idle timer should be armed')
    idleTimer.fn()

    const stats = await promise
    t.ok(destroyed, 'stalled download should be destroyed after idle timeout')
    t.is(stats.blobsFound, 1)
    t.is(stats.blobsDownloaded, 0)
    t.is(stats.videosDownloaded, 0)
    t.alike(stats.previewVideos, [])
  } finally {
    globalThis.setTimeout = previous
    globalThis.clearTimeout = clearTimeout
  }
})
