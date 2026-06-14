import test from 'brittle'
import { SeedingManager } from '../src/seeding.js'

function createMetaDb(seed = {}) {
  const state = new Map(Object.entries(seed))
  return {
    state,
    puts: [],
    async get(key) {
      return state.has(key) ? { value: state.get(key) } : null
    },
    async put(key, value) {
      this.puts.push([key, value])
      state.set(key, value)
    }
  }
}

function createStore({ diskUsageBytes = 0, compactedDiskUsageBytes = null, clearDiskUsageBytes = 0 } = {}) {
  const state = { diskUsageBytes }
  const cores = new Map()
  return {
    _peartubeStoragePath: '/tmp/peartube-test-storage',
    storage: {
      flushCalls: 0,
      compactCalls: 0,
      async flush() {
        this.flushCalls += 1
      },
      async compact() {
        this.compactCalls += 1
        if (compactedDiskUsageBytes !== null) state.diskUsageBytes = compactedDiskUsageBytes
      }
    },
    async getDiskUsageBytes() {
      return state.diskUsageBytes
    },
    get(key) {
      const keyHex = Buffer.isBuffer(key) ? key.toString('hex') : String(key)
      if (!cores.has(keyHex)) {
        cores.set(keyHex, {
          clearCalls: [],
          async ready() {},
          async clear(start, end) {
            this.clearCalls.push({ start, end })
            state.diskUsageBytes = Math.max(0, state.diskUsageBytes - clearDiskUsageBytes)
          }
        })
      }
      return cores.get(keyHex)
    }
  }
}

const GB = 1024 * 1024 * 1024
const coreA = 'aa'.repeat(32)
const coreB = 'bb'.repeat(32)

test('storage stats include actual app P2P disk usage separately from tracked cache quota', async (t) => {
  const manager = new SeedingManager(createStore({ diskUsageBytes: 10 * GB }), createMetaDb())
  await manager.setConfig({ maxStorageGB: 20 })

  await manager.addSeed('drive-a', 'videos/watched.mp4', 'watched', {
    byteLength: Math.round(4.92 * GB),
    blobId: '10:4:0:4096',
    blobsCoreKey: coreA
  })

  const stats = await manager.getStorageStats()

  t.is(stats.usedBytes, Math.round(4.92 * GB))
  t.is(stats.usedGB, '4.92')
  t.is(stats.totalStorageBytes, 10 * GB)
  t.is(stats.totalStorageGB, '10.00')
  t.is(stats.untrackedStorageBytes, 10 * GB - Math.round(4.92 * GB))
  t.is(stats.untrackedStorageGB, '5.08')
})

test('clearCache reports app P2P disk usage after clearing tracked non-pinned cache', async (t) => {
  const store = createStore({ diskUsageBytes: 6 * GB })
  const manager = new SeedingManager(store, createMetaDb())
  await manager.setConfig({ maxStorageGB: 20 })

  await manager.addSeed('drive-a', 'videos/watched.mp4', 'watched', {
    byteLength: 2 * GB,
    blobId: '3:5:0:1234',
    blobsCoreKey: coreA
  })
  await manager.addSeed('drive-pinned', 'videos/pinned.mp4', 'pinned', {
    byteLength: 3 * GB,
    blobId: '8:2:0:2048',
    blobsCoreKey: coreB
  })

  const cleared = await manager.clearCache()

  t.is(cleared.clearedBytes, 2 * GB)
  t.is(cleared.totalStorageBytes, 6 * GB)
  t.is(cleared.untrackedStorageBytes, 3 * GB)
})

test('clearCache compacts Corestore before measuring app P2P disk usage', async (t) => {
  const store = createStore({
    diskUsageBytes: 6 * GB,
    compactedDiskUsageBytes: 4 * GB
  })
  const manager = new SeedingManager(store, createMetaDb())
  await manager.setConfig({ maxStorageGB: 20 })

  await manager.addSeed('drive-a', 'videos/watched.mp4', 'watched', {
    byteLength: 2 * GB,
    blobId: '3:5:0:1234',
    blobsCoreKey: coreA
  })
  await manager.addSeed('drive-pinned', 'videos/pinned.mp4', 'pinned', {
    byteLength: 3 * GB,
    blobId: '8:2:0:2048',
    blobsCoreKey: coreB
  })

  const cleared = await manager.clearCache()

  t.is(store.storage.flushCalls, 1)
  t.is(store.storage.compactCalls, 1)
  t.is(cleared.clearedBytes, 2 * GB)
  t.is(cleared.totalStorageBytes, 4 * GB)
  t.is(cleared.untrackedStorageBytes, 1 * GB)
})

test('quota enforcement evicts tracked cache once the cached bytes exceed the limit', async (t) => {
  const store = createStore({ diskUsageBytes: 10 * GB, clearDiskUsageBytes: 4 * GB })
  const manager = new SeedingManager(store, createMetaDb())
  await manager.setConfig({ maxStorageGB: 20 })

  await manager.addSeed('drive-a', 'videos/watched.mp4', 'watched', {
    byteLength: 6 * GB,
    blobId: '3:5:0:1234',
    blobsCoreKey: coreA
  })

  // 6 GB of network cache exceeds the new 5 GB limit, so it is evicted.
  await manager.setMaxStorageGB(5)

  t.is(manager.getStorageStatsSync().usedBytes, 0)
  t.is(manager.getActiveSeeds().length, 0)
  t.alike(store.get(Buffer.from(coreA, 'hex')).clearCalls, [{ start: 3, end: 8 }])
  t.is(store.storage.flushCalls, 1)
  t.is(store.storage.compactCalls, 1)
})

test('quota enforcement leaves cache intact when only the user\'s uploads exceed the limit', async (t) => {
  // 10 GB on disk is dominated by the user's own uploaded videos (never tracked
  // as seeds); only 4 GB is cached from the network. Lowering the limit to 5 GB
  // must NOT evict that cache — uploads do not count against the cache quota.
  const store = createStore({ diskUsageBytes: 10 * GB, clearDiskUsageBytes: 4 * GB })
  const manager = new SeedingManager(store, createMetaDb())
  await manager.setConfig({ maxStorageGB: 20 })

  await manager.addSeed('drive-a', 'videos/watched.mp4', 'watched', {
    byteLength: 4 * GB,
    blobId: '3:5:0:1234',
    blobsCoreKey: coreA
  })

  await manager.setMaxStorageGB(5)

  t.is(manager.getStorageStatsSync().usedBytes, 4 * GB, 'tracked cache is untouched')
  t.is(manager.getActiveSeeds().length, 1)
  t.alike(store.get(Buffer.from(coreA, 'hex')).clearCalls, [], 'no blob ranges cleared')
})
