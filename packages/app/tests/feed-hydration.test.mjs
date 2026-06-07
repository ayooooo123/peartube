import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getFeedPreviewVideos,
  hasDirectBlobReadinessProof,
  getFeedVideoHydrationMode,
  getFeedVideoLoadEntries,
  getMissingChannelMetaRequests,
  getVisibleSeededFeedEntries,
  isConfirmedFeedHydrationResult,
  mergeHydratedFeedVideos,
  mergePreviewFeedVideos,
  selectFeedEntryVideosWithPreviewFallback,
  shouldKeepFeedVideoForVisibleEntries,
  isFeedVideoPlaybackReady,
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

test('getFeedVideoLoadEntries prioritizes playable relay archive previews before stale live-peer entries', () => {
  const directPlayable = {
    driveKey: 'relay-playable',
    peerCount: 0,
    publicBeeKey: 'bee-relay',
    previewVideos: [{
      id: 'playable-archive',
      availability: 'playable',
      byteAvailability: 'playable',
      blobId: '0:1:0:32',
      blobsCoreKey: 'aa'.repeat(32),
      hasHeadBlock: true,
      contiguousBlocks: 1,
      readyForPlayback: true,
    }],
  }
  const staleLive = { driveKey: 'stale-live', peerCount: 4, publicBeeKey: 'bee-live', previewVideos: [] }
  const cached = { driveKey: 'cached', peerCount: 0, publicBeeKey: 'bee-cached', previewVideos: [] }

  const entries = getFeedVideoLoadEntries([
    staleLive,
    cached,
    directPlayable,
  ], 2)

  assert.deepEqual(entries.map((entry) => entry.driveKey), [
    'relay-playable',
    'stale-live',
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

  assert.equal(getFeedVideoHydrationMode({
    feedEntries: [{
      driveKey: 'relay-archive',
      publicBeeKey: 'bee-relay',
      peerCount: 0,
      previewVideos: [{ id: 'direct', blobId: '0:8:0:1024', blobsCoreKey: 'aa'.repeat(32) }],
    }],
    swarmStatus: { peers: 0, feedConnections: 0 },
  }), 'network')

  assert.equal(getFeedVideoHydrationMode({
    feedEntries: [{ driveKey: 'status-backed', peerCount: 0 }],
    swarmStatus: { peers: 0, feedConnections: 0, feedEntries: 88 },
  }), 'network')
})

test('selectFeedEntryVideosWithPreviewFallback uses direct feed previews when hydration returns empty', () => {
  const previews = [{
    id: 'relay-preview',
    title: 'Relay archive',
    uploadedAt: 40,
    availability: 'playable',
    blobId: '0:8:0:1024',
    blobsCoreKey: 'aa'.repeat(32),
    hasHeadBlock: true,
    contiguousBlocks: 1,
    readyForPlayback: true,
  }]

  assert.equal(selectFeedEntryVideosWithPreviewFallback([], previews), previews)
  assert.deepEqual(selectFeedEntryVideosWithPreviewFallback([{ id: 'hydrated' }], previews), [{ id: 'hydrated' }])
  assert.deepEqual(selectFeedEntryVideosWithPreviewFallback([], []), [])
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
        hasHeadBlock: true,
        contiguousBlocks: 1,
        readyForPlayback: true,
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

test('feed readiness separates visible direct-blob cards from playable direct-blob cards', () => {
  const directWithoutBytes = {
    channelKey: 'remote',
    availability: 'playable',
    byteAvailability: 'playable',
    blobId: '0:1:0:32',
    blobsCoreKey: 'aa'.repeat(32),
  }

  assert.equal(shouldRenderFeedVideo({
    video: directWithoutBytes,
    identityDriveKey: 'local',
  }), true)
  assert.equal(hasDirectBlobReadinessProof(directWithoutBytes), false)
  assert.equal(isFeedVideoPlaybackReady(directWithoutBytes, 'local'), false)

  const directWithBytes = {
    ...directWithoutBytes,
    hasHeadBlock: true,
    contiguousBlocks: 1,
  }
  assert.equal(hasDirectBlobReadinessProof(directWithBytes), true)
  assert.equal(isFeedVideoPlaybackReady(directWithBytes, 'local'), true)

  assert.equal(shouldRenderFeedVideo({
    video: { channelKey: 'remote', availability: 'unknown', playbackSupport: 'unverified-container' },
    identityDriveKey: 'local',
  }), false)

  assert.equal(shouldRenderFeedVideo({
    video: { channelKey: 'remote', byteAvailability: 'playable', playbackSupport: 'unverified-container' },
    identityDriveKey: 'local',
  }), true)

  assert.equal(shouldRenderFeedVideo({
    video: { channelKey: 'local', availability: 'unknown' },
    identityDriveKey: 'local',
  }), true)
})


test('feed preview videos keep unverified mirrored media visible when byte availability is marked playable', () => {
  const videos = getFeedPreviewVideos([{
    driveKey: 'remote-a',
    publicBeeKey: 'bb'.repeat(32),
    previewVideos: [{
      id: 'mkv-preview',
      title: 'MKV Preview',
      uploadedAt: 10,
      availability: 'playable',
      playbackSupport: 'unverified-container',
      blobId: '0:1:0:32',
      blobsCoreKey: 'cc'.repeat(32),
      hasHeadBlock: true,
      contiguousBlocks: 1,
      readyForPlayback: true,
    }],
  }], {}, undefined, 5)

  assert.equal(videos.length, 1)
  assert.equal(videos[0].id, 'mkv-preview')
  assert.equal(videos[0].availability, 'playable')
  assert.equal(videos[0].playbackSupport, 'unverified-container')
})

test('backend preview fallback refuses to convert feed peer metadata into byte readiness', async () => {
  const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../backend/src/api.js', import.meta.url), 'utf8'))
  const previewHelper = source.slice(
    source.indexOf('function previewVideosFromFeedEntry'),
    source.indexOf('function getPreviewVideoFromFeed'),
  )
  const availabilityBlock = source.slice(
    source.indexOf('const resolveExplicitVideoAvailability'),
    source.indexOf('const cached = listVideosCache.get'),
  )

  assert.doesNotMatch(previewHelper, /feedEntryHasLivePeer/, 'feed peer counts must not mark selected direct blobs playable')
  assert.match(previewHelper, /hasByteProof/, 'preview fallback should carry byte proof only from preview video fields')
  assert.match(availabilityBlock, /Feed peers, relay metadata, and stale playable labels are[\s\S]*not media readiness/, 'availability revalidation should reject stale playable metadata without byte proof')
  assert.match(availabilityBlock, /explicitAvailability === 'playable' && hasVideoByteProof\(video\)/, 'explicit playable labels must require direct byte proof')
})

test('mergeHydratedFeedVideos replaces stale channel cards when a refreshed channel no longer has watchable videos', () => {
  const merged = mergeHydratedFeedVideos({
    previousVideos: [
      { id: 'stale-remote', channelKey: 'remote-a', uploadedAt: 30, availability: 'playable' },
      { id: 'keep-remote', channelKey: 'remote-b', uploadedAt: 20, availability: 'playable' },
    ],
    incomingVideos: [],
    refreshedChannelKeys: ['remote-a'],
    feedEntries: [
      { driveKey: 'remote-a', manifestUpdatedAt: 123, previewVideos: [] },
    ],
    identityDriveKey: 'local',
    limit: 50,
  })

  assert.deepEqual(merged.map((video) => ({ id: video.id, channelKey: video.channelKey })), [
    { id: 'keep-remote', channelKey: 'remote-b' },
  ])
})

test('mergeHydratedFeedVideos preserves preview-backed cards when channel hydration returns an empty partial result', () => {
  const merged = mergeHydratedFeedVideos({
    previousVideos: [
      { id: 'preview-a', channelKey: 'remote-a', uploadedAt: 30, availability: 'playable', __feedSource: 'preview' },
      { id: 'keep-remote', channelKey: 'remote-b', uploadedAt: 20, availability: 'playable' },
    ],
    incomingVideos: [],
    refreshedChannelKeys: ['remote-a'],
    feedEntries: [
      {
        driveKey: 'remote-a',
        manifestUpdatedAt: 123,
        previewVideos: [{ id: 'preview-a', availability: 'playable' }],
      },
    ],
    identityDriveKey: 'local',
    limit: 50,
  })

  assert.deepEqual(merged.map((video) => ({ id: video.id, channelKey: video.channelKey, source: video.__feedSource || 'hydrated' })), [
    { id: 'preview-a', channelKey: 'remote-a', source: 'preview' },
    { id: 'keep-remote', channelKey: 'remote-b', source: 'hydrated' },
  ])
})

test('mergeHydratedFeedVideos preserves feed preview blob refs when hydration omits them', () => {
  const merged = mergeHydratedFeedVideos({
    previousVideos: [
      {
        id: 'shared-video',
        channelKey: 'remote-a',
        uploadedAt: 30,
        availability: 'playable',
        blobId: '0:4:0:1024',
        blobsCoreKey: 'aa'.repeat(32),
        mimeType: 'video/mp4',
        publicBeeKey: 'bee-preview',
        byteAvailability: 'playable',
        hasHeadBlock: true,
        contiguousBlocks: 4,
        readyForPlayback: true,
        __feedSource: 'preview',
      },
    ],
    incomingVideos: [
      {
        id: 'shared-video',
        channelKey: 'remote-a',
        uploadedAt: 40,
        availability: 'playable',
        title: 'Hydrated title',
      },
    ],
    refreshedChannelKeys: ['remote-a'],
    feedEntries: [
      {
        driveKey: 'remote-a',
        manifestUpdatedAt: 123,
        previewVideos: [{ id: 'shared-video', availability: 'playable' }],
      },
    ],
    identityDriveKey: 'local',
    limit: 50,
  })

  assert.equal(merged.length, 1)
  assert.equal(merged[0].title, 'Hydrated title')
  assert.equal(merged[0].blobId, '0:4:0:1024')
  assert.equal(merged[0].blobsCoreKey, 'aa'.repeat(32))
  assert.equal(merged[0].mimeType, 'video/mp4')
  assert.equal(merged[0].publicBeeKey, 'bee-preview')
  assert.equal(merged[0].byteAvailability, 'playable')
  assert.equal(merged[0].hasHeadBlock, true)
  assert.equal(merged[0].contiguousBlocks, 4)
  assert.equal(merged[0].readyForPlayback, true)
  assert.equal(merged[0].__feedSource, 'hydrated')
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
    videos: [],
  }), false)

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
