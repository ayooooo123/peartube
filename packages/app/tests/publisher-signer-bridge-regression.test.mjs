import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  encodeUnsignedMultiSignedEnvelope,
  encodeUnsignedSignedEnvelope,
  multiSignedRecordSignaturePreimage,
  prepareMultiSignedEnvelope,
  prepareSignedEnvelope,
  signedRecordSignaturePreimage,
} from '../../backend/src/records/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '..')
const NOW = 1_700_000_000_000
const ISSUER_KEY = b4a.alloc(32, 8)

async function loadSignerBridgeModule() {
  const result = await build({
    entryPoints: [path.join(appRoot, 'lib/publisher-signer-bridge.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    external: ['hypercore-crypto', 'sodium-native'],
    write: false,
  })
  const tempDir = fs.mkdtempSync(path.join(appRoot, '.tmp-signer-bridge-'))
  const tempFile = path.join(tempDir, 'publisher-signer-bridge.cjs')
  fs.writeFileSync(tempFile, result.outputFiles[0].text)
  return { mod: await import(pathToFileURL(tempFile).href), tempDir }
}

function singlePrepared(signerPublicKey, intentId, overrides = {}) {
  const canonicalBody = overrides.body || b4a.from('revoke writer')
  const unsigned = {
    recordType: 'publisher.writer-revocation',
    schemaMajor: 1,
    schemaMinor: 0,
    issuerIdentityKey: ISSUER_KEY,
    signerKey: signerPublicKey,
    policyEpoch: 2,
    issuerSequence: 4,
    signedAt: NOW,
    canonicalBody,
  }
  const protocol = prepareSignedEnvelope(unsigned, { hash: crypto.hash })
  return {
    intentId,
    success: true,
    publisherId: overrides.publisherId || 'a'.repeat(64),
    recordType: unsigned.recordType,
    unsignedBytes: encodeUnsignedSignedEnvelope(protocol),
    candidateRecordId: protocol.recordId,
    signerPublicKey,
    bodyLength: canonicalBody.byteLength,
    issuedAt: NOW,
    intentExpiresAt: NOW + 60_000,
    displaySummaryJson: '{"action":"revoke writer"}',
  }
}

async function createFixture(overrides = {}) {
  const { mod, tempDir } = await loadSignerBridgeModule()
  const keyPair = crypto.keyPair(b4a.alloc(32, overrides.seed || 42))
  const calls = []
  let currentTime = NOW
  const vault = overrides.vault || {
    async getPublicKey() { return keyPair.publicKey },
    async signProtocolRecord(request) {
      calls.push(request)
      const preimage = request.transitionId
        ? multiSignedRecordSignaturePreimage(request)
        : signedRecordSignaturePreimage(request)
      return {
        signerPublicKey: keyPair.publicKey,
        signature: crypto.sign(preimage, keyPair.secretKey),
      }
    },
  }
  const bridge = mod.createPublisherSignerBridge({
    vault,
    now: () => currentTime,
    randomBytes: () => b4a.alloc(16, overrides.intentSeed || 7),
  })
  return { mod, tempDir, keyPair, calls, bridge, setNow: (value) => { currentTime = value } }
}

async function beginSingle(fixture) {
  const body = b4a.from('revoke writer')
  const intent = await fixture.bridge.beginUserIntent({
    publisherId: 'a'.repeat(64),
    recordType: 'publisher.writer-revocation',
    body,
    displaySummaryJson: '{"action":"revoke writer"}',
    intentExpiresAt: NOW + 60_000,
    userInitiated: true,
  })
  return { intent, prepared: singlePrepared(fixture.keyPair.publicKey, intent.intentId, { body }) }
}

test('publisher signer bridge binds exact canonical prepare bytes and exposes only purpose-specific signing', async () => {
  const fixture = await createFixture()
  const { intent, prepared } = await beginSingle(fixture)
  const signed = await fixture.bridge.signPreparedRecord(intent.intentId, prepared)

  assert.deepEqual(Object.keys(fixture.calls[0]).sort(), ['publisherId', 'recordId', 'recordType'])
  assert.deepEqual(fixture.calls[0].recordId, prepared.candidateRecordId)
  assert.equal(fixture.bridge.signMessage, undefined)
  assert.equal(fixture.bridge.signDigest, undefined)
  assert.deepEqual(
    signed.signature,
    crypto.sign(
      signedRecordSignaturePreimage({ recordType: signed.recordType, recordId: signed.candidateRecordId }),
      fixture.keyPair.secretKey,
    ),
  )
  await assert.rejects(() => fixture.bridge.signPreparedRecord(intent.intentId, prepared), /UNKNOWN_INTENT/)
  fs.rmSync(fixture.tempDir, { recursive: true, force: true })
})

test('publisher signer bridge derives a root transition id and returns one signer contribution', async () => {
  const fixture = await createFixture({ intentSeed: 9 })
  const body = b4a.from('rotate root')
  const intent = await fixture.bridge.beginUserIntent({
    publisherId: 'a'.repeat(64),
    recordType: 'publisher.root-transition',
    body,
    displaySummaryJson: '{"action":"rotate root"}',
    intentExpiresAt: NOW + 60_000,
    userInitiated: true,
  })
  const unsigned = {
    recordType: 'publisher.root-transition',
    schemaMajor: 1,
    schemaMinor: 0,
    issuerIdentityKey: ISSUER_KEY,
    policyEpoch: 2,
    issuerSequence: 5,
    signedAt: NOW,
    canonicalBody: body,
  }
  const protocol = prepareMultiSignedEnvelope(unsigned, { hash: crypto.hash })
  const signed = await fixture.bridge.signPreparedRecord(intent.intentId, {
    intentId: intent.intentId,
    success: true,
    publisherId: 'a'.repeat(64),
    recordType: unsigned.recordType,
    unsignedBytes: encodeUnsignedMultiSignedEnvelope(protocol),
    candidateRecordId: protocol.transitionId,
    signerPublicKey: intent.signerPublicKey,
    bodyLength: body.byteLength,
    issuedAt: NOW,
    intentExpiresAt: NOW + 60_000,
    displaySummaryJson: '{"action":"rotate root"}',
  })

  assert.deepEqual(Object.keys(fixture.calls[0]).sort(), ['publisherId', 'recordType', 'transitionId'])
  assert.deepEqual(signed.candidateRecordId, protocol.transitionId)
  assert.equal(signed.signature.byteLength, 64)
  fs.rmSync(fixture.tempDir, { recursive: true, force: true })
})

test('summary, body, candidate id, and record type substitutions each consume the intent', async () => {
  for (const field of ['summary', 'body', 'candidate-id', 'record-type']) {
    const fixture = await createFixture()
    const { intent, prepared } = await beginSingle(fixture)
    if (field === 'summary') prepared.displaySummaryJson = '{"action":"different"}'
    if (field === 'body') {
      Object.assign(prepared, singlePrepared(fixture.keyPair.publicKey, intent.intentId, {
        body: b4a.from('different body'),
      }))
    }
    if (field === 'candidate-id') prepared.candidateRecordId = b4a.alloc(32, 99)
    if (field === 'record-type') prepared.recordType = 'publisher.namespace'
    await assert.rejects(
      () => fixture.bridge.signPreparedRecord(intent.intentId, prepared),
      (error) => error?.code === 'PUBLISHER_SIGNER_MISMATCH',
    )
    await assert.rejects(() => fixture.bridge.signPreparedRecord(intent.intentId, prepared), /UNKNOWN_INTENT/)
    fs.rmSync(fixture.tempDir, { recursive: true, force: true })
  }
})

test('every failed signing attempt consumes the intent, including mismatch, expiry, and vault error', async () => {
  for (const scenario of ['mismatch', 'expiry', 'vault']) {
    const fixture = await createFixture(scenario === 'vault' ? {
      vault: {
        async getPublicKey() { return crypto.keyPair(b4a.alloc(32, 42)).publicKey },
        async signProtocolRecord() { throw new Error('raw-secret-material') },
      },
    } : {})
    const { intent, prepared } = await beginSingle(fixture)
    if (scenario === 'mismatch') prepared.candidateRecordId = b4a.alloc(32, 99)
    if (scenario === 'expiry') fixture.setNow(NOW + 60_000)
    await assert.rejects(
      () => fixture.bridge.signPreparedRecord(intent.intentId, prepared),
      scenario === 'vault'
        ? (error) => error?.code === 'PUBLISHER_SIGNER_VAULT_UNAVAILABLE' && !error.message.includes('raw-secret-material')
        : undefined,
    )
    await assert.rejects(() => fixture.bridge.signPreparedRecord(intent.intentId, prepared), /UNKNOWN_INTENT/)
    fs.rmSync(fixture.tempDir, { recursive: true, force: true })
  }
})

test('locked vault failures are stable and redact shell credential errors', async () => {
  const fixture = await createFixture({
    vault: {
      async getPublicKey() { throw new Error('device-lock-secret-path') },
      async signProtocolRecord() { throw new Error('must not sign') },
    },
  })
  await assert.rejects(
    () => fixture.bridge.beginUserIntent({
      publisherId: 'a'.repeat(64),
      recordType: 'publisher.namespace',
      body: b4a.from('namespace'),
      displaySummaryJson: '{}',
      intentExpiresAt: NOW + 60_000,
      userInitiated: true,
    }),
    (error) => error?.code === 'PUBLISHER_SIGNER_VAULT_UNAVAILABLE' &&
      !error.message.includes('device-lock-secret-path'),
  )
  fs.rmSync(fixture.tempDir, { recursive: true, force: true })
})

test('background intents and substituted vault signatures are rejected with redacted stable errors', async () => {
  const fixture = await createFixture({
    vault: {
      async getPublicKey() { return crypto.keyPair(b4a.alloc(32, 42)).publicKey },
      async signProtocolRecord() {
        return { signerPublicKey: b4a.alloc(32, 2), signature: b4a.alloc(64, 3) }
      },
    },
  })
  await assert.rejects(() => fixture.bridge.beginUserIntent({
    publisherId: 'a'.repeat(64),
    recordType: 'publisher.namespace',
    body: b4a.from('namespace'),
    displaySummaryJson: '{}',
    intentExpiresAt: NOW + 60_000,
    userInitiated: false,
  }), /BACKGROUND_FORBIDDEN/)
  const { intent, prepared } = await beginSingle(fixture)
  await assert.rejects(
    () => fixture.bridge.signPreparedRecord(intent.intentId, prepared),
    (error) => error?.code === 'PUBLISHER_SIGNER_SIGNATURE_SUBSTITUTION' && !error.message.includes('raw-secret'),
  )
  fs.rmSync(fixture.tempDir, { recursive: true, force: true })
})
