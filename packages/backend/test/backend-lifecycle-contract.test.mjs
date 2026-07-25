import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'brittle'

import { createUniversalCore } from '../src/universal-core.js'
import {
  createBackendLifecycle,
  installBackendCleanupStack,
  shutdownBackend,
} from '../src/storage.js'
import { ChannelPairer } from '../src/channel/pairer.js'

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

  const deferredBody = orchestratorSource.match(
    /lifecycle\.defer\('backend warm-up', async \(signal\) => \{([\s\S]*?)\n\s*\}\)/,
  )?.[1] ?? ''
  assert.ok(deferredBody, 'orchestrator should have a lifecycle-owned deferred warmup block')
  assert.doesNotMatch(deferredBody, /if \(isShuttingDown\)/)
  assert.match(deferredBody, /signal\.aborted\s*\|\|\s*isContextShuttingDown\(ctx\)/)
  t.pass('deferred warmup is bound to the backend context lifecycle')
})

function createManualScheduler() {
  let nextId = 1
  const pending = new Map()

  return {
    schedule(fn) {
      const id = nextId++
      pending.set(id, fn)
      return id
    },
    cancel(id) {
      pending.delete(id)
    },
    run(id) {
      const fn = pending.get(id)
      pending.delete(id)
      fn?.()
    },
    get pendingCount() {
      return pending.size
    },
    get firstId() {
      return pending.keys().next().value
    },
  }
}

test('backend lifecycle provides an abort signal when Bare has no AbortController global', () => {
  const lifecycleModuleUrl = new URL('../src/storage.js', import.meta.url).href
  const script = `
    globalThis.AbortController = undefined
    const { createBackendLifecycle } = await import(${JSON.stringify(lifecycleModuleUrl)})
    const lifecycle = createBackendLifecycle()
    let abortEvents = 0
    let cleanups = 0
    lifecycle.own('portable cleanup', () => { cleanups += 1 })
    lifecycle.signal.addEventListener('abort', () => { throw new Error('listener failed') }, { once: true })
    lifecycle.signal.addEventListener('abort', () => { abortEvents += 1 }, { once: true })
    await lifecycle.shutdown()
    await lifecycle.shutdown()
    if (!lifecycle.signal.aborted || abortEvents !== 1 || cleanups !== 1) {
      throw new Error('portable abort signal did not abort and clean up exactly once')
    }
  `

  execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    stdio: 'pipe',
  })
})

test('backend lifecycle aborts deferred work and closes owned resources once in reverse order', async () => {
  const scheduler = createManualScheduler()
  const closeLog = []
  const lifecycle = createBackendLifecycle({
    scheduleDeferred: scheduler.schedule,
    cancelDeferred: scheduler.cancel,
    shutdownTimeoutMs: 50,
  })

  const corestore = {
    lockHeld: true,
    async close() {
      this.lockHeld = false
      closeLog.push('corestore')
    },
  }
  const swarm = { async destroy() { closeLog.push('swarm') } }
  const server = { async close() { closeLog.push('server') } }

  lifecycle.ownResource('Corestore', corestore, 'close')
  lifecycle.ownResource('swarm', swarm, 'destroy')
  lifecycle.ownResource('server', server, 'close')

  let warmupObservedShutdown = false
  let reopenedResources = 0
  const warmupStarted = new Promise((resolve) => {
    lifecycle.defer('channel warm-up', async (signal) => {
      resolve()
      if (!signal.aborted) {
        await new Promise((resume) => signal.addEventListener('abort', resume, { once: true }))
      }
      warmupObservedShutdown = signal.aborted
      if (!signal.aborted) reopenedResources += 1
    })
  })

  assert.equal(scheduler.pendingCount, 1)
  scheduler.run(scheduler.firstId)
  await warmupStarted

  await Promise.all([lifecycle.shutdown(), lifecycle.shutdown()])

  assert.equal(warmupObservedShutdown, true)
  assert.equal(reopenedResources, 0)
  assert.equal(scheduler.pendingCount, 0)
  assert.deepEqual(closeLog, ['server', 'swarm', 'corestore'])
  assert.equal(corestore.lockHeld, false, 'Corestore close must release its lock')
  assert.equal(lifecycle.ownedCount, 0)
})

test('concurrent ownership cleanup waits for the same close operation', async () => {
  const lifecycle = createBackendLifecycle()
  let releaseClose = null
  const closeGate = new Promise((resolve) => {
    releaseClose = resolve
  })
  let closeCalls = 0
  const registration = lifecycle.own('resource', async () => {
    closeCalls += 1
    await closeGate
  })

  const first = registration.cleanup()
  let secondSettled = false
  const second = registration.cleanup().finally(() => {
    secondSettled = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(secondSettled, false)
  releaseClose()
  await Promise.all([first, second])
  assert.equal(closeCalls, 1)
})

test('shutdown awaits cleanup that started before shutdown', async () => {
  const lifecycle = createBackendLifecycle()
  let releaseClose = null
  const closeGate = new Promise((resolve) => {
    releaseClose = resolve
  })
  let closeCalls = 0
  const registration = lifecycle.own('racing resource', async () => {
    closeCalls += 1
    await closeGate
  })

  const cleanup = registration.cleanup()
  let shutdownSettled = false
  const shutdown = lifecycle.shutdown().finally(() => {
    shutdownSettled = true
  })
  await new Promise((resolve) => setImmediate(resolve))

  try {
    assert.equal(closeCalls, 1)
    assert.equal(shutdownSettled, false, 'shutdown must await cleanup already in progress')
  } finally {
    releaseClose()
    await Promise.all([cleanup, shutdown])
  }
  assert.equal(closeCalls, 1)
})

test('released ownership does not retain transient resource cleanup closures', () => {
  const lifecycleModuleUrl = new URL('../src/storage.js', import.meta.url).href
  const script = `
    const { createBackendLifecycle } = await import(${JSON.stringify(lifecycleModuleUrl)})
    const lifecycle = createBackendLifecycle()
    const resourceRefs = []

    async function createAndDetachTransientResource(method) {
      const resource = { async close() {} }
      resourceRefs.push(new WeakRef(resource))
      const registration = lifecycle.ownResource('transient probe', resource, 'close')
      await registration[method]()
    }

    await createAndDetachTransientResource('cleanup')
    await createAndDetachTransientResource('release')
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      globalThis.gc()
      await new Promise((resolve) => setImmediate(resolve))
      if (resourceRefs.every((resourceRef) => !resourceRef.deref())) break
    }
    if (resourceRefs.some((resourceRef) => resourceRef.deref())) {
      throw new Error('detached resource remains strongly retained')
    }
  `

  execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '--eval', script], {
    stdio: 'pipe',
  })
})

test('pairer closes its transient channel discovery exactly once', async () => {
  let destroyCalls = 0
  const pairer = Object.create(ChannelPairer.prototype)
  Object.assign(pairer, {
    candidate: null,
    pairing: null,
    discovery: {
      async destroy() {
        destroyCalls += 1
      },
    },
    swarm: null,
    opts: { swarm: {} },
  })

  const lifecycle = createBackendLifecycle()
  lifecycle.own('channel pairer', () => pairer._close())
  await Promise.all([lifecycle.shutdown(), lifecycle.shutdown()])
  assert.equal(destroyCalls, 1)
})

test('backend lifecycle bounds a stuck cleanup and continues consuming ownership', async () => {
  const closeLog = []
  const lifecycle = createBackendLifecycle({ shutdownTimeoutMs: 10 })

  lifecycle.own('Corestore', async () => { closeLog.push('corestore') })
  lifecycle.own('stuck worker', async () => {
    closeLog.push('worker')
    await new Promise(() => {})
  })

  await lifecycle.shutdown()

  assert.deepEqual(closeLog, ['worker', 'corestore'])
  assert.equal(lifecycle.signal.aborted, true)
  assert.equal(lifecycle.ownedCount, 0)
})
