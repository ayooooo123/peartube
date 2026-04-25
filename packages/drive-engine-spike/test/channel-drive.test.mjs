import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createChannelDrive,
  readJson,
  writeSampleVideo,
  SAMPLE_VIDEO_HEADER
} from '../src/channel-drive.mjs'
import { validateProfileRecord, validateVideoRecord } from '../src/schema.mjs'

test('createChannelDrive creates a keyed Hyperdrive with valid profile', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'peartube-drive-channel-'))
  const channel = await createChannelDrive({ storagePath, name: 'Alice' })

  assert.equal(typeof channel.channelKey, 'string')
  assert.ok(channel.channelKey.length > 0)

  const profile = await readJson(channel.drive, '/profile.json')
  assert.equal(profile.channelKey, channel.channelKey)
  assert.equal(profile.name, 'Alice')
  assert.equal(validateProfileRecord(profile).ok, true)

  await channel.close()
})

test('writeSampleVideo stores valid metadata and readable video bytes', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'peartube-drive-video-'))
  const channel = await createChannelDrive({ storagePath, name: 'Alice' })

  const result = await writeSampleVideo({
    drive: channel.drive,
    channelKey: channel.channelKey,
    id: 'v1',
    title: 'Hello drive video',
    size: 1024 * 1024
  })

  assert.equal(result.filename, '/videos/v1/source.mp4')

  const video = await readJson(channel.drive, '/videos/v1/video.json')
  assert.equal(validateVideoRecord(video).ok, true)
  assert.equal(video.byteLength, 1024 * 1024)

  const bytes = await channel.drive.get('/videos/v1/source.mp4')
  assert.equal(bytes.length, 1024 * 1024)
  assert.equal(bytes.subarray(0, SAMPLE_VIDEO_HEADER.length).toString(), SAMPLE_VIDEO_HEADER)

  await channel.close()
})
