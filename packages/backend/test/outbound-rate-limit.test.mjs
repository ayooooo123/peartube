// The participation policy promises "5 Mbit/s outbound". Until this suite
// existed that number was declared in three places and enforced in none: the
// scoped runtime only ever checked a cumulative per-process total, so a device
// that had sent nothing all day would happily saturate its uplink for a
// gigabyte and then stop. These tests pin the rate itself.
import test from 'brittle'
import { EventEmitter } from 'node:events'
import { Duplex, PassThrough } from 'node:stream'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { createArchivePledge } from '../src/archive/pledge.js'
import { createScopedNetworkRuntime } from '../src/network/scoped-runtime.js'
import { SeedingManager } from '../src/seeding.js'
import { createBudgetManager } from '../src/budget-manager.js'
import { DEFAULT_POLICY } from '../src/universal-core-utils.js'

const BLOCK_BYTES = 128 * 1024
// The bucket never holds less than one maximal block, so a rate at that floor
// makes capacity exactly two of our blocks and the arithmetic readable.
const RATE_BYTES_PER_SECOND = 256 * 1024
const CAPACITY_BYTES = 256 * 1024
const PLEDGE_CEILING_BYTES = 16 * BLOCK_BYTES
const UPLOAD_CEILING_BYTES = 64 * BLOCK_BYTES

function bytes (size, fill) {
  return b4a.alloc(size, fill)
}

function connectionPair ({ sourcePeerFill = 202, consumerPeerFill = 201 } = {}) {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const a = Duplex.from({ readable: bToA, writable: aToB })
  const b = Duplex.from({ readable: aToB, writable: bToA })
  a.userData = null
  b.userData = null
  a.remotePublicKey = bytes(32, consumerPeerFill)
  b.remotePublicKey = bytes(32, sourcePeerFill)
  return { a, b }
}

function fakeSwarm () {
  const swarm = new EventEmitter()
  swarm.connections = new Set()
  swarm.joins = []
  swarm.join = (topic, options) => {
    const handle = {
      topic: b4a.from(topic),
      options,
      destroyed: 0,
      flushed: async () => {},
      destroy () { this.destroyed++ },
      suspended: 0,
      resumed: 0,
      async suspend () { this.suspended++ },
      async resume () { this.resumed++ },
    }
    swarm.joins.push(handle)
    return handle
  }
  return swarm
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

// A clock and a refill scheduler the test owns outright: no wall-clock waiting,
// and a deferred send only resumes when the test says time has passed.
function fakeSchedule () {
  const pending = []
  return {
    ms: 1000,
    pending,
    now () { return this.ms },
    advance (delta) { this.ms += delta },
    setTimer (fn, delay) {
      pending.push({ fn, delay })
      return { unref () {} }
    },
    // Fire every armed refill and let the resumed sends run to completion.
    async fire () {
      const armed = pending.splice(0, pending.length)
      for (const timer of armed) timer.fn()
      await settle()
      return armed
    },
  }
}

function archiveFixture ({ blockCount = 4, fill = 90 } = {}) {
  const archivist = crypto.keyPair(bytes(32, fill))
  const coreKey = bytes(32, fill + 1)
  const sourceBlocks = new Map()
  for (let index = 0; index < blockCount; index++) {
    sourceBlocks.set(index, bytes(BLOCK_BYTES, index + 1))
  }
  const received = new Map()
  const pledge = createArchivePledge({
    archivistId: archivist.publicKey,
    publicationId: bytes(32, fill + 2),
    renditionId: bytes(32, fill + 3),
    ranges: [{ coreKey, start: 0, end: blockCount }],
    retentionUntil: 10_000_000,
    issuedAt: 10,
    uploadCeilingBytes: PLEDGE_CEILING_BYTES,
    keyPair: archivist,
  })
  const sourceCore = {
    key: coreKey,
    length: blockCount,
    async ready () {},
    async has (index) { return sourceBlocks.has(index) },
    async proof ({ block }) {
      return {
        fork: 0,
        block: { index: block.index, value: sourceBlocks.get(block.index), nodes: [] },
        hash: null,
        seek: null,
        upgrade: null,
        manifest: null,
      }
    },
    download () { return { destroy () {} } },
    async close () {},
  }
  const targetCore = {
    key: coreKey,
    length: blockCount,
    async ready () {},
    async has (index) { return received.has(index) },
    async applyProof (proof) {
      received.set(proof.block.index, b4a.from(proof.block.value))
      return true
    },
    download () { return { destroy () {} } },
    async close () {},
  }
  return { archivist, coreKey, blockCount, pledge, sourceCore, targetCore, received }
}

async function connectArchivePair (fixture, { schedule, sourcePolicy }) {
  const swarmA = fakeSwarm()
  const swarmB = fakeSwarm()
  const source = createScopedNetworkRuntime({
    swarm: swarmA,
    store: { get: () => fixture.sourceCore },
    now: () => schedule.now(),
    setOutboundRateTimer: (fn, delay) => schedule.setTimer(fn, delay),
    initialNetworkPolicy: {
      networkEnabled: true,
      uploadPermission: 'enabled',
      uploadCeilingBytes: UPLOAD_CEILING_BYTES,
      archiveBudgetBytes: UPLOAD_CEILING_BYTES,
      diskCeilingBytes: 64 * 1024 * 1024,
      permissions: { archive: true },
      publicServingAllowed: true,
      ...sourcePolicy,
    },
  })
  const consumer = createScopedNetworkRuntime({
    swarm: swarmB,
    store: { get: () => fixture.targetCore },
    now: () => schedule.now(),
    initialNetworkPolicy: {
      networkEnabled: true,
      uploadPermission: 'enabled',
      uploadCeilingBytes: UPLOAD_CEILING_BYTES,
      archiveBudgetBytes: UPLOAD_CEILING_BYTES,
      diskCeilingBytes: 64 * 1024 * 1024,
      permissions: { archive: true },
      publicServingAllowed: true,
    },
  })
  await source.start()
  await consumer.start()
  const pair = connectionPair()
  swarmA.connections.add(pair.a)
  swarmB.connections.add(pair.b)
  swarmA.emit('connection', pair.a, { publicKey: pair.a.remotePublicKey })
  swarmB.emit('connection', pair.b, { publicKey: pair.b.remotePublicKey })
  await settle()
  const retain = { pledge: fixture.pledge, coreKey: fixture.coreKey, start: 0, end: fixture.blockCount }
  await source.retainAuthorizedArchive(retain)
  await consumer.retainAuthorizedArchive(retain)
  for (let attempt = 0; attempt < 20 && schedule.pending.length === 0; attempt++) await settle()
  return { source, consumer }
}

test('the outbound rate throttles a sender the cumulative ceiling would wave through', async (t) => {
  const fixture = archiveFixture({ fill: 90 })
  const schedule = fakeSchedule()
  const { source, consumer } = await connectArchivePair(fixture, {
    schedule,
    sourcePolicy: { outboundBytesPerSecond: RATE_BYTES_PER_SECOND },
  })
  t.teardown(async () => {
    await source.close()
    await consumer.close()
  })

  const served = () => [...fixture.received.keys()].sort((left, right) => left - right)
  const servedBytes = () => [...fixture.received.values()].reduce((sum, value) => sum + value.byteLength, 0)
  t.alike(served(), [0, 1], 'the burst stops at one bucket of tokens, not at the daily ceiling')
  t.is(servedBytes(), CAPACITY_BYTES, 'exactly one bucket of bytes reached the peer')
  t.ok(
    source.getDiagnostics().policy.uploadedBytes < UPLOAD_CEILING_BYTES,
    'the cumulative ceiling had 61 blocks of headroom left, so only the rate can have stopped this',
  )
  t.is(schedule.pending.length, 1, 'the third block is deferred, not refused')
  t.is(schedule.pending[0].delay, 500, 'half a second buys back one 128 KiB block at 256 KiB/s')

  // Firing the refill without moving the clock must not mint anything.
  await schedule.fire()
  t.alike(served(), [0, 1], 'a timer that fires early earns no tokens')

  schedule.advance(1000)
  await schedule.fire()
  t.alike(served(), [0, 1, 2, 3], 'one second of refill releases exactly one bucket more')
  t.is(servedBytes(), 2 * CAPACITY_BYTES, 'a second of refill is worth exactly a second of bytes')
  t.is(source.getDiagnostics().policy.uploadedBytes, 2 * CAPACITY_BYTES)
})

test('a zero outbound rate serves no content bytes however much ceiling is left', async (t) => {
  const fixture = archiveFixture({ fill: 100 })
  const schedule = fakeSchedule()
  const { source, consumer } = await connectArchivePair(fixture, {
    schedule,
    sourcePolicy: { outboundBytesPerSecond: 0 },
  })
  t.teardown(async () => {
    await source.close()
    await consumer.close()
  })

  for (let attempt = 0; attempt < 10; attempt++) await settle()
  const policy = source.getDiagnostics().policy
  t.is(policy.uploadAllowed, true, 'upload permission and ceiling both say yes')
  t.is(policy.outboundBytesPerSecond, 0)
  t.is(policy.outboundRateEnforced, true)
  t.is(policy.uploadedBytes, 0, 'and still not one content byte leaves')
  t.is(fixture.received.size, 0)
  t.is(schedule.pending.length, 0, 'zero is a refusal, not a wait that can ever end')
})

test('an absent outbound rate leaves the enforced limit exactly where it was', async (t) => {
  const swarm = fakeSwarm()
  const schedule = fakeSchedule()
  const runtime = createScopedNetworkRuntime({
    swarm,
    store: { get: () => null },
    now: () => schedule.now(),
    setOutboundRateTimer: (fn, delay) => schedule.setTimer(fn, delay),
    initialNetworkPolicy: {
      networkEnabled: true,
      uploadPermission: 'enabled',
      uploadCeilingBytes: UPLOAD_CEILING_BYTES,
      diskCeilingBytes: 1024,
      outboundBytesPerSecond: RATE_BYTES_PER_SECOND,
    },
  })
  t.teardown(() => runtime.close())

  const applied = await runtime.applyNetworkPolicy({
    networkEnabled: true,
    uploadPermission: 'enabled',
    uploadCeilingBytes: UPLOAD_CEILING_BYTES,
    diskCeilingBytes: 2048,
  })
  t.is(applied.outboundBytesPerSecond, RATE_BYTES_PER_SECOND, 'a disk-only update does not uncap the uplink')
  t.is(applied.outboundRateEnforced, true)
  t.is(runtime.getDiagnostics().policy.outboundBytesPerSecond, RATE_BYTES_PER_SECOND)

  const lowered = await runtime.applyNetworkPolicy({
    networkEnabled: true,
    uploadPermission: 'enabled',
    uploadCeilingBytes: UPLOAD_CEILING_BYTES,
    diskCeilingBytes: 2048,
    outboundBytesPerSecond: 125_000,
  })
  t.is(lowered.outboundBytesPerSecond, 125_000, 'a supplied rate is honoured')

  await t.exception(() => runtime.applyNetworkPolicy({
    networkEnabled: true,
    uploadPermission: 'enabled',
    uploadCeilingBytes: UPLOAD_CEILING_BYTES,
    diskCeilingBytes: 2048,
    outboundBytesPerSecond: -1,
  }), /invalid outbound rate/)

  const unrated = createScopedNetworkRuntime({
    swarm: fakeSwarm(),
    store: { get: () => null },
    initialNetworkPolicy: {
      networkEnabled: true,
      uploadPermission: 'enabled',
      uploadCeilingBytes: UPLOAD_CEILING_BYTES,
      diskCeilingBytes: 1024,
    },
  })
  t.teardown(() => unrated.close())
  t.is(unrated.getDiagnostics().policy.outboundBytesPerSecond, null, 'no declared rate is reported as no rate')
  t.is(unrated.getDiagnostics().policy.outboundRateEnforced, false, 'and never as an enforced one')
})

test('a rate that survives a policy round trip still throttles the wire', async (t) => {
  const fixture = archiveFixture({ fill: 110 })
  const schedule = fakeSchedule()
  const swarmA = fakeSwarm()
  const swarmB = fakeSwarm()
  const source = createScopedNetworkRuntime({
    swarm: swarmA,
    store: { get: () => fixture.sourceCore },
    now: () => schedule.now(),
    setOutboundRateTimer: (fn, delay) => schedule.setTimer(fn, delay),
    initialNetworkPolicy: {
      networkEnabled: true,
      uploadPermission: 'enabled',
      uploadCeilingBytes: UPLOAD_CEILING_BYTES,
      archiveBudgetBytes: UPLOAD_CEILING_BYTES,
      diskCeilingBytes: 64 * 1024 * 1024,
      permissions: { archive: true },
      publicServingAllowed: true,
      outboundBytesPerSecond: RATE_BYTES_PER_SECOND,
    },
  })
  const consumer = createScopedNetworkRuntime({
    swarm: swarmB,
    store: { get: () => fixture.targetCore },
    now: () => schedule.now(),
    initialNetworkPolicy: {
      networkEnabled: true,
      uploadPermission: 'enabled',
      uploadCeilingBytes: UPLOAD_CEILING_BYTES,
      archiveBudgetBytes: UPLOAD_CEILING_BYTES,
      diskCeilingBytes: 64 * 1024 * 1024,
      permissions: { archive: true },
      publicServingAllowed: true,
    },
  })
  t.teardown(async () => {
    await source.close()
    await consumer.close()
  })
  await source.start()
  await consumer.start()
  // The round trip happens before a single byte moves, so nothing about the
  // bucket's balance can explain the throttle that follows.
  await source.applyNetworkPolicy({
    networkEnabled: true,
    uploadPermission: 'enabled',
    uploadCeilingBytes: UPLOAD_CEILING_BYTES,
    archiveBudgetBytes: UPLOAD_CEILING_BYTES,
    diskCeilingBytes: 32 * 1024 * 1024,
    permissions: { archive: true },
    publicServingAllowed: true,
  })

  const pair = connectionPair({ sourcePeerFill: 212, consumerPeerFill: 211 })
  swarmA.connections.add(pair.a)
  swarmB.connections.add(pair.b)
  swarmA.emit('connection', pair.a, { publicKey: pair.a.remotePublicKey })
  swarmB.emit('connection', pair.b, { publicKey: pair.b.remotePublicKey })
  await settle()
  const retain = { pledge: fixture.pledge, coreKey: fixture.coreKey, start: 0, end: fixture.blockCount }
  await source.retainAuthorizedArchive(retain)
  await consumer.retainAuthorizedArchive(retain)
  for (let attempt = 0; attempt < 20 && schedule.pending.length === 0; attempt++) await settle()

  t.alike([...fixture.received.keys()].sort((left, right) => left - right), [0, 1])
  t.is(schedule.pending.length, 1, 'the limit carried through the update and still defers the third block')
})

function seedingHarness () {
  const state = new Map()
  const metaDb = {
    async get (key) { return state.has(key) ? { value: state.get(key) } : null },
    async put (key, value) { state.set(key, value) },
  }
  const store = {
    _peartubeStoragePath: '/tmp/peartube-outbound-rate',
    async getDiskUsageBytes () { return 0 },
    get () { return { async ready () {}, async clear () {} } },
  }
  return new SeedingManager(store, metaDb)
}

test('seeding reports an outbound cap only when the transport says it is applying one', async (t) => {
  const manager = seedingHarness()

  const fresh = await manager.getStatus()
  t.is(fresh.contribution.outboundBytesPerSecond, null, 'a manager nobody has told anything advertises no cap')
  t.is(fresh.contribution.outboundRateEnforced, false)

  // A rate asked for but not confirmed by the enforcer is not a rate.
  await manager.applyNetworkPolicy({
    diskCeilingBytes: 20 * 1024 * 1024 * 1024,
    uploadAllowed: true,
    outboundBytesPerSecond: 625_000,
  })
  const unconfirmed = await manager.getStatus()
  t.is(unconfirmed.contribution.uploadAllowed, true)
  t.is(unconfirmed.contribution.outboundBytesPerSecond, null, 'an unenforced 5 Mbit/s is not advertised as a cap')
  t.is(unconfirmed.contribution.outboundRateEnforced, false)

  const confirmed = await manager.applyNetworkPolicy({
    diskCeilingBytes: 20 * 1024 * 1024 * 1024,
    uploadAllowed: true,
    outboundBytesPerSecond: 625_000,
    outboundRateEnforced: true,
  })
  t.is(confirmed.outboundBytesPerSecond, 625_000)
  t.is(confirmed.outboundRateEnforced, true)
  t.is((await manager.getStatus()).contribution.outboundBytesPerSecond, 625_000)

  // Zero is a real enforced cap, not a missing one.
  await manager.applyNetworkPolicy({
    diskCeilingBytes: 20 * 1024 * 1024 * 1024,
    uploadAllowed: false,
    outboundBytesPerSecond: 0,
    outboundRateEnforced: true,
  })
  const stopped = await manager.getStatus()
  t.is(stopped.contribution.outboundBytesPerSecond, 0)
  t.is(stopped.contribution.outboundRateEnforced, true)
  t.is(stopped.contribution.uploadAllowed, false)
})

test('the budget manager states no second opinion on what this device may contribute', (t) => {
  const mobile = createBudgetManager({ role: 'mobile' }).budgetFor({ batteryPercent: 100, bandwidthScore: 100 })

  // A ceiling nothing enforces is a ceiling that will be believed. The upload
  // budget belongs to the participation decision and is applied by the
  // transport; a scheduler for background work must not publish a rival copy.
  t.absent('maxOutboundBytesPerSecond' in mobile, 'no rival outbound rate')
  t.absent('uploadAllowed' in mobile, 'no rival upload verdict')
  t.absent('uploadCeilingBytesPer24h' in mobile, 'no rival 24h contribution ceiling')
  t.is(mobile.maxBytesPerDay, DEFAULT_POLICY.mobile.maxBytesPerDay, 'the daily figure is the role profile, not a participation preset')

  // And the numeric battery/thermal inputs only move scheduling.
  const hot = createBudgetManager({ role: 'mobile' }).budgetFor({ batteryPercent: 5, thermalScore: 90, bandwidthScore: 2 })
  t.is(hot.canSync, false, 'a flat, hot, throttled phone stops scheduling its own background work')
  t.is(hot.maxBytesPerDay, DEFAULT_POLICY.mobile.maxBytesPerDay, 'but says nothing new about contribution')
})
