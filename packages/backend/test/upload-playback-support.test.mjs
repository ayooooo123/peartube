import test from 'node:test'
import assert from 'node:assert/strict'
import { createUploadManager } from '../src/upload.js'
import crypto from 'hypercore-crypto'

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

test('uploadFromBuffer marks Matroska uploads playable with unverified playback support', async () => {
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
  assert.equal(result.metadata.availability, 'playable')
  assert.equal(result.metadata.playbackSupport, 'unverified-container')
  assert.equal(channel.videos[0].playbackSupport, 'unverified-container')
})

test('catalog commit failure clears the newly written blob and leaves no upload metadata', async () => {
  const deviceKeyPair = crypto.keyPair(Buffer.alloc(32, 7))
  const blob = { id: '4:2:128:64', blockOffset: 4, blockLength: 2, byteOffset: 128, byteLength: 64 }
  const cleared = []
  const videos = []
  const channel = {
    localWriterKeyHex: '11'.repeat(32),
    blobsKeyHex: '22'.repeat(32),
    blobs: {
      async clear(value) {
        cleared.push({ ...value })
      },
    },
    async putBlob() {
      return { ...blob }
    },
    async addVideo(metadata) {
      videos.push(metadata)
    },
  }
  const catalog = {
    writable: true,
    localSignerKey: deviceKeyPair.publicKey,
    async getAuthorizationState() {
      return {
        writers: [{
          signerKey: Buffer.from(deviceKeyPair.publicKey).toString('hex'),
          capabilities: ['claim', 'publish'],
          firstAcceptedSequence: 1,
          lastAcceptedSequence: 0,
          expiresAt: Number.MAX_SAFE_INTEGER,
          admissionPolicyEpoch: 0,
          revocation: null,
        }],
      }
    },
    async getOperationReceipt() {
      return { accepted: false }
    },
    async createLocalOperation(value) {
      return { ...value, recordId: Buffer.alloc(32, value.sequence) }
    },
    async appendBatchAndConfirm() {
      throw new Error('injected immutable catalog commit failure')
    },
  }
  const manager = createUploadManager({
    ctx: {},
    deviceKeyPair,
    catalogRegistry: {
      async getWritableBindings() {
        return [{
          publisherId: Buffer.alloc(32, 9),
          catalog,
        }]
      },
    },
    now: () => 1_700_000_000_000,
  })

  const result = await manager.uploadFromBuffer(
    channel,
    Buffer.concat([Buffer.from([0x1A, 0x45, 0xDF, 0xA3]), Buffer.from('matroska'), Buffer.alloc(48)]),
    { title: 'Rollback fixture' },
  )

  assert.equal(result.success, false)
  assert.match(result.error, /catalog commit failure/)
  assert.deepEqual(cleared, [blob])
  assert.deepEqual(videos, [])
})
