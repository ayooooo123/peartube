import test from 'brittle'
import b4a from 'b4a'

import { cryptoSuite } from '../index.js'
import { expectCode, seed } from './helpers.js'

test('encryption key pairs are deterministic for a 32-byte seed', (t) => {
  const first = cryptoSuite.encryptionKeyPair(seed(1))
  const second = cryptoSuite.encryptionKeyPair(seed(1))

  t.alike(first, second)
  t.is(first.publicKey.byteLength, 32)
  t.is(first.secretKey.byteLength, 32)
})

test('X25519 derives the same nonzero shared secret on both sides', (t) => {
  const alice = cryptoSuite.encryptionKeyPair(seed(1))
  const bob = cryptoSuite.encryptionKeyPair(seed(2))
  const left = cryptoSuite.keyAgreement(alice.secretKey, bob.publicKey)
  const right = cryptoSuite.keyAgreement(bob.secretKey, alice.publicKey)

  t.alike(left, right)
  t.is(b4a.equals(left, b4a.alloc(32)), false)
})

test('X25519 validates local and remote keys exactly', (t) => {
  const alice = cryptoSuite.encryptionKeyPair(seed(1))
  const invalid = [null, 'key', new Uint16Array(16), b4a.alloc(31), b4a.alloc(33)]

  for (const key of invalid) {
    expectCode(t, () => cryptoSuite.keyAgreement(key, alice.publicKey), 'INVALID_KEY')
    expectCode(t, () => cryptoSuite.keyAgreement(alice.secretKey, key), 'INVALID_KEY')
  }
})

test('X25519 rejects a low-order all-zero public key', (t) => {
  const alice = cryptoSuite.encryptionKeyPair(seed(1))

  expectCode(t, () => cryptoSuite.keyAgreement(alice.secretKey, b4a.alloc(32)), 'INVALID_KEY')
})

test('X25519 outputs do not alias caller inputs', (t) => {
  const alice = cryptoSuite.encryptionKeyPair(seed(1))
  const bob = cryptoSuite.encryptionKeyPair(seed(2))
  const localKey = b4a.from(alice.secretKey)
  const remoteKey = b4a.from(bob.publicKey)
  const shared = cryptoSuite.keyAgreement(localKey, remoteKey)
  const expected = b4a.from(shared)

  localKey.fill(0)
  remoteKey.fill(0)
  t.alike(shared, expected)
})

test('KDF separates direction, purpose, transcript, and nonce prefixes', (t) => {
  const a = cryptoSuite.deriveKeys(seed(3), b4a.from('transcript-a'))
  const b = cryptoSuite.deriveKeys(seed(3), b4a.from('transcript-b'))

  t.is(b4a.equals(a.forwardKey, a.reverseKey), false)
  t.is(b4a.equals(a.forwardNoncePrefix, a.reverseNoncePrefix), false)
  t.is(b4a.equals(a.forwardKey, b.forwardKey), false)
  t.is(b4a.equals(a.forwardNoncePrefix, a.forwardKey.subarray(0, 16)), false)
  t.is(a.forwardNoncePrefix.byteLength, 16)
  t.is(a.reverseNoncePrefix.byteLength, 16)
  t.is(
    b4a.toString(a.forwardKey, 'hex'),
    '3976601ef753f92f19e4d544d6a80526635bd8af0dd09efd18e224493d44fb04'
  )
  t.is(
    b4a.toString(a.reverseKey, 'hex'),
    'ba56480d6d8391e60bf57bd8846cf1a6ee7466b5ec3e7bd7325f2224227e19f2'
  )
  t.is(b4a.toString(a.forwardNoncePrefix, 'hex'), 'a4300237c95a17d6b7b5c1eb5d0bf837')
})

test('KDF validates its shared secret and transcript bounds', (t) => {
  const invalidSecrets = [null, 'secret', new Uint16Array(16), b4a.alloc(31), b4a.alloc(33)]

  for (const sharedSecret of invalidSecrets) {
    expectCode(t, () => cryptoSuite.deriveKeys(sharedSecret, b4a.alloc(0)), 'INVALID_KEY')
  }

  expectCode(t, () => cryptoSuite.deriveKeys(seed(3), b4a.alloc(4097)), 'INVALID_KEY')
})

test('KDF outputs do not alias caller inputs or later derivations', (t) => {
  const sharedSecret = seed(3)
  const transcript = b4a.from('transcript-a')
  const derived = cryptoSuite.deriveKeys(sharedSecret, transcript)
  const expectedReverse = b4a.from(derived.reverseKey)
  const expectedForwardPrefix = b4a.from(derived.forwardNoncePrefix)

  sharedSecret.fill(0)
  transcript.fill(0)
  derived.forwardKey.fill(0)

  t.alike(derived.reverseKey, expectedReverse)
  t.alike(derived.forwardNoncePrefix, expectedForwardPrefix)

  const repeated = cryptoSuite.deriveKeys(seed(3), b4a.from('transcript-a'))
  t.is(
    b4a.toString(repeated.forwardKey, 'hex'),
    '3976601ef753f92f19e4d544d6a80526635bd8af0dd09efd18e224493d44fb04'
  )
})

test('AEAD uses direction-separated keys and counter-derived nonces', (t) => {
  const keys = cryptoSuite.deriveKeys(seed(3), b4a.from('transcript-a'))
  const associatedData = b4a.from('header-v0')
  const plaintext = b4a.from('hello')
  const forward0 = cryptoSuite.seal({
    key: keys.forwardKey,
    noncePrefix: keys.forwardNoncePrefix,
    counter: 0n,
    associatedData,
    plaintext
  })
  const forward1 = cryptoSuite.seal({
    key: keys.forwardKey,
    noncePrefix: keys.forwardNoncePrefix,
    counter: 1n,
    associatedData,
    plaintext
  })
  const reverse0 = cryptoSuite.seal({
    key: keys.reverseKey,
    noncePrefix: keys.reverseNoncePrefix,
    counter: 0n,
    associatedData,
    plaintext
  })

  t.is(b4a.equals(forward0, forward1), false)
  t.is(b4a.equals(forward0, reverse0), false)
  t.is(b4a.equals(forward1, reverse0), false)
  t.is(
    b4a.toString(b4a.concat([keys.forwardNoncePrefix, b4a.alloc(8)]), 'hex'),
    'a4300237c95a17d6b7b5c1eb5d0bf8370000000000000000'
  )
  t.is(b4a.toString(forward0, 'hex'), 'c51fa92d7a49769b21ebcf07d72c7ae7bead2de70b')
  t.alike(
    cryptoSuite.open({
      key: keys.forwardKey,
      noncePrefix: keys.forwardNoncePrefix,
      counter: 0n,
      associatedData,
      ciphertext: forward0
    }),
    plaintext
  )
})

test('AEAD rejects malformed keys and cells with stable errors', (t) => {
  const key = seed(3)
  const noncePrefix = b4a.alloc(16, 4)
  const associatedData = b4a.from('header-v0')
  const plaintext = b4a.from('hello')
  const base = { key, noncePrefix, counter: 0n, associatedData, plaintext }

  for (const invalidKey of [null, 'key', new Uint16Array(16), b4a.alloc(31), b4a.alloc(33)]) {
    expectCode(t, () => cryptoSuite.seal({ ...base, key: invalidKey }), 'INVALID_KEY')
  }

  for (const invalidPrefix of [null, 'prefix', new Uint16Array(8), b4a.alloc(15), b4a.alloc(17)]) {
    expectCode(t, () => cryptoSuite.seal({ ...base, noncePrefix: invalidPrefix }), 'INVALID_KEY')
  }

  for (const counter of [null, 0, -1n, 0x1_0000_0000_0000_0000n]) {
    expectCode(t, () => cryptoSuite.seal({ ...base, counter }), 'CELL_INVALID')
  }

  for (const invalidData of [null, 'header', new Uint16Array(1), b4a.alloc(513)]) {
    expectCode(t, () => cryptoSuite.seal({ ...base, associatedData: invalidData }), 'CELL_INVALID')
  }

  for (const invalidPlaintext of [null, 'message', new Uint16Array(1), b4a.alloc(65_536)]) {
    expectCode(t, () => cryptoSuite.seal({ ...base, plaintext: invalidPlaintext }), 'CELL_INVALID')
  }

  const openBase = { ...base, ciphertext: b4a.alloc(16) }
  delete openBase.plaintext
  expectCode(t, () => cryptoSuite.open({ ...openBase, key: b4a.alloc(31) }), 'INVALID_KEY')
  expectCode(t, () => cryptoSuite.open({ ...openBase, noncePrefix: b4a.alloc(15) }), 'INVALID_KEY')
  expectCode(t, () => cryptoSuite.open({ ...openBase, counter: -1n }), 'CELL_INVALID')
  expectCode(
    t,
    () => cryptoSuite.open({ ...openBase, associatedData: b4a.alloc(513) }),
    'CELL_INVALID'
  )
  expectCode(t, () => cryptoSuite.open({ ...openBase, ciphertext: b4a.alloc(15) }), 'CELL_INVALID')
  expectCode(t, () => cryptoSuite.open({ ...openBase, ciphertext: 'ciphertext' }), 'CELL_INVALID')
  expectCode(t, () => cryptoSuite.seal(null), 'CELL_INVALID')
  expectCode(t, () => cryptoSuite.open(null), 'CELL_INVALID')
})

test('AEAD accepts exact primitive bounds', (t) => {
  const key = seed(3)
  const noncePrefix = b4a.alloc(16, 4)
  const associatedData = b4a.alloc(512, 5)
  const plaintext = b4a.alloc(65_535, 6)
  const ciphertext = cryptoSuite.seal({
    key,
    noncePrefix,
    counter: 0xffff_ffff_ffff_ffffn,
    associatedData,
    plaintext
  })

  t.is(ciphertext.byteLength, plaintext.byteLength + 16)
  t.alike(
    cryptoSuite.open({
      key,
      noncePrefix,
      counter: 0xffff_ffff_ffff_ffffn,
      associatedData,
      ciphertext
    }),
    plaintext
  )
})

test('AEAD authentication rejects every associated-data and ciphertext mutation', (t) => {
  const keys = cryptoSuite.deriveKeys(seed(3), b4a.from('transcript-a'))
  const associatedData = b4a.from('header-v0')
  const plaintext = b4a.from('hello')
  const args = {
    key: keys.forwardKey,
    noncePrefix: keys.forwardNoncePrefix,
    counter: 0n,
    associatedData
  }
  const ciphertext = cryptoSuite.seal({ ...args, plaintext })

  for (let i = 0; i < associatedData.byteLength; i++) {
    const mutated = b4a.from(associatedData)
    mutated[i] ^= 1
    t.is(cryptoSuite.open({ ...args, associatedData: mutated, ciphertext }), null)
  }

  for (let i = 0; i < ciphertext.byteLength; i++) {
    const mutated = b4a.from(ciphertext)
    mutated[i] ^= 1
    t.is(cryptoSuite.open({ ...args, ciphertext: mutated }), null)
  }
})

test('AEAD never mutates or aliases caller buffers', (t) => {
  const key = seed(3)
  const noncePrefix = b4a.alloc(16, 4)
  const associatedData = b4a.from('header-v0')
  const plaintext = b4a.from('hello')
  const snapshots = [key, noncePrefix, associatedData, plaintext].map((value) => b4a.from(value))
  const args = { key, noncePrefix, counter: 0n, associatedData }
  const ciphertext = cryptoSuite.seal({ ...args, plaintext })

  t.alike(key, snapshots[0])
  t.alike(noncePrefix, snapshots[1])
  t.alike(associatedData, snapshots[2])
  t.alike(plaintext, snapshots[3])

  const ciphertextSnapshot = b4a.from(ciphertext)
  const opened = cryptoSuite.open({ ...args, ciphertext })
  opened.fill(0)
  t.alike(ciphertext, ciphertextSnapshot)
  t.alike(cryptoSuite.open({ ...args, ciphertext }), plaintext)

  ciphertext.fill(0)
  t.alike(cryptoSuite.seal({ ...args, plaintext }), ciphertextSnapshot)
})

test('crypto suite exposes an exact immutable adapter surface', (t) => {
  t.alike(Object.keys(cryptoSuite), [
    'keyPair',
    'encryptionKeyPair',
    'sign',
    'verify',
    'hash',
    'randomBytes',
    'keyAgreement',
    'deriveKeys',
    'seal',
    'open'
  ])
  t.ok(Object.isFrozen(cryptoSuite))

  let error = null
  try {
    cryptoSuite.seal = null
  } catch (err) {
    error = err
  }

  t.ok(error instanceof TypeError)
  t.is(typeof cryptoSuite.seal, 'function')
})
