import test from 'node:test'
import assert from 'node:assert/strict'

import { createUniversalCore } from '../src/universal-core.js'

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
