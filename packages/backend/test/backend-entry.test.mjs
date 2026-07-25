import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'brittle'

import * as backendEntry from '../src/backend-entry.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const packageRoot = path.resolve(__dirname, '..')

function readBackendFile(relativePath) {
  return fs.readFileSync(path.join(packageRoot, relativePath), 'utf8')
}

test('backend package stays below host and does not import host', (t) => {
  const pkg = JSON.parse(readBackendFile('package.json'))

  assert.equal(pkg.dependencies?.['@peartube/host'], undefined)
  for (const relativePath of ['src/backend-entry.js', 'src/runtime.js']) {
    assert.doesNotMatch(
      readBackendFile(relativePath),
      /(?:from\s+['"]@peartube\/host|import\(\s*['"]@peartube\/host)/
    )
  }

  t.pass('backend has no direct host dependency')
})

test('shared system handlers use the host-provided protocol version', async (t) => {
  const { buildSharedSystemHandlers } = await import('../src/runtime.js')
  const handlers = buildSharedSystemHandlers({}, { protocolVersion: 42 })
  const bootstrap = await handlers.DesktopBootstrap({ storagePath: '/tmp/peartube-test' })

  t.is(bootstrap.protocolVersion, 42)
})

test('backend API module imports in relay runtime', async (t) => {
  const apiModule = await import('../src/api.js')
  t.is(typeof apiModule.createApi, 'function')
})

test('backend package root imports without stale export drift', async (t) => {
  const backendModule = await import('../src/index.js')
  t.is(typeof backendModule.createUniversalCore, 'function')
})

test('attachSharedAppHandlers skips loading shared app handlers unless requested', async (t) => {
  t.is(typeof backendEntry.attachSharedAppHandlers, 'function')
  if (typeof backendEntry.attachSharedAppHandlers !== 'function') return

  let loaded = false
  const attached = await backendEntry.attachSharedAppHandlers({
    backend: {},
    rpc: {},
    api: {},
    identityManager: {},
    uploadManager: {},
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
  const uploadManager = {}
  const ctx = {}

  const attached = await backendEntry.attachSharedAppHandlers({
    backend,
    rpc,
    api,
    identityManager,
    uploadManager,
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
  t.is(attachedDeps.uploadManager, uploadManager)
  t.is(attachedDeps.ctx, ctx)
  t.is(attachedDeps.storagePath, '/tmp/peartube-test')
})


test('createBackend exposes universal core as the entry runtime composition root', async (t) => {
  t.is(typeof backendEntry.createBackend, 'function')
  if (typeof backendEntry.createBackend !== 'function') return

  const responses = new Map()
  const stream = {}
  let readyPayload = null
  const lifecycle = []
  let contextPlatform = null
  let contextExpectedProtocolVersion = null
  let releaseBackendDestroy = null
  const backendDestroyGate = new Promise((resolve) => {
    releaseBackendDestroy = resolve
  })
  const metaDb = {
    async get() { return null },
    async put() {}
  }

  const session = await backendEntry.createBackend({
    storagePath: '/tmp/peartube-entry-universal-core-test',
    stream,
    platform: 'desktop',
    protocolVersion: 42,
    onReady(payload) { readyPayload = payload },
    createBackendContext: async (contextOptions) => {
      contextPlatform = contextOptions.platform
      contextExpectedProtocolVersion = contextOptions.expectedProtocolVersion
      return {
        ctx: { metaDb },
        api: {},
        identityManager: { getIdentities: () => [] },
        uploadManager: {},
        async destroy() {
          lifecycle.push('backend:destroy')
          await backendDestroyGate
        },
      }
    },
    createGossipService: () => ({}),
    createMirrorSeedWorker: () => ({}),
    createStorageService: () => ({}),
    loadNativeModules: async () => ({
      libhc: {
        async create() {
          return {
            async init() { lifecycle.push('hc:init') },
            async flush(context) { lifecycle.push(`hc:flush:${context.phase}`) },
            async start() { lifecycle.push('hc:start') },
            async shutdown() { lifecycle.push('hc:shutdown') },
          }
        },
      },
    }),
    HRPCImpl: class MockHRPC {
      constructor(nextStream) { this.stream = nextStream }
      respond(name, handler) { responses.set(name, handler) }
      eventReady(payload) { this.ready = payload }
      eventError(payload) { this.error = payload }
    }
  })

  t.is(session.runtime, session.core)
  t.is(session.backend.universalCore, session.core)
  t.is(session.core.state, 'started')
  t.is(readyPayload.protocolVersion, 42)
  t.is(session.rpc.ready.protocolVersion, 42)
  t.is(contextPlatform, 'desktop')
  t.is(contextExpectedProtocolVersion, 42)
  t.ok(lifecycle.includes('hc:init'))
  t.is(contextPlatform, 'desktop')
  t.ok(lifecycle.includes('hc:start'))

  const firstDestroy = session.destroy()
  let secondDestroySettled = false
  const secondDestroy = session.destroy().finally(() => {
    secondDestroySettled = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  t.is(secondDestroySettled, false, 'concurrent destroy waits for the in-flight shutdown')
  releaseBackendDestroy()
  await Promise.all([firstDestroy, secondDestroy])
  t.is(session.core.state, 'shutdown')
  t.is(lifecycle.filter((entry) => entry === 'backend:destroy').length, 1)
})

test('stored protocol rejection happens before RPC handlers or readiness are exposed', async (t) => {
  let rpcConstructed = false
  let readyCalls = 0
  let errorCalls = 0
  const error = Object.assign(new Error('Stored protocol version 5 is unsupported; expected 4'), {
    code: 'STORED_PROTOCOL_VERSION_UNSUPPORTED',
    storedVersion: 5,
    expectedVersion: 4,
  })

  try {
    await backendEntry.createBackend({
      storagePath: '/tmp/peartube-entry-stored-protocol-rejection',
      stream: {},
      platform: 'desktop',
      protocolVersion: 4,
      createBackendContext: async () => {
        throw error
      },
      onReady() {
        readyCalls += 1
      },
      onError(received) {
        errorCalls += 1
        t.is(received, error)
      },
      HRPCImpl: class MockHRPC {
        constructor() {
          rpcConstructed = true
        }
      },
    })
    t.fail('unsupported stored state must reject backend startup')
  } catch (received) {
    t.is(received, error)
  }

  t.is(rpcConstructed, false)
  t.is(readyCalls, 0)
  t.is(errorCalls, 1)
})
