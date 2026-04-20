import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createInitialDiscoverFeedCacheState,
  snapshotDiscoverFeedCache,
  resetDiscoverFeedCache,
} from '../lib/discover-feed-cache.js'

test('discover feed cache restores hydrated videos and entries across remount-style reinitialization', () => {
  resetDiscoverFeedCache()

  snapshotDiscoverFeedCache({
    feedEntries: [
      { driveKey: 'remote-a', channelKey: 'remote-a', peerCount: 0, previewVideos: [] },
      { driveKey: 'local', channelKey: 'local', source: 'local', peerCount: 0, previewVideos: [] },
    ],
    feedVideos: [
      { id: 'cached-1', channelKey: 'remote-a', availability: 'playable', _feedSource: 'hydrated' },
      { id: 'cached-2', channelKey: 'local', availability: 'unknown', _feedSource: 'local-seed' },
    ],
    channelMeta: {
      'remote-a': { name: 'Remote A' },
    },
    peerCount: 3,
    lastFeedRefresh: 123,
    swarmStatus: { peers: 2, feedConnections: 1, channels: 4 },
  })

  assert.deepEqual(createInitialDiscoverFeedCacheState(), {
    feedEntries: [
      { driveKey: 'remote-a', channelKey: 'remote-a', peerCount: 0, previewVideos: [] },
      { driveKey: 'local', channelKey: 'local', source: 'local', peerCount: 0, previewVideos: [] },
    ],
    feedVideos: [
      { id: 'cached-1', channelKey: 'remote-a', availability: 'playable', _feedSource: 'hydrated' },
      { id: 'cached-2', channelKey: 'local', availability: 'unknown', _feedSource: 'local-seed' },
    ],
    channelMeta: {
      'remote-a': { name: 'Remote A' },
    },
    peerCount: 3,
    lastFeedRefresh: 123,
    swarmStatus: { peers: 2, feedConnections: 1, channels: 4 },
  })
})
