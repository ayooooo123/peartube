import b4a from 'b4a'
import Hypercore from 'hypercore'

import {
  normalizeBytes,
  normalizeNonNegativeInteger,
} from '../publisher/canonical.js'

export const ASSET_BLOCK_SIZE = 256 * 1024

const STATIC_ASSET_KIND = 'static-prologue-v1'

function normalizeIdentityInput(input = {}) {
  const treeHash = normalizeBytes(input.treeHash, 32, 'treeHash')
  const blockLength = normalizeNonNegativeInteger(
    input.blockLength ?? input.length,
    'blockLength',
    NaN
  )
  const byteLength = normalizeNonNegativeInteger(input.byteLength, 'byteLength', NaN)
  const blockSize = normalizeNonNegativeInteger(
    input.blockSize ?? ASSET_BLOCK_SIZE,
    'blockSize',
    NaN
  )

  if (blockSize !== ASSET_BLOCK_SIZE) throw new Error('blockSize does not match canonical asset blocks')
  if (blockLength !== Math.ceil(byteLength / ASSET_BLOCK_SIZE)) {
    throw new Error('blockLength does not match canonical asset blocks')
  }

  return { treeHash, blockLength, byteLength, blockSize }
}

function createHypercoreManifest(treeHash, blockLength) {
  return {
    version: 1,
    hash: 'blake2b',
    allowPatch: false,
    quorum: 0,
    signers: [],
    prologue: { hash: treeHash, length: blockLength },
  }
}

export function deriveStaticAssetId(input = {}) {
  const { treeHash, blockLength } = normalizeIdentityInput(input)
  return b4a.toString(Hypercore.key(createHypercoreManifest(treeHash, blockLength)), 'hex')
}

export function deriveStaticAssetTopic(assetId) {
  return Hypercore.discoveryKey(normalizeBytes(assetId, 32, 'assetId'))
}

export function createStaticAssetManifest(input = {}) {
  const { treeHash, blockLength, byteLength, blockSize } = normalizeIdentityInput(input)
  const hypercoreManifest = createHypercoreManifest(treeHash, blockLength)
  const key = Hypercore.key(hypercoreManifest)
  const descriptor = {
    kind: STATIC_ASSET_KIND,
    key,
    treeHash,
    length: blockLength,
    byteLength,
    blockSize,
    hypercoreManifest,
  }

  return {
    ...descriptor,
    assetId: b4a.toString(key, 'hex'),
  }
}

export async function verifyStaticAssetDescriptor(core, descriptor) {
  if (!core || !descriptor) return false

  try {
    const expected = createStaticAssetManifest({
      treeHash: descriptor.treeHash,
      blockLength: descriptor.length,
      byteLength: descriptor.byteLength,
      blockSize: descriptor.blockSize,
    })

    if (descriptor.kind !== STATIC_ASSET_KIND || descriptor.assetId !== expected.assetId) return false
    if (!b4a.equals(normalizeBytes(descriptor.key, 32, 'key'), expected.key)) return false

    await core.ready()
    if (!b4a.equals(normalizeBytes(core.key, 32, 'core.key'), expected.key)) return false
    if (core.length !== expected.length || core.byteLength !== expected.byteLength) return false

    return b4a.equals(normalizeBytes(await core.treeHash(), 32, 'core.treeHash'), expected.treeHash)
  } catch {
    return false
  }
}
