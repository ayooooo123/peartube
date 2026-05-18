import test from 'brittle'
import { downloadChannelBlobs, addVideoDownloadRefs } from '../src/blob-downloader.js'

function createCore({ length = 10, byteLength = 100 } = {}) {
  return {
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
  }
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
