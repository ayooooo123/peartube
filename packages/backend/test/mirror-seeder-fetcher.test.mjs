import test from 'node:test'
import assert from 'node:assert/strict'

import { seedMirroredVideo, createMirrorSeeder } from '../src/mirror/seeder.js'
import { fetchMirrorDescriptor } from '../src/mirror/fetcher.js'

const ZERO_32 = new Uint8Array(32)
const ZERO_64 = new Uint8Array(64)

function fixed(byte, size = 32) {
  return new Uint8Array(size).fill(byte)
}

function descriptor() {
  const now = BigInt(Date.now())
  return {
    version: 1,
    descriptorId: fixed(1),
    contentRoot: fixed(2),
    dasRoot: fixed(3),
    swarmTopic: fixed(4),
    sourceRefHash: fixed(5),
    sourceType: 2,
    mirrorOrigin: 0,
    contentBytes: 1024n,
    segmentCount: 1,
    durationMs: 1000n,
    publishAt: now,
    expiresAt: now + 60_000n,
    availabilityEpoch: Number(now / 600_000n),
    publisherIdentity: fixed(6),
    parentDescriptorId: ZERO_32,
    titleHash: fixed(7),
    descriptionHash: fixed(8),
    languageTag: 'und',
    codecProfile: 0,
    flags: 0,
    signer: fixed(9),
    signature: ZERO_64,
  }
}

function fakeSwarm() {
  return {
    handlers: new Set(),
    join() { return { destroy() {} } },
    on(event, handler) { if (event === 'connection') this.handlers.add(handler) },
    off(event, handler) { if (event === 'connection') this.handlers.delete(handler) },
  }
}

function timersStillActive(timers) {
  return timers.filter((timer) => !timer.cleared).length
}

test('seedMirroredVideo does not append unsigned autobase events after joining swarm', async () => {
  let appended = 0
  const swarm = fakeSwarm()
  const record = await seedMirroredVideo({ append: async () => { appended += 1 } }, swarm, descriptor(), {
    getCore: async () => ({ ready: async () => {}, close: async () => {} }),
  })

  assert.equal(appended, 0)
  assert.equal(swarm.handlers.size, 1)
  await record.close()
  assert.equal(swarm.handlers.size, 0)
})

test('seedMirroredVideo replicates only matching swarm topic once per connection/core pair', async () => {
  const swarm = fakeSwarm()
  const streams = [{ id: 'match' }, { id: 'other-topic' }]
  const replicateCalls = []
  const record = await seedMirroredVideo(null, swarm, descriptor(), {
    getCore: async () => ({
      ready: async () => {},
      close: async () => {},
      replicate(stream) {
        replicateCalls.push(stream.id)
      },
    }),
  })

  try {
    const handler = Array.from(swarm.handlers)[0]
    await handler(streams[1], { topics: [fixed(99)] })
    await handler(streams[0], { topics: [fixed(4)] })
    await handler(streams[0], { topics: [fixed(4)] })

    assert.deepEqual(replicateCalls, ['match'])
  } finally {
    await record.close()
  }
})

test('new seed records do not start immediately key-rotation due', async () => {
  const now = 1_000_000n
  const swarm = fakeSwarm()
  const record = await seedMirroredVideo(null, swarm, descriptor(), {
    now,
    getCore: async () => ({ ready: async () => {}, close: async () => {} }),
  })
  const plan = record.refreshPolicy.plan(record, { now })

  assert.equal(record.lastKeyRotationAt, now)
  assert.equal(plan.shouldRotateSigningKey, false)
  await record.close()
})

test('mirror seeder refresh timer schedules one successor per refresh', async () => {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const scheduled = []
  globalThis.setTimeout = (fn, delay) => {
    const timer = { fn, delay, cleared: false }
    scheduled.push(timer)
    return timer
  }
  globalThis.clearTimeout = (timer) => { timer.cleared = true }

  try {
    const swarm = fakeSwarm()
    const seeder = createMirrorSeeder({ autoRefresh: true, scheduleIdleRefresh: true, intervalMs: 1000, refetchIntervalMs: 1000, keyRotationIntervalMs: 1000 })
    const record = await seeder.register(null, swarm, descriptor(), {
      now: 1_000_000n,
      getCore: async () => ({ ready: async () => {}, close: async () => {} }),
    })
    assert.equal(scheduled.length, 1)

    await scheduled[0].fn()
    assert.equal(scheduled.length, 2)
    seeder.stop()
    assert.equal(timersStillActive(scheduled), 1)
    await record.close()
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
})

test('mirror descriptor hashing uses real SHA-256 fallback when WebCrypto is unavailable', async () => {
  const originalCrypto = globalThis.crypto
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true })
  try {
    const first = await fetchMirrorDescriptor('https://example.com/video.mp4', {
      now: 1_000_000n,
      fetch: async () => ({
        ok: true,
        url: 'https://example.com/video.mp4',
        headers: new Map([
          ['content-type', 'video/mp4'],
          ['content-length', '1024'],
        ]),
      }),
      signer: fixed(9),
      signBytes: async () => ZERO_64,
    })
    const second = await fetchMirrorDescriptor('https://example.com/video.mp4', {
      now: 1_000_000n,
      fetch: async () => ({
        ok: true,
        url: 'https://example.com/video.mp4',
        headers: new Map([
          ['content-type', 'video/mp4'],
          ['content-length', '1024'],
        ]),
      }),
      signer: fixed(9),
      signBytes: async () => ZERO_64,
    })

    assert.equal(Buffer.from(first.descriptor.descriptorId).toString('hex'), Buffer.from(second.descriptor.descriptorId).toString('hex'))
    assert.equal(Buffer.from(first.descriptor.descriptorId).toString('hex').length, 64)
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: originalCrypto, configurable: true })
  }
})
