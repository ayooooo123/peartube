import test from 'brittle'
import b4a from 'b4a'

import {
  RECORD_LIMITS,
  encodeSignedEnvelope,
  decodeSignedEnvelope,
  decodeUnsignedSignedEnvelope,
  encodeUnsignedSignedEnvelope,
  signedRecordSignaturePreimage,
  prepareSignedEnvelope,
  attachSignedEnvelopeSignature,
  verifySignedEnvelope,
  encodeMultiSignedEnvelope,
  decodeMultiSignedEnvelope,
  decodeUnsignedMultiSignedEnvelope,
  encodeUnsignedMultiSignedEnvelope,
  multiSignedRecordSignaturePreimage,
  prepareMultiSignedEnvelope,
  attachMultiSignedEnvelopeSignatures,
  verifyMultiSignedEnvelope
} from '@peartube/backend/records'

const SIGNED_ENVELOPE_VECTOR_HEX = '01137075626c69736865722e6f7065726174696f6e01000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f4004010980d095ffbc3101e0a499ffbc310c464748494a4b4c4d4e4f505136acddc732a8d9c33ea4d5cf3aa0d1cb26bccdd722b8c9d32eb4c5df2ab0c1db2a6277662e667362226a7f6e266e7b6a3a7267763e766372327a6f7e367e6b7aaa304346ae344742a2384b4ea63c4f4aba205356be245752b2285b5eb62c5f5a'
const MULTI_SIGNED_ENVELOPE_VECTOR_HEX = '02197075626c69736865722e726f6f742d7472616e736974696f6e01000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20050a80d095ffbc310f5a5b5c5d5e5f60616263646566676851389705553c930159309f0d5d349b0941288715452c831149208f1d4d248b190202030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20213f4699903b429d94374e9198334a959c2f5689802b528d84275e8188235a858cbfd3afeabbd7abeeb7dba7e2b3dfa3e6afc3bffaabc7bbfea7cbb7f2a3cfb3f622232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40413fd5d2453bd1d64137ddda4d33d9de492fc5c2552bc1c65127cdca5d23c9ce59bfa42d02bba02906b7ac250ab3a8210eafb43d12abb03916a7bc351aa3b8311e'

function assertFixedCodecVectors () {
  const single = b4a.from(SIGNED_ENVELOPE_VECTOR_HEX, 'hex')
  const multi = b4a.from(MULTI_SIGNED_ENVELOPE_VECTOR_HEX, 'hex')
  if (b4a.toString(encodeSignedEnvelope(decodeSignedEnvelope(single)), 'hex') !== SIGNED_ENVELOPE_VECTOR_HEX) throw new Error('single signed-envelope vector mismatch')
  if (b4a.toString(encodeMultiSignedEnvelope(decodeMultiSignedEnvelope(multi)), 'hex') !== MULTI_SIGNED_ENVELOPE_VECTOR_HEX) throw new Error('multi signed-envelope vector mismatch')
  return 2
}
const bytes = (length, seed = 0) => b4a.from(Array.from({ length }, (_, i) => (seed + i) & 255))
const key = seed => bytes(32, seed)
const signature = seed => bytes(64, seed)
const equal = (a, b) => b4a.equals(a, b)
function throws (t, fn, pattern) {
  try {
    fn()
  } catch (error) {
    t.ok(pattern.test(error?.message || ''), `expected ${pattern}, received ${error?.message || error}`)
    return
  }
  t.fail(`expected ${pattern} to be thrown`)
}
const hash = input => {
  let state = 2166136261
  for (const value of input) state = Math.imul(state ^ value, 16777619) >>> 0
  const out = b4a.alloc(32)
  for (let i = 0; i < out.length; i++) out[i] = (state >>> ((i & 3) * 8)) ^ i
  return out
}
const makeSignature = (signerKey, preimage) => b4a.concat([hash(b4a.concat([signerKey, preimage])), hash(b4a.concat([preimage, signerKey]))])
const verifySignature = (sig, preimage, signerKey) => equal(sig, makeSignature(signerKey, preimage))

const unsigned = (overrides = {}) => ({
  recordType: 'publisher.operation', schemaMajor: 1, schemaMinor: 0,
  issuerIdentityKey: key(1), signerKey: key(33), policyEpoch: 4,
  issuerSequence: 9, signedAt: 1_700_000_000_000, expiresAt: 1_700_000_060_000,
  canonicalBody: bytes(12, 70), ...overrides
})
const auth = (overrides = {}) => ({
  issuerIdentityKey: key(1), policyEpoch: 4,
  authorizeSigner: ({ signerKey }) => equal(signerKey, key(33)),
  authorizeSequence: ({ issuerSequence }) => issuerSequence === 9,
  claimReplay: () => true,
  now: 1_700_000_030_000, maxClockSkew: 0,
  ...overrides
})

function signed (overrides = {}) {
  const prepared = prepareSignedEnvelope(unsigned(overrides), { hash })
  return attachSignedEnvelopeSignature(prepared, makeSignature(prepared.signerKey, signedRecordSignaturePreimage(prepared)))
}

const multiUnsigned = (overrides = {}) => ({
  recordType: 'publisher.root-transition', schemaMajor: 1, schemaMinor: 0,
  issuerIdentityKey: key(1), policyEpoch: 5, issuerSequence: 10,
  signedAt: 1_700_000_000_000, canonicalBody: bytes(15, 90), ...overrides
})
function multiSigned (signers = [key(2), key(34)], overrides = {}) {
  const prepared = prepareMultiSignedEnvelope(multiUnsigned(overrides), { hash })
  return attachMultiSignedEnvelopeSignatures(prepared, signers.map(signerKey => ({
    signerKey, signature: makeSignature(signerKey, multiSignedRecordSignaturePreimage(prepared))
  })))
}

test('single envelope encoding is deterministic and round trips canonically', (t) => { const value = signed()
const encoded = encodeSignedEnvelope(value)
t.alike(decodeSignedEnvelope(encoded), value)
t.ok(equal(encoded, encodeSignedEnvelope(decodeSignedEnvelope(encoded))))
t.is(value.bodyLength, value.canonicalBody.byteLength) })

test('unsigned envelope decoders reject trailing bytes and round trip canonically', (t) => {
  const singleBytes = encodeUnsignedSignedEnvelope(unsigned())
  const multiBytes = encodeUnsignedMultiSignedEnvelope(multiUnsigned())
  t.alike(decodeUnsignedSignedEnvelope(singleBytes), { ...unsigned(), bodyLength: unsigned().canonicalBody.byteLength })
  t.alike(decodeUnsignedMultiSignedEnvelope(multiBytes), { ...multiUnsigned(), bodyLength: multiUnsigned().canonicalBody.byteLength })
  throws(t, () => decodeUnsignedSignedEnvelope(b4a.concat([singleBytes, b4a.from([0])])), /trailing/)
  throws(t, () => decodeUnsignedMultiSignedEnvelope(b4a.concat([multiBytes, b4a.from([0])])), /trailing/)
})

test('record ID hashes only the exact canonical unsigned envelope', (t) => { const value = signed()
t.ok(equal(value.recordId, hash(encodeUnsignedSignedEnvelope(value))))
t.absent(equal(prepareSignedEnvelope(unsigned({ recordType: 'other' }), { hash }).recordId, value.recordId))
throws(t, () => prepareSignedEnvelope(unsigned(), { hash: () => bytes(31) }), /32 bytes/) })

test('single signature preimage has exact domain and unambiguous fields', (t) => { const value = signed()
const expected = b4a.concat([b4a.from([35]), b4a.from('peartube/signed-record-signature/v1'), b4a.from([19]), b4a.from(value.recordType), value.recordId])
t.ok(equal(signedRecordSignaturePreimage(value), expected)) })

test('single verification requires explicit current authorization, sequence, time, and replay context', (t) => { const value = signed()
throws(t, () => verifySignedEnvelope(value, { hash, verifySignature }), /authorization context/)
t.is(verifySignedEnvelope(value, { hash, verifySignature, authorization: auth() }).valid, true)
for (const authorization of [
  auth({ issuerIdentityKey: key(2) }), auth({ policyEpoch: 3 }),
  auth({ authorizeSigner: () => false }), auth({ authorizeSequence: undefined }),
  auth({ authorizeSequence: () => false }), auth({ claimReplay: () => false }),
  auth({ now: undefined }), auth({ now: Number.NaN }), auth({ now: value.expiresAt + 1 }),
  auth({ now: value.signedAt - 1 }), auth({ now: value.signedAt - 11, maxClockSkew: 10 })
]) throws(t, () => verifySignedEnvelope(value, { hash, verifySignature, authorization }), /issuer|policy|authorized|replay|expired|sequence|now|future/)
t.is(verifySignedEnvelope(value, { hash, verifySignature, authorization: auth({ now: value.expiresAt, maxClockSkew: 10 }) }).valid, true)
t.is(verifySignedEnvelope(value, { hash, verifySignature, authorization: auth({ now: value.expiresAt + 10, maxClockSkew: 10 }) }).valid, true)
throws(t, () => verifySignedEnvelope(signed({ expiresAt: 1_699_999_999_999 }), { hash, verifySignature, authorization: auth() }), /expiresAt/) })

test('single verification rejects tampering, stale IDs, and invalid signatures', (t) => { const value = signed()
for (const changed of [
  { ...value, canonicalBody: bytes(12, 71) },
  { ...value, recordId: key(99) },
  { ...value, signature: signature(99) }
]) throws(t, () => verifySignedEnvelope(changed, { hash, verifySignature, authorization: auth() }), /bodyLength|recordId|signature/) })

test('single parser rejects malformed, truncated, trailing, noncanonical, and bounded input', (t) => { const encoded = encodeSignedEnvelope(signed())
throws(t, () => decodeSignedEnvelope(encoded.subarray(0, encoded.length - 1)), /truncated/)
throws(t, () => decodeSignedEnvelope(b4a.concat([encoded, b4a.from([0])])), /trailing/)
throws(t, () => decodeSignedEnvelope(b4a.from([2])), /variant/)
const noncanonical = b4a.from(encoded); noncanonical[1] = 0x81; noncanonical[2] = 0
throws(t, () => decodeSignedEnvelope(noncanonical), /canonical|trailing/)
throws(t, () => encodeSignedEnvelope(signed({ recordType: 'x'.repeat(RECORD_LIMITS.maxRecordTypeBytes + 1) })), /recordType/)
throws(t, () => encodeSignedEnvelope(signed({ canonicalBody: bytes(RECORD_LIMITS.maxBodyBytes + 1) })), /canonicalBody/)
throws(t, () => decodeSignedEnvelope(b4a.from([1, 1, 120, 1, 0, 32])), /truncated|length/) })

test('multi envelope is signer-independent, deterministic, sorted, and transition-bound', (t) => { const value = multiSigned()
const encoded = encodeMultiSignedEnvelope(value)
t.alike(decodeMultiSignedEnvelope(encoded), value)
t.ok(equal(value.transitionId, hash(encodeUnsignedMultiSignedEnvelope(value))))
t.ok(equal(encoded, encodeMultiSignedEnvelope(decodeMultiSignedEnvelope(encoded))))
const changed = prepareMultiSignedEnvelope(multiUnsigned({ canonicalBody: bytes(15, 91) }), { hash })
t.absent(equal(multiSignedRecordSignaturePreimage(changed), multiSignedRecordSignaturePreimage(value))) })

test('multi signature preimage has exact separate domain', (t) => { const value = multiSigned()
const expected = b4a.concat([b4a.from([40]), b4a.from('peartube/multisigned-record-signature/v1'), b4a.from([25]), b4a.from(value.recordType), value.transitionId])
t.ok(equal(multiSignedRecordSignaturePreimage(value), expected)) })

test('multi verification enforces complete required and quorum signer policy', (t) => { const value = multiSigned()
const authorization = {
  issuerIdentityKey: key(1), policyEpoch: 5, expectedSequence: 10,
  signerPolicy: { requiredSignerKeys: [key(2)], quorumSignerKeys: [key(34), key(66)], quorum: 1 },
  claimReplay: () => true
}
t.is(verifyMultiSignedEnvelope(value, { hash, verifySignature, authorization }).valid, true)
throws(t, () => verifyMultiSignedEnvelope(value, { hash, verifySignature }), /authorization context/)
throws(t, () => verifyMultiSignedEnvelope(multiSigned([key(2)]), { hash, verifySignature, authorization }), /quorum/)
throws(t, () => verifyMultiSignedEnvelope(multiSigned([key(34)]), { hash, verifySignature, authorization }), /required/)
throws(t, () => verifyMultiSignedEnvelope(multiSigned([key(2), key(34), key(66)]), { hash, verifySignature, authorization }), /quorum|extra/)
throws(t, () => verifyMultiSignedEnvelope(value, { hash, verifySignature, authorization: {
  ...authorization, signerPolicy: { requiredSignerKeys: [key(2)], quorumSignerKeys: [key(2), key(34)], quorum: 1 }
} }), /overlap/)
throws(t, () => verifyMultiSignedEnvelope(multiSigned([key(2), key(99)]), { hash, verifySignature, authorization }), /authorized|extra/)
throws(t, () => attachMultiSignedEnvelopeSignatures(prepareMultiSignedEnvelope(multiUnsigned(), { hash }), [
  { signerKey: key(2), signature: signature(1) }, { signerKey: key(2), signature: signature(2) }
]), /distinct/)
throws(t, () => attachMultiSignedEnvelopeSignatures(prepareMultiSignedEnvelope(multiUnsigned(), { hash }), [
  { signerKey: key(34), signature: signature(1) }, { signerKey: key(2), signature: signature(2) }
]), /ordered/) })

test('multi parser rejects unknown/truncated/trailing and signature count bounds', (t) => { const encoded = encodeMultiSignedEnvelope(multiSigned())
throws(t, () => decodeMultiSignedEnvelope(encoded.subarray(0, encoded.length - 1)), /truncated/)
throws(t, () => decodeMultiSignedEnvelope(b4a.concat([encoded, b4a.from([0])])), /trailing/)
throws(t, () => decodeMultiSignedEnvelope(b4a.from([3])), /variant/)
const tooMany = Array.from({ length: RECORD_LIMITS.maxSignatures + 1 }, (_, i) => ({ signerKey: key(i), signature: signature(i) }))
throws(t, () => attachMultiSignedEnvelopeSignatures(prepareMultiSignedEnvelope(multiUnsigned(), { hash }), tooMany), /signatures/) })

test('fixed Node/Bare codec vectors match exact semantic encodings', (t) => { t.is(b4a.toString(encodeSignedEnvelope(signed()), 'hex'), SIGNED_ENVELOPE_VECTOR_HEX)
t.is(b4a.toString(encodeMultiSignedEnvelope(multiSigned()), 'hex'), MULTI_SIGNED_ENVELOPE_VECTOR_HEX)
t.is(assertFixedCodecVectors(), 2) })
