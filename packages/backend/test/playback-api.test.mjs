import test from 'brittle'
import { EventEmitter } from 'node:events'

import { createApi } from '../src/api.js'

test('preparePlayback returns a streamable URL without waiting for startup prefetch', async (t) => {
  const api = createApi({ ctx: {} })
  const calls = []
  const statsValue = {
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

  api.getVideoUrl = async (...args) => {
    calls.push(['getVideoUrl', args])
    return { url: 'http://127.0.0.1:60023/video.mp4' }
  }

  api.prefetchVideo = (...args) => {
    calls.push(['prefetchVideo', args])
    return new Promise(() => {})
  }

  api.getVideoStats = (...args) => {
    calls.push(['getVideoStats', args])
    return { ...statsValue }
  }

  const result = await Promise.race([
    api.preparePlayback(
      'channel-key',
      'videos/demo.mp4',
      'public-bee-key',
      'blob-id',
      'blobs-core-key',
      'video/mp4',
    ),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 50)),
  ])

  t.is(result.url, 'http://127.0.0.1:60023/video.mp4')
  t.alike(result.stats, statsValue)
  // The URL remains the same direct blob-server URL; the API-level playback
  // path now starts prefetch in the background without blocking native player
  // handoff.
  t.is(result.warmupStarted, undefined)
  t.is(result.peerWarmupStarted, undefined)
  t.is(result.selectedBlobWarmup, undefined)

  t.alike(calls, [
    ['getVideoUrl', ['channel-key', 'videos/demo.mp4', 'public-bee-key', 'blob-id', 'blobs-core-key', 'video/mp4']],
    ['prefetchVideo', ['channel-key', 'videos/demo.mp4', 'public-bee-key']],
    ['getVideoStats', ['channel-key', 'videos/demo.mp4']],
  ])
})


test('preparePlayback falls back to direct on-demand stats when playback prefetch is unavailable', async (t) => {
  const driveKey = 'channel-key'
  const videoPath = 'videos/demo.mp4'
  const blobsCoreKey = '78'.repeat(32)
  const blobId = '5:4:0:4096'
  const calls = []
  const core = new EventEmitter()
  core.key = Buffer.from(blobsCoreKey, 'hex')
  core.discoveryKey = Buffer.from('discovery-key')
  core.peers = [{ remotePublicKey: Buffer.from('a'.repeat(64), 'hex') }]
  core.ready = async () => { calls.push(['core.ready']) }
  core.update = () => Promise.resolve()
  core.has = async (start, end) => {
    calls.push(['core.has', start, end])
    return false
  }

  const api = createApi({
    ctx: {
      blobServer: {
        port: 60023,
        getLink(_keyBuffer, options) {
          calls.push(['getLink', options.blob, options.type])
          return 'http://127.0.0.1:60023/demo.mp4'
        },
      },
      store: {
        get() {
          calls.push(['store.get'])
          return core
        },
      },
      swarm: {
        connections: new Set([1, 2]),
        join(discoveryKey) {
          calls.push(['swarm.join', discoveryKey])
          return { flushed: () => Promise.resolve() }
        },
      },
      channels: new Map(),
    },
    videoStats: new (await import('../src/video-stats.js')).VideoStatsTracker(),
  })

  api.prefetchVideo = async (...args) => {
    calls.push(['prefetchVideo', args])
    return { success: false, error: 'prefetch unavailable in test' }
  }

  const prepared = await api.preparePlayback(
    driveKey,
    videoPath,
    null,
    blobId,
    blobsCoreKey,
    'video/mp4',
  )

  t.is(prepared.url, 'http://127.0.0.1:60023/demo.mp4')
  t.is(prepared.stats.status, 'downloading')
  t.is(prepared.stats.totalBlocks, 4)
  t.is(prepared.stats.totalBytes, 4096)
  t.is(prepared.stats.peerCount, 1)

  core.emit('download', 5, 1024)
  const stats = api.getVideoStats(driveKey, videoPath)

  t.is(stats.status, 'downloading')
  t.is(stats.downloadedBlocks, 1)
  t.is(stats.downloadedBytes, 1024)
  t.is(stats.progress, 25)
  t.is(stats.peerCount, 1)
  t.alike(stats.blobPeerIds, ['a'.repeat(64)])
  t.is(stats.blobCoreKey, blobsCoreKey)
  t.ok(calls.find((call) => call[0] === 'prefetchVideo'), 'preparePlayback should start playback prefetch in the background')
})


test('getAvailabilityHints revalidates cached playable head proof', async (t) => {
  const driveKey = 'ab'.repeat(32)
  const blobsCoreKey = 'cd'.repeat(32)
  const blobId = '0:4:0:4096'
  const hasCalls = []
  let headAvailable = true
  const core = {
    async ready() {},
    async has(start, end) {
      hasCalls.push([start, end])
      return headAvailable
    },
  }

  const api = createApi({
    ctx: {
      store: {
        get() {
          return core
        },
      },
      swarm: {
        keyPair: { publicKey: Buffer.from('ef'.repeat(32), 'hex') },
      },
    },
  })

  const request = {
    driveKey,
    id: 'video-id',
    blobsCoreKey,
    blobId,
  }

  const first = await api.getAvailabilityHints([request])
  headAvailable = false
  const second = await api.getAvailabilityHints([request])

  t.is(first[0]?.availability, 'playable')
  t.is(first[0]?.hasHeadBlock, true)
  t.is(second[0]?.availability, 'unknown')
  t.is(second[0]?.hasHeadBlock, false)
  t.ok(hasCalls.length > 1, 'cached playable proof is rechecked against local blocks')
})



test('getVideoStats preserves tracked peer details when no live core is registered', (t) => {
  const tracked = {
    status: 'downloading',
    peerCount: 3,
    blobPeerIds: ['d'.repeat(64)],
    blobCoreKey: 'e'.repeat(64),
  }
  const api = createApi({
    ctx: {
      swarm: { connections: new Set([1]) },
      channels: new Map(),
    },
    videoStats: {
      getStats() {
        return tracked
      },
    },
  })

  const stats = api.getVideoStats('channel-key', 'videos/demo.mp4')

  t.is(stats.peerCount, 3)
  t.alike(stats.blobPeerIds, tracked.blobPeerIds)
  t.is(stats.blobCoreKey, tracked.blobCoreKey)
  t.is(stats.swarmConnections, 1)
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
