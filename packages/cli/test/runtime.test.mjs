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


test('relay runtime wires production discovered seeding through quota-aware cache manager', async (t) => {
  const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/runtime.js', import.meta.url), 'utf8'))
  t.ok(/new CacheManager\(ctx\.store, ctx\.metaDb, config\?\.storage\?\.maxBytes \|\| 0\)/.test(source), 'runtime cache manager should receive storage.maxBytes')
  t.ok(/seeder\.seedCachedChannels\(cacheManager\)/.test(source), 'runtime should seed cached/discovered channels through the production seeder')
  const seedingSource = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/seeding.js', import.meta.url), 'utf8'))
  t.ok(/cacheManager\.enforceQuota\(\{/.test(seedingSource), 'production seedCachedChannels should enforce quota after measured seeding')
  t.ok(/await stopChannel\(evicted\?\.driveKey \|\| evicted\?\.channelKey\)/.test(seedingSource), 'quota eviction should stop retained seeding resources')
})
