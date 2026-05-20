import assert from 'node:assert/strict'
import test from 'node:test'

import { attachMobileHandlers } from '../src/mobile-handlers.js'

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

test('uploadVideo re-gossips an already-published mobile channel after thumbnail metadata is stored', async () => {
  const backend = {}
  const calls = []
  let thumbnailUpdated = false
  const activeIdentity = { driveKey: 'aa'.repeat(32) }
  const channel = {
    blobs: {},
    async updateVideo(videoId, updates) {
      calls.push(['updateVideo', videoId, updates.thumbnailBlobId])
      thumbnailUpdated = true
    },
  }
  const deps = createDeps({
    identityManager: {
      getActiveIdentity() {
        return activeIdentity
      },
      async getActiveChannel() {
        return channel
      },
    },
    uploadManager: {
      async uploadFromPath(receivedChannel, filePath, options) {
        calls.push(['uploadFromPath', receivedChannel === channel, filePath, options.title])
        return { success: true, videoId: 'video-1' }
      },
    },
    api: {
      invalidateChannelCaches(driveKey) {
        calls.push(['invalidate', driveKey])
      },
      async isChannelPublished(driveKey) {
        calls.push(['isChannelPublished', driveKey])
        return { published: true }
      },
      async submitToFeed(driveKey) {
        assert.equal(thumbnailUpdated, true, 'feed gossip should refresh after thumbnail metadata is committed')
        calls.push(['submitToFeed', driveKey])
        return { success: true }
      },
    },
    generateAndStoreThumbnail: async (filePath, videoId) => {
      calls.push(['generateThumbnail', filePath, videoId])
      return {
        thumbnailBlobId: 'thumb-blob',
        thumbnailBlobsCoreKey: 'bb'.repeat(32),
        thumbnailMimeType: 'image/jpeg',
      }
    },
  })

  attachMobileHandlers(backend, deps)

  assert.deepEqual(await backend.uploadVideo({
    filePath: 'file:///tmp/demo.mp4',
    title: 'Demo',
    description: 'Uploaded from device',
  }), {
    video: {
      id: 'video-1',
      title: 'Demo',
      description: 'Uploaded from device',
      channelKey: activeIdentity.driveKey,
    },
  })

  assert.deepEqual(calls.map(([name]) => name), [
    'uploadFromPath',
    'invalidate',
    'generateThumbnail',
    'updateVideo',
    'isChannelPublished',
    'submitToFeed',
  ])
})
