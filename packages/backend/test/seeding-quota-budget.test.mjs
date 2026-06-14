import test from 'brittle'
import { SeedingManager, fullDownloadFitsQuota } from '../src/seeding.js'

function createMetaDb(seed = {}) {
  const state = new Map(Object.entries(seed))
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

// The user's own uploads live in the same corestore, so raw disk usage is much
// larger than the tracked cache. The quota must ignore that — uploads never
// count against the cache limit.
function createStore({ diskUsageBytes = 0 } = {}) {
  return {
    async getDiskUsageBytes() {
      return diskUsageBytes
    },
    get() {
      return { async ready() {}, async clear() {} }
    }
  }
}

const GB = 1024 * 1024 * 1024

test('fullDownloadFitsQuota admits only downloads that fit the remaining headroom', (t) => {
  t.ok(fullDownloadFitsQuota(2 * GB, 1 * GB), 'fits when headroom exceeds remaining')
  t.ok(fullDownloadFitsQuota(1 * GB, 1 * GB), 'fits when headroom equals remaining')
  t.absent(fullDownloadFitsQuota(1 * GB, 2 * GB), 'rejected when remaining exceeds headroom')
  t.absent(fullDownloadFitsQuota(0, 1), 'rejected with no headroom')
  t.ok(fullDownloadFitsQuota(0, 0), 'zero remaining always fits')
  t.ok(fullDownloadFitsQuota(NaN, 0), 'zero remaining fits even with unknown headroom')
})

test('getQuotaBudget measures the tracked cache, excluding the user\'s own uploads', async (t) => {
  // 40 GB on disk (mostly the user's own uploaded videos) but only 2 GB cached
  // from the network under a 5 GB quota.
  const manager = new SeedingManager(createStore({ diskUsageBytes: 40 * GB }), createMetaDb())
  await manager.setConfig({ maxStorageGB: 5 })
  await manager.addSeed('drive-a', 'videos/a.mp4', 'watched', {
    byteLength: 2 * GB,
    blobId: '10:4:0:4096',
    blobsCoreKey: 'aa'.repeat(32)
  })

  const budget = manager.getQuotaBudget()
  t.is(budget.maxBytes, 5 * GB)
  t.is(budget.usageBytes, 2 * GB, 'usage is the tracked cache, not the 40 GB on disk')
  t.is(budget.headroomBytes, 3 * GB)

  // A 4 GB video does not fit the 3 GB of remaining cache headroom...
  t.absent(fullDownloadFitsQuota(budget.headroomBytes, 4 * GB), 'oversized video rejected')
  // ...but a 1 GB video does, regardless of the 40 GB of uploads on disk.
  t.ok(fullDownloadFitsQuota(budget.headroomBytes, 1 * GB), 'small video admitted despite large uploads')
})

test('getQuotaBudget reports full headroom when nothing is cached', async (t) => {
  const manager = new SeedingManager(createStore({ diskUsageBytes: 12 * GB }), createMetaDb())
  await manager.setConfig({ maxStorageGB: 5 })

  const budget = manager.getQuotaBudget()
  t.is(budget.usageBytes, 0, 'no seeds means zero cache usage even with uploads on disk')
  t.is(budget.headroomBytes, 5 * GB)
})
