import test from 'brittle'
import { createStorageGuard } from '../src/storage-guard.js'

// Build a fake fs over an in-memory tree: { 'db': { 'a.blob': blocks, ... } }.
function fakeFs (tree) {
  const dirent = (name, isDir) => ({ name, isDirectory: () => isDir })
  function resolve (path) {
    const parts = path.split('/').filter(Boolean)
    let node = tree
    for (const part of parts) {
      if (node && typeof node === 'object' && part in node) node = node[part]
      else return undefined
    }
    return node
  }
  return {
    readdirSync (dir) {
      const node = resolve(dir)
      if (!node || typeof node !== 'object') { const e = new Error('ENOTDIR'); throw e }
      return Object.entries(node).map(([name, v]) => dirent(name, v && typeof v === 'object'))
    },
    statSync (path) {
      const node = resolve(path)
      if (typeof node !== 'number') { const e = new Error('ENOENT'); throw e }
      return { blocks: node, size: node * 512 } // node = block count
    },
  }
}

test('storage guard trips on storage-dir usage reaching maxBytes', function (t) {
  // 3 blob files of 1000 blocks each = 3000 * 512 = 1_536_000 bytes.
  const fs = fakeFs({ root: { db: { 'a.blob': 1000, 'b.blob': 1000, 'c.blob': 1000 } } })
  const guard = createStorageGuard({
    storagePath: 'root',
    maxBytes: 1_500_000,
    statSync: fs.statSync,
    readdirSync: fs.readdirSync,
  })
  const snap = guard.snapshot()
  t.is(snap.usedBytes, 1_536_000, 'uses blocks*512 allocation accounting')
  t.ok(snap.overBudget, 'over the defined threshold')
  t.absent(guard.canIngest(), 'refuses ingestion at/over budget')
})

test('storage guard allows ingestion below budget', function (t) {
  const fs = fakeFs({ root: { db: { 'a.blob': 100 } } })
  const guard = createStorageGuard({
    storagePath: 'root',
    maxBytes: 1_000_000,
    statSync: fs.statSync,
    readdirSync: fs.readdirSync,
  })
  t.ok(guard.canIngest())
  t.absent(guard.snapshot().overBudget)
})

test('storage guard trips on free-disk floor', function (t) {
  const guard = createStorageGuard({
    storagePath: 'root',
    minFreeBytes: 2_000_000,
    statfsSync: () => ({ bsize: 4096, bavail: 100 }), // 409_600 bytes free
  })
  const snap = guard.snapshot()
  t.is(snap.freeBytes, 409_600)
  t.ok(snap.lowDisk)
  t.absent(guard.canIngest())
})

test('storage guard degrades to a no-op without fs primitives', function (t) {
  const guard = createStorageGuard({ storagePath: 'root', maxBytes: 1, minFreeBytes: 1 })
  t.ok(guard.canIngest(), 'fails open when it cannot measure')
  t.absent(guard.snapshot().enabled)
})

test('storage guard caches within ttl and re-measures after invalidate', function (t) {
  let calls = 0
  const guard = createStorageGuard({
    storagePath: 'root',
    maxBytes: 1_000_000,
    statSync: () => ({ blocks: 1 }),
    readdirSync: () => { calls++; return [{ name: 'x', isDirectory: () => false }] },
    ttlMs: 10_000,
    now: () => 1000,
  })
  guard.snapshot(); guard.snapshot()
  t.is(calls, 1, 'second read served from cache')
  guard.invalidate()
  guard.snapshot()
  t.is(calls, 2, 'invalidate forces re-measure')
})
