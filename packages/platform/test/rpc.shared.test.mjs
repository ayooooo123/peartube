import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const platformRoot = path.resolve(import.meta.dirname, '..')
const repositoryRoot = path.resolve(platformRoot, '../..')

async function loadCatalogModules() {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-platform-rpc-'))
  const hostRoot = path.join(repositoryRoot, 'packages/host/src')
  const hostEventsUrl = pathToFileURL(path.join(hostRoot, 'event-map.js')).href
  const hostContractsUrl = pathToFileURL(path.join(hostRoot, 'contracts.js')).href
  const sharedSourcePath = path.join(platformRoot, 'src/rpc.shared.ts')
  const sharedSource = fs.readFileSync(sharedSourcePath, 'utf8')
    .replace("import { PROTOCOL_VERSION } from '@peartube/host/contracts'", `import { PROTOCOL_VERSION } from '${hostContractsUrl}'`)
    .replace(
      "import { PROTOCOL_EVENTS } from '@peartube/host/events'",
      `import { PROTOCOL_EVENTS } from '${hostEventsUrl}'`,
    )
  const sharedOutput = ts.transpileModule(sharedSource, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sharedSourcePath,
  }).outputText
  const sharedModulePath = path.join(temporaryDirectory, 'rpc.shared.mjs')
  fs.writeFileSync(sharedModulePath, sharedOutput)

  const hostSourcePath = path.join(hostRoot, 'create-client.js')
  const hostSource = fs.readFileSync(hostSourcePath, 'utf8')
    .replace("from './contracts.js'", `from '${hostContractsUrl}'`)
    .replace("import DefaultHRPC from '@peartube/spec'", 'const DefaultHRPC = null')
    .replace(
      "from '@peartube/spec/app-rpc-adapter'",
      `from '${pathToFileURL(path.join(repositoryRoot, 'packages/spec/spec/hrpc/app-rpc-adapter.mjs')).href}'`,
    )
    .replace("from './event-map.js'", `from '${hostEventsUrl}'`)
  const hostModulePath = path.join(temporaryDirectory, 'create-client.mjs')
  fs.writeFileSync(hostModulePath, hostSource)

  try {
    const [shared, host, contracts] = await Promise.all([
      import(pathToFileURL(sharedModulePath).href),
      import(pathToFileURL(hostModulePath).href),
      import(pathToFileURL(path.join(hostRoot, 'contracts.js')).href),
    ])
    return { ...shared, ...host, ...contracts }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

async function exercisePlatformCatalog(platform) {
  const { PROTOCOL_VERSION, createChannelCatalogRpc, createPlatformRpcBridge, createProtocolClient } = await loadCatalogModules()
  let resolveStatus
  const rawCalls = []
  const invalidCursor = {
    success: false,
    errorCode: 'INVALID_CURSOR',
    error: 'Invalid catalog cursor',
    group: null,
    items: [],
    nextCursor: null,
  }

  class CatalogHRPC {
    getStatus() {
      return new Promise((resolve) => {
        resolveStatus = resolve
      })
    }

    getContentCatalog(request) {
      rawCalls.push(['catalog', request])
      return Promise.resolve({ success: true, profile: null, groups: [] })
    }

    getContentItems(request) {
      rawCalls.push(['items', request])
      return Promise.resolve(
        request.cursor === 'invalid'
          ? invalidCursor
          : { success: true, group: null, items: [], nextCursor: null },
      )
    }
  }

  const client = createProtocolClient({ stream: {}, HRPCImpl: CatalogHRPC })
  const bridge = createPlatformRpcBridge({
    platform,
    entrypoint: 'test-entry',
    getStoragePath: () => '/tmp/peartube-platform-test',
    runner: {
      async start() {
        return {
          stream: {},
          client,
          waitUntilReady: () => client.ready(),
          terminate: async () => {},
          onLifecycle: () => () => {},
        }
      },
    },
  })
  const initPromise = bridge.init()
  await Promise.resolve()
  await Promise.resolve()
  const platformRpc = createChannelCatalogRpc(() => {
    const activeClient = bridge.getClient()
    assert.ok(activeClient, `${platform} bridge must expose its active host client`)
    return activeClient
  })
  const catalogRequest = { channelKey: 'abc' }
  const zeroRequest = { channelKey: 'abc', groupId: 'latest', limit: 0 }
  const positiveRequest = { channelKey: 'abc', groupId: 'latest', limit: 24 }
  const omittedRequest = { channelKey: 'abc', publicBeeKey: 'def', groupId: 'latest' }

  const catalogPromise = platformRpc.getContentCatalog(catalogRequest)
  const zeroPromise = platformRpc.getContentItems(zeroRequest)
  const positivePromise = platformRpc.getContentItems(positiveRequest)
  const omittedPromise = platformRpc.getContentItems(omittedRequest)
  await Promise.resolve()
  assert.deepEqual(rawCalls, [], `${platform} calls must wait for host readiness`)

  resolveStatus({
    status: {
      blobServerPort: 9999,
      blobServerReady: true,
      blobServerError: null,
      protocolVersion: PROTOCOL_VERSION,
    },
  })

  await initPromise
  assert.equal((await catalogPromise).success, true)
  assert.equal((await zeroPromise).success, true)
  assert.equal((await positivePromise).success, true)
  assert.equal((await omittedPromise).success, true)
  assert.deepEqual(rawCalls, [
    ['catalog', catalogRequest],
    ['items', { ...zeroRequest, limitProvided: true }],
    ['items', { ...positiveRequest, limitProvided: true }],
    ['items', omittedRequest],
  ])
  assert.strictEqual(
    await platformRpc.getContentItems({ channelKey: 'abc', groupId: 'latest', cursor: 'invalid' }),
    invalidCursor,
  )
}

test('native and web bridge chains use host readiness and generated request-presence handling', async () => {
  await exercisePlatformCatalog('mobile')
  await exercisePlatformCatalog('desktop')
})

test('shared media graph facade exposes every command and preserves catalog limit presence', async () => {
  const { createMediaGraphRpc } = await loadCatalogModules()
  const calls = []
  const mediaGraph = {}
  for (const method of [
    'getMediaCatalog',
    'getMediaEntity',
    'getMediaCollection',
    'getMediaCollectionItems',
    'getMediaAgent',
    'getAgentContributions',
    'getPublicationSources',
    'getClaimProvenance',
    'setSourcePreference',
  ]) {
    mediaGraph[method] = async (request) => {
      calls.push([method, request])
      return { success: true, items: [] }
    }
  }
  const rpc = createMediaGraphRpc(() => ({
    ready: async () => {},
    mediaGraph,
  }))

  await rpc.getMediaCatalog({ limit: 0 })
  await rpc.getMediaCatalog({})
  await rpc.getMediaEntity({ entityId: 'work-1' })
  await rpc.getMediaCollection({ entityId: 'collection-1' })
  await rpc.getMediaCollectionItems({ collectionEntityId: 'collection-1', limit: 2 })
  await rpc.getMediaAgent({ entityId: 'agent-1' })
  await rpc.getAgentContributions({ agentEntityId: 'agent-1' })
  await rpc.getPublicationSources({ entityId: 'work-1' })
  await rpc.getClaimProvenance({ claimId: 'claim-1' })
  await rpc.setSourcePreference({ entityId: 'work-1', publicationId: 'publication-1', preferred: true })

  assert.deepEqual(calls, [
    ['getMediaCatalog', { limit: 0, limitProvided: true }],
    ['getMediaCatalog', {}],
    ['getMediaEntity', { entityId: 'work-1' }],
    ['getMediaCollection', { entityId: 'collection-1' }],
    ['getMediaCollectionItems', { collectionEntityId: 'collection-1', limit: 2, limitProvided: true }],
    ['getMediaAgent', { entityId: 'agent-1' }],
    ['getAgentContributions', { agentEntityId: 'agent-1' }],
    ['getPublicationSources', { entityId: 'work-1' }],
    ['getClaimProvenance', { claimId: 'claim-1' }],
    ['setSourcePreference', { entityId: 'work-1', publicationId: 'publication-1', preferred: true }],
  ])
})

test('platform bridge dispatches typed media graph updates', async () => {
  const { PROTOCOL_VERSION, createPlatformRpcBridge } = await loadCatalogModules()
  const listeners = new Map()
  const client = {
    rpc: {},
    events: {
      on(event, listener) {
        listeners.set(event, listener)
        return () => listeners.delete(event)
      },
    },
    ready: async () => ({ blobServerPort: 9999, protocolVersion: PROTOCOL_VERSION }),
    channel: {},
    mediaGraph: {},
  }
  const bridge = createPlatformRpcBridge({
    platform: 'desktop',
    entrypoint: 'test-entry',
    getStoragePath: () => '/tmp/peartube-platform-test',
    runner: {
      async start() {
        return {
          stream: {},
          client,
          waitUntilReady: () => client.ready(),
          terminate: async () => {},
          onLifecycle: () => () => {},
        }
      },
    },
  })
  const updates = []
  bridge.events.onMediaGraphUpdate((update) => updates.push(update))
  await bridge.init()
  listeners.get('mediaGraph.updated')({ revision: '42', changedCount: 5 })
  assert.deepEqual(updates, [{ revision: '42', changedCount: 5 }])
})

test('shared facade waits and preserves limit presence for an injected direct protocol client', async () => {
  const { PROTOCOL_VERSION, createChannelCatalogRpc, createPlatformRpcBridge } = await loadCatalogModules()
  let resolveReady
  const readyData = { blobServerPort: 9999, protocolVersion: PROTOCOL_VERSION }
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve
  })
  const rawCalls = []
  const directClient = {
    rpc: {},
    events: { on: () => () => {} },
    ready: () => readyPromise,
    channel: {
      async getContentCatalog(request) {
        rawCalls.push(['catalog', request])
        return { success: true, profile: null, groups: [] }
      },
      async getContentItems(request) {
        rawCalls.push(['items', request])
        return { success: true, group: null, items: [], nextCursor: null }
      },
    },
  }
  const bridge = createPlatformRpcBridge({
    platform: 'desktop',
    entrypoint: 'legacy-test-entry',
    getStoragePath: () => '/tmp/peartube-platform-test',
    runner: {
      async start() {
        return {
          stream: {},
          client: directClient,
          waitUntilReady: () => directClient.ready(),
          terminate: async () => {},
          onLifecycle: () => () => {},
        }
      },
    },
  })
  const initPromise = bridge.init()
  await Promise.resolve()
  await Promise.resolve()
  const platformRpc = createChannelCatalogRpc(() => bridge.getClient())
  const catalogRequest = { channelKey: 'abc' }
  const zeroRequest = { channelKey: 'abc', groupId: 'latest', limit: 0 }
  const positiveRequest = { channelKey: 'abc', groupId: 'latest', limit: 24 }
  const omittedRequest = { channelKey: 'abc', groupId: 'latest' }

  const catalogPromise = platformRpc.getContentCatalog(catalogRequest)
  const zeroPromise = platformRpc.getContentItems(zeroRequest)
  const positivePromise = platformRpc.getContentItems(positiveRequest)
  const omittedPromise = platformRpc.getContentItems(omittedRequest)
  await Promise.resolve()
  assert.deepEqual(rawCalls, [])

  resolveReady(readyData)
  await initPromise
  await Promise.all([catalogPromise, zeroPromise, positivePromise, omittedPromise])
  assert.deepEqual(rawCalls, [
    ['catalog', catalogRequest],
    ['items', { ...zeroRequest, limitProvided: true }],
    ['items', { ...positiveRequest, limitProvided: true }],
    ['items', omittedRequest],
  ])

  const readinessError = new Error('direct client not ready')
  const rejectedRawCalls = []
  const rejectedRpc = createChannelCatalogRpc(() => ({
    ready: () => Promise.reject(readinessError),
    channel: {
      async getContentCatalog(request) {
        rejectedRawCalls.push(['catalog', request])
      },
      async getContentItems(request) {
        rejectedRawCalls.push(['items', request])
      },
    },
  }))
  await assert.rejects(rejectedRpc.getContentCatalog(catalogRequest), readinessError)
  await assert.rejects(rejectedRpc.getContentItems(zeroRequest), readinessError)
  assert.deepEqual(rejectedRawCalls, [])
})

test('native and web RPC facades have identical media graph surfaces without feed compatibility', () => {
  for (const fileName of ['rpc.native.ts', 'rpc.web.ts']) {
    const source = fs.readFileSync(path.join(platformRoot, 'src', fileName), 'utf8')
    assert.match(source, /createChannelCatalogRpc/)
    assert.match(source, /\.\.\.createChannelCatalogRpc\(ensureProtocolClient\)/)
    assert.match(source, /createMediaGraphRpc/)
    assert.match(source, /\.\.\.createMediaGraphRpc\(ensureProtocolClient\)/)
    for (const legacyName of [
      'refreshFeed',
      'submitToFeed',
      'unpublishFromFeed',
      'isChannelPublished',
      'onEventFeedUpdate',
    ]) {
      assert.doesNotMatch(source, new RegExp(`\\b${legacyName}\\b`), `${fileName} removes ${legacyName}`)
    }
  }
})

test('publisher shell workflow provisions, binds intent through prepare/sign/submit, and consumes accepted contributions', async () => {
  const { createPublisherRootOperationRpc } = await loadCatalogModules()
  const calls = []
  const signerPublicKey = Buffer.alloc(32, 3)
  const candidateRecordId = Buffer.alloc(32, 7)
  const signature = Buffer.alloc(64, 11)
  const request = {
    publisherId: 'a'.repeat(64),
    recordType: 'publisher.writer-revocation',
    body: Buffer.from([1, 2, 3]),
    displaySummaryJson: '{"action":"revoke writer"}',
    intentExpiresAt: 1_700_000_060_000,
    userInitiated: true
  }
  const prepared = {
    intentId: 'intent-platform',
    success: true,
    publisherId: request.publisherId,
    recordType: request.recordType,
    unsignedBytes: Buffer.from([9, 8, 7]),
    candidateRecordId,
    signerPublicKey,
    bodyLength: request.body.byteLength,
    issuedAt: 1_700_000_000_000,
    intentExpiresAt: request.intentExpiresAt,
    displaySummaryJson: request.displaySummaryJson
  }
  const signed = {
    intentId: prepared.intentId,
    publisherId: prepared.publisherId,
    recordType: prepared.recordType,
    unsignedBytes: prepared.unsignedBytes,
    candidateRecordId,
    displaySummaryJson: prepared.displaySummaryJson,
    signer: signerPublicKey,
    signerPublicKey,
    signature
  }
  const client = {
    publisher: {
      async provisionPublisherCatalog(value) {
        calls.push(['provision', value])
        return { success: true, publisherId: value.publisherId, catalogBootstrapKey: Buffer.alloc(32, 4) }
      },
      async preparePublisherRootOperation(value) {
        calls.push(['prepare', value])
        return prepared
      },
      async submitPublisherRootOperation(value) {
        calls.push(['submit', value])
        return {
          intentId: value.intentId,
          success: true,
          valid: true,
          complete: false,
          recordId: candidateRecordId,
          signer: signerPublicKey,
          signerPublicKey,
          signature
        }
      }
    }
  }
  const signerBridge = {
    async beginUserIntent(value) {
      calls.push(['intent', value])
      return { intentId: 'intent-platform', signerPublicKey }
    },
    async signPreparedRecord(intentId, value) {
      calls.push(['sign', intentId, value])
      return signed
    },
    completeIntent(intentId) {
      calls.push(['complete', intentId])
    },
    cancelIntent() {
      throw new Error('cancel should not run')
    }
  }
  const publisher = createPublisherRootOperationRpc(() => client, signerBridge)
  const provisionRequest = { publisherId: request.publisherId, genesisRootKey: Buffer.alloc(32, 5) }

  const provisioned = await publisher.provisionPublisherCatalog(provisionRequest)
  const result = await publisher.authorizePublisherRootOperation(request)

  assert.deepEqual(calls, [
    ['provision', provisionRequest],
    ['intent', request],
    ['prepare', {
      publisherId: request.publisherId,
      recordType: request.recordType,
      body: request.body,
      displaySummaryJson: request.displaySummaryJson,
      intentExpiresAt: request.intentExpiresAt,
      intentId: 'intent-platform',
      signerPublicKey
    }],
    ['sign', 'intent-platform', prepared],
    ['submit', signed],
    ['complete', 'intent-platform']
  ])
  assert.equal(provisioned.success, true)
  assert.equal(result.success, true)
  assert.equal(result.complete, false)
})

test('publisher root workflow rejects renderer use and substituted submit identity', async () => {
  const { createPublisherRootOperationRpc } = await loadCatalogModules()
  const request = {
    publisherId: 'a'.repeat(64),
    recordType: 'publisher.namespace',
    body: Buffer.from([1]),
    displaySummaryJson: '{"action":"create publisher"}',
    intentExpiresAt: 1_700_000_060_000,
    userInitiated: true
  }
  const renderer = createPublisherRootOperationRpc(() => ({ publisher: {} }), null, { runtime: 'renderer' })
  await assert.rejects(
    renderer.authorizePublisherRootOperation(request),
    (error) => error?.code === 'PUBLISHER_SIGNER_RENDERER_FORBIDDEN' && !error.message.includes('create publisher'),
  )
  await assert.rejects(
    renderer.provisionPublisherCatalog({ publisherId: request.publisherId, genesisRootKey: Buffer.alloc(32) }),
    (error) => error?.code === 'PUBLISHER_SIGNER_RENDERER_FORBIDDEN',
  )

  const signerPublicKey = Buffer.alloc(32, 3)
  const candidateRecordId = Buffer.alloc(32, 7)
  let canceled = 0
  const bridge = {
    async beginUserIntent() {
      return { intentId: 'intent-substitution', signerPublicKey }
    },
    async signPreparedRecord() {
      return {
        intentId: 'intent-substitution',
        publisherId: request.publisherId,
        recordType: request.recordType,
        unsignedBytes: Buffer.from([9]),
        candidateRecordId,
        signer: signerPublicKey,
        signerPublicKey,
        signature: Buffer.alloc(64, 11)
      }
    },
    completeIntent() {
      throw new Error('substituted echo must not complete the intent')
    },
    cancelIntent() {
      canceled++
    }
  }
  const publisher = createPublisherRootOperationRpc(() => ({
    publisher: {
      async preparePublisherRootOperation(value) {
        return {
          ...value,
          success: true,
          unsignedBytes: Buffer.from([9]),
          candidateRecordId,
          bodyLength: value.body.byteLength,
          issuedAt: 1_700_000_000_000,
          displaySummaryJson: value.displaySummaryJson
        }
      },
      async submitPublisherRootOperation(value) {
        return {
          intentId: value.intentId,
          success: true,
          valid: true,
          complete: true,
          recordId: Buffer.alloc(32, 99),
          signer: Buffer.alloc(32, 100),
          signerPublicKey: Buffer.alloc(32, 100),
          signature: Buffer.alloc(64, 101)
        }
      }
    }
  }), bridge)

  await assert.rejects(
    publisher.authorizePublisherRootOperation(request),
    (error) => error?.code === 'PUBLISHER_SIGNER_SUBSTITUTION' &&
      !error.message.includes('create publisher') &&
      !error.message.includes(candidateRecordId.toString('hex')),
  )
  assert.equal(canceled, 1)
})

test('platform runner session carries the shell signer only on explicitly injected native startup', async () => {
  const { createPlatformRpcBridge, PROTOCOL_VERSION } = await loadCatalogModules()
  const signer = { beginUserIntent() {}, signPreparedRecord() {} }
  let receivedOptions
  const lifecycleListeners = new Set()
  const platformErrors = []
  const client = {
    rpc: {},
    events: { on: () => () => {} },
    channel: {},
    ready: async () => ({
      blobServerPort: null,
      blobServerReady: false,
      blobServerError: null,
      protocolVersion: PROTOCOL_VERSION
    })
  }
  const runner = {
    async start(options) {
      receivedOptions = options
      return {
        stream: {},
        client,
        publisherSigner: options.publisherSigner,
        waitUntilReady: client.ready,
        terminate: async () => {},
        onLifecycle(listener) {
          lifecycleListeners.add(listener)
          return () => lifecycleListeners.delete(listener)
        }
      }
    }
  }
  const bridge = createPlatformRpcBridge({
    platform: 'mobile',
    runner,
    entrypoint: 'mobile-entry',
    getStoragePath: () => '/tmp/mobile',
    getPublisherSigner: () => signer
  })
  bridge.events.onError((error) => platformErrors.push(error))

  await bridge.init()

  assert.equal(receivedOptions.publisherSigner, signer)
  assert.equal(receivedOptions.protocolVersion, PROTOCOL_VERSION)
  assert.equal(bridge.getPublisherSigner(), signer)
  for (const listener of lifecycleListeners) {
    listener({
      type: 'host.error',
      code: 'STORED_PROTOCOL_VERSION_UNSUPPORTED',
      message: 'STORED_PROTOCOL_VERSION_UNSUPPORTED',
      retryable: false,
      storedVersion: 5,
      expectedVersion: PROTOCOL_VERSION,
    })
  }
  assert.deepEqual(platformErrors, [{
    code: 'STORED_PROTOCOL_VERSION_UNSUPPORTED',
    message: 'STORED_PROTOCOL_VERSION_UNSUPPORTED',
    retryable: false,
    storedVersion: 5,
    expectedVersion: PROTOCOL_VERSION,
  }])
})

test('native facade accepts an injected shell signer while web stays renderer-forbidden', () => {
  const nativeSource = fs.readFileSync(path.join(platformRoot, 'src/rpc.native.ts'), 'utf8')
  const webSource = fs.readFileSync(path.join(platformRoot, 'src/rpc.web.ts'), 'utf8')
  const nativeRunnerSource = fs.readFileSync(path.join(platformRoot, 'src/runner.native.ts'), 'utf8')

  assert.match(nativeSource, /publisherSigner\?: PublisherSignerBridgeLike/)
  assert.match(nativeSource, /createPublisherRootOperationRpc\(/)
  assert.match(nativeSource, /getPublisherSigner:/)
  assert.match(webSource, /runtime: 'renderer'/)
  assert.match(webSource, /createPublisherRootOperationRpc\([\s\S]*?null,[\s\S]*?runtime: 'renderer'/)
  assert.match(webSource, /registerPublisherBackendRelay/)
  assert.match(webSource, /ensureLocalPublisherCatalog/)
  assert.doesNotMatch(webSource, /publisherSigner\?: PublisherSignerBridgeLike/)
  assert.match(nativeRunnerSource, /publisherSigner: options\.publisherSigner/)
})

test('operability facade exposes complete local network policy RPC', async () => {
  const { createOperabilityRpc } = await loadCatalogModules()
  const calls = []
  const policy = createOperabilityRpc(() => ({
    async getNetworkPolicy(request) {
      calls.push(['get', request])
      return { uploadPermission: 'manual' }
    },
    async setNetworkPolicy(request) {
      calls.push(['set', request])
      return { success: true, ...request }
    },
  }))

  assert.equal((await policy.getNetworkPolicy()).uploadPermission, 'manual')
  assert.equal((await policy.setNetworkPolicy({ backgroundMode: 'local-only' })).success, true)
  assert.deepEqual(calls, [
    ['get', {}],
    ['set', { backgroundMode: 'local-only' }],
  ])
})
