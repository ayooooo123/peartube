import test from 'brittle'
import * as seeding from '../src/seeding.js'

function createMetaDb() {
  const state = new Map()
  return {
    state,
    async get(key) {
      return state.has(key) ? { value: state.get(key) } : null
    },
    async put(key, value) {
      state.set(key, value)
    }
  }
}

function createStore(diskUsageBytes = null) {
  const cores = new Map()
  return {
    cores,
    async getDiskUsageBytes() {
      return diskUsageBytes
    },
    get(key) {
      const keyHex = Buffer.isBuffer(key) ? key.toString('hex') : String(key)
      if (!cores.has(keyHex)) {
        cores.set(keyHex, {
          clearCalls: [],
          async ready() {},
          async clear(start, end) {
            this.clearCalls.push({ start, end })
          }
        })
      }
      return cores.get(keyHex)
    }
  }
}

function createDownloadIntents(seed = {}) {
  const state = new Map(Object.entries(seed))
  return {
    state,
    async *createReadStream() {
      for (const [key, value] of Array.from(state.entries()).sort(([a], [b]) => a.localeCompare(b))) {
        yield { key, value }
      }
    },
    async del(key) {
      state.delete(key)
    }
  }
}


const GB = 1024 * 1024 * 1024
const coreA = 'aa'.repeat(32)
const coreB = 'bb'.repeat(32)
const coreC = 'cc'.repeat(32)
const coreD = 'dd'.repeat(32)



test('storage category totals reconcile in deterministic order', (t) => {
  t.is(typeof seeding.buildStorageCategoryTotals, 'function')

  const totals = seeding.buildStorageCategoryTotals({
    indexBytes: 60,
    localCacheBytes: 40,
    ownedOriginalBytes: 10,
    temporaryTransferBytes: 70,
    thumbnailBytes: 50,
    pledgedArchiveBytes: 30,
    immutablePublicationBytes: 20
  })

  t.alike(Object.keys(totals), [
    'ownedOriginalBytes',
    'immutablePublicationBytes',
    'pledgedArchiveBytes',
    'localCacheBytes',
    'thumbnailBytes',
    'indexBytes',
    'temporaryTransferBytes',
    'totalCategorizedBytes',
    'evictableBytes',
    'protectedBytes'
  ])
  t.is(totals.totalCategorizedBytes, 280)
  t.is(totals.evictableBytes, 220)
  t.is(totals.protectedBytes, 60)
  t.is(totals.evictableBytes + totals.protectedBytes, totals.totalCategorizedBytes)
})

test('clearCache preserves pledged and archive seeds', async (t) => {
  const store = createStore()
  const manager = new seeding.SeedingManager(store, createMetaDb())
  await manager.applyNetworkPolicy({ contributeWatchedMedia: true, contributionBudgetBytes: 20 * GB, archiveEnabled: true, archiveBudgetBytes: 20 * GB, migrationRequired: false })
  await manager.addSeed('drive-watched', 'videos/watched.mp4', 'watched', {
    byteLength: 1 * GB,
    blobId: '0:1:0:1',
    blobsCoreKey: coreA
  })
  await manager.addSeed('drive-pledged', 'videos/pledged.mp4', 'pledged', {
    byteLength: 1 * GB,
    blobId: '1:1:0:1',
    blobsCoreKey: coreB
  })
  await manager.addSeed('drive-archive', 'videos/archive.mp4', 'archive', {
    byteLength: 1 * GB,
    blobId: '2:1:0:1',
    blobsCoreKey: coreC
  })

  await manager.clearCache()

  t.alike(manager.getActiveSeeds().map(seed => seed.reason).sort(), ['archive', 'pledged'])
  t.alike(store.cores.get(coreA).clearCalls, [{ start: 0, end: 1 }])
  t.absent(store.cores.get(coreB)?.clearCalls?.length)
  t.absent(store.cores.get(coreC)?.clearCalls?.length)
})

test('quota enforcement preserves pledged and archive seeds', async (t) => {
  const store = createStore()
  const manager = new seeding.SeedingManager(store, createMetaDb())
  await manager.applyNetworkPolicy({ contributeWatchedMedia: true, contributionBudgetBytes: 20 * GB, archiveEnabled: true, archiveBudgetBytes: 20 * GB, migrationRequired: false })
  await manager.setMaxStorageGB(10)

  await manager.addSeed('drive-archive', 'videos/archive.mp4', 'archive', {
    byteLength: 2 * GB,
    blobId: '0:1:0:1',
    blobsCoreKey: coreA
  })
  await manager.addSeed('drive-pledged', 'videos/pledged.mp4', 'pledged', {
    byteLength: 2 * GB,
    blobId: '1:1:0:1',
    blobsCoreKey: coreB
  })
  await manager.addSeed('drive-watched', 'videos/watched.mp4', 'watched', {
    byteLength: 3 * GB,
    blobId: '2:1:0:1',
    blobsCoreKey: coreC
  })

  await manager.setMaxStorageGB(4)

  t.alike(manager.getActiveSeeds().map(seed => seed.reason).sort(), ['archive', 'pledged'])
  t.absent(store.cores.get(coreA)?.clearCalls?.length)
  t.absent(store.cores.get(coreB)?.clearCalls?.length)
  t.alike(store.cores.get(coreC).clearCalls, [{ start: 2, end: 3 }])
})

test('pledged and archive reasons outrank pinned retention', async (t) => {
  const manager = new seeding.SeedingManager(createStore(), createMetaDb())
  await manager.applyNetworkPolicy({ contributeWatchedMedia: true, contributionBudgetBytes: 20 * GB, archiveEnabled: true, archiveBudgetBytes: 20 * GB, migrationRequired: false })
  await manager.addSeed('drive-pledged', 'videos/pledged.mp4', 'pinned', { byteLength: 1 })
  await manager.addSeed('drive-pledged', 'videos/pledged.mp4', 'pledged', { byteLength: 1 })
  await manager.addSeed('drive-archive', 'videos/archive.mp4', 'pinned', { byteLength: 1 })
  await manager.addSeed('drive-archive', 'videos/archive.mp4', 'archive', { byteLength: 1 })

  const reasons = Object.fromEntries(manager.getActiveSeeds().map(seed => [seed.videoPath, seed.reason]))
  t.is(reasons['videos/pledged.mp4'], 'pledged')
  t.is(reasons['videos/archive.mp4'], 'archive')
})

test('previewStorageLimit is side-effect free and matches quota enforcement', async (t) => {
  const metaDb = createMetaDb()
  const store = createStore()
  const manager = new seeding.SeedingManager(store, metaDb)
  manager.config.maxStorageGB = 10
  const seeds = [
    ['drive-old:videos/old.mp4', { driveKey: 'drive-old', videoPath: 'videos/old.mp4', reason: 'watched', addedAt: 1, bytes: 3 * GB, blobId: '0:1:0:1', blobsCoreKey: coreA }],
    ['drive-new:videos/new.mp4', { driveKey: 'drive-new', videoPath: 'videos/new.mp4', reason: 'watched', addedAt: 3, bytes: 2 * GB, blobId: '1:1:0:1', blobsCoreKey: coreB }],
    ['drive-sub:videos/subscribed.mp4', { driveKey: 'drive-sub', videoPath: 'videos/subscribed.mp4', reason: 'subscribed', addedAt: 2, bytes: 2 * GB, blobId: '2:1:0:1', blobsCoreKey: coreC }],
    ['drive-pin:videos/pinned.mp4', { driveKey: 'drive-pin', videoPath: 'videos/pinned.mp4', reason: 'pinned', addedAt: 4, bytes: 3 * GB, blobId: '3:1:0:1', blobsCoreKey: coreD }]
  ]
  for (const [key, seed] of seeds) manager.activeSeeds.set(key, seed)
  const beforeKeys = Array.from(manager.activeSeeds.keys())

  const preview = await manager.previewStorageLimit({ maxBytes: 5 * GB })

  t.alike(preview, {
    success: true,
    requestedMaxBytes: 5 * GB,
    currentUsedBytes: 10 * GB,
    requiredEvictionBytes: 5 * GB,
    evictableBytes: 7 * GB,
    protectedBytes: 3 * GB,
    affectedSeedCount: 2,
    affectedCategories: ['localCacheBytes'],
    consequences: [
      '2 local cache seeds will stop seeding on this device.',
      'Evicted content may become unavailable if no other peer retains it.'
    ],
    feasible: true
  })
  t.alike(Array.from(manager.activeSeeds.keys()), beforeKeys)
  t.is(metaDb.state.size, 0)
  t.is(store.cores.size, 0)

  await manager.setMaxStorageGB(5)

  t.alike(manager.getActiveSeeds().map(seed => seed.videoPath).sort(), [
    'videos/pinned.mp4',
    'videos/subscribed.mp4'
  ])
  t.is(store.cores.get(coreA).clearCalls.length + store.cores.get(coreB).clearCalls.length, 2)
})

test('an infeasible storage limit reports protected bytes and is not applied', async (t) => {
  const metaDb = createMetaDb()
  const store = createStore()
  const manager = new seeding.SeedingManager(store, metaDb)
  manager.config.maxStorageGB = 10
  manager.activeSeeds.set('drive-pin:videos/pinned.mp4', {
    driveKey: 'drive-pin',
    videoPath: 'videos/pinned.mp4',
    reason: 'pinned',
    addedAt: 1,
    bytes: 6 * GB,
    blobId: '0:1:0:1',
    blobsCoreKey: coreA
  })
  manager.activeSeeds.set('drive-cache:videos/cache.mp4', {
    driveKey: 'drive-cache',
    videoPath: 'videos/cache.mp4',
    reason: 'watched',
    addedAt: 2,
    bytes: 1 * GB,
    blobId: '1:1:0:1',
    blobsCoreKey: coreB
  })

  const preview = await manager.previewStorageLimit({ maxBytes: 5 * GB })

  t.is(preview.success, true)
  t.is(preview.feasible, false)
  t.is(preview.errorCode, 'STORAGE_LIMIT_INFEASIBLE')
  t.is(preview.requiredEvictionBytes, 2 * GB)
  t.is(preview.evictableBytes, 1 * GB)
  t.is(preview.protectedBytes, 6 * GB)

  await manager.setMaxStorageGB(5)

  t.is(manager.getMaxStorageGB(), 10)
  t.is(manager.getActiveSeeds().length, 2)
  t.is(metaDb.state.size, 0)
  t.is(store.cores.size, 0)
})

test('storage stats expose reconciled seeded and external disk categories', async (t) => {
  const manager = new seeding.SeedingManager(createStore(142), createMetaDb(), {
    getStorageCategoryUsage: async () => ({
      ownedOriginalBytes: 10,
      immutablePublicationBytes: 5,
      pledgedArchiveBytes: 7,
      localCacheBytes: 3,
      thumbnailBytes: 6,
      indexBytes: 8,
      temporaryTransferBytes: 9
    })
  })
  manager.activeSeeds.set('drive-watch:videos/watch.mp4', {
    driveKey: 'drive-watch',
    videoPath: 'videos/watch.mp4',
    reason: 'watched',
    bytes: 40,
    thumbnailBytes: 4
  })
  manager.activeSeeds.set('drive-pin:videos/pinned.mp4', {
    driveKey: 'drive-pin',
    videoPath: 'videos/pinned.mp4',
    reason: 'pinned',
    bytes: 20
  })
  manager.activeSeeds.set('drive-pledge:videos/pledged.mp4', {
    driveKey: 'drive-pledge',
    videoPath: 'videos/pledged.mp4',
    reason: 'pledged',
    bytes: 30
  })

  const stats = await manager.getStorageStats()

  t.alike(Object.fromEntries(seeding.STORAGE_CATEGORY_FIELDS.map(field => [field, stats[field]])), {
    ownedOriginalBytes: 10,
    immutablePublicationBytes: 25,
    pledgedArchiveBytes: 37,
    localCacheBytes: 43,
    thumbnailBytes: 10,
    indexBytes: 8,
    temporaryTransferBytes: 9
  })
  t.is(stats.totalCategorizedBytes, 142)
  t.is(stats.evictableBytes, 70)
  t.is(stats.protectedBytes, 72)
  t.is(stats.totalCategorizedBytes, stats.totalStorageBytes)
})

test('ordinary cache clearing preserves pledged temporary transfers', async (t) => {
  const downloadIntents = createDownloadIntents({
    'drive-cache:videos/cache.mp4': {
      driveKey: 'drive-cache',
      videoPath: 'videos/cache.mp4',
      reason: 'watched',
      totalBytes: 10,
      blobId: '0:1:0:1',
      blobsCoreKey: coreA
    },
    'drive-pledge:videos/pledged.mp4': {
      driveKey: 'drive-pledge',
      videoPath: 'videos/pledged.mp4',
      reason: 'pledged',
      totalBytes: 20,
      blobId: '1:1:0:1',
      blobsCoreKey: coreB
    }
  })
  const store = createStore()
  const manager = new seeding.SeedingManager(store, createMetaDb(), {
    metaSubspaces: { downloadIntents }
  })

  await manager.clearCache()

  t.alike(Array.from(downloadIntents.state.keys()), ['drive-pledge:videos/pledged.mp4'])
  t.alike(store.cores.get(coreA).clearCalls, [{ start: 0, end: 1 }])
  t.absent(store.cores.get(coreB)?.clearCalls?.length)
})

test('seed thumbnail bytes are accounted separately from cached publication bytes', async (t) => {
  const manager = new seeding.SeedingManager(createStore(), createMetaDb())
  await manager.applyNetworkPolicy({ contributeWatchedMedia: true, contributionBudgetBytes: 20 * GB, migrationRequired: false })
  await manager.addSeed('drive-watch', 'videos/watch.mp4', 'watched', {
    byteLength: 40,
    thumbnailByteLength: 6
  })

  const stats = manager.getStorageStatsSync()
  t.is(stats.localCacheBytes, 40)
  t.is(stats.thumbnailBytes, 6)
  t.is(stats.totalCategorizedBytes, 46)
  t.is(manager.getActiveSeeds()[0].thumbnailBytes, 6)
})

test('ordinary seed eviction clears its thumbnail range', async (t) => {
  const store = createStore()
  const manager = new seeding.SeedingManager(store, createMetaDb())
  await manager.applyNetworkPolicy({ contributeWatchedMedia: true, contributionBudgetBytes: 20 * GB, migrationRequired: false })
  await manager.addSeed('drive-watch', 'videos/watch.mp4', 'watched', {
    byteLength: 40,
    blobId: '2:3:0:40',
    blobsCoreKey: coreA,
    thumbnailByteLength: 6,
    thumbnailBlobId: '7:2:0:6',
    thumbnailBlobsCoreKey: coreB
  })

  const result = await manager.clearCache()

  t.alike(store.cores.get(coreA).clearCalls, [{ start: 2, end: 5 }])
  t.alike(store.cores.get(coreB).clearCalls, [{ start: 7, end: 9 }])
  t.is(result.clearedBytes, 46)
})

test('archive-retained cores cannot be evicted through an ordinary watched seed', async (t) => {
  const protectedArchiveCores = new Map([[coreA, 1]])
  const store = createStore()
  const manager = new seeding.SeedingManager(store, createMetaDb(), { protectedArchiveCores })
  manager.config.maxStorageGB = 0
  manager.activeSeeds.set('drive-watch:videos/watch.mp4', {
    key: 'drive-watch:videos/watch.mp4',
    driveKey: 'drive-watch',
    videoPath: 'videos/watch.mp4',
    reason: 'watched',
    bytes: 40,
    blobId: '0:1:0:40',
    blobsCoreKey: coreA,
  })

  await manager.enforceQuota()

  t.is(manager.getActiveSeeds().length, 1)
  t.is(manager.protectedBlobCores.size, 0, 'archive custody is not reported as active playback')
  t.absent(store.cores.get(coreA)?.clearCalls?.length)
})
