import test from 'node:test'
import assert from 'node:assert/strict'

import { attachMobileHandlers } from './mobile-handlers.mjs'

function createDeps(overrides = {}) {
  return {
    api: {},
    identityManager: {},
    uploadManager: {},
    ctx: {},
    initializeIdentityFromMnemonic: async () => ({ needsRestart: false }),
    rpc: {},
    fs: {},
    path: {},
    generateAndStoreThumbnail: async () => null,
    transcoder: {},
    storagePath: '/tmp/peartube-test',
    ...overrides,
  }
}

test('getVideoUrl forwards direct blob playback fields to the backend api', async () => {
  const backend = {}
  const captured = []
  const deps = createDeps({
    api: {
      async getVideoUrl(...args) {
        captured.push(args)
        return { url: 'http://127.0.0.1:60023/video.mp4' }
      },
    },
  })

  attachMobileHandlers(backend, deps)

  const result = await backend.getVideoUrl({
    channelKey: 'channel-key',
    videoId: 'videos/demo.mp4',
    publicBeeKey: 'public-bee-key',
    blobId: 'blob-id',
    blobsCoreKey: 'blobs-core-key',
    mimeType: 'video/mp4',
  })

  assert.equal(result.url, 'http://127.0.0.1:60023/video.mp4')
  assert.deepEqual(captured, [[
    'channel-key',
    'videos/demo.mp4',
    'public-bee-key',
    'blob-id',
    'blobs-core-key',
    'video/mp4',
  ]])
})

test('prefetchVideo preserves backend playback readiness metadata', async () => {
  const backend = {}
  const deps = createDeps({
    api: {
      async prefetchVideo(...args) {
        assert.deepEqual(args, ['channel-key', 'videos/demo.mp4', 'public-bee-key'])
        return {
          success: true,
          cached: false,
          initialBlocks: 128,
          peerCount: 2,
          message: 'Prefetch started',
        }
      },
    },
  })

  attachMobileHandlers(backend, deps)

  const result = await backend.prefetchVideo({
    channelKey: 'channel-key',
    videoId: 'videos/demo.mp4',
    publicBeeKey: 'public-bee-key',
  })

  assert.deepEqual(result, {
    success: true,
    cached: false,
    initialBlocks: 128,
    peerCount: 2,
    message: 'Prefetch started',
  })
})
