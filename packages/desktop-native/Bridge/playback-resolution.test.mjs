import test from 'node:test'
import assert from 'node:assert/strict'

import { resolvePlaybackViaClient } from './playback-resolution.mjs'

test('resolvePlaybackViaClient warms playback before requesting the blob URL', async () => {
  const order = []

  const logs = []
  const response = await resolvePlaybackViaClient({
    client: {
      video: {
        async getVideoUrl(request) {
          order.push('getVideoUrl')
          assert.equal(request.channelKey, 'channel-a')
          assert.equal(request.videoId, '/videos/video-a.mp4')
          return { url: 'http://127.0.0.1:3000/blob.mp4' }
        },
        async prefetchVideo() {
          order.push('prefetchVideo')
          await new Promise((resolve) => setTimeout(resolve, 20))
          return {
            success: true,
            initialBlocks: 16,
            peerCount: 2,
            cached: false,
          }
        },
      },
    },
    params: {
      channelKey: 'channel-a',
      publicBeeKey: 'bee-a',
      videoId: 'video-a',
      videoPath: '/videos/video-a.mp4',
    },
    log: (line) => logs.push(line),
    prefetchTimeoutMs: 100,
  })

  assert.deepEqual(response, {
    videoId: 'video-a',
    url: 'http://127.0.0.1:3000/blob.mp4',
  })
  assert.deepEqual(order, ['prefetchVideo', 'getVideoUrl'])
  assert.match(logs.at(-1), /Playback prefetch started/)
})

test('resolvePlaybackViaClient keeps playback URL resolution separate from prefetch failures', async () => {
  const logs = []
  const order = []

  const response = await resolvePlaybackViaClient({
    client: {
      video: {
        async getVideoUrl() {
          order.push('getVideoUrl')
          return { url: 'http://127.0.0.1:3000/blob.mp4' }
        },
        async prefetchVideo() {
          order.push('prefetchVideo')
          return { success: false, error: 'Playback prefetch timed out' }
        },
      },
    },
    params: {
      channelKey: 'channel-a',
      videoId: 'video-a',
    },
    log: (line) => logs.push(line),
    prefetchTimeoutMs: 5,
  })

  assert.deepEqual(order, ['prefetchVideo', 'getVideoUrl'])
  assert.equal(response.url, 'http://127.0.0.1:3000/blob.mp4')
  assert.match(logs.at(-1), /still warming/)
})
