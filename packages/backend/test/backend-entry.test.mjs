import test from 'brittle'

import * as backendEntry from '../src/backend-entry.js'

test('attachSharedAppHandlers skips loading shared app handlers unless requested', async (t) => {
  t.is(typeof backendEntry.attachSharedAppHandlers, 'function')
  if (typeof backendEntry.attachSharedAppHandlers !== 'function') return

  let loaded = false
  const attached = await backendEntry.attachSharedAppHandlers({
    backend: {},
    rpc: {},
    api: {},
    identityManager: {},
    ctx: {},
    storagePath: '/tmp/peartube-test',
    autoAttachSharedAppHandlers: false,
    loadSharedAppHandlers: async () => {
      loaded = true
      return {
        attachMobileHandlers() {}
      }
    }
  })

  t.is(attached, false)
  t.is(loaded, false)
})

test('attachSharedAppHandlers loads shared app handlers when explicitly enabled', async (t) => {
  t.is(typeof backendEntry.attachSharedAppHandlers, 'function')
  if (typeof backendEntry.attachSharedAppHandlers !== 'function') return

  let loaded = false
  let attachedBackend = null
  let attachedDeps = null

  const backend = {}
  const rpc = {}
  const api = {}
  const identityManager = {}
  const ctx = {}

  const attached = await backendEntry.attachSharedAppHandlers({
    backend,
    rpc,
    api,
    identityManager,
    ctx,
    storagePath: '/tmp/peartube-test',
    autoAttachSharedAppHandlers: true,
    loadSharedAppHandlers: async () => {
      loaded = true
      return {
        attachMobileHandlers(nextBackend, deps) {
          attachedBackend = nextBackend
          attachedDeps = deps
        }
      }
    }
  })

  t.is(attached, true)
  t.is(loaded, true)
  t.is(attachedBackend, backend)
  t.is(attachedDeps.rpc, rpc)
  t.is(attachedDeps.api, api)
  t.is(attachedDeps.identityManager, identityManager)
  t.is(attachedDeps.ctx, ctx)
  t.is(attachedDeps.storagePath, '/tmp/peartube-test')
})
