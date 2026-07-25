import test from 'node:test'
import assert from 'node:assert/strict'

import { attachMobileHandlers } from '../../backend/src/mobile-handlers.js'

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

test('listVideos forwards video availability metadata from backend api', async () => {
  const backend = {}
  const deps = createDeps({
    api: {
      async listVideos() {
        return [{
          id: 'video-1',
          title: 'Demo',
          channelKey: 'channel-key',
          size: 12345,
          uploadedAt: 999,
          blobId: 'blob-id',
          blobsCoreKey: 'blobs-core-key',
          availability: 'playable',
        }]
      },
    },
  })

  attachMobileHandlers(backend, deps)

  const result = await backend.listVideos({ channelKey: 'channel-key', publicBeeKey: 'public-bee-key' })
  assert.deepEqual(result, {
    videos: [{
      id: 'video-1',
      title: 'Demo',
      description: null,
      path: null,
      duration: 0,
      thumbnail: null,
      channelKey: 'channel-key',
      channelName: '',
      size: 12345,
      uploadedAt: 999,
      createdAt: result.videos[0].createdAt,
      views: 0,
      category: null,
      blobId: 'blob-id',
      blobsCoreKey: 'blobs-core-key',
      mimeType: null,
      availability: 'playable',
      byteAvailability: null,
      hasHeadBlock: false,
      contiguousBlocks: 0,
      readyForPlayback: false,
      thumbnailBlobId: null,
      thumbnailBlobsCoreKey: null,
      thumbnailMimeType: null,
      playbackSupport: null,
      publicBeeKey: 'public-bee-key',
    }],
  })
})

test('listVideos returns explicit stale error when backend api list fails', async () => {
  const backend = {}
  const deps = createDeps({
    api: {
      async listVideos(channelKey, publicBeeKey) {
        assert.equal(channelKey, 'channel-key')
        assert.equal(publicBeeKey, 'public-bee-key')
        throw new Error('manifest unavailable')
      },
    },
  })

  attachMobileHandlers(backend, deps)

  assert.deepEqual(await backend.listVideos({ channelKey: 'channel-key', publicBeeKey: 'public-bee-key' }), {
    success: false,
    error: 'manifest unavailable',
    stale: true,
    videos: [],
  })
})

test('preparePlayback forwards direct blob playback fields to the backend api', async () => {
  const backend = {}
  const captured = []
  const deps = createDeps({
    api: {
      async preparePlayback(...args) {
        captured.push(args)
        return {
          url: 'http://127.0.0.1:60023/video.mp4',
          stats: {
            status: 'connecting',
            progress: 0,
          },
          warmupStarted: true,
        }
      },
    },
  })

  attachMobileHandlers(backend, deps)

  const result = await backend.preparePlayback({
    channelKey: 'channel-key',
    videoId: 'videos/demo.mp4',
    publicBeeKey: 'public-bee-key',
    blobId: 'blob-id',
    blobsCoreKey: 'blobs-core-key',
    mimeType: 'video/mp4',
  })

  assert.deepEqual(result, {
    url: 'http://127.0.0.1:60023/video.mp4',
    stats: {
      status: 'connecting',
      progress: 0,
    },
    warmupStarted: true,
  })
  assert.deepEqual(captured, [[
    'channel-key',
    'videos/demo.mp4',
    'public-bee-key',
    'blob-id',
    'blobs-core-key',
    'video/mp4',
  ]])
})

test('preparePlayback skips Android compat probing for direct PearTube blob URLs', async () => {
  const backend = {}
  const deps = createDeps({
    player: 'exoplayer',
    castTranscoder: {
      async startCompatTranscode() {
        throw new Error('Android direct blob playback must not run the compat probe')
      },
      getCastHlsUrl() {
        throw new Error('Android direct blob playback must not request HLS')
      },
    },
    api: {
      async preparePlayback() {
        return {
          url: 'http://127.0.0.1:60023/?key=abc&blob=def&type=video%2Fmp4&token=redacted',
          stats: {
            status: 'connecting',
            progress: 0,
          },
        }
      },
    },
  })

  attachMobileHandlers(backend, deps)

  const result = await backend.preparePlayback({
    channelKey: 'channel-key',
    videoId: 'videos/demo.mp4',
    publicBeeKey: 'public-bee-key',
    blobId: 'blob-id',
    blobsCoreKey: 'blobs-core-key',
    mimeType: 'video/mp4',
  })

  assert.deepEqual(result, {
    url: 'http://127.0.0.1:60023/?key=abc&blob=def&type=video%2Fmp4&token=redacted',
    stats: {
      status: 'connecting',
      progress: 0,
    },
  })
})


test('transcodeStop and transcodeStatus await async transcoder adapters', async () => {
  const backend = {}
  const events = []
  const deps = createDeps({
    rpc: {
      eventTranscodeProgress(payload) {
        events.push(payload)
      },
    },
    transcoder: {
      async startTranscode() {
        return { success: true, sessionId: 'session-1', transcodeUrl: 'http://127.0.0.1/transcode/1' }
      },
      async stopTranscode(sessionId) {
        return { success: sessionId === 'session-1', error: '' }
      },
      async getStatus(sessionId) {
        return { status: sessionId === 'session-1' ? 'ready' : 'error', progress: 88, bytesWritten: 4096, error: '' }
      },
    },
  })

  attachMobileHandlers(backend, deps)

  const startResult = await backend.transcodeStart({ sourceUrl: 'hyper://video', title: 'Demo' })
  const stopResult = await backend.transcodeStop({ sessionId: 'session-1' })
  const statusResult = await backend.transcodeStatus({ sessionId: 'session-1' })

  assert.deepEqual(startResult, {
    success: true,
    sessionId: 'session-1',
    transcodeUrl: 'http://127.0.0.1/transcode/1',
    error: '',
  })
  assert.deepEqual(stopResult, { success: true, error: '' })
  assert.deepEqual(statusResult, {
    status: 'ready',
    progress: 88,
    bytesWritten: 4096,
    error: '',
  })
  assert.deepEqual(events, [])
})
