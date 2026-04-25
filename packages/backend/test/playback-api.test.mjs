import test from 'brittle'

import { createApi } from '../src/api.js'

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
