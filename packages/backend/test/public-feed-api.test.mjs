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
    manifestUpdatedAt: 0,
    previewVideos: [],
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

test('getPublicFeed exposes serving manifest previews when present', (t) => {
  const api = createApi({
    ctx: {},
    publicFeed: {
      getFeed() {
        return [{
          driveKey: '99'.repeat(32),
          publicBeeKey: '88'.repeat(32),
          addedAt: 5,
          source: 'peer',
          peerCount: 1,
          channelName: 'Preview Channel',
          videoCount: 4,
          manifestUpdatedAt: 1234,
          previewVideos: [{
            id: 'video-preview',
            title: 'Manifest video',
            uploadedAt: 123,
            blobId: '0:8:0:1024',
            blobsCoreKey: '77'.repeat(32),
            mimeType: 'video/mp4',
            availability: 'playable',
          }],
        }]
      },
      getStats() {
        return {
          totalEntries: 1,
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
  t.is(result.entries.length, 1)
  t.is(result.entries[0].channelName, 'Preview Channel')
  t.is(result.entries[0].videoCount, 4)
  t.is(result.entries[0].manifestUpdatedAt, 1234)
  t.alike(result.entries[0].previewVideos, [{
    id: 'video-preview',
    title: 'Manifest video',
    uploadedAt: 123,
    blobId: '0:8:0:1024',
    blobsCoreKey: '77'.repeat(32),
    mimeType: 'video/mp4',
    availability: 'playable',
  }])
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

test('listVideos marks videos unavailable when neither local cache nor peer hints prove playback', async (t) => {
  const driveKey = 'ee'.repeat(32)
  const publicBeeKey = 'ff'.repeat(32)
  const blobsCoreKey = 'aa'.repeat(32)
  const requestCalls = []

  const api = createApi({
    ctx: {
      store: {
        get() {
          return {
            async ready() {},
            async has() {
              return false
            },
          }
        },
      },
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
    publicFeed: {
      async requestAvailabilityHints(requests) {
        requestCalls.push(requests)
        return []
      },
    },
    loadPublicBee: async () => ({
      async listVideos() {
        return [{
          id: 'video-3',
          title: 'Needs proof',
          uploadedAt: 3,
          blobId: '0:8:0:1024',
          blobsCoreKey,
        }]
      },
      async getVideo(id) {
        return {
          id,
          title: 'Needs proof',
          uploadedAt: 3,
          blobId: '0:8:0:1024',
          blobsCoreKey,
        }
      },
    }),
  })

  const videos = await api.listVideos(driveKey, publicBeeKey)

  t.is(requestCalls.length, 1)
  t.is(videos.length, 1)
  t.is(videos[0]?.availability, 'unavailable')
})

test('listVideos revalidates cached remote availability on each read', async (t) => {
  const driveKey = '12'.repeat(32)
  const publicBeeKey = '34'.repeat(32)
  const blobsCoreKey = '56'.repeat(32)
  let requestCount = 0

  const api = createApi({
    ctx: {
      store: {
        get() {
          return {
            async ready() {},
            async has() {
              return false
            },
          }
        },
      },
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
    publicFeed: {
      async requestAvailabilityHints() {
        requestCount += 1
        if (requestCount === 1) {
          return [{
            driveKey,
            id: 'video-4',
            availability: 'playable',
            hasHeadBlock: true,
            contiguousBlocks: 8,
          }]
        }
        return []
      },
    },
    loadPublicBee: async () => ({
      async listVideos() {
        return [{
          id: 'video-4',
          title: 'Remote peer only',
          uploadedAt: 4,
          blobId: '0:8:0:1024',
          blobsCoreKey,
        }]
      },
      async getVideo(id) {
        return {
          id,
          title: 'Remote peer only',
          uploadedAt: 4,
          blobId: '0:8:0:1024',
          blobsCoreKey,
        }
      },
    }),
  })

  const first = await api.listVideos(driveKey, publicBeeKey)
  const second = await api.listVideos(driveKey, publicBeeKey)

  t.is(first[0]?.availability, 'playable')
  t.is(second[0]?.availability, 'unavailable')
  t.is(requestCount, 2)
})

test('getFeedSnapshotEntries keeps manifestUpdatedAt stable for unchanged public bee content', async (t) => {
  const originalDateNow = Date.now
  let now = 1000
  Date.now = () => now

  try {
    const api = createApi({
      ctx: {
        metaDb: {
          async get() { return null },
          async put() {},
        },
      },
      loadPublicBee: async () => ({
        core: { length: 9 },
        async getMetadata() {
          return { name: 'Stable Channel', updatedAt: 77 }
        },
        async listVideos() {
          return [{
            id: 'video-stable',
            title: 'Stable preview',
            uploadedAt: 42,
            syncedAt: 88,
            blobId: '0:8:0:1024',
            blobsCoreKey: '99'.repeat(32),
          }]
        },
        async getVideo(id) {
          return {
            id,
            title: 'Stable preview',
            uploadedAt: 42,
            syncedAt: 88,
            blobId: '0:8:0:1024',
            blobsCoreKey: '99'.repeat(32),
          }
        },
      }),
    })

    const first = await api.getFeedSnapshotEntries([{ driveKey: 'ab'.repeat(32), publicBeeKey: 'cd'.repeat(32) }])
    now = 5000
    const second = await api.getFeedSnapshotEntries([{ driveKey: 'ab'.repeat(32), publicBeeKey: 'cd'.repeat(32) }])

    t.is(first.length, 1)
    t.is(second.length, 1)
    t.is(first[0].manifestUpdatedAt, 88)
    t.is(second[0].manifestUpdatedAt, 88)
  } finally {
    Date.now = originalDateNow
  }
})

test('submitToFeed fails closed when the channel cannot provide a publicBeeKey', async (t) => {
  let submitted = false

  const api = createApi({
    ctx: {
      metaDb: {
        async get() { return null },
        async put() {},
      },
    },
    publicFeed: {
      async submitChannel() {
        submitted = true
      },
    },
    loadChannel: async () => ({
      publicBeeKey: null,
      async getPublicBeeKey() {
        return null
      },
      async getCommentsAutobase() {
        return null
      },
    }),
  })

  const result = await api.submitToFeed('ef'.repeat(32))

  t.is(result.success, false)
  t.is(submitted, false)
  t.ok(/publicBeeKey/i.test(result.error || ''))
})
