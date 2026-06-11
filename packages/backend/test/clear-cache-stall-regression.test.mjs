import test from 'brittle'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { collectCorestoreGarbage } from '../src/corestore-gc.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const seedingSource = readFileSync(resolve(__dirname, '../src/seeding.js'), 'utf8')
const apiSource = readFileSync(resolve(__dirname, '../src/api.js'), 'utf8')

test('collectCorestoreGarbage honors skipFlush/skipCompact', async (t) => {
  const calls = []
  const store = {
    storage: {
      async flush() { calls.push('flush') },
      async compact() { calls.push('compact') },
    },
  }

  const flushOnly = await collectCorestoreGarbage(store, { skipCompact: true })
  t.alike(calls, ['flush'])
  t.is(flushOnly.flushed, true)
  t.is(flushOnly.compacted, false)

  calls.length = 0
  const compactOnly = await collectCorestoreGarbage(store, { skipFlush: true })
  t.alike(calls, ['compact'])
  t.is(compactOnly.flushed, false)
  t.is(compactOnly.compacted, true)
})

test('clearCache does not hold the RPC reply on RocksDB compaction', (t) => {
  // Compacting a multi-GB store can take minutes on mobile flash. Awaiting it
  // inside clearCache held the RPC reply and starved every other storage op —
  // the app appeared to hang on "Clear cache". The flush is awaited (cleared
  // ranges become durable) but compaction must run in the background.
  const clearCacheStart = seedingSource.indexOf('async clearCache(')
  t.ok(clearCacheStart !== -1, 'expected SeedingManager.clearCache')
  const clearCache = seedingSource.slice(clearCacheStart, seedingSource.indexOf('clearCacheSync', clearCacheStart))

  t.ok(/await collectCorestoreGarbage\(this\.store, \{[^}]*skipCompact: true/s.test(clearCache),
    'the awaited GC pass must skip compaction')
  t.ok(/void collectCorestoreGarbage\(this\.store, \{[^}]*skipFlush: true/s.test(clearCache),
    'compaction must be kicked off without being awaited')
})

test('clearCache cancels live prefetch downloads before clearing blocks', (t) => {
  // Clearing blocks under an active linear fill immediately re-downloads
  // them; the clear/download race thrashes storage and the cache never
  // actually shrinks.
  const clearCacheStart = apiSource.indexOf('async clearCache(')
  t.ok(clearCacheStart !== -1, 'expected api.clearCache')
  const clearCache = apiSource.slice(clearCacheStart, clearCacheStart + 1600)

  t.ok(/activeRangeRequests\.entries\(\)/.test(clearCache), 'clearCache iterates active prefetch sessions')
  t.ok(/request\.cancel\?\.\(\)/.test(clearCache), 'clearCache flags sessions cancelled so their timers cannot restart downloads')
  t.ok(clearCache.indexOf('activeRangeRequests.delete') < clearCache.indexOf('seedingManager.clearCache'),
    'downloads are cancelled before seed blocks are cleared')
})
