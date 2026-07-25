import assert from 'node:assert/strict'
import test from 'brittle'

import { HOST_ERROR_CODES, PROTOCOL_VERSION } from '../src/index.js'
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

  t.alike(ready, { blobServerPort: 7777, blobServerReady: true, blobServerError: null, protocolVersion: PROTOCOL_VERSION })
  t.alike(lifecycleEvents, [{ type: 'host.ready', data: ready }])
})

test('startHost passes the canonical protocol version into backend startup', async (t) => {
  let receivedProtocolVersion = null

  const session = await startHost({
    platform: 'desktop',
    storagePath: '/tmp/peartube-host',
    entrypoint: 'sidecar-entry',
    args: [],
    stream: createFakeStream(),
    createBackendImpl: async ({ onReady, protocolVersion }) => {
      receivedProtocolVersion = protocolVersion
      onReady({ blobServerPort: 7777, protocolVersion })
      return { destroy: async () => {} }
    }
  })

  const ready = await session.waitUntilReady()

  t.is(receivedProtocolVersion, PROTOCOL_VERSION)
  t.is(ready.protocolVersion, PROTOCOL_VERSION)
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
      onReady({ blobServerPort: null, blobServerReady: false, blobServerError: 'address in use', protocolVersion: PROTOCOL_VERSION })
      return { destroy: async () => {} }
    }
  })

  const ready = await session.waitUntilReady()

  t.alike(ready, { blobServerPort: null, blobServerReady: false, blobServerError: 'address in use', protocolVersion: PROTOCOL_VERSION })
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
      onReady({ blobServerPort: 7777, protocolVersion: PROTOCOL_VERSION })
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

test('startHost forwards video callbacks without legacy feed startup options', async (t) => {
  const calls = []

  const session = await startHost({
    platform: 'desktop',
    storagePath: '/tmp/peartube-host',
    entrypoint: 'sidecar-entry',
    args: [],
    stream: createFakeStream(),
    onVideoStats: (...args) => calls.push(['stats', ...args]),
    createBackendImpl: async (options) => {
      t.absent(Object.hasOwn(options, 'onFeedUpdate'))
      options.onVideoStats?.('channel-key', 'video-id', { peerCount: 3 })
      options.onReady({ blobServerPort: 7777, protocolVersion: PROTOCOL_VERSION })
      return { destroy: async () => {} }
    }
  })

  await session.waitUntilReady()

  t.alike(calls, [['stats', 'channel-key', 'video-id', { peerCount: 3 }]])
})

test('startHost forwards explicit network options to createBackend', async (t) => {
  const network = { announce: true, bootstrap: ['127.0.0.1:49737'] }
  const swarmOptions = { relayThrough: ['relay.example:49737'] }
  let received = null

  const session = await startHost({
    platform: 'mobile',
    storagePath: '/tmp/peartube-host',
    entrypoint: 'mobile-entry',
    args: [],
    stream: createFakeStream(),
    network,
    swarmOptions,
    createBackendImpl: async ({ onReady, network: backendNetwork, swarmOptions: backendSwarmOptions }) => {
      received = { network: backendNetwork, swarmOptions: backendSwarmOptions }
      onReady({ blobServerPort: 7777, protocolVersion: PROTOCOL_VERSION })
      return { destroy: async () => {} }
    }
  })

  await session.waitUntilReady()

  t.is(received.network, network)
  t.is(received.swarmOptions, swarmOptions)
})

test('startHost surfaces unsupported stored protocol readiness details', async (t) => {
  const lifecycleEvents = []
  const error = Object.assign(new Error('STORED_PROTOCOL_VERSION_UNSUPPORTED'), {
    code: 'STORED_PROTOCOL_VERSION_UNSUPPORTED',
    storedVersion: 5,
    expectedVersion: PROTOCOL_VERSION,
  })

  try {
    await startHost({
      platform: 'mobile',
      storagePath: '/tmp/peartube-host',
      entrypoint: 'mobile-entry',
      args: [],
      stream: createFakeStream(),
      onLifecycle: (event) => lifecycleEvents.push(event),
      createBackendImpl: async () => {
        throw error
      },
    })
    t.fail('unsupported stored protocol must reject host startup')
  } catch (received) {
    t.is(received, error)
  }

  t.alike(lifecycleEvents, [{
    type: 'host.error',
    code: 'STORED_PROTOCOL_VERSION_UNSUPPORTED',
    message: 'STORED_PROTOCOL_VERSION_UNSUPPORTED',
    retryable: false,
    storedVersion: 5,
    expectedVersion: PROTOCOL_VERSION,
  }])
})
