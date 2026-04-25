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

test('uploadVideo delegates to engine-backed api.uploadVideo before old upload manager', async () => {
  const backend = {}
  const calls = []
  const deps = createDeps({
    identityManager: {
      getActiveIdentity() {
        return { driveKey: 'ui-channel' }
      },
      async getActiveChannel() {
        throw new Error('old channel path should not be used')
      },
    },
    api: {
      async uploadVideo(...args) {
        calls.push(args)
        return { video: { id: 'v1', title: 'Engine Upload', channelKey: 'ui-channel' } }
      },
    },
    rpc: {
      eventUploadProgress() {}
    },
    uploadManager: {
      async uploadFromPath() {
        throw new Error('old upload manager should not be used')
      }
    }
  })

  attachMobileHandlers(backend, deps)

  const result = await backend.uploadVideo({
    filePath: 'file:///tmp/demo.webm',
    title: 'Engine Upload',
    description: 'desc',
    category: 'cat'
  })

  assert.deepEqual(result, { video: { id: 'v1', title: 'Engine Upload', channelKey: 'ui-channel' } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'ui-channel')
  assert.equal(calls[0][1], '/tmp/demo.webm')
  assert.deepEqual({
    title: calls[0][2].title,
    description: calls[0][2].description,
    category: calls[0][2].category,
    mimeType: calls[0][2].mimeType,
  }, {
    title: 'Engine Upload',
    description: 'desc',
    category: 'cat',
    mimeType: 'video/webm',
  })
  assert.equal(typeof calls[0][2].onProgress, 'function')
})

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
      createdAt: result.videos[0].createdAt,
      views: 0,
      category: null,
      blobId: 'blob-id',
      blobsCoreKey: 'blobs-core-key',
      mimeType: null,
      availability: 'playable',
      thumbnailBlobId: null,
      thumbnailBlobsCoreKey: null,
      thumbnailMimeType: null,
      publicBeeKey: 'public-bee-key',
    }],
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

test('getPublicFeed preserves serving manifest fields from the backend api', async () => {
  const backend = {}
  const deps = createDeps({
    api: {
      async getPublicFeed() {
        return {
          entries: [{
            driveKey: 'channel-key',
            source: 'peer',
            publicBeeKey: 'public-bee-key',
            channelName: 'Manifest Channel',
            videoCount: 4,
            peerCount: 2,
            lastSeen: 123,
            manifestUpdatedAt: 456,
            previewVideos: [{
              id: 'preview-1',
              title: 'Preview',
              uploadedAt: 999,
              availability: 'playable',
            }],
          }],
          stats: { totalEntries: 1, hiddenCount: 0, peerCount: 2 },
        }
      },
    },
  })

  attachMobileHandlers(backend, deps)

  const result = await backend.getPublicFeed({})
  assert.deepEqual(result, {
    entries: [{
      channelKey: 'channel-key',
      driveKey: 'channel-key',
      source: 'peer',
      publicBeeKey: 'public-bee-key',
      channelName: 'Manifest Channel',
      videoCount: 4,
      peerCount: 2,
      lastSeen: 123,
      manifestUpdatedAt: 456,
      previewVideos: [{
        id: 'preview-1',
        title: 'Preview',
        uploadedAt: 999,
        availability: 'playable',
      }],
    }],
    stats: { totalEntries: 1, hiddenCount: 0, peerCount: 2 },
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
