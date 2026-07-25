import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import {
  decodePublisherNamespaceDescriptor,
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
                static defineRPC() {
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

test('desktop app initialization injects only the Electrobun shell signer proxy', () => {
  const layout = readAppFile('app/_layout.tsx')
  const pearStart = layout.indexOf('const initPearBackend')
  const pearEnd = layout.indexOf('const isCastSessionActive', pearStart)
  const pearInitialization = layout.slice(pearStart, pearEnd)

  assert.ok(pearStart >= 0 && pearEnd > pearStart)
  assert.match(pearInitialization, /const desktopShell = window as Window/)
  assert.match(
    pearInitialization,
    /initPlatformRPC\(\{[\s\S]*publisherSigner:\s*desktopShell\.bridge\?\.publisherSigner,[\s\S]*\}\)/,
  )
  assert.doesNotMatch(pearInitialization, /createPublisherKeyVault|createPublisherSignerBridge|expo-secure-store/)
})

test('desktop exposes only a bounded public signing proxy while vault custody stays in Bun main', () => {
  const schema = readAppFile('src/shared/rpc-types.ts')
  const bunMain = readAppFile('src/bun/index.ts')
  const renderer = readAppFile('src/view/index.ts')
  const webRpc = readRepositoryFile('packages/platform/src/rpc.web.ts')

  for (const requestName of [
    'publisherCreateRoot',
    'publisherBeginUserIntent',
    'publisherSignPreparedRecord',
    'publisherCompleteIntent',
    'publisherCancelIntent',
  ]) {
    assert.match(schema, new RegExp(`${requestName}:`), `${requestName} must be typed in Electrobun RPC`)
    assert.match(bunMain, new RegExp(`${requestName}:\\s*async`), `${requestName} must be handled by Bun main`)
  }

  assert.match(bunMain, /createDesktopPublisherRpcHandlers/)
  assert.match(renderer, /publisherSigner:\s*createPublisherSignerProxy\(/)
  assert.match(renderer, /new Uint8Array\(/)
  assert.match(webRpc, /publisherSigner\?: PublisherSignerBridgeLike/)
  assert.match(webRpc, /publisherSigner === window\.bridge\?\.publisherSigner/)

  const rendererGlobalAssignment = renderer.slice(
    renderer.indexOf('const bridge ='),
    renderer.indexOf("Object.defineProperty(window, 'bridge'"),
  )
  assert.doesNotMatch(rendererGlobalAssignment, /publisherKeyVault|publisherVault|rootSecret|getSecret|secretKey|privateKey|seed/i)
  assert.doesNotMatch(bunMain, /globalThis.*(?:publisher|vault|signer)/i)
  assert.doesNotMatch(schema, /secretKey|privateKey|rootSecret|\bseed\b/i)
})

test('desktop publisher handlers normalize bounded bytes and return public material only', async () => {
  const { createDesktopPublisherRpcHandlers } = await loadPublisherShellService()
  const publisherId = 'a'.repeat(64)
  const intentId = 'b'.repeat(32)
  const signerPublicKey = new Uint8Array(32).fill(7)
  const calls = []
  const handlers = createDesktopPublisherRpcHandlers({
    vault: {
      async createRoot(input) {
        calls.push(['create', input])
        return { publisherId, publicKey: '09'.repeat(32) }
      },
    },
    signer: {
      async beginUserIntent(request) {
        assert.ok(request.body instanceof Uint8Array)
        calls.push(['begin', request])
        return { intentId, signerPublicKey }
      },
      async signPreparedRecord(receivedIntentId, prepared) {
        assert.ok(prepared.unsignedBytes instanceof Uint8Array)
        assert.ok(prepared.candidateRecordId instanceof Uint8Array)
        assert.ok(prepared.signerPublicKey instanceof Uint8Array)
        calls.push(['sign', receivedIntentId, prepared])
        return {
          intentId,
          publisherId,
          recordType: 'publisher.namespace',
          unsignedBytes: prepared.unsignedBytes,
          candidateRecordId: prepared.candidateRecordId,
          displaySummaryJson: prepared.displaySummaryJson,
          signer: signerPublicKey,
          signerPublicKey,
          signature: new Uint8Array(64).fill(8),
        }
      },
      completeIntent(receivedIntentId) {
        calls.push(['complete', receivedIntentId])
      },
      cancelIntent(receivedIntentId) {
        calls.push(['cancel', receivedIntentId])
      },
    },
  })

  const created = await handlers.publisherCreateRoot({})
  assert.deepEqual(created, { publisherId, publicKey: new Array(32).fill(9) })
  assertNoSecretFields(created)

  const intentExpiresAt = Date.now() + 60_000
  const intent = await handlers.publisherBeginUserIntent({
    publisherId,
    recordType: 'publisher.namespace',
    body: [1, 2, 3],
    displaySummaryJson: '{\"action\":\"create\"}',
    intentExpiresAt,
    userInitiated: true,
  })
  assert.deepEqual(intent, { intentId, signerPublicKey: Array.from(signerPublicKey) })

  const signed = await handlers.publisherSignPreparedRecord({
    intentId,
    prepared: {
      intentId,
      success: true,
      publisherId,
      recordType: 'publisher.namespace',
      unsignedBytes: [4, 5, 6],
      candidateRecordId: new Array(32).fill(10),
      signerPublicKey: Array.from(signerPublicKey),
      intentExpiresAt,
      bodyLength: 3,
      issuedAt: 123,
      expiresAt: 0,
      displaySummaryJson: '{\"action\":\"create\"}',
      error: null,
    },
  })
  assert.deepEqual(signed.signature, new Array(64).fill(8))
  assert.deepEqual(signed.unsignedBytes, [4, 5, 6])
  assertNoSecretFields(signed)

  assert.deepEqual(await handlers.publisherCompleteIntent({ intentId }), { ok: true })
  assert.deepEqual(await handlers.publisherCancelIntent({ intentId }), { ok: true })
  assert.deepEqual(calls.map(([name]) => name), ['create', 'begin', 'sign', 'complete', 'cancel'])
})

test('desktop publisher handlers reject hidden inputs, redact failures, and preserve single-use cleanup', async () => {
  const { createDesktopPublisherRpcHandlers } = await loadPublisherShellService()
  const publisherId = 'a'.repeat(64)
  const intentId = 'b'.repeat(32)
  const active = new Set()
  const handlers = createDesktopPublisherRpcHandlers({
    vault: {
      async createRoot() {
        throw new Error('vault-root-secret-value')
      },
    },
    signer: {
      async beginUserIntent() {
        active.add(intentId)
        return { intentId, signerPublicKey: new Uint8Array(32) }
      },
      async signPreparedRecord(receivedIntentId) {
        if (!active.delete(receivedIntentId)) throw new Error('unknown-intent-secret-value')
        throw new Error('signing-secret-value')
      },
      completeIntent(receivedIntentId) {
        active.delete(receivedIntentId)
      },
      cancelIntent(receivedIntentId) {
        active.delete(receivedIntentId)
      },
    },
  })

  await assert.rejects(
    handlers.publisherCreateRoot({ seed: [1, 2, 3] }),
    (error) => !error.message.includes('seed') && !error.message.includes('vault-root-secret-value'),
  )
  await assert.rejects(
    handlers.publisherBeginUserIntent({
      publisherId: publisherId.toUpperCase(),
      recordType: 'publisher.namespace',
      body: [1],
      displaySummaryJson: null,
      intentExpiresAt: Date.now() + 60_000,
      userInitiated: true,
    }),
    (error) => !error.message.includes(publisherId.toUpperCase()),
  )
  await assert.rejects(
    handlers.publisherBeginUserIntent({
      publisherId,
      recordType: 'publisher.namespace',
      body: [256],
      displaySummaryJson: null,
      intentExpiresAt: Date.now() + 60_000,
      userInitiated: true,
    }),
    /PUBLISHER_SHELL_INVALID_REQUEST/,
  )

  const begun = await handlers.publisherBeginUserIntent({
    publisherId,
    recordType: 'publisher.namespace',
    body: [1],
    displaySummaryJson: null,
    intentExpiresAt: Date.now() + 60_000,
    userInitiated: true,
  })
  const prepared = {
    intentId: begun.intentId,
    success: true,
    publisherId,
    recordType: 'publisher.namespace',
    unsignedBytes: [1],
    candidateRecordId: new Array(32).fill(2),
    signerPublicKey: begun.signerPublicKey,
    intentExpiresAt: Date.now() + 60_000,
    bodyLength: 1,
    issuedAt: 1,
    expiresAt: 0,
    displaySummaryJson: null,
    error: null,
  }
  await assert.rejects(
    handlers.publisherSignPreparedRecord({ intentId: begun.intentId, prepared }),
    (error) => error.message === 'PUBLISHER_SHELL_SIGN_FAILED',
  )
  assert.equal(active.size, 0)
  await assert.rejects(
    handlers.publisherSignPreparedRecord({ intentId: begun.intentId, prepared }),
    (error) => error.message === 'PUBLISHER_SHELL_SIGN_FAILED' && !error.message.includes('unknown-intent-secret-value'),
  )
})

test('desktop renderer proxy round-trips bytes without exposing privileged state', async () => {
  const previousWindow = globalThis.window
  const previousCall = globalThis.__publisherRpcCall
  const calls = []
  globalThis.window = {
    location: { port: '1234', reload() {} },
  }
  globalThis.__publisherRpcCall = async (method, params) => {
    calls.push([method, params])
    if (method === 'publisherCreateRoot') {
      return { publisherId: 'a'.repeat(64), publicKey: new Array(32).fill(3) }
    }
    if (method === 'publisherBeginUserIntent') {
      return { intentId: 'b'.repeat(32), signerPublicKey: new Array(32).fill(4) }
    }
    if (method === 'publisherSignPreparedRecord') {
      return {
        intentId: params.intentId,
        publisherId: params.prepared.publisherId,
        recordType: params.prepared.recordType,
        unsignedBytes: params.prepared.unsignedBytes,
        candidateRecordId: params.prepared.candidateRecordId,
        displaySummaryJson: params.prepared.displaySummaryJson,
        signer: new Array(32).fill(4),
        signerPublicKey: new Array(32).fill(4),
        signature: new Array(64).fill(5),
      }
    }
    return { ok: true }
  }

  try {
    await loadDesktopView()
    const shellBridge = globalThis.window.bridge
    assert.ok(shellBridge)
    assert.equal(Object.isFrozen(shellBridge.publisherSigner), true)
    const bridgeDescriptor = Object.getOwnPropertyDescriptor(globalThis.window, 'bridge')
    assert.equal(bridgeDescriptor?.writable, false)
    assert.equal(bridgeDescriptor?.configurable, false)
    assert.equal('publisherVault' in shellBridge, false)
    assert.equal('publisherSigner' in globalThis, false)

    const created = await shellBridge.publisherCreateRoot()
    assert.deepEqual(created, {
      publisherId: 'a'.repeat(64),
      publicKey: new Uint8Array(32).fill(3),
    })
    assertNoSecretFields(created)

    const intent = await shellBridge.publisherSigner.beginUserIntent({
      publisherId: 'a'.repeat(64),
      recordType: 'publisher.namespace',
      body: new Uint8Array([1, 2, 3]),
      displaySummaryJson: null,
      intentExpiresAt: 500,
      userInitiated: true,
    })
    assert.ok(intent.signerPublicKey instanceof Uint8Array)
    assert.deepEqual(calls.at(-1)[1].body, [1, 2, 3])

    const signed = await shellBridge.publisherSigner.signPreparedRecord(intent.intentId, {
      intentId: intent.intentId,
      success: true,
      publisherId: 'a'.repeat(64),
      recordType: 'publisher.namespace',
      unsignedBytes: new Uint8Array([6, 7]),
      candidateRecordId: new Uint8Array(32).fill(8),
      signerPublicKey: intent.signerPublicKey,
      intentExpiresAt: 500,
      bodyLength: 3,
      issuedAt: 100,
      expiresAt: 0,
      displaySummaryJson: null,
      error: null,
    })
    assert.ok(signed.unsignedBytes instanceof Uint8Array)
    assert.ok(signed.candidateRecordId instanceof Uint8Array)
    assert.ok(signed.signerPublicKey instanceof Uint8Array)
    assert.ok(signed.signature instanceof Uint8Array)
    assert.deepEqual(calls.at(-1)[1].prepared.unsignedBytes, [6, 7])

    shellBridge.publisherSigner.completeIntent(intent.intentId)
    shellBridge.publisherSigner.cancelIntent(intent.intentId)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(calls.slice(-2).map(([method]) => method), [
      'publisherCompleteIntent',
      'publisherCancelIntent',
    ])
    assert.doesNotMatch(JSON.stringify(calls), /secretKey|privateKey|rootSecret|seed/i)
  } finally {
    globalThis.window = previousWindow
    globalThis.__publisherRpcCall = previousCall
  }
})

test('publisher shell service creates and authorizes a canonical public namespace', async () => {
  const { createPublisherShellService } = await loadPublisherShellService()
  assert.equal(typeof createPublisherShellService, 'function')
  const genesisRootKey = new Uint8Array(32).fill(11)
  const publisherId = Buffer.from(derivePublisherId(genesisRootKey)).toString('hex')
  const catalogBootstrapKey = new Uint8Array(32).fill(12)
  const calls = []
  const publisherShell = createPublisherShellService({
    shell: {
      async createRoot() {
        calls.push(['root'])
        return { publisherId, publicKey: genesisRootKey }
      },
    },
    publisherRpc: {
      async provisionPublisherCatalog(request) {
        calls.push(['provision', request])
        return { success: true, publisherId, catalogBootstrapKey }
      },
      async authorizePublisherRootOperation(request) {
        calls.push(['authorize', request])
        return { success: true, valid: true, complete: true, recordId: new Uint8Array(32) }
      },
    },
    now: () => 1_000,
    intentTtlMs: 60_000,
  })

  const result = await publisherShell.createPublisherNamespace({
    displaySummaryJson: '{\"action\":\"create publisher\"}',
  })
  assert.deepEqual(calls.map(([name]) => name), ['root', 'provision', 'authorize'])
  assert.deepEqual(calls[1][1], { publisherId, genesisRootKey })
  const authorization = calls[2][1]
  assert.equal(authorization.publisherId, publisherId)
  assert.equal(authorization.recordType, 'publisher.namespace')
  assert.equal(authorization.intentExpiresAt, 61_000)
  assert.equal(authorization.userInitiated, true)
  const descriptor = decodePublisherNamespaceDescriptor(authorization.body)
  assert.deepEqual(descriptor.genesisRootKey, undefined)
  assert.deepEqual(Array.from(descriptor.publisherId), Array.from(derivePublisherId(genesisRootKey)))
  assert.deepEqual(Array.from(descriptor.publisherRootKey), Array.from(genesisRootKey))
  assert.deepEqual(Array.from(descriptor.catalogBootstrapKey), Array.from(catalogBootstrapKey))
  assert.deepEqual(result.root, { publisherId, publicKey: genesisRootKey })
  assert.equal(result.provision.success, true)
  assert.equal(result.authorization.success, true)
  assertNoSecretFields(result)
})

test('publisher shell service stops after a redacted catalog provisioning failure', async () => {
  const { createPublisherShellService } = await loadPublisherShellService()
  const genesisRootKey = new Uint8Array(32).fill(13)
  const publisherId = Buffer.from(derivePublisherId(genesisRootKey)).toString('hex')
  let authorizeCalls = 0
  const publisherShell = createPublisherShellService({
    shell: {
      async createRoot() {
        return { publisherId, publicKey: genesisRootKey }
      },
    },
    publisherRpc: {
      async provisionPublisherCatalog() {
        return {
          success: false,
          publisherId,
          catalogBootstrapKey: new Uint8Array(0),
          error: 'catalog-provision-secret-value',
        }
      },
      async authorizePublisherRootOperation() {
        authorizeCalls++
        return { success: true }
      },
    },
  })

  await assert.rejects(
    publisherShell.createPublisherNamespace(),
    (error) => error.message === 'PUBLISHER_SHELL_PROVISION_FAILED' &&
      !error.message.includes('catalog-provision-secret-value'),
  )
  assert.equal(authorizeCalls, 0)
})
