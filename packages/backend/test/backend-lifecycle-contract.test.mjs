import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'brittle'

import { createUniversalCore } from '../src/universal-core.js'
import {
  installBackendCleanupStack,
  shutdownBackend,
} from '../src/storage.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const orchestratorSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'orchestrator.js'), 'utf8')

test('shutdownBackend consumes an owned cleanup stack in reverse order exactly once', async (t) => {
  const log = []
  const ctx = {}
  installBackendCleanupStack(ctx)

  ctx.registerCleanup('store close', async () => log.push('store'), { timeoutMs: 100 })
  ctx.registerCleanup('metaCore close', async () => log.push('metaCore'), { timeoutMs: 100 })
  ctx.registerCleanup('metaDb close', async () => log.push('metaDb'), { timeoutMs: 100 })
  ctx.registerCleanup('swarm destroy', async () => log.push('swarm'), { timeoutMs: 100 })
  ctx.registerCleanup('deferred warmup timer', async () => log.push('timer'), { timeoutMs: 100 })

  await shutdownBackend(ctx)
  await shutdownBackend(ctx)

  assert.deepEqual(log, ['timer', 'swarm', 'metaDb', 'metaCore', 'store'])
  t.is(ctx._cleanupStackConsumed, true)
  t.is(ctx.isShuttingDown, true)
})

test('universal core shutdown delegates backend teardown once before native handles', async (t) => {
  const log = []
  const core = createUniversalCore({
    platform: 'mobile',
    storagePath: '/tmp/peartube-lifecycle-test',
    createBackendContext: async () => ({
      ctx: {},
      async destroy() {
        log.push('backend:destroy')
      }
    }),
    loadNativeModules: async () => ({
      libhc: {
        async create() {
          return {
            async init() { log.push('native:init') },
            async start() { log.push('native:start') },
            async flush(context) { log.push(`native:flush:${context.phase}`) },
            async shutdown() { log.push('native:shutdown') },
          }
        }
      }
    })
  })

  await core.init()
  await core.start()
  await Promise.all([core.shutdown(), core.shutdown()])

  t.is(log.filter((entry) => entry === 'backend:destroy').length, 1)
  t.ok(log.indexOf('backend:destroy') !== -1)
  t.ok(log.indexOf('native:shutdown') !== -1)
  t.ok(log.indexOf('backend:destroy') < log.indexOf('native:shutdown'))
  t.is(core.state, 'shutdown')
})

test('orchestrator deferred warmup uses context shutdown state, not a reusable global flag', (t) => {
  assert.match(orchestratorSource, /function isContextShuttingDown\(ctx\)/)
  assert.match(orchestratorSource, /ctx\.isShuttingDown\s*\|\|\s*ctx\._isShutdown/)

  const deferredBody = orchestratorSource.match(/defer\(async \(\) => \{([\s\S]*?)\n\s*\}\)/)?.[1] ?? ''
  assert.ok(deferredBody, 'orchestrator should have a deferred warmup block')
  assert.doesNotMatch(deferredBody, /if \(isShuttingDown\)/)
  assert.match(deferredBody, /if \(isContextShuttingDown\(ctx\)\)/)
  t.pass('deferred warmup is bound to the backend context lifecycle')
})
