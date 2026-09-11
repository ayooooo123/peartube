import test from 'brittle'

import { collectCorestoreGarbage } from '../src/corestore-gc.js'
import { SeedingManager } from '../src/seeding.js'


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
  await manager.applyNetworkPolicy({ contributeWatchedMedia: true, contributionBudgetBytes: 20 * GB, migrationRequired: false })
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
