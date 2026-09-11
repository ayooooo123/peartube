import test from 'brittle'
import b4a from 'b4a'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import { mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAcquisitionCoordinator } from '../src/acquisition/coordinator.js'
import { createAcquisitionStore } from '../src/acquisition/store.js'
import { createBufferSourceReader } from '../src/assets/source-reader.js'
import { writeStaticAsset } from '../src/assets/static-core.js'
import { normalizeAssetCoreRefV2 } from '../src/assets/rendition.js'

function deferred () {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function eventually (read, predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('condition was not reached')
}

function manualScheduler () {
  let nextId = 0
  const timers = new Map()
  return {
    schedule (fn) {
      const id = ++nextId
      timers.set(id, fn)
      return id
    },
    cancelTimer (id) { timers.delete(id) },
    get size () { return timers.size },
    async fire () {
      const entry = timers.entries().next().value
      if (!entry) return false
      const [id, fn] = entry
      timers.delete(id)
      await fn()
      return true
    }
  }
}

async function workerFixture (t) {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-worker-result-'))
  const cores = new Corestore(dir)
  await cores.ready()
  const bee = new Hyperbee(cores.get({ name: 'coordination' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
  const bytes = b4a.from('verified worker result retained across transport failure')
  const reader = createBufferSourceReader(bytes)
  const identity = { kind: 'sha256', value: createHash('sha256').update(bytes).digest('hex') }
  const asset = await writeStaticAsset({ store: cores, reader })
  const clock = { current: 1_000_000, generation: 1 }
  const now = () => clock.current
  const durableStore = createAcquisitionStore({ bee, now })
  const scheduler = manualScheduler()
  const job = {
    acquisitionId: 'worker-result-retry',
    principalId: 'worker-acquisition',
    state: 'verified',
    committedBytes: 0,
    verifiedAsset: normalizeAssetCoreRefV2(asset.descriptor),
    expectedIdentity: identity
  }
  const store = { ...durableStore, async get () { return { ...job } } }
  await store.saveCoordination(job.acquisitionId, {
    schemaVersion: 1,
    role: 'worker',
    phase: 'assigned',
    requestId: '11'.repeat(32),
    offerId: '22'.repeat(32),
    assignmentId: '33'.repeat(32),
    peerId: '44'.repeat(32),
    requesterId: '55'.repeat(32),
    acquirerId: '66'.repeat(32),
    publisherId: '77'.repeat(32),
    publicationIntentDigest: '88'.repeat(32),
    epoch: 1,
    deadline: clock.current + 60_000,
    resultHoldUntil: clock.current + 120_000,
    budget: { maxSourceBytes: 1024, maxOutputBytes: 1024, maxNetworkBytes: 2048, maxWallClockMs: 60_000 },
    result: null,
    error: null
  })
  const attempts = []
  const delivered = []
  const faults = { hold: false, send: false, unavailable: false, holdGate: null, sendGate: null }
  let held = false
  let restored = false
  const network = {
    async restoreAssignment () { restored = true },
    async holdVerifiedAsset () {
      if (!restored) throw new Error('assignment must be restored before holding')
      if (faults.holdGate) {
        faults.holdGate.entered.resolve()
        await faults.holdGate.release.promise
      }
      if (faults.hold) throw new Error('hold unavailable')
      if (!b4a.equals(await asset.core.get(0), bytes)) throw new Error('verified bytes unavailable')
      held = true
    },
    async result (result) {
      if (!held) throw new Error('result cannot precede custody')
      held = false
      attempts.push(structuredClone(result))
      if (faults.sendGate) {
        faults.sendGate.entered.resolve()
        await faults.sendGate.release.promise
      }
      if (faults.send) throw new Error('transport unavailable')
      if (faults.unavailable) return { delivery: { sent: 0 } }
      delivered.push(structuredClone(result))
      return { delivery: { sent: 1 } }
    },
    async cancel () {}
  }
  const forbidden = () => { throw new Error('result retry must not acquire or publish') }
  const coordinator = createAcquisitionCoordinator({
    store,
    policy: { networkTerms: () => ({ generation: clock.generation }) },
    provider: { acquire: forbidden },
    publisher: { publish: forbidden },
    network,
    now,
    schedule: scheduler.schedule,
    cancelTimer: scheduler.cancelTimer
  })
  t.teardown(async () => {
    await coordinator.close()
    await asset.core.close()
    await bee.close()
    await cores.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    coordinator, store, scheduler, clock, job, faults, network, attempts, delivered,
    freshStore: () => createAcquisitionStore({ bee, now }),
    notify: () => coordinator.managerNetwork.result({ acquisitionId: job.acquisitionId, job }),
    coord: () => store.getCoordination(job.acquisitionId)
  }
}

test('worker result send failure retries the identical durable result in the same coordinator', async t => {
  const f = await workerFixture(t)
  f.faults.send = true
  await t.exception(f.notify(), /transport unavailable/)
  const pending = await f.coord()
  t.is(pending.phase, 'result-ready')
  t.is(f.delivered.length, 0)
  t.is(f.scheduler.size, 1)
  f.clock.current += 2000
  f.faults.send = false
  await f.scheduler.fire()
  t.alike(f.attempts[1], f.attempts[0], 'retry keeps completion time, identity and exact asset commitment')
  t.alike(f.delivered, [f.attempts[0]])
  t.alike((await f.coord()).result, pending.result)
  t.is((await f.coord()).error, null)
  t.is(f.scheduler.size, 0, 'successful delivery does not rearm')
  await f.notify()
  t.is(f.attempts.length, 2, 'late duplicate notification does not resend a delivered attempt')
})

test('failed custody emits no worker result and recovers without another manager notification', async t => {
  const f = await workerFixture(t)
  f.faults.hold = true
  await t.exception(f.notify(), /hold unavailable/)
  t.is(f.attempts.length, 0)
  t.is((await f.coord()).phase, 'result-ready')
  f.faults.hold = false
  await f.scheduler.fire()
  t.is(f.delivered.length, 1)
  t.is(f.scheduler.size, 0)
})

test('missing result transport persists work and zero-recipient delivery remains retryable', async t => {
  const f = await workerFixture(t)
  f.coordinator.attachNetwork(null)
  await t.exception(f.notify(), { code: 'COORDINATION_NETWORK_UNAVAILABLE' })
  t.is((await f.coord()).phase, 'result-ready')
  f.coordinator.attachNetwork(f.network)
  f.faults.unavailable = true
  await f.scheduler.fire()
  t.is(f.delivered.length, 0)
  t.is(f.scheduler.size, 1)
  f.faults.unavailable = false
  await f.scheduler.fire()
  t.is(f.delivered.length, 1)
  t.alike(f.attempts[1], f.attempts[0])
  t.is(f.scheduler.size, 0)
})

for (const stop of ['cancelled', 'failed', 'committed', 'policy', 'expired']) {
  test(`worker result retry stops after ${stop} while custody is in flight`, async t => {
    const f = await workerFixture(t)
    f.faults.send = true
    await t.exception(f.notify(), /transport unavailable/)
    f.faults.send = false
    const gate = { entered: deferred(), release: deferred() }
    f.faults.holdGate = gate
    const pass = f.scheduler.fire()
    await gate.entered.promise
    if (stop === 'cancelled') await f.coordinator.managerNetwork.cancel({ acquisitionId: f.job.acquisitionId })
    if (stop === 'failed') await f.store.saveCoordination(f.job.acquisitionId, { ...await f.coord(), phase: 'failed' })
    if (stop === 'committed') f.job.committedBytes = f.job.verifiedAsset.byteLength
    if (stop === 'policy') f.clock.generation++
    if (stop === 'expired') f.clock.current = (await f.coord()).result.availabilityUntil
    gate.release.resolve()
    await pass
    t.is(f.attempts.length, 1, 'no result after the asynchronous custody boundary invalidates work')
    t.is(f.delivered.length, 0)
    t.is(f.scheduler.size, 0)
    if (stop === 'policy') t.is((await f.coord()).phase, 'cancelled')
    if (stop === 'expired') {
      const coord = await f.coord()
      t.is(coord.phase, 'failed')
      t.is(coord.error?.code, 'COORDINATION_RESULT_EXPIRED')
      t.alike(await f.store.listActiveCoordinations(), [])
    }
  })
}

test('retry passes never overlap and close drains a blocked send without rearming', async t => {
  const f = await workerFixture(t)
  f.faults.send = true
  await t.exception(f.notify(), /transport unavailable/)
  const gate = { entered: deferred(), release: deferred() }
  f.faults.sendGate = gate
  const pass = f.scheduler.fire()
  await gate.entered.promise
  t.is(f.scheduler.size, 0, 'no timer exists while the pass is running')
  t.is(await f.scheduler.fire(), false, 'another clock tick cannot overlap the pass')
  let closed = false
  const closing = f.coordinator.close().then(() => { closed = true })
  await Promise.resolve()
  t.is(closed, false, 'close waits for the in-flight result send')
  gate.release.resolve()
  await Promise.all([pass, closing])
  t.is(f.attempts.length, 2)
  t.is(f.delivered.length, 0)
  t.is(f.scheduler.size, 0)
})

test('close clears queued retry and invalidates a blocked custody operation', async t => {
  const f = await workerFixture(t)
  f.faults.send = true
  await t.exception(f.notify(), /transport unavailable/)
  await f.coordinator.close()
  t.is(f.scheduler.size, 0)
  t.is(await f.scheduler.fire(), false)

  const g = await workerFixture(t)
  const gate = { entered: deferred(), release: deferred() }
  g.faults.holdGate = gate
  const notification = g.notify()
  await gate.entered.promise
  const closing = g.coordinator.close()
  gate.release.resolve()
  await Promise.all([notification, closing])
  t.is(g.attempts.length, 0)
  t.is(g.scheduler.size, 0)
})

test('worker result hold expiry terminalizes pending record and does not reappear or send across restart', async t => {
  const f = await workerFixture(t)
  f.faults.send = true
  await t.exception(f.notify(), /transport unavailable/)
  const pending = await f.coord()
  t.is(pending.phase, 'result-ready')
  t.is(pending.error?.code, 'COORDINATION_RESULT_PENDING')
  t.is((await f.store.listActiveCoordinations()).length, 1)
  t.is(f.scheduler.size, 1)

  // Advance exactly to availabilityUntil
  f.clock.current = pending.result.availabilityUntil
  f.faults.send = false
  await f.scheduler.fire()

  const expired = await f.coord()
  t.is(expired.phase, 'failed')
  t.is(expired.error?.code, 'COORDINATION_RESULT_EXPIRED')
  t.alike(expired.result, pending.result, 'result history is preserved')
  t.is(f.scheduler.size, 0, 'no retry is rearmed')
  t.alike(await f.store.listActiveCoordinations(), [], 'removed from listActiveCoordinations')
  t.is(f.attempts.length, 1, 'no further send attempted after expiry')
  t.is(f.delivered.length, 0)


  // Instantiate a fresh controller over the persisted store and show expired active work does not reappear or send
  await f.coordinator.close()
  const freshStore = f.freshStore()
  const freshCoordinator = createAcquisitionCoordinator({
    store: freshStore,
    policy: { networkTerms: () => ({ generation: f.clock.generation }) },
    provider: { acquire: () => { throw new Error('must not acquire') } },
    publisher: { publish: () => { throw new Error('must not publish') } },
    network: f.network,
    now: () => f.clock.current,
    schedule: f.scheduler.schedule,
    cancelTimer: f.scheduler.cancelTimer
  })
  await freshCoordinator.start()

  t.alike(await freshStore.listActiveCoordinations(), [], 'remains absent from listActiveCoordinations on fresh start')
  t.is(f.attempts.length, 1, 'fresh controller does not send expired work')
  const afterStart = await freshStore.getCoordination(f.job.acquisitionId)
  t.is(afterStart.phase, 'failed')
  t.is(afterStart.error?.code, 'COORDINATION_RESULT_EXPIRED')
  await freshCoordinator.close()
})

test('fresh coordinator start reconciles unexpired persisted pending result into expired terminal state without sending', async t => {
  const f = await workerFixture(t)
  f.faults.send = true
  await t.exception(f.notify(), /transport unavailable/)

  // Still active and pending before closing
  t.is((await f.coord()).phase, 'result-ready')
  t.is((await f.coord()).error?.code, 'COORDINATION_RESULT_PENDING')
  t.is((await f.store.listActiveCoordinations()).length, 1)

  // Stop coordinator before expiry
  await f.coordinator.close()

  // Advance clock exactly to availabilityUntil while coordinator is offline
  const availabilityUntil = (await f.coord()).result.availabilityUntil
  f.clock.current = availabilityUntil
  f.faults.send = false

  // Start fresh coordinator
  const freshStore = f.freshStore()
  const freshCoordinator = createAcquisitionCoordinator({
    store: freshStore,
    policy: { networkTerms: () => ({ generation: f.clock.generation }) },
    provider: { acquire: () => { throw new Error('must not acquire') } },
    publisher: { publish: () => { throw new Error('must not publish') } },
    network: f.network,
    now: () => f.clock.current,
    schedule: f.scheduler.schedule,
    cancelTimer: f.scheduler.cancelTimer
  })
  await freshCoordinator.start()

  t.alike(await freshStore.listActiveCoordinations(), [], 'reconciliation terminalizes and purges expired pending result')
  t.is(f.attempts.length, 1, 'reconciliation does not send expired result')
  const reconciled = await freshStore.getCoordination(f.job.acquisitionId)
  t.is(reconciled.phase, 'failed')
  t.is(reconciled.error?.code, 'COORDINATION_RESULT_EXPIRED')
  await freshCoordinator.close()
})

test('cancellation race during in-flight hold expiry retains cancellation phase over expired failure', async t => {
  const f = await workerFixture(t)
  f.faults.send = true
  await t.exception(f.notify(), /transport unavailable/)
  f.faults.send = false

  const gate = { entered: deferred(), release: deferred() }
  f.faults.holdGate = gate
  const pass = f.scheduler.fire()
  await gate.entered.promise

  // While custody hold is blocked, advance to availabilityUntil AND cancel concurrently
  f.clock.current = (await f.coord()).result.availabilityUntil
  await f.coordinator.managerNetwork.cancel({ acquisitionId: f.job.acquisitionId })

  // Ensure cancellation was durably written as 'cancelled'
  t.is((await f.coord()).phase, 'cancelled')
  t.is((await f.coord()).error?.code, 'CANCELLED')

  // Release custody hold gate
  gate.release.resolve()
  await pass

  // Coordination must still be 'cancelled' - expiry must never overwrite cancellation
  const finalCoord = await f.coord()
  t.is(finalCoord.phase, 'cancelled')
  t.is(finalCoord.error?.code, 'CANCELLED')
  t.alike(await f.store.listActiveCoordinations(), [], 'cancelled coordination is not active')
  t.is(f.attempts.length, 1)
  t.is(f.delivered.length, 0)
  t.is(f.scheduler.size, 0)
})

test('policy generation change during in-flight hold expiry cancels coordination rather than failing as expired', async t => {
  const f = await workerFixture(t)
  f.faults.send = true
  await t.exception(f.notify(), /transport unavailable/)
  f.faults.send = false

  const gate = { entered: deferred(), release: deferred() }
  f.faults.holdGate = gate
  const pass = f.scheduler.fire()
  await gate.entered.promise

  // While custody hold is blocked, advance to availabilityUntil AND advance policy generation
  f.clock.current = (await f.coord()).result.availabilityUntil
  f.clock.generation++

  // Release gate
  gate.release.resolve()
  await pass

  // Policy change takes precedence over hold expiry
  const finalCoord = await f.coord()
  t.is(finalCoord.phase, 'cancelled')
  t.is(finalCoord.error?.code, 'COORDINATION_POLICY_CHANGED')
  t.alike(await f.store.listActiveCoordinations(), [], 'cancelled coordination is not active')
  t.is(f.attempts.length, 1)
  t.is(f.delivered.length, 0)
  t.is(f.scheduler.size, 0)
})

test('concurrent cancellation during expireWorkerCoordination persistence is preserved via terminal guard', async t => {
  const f = await workerFixture(t)
  f.faults.send = true
  await t.exception(f.notify(), /transport unavailable/)
  f.faults.send = false

  // Intercept store.getCoordination during retry pass to simulate cancellation
  // occurring right after read but before store.saveCoordination in expireWorkerCoordination
  f.clock.current = (await f.coord()).result.availabilityUntil

  const originalGetCoordination = f.store.getCoordination.bind(f.store)
  let cancelled = false
  f.store.getCoordination = async (id) => {
    const result = await originalGetCoordination(id)
    if (!cancelled && result?.phase === 'result-ready') {
      cancelled = true
      // Concurrent cancellation persists first
      await f.coordinator.managerNetwork.cancel({ acquisitionId: id })
    }
    return result
  }

  await f.scheduler.fire()

  const finalCoord = await originalGetCoordination(f.job.acquisitionId)
  t.is(finalCoord.phase, 'cancelled', 'cancellation wins over stale snapshot expiry attempt')
  t.is(finalCoord.error?.code, 'CANCELLED')
  t.alike(await f.store.listActiveCoordinations(), [])
})

test('verified worker reaching the hold boundary before its first result leaves no active coordination', async t => {
  const f = await workerFixture(t)
  const assigned = await f.coord()
  f.clock.current = assigned.resultHoldUntil
  await f.notify()
  const expired = await f.coord()
  t.is(expired.phase, 'failed')
  t.is(expired.error.code, 'COORDINATION_RESULT_EXPIRED')
  t.alike(await f.store.listActiveCoordinations(), [])
  t.is(f.attempts.length, 0)
})

function fakeBee () {
  const map = new Map()
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
  return {
    async get (key) { return map.has(key) ? { value: clone(map.get(key)) } : null },
    batch () {
      const operations = []
      return {
        async put (key, value) { operations.push(['put', key, clone(value)]) },
        async del (key) { operations.push(['del', key]) },
        async flush () { for (const [operation, key, value] of operations) { if (operation === 'put') map.set(key, value); else map.delete(key) } }
      }
    },
    async * createReadStream ({ gte, lt }) {
      for (const key of [...map.keys()].sort()) if (key >= gte && key < lt) yield { key, value: clone(map.get(key)) }
    }
  }
}

function requesterAssignment (acquisitionId, assignmentId) {
  return {
    schemaVersion: 1,
    role: 'requester',
    phase: 'assigned',
    requestId: '11'.repeat(32),
    offerId: '22'.repeat(32),
    assignmentId,
    peerId: '44'.repeat(32),
    requesterId: '55'.repeat(32),
    acquirerId: '66'.repeat(32),
    sourceRef: 'B'.repeat(43),
    publisherId: '77'.repeat(32),
    publicationIntentDigest: '88'.repeat(32),
    budget: { maxSourceBytes: 1024, maxOutputBytes: 1024, maxNetworkBytes: 2048, maxWallClockMs: 60_000 },
    output: { purpose: 'original', formats: ['application/octet-stream'] },
    resultHoldUntil: 1_120_000,
    requestGeneration: 1,
    epoch: 1,
    deadline: 1_060_000,
    progress: null,
    result: null,
    error: null
  }
}

function requesterResult (assignmentId) {
  return {
    assignmentId,
    acquiredBytes: 8,
    completedAt: 1_000_500,
    availabilityUntil: 1_100_000,
    sourceIdentity: { kind: 'sha256', value: 'e'.repeat(64) },
    assets: [{
      purpose: 'original',
      format: 'application/octet-stream',
      renditionId: 'd'.repeat(64),
      core: { kind: 'static-prologue-v1', key: 'a'.repeat(64), assetId: 'b'.repeat(64), treeHash: 'c'.repeat(64), length: 1, byteLength: 8, blockSize: 8 }
    }]
  }
}

test('close aborts a pending requester import and refuses late transferred admission', async t => {
  const store = createAcquisitionStore({ bee: fakeBee(), now: () => 1_000_000 })
  await store.saveCoordination('requester-import-abort', requesterAssignment('requester-import-abort', '33'.repeat(32)))
  await store.saveCoordination('requester-late-admission', requesterAssignment('requester-late-admission', '99'.repeat(32)))
  const acceptCalls = []
  let sawAbort = false
  const manager = {
    async acceptTransferredResult (input) {
      acceptCalls.push(input)
      return await new Promise((resolve, reject) => {
        const abort = () => {
          sawAbort = true
          reject(Object.assign(new Error('requester import aborted'), { code: 'REQUESTER_IMPORT_ABORTED' }))
        }
        if (input.signal?.aborted) abort()
        else if (input.signal?.addEventListener) input.signal.addEventListener('abort', abort, { once: true })
        else setTimeout(() => resolve({ acquisitionId: input.acquisitionId, state: 'completed' }), 5)
      })
    }
  }
  const coordinator = createAcquisitionCoordinator({
    store,
    policy: { networkTerms: () => ({ generation: 1 }) },
    provider: { acquire: () => { throw new Error('must not acquire') } },
    publisher: { publish: () => { throw new Error('must not publish') } },
    now: () => 1_000_000
  })
  coordinator.bindManager(manager)
  const first = coordinator.networkManager.onResult({ result: requesterResult('33'.repeat(32)), peerId: '44'.repeat(32) }).then(() => 'resolved', error => 'rejected:' + error?.code)
  await eventually(() => acceptCalls.length, count => count === 1)
  t.ok(acceptCalls[0].signal, 'a transferred import receives the coordinator-lifetime signal')
  t.is(acceptCalls[0].signal.aborted, false, 'the import starts on a live coordinator')
  const second = coordinator.networkManager.onResult({ result: requesterResult('99'.repeat(32)), peerId: '44'.repeat(32) }).then(() => 'resolved', error => 'rejected:' + error?.code)
  await Promise.resolve()
  await coordinator.close()
  t.is(await first, 'rejected:REQUESTER_IMPORT_ABORTED')
  t.is(sawAbort, true, 'close aborts the pending requester import instead of hanging or completing it')
  t.is(acceptCalls.length, 1, 'admission that resumes after close never reaches the manager')
  t.is(await second, 'resolved')
  const abortedCoord = await store.getCoordination('requester-import-abort')
  t.is(abortedCoord.phase, 'result-ready', 'an aborted import stays durable re-drive work, not completed')
  t.is(abortedCoord.error?.code, 'REQUESTER_IMPORT_ABORTED')
  const lateCoord = await store.getCoordination('requester-late-admission')
  t.is(lateCoord.phase, 'result-ready', 'the refused late admission leaves its result for a future coordinator')
  t.exception(() => coordinator.reconcile(), { code: 'COORDINATION_CLOSED' })
})
