import test from 'brittle'

import { createApi } from '../src/api.js'

test('api routes engine-backed list/data/url/playback through engine adapter', async (t) => {
  const calls = []
  const engineVideo = {
    id: 'v1',
    title: 'Engine Video',
    channelKey: 'ui-channel',
    path: '/videos/v1/source.mp4',
    source: 'engine'
  }
  const api = createApi({
    ctx: {},
    engineAdapter: {
      async hasEngineChannel(channelKey) {
        calls.push(['hasEngineChannel', channelKey])
        return channelKey === 'ui-channel'
      },
      async listVideos(channelKey) {
        calls.push(['listVideos', channelKey])
        return [engineVideo]
      },
      async getVideoData(channelKey, videoId) {
        calls.push(['getVideoData', channelKey, videoId])
        return engineVideo
      },
      async getVideoUrl(channelKey, videoId) {
        calls.push(['getVideoUrl', channelKey, videoId])
        return { url: 'http://127.0.0.1/engine/v1' }
      },
      async preparePlayback(channelKey, videoId) {
        calls.push(['preparePlayback', channelKey, videoId])
        return {
          url: 'http://127.0.0.1/engine/v1',
          stats: { status: 'playable', progress: 1, isComplete: true },
          warmupStarted: false
        }
      }
    }
  })

  t.alike(await api.listVideos('ui-channel'), [engineVideo])
  t.alike(await api.getVideoData('ui-channel', '/videos/v1/source.mp4'), engineVideo)
  t.alike(await api.getVideoUrl('ui-channel', '/videos/v1/source.mp4'), { url: 'http://127.0.0.1/engine/v1' })
  t.alike(await api.preparePlayback('ui-channel', '/videos/v1/source.mp4'), {
    url: 'http://127.0.0.1/engine/v1',
    stats: { status: 'playable', progress: 1, isComplete: true },
    warmupStarted: false
  })

  t.alike(calls, [
    ['hasEngineChannel', 'ui-channel'],
    ['listVideos', 'ui-channel'],
    ['hasEngineChannel', 'ui-channel'],
    ['getVideoData', 'ui-channel', '/videos/v1/source.mp4'],
    ['hasEngineChannel', 'ui-channel'],
    ['getVideoUrl', 'ui-channel', '/videos/v1/source.mp4'],
    ['hasEngineChannel', 'ui-channel'],
    ['preparePlayback', 'ui-channel', '/videos/v1/source.mp4']
  ])
})

test('preparePlayback returns a playable URL even when warmup fails', async (t) => {
  const api = createApi({ ctx: {} })
  const calls = []

  api.getVideoUrl = async (...args) => {
    calls.push(['getVideoUrl', args])
    return { url: 'http://127.0.0.1:60023/video.mp4' }
  }

  api.prefetchVideo = async (...args) => {
    calls.push(['prefetchVideo', args])
    throw new Error('warmup failed')
  }

  api.getVideoStats = (...args) => {
    calls.push(['getVideoStats', args])
    return {
      status: 'unknown',
      progress: 0,
      totalBlocks: 0,
      downloadedBlocks: 0,
      totalBytes: 0,
      downloadedBytes: 0,
      peerCount: 0,
      swarmConnections: 0,
      speedMBps: '0',
      elapsed: 0,
      isComplete: false,
    }
  }

  const result = await api.preparePlayback(
    'channel-key',
    'videos/demo.mp4',
    'public-bee-key',
    'blob-id',
    'blobs-core-key',
    'video/mp4',
  )

  t.alike(result, {
    url: 'http://127.0.0.1:60023/video.mp4',
    stats: {
      status: 'unknown',
      progress: 0,
      totalBlocks: 0,
      downloadedBlocks: 0,
      totalBytes: 0,
      downloadedBytes: 0,
      peerCount: 0,
      swarmConnections: 0,
      speedMBps: '0',
      elapsed: 0,
      isComplete: false,
    },
    warmupStarted: false,
  })

  t.alike(calls, [
    ['prefetchVideo', ['channel-key', 'videos/demo.mp4', 'public-bee-key']],
    ['getVideoUrl', ['channel-key', 'videos/demo.mp4', 'public-bee-key', 'blob-id', 'blobs-core-key', 'video/mp4']],
    ['getVideoStats', ['channel-key', 'videos/demo.mp4']],
  ])
})
