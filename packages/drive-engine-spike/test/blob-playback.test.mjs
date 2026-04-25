import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBlobPlaybackServer, getHyperdriveFileUrl } from '../src/blob-playback.mjs'
import { createChannelDrive, SAMPLE_VIDEO_HEADER, writeSampleVideo } from '../src/channel-drive.mjs'

test('blob server serves a Hyperdrive file by filename with HTTP range support', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'peartube-drive-blob-'))
  const channel = await createChannelDrive({ storagePath, name: 'Alice' })
  await writeSampleVideo({
    drive: channel.drive,
    channelKey: channel.channelKey,
    id: 'v1',
    title: 'Hello blob server',
    size: 1024 * 1024
  })

  const server = await createBlobPlaybackServer({ store: channel.store })
  const url = getHyperdriveFileUrl({
    server,
    driveKey: channel.drive.key,
    filename: '/videos/v1/source.mp4',
    mimeType: 'video/mp4'
  })

  const response = await fetch(url, { headers: { Range: 'bytes=0-31' } })
  const body = Buffer.from(await response.arrayBuffer())

  assert.equal(response.status, 206)
  assert.match(response.headers.get('content-range'), /^bytes 0-31\//)
  assert.equal(body.length, 32)
  assert.equal(body.subarray(0, SAMPLE_VIDEO_HEADER.length).toString(), SAMPLE_VIDEO_HEADER)

  await server.close()
  await channel.close()
})
