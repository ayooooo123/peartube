/**
 * The device-local watch-state adapter, exercised against a stand-in store.
 *
 * `lib/watch-history.ts` is the only thing between the player and the viewer's
 * encrypted personal store, and every failure mode below was silent: the cache
 * went on rendering progress that was never written, an unreachable backend
 * grew an unbounded queue, a delete was undone by the player still mounted on
 * it, and a plaintext file was deleted without proof its contents had landed
 * anywhere. Each test drives the real module and asserts what reached the
 * store, never what the source looks like.
 *
 * The platform RPC facade is loaded by a dynamic import, and how that import
 * behaves is itself under test, so it is answered per-import from the harness
 * in force at that moment rather than bundled in.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const appRoot = path.resolve(import.meta.dirname, '..')
const WATCH_HISTORY = pathToFileURL(path.join(appRoot, 'lib/watch-history.ts')).href
const LEGACY_WEB_STORAGE_KEY = 'peartube-watch-history'

/** The two device modules the adapter imports statically. */
const STATIC_STUBS = {
  react: 'export const useEffect = () => {}\nexport const useState = (initial) => [initial, () => {}]',
  'react-native': 'export const Platform = { OS: "web" }',
}

/**
 * Every dynamic import of the platform facade runs this module body afresh, so
 * a load can be made to fail exactly as many times as a test wants.
 */
const PLATFORM_RPC_STUB = [
  'const harness = () => globalThis.__peartubeWatchHistoryHarness',
  'harness().moduleLoads += 1',
  'if (harness().failingModuleLoads-- > 0) throw new Error("platform rpc module unavailable")',
  'export const isInitialized = () => harness().initialized',
  'export const rpc = new Proxy({}, { get: (_target, method) => (args) => harness().call(String(method), args) })',
].join('\n')

let moduleLoadCounter = 0

registerHooks({
  resolve(specifier, context, next) {
    if (specifier in STATIC_STUBS) return { url: `peartube-stub:${specifier}`, shortCircuit: true }
    // A distinct URL per import: Node caches modules by URL, and a cached
    // rejection would hide the retry this file is here to prove.
    if (specifier === '@peartube/platform/rpc') return { url: `peartube-rpc:${++moduleLoadCounter}`, shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith('peartube-stub:')) {
      return { format: 'module', source: STATIC_STUBS[url.slice('peartube-stub:'.length)], shortCircuit: true }
    }
    if (url.startsWith('peartube-rpc:')) return { format: 'module', source: PLATFORM_RPC_STUB, shortCircuit: true }
    return next(url, context)
  },
})

/** The web legacy source the migration path reads. */
const legacyStorage = new Map()
globalThis.localStorage = {
  getItem: (key) => (legacyStorage.has(key) ? legacyStorage.get(key) : null),
  setItem: (key, value) => { legacyStorage.set(key, String(value)) },
  removeItem: (key) => { legacyStorage.delete(key) },
}

/**
 * A stand-in personal store. `resume` and `history` are what the two read
 * methods report; every call is recorded so a test can assert on what the
 * adapter actually asked the store to do.
 */
function installStore({ initialized = true, failingModuleLoads = 0, resume = [], history = [], answer = null } = {}) {
  const calls = []
  const harness = {
    calls,
    moduleLoads: 0,
    failingModuleLoads,
    initialized,
    resume,
    history,
    async call(method, args) {
      calls.push({ method, args })
      if (answer) {
        const early = await answer(method, args)
        if (early !== undefined) return early
      }
      if (method === 'getWatchHistory') return { entries: harness.history }
      if (method === 'listResumePositions') return { entries: harness.resume }
      return { success: true }
    },
    logged() {
      return calls.filter((call) => call.method === 'logWatchHistory').map((call) => call.args)
    },
  }
  globalThis.__peartubeWatchHistoryHarness = harness
  return harness
}

/**
 * A fresh module instance. The adapter keeps a process-wide cache, a pending
 * queue, and a tombstone map, so tests must not share one.
 */
function freshWatchHistory() {
  return import(`${WATCH_HISTORY}?instance=${++moduleLoadCounter}`)
}

const NEBULA = {
  channelKey: 'ab'.repeat(32),
  videoId: 'nebula-drift',
  title: 'Nebula Drift',
  identity: { entityRef: 'work:nebula-drift' },
  positionSec: 1_200,
  durationSec: 3_600,
}

test.beforeEach(() => {
  legacyStorage.clear()
  delete globalThis.__peartubeWatchHistoryHarness
})

test('a transient platform-module failure does not disable writes for the life of the process', async () => {
  // The facade import used to be latched on the *promise*, so the first
  // rejection was memoised and every later write silently went nowhere while
  // the cache carried on rendering progress as if it had been saved.
  const store = installStore({ failingModuleLoads: 1 })
  const history = await freshWatchHistory()

  await history.recordProgress(NEBULA)

  assert.ok(store.moduleLoads >= 2, 'the failed import was retried rather than remembered')
  assert.deepEqual(
    store.logged().map((request) => request.videoId),
    ['nebula-drift'],
    'the progress the cache is showing really did reach the store',
  )

  const loadsAfterRecovery = store.moduleLoads
  await history.recordProgress({ ...NEBULA, positionSec: 2_400 })
  assert.equal(store.moduleLoads, loadsAfterRecovery, 'a module that did load is not imported again')
  assert.equal(store.logged().length, 2)
})

test('every failed import is retried, not just the first', async () => {
  const store = installStore({ failingModuleLoads: 4 })
  const history = await freshWatchHistory()

  await history.recordProgress(NEBULA)
  assert.deepEqual(store.logged(), [], 'the store was never reachable during that write')

  store.failingModuleLoads = 0
  await history.recordProgress({ ...NEBULA, positionSec: 2_400 })
  assert.deepEqual(
    store.logged().map((request) => request.position),
    [1_200, 2_400],
    'both the write held back by the outage and the new one land once the module loads',
  )
})

test('recording progress resolves only once the store has been asked to write it', async () => {
  let settled = false
  const store = installStore({
    async answer(method) {
      if (method !== 'logWatchHistory') return undefined
      // A real write is not synchronous. Anything that resolves before this
      // does is reporting success it has no evidence for.
      await new Promise((resolve) => { setImmediate(resolve) })
      settled = true
      return { success: true }
    },
  })
  const history = await freshWatchHistory()

  await history.recordProgress(NEBULA)

  assert.equal(settled, true, 'the write completed before recordProgress resolved')
  assert.equal(store.logged().length, 1)
})

test('a write the store refuses stays queued and is replayed', async () => {
  // Rotating the personal store's epoch answers `success: false` rather than
  // throwing. Treating that as "written" would drop the viewer's progress on
  // the floor every time a device is revoked.
  const store = installStore({
    async answer(method) {
      return method === 'logWatchHistory' && store.rotating
        ? { success: false, error: 'personal-store-rotating' }
        : undefined
    },
  })
  store.rotating = true
  const history = await freshWatchHistory()

  await history.recordProgress(NEBULA)
  assert.deepEqual(store.logged().map((request) => request.videoId), ['nebula-drift'], 'the write was attempted')

  // Rotation finishes, and a different title is watched. Draining the queue has
  // to carry the refused write with it.
  store.rotating = false
  await history.recordProgress({ ...NEBULA, identity: { entityRef: 'work:tidepool' }, videoId: 'tidepool', positionSec: 600 })

  assert.deepEqual(
    store.logged().map((request) => request.videoId),
    ['nebula-drift', 'nebula-drift', 'tidepool'],
    'the refused write was replayed against the new epoch, not discarded',
  )
  assert.deepEqual(
    (await history.getHistory()).map((entry) => entry.videoId).sort(),
    ['nebula-drift', 'tidepool'],
  )
})

test('an unreachable store bounds the unwritten queue exactly as the cache is bounded', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 })
  const store = installStore({ initialized: false })
  const history = await freshWatchHistory()

  const total = 140
  for (let index = 0; index < total; index += 1) {
    t.mock.timers.tick(1_000)
    await history.recordProgress({
      ...NEBULA,
      identity: null,
      videoId: `video-${String(index).padStart(3, '0')}`,
      positionSec: 1_200,
    })
  }
  assert.deepEqual(store.logged(), [], 'nothing could be written while the backend was down')

  const cached = (await history.getHistory()).map((entry) => entry.videoId)
  assert.ok(cached.length < total, 'the cache is bounded')

  // The backend comes up; the queue drains.
  store.initialized = true
  t.mock.timers.tick(1_000)
  await history.recordProgress({ ...NEBULA, identity: null, videoId: 'video-999', positionSec: 1_200 })

  const written = [...new Set(store.logged().map((request) => request.videoId))].sort()
  assert.deepEqual(
    written,
    [...new Set([...cached, 'video-999'])].sort(),
    'the queue retained the same bounded, most-recent slice the cache did — not every write ever made',
  )
  assert.ok(
    !written.includes('video-000'),
    'the oldest unwritten progress is what an unbounded queue would have kept forever',
  )
})

test('a delete is not undone by the player still mounted on it', async () => {
  const store = installStore()
  const history = await freshWatchHistory()

  await history.recordProgress(NEBULA)
  const played = store.logged().at(-1)

  await history.removeEntry(NEBULA.channelKey, NEBULA.videoId)
  const grave = store.logged().at(-1)
  assert.equal(grave.tombstone, true, 'the delete reached the store')
  assert.ok(
    grave.playbackGeneration > (played.playbackGeneration ?? 0),
    'the delete outranks the record it removes instead of merely out-timestamping it',
  )

  // The viewer deleted from the Library while the player kept playing. Its next
  // progress tick used to write the record straight back.
  const writesBefore = store.logged().length
  await history.recordProgress({ ...NEBULA, positionSec: 2_400 })

  assert.equal(store.logged().length, writesBefore, 'the running player wrote nothing')
  assert.deepEqual(await history.getHistory(), [], 'and the deleted title stayed deleted')

  // The viewer deliberately plays it again. That, and only that, is a new watch.
  history.beginWatchSession(NEBULA)
  await history.recordProgress({ ...NEBULA, positionSec: 30 })

  const rewatch = store.logged().at(-1)
  assert.equal(rewatch.tombstone, undefined, 'the new watch is a real record, not a tombstone')
  assert.ok(
    rewatch.playbackGeneration > grave.playbackGeneration,
    'a deliberate rewatch starts strictly above the delete, so it wins on every device',
  )
  assert.deepEqual((await history.getHistory()).map((entry) => entry.positionSec), [30])
})

test('clearing the whole history bars every running player the same way', async () => {
  const store = installStore()
  const history = await freshWatchHistory()

  await history.recordProgress(NEBULA)
  await history.recordProgress({ ...NEBULA, identity: { entityRef: 'work:tidepool' }, videoId: 'tidepool', positionSec: 600 })
  await history.clearHistory()
  assert.equal(store.logged().filter((request) => request.tombstone === true).length, 2)

  const writesBefore = store.logged().length
  await history.recordProgress({ ...NEBULA, positionSec: 2_400 })
  await history.recordProgress({ ...NEBULA, identity: { entityRef: 'work:tidepool' }, videoId: 'tidepool', positionSec: 900 })

  assert.equal(store.logged().length, writesBefore, 'neither running player refilled the history the viewer emptied')
  assert.deepEqual(await history.getHistory(), [])
})

test('a delete the store already knows about still lets a new watch be recorded', async () => {
  // A tombstone read back at startup is history, not an instruction aimed at a
  // session that has not begun yet: it sets the floor the next watch has to
  // clear, and nothing else.
  const store = installStore({
    resume: [{
      stateKey: 'work:nebula-drift||',
      videoKey: 'work:nebula-drift||',
      identity: { entityRef: 'work:nebula-drift' },
      position: 1_200,
      duration: 3_600,
      updatedAt: 1,
      order: { playbackGeneration: 4, tombstone: true },
    }],
  })
  const history = await freshWatchHistory()

  assert.deepEqual(await history.getHistory(), [], 'the deleted record is not shown')

  await history.recordProgress(NEBULA)
  const written = store.logged().at(-1)
  assert.ok(written.playbackGeneration > 4, 'the new watch clears the generation the delete was written at')
  assert.equal((await history.getHistory()).length, 1)
})

test('the plaintext legacy file survives a migration the store cannot confirm', async () => {
  // Identity-only rows carry no channel/video pair, so the read-back used to
  // find nothing to check and cleared the file on the strength of a write it
  // had never seen land.
  const legacy = [{
    identity: { entityRef: 'work:nebula-drift' },
    title: 'Nebula Drift',
    position: 1_200,
    duration: 3_600,
    updatedAt: 1_699_000_000_000,
  }]
  legacyStorage.set(LEGACY_WEB_STORAGE_KEY, JSON.stringify(legacy))
  const store = installStore()
  const history = await freshWatchHistory()

  await history.getHistory()

  assert.deepEqual(
    store.logged().map((request) => request.identity?.entityRef),
    ['work:nebula-drift'],
    'the row was offered to the store',
  )
  assert.equal(
    legacyStorage.get(LEGACY_WEB_STORAGE_KEY),
    JSON.stringify(legacy),
    'but an unconfirmed migration keeps the only other copy the viewer has',
  )
})

test('the plaintext legacy file goes once the store reads the row back', async () => {
  legacyStorage.set(LEGACY_WEB_STORAGE_KEY, JSON.stringify([{
    identity: { entityRef: 'work:nebula-drift' },
    title: 'Nebula Drift',
    position: 1_200,
    duration: 3_600,
    updatedAt: 1_699_000_000_000,
  }]))
  const store = installStore()
  // The store answers the read-back under the canonical state key, which is
  // all an identity-only record ever has.
  store.resume = [{
    stateKey: 'work:nebula-drift||',
    videoKey: 'work:nebula-drift||',
    identity: { entityRef: 'work:nebula-drift' },
    title: 'Nebula Drift',
    position: 1_200,
    duration: 3_600,
    updatedAt: 1_699_000_000_000,
  }]
  const history = await freshWatchHistory()

  await history.getHistory()

  assert.equal(legacyStorage.has(LEGACY_WEB_STORAGE_KEY), false, 'a confirmed migration takes the plaintext copy off the device')
  assert.deepEqual((await history.getHistory()).map((entry) => entry.title), ['Nebula Drift'])
})

test('a legacy row a previous run moved is still confirmed before the file is dropped', async () => {
  // Nothing is written for the first row — it is already in the store — but
  // "we did not write it" is not evidence that the source is safe to delete.
  legacyStorage.set(LEGACY_WEB_STORAGE_KEY, JSON.stringify([
    { identity: { entityRef: 'work:nebula-drift' }, title: 'Nebula Drift', position: 1_200, duration: 3_600, updatedAt: 1 },
    { identity: { entityRef: 'work:tidepool' }, title: 'Tidepool', position: 600, duration: 1_200, updatedAt: 2 },
  ]))
  const store = installStore({
    resume: [{
      stateKey: 'work:nebula-drift||',
      videoKey: 'work:nebula-drift||',
      identity: { entityRef: 'work:nebula-drift' },
      position: 1_200,
      duration: 3_600,
      updatedAt: 1,
    }],
  })
  const history = await freshWatchHistory()

  await history.getHistory()

  assert.deepEqual(
    store.logged().map((request) => request.identity?.entityRef),
    ['work:tidepool'],
    'only the row the store did not have was written',
  )
  assert.ok(legacyStorage.has(LEGACY_WEB_STORAGE_KEY), 'one unconfirmed row is enough to keep the whole file')
})
