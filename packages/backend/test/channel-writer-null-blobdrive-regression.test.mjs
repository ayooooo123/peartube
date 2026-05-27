import test from 'brittle'

import { MultiWriterChannel } from '../src/channel/multi-writer-channel.js'

function makeChannelWithBlobKey(blobsKeyHex) {
  const channel = Object.create(MultiWriterChannel.prototype)
  Object.defineProperty(channel, 'localWriterKeyHex', {
    value: 'a'.repeat(64),
    configurable: true
  })
  channel.blobs = {}
  channel.view = {
    async get() {
      return null
    }
  }
  channel.appended = null
  channel.appendOp = async (op) => {
    channel.appended = op
  }
  Object.defineProperty(channel, 'blobsKeyHex', {
    value: blobsKeyHex,
    configurable: true
  })
  return channel
}

test('ensureLocalBlobDrive omits null blobDriveKey from writer ops', async (t) => {
  const channel = makeChannelWithBlobKey(null)

  const result = await channel.ensureLocalBlobDrive({ deviceName: 'Desktop' })

  t.is(result, null)
  t.ok(channel.appended)
  t.is(channel.appended.type, 'upsert-writer')
  t.is(Object.hasOwn(channel.appended, 'blobDriveKey'), false)
})

test('ensureLocalBlobDrive includes blobDriveKey once the core key exists', async (t) => {
  const blobDriveKey = 'b'.repeat(64)
  const channel = makeChannelWithBlobKey(blobDriveKey)

  const result = await channel.ensureLocalBlobDrive({ deviceName: 'Desktop' })

  t.is(result, blobDriveKey)
  t.is(channel.appended.blobDriveKey, blobDriveKey)
})
