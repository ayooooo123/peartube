import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearHydratedFeedChannels,
  getVerticalFeedPreviewVideos,
  mapHydratedVerticalFeedVideos,
  mergeUniqueFeedVideos,
  warmNextPlaybackUrls,
  withFeedTimeout,
} from '../lib/discover-feed-controller.js'

test('vertical feed controller falls back when feed RPC times out', async () => {
  const fallback = { entries: [] }
  const result = await withFeedTimeout(new Promise(() => {}), 5, fallback)

  assert.equal(result, fallback)
})

test('vertical feed controller dedupes preview and hydrated videos by channel/video key', () => {
  const merged = mergeUniqueFeedVideos([
    { id: 'a', channelKey: 'one', title: 'old' },
    { id: 'b', channelKey: 'one', title: 'keep' },
  ], [
    { id: 'a', channelKey: 'one', title: 'new' },
    { id: 'c', channelKey: 'two', title: 'add' },
  ])

  assert.deepEqual(merged.map((video) => [video.channelKey, video.id, video.title]), [
    ['one', 'a', 'new'],
    ['one', 'b', 'keep'],
    ['two', 'c', 'add'],
  ])
})

test('vertical feed controller filters preview videos through renderability policy', () => {
  const videos = getVerticalFeedPreviewVideos([
    {
      driveKey: 'stale-remote',
      peerCount: 0,
      previewVideos: [{ id: 'stale', availability: 'playable', uploadedAt: 30 }],
    },
    {
      driveKey: 'live-remote',
      peerCount: 2,
      publicBeeKey: 'bee-live',
      channelName: 'Live',
      previewVideos: [
        { id: 'playable', availability: 'playable', uploadedAt: 20 },
        { id: 'unknown', availability: 'unknown', uploadedAt: 10 },
      ],
    },
  ], { identityDriveKey: 'local', limit: 10 })

  assert.deepEqual(videos.map((video) => ({
    id: video.id,
    channelKey: video.channelKey,
    publicBeeKey: video.publicBeeKey,
  })), [
    { id: 'playable', channelKey: 'live-remote', publicBeeKey: 'bee-live' },
  ])
})

test('vertical feed controller maps hydrated videos with channel metadata and renderability policy', () => {
  const mapped = mapHydratedVerticalFeedVideos({
    driveKey: 'remote',
    publicBeeKey: 'bee-remote',
    channelName: 'Remote Channel',
  }, [
    { id: 'playable', availability: 'playable' },
    { id: 'unknown', availability: 'unknown' },
  ], { identityDriveKey: 'local' })

  assert.deepEqual(mapped, [{
    id: 'playable',
    availability: 'playable',
    channelKey: 'remote',
    publicBeeKey: 'bee-remote',
    channel: { name: 'Remote Channel' },
  }])
})

test('vertical feed refresh clears hydrated channel state through controller helper', () => {
  const hydratedChannelsRef = { current: new Set(['one', 'two']) }

  clearHydratedFeedChannels(hydratedChannelsRef)

  assert.equal(hydratedChannelsRef.current.size, 0)
})

test('vertical feed controller prewarms next playback URLs best-effort', async () => {
  const prepared = []
  const cached = new Map([['one:a', 'http://cached/a']])

  await warmNextPlaybackUrls({
    videos: [
      { id: 'current', channelKey: 'one' },
      { id: 'a', channelKey: 'one' },
      { id: 'b', channelKey: 'one' },
      { id: 'c', channelKey: 'two' },
    ],
    activeIndex: 0,
    makePlaybackRequest(video) {
      return {
        cacheKey: `${video.channelKey}:${video.id}`,
        playbackRequest: { channelKey: video.channelKey, videoId: video.id },
      }
    },
    getCachedVideoUrl(cacheKey) {
      return cached.get(cacheKey)
    },
    setCachedVideoUrl(cacheKey, url) {
      cached.set(cacheKey, url)
    },
    async preparePlayback(request) {
      prepared.push(request)
      if (request.videoId === 'c') throw new Error('network flake')
      return { url: `http://prepared/${request.videoId}` }
    },
  })

  assert.deepEqual(prepared, [
    { channelKey: 'one', videoId: 'b' },
    { channelKey: 'two', videoId: 'c' },
  ])
  assert.equal(cached.get('one:b'), 'http://prepared/b')
})
