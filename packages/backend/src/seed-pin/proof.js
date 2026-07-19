import b4a from 'b4a'
import c from 'compact-encoding'
import IdentityEncoding from 'keet-identity-key/lib/encoding.js'

export const MAX_SEED_PIN_PROOF_BYTES = 16 * 1024
export const MAX_SEED_PIN_PROOF_CHAIN = 16

const { ProofEncoding } = IdentityEncoding

export function canonicalSeedPinProofBytes (value, name) {
  if (!(value instanceof Uint8Array) && !b4a.isBuffer(value)) {
    throw new TypeError(`${name} must be bytes`)
  }
  if (value.byteLength === 0 || value.byteLength > MAX_SEED_PIN_PROOF_BYTES) {
    throw new RangeError(`${name} has an invalid size`)
  }
  const bytes = b4a.from(value)
  let canonical
  try {
    preflightProofBytes(bytes, name)
    const decoded = c.decode(ProofEncoding, bytes)
    canonical = c.encode(ProofEncoding, decoded)
  } catch (error) {
    throw new TypeError(`${name} has invalid compact encoding: ${error?.message || String(error)}`)
  }
  if (!b4a.equals(bytes, canonical)) {
    throw new TypeError(`${name} must use canonical compact encoding without trailing bytes`)
  }
  return bytes
}

function preflightProofBytes (bytes, name) {
  const state = { buffer: bytes, start: 0, end: bytes.byteLength }
  const version = c.uint.decode(state)
  if (version === 0) return
  c.uint64.decode(state)
  if (state.end - state.start < 32) throw new Error('Out of bounds')
  state.start += 32
  const chainLength = c.uint.decode(state)
  if (!Number.isSafeInteger(chainLength) || chainLength < 0 ||
      chainLength > MAX_SEED_PIN_PROOF_CHAIN) {
    throw new RangeError(`${name} chain length is out of bounds`)
  }
  const chainBytes = chainLength * 96
  if (state.end - state.start < chainBytes + 1) throw new Error('Out of bounds')
  state.start += chainBytes
  const flags = c.uint.decode(state)
  if ((flags & 1) !== 0 && state.end - state.start < 64) {
    throw new Error('Out of bounds')
  }
}
