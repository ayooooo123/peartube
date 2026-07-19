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
  const sharedSourcePath = path.join(platformRoot, 'src/rpc.shared.ts')
  const sharedSource = fs.readFileSync(sharedSourcePath, 'utf8').replace(
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
    .replace("from './contracts.js'", `from '${pathToFileURL(path.join(hostRoot, 'contracts.js')).href}'`)
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

test('native and web RPC facades use the shared catalog forwarding helper', () => {
  for (const fileName of ['rpc.native.ts', 'rpc.web.ts']) {
    const source = fs.readFileSync(path.join(platformRoot, 'src', fileName), 'utf8')
    assert.match(source, /createChannelCatalogRpc/)
    assert.match(source, /\.\.\.createChannelCatalogRpc\(ensureProtocolClient\)/)
  }
})
