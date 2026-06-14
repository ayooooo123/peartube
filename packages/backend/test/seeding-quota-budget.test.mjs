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

function createStore({ diskUsageBytes = 0 } = {}) {
  const state = { diskUsageBytes, measureCalls: 0 }
  return {
    state,
    async getDiskUsageBytes() {
      state.measureCalls += 1
      return state.diskUsageBytes
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

test('getQuotaBudget reports real on-disk headroom under the configured quota', async (t) => {
  const store = createStore({ diskUsageBytes: 4 * GB })
  const manager = new SeedingManager(store, createMetaDb())
  await manager.setConfig({ maxStorageGB: 5 })

  const budget = await manager.getQuotaBudget()
  t.is(budget.maxBytes, 5 * GB)
  t.is(budget.usageBytes, 4 * GB)
  t.is(budget.headroomBytes, 1 * GB)

  // A video larger than the 1 GB of headroom must not be admitted for a full
  // background download — that is what was breaching the quota mid-watch.
  t.absent(fullDownloadFitsQuota(budget.headroomBytes, 3 * GB), 'oversized video rejected')
  t.ok(fullDownloadFitsQuota(budget.headroomBytes, 512 * 1024 * 1024), 'small video admitted')
})

test('getQuotaBudget falls back to the tracked sum when disk cannot be measured', async (t) => {
  const manager = new SeedingManager({ get() { return {} } }, createMetaDb())
  await manager.setConfig({ maxStorageGB: 5 })
  await manager.addSeed('drive-a', 'videos/a.mp4', 'watched', {
    byteLength: 2 * GB,
    blobId: '10:4:0:4096',
    blobsCoreKey: 'aa'.repeat(32)
  })

  const budget = await manager.getQuotaBudget()
  t.is(budget.usageBytes, 2 * GB, 'uses tracked sum when no measurer is available')
  t.is(budget.headroomBytes, 3 * GB)
})

test('getTotalStorageBytesCached coalesces repeated measurements within the TTL', async (t) => {
  const store = createStore({ diskUsageBytes: 4 * GB })
  const manager = new SeedingManager(store, createMetaDb())

  const first = await manager.getTotalStorageBytesCached(10_000)
  const second = await manager.getTotalStorageBytesCached(10_000)
  t.is(first, 4 * GB)
  t.is(second, 4 * GB)
  t.is(store.state.measureCalls, 1, 'second call within TTL reuses the cached measurement')

  // A zero-age request bypasses the cache and re-measures.
  await manager.getTotalStorageBytesCached(0)
  t.is(store.state.measureCalls, 2, 're-measures when the cache is forced stale')
})
