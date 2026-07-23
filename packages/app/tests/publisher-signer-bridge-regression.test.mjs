import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  createSignedEnvelope,
  deriveRecordId,
  encodeUnsignedRecord,
} from '../../backend/src/records/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')
const recordsUrl = pathToFileURL(path.resolve(appRoot, '../backend/src/records/index.js')).href

function readAppFile(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

async function loadSignerBridgeModule() {
  const source = readAppFile('lib/publisher-signer-bridge.ts')
    .replace(/from ['"]@peartube\/backend\/records['"]/g, `from '${recordsUrl}'`)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-signer-bridge-'))
  const tempFile = path.join(tempDir, 'publisher-signer-bridge.mjs')
  fs.writeFileSync(tempFile, source)
  const mod = await import(pathToFileURL(tempFile).href)
  return { mod, tempDir }
}

test('publisher signer bridge validates exact canonical bytes, candidate id, and single-use shell intent', async () => {
  const { mod, tempDir } = await loadSignerBridgeModule()
  const keyPair = crypto.keyPair(b4a.alloc(32, 42))
  const unsigned = {
    recordType: 'publisher.root.operation.v1',
    body: b4a.from('create-root'),
    issuedAt: 10,
    expiresAt: 100,
  }
  const unsignedBytes = encodeUnsignedRecord(unsigned)
  const recordId = deriveRecordId(unsigned)
  const calls = []
  const bridge = mod.createPublisherSignerBridge({
    now: () => 50,
    vault: {
      async getPublicKey({ publisherId }) {
        assert.equal(publisherId, 'publisher-a')
        return keyPair.publicKey
      },
      async signDigest(request) {
        calls.push(request)
        return {
          signer: keyPair.publicKey,
          signature: crypto.sign(request.signingDigest, keyPair.secretKey),
        }
      },
    },
  })

  bridge.registerIntent({
    intentId: 'intent-1',
    publisherId: 'publisher-a',
    recordType: unsigned.recordType,
    unsignedBytes,
    candidateRecordId: recordId,
    displaySummary: { action: 'create root' },
    expiresAt: 100,
  })

  const signed = await bridge.signPreparedOperation({
    caller: 'shell',
    intentId: 'intent-1',
    publisherId: 'publisher-a',
    recordType: unsigned.recordType,
    unsignedBytes,
    candidateRecordId: recordId,
    displaySummary: { action: 'create root' },
  })

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].recordId, recordId)
  assert.equal(calls[0].recordType, unsigned.recordType)
  assert.equal(calls[0].intentId, 'intent-1')
  assert.equal(await mod.verifyBridgeSignedOperation(signed, { allowedSigners: [keyPair.publicKey], now: 50 }), true)

  await assert.rejects(() => bridge.signPreparedOperation({
    caller: 'shell',
    intentId: 'intent-1',
    publisherId: 'publisher-a',
    recordType: unsigned.recordType,
    unsignedBytes,
    candidateRecordId: recordId,
    displaySummary: { action: 'create root' },
  }), /unknown or consumed intent/i)

  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('publisher signer bridge rejects renderer calls, summary-only authority, and candidate-id substitution', async () => {
  const { mod, tempDir } = await loadSignerBridgeModule()
  const keyPair = crypto.keyPair(b4a.alloc(32, 43))
  const unsigned = {
    recordType: 'publisher.root.operation.v1',
    body: b4a.from('rotate-root'),
    issuedAt: 10,
    expiresAt: 100,
  }
  const unsignedBytes = encodeUnsignedRecord(unsigned)
  const recordId = deriveRecordId(unsigned)
  const bridge = mod.createPublisherSignerBridge({
    now: () => 50,
    vault: {
      async getPublicKey() { return keyPair.publicKey },
      async signDigest() { throw new Error('must not sign invalid request') },
    },
  })

  bridge.registerIntent({
    intentId: 'intent-2',
    publisherId: 'publisher-a',
    recordType: unsigned.recordType,
    unsignedBytes,
    candidateRecordId: recordId,
    displaySummary: { action: 'rotate root' },
    expiresAt: 100,
  })

  await assert.rejects(() => bridge.signPreparedOperation({
    caller: 'renderer',
    intentId: 'intent-2',
    publisherId: 'publisher-a',
    recordType: unsigned.recordType,
    unsignedBytes,
    candidateRecordId: recordId,
    displaySummary: { action: 'rotate root' },
  }), /shell-owned signer/i)

  await assert.rejects(() => bridge.signPreparedOperation({
    caller: 'shell',
    intentId: 'intent-2',
    publisherId: 'publisher-a',
    recordType: unsigned.recordType,
    unsignedBytes,
    candidateRecordId: b4a.alloc(32, 9),
    displaySummary: { action: 'rotate root' },
  }), /candidate record id mismatch/i)

  await assert.rejects(() => bridge.signPreparedOperation({
    caller: 'shell',
    intentId: 'intent-2',
    publisherId: 'publisher-a',
    recordType: unsigned.recordType,
    unsignedBytes,
    candidateRecordId: recordId,
    displaySummary: { action: 'different summary' },
  }), /display summary mismatch/i)

  const source = readAppFile('lib/publisher-signer-bridge.ts')
  assert.match(source, /summary is never signature authority/i)
  assert.match(source, /constantTimeEqual/)
  assert.doesNotMatch(source, /getSecret|secretKey|rootSecret/)

  fs.rmSync(tempDir, { recursive: true, force: true })
})
