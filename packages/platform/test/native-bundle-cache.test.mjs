import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildBundleVersionKey,
  createBundleCachePaths,
  fingerprintBundleSource,
  fnv1aHashString,
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

test('fnv1aHashString is deterministic and discriminative', () => {
  assert.equal(fnv1aHashString('hello'), fnv1aHashString('hello'))
  assert.notEqual(fnv1aHashString('hello'), fnv1aHashString('hellO'))
  assert.equal(fnv1aHashString(''), '00000000')
  assert.equal(fnv1aHashString('a').length, 8)
})

test('fingerprintBundleSource produces stable identifiers per source content', () => {
  const a = 'X'.repeat(10000)
  const b = 'X'.repeat(10000) + 'Y'
  assert.equal(fingerprintBundleSource(a), fingerprintBundleSource(a))
  assert.notEqual(fingerprintBundleSource(a), fingerprintBundleSource(b))
  assert.equal(fingerprintBundleSource(null), fingerprintBundleSource(undefined))
})

test('fingerprintBundleSource changes for middle-only bundle edits', () => {
  const head = 'H'.repeat(4096)
  const tail = 'T'.repeat(4096)
  const a = `${head}${'A'.repeat(2048)}${tail}`
  const b = `${head}${'B'.repeat(2048)}${tail}`

  assert.equal(a.length, b.length)
  assert.equal(a.slice(0, 4096), b.slice(0, 4096))
  assert.equal(a.slice(-4096), b.slice(-4096))
  assert.notEqual(
    fingerprintBundleSource(a),
    fingerprintBundleSource(b),
    'middle-only backend bundle edits must invalidate the persisted native worklet cache',
  )
})

test('buildBundleVersionKey changes when only the embedded backend bundle changes', () => {
  const baseKey = 'peartube-native-backend:1.0.0:1'
  const a = buildBundleVersionKey({ baseKey, backendSource: 'console.log("v1")' })
  const b = buildBundleVersionKey({ baseKey, backendSource: 'console.log("v2")' })
  assert.notEqual(a, b, 'fingerprint must change when bundle content changes (otherwise updated installs reuse stale cached worklet)')
  assert.match(String(a), /^peartube-native-backend:1\.0\.0:1:b=/)
})

test('buildBundleVersionKey is stable when nothing changes between launches', () => {
  const baseKey = 'peartube-native-backend:1.0.0:1'
  const source = 'console.log("identical")'
  assert.equal(
    buildBundleVersionKey({ baseKey, backendSource: source, downloaderWorkerSource: 'worker' }),
    buildBundleVersionKey({ baseKey, backendSource: source, downloaderWorkerSource: 'worker' }),
  )
})

test('buildBundleVersionKey returns undefined without a base key (dev/Expo Go fallthrough)', () => {
  assert.equal(buildBundleVersionKey({ baseKey: undefined, backendSource: 'src' }), undefined)
  assert.equal(buildBundleVersionKey({ baseKey: '', backendSource: 'src' }), undefined)
})

test('buildBundleVersionKey discriminates downloader worker changes too', () => {
  const baseKey = 'peartube-native-backend:1.0.0:1'
  const backendSource = 'backend-source'
  const a = buildBundleVersionKey({ baseKey, backendSource, downloaderWorkerSource: 'worker-v1' })
  const b = buildBundleVersionKey({ baseKey, backendSource, downloaderWorkerSource: 'worker-v2' })
  assert.notEqual(a, b)
})
