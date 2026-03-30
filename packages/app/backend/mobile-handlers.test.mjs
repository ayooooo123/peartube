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
