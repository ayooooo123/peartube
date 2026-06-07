import test from 'brittle'

import { createApi } from '../src/api.js'

test('preparePlayback returns a playable URL before warmup settles or fails', async (t) => {
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

  t.is(result.url, 'http://127.0.0.1:60023/video.mp4')
  t.alike(result.stats, {
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
  })
  t.is(result.warmupStarted, true)
  t.is(result.peerWarmupStarted, true)
  t.alike(result.peerWarmup, {
    peerCount: 0,
    retained: false,
    timedOut: false,
  })
  t.is(result.selectedBlobWarmup.readyForPlayback, false)
  t.is(result.selectedBlobWarmup.error, 'invalid-blob-ref')

  t.alike(calls, [
    ['getVideoUrl', ['channel-key', 'videos/demo.mp4', 'public-bee-key', 'blob-id', 'blobs-core-key', 'video/mp4']],
    ['prefetchVideo', ['channel-key', 'videos/demo.mp4', 'public-bee-key']],
    ['getVideoStats', ['channel-key', 'videos/demo.mp4']],
  ])
})

test('preparePlayback resolves feed preview blob refs when playback request omits direct identity', async (t) => {
  const driveKey = '12'.repeat(32)
  const publicBeeKey = '34'.repeat(32)
  const blobsCoreKey = '56'.repeat(32)
  const blobId = '0:4:0:2048'
  const calls = []
  const core = {
    discoveryKey: Buffer.from('discovery-key'),
    peers: [{ remotePublicKey: Buffer.from('peer-key') }],
    async ready() {
      calls.push(['core.ready'])
    },
    update() {
      calls.push(['core.update'])
      return Promise.resolve()
    },
    async has(start, end) {
      calls.push(['core.has', start, end])
      return start === 0 && end === 1
    },
  }

  const api = createApi({
    ctx: {
      blobServer: {
        port: 60023,
        getLink(_keyBuffer, options) {
          calls.push(['getLink', options.blob, options.type])
          return 'http://127.0.0.1:60023/feed-video.webm'
        },
      },
      store: {
        get() {
          calls.push(['store.get'])
          return core
        },
      },
      swarm: {
        join(discoveryKey) {
          calls.push(['swarm.join', discoveryKey])
          return { flushed: () => Promise.resolve() }
        },
      },
    },
    publicFeed: {
      getFeed() {
        return [{
          driveKey,
          publicBeeKey,
          source: 'peer',
          peerCount: 2,
          previewVideos: [{
            id: 'feed-video',
            title: 'Feed video',
            blobId,
            blobsCoreKey,
            mimeType: 'video/webm',
            availability: 'playable',
          }],
        }]
      },
      getStats() {
        return { totalEntries: 1, hiddenCount: 0, peerCount: 2 }
      },
    },
    loadPublicBee: async () => {
      throw new Error('public bee should not be required for preview playback')
    },
    loadChannel: async () => {
      throw new Error('channel should not be required for preview playback')
    },
  })

  api.prefetchVideo = async (...args) => {
    calls.push(['prefetchVideo', args])
  }
  api.getVideoStats = (...args) => {
    calls.push(['getVideoStats', args])
    return { peerCount: 1 }
  }

  const result = await api.preparePlayback(driveKey, 'feed-video', publicBeeKey)

  t.is(result.url, 'http://127.0.0.1:60023/feed-video.webm')
  t.is(result.peerWarmupStarted, true)
  t.is(result.selectedBlobWarmup.blobId, blobId)
  t.is(result.selectedBlobWarmup.blobsCoreKey, blobsCoreKey)
  t.is(result.selectedBlobWarmup.readyForPlayback, true)
  t.ok(calls.some((call) => call[0] === 'getLink' && call[2] === 'video/webm'), 'uses feed preview mime type for the blob-server URL')
  t.ok(calls.some((call) => call[0] === 'swarm.join'), 'joins selected blob discovery before returning playback diagnostics')
})

test('prefetchNextVideos lists channel videos with the correct signature', async (t) => {
  const api = createApi({ ctx: {} })
  const calls = []

  api.listVideos = async (...args) => {
    calls.push(['listVideos', args])
    return [
      { id: 'current', title: 'Current' },
      { id: 'next-one', title: 'Next one' },
      { videoId: 'next-two', title: 'Next two' },
      { path: 'videos/next-three.mp4', title: 'Next three' },
    ]
  }

  api.prefetchVideo = async (...args) => {
    calls.push(['prefetchVideo', args])
    return { success: true }
  }

  const result = await api.prefetchNextVideos('channel-key', 'current', 2)

  t.alike(result, { success: true, prefetchedCount: 2 })
  t.alike(calls, [
    ['listVideos', ['channel-key']],
    ['prefetchVideo', ['channel-key', 'next-one']],
    ['prefetchVideo', ['channel-key', 'next-two']],
  ])
})

test('prefetchNextVideos prefetches first videos when current video is absent', async (t) => {
  const api = createApi({ ctx: {} })
  const calls = []

  api.listVideos = async (...args) => {
    calls.push(['listVideos', args])
    return [
      { path: 'videos/first.mp4', title: 'First' },
      { id: 'second', title: 'Second' },
    ]
  }

  api.prefetchVideo = async (...args) => {
    calls.push(['prefetchVideo', args])
    return { success: true }
  }

  const result = await api.prefetchNextVideos('channel-key', 'missing', 2)

  t.alike(result, { success: true, prefetchedCount: 2 })
  t.alike(calls, [
    ['listVideos', ['channel-key']],
    ['prefetchVideo', ['channel-key', 'videos/first.mp4']],
    ['prefetchVideo', ['channel-key', 'second']],
  ])
})

test('getVideoStats keeps video peer count separate from global swarm connections', (t) => {
  const videoCore = { peers: [1, 2] }
  const api = createApi({
    ctx: {
      swarm: { connections: new Set([1, 2, 3, 4]) },
      channels: new Map([
        ['channel-key', { videoCores: new Map([['videos/demo.mp4', videoCore]]) }],
      ]),
    },
  })

  const stats = api.getVideoStats('channel-key', 'videos/demo.mp4')

  t.is(stats.peerCount, 2)
  t.is(stats.swarmConnections, 4)
})

test('getVideoStats exposes blob core peer identities for transfer proof', (t) => {
  const peerA = { remotePublicKey: Buffer.from('a'.repeat(64), 'hex'), remoteAddress: 'relay-a' }
  const peerB = { publicKey: Buffer.from('b'.repeat(64), 'hex'), remoteAddress: 'relay-b' }
  const videoCore = {
    key: Buffer.from('c'.repeat(64), 'hex'),
    peers: [peerA, peerB],
  }
  const api = createApi({
    ctx: {
      swarm: { connections: new Set([1, 2, 3, 4]) },
      channels: new Map([
        ['channel-key', { videoCores: new Map([['videos/demo.mp4', videoCore]]) }],
      ]),
    },
  })

  const stats = api.getVideoStats('channel-key', 'videos/demo.mp4')

  t.is(stats.peerCount, 2)
  t.alike(stats.blobPeerIds, ['a'.repeat(64), 'b'.repeat(64)])
  t.is(stats.blobCoreKey, 'c'.repeat(64))
  t.is(stats.swarmConnections, 4)
})

test('getVideoStats does not fall back to global swarm connections as video peers', (t) => {
  const api = createApi({
    ctx: {
      swarm: { connections: new Set([1, 2, 3]) },
      channels: new Map(),
    },
  })

  const stats = api.getVideoStats('channel-key', 'missing-video')

  t.is(stats.peerCount, 0)
  t.is(stats.swarmConnections, 3)
})
