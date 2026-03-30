import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createBundleCachePaths,
  normalizeBundleFilePath,
  shouldReusePersistedBundleCache,
} from '../src/native-bundle-cache.js'

test('createBundleCachePaths builds version and bundle file URIs from storage roots', () => {
  assert.deepEqual(
    createBundleCachePaths('file:///tmp/peartube'),
    {
      backendBundleUri: 'file:///tmp/peartube/backend.bundle',
      downloaderWorkerUri: 'file:///tmp/peartube/downloader-worker.bundle.js',
      versionMarkerUri: 'file:///tmp/peartube/backend-bundle.version',
    },
  )
})

test('normalizeBundleFilePath strips file:// prefixes and preserves native paths', () => {
  assert.equal(normalizeBundleFilePath('file:///tmp/peartube/backend.bundle'), '/tmp/peartube/backend.bundle')
  assert.equal(normalizeBundleFilePath('/tmp/peartube/backend.bundle'), '/tmp/peartube/backend.bundle')
})

test('shouldReusePersistedBundleCache only reuses matching versioned bundle sets', () => {
  assert.equal(
    shouldReusePersistedBundleCache({
      expectedVersionKey: '1.0.0-native',
      cachedVersionKey: '1.0.0-native',
      backendBundleExists: true,
      downloaderWorkerExists: true,
      needsDownloaderWorker: true,
    }),
    true,
  )

  assert.equal(
    shouldReusePersistedBundleCache({
      expectedVersionKey: '1.0.0-native',
      cachedVersionKey: '0.9.0-native',
      backendBundleExists: true,
      downloaderWorkerExists: true,
      needsDownloaderWorker: true,
    }),
    false,
  )

  assert.equal(
    shouldReusePersistedBundleCache({
      expectedVersionKey: '1.0.0-native',
      cachedVersionKey: '1.0.0-native',
      backendBundleExists: true,
      downloaderWorkerExists: false,
      needsDownloaderWorker: true,
    }),
    false,
  )

  assert.equal(
    shouldReusePersistedBundleCache({
      expectedVersionKey: '1.0.0-native',
      cachedVersionKey: '1.0.0-native',
      backendBundleExists: true,
      downloaderWorkerExists: false,
      needsDownloaderWorker: false,
    }),
    true,
  )
})
