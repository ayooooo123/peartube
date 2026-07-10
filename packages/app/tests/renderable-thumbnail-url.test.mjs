import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getRenderableThumbnailUrl,
  isLoopbackThumbnailUrl,
} from '../lib/renderable-thumbnail-url.mjs'

test('a resolved cache URL always wins', () => {
  const url = getRenderableThumbnailUrl(
    { thumbnailBlobId: 'blob', thumbnailBlobsCoreKey: 'core' },
    'http://127.0.0.1:5000/current-process.jpg',
  )
  assert.equal(url, 'http://127.0.0.1:5000/current-process.jpg')
})

test('regression: a remote inline thumbnail renders even when blob refs are present', () => {
  // Archived/imported videos carry a real remote thumbnail AND blob refs. The
  // buggy version discarded the inline URL whenever blob refs existed, forcing a
  // flaky blob resolve and leaving those cards blank ("some load, others don't").
  const url = getRenderableThumbnailUrl({
    thumbnail: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
    thumbnailBlobId: 'blob',
    thumbnailBlobsCoreKey: 'core',
  })
  assert.equal(url, 'https://i.ytimg.com/vi/abc/hqdefault.jpg')
})

test('regression: a self-contained data: thumbnail renders even with blob refs', () => {
  const dataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
  const url = getRenderableThumbnailUrl({
    thumbnailUrl: dataUrl,
    thumbnailBlobId: 'blob',
    thumbnailBlobsCoreKey: 'core',
  })
  assert.equal(url, dataUrl)
})

test('a stale loopback inline URL is never painted directly', () => {
  // Only the freshly-resolved cache URL is safe; a persisted loopback URL points
  // at a dead port/process, so render nothing until an HRPC resolve fills cache.
  assert.ok(isLoopbackThumbnailUrl('http://127.0.0.1:5000/old.jpg'))
  const url = getRenderableThumbnailUrl({
    thumbnailUrl: 'http://127.0.0.1:5000/old.jpg',
    thumbnailBlobId: 'blob',
    thumbnailBlobsCoreKey: 'core',
  })
  assert.equal(url, null)
})

test('blob-only videos with no inline URL wait for the cache resolve', () => {
  const url = getRenderableThumbnailUrl({
    thumbnailBlobId: 'blob',
    thumbnailBlobsCoreKey: 'core',
  })
  assert.equal(url, null)
})

test('non-native callers keep the raw inline URL (including loopback)', () => {
  const url = getRenderableThumbnailUrl(
    { thumbnailUrl: 'http://127.0.0.1:5000/old.jpg' },
    null,
    { native: false },
  )
  assert.equal(url, 'http://127.0.0.1:5000/old.jpg')
})
