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

// Everything under the storage path counts. Published uploads used to be
// excluded on the grounds that they are not "cache", which meant a relay
// holding gigabytes of its own publications reported zero usage and admitted
// downloads until the disk filled.
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

test('getQuotaBudget counts what is on disk, not only what it tracked', async (t) => {
  // 40 GB under the storage path, 2 GB of it tracked as cache, under a 5 GB
  // limit. The relay is far over; nothing more may be admitted.
  const manager = new SeedingManager(createStore({ diskUsageBytes: 40 * GB }), createMetaDb())
  await manager.setConfig({ maxStorageGB: 5 })
  await manager.addSeed('drive-a', 'videos/a.mp4', 'watched', {
    byteLength: 2 * GB,
    blobId: '10:4:0:4096',
    blobsCoreKey: 'aa'.repeat(32)
  })

  const budget = await manager.getQuotaBudget()
  t.is(budget.maxBytes, 5 * GB)
  t.is(budget.usageBytes, 40 * GB, 'usage is what the storage path holds')
  t.is(budget.trackedBytes, 2 * GB, 'tracked cache is still reported, as a component')
  t.is(budget.headroomBytes, 0, 'no headroom while over the limit')
  t.absent(fullDownloadFitsQuota(budget.headroomBytes, 1), 'not one further byte is admitted')
})

test('getQuotaBudget admits what fits under the limit', async (t) => {
  const manager = new SeedingManager(createStore({ diskUsageBytes: 3 * GB }), createMetaDb())
  await manager.setConfig({ maxStorageGB: 5 })

  const budget = await manager.getQuotaBudget()
  t.is(budget.usageBytes, 3 * GB, 'published content counts even with nothing tracked')
  t.is(budget.headroomBytes, 2 * GB)
  t.ok(fullDownloadFitsQuota(budget.headroomBytes, 2 * GB), 'a download that fits is admitted')
  t.absent(fullDownloadFitsQuota(budget.headroomBytes, 2 * GB + 1), 'one byte past the limit is not')
})

test('tracked usage is the floor when the disk cannot be measured', async (t) => {
  // An unmeasurable disk must never read as empty, or the limit stops
  // existing exactly when it is least observable.
  const manager = new SeedingManager({ get: () => ({ async ready() {}, async clear() {} }) }, createMetaDb())
  await manager.setConfig({ maxStorageGB: 5 })
  await manager.addSeed('drive-a', 'videos/a.mp4', 'watched', {
    byteLength: 4 * GB,
    blobId: '10:4:0:4096',
    blobsCoreKey: 'aa'.repeat(32)
  })

  const budget = await manager.getQuotaBudget()
  t.is(budget.measuredBytes, null, 'no measurement was available')
  t.is(budget.usageBytes, 4 * GB, 'the tracked cache still binds the limit')
  t.is(budget.headroomBytes, 1 * GB)
})

test('a measurement is reused briefly, then retaken', async (t) => {
  let walks = 0
  let onDisk = 1 * GB
  const manager = new SeedingManager({
    async getDiskUsageBytes() {
      walks += 1
      return onDisk
    },
    get: () => ({ async ready() {}, async clear() {} })
  }, createMetaDb())
  await manager.setConfig({ maxStorageGB: 5 })

  t.is((await manager.getQuotaBudget()).usageBytes, 1 * GB)
  onDisk = 4 * GB
  t.is((await manager.getQuotaBudget()).usageBytes, 1 * GB, 'a burst of checks walks the tree once')
  t.is(walks, 1)

  // Expire the cached reading the way time would.
  manager._measuredStorageAt = 0
  t.is((await manager.getQuotaBudget()).usageBytes, 4 * GB, 'growth is picked up on the next walk')
  t.is(walks, 2)
})

test('a failed measurement keeps the last known reading', async (t) => {
  let fail = false
  const manager = new SeedingManager({
    async getDiskUsageBytes() {
      if (fail) throw new Error('storage unreadable')
      return 4 * GB
    },
    get: () => ({ async ready() {}, async clear() {} })
  }, createMetaDb())
  await manager.setConfig({ maxStorageGB: 5 })

  t.is((await manager.getQuotaBudget()).usageBytes, 4 * GB)
  fail = true
  manager._measuredStorageAt = 0
  const budget = await manager.getQuotaBudget()
  t.is(budget.usageBytes, 4 * GB, 'an unreadable disk does not read as empty')
  t.is(budget.headroomBytes, 1 * GB)
})
