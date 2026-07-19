import { EventEmitter } from 'node:events'

import b4a from 'b4a'
import test from 'brittle'

import { installSeedPinIdentityMutationHooks, registerSeedPinProtocol } from '../src/seed-pin/index.js'
import { installOwnedContentPublicationIdentityHooks, startBackendSeedPinBeforeDiscovery } from '../src/orchestrator.js'
import { shutdownBackend } from '../src/storage.js'

const REMOTE_KEY = b4a.alloc(32, 0x41)
const OTHER_REMOTE_KEY = b4a.alloc(32, 0x42)
const IDENTITY_KEY = '51'.repeat(32)

class FakeConnection extends EventEmitter {
  constructor (remotePublicKey = null) {
    super()
    this.remotePublicKey = remotePublicKey
    this.destroyed = false
    this.mux = { stream: this }
  }
}

function createHandle (kind, options, calls) {
  const handle = {
    kind,
    options,
    closed: 0,
    close () { this.closed++ },
  }
  calls.push(handle)
  return handle
}

function clientAuth (identityPublicKey = IDENTITY_KEY, fill = 0x31) {
  return {
    identityPublicKey,
    deviceKeyPair: {
      publicKey: b4a.alloc(32, fill),
      secretKey: b4a.alloc(64, fill + 1),
    },
    deviceProof: b4a.alloc(64, fill + 2),
    signedDescriptor: {
      schema: 'peartube.channel.root.signed.v1',
      proof: b4a.toString(b4a.alloc(64, fill + 2), 'hex'),
      attestation: `${identityPublicKey}:${fill}`,
    },
  }
}

test('registration attaches existing and future authenticated connections once without replacing replication', async (t) => {
  const swarm = new EventEmitter()
  const existing = new FakeConnection(REMOTE_KEY)
  swarm.connections = new Set([existing])
  const ctx = { swarm, metaDb: {}, store: {} }
  const serverCalls = []
  const clientCalls = []
  let replicationCalls = 0
  const replicationListener = () => { replicationCalls++ }
  swarm.on('connection', replicationListener)

  const pinStore = {}
  const worker = { resume: () => Promise.resolve(), stop: async () => { throw new Error('external worker must not stop') } }
  const verificationLimiter = { tryAcquire () { return () => {} } }
  const registration = registerSeedPinProtocol(ctx, {
    store: pinStore,
    worker,
    verificationLimiter,
    admission: () => true,
    capacity: () => true,
    clientAuth: clientAuth(),
    protomuxFrom: connection => connection.mux,
    serverFactory: (_mux, options) => createHandle('server', options, serverCalls),
    clientFactory: (_mux, options) => createHandle('client', options, clientCalls),
  })

  t.is(serverCalls.length, 1, 'existing connection receives one server')
  t.is(clientCalls.length, 1, 'eligible existing connection receives one client')
  t.is(serverCalls[0].options.remotePublicKey, existing.remotePublicKey, 'server receives the live connection key bytes')
  t.is(serverCalls[0].options.store, pinStore)
  t.is(serverCalls[0].options.worker, worker)
  t.is(serverCalls[0].options.verificationLimiter, verificationLimiter)
  t.is(clientCalls[0].options.deviceKeyPair.secretKey, registration.clientAuth.deviceKeyPair.secretKey, 'factory receives local signer without transmitting it')
  t.is(ctx.seedPinClients.get(b4a.toString(REMOTE_KEY, 'hex')), clientCalls[0])

  swarm.emit('connection', existing, { publicKey: OTHER_REMOTE_KEY })
  t.is(serverCalls.length, 1, 'duplicate event does not create a second mux pair')
  t.is(replicationCalls, 1, 'pre-existing replication listener remains active')

  const future = new FakeConnection(null)
  swarm.connections.add(future)
  swarm.emit('connection', future, { publicKey: OTHER_REMOTE_KEY })
  t.is(serverCalls.length, 1, 'caller-declared info key is never trusted')
  future.remotePublicKey = OTHER_REMOTE_KEY
  future.emit('open')
  t.is(serverCalls.length, 2, 'connection attaches once its authenticated byte key exists')
  t.is(clientCalls.length, 2)
  swarm.emit('connection', future, {})
  future.emit('open')
  t.is(serverCalls.length, 2, 'future connection/open races remain idempotent')

  future.emit('close')
  t.is(serverCalls[1].closed, 1)
  t.is(clientCalls[1].closed, 1)
  t.absent(ctx.seedPinClients.has(b4a.toString(OTHER_REMOTE_KEY, 'hex')))

  const listenerCountBefore = swarm.listenerCount('connection')
  await registration.unregister()
  t.is(swarm.listenerCount('connection'), listenerCountBefore - 1, 'unregister removes only its swarm listener')
  t.is(serverCalls[0].closed, 1)
  t.is(clientCalls[0].closed, 1)
  t.is(ctx.seedPinClients.size, 0)
  t.is(swarm.listeners('connection').includes(replicationListener), true, 'replication listener is preserved after unregister')
})

test('client auth refresh replaces only sender halves and follows active identity fail closed', async (t) => {
  const swarm = new EventEmitter()
  const existing = new FakeConnection(REMOTE_KEY)
  swarm.connections = new Set([existing])
  const ctx = { swarm, metaDb: {}, store: {} }
  const serverCalls = []
  const clientCalls = []
  const worker = { resume: async () => {}, stop: async () => {} }
  const authA = clientAuth('61'.repeat(32), 0x41)
  const authB = clientAuth('62'.repeat(32), 0x51)
  let activeAuth = authA
  let resolutionError = null

  const registration = registerSeedPinProtocol(ctx, {
    store: {},
    worker,
    verificationLimiter: { tryAcquire () { return () => {} } },
    resolveClientAuth: async () => {
      if (resolutionError) throw resolutionError
      return activeAuth
    },
    protomuxFrom: connection => connection.mux,
    serverFactory: (_mux, options) => createHandle('server', options, serverCalls),
    clientFactory: (_mux, options) => {
      let rejectPending
      const handle = createHandle('client', options, clientCalls)
      handle.authEnabled = true
      handle.pending = new Promise((_resolve, reject) => { rejectPending = reject })
      void handle.pending.catch(() => {})
      handle.updateAuth = function (auth) {
        rejectPending(Object.assign(new Error('seed pin authentication changed'), {
          code: 'AUTH_REFRESHED',
          retryable: true,
        }))
        this.authEnabled = auth !== null
        if (auth) this.options = { ...this.options, ...auth }
      }
      handle.close = function () {
        this.closed++
        rejectPending(Object.assign(new Error('seed pin transport is closed'), {
          code: 'TRANSPORT_CLOSED',
          retryable: true,
        }))
      }
      return handle
    },
  })
  await registration.refreshClientAuth()
  t.is(serverCalls.length, 1)
  t.is(clientCalls.length, 1)
  t.is(clientCalls[0].options.identityPublicKey, authA.identityPublicKey)

  activeAuth = authB
  await registration.refreshClientAuth()
  let pendingError = null
  try { await clientCalls[0].pending } catch (error) { pendingError = error }
  t.is(pendingError.code, 'AUTH_REFRESHED')
  t.is(pendingError.retryable, true)
  t.is(clientCalls[0].closed, 0)
  t.is(clientCalls.length, 1)
  t.is(clientCalls[0].options.identityPublicKey, authB.identityPublicKey)
  t.alike(clientCalls[0].options.deviceProof, authB.deviceProof)
  t.is(serverCalls.length, 1, 'identity refresh never replaces the receiver')

  const future = new FakeConnection(OTHER_REMOTE_KEY)
  swarm.connections.add(future)
  swarm.emit('connection', future)
  await registration.refreshClientAuth()
  t.is(serverCalls.length, 2)
  t.is(clientCalls.length, 2)
  t.is(clientCalls[1].options.identityPublicKey, authB.identityPublicKey)

  activeAuth = null
  await registration.refreshClientAuth()
  t.is(clientCalls[0].closed, 0)
  t.is(clientCalls[1].closed, 0)
  t.is(clientCalls[0].authEnabled, false)
  t.is(clientCalls[1].authEnabled, false)
  t.is(ctx.seedPinClients.size, 0)
  t.is(serverCalls[0].closed, 0)
  t.is(serverCalls[1].closed, 0)

  activeAuth = authB
  await registration.refreshClientAuth()
  t.is(clientCalls.length, 2)
  t.is(clientCalls[0].authEnabled, true)
  t.is(clientCalls[1].authEnabled, true)
  resolutionError = new Error('identity manager unavailable')
  await registration.refreshClientAuth()
  t.is(clientCalls[0].closed, 0)
  t.is(clientCalls[1].closed, 0)
  t.is(clientCalls[0].authEnabled, false)
  t.is(clientCalls[1].authEnabled, false)
  t.is(ctx.seedPinClients.size, 0)
  t.is(registration.error, resolutionError)
  t.is(serverCalls[0].closed, 0)
  t.is(serverCalls[1].closed, 0)

  await registration.unregister()
  t.is(serverCalls[0].closed, 1)
  t.is(serverCalls[1].closed, 1)
})

test('all active identity mutations refresh personal then seed-pin auth once and fail closed', async (t) => {
  const events = []
  let activePublicKey = null
  let failPersonal = false
  const identityManager = {
    getActivePublicKey () { return activePublicKey },
    getIdentities () { return [] },
    async setActiveIdentity (publicKey) {
      events.push(`set:${publicKey}`)
      activePublicKey = publicKey
      return { method: 'set', publicKey }
    },
    async createIdentity (_name) {
      events.push(`create:${IDENTITY_KEY}`)
      activePublicKey = IDENTITY_KEY
      return { method: 'create', publicKey: IDENTITY_KEY }
    },
    async createSourceIdentity () { events.push('source'); return { method: 'source' } },
    async recoverIdentity (_mnemonic) {
      const publicKey = '71'.repeat(32)
      events.push(`recover:${publicKey}`)
      activePublicKey = publicKey
      return { method: 'recover', publicKey }
    },
    async addPairedChannelIdentity () { events.push('paired'); return { method: 'paired' } },
    async bootstrapDevice () { events.push('bootstrap'); return { method: 'bootstrap' } },
    async ensureSignedChannelDescriptors () { events.push('descriptors'); return { method: 'descriptors' } },
  }
  const uninstall = installOwnedContentPublicationIdentityHooks({
    ctx: {},
    identityManager,
    publicFeed: {},
    refreshActivePersonalStore: async publicKey => {
      events.push(`personal:${publicKey}`)
      if (failPersonal) throw new Error('personal failed')
    },
    refreshSeedPinClientAuth: async options => {
      events.push(`seed-pin:${options.failClosed}`)
    },
    log: { warn: (_message, error) => events.push(`warn:${error}`) },
  })

  const setResult = await identityManager.setActiveIdentity('61'.repeat(32))
  t.is(setResult.method, 'set')
  t.alike(events.splice(0), [
    `set:${'61'.repeat(32)}`,
    `personal:${'61'.repeat(32)}`,
    'seed-pin:false',
  ])

  const createResult = await identityManager.createIdentity('new')
  t.is(createResult.method, 'create')
  t.alike(events.splice(0), [
    `create:${IDENTITY_KEY}`,
    `personal:${IDENTITY_KEY}`,
    'seed-pin:false',
  ])

  const recovered = '71'.repeat(32)
  const recoverResult = await identityManager.recoverIdentity('mnemonic')
  t.is(recoverResult.method, 'recover')
  t.alike(events.splice(0), [
    `recover:${recovered}`,
    `personal:${recovered}`,
    'seed-pin:false',
  ])

  for (const [method, marker] of [
    ['addPairedChannelIdentity', 'paired'],
    ['createSourceIdentity', 'source'],
    ['bootstrapDevice', 'bootstrap'],
    ['ensureSignedChannelDescriptors', 'descriptors'],
  ]) {
    const result = await identityManager[method]()
    t.is(result.method, marker)
    t.alike(events.splice(0), [
      marker,
      `personal:${recovered}`,
      'seed-pin:false',
    ])
  }

  failPersonal = true
  const failedPersonalResult = await identityManager.createIdentity('still succeeds')
  t.is(failedPersonalResult.method, 'create', 'post-mutation failure preserves the original return')
  t.alike(events.splice(0), [
    `create:${IDENTITY_KEY}`,
    `personal:${IDENTITY_KEY}`,
    'warn:personal failed',
    'seed-pin:true',
  ])

  uninstall()
})

test('identity mutation hook emits fixed change signals without arguments, results, or secrets', async (t) => {
  const mnemonic = 'recover mnemonic must remain private'
  const deviceProof = b4a.from('private-device-proof')
  const manager = {
    async createIdentity (_name, _generateMnemonic) {
      return { identityPublicKey: IDENTITY_KEY, mnemonic: 'created mnemonic must remain private' }
    },
    async recoverIdentity (_mnemonic) {
      return { identityPublicKey: '71'.repeat(32), mnemonic }
    },
    async bootstrapDevice (_proof) {
      return { deviceProof }
    },
  }
  const signals = []
  const uninstall = installSeedPinIdentityMutationHooks({
    identityManager: manager,
    onMutation: signal => signals.push(signal),
  })

  const created = await manager.createIdentity('archive', true)
  const recovered = await manager.recoverIdentity(mnemonic)
  const bootstrapped = await manager.bootstrapDevice(deviceProof)
  t.is(created.mnemonic, 'created mnemonic must remain private', 'original result is returned only to caller')
  t.is(recovered.mnemonic, mnemonic)
  t.is(bootstrapped.deviceProof, deviceProof)
  t.alike(signals, [
    { method: 'createIdentity', label: 'New identity', reconcile: true },
    { method: 'recoverIdentity', label: 'Recovered identity', reconcile: true },
    { method: 'bootstrapDevice', label: 'Device proof', reconcile: false },
  ])
  const serializedSignals = JSON.stringify(signals)
  t.is(serializedSignals.includes('mnemonic'), false)
  t.is(serializedSignals.includes('private-device-proof'), false)
  t.is(signals.every(signal => !('args' in signal) && !('result' in signal) && !('error' in signal)), true)
  uninstall()
})

test('registration gates malformed remote keys and owns only resources it constructs', async (t) => {
  const swarm = new EventEmitter()
  const malformed = new FakeConnection('41'.repeat(32))
  const short = new FakeConnection(b4a.alloc(31))
  swarm.connections = new Set([malformed, short])
  const ctx = { swarm, metaDb: {}, store: {} }
  const serverCalls = []
  let storeClosed = 0
  let workerResumed = 0
  let workerStopped = 0
  let resumeFinished = false

  const registration = registerSeedPinProtocol(ctx, {
    admission: () => true,
    protomuxFrom: connection => connection.mux,
    pinStoreFactory: ({ db }) => ({ db, close: async () => { storeClosed++ } }),
    pinWorkerOptions: pinStore => ({ marker: pinStore }),
    pinWorkerFactory: ({ corestore, pinStore, marker }) => ({
      corestore,
      pinStore,
      marker,
      resume: async () => {
        workerResumed++
        resumeFinished = true
      },
      stop: async () => { workerStopped++ },
    }),
    serverFactory: (_mux, options) => createHandle('server', options, serverCalls),
  })

  await registration.ready
  t.is(serverCalls.length, 0, 'string and non-32-byte remote keys are rejected')
  t.is(workerResumed, 1, 'owned worker resume feeder starts')
  t.is(resumeFinished, true, 'registration awaits bounded initial resume scheduling')
  t.is(registration.worker.marker, registration.store, 'worker options may be derived from the constructed shared store')
  await registration.unregister()
  t.is(workerStopped, 1)
  t.is(storeClosed, 1)
})

test('initial resume failure rejects readiness and unwinds owned registration resources', async (t) => {
  const swarm = new EventEmitter()
  swarm.connections = new Set([new FakeConnection(REMOTE_KEY)])
  const ctx = { swarm, metaDb: {}, store: {} }
  let storeClosed = 0
  let workerStopped = 0
  const servers = []
  const registration = registerSeedPinProtocol(ctx, {
    pinStoreFactory: () => ({ close: async () => { storeClosed++ } }),
    pinWorkerFactory: () => ({
      resume: async () => { throw new Error('resume corruption') },
      stop: async () => { workerStopped++ },
    }),
    protomuxFrom: connection => connection.mux,
    serverFactory: (_mux, options) => createHandle('server', options, servers),
  })
  await t.exception(registration.ready, /resume corruption/)
  t.is(registration.error.message, 'resume corruption')
  t.is(swarm.listenerCount('connection'), 0)
  t.is(servers[0].closed, 1)
  t.is(workerStopped, 1)
  t.is(storeClosed, 1)
})

test('disabled registration creates no resources or listeners', async (t) => {
  const swarm = new EventEmitter()
  swarm.connections = new Set([new FakeConnection(REMOTE_KEY)])
  const ctx = { swarm, metaDb: {}, store: {} }
  const before = swarm.listenerCount('connection')
  const registration = registerSeedPinProtocol(ctx, {
    enabled: false,
    pinStoreFactory: () => { throw new Error('must not construct') },
  })

  t.is(registration.enabled, false)
  t.is(swarm.listenerCount('connection'), before)
  t.absent(ctx.seedPinClients)
  await registration.unregister()
})

test('backend registers receiver and active sender after identity readiness but before discovery', async (t) => {
  const events = []
  const ctx = { swarm: {}, metaDb: {}, store: {} }
  const auth = clientAuth()
  let options = null
  const registration = {
    clients: new Map(),
    async refreshClientAuth () { return options.resolveClientAuth() },
    async unregister () { events.push('unregister') },
  }
  const identityManager = { getSeedPinOwnershipFacts () { return { identityOwned: true, channelAccess: 'owned' } } }
  const publicFeed = {
    start () {
      events.push('feed-start')
      return Promise.resolve('started')
    },
  }
  events.push('identity-ready')
  const started = await startBackendSeedPinBeforeDiscovery({
    ctx,
    identityManager,
    publicFeed,
    seedPin: { enabled: true, serverOptions: { marker: 'backend' } },
    resolveClientAuth: async () => {
      events.push('client-auth-ready')
      return auth
    },
    createAdmission: () => {
      events.push('admission-ready')
      return () => true
    },
    register: (_ctx, registerOptions) => {
      events.push('seed-pin-register')
      options = registerOptions
      return registration
    },
  })
  await started.discovery

  t.alike(events, ['identity-ready', 'admission-ready', 'seed-pin-register', 'client-auth-ready', 'feed-start'])
  t.is(await options.resolveClientAuth(), auth)
  t.is(typeof options.admission, 'function')
  t.alike(options.serverOptions, { marker: 'backend' })
  t.is(ctx.seedPinRegistration, registration)
  t.is(started.registration, registration)
})

test('backend disabled path creates no seed-pin registration and discovery failure cleans registration', async (t) => {
  let registerCalls = 0
  const disabled = await startBackendSeedPinBeforeDiscovery({
    ctx: {},
    identityManager: {},
    publicFeed: { start: async () => 'started' },
    seedPin: { enabled: false },
    register: () => { registerCalls++ },
  })
  t.is(registerCalls, 0)
  t.is(disabled.registration, null)
  t.is(await disabled.discovery, 'started')

  let unregistered = 0
  const failure = await startBackendSeedPinBeforeDiscovery({
    ctx: { swarm: {}, metaDb: {}, store: {} },
    identityManager: { getSeedPinOwnershipFacts () { return { identityOwned: true, channelAccess: 'owned' } } },
    publicFeed: { start: async () => { throw new Error('discovery failed') } },
    resolveClientAuth: async () => null,
    createAdmission: () => () => true,
    register: () => ({ clients: new Map(), async unregister () { unregistered++ } }),
  })
  await t.exception(failure.discovery, /discovery failed/)
  t.is(unregistered, 1)
})

test('backend shutdown unregisters seed pins before feed, swarm, and Corestore', async (t) => {
  const events = []
  const ctx = {
    seedPinRegistration: { async unregister () { events.push('seed-pin-unregister') } },
    publicFeed: {
      async _persistDiscoveredNow () {},
      async stop () { events.push('feed-stop') },
    },
    swarm: { async destroy () { events.push('swarm-destroy') } },
    metaDb: { async close () { events.push('meta-close') } },
    store: { async close () { events.push('store-close') } },
  }
  await shutdownBackend(ctx)
  t.is(events[0], 'seed-pin-unregister')
  t.is(events.indexOf('seed-pin-unregister') < events.indexOf('feed-stop'), true)
  t.is(events.indexOf('seed-pin-unregister') < events.indexOf('swarm-destroy'), true)
  t.is(events.indexOf('seed-pin-unregister') < events.indexOf('store-close'), true)
})
