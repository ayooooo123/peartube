// Protected media is PUBLIC opaque ciphertext plus a PUBLIC descriptor of how
// an entitled player obtains a license for it. Every field in this module is
// already world-readable: a DRM key id is an identifier, CENC init data rides
// in the container, and the endpoints are the provider's own published
// services. There is deliberately no representation for a content key, a
// license payload, or a provider token, and the constructor REFUSES input that
// carries a property shaped like one. That refusal is the by-construction half
// of the key boundary: a caller cannot smuggle key material into a signed
// manifest, backend storage, HRPC, or relay state by accident.

import b4a from 'b4a'

import { hashCanonical, sortPlain } from '../publisher/canonical.js'

export const PROTECTED_RENDITION_VERSION = 1
export const PROTECTED_RENDITION_DIGEST_DOMAIN = 'peartube.access.protected-rendition.v1'

// Production systems require a real platform CDM. ClearKey is a deterministic
// test/dev fixture only: it is accepted exclusively when a caller injects the
// `allowClearKeyForTests` capability, which production constructors never do.
export const PROTECTED_DRM_SYSTEMS = Object.freeze(['widevine', 'fairplay', 'playready'])
export const TEST_ONLY_DRM_SYSTEMS = Object.freeze(['clearkey'])
export const PROTECTION_SCHEMES = Object.freeze(['cenc', 'cbcs'])

// Every bound is a named constant so the wire contract, the validator, and the
// tests cannot drift apart.
export const MAX_DRM_INIT_DATA_BYTES = 4096
// Base64 expansion of MAX_DRM_INIT_DATA_BYTES: ceil(4096 / 3) * 4. Checked
// before decoding so oversized input never allocates.
export const MAX_DRM_INIT_DATA_CHARS = 5464
export const MAX_DRM_KEY_ID_CHARS = 64
export const MAX_DRM_URL_CHARS = 512
export const MAX_DRM_URL_QUERY_CHARS = 128
export const MAX_DRM_URL_QUERY_VALUE_CHARS = 64
export const MAX_DRM_ISSUER_CHARS = 256
export const MAX_ENTITLEMENT_ID_CHARS = 128

export const PROTECTED_RENDITION_FIELDS = Object.freeze([
  'version',
  'scheme',
  'drmSystem',
  'keyId',
  'initData',
  'licenseEndpoint',
  'certificateUrl',
  'issuer',
  'entitlementId',
])

// One explicit predicate, applied to the whole input graph, instead of a
// scattering of per-field checks. Substring matching is deliberate: a property
// named `contentkey` or `providerToken` must be refused even though it is not
// an exact token.
export const SECRET_SHAPED_PROPERTY_TOKENS = Object.freeze([
  'bearer',
  'credential',
  'jwt',
  'key',
  'licence',
  'license',
  'passphrase',
  'passwd',
  'password',
  'pwd',
  'secret',
  'token',
])

// The only public wire fields whose names collide with the token list. Nothing
// else may reuse those words.
export const PUBLIC_DRM_PROPERTY_NAMES = Object.freeze(['certificateUrl', 'keyId', 'licenseEndpoint'])

const MAX_INSPECTED_PROPERTY_DEPTH = 16
const MAX_INSPECTED_PROPERTY_NODES = 4096

const KEY_ID_RE = /^(?:[0-9a-f]{2})+$/i
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const ENTITLEMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

function invalid(message, label = 'protected rendition') {
  throw new Error(`Invalid ${label}: ${message}`)
}

function isBytes(value) {
  return b4a.isBuffer(value) || value instanceof Uint8Array
}

export function isSecretShapedPropertyName(name, allowedNames = PUBLIC_DRM_PROPERTY_NAMES) {
  if (allowedNames.includes(name)) return false
  const lowered = String(name).toLowerCase()
  return SECRET_SHAPED_PROPERTY_TOKENS.some(token => lowered.includes(token))
}

function inspectProperties(value, path, allowedNames, state, depth) {
  if (value === null || typeof value !== 'object' || isBytes(value)) return null
  if (depth > MAX_INSPECTED_PROPERTY_DEPTH) invalid(`${path || 'input'} exceeds the inspection depth limit`, state.label)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (++state.nodes > MAX_INSPECTED_PROPERTY_NODES) invalid('input exceeds the inspection node limit', state.label)
      const found = inspectProperties(value[index], `${path}[${index}]`, allowedNames, state, depth + 1)
      if (found) return found
    }
    return null
  }
  for (const name of Object.keys(value)) {
    if (++state.nodes > MAX_INSPECTED_PROPERTY_NODES) invalid('input exceeds the inspection node limit', state.label)
    const childPath = path ? `${path}.${name}` : name
    if (isSecretShapedPropertyName(name, allowedNames)) return childPath
    const found = inspectProperties(value[name], childPath, allowedNames, state, depth + 1)
    if (found) return found
  }
  return null
}

// Returns the dotted path of the first key-material or credential-shaped
// property anywhere in `value`, or null when the graph is clean.
export function findSecretShapedProperty(value, options = {}) {
  const allowedNames = options.allowedNames || PUBLIC_DRM_PROPERTY_NAMES
  const label = options.label || 'protected rendition'
  return inspectProperties(value, '', allowedNames, { nodes: 0, label }, 0)
}

export function assertNoSecretShapedProperties(value, options = {}) {
  const found = findSecretShapedProperty(value, options)
  if (found !== null) {
    invalid(`property "${found}" is key-material or credential shaped and must never reach this boundary`, options.label || 'protected rendition')
  }
  return value
}

function boundedString(value, name, max, label) {
  if (typeof value !== 'string') invalid(`${name} must be a string`, label)
  if (value.length === 0) invalid(`${name} must not be empty`, label)
  if (value.length > max) invalid(`${name} must not exceed ${max} characters`, label)
  return value
}

function enumerated(value, name, allowed, label) {
  if (typeof value !== 'string') invalid(`${name} must be a string`, label)
  const normalized = value.toLowerCase()
  if (!allowed.includes(normalized)) invalid(`${name} "${value}" is not supported`, label)
  return normalized
}

export function normalizeProtectionScheme(value, label = 'protected rendition') {
  return enumerated(value, 'scheme', PROTECTION_SCHEMES, label)
}

export function normalizeDrmSystem(value, { allowClearKeyForTests = false, label = 'protected rendition' } = {}) {
  const allowed = allowClearKeyForTests
    ? [...PROTECTED_DRM_SYSTEMS, ...TEST_ONLY_DRM_SYSTEMS]
    : PROTECTED_DRM_SYSTEMS
  return enumerated(value, 'drmSystem', allowed, label)
}

function normalizeKeyId(value, label) {
  const keyId = boundedString(value, 'keyId', MAX_DRM_KEY_ID_CHARS, label)
  if (!KEY_ID_RE.test(keyId)) invalid('keyId must be an even-length hex identifier', label)
  return keyId.toLowerCase()
}

function normalizeInitData(value, label) {
  if (value == null) return null
  const initData = boundedString(value, 'initData', MAX_DRM_INIT_DATA_CHARS, label)
  if (initData.length % 4 !== 0 || !BASE64_RE.test(initData)) invalid('initData must be canonical base64', label)
  const decoded = b4a.from(initData, 'base64')
  // b4a/Buffer silently tolerates junk, so require an exact round trip rather
  // than trusting the decoder.
  if (b4a.toString(decoded, 'base64') !== initData) invalid('initData must be canonical base64', label)
  if (decoded.byteLength === 0) invalid('initData must not decode to zero bytes', label)
  if (decoded.byteLength > MAX_DRM_INIT_DATA_BYTES) {
    invalid(`initData must not exceed ${MAX_DRM_INIT_DATA_BYTES} decoded bytes`, label)
  }
  return initData
}

// A provider endpoint is public, but a URL is also the easiest place to hide a
// bearer token, so the authority must be credential-free and the query string
// must not carry anything secret shaped or long enough to be an opaque token.
export function normalizePublicHttpsUrl(value, name, label = 'protected rendition') {
  const raw = boundedString(value, name, MAX_DRM_URL_CHARS, label)
  if (!/^https:\/\//i.test(raw)) invalid(`${name} must be an absolute https URL`, label)
  let url
  try {
    url = new URL(raw)
  } catch {
    invalid(`${name} is not a valid URL`, label)
  }
  if (url.protocol !== 'https:') invalid(`${name} must be an absolute https URL`, label)
  if (url.username || url.password) invalid(`${name} must not embed credentials`, label)
  if (!url.hostname || url.hostname.includes('*')) invalid(`${name} must name an exact host`, label)
  if (url.hash) invalid(`${name} must not carry a fragment`, label)
  if (url.search.length > MAX_DRM_URL_QUERY_CHARS) {
    invalid(`${name} query must not exceed ${MAX_DRM_URL_QUERY_CHARS} characters`, label)
  }
  for (const [param, paramValue] of url.searchParams) {
    if (isSecretShapedPropertyName(param, [])) {
      invalid(`${name} query parameter "${param}" is key-material or credential shaped`, label)
    }
    if (paramValue.length > MAX_DRM_URL_QUERY_VALUE_CHARS) {
      invalid(`${name} query parameter "${param}" exceeds ${MAX_DRM_URL_QUERY_VALUE_CHARS} characters`, label)
    }
  }
  if (url.href.length > MAX_DRM_URL_CHARS) invalid(`${name} must not exceed ${MAX_DRM_URL_CHARS} characters`, label)
  return url.href
}

function normalizeEntitlementRef(value, label) {
  if (value == null) return null
  const entitlementId = boundedString(value, 'entitlementId', MAX_ENTITLEMENT_ID_CHARS, label)
  if (!ENTITLEMENT_ID_RE.test(entitlementId)) invalid('entitlementId must be a safe identifier', label)
  return entitlementId
}

// The canonical public descriptor, shaped exactly like the
// `@peartube/media-drm-descriptor` wire message. Absent optional fields are
// explicit nulls so canonical encoding — and therefore rendition identity — is
// stable.
export function createProtectedRendition(input, options = {}) {
  const { allowClearKeyForTests = false } = options
  const label = options.label || 'protected rendition'
  if (input === null || typeof input !== 'object' || Array.isArray(input) || isBytes(input)) {
    invalid('descriptor must be an object', label)
  }
  assertNoSecretShapedProperties(input, { label })

  if (input.version != null && input.version !== PROTECTED_RENDITION_VERSION) {
    invalid(`version ${input.version} is not supported`, label)
  }

  return Object.freeze({
    version: PROTECTED_RENDITION_VERSION,
    scheme: normalizeProtectionScheme(input.scheme, label),
    drmSystem: normalizeDrmSystem(input.drmSystem, { allowClearKeyForTests, label }),
    keyId: normalizeKeyId(input.keyId, label),
    initData: normalizeInitData(input.initData, label),
    licenseEndpoint: normalizePublicHttpsUrl(input.licenseEndpoint, 'licenseEndpoint', label),
    certificateUrl: input.certificateUrl == null ? null : normalizePublicHttpsUrl(input.certificateUrl, 'certificateUrl', label),
    issuer: boundedString(input.issuer, 'issuer', MAX_DRM_ISSUER_CHARS, label),
    entitlementId: normalizeEntitlementRef(input.entitlementId, label),
  })
}

function canonicalProtectedRendition(descriptor) {
  const picked = {}
  for (const field of PROTECTED_RENDITION_FIELDS) {
    picked[field] = descriptor?.[field] === undefined ? null : descriptor[field]
  }
  return sortPlain(picked)
}

// Identity over the canonical public encoding: changing any field — key id,
// init data, scheme, endpoint, issuer — changes the digest, so a tampered
// protected rendition can never keep its place in a signed manifest.
export function protectedRenditionDigest(descriptor) {
  return b4a.toString(hashCanonical(PROTECTED_RENDITION_DIGEST_DOMAIN, canonicalProtectedRendition(descriptor)), 'hex')
}

// Never throws. A descriptor verifies only when it is already exactly the
// canonical form this module would have produced, with no extra properties.
export function verifyProtectedRendition(descriptor, options = {}) {
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) return false
  const keys = Object.keys(descriptor)
  if (keys.length !== PROTECTED_RENDITION_FIELDS.length) return false
  for (const field of PROTECTED_RENDITION_FIELDS) {
    if (!Object.hasOwn(descriptor, field)) return false
  }
  let canonical
  try {
    canonical = createProtectedRendition(descriptor, options)
  } catch {
    return false
  }
  return PROTECTED_RENDITION_FIELDS.every(field => canonical[field] === (descriptor[field] === undefined ? null : descriptor[field]))
}
