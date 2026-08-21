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

test('a public discovery relay starts, because relay mode is not an archive operator mode', async (t) => {
  // Regression: runtime.js passed the relay mode (public/private) straight
  // through as the archive operator mode (local-first/altruistic/...). Every
  // public relay then died at startup with "invalid archive operator mode",
  // and public is the default, so no relay could boot from source at all.
  const dir = makeTempDir('peartube-relay-operator-mode-')
  const logger = createFakeLogger()

  try {
    const config = resolveRelayConfig({
      mode: 'public',
      policy: 'discovery',
      storage: { path: dir, maxBytes: 1_000_000 },
    }, { env: {} })
    t.is(config.mode, 'public', 'the relay is still a public discovery relay')

    const runtime = await createRelayRuntime({ config, logger })
    await runtime.start()
    t.ok(runtime.ctx, 'a public relay reaches a usable backend context')
    await runtime.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an explicit archive operator mode is honoured, and a bogus one still fails loudly', async (t) => {
  const dir = makeTempDir('peartube-relay-operator-explicit-')
  const logger = createFakeLogger()

  try {
    const config = resolveRelayConfig({
      mode: 'public',
      storage: { path: dir, maxBytes: 1_000_000 },
    }, { env: {} })

    const runtime = await createRelayRuntime({
      config: { ...config, archiveOperatorMode: 'altruistic' },
      logger,
    })
    await runtime.start()
    t.ok(runtime.ctx, 'a declared operator mode is accepted')
    await runtime.close()

    await t.exception(
      createRelayRuntime({ config: { ...config, archiveOperatorMode: 'nonsense' }, logger })
        .then(runtime => runtime.start()),
      /invalid archive operator mode/,
      'an unknown operator mode is still rejected rather than silently defaulted'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
