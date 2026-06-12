import test from 'brittle'

import { BlobPlaybackService } from '../src/blob-playback-service.js'

const VALID_KEY = 'a'.repeat(64)
const VALID_BLOB = '1:2:3:4'
const VALID_URL = 'http://127.0.0.1:4321/blob.mp4?token=***'

function createCtx() {
  const calls = []
  const core = {
    discoveryKey: Buffer.from('discovery-key'),
    async ready() {
      calls.push(['ready'])
    },
    async update() {
      calls.push(['update'])
    },
  }
  return {
    calls,
    ctx: {
      blobServerHost: '127.0.0.1',
      blobServerPort: 1234,
      blobServer: {
        port: 4321,
        getLink(key, options) {
          calls.push(['getLink', key.toString('hex'), options])
          return VALID_URL
        },
      },
      store: {
        get(key) {
          calls.push(['store.get', key.toString('hex')])
          return core
        },
      },
      swarm: {},
    },
  }
}

test('direct blob refs return a URL before background warmup settles', async (t) => {
  const { ctx, calls } = createCtx()
  const service = new BlobPlaybackService({ ctx })

  const result = service.resolveDirectBlobUrl({
    blobsCoreKey: VALID_KEY,
    blobId: VALID_BLOB,
    mimeType: 'video/mp4',
  })

  t.alike(result, { url: VALID_URL })
  t.is(calls[0][0], 'getLink')
  t.is(calls[1][0], 'store.get')

  await Promise.resolve()
  await Promise.resolve()
  t.ok(calls.some((call) => call[0] === 'ready'))
})

test('metadata fallback resolves direct refs when metadata includes blobsCoreKey', async (t) => {
  const { ctx, calls } = createCtx()
  const service = new BlobPlaybackService({ ctx })

  const result = await service.resolveFromMetadata({
    id: 'videos/demo.mp4',
    blobId: VALID_BLOB,
    blobsCoreKey: VALID_KEY.toUpperCase(),
    mimeType: 'video/webm',
  })

  t.is(result.url, VALID_URL)
  t.alike(calls[0][2].blob, { blockOffset: 1, blockLength: 2, byteOffset: 3, byteLength: 4 })
  t.is(calls[0][2].type, 'video/webm')
})

test('channel metadata fallback uses getBlobEntry without blocking on prefetch warmup', async (t) => {
  const { ctx } = createCtx()
  const service = new BlobPlaybackService({ ctx })
  const seen = []
  const channel = {
    async getBlobEntry(meta) {
      seen.push(meta.id)
      return {
        blobsKey: Buffer.from(VALID_KEY, 'hex'),
        blobId: VALID_BLOB,
      }
    },
  }

  const result = await service.resolveFromMetadata({ id: 'legacy-video', blobId: VALID_BLOB }, { channel })

  t.is(result.url, VALID_URL)
  t.alike(seen, ['legacy-video'])
})

test('preparePlayback resolves the player URL and stats with no warmup', async (t) => {
  const { ctx } = createCtx()
  const service = new BlobPlaybackService({ ctx })

  const result = await service.preparePlayback({
    driveKey: 'channel-key',
    videoPath: 'videos/demo.mp4',
    publicBeeKey: 'public-bee-key',
    blobId: VALID_BLOB,
    blobsCoreKey: VALID_KEY,
    mimeType: 'video/mp4',
    getStats: () => ({ progress: 0, peerCount: 2 }),
  })

  t.is(result.url, VALID_URL)
  t.alike(result.stats, { progress: 0, peerCount: 2 })
  // No prewarming: the result is just the streamable URL + stats.
  t.is(result.warmupStarted, undefined)
  t.is(result.peerWarmupStarted, undefined)
  t.is(result.selectedBlobWarmup, undefined)
})

test('preparePlayback resolves via resolveUrl when one is provided', async (t) => {
  const { ctx } = createCtx()
  const service = new BlobPlaybackService({ ctx })

  const result = await service.preparePlayback({
    driveKey: 'channel-key',
    videoPath: 'videos/demo.mp4',
    publicBeeKey: 'public-bee-key',
    resolveUrl: async () => ({ url: 'http://resolved/url.mp4' }),
    getStats: () => ({ progress: 5 }),
  })

  t.is(result.url, 'http://resolved/url.mp4')
  t.alike(result.stats, { progress: 5 })
})
