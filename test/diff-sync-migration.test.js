import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'

const require = createRequire(import.meta.url)
const Hyperbee2 = require('hyperbee2')

const tmp = () => mkdtempSync(join(tmpdir(), 'peartube-diff-sync-test-'))

async function until (fn, ms = 30_000, label = 'condition') {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 150))
  }
}

test('zombie deletion fix: removed title does not resurrect on hibernation or cold restart from catalog-cache.json', async t => {
  const testnet = await createTestnet(3)
  const a = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const c = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const d = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const bDir = tmp()
  let b = null
  let bRestarted = null

  t.after(async () => {
    await bRestarted?.close()
    await b?.close()
    await d.close()
    await c.close()
    await a.close()
    await testnet.destroy()
  })

  await a.publish({ id: 'imdb:tt0133093', title: 'Matrix 1999' }, Readable.from([randomBytes(32 * 1024)]))
  const movie2 = await a.publish({ id: 'imdb:tt0234215', title: 'Matrix Reloaded 2003' }, Readable.from([randomBytes(32 * 1024)]))
  await c.publish({ id: 'imdb:tt0111161', title: 'Channel C Film' }, Readable.from([randomBytes(16 * 1024)]))
  await d.publish({ id: 'imdb:tt0068646', title: 'Channel D Film' }, Readable.from([randomBytes(16 * 1024)]))

  const chA = a.status().channel
  const chC = c.status().channel
  const chD = d.status().channel

  b = await createNode({
    storage: bDir,
    bootstrap: testnet.bootstrap,
    sources: [{ key: chA, kind: 'channel' }],
    maxActiveSources: 2
  })

  await until(async () => {
    const list = await b.search()
    return list.some(e => e.id === 'imdb:tt0133093') && list.some(e => e.id === 'imdb:tt0234215')
  }, 30_000, 'Node B syncs both initial movies from A')

  // Remove Movie 2 on A and publish a sentinel Movie 3 so B can prove it synced past the deletion.
  await a.remove(movie2.key)
  await a.publish({ id: 'imdb:tt0242653', title: 'Matrix Revolutions 2003' }, Readable.from([randomBytes(16 * 1024)]))
  const afterDelete = await until(async () => {
    const list = await b.search()
    return list.some(e => e.id === 'imdb:tt0242653') ? list : null
  }, 30_000, 'Node B syncs sentinel Movie 3 after Movie 2 deletion')
  assert.equal(afterDelete.some(e => e.id === 'imdb:tt0133093'), true, 'Movie 1 remains listed while A is awake')
  assert.equal(afterDelete.some(e => e.id === 'imdb:tt0234215'), false, 'Deleted Movie 2 must disappear while A is awake')

  // Open 2 other channels on B (with maxActiveSources: 2) to force Channel A into hibernation!
  await b.addSource(chC)
  await b.addSource(chD)
  await until(async () => {
    const list = await b.search()
    return list.some(e => e.id === 'imdb:tt0111161') && list.some(e => e.id === 'imdb:tt0068646')
  }, 30_000, 'Node B syncs Channels C and D')

  const srcA = b.listSources().find(s => s.key === chA)
  assert.ok(srcA, 'Channel A remains followed')
  assert.equal(srcA.active, false, 'Channel A must be hibernated after opening maxActiveSources other channels')
  assert.equal(srcA.entries, 2, 'Hibernated Channel A cache must hold only the 2 surviving movies')

  // Assert Movie 2 does NOT resurrect from B's hibernated cache!
  const listWhileHibernated = await b.search()
  assert.equal(listWhileHibernated.some(e => e.id === 'imdb:tt0133093'), true, 'Movie 1 remains listed from hibernated cache')
  assert.equal(listWhileHibernated.some(e => e.id === 'imdb:tt0242653'), true, 'Movie 3 remains listed from hibernated cache')
  assert.equal(listWhileHibernated.some(e => e.id === 'imdb:tt0234215'), false, 'Deleted Movie 2 must NOT resurrect from hibernated cache')
  assert.equal((await b.search('imdb:tt0234215')).length, 0, 'ID lookup must NOT resurrect deleted Movie 2')
  assert.equal(await b.findEntry(`channel:${chA}/${movie2.key}`), null, 'findEntry must NOT resurrect deleted Movie 2')

  // Close B (flushes catalog-cache.json) and verify disk cache + cold restart without A online.
  await b.close()
  b = null

  const saved = JSON.parse(readFileSync(join(bDir, 'catalog-cache.json'), 'utf8'))
  const savedA = saved.channels[chA]
  assert.ok(savedA, 'catalog-cache.json persisted Channel A')
  assert.equal(typeof savedA.viewKey, 'string')
  assert.equal(savedA.viewKey.length, 64, 'catalog-cache.json persisted 64-hex viewKey')
  assert.ok(Number.isInteger(savedA.viewVersion) && savedA.viewVersion > 0, 'catalog-cache.json persisted positive viewVersion')
  assert.deepEqual(savedA.entries.map(([, e]) => e.id).sort(), ['imdb:tt0133093', 'imdb:tt0242653'], 'catalog-cache.json must persist only surviving movies')

  // Restart B offline with Channel A placed 3rd so it stays hibernated and serves purely from catalog-cache.json.
  bRestarted = await createNode({
    storage: bDir,
    bootstrap: [{ host: '127.0.0.1', port: 1 }],
    sources: [
      { key: chC, kind: 'channel' },
      { key: chD, kind: 'channel' },
      { key: chA, kind: 'channel' }
    ],
    maxActiveSources: 2
  })

  const afterRestart = await bRestarted.search()
  assert.equal(afterRestart.some(e => e.id === 'imdb:tt0133093'), true, 'Movie 1 survives cold restart from catalog-cache.json')
  assert.equal(afterRestart.some(e => e.id === 'imdb:tt0234215'), false, 'Deleted Movie 2 must NOT resurrect after cold restart')
  assert.equal((await bRestarted.search('imdb:tt0234215')).length, 0, 'ID lookup stays empty for deleted Movie 2 after cold restart')
})

test('incremental diff sync applies adds and deletes in O(delta) without full-view rescans or losing untouched entries', async t => {
  const testnet = await createTestnet(3)
  const a = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const bDir = tmp()
  const b = await createNode({
    storage: bDir,
    bootstrap: testnet.bootstrap,
    sources: [{ key: a.status().channel, kind: 'channel' }]
  })

  const origDiff = Hyperbee2.prototype.createDiffStream
  const origRead = Hyperbee2.prototype.createReadStream
  t.after(async () => {
    Hyperbee2.prototype.createDiffStream = origDiff
    Hyperbee2.prototype.createReadStream = origRead
    await b.close()
    await a.close()
    await testnet.destroy()
  })

  await a.publish({ id: 'imdb:tt1000001', title: 'Untouched Alpha 2020' }, Readable.from([randomBytes(24 * 1024)]))
  const toDelete = await a.publish({ id: 'imdb:tt1000002', title: 'To Delete Beta 2021' }, Readable.from([randomBytes(24 * 1024)]))
  await a.publish({ id: 'imdb:tt1000003', title: 'Untouched Gamma 2022' }, Readable.from([randomBytes(24 * 1024)]))

  // Wait for initial sync (full scan).
  await until(async () => (await b.search()).length === 3, 30_000, 'Node B finishes initial 3-movie sync')

  // Instrument Hyperbee2 streams to prove the subsequent delta uses createDiffStream and zero full-view createReadStream walks.
  let diffStreamCalls = 0
  let fullReadStreamCalls = 0
  Hyperbee2.prototype.createDiffStream = function (...args) {
    diffStreamCalls++
    return origDiff.apply(this, args)
  }
  Hyperbee2.prototype.createReadStream = function (opts, ...rest) {
    const isBoundedRange = Boolean(opts && (opts.gte || opts.gt || opts.lte || opts.lt))
    // Ignore publisher A's own primary view (used by `a.remove()` for blob refcount GC).
    if (!isBoundedRange && this !== a.channel.view) fullReadStreamCalls++
    return origRead.call(this, opts, ...rest)
  }

  // Delete 1 old entry and then publish 1 new entry on A so seeing Movie 4 guarantees the delete is also flushed.
  await a.remove(toDelete.key)
  const addedBytes = randomBytes(48 * 1024 + 7)
  const added = await a.publish({ id: 'imdb:tt1000004', title: 'Added Delta 2025' }, Readable.from([addedBytes]))

  const synced = await until(async () => {
    const list = await b.search()
    return list.some(e => e.id === 'imdb:tt1000004') ? list : null
  }, 30_000, 'Node B syncs newly added Movie 4')

  // Restore prototypes before remaining checks.
  Hyperbee2.prototype.createDiffStream = origDiff
  Hyperbee2.prototype.createReadStream = origRead

  const ids = synced.map(e => e.id).sort()
  assert.deepEqual(ids, ['imdb:tt1000001', 'imdb:tt1000003', 'imdb:tt1000004'], 'Untouched entries kept, old deleted, new added')
  assert.ok(diffStreamCalls >= 1, `Expected incremental createDiffStream to run at least once (got ${diffStreamCalls})`)
  assert.equal(fullReadStreamCalls, 0, `Expected zero full-view createReadStream walks during incremental sync (got ${fullReadStreamCalls})`)

  // Verify the newly added blob key was registered in scoped replication and streams cleanly!
  const hit = synced.find(e => e.id === 'imdb:tt1000004')
  assert.equal(hit.sha256, added.sha256)
  const streamed = Buffer.from(await (await fetch(hit.streamUrl)).arrayBuffer())
  assert.deepEqual(streamed, addedBytes, 'Newly diff-synced video streams exact bytes under scoped replication')
})

test('smooth v0.5.0 catalog-cache.json migration: readable at boot before sync and reconciles deletes on connect', async t => {
  const testnet = await createTestnet(3)
  const a = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const bDir = tmp()
  let bOffline = null
  let bOnline = null

  t.after(async () => {
    await bOnline?.close()
    await bOffline?.close()
    await a.close()
    await testnet.destroy()
  })

  // Publisher creates Movie 1 (stays), Movie 2 (will be deleted), and Movie 3 (added after legacy snapshot).
  const pub1 = await a.publish({ id: 'imdb:tt2000001', title: 'Legacy Survivor 2019' }, Readable.from([randomBytes(16 * 1024)]))
  const pub2 = await a.publish({ id: 'imdb:tt2000002', title: 'Legacy Stale Deleted 2020' }, Readable.from([randomBytes(16 * 1024)]))
  const entry1 = await a.findEntry(pub1.key)
  const entry2 = await a.findEntry(pub2.key)
  assert.ok(entry1 && entry2, 'Publisher entries ready for legacy cache fixture')

  // Publisher deletes Movie 2 and publishes Movie 3 while B is offline.
  await a.remove(pub2.key)
  await a.publish({ id: 'imdb:tt2000003', title: 'Fresh Post-Migration 2026' }, Readable.from([randomBytes(16 * 1024)]))

  const chA = a.status().channel
  // Write exact legacy v0.5.0 catalog-cache.json format (no viewKey, no viewVersion).
  const legacyCache = {
    version: 1,
    channels: {
      [chA]: {
        syncedAt: 1700000000000,
        entries: [
          [pub1.key, entry1],
          [pub2.key, entry2]
        ],
        discovered: []
      }
    }
  }
  writeFileSync(join(bDir, 'catalog-cache.json'), JSON.stringify(legacyCache), { mode: 0o600 })

  // Step 1: Boot Node B offline (cannot reach A). Both legacy cached entries must be readable immediately!
  bOffline = await createNode({
    storage: bDir,
    bootstrap: [{ host: '127.0.0.1', port: 1 }],
    sources: [{ key: chA, kind: 'channel' }]
  })

  const bootList = await bOffline.search()
  assert.deepEqual(bootList.map(e => e.id).sort(), ['imdb:tt2000001', 'imdb:tt2000002'], 'Legacy v0.5.0 cached entries readable immediately at boot before sync')
  assert.equal((await bOffline.search('imdb:tt2000002')).length, 1, 'Legacy ID lookup works before sync')
  assert.equal((await bOffline.findEntry(`channel:${chA}/${pub2.key}`))?.id, 'imdb:tt2000002', 'Legacy findEntry works before sync')
  await bOffline.close()
  bOffline = null

  // Step 2: Reopen Node B on the live testnet so it connects to A and reconciles cleanly!
  bOnline = await createNode({
    storage: bDir,
    bootstrap: testnet.bootstrap,
    sources: [{ key: chA, kind: 'channel' }]
  })

  const reconciled = await until(async () => {
    const list = await bOnline.search()
    const has1 = list.some(e => e.id === 'imdb:tt2000001')
    const has3 = list.some(e => e.id === 'imdb:tt2000003')
    return has1 && has3 ? list : null
  }, 30_000, 'Node B syncs live publisher after loading legacy v0.5.0 cache')

  assert.deepEqual(reconciled.map(e => e.id).sort(), ['imdb:tt2000001', 'imdb:tt2000003'], 'Legacy cache reconciled: survivor kept, deleted removed, new added')
  await bOnline.close()
  bOnline = null

  // Verify catalog-cache.json was upgraded in place with viewKey & viewVersion and without the stale entry.
  const upgraded = JSON.parse(readFileSync(join(bDir, 'catalog-cache.json'), 'utf8'))
  const upgradedA = upgraded.channels[chA]
  assert.equal(upgraded.version, 1)
  assert.equal(typeof upgradedA.viewKey, 'string')
  assert.equal(upgradedA.viewKey.length, 64, 'Upgraded cache persisted viewKey')
  assert.ok(Number.isInteger(upgradedA.viewVersion) && upgradedA.viewVersion > 0, 'Upgraded cache persisted viewVersion')
  assert.deepEqual(upgradedA.entries.map(([, e]) => e.id).sort(), ['imdb:tt2000001', 'imdb:tt2000003'])
})
