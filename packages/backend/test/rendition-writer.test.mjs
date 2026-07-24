import test from 'brittle'
import b4a from 'b4a'

import { createImmutableRenditionWriter } from '../src/assets/rendition-writer.js'

function bytes(value, length) {
  return b4a.alloc(length, value)
}

test('rendition writer blocks use before initialization and writes deterministic sealed descriptors', async (t) => {
  const writer = createImmutableRenditionWriter()
  await t.exception(() => writer.writeRendition({ purpose: 'original', format: 'video/mp4', chunks: [bytes(1, 8)] }), /initialize/)
  await writer.initialize()

  const first = await writer.writeRendition({
    purpose: 'original',
    format: 'video/mp4',
    chunks: [bytes(1, 8), bytes(2, 8)],
    segments: [
      { timeStartMs: 0, durationMs: 1000, byteStart: 0, byteEnd: 8, independent: true },
      { timeStartMs: 1000, durationMs: 1000, byteStart: 8, byteEnd: 16, independent: true },
    ],
  })
  const second = await writer.writeRendition({ purpose: 'original', format: 'video/mp4', chunks: [bytes(1, 8), bytes(2, 8)], segments: first.segmentIndex.entries })

  t.ok(first.sealed)
  t.alike(first.descriptor.renditionId, second.descriptor.renditionId)
  t.alike(first.descriptor.core.byteLength, 16)
  t.alike(first.descriptor.segmentIndex.entryCount, 2)
})

test('rendition writer cleans up cancelled writes and never stores caller chunk references', async (t) => {
  const writer = createImmutableRenditionWriter()
  await writer.initialize()
  const chunk = bytes(7, 16)
  await t.exception(() => writer.writeRendition({ purpose: 'original', format: 'video/mp4', chunks: [chunk], signal: { aborted: true } }), /cancel/)
  t.alike(writer.getOpenWriteCount(), 0)

  const written = await writer.writeRendition({ purpose: 'original', format: 'video/mp4', chunks: [chunk] })
  chunk[0] = 99
  t.unlike(written.bytes[0], 99)
})
