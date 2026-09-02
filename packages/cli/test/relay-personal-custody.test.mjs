import test from 'brittle'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveRelayConfig } from '../src/config.js'
import { createRelayRuntime } from '../src/runtime.js'
import { createArchivePublisher } from '../src/archive-manager.js'

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

function publisherFor(runtime, dir) {
  // Record every provisioning round-trip so a test can prove which store's key
  // the relay actually persisted, rather than just that it persisted something.
  const calls = []
  const api = {
    ...runtime.api,
    async provisionPersonalEncryption(request) {
      const result = await runtime.api.provisionPersonalEncryption(request)
      calls.push({ deviceLocal: request.deviceLocal === true, result })
      return result
    }
  }
  const publisher = createArchivePublisher({
    identityManager: runtime.identityManager,
    uploadManager: runtime.uploadManager,
    api,
    runtime,
    storagePath: dir,
    canPublish: () => true
  })
  return { publisher, calls }
}

// A relay has no OS keychain, so it is its own custodian for the personal-store
// secret. Before this was wired up, the very first archive job on a fresh relay
// created an identity whose personal store could never open, and the job died
// with PERSONAL_STORE_SECRET_UNAVAILABLE. Starting from genuinely empty storage
// is the whole point: a half-provisioned relay hides the failure.
test('a fresh relay provisions its own personal-store secret when it creates its first identity', async (t) => {
  const dir = makeTempDir('peartube-relay-custody-')
  const logger = createFakeLogger()

  try {
    const config = resolveRelayConfig({ storage: { path: dir, maxBytes: 1_000_000 } }, { env: {} })
    const runtime = await createRelayRuntime({ config, logger })
    await runtime.start()

    t.absent(runtime.identityManager.getActiveIdentity?.()?.publicKey, 'storage starts with no identity')
    t.absent(existsSync(join(dir, 'personal-secret')), 'storage starts with no personal secret')

    const { publisher, calls } = publisherFor(runtime, dir)
    const channel = await publisher.ensureAnonymousChannel({ channelName: 'Fresh Relay Archive' })

    t.ok(channel?.publisherId, 'first archive channel resolves against a usable identity')

    const secretPath = join(dir, 'personal-secret')
    t.ok(existsSync(secretPath), 'the relay persisted a secret for itself')
    const record = JSON.parse(readFileSync(secretPath, 'utf8'))
    t.ok(/^[0-9a-f]{64}$/.test(record.secret), 'the persisted secret is 32 bytes of hex')

    // provisionSecret hands back the opened store's key for either mode, so a
    // nonempty bootstrapKey proves nothing on its own: under the clobber bug it
    // would hold the identity store's key and still look stable. Pin it to the
    // key the device-local call actually returned.
    const deviceLocalCall = calls.find((call) => call.deviceLocal)
    const identityCall = calls.find((call) => !call.deviceLocal)
    t.ok(deviceLocalCall, 'the relay seeded a device-local store before creating an identity')
    t.ok(identityCall, 'the relay then provisioned the identity-keyed store')
    t.is(record.bootstrapKey, deviceLocalCall.result.bootstrapKey, 'the persisted bootstrap key is the anonymous store key')
    t.not(record.bootstrapKey, identityCall.result.bootstrapKey, 'the identity provision did not overwrite it')

    await runtime.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The secret is the encryption key for the store: regenerating it on restart
// would strand everything the relay already wrote.
test('a restarted relay reuses its persisted personal-store secret', async (t) => {
  const dir = makeTempDir('peartube-relay-custody-restart-')
  const logger = createFakeLogger()

  try {
    const config = resolveRelayConfig({ storage: { path: dir, maxBytes: 1_000_000 } }, { env: {} })

    const runtimeA = await createRelayRuntime({ config, logger })
    await runtimeA.start()
    await publisherFor(runtimeA, dir).publisher.ensureAnonymousChannel({ channelName: 'Fresh Relay Archive' })
    const firstRecord = JSON.parse(readFileSync(join(dir, 'personal-secret'), 'utf8'))
    await runtimeA.close()

    const runtimeB = await createRelayRuntime({ config, logger })
    await runtimeB.start()
    await publisherFor(runtimeB, dir).publisher.ensureAnonymousChannel({ channelName: 'Fresh Relay Archive' })
    const secondRecord = JSON.parse(readFileSync(join(dir, 'personal-secret'), 'utf8'))
    await runtimeB.close()

    t.is(secondRecord.secret, firstRecord.secret, 'the restarted relay kept the same secret')
    t.is(secondRecord.bootstrapKey, firstRecord.bootstrapKey, 'the restarted relay kept the same bootstrap key')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
