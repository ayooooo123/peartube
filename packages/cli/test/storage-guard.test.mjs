import test from 'brittle'
import { readFile } from 'node:fs/promises'
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

test('storage guard reports the bytes a single ingest may still write', function (t) {
  const guard = createStorageGuard({
    storagePath: 'root',
    minFreeBytes: 2_000_000,
    statfsSync: () => ({ bsize: 4096, bavail: 1000 }), // 4_096_000 bytes free
  })
  t.is(guard.headroomBytes(), 2_096_000, 'free space above the floor, not raw free space')

  const atFloor = createStorageGuard({
    storagePath: 'root',
    minFreeBytes: 2_000_000,
    statfsSync: () => ({ bsize: 4096, bavail: 100 }),
  })
  t.is(atFloor.headroomBytes(), 0, 'never negative: at the floor there is nothing to write')

  const unmeasurable = createStorageGuard({ storagePath: 'root', maxBytes: 1 })
  t.is(unmeasurable.headroomBytes(), null, 'null when free space cannot be measured')
})

test('storage guard bounds deliberate archive writes by the aggregate storage budget', function (t) {
  const fs = fakeFs({ root: { db: { 'existing.blob': 20 } } })
  const guard = createStorageGuard({
    storagePath: 'root',
    maxBytes: 12_288,
    statSync: fs.statSync,
    readdirSync: fs.readdirSync,
  })

  t.is(guard.headroomBytes(), 2_048, 'an archive may only consume the unallocated part of storage.maxBytes')
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

// The bug this test exists for: `#fs` did not export `statfsSync` for Bare, so
// on every real relay the configured free-disk floor measured nothing, refused
// nothing, and said nothing about it. The guard now states what it can measure.
test('storage guard says which signals it can measure, especially the missing one', function (t) {
  const lines = []
  const fs = fakeFs({ root: { db: { 'a.blob': 100 } } })

  createStorageGuard({
    storagePath: 'root',
    maxBytes: 1_000_000,
    minFreeBytes: 2_000_000,
    statSync: fs.statSync,
    readdirSync: fs.readdirSync,
    // Exactly the Bare relay's shape until the shim exported statfsSync.
    statfsSync: null,
    log: (line) => lines.push(line),
  })
  t.ok(lines[0].includes('free=unmeasurable'), 'a floor it cannot measure is named as such')
  t.ok(lines[0].includes('usage=measurable'), 'and the signal that does work is distinguished')
  t.ok(lines[0].includes('floor=2000000'), 'with the floor the operator configured')
  t.is(lines.length, 1, 'no free-space probe is claimed when free space cannot be read')

  lines.length = 0
  createStorageGuard({
    storagePath: 'root',
    minFreeBytes: 2_000_000,
    statfsSync: () => ({ bsize: 4096, bavail: 1000 }),
    log: (line) => lines.push(line),
  })
  t.ok(lines[0].includes('free=measurable'), 'a runtime that can statfs says so')
  t.ok(lines[1].includes('freeBytes=4096000'), 'and puts the measured number on the record at boot')
})

// The shim is the contract: the guard reads these names off `#fs`, and a name
// that is absent arrives as undefined and disables its signal in silence.
test('the Bare fs shim exports every name the storage guard reads', async function (t) {
  const source = await readFile(new URL('../src/shims/fs.bare.js', import.meta.url), 'utf8')
  for (const name of ['statfsSync', 'statSync', 'readdirSync']) {
    t.ok(new RegExp(`^\\s*${name},?$`, 'm').test(source), `#fs exports ${name} under Bare`)
  }
})
