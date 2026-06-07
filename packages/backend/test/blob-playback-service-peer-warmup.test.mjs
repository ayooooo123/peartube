import test from 'node:test'
import assert from 'node:assert/strict'

import { BlobPlaybackService } from '../src/blob-playback-service.js'

const VALID_KEY = 'a'.repeat(64)
const VALID_BLOB = '1:2:3:4'
const VALID_URL = 'http://127.0.0.1:4321/blob.mp4?token=***'

function createCtx({ peers = [] } = {}) {
  const calls = []
  const core = {
    discoveryKey: Buffer.from('discovery-key'),
    peers,
    async ready() {
      calls.push(['ready'])
    },
    async update() {
      calls.push(['update'])
    },
  }
  return {
    calls,
    core,
    ctx: {
      network: {
        relayPeers: ['b'.repeat(64), 'c'.repeat(64)],
      },
      blobServerHost: '127.0.0.1',
      blobServerPort: 1234,
      blobServer: {
        port: 4321,
        getLink(key, options) {
          calls.push(['getLink', key.toString('hex'), options])
          return VALID_URL
        },
      },
      store: {
        get(key) {
          calls.push(['store.get', key.toString('hex')])
          return core
        },
      },
      swarm: {
        _peartubeOffline: false,
        join(discoveryKey, options) {
          calls.push(['join', discoveryKey.toString(), options])
          return { flushed: async () => {} }
        },
        joinPeer(publicKey) {
          calls.push(['joinPeer', publicKey.toString('hex')])
        },
      },
    },
  }
}

test('preparePlayback joins the blob topic and leaves peer selection to Hyperswarm', async () => {
  const { ctx, core, calls } = createCtx()
  const service = new BlobPlaybackService({ ctx })

  let statsCalls = 0
  const result = await service.preparePlayback({
    driveKey: 'channel-key',
    videoPath: 'videos/demo.mp4',
    blobId: VALID_BLOB,
    blobsCoreKey: VALID_KEY,
    mimeType: 'video/mp4',
    warmup: () => Promise.resolve(),
    getStats: () => {
      statsCalls++
      return { peerCount: core.peers.length }
    },
  })

  assert.equal(result.url, VALID_URL)
  assert.equal(result.warmupStarted, true)
  assert.equal(result.stats.peerCount, 0)
  assert.ok(statsCalls >= 1)

  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(calls.some((call) => call[0] === 'join'))
  assert.deepEqual(calls.filter((call) => call[0] === 'joinPeer'), [])
})

test('preparePlayback peer diagnostics can observe a peer after the first tick', async () => {
  const peers = []
  const { ctx } = createCtx({ peers })
  const service = new BlobPlaybackService({ ctx })
  setImmediate(() => {
    peers.push({ remotePublicKey: Buffer.from('d'.repeat(64), 'hex') })
  })

  const result = await service.preparePlayback({
    driveKey: 'channel-key',
    videoPath: 'videos/demo.mp4',
    blobId: VALID_BLOB,
    blobsCoreKey: VALID_KEY,
    mimeType: 'video/mp4',
  })

  assert.equal(result.peerWarmup.peerCount, 1)
  assert.equal(result.peerWarmup.timedOut, false)
})
