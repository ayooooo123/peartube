import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getFeedPreviewVideos,
  getFeedVideoHydrationMode,
  getFeedVideoLoadEntries,
  getMissingChannelMetaRequests,
  getVisibleSeededFeedEntries,
  isConfirmedFeedHydrationResult,
  mergeHydratedFeedVideos,
  mergePreviewFeedVideos,
  shouldKeepFeedVideoForVisibleEntries,
  shouldRenderFeedVideo,
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
  ], 'stale cached remote preview without blob refs is ignored before a live peer proves availability')
})

test('getFeedPreviewVideos keeps relay manifest previews with direct blob refs even when peer count temporarily drops', () => {
  const previews = getFeedPreviewVideos([
    {
      driveKey: 'relay-archive',
      peerCount: 0,
      publicBeeKey: 'bee-relay',
      channelName: 'Relay archive',
      previewVideos: [{
        id: 'archived-video',
        title: 'Archived video',
        uploadedAt: 40,
        availability: 'playable',
        blobId: '0:8:0:1024',
        blobsCoreKey: 'aa'.repeat(32),
      }],
    },
  ], {}, 'local', 5)

  assert.deepEqual(previews.map((video) => ({
    id: video.id,
    channelKey: video.channelKey,
    publicBeeKey: video.publicBeeKey,
    channelName: video.channel?.name,
  })), [{
    id: 'archived-video',
    channelKey: 'relay-archive',
    publicBeeKey: 'bee-relay',
    channelName: 'Relay archive',
  }])
})

test('shouldKeepFeedVideoForVisibleEntries keeps restored snapshot cards until their channels are refreshed', () => {
  const seededFeedChannelKeys = new Set(['live-channel'])
  const snapshotChannelKeys = new Set(['cached-channel'])

  assert.equal(shouldKeepFeedVideoForVisibleEntries({
    video: { id: 'cached', channelKey: 'cached-channel', __feedSource: 'snapshot' },
    seededFeedChannelKeys,
    snapshotChannelKeys,
  }), true)

  assert.equal(shouldKeepFeedVideoForVisibleEntries({
    video: { id: 'live', channelKey: 'live-channel', __feedSource: 'hydrated' },
    seededFeedChannelKeys,
    snapshotChannelKeys,
  }), true)

  assert.equal(shouldKeepFeedVideoForVisibleEntries({
    video: { id: 'other', channelKey: 'other-channel', __feedSource: 'hydrated' },
    seededFeedChannelKeys,
    snapshotChannelKeys,
  }), false)
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

test('mergeHydratedFeedVideos replaces stale channel cards when a refreshed channel no longer has watchable videos', () => {
  const merged = mergeHydratedFeedVideos({
    previousVideos: [
      { id: 'stale-remote', channelKey: 'remote-a', uploadedAt: 30, availability: 'playable' },
      { id: 'keep-remote', channelKey: 'remote-b', uploadedAt: 20, availability: 'playable' },
    ],
    incomingVideos: [],
    refreshedChannelKeys: ['remote-a'],
    identityDriveKey: 'local',
    limit: 50,
  })

  assert.deepEqual(merged.map((video) => ({ id: video.id, channelKey: video.channelKey })), [
    { id: 'keep-remote', channelKey: 'remote-b' },
  ])
})

test('isConfirmedFeedHydrationResult only treats empty results as authoritative when the feed manifest explicitly resolved empty', () => {
  assert.equal(isConfirmedFeedHydrationResult({
    entry: { manifestUpdatedAt: 0, previewVideos: [] },
    resolved: true,
    videos: [],
  }), false)

  assert.equal(isConfirmedFeedHydrationResult({
    entry: { manifestUpdatedAt: 123, previewVideos: [] },
    resolved: true,
    videos: [],
  }), true)

  assert.equal(isConfirmedFeedHydrationResult({
    entry: { manifestUpdatedAt: 123, previewVideos: [{ id: 'preview-a' }] },
    resolved: true,
    videos: [{ id: 'full-a' }],
  }), true)

  assert.equal(isConfirmedFeedHydrationResult({
    entry: { manifestUpdatedAt: 123, previewVideos: [] },
    resolved: false,
    videos: [],
  }), false)
})

test('mergePreviewFeedVideos clears stale preview-only cards when the latest preview manifest is empty', () => {
  const merged = mergePreviewFeedVideos({
    previousVideos: [
      { id: 'stale-preview', channelKey: 'remote-a', uploadedAt: 30, availability: 'playable', __feedSource: 'preview' },
      { id: 'hydrated-keep', channelKey: 'remote-b', uploadedAt: 20, availability: 'playable' },
    ],
    previewVideos: [],
    limit: 50,
  })

  assert.deepEqual(merged.map((video) => ({ id: video.id, channelKey: video.channelKey })), [
    { id: 'hydrated-keep', channelKey: 'remote-b' },
  ])
})

test('mergePreviewFeedVideos does not overwrite hydrated cards with preview copies of the same video', () => {
  const merged = mergePreviewFeedVideos({
    previousVideos: [
      { id: 'shared-video', channelKey: 'remote-a', uploadedAt: 30, availability: 'playable', title: 'Hydrated title' },
    ],
    previewVideos: [
      { id: 'shared-video', channelKey: 'remote-a', uploadedAt: 10, availability: 'playable', title: 'Preview title' },
      { id: 'preview-only', channelKey: 'remote-b', uploadedAt: 20, availability: 'playable', title: 'Preview only' },
    ],
    limit: 50,
  })

  assert.deepEqual(merged.map((video) => ({
    id: video.id,
    channelKey: video.channelKey,
    title: video.title,
    source: video.__feedSource || 'hydrated',
  })), [
    { id: 'shared-video', channelKey: 'remote-a', title: 'Hydrated title', source: 'hydrated' },
    { id: 'preview-only', channelKey: 'remote-b', title: 'Preview only', source: 'preview' },
  ])
})
