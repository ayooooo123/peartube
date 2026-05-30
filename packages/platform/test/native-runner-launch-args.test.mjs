import test from 'node:test'
import assert from 'node:assert/strict'

import { createNativeRunner } from '../src/runner.native.ts'

function createNeverReadyClient() {
  return {
    events: { on() {} },
    ready() { return new Promise(() => {}) },
  }
}

test('native runner includes entrypoint and trailing args in worklet launch argv', async () => {
  const starts = []
  class Worklet {
    constructor() {
      this.IPC = { on() {}, write() {} }
    }

    start(...args) {
      starts.push(args)
    }

    terminate() {}
  }

  const runner = createNativeRunner({
    WorkletCtor: Worklet,
    backendSource: 'module.exports = "backend"',
    workletId: '/peartube-backend-core.bundle',
    createProtocolClientImpl: createNeverReadyClient,
  })

  const startPromise = runner.start({
    platform: 'mobile',
    storagePath: '/tmp/peartube-storage',
    entrypoint: 'mobile-entry',
    args: ['downloader.bundle'],
  })

  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(starts, [[
    '/peartube-backend-core.bundle',
    'module.exports = "backend"',
    ['/tmp/peartube-storage', 'mobile-entry', 'downloader.bundle'],
  ]])

  startPromise.catch(() => {})
})


test('native runner includes launch option JSON before trailing worker args', async () => {
  const starts = []
  class Worklet {
    constructor() {
      this.IPC = { on() {}, write() {} }
    }

    start(...args) {
      starts.push(args)
    }

    terminate() {}
  }

  const launchOptions = {
    __peartubeLaunchOptions: true,
    network: { relayPeers: ['a'.repeat(64)] },
    swarmOptions: { knownPeers: ['b'.repeat(64)] },
  }

  const runner = createNativeRunner({
    WorkletCtor: Worklet,
    backendSource: 'module.exports = "backend"',
    workletId: '/peartube-backend-core.bundle',
    createProtocolClientImpl: createNeverReadyClient,
    resolveLaunchArgs(options) {
      return [options.storagePath, options.entrypoint, JSON.stringify(launchOptions), ...(options.args ?? [])]
    },
  })

  const startPromise = runner.start({
    platform: 'mobile',
    storagePath: '/tmp/peartube-storage',
    entrypoint: 'mobile-entry',
    args: ['downloader.bundle'],
  })

  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(starts.length, 1)
  assert.deepEqual(starts[0][2], [
    '/tmp/peartube-storage',
    'mobile-entry',
    JSON.stringify(launchOptions),
    'downloader.bundle',
  ])

  startPromise.catch(() => {})
})
