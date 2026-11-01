// The worklet's `crypto`: createHash('sha256'), the only part of it that the core
// (src/index.js) and LAN discovery (src/lan.js) use. It runs on
// sodium-native, which the worklet loads anyway, so the app does not ship
// bare-crypto's 0.8 MB native library. package.json's `imports` and
// worklet/imports.json map `node:crypto` and `crypto` here for Bare.
const b4a = require('b4a')
const sodium = require('sodium-native')

exports.createHash = function createHash (algorithm) {
  if (algorithm !== 'sha256') throw new Error(`The worklet has no ${algorithm} hash, only sha256`)
  const state = b4a.alloc(sodium.crypto_hash_sha256_STATEBYTES)
  sodium.crypto_hash_sha256_init(state)
  return {
    update (data, encoding) {
      sodium.crypto_hash_sha256_update(state, typeof data === 'string' ? b4a.from(data, encoding) : data)
      return this
    },
    digest (encoding) {
      const hash = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
      sodium.crypto_hash_sha256_final(state, hash)
      return encoding ? b4a.toString(hash, encoding) : hash
    }
  }
}

exports.randomUUID = function randomUUID () {
  const buf = b4a.alloc(16)
  sodium.randombytes_buf(buf)
  buf[6] = (buf[6] & 0x0f) | 0x40
  buf[8] = (buf[8] & 0x3f) | 0x80
  const h = b4a.toString(buf, 'hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// Fresh entropy wet from sodium's belly so cast tokens and receiver seeds never pull bare-crypto.
exports.randomBytes = function randomBytes (size) {
  const buf = b4a.alloc(size)
  sodium.randombytes_buf(buf)
  return buf
}

exports.timingSafeEqual = function timingSafeEqual (a, b) {
  if (a.byteLength !== b.byteLength) throw new RangeError('Input buffers must have the same byte length')
  return sodium.sodium_memcmp(a, b)
}
