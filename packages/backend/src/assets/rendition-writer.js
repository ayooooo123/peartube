import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { createRenditionDescriptor } from './rendition.js'
import { createSegmentIndexDescriptor } from './segment-index.js'

function hashHex(buffer) {
  return b4a.toString(crypto.hash(buffer), 'hex')
}

function assertNotCancelled(signal) {
  if (signal?.aborted) throw new Error('rendition write cancelled')
}

function concatChunks(chunks = []) {
  if (!Array.isArray(chunks) || chunks.length === 0) throw new Error('chunks are required')
  return b4a.concat(chunks.map((chunk) => b4a.from(chunk)))
}

export function createImmutableRenditionWriter() {
  let initialized = false
  let openWrites = 0

  return {
    async initialize() {
      initialized = true
    },

    getOpenWriteCount() {
      return openWrites
    },

    async writeRendition(input = {}) {
      if (!initialized) throw new Error('rendition writer must initialize before writes')
      openWrites++
      try {
        assertNotCancelled(input.signal)
        const bytes = concatChunks(input.chunks)
        assertNotCancelled(input.signal)
        const segmentIndex = createSegmentIndexDescriptor({
          codec: input.segmentCodec || 'peartube-inline-segments-v1',
          mediaByteLength: bytes.byteLength,
          entries: input.segments || [{ timeStartMs: 0, durationMs: Number(input.durationMs || 1), byteStart: 0, byteEnd: bytes.byteLength, independent: true }],
          indexCore: input.indexCore,
        })
        const descriptor = createRenditionDescriptor({
          purpose: input.purpose,
          format: input.format,
          core: {
            key: hashHex(b4a.concat([b4a.from('core-key'), bytes])),
            length: Number(input.coreLength || 1),
            treeHash: hashHex(bytes),
            byteLength: bytes.byteLength,
          },
          segmentIndex,
        })
        return { descriptor, segmentIndex, bytes: b4a.from(bytes), sealed: true, readOnly: true }
      } finally {
        openWrites--
      }
    },
  }
}
