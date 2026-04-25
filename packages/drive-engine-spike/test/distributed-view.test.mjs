import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createChannelDrive, writeSampleVideo } from '../src/channel-drive.mjs'
import {
  connectDistributedViews,
  createDistributedView,
  listEntries,
  readJsonFromView
} from '../src/distributed-view.mjs'
import { validateVideoRecord } from '../src/schema.mjs'

test('distributed-drive can list and read remote Hyperdrive metadata records', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'peartube-drive-dd-'))
  const channel = await createChannelDrive({ storagePath, name: 'Alice' })
  await writeSampleVideo({
    drive: channel.drive,
    channelKey: channel.channelKey,
    id: 'v1',
    title: 'Distributed metadata',
    size: 65536
  })

  const writerView = await createDistributedView(channel.drive)
  const readerView = await createDistributedView()
  const disconnect = connectDistributedViews(writerView, readerView)

  try {
    const entries = await listEntries(readerView, '/videos/v1')
    assert.ok(entries.some(entry => entry.key === '/videos/v1/video.json'))
    assert.ok(entries.some(entry => entry.key === '/videos/v1/source.mp4'))

    const video = await readJsonFromView(readerView, '/videos/v1/video.json')
    assert.equal(video.title, 'Distributed metadata')
    assert.equal(validateVideoRecord(video).ok, true)
  } finally {
    disconnect()
    await readerView.close()
    await writerView.close()
    await channel.close()
  }
})

test('distributed-drive entries do not expose source drive identity by default', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'peartube-drive-dd-source-'))
  const channel = await createChannelDrive({ storagePath, name: 'Alice' })
  await writeSampleVideo({
    drive: channel.drive,
    channelKey: channel.channelKey,
    id: 'v1',
    title: 'Source identity check',
    size: 65536
  })

  const writerView = await createDistributedView(channel.drive)
  const readerView = await createDistributedView()
  const disconnect = connectDistributedViews(writerView, readerView)

  try {
    const entries = (await listEntries(readerView, '/')).filter(entry => entry.key === '/profile.json')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].key, '/profile.json')
    assert.equal(Object.hasOwn(entries[0], 'driveKey'), false)
    assert.equal(Object.hasOwn(entries[0], 'peer'), false)
  } finally {
    disconnect()
    await readerView.close()
    await writerView.close()
    await channel.close()
  }
})
