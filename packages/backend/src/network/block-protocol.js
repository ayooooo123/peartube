import b4a from 'b4a'
import c from 'compact-encoding'

export const MAX_VERIFIED_BLOCK_BYTES = 256 * 1024
export const MAX_VERIFIED_PROOF_BYTES = 32 * 1024
export const VERIFIED_BLOCK_CHUNK_BYTES = 48 * 1024

function fail (message) {
  const error = new Error(message)
  error.code = 'SCOPED_NETWORK_REJECTED'
  throw error
}

export async function createVerifiedBlockProof (source, index) {
  const proof = await source.proof(index)
  if (proof && !proof.manifest && source.manifest) proof.manifest = source.manifest
  return proof
}

export function encodeVerifiedBlockProof ({ index, proof, value, coreKey = null, label = 'asset' } = {}) {
  const metadata = {
    index,
    byteLength: value?.byteLength,
    proof: {
      ...proof,
      block: { ...proof?.block, value: null },
    },
  }
  if (coreKey !== null) metadata.coreKey = String(coreKey)
  const payload = c.encode(c.any, metadata)
  if (payload.byteLength > MAX_VERIFIED_PROOF_BYTES) fail(`${label} proof exceeds bounded limit`)
  return payload
}

function assertVerifiedBlockProofPayload (payload, label) {
  if (!b4a.isBuffer(payload) || payload.byteLength > MAX_VERIFIED_PROOF_BYTES) {
    fail(`${label} proof exceeds bounded limit`)
  }
}

function assertVerifiedBlockProofCore (metadata, coreKey, label) {
  if (coreKey !== null && String(metadata?.coreKey || '') !== String(coreKey)) {
    fail(`${label} proof core is invalid`)
  }
}

function isMetadataProofBlockValid (proof, index) {
  if (!proof || typeof proof !== 'object') return false
  const block = proof.block
  return Boolean(block && block.index === index && block.value === null)
}

function isVerifiedProofMetadataValid (metadata, index) {
  if (!metadata || typeof metadata !== 'object') return false
  if (!Number.isSafeInteger(metadata.index) || metadata.index !== index) return false
  if (!Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 0 || metadata.byteLength > MAX_VERIFIED_BLOCK_BYTES) {
    return false
  }
  return isMetadataProofBlockValid(metadata.proof, index)
}

export function decodeVerifiedBlockProof (payload, { index, coreKey = null, label = 'asset' } = {}) {
  assertVerifiedBlockProofPayload(payload, label)
  const metadata = c.decode(c.any, payload)
  assertVerifiedBlockProofCore(metadata, coreKey, label)
  if (!isVerifiedProofMetadataValid(metadata, index)) {
    fail(`${label} proof metadata is invalid`)
  }
  const canonical = { ...metadata }
  if (coreKey === null) delete canonical.coreKey
  if (!b4a.equals(c.encode(c.any, metadata), payload)) fail(`${label} proof encoding is noncanonical`)
  return canonical
}

export function encodeVerifiedBlockChunk ({ index, offset, value } = {}) {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > 0xffffffff ||
      !b4a.isBuffer(value) || value.byteLength > VERIFIED_BLOCK_CHUNK_BYTES) {
    fail('asset block chunk is invalid')
  }
  const payload = b4a.allocUnsafe(8 + value.byteLength)
  payload.writeUInt32BE(index, 0)
  payload.writeUInt32BE(offset, 4)
  b4a.copy(value, payload, 8)
  return payload
}

export function decodeVerifiedBlockChunk (payload) {
  if (!b4a.isBuffer(payload) || payload.byteLength < 8 || payload.byteLength > 8 + VERIFIED_BLOCK_CHUNK_BYTES) {
    fail('asset block chunk is invalid')
  }
  return {
    index: payload.readUInt32BE(0),
    offset: payload.readUInt32BE(4),
    value: payload.subarray(8),
  }
}
