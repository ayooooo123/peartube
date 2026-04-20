import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyConfirmedFeedEntryBatches,
  applyConfirmedFeedVideoBatches,
  getFeedPreviewVideos,
  getFeedVideoHydrationMode,
  getFeedVideoLoadEntries,
  getMissingChannelMetaRequests,
  getVisibleSeededFeedEntries,
  reconcilePreviewFeedVideos,
  shouldRenderFeedVideo,
  filterRenderableFeedVideos,
} from '../lib/feed-hydration.js'

test('getMissingChannelMetaRequests dedupes channels and respects the visible-first limit', () => {
  const requests = getMissingChannelMetaRequests([
    { driveKey: 'a', publicBeeKey: 'bee-a' },
    { driveKey: 'a', publicBeeKey: 'bee-a-2' },
    { driveKey: 'b', publicBeeKey: 'bee-b' },
    { driveKey: 'c', publicBeeKey: 'bee-c' },
  ], { b: { name: 'Known' } }, 2)

  assert.deepEqual(requests, [
    { channelKey: 'a', publicBeeKey: 'bee-a' },
    { channelKey: 'c', publicBeeKey: 'bee-c' },
  ])
})

test('getVisibleSeededFeedEntries returns deduped feed entries in order', () => {
  const entries = getVisibleSeededFeedEntries([
    { driveKey: 'cached', peerCount: 0, publicBeeKey: 'bee-cached' },
    { driveKey: 'live', peerCount: 2, publicBeeKey: 'bee-live' },
    { driveKey: 'local', peerCount: 0, source: 'local', publicBeeKey: 'bee-local' },
    { driveKey: 'live', peerCount: 2, publicBeeKey: 'bee-live' },
  ], 3)

  assert.deepEqual(entries, [
    { driveKey: 'local', peerCount: 0, source: 'local', publicBeeKey: 'bee-local' },
    { driveKey: 'live', peerCount: 2, publicBeeKey: 'bee-live' },
    { driveKey: 'cached', peerCount: 0, publicBeeKey: 'bee-cached' },
  ])
})

test('getFeedVideoLoadEntries prioritizes local and live-peer entries before cached zero-peer entries', () => {
  const entries = getFeedVideoLoadEntries([
    { driveKey: 'cached', peerCount: 0, publicBeeKey: 'bee-cached' },
    { driveKey: 'live', peerCount: 3, publicBeeKey: 'bee-live' },
    { driveKey: 'b', peerCount: 3, publicBeeKey: 'bee-b' },
    { driveKey: 'local', peerCount: 0, source: 'local', publicBeeKey: 'bee-local' },
  ], 3)

  assert.deepEqual(entries, [
    { driveKey: 'local', peerCount: 0, source: 'local', publicBeeKey: 'bee-local' },
    { driveKey: 'live', peerCount: 3, publicBeeKey: 'bee-live' },
    { driveKey: 'b', peerCount: 3, publicBeeKey: 'bee-b' },
  ])
})

test('getFeedVideoHydrationMode uses local-only hydration for cached entries before peers arrive', () => {
  assert.equal(getFeedVideoHydrationMode({
    feedEntries: [{ driveKey: 'a' }],
    swarmStatus: { peers: 0, feedConnections: 0 },
  }), 'local-only')

  assert.equal(getFeedVideoHydrationMode({
    feedEntries: [{ driveKey: 'a' }],
    swarmStatus: { peers: 1, feedConnections: 0 },
  }), 'network')

  assert.equal(getFeedVideoHydrationMode({
    feedEntries: [{ driveKey: 'a' }],
    swarmStatus: { peers: 0, feedConnections: 1 },
  }), 'network')

  assert.equal(getFeedVideoHydrationMode({
    feedEntries: [],
    swarmStatus: { peers: 0, feedConnections: 0 },
  }), 'off')

  assert.equal(getFeedVideoHydrationMode({
    feedEntries: [{ driveKey: 'a', peerCount: 2 }],
    swarmStatus: null,
  }), 'network')
})

test('getFeedPreviewVideos only uses local or live-peer manifest previews', () => {
  const previews = getFeedPreviewVideos([
    {
      driveKey: 'cached-remote',
      peerCount: 0,
      publicBeeKey: 'bee-cached',
      previewVideos: [{
        id: 'stale-preview',
        title: 'Stale remote',
        uploadedAt: 10,
        availability: 'playable',
      }],
    },
    {
      driveKey: 'live-remote',
      peerCount: 2,
      publicBeeKey: 'bee-live',
      previewVideos: [{
        id: 'live-preview',
        title: 'Live remote',
        uploadedAt: 20,
        availability: 'playable',
      }],
    },
    {
      driveKey: 'local',
      source: 'local',
      peerCount: 0,
      publicBeeKey: 'bee-local',
      previewVideos: [{
        id: 'local-preview',
        title: 'Local video',
        uploadedAt: 30,
        availability: 'playable',
      }],
    },
  ], {
    'live-remote': { name: 'Live channel' },
    local: { name: 'Your channel' },
  }, 'local', 5)

  assert.deepEqual(previews.map((video) => ({
    id: video.id,
    channelKey: video.channelKey,
    publicBeeKey: video.publicBeeKey,
    channelName: video.channel?.name,
  })), [
    {
      id: 'local-preview',
      channelKey: 'local',
      publicBeeKey: 'bee-local',
      channelName: 'Your channel',
    },
    {
      id: 'live-preview',
      channelKey: 'live-remote',
      publicBeeKey: 'bee-live',
      channelName: 'Live channel',
    },
  ])
})

test('shouldRenderFeedVideo only accepts proven-playable remote videos but keeps the local channel visible', () => {
  assert.equal(shouldRenderFeedVideo({
    video: { channelKey: 'remote', availability: 'playable' },
    identityDriveKey: 'local',
  }), true)

  assert.equal(shouldRenderFeedVideo({
    video: { channelKey: 'remote', availability: 'unknown' },
    identityDriveKey: 'local',
  }), false)

  assert.equal(shouldRenderFeedVideo({
    video: { channelKey: 'local', availability: 'unknown' },
    identityDriveKey: 'local',
  }), true)
})

test('applyConfirmedFeedVideoBatches removes stale videos when a channel is confirmed empty', () => {
  const merged = applyConfirmedFeedVideoBatches([
    {
      id: 'stale-preview',
      channelKey: 'remote',
      uploadedAt: 10,
      availability: 'playable',
      _feedSource: 'preview',
    },
    {
      id: 'other-video',
      channelKey: 'other',
      uploadedAt: 20,
      availability: 'playable',
      _feedSource: 'hydrated',
    },
  ], [
    {
      channelKey: 'remote',
      confirmed: true,
      videos: [],
    },
  ])

  assert.deepEqual(merged, [{
    id: 'other-video',
    channelKey: 'other',
    uploadedAt: 20,
    availability: 'playable',
    _feedSource: 'hydrated',
  }])
})

test('applyConfirmedFeedVideoBatches preserves stale videos for unconfirmed empty channel refreshes', () => {
  const merged = applyConfirmedFeedVideoBatches([
    {
      id: 'stale-preview',
      channelKey: 'remote',
      uploadedAt: 10,
      availability: 'playable',
      _feedSource: 'preview',
    },
  ], [
    {
      channelKey: 'remote',
      confirmed: false,
      videos: [],
    },
  ])

  assert.deepEqual(merged, [{
    id: 'stale-preview',
    channelKey: 'remote',
    uploadedAt: 10,
    availability: 'playable',
    _feedSource: 'preview',
  }])
})

test('reconcilePreviewFeedVideos drops stale preview cards when a channel loses live preview eligibility', () => {
  const reconciled = reconcilePreviewFeedVideos([
    {
      id: 'stale-preview',
      channelKey: 'remote',
      uploadedAt: 10,
      availability: 'playable',
      _feedSource: 'preview',
    },
    {
      id: 'hydrated-video',
      channelKey: 'remote',
      uploadedAt: 30,
      availability: 'playable',
      _feedSource: 'hydrated',
    },
  ], [
    {
      channelKey: 'remote',
      peerCount: 0,
      publicBeeKey: 'bee-remote',
      previewVideos: [],
    },
  ], [])

  assert.deepEqual(reconciled, [
    {
      id: 'hydrated-video',
      channelKey: 'remote',
      uploadedAt: 30,
      availability: 'playable',
      _feedSource: 'hydrated',
    },
  ])
})

test('filterRenderableFeedVideos keeps cached playable hydrated videos while still dropping stale preview-only cards', () => {
  const filtered = filterRenderableFeedVideos([
    {
      id: 'cached-hydrated',
      channelKey: 'cached-remote',
      uploadedAt: 10,
      availability: 'playable',
      _feedSource: 'hydrated',
    },
    {
      id: 'cached-preview',
      channelKey: 'cached-remote',
      uploadedAt: 9,
      availability: 'playable',
      _feedSource: 'preview',
    },
    {
      id: 'live-hydrated',
      channelKey: 'live-remote',
      uploadedAt: 20,
      availability: 'playable',
      _feedSource: 'hydrated',
    },
    {
      id: 'local-video',
      channelKey: 'local',
      uploadedAt: 30,
      availability: 'unknown',
      _feedSource: 'local-seed',
    },
  ], [
    { driveKey: 'cached-remote', peerCount: 0, publicBeeKey: 'bee-cached' },
    { driveKey: 'live-remote', peerCount: 2, publicBeeKey: 'bee-live' },
    { driveKey: 'local', source: 'local', peerCount: 0, publicBeeKey: 'bee-local' },
  ], 'local', 10)

  assert.deepEqual(filtered, [
    {
      id: 'local-video',
      channelKey: 'local',
      uploadedAt: 30,
      availability: 'unknown',
      _feedSource: 'local-seed',
    },
    {
      id: 'live-hydrated',
      channelKey: 'live-remote',
      uploadedAt: 20,
      availability: 'playable',
      _feedSource: 'hydrated',
    },
    {
      id: 'cached-hydrated',
      channelKey: 'cached-remote',
      uploadedAt: 10,
      availability: 'playable',
      _feedSource: 'hydrated',
    },
  ])
})

test('reconcilePreviewFeedVideos replaces preview-derived cards for visible channels', () => {
  const reconciled = reconcilePreviewFeedVideos([
    {
      id: 'stale-preview',
      channelKey: 'remote',
      uploadedAt: 10,
      availability: 'playable',
      _feedSource: 'preview',
    },
    {
      id: 'hydrated-video',
      channelKey: 'remote',
      uploadedAt: 30,
      availability: 'playable',
      _feedSource: 'hydrated',
    },
    {
      id: 'other-preview',
      channelKey: 'other',
      uploadedAt: 15,
      availability: 'playable',
      _feedSource: 'preview',
    },
  ], [
    {
      channelKey: 'remote',
      peerCount: 1,
      previewVideos: [],
    },
  ], [])

  assert.deepEqual(reconciled, [
    {
      id: 'hydrated-video',
      channelKey: 'remote',
      uploadedAt: 30,
      availability: 'playable',
      _feedSource: 'hydrated',
    },
  ])
})

test('reconcilePreviewFeedVideos keeps hydrated cards when refreshed preview data for the same video arrives later', () => {
  const reconciled = reconcilePreviewFeedVideos([
    {
      id: 'same-video',
      channelKey: 'remote',
      uploadedAt: 30,
      availability: 'playable',
      title: 'Hydrated title',
      blobId: 'blob-123',
      thumbnailBlobId: 'thumb-123',
      _feedSource: 'hydrated',
    },
  ], [
    {
      channelKey: 'remote',
      peerCount: 1,
      previewVideos: [{
        id: 'same-video',
        uploadedAt: 30,
        availability: 'playable',
        title: 'Preview title',
      }],
    },
  ], [])

  assert.deepEqual(reconciled, [
    {
      id: 'same-video',
      channelKey: 'remote',
      uploadedAt: 30,
      availability: 'playable',
      title: 'Hydrated title',
      blobId: 'blob-123',
      thumbnailBlobId: 'thumb-123',
      _feedSource: 'hydrated',
    },
  ])
})

test('applyConfirmedFeedEntryBatches clears stale preview manifests once a channel is confirmed empty', () => {
  const updated = applyConfirmedFeedEntryBatches([
    {
      channelKey: 'remote',
      peerCount: 1,
      previewVideos: [{
        id: 'stale-preview',
        title: 'Old preview',
        uploadedAt: 10,
        availability: 'playable',
      }],
    },
    {
      channelKey: 'other',
      peerCount: 1,
      previewVideos: [{
        id: 'other-preview',
        title: 'Other preview',
        uploadedAt: 20,
        availability: 'playable',
      }],
    },
  ], [
    {
      channelKey: 'remote',
      confirmed: true,
      videos: [],
    },
  ])

  assert.deepEqual(updated, [
    {
      channelKey: 'remote',
      peerCount: 1,
      previewVideos: [],
    },
    {
      channelKey: 'other',
      peerCount: 1,
      previewVideos: [{
        id: 'other-preview',
        title: 'Other preview',
        uploadedAt: 20,
        availability: 'playable',
      }],
    },
  ])
})
