import test from 'brittle'

import { createApi } from '../src/api.js'

test('getPublicFeed returns peer entries even when publicBeeKey is absent', (t) => {
  const api = createApi({
    ctx: {},
    publicFeed: {
      getFeed() {
        return [
          {
            driveKey: '11'.repeat(32),
            publicBeeKey: null,
            addedAt: 1,
            source: 'peer',
          },
          {
            driveKey: '22'.repeat(32),
            publicBeeKey: '33'.repeat(32),
            addedAt: 2,
            source: 'peer',
          },
        ]
      },
      getStats() {
        return {
          totalEntries: 2,
          hiddenCount: 0,
          peerCount: 1,
        }
      },
      requestFeedsFromPeers() {
        return 1
      },
    },
  })

  const result = api.getPublicFeed()

  t.is(result.entries.length, 2)
  t.is(result.stats.peerCount, 1)
  t.is(result.stats.keyedEntries, 1)
  t.is(result.stats.unkeyedEntries, 1)
  t.alike(result.entries[0], {
    driveKey: '11'.repeat(32),
    channelKey: '11'.repeat(32),
    source: 'peer',
    publicBeeKey: null,
    channelName: null,
    videoCount: 0,
    peerCount: 0,
    lastSeen: 1,
  })
})

test('getPublicFeed forwards live per-entry peer counts', (t) => {
  const api = createApi({
    ctx: {},
    publicFeed: {
      getFeed() {
        return [{
          driveKey: '44'.repeat(32),
          publicBeeKey: '55'.repeat(32),
          addedAt: 3,
          source: 'peer',
          peerCount: 2,
        }]
      },
      getStats() {
        return {
          totalEntries: 1,
          hiddenCount: 0,
          peerCount: 2,
        }
      },
      requestFeedsFromPeers() {
        return 2
      },
    },
  })

  const result = api.getPublicFeed()
  t.is(result.entries.length, 1)
  t.is(result.entries[0].peerCount, 2)
})

test('getPublicFeed omits stale peer entries with zero live seeders but keeps local ones', (t) => {
  const api = createApi({
    ctx: {},
    publicFeed: {
      getFeed() {
        return [{
          driveKey: '66'.repeat(32),
          publicBeeKey: '77'.repeat(32),
          addedAt: 4,
          source: 'local',
          peerCount: 1,
        }]
      },
      getStats() {
        return {
          totalEntries: 1,
          hiddenCount: 0,
          peerCount: 0,
        }
      },
      requestFeedsFromPeers() {
        return 0
      },
    },
  })

  const result = api.getPublicFeed()
  t.is(result.entries.length, 1)
  t.is(result.entries[0].channelKey, '66'.repeat(32))
})

test('listVideos falls back to channel reads when a keyed public bee returns no videos', async (t) => {
  let publicBeeLoads = 0
  let channelLoads = 0

  const api = createApi({
    ctx: {
      semanticFinder: {
        hasVideo() {
          return true
        },
      },
      metaDb: {
        async get() { return null },
        async put() {},
      },
    },
    loadPublicBee: async () => {
      publicBeeLoads += 1
      return {
        async listVideos() {
          return []
        },
        async getVideo() {
          return null
        },
      }
    },
    loadChannel: async () => {
      channelLoads += 1
      return {
        async listVideos() {
          return [{
            id: 'video-1',
            title: 'Recovered from channel',
            uploadedAt: 1,
          }]
        },
        async getVideo(id) {
          return {
            id,
            title: 'Recovered from channel',
            uploadedAt: 1,
          }
        },
      }
    },
  })

  const videos = await api.listVideos('aa'.repeat(32), 'bb'.repeat(32))

  t.is(publicBeeLoads, 1)
  t.is(channelLoads, 1)
  t.is(videos.length, 1)
  t.is(videos[0]?.id, 'video-1')
  t.is(videos[0]?.channelKey, 'aa'.repeat(32))
  t.is(videos[0]?.publicBeeKey, 'bb'.repeat(32))
})

test('listVideos falls back to the owner public bee when the channel view is empty', async (t) => {
  let channelLoads = 0
  let publicBeeReads = 0

  const api = createApi({
    ctx: {
      semanticFinder: {
        hasVideo() {
          return true
        },
      },
      metaDb: {
        async get() { return null },
        async put() {},
      },
    },
    loadChannel: async () => {
      channelLoads += 1
      return {
        publicBeeKey: 'cc'.repeat(32),
        publicBee: {
          async listVideos() {
            publicBeeReads += 1
            return [{
              id: 'video-2',
              title: 'Recovered from owner public bee',
              uploadedAt: 2,
            }]
          },
          async getVideo(id) {
            return {
              id,
              title: 'Recovered from owner public bee',
              uploadedAt: 2,
            }
          },
        },
        async listVideos() {
          return []
        },
        async getVideo() {
          return null
        },
      }
    },
  })

  const videos = await api.listVideos('dd'.repeat(32))

  t.is(channelLoads, 1)
  t.is(publicBeeReads, 1)
  t.is(videos.length, 1)
  t.is(videos[0]?.id, 'video-2')
  t.is(videos[0]?.channelKey, 'dd'.repeat(32))
  t.is(videos[0]?.publicBeeKey, 'cc'.repeat(32))
})
