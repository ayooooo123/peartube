import sodium from 'sodium-universal'
import b4a from 'b4a'

/**
 * At-rest encryption key material for the personal store.
 *
 * A single 32-byte `secret` (held in the device's native keychain and shared
 * with paired devices) deterministically derives:
 *   - dek:     the Autobase data-encryption key (encrypts every core on disk).
 *              Deterministic from the secret so all of the user's devices
 *              converge on the same key.
 *   - wrapKey: a wrapping key used for Autobase "blind encryption" — the dek is
 *              stored on disk wrapped under it, never in plaintext. Without the
 *              secret the wrapped dek can't be unwrapped, so the on-disk data is
 *              unreadable even though Autobase persists its key material.
 */

const CTX = b4a.from('ptpersnl') // 8 bytes (crypto_kdf_CONTEXTBYTES)
const DEK_SUBKEY_ID = 1
const WRAP_SUBKEY_ID = 2

function deriveSubkey(secret, subkeyId) {
  const out = b4a.allocUnsafe(sodium.crypto_kdf_KEYBYTES) // 32
  sodium.crypto_kdf_derive_from_key(out, subkeyId, CTX, secret)
  return out
}

export function toSecret(value) {
  if (!value) return null
  const buf = b4a.isBuffer(value) ? value : b4a.from(value, 'hex')
  if (buf.length !== sodium.crypto_kdf_KEYBYTES) {
    throw new Error(`Personal store secret must be ${sodium.crypto_kdf_KEYBYTES} bytes`)
  }
  return buf
}

export function generateSecret() {
  const secret = b4a.allocUnsafe(sodium.crypto_kdf_KEYBYTES)
  sodium.randombytes_buf(secret)
  return secret
}

export function deriveKeys(secret) {
  const s = toSecret(secret)
  return {
    dek: deriveSubkey(s, DEK_SUBKEY_ID),
    wrapKey: deriveSubkey(s, WRAP_SUBKEY_ID)
  }
}

/**
 * Build the Autobase `blindEncryption` callback pair from a wrapping key.
 * encryptionEncoding calls `encrypt(data)` and stores `{ type, value }`;
 * on read it calls `decrypt({ type, value })` expecting `{ value, rotated }`.
 */
export function makeBlindEncryption(wrapKey) {
  const NONCE = sodium.crypto_secretbox_NONCEBYTES // 24
  const MAC = sodium.crypto_secretbox_MACBYTES // 16
  return {
    encrypt(data) {
      const nonce = b4a.allocUnsafe(NONCE)
      sodium.randombytes_buf(nonce)
      const cipher = b4a.allocUnsafe(data.length + MAC)
      sodium.crypto_secretbox_easy(cipher, data, nonce, wrapKey)
      return { type: 0, value: b4a.concat([nonce, cipher]) }
    },
    decrypt({ value }) {
      const nonce = value.subarray(0, NONCE)
      const cipher = value.subarray(NONCE)
      const message = b4a.allocUnsafe(cipher.length - MAC)
      const ok = sodium.crypto_secretbox_open_easy(message, cipher, nonce, wrapKey)
      if (!ok) throw new Error('Failed to unwrap personal store key (wrong keychain secret?)')
      return { value: message, rotated: false }
    }
  }
}
