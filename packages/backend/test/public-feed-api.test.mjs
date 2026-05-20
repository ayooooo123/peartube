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
    relayRole: null,
    relayServing: false,
    catalogVersion: null,
    previewVideosHash: null,
    channelName: null,
    videoCount: 0,
    peerCount: 0,
    discoveryOnly: false,
    restoredFromCache: false,
    restoredFrom: null,
    requiresAvailabilityProbe: false,
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

test('listVideos uses feed previews instead of slow channel fallback when keyed public bee is empty', async (t) => {
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
    publicFeed: {
      getFeed() {
        return [{
          driveKey: 'aa'.repeat(32),
          publicBeeKey: 'bb'.repeat(32),
          addedAt: 1,
          source: 'peer',
          peerCount: 1,
          previewVideos: [{
            id: 'video-1',
            title: 'Recovered from preview',
            uploadedAt: 1,
            availability: 'playable',
            blobId: '0:8:0:1024',
            blobsCoreKey: 'cc'.repeat(32),
          }],
        }]
      },
      getStats() { return { totalEntries: 1, hiddenCount: 0, peerCount: 1 } },
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
      throw new Error('should not load channel for preview-backed peer feed')
    },
  })

  const videos = await api.listVideos('aa'.repeat(32), 'bb'.repeat(32))

  t.is(publicBeeLoads, 1)
  t.is(channelLoads, 0)
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
  t.is(videos[0]?.byteAvailability, 'unavailable')
})

test('listVideos does not mark remote videos playable from unrelated swarm peers alone', async (t) => {
  const driveKey = 'ab'.repeat(32)
  const publicBeeKey = 'cd'.repeat(32)
  const blobsCoreKey = 'ef'.repeat(32)

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
      swarm: {
        connections: new Set([{}]),
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
        throw new Error('hint transport timeout')
      },
    },
    loadPublicBee: async () => ({
      async listVideos() {
        return [{
          id: 'video-fallback',
          title: 'Fallback to swarm peers',
          uploadedAt: 5,
          blobId: '0:8:0:1024',
          blobsCoreKey,
        }]
      },
      async getVideo(id) {
        return {
          id,
          title: 'Fallback to swarm peers',
          uploadedAt: 5,
          blobId: '0:8:0:1024',
          blobsCoreKey,
        }
      },
    }),
  })

  const videos = await api.listVideos(driveKey, publicBeeKey)

  t.is(videos.length, 1)
  t.is(videos[0]?.availability, 'unavailable')
})

test('listVideos keeps the local head-block fast path explicitly playable', async (t) => {
  const driveKey = 'de'.repeat(32)
  const publicBeeKey = 'ad'.repeat(32)
  const blobsCoreKey = 'be'.repeat(32)

  const api = createApi({
    ctx: {
      store: {
        get() {
          return {
            async ready() {},
            async has(start, end) {
              return start === 0 && end === 8
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
        return []
      },
    },
    loadPublicBee: async () => ({
      async listVideos() {
        return [{
          id: 'video-local-fast-path',
          title: 'Locally cached start blocks',
          uploadedAt: 7,
          blobId: '0:8:0:1024',
          blobsCoreKey,
        }]
      },
      async getVideo(id) {
        return {
          id,
          title: 'Locally cached start blocks',
          uploadedAt: 7,
          blobId: '0:8:0:1024',
          blobsCoreKey,
        }
      },
    }),
  })

  const videos = await api.listVideos(driveKey, publicBeeKey)

  t.is(videos.length, 1)
  t.is(videos[0]?.availability, 'playable')
  t.is(videos[0]?.byteAvailability, 'playable')
  t.is(videos[0]?.contiguousBlocks, 8)
  t.is(videos[0]?.hasHeadBlock, true)
})

test('listVideos respects authoritative unavailable hints even when peers are connected', async (t) => {
  const driveKey = '98'.repeat(32)
  const publicBeeKey = '76'.repeat(32)
  const blobsCoreKey = '54'.repeat(32)

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
      swarm: {
        connections: new Set([{}, {}]),
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
        return [{
          driveKey,
          id: 'video-unavailable',
          availability: 'unavailable',
          hasHeadBlock: false,
          contiguousBlocks: 0,
        }]
      },
    },
    loadPublicBee: async () => ({
      async listVideos() {
        return [{
          id: 'video-unavailable',
          title: 'Unavailable by hint',
          uploadedAt: 6,
          blobId: '0:8:0:1024',
          blobsCoreKey,
        }]
      },
      async getVideo(id) {
        return {
          id,
          title: 'Unavailable by hint',
          uploadedAt: 6,
          blobId: '0:8:0:1024',
          blobsCoreKey,
        }
      },
    }),
  })

  const videos = await api.listVideos(driveKey, publicBeeKey)

  t.is(videos.length, 1)
  t.is(videos[0]?.availability, 'unavailable')
  t.is(videos[0]?.byteAvailability, 'unavailable')
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
  t.is(first[0]?.byteAvailability, 'playable')
  t.is(first[0]?.contiguousBlocks, 8)
  t.is(first[0]?.hasHeadBlock, true)
  t.is(second[0]?.availability, 'unavailable')
  t.is(second[0]?.byteAvailability, 'unavailable')
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


test('listVideos uses relay catalog preview refs without channel load when PublicBee is empty', async (t) => {
  let publicBeeLoads = 0
  let channelLoads = 0
  const driveKey = 'ab'.repeat(32)
  const publicBeeKey = 'bc'.repeat(32)

  const api = createApi({
    ctx: {
      store: {
        get() {
          return {
            async ready() {},
            async has() { return true },
          }
        },
      },
      metaDb: { async get() { return null }, async put() {} },
    },
    publicFeed: {
      getFeed() {
        return [{
          driveKey,
          publicBeeKey,
          source: 'relay-cache',
          relayRole: 'cache',
          relayServing: true,
          previewVideos: [{
            id: 'relay-video',
            title: 'Relay Video',
            blobId: '0:8:0:1024',
            blobsCoreKey: 'cd'.repeat(32),
            mimeType: 'video/mp4',
            availability: 'playable',
          }],
        }]
      },
      async requestAvailabilityHints() { return [] },
    },
    loadPublicBee: async () => {
      publicBeeLoads += 1
      return { async listVideos() { return [] } }
    },
    loadChannel: async () => {
      channelLoads += 1
      throw new Error('loadChannel should not be called')
    },
  })

  const videos = await api.listVideos(driveKey, publicBeeKey)
  t.is(publicBeeLoads, 1)
  t.is(channelLoads, 0)
  t.is(videos.length, 1)
  t.is(videos[0].id, 'relay-video')
  t.is(videos[0].channelKey, driveKey)
  t.is(videos[0].publicBeeKey, publicBeeKey)
  t.is(videos[0].relayBacked, true)
})

test('getVideoData resolves relay catalog preview refs without channel load', async (t) => {
  let channelLoads = 0
  const driveKey = 'de'.repeat(32)
  const publicBeeKey = 'ef'.repeat(32)

  const api = createApi({
    ctx: { metaDb: { async get() { return null }, async put() {} } },
    publicFeed: {
      getFeed() {
        return [{
          driveKey,
          publicBeeKey,
          source: 'relay-cache',
          relayRole: 'cache',
          relayServing: true,
          previewVideos: [{
            id: 'preview-only',
            title: 'Preview Only',
            blobId: '0:4:0:512',
            blobsCoreKey: 'fa'.repeat(32),
            mimeType: 'video/mp4',
            availability: 'playable',
          }],
        }]
      },
    },
    loadPublicBee: async () => ({ async getVideo() { return null } }),
    loadChannel: async () => {
      channelLoads += 1
      throw new Error('loadChannel should not be called')
    },
  })

  const video = await api.getVideoData(driveKey, 'preview-only', publicBeeKey)
  t.is(channelLoads, 0)
  t.is(video.id, 'preview-only')
  t.is(video.blobId, '0:4:0:512')
  t.is(video.blobsCoreKey, 'fa'.repeat(32))
  t.is(video.relayBacked, true)
})

test('getPublicFeed exposes relay catalog fields', (t) => {
  const api = createApi({
    ctx: {},
    publicFeed: {
      getFeed() {
        return [{
          driveKey: '12'.repeat(32),
          publicBeeKey: '34'.repeat(32),
          addedAt: 9,
          source: 'relay-cache',
          relayRole: 'cache',
          relayServing: true,
          catalogVersion: 1,
          previewVideosHash: 'hash-value',
          previewVideos: [],
        }]
      },
      getStats() { return { totalEntries: 1, hiddenCount: 0, peerCount: 0 } },
    },
  })

  const result = api.getPublicFeed()
  t.is(result.entries[0].source, 'relay-cache')
  t.is(result.entries[0].relayRole, 'cache')
  t.is(result.entries[0].relayServing, true)
  t.is(result.entries[0].catalogVersion, 1)
  t.is(result.entries[0].previewVideosHash, 'hash-value')
})


test('createApi exposes getCanonicalFeed as the HRPC canonical feed handler alias', (t) => {
  const api = createApi({
    ctx: {},
    publicFeed: {
      getFeed() {
        return [{
          driveKey: 'aa'.repeat(32),
          channelKey: 'aa'.repeat(32),
          source: 'peer',
          publicBeeKey: 'bb'.repeat(32),
          channelName: 'Canonical Alias',
          videoCount: 1,
          peerCount: 1,
          lastSeen: 321,
          previewVideos: [{ id: 'v1', title: 'Preview' }],
        }]
      },
      getStats() {
        return { totalEntries: 1, hiddenCount: 0, peerCount: 1 }
      },
    },
  })

  t.is(typeof api.getCanonicalFeed, 'function')
  t.alike(api.getCanonicalFeed(), api.getPublicFeed())
})
