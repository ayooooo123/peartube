import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { createPublisherKeyProvider } from '../src/publisher/index.js'
import {
  prepareSignedEnvelope,
  attachSignedEnvelopeSignature,
  signedRecordSignaturePreimage
} from '@peartube/backend/records'

const bytes = (length, seed = 0) => b4a.from(Array.from({ length }, (_, index) => (seed + index) & 255))

function throws (t, fn, pattern) {
  try {
    fn()
  } catch (error) {
    t.ok(pattern.test(error?.message || ''), `expected ${pattern}, received ${error?.message || error}`)
    return
  }
  t.fail(`expected ${pattern} to be thrown`)
}

function signedEnvelope() {
  const signer = crypto.keyPair(bytes(32, 1))
  const prepared = prepareSignedEnvelope({
    recordType: 'publisher.publication',
    schemaMajor: 1,
    schemaMinor: 0,
    issuerIdentityKey: bytes(32, 40),
    signerKey: signer.publicKey,
    policyEpoch: 3,
    issuerSequence: 9,
    signedAt: 1_700_000_000_000,
    canonicalBody: b4a.from('bounded body')
  }, { hash: crypto.hash })
  return {
    signer,
    value: attachSignedEnvelopeSignature(prepared, crypto.sign(signedRecordSignaturePreimage(prepared), signer.secretKey))
  }
}

const authorization = value => ({
  issuerIdentityKey: value.issuerIdentityKey,
  policyEpoch: value.policyEpoch,
  authorizeSigner: candidate => b4a.equals(candidate.signerKey, value.signerKey),
  authorizeSequence: candidate => candidate.issuerSequence === value.issuerSequence,
  claimReplay: () => true,
  now: value.signedAt,
  maxClockSkew: 0
})

test('backend key provider exposes verification only and verifies real signed records', (t) => {
  const provider = createPublisherKeyProvider()
  const { value } = signedEnvelope()

  t.is(provider.verifySignedEnvelope(value, authorization(value)).valid, true)
  t.is(typeof provider.hash, 'function')
  t.is(typeof provider.verifySignature, 'function')
  t.is(provider.sign, undefined)
  t.is(provider.getSecret, undefined)
  t.is(provider.exportSecret, undefined)
  t.is(provider.secretKey, undefined)
  t.ok(Object.isFrozen(provider), 'verification boundary cannot be extended with secret APIs')

  const tampered = { ...value, signature: b4a.from(value.signature) }
  tampered.signature[0] ^= 1
  throws(t, () => provider.verifySignedEnvelope(tampered, authorization(tampered)), /signature/)
})

test('key provider rejects secret-bearing or signing dependencies before retaining them', (t) => {
  for (const dependency of [
    { secretKey: bytes(64, 1) },
    { getSecret() {} },
    { exportSecret() {} },
    { sign() {} },
    { signer: { signPreparedRecord() {} } }
  ]) {
    throws(t, () => createPublisherKeyProvider(dependency), /secret|signing|verification-only/)
  }
})

test('injected provider receives public verification inputs only and cannot mutate caller bytes', (t) => {
  const { value } = signedEnvelope()
  const calls = []
  const provider = createPublisherKeyProvider({
    hash(input) {
      calls.push({ type: 'hash', input: b4a.from(input) })
      return crypto.hash(input)
    },
    verifySignature(signature, preimage, publicKey) {
      calls.push({ type: 'verify', signature: b4a.from(signature), preimage: b4a.from(preimage), publicKey: b4a.from(publicKey) })
      return crypto.verify(preimage, signature, publicKey)
    }
  })

  t.is(provider.verifySignedEnvelope(value, authorization(value)).valid, true)
  t.ok(calls.some(call => call.type === 'hash'))
  const verification = calls.find(call => call.type === 'verify')
  t.is(verification.publicKey.byteLength, 32)
  t.is(verification.signature.byteLength, 64)
  t.absent(calls.some(call => Object.hasOwn(call, 'secretKey')), 'no secret reaches verification dependency')
})
