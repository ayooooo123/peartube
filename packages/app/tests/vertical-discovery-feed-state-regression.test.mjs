import test from 'node:test'
import assert from 'node:assert/strict'

import {
  mergeHydratedFeedVideos,
  mergePreviewFeedVideos,
} from '../lib/feed-hydration.js'

test('vertical discovery keeps cached hydrated videos when a refresh returns no previews yet', () => {
  const previousVideos = [
    { id: 'cached-a', channelKey: 'remote-a', uploadedAt: 30, availability: 'playable', __feedSource: 'hydrated' },
    { id: 'cached-b', channelKey: 'remote-b', uploadedAt: 20, availability: 'playable', __feedSource: 'hydrated' },
  ]

  const afterHydration = mergeHydratedFeedVideos({
    previousVideos,
    incomingVideos: [],
    refreshedChannelKeys: [],
    identityDriveKey: 'local',
    limit: 50,
  })

  const afterPreviewReconcile = mergePreviewFeedVideos({
    previousVideos: afterHydration,
    previewVideos: [],
    limit: 50,
  })

  assert.deepEqual(afterPreviewReconcile.map((video) => video.id), ['cached-a', 'cached-b'])
})

test('vertical discovery can replace one live channel without dropping unrelated cached videos', () => {
  const previousVideos = [
    { id: 'old-live', channelKey: 'live-a', uploadedAt: 10, availability: 'playable', __feedSource: 'hydrated' },
    { id: 'cached-b', channelKey: 'remote-b', uploadedAt: 20, availability: 'playable', __feedSource: 'hydrated' },
  ]

  const merged = mergeHydratedFeedVideos({
    previousVideos,
    incomingVideos: [
      { id: 'fresh-live', channelKey: 'live-a', uploadedAt: 40, availability: 'playable' },
    ],
    refreshedChannelKeys: ['live-a'],
    identityDriveKey: 'local',
    limit: 50,
  })

  assert.deepEqual(merged.map((video) => ({ id: video.id, channelKey: video.channelKey })), [
    { id: 'fresh-live', channelKey: 'live-a' },
    { id: 'cached-b', channelKey: 'remote-b' },
  ])
})
