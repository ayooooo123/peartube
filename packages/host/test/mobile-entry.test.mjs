import test from 'brittle'

import { startHost } from '../src/start-host.js'
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

  const session = await startMobileBackend({
    storagePath: '/tmp/peartube-mobile',
    stream: createFakeStream(),
    entrypoint: 'mobile-entry',
    args: ['backend.bundle.js'],
    startHostImpl: startHost,
    createBackendImpl: async ({ onReady }) => {
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

  t.alike(await session.waitUntilReady(), { blobServerPort: 6123, protocolVersion: 1 })
  t.is(attachedBackend?.mobileHandlersAttached, true)
  t.is(attachedBackend?.castHandlersAttached, true)

  await session.terminate()

  t.is(destroyCalls, 1)
})
