import EventEmitter from 'node:events'

import b4a from 'b4a'
import test from 'brittle'

import { createApi } from '../src/api.js'
import { SeedingManager } from '../src/seeding.js'

function createMetaDb(seed = {}) {
  const state = new Map(Object.entries(seed))
  return {
    state,
    async get(key) {
      return state.has(key) ? { value: state.get(key) } : null
    },
    async put(key, value) {
      state.set(key, value)
    },
    async del(key) {
      state.delete(key)
    },
    createReadStream({ gte, lt } = {}) {
      const entries = Array.from(state.entries())
        .filter(([key]) => (!gte || key >= gte) && (!lt || key < lt))
        .map(([key, value]) => ({ key, value }))

      return {
        async *[Symbol.asyncIterator]() {
          yield * entries
        }
      }
    }
  }
}

function createStore() {
  const cores = new Map()
  return {
    cores,
    closed: false,
    storage: {
      flushCalls: 0,
      compactCalls: 0,
      async flush() {
        this.flushCalls += 1
      },
      async compact() {
        this.compactCalls += 1
      }
    },
    get(input) {
      const key = b4a.isBuffer(input)
        ? b4a.toString(input, 'hex')
        : b4a.isBuffer(input?.key)
          ? b4a.toString(input.key, 'hex')
          : String(input)

      if (!cores.has(key)) cores.set(key, new FakeCore(key))
      return cores.get(key)
    }
  }
}

class FakeCore extends EventEmitter {
  constructor(key) {
    super()
    this.key = key
    this.peers = []
    this.clearCalls = []
    this.downloadCalls = []
    this.destroyedRanges = 0
  }

  async ready() {}

  async has() {
    return false
  }

  async clear(start, end) {
    this.clearCalls.push({ start, end })
  }

  download(range) {
    this.downloadCalls.push(range)
    return {
      destroy: () => {
        this.destroyedRanges += 1
      },
      done: () => new Promise(() => {})
    }
  }
}

const GB = 1024 * 1024 * 1024
const coreA = 'aa'.repeat(32)

test('clearCache clears persisted partial download intents as cache bytes', async (t) => {
  const metaDb = createMetaDb({
    [`download-intent:drive-a:videos/partial.mp4`]: {
      driveKey: 'drive-a',
      videoPath: 'videos/partial.mp4',
      blobsCoreKey: coreA,
      blobId: '5:4:0:2048',
      startBlock: 5,
      endBlock: 9,
      totalBlocks: 4,
      totalBytes: 2 * GB,
      mimeType: 'video/mp4',
      startedAt: 1
    }
  })
  const store = createStore()
  store.get(b4a.from(coreA, 'hex'))
  const seedingManager = new SeedingManager(store, metaDb)
  const api = createApi({ ctx: { store, metaDb }, seedingManager })

  const result = await api.clearCache()

  t.is(result.success, true)
  t.is(result.clearedBytes, 2 * GB)
  t.alike(store.cores.get(coreA).clearCalls, [{ start: 5, end: 9 }])
  t.is(store.storage.flushCalls, 1)
  t.is(store.storage.compactCalls, 1)
  t.absent(metaDb.state.has('download-intent:drive-a:videos/partial.mp4'))
})

test('setStorageLimit preserves partial download intents when the limit is unchanged or raised', async (t) => {
  const metaDb = createMetaDb({
    [`download-intent:drive-a:videos/stale.mp4`]: {
      driveKey: 'drive-a',
      videoPath: 'videos/stale.mp4',
      blobsCoreKey: coreA,
      blobId: '10:3:0:4096',
      startBlock: 10,
      endBlock: 13,
      totalBlocks: 3,
      totalBytes: 3 * GB,
      mimeType: 'video/mp4',
      startedAt: 1
    }
  })
  const store = createStore()
  store.get(b4a.from(coreA, 'hex'))
  const seedingManager = new SeedingManager(store, metaDb)
  const api = createApi({ ctx: { store, metaDb }, seedingManager })

  const result = await api.setStorageLimit(5)
  const raised = await api.setStorageLimit(10)

  t.is(result.success, true)
  t.is(raised.success, true)
  t.alike(store.cores.get(coreA).clearCalls, [])
  t.ok(metaDb.state.has('download-intent:drive-a:videos/stale.mp4'))
})

test('setStorageLimit clears partial download intents when lowering the limit', async (t) => {
  const metaDb = createMetaDb({
    [`download-intent:drive-a:videos/stale.mp4`]: {
      driveKey: 'drive-a',
      videoPath: 'videos/stale.mp4',
      blobsCoreKey: coreA,
      blobId: '10:3:0:4096',
      startBlock: 10,
      endBlock: 13,
      totalBlocks: 3,
      totalBytes: 3 * GB,
      mimeType: 'video/mp4',
      startedAt: 1
    }
  })
  const store = createStore()
  store.get(b4a.from(coreA, 'hex'))
  const seedingManager = new SeedingManager(store, metaDb)
  const api = createApi({ ctx: { store, metaDb }, seedingManager })

  await api.setStorageLimit(10)
  const lowered = await api.setStorageLimit(5)

  t.is(lowered.success, true)
  t.alike(store.cores.get(coreA).clearCalls, [{ start: 10, end: 13 }])
  t.absent(metaDb.state.has('download-intent:drive-a:videos/stale.mp4'))
})

test('setStorageLimit clears stale partial bytes before evicting valid seeds on lower limit', async (t) => {
  const intentKey = `download-intent:drive-a:videos/stale.mp4`
  const metaDb = createMetaDb({
    [intentKey]: {
      driveKey: 'drive-a',
      videoPath: 'videos/stale.mp4',
      blobsCoreKey: coreA,
      blobId: '10:3:0:4096',
      startBlock: 10,
      endBlock: 13,
      totalBlocks: 3,
      totalBytes: 2 * GB,
      mimeType: 'video/mp4',
      startedAt: 1
    }
  })
  const store = createStore()
  store.get(b4a.from(coreA, 'hex'))
  const seedingManager = new SeedingManager(store, metaDb, {
    getDiskUsageBytes: () => metaDb.state.has(intentKey) ? 6 * GB : 4 * GB
  })
  const api = createApi({ ctx: { store, metaDb }, seedingManager })

  await api.setStorageLimit(10)
  await seedingManager.addSeed('drive-a', 'videos/valid.mp4', 'watched', {
    byteLength: 4 * GB,
    blobId: '20:4:0:4096',
    blobsCoreKey: coreA
  })
  const lowered = await api.setStorageLimit(5)

  t.is(lowered.success, true)
  t.absent(metaDb.state.has(intentKey))
  t.is(seedingManager.getActiveSeeds().length, 1)
  t.is(seedingManager.getActiveSeeds()[0]?.videoPath, 'videos/valid.mp4')
  t.is(seedingManager.getStorageStatsSync().usedBytes, 4 * GB)
})

test('prefetchVideo registers in-flight downloads with quota tracking before completion', async (t) => {
  const metaDb = createMetaDb()
  const store = createStore()
  const seedingManager = new SeedingManager(store, metaDb)
  await seedingManager.init()
  const api = createApi({ ctx: { store, metaDb, swarm: null }, seedingManager })

  api.getVideoData = async () => ({
    id: 'partial',
    path: 'videos/partial.mp4',
    blobId: '0:8:0:1048576',
    blobsCoreKey: coreA,
    byteLength: 1024 * 1024,
    publicBeeKey: 'bb'.repeat(32),
    mimeType: 'video/mp4'
  })

  const prefetch = api.prefetchVideo('drive-a', 'videos/partial.mp4')
  await new Promise((resolve) => setImmediate(resolve))

  const core = store.cores.get(coreA)
  core.emit('download', 0, 65536)

  const result = await prefetch

  t.is(result.success, true)
  t.is(result.message, 'Prefetch started')
  const seeds = seedingManager.getActiveSeeds()
  t.is(seeds.length, 1)
  t.is(seeds[0]?.videoPath, 'videos/partial.mp4')
  t.is(seedingManager.getStorageStatsSync().usedBytes, 65536)
})

test('prefetchVideo does not reserve the full blob size before bytes are cached', async (t) => {
  const metaDb = createMetaDb()
  const store = createStore()
  const seedingManager = new SeedingManager(store, metaDb)
  await seedingManager.init()
  const api = createApi({ ctx: { store, metaDb, swarm: null }, seedingManager })

  api.getVideoData = async () => ({
    id: 'huge-partial',
    path: 'videos/huge-partial.mp4',
    blobId: '0:8:0:8589934592',
    blobsCoreKey: coreA,
    byteLength: 8 * GB,
    publicBeeKey: 'bb'.repeat(32),
    mimeType: 'video/mp4'
  })

  const result = await api.prefetchVideo('drive-a', 'videos/huge-partial.mp4')

  t.is(result.success, true)
  const seeds = seedingManager.getActiveSeeds()
  t.is(seeds.length, 1)
  t.is(seeds[0]?.bytes, 0)
  t.is(seedingManager.getStorageStatsSync().usedBytes, 0)
})

test('prefetchVideo corrects stale full-size watched seed accounting downward', async (t) => {
  const metaDb = createMetaDb()
  const store = createStore()
  const seedingManager = new SeedingManager(store, metaDb)
  await seedingManager.init()
  await seedingManager.addSeed('drive-a', 'videos/stale-huge.mp4', 'watched', {
    blockLength: 8,
    byteLength: 8 * GB,
    blobId: '0:8:0:8589934592',
    blobsCoreKey: coreA
  }, { protectSelf: true })
  const api = createApi({ ctx: { store, metaDb, swarm: null }, seedingManager })

  api.getVideoData = async () => ({
    id: 'stale-huge',
    path: 'videos/stale-huge.mp4',
    blobId: '0:8:0:8589934592',
    blobsCoreKey: coreA,
    byteLength: 8 * GB,
    publicBeeKey: 'bb'.repeat(32),
    mimeType: 'video/mp4'
  })

  t.is(seedingManager.getStorageStatsSync().usedBytes, 8 * GB)
  const result = await api.prefetchVideo('drive-a', 'videos/stale-huge.mp4')

  t.is(result.success, true)
  const seeds = seedingManager.getActiveSeeds()
  t.is(seeds.length, 1)
  t.is(seeds[0]?.bytes, 0)
  t.is(seedingManager.getStorageStatsSync().usedBytes, 0)
})

test('prefetchVideo cleans up core listeners when blob is already fully cached', async (t) => {
  const metaDb = createMetaDb()
  const store = createStore()
  const api = createApi({ ctx: { store, metaDb, swarm: null } })
  const core = store.get(b4a.from(coreA, 'hex'))
  core.has = async () => true

  api.getVideoData = async () => ({
    id: 'cached',
    path: 'videos/cached.mp4',
    blobId: '0:8:0:1048576',
    blobsCoreKey: coreA,
    byteLength: 1024 * 1024,
    mimeType: 'video/mp4'
  })

  const result = await api.prefetchVideo('drive-a', 'videos/cached.mp4')

  t.is(result.success, true)
  t.is(result.cached, true)
  t.is(core.listenerCount('download'), 0)
  t.is(core.listenerCount('upload'), 0)
})

test('addSeed updates existing cache entries with resolved blob bytes', async (t) => {
  const store = createStore()
  const manager = new SeedingManager(store, createMetaDb())

  await manager.addSeed('drive-a', 'videos/partial.mp4', 'watched', {
    byteLength: 0,
    blobId: null,
    blobsCoreKey: null
  })

  await manager.addSeed('drive-a', 'videos/partial.mp4', 'watched', {
    blockLength: 8,
    byteLength: 1024 * 1024,
    blobId: '0:8:0:1048576',
    blobsCoreKey: coreA,
    mimeType: 'video/mp4'
  }, { protectSelf: true })

  const [seed] = manager.getActiveSeeds()
  t.is(seed.bytes, 1024 * 1024)
  t.is(seed.blocks, 8)
  t.is(seed.blobId, '0:8:0:1048576')
  t.is(seed.blobsCoreKey, coreA)
  t.is(manager.getStorageStatsSync().usedBytes, 1024 * 1024)
})

test('addSeed does not downgrade existing pinned cache entries', async (t) => {
  const manager = new SeedingManager(createStore(), createMetaDb())

  await manager.addSeed('drive-a', 'videos/pinned.mp4', 'pinned', {
    byteLength: 1024,
    blobId: '0:1:0:1024',
    blobsCoreKey: coreA
  })

  await manager.addSeed('drive-a', 'videos/pinned.mp4', 'watched', {
    byteLength: 2048,
    blobId: '0:2:0:2048',
    blobsCoreKey: coreA
  })

  const [seed] = manager.getActiveSeeds()
  t.is(seed.reason, 'pinned')
  t.is(seed.bytes, 2048)
})
