import assert from 'node:assert/strict'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'brittle'

import {
  deriveRecordId,
  deriveSigningDigest,
  verifySignedEnvelope,
} from '../src/records/index.js'
import {
  createPublisherKeyProvider,
  MAX_PREPARED_ROOT_OPERATION_BYTES,
} from '../src/publisher/key-provider.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function keyPair(seedByte) {
  return crypto.keyPair(b4a.alloc(32, seedByte))
}

test('publisher key provider prepares bounded canonical bytes without platform vault access', async (t) => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'publisher', 'key-provider.js'), 'utf8')
  assert.doesNotMatch(source, /expo-secure-store|@napi-rs\/keyring|publisher-key-vault|getSecret|secretKey|rootSecret/)

  const provider = createPublisherKeyProvider({ now: () => 1000 })
  const prepared = provider.preparePublisherRootOperation({
    publisherId: 'ptpub:test',
    recordType: 'publisher.root.operation.v1',
    body: b4a.from('authorize-writer'),
    displaySummary: { action: 'authorize writer', writer: 'device-a' },
    expiresInMs: 60_000,
  })

  assert.equal(prepared.recordType, 'publisher.root.operation.v1')
  assert.equal(prepared.expiresAt, 61_000)
  assert.equal(prepared.unsignedBytes.byteLength <= MAX_PREPARED_ROOT_OPERATION_BYTES, true)
  assert.deepEqual(prepared.candidateRecordId, deriveRecordId({
    recordType: prepared.recordType,
    body: b4a.from('authorize-writer'),
    issuedAt: 1000,
    expiresAt: 61_000,
  }))
  assert.deepEqual(prepared.displaySummary, { action: 'authorize writer', writer: 'device-a' })
  assert.equal(Object.hasOwn(prepared, 'secretKey'), false)
  t.pass('prepared canonical bytes without secret material')
})

test('publisher key provider accepts only signatures over the prepared candidate id', async (t) => {
  const root = keyPair(7)
  const attacker = keyPair(8)
  const provider = createPublisherKeyProvider({ now: () => 1000 })
  const prepared = provider.preparePublisherRootOperation({
    publisherId: 'ptpub:test',
    recordType: 'publisher.root.operation.v1',
    body: b4a.from('rotate-root'),
    expiresInMs: 60_000,
  })
  const signature = crypto.sign(deriveSigningDigest(prepared.candidateRecordId), root.secretKey)

  const accepted = await provider.submitPublisherRootOperation({
    prepared,
    signer: root.publicKey,
    signature,
    allowedSigners: [root.publicKey],
  })
  assert.equal(accepted.valid, true)
  assert.equal(await verifySignedEnvelope(accepted.envelope, { allowedSigners: [root.publicKey], now: 1000 }), true)

  const wrongSigner = await provider.submitPublisherRootOperation({
    prepared,
    signer: attacker.publicKey,
    signature: crypto.sign(deriveSigningDigest(prepared.candidateRecordId), attacker.secretKey),
    allowedSigners: [root.publicKey],
  })
  assert.equal(wrongSigner.valid, false)
  assert.equal(wrongSigner.reason, 'signature-verification-failed')

  const substituted = await provider.submitPublisherRootOperation({
    prepared: { ...prepared, candidateRecordId: b4a.alloc(32, 9) },
    signer: root.publicKey,
    signature,
    allowedSigners: [root.publicKey],
  })
  assert.equal(substituted.valid, false)
  assert.equal(substituted.reason, 'candidate-record-id-mismatch')
  t.pass('signature submit path is bound to prepared canonical bytes')
})

test('publisher key provider rejects oversized prepared bodies before allocating signature work', (t) => {
  const provider = createPublisherKeyProvider({ now: () => 1000 })
  assert.throws(() => provider.preparePublisherRootOperation({
    publisherId: 'ptpub:test',
    recordType: 'publisher.root.operation.v1',
    body: b4a.alloc(MAX_PREPARED_ROOT_OPERATION_BYTES + 1),
  }), /body length exceeds/i)
  t.pass('prepared body bound enforced')
})
