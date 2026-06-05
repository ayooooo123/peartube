import test from 'node:test'
import assert from 'node:assert/strict'

import { readFile } from 'node:fs/promises'

import { createUniversalCore } from '../src/universal-core.js'
import { createBudgetManager, decodeBudgetState, encodeBudgetState } from '../src/budget-manager.js'
import { createPeerScorer, decodePeerMetric, encodePeerMetric } from '../src/peer-scorer.js'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('universal core lifecycle calls are serialized and lifecycle events use final state labels', async () => {
  const events = []
  const releaseStart = deferred()
  const core = createUniversalCore({
    platform: 'mobile',
    storagePath: '/tmp/peartube-universal-core-test',
    onEvent: (event) => events.push(event),
    loadNativeModules: async () => ({
      libhc: {
        async create() {
          return {
            async start() { await releaseStart.promise },
            async flush() {},
            async suspend() {},
            async shutdown() {},
          }
        },
      },
    }),
    createBackendContext: async () => ({
      ctx: { metaDb: { async get() { return null }, async put() {} } },
    }),
    createGossipService: () => ({}),
    createMirrorSeedWorker: () => ({}),
    createStorageService: () => ({}),
  })

  await core.init()
  const startPromise = core.start()
  await new Promise((resolve) => setImmediate(resolve))
  const suspendPromise = core.suspend()
  assert.equal(core.state, 'starting')
  releaseStart.resolve()
  await Promise.all([startPromise, suspendPromise])
  assert.equal(core.state, 'suspended')

  const started = events.find((event) => event.event === 'autobase:event' && event.detail?.type === 'core.started')
  const suspended = events.find((event) => event.event === 'autobase:event' && event.detail?.type === 'core.suspended')
  assert.equal(started?.detail?.payload?.state, 'started')
  assert.equal(suspended?.detail?.payload?.state, 'suspended')
})

test('native handle init rolls back already-created handles when later native init fails', async () => {
  const calls = []
  const core = createUniversalCore({
    platform: 'desktop',
    storagePath: '/tmp/peartube-universal-core-test',
    loadNativeModules: async () => ({
      libhc: {
        async create() {
          return {
            async init() { calls.push('hc:init') },
            async flush() { calls.push('hc:flush') },
            async rollback() { calls.push('hc:rollback') },
            async shutdown() { calls.push('hc:shutdown') },
          }
        },
      },
      libkv: {
        async create() {
          return {
            async init() { calls.push('kv:init'); throw new Error('kv boom') },
          }
        },
      },
    }),
    createBackendContext: async () => ({ ctx: {} }),
  })

  await assert.rejects(() => core.init(), /kv boom/)
  assert.deepEqual(calls, ['hc:init', 'kv:init', 'hc:rollback', 'hc:shutdown'])
})

test('autobase sink serializes high-concurrency appends without snapshot overwrite', async () => {
  const store = new Map()
  const puts = []
  const core = createUniversalCore({
    platform: 'relay',
    storagePath: '/tmp/peartube-universal-core-test',
    createBackendContext: async () => ({
      ctx: {
        metaDb: {
          async get(key) { return store.has(key) ? { value: store.get(key) } : null },
          async put(key, value) { puts.push([key, value]); store.set(key, value) },
        },
      },
    }),
    createGossipService: () => ({}),
    createMirrorSeedWorker: () => ({}),
    createStorageService: () => ({}),
  })

  await core.init()
  await Promise.all(Array.from({ length: 32 }, (_, index) => core.eventSink.append('test.concurrent', { index })))
  const snapshot = core.eventSink.snapshot().current
  assert.equal(snapshot.lastSeq, 33)
  assert.equal(new Set(snapshot.recent.map((item) => item.seq)).size, snapshot.recent.length)
  assert.equal(puts.some(([key]) => key === 'universal-core:snapshot'), true)
})

test('playback contexts isolate host surfaces and reject shorts pip surfaces', async () => {
  const core = createUniversalCore({
    platform: 'mobile',
    storagePath: '/tmp/peartube-universal-core-test',
    createBackendContext: async () => ({ ctx: {} }),
    createGossipService: () => ({}),
    createMirrorSeedWorker: () => ({}),
    createStorageService: () => ({}),
  })
  await core.init()
  await core.start()

  const main = await core.playback.acquire('main', { hostSurfaceId: 'native-video-1', allowPiP: true })
  assert.equal(main.granted, true)
  const shortsCollision = await core.playback.acquire('shorts', { hostSurfaceId: 'native-video-1' })
  assert.equal(shortsCollision.granted, false)
  assert.match(shortsCollision.reason, /owned by main/)
  await core.playback.release(main.context)

  const shortsPip = await core.playback.acquire('shorts', { hostSurfaceId: 'shorts-native', pictureInPicture: true })
  assert.equal(shortsPip.granted, false)
  assert.match(shortsPip.reason, /PiP-capable/)
})

test('mirror refresh guard skips overlapping runs instead of mutating seeding state concurrently', async () => {
  const release = deferred()
  let addSeedCalls = 0
  const events = []
  const core = createUniversalCore({
    platform: 'relay',
    storagePath: '/tmp/peartube-universal-core-test',
    onEvent: (event) => events.push(event),
    createBackendContext: async () => ({
      ctx: {},
      publicFeed: { getFeed: () => [{ driveKey: 'drive', source: 'local', previewVideos: [{ videoPath: 'video.mp4' }] }] },
      seedingManager: {
        getActiveSeeds: () => [],
        getPinnedChannels: () => [],
        async pinChannel() {},
        async addSeed() { addSeedCalls += 1; await release.promise; return true },
        async getStatus() { return { activeSeeds: addSeedCalls } },
      },
    }),
    createGossipService: () => ({}),
    createStorageService: () => ({}),
  })

  await core.init()
  const first = core.services.mirrorSeed.refresh('first')
  const second = await core.services.mirrorSeed.refresh('second')
  assert.equal(second.skipped, true)
  assert.equal(second.why, 'refresh already in flight')
  release.resolve()
  await first
  assert.equal(addSeedCalls, 1)
})

test('peer scorer persists compact performance metrics and updates reactive scores', async () => {
  const puts = []
  const state = { peers: new Map() }
  const scorer = createPeerScorer({
    state,
    availability: { shouldAdmit: () => true },
    resources: { profile: { maxFanout: 8 }, budgetFor: () => ({ credit: 80 }) },
    persist: async (key, value) => puts.push([key, value]),
  })
  const updates = []
  scorer.subscribe((_peerId, record) => updates.push(record.score))

  const peer = scorer.registerPeer({ peerId: 'peer-a', identity: { validProofCount: 2 }, descriptor: { descriptorId: 'feed-a' } })
  await scorer.recordPerformance(peer.peerId, {
    latencyMs: 40,
    handshakeSuccesses: 4,
    handshakes: 4,
    udxThroughputBps: 1024 * 1024,
  })

  assert.equal(puts.length, 1)
  assert.equal(puts[0][0], 'universal-core:peer-metric:peer-a')
  assert.equal(puts[0][1] instanceof Uint8Array, true)
  assert.equal(decodePeerMetric(puts[0][1]).udxThroughputBps, 1024 * 1024)
  assert.equal(updates.length > 0, true)
  assert.equal(state.peers.get('peer-a').performance.udxThroughputBps, 1024 * 1024)
})

test('budget manager derives dynamic peer/feed caps from bare-hc memory pressure', async () => {
  const manager = createBudgetManager({
    role: 'relay',
    bareHc: { memoryStats: async () => ({ total: 1000, rss: 900 }) },
  })

  const refreshed = await manager.refreshMemoryStats()
  assert.equal(refreshed.thresholds.memoryPressure, 90)
  assert.equal(refreshed.thresholds.maxFanout < manager.profile.maxFanout, true)
  assert.equal(refreshed.thresholds.maxFeedEntries < manager.profile.maxFeedEntries, true)

  const encoded = encodeBudgetState(refreshed.thresholds)
  assert.equal(encoded instanceof Uint8Array, true)
  assert.equal(decodeBudgetState(encoded).maxFeedEntries, refreshed.thresholds.maxFeedEntries)
})

test('universal core state persistence uses compact buffers and has no legacy gossip polling interval', async () => {
  const puts = []
  const observed = []
  const core = createUniversalCore({
    platform: 'relay',
    storagePath: '/tmp/peartube-universal-core-test',
    createBackendContext: async () => ({ ctx: { metaDb: { async put(key, value) { puts.push([key, value]) } } } }),
  })

  await core.init()
  const unsubscribe = core.eventSink.onappend((record) => observed.push(record))
  await core.eventSink.append('test.compact', { ok: true })
  unsubscribe()
  const snapshotPut = puts.find(([key]) => key === 'universal-core:snapshot')
  assert.equal(snapshotPut?.[1] instanceof Uint8Array, true)
  assert.equal(observed.at(-1).kind, 'test.compact')

  const source = await readFile(new URL('../src/universal-core.js', import.meta.url), 'utf8')
  assert.equal(/setInterval\s*\(/.test(source), false)
  assert.equal(/gossip/i.test(source) && /setInterval\s*\(/.test(source), false)
})
