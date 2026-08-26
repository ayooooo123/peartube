import test from 'brittle'
import b4a from 'b4a'

import {
  createRenditionDescriptor,
  createSegmentIndexDescriptor,
  createStaticAssetManifest,
  decodeSegmentIndex,
  deriveSegmentIndexId,
  encodeSegmentIndex,
} from '../src/assets/index.js'

function hex(byte) {
  return b4a.toString(b4a.alloc(32, byte), 'hex')
}

function assetRef(byte = 3, byteLength = 3600) {
  return createStaticAssetManifest({
    treeHash: b4a.alloc(32, byte),
    blockLength: Math.ceil(byteLength / (256 * 1024)),
    byteLength,
  })
}

const entries = [
  { timeStartMs: 0, durationMs: 1000, byteStart: 0, byteEnd: 1200, independent: true },
  { timeStartMs: 1000, durationMs: 1000, byteStart: 1200, byteEnd: 2400, independent: false },
  { timeStartMs: 2000, durationMs: 1000, byteStart: 2400, byteEnd: 3600, independent: true },
]

test('segment indexes are bounded canonical immutable descriptors', (t) => {
  const descriptor = createSegmentIndexDescriptor({
    codec: 'fmp4-sidx-v1',
    mediaByteLength: 3600,
    entries,
  })
  const again = createSegmentIndexDescriptor({
    entries: entries.map(entry => ({ ...entry })),
    mediaByteLength: 3600,
    codec: 'fmp4-sidx-v1',
  })

  t.alike(descriptor, again)
  t.alike(descriptor.entryCount, 3)
  t.alike(descriptor.id, deriveSegmentIndexId(descriptor))
  t.alike(decodeSegmentIndex(encodeSegmentIndex(descriptor)), descriptor)
})

test('segment index validation rejects unsafe sparse seek coordinates before playback', (t) => {
  t.exception(() => createSegmentIndexDescriptor({ codec: 'x', mediaByteLength: 100, entries: [{ timeStartMs: 0, durationMs: 1, byteStart: 10, byteEnd: 10 }] }), /byte/i)
  t.exception(() => createSegmentIndexDescriptor({ codec: 'x', mediaByteLength: 100, entries: [{ timeStartMs: 0, durationMs: 1, byteStart: 20, byteEnd: 30 }, { timeStartMs: 1, durationMs: 1, byteStart: 25, byteEnd: 40 }] }), /overlap|monotonic/i)
  t.exception(() => createSegmentIndexDescriptor({ codec: 'x', mediaByteLength: 100, entries: [{ timeStartMs: 0, durationMs: 1, byteStart: 0, byteEnd: 101 }] }), /media/i)
  t.exception(() => createSegmentIndexDescriptor({ codec: 'x', mediaByteLength: 100, entries: Array.from({ length: 100001 }, (_, i) => ({ timeStartMs: i, durationMs: 1, byteStart: i, byteEnd: i + 1 })) }), /entry/i)
})

test('renditions reject segment ranges outside the referenced static asset byte length', (t) => {
  const segmentIndex = createSegmentIndexDescriptor({
    codec: 'fmp4-sidx-v1',
    mediaByteLength: 3601,
    entries: [
      { timeStartMs: 0, durationMs: 1000, byteStart: 0, byteEnd: 3601, independent: true },
    ],
  })

  t.exception(() => createRenditionDescriptor({
    purpose: 'original',
    format: 'video/mp4',
    core: assetRef(3, 3600),
    segmentIndex,
  }), /byte length/i)
})

test('segment indexes may reference separate immutable index cores', (t) => {
  const descriptor = createSegmentIndexDescriptor({
    codec: 'fmp4-sidx-v1',
    mediaByteLength: 3600,
    entries,
    indexCore: { key: hex(1), length: 3, treeHash: hex(2), byteLength: 512 },
  })

  t.alike(descriptor.indexCore.key, hex(1))
  t.alike(descriptor.indexCore.length, 3)
  t.exception(() => createSegmentIndexDescriptor({ codec: 'x', mediaByteLength: 1, entries: [], indexCore: { key: hex(1), length: -1, treeHash: hex(2), byteLength: 1 } }), /length/)
})
