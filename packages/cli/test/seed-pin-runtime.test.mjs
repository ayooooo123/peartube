import { EventEmitter } from 'node:events'

import b4a from 'b4a'
import test from 'brittle'

import { resolveRelayConfig } from '../src/config.js'
import { createRelayRuntime } from '../src/runtime.js'
import { installSeedPinIdentityMutationHooks } from '../../backend/src/seed-pin/index.js'

const CLIENT_AUTH = Object.freeze({
  identityPublicKey: '11'.repeat(32),
  deviceKeyPair: Object.freeze({
    publicKey: b4a.alloc(32, 0x31),
    secretKey: b4a.alloc(64, 0x32),
  }),
  deviceProof: b4a.alloc(64, 0x41),
  signedDescriptor: Object.freeze({ schema: 'peartube.channel.root.signed.v1' }),
})

function createHarness ({ seedPin = {}, failFeedStart = false, authAfterIdentityMutation = false } = {}) {
  const events = []
  const swarm = new EventEmitter()
  swarm.connections = new Set()
  swarm.peers = new Set()
  swarm.keyPair = CLIENT_AUTH.deviceKeyPair
  swarm.dht = {}
  swarm.destroy = async () => { events.push('swarm-destroy') }
  const ctx = {
    swarm,
    store: {
      primaryKey: b4a.alloc(32, 0x51),
      close: async () => { events.push('store-close') },
    },
    metaDb: {},
    blobServer: { close: async () => { events.push('blob-close') } },
  }
  let registerOptions = null
  let registration = null
  let currentClientAuth = authAfterIdentityMutation ? null : CLIENT_AUTH
  let seedPinClient = null

  class PublicFeedManager {
    constructor () {
      this.entries = new Map()
      this.feedDiscovery = null
    }
    handleDiscoveredPeer () {}
    handleConnection () {}
    setOnFeedUpdate () {}
    setAvailabilityHintProvider () {}
    setFeedSnapshotProvider () {}
    setSignedDescriptorProvider () {}
    getFeed () { return [] }
    getStats () { return {} }
    async start () {
      events.push('feed-start')
      if (failFeedStart) throw new Error('feed failed')
    }
    async stop () { events.push('feed-stop') }
  }

  class CacheManager {
    async init () { events.push('cache-ready') }
    addChannel () { return Promise.resolve() }
  }

  const dependencies = {
    initializeStorage: async () => {
      events.push('storage-ready')
      return ctx
    },
    loadChannel: async () => null,
    loadPublicBee: async () => null,
    getNetworkStats: () => ({}),
    PublicFeedManager,
    CacheManager,
    createRelaySeeder: () => ({
      seedFeedEntries: async () => {},
      seedCachedChannels: async () => {},
      getStats: () => ({}),
      close: async () => { events.push('seeder-close') },
    }),
    createRelayBlindPeer: async () => ({
      enabled: false,
      getStats: () => ({}),
      close: async () => { events.push('blind-close') },
    }),
    readPrimaryKeyFile: async () => b4a.alloc(32, 0x61),
    writePrimaryKeyFile: async () => {},
    createIdentityManager: () => ({
      async loadIdentities () { events.push('identity-ready') },
      async ensureSignedChannelDescriptors () {},
      async createIdentity () {
        events.push('identity-created')
        currentClientAuth = CLIENT_AUTH
        return { publicKey: CLIENT_AUTH.identityPublicKey }
      },
    }),
    createUploadManager: () => ({}),
    createApi: () => ({}),
    resolveSeedPinClientAuth: async () => {
      events.push('client-auth-ready')
      return currentClientAuth
    },
    createRelaySeedPinAdmission: () => () => true,
    createRelaySeedPinCapacityPolicy: ({ maxBytes }) => Object.assign(
      async () => true,
      { maxBytes, release: async () => true },
    ),
    createRelaySeedPinReleasePolicy: ({ retentionDays }) => Object.assign(
      async () => true,
      { retentionDays },
    ),
    installSeedPinIdentityMutationHooks,
    registerSeedPinProtocol: (_ctx, options) => {
      events.push('seed-pin-register')
      registerOptions = options
      const channel = Object.freeze({ id: 'existing-seed-pin-channel' })
      seedPinClient = {
        channel,
        authEnabled: false,
        async pin () {
          if (!this.authEnabled) throw new Error('AUTH_UNAVAILABLE')
          return { state: 'accepted' }
        },
        async status () {
          if (!this.authEnabled) throw new Error('AUTH_UNAVAILABLE')
          return { state: 'accepted' }
        },
      }
      registration = {
        enabled: true,
        clients: new Map(),
        clientAuth: null,
        async refreshClientAuth () {
          this.clientAuth = await options.resolveClientAuth()
          seedPinClient.authEnabled = this.clientAuth !== null
          this.clients.clear()
          if (seedPinClient.authEnabled) this.clients.set('remote', seedPinClient)
          return this.clientAuth
        },
        async unregister () { events.push('seed-pin-unregister') },
      }
      return registration
    },
  }
  const config = resolveRelayConfig({
    storage: { path: './test-relay', maxBytes: 10_000 },
    seedPin,
  }, { env: {} })
  const logger = { runtime: { info () {}, warn () {}, debug () {}, error () {} } }
  return {
    config,
    ctx,
    dependencies,
    events,
    logger,
    get registerOptions () { return registerOptions },
    get registration () { return registration },
    get seedPinClient () { return seedPinClient },
  }
}

test('relay registers the shared protocol after identity/admission readiness and before feed discovery', async (t) => {
  const harness = createHarness({
    seedPin: { maxBytes: 4096, maxConcurrent: 3, retentionDays: 7 },
  })
  const runtime = await createRelayRuntime({
    config: harness.config,
    logger: harness.logger,
    dependencies: harness.dependencies,
  })
  const connectionListenersBeforeStart = harness.ctx.swarm.listenerCount('connection')
  await runtime.start()

  t.is(harness.events.indexOf('storage-ready') < harness.events.indexOf('identity-ready'), true)
  t.is(harness.events.indexOf('identity-ready') < harness.events.indexOf('seed-pin-register'), true)
  t.is(harness.events.indexOf('seed-pin-register') < harness.events.indexOf('client-auth-ready'), true)
  t.is(harness.events.indexOf('client-auth-ready') < harness.events.indexOf('feed-start'), true)
  t.is(harness.ctx.swarm.listenerCount('connection'), connectionListenersBeforeStart, 'stub registration proves runtime adds no extra listener itself')

  const options = harness.registerOptions
  t.is(options.enabled, true)
  t.is(typeof options.resolveClientAuth, 'function')
  t.is(harness.registration.clientAuth, CLIENT_AUTH, 'stored active-device proof bundle is resolved intact by the shared registration')
  let listActiveCalls = 0
  const workerOptions = options.pinWorkerOptions({
    async getActiveUsage () {
      return {
        version: 1,
        activeCount: 0,
        reservedBytes: 0,
        downloadedBytes: 0,
        usedBytes: 0,
      }
    },
    async listActive () {
      listActiveCalls++
      throw new Error('capacity policy must not scan active records')
    },
  })
  await workerOptions.capacityPolicy.ready
  t.is(listActiveCalls, 0)
  t.is(workerOptions.concurrency, 3)
  t.is(workerOptions.capacityPolicy.maxBytes, 4096)
  t.is(workerOptions.releasePolicy.retentionDays, 7)
  t.is(options.verificationLimiterOptions.maxConcurrent, 3)
  t.is(typeof options.admission, 'function')
  t.is(runtime.seedPin, harness.registration)
  t.is(runtime.seedPinClients, harness.registration.clients)

  await runtime.close()
  t.is(harness.events.indexOf('seed-pin-unregister') < harness.events.indexOf('swarm-destroy'), true)
  t.is(harness.events.indexOf('seed-pin-unregister') < harness.events.indexOf('store-close'), true)
})

test('first relay identity creation refreshes the existing seed-pin client in place once', async (t) => {
  const harness = createHarness({ authAfterIdentityMutation: true })
  const runtime = await createRelayRuntime({
    config: harness.config,
    logger: harness.logger,
    dependencies: harness.dependencies,
  })
  await runtime.start()

  const client = harness.seedPinClient
  const channel = client.channel
  t.is(client.authEnabled, false)
  t.is(runtime.seedPinClients.size, 0)
  const beforeRefreshes = harness.events.filter(event => event === 'client-auth-ready').length

  await runtime.identityManager.createIdentity('Anonymous Archive', true)

  t.is(client.authEnabled, true)
  t.is(client.channel, channel, 'the existing client channel is retained')
  t.is(runtime.seedPinClients.get('remote'), client)
  t.is((await client.pin()).state, 'accepted')
  t.is((await client.status()).state, 'accepted')
  t.is(
    harness.events.filter(event => event === 'client-auth-ready').length,
    beforeRefreshes + 1,
    'successful identity mutation performs one auth refresh',
  )
  await runtime.close()
  const refreshesAfterClose = harness.events.filter(event => event === 'client-auth-ready').length
  await runtime.identityManager.createIdentity('After close', true)
  t.is(
    harness.events.filter(event => event === 'client-auth-ready').length,
    refreshesAfterClose,
    'shutdown restores identity mutators and leaves no refresh hook',
  )
})

test('disabled relay seed pins create no registration or connection listener', async (t) => {
  const harness = createHarness({ seedPin: { enabled: false } })
  harness.dependencies.registerSeedPinProtocol = () => { throw new Error('disabled registration must not run') }
  harness.dependencies.resolveSeedPinClientAuth = () => { throw new Error('disabled auth resolution must not run') }
  const runtime = await createRelayRuntime({
    config: harness.config,
    logger: harness.logger,
    dependencies: harness.dependencies,
  })
  const before = harness.ctx.swarm.listenerCount('connection')
  await runtime.start()
  t.is(harness.ctx.swarm.listenerCount('connection'), before)
  t.is(runtime.seedPin, null)
  t.is(runtime.seedPinClients, null)
  await runtime.close()
})

test('relay startup failure unregisters seed pins before closing swarm and Corestore', async (t) => {
  const harness = createHarness({ failFeedStart: true })
  const runtime = await createRelayRuntime({
    config: harness.config,
    logger: harness.logger,
    dependencies: harness.dependencies,
  })

  await t.exception(runtime.start(), /feed failed/)
  t.is(harness.events.filter(event => event === 'seed-pin-unregister').length, 1)
  t.is(harness.events.indexOf('seed-pin-unregister') < harness.events.indexOf('swarm-destroy'), true)
  t.is(harness.events.indexOf('swarm-destroy') < harness.events.indexOf('store-close'), true)

  await runtime.close()
  t.is(harness.events.filter(event => event === 'seed-pin-unregister').length, 1, 'close is idempotent after failed startup')
})
