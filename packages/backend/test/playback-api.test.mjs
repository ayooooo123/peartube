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
    ['getVideoUrl', 'ui-channel', '/videos/v1/source.mp4'],
    ['preparePlayback', 'ui-channel', '/videos/v1/source.mp4']
  ])
})

test('preparePlayback requires the engine adapter after legacy Hyperblobs playback removal', async (t) => {
  const api = createApi({ ctx: {} })

  try {
    await api.preparePlayback('channel-key', 'videos/demo.mp4')
    t.fail('preparePlayback should require an engine adapter')
  } catch (err) {
    t.is(err.message, 'Engine adapter not initialized')
  }
})
