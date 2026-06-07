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

function createStore() {
  const cores = new Map()
  const calls = []
  return {
    cores,
    calls,
    get(key) {
      const keyHex = Buffer.isBuffer(key) ? key.toString('hex') : String(key)
      if (!cores.has(keyHex)) {
        cores.set(keyHex, {
          keyHex,
          clearCalls: [],
          async ready() {},
          async clear(start, end) {
            this.clearCalls.push({ start, end })
            calls.push({ keyHex, start, end })
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
const coreC = 'cc'.repeat(32)

test('setMaxStorageGB enforces quota and clears removed cached blob ranges', async (t) => {
  const store = createStore()
  const metaDb = createMetaDb()
  const manager = new SeedingManager(store, metaDb)

  await manager.addSeed('drive-a', 'videos/old.mp4', 'watched', {
    byteLength: 4 * GB,
    blobId: '10:4:0:4096',
    blobsCoreKey: coreA
  })
  await manager.addSeed('drive-b', 'videos/new.mp4', 'watched', {
    byteLength: 4 * GB,
    blobId: '20:4:0:4096',
    blobsCoreKey: coreB
  })

  await manager.setMaxStorageGB(10)
  store.calls.length = 0
  for (const core of store.cores.values()) core.clearCalls.length = 0
  manager.activeSeeds.set('drive-a:videos/old.mp4', {
    driveKey: 'drive-a',
    videoPath: 'videos/old.mp4',
    reason: 'watched',
    addedAt: 1,
    blocks: 4,
    bytes: 4 * GB,
    blobId: '10:4:0:4096',
    blobsCoreKey: coreA
  })
  manager.activeSeeds.set('drive-b:videos/new.mp4', {
    driveKey: 'drive-b',
    videoPath: 'videos/new.mp4',
    reason: 'watched',
    addedAt: 2,
    blocks: 4,
    bytes: 4 * GB,
    blobId: '20:4:0:4096',
    blobsCoreKey: coreB
  })
  await manager.persistSeeds()
  t.is(manager.getStorageStatsSync().usedBytes, 8 * GB)

  await manager.setMaxStorageGB(5)

  t.is(manager.getStorageStatsSync().usedBytes, 4 * GB)
  t.is(manager.getActiveSeeds().length, 1)
  t.is(manager.getActiveSeeds()[0].videoPath, 'videos/new.mp4')
  t.alike(store.cores.get(coreA).clearCalls, [{ start: 10, end: 14 }])
  t.absent(store.cores.get(coreB)?.clearCalls?.length)

  const persistedSeeds = metaDb.state.get('active-seeds')
  t.is(Object.keys(persistedSeeds).length, 1)
  t.ok(persistedSeeds['drive-b:videos/new.mp4'])
})

test('protectSelf keeps the current watched seed through quota enforcement', async (t) => {
  const store = createStore()
  const manager = new SeedingManager(store, createMetaDb())

  await manager.setMaxStorageGB(5)
  await manager.addSeed('drive-a', 'videos/large.mp4', 'watched', {
    byteLength: 1 * GB,
    blobId: '30:1:0:1024',
    blobsCoreKey: coreA
  }, { protectSelf: true })
  await manager.addSeed('drive-a', 'videos/large.mp4', 'watched', {
    byteLength: 6 * GB,
    blobId: '30:6:0:6144',
    blobsCoreKey: coreA
  }, { protectSelf: true })

  t.is(manager.getStorageStatsSync().usedBytes, 6 * GB)
  t.is(manager.getActiveSeeds().length, 1)
  t.is(manager.getActiveSeeds()[0].videoPath, 'videos/large.mp4')
  t.alike(store.cores.get(coreA)?.clearCalls || [], [])
})

test('quota enforcement skips retained in-flight blob cores', async (t) => {
  const store = createStore()
  const metaDb = createMetaDb()
  const manager = new SeedingManager(store, metaDb)

  await manager.setMaxStorageGB(10)
  manager.activeSeeds.set('drive-a:videos/in-flight.mp4', {
    driveKey: 'drive-a',
    videoPath: 'videos/in-flight.mp4',
    reason: 'watched',
    addedAt: 1,
    blocks: 4,
    bytes: 4 * GB,
    blobId: '10:4:0:4096',
    blobsCoreKey: coreA
  })
  manager.activeSeeds.set('drive-b:videos/evictable.mp4', {
    driveKey: 'drive-b',
    videoPath: 'videos/evictable.mp4',
    reason: 'watched',
    addedAt: 2,
    blocks: 4,
    bytes: 4 * GB,
    blobId: '20:4:0:4096',
    blobsCoreKey: coreB
  })
  await manager.persistSeeds()

  const release = manager.retainBlobRef({ blobId: '10:4:0:4096', blobsCoreKey: coreA })
  await manager.setMaxStorageGB(5)

  t.is(manager.getActiveSeeds().length, 1)
  t.is(manager.getActiveSeeds()[0].videoPath, 'videos/in-flight.mp4')
  t.alike(store.cores.get(coreA)?.clearCalls || [], [])
  t.alike(store.cores.get(coreB).clearCalls, [{ start: 20, end: 24 }])

  release()
  t.absent(manager.isSeedBlobProtected({ blobId: '10:4:0:4096', blobsCoreKey: coreA }))
})

test('quota enforcement defers clears while playback is active', async (t) => {
  const store = createStore()
  const metaDb = createMetaDb()
  let playbackActive = true
  const manager = new SeedingManager(store, metaDb, {
    isCacheClearBlocked: () => playbackActive
  })

  await manager.setMaxStorageGB(10)
  manager.activeSeeds.set('drive-a:videos/old.mp4', {
    driveKey: 'drive-a',
    videoPath: 'videos/old.mp4',
    reason: 'watched',
    addedAt: 1,
    blocks: 4,
    bytes: 4 * GB,
    blobId: '10:4:0:4096',
    blobsCoreKey: coreA
  })
  manager.activeSeeds.set('drive-b:videos/new.mp4', {
    driveKey: 'drive-b',
    videoPath: 'videos/new.mp4',
    reason: 'watched',
    addedAt: 2,
    blocks: 4,
    bytes: 4 * GB,
    blobId: '20:4:0:4096',
    blobsCoreKey: coreB
  })
  await manager.persistSeeds()

  await manager.setMaxStorageGB(5)

  t.is(manager.getActiveSeeds().length, 2)
  t.is(store.calls.length, 0)

  playbackActive = false
  await manager.enforceQuota()

  t.is(manager.getActiveSeeds().length, 1)
  t.is(manager.getActiveSeeds()[0].videoPath, 'videos/new.mp4')
  t.alike(store.cores.get(coreA).clearCalls, [{ start: 10, end: 14 }])
})

test('clearCache clears non-pinned blob ranges and keeps pinned cached bytes', async (t) => {
  const store = createStore()
  const metaDb = createMetaDb()
  const manager = new SeedingManager(store, metaDb)

  await manager.addSeed('drive-a', 'videos/watched.mp4', 'watched', {
    byteLength: 2 * GB,
    blobId: { blockOffset: 3, blockLength: 5, byteOffset: 0, byteLength: 1234 },
    blobsCoreKey: coreA
  })
  await manager.addSeed('drive-pinned', 'videos/pinned.mp4', 'pinned', {
    byteLength: 3 * GB,
    blobId: '8:2:0:2048',
    blobsCoreKey: coreC
  })

  const clearResult = await manager.clearCache()

  t.is(clearResult.clearedBytes, 2 * GB)
  t.is(manager.getStorageStatsSync().usedBytes, 3 * GB)
  t.is(manager.getActiveSeeds().length, 1)
  t.is(manager.getActiveSeeds()[0].reason, 'pinned')
  t.alike(store.cores.get(coreA).clearCalls, [{ start: 3, end: 8 }])
  t.absent(store.cores.get(coreC)?.clearCalls?.length)
})

test('quota enforcement ignores invalid blob refs but still updates seed accounting', async (t) => {
  const store = createStore()
  const manager = new SeedingManager(store, createMetaDb())

  await manager.addSeed('drive-a', 'videos/bad-ref.mp4', 'watched', {
    byteLength: 6 * GB,
    blobId: 'not-a-range',
    blobsCoreKey: coreA
  })

  await manager.setMaxStorageGB(5)

  t.is(manager.getStorageStatsSync().usedBytes, 0)
  t.is(manager.getActiveSeeds().length, 0)
  t.is(store.calls.length, 0)
})
