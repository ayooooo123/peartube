import test from 'brittle'

import {
  buildBlobRefCacheKey,
  normalizeBlobRefInput,
  parseBlobId,
  parseBlobRef,
  stringifyBlobId,
} from '../src/blob-ref.js'

test('parseBlobId accepts hyperblob range strings', (t) => {
  t.alike(parseBlobId('10:4:128:4096'), {
    blockOffset: 10,
    blockLength: 4,
    byteOffset: 128,
    byteLength: 4096,
  })
})

test('parseBlobId rejects malformed ranges', (t) => {
  t.is(parseBlobId(null), null)
  t.is(parseBlobId(''), null)
  t.is(parseBlobId('1:2:3'), null)
  t.is(parseBlobId('1:2:3:NaN'), null)
  t.is(parseBlobId('1:2:3:-4'), null)
  t.is(parseBlobId('1:0:3:4'), null)
  t.is(parseBlobId({ blockOffset: 1, blockLength: 2, byteOffset: 0, byteLength: 10 }), null)
})

test('normalizeBlobRefInput preserves valid object blob ranges', (t) => {
  const blob = { blockOffset: 1, blockLength: 2, byteOffset: 3, byteLength: 4 }
  t.alike(normalizeBlobRefInput(blob), blob)
})

test('parseBlobRef normalizes key, id, mime, and byte length', (t) => {
  const ref = parseBlobRef({
    blobsCoreKey: 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789',
    blobId: '1:2:3:4',
    mimeType: 'video/mp4',
    byteLength: '4',
  })

  t.alike(ref, {
    blobsCoreKey: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    blobId: '1:2:3:4',
    blob: { blockOffset: 1, blockLength: 2, byteOffset: 3, byteLength: 4 },
    mimeType: 'video/mp4',
    byteLength: 4,
  })
})

test('parseBlobRef fails closed for partial or invalid refs', (t) => {
  t.is(parseBlobRef({ blobsCoreKey: 'abc', blobId: '1:2:3:4' }), null)
  t.is(parseBlobRef({ blobsCoreKey: 'a'.repeat(64) }), null)
  t.is(parseBlobRef({ blobId: '1:2:3:4' }), null)
  t.is(parseBlobRef({ blobsCoreKey: 'a'.repeat(64), blobId: '1:2:3' }), null)
})

test('normalizeBlobRefInput accepts persisted hyperblob range strings', (t) => {
  t.alike(normalizeBlobRefInput('10:4:128:4096'), {
    blockOffset: 10,
    blockLength: 4,
    byteOffset: 128,
    byteLength: 4096,
  })
})

test('stringifyBlobId and cache key use normalized identity', (t) => {
  const blob = { blockOffset: 1, blockLength: 2, byteOffset: 3, byteLength: 4 }
  t.is(stringifyBlobId(blob), '1:2:3:4')
  t.is(buildBlobRefCacheKey({ driveKey: 'drive', id: 'vid', blobsCoreKey: 'A'.repeat(64), blobId: blob }), 'drive:vid:' + 'a'.repeat(64) + ':1:2:3:4')
})


test('normalizeBlobRefInput accepts nested blob ref wrappers from mirror seeders and fetchers', (t) => {
  const expected = { blockOffset: 2, blockLength: 3, byteOffset: 4, byteLength: 5 }
  t.alike(normalizeBlobRefInput({ blobId: '2:3:4:5' }), expected)
  t.alike(normalizeBlobRefInput({ blob: expected }), expected)
  t.alike(normalizeBlobRefInput({ id: '2:3:4:5' }), expected)
  t.alike(parseBlobRef({
    blobsCoreKey: 'A'.repeat(64),
    blobRef: { blobId: '2:3:4:5', byteLength: '5' },
  }), {
    blobsCoreKey: 'a'.repeat(64),
    blobId: '2:3:4:5',
    blob: expected,
    byteLength: 5,
  })
})
