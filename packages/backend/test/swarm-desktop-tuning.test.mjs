import assert from 'node:assert/strict'
import test from 'node:test'
import b4a from 'b4a'

import {
  resolveHyperswarmOptions,
  schedulePeerPoolWarmupRefreshes,
} from '../src/storage.js'

test('desktop swarm options raise parallel dialing while preserving storage-owned keypair', () => {
  const keyPair = { publicKey: b4a.alloc(32, 1), secretKey: b4a.alloc(64, 2) }
  const result = resolveHyperswarmOptions({
    keyPair,
    platform: 'desktop',
    swarmOptions: { keyPair: { publicKey: b4a.alloc(32, 9) } },
  })

  assert.equal(result.keyPair, keyPair)
  assert.equal(result.maxParallel, 12)
  assert.equal(result.maxPeers, 96)
})

test('mobile swarm options keep Hyperswarm defaults unless explicitly configured', () => {
  const keyPair = { publicKey: b4a.alloc(32, 3), secretKey: b4a.alloc(64, 4) }
  const result = resolveHyperswarmOptions({ keyPair, platform: 'mobile' })

  assert.equal(result.keyPair, keyPair)
  assert.equal(result.maxParallel, undefined)
  assert.equal(result.maxPeers, undefined)
})

test('explicit swarm and network options override desktop defaults except keypair', () => {
  const keyPair = { publicKey: b4a.alloc(32, 5), secretKey: b4a.alloc(64, 6) }
  const bootstrap = ['127.0.0.1:49737']
  const nodes = [{ host: '192.168.1.20', port: 49737 }]
  const result = resolveHyperswarmOptions({
    keyPair,
    platform: 'desktop',
    network: { bootstrap, nodes, port: 54321 },
    swarmOptions: {
      maxParallel: 5,
      maxPeers: 32,
      randomPunchInterval: 750,
      keyPair: { publicKey: b4a.alloc(32, 9) },
    },
  })

  assert.equal(result.keyPair, keyPair)
  assert.equal(result.bootstrap, bootstrap)
  assert.equal(result.nodes, nodes)
  assert.equal(result.port, 54321)
  assert.equal(result.maxParallel, 5)
  assert.equal(result.maxPeers, 32)
  assert.equal(result.randomPunchInterval, 750)
})

test('desktop peer pool warmup refreshes discovery while under connection target', async () => {
  const calls = []
  const timers = []
  const swarm = { connections: new Set([{}]), connecting: 0 }
  const discovery = {
    async refresh(opts) {
      calls.push(opts)
    },
  }
  const startupEvents = []
  const result = schedulePeerPoolWarmupRefreshes({
    platform: 'desktop',
    swarm,
    discovery,
    startupTiming: {
      record(name, details) {
        startupEvents.push({ name, details })
      },
    },
    setTimer(fn, ms) {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimer() {},
  })

  assert.equal(result.scheduled, 3)
  assert.deepEqual(timers.map((timer) => timer.ms), [3000, 10000, 30000])

  await timers[0].fn()
  assert.deepEqual(calls, [{ server: true, client: true }])
  assert.equal(startupEvents[0].name, 'peer-pool-warm-refresh')
  assert.equal(startupEvents[0].details.connections, 1)
})

test('peer pool warmup skips mobile and already well-connected desktop swarms', async () => {
  const mobile = schedulePeerPoolWarmupRefreshes({
    platform: 'mobile',
    swarm: { connections: new Set() },
    discovery: { refresh() { throw new Error('should not refresh mobile') } },
    setTimer() { throw new Error('should not schedule mobile timers') },
  })
  assert.equal(mobile.scheduled, 0)

  const timers = []
  const desktop = schedulePeerPoolWarmupRefreshes({
    platform: 'desktop',
    swarm: { connections: new Set([{}, {}, {}, {}]), connecting: 0 },
    discovery: { refresh() { throw new Error('should not refresh connected desktop') } },
    setTimer(fn, ms) {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimer() {},
  })

  assert.equal(desktop.scheduled, 0)
  assert.equal(timers.length, 0)
})
