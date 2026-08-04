import EventEmitter from 'node:events'

import b4a from 'b4a'
import test from 'brittle'

// Collapse the post-playback eviction debounce so the timing assertions below
// run fast and deterministically.
process.env.PEARTUBE_QUOTA_SWEEP_DELAY_MS = '20'

import { createApi } from '../src/api.js'
import { SeedingManager } from '../src/seeding.js'
import { isPlaybackActive } from '../src/storage.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Poll until a condition holds (the post-playback sweep is async + debounced),
// or give up after a bounded wait.
async function waitUntil(fn) {
  for (let i = 0; i < 80 && !fn(); i += 1) {
    await delay(25)
  }
}

function createMetaDb(seed = {}) {
  const state = new Map(Object.entries(seed))
  // Download intents now live in the `download-intent` metaDb subspace. This
  // fake keeps the flat `download-intent:<sub>` storage (so the seed format and
  // `state.has(...)` assertions are unchanged) while exposing the subspace
  // accessor the production code uses — its keys are the prefix-stripped form.
  const DI_PREFIX = 'download-intent:'
  const subspaces = {
    downloadIntents: {
      async get(key) {
        return state.has(DI_PREFIX + key) ? { value: state.get(DI_PREFIX + key) } : null
      },
      async put(key, value) {
        state.set(DI_PREFIX + key, value)
      },
      async del(key) {
        state.delete(DI_PREFIX + key)
      },
      createReadStream() {
        const entries = Array.from(state.entries())
          .filter(([key]) => key.startsWith(DI_PREFIX))
          .map(([key, value]) => ({ key: key.slice(DI_PREFIX.length), value }))
        return {
          async *[Symbol.asyncIterator]() {
            yield * entries
          }
        }
      }
    }
  }
  return {
    state,
    subspaces,
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

function createTimerOptions(timers) {
  return {
    storageMaintenanceDelayMs: 0,
    setTimer(fn, delay) {
      const timer = { fn, delay, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer(timer) {
      timer.cleared = true
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
const coreB = 'bb'.repeat(32)

test('clearCache clears persisted partial download intents as cache bytes', async (t) => {
  const timers = []
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
  const seedingManager = new SeedingManager(store, metaDb, { ...createTimerOptions(timers), metaSubspaces: metaDb.subspaces })
  const api = createApi({ ctx: { store, metaDb, metaSubspaces: metaDb.subspaces }, seedingManager })

  const result = await api.clearCache()

  t.is(result.success, true)
  t.is(result.clearedBytes, 2 * GB)
  t.alike(store.cores.get(coreA).clearCalls, [{ start: 5, end: 9 }])
  t.is(store.storage.flushCalls, 1)
  t.is(store.storage.compactCalls, 0)
  t.is(timers.length, 1)

  await timers.shift().fn()
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
  const seedingManager = new SeedingManager(store, metaDb, { metaSubspaces: metaDb.subspaces })
  const api = createApi({ ctx: { store, metaDb, metaSubspaces: metaDb.subspaces }, seedingManager })

  // Start from whatever quota the participation policy ships, so this asserts
  // "unchanged, then raised" rather than a particular default.
  const baseline = seedingManager.config.maxStorageGB
  const result = await api.setStorageLimit(baseline)
  const raised = await api.setStorageLimit(baseline + 5)

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
  const seedingManager = new SeedingManager(store, metaDb, { metaSubspaces: metaDb.subspaces })
  const api = createApi({ ctx: { store, metaDb, metaSubspaces: metaDb.subspaces }, seedingManager })

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
    metaSubspaces: metaDb.subspaces,
    getDiskUsageBytes: () => metaDb.state.has(intentKey) ? 6 * GB : 4 * GB
  })
  const api = createApi({ ctx: { store, metaDb, metaSubspaces: metaDb.subspaces }, seedingManager })

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
  const seedingManager = new SeedingManager(store, metaDb, { metaSubspaces: metaDb.subspaces })
  await seedingManager.init()
  const api = createApi({ ctx: { store, metaDb, metaSubspaces: metaDb.subspaces, swarm: null }, seedingManager })

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
  const seedingManager = new SeedingManager(store, metaDb, { metaSubspaces: metaDb.subspaces })
  await seedingManager.init()
  const api = createApi({ ctx: { store, metaDb, metaSubspaces: metaDb.subspaces, swarm: null }, seedingManager })

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

test('concurrent prefetches reserve quota before either download completes', async (t) => {
  const metaDb = createMetaDb()
  const store = createStore()
  const seedingManager = new SeedingManager(store, metaDb, { metaSubspaces: metaDb.subspaces })
  await seedingManager.init()
  await seedingManager.setMaxStorageGB(5)
  const api = createApi({ ctx: { store, metaDb, metaSubspaces: metaDb.subspaces, swarm: null }, seedingManager })

  api.getVideoData = async (_driveKey, videoPath) => ({
    id: videoPath,
    path: videoPath,
    blobId: '0:8:0:3221225472',
    blobsCoreKey: videoPath.includes('first') ? coreA : coreB,
    byteLength: 3 * GB,
    mimeType: 'video/mp4'
  })

  const results = await Promise.all([
    api.prefetchVideo('drive-a', 'videos/first.mp4'),
    api.prefetchVideo('drive-b', 'videos/second.mp4')
  ])

  t.is(results.filter(result => result.message === 'Prefetch started').length, 1)
  t.is(results.filter(result => result.message === 'Streaming within storage quota').length, 1)
})

test('setStorageLimit reports infeasible reductions without mutating the configured limit', async (t) => {
  const metaDb = createMetaDb()
  const store = createStore()
  const seed = {
    driveKey: 'drive-protected',
    videoPath: 'videos/protected.mp4',
    reason: 'pinned',
    bytes: 6 * GB,
    blobId: '0:6:0:6144',
    blobsCoreKey: 'ac'.repeat(32),
    addedAt: 1,
    lastAccessedAt: 1,
  }
  metaDb.state.set('active-seeds', { [`${seed.driveKey}:${seed.videoPath}`]: seed })
  const seedingManager = new SeedingManager(store, metaDb, { metaSubspaces: metaDb.subspaces })
  await seedingManager.init()
  await seedingManager.setMaxStorageGB(10, { authorized: true })
  const api = createApi({ ctx: { store, metaDb, metaSubspaces: metaDb.subspaces }, seedingManager })

  const result = await api.setStorageLimit(5)

  t.is(result.success, false)
  t.is(result.errorCode, 'STORAGE_LIMIT_INFEASIBLE')
  t.is(seedingManager.getMaxStorageGB(), 10)
})

test('lowering the storage limit cancels active prefetches before clearing their ranges', async (t) => {
  const metaDb = createMetaDb()
  const store = createStore()
  const seedingManager = new SeedingManager(store, metaDb, { metaSubspaces: metaDb.subspaces })
  await seedingManager.init()
  await seedingManager.setMaxStorageGB(5)
  const api = createApi({ ctx: { store, metaDb, metaSubspaces: metaDb.subspaces, swarm: null }, seedingManager })

  api.getVideoData = async () => ({
    id: 'active',
    path: 'videos/active.mp4',
    blobId: '0:8:0:4294967296',
    blobsCoreKey: coreA,
    byteLength: 4 * GB,
    mimeType: 'video/mp4'
  })

  const prefetch = await api.prefetchVideo('drive-a', 'videos/active.mp4')
  t.is(prefetch.message, 'Prefetch started')

  const lowered = await api.setStorageLimit(1)

  t.is(lowered.success, true)
  t.is(store.cores.get(coreA).destroyedRanges, 1)
  t.alike(store.cores.get(coreA).clearCalls, [{ start: 0, end: 8 }])
})

test('prefetchVideo corrects stale full-size watched seed accounting downward', async (t) => {
  const metaDb = createMetaDb()
  const store = createStore()
  const seedingManager = new SeedingManager(store, metaDb, { metaSubspaces: metaDb.subspaces })
  await seedingManager.init()
  await seedingManager.addSeed('drive-a', 'videos/stale-huge.mp4', 'watched', {
    blockLength: 8,
    byteLength: 8 * GB,
    blobId: '0:8:0:8589934592',
    blobsCoreKey: coreA
  }, { protectSelf: true })
  const api = createApi({ ctx: { store, metaDb, metaSubspaces: metaDb.subspaces, swarm: null }, seedingManager })

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

test('prefetchVideo quota enforcement preserves active range downloads', async (t) => {
  const metaDb = createMetaDb()
  const store = createStore()
  const seedingManager = new SeedingManager(store, metaDb, { metaSubspaces: metaDb.subspaces })
  await seedingManager.init()
  await seedingManager.setMaxStorageGB(5)
  const api = createApi({ ctx: { store, metaDb, metaSubspaces: metaDb.subspaces, swarm: null }, seedingManager })

  api.getVideoData = async (_driveKey, videoPath) => {
    if (videoPath === 'videos/active.mp4') {
      return {
        id: 'active',
        path: 'videos/active.mp4',
        blobId: '0:8:0:4294967296',
        blobsCoreKey: coreA,
        byteLength: 4 * GB,
        mimeType: 'video/mp4'
      }
    }

    return {
      id: 'cached',
      path: 'videos/cached.mp4',
      blobId: '10:8:0:4294967296',
      blobsCoreKey: coreB,
      byteLength: 4 * GB,
      mimeType: 'video/mp4'
    }
  }

  const activePrefetch = api.prefetchVideo('drive-a', 'videos/active.mp4')
  await new Promise((resolve) => setImmediate(resolve))
  const activeCore = store.cores.get(coreA)
  activeCore.emit('download', 0, 2 * GB)
  await activePrefetch

  const cachedCore = store.get(b4a.from(coreB, 'hex'))
  cachedCore.has = async () => true
  const cachedResult = await api.prefetchVideo('drive-b', 'videos/cached.mp4')

  t.is(cachedResult.success, true)
  t.is(cachedResult.cached, true)
  t.alike(activeCore.clearCalls, [])
  t.is(seedingManager.getActiveSeeds().length, 2)
  t.is(seedingManager.getStorageStatsSync().usedBytes, 6 * GB)
})

test('prefetchVideo cleans up core listeners when blob is already fully cached', async (t) => {
  const metaDb = createMetaDb()
  const store = createStore()
  const api = createApi({ ctx: { store, metaDb, metaSubspaces: metaDb.subspaces, swarm: null } })
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

test('ending playback flushes the quota eviction that was deferred while playing', async (t) => {
  const store = createStore()
  const metaDb = createMetaDb()
  // Mirror production wiring: enforceQuota defers all clears while playback is
  // active. The only thing that calls enforceQuota during a watch is addSeed,
  // which runs *while* playback is active — so without a flush on playback-stop
  // the over-quota cache is never evicted.
  const seedingManager = new SeedingManager(store, metaDb, {
    isCacheClearBlocked: () => isPlaybackActive()
  })
  const api = createApi({ ctx: { store, metaDb, metaSubspaces: metaDb.subspaces }, seedingManager })
  const core = store.get(b4a.from(coreA, 'hex'))

  api.setPlaybackActive({ active: false }) // clean baseline for the shared module flag
  await seedingManager.setMaxStorageGB(5)

  // Start watching: cache eviction is now gated off.
  api.setPlaybackActive({ active: true })
  await seedingManager.addSeed('drive-a', 'videos/big.mp4', 'watched', {
    byteLength: 6 * GB,
    blobId: '0:6:0:6144',
    blobsCoreKey: coreA
  })

  // Over quota (6GB > 5GB) but deferred: nothing cleared while playing.
  t.is(seedingManager.getActiveSeeds().length, 1)
  t.alike(core.clearCalls, [])

  // Stop playback -> the deferred eviction must now run.
  api.setPlaybackActive({ active: false })
  await waitUntil(() => seedingManager.getActiveSeeds().length === 0)

  t.is(seedingManager.getActiveSeeds().length, 0)
  t.alike(core.clearCalls, [{ start: 0, end: 6 }])
})

test('rapid reopen cancels the post-playback eviction sweep', async (t) => {
  const store = createStore()
  const metaDb = createMetaDb()
  const seedingManager = new SeedingManager(store, metaDb, {
    isCacheClearBlocked: () => isPlaybackActive()
  })
  const api = createApi({ ctx: { store, metaDb, metaSubspaces: metaDb.subspaces }, seedingManager })
  const core = store.get(b4a.from(coreA, 'hex'))

  api.setPlaybackActive({ active: false })
  await seedingManager.setMaxStorageGB(5)

  // Over quota, but added while playing -> eviction deferred to the sweep.
  api.setPlaybackActive({ active: true })
  await seedingManager.addSeed('drive-a', 'videos/old.mp4', 'watched', {
    byteLength: 6 * GB,
    blobId: '0:6:0:6144',
    blobsCoreKey: coreA
  })
  t.is(seedingManager.getActiveSeeds().length, 1)
  t.alike(core.clearCalls, [])

  // Close then immediately reopen (a new watch starts) before the debounce fires.
  api.setPlaybackActive({ active: false })
  api.setPlaybackActive({ active: true })

  // Give the (cancelled) sweep well past its delay to prove it never ran.
  await delay(120)
  t.is(seedingManager.getActiveSeeds().length, 1)
  t.alike(core.clearCalls, [])

  // Reset shared playback flag and let the now-pending sweep settle.
  api.setPlaybackActive({ active: false })
  await waitUntil(() => seedingManager.getActiveSeeds().length === 0)
})

test('post-playback sweep never evicts the most-recently-played video', async (t) => {
  const store = createStore()
  const metaDb = createMetaDb()
  const seedingManager = new SeedingManager(store, metaDb, {
    isCacheClearBlocked: () => isPlaybackActive()
  })
  const api = createApi({ ctx: { store, metaDb, metaSubspaces: metaDb.subspaces }, seedingManager })
  const coreCurrent = store.get(b4a.from(coreA, 'hex'))
  const coreOld = store.get(b4a.from(coreB, 'hex'))

  api.setPlaybackActive({ active: false })
  await seedingManager.setMaxStorageGB(5)

  // Watching: both seeds added while playing, so eviction is deferred until stop.
  api.setPlaybackActive({ active: true })
  await seedingManager.addSeed('drive-old', 'videos/old.mp4', 'watched', {
    byteLength: 4 * GB,
    blobId: '0:4:0:4096',
    blobsCoreKey: coreB
  })
  // preparePlayback records the current video as most-recently-played before it
  // resolves a blob URL; stub the resolver so the handler returns fast.
  api.getVideoUrl = async () => { throw new Error('no blob server in test') }
  await api.preparePlayback('drive-cur', 'videos/current.mp4', null, '0:4:0:4096', coreA, 'video/mp4').catch(() => {})
  await seedingManager.addSeed('drive-cur', 'videos/current.mp4', 'watched', {
    byteLength: 4 * GB,
    blobId: '0:4:0:4096',
    blobsCoreKey: coreA
  }, { protectSelf: true })

  // 8GB tracked vs 5GB quota, nothing cleared yet (deferred while playing).
  t.is(seedingManager.getActiveSeeds().length, 2)
  t.alike(coreOld.clearCalls, [])

  // Stop -> sweep runs and must evict the old one but keep the just-played one.
  api.setPlaybackActive({ active: false })
  await waitUntil(() => seedingManager.getActiveSeeds().length === 1)

  const survivors = seedingManager.getActiveSeeds().map((s) => s.videoPath)
  t.absent(survivors.includes('videos/old.mp4'), 'old video evicted')
  t.ok(survivors.includes('videos/current.mp4'), 'just-played video kept')
  t.alike(coreOld.clearCalls, [{ start: 0, end: 4 }])
  t.alike(coreCurrent.clearCalls, [])
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
