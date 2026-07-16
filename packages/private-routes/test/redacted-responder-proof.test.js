import b4a from 'b4a'
import test from 'brittle'

import { cryptoSuite } from '../lib/crypto-suite.js'
import {
  MAX_VERIFIED_RESPONDER_PROOF_STATES,
  REDACTED_RESPONDER_PROOF_SIZE,
  consumeVerifiedRedactedResponderProof,
  createRedactedResponderProofAuthority,
  decodeRedactedResponderProof,
  revokeVerifiedRedactedResponderProof,
  signRedactedResponderProof,
  verifyExpectedRedactedResponderProof,
  verifyRedactedResponderProof
} from '../lib/redacted-responder-proof.js'
import {
  BRANCH_CLASS,
  M3_MESSAGE_ID,
  M3_PROTOCOL_VERSION,
  decodeM3Object
} from '../lib/protocol.js'

const NOW = 1_000n
const SIGNATURE_DOMAIN = b4a.from('hyperdht-private-routes/m3/redacted-responder-proof/v1')

function seed(byte, size = 32) {
  return b4a.alloc(size, byte)
}

function writeUint16(target, value, offset) {
  target[offset] = value >>> 8
  target[offset + 1] = value
}

function writeUint32(target, value, offset) {
  target[offset] = value >>> 24
  target[offset + 1] = value >>> 16
  target[offset + 2] = value >>> 8
  target[offset + 3] = value
}

function writeUint64(target, value, offset) {
  for (let index = 7; index >= 0; index--) {
    target[offset + index] = Number(value & 0xffn)
    value >>= 8n
  }
}

function expectedBody(value) {
  const body = b4a.alloc(306)
  body.set(value.responderAdvertisementDigest, 0)
  body.set(value.initiatorIdentity, 32)
  body.set(value.responderIdentity, 64)
  body[96] = value.branchClass
  body.set(value.branchId, 97)
  body.set(value.circuitId, 113)
  writeUint64(body, value.generation, 129)
  body[137] = value.extensionIndex
  body.set(value.clientTailEphemeralPublicKey, 138)
  body.set(value.clientNonce, 170)
  body.set(value.advertisedRouteEncryptionPublicKey, 202)
  body.set(value.admittedLimitsDigest, 234)
  writeUint64(body, value.expiresAtMs, 266)
  body.set(value.responderProofNonce, 274)
  return body
}

function expectedSignatureInput(body) {
  const input = b4a.alloc(2 + SIGNATURE_DOMAIN.byteLength + 8 + body.byteLength)
  writeUint16(input, SIGNATURE_DOMAIN.byteLength, 0)
  input.set(SIGNATURE_DOMAIN, 2)
  writeUint32(input, M3_PROTOCOL_VERSION, 2 + SIGNATURE_DOMAIN.byteLength)
  writeUint16(input, M3_MESSAGE_ID.REDACTED_RESPONDER_PROOF_V1, 6 + SIGNATURE_DOMAIN.byteLength)
  writeUint16(input, body.byteLength, 8 + SIGNATURE_DOMAIN.byteLength)
  input.set(body, 10 + SIGNATURE_DOMAIN.byteLength)
  return input
}

function fixture() {
  const identity = cryptoSuite.keyPair(seed(0x21))
  const value = {
    responderAdvertisementDigest: seed(0x33),
    initiatorIdentity: seed(0x34),
    responderIdentity: identity.publicKey,
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: seed(0x31, 16),
    circuitId: seed(0x32, 16),
    generation: 7n,
    extensionIndex: 2,
    clientTailEphemeralPublicKey: seed(0x35),
    clientNonce: seed(0x36),
    advertisedRouteEncryptionPublicKey: seed(0x37),
    admittedLimitsDigest: seed(0x38),
    expiresAtMs: 5_000n,
    responderProofNonce: seed(0x39)
  }
  return { identity, value }
}

function expectCode(t, operation, code, message) {
  let error = null
  try {
    operation()
  } catch (err) {
    error = err
  }
  t.is(error && error.code, code, message)
}

test('successor proof signs one exact 306-byte transcript and moves once', (t) => {
  const { identity, value } = fixture()
  const authority = createRedactedResponderProofAuthority({ now: () => NOW })
  const encoded = signRedactedResponderProof(value, identity.secretKey)
  const decoded = decodeRedactedResponderProof(encoded)
  const object = decodeM3Object(encoded)
  const body = expectedBody(value)
  const signatureInput = expectedSignatureInput(body)

  t.is(encoded.byteLength, REDACTED_RESPONDER_PROOF_SIZE)
  t.is(object.messageId, M3_MESSAGE_ID.REDACTED_RESPONDER_PROOF_V1)
  t.alike(object.body, body, 'field offsets match the independent registry transcript')
  t.ok(
    cryptoSuite.verify(signatureInput, object.authSuffix, identity.publicKey),
    'signature uses the independently framed registry preimage'
  )
  t.is(
    cryptoSuite.verify(b4a.concat([SIGNATURE_DOMAIN, body]), object.authSuffix, identity.publicKey),
    false,
    'the legacy unframed preimage is not accepted'
  )
  t.alike(decoded, value)
  const verified = verifyRedactedResponderProof(authority.verifier, encoded)
  t.ok(Object.isFrozen(verified))
  t.alike(Object.keys(verified), [])
  const other = createRedactedResponderProofAuthority({ now: () => NOW })
  expectCode(
    t,
    () => consumeVerifiedRedactedResponderProof(other.consumer, verified, value),
    'ERR_AUTHENTICATION',
    'verified authority is owner-bound'
  )
  const consumed = consumeVerifiedRedactedResponderProof(authority.consumer, verified, value)
  t.alike(consumed, encoded)
  expectCode(
    t,
    () => consumeVerifiedRedactedResponderProof(authority.consumer, verified, value),
    'ERR_REPLAY',
    'verified proof capabilities are one-use'
  )
  t.is(revokeVerifiedRedactedResponderProof(authority.consumer, verified), false)
  other.destroy()
  authority.destroy()
})

test('proof consumption binds every successor and client commitment', (t) => {
  const { identity, value } = fixture()
  const encoded = signRedactedResponderProof(value, identity.secretKey)
  const substitutions = {
    responderAdvertisementDigest: seed(0x44),
    initiatorIdentity: seed(0x45),
    responderIdentity: cryptoSuite.keyPair(seed(0x43)).publicKey,
    branchClass: BRANCH_CLASS.ANNOUNCE,
    branchId: seed(0x41, 16),
    circuitId: seed(0x42, 16),
    generation: 8n,
    extensionIndex: 1,
    clientTailEphemeralPublicKey: seed(0x46),
    clientNonce: seed(0x47),
    advertisedRouteEncryptionPublicKey: seed(0x48),
    admittedLimitsDigest: seed(0x49),
    expiresAtMs: 4_999n,
    responderProofNonce: seed(0x4a)
  }

  for (const [field, substitution] of Object.entries(substitutions)) {
    const authority = createRedactedResponderProofAuthority({ now: () => NOW })
    const verified = verifyRedactedResponderProof(authority.verifier, encoded)
    expectCode(
      t,
      () =>
        consumeVerifiedRedactedResponderProof(authority.consumer, verified, {
          ...value,
          [field]: substitution
        }),
      'ERR_AUTHENTICATION',
      field
    )
    t.ok(revokeVerifiedRedactedResponderProof(authority.consumer, verified), field)
    authority.destroy()
  }
})

test('proof verification can bind the exact successor projection before publication', (t) => {
  const { identity, value } = fixture()
  const authority = createRedactedResponderProofAuthority({ now: () => NOW })
  const encoded = signRedactedResponderProof(value, identity.secretKey)

  expectCode(
    t,
    () =>
      verifyExpectedRedactedResponderProof(authority.verifier, encoded, {
        ...value,
        clientNonce: seed(0x7a)
      }),
    'ERR_AUTHENTICATION',
    'a mismatch publishes no proof authority'
  )
  t.alike(authority.diagnostics(), { state: 'ACTIVE', live: 0, states: 0 })
  const verified = verifyExpectedRedactedResponderProof(authority.verifier, encoded, value)
  t.ok(Object.isFrozen(verified))
  t.alike(Object.keys(verified), [])
  t.alike(consumeVerifiedRedactedResponderProof(authority.consumer, verified, value), encoded)
  authority.destroy()
})

test('proof verification rejects wrong signatures, expiry, and malformed commitments', (t) => {
  const { identity, value } = fixture()
  const authority = createRedactedResponderProofAuthority({ now: () => NOW })
  const encoded = signRedactedResponderProof(value, identity.secretKey)
  const tampered = b4a.from(encoded)
  tampered[tampered.byteLength - 1] ^= 1
  const bodyTampered = b4a.from(encoded)
  bodyTampered[10] ^= 1

  expectCode(
    t,
    () => verifyRedactedResponderProof(authority.verifier, tampered),
    'ERR_AUTHENTICATION',
    'signature tampering'
  )
  expectCode(
    t,
    () => verifyRedactedResponderProof(authority.verifier, bodyTampered),
    'ERR_AUTHENTICATION',
    'body tampering'
  )
  expectCode(
    t,
    () => {
      const expired = createRedactedResponderProofAuthority({ now: () => value.expiresAtMs })
      try {
        verifyRedactedResponderProof(expired.verifier, encoded)
      } finally {
        expired.destroy()
      }
    },
    'ERR_AUTHENTICATION',
    'expiry is exclusive'
  )
  expectCode(
    t,
    () =>
      signRedactedResponderProof(
        { ...value, responderProofNonce: b4a.alloc(32) },
        identity.secretKey
      ),
    'INVALID_ROUTE',
    'zero commitments are forbidden'
  )
  expectCode(
    t,
    () => decodeRedactedResponderProof(encoded.subarray(0, encoded.byteLength - 1)),
    'INVALID_ROUTE',
    'the encoding size is exact'
  )
  authority.destroy()
})

test('proof nonce reuse rejects conflicting signed proof bytes', (t) => {
  const { identity, value } = fixture()
  const authority = createRedactedResponderProofAuthority({ now: () => NOW })
  const first = signRedactedResponderProof(value, identity.secretKey)
  const conflict = signRedactedResponderProof(
    { ...value, clientNonce: seed(0x7a) },
    identity.secretKey
  )
  const verified = verifyRedactedResponderProof(authority.verifier, first)

  expectCode(
    t,
    () => verifyRedactedResponderProof(authority.verifier, conflict),
    'ERR_REPLAY',
    'same responder, branch, generation, index, and proof nonce conflicts'
  )
  t.alike(authority.diagnostics(), { state: 'ACTIVE', live: 1, states: 1 })
  t.ok(revokeVerifiedRedactedResponderProof(authority.consumer, verified))
  authority.destroy()
})

test('trusted consume time, proof replay, and ninety-six tombstones are exact', (t) => {
  const { identity, value } = fixture()
  let current = NOW
  const delayed = createRedactedResponderProofAuthority({ now: () => current })
  const encoded = signRedactedResponderProof(value, identity.secretKey)
  const verified = verifyRedactedResponderProof(delayed.verifier, encoded)
  current = value.expiresAtMs
  expectCode(
    t,
    () => consumeVerifiedRedactedResponderProof(delayed.consumer, verified, value),
    'ERR_AUTHENTICATION',
    'delayed consumption rechecks trusted time'
  )
  t.alike(delayed.diagnostics(), { state: 'ACTIVE', live: 0, states: 0 })
  delayed.destroy()

  const revoked = createRedactedResponderProofAuthority({ now: () => NOW })
  const revokedCapability = verifyRedactedResponderProof(revoked.verifier, encoded)
  t.ok(revokeVerifiedRedactedResponderProof(revoked.consumer, revokedCapability))
  expectCode(
    t,
    () => consumeVerifiedRedactedResponderProof(revoked.consumer, revokedCapability, value),
    'ERR_REPLAY',
    'revoked proofs retain tombstones'
  )
  revoked.destroy()

  const liveCapped = createRedactedResponderProofAuthority({ now: () => NOW })
  for (let index = 0; index < 16; index++) {
    const expected = { ...value, responderProofNonce: seed(index + 1) }
    verifyRedactedResponderProof(
      liveCapped.verifier,
      signRedactedResponderProof(expected, identity.secretKey)
    )
  }
  const seventeenth = signRedactedResponderProof(
    { ...value, responderProofNonce: seed(0xe0) },
    identity.secretKey
  )
  expectCode(
    t,
    () => verifyRedactedResponderProof(liveCapped.verifier, seventeenth),
    'ERR_BUSY',
    'sixteen live verified proofs is a hard cap'
  )
  liveCapped.destroy()

  const capped = createRedactedResponderProofAuthority({ now: () => NOW })
  let first = null
  let firstCapability = null
  for (let index = 0; index < MAX_VERIFIED_RESPONDER_PROOF_STATES; index++) {
    const expected = { ...value, responderProofNonce: seed(index + 1) }
    const proof = signRedactedResponderProof(expected, identity.secretKey)
    const capability = verifyRedactedResponderProof(capped.verifier, proof)
    consumeVerifiedRedactedResponderProof(capped.consumer, capability, expected)
    if (index === 0) {
      first = proof
      firstCapability = capability
    }
  }
  t.alike(capped.diagnostics(), {
    state: 'ACTIVE',
    live: 0,
    states: MAX_VERIFIED_RESPONDER_PROOF_STATES
  })
  expectCode(
    t,
    () => verifyRedactedResponderProof(capped.verifier, first),
    'ERR_REPLAY',
    'the complete proof digest is replay keyed'
  )
  t.is(revokeVerifiedRedactedResponderProof(capped.consumer, firstCapability), false)
  const overflow = signRedactedResponderProof(
    { ...value, responderProofNonce: seed(0xf0) },
    identity.secretKey
  )
  expectCode(
    t,
    () => verifyRedactedResponderProof(capped.verifier, overflow),
    'ERR_BUSY',
    'consumed tombstones retain the global state cap'
  )
  capped.destroy()
})

test('reordered projections work and wrong-sized allocations clear transactionally', (t) => {
  const { identity, value } = fixture()
  const authority = createRedactedResponderProofAuthority({ now: () => NOW })
  const encoded = signRedactedResponderProof(value, identity.secretKey)
  const verified = verifyRedactedResponderProof(authority.verifier, encoded)
  const reordered = Object.fromEntries(Object.entries(value).reverse())
  t.alike(
    consumeVerifiedRedactedResponderProof(authority.consumer, verified, reordered),
    encoded,
    'exact fields are order independent'
  )
  authority.destroy()

  const allocate = b4a.allocUnsafeSlow
  let wrongBody = null
  b4a.allocUnsafeSlow = (size) => {
    if (size === 306 && wrongBody === null) {
      wrongBody = allocate(305).fill(0xaa)
      return wrongBody
    }
    return allocate(size)
  }
  try {
    expectCode(
      t,
      () => signRedactedResponderProof(value, identity.secretKey),
      'INVALID_ROUTE',
      'wrong-sized body allocation'
    )
  } finally {
    b4a.allocUnsafeSlow = allocate
  }
  t.ok(wrongBody && wrongBody.every((byte) => byte === 0))

  const allocateWire = b4a.allocUnsafe
  let wrongWire = null
  b4a.allocUnsafe = (size) => {
    if (size === REDACTED_RESPONDER_PROOF_SIZE && wrongWire === null) {
      wrongWire = allocateWire(REDACTED_RESPONDER_PROOF_SIZE + 1).fill(0xcc)
      return wrongWire
    }
    return allocateWire(size)
  }
  try {
    expectCode(
      t,
      () => signRedactedResponderProof(value, identity.secretKey),
      'INVALID_ROUTE',
      'wrong-sized final wire allocation'
    )
  } finally {
    b4a.allocUnsafe = allocateWire
  }
  t.ok(wrongWire && wrongWire.every((byte) => byte === 0))

  const copyAuthority = createRedactedResponderProofAuthority({ now: () => NOW })
  let wrongCopy = null
  b4a.allocUnsafeSlow = (size) => {
    if (size === REDACTED_RESPONDER_PROOF_SIZE && wrongCopy === null) {
      wrongCopy = allocate(REDACTED_RESPONDER_PROOF_SIZE - 1).fill(0xbb)
      return wrongCopy
    }
    return allocate(size)
  }
  try {
    expectCode(
      t,
      () => verifyRedactedResponderProof(copyAuthority.verifier, encoded),
      'INVALID_ROUTE',
      'wrong-sized owned proof allocation'
    )
  } finally {
    b4a.allocUnsafeSlow = allocate
  }
  t.ok(wrongCopy && wrongCopy.every((byte) => byte === 0))
  t.alike(copyAuthority.diagnostics(), { state: 'ACTIVE', live: 0, states: 0 })
  copyAuthority.destroy()
})

test('expected-field reentry poisons and destroys the proof authority', (t) => {
  const { identity, value } = fixture()
  const authority = createRedactedResponderProofAuthority({ now: () => NOW })
  const encoded = signRedactedResponderProof(value, identity.secretKey)
  const verified = verifyRedactedResponderProof(authority.verifier, encoded)
  let reentered = false
  const expected = new Proxy(value, {
    get(target, name, receiver) {
      if (!reentered && name === 'branchClass') {
        reentered = true
        expectCode(
          t,
          () => consumeVerifiedRedactedResponderProof(authority.consumer, verified, value),
          'ERR_BUSY',
          'same-authority reentry is rejected'
        )
      }
      return Reflect.get(target, name, receiver)
    }
  })

  expectCode(
    t,
    () => consumeVerifiedRedactedResponderProof(authority.consumer, verified, expected),
    'INVALID_ROUTE',
    'caught reentry still terminalizes the outer operation'
  )
  expectCode(t, () => authority.diagnostics(), 'ERR_DESTROYED')
})

test('trusted-clock reentry cannot race the provisional proof reservation', (t) => {
  const { identity, value } = fixture()
  const encoded = signRedactedResponderProof(value, identity.secretKey)
  let authority = null
  let reenter = false
  const now = () => {
    if (reenter) {
      reenter = false
      expectCode(
        t,
        () => verifyRedactedResponderProof(authority.verifier, encoded),
        'ERR_BUSY',
        'same-authority clock reentry is rejected'
      )
    }
    return NOW
  }
  authority = createRedactedResponderProofAuthority({ now })
  reenter = true

  expectCode(
    t,
    () => verifyRedactedResponderProof(authority.verifier, encoded),
    'INVALID_ROUTE',
    'caught clock reentry terminalizes the reserved outer operation'
  )
  expectCode(t, () => authority.diagnostics(), 'ERR_DESTROYED')
})

test('uncaught clock and getter reentry permanently destroy their authorities', (t) => {
  const { identity, value } = fixture()
  const encoded = signRedactedResponderProof(value, identity.secretKey)
  let authority = null
  let reenterClock = false
  authority = createRedactedResponderProofAuthority({
    now() {
      if (reenterClock) {
        reenterClock = false
        verifyRedactedResponderProof(authority.verifier, encoded)
      }
      return NOW
    }
  })
  reenterClock = true
  expectCode(
    t,
    () => verifyRedactedResponderProof(authority.verifier, encoded),
    'INVALID_ROUTE',
    'uncaught clock reentry fails the outer reservation'
  )
  expectCode(t, () => authority.diagnostics(), 'ERR_DESTROYED')

  const getterAuthority = createRedactedResponderProofAuthority({ now: () => NOW })
  const verified = verifyRedactedResponderProof(getterAuthority.verifier, encoded)
  let reenterGetter = true
  const expected = new Proxy(value, {
    get(target, name, receiver) {
      if (reenterGetter && name === 'branchClass') {
        reenterGetter = false
        consumeVerifiedRedactedResponderProof(getterAuthority.consumer, verified, value)
      }
      return Reflect.get(target, name, receiver)
    }
  })
  expectCode(
    t,
    () => consumeVerifiedRedactedResponderProof(getterAuthority.consumer, verified, expected),
    'INVALID_ROUTE',
    'uncaught getter reentry fails the outer consumption'
  )
  expectCode(t, () => getterAuthority.diagnostics(), 'ERR_DESTROYED')
})
