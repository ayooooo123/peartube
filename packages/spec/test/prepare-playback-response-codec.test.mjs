import test from 'brittle'

import { decode, encode } from '../spec/hrpc/messages.js'

const MESSAGE = '@peartube/prepare-playback-response'

test('prepare-playback response codec preserves selected blob readiness diagnostics', (t) => {
  const encoded = encode(MESSAGE, {
    url: 'http://127.0.0.1:9000/blob.mp4',
    warmupStarted: true,
    peerWarmupStarted: true,
    selectedBlobWarmup: {
      requested: true,
      resolved: true,
      driveKey: 'channel-key',
      videoPath: 'videos/demo.mp4',
      blobsCoreKey: 'b'.repeat(64),
      blobId: '5:4:0:1024',
      peerCount: 2,
      blobPeerIds: ['a'.repeat(64)],
      hasHeadBlock: true,
      requiredStartupBlocks: 4,
      startupBlocks: 1,
      startupByteLength: 1024,
      readyForPlayback: false,
    },
    peerWarmup: {
      peerCount: 1,
      retained: true,
      timedOut: false,
      elapsedMs: 42,
    },
  })

  const decoded = decode(MESSAGE, encoded)
  t.is(decoded.url, 'http://127.0.0.1:9000/blob.mp4')
  t.is(decoded.warmupStarted, true)
  t.is(decoded.peerWarmupStarted, true)
  t.is(decoded.selectedBlobWarmup.readyForPlayback, false)
  t.is(decoded.selectedBlobWarmup.startupBlocks, 1)
  t.is(decoded.selectedBlobWarmup.requiredStartupBlocks, 4)
  t.alike(decoded.selectedBlobWarmup.blobPeerIds, ['a'.repeat(64)])
  t.alike(decoded.peerWarmup, {
    peerCount: 1,
    retained: true,
    timedOut: false,
    elapsedMs: 42,
  })
})
