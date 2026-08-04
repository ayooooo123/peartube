// A signed, entirely PUBLIC provider descriptor: it says which provider issues
// licenses for a protected rendition, where an entitled player authenticates,
// which redirect origins that flow may return to, and which DRM systems the
// provider serves. It carries no token, no credential, and no license payload —
// those exist only transiently in the app-owned authentication coordinator, in
// SecureStore/keychain, and inside the platform CDM. The same refusal predicate
// that guards protected renditions guards this input, so provider secrets
// cannot be smuggled into a signed record that peers replicate.

import b4a from 'b4a'

import { encodeCanonical, hashCanonical, normalizeNonNegativeInteger, sortPlain, toHex } from '../publisher/canonical.js'
import {
  createApplicationEnvelope,
  decodeApplicationEnvelope,
  encodeApplicationEnvelope,
  verifyApplicationEnvelope,
} from '../records/application-envelope.js'
import {
  MAX_DRM_ISSUER_CHARS,
  PROTECTED_DRM_SYSTEMS,
  PUBLIC_DRM_PROPERTY_NAMES,
  TEST_ONLY_DRM_SYSTEMS,
  assertNoSecretShapedProperties,
  normalizeDrmSystem,
  normalizePublicHttpsUrl,
} from './protected-rendition.js'

export const ENTITLEMENT_DESCRIPTOR_VERSION = 1
export const ENTITLEMENT_DESCRIPTOR_ID_DOMAIN = 'peartube.access.entitlement-descriptor.v1'
export const ENTITLEMENT_DESCRIPTOR_RECORD_TYPE = 'peartube.access.entitlement-descriptor.v1'

export const MAX_ENTITLEMENT_REDIRECT_ORIGINS = 8
export const MAX_ENTITLEMENT_ORIGIN_CHARS = 256
export const MAX_ENTITLEMENT_DRM_SYSTEMS = PROTECTED_DRM_SYSTEMS.length + TEST_ONLY_DRM_SYSTEMS.length

export const ENTITLEMENT_DESCRIPTOR_FIELDS = Object.freeze([
  'version',
  'entitlementId',
  'providerId',
  'issuer',
  'authorizationEndpoint',
  'licenseEndpoint',
  'certificateUrl',
  'allowedRedirectOrigins',
  'drmSystems',
  'notBefore',
  'expiresAt',
])

const LABEL = 'entitlement descriptor'

function invalid(message) {
  throw new Error(`Invalid ${LABEL}: ${message}`)
}

function boundedString(value, name, max) {
  if (typeof value !== 'string') invalid(`${name} must be a string`)
  if (value.length === 0) invalid(`${name} must not be empty`)
  if (value.length > max) invalid(`${name} must not exceed ${max} characters`)
  return value
}

function boundedList(value, name, max) {
  if (!Array.isArray(value) || value.length === 0) invalid(`${name} must be a non-empty array`)
  if (value.length > max) invalid(`${name} must not exceed ${max} entries`)
  return value
}

// Redirect origins are exact HTTPS origins. A wildcard origin would let any
// host under a provider's domain receive an authentication redirect, so it is
// refused outright rather than pattern-matched.
export function normalizeExactHttpsOrigin(value) {
  const raw = boundedString(value, 'allowedRedirectOrigins entry', MAX_ENTITLEMENT_ORIGIN_CHARS)
  if (raw.includes('*')) invalid('allowedRedirectOrigins must not contain a wildcard')
  if (!/^https:\/\//i.test(raw)) invalid('allowedRedirectOrigins must use https')
  let url
  try {
    url = new URL(raw)
  } catch {
    invalid('allowedRedirectOrigins entry is not a valid URL')
  }
  if (url.protocol !== 'https:') invalid('allowedRedirectOrigins must use https')
  if (url.username || url.password) invalid('allowedRedirectOrigins must not embed credentials')
  if (!url.hostname || url.hostname.includes('*')) invalid('allowedRedirectOrigins must name an exact host')
  if (url.search || url.hash) invalid('allowedRedirectOrigins must be a bare origin')
  if (url.pathname !== '/') invalid('allowedRedirectOrigins must be a bare origin')
  return url.origin
}

function normalizeDrmSystems(value, allowClearKeyForTests) {
  const systems = boundedList(value, 'drmSystems', MAX_ENTITLEMENT_DRM_SYSTEMS)
    .map(system => normalizeDrmSystem(system, { allowClearKeyForTests, label: LABEL }))
  const unique = [...new Set(systems)].sort()
  if (unique.length !== systems.length) invalid('drmSystems must not repeat a system')
  return unique
}

function normalizeRedirectOrigins(value) {
  const origins = boundedList(value, 'allowedRedirectOrigins', MAX_ENTITLEMENT_REDIRECT_ORIGINS)
    .map(normalizeExactHttpsOrigin)
  const unique = [...new Set(origins)].sort()
  if (unique.length !== origins.length) invalid('allowedRedirectOrigins must not repeat an origin')
  return unique
}

function unsignedEntitlementBody(input, options = {}) {
  const { allowClearKeyForTests = false } = options
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid('descriptor must be an object')
  assertNoSecretShapedProperties(input, { allowedNames: PUBLIC_DRM_PROPERTY_NAMES, label: LABEL })
  if (input.version != null && input.version !== ENTITLEMENT_DESCRIPTOR_VERSION) {
    invalid(`version ${input.version} is not supported`)
  }

  const notBefore = normalizeNonNegativeInteger(input.notBefore, 'notBefore')
  const expiresAt = normalizeNonNegativeInteger(input.expiresAt, 'expiresAt')
  if (notBefore === 0) invalid('notBefore is required')
  if (expiresAt === 0) invalid('expiresAt is required')
  if (expiresAt <= notBefore) invalid('expiresAt must be greater than notBefore')

  return sortPlain({
    version: ENTITLEMENT_DESCRIPTOR_VERSION,
    providerId: toHex(input.providerId, 32, 'providerId'),
    issuer: boundedString(input.issuer, 'issuer', MAX_DRM_ISSUER_CHARS),
    authorizationEndpoint: normalizePublicHttpsUrl(input.authorizationEndpoint, 'authorizationEndpoint', LABEL),
    licenseEndpoint: normalizePublicHttpsUrl(input.licenseEndpoint, 'licenseEndpoint', LABEL),
    certificateUrl: input.certificateUrl == null ? null : normalizePublicHttpsUrl(input.certificateUrl, 'certificateUrl', LABEL),
    allowedRedirectOrigins: normalizeRedirectOrigins(input.allowedRedirectOrigins),
    drmSystems: normalizeDrmSystems(input.drmSystems, allowClearKeyForTests),
    notBefore,
    expiresAt,
  })
}

// Derived from the canonical unsigned body, exactly like `manifestId`: the id is
// the content, so it cannot be claimed independently of what it describes.
export function deriveEntitlementId(input = {}, options = {}) {
  const unsignedBody = input.unsignedBody ? input.unsignedBody : unsignedEntitlementBody(input, options)
  return b4a.toString(hashCanonical(ENTITLEMENT_DESCRIPTOR_ID_DOMAIN, unsignedBody), 'hex')
}

export function createEntitlementDescriptor(input = {}, options = {}) {
  const unsignedBody = unsignedEntitlementBody(input, options)
  const entitlementId = deriveEntitlementId({ unsignedBody })
  const body = sortPlain({ entitlementId, unsignedBody, ...unsignedBody })
  const envelope = createApplicationEnvelope({
    recordType: ENTITLEMENT_DESCRIPTOR_RECORD_TYPE,
    body: encodeCanonical(body),
    keyPair: options.keyPair,
    issuedAt: unsignedBody.notBefore,
    expiresAt: unsignedBody.expiresAt,
  })
  if (toHex(envelope.signer, 32, 'signer') !== unsignedBody.providerId) {
    invalid('providerId must be the signing provider key')
  }
  return { entitlementId, body, envelope }
}

export function encodeEntitlementDescriptor(record) {
  if (!record?.body || !record?.envelope) throw new Error('entitlement descriptor is required')
  if (!b4a.equals(record.envelope.body, encodeCanonical(record.body))) {
    throw new Error('entitlement descriptor envelope body mismatch')
  }
  return encodeApplicationEnvelope(record.envelope)
}

export function decodeEntitlementDescriptor(input, options = {}) {
  const envelope = decodeApplicationEnvelope(input)
  let parsed
  try {
    parsed = JSON.parse(b4a.toString(envelope.body))
  } catch {
    throw new Error('entitlement descriptor body is not canonical JSON')
  }
  const unsignedBody = unsignedEntitlementBody(parsed?.unsignedBody, options)
  const entitlementId = deriveEntitlementId({ unsignedBody })
  const body = sortPlain({ entitlementId, unsignedBody, ...unsignedBody })
  if (!b4a.equals(envelope.body, encodeCanonical(body))) {
    throw new Error('entitlement descriptor body is noncanonical')
  }
  return { entitlementId, body, envelope }
}

// Mirrors verifyPublicationManifest: recompute the id from the signed body,
// require the signer to be the provider it claims to be, then let the envelope
// prove the signature. Validity is enforced against an injected clock; without
// one the descriptor fails closed.
export async function verifyEntitlementDescriptor(record, options = {}) {
  if (!record?.body || !record?.envelope) return false
  let unsignedBody
  try {
    unsignedBody = unsignedEntitlementBody(record.body.unsignedBody, options)
  } catch {
    return false
  }
  const expectedEntitlementId = deriveEntitlementId({ unsignedBody })
  if (record.entitlementId !== expectedEntitlementId) return false
  if (record.body.entitlementId !== expectedEntitlementId) return false

  let signer
  try {
    signer = record.envelope.signer ? toHex(record.envelope.signer, 32, 'signer') : null
  } catch {
    return false
  }
  if (signer !== unsignedBody.providerId) return false

  const now = options.now == null ? 0 : Number(options.now)
  if (!Number.isSafeInteger(now) || now <= 0) return false
  if (now < unsignedBody.notBefore) return false
  if (now > unsignedBody.expiresAt) return false

  let verified
  try {
    verified = await verifyApplicationEnvelope(record.envelope, {
      ...options,
      now,
      recordType: ENTITLEMENT_DESCRIPTOR_RECORD_TYPE,
    })
  } catch {
    return false
  }
  return Boolean(verified && b4a.equals(record.envelope.body, encodeCanonical(record.body)))
}
