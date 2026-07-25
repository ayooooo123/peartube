import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import {
  decodePublisherNamespaceDescriptor,
  decodePublisherOperationBody,
  derivePublisherId,
} from '../../backend/src/publisher/index.js'



const appRoot = path.resolve(import.meta.dirname, '..')
const repositoryRoot = path.resolve(appRoot, '../..')

function readAppFile(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

function readRepositoryFile(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8')
}
async function loadPublisherShellService() {
  const entry = path.join(appRoot, 'lib/publisher-shell-service.ts')
  assert.equal(fs.existsSync(entry), true, 'publisher shell service must exist')
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    external: ['@peartube/backend/publisher'],
    write: false,
  })
  const temporaryDirectory = fs.mkdtempSync(path.join(appRoot, '.tmp-publisher-shell-service-'))
  const output = path.join(temporaryDirectory, 'publisher-shell-service.cjs')
  fs.writeFileSync(output, result.outputFiles[0].text)
  try {
    return await import(pathToFileURL(output).href)
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}
async function loadDesktopView() {
  const entry = path.join(appRoot, 'src/view/index.ts')
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    write: false,
    plugins: [{
      name: 'electrobun-view-stub',
      setup(builder) {
        builder.onResolve({ filter: /^electrobun\/view$/ }, () => ({
          path: 'electrobun-view-stub',
          namespace: 'publisher-shell-test',
        }))
        builder.onLoad(
          { filter: /.*/, namespace: 'publisher-shell-test' },
          () => ({
            loader: 'js',
            contents: `
              export class Electroview {
                static defineRPC(config) {
                  globalThis.__publisherRpcHandlers = config.handlers.requests
                  const request = new Proxy({}, {
                    get(_target, method) {
                      return (params) => globalThis.__publisherRpcCall(String(method), params)
                    }
                  })
                  return { proxy: { request }, setTransport() {} }
                }
                constructor({ rpc }) { this.rpc = rpc }
              }
            `,
          }),
        )
      },
    }],
  })
  const encoded = Buffer.from(result.outputFiles[0].text).toString('base64')
  return import(`data:text/javascript;base64,${encoded}#${Date.now()}`)
}


function assertNoSecretFields(value) {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(key, /secret|private|seed/i)
    assertNoSecretFields(child)
  }
}


test('native shell signer custody is isolated behind platform-specific modules', () => {
  const layout = readAppFile('app/_layout.tsx')
  const nativeBoundary = readAppFile('lib/publisher-shell-signer.native.ts')
  const webBoundary = readAppFile('lib/publisher-shell-signer.web.ts')
  const mobileVault = readAppFile('lib/publisher-key-vault.ts')

  assert.match(layout, /from ['"]@\/lib\/publisher-shell-signer['"]/)
  assert.match(layout, /publisherSigner:\s*await getNativePublisherSigner\(\)/)
  assert.doesNotMatch(layout, /publisher-key-vault|publisher-signer-bridge|expo-secure-store/)
  assert.match(nativeBoundary, /from ['"]\.\/publisher-key-vault['"]/)
  assert.match(nativeBoundary, /from ['"]\.\/publisher-signer-bridge['"]/)
  assert.doesNotMatch(webBoundary, /publisher-key-vault|publisher-signer-bridge|hypercore-crypto|expo-secure-store/)
  assert.match(webBoundary, /Publisher key vault is available only in the native shell/)
  assert.match(mobileVault, /async function defaultSecureStoreLoader\(\)[\s\S]*import\(['"]expo-secure-store['"]\)/)
})

test('desktop app gates readiness on the privileged local publisher lifecycle', () => {
  const layout = readAppFile('app/_layout.tsx')
  const pearStart = layout.indexOf('const initPearBackend')
  const pearEnd = layout.indexOf('const isCastSessionActive', pearStart)
  const pearInitialization = layout.slice(pearStart, pearEnd)

  assert.ok(pearStart >= 0 && pearEnd > pearStart)
  assert.match(pearInitialization, /await platformRPC\.initPlatformRPC\(\)/)
  assert.match(pearInitialization, /await platformRPC\.ensureLocalPublisherCatalog\(\)/)
  assert.ok(
    pearInitialization.indexOf('ensureLocalPublisherCatalog') <
      pearInitialization.lastIndexOf('setReady(true)'),
    'publisher catalog readiness must precede upload-capable UI readiness',
  )
  assert.doesNotMatch(pearInitialization, /publisherSigner|userInitiated/)
})

test('desktop exposes one bounded lifecycle action while vault custody stays in Bun main', () => {
  const schema = readAppFile('src/shared/rpc-types.ts')
  const bunMain = readAppFile('src/bun/index.ts')
  const renderer = readAppFile('src/view/index.ts')
  const webRpc = readRepositoryFile('packages/platform/src/rpc.web.ts')

  assert.match(schema, /publisherEnsureLocalCatalog:/)
  assert.doesNotMatch(
    schema,
    /publisherCreateRoot:|publisherBeginUserIntent:|publisherSignPreparedRecord:|publisherCompleteIntent:|publisherCancelIntent:/,
  )
  assert.match(bunMain, /createPublisherShellService/)
  assert.match(bunMain, /publisherEnsureLocalCatalog:\s*async/)
  assert.match(renderer, /registerPublisherBackendRelay/)
  assert.match(renderer, /publisherEnsureLocalCatalog\(\{ action: 'ensure-local-publisher' \}\)/)
  assert.doesNotMatch(renderer, /createPublisherSignerProxy|publisherSigner:/)
  assert.match(webRpc, /runtime: 'renderer'/)
  assert.doesNotMatch(webRpc, /publisherSigner\?: PublisherSignerBridgeLike/)

  const rendererGlobalAssignment = renderer.slice(
    renderer.indexOf('const bridge ='),
    renderer.indexOf("Object.defineProperty(window, 'bridge'"),
  )
  assert.doesNotMatch(rendererGlobalAssignment, /publisherKeyVault|publisherVault|rootSecret|getSecret|secretKey|privateKey|seed/i)
  assert.doesNotMatch(bunMain, /globalThis.*(?:publisher|vault|signer)/i)
  assert.doesNotMatch(schema, /secretKey|privateKey|rootSecret|\bseed\b/i)
})

test('desktop renderer exposes only the narrow lifecycle request and public backend relay', async () => {
  const previousWindow = globalThis.window
  const previousRpcCall = globalThis.__publisherRpcCall
  const previousHandlers = globalThis.__publisherRpcHandlers
  const calls = []
  globalThis.window = { location: { reload() {}, port: '8080' } }
  globalThis.__publisherRpcCall = async (method, params) => {
    calls.push([method, params])
    return {
      status: 'ready',
      publisherId: 'a'.repeat(64),
      catalogBootstrapKey: Array(32).fill(1),
      writable: true,
      admitted: true,
    }
  }
  try {
    await loadDesktopView()
    const bridge = globalThis.window.bridge
    assert.equal(bridge.publisherSigner, undefined)
    assert.equal(bridge.publisherCreateRoot, undefined)
    const ready = await bridge.ensureLocalPublisher()
    assert.equal(ready.status, 'ready')
    assert.deepEqual(calls, [[
      'publisherEnsureLocalCatalog',
      { action: 'ensure-local-publisher' },
    ]])

    const relayCalls = []
    bridge.registerPublisherBackendRelay({
      async provisionPublisherCatalog(request) {
        relayCalls.push(request)
        return {
          success: true,
          publisherId: request.publisherId,
          catalogBootstrapKey: new Uint8Array(32),
          localWriterKey: new Uint8Array(32),
          localSignerKey: new Uint8Array(32),
          writable: true,
          namespaceInitialized: false,
          admitted: false,
        }
      },
      async preparePublisherRootOperation() { throw new Error('not exercised') },
      async submitPublisherRootOperation() { throw new Error('not exercised') },
    })
    const response = await globalThis.__publisherRpcHandlers.publisherProvisionCatalog({
      publisherId: 'a'.repeat(64),
      genesisRootKey: Array(32).fill(2),
    })
    assert.equal(relayCalls[0].genesisRootKey instanceof Uint8Array, true)
    assert.deepEqual(response.catalogBootstrapKey, Array(32).fill(0))
    assert.throws(
      () => bridge.registerPublisherBackendRelay({}),
      /already registered/,
    )
  } finally {
    globalThis.window = previousWindow
    globalThis.__publisherRpcCall = previousRpcCall
    globalThis.__publisherRpcHandlers = previousHandlers
  }
})

function publisherLifecycleFixture({ alreadyInitialized = false } = {}) {
  const genesisRootKey = new Uint8Array(32).fill(31)
  const publisherId = Buffer.from(derivePublisherId(genesisRootKey)).toString('hex')
  const catalogBootstrapKey = new Uint8Array(32).fill(32)
  const localWriterKey = new Uint8Array(32).fill(33)
  const localSignerKey = new Uint8Array(32).fill(34)
  const confirmations = []
  const intents = []
  const submitted = []
  let namespaceInitialized = alreadyInitialized
  let admitted = alreadyInitialized
  let rootCalls = 0

  return {
    publisherId,
    catalogBootstrapKey,
    localWriterKey,
    localSignerKey,
    confirmations,
    intents,
    submitted,
    get rootCalls() { return rootCalls },
    dependencies: {
      shell: {
        async getOrCreateRoot() {
          rootCalls++
          return { publisherId, publicKey: genesisRootKey }
        },
      },
      signer: {
        async beginUserIntent(request) {
          intents.push({ ...request, body: Uint8Array.from(request.body) })
          return {
            intentId: String(intents.length).padStart(32, '0'),
            signerPublicKey: genesisRootKey,
          }
        },
        async signPreparedRecord(intentId, prepared) {
          return {
            intentId,
            publisherId,
            recordType: prepared.recordType,
            unsignedBytes: prepared.unsignedBytes,
            candidateRecordId: prepared.candidateRecordId,
            displaySummaryJson: prepared.displaySummaryJson,
            signer: genesisRootKey,
            signerPublicKey: genesisRootKey,
            signature: new Uint8Array(64).fill(35),
          }
        },
        completeIntent() {},
        cancelIntent() {},
      },
      confirmRootOperation: async (summary) => {
        confirmations.push(summary)
        return true
      },
      publisherRpc: {
        async provisionPublisherCatalog() {
          return {
            success: true,
            publisherId,
            catalogBootstrapKey,
            localWriterKey,
            localSignerKey,
            writable: true,
            namespaceInitialized,
            admitted,
          }
        },
        async preparePublisherRootOperation(request) {
          return {
            intentId: request.intentId,
            success: true,
            publisherId: request.publisherId,
            recordType: request.recordType,
            unsignedBytes: new Uint8Array([intents.length, 7, 8]),
            candidateRecordId: new Uint8Array(32).fill(intents.length),
            signerPublicKey: request.signerPublicKey,
            intentExpiresAt: request.intentExpiresAt,
            bodyLength: request.body.byteLength,
            issuedAt: request.issuedAt,
            expiresAt: 0,
            displaySummaryJson: request.displaySummaryJson,
            error: null,
          }
        },
        async submitPublisherRootOperation(request) {
          submitted.push(request)
          if (request.recordType === 'publisher.namespace') namespaceInitialized = true
          if (request.recordType === 'publisher.writer-admission') admitted = true
          return {
            intentId: request.intentId,
            success: true,
            valid: true,
            complete: true,
            publisherId,
            recordType: request.recordType,
            recordId: request.candidateRecordId,
            transitionId: new Uint8Array(0),
            signer: request.signer,
            reason: null,
          }
        },
      },
      now: () => 1_700_000_000_000,
      randomBytes: (length) => new Uint8Array(length).fill(36),
    },
  }
}

test('fresh publisher lifecycle provisions one writable catalog and admits the local device before returning ready', async () => {
  const { createPublisherShellService } = await loadPublisherShellService()
  const fixture = publisherLifecycleFixture()
  const service = createPublisherShellService(fixture.dependencies)

  const result = await service.ensureLocalPublisher()

  assert.equal(result.status, 'ready')
  assert.equal(result.publisherId, fixture.publisherId)
  assert.equal(result.writable, true)
  assert.equal(result.admitted, true)
  assert.equal(fixture.rootCalls, 1)
  assert.deepEqual(fixture.intents.map((intent) => intent.recordType), [
    'publisher.namespace',
    'publisher.writer-admission',
  ])
  assert.equal(fixture.intents.some((intent) => 'userInitiated' in intent), false)
  assert.deepEqual(
    Array.from(decodePublisherNamespaceDescriptor(fixture.intents[0].body).catalogBootstrapKey),
    Array.from(fixture.catalogBootstrapKey),
  )
  const admission = decodePublisherOperationBody(
    'publisher.writer-admission',
    fixture.intents[1].body,
  )
  assert.deepEqual(Array.from(admission.writerKey), Array.from(fixture.localWriterKey))
  assert.deepEqual(Array.from(admission.signerKey), Array.from(fixture.localSignerKey))
  assert.deepEqual(admission.capabilities, ['claim', 'publish'])
  assert.deepEqual(fixture.confirmations.map((summary) => summary.action), [
    'create-publisher-namespace',
    'admit-local-publisher-device',
  ])
  assertNoSecretFields(result)
})

test('upgrade publisher lifecycle reuses the imported root and already admitted catalog without signing again', async () => {
  const { createPublisherShellService } = await loadPublisherShellService()
  const fixture = publisherLifecycleFixture({ alreadyInitialized: true })
  const service = createPublisherShellService(fixture.dependencies)

  const result = await service.ensureLocalPublisher()

  assert.equal(result.status, 'ready')
  assert.equal(result.writable, true)
  assert.equal(result.admitted, true)
  assert.equal(fixture.rootCalls, 1)
  assert.deepEqual(fixture.intents, [])
  assert.deepEqual(fixture.submitted, [])
  assert.deepEqual(fixture.confirmations, [])
  assertNoSecretFields(result)
})

test('desktop lifecycle handler rejects renderer-selected root semantics and userInitiated authorization', async () => {
  const { createDesktopPublisherLifecycleHandlers } = await loadPublisherShellService()
  let calls = 0
  const handlers = createDesktopPublisherLifecycleHandlers({
    publisherShell: {
      async ensureLocalPublisher() {
        calls++
        return {
          status: 'ready',
          publisherId: 'a'.repeat(64),
          catalogBootstrapKey: new Uint8Array(32),
          writable: true,
          admitted: true,
        }
      },
    },
  })

  for (const request of [
    { action: 'publisher.writer-revocation', userInitiated: true },
    { action: 'publisher.root-transition', body: [1, 2, 3], userInitiated: true },
    { action: 'ensure-local-publisher', body: [1, 2, 3] },
  ]) {
    await assert.rejects(
      handlers.publisherEnsureLocalCatalog(request),
      /PUBLISHER_SHELL_INVALID_REQUEST/,
    )
  }
  assert.equal(calls, 0)

  const result = await handlers.publisherEnsureLocalCatalog({ action: 'ensure-local-publisher' })
  assert.equal(result.status, 'ready')
  assert.equal(calls, 1)
  assert.equal('publisherBeginUserIntent' in handlers, false)
  assert.equal('publisherSignPreparedRecord' in handlers, false)
})
