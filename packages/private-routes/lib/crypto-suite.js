import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import sodium from 'sodium-universal'

import { PrivateRouteError } from './errors.js'
import { DOMAIN, PROTOCOL_VERSION } from './protocol.js'

const ZERO_KEY = b4a.alloc(32)
const MAX_TRANSCRIPT = 4096
const MAX_ASSOCIATED_DATA = 512
const AEAD_TAG_BYTES = 16
const MAX_COUNTER = 0xffff_ffff_ffff_ffffn

export const MAX_AEAD_PLAINTEXT = 65_535

function copySlow(buffer) {
  const copy = b4a.allocUnsafeSlow(buffer.byteLength)
  copy.set(buffer)
  return copy
}

function validateSeed(seed) {
  if (seed !== undefined && (!b4a.isBuffer(seed) || seed.byteLength !== 32)) {
    throw PrivateRouteError.INVALID_KEY()
  }
}

function keyPair(seed) {
  validateSeed(seed)
  const pair = crypto.keyPair(seed)
  return {
    publicKey: copySlow(pair.publicKey),
    secretKey: copySlow(pair.secretKey)
  }
}

function encryptionKeyPair(seed) {
  validateSeed(seed)
  const pair = crypto.encryptionKeyPair(seed)
  return {
    publicKey: copySlow(pair.publicKey),
    secretKey: copySlow(pair.secretKey)
  }
}

function keyAgreement(localSecretKey, remotePublicKey) {
  if (
    !b4a.isBuffer(localSecretKey) ||
    localSecretKey.byteLength !== 32 ||
    !b4a.isBuffer(remotePublicKey) ||
    remotePublicKey.byteLength !== 32
  ) {
    throw PrivateRouteError.INVALID_KEY()
  }

  const shared = b4a.allocUnsafeSlow(32)

  try {
    const result = sodium.crypto_scalarmult(shared, localSecretKey, remotePublicKey)
    if (result === false || b4a.equals(shared, ZERO_KEY)) throw PrivateRouteError.INVALID_KEY()
  } catch {
    throw PrivateRouteError.INVALID_KEY()
  }

  return shared
}

function writeUint16BE(buffer, value, offset) {
  buffer[offset] = value >>> 8
  buffer[offset + 1] = value
}

function writeUint32BE(buffer, value, offset) {
  buffer[offset] = value >>> 24
  buffer[offset + 1] = value >>> 16
  buffer[offset + 2] = value >>> 8
  buffer[offset + 3] = value
}

function derive(sharedSecret, label, transcript) {
  const message = b4a.allocUnsafe(2 + label.byteLength + 4 + 4 + transcript.byteLength)
  let offset = 0

  writeUint16BE(message, label.byteLength, offset)
  offset += 2
  message.set(label, offset)
  offset += label.byteLength
  writeUint32BE(message, PROTOCOL_VERSION, offset)
  offset += 4
  writeUint32BE(message, transcript.byteLength, offset)
  offset += 4
  message.set(transcript, offset)

  const output = b4a.allocUnsafeSlow(32)
  sodium.crypto_generichash(output, message, sharedSecret)
  return output
}

function deriveKeys(sharedSecret, transcript) {
  if (
    !b4a.isBuffer(sharedSecret) ||
    sharedSecret.byteLength !== 32 ||
    !b4a.isBuffer(transcript) ||
    transcript.byteLength > MAX_TRANSCRIPT
  ) {
    throw PrivateRouteError.INVALID_KEY()
  }

  const forwardNonce = derive(sharedSecret, DOMAIN.KDF_FORWARD_NONCE, transcript)
  const reverseNonce = derive(sharedSecret, DOMAIN.KDF_REVERSE_NONCE, transcript)

  return {
    forwardKey: derive(sharedSecret, DOMAIN.KDF_FORWARD_KEY, transcript),
    reverseKey: derive(sharedSecret, DOMAIN.KDF_REVERSE_KEY, transcript),
    forwardNoncePrefix: copySlow(forwardNonce.subarray(0, 16)),
    reverseNoncePrefix: copySlow(reverseNonce.subarray(0, 16))
  }
}

function validateKeyAndNoncePrefix(key, noncePrefix) {
  if (
    !b4a.isBuffer(key) ||
    key.byteLength !== 32 ||
    !b4a.isBuffer(noncePrefix) ||
    noncePrefix.byteLength !== 16
  ) {
    throw PrivateRouteError.INVALID_KEY()
  }
}

function validateCellInputs(options) {
  if (options === null || typeof options !== 'object') throw PrivateRouteError.CELL_INVALID()

  const { key, noncePrefix, counter, associatedData } = options
  validateKeyAndNoncePrefix(key, noncePrefix)

  if (
    typeof counter !== 'bigint' ||
    counter < 0n ||
    counter > MAX_COUNTER ||
    !b4a.isBuffer(associatedData) ||
    associatedData.byteLength > MAX_ASSOCIATED_DATA
  ) {
    throw PrivateRouteError.CELL_INVALID()
  }
}

function nonceFor(noncePrefix, counter) {
  const nonce = b4a.allocUnsafe(24)
  nonce.set(noncePrefix, 0)

  for (let i = 23; i >= 16; i--) {
    nonce[i] = Number(counter & 0xffn)
    counter >>= 8n
  }

  return nonce
}

function seal(options) {
  validateCellInputs(options)
  const { key, noncePrefix, counter, associatedData, plaintext } = options

  if (!b4a.isBuffer(plaintext) || plaintext.byteLength > MAX_AEAD_PLAINTEXT) {
    throw PrivateRouteError.CELL_INVALID()
  }

  const ciphertext = b4a.allocUnsafeSlow(plaintext.byteLength + AEAD_TAG_BYTES)

  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      ciphertext,
      plaintext,
      associatedData,
      null,
      nonceFor(noncePrefix, counter),
      key
    )
  } catch {
    throw PrivateRouteError.CELL_INVALID()
  }

  return ciphertext
}

function open(options) {
  validateCellInputs(options)
  const { key, noncePrefix, counter, associatedData, ciphertext } = options

  if (
    !b4a.isBuffer(ciphertext) ||
    ciphertext.byteLength < AEAD_TAG_BYTES ||
    ciphertext.byteLength > MAX_AEAD_PLAINTEXT + AEAD_TAG_BYTES
  ) {
    throw PrivateRouteError.CELL_INVALID()
  }

  const plaintext = b4a.allocUnsafeSlow(ciphertext.byteLength - AEAD_TAG_BYTES)

  try {
    const result = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      plaintext,
      null,
      ciphertext,
      associatedData,
      nonceFor(noncePrefix, counter),
      key
    )
    if (result === false) return null
  } catch {
    return null
  }

  return plaintext
}

export const cryptoSuite = Object.freeze({
  keyPair,
  encryptionKeyPair,
  sign: crypto.sign,
  verify: crypto.verify,
  hash: crypto.hash,
  randomBytes: crypto.randomBytes,
  keyAgreement,
  deriveKeys,
  seal,
  open
})
