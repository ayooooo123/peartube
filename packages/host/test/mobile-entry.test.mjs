import test from 'brittle'

import { startHost } from '../src/start-host.js'
import { PROTOCOL_VERSION } from '../src/contracts.js'
import { startMobileBackend } from '../../app/backend/mobile-entry.mjs'

function createFakeStream() {
  return {
    on() {},
    once() {},
    write() {},
    destroy() {}
  }
}

test('startMobileBackend delegates startup through the shared host contract', async (t) => {
  let destroyCalls = 0
  let attachedBackend = null
  let capturedBackendOptions = null

  const session = await startMobileBackend({
    storagePath: '/tmp/peartube-mobile',
    stream: createFakeStream(),
    entrypoint: 'mobile-entry',
    args: ['backend.bundle.js'],
    startHostImpl: startHost,
    createBackendImpl: async ({ onReady, ...backendOptions }) => {
      capturedBackendOptions = backendOptions
      const backend = {}
      onReady({ blobServerPort: 6123 })
      return {
        backend,
        handlerDeps: { storagePath: '/tmp/peartube-mobile' },
        destroy: async () => {
          destroyCalls++
        }
      }
    },
    attachMobileHandlersImpl(backend) {
      backend.mobileHandlersAttached = true
      attachedBackend = backend
    },
    attachCastHandlersImpl(backend) {
      backend.castHandlersAttached = true
      return {
        closeCastProxyServer() {},
        enterHeadlessMode() {}
      }
    }
  })

  const ready = await session.waitUntilReady()
  t.is(ready.blobServerPort, 6123)
  t.is(ready.protocolVersion, PROTOCOL_VERSION)
  t.is(attachedBackend?.mobileHandlersAttached, true)
  t.is(attachedBackend?.castHandlersAttached, true)
  t.alike(capturedBackendOptions.args, ['backend.bundle.js'])

  await session.terminate()

  t.is(destroyCalls, 1)
})

test('startMobileBackend preserves serialized launch options for runtime backend startup', async (t) => {
  const launchOptions = {
    __peartubeLaunchOptions: true,
    network: { relayPeers: ['relay-a'] },
    swarmOptions: { knownPeers: ['relay-a'] },
  }
  let capturedBackendOptions = null

  const session = await startMobileBackend({
    storagePath: '/tmp/peartube-mobile',
    stream: createFakeStream(),
    entrypoint: 'mobile-entry',
    args: [JSON.stringify(launchOptions), 'downloader-worker.bundle.js'],
    startHostImpl: startHost,
    createBackendImpl: async ({ onReady, ...backendOptions }) => {
      capturedBackendOptions = backendOptions
      onReady({ blobServerPort: 6123 })
      return {
        backend: {},
        handlerDeps: { storagePath: '/tmp/peartube-mobile' },
        destroy: async () => {},
      }
    },
  })

  const ready = await session.waitUntilReady()
  t.is(ready.blobServerPort, 6123)
  t.is(ready.protocolVersion, PROTOCOL_VERSION)
  t.alike(capturedBackendOptions.args, [JSON.stringify(launchOptions), 'downloader-worker.bundle.js'])

  await session.terminate()
})
