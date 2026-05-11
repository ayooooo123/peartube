import assert from 'node:assert/strict'
import test from 'brittle'

import { HOST_ERROR_CODES } from '../src/index.js'
import { startHost } from '../src/start-host.js'

function createFakeStream() {
  return {
    on() {},
    once() {},
    write() {},
    destroy() {}
  }
}

test('startHost rejects empty storagePath', async (t) => {
  await assert.rejects(
    startHost({
      platform: 'desktop',
      storagePath: '',
      entrypoint: 'sidecar-entry',
      args: [],
      stream: createFakeStream()
    }),
    /storagePath/
  )

  t.pass('empty storagePath rejected')
})

test('startHost forwards ready payload with protocolVersion and lifecycle event', async (t) => {
  const lifecycleEvents = []

  const session = await startHost({
    platform: 'desktop',
    storagePath: '/tmp/peartube-host',
    entrypoint: 'sidecar-entry',
    args: [],
    stream: createFakeStream(),
    onLifecycle: (event) => lifecycleEvents.push(event),
    createBackendImpl: async ({ onReady }) => {
      onReady({ blobServerPort: 7777, blobServerReady: true, blobServerError: null })
      return { destroy: async () => {} }
    }
  })

  const ready = await session.waitUntilReady()

  t.alike(ready, { blobServerPort: 7777, blobServerReady: true, blobServerError: null, protocolVersion: 2 })
  t.alike(lifecycleEvents, [{ type: 'host.ready', data: ready }])
})

test('startHost forwards degraded blob server readiness details', async (t) => {
  const lifecycleEvents = []

  const session = await startHost({
    platform: 'desktop',
    storagePath: '/tmp/peartube-host',
    entrypoint: 'sidecar-entry',
    args: [],
    stream: createFakeStream(),
    onLifecycle: (event) => lifecycleEvents.push(event),
    createBackendImpl: async ({ onReady }) => {
      onReady({ blobServerPort: null, blobServerReady: false, blobServerError: 'address in use', protocolVersion: 2 })
      return { destroy: async () => {} }
    }
  })

  const ready = await session.waitUntilReady()

  t.alike(ready, { blobServerPort: null, blobServerReady: false, blobServerError: 'address in use', protocolVersion: 2 })
  t.alike(lifecycleEvents, [{ type: 'host.ready', data: ready }])
})

test('startHost terminate is idempotent', async (t) => {
  let destroyCalls = 0

  const session = await startHost({
    platform: 'desktop',
    storagePath: '/tmp/peartube-host',
    entrypoint: 'sidecar-entry',
    args: [],
    stream: createFakeStream(),
    createBackendImpl: async ({ onReady }) => {
      onReady({ blobServerPort: 7777, protocolVersion: 2 })
      return {
        destroy: async () => {
          destroyCalls++
        }
      }
    }
  })

  await session.waitUntilReady()
  await session.terminate()
  await session.terminate()

  t.is(destroyCalls, 1)
})

test('startHost forwards feed and video callbacks to createBackend', async (t) => {
  const calls = []

  const session = await startHost({
    platform: 'desktop',
    storagePath: '/tmp/peartube-host',
    entrypoint: 'sidecar-entry',
    args: [],
    stream: createFakeStream(),
    onFeedUpdate: () => calls.push('feed'),
    onVideoStats: (...args) => calls.push(['stats', ...args]),
    createBackendImpl: async ({ onReady, onFeedUpdate, onVideoStats }) => {
      onFeedUpdate?.()
      onVideoStats?.('channel-key', 'video-id', { peerCount: 3 })
      onReady({ blobServerPort: 7777, protocolVersion: 2 })
      return { destroy: async () => {} }
    }
  })

  await session.waitUntilReady()

  t.alike(calls, ['feed', ['stats', 'channel-key', 'video-id', { peerCount: 3 }]])
})
