import test from 'brittle'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveRelayConfig } from '../src/config.js'
import { createRelayRuntime } from '../src/runtime.js'

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function createFakeLogger() {
  const levels = ['debug', 'info', 'warn', 'error']
  const components = ['relay', 'runtime', 'admission', 'status', 'mirror', 'peer', 'cache', 'feed', 'download']
  const logger = {}

  for (const component of components) {
    logger[component] = {}
    for (const level of levels) {
      logger[component][level] = () => {}
    }
  }

  return logger
}

test('relay visibility modes map to valid archive operator modes', async t => {
  for (const [mode, expected] of [['public', 'community'], ['private', 'local-first']]) {
    let backendOptions
    const config = resolveRelayConfig({
      mode,
      storage: { path: `/tmp/peartube-relay-${mode}`, maxBytes: 1_000_000 },
    }, { env: {} })
    const runtime = await createRelayRuntime({
      config,
      logger: createFakeLogger(),
      dependencies: {
        async createBackendContext(options) {
          backendOptions = options
          return { ctx: {}, api: {}, async destroy() {} }
        },
      },
    })
    t.is(backendOptions.operability.operatorMode, expected)
    await runtime.close()
  }
})

test('relay runtime persists and reuses primary-key across restart on same storage path', async (t) => {
  const dir = makeTempDir('peartube-relay-runtime-')
  const logger = createFakeLogger()

  try {
    const config = resolveRelayConfig({
      storage: { path: dir, maxBytes: 1_000_000 }
    }, { env: {} })

    const runtimeA = await createRelayRuntime({ config, logger })
    await runtimeA.start()

    const primaryKeyPath = join(dir, 'primary-key')
    t.ok(existsSync(primaryKeyPath), 'primary-key file should be created on first start')
    const firstPrimaryKey = runtimeA.ctx?.store?.primaryKey?.toString('hex')
    t.ok(firstPrimaryKey, 'first runtime should expose a corestore primary key')

    await runtimeA.close()

    const runtimeB = await createRelayRuntime({ config, logger })
    await runtimeB.start()

    const secondPrimaryKey = runtimeB.ctx?.store?.primaryKey?.toString('hex')
    t.ok(secondPrimaryKey, 'second runtime should expose a corestore primary key')
    t.is(secondPrimaryKey, firstPrimaryKey, 'primary key should be reused across restart')

    await runtimeB.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
