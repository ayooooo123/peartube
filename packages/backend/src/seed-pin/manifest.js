import b4a from 'b4a'
import sodium from 'sodium-universal'

import {
  canonicalDurabilityRefKey,
  canonicalizeDurabilityRefs,
} from '../durability/aggregate-assessment.js'
import { ARTWORK_ROLES } from '../channel/structured-content.js'

export const DURABLE_MANIFEST_VERSION = 1
export const MAX_DURABLE_MANIFEST_ROW_ID_BYTES = 256

const LOWERCASE_HEX_KEY_PATTERN = /^[0-9a-f]{64}$/
const MANIFEST_DOMAIN = b4a.from('peartube.seed-pin.manifest/v1\0')
const ARTWORK_ROLE_ORDER = Object.freeze([...ARTWORK_ROLES])
const ASSET_FIELDS = new Set(['media', 'thumbnail', 'artwork'])
const ARTWORK_FIELDS = new Set(ARTWORK_ROLE_ORDER)

function isByteArray (value) {
  return value instanceof Uint8Array || b4a.isBuffer(value)
}

function normalizeChannelKey (value) {
  if (typeof value === 'string') {
    if (!LOWERCASE_HEX_KEY_PATTERN.test(value)) {
      throw new TypeError('channelKey must be a lowercase 32-byte hex key')
    }
    return value
  }
  if (!isByteArray(value) || value.byteLength !== 32) {
    throw new TypeError('channelKey must be a 32-byte key')
  }
  return b4a.toString(value, 'hex')
}

function normalizeRowId (value) {
  if (typeof value !== 'string') throw new TypeError('rowId must be a string')
  const encoded = b4a.from(value)
  if (encoded.byteLength === 0 || encoded.byteLength > MAX_DURABLE_MANIFEST_ROW_ID_BYTES) {
    throw new RangeError(`rowId must be between 1 and ${MAX_DURABLE_MANIFEST_ROW_ID_BYTES} UTF-8 bytes`)
  }
  if (b4a.toString(encoded) !== value) throw new TypeError('rowId must contain valid UTF-8')
  return value
}

function assertExactFields (value, allowed, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain object`)
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError(`${name} contains unsupported field ${String(key)}`)
    }
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new TypeError(`${name}.${key} is required`)
    }
  }
}

function normalizeAssetBindings (assets, inputRefs, canonicalRefs) {
  assertExactFields(assets, ASSET_FIELDS, 'assets')
  assertExactFields(assets.artwork, ARTWORK_FIELDS, 'assets.artwork')
  if (!Array.isArray(assets.media) || assets.media.length === 0) {
    throw new TypeError('assets.media must contain at least one ref index')
  }

  const canonicalIndexes = new Map()
  for (let index = 0; index < canonicalRefs.length; index++) {
    canonicalIndexes.set(canonicalDurabilityRefKey(canonicalRefs[index]), index)
  }
  const bound = new Set()
  const bindingIndex = (value, name, expectedKind) => {
    if (!Number.isSafeInteger(value) || value < 0 || value >= inputRefs.length) {
      throw new RangeError(`${name} must be an in-range ref index`)
    }
    const durabilityRef = canonicalizeDurabilityRefs([inputRefs[value]])[0]
    if (durabilityRef.kind !== expectedKind) {
      throw new TypeError(`${name} must bind a ${expectedKind} ref kind`)
    }
    const canonicalIndex = canonicalIndexes.get(canonicalDurabilityRefKey(durabilityRef))
    if (canonicalIndex === undefined) throw new Error(`${name} binds a ref outside manifest.refs`)
    bound.add(canonicalIndex)
    return canonicalIndex
  }
  const optionalBinding = (value, name, expectedKind) => {
    if (value === null) return null
    return bindingIndex(value, name, expectedKind)
  }

  const media = []
  for (let index = 0; index < assets.media.length; index++) {
    media.push(bindingIndex(assets.media[index], `assets.media[${index}]`, 'media'))
  }
  media.sort((left, right) => left - right)
  const deduplicatedMedia = media.filter((value, index) => index === 0 || media[index - 1] !== value)
  const thumbnail = optionalBinding(assets.thumbnail, 'assets.thumbnail', 'thumbnail')
  const artwork = {}
  for (const role of ARTWORK_ROLE_ORDER) {
    artwork[role] = optionalBinding(assets.artwork[role], `assets.artwork.${role}`, 'artwork')
  }

  if (bound.size !== canonicalRefs.length) {
    throw new Error('manifest.refs contains an unbound ref outside the asset union')
  }
  for (let index = 0; index < canonicalRefs.length; index++) {
    if (!bound.has(index)) throw new Error('manifest.refs does not equal the bound asset union')
  }
  return { media: deduplicatedMedia, thumbnail, artwork }
}

function encodeUint64 (value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('canonical integer must be a nonnegative safe integer')
  }
  const encoded = b4a.alloc(8)
  const high = Math.floor(value / 0x100000000)
  const low = value - high * 0x100000000
  encoded[0] = high >>> 24
  encoded[1] = high >>> 16
  encoded[2] = high >>> 8
  encoded[3] = high
  encoded[4] = low >>> 24
  encoded[5] = low >>> 16
  encoded[6] = low >>> 8
  encoded[7] = low
  return encoded
}

function frame (value) {
  if (value.byteLength > 0xffffffff) throw new RangeError('canonical field is too large')
  const length = b4a.alloc(4)
  length[0] = value.byteLength >>> 24
  length[1] = value.byteLength >>> 16
  length[2] = value.byteLength >>> 8
  length[3] = value.byteLength
  return [length, value]
}

function encodeOptionalIndex (value) {
  return value === null ? b4a.alloc(0) : encodeUint64(value)
}

function encodeCanonicalFields ({ version, channelKey, rowId, refs, assets }) {
  const parts = [MANIFEST_DOMAIN]
  parts.push(...frame(encodeUint64(version)))
  parts.push(...frame(b4a.from(channelKey, 'hex')))
  parts.push(...frame(b4a.from(rowId)))
  parts.push(...frame(encodeUint64(refs.length)))
  for (const durabilityRef of refs) {
    parts.push(...frame(b4a.from(durabilityRef.coreKey, 'hex')))
    parts.push(...frame(encodeUint64(durabilityRef.start)))
    parts.push(...frame(encodeUint64(durabilityRef.end)))
    parts.push(...frame(b4a.from(durabilityRef.kind)))
  }
  parts.push(...frame(b4a.from('media')))
  parts.push(...frame(encodeUint64(assets.media.length)))
  for (const index of assets.media) parts.push(...frame(encodeUint64(index)))
  parts.push(...frame(b4a.from('thumbnail')))
  parts.push(...frame(encodeOptionalIndex(assets.thumbnail)))
  parts.push(...frame(b4a.from('artwork')))
  for (const role of ARTWORK_ROLE_ORDER) {
    parts.push(...frame(b4a.from(role)))
    parts.push(...frame(encodeOptionalIndex(assets.artwork[role])))
  }
  return b4a.concat(parts)
}

function sha256Hex (payload) {
  const digest = b4a.allocUnsafe(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(digest, payload)
  return b4a.toString(digest, 'hex')
}

function normalizeManifestInput ({ channelKey, rowId, refs, assets }) {
  const normalizedRefs = canonicalizeDurabilityRefs(refs)
  const normalizedAssets = normalizeAssetBindings(assets, refs, normalizedRefs)
  return {
    version: DURABLE_MANIFEST_VERSION,
    channelKey: normalizeChannelKey(channelKey),
    rowId: normalizeRowId(rowId),
    refs: normalizedRefs,
    assets: normalizedAssets,
  }
}

/**
 * Encode the identity-bearing manifest fields. Every variable-width field is
 * length-framed and integers use fixed-width unsigned big-endian encoding.
 * requestId is deliberately excluded because it is the hash of these bytes.
 */
export function encodeDurableManifest (manifest) {
  const normalized = normalizeManifestInput(manifest)
  return encodeCanonicalFields(normalized)
}

export function createDurableManifest (input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('manifest input must be an object')
  }
  const normalized = normalizeManifestInput(input)
  const refs = normalized.refs.map((durabilityRef) => Object.freeze(durabilityRef))
  Object.freeze(refs)
  Object.freeze(normalized.assets.media)
  Object.freeze(normalized.assets.artwork)
  Object.freeze(normalized.assets)
  return Object.freeze({
    version: DURABLE_MANIFEST_VERSION,
    channelKey: normalized.channelKey,
    rowId: normalized.rowId,
    refs,
    assets: normalized.assets,
    requestId: sha256Hex(encodeCanonicalFields(normalized)),
  })
}
