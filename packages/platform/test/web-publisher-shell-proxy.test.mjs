import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const platformRoot = path.resolve(import.meta.dirname, '..')

async function loadTypeScriptModule(relativePath) {
  const sourcePath = path.join(platformRoot, relativePath)
  const hostEventsUrl = pathToFileURL(path.join(platformRoot, '../host/src/event-map.js')).href
  const source = fs.readFileSync(sourcePath, 'utf8')
    .replace(/import type \{[\s\S]*?\} from '@peartube\/host'\n/g, '')
    .replace(
      "import { PROTOCOL_VERSION } from '@peartube/host/contracts'",
      'const PROTOCOL_VERSION = 1',
    )
    .replace(
      "import { PROTOCOL_EVENTS } from '@peartube/host/events'",
      `import { PROTOCOL_EVENTS } from '${hostEventsUrl}'`,
    )
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}#${Date.now()}-${relativePath}`)
}

test('web runner carries only the explicit signer session field and keeps transport options unchanged', async () => {
  const { createWebRunner } = await loadTypeScriptModule('src/runner.web.ts')
  const signer = Object.freeze({
    beginUserIntent() {},
    signPreparedRecord() {},
    completeIntent() {},
    cancelIntent() {},
  })
  let transportOptions
  const listeners = new Map()
  const runner = createWebRunner({
    async connectTransport(options) {
      transportOptions = options
      return {
        stream: { destroy() {} },
        client: {
          ready: async () => ({ blobServerPort: 9000, protocolVersion: 1 }),
          events: {
            on(name, listener) {
              listeners.set(name, listener)
              return () => listeners.delete(name)
            },
          },
        },
      }
    },
  })

  const session = await runner.start({
    platform: 'desktop',
    storagePath: 'desktop-storage',
    entrypoint: 'desktop-entry',
    args: ['one'],
    publisherSigner: signer,
  })

  assert.equal(session.publisherSigner, signer)
  assert.deepEqual(transportOptions, {
    platform: 'desktop',
    storagePath: 'desktop-storage',
    entrypoint: 'desktop-entry',
    args: ['one'],
  })
})

test('trusted web shell proxy authorizes while absent or direct renderer signers fail closed', async () => {
  const [{ resolveWebPublisherSigner }, { createPublisherRootOperationRpc }] = await Promise.all([
    loadTypeScriptModule('src/runner.web.ts'),
    loadTypeScriptModule('src/rpc.shared.ts'),
  ])
  assert.equal(typeof resolveWebPublisherSigner, 'function')

  const publisherId = 'a'.repeat(64)
  const intentId = 'b'.repeat(32)
  const signerPublicKey = new Uint8Array(32).fill(1)
  const recordId = new Uint8Array(32).fill(2)
  const signature = new Uint8Array(64).fill(3)
  const request = {
    publisherId,
    recordType: 'publisher.namespace',
    body: new Uint8Array([4, 5]),
    displaySummaryJson: null,
    intentExpiresAt: Date.now() + 60_000,
    userInitiated: true,
  }
  const trustedSigner = Object.freeze({
    async beginUserIntent() {
      return { intentId, signerPublicKey }
    },
    async signPreparedRecord(_receivedIntentId, prepared) {
      return {
        intentId,
        publisherId,
        recordType: request.recordType,
        unsignedBytes: prepared.unsignedBytes,
        candidateRecordId: recordId,
        displaySummaryJson: null,
        signer: signerPublicKey,
        signerPublicKey,
        signature,
      }
    },
    completeIntent() {},
    cancelIntent() {},
  })
  const directRendererSigner = { ...trustedSigner }
  const client = {
    publisher: {
      async provisionPublisherCatalog(provision) {
        return { success: true, ...provision, catalogBootstrapKey: new Uint8Array(32) }
      },
      async preparePublisherRootOperation(preparedRequest) {
        return {
          ...preparedRequest,
          success: true,
          unsignedBytes: new Uint8Array([6, 7]),
          candidateRecordId: recordId,
          bodyLength: request.body.byteLength,
          issuedAt: 100,
          expiresAt: 0,
          error: null,
        }
      },
      async submitPublisherRootOperation(signed) {
        return {
          intentId,
          success: true,
          valid: true,
          complete: true,
          publisherId,
          recordType: request.recordType,
          recordId,
          signer: signed.signer,
          signerPublicKey: signed.signerPublicKey,
          signature: signed.signature,
        }
      },
    },
  }

  const resolved = resolveWebPublisherSigner(trustedSigner, trustedSigner)
  assert.equal(resolved, trustedSigner)
  const shellRpc = createPublisherRootOperationRpc(() => client, resolved, { runtime: 'shell' })
  assert.equal((await shellRpc.authorizePublisherRootOperation(request)).success, true)

  for (const explicit of [undefined, directRendererSigner]) {
    const rejected = resolveWebPublisherSigner(explicit, trustedSigner)
    assert.equal(rejected, null)
    const rendererRpc = createPublisherRootOperationRpc(() => client, rejected, { runtime: 'renderer' })
    await assert.rejects(
      rendererRpc.authorizePublisherRootOperation(request),
      (error) => error?.code === 'PUBLISHER_SIGNER_RENDERER_FORBIDDEN',
    )
  }
})

test('web RPC never accepts a renderer signer and only relays public publisher records to Bun', () => {
  const source = fs.readFileSync(path.join(platformRoot, 'src/rpc.web.ts'), 'utf8')
  assert.doesNotMatch(source, /publisherSigner\?: PublisherSignerBridgeLike/)
  assert.doesNotMatch(source, /window\.bridge\?\.publisherSigner/)
  assert.match(source, /registerPublisherBackendRelay/)
  assert.match(source, /ensureLocalPublisherCatalog/)
  assert.match(source, /createPublisherRootOperationRpc\([\s\S]*?null,[\s\S]*?runtime: 'renderer'/)
})
