import * as ed25519 from '@noble/ed25519'
import { blake2b } from '@noble/hashes/blake2.js'
import { sha512 } from '@noble/hashes/sha2.js'

ed25519.hashes.sha512 = sha512

const PUBLIC_KEY_BYTES = 32
const SECRET_SEED_BYTES = 32
const SECRET_KEY_BYTES = 64

function bytes(value: unknown, length: number | null, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || (length !== null && value.byteLength !== length)) {
    throw new TypeError(`${name} must be ${length ?? 'valid'} bytes`)
  }
  return value
}

function randomSeed(): Uint8Array {
  const seed = new Uint8Array(SECRET_SEED_BYTES)
  if (!globalThis.crypto?.getRandomValues) throw new Error('secure random source unavailable')
  globalThis.crypto.getRandomValues(seed)
  return seed
}

export function hashPublisherBytes(value: Uint8Array): Uint8Array {
  return blake2b(bytes(value, null, 'hash input'), { dkLen: 32 })
}

function keyPair(seedValue?: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const seed = seedValue === undefined
    ? randomSeed()
    : bytes(seedValue, SECRET_SEED_BYTES, 'seed').slice()
  try {
    const publicKey = ed25519.getPublicKey(seed)
    const secretKey = new Uint8Array(SECRET_KEY_BYTES)
    secretKey.set(seed, 0)
    secretKey.set(publicKey, SECRET_SEED_BYTES)
    return { publicKey, secretKey }
  } finally {
    seed.fill(0)
  }
}

function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  const secret = bytes(secretKey, SECRET_KEY_BYTES, 'secretKey')
  return ed25519.sign(bytes(message, null, 'message'), secret.subarray(0, SECRET_SEED_BYTES))
}

function verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(
      bytes(signature, 64, 'signature'),
      bytes(message, null, 'message'),
      bytes(publicKey, PUBLIC_KEY_BYTES, 'publicKey'),
    )
  } catch {
    return false
  }
}

const publisherMobileCrypto = {
  hash: hashPublisherBytes,
  keyPair,
  sign,
  verify,
}

export default publisherMobileCrypto
