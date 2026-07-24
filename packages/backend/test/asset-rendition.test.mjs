import test from 'brittle'
import b4a from 'b4a'

import {
  createRenditionDescriptor,
  createSegmentIndexDescriptor,
  deriveRenditionId,
} from '../src/assets/index.js'

function hex(byte) {
  return b4a.toString(b4a.alloc(32, byte), 'hex')
}

function indexDescriptor() {
  return createSegmentIndexDescriptor({
    codec: 'fmp4-sidx-v1',
    mediaByteLength: 2048,
    entries: [
      { timeStartMs: 0, durationMs: 1000, byteStart: 0, byteEnd: 1024, independent: true },
      { timeStartMs: 1000, durationMs: 1000, byteStart: 1024, byteEnd: 2048, independent: true },
    ],
  })
}

test('rendition id derives from exact reusable content, not publisher identity', (t) => {
  const descriptor = createRenditionDescriptor({
    purpose: 'video-playback',
    format: 'video/mp4; codecs="avc1.640028"',
    core: { key: hex(1), length: 42, treeHash: hex(2), byteLength: 2048 },
    segmentIndex: indexDescriptor(),
  })
  const byOtherPublisher = createRenditionDescriptor({
    publisherId: hex(99),
    purpose: 'video-playback',
    format: 'video/mp4; codecs="avc1.640028"',
    core: { key: hex(1), length: 42, treeHash: hex(2), byteLength: 2048 },
    segmentIndex: indexDescriptor(),
  })

  t.alike(descriptor.renditionId, deriveRenditionId(descriptor))
  t.alike(byOtherPublisher.renditionId, descriptor.renditionId)
})

test('rendition id changes for one-field content changes and validates core bounds', (t) => {
  const base = createRenditionDescriptor({
    purpose: 'original',
    format: 'video/mp4',
    core: { key: hex(3), length: 1, treeHash: hex(4), byteLength: 10 },
  })
  const changed = createRenditionDescriptor({
    purpose: 'original',
    format: 'video/mp4',
    core: { key: hex(3), length: 1, treeHash: hex(5), byteLength: 10 },
  })

  t.unlike(base.renditionId, changed.renditionId)
  t.exception(() => createRenditionDescriptor({ purpose: 'original', format: 'video/mp4', core: { key: 'abc', length: 1, treeHash: hex(4), byteLength: 10 } }), /core.key/)
  t.exception(() => createRenditionDescriptor({ purpose: 'original', format: 'video/mp4', core: { key: hex(3), length: -1, treeHash: hex(4), byteLength: 10 } }), /length/)
})
