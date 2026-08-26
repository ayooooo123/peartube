import test from 'brittle'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveRelayConfig } from '../src/config.js'
import { createRelayRuntime } from '../src/runtime.js'
import { createRelayPublisherShell } from '../src/publisher-shell.js'

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function createFakeLogger() {
  const levels = ['debug', 'info', 'warn', 'error']
  const components = ['relay', 'runtime', 'admission', 'status', 'mirror', 'peer', 'cache', 'feed', 'download', 'archive']
  const logger = {}
  for (const component of components) {
    logger[component] = {}
    for (const level of levels) logger[component][level] = () => {}
  }
  return logger
}

// Uploading needs a writable, admitted publisher catalog. A relay has no
// keychain and nobody to confirm root operations, so it has to authorize its
// own namespace and writer admission or every archive job fails with
// "No admitted publisher catalog is available".
test('a relay authorizes its own publisher catalog from empty storage', async (t) => {
  const dir = makeTempDir('peartube-relay-publisher-')
  const logger = createFakeLogger()

  try {
    const config = resolveRelayConfig({ storage: { path: dir, maxBytes: 1_000_000 } }, { env: {} })
    const runtime = await createRelayRuntime({ config, logger })
    await runtime.start()

    t.absent(existsSync(join(dir, 'publisher-root')), 'storage starts with no publisher root')

    const shell = createRelayPublisherShell({ api: runtime.api, storagePath: dir, logger })
    const result = await shell.ensureLocalPublisher()

    t.ok(/^[0-9a-f]{64}$/.test(result.publisherId), 'the relay resolved a publisher id')

    // The contract that actually matters: upload.js refuses to publish unless
    // the catalog registry hands back a writable, admitted binding.
    const catalog = await runtime.api.provisionPublisherCatalog({
      publisherId: result.publisherId,
      genesisRootKey: Buffer.from(JSON.parse(readFileSync(join(dir, 'publisher-root'), 'utf8')).publicKey, 'hex')
    })
    t.ok(catalog.namespaceInitialized, 'the publisher namespace is initialized')
    t.ok(catalog.writable, 'the catalog is writable')
    t.ok(catalog.admitted, 'the relay device is admitted to write')

    await runtime.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The publisher root addresses the catalog: regenerating it would strand every
// publication the relay has already signed.
test('a restarted relay reuses its publisher root and catalog', async (t) => {
  const dir = makeTempDir('peartube-relay-publisher-restart-')
  const logger = createFakeLogger()

  try {
    const config = resolveRelayConfig({ storage: { path: dir, maxBytes: 1_000_000 } }, { env: {} })

    const runtimeA = await createRelayRuntime({ config, logger })
    await runtimeA.start()
    const first = await createRelayPublisherShell({ api: runtimeA.api, storagePath: dir, logger }).ensureLocalPublisher()
    const firstRoot = JSON.parse(readFileSync(join(dir, 'publisher-root'), 'utf8'))
    await runtimeA.close()

    const runtimeB = await createRelayRuntime({ config, logger })
    await runtimeB.start()
    const second = await createRelayPublisherShell({ api: runtimeB.api, storagePath: dir, logger }).ensureLocalPublisher()
    const secondRoot = JSON.parse(readFileSync(join(dir, 'publisher-root'), 'utf8'))

    t.is(second.publisherId, first.publisherId, 'the publisher id survived the restart')
    t.is(secondRoot.publicKey, firstRoot.publicKey, 'the root key survived the restart')

    const catalog = await runtimeB.api.provisionPublisherCatalog({
      publisherId: second.publisherId,
      genesisRootKey: Buffer.from(secondRoot.publicKey, 'hex')
    })
    t.ok(catalog.writable && catalog.admitted, 'the catalog is still writable and admitted after restart')

    await runtimeB.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
