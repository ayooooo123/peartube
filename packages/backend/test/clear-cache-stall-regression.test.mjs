import test from 'brittle'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { collectCorestoreGarbage } from '../src/corestore-gc.js'
import { SeedingManager } from '../src/seeding.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const seedingSource = readFileSync(resolve(__dirname, '../src/seeding.js'), 'utf8')
const apiSource = readFileSync(resolve(__dirname, '../src/api.js'), 'utf8')

const GB = 1024 * 1024 * 1024
const coreA = 'aa'.repeat(32)

function createMetaDb() {
  const state = new Map()
  return {
    async get(key) {
      return state.has(key) ? { value: state.get(key) } : null
    },
    async put(key, value) {
      state.set(key, value)
    }
  }
}

function createStore() {
  const cores = new Map()
  return {
    storage: {
      flushCalls: 0,
      compactCalls: 0,
      async flush() {
        this.flushCalls += 1
      },
      async compact() {
        this.compactCalls += 1
      },
    },
    async getDiskUsageBytes() {
      return 6 * GB
    },
    get(key) {
      const keyHex = Buffer.isBuffer(key) ? key.toString('hex') : String(key)
      if (!cores.has(keyHex)) {
        cores.set(keyHex, {
          async ready() {},
          async clear() {}
        })
      }
      return cores.get(keyHex)
    }
  }
}

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

test('clearCache defers RocksDB compaction to idle storage maintenance', (t) => {
  // Compacting a multi-GB store can take minutes on mobile flash. Awaiting it
  // inside clearCache held the RPC reply and starved every other storage op —
  // the app appeared to hang on "Clear cache". The flush is awaited (cleared
  // ranges become durable) but compaction must be scheduled for later so it can
  // re-check playback state before touching RocksDB.
  const clearCacheStart = seedingSource.indexOf('async clearCache(')
  t.ok(clearCacheStart !== -1, 'expected SeedingManager.clearCache')
  const clearCache = seedingSource.slice(clearCacheStart, seedingSource.indexOf('clearCacheSync', clearCacheStart))

  t.ok(/await this\.flushClearedBlobRanges\('cache clear'\)/.test(clearCache),
    'clearCache should flush cleared ranges through the maintenance helper')
  t.absent(/void collectCorestoreGarbage\(this\.store, \{[^}]*skipFlush: true/s.test(clearCache),
    'clearCache must not kick off immediate background compaction')
})

test('clearCache schedules compaction and re-checks playback before compacting', async (t) => {
  const timers = []
  let playbackActive = false
  const store = createStore()
  const manager = new SeedingManager(store, createMetaDb(), {
    isCacheClearBlocked: () => playbackActive,
    storageMaintenanceDelayMs: 0,
    setTimer(fn, delay) {
      const timer = { fn, delay, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer(timer) {
      timer.cleared = true
    }
  })

  await manager.addSeed('drive-a', 'videos/watched.mp4', 'watched', {
    byteLength: 2 * GB,
    blobId: '3:5:0:1234',
    blobsCoreKey: coreA
  })

  await manager.clearCache()

  t.is(store.storage.flushCalls, 1, 'cleared ranges are flushed before the RPC returns')
  t.is(store.storage.compactCalls, 0, 'compaction does not start immediately')
  t.is(timers.length, 1, 'compaction is scheduled for idle maintenance')

  playbackActive = true
  await timers.shift().fn()
  t.is(store.storage.compactCalls, 0, 'scheduled compaction respects resumed playback')
  t.is(timers.length, 1, 'blocked compaction is rescheduled')

  playbackActive = false
  await timers.shift().fn()
  t.is(store.storage.compactCalls, 1, 'compaction runs after playback is idle')
})

test('clearCache cancels live prefetch downloads before clearing blocks', (t) => {
  // Clearing blocks under an active linear fill immediately re-downloads
  // them; the clear/download race thrashes storage and the cache never
  // actually shrinks.
  const clearCacheStart = apiSource.indexOf('async clearCache(')
  const cleanupStart = apiSource.indexOf('async function cleanupRangeRequest(')
  t.ok(clearCacheStart !== -1, 'expected api.clearCache')
  t.ok(cleanupStart !== -1, 'expected shared active-range cleanup')
  const clearCache = apiSource.slice(clearCacheStart, clearCacheStart + 1600)
  const cleanupRangeRequest = apiSource.slice(cleanupStart, cleanupStart + 1800)

  t.ok(/activeRangeRequests\.keys\(\)/.test(clearCache), 'clearCache iterates active prefetch sessions')
  t.ok(/cleanupRangeRequest\(key\)/.test(clearCache), 'clearCache uses the shared cancellation path')
  t.ok(/request\.cancel\?\.\(\)|request\.cancel\(\)/.test(cleanupRangeRequest), 'active range cleanup cancels the download')
  t.ok(/request\.release\?\.\(\)/.test(cleanupRangeRequest), 'active range cleanup releases quota and blob guards')
  t.ok(clearCache.indexOf('cleanupRangeRequest') < clearCache.indexOf('seedingManager.clearCache'),
    'downloads are cancelled before seed blocks are cleared')
})
