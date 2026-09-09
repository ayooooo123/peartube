import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import sodium from 'sodium-universal'

import { cryptoSuite } from '../index.js'
import { expectCode, seed } from './helpers.js'

test('encryption key pairs are deterministic for a 32-byte seed', (t) => {
  const first = cryptoSuite.encryptionKeyPair(seed(1))
  const second = cryptoSuite.encryptionKeyPair(seed(1))

  t.alike(first, second)
  t.is(first.publicKey.byteLength, 32)
  t.is(first.secretKey.byteLength, 32)
})

test('key pair wrappers copy usable secrets and clear owned source secrets', (t) => {
  const originalKeyPair = crypto.keyPair
  const originalEncryptionKeyPair = crypto.encryptionKeyPair
  let signingSource = null
  let encryptionSource = null

  crypto.keyPair = (keySeed) => {
    const pair = originalKeyPair(keySeed)
    signingSource = pair.secretKey
    return pair
  }
  crypto.encryptionKeyPair = (keySeed) => {
    const pair = originalEncryptionKeyPair(keySeed)
    encryptionSource = pair.secretKey
    return pair
  }

  try {
    const signing = cryptoSuite.keyPair(seed(9))
    const encryption = cryptoSuite.encryptionKeyPair(seed(10))
    const peer = originalEncryptionKeyPair(seed(11))
    const message = b4a.from('secret-copy-check')
    const signature = cryptoSuite.sign(message, signing.secretKey)

    t.ok(cryptoSuite.verify(message, signature, signing.publicKey))
    t.is(b4a.equals(signing.secretKey, b4a.alloc(signing.secretKey.byteLength)), false)
    t.is(b4a.equals(encryption.secretKey, b4a.alloc(encryption.secretKey.byteLength)), false)
    t.alike(signingSource, b4a.alloc(signingSource.byteLength))
    t.alike(encryptionSource, b4a.alloc(encryptionSource.byteLength))
    t.is(signing.secretKey.buffer === signingSource.buffer, false)
    t.is(encryption.secretKey.buffer === encryptionSource.buffer, false)
    t.is(cryptoSuite.keyAgreement(encryption.secretKey, peer.publicKey).byteLength, 32)
  } finally {
    crypto.keyPair = originalKeyPair
    crypto.encryptionKeyPair = originalEncryptionKeyPair
  }
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

test('X25519 matches the RFC 7748 scalar multiplication vector', (t) => {
  const scalar = b4a.from('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4', 'hex')
  const publicKey = b4a.from(
    'e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c',
    'hex'
  )

  t.is(
    b4a.toString(cryptoSuite.keyAgreement(scalar, publicKey), 'hex'),
    'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552'
  )
})

test('X25519 clears internal shared-secret scratch on success and failure', (t) => {
  const original = sodium.crypto_scalarmult
  const alice = cryptoSuite.encryptionKeyPair(seed(1))
  const bob = cryptoSuite.encryptionKeyPair(seed(2))
  const scratches = []

  sodium.crypto_scalarmult = (output, localSecretKey, remotePublicKey) => {
    scratches.push(output)
    return original(output, localSecretKey, remotePublicKey)
  }

  try {
    const shared = cryptoSuite.keyAgreement(alice.secretKey, bob.publicKey)
    expectCode(t, () => cryptoSuite.keyAgreement(alice.secretKey, b4a.alloc(32)), 'INVALID_KEY')

    t.is(b4a.equals(shared, b4a.alloc(32)), false)
    t.is(shared.buffer === scratches[0].buffer, false)
    t.alike(scratches[0], b4a.alloc(32))
    t.alike(scratches[1], b4a.alloc(32))
  } finally {
    sodium.crypto_scalarmult = original
  }
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

test('KDF clears discarded full nonce derivations after copying prefixes', (t) => {
  const original = sodium.crypto_generichash
  const outputs = []

  sodium.crypto_generichash = (output, input, key) => {
    outputs.push(output)
    return original(output, input, key)
  }

  try {
    const derived = cryptoSuite.deriveKeys(seed(3), b4a.from('transcript-a'))

    t.is(outputs.length, 4)
    t.alike(outputs[0], b4a.alloc(32))
    t.alike(outputs[1], b4a.alloc(32))
    t.is(b4a.equals(derived.forwardNoncePrefix, b4a.alloc(16)), false)
    t.is(b4a.equals(derived.reverseNoncePrefix, b4a.alloc(16)), false)
  } finally {
    sodium.crypto_generichash = original
  }
})

test('KDF clears every internally owned output when derivation fails', (t) => {
  const original = sodium.crypto_generichash
  const outputs = []
  const sentinel = new Error('derivation failure')

  sodium.crypto_generichash = (output, input, key) => {
    outputs.push(output)
    original(output, input, key)
    if (outputs.length === 4) throw sentinel
  }

  try {
    let error = null
    try {
      cryptoSuite.deriveKeys(seed(3), b4a.from('transcript-a'))
    } catch (err) {
      error = err
    }

    t.is(error, sentinel)
    t.is(outputs.length, 4)
    for (const output of outputs) t.alike(output, b4a.alloc(32))
  } finally {
    sodium.crypto_generichash = original
  }
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

test('AEAD encodes a nonzero counter as uint64 big-endian', (t) => {
  const original = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt
  const nonces = []
  const nonceScratches = []

  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt = (
    ciphertext,
    plaintext,
    associatedData,
    secretNonce,
    nonce,
    key
  ) => {
    nonces.push(b4a.from(nonce))
    nonceScratches.push(nonce)
    return original(ciphertext, plaintext, associatedData, secretNonce, nonce, key)
  }

  try {
    const ciphertext = cryptoSuite.seal({
      key: b4a.from('3976601ef753f92f19e4d544d6a80526635bd8af0dd09efd18e224493d44fb04', 'hex'),
      noncePrefix: b4a.from('a4300237c95a17d6b7b5c1eb5d0bf837', 'hex'),
      counter: 0x0102_0304_0506_0708n,
      associatedData: b4a.from('header-v0'),
      plaintext: b4a.from('hello')
    })

    t.is(b4a.toString(nonces[0], 'hex'), 'a4300237c95a17d6b7b5c1eb5d0bf8370102030405060708')
    t.is(b4a.toString(ciphertext, 'hex'), '3fdcffe5f784d46ad82c96c58488c11613b5f37c49')
    t.alike(nonceScratches[0], b4a.alloc(24))
  } finally {
    sodium.crypto_aead_xchacha20poly1305_ietf_encrypt = original
  }
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

test('AEAD rejects wrong key, nonce prefix, and counter as authentication failures', (t) => {
  const keys = cryptoSuite.deriveKeys(seed(3), b4a.from('transcript-a'))
  const args = {
    key: keys.forwardKey,
    noncePrefix: keys.forwardNoncePrefix,
    counter: 9n,
    associatedData: b4a.from('header-v0')
  }
  const ciphertext = cryptoSuite.seal({ ...args, plaintext: b4a.from('hello') })

  t.is(cryptoSuite.open({ ...args, key: seed(4), ciphertext }), null)
  t.is(cryptoSuite.open({ ...args, noncePrefix: b4a.alloc(16, 5), ciphertext }), null)
  t.is(cryptoSuite.open({ ...args, counter: 10n, ciphertext }), null)
})

test('AEAD open clears plaintext scratch and preserves programming errors', (t) => {
  const original = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt
  const key = seed(3)
  const noncePrefix = b4a.alloc(16, 4)
  const associatedData = b4a.from('header-v0')
  const args = { key, noncePrefix, counter: 0n, associatedData }
  const ciphertext = cryptoSuite.seal({ ...args, plaintext: b4a.from('hello') })
  const scratches = []

  sodium.crypto_aead_xchacha20poly1305_ietf_decrypt = (
    plaintext,
    secretNonce,
    encrypted,
    data,
    nonce,
    decryptKey
  ) => {
    scratches.push(plaintext)
    return original(plaintext, secretNonce, encrypted, data, nonce, decryptKey)
  }

  try {
    const opened = cryptoSuite.open({ ...args, ciphertext })
    t.alike(opened, b4a.from('hello'))
    t.is(opened.buffer === scratches[0].buffer, false)
    t.alike(scratches[0], b4a.alloc(5))

    t.is(cryptoSuite.open({ ...args, key: seed(4), ciphertext }), null)
    t.alike(scratches[1], b4a.alloc(5))
  } finally {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt = original
  }

  const sentinel = new TypeError('programming failure')
  sodium.crypto_aead_xchacha20poly1305_ietf_decrypt = () => {
    throw sentinel
  }

  try {
    let error = null
    try {
      cryptoSuite.open({ ...args, ciphertext })
    } catch (err) {
      error = err
    }
    t.is(error, sentinel)
  } finally {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt = original
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

test('sign, verify, hash, and random byte adapters preserve their contracts', (t) => {
  const pair = cryptoSuite.keyPair(seed(12))
  const message = b4a.from('adapter-contract')
  const messageSnapshot = b4a.from(message)
  const signature = cryptoSuite.sign(message, pair.secretKey)
  const digest = cryptoSuite.hash(message)
  const repeatedDigest = cryptoSuite.hash(message)
  const random = cryptoSuite.randomBytes(32)
  const secondRandom = cryptoSuite.randomBytes(32)

  t.is(signature.byteLength, 64)
  t.ok(cryptoSuite.verify(message, signature, pair.publicKey))
  signature[0] ^= 1
  t.is(cryptoSuite.verify(message, signature, pair.publicKey), false)
  t.is(digest.byteLength, 32)
  t.alike(digest, repeatedDigest)
  t.alike(message, messageSnapshot)
  t.is(random.byteLength, 32)
  const secondSnapshot = b4a.from(secondRandom)
  random.fill(0)
  t.alike(secondRandom, secondSnapshot)
})
