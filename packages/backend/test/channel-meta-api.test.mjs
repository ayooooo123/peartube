import test from 'brittle'

import { createApi } from '../src/api.js'

test('getChannelMeta uses feed preview count without listing PublicBee videos', async (t) => {
  const driveKey = 'aa'.repeat(32)
  const publicBeeKey = 'bb'.repeat(32)
  let publicBeeListCalls = 0

  const api = createApi({
    ctx: {},
    publicFeed: {
      getFeed() {
        return [{
          driveKey,
          publicBeeKey,
          channelName: 'Feed Channel',
          videoCount: 99,
          previewVideos: [{ id: 'one' }, { id: 'two' }],
        }]
      },
    },
    loadPublicBee: async () => ({
      async getMetadata() {
        return { name: 'PublicBee Channel', description: 'metadata only', createdAt: 123 }
      },
      async listVideos() {
        publicBeeListCalls += 1
        throw new Error('getChannelMeta must not list videos')
      },
    }),
  })

  const meta = await api.getChannelMeta(driveKey, publicBeeKey)

  t.is(meta.name, 'PublicBee Channel')
  t.is(meta.videoCount, 2)
  t.is(publicBeeListCalls, 0)
})

test('getChannelMeta accepts HRPC request object shape', async (t) => {
  const driveKey = 'ee'.repeat(32)
  const publicBeeKey = 'ff'.repeat(32)
  let loadedPublicBeeKey = null

  const api = createApi({
    ctx: {},
    publicFeed: {
      getFeed() {
        return [{
          driveKey,
          publicBeeKey,
          channelName: 'Request Channel',
          videoCount: 5,
          previewVideos: [],
        }]
      },
    },
    loadPublicBee: async (_ctx, key) => {
      loadedPublicBeeKey = key
      return {
        async getMetadata() {
          return { name: 'Request Channel', description: 'request metadata', createdAt: 321 }
        },
      }
    },
  })

  const meta = await api.getChannelMeta({ channelKey: driveKey, publicBeeKey }, { backend: true })

  t.is(loadedPublicBeeKey, publicBeeKey)
  t.is(meta.driveKey, driveKey)
  t.is(meta.name, 'Request Channel')
  t.is(meta.videoCount, 5)
})

test('getChannelMeta uses feed videoCount without listing local channel videos', async (t) => {
  const driveKey = 'cc'.repeat(32)
  let channelListCalls = 0

  const api = createApi({
    ctx: {},
    publicFeed: {
      getFeed() {
        return [{
          driveKey,
          videoCount: 7,
          previewVideos: [],
        }]
      },
    },
    loadChannel: async () => ({
      async getMetadata() {
        return { name: 'Local Channel', description: 'local metadata', createdAt: 456 }
      },
      async listVideos() {
        channelListCalls += 1
        throw new Error('getChannelMeta must not list videos')
      },
    }),
  })

  const meta = await api.getChannelMeta(driveKey)

  t.is(meta.name, 'Local Channel')
  t.is(meta.videoCount, 7)
  t.is(channelListCalls, 0)
})

test('getChannelMeta returns zero count when no feed snapshot exists', async (t) => {
  const driveKey = 'dd'.repeat(32)

  const api = createApi({
    ctx: {},
    publicFeed: { getFeed() { return [] } },
    loadChannel: async () => ({
      async getMetadata() {
        return { name: 'Unknown Count Channel', createdAt: 789 }
      },
      async listVideos() {
        throw new Error('getChannelMeta must not list videos')
      },
    }),
  })

  const meta = await api.getChannelMeta(driveKey)

  t.is(meta.name, 'Unknown Count Channel')
  t.is(meta.videoCount, 0)
})
