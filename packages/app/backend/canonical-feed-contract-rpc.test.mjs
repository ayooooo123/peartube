import test from 'node:test'
import assert from 'node:assert/strict'

import { attachMobileHandlers } from './mobile-handlers.mjs'
import { createCanonicalFeedVideo } from '../../backend/src/canonical-feed-contract.js'

test('RPC integration scaffold preserves canonical feed video fields through the app boundary', async () => {
  const backend = {}
  const deps = {
    api: {
      async listVideos() {
        return [createCanonicalFeedVideo({
          id: 'video-1',
          title: 'Canonical RPC video',
          uploadedAt: 100,
          channelKey: 'channel-key',
          blobId: 'blob-id',
          blobsCoreKey: '11'.repeat(32),
          mimeType: 'video/mp4',
          availability: 'playable',
          byteAvailability: 'playable',
          publicBeeKey: 'bee-key',
          thumbnailBlobId: 'thumb-blob',
          thumbnailBlobsCoreKey: '22'.repeat(32),
          thumbnailMimeType: 'image/jpeg',
        })]
      },
    },
    identityManager: {},
    uploadManager: {},
    ctx: {},
    initializeIdentityFromMnemonic: async () => ({ needsRestart: false }),
    rpc: {},
    fs: {},
    path: {},
    generateAndStoreThumbnail: async () => null,
    transcoder: {},
  }

  attachMobileHandlers(backend, deps)

  const result = await backend.listVideos({ channelKey: 'channel-key', publicBeeKey: 'bee-key' })
  assert.equal(result.videos.length, 1)
  assert.equal(result.videos[0].title, 'Canonical RPC video')
  assert.equal(result.videos[0].blobId, 'blob-id')
  assert.equal(result.videos[0].blobsCoreKey, '11'.repeat(32))
  assert.equal(result.videos[0].publicBeeKey, 'bee-key')
  assert.equal(result.videos[0].thumbnailBlobId, 'thumb-blob')
  assert.equal(result.videos[0].availability, 'playable')
})


test('app mobile handler adapter uses backend canonical mobile handler implementation', async () => {
  const appHandlers = await import('./mobile-handlers.mjs')
  const backendHandlers = await import('../../backend/src/mobile-handlers.js')
  assert.equal(appHandlers.attachMobileHandlers, backendHandlers.attachMobileHandlers)
})

test('canonical mobile handlers preserve backend recommendation and watch handlers', async () => {
  const backend = {}
  const calls = []
  attachMobileHandlers(backend, {
    api: {
      async getRecommendations(channelKey, options) { calls.push(['getRecommendations', channelKey, options]); return { success: true, recommendations: [{ id: `${channelKey}:${options.limit}` }] } },
      async getVideoRecommendations(channelKey, videoId, options) { calls.push(['getVideoRecommendations', channelKey, videoId, options]); return { success: true, recommendations: [{ id: `${channelKey}:${videoId}:${options.limit}` }] } },
      async logWatchEvent(channelKey, videoId, options) { calls.push(['logWatchEvent', channelKey, videoId, options.completed]); return { success: true, watched: `${channelKey}:${videoId}:${options.completed}` } },
    },
    identityManager: {},
    uploadManager: {},
    ctx: {},
    initializeIdentityFromMnemonic: async () => ({ needsRestart: false }),
    rpc: {},
    fs: {},
    path: {},
    generateAndStoreThumbnail: async () => null,
    transcoder: {},
  })

  assert.deepEqual(await backend.getRecommendations({ channelKey: 'channel', limit: 2 }), { success: true, recommendations: [{ id: 'channel:2' }] })
  assert.deepEqual(await backend.getVideoRecommendations({ channelKey: 'channel', videoId: 'video', limit: 3 }), { success: true, recommendations: [{ id: 'channel:video:3' }] })
  assert.deepEqual(await backend.logWatchEvent({ channelKey: 'channel', videoId: 'video', completed: true }), { success: true, watched: 'channel:video:true' })
  assert.deepEqual(calls.map((call) => call[0]), ['getRecommendations', 'getVideoRecommendations', 'logWatchEvent'])
})
