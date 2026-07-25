import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from '../../app/node_modules/esbuild/lib/main.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const platformRoot = path.resolve(__dirname, '..')

async function loadRunner() {
  const result = await build({
    entryPoints: [path.join(platformRoot, 'src', 'runner.native.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    write: false,
  })
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-native-runner-'))
  const tempFile = path.join(tempDir, 'runner.cjs')
  fs.writeFileSync(tempFile, result.outputFiles[0].text)
  const mod = await import(pathToFileURL(tempFile).href)
  fs.rmSync(tempDir, { recursive: true, force: true })
  return mod
}

function validWireRequest(id = 1) {
  const publicKey = Buffer.alloc(32, 3)
  const secretKey = Buffer.alloc(64, 4)
  const domain = Buffer.from('peartube:legacy-publisher-root-migration:v1\0')
  const challenge = Buffer.concat([domain, publicKey, Buffer.alloc(32, 5)])
  return {
    type: 'legacy-publisher-root-migration-request',
    id,
    version: 1,
    identityPublicKey: publicKey.toString('hex'),
    secretKey: secretKey.toString('hex'),
    challenge: challenge.toString('hex'),
  }
}

class SuccessfulPreflightWorklet {
  static instance = null

  constructor() {
    SuccessfulPreflightWorklet.instance = this
    this.IPC = new EventEmitter()
    this.IPC.write = (chunk) => {
      const message = JSON.parse(String(chunk))
      this.writes.push(message)
      if (message.type === 'legacy-publisher-root-migration-ack' && message.ok === true) {
        const resultFrame = new TextEncoder().encode(JSON.stringify({
          type: 'legacy-publisher-root-preflight-result',
          summary: { status: 'complete', scanned: 1, migrated: 1, remaining: 0, secretKey: 'must-not-project' },
          secretKey: 'must-not-project',
        }))
        queueMicrotask(() => this.IPC.emit('data', resultFrame))
      }
    }
    this.writes = []
    this.started = []
    this.terminated = false
  }

  start(...args) {
    this.started.push(args)
    const requestFrame = new TextEncoder().encode(JSON.stringify(validWireRequest()))
    queueMicrotask(() => this.IPC.emit('data', requestFrame))
  }

  terminate() {
    this.terminated = true
  }
}

test('native legacy-root preflight bounds and converts local IPC, projects only a safe summary, and always terminates', async () => {
  const { runNativeLegacyPublisherRootPreflight } = await loadRunner()
  const callbackRequests = []
  const acknowledgement = {
    version: 1,
    durable: true,
    publicKey: Buffer.alloc(32, 3),
    challengeSignature: Buffer.alloc(64, 9),
  }

  const summary = await runNativeLegacyPublisherRootPreflight({
    WorkletCtor: SuccessfulPreflightWorklet,
    backendPath: '',
    backendSource: 'preflight bundle source',
    workletId: '/peartube-legacy-root-preflight.bundle',
    storagePath: '/tmp/peartube',
    timeoutMs: 1000,
    migrateLegacyPublisherRoot: async (request) => {
      callbackRequests.push(request)
      return acknowledgement
    },
  })

  const instance = SuccessfulPreflightWorklet.instance
  assert.deepEqual(instance.started, [[
    '/peartube-legacy-root-preflight.bundle',
    'preflight bundle source',
    ['/tmp/peartube', 'legacy-publisher-root-preflight'],
  ]])
  assert.equal(callbackRequests.length, 1)
  assert.deepEqual(Object.keys(callbackRequests[0]).sort(), [
    'challenge',
    'identityPublicKey',
    'secretKey',
    'version',
  ])
  assert.equal(callbackRequests[0].identityPublicKey.byteLength, 32)
  assert.equal(callbackRequests[0].secretKey.byteLength, 64)
  assert.equal(callbackRequests[0].challenge.byteLength, Buffer.from('peartube:legacy-publisher-root-migration:v1\0').byteLength + 64)
  assert.deepEqual(summary, { status: 'complete', scanned: 1, migrated: 1, remaining: 0 })
  assert.equal(JSON.stringify(summary).includes('secret'), false)
  assert.equal(instance.terminated, true)
  assert.deepEqual(instance.writes[0], {
    type: 'legacy-publisher-root-migration-ack',
    id: 1,
    ok: true,
    version: 1,
    durable: true,
    publicKey: acknowledgement.publicKey.toString('hex'),
    challengeSignature: acknowledgement.challengeSignature.toString('hex'),
  })
})

test('native legacy-root preflight rejects oversized or concurrent requests without leaking errors and still terminates', async () => {
  const { runNativeLegacyPublisherRootPreflight } = await loadRunner()
  let callbackCalls = 0

  class BoundedPreflightWorklet {
    static instance = null

    constructor() {
      BoundedPreflightWorklet.instance = this
      this.IPC = new EventEmitter()
      this.writes = []
      this.terminated = false
      this.IPC.write = (chunk) => { this.writes.push(JSON.parse(String(chunk))) }
    }

    start() {
      queueMicrotask(() => {
        this.IPC.emit('data', JSON.stringify(validWireRequest(1)))
        this.IPC.emit('data', JSON.stringify(validWireRequest(2)))
        this.IPC.emit('data', 'x'.repeat(9000))
      })
    }

    terminate() { this.terminated = true }
  }

  const summary = await runNativeLegacyPublisherRootPreflight({
    WorkletCtor: BoundedPreflightWorklet,
    backendSource: 'source',
    storagePath: '/tmp/peartube',
    timeoutMs: 1000,
    migrateLegacyPublisherRoot: async () => {
      callbackCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 50))
      throw new Error('denied secret=do-not-leak')
    },
  })

  const instance = BoundedPreflightWorklet.instance
  assert.equal(callbackCalls, 1, 'only one migration request may be pending')
  assert.equal(instance.terminated, true)
  assert.equal(JSON.stringify(summary).includes('do-not-leak'), false)
  assert.deepEqual(summary, {
    status: 'unavailable',
    scanned: 0,
    migrated: 0,
    remaining: 0,
    errorCode: 'MIGRATION_TRANSPORT_UNAVAILABLE',
  })
  assert.ok(instance.writes.some((message) => message.id === 2 && message.ok === false))
})
