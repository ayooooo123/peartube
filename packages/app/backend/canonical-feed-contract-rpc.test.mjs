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
