import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SAMPLE_VIDEO_HEADER } from '../src/channel-drive.mjs'
import {
  connectPeers,
  createReplicatedPeers,
  waitForRangeReadable
} from '../src/two-peer-harness.mjs'

test('reader blob server range-serves writer Hyperdrive file over replicated Corestore', async () => {
  const basePath = await mkdtemp(join(tmpdir(), 'peartube-drive-two-peer-'))
  const peers = await createReplicatedPeers({ basePath, videoSize: 2 * 1024 * 1024 })
  const disconnect = connectPeers(peers.peerA, peers.peerB)

  try {
    const { response, body } = await waitForRangeReadable({
      url: peers.playbackUrl,
      range: 'bytes=0-63',
      timeoutMs: 8000
    })

    assert.equal(response.status, 206)
    assert.match(response.headers.get('content-range'), /^bytes 0-63\//)
    assert.equal(body.length, 64)
    assert.equal(body.subarray(0, SAMPLE_VIDEO_HEADER.length).toString(), SAMPLE_VIDEO_HEADER)

    const later = await waitForRangeReadable({
      url: peers.playbackUrl,
      range: 'bytes=1048576-1048639',
      timeoutMs: 8000
    })

    assert.equal(later.response.status, 206)
    assert.equal(later.body.length, 64)
    assert.equal(later.body[0], 1048576 % 251)
  } finally {
    disconnect()
    await peers.close()
  }
})
