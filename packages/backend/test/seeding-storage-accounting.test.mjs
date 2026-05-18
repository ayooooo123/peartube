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

function createStore({ diskUsageBytes = 0 } = {}) {
  return {
    _peartubeStoragePath: '/tmp/peartube-test-storage',
    async getDiskUsageBytes() {
      return diskUsageBytes
    },
    get() {
      return {
        async ready() {},
        async clear() {}
      }
    }
  }
}

const GB = 1024 * 1024 * 1024
const coreA = 'aa'.repeat(32)
const coreB = 'bb'.repeat(32)

test('storage stats include actual app P2P disk usage separately from tracked cache quota', async (t) => {
  const manager = new SeedingManager(createStore({ diskUsageBytes: 10 * GB }), createMetaDb())

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
