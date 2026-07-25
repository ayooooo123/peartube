import b4a from 'b4a'

import {
  encodeCanonical,
  hashCanonical,
  normalizeBytes,
  normalizeNonNegativeInteger,
  sortPlain,
  toHex,
} from '../publisher/canonical.js'
import { normalizeExternalIdentifier } from './external-identifiers.js'

export const MEDIA_ENTITY_REF_VERSION = 1
export const MEDIA_ENTITY_ID_DOMAIN = 'peartube.media-graph.entity-id.v1'
export const ENTITY_REFERENCE_VERSION = 1
export const ENTITY_KINDS = ['work', 'recording', 'edition', 'publication', 'rendition', 'collection', 'agent', 'publisher']

const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9._:-]*$/i
const LOCATOR_PROTOCOLS = new Set(['hypercore', 'https', 'ipfs', 'file'])
const NAMESPACE_RE = /^[a-z0-9][a-z0-9._:-]*$/i

function normalizeName(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || !MEDIA_TYPE_RE.test(value)) {
    throw new Error(`${name} must be a bounded domain string`)
  }
  return value
}

function normalizeOptionalString(value, name, max = 2048) {
  if (value == null) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`${name} must be a bounded string`)
  return value
}

function normalizeLocator(locator = {}) {
  const protocol = normalizeName(locator.protocol, 'locator.protocol').toLowerCase()
  if (!LOCATOR_PROTOCOLS.has(protocol)) throw new Error('unsupported locator protocol')

  const out = { protocol }
  if (protocol === 'hypercore') {
    out.key = toHex(locator.key, 32, 'locator.key')
    out.path = normalizeOptionalString(locator.path || '/', 'locator.path')
  } else if (protocol === 'https') {
    if (locator.key != null || locator.path != null) throw new Error('https locator must not include hypercore fields')
    const url = normalizeOptionalString(locator.url, 'locator.url')
    if (!/^https:\/\//i.test(url)) throw new Error('https locator.url must be https')
    out.url = url
  } else if (protocol === 'ipfs') {
    out.cid = normalizeOptionalString(locator.cid, 'locator.cid', 256)
  } else if (protocol === 'file') {
    out.path = normalizeOptionalString(locator.path, 'locator.path')
  }
  return out
}

function normalizeHashRef(input = {}, name = 'hashRef') {
  return {
    ...sortPlain(input),
    contentHash: toHex(input.contentHash, 32, `${name}.contentHash`),
  }
}

function normalizeVariant(variant = {}) {
  return {
    contentHash: toHex(variant.contentHash, 32, 'variant.contentHash'),
    codec: normalizeOptionalString(variant.codec, 'variant.codec', 64),
    bitrate: normalizeNonNegativeInteger(variant.bitrate, 'variant.bitrate', 0),
    width: normalizeNonNegativeInteger(variant.width, 'variant.width', 0),
    height: normalizeNonNegativeInteger(variant.height, 'variant.height', 0),
  }
}

function dedupeSorted(items) {
  const keyed = new Map()
  for (const item of items) keyed.set(JSON.stringify(sortPlain(item)), item)
  return Array.from(keyed.keys()).sort().map(key => keyed.get(key))
}

export function createMediaEntityRef(input = {}) {
  const ref = {
    version: MEDIA_ENTITY_REF_VERSION,
    type: normalizeName(input.type, 'type').toLowerCase(),
    contentHash: toHex(input.contentHash, 32, 'contentHash'),
    locators: dedupeSorted((input.locators || []).map(normalizeLocator)),
    variants: dedupeSorted((input.variants || []).map(normalizeVariant)),
    thumbnails: dedupeSorted((input.thumbnails || []).map((thumbnail) => normalizeHashRef(thumbnail, 'thumbnail'))),
    metadata: sortPlain(input.metadata || {}),
  }
  ref.id = deriveMediaEntityId(ref)
  return ref
}

export function encodeMediaEntityRef(ref) {
  return encodeCanonical(createMediaEntityRef(ref))
}

export function deriveMediaEntityId(input = {}) {
  const ref = {
    version: MEDIA_ENTITY_REF_VERSION,
    type: normalizeName(input.type, 'type').toLowerCase(),
    contentHash: toHex(input.contentHash, 32, 'contentHash'),
    locators: dedupeSorted((input.locators || []).map(normalizeLocator)),
    variants: dedupeSorted((input.variants || []).map(normalizeVariant)),
    thumbnails: dedupeSorted((input.thumbnails || []).map((thumbnail) => normalizeHashRef(thumbnail, 'thumbnail'))),
    metadata: sortPlain(input.metadata || {}),
  }
  return b4a.toString(hashCanonical(MEDIA_ENTITY_ID_DOMAIN, ref), 'hex')
}

export function decodeMediaEntityRef(buffer) {
  const parsed = JSON.parse(b4a.toString(normalizeBytes(buffer, null, 'media entity ref'), 'utf8'))
  return createMediaEntityRef(parsed)
}

function normalizeVersion(value, name) {
  return normalizeNonNegativeInteger(value, name, 1) || 1
}

function normalizeIdentifier(namespace, identifier) {
  const external = normalizeExternalIdentifier(namespace, identifier)
  if (external !== null) return external
  if (typeof identifier !== 'string') throw new Error('identifier must be a string')
  let next = identifier.trim()
  if (next.length === 0 || next.length > 512) throw new Error('identifier must be bounded')

  if (namespace === 'canonical-url') {
    const url = new URL(next)
    if (url.protocol !== 'https:') throw new Error('canonical-url references require https')
    url.hash = ''
    if (url.port === '443') url.port = ''
    next = url.toString()
  } else if (namespace === 'musicbrainz-recording' || namespace === 'musicbrainz-release') {
    next = next.toLowerCase()
  } else if (namespace === 'av-fingerprint' || namespace === 'exact-hash') {
    next = next.toLowerCase()
    if (!/^sha256:[0-9a-f]+$/.test(next)) throw new Error('fingerprint algorithm must be sha256')
  } else if (namespace === 'imdb-title') {
    next = next.toLowerCase()
  }

  if (next.length === 0 || next.length > 512) throw new Error('identifier must be bounded')
  return next
}

function normalizeNamespace(namespace) {
  if (typeof namespace !== 'string' || !NAMESPACE_RE.test(namespace)) throw new Error('namespace must be a domain string')
  return namespace.toLowerCase()
}

function normalizeEntityKind(entityKind) {
  if (!ENTITY_KINDS.includes(entityKind)) throw new Error('entityKind is unsupported')
  return entityKind
}

export function normalizeEntityReference(input = {}) {
  const entityKind = normalizeEntityKind(input.entityKind)
  const namespace = normalizeNamespace(input.namespace)
  const namespaceVersion = normalizeVersion(input.namespaceVersion, 'namespaceVersion')
  const normalizationVersion = normalizeVersion(input.normalizationVersion, 'normalizationVersion')

  const base = {
    version: ENTITY_REFERENCE_VERSION,
    entityKind,
    namespace,
    namespaceVersion,
    normalizationVersion,
  }

  if (namespace === 'issuer-native') {
    const issuerRootKey = toHex(input.issuerRootKey, 32, 'issuerRootKey')
    const issuerLocalId = normalizeIdentifier(namespace, input.issuerLocalId)
    return {
      ...base,
      issuerRootKey,
      issuerLocalId,
      entityId: deriveNativeEntityId({ entityKind, issuerRootKey, issuerLocalId, namespaceVersion, normalizationVersion }),
    }
  }

  const normalizedIdentifier = normalizeIdentifier(namespace, input.normalizedIdentifier)
  return {
    ...base,
    normalizedIdentifier,
    entityId: deriveEntityId({ entityKind, namespace, namespaceVersion, normalizationVersion, normalizedIdentifier }),
  }
}

export function createEntityReference(input = {}) {
  return normalizeEntityReference(input)
}

export function deriveEntityId(input = {}) {
  const entityKind = normalizeEntityKind(input.entityKind)
  const namespace = normalizeNamespace(input.namespace)
  const namespaceVersion = normalizeVersion(input.namespaceVersion, 'namespaceVersion')
  const normalizationVersion = normalizeVersion(input.normalizationVersion, 'normalizationVersion')
  if (namespace === 'issuer-native') {
    return deriveNativeEntityId({ entityKind, issuerRootKey: input.issuerRootKey, issuerLocalId: input.issuerLocalId, namespaceVersion, normalizationVersion })
  }
  const normalizedIdentifier = normalizeIdentifier(namespace, input.normalizedIdentifier)
  return b4a.toString(hashCanonical(MEDIA_ENTITY_ID_DOMAIN, {
    version: ENTITY_REFERENCE_VERSION,
    entityKind,
    namespace,
    namespaceVersion,
    normalizationVersion,
    normalizedIdentifier,
  }), 'hex')
}

export function deriveNativeEntityId(input = {}) {
  const entityKind = normalizeEntityKind(input.entityKind)
  const issuerRootKey = toHex(input.issuerRootKey, 32, 'issuerRootKey')
  const issuerLocalId = normalizeIdentifier('issuer-native', input.issuerLocalId)
  const namespaceVersion = normalizeVersion(input.namespaceVersion, 'namespaceVersion')
  const normalizationVersion = normalizeVersion(input.normalizationVersion, 'normalizationVersion')
  return b4a.toString(hashCanonical(MEDIA_ENTITY_ID_DOMAIN, {
    version: ENTITY_REFERENCE_VERSION,
    entityKind,
    namespace: 'issuer-native',
    namespaceVersion,
    normalizationVersion,
    issuerRootKey,
    issuerLocalId,
  }), 'hex')
}

export function encodeEntityReference(ref) {
  return encodeCanonical(normalizeEntityReference(ref))
}

export function decodeEntityReference(buffer) {
  const parsed = JSON.parse(b4a.toString(normalizeBytes(buffer, null, 'entity reference'), 'utf8'))
  return normalizeEntityReference(parsed)
}
