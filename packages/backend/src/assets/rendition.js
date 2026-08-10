import b4a from 'b4a'

import {
  hashCanonical,
  normalizeNonNegativeInteger,
  toHex,
} from '../publisher/canonical.js'
import {
  assertSegmentIndexMatchesAsset,
  createSegmentIndexDescriptor,
} from './segment-index.js'
import { ASSET_BLOCK_SIZE, createStaticAssetManifest } from './static-core.js'

export const RENDITION_DESCRIPTOR_VERSION = 2
export const RENDITION_ID_DOMAIN = 'peartube.asset.rendition.v2'

function boundedString(value, name, max = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`${name} must be bounded string`)
  return value
}

export function normalizeAssetCoreRefV2(input = {}, name = 'core') {
  if (input.kind !== 'static-prologue-v1') throw new Error('static asset core reference required')

  const byteLength = normalizeNonNegativeInteger(input.byteLength, `${name}.byteLength`)
  const blockSize = normalizeNonNegativeInteger(input.blockSize, `${name}.blockSize`)
  const length = normalizeNonNegativeInteger(input.length, `${name}.length`)
  if (blockSize !== ASSET_BLOCK_SIZE || length !== Math.ceil(byteLength / blockSize)) {
    throw new Error('asset core length does not match canonical blocks')
  }

  const key = toHex(input.key, 32, `${name}.key`)
  const assetId = toHex(input.assetId, 32, `${name}.assetId`)
  if (assetId !== key) throw new Error('assetId must equal static core key')
  const treeHash = toHex(input.treeHash, 32, `${name}.treeHash`)
  const reconstructed = createStaticAssetManifest({
    treeHash,
    blockLength: length,
    byteLength,
    blockSize,
  })
  if (toHex(reconstructed.key, 32, 'reconstructed key') !== key) {
    throw new Error('static asset core key does not match reconstructed manifest')
  }

  return Object.freeze({
    kind: input.kind,
    key,
    treeHash,
    length,
    byteLength,
    blockSize,
    assetId,
  })
}

function unsignedRenditionDescriptor(input = {}) {
  const core = normalizeAssetCoreRefV2(input.core, 'core')
  const segmentIndex = input.segmentIndex
    ? assertSegmentIndexMatchesAsset(createSegmentIndexDescriptor(input.segmentIndex), core)
    : null
  return {
    version: RENDITION_DESCRIPTOR_VERSION,
    purpose: boundedString(input.purpose, 'purpose'),
    format: boundedString(input.format, 'format'),
    core,
    segmentIndex,
  }
}

export function deriveRenditionId(input = {}) {
  return b4a.toString(hashCanonical(RENDITION_ID_DOMAIN, unsignedRenditionDescriptor(input)), 'hex')
}

export function createRenditionDescriptor(input = {}) {
  const body = unsignedRenditionDescriptor(input)
  return { ...body, renditionId: deriveRenditionId(body) }
}
