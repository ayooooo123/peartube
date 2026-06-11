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

test('feed handlers use getPublicFeed for public and canonical RPC names', async () => {
  const backend = {}
  const calls = []
  const deps = createDeps({
    api: {
      getPublicFeed() {
        calls.push('getPublicFeed')
        return {
          entries: [{
            driveKey: 'channel-key',
            channelKey: 'channel-key',
            source: 'peer',
            publicBeeKey: 'public-bee-key',
            channelName: 'Manifest Channel',
            videoCount: 4,
            peerCount: 2,
            lastSeen: 123,
            manifestUpdatedAt: 456,
            previewVideos: [{ id: 'preview-1', title: 'Preview' }],
          }],
          stats: { totalEntries: 1, hiddenCount: 0, peerCount: 2 },
        }
      },
      getCanonicalFeed() {
        throw new Error('canonical feed should reuse getPublicFeed')
      },
    },
  })

  attachMobileHandlers(backend, deps)

  const expected = {
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
      isLive: false,
      liveStreams: [],
      previewVideos: [{ id: 'preview-1', title: 'Preview', byteAvailability: null, hasHeadBlock: false, contiguousBlocks: 0, readyForPlayback: false }],
    }],
    stats: {
      totalEntries: 1,
      hiddenCount: 0,
      peerCount: 2,
      feedConnections: 2,
      feedEntries: 1,
      channelsLoaded: 1,
    },
  }

  assert.deepEqual(await backend.getPublicFeed({}), expected)
  assert.deepEqual(await backend.getCanonicalFeed({}), expected)
  assert.deepEqual(calls, ['getPublicFeed', 'getPublicFeed'])
})

test('mobile video handlers preserve byte-readiness fields', async () => {
  const backend = {}
  const deps = createDeps({
    api: {
      async listVideos() {
        return [{
          id: 'video-1',
          title: 'Ready Video',
          availability: 'playable',
          byteAvailability: 'playable',
          hasHeadBlock: true,
          contiguousBlocks: 4,
          readyForPlayback: true,
          blobId: '0:4:0:512',
          blobsCoreKey: 'aa'.repeat(32),
        }]
      },
      async getPublicFeed() {
        return {
          entries: [{
            driveKey: 'channel-key',
            previewVideos: [{
              id: 'preview-1',
              availability: 'playable',
              byteAvailability: 'playable',
              hasHeadBlock: true,
              contiguousBlocks: 2,
              readyForPlayback: true,
            }],
          }],
        }
      },
    },
  })

  attachMobileHandlers(backend, deps)

  const listResult = await backend.listVideos({ channelKey: 'channel-key' })
  assert.equal(listResult.videos[0].byteAvailability, 'playable')
  assert.equal(listResult.videos[0].hasHeadBlock, true)
  assert.equal(listResult.videos[0].contiguousBlocks, 4)
  assert.equal(listResult.videos[0].readyForPlayback, true)

  const feedResult = await backend.getPublicFeed({})
  assert.equal(feedResult.entries[0].previewVideos[0].byteAvailability, 'playable')
  assert.equal(feedResult.entries[0].previewVideos[0].hasHeadBlock, true)
  assert.equal(feedResult.entries[0].previewVideos[0].contiguousBlocks, 2)
  assert.equal(feedResult.entries[0].previewVideos[0].readyForPlayback, true)
})

test('mobile getSeedingStatus reports normalized backend cache counters', async () => {
  const backend = {}
  const deps = createDeps({
    api: {
      async getSeedingStatus() {
        return {
          activeSeeds: 0,
          storageUsedBytes: 0,
          maxStorageGB: 5,
          config: { autoSeedWatched: false },
          seeds: [],
        }
      },
    },
  })

  attachMobileHandlers(backend, deps)

  assert.deepEqual(await backend.getSeedingStatus(), {
    status: {
      enabled: false,
      usedStorage: 0,
      maxStorage: 5 * 1024 * 1024 * 1024,
      seedingCount: 0,
    },
  })
})

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

test('getVideoThumbnail forwards feed preview blob refs to the API', async () => {
  const backend = {}
  const calls = []
  const deps = createDeps({
    api: {
      async getVideoThumbnail(channelKey, videoId, refs) {
        calls.push([channelKey, videoId, refs])
        return { url: 'http://127.0.0.1:1/thumb', exists: true }
      },
    },
  })

  attachMobileHandlers(backend, deps)

  const result = await backend.getVideoThumbnail({
    channelKey: 'channel-key',
    videoId: 'video-1',
    thumbnailBlobId: '0:4:0:1024',
    thumbnailBlobsCoreKey: 'a'.repeat(64),
  })

  // Gossip-discovered channels have no locally resolvable video record, so
  // dropping these refs (as the handler used to) meant mobile thumbnails for
  // feed previews could never resolve at all.
  assert.deepEqual(calls, [[
    'channel-key',
    'video-1',
    { thumbnailBlobId: '0:4:0:1024', thumbnailBlobsCoreKey: 'a'.repeat(64) },
  ]])
  assert.deepEqual(result, { url: 'http://127.0.0.1:1/thumb', exists: true, dataUrl: null })
})
