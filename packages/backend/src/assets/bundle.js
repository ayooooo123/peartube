import b4a from 'b4a'

import { encodeCanonical, hashCanonical, normalizeNonNegativeInteger, sortPlain, toHex } from '../publisher/canonical.js'
import {
  createApplicationEnvelope,
  decodeApplicationEnvelope,
  encodeApplicationEnvelope,
  verifyApplicationEnvelope,
} from '../records/application-envelope.js'

export const ASSET_BUNDLE_VERSION = 1
export const ASSET_BUNDLE_ID_DOMAIN = 'peartube.asset.bundle.v1'
export const ASSET_BUNDLE_RECORD_TYPE = 'peartube.asset.bundle.v1'

const MAX_BUNDLE_ENTRIES = 1024
const MAX_SOURCE_NAME_BYTES = 512
const MAX_SOURCE_PATH_BYTES = 4096
const SOURCE_KINDS = new Set(['public-torrent', 'release', 'folder', 'archive'])
const PRIVATE_FIELD = /(?:passkey|cookie|credential|password|secret|token|signedurl|sourceurl|trackerurl|trackerid|debrid|sourceheader|authorization|locator|localfilepath|sourcefilepath|^headers?$|^urls?$|^uris?$)/i
const SCP_LOCATOR = /^(?:[^/\\\s:@]+@(?:\[[^\]\s]+\]|[^/\\\s:]+)|\[[^\]\s]+\]|(?:\d{1,3}\.){3}\d{1,3}):[^\s]/

function assertNoPrivateSourceMaterial(value, state = { depth: 0, nodes: 0, seen: new Set() }) {
  if (value == null || typeof value !== 'object' || b4a.isBuffer(value) || value instanceof Uint8Array) return
  if (state.depth > 16 || ++state.nodes > 10_000) throw new Error('bundle source metadata exceeds its bounds')
  if (state.seen.has(value)) throw new Error('bundle source metadata must not contain cycles')
  state.seen.add(value)
  state.depth++
  try {
    for (const [key, child] of Object.entries(value)) {
      const compact = key.replace(/[-_]/g, '')
      if (PRIVATE_FIELD.test(compact)) throw new Error(`private source material is forbidden: ${key}`)
      assertNoPrivateSourceMaterial(child, state)
    }
  } finally {
    state.depth--
    state.seen.delete(value)
  }
}

function boundedText(value, name, maxBytes, required = false) {
  if (value == null && !required) return null
  if (typeof value !== 'string') throw new Error(`${name} must be bounded string`)
  const normalized = value.normalize('NFC')
  if (!normalized || b4a.byteLength(normalized) > maxBytes || normalized.includes('\0')) {
    throw new Error(`${name} must be bounded string`)
  }
  if (/(?:[a-z][a-z0-9+.-]*:\/\/|^magnet:|^data:|^file:)/i.test(normalized)) {
    throw new Error(`${name} must not contain a source locator`)
  }
  return normalized
}

function normalizeSourceName(value) {
  const sourceName = boundedText(value, 'sourceName', MAX_SOURCE_NAME_BYTES)
  if (sourceName == null) return null
  if (sourceName.includes('/') ||
      sourceName.includes('\\') ||
      SCP_LOCATOR.test(sourceName) ||
      /^[a-z][a-z0-9+.-]*:[^\s]/i.test(sourceName)) {
    throw new Error('sourceName must not contain a source locator')
  }
  return sourceName
}

function normalizeSourcePath(value) {
  const raw = boundedText(value, 'sourcePath', MAX_SOURCE_PATH_BYTES, true)
  if (raw.startsWith('/') ||
      raw.startsWith('\\') ||
      SCP_LOCATOR.test(raw) ||
      /^[a-z]:/i.test(raw) ||
      /^[a-z][a-z0-9+.-]*:[^\s]/i.test(raw)) {
    throw new Error('sourcePath must be a relative path without locator material')
  }
  const source = raw.replaceAll('\\', '/')
  if (source.startsWith('/') || source.includes('?') || source.includes('#')) {
    throw new Error('sourcePath must be a relative path without locator material')
  }
  const parts = source.split('/').filter(part => part !== '' && part !== '.')
  if (parts.length === 0 || parts.some(part => part === '..')) throw new Error('sourcePath must not escape its source root')
  const normalized = parts.join('/')
  if (b4a.byteLength(normalized) > MAX_SOURCE_PATH_BYTES) throw new Error('sourcePath must be bounded string')
  return normalized
}

function optionalInteger(value, name) {
  return value == null ? null : normalizeNonNegativeInteger(value, name)
}

function normalizeInfohash(value) {
  let bytes
  if (b4a.isBuffer(value) || value instanceof Uint8Array) bytes = b4a.from(value)
  else if (typeof value === 'string' && /^(?:[0-9a-f]{2})+$/i.test(value)) bytes = b4a.from(value, 'hex')
  else throw new Error('publicInfohash must be a v1 or v2 infohash')
  if (bytes.byteLength !== 20 && bytes.byteLength !== 32) throw new Error('publicInfohash must be a v1 or v2 infohash')
  return b4a.toString(bytes, 'hex')
}

function normalizeEntry(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('bundle entry must be an object')
  const entry = {
    sourcePath: normalizeSourcePath(input.sourcePath),
    publicationId: toHex(input.publicationId, 32, 'publicationId'),
    renditionId: toHex(input.renditionId, 32, 'renditionId'),
    assetId: toHex(input.assetId, 32, 'assetId'),
  }
  const sourceIndex = optionalInteger(input.sourceIndex, 'sourceIndex')
  const sourceOffset = optionalInteger(input.sourceOffset, 'sourceOffset')
  const sourceLength = optionalInteger(input.sourceLength, 'sourceLength')
  if (sourceIndex != null) entry.sourceIndex = sourceIndex
  if (sourceOffset != null) entry.sourceOffset = sourceOffset
  if (sourceLength != null) entry.sourceLength = sourceLength
  return sortPlain(entry)
}

function compareStrings(a, b) {
  return a === b ? 0 : a < b ? -1 : 1
}

function compareEntries(a, b) {
  const aIndex = a.sourceIndex == null ? Number.MAX_SAFE_INTEGER : a.sourceIndex
  const bIndex = b.sourceIndex == null ? Number.MAX_SAFE_INTEGER : b.sourceIndex
  return aIndex - bIndex ||
    compareStrings(a.sourcePath, b.sourcePath) ||
    compareStrings(a.publicationId, b.publicationId) ||
    compareStrings(a.renditionId, b.renditionId) ||
    compareStrings(a.assetId, b.assetId)
}

function normalizeUnsignedBundle(input = {}) {
  if (!SOURCE_KINDS.has(input.sourceKind)) throw new Error('sourceKind must identify a bounded public source kind')
  const entries = input.entries || []
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_BUNDLE_ENTRIES) {
    throw new Error('entries must be a non-empty bounded array')
  }
  const normalizedEntries = entries.map(normalizeEntry).sort(compareEntries)
  const sourcePaths = new Set()
  const sourceIndexes = new Set()
  for (const entry of normalizedEntries) {
    if (sourcePaths.has(entry.sourcePath)) throw new Error('bundle entries must have distinct source paths')
    sourcePaths.add(entry.sourcePath)
    if (entry.sourceIndex == null) continue
    if (sourceIndexes.has(entry.sourceIndex)) throw new Error('bundle entries must have distinct source indexes')
    sourceIndexes.add(entry.sourceIndex)
  }

  let publicInfohash = null
  if (input.publicInfohash != null) {
    if (input.sourceKind !== 'public-torrent') throw new Error('publicInfohash requires public-torrent sourceKind')
    if (input.publicTrackerIndependent !== true) {
      throw new Error('publicInfohash requires an explicit tracker-independent public attestation')
    }
    publicInfohash = normalizeInfohash(input.publicInfohash)
  }

  const sourceName = normalizeSourceName(input.sourceName)
  const sourceRoot = input.sourceRoot == null ? null : toHex(input.sourceRoot, 32, 'sourceRoot')
  return sortPlain({
    version: ASSET_BUNDLE_VERSION,
    sourceKind: input.sourceKind,
    ...(sourceName == null ? {} : { sourceName }),
    ...(sourceRoot == null ? {} : { sourceRoot }),
    ...(publicInfohash == null ? {} : { publicInfohash }),
    ...(publicInfohash == null ? {} : { publicTrackerIndependent: true }),
    entries: normalizedEntries,
  })
}

function bundleIdFor(unsignedBody) {
  return b4a.toString(hashCanonical(ASSET_BUNDLE_ID_DOMAIN, unsignedBody), 'hex')
}

function canonicalBundleBody(input = {}) {
  assertNoPrivateSourceMaterial(input)
  const unsignedBody = normalizeUnsignedBundle(input)
  const bundleId = bundleIdFor(unsignedBody)
  if (input.bundleId !== bundleId) throw new Error('bundleId does not match canonical bundle metadata')
  const body = sortPlain({ bundleId, ...unsignedBody })
  if (!b4a.equals(encodeCanonical(body), encodeCanonical(input))) throw new Error('asset bundle body is noncanonical')
  return body
}

function decodeCanonicalBody(input) {
  let parsed
  try {
    parsed = JSON.parse(b4a.toString(input))
  } catch {
    throw new Error('asset bundle body is not canonical JSON')
  }
  const body = canonicalBundleBody(parsed)
  if (!b4a.equals(input, encodeCanonical(body))) throw new Error('asset bundle body is noncanonical')
  return body
}

export function deriveAssetBundleId(input = {}) {
  const source = input.body || input
  assertNoPrivateSourceMaterial(source)
  return bundleIdFor(normalizeUnsignedBundle(source))
}

export function createAssetBundleManifest(input = {}) {
  assertNoPrivateSourceMaterial(input)
  const unsignedBody = normalizeUnsignedBundle(input)
  return sortPlain({ bundleId: bundleIdFor(unsignedBody), ...unsignedBody })
}

export function normalizeAssetBundleManifest(input = {}) {
  return canonicalBundleBody(input)
}

export function signAssetBundleManifest(input = {}) {
  const body = canonicalBundleBody(input.manifest || input.body)
  const envelope = createApplicationEnvelope({
    recordType: ASSET_BUNDLE_RECORD_TYPE,
    body: encodeCanonical(body),
    keyPair: input.keyPair,
    issuedAt: input.signedAt,
    expiresAt: input.expiresAt,
  })
  return { bundleId: body.bundleId, body, envelope }
}

export function encodeAssetBundleManifest(manifest) {
  if (manifest?.body && manifest?.envelope) {
    const body = canonicalBundleBody(manifest.body)
    if (manifest.bundleId !== body.bundleId) throw new Error('signed asset bundle bundleId mismatch')
    const encodedBody = encodeCanonical(body)
    if (!b4a.equals(manifest.envelope.body, encodedBody)) throw new Error('signed asset bundle body mismatch')
    return encodeApplicationEnvelope(manifest.envelope)
  }
  return encodeCanonical(canonicalBundleBody(manifest))
}

export function decodeAssetBundleManifest(input) {
  const frame = b4a.from(input)
  if (frame[0] === 0x7b) return decodeCanonicalBody(frame)
  const envelope = decodeApplicationEnvelope(frame)
  const body = decodeCanonicalBody(envelope.body)
  return { bundleId: body.bundleId, body, envelope }
}

export async function verifyAssetBundleManifest(manifest, options = {}) {
  if (!manifest?.body || !manifest?.envelope) return false
  try {
    encodeAssetBundleManifest(manifest)
    return Boolean(await verifyApplicationEnvelope(manifest.envelope, {
      ...options,
      recordType: ASSET_BUNDLE_RECORD_TYPE,
    }))
  } catch {
    return false
  }
}
