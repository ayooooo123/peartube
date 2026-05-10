import test from 'node:test'
import assert from 'node:assert/strict'
import { createUploadManager } from '../src/upload.js'

function makeChannel() {
  const videos = []
  return {
    localWriterKeyHex: '11'.repeat(32),
    blobsKeyHex: '22'.repeat(32),
    videos,
    blobs: {
      createWriteStream() {
        return {
          id: { blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 32 },
          on() { return this },
          close() {},
        }
      },
    },
    async putBlob() {
      return { id: '0:1:0:32' }
    },
    async addVideo(metadata) {
      videos.push(metadata)
    },
  }
}

test('uploadFromBuffer marks Matroska uploads as unsupported for direct playback', async () => {
  const manager = createUploadManager({ ctx: {} })
  const channel = makeChannel()
  const header = Buffer.concat([
    Buffer.from([0x1A, 0x45, 0xDF, 0xA3]),
    Buffer.from('matroska'),
    Buffer.alloc(32),
  ])

  const result = await manager.uploadFromBuffer(channel, header, { title: 'Movie' })

  assert.equal(result.success, true)
  assert.equal(result.metadata.mimeType, 'video/x-matroska')
  assert.equal(result.metadata.availability, 'unknown')
  assert.equal(result.metadata.playbackSupport, 'unsupported-container')
  assert.equal(channel.videos[0].playbackSupport, 'unsupported-container')
})
