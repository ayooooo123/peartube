import test from 'node:test'
import assert from 'node:assert/strict'

import { HypercoreIOReader } from '../backend/hypercore-io-reader.mjs'

function createReaderWithBlocks(blobInfo, blocks) {
  const reader = new HypercoreIOReader({
    contiguousLength: blobInfo.blockOffset + blobInfo.blockLength,
    async has() {
      return true
    },
    async get(index) {
      const block = blocks[index]
      return Buffer.isBuffer(block) ? block : Buffer.from(block)
    },
  }, blobInfo)

  return reader
}

test('HypercoreIOReader starts reads at blobInfo.byteOffset inside the first block', async () => {
  const reader = createReaderWithBlocks(
    { blockOffset: 4, blockLength: 2, byteOffset: 3, byteLength: 7 },
    {
      4: Buffer.from('abcHEADER'),
      5: Buffer.from('TAILzzz'),
    },
  )

  await reader.preload()

  const buffer = Buffer.alloc(7)
  assert.equal(reader.syncRead(buffer), 7)
  assert.equal(buffer.toString(), 'HEADERT')
  assert.equal(reader.syncRead(Buffer.alloc(1)), 0, 'reader should stop at blob byteLength, not block length')
})

test('HypercoreIOReader seek positions are relative to blob data, not hypercore block data', async () => {
  const reader = createReaderWithBlocks(
    { blockOffset: 7, blockLength: 2, byteOffset: 5, byteLength: 8 },
    {
      7: Buffer.from('xxxxx01234'),
      8: Buffer.from('56789'),
    },
  )

  await reader.preload()
  assert.equal(reader.seek(4, 0), 4)

  const buffer = Buffer.alloc(4)
  assert.equal(reader.syncRead(buffer), 4)
  assert.equal(buffer.toString(), '4567')
})
