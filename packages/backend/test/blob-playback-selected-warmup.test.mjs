import test from 'brittle'

import { BlobPlaybackService } from '../src/blob-playback-service.js'

const VALID_KEY = 'b'.repeat(64)
const VALID_BLOB = '5:4:0:1024'
const VALID_URL = 'http://127.0.0.1:4321/blob.mp4?token=***'

function createCtx({ peerCount = 0, hasHeadBlock = false } = {}) {
  const calls = []
  const peerList = Array.from({ length: peerCount }, (_, index) => ({
    remotePublicKey: Buffer.from(String(index + 1).repeat(64), 'hex'),
  }))
  const core = {
    key: Buffer.from(VALID_KEY, 'hex'),
    discoveryKey: Buffer.from('selected-discovery-key'),
    peers: peerList,
    async ready() {
      calls.push(['ready'])
    },
    async update(opts) {
      calls.push(['update', opts])
    },
    async has(start, end) {
      calls.push(['has', start, end])
      return hasHeadBlock
    },
  }

  return {
    calls,
    ctx: {
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
        join(discoveryKey, opts) {
          calls.push(['swarm.join', discoveryKey.toString('hex'), opts])
          return { flushed: async () => calls.push(['flushed']) }
        },
      },
    },
  }
}

test('preparePlayback warms selected direct blob core and reports blob peer diagnostics', async (t) => {
  const { ctx, calls } = createCtx({ peerCount: 2, hasHeadBlock: true })
  const service = new BlobPlaybackService({ ctx })

  const result = await service.preparePlayback({
    driveKey: 'channel-key',
    videoPath: 'videos/king.mp4',
    publicBeeKey: 'public-bee-key',
    blobId: VALID_BLOB,
    blobsCoreKey: VALID_KEY,
    mimeType: 'video/mp4',
    warmSelectedBlob: true,
    selectedBlobWarmupTimeoutMs: 25,
    getStats: () => ({ progress: 0, peerCount: 2 }),
  })

  t.is(result.url, VALID_URL)
  t.is(result.peerWarmupStarted, true)
  t.is(result.selectedBlobWarmup.blobsCoreKey, VALID_KEY)
  t.is(result.selectedBlobWarmup.blobId, VALID_BLOB)
  t.is(result.selectedBlobWarmup.peerCount, 2)
  t.is(result.selectedBlobWarmup.hasHeadBlock, true)
  t.ok(calls.some((call) => call[0] === 'swarm.join'), 'joins selected blob discovery')
  t.ok(calls.some((call) => call[0] === 'update' && call[1]?.wait === true), 'waits for selected blob core update')
  t.ok(calls.some((call) => call[0] === 'has' && call[1] === 5 && call[2] === 6), 'checks selected blob head block')
})

test('preparePlayback returns URL with explicit selected blob diagnostics when no blob peer arrives', async (t) => {
  const { ctx } = createCtx({ peerCount: 0, hasHeadBlock: false })
  const service = new BlobPlaybackService({ ctx })

  const result = await service.preparePlayback({
    driveKey: 'channel-key',
    videoPath: 'videos/king.mp4',
    publicBeeKey: 'public-bee-key',
    blobId: VALID_BLOB,
    blobsCoreKey: VALID_KEY,
    mimeType: 'video/mp4',
    warmSelectedBlob: true,
    selectedBlobWarmupTimeoutMs: 25,
  })

  t.is(result.url, VALID_URL)
  t.is(result.peerWarmupStarted, true)
  t.is(result.selectedBlobWarmup.peerCount, 0)
  t.is(result.selectedBlobWarmup.hasHeadBlock, false)
  t.is(result.selectedBlobWarmup.readyForPlayback, false)
})
