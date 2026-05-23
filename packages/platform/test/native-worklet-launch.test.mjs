import test from 'node:test'
import assert from 'node:assert/strict'

import { launchNativeWorklet } from '../src/native-worklet-launch.js'

test('launchNativeWorklet starts from a persisted file path when available', () => {
  const calls = []
  const worklet = {
    start(...args) {
      calls.push(args)
    },
  }

  const mode = launchNativeWorklet(worklet, {
    backendPath: '/tmp/peartube/backend.bundle.js',
    backendSource: 'module.exports = "unused"',
    workletId: '/peartube-backend-core.bundle',
    launchArgs: ['/tmp/storage'],
  })

  assert.equal(mode, 'file')
  assert.deepEqual(calls, [[
    '/tmp/peartube/backend.bundle.js',
    ['/tmp/storage'],
  ]])
})

test('launchNativeWorklet falls back to the embedded source when no file path exists', () => {
  const calls = []
  const worklet = {
    start(...args) {
      calls.push(args)
    },
  }

  const mode = launchNativeWorklet(worklet, {
    backendPath: '',
    backendSource: 'module.exports = "backend"',
    workletId: '/peartube-backend-core.bundle',
    launchArgs: ['/tmp/storage'],
  })

  assert.equal(mode, 'source')
  assert.deepEqual(calls, [[
    '/peartube-backend-core.bundle',
    'module.exports = "backend"',
    ['/tmp/storage'],
  ]])
})

test('launchNativeWorklet preserves entrypoint and launch options in argv', () => {
  const calls = []
  const worklet = {
    start(...args) {
      calls.push(args)
    },
  }
  const launchOptions = JSON.stringify({
    __peartubeLaunchOptions: true,
    network: { relayPeers: ['a'.repeat(64)] },
    swarmOptions: { knownPeers: ['b'.repeat(64)] },
  })
  const launchArgs = ['/tmp/storage', 'mobile-entry', launchOptions, 'downloader.bundle']

  const mode = launchNativeWorklet(worklet, {
    backendPath: '/tmp/peartube/backend.bundle.js',
    backendSource: '',
    workletId: '/peartube-backend-core.bundle',
    launchArgs,
  })

  assert.equal(mode, 'file')
  assert.deepEqual(calls, [[
    '/tmp/peartube/backend.bundle.js',
    launchArgs,
  ]])
})

test('launchNativeWorklet rejects missing file and source inputs', () => {
  assert.throws(() => launchNativeWorklet(
    { start() {} },
    {
      backendPath: '',
      backendSource: '',
      workletId: '/peartube-backend-core.bundle',
      launchArgs: [],
    },
  ), /backend worklet launch input/i)
})
