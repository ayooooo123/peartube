import b4a from 'b4a'

import { encodeCanonical, hashCanonical, toHex } from '../publisher/canonical.js'
import { createApplicationEnvelope, verifyApplicationEnvelope } from '../records/application-envelope.js'
import {
  assertProtocolCompatibility,
  createProtocolAdvertisement
} from '../network/version.js'

export const BOOTSTRAP_LOCATOR_RECORD_TYPE = 'peartube.bootstrap-locator.v1'
export const BOOTSTRAP_LOCATOR_CAPABILITY = 'bootstrap-locator:v1'
export const MAX_BOOTSTRAP_EXTRA_LOCATORS = 64
export const MAX_BOOTSTRAP_EXTRA_LOCATOR_BYTES = 512
export const MAX_BOOTSTRAP_EXTRA_LOCATORS_BYTES = 8_192
export const MAX_BOOTSTRAP_LABEL_BYTES = 2_048
export const MAX_BOOTSTRAP_LOCATOR_BODY_BYTES = 16_384

function fixedHex(value, name) {
  if (typeof value !== 'string') throw new Error(`${name} must be 32-byte hex`)
  const next = value.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(next)) throw new Error(`${name} must be 32-byte hex`)
  return next
}

function decodeBody(buffer) {
  try {
    return JSON.parse(b4a.toString(buffer, 'utf8'))
  } catch {
    return null
  }
}

function normalizeSafeInteger(value, name, { minimum = 0 } = {}) {
  const next = Number(value)
  if (!Number.isSafeInteger(next) || next < minimum) throw new Error(`${name} must be a safe integer`)
  return next
}

function normalizeLabel(value) {
  if (value == null) return null
  if (typeof value !== 'string') throw new Error('label must be a metadata string')
  if (b4a.byteLength(value) > MAX_BOOTSTRAP_LABEL_BYTES) throw new Error('label too large')
  return value
}

function normalizeExtraLocators(value) {
  if (!Array.isArray(value)) throw new Error('extra locators must be an array')
  if (value.length > MAX_BOOTSTRAP_EXTRA_LOCATORS) throw new Error('too many extra locators')
  let totalBytes = 0
  return value.map(locator => {
    if (typeof locator !== 'string' || locator.length === 0) {
      throw new Error('extra locator must be a non-empty metadata string')
    }
    const bytes = b4a.byteLength(locator)
    if (bytes > MAX_BOOTSTRAP_EXTRA_LOCATOR_BYTES) throw new Error('extra locator exceeds its byte limit')
    totalBytes += bytes
    if (totalBytes > MAX_BOOTSTRAP_EXTRA_LOCATORS_BYTES) throw new Error('extra locators exceed their total byte limit')
    return locator
  })
}

const BASE_BODY_FIELDS = Object.freeze([
  'version',
  'publisherId',
  'catalogBootstrapKey',
  'catalogHead',
  'catalogEpoch',
  'authorizationChainDigest',
  'rootSignerId',
  'issuedAt',
  'expiresAt',
  'label',
  'extraLocators',
])
const COMPATIBILITY_FIELDS = Object.freeze([
  'minimumProtocolMajor',
  'protocolMinor',
  'requiredCapabilities',
])

function normalizeBody(body, { preserveCompatibility = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('bootstrap locator body must be an object')
  const keys = Object.keys(body)
  const compatibilityCount = COMPATIBILITY_FIELDS.filter(field => Object.hasOwn(body, field)).length
  if (compatibilityCount !== 0 && compatibilityCount !== COMPATIBILITY_FIELDS.length) {
    throw new Error('bootstrap locator compatibility fields must be complete')
  }
  const allowed = new Set(compatibilityCount ? [...BASE_BODY_FIELDS, ...COMPATIBILITY_FIELDS] : BASE_BODY_FIELDS)
  for (const field of keys) if (!allowed.has(field)) throw new Error(`bootstrap locator body has unknown field ${field}`)
  for (const field of BASE_BODY_FIELDS) if (!Object.hasOwn(body, field)) throw new Error(`bootstrap locator body is missing field ${field}`)
  if (keys.length !== allowed.size) throw new Error('bootstrap locator body fields must be exact')
  if (body.version !== 1) throw new Error('bootstrap locator version is unsupported')

  const issuedAt = normalizeSafeInteger(body.issuedAt, 'issuedAt')
  const expiresAt = normalizeSafeInteger(body.expiresAt, 'expiresAt', { minimum: 1 })
  if (expiresAt <= issuedAt) throw new Error('expiresAt must be after issuedAt')
  const normalized = {
    version: 1,
    publisherId: fixedHex(body.publisherId, 'publisherId'),
    catalogBootstrapKey: fixedHex(body.catalogBootstrapKey, 'catalogBootstrapKey'),
    catalogHead: fixedHex(body.catalogHead, 'catalogHead'),
    catalogEpoch: normalizeSafeInteger(body.catalogEpoch, 'catalogEpoch'),
    authorizationChainDigest: fixedHex(body.authorizationChainDigest, 'authorizationChainDigest'),
    rootSignerId: body.rootSignerId == null ? null : fixedHex(body.rootSignerId, 'rootSignerId'),
    issuedAt,
    expiresAt,
    label: normalizeLabel(body.label),
    extraLocators: normalizeExtraLocators(body.extraLocators),
  }
  if (compatibilityCount) {
    Object.assign(normalized, preserveCompatibility
      ? Object.fromEntries(COMPATIBILITY_FIELDS.map(field => [field, body[field]]))
      : createProtocolAdvertisement(body, {
          requiredCapabilities: [BOOTSTRAP_LOCATOR_CAPABILITY],
        }))
  }
  return normalized
}

export function createBootstrapLocator(input = {}) {
  const compatibility = createProtocolAdvertisement(input, {
    requiredCapabilities: [BOOTSTRAP_LOCATOR_CAPABILITY],
  })
  const body = normalizeBody({
    version: 1,
    publisherId: fixedHex(input.publisherId, 'publisherId'),
    catalogBootstrapKey: fixedHex(input.catalogBootstrapKey, 'catalogBootstrapKey'),
    catalogHead: fixedHex(input.catalogHead, 'catalogHead'),
    catalogEpoch: input.catalogEpoch ?? 0,
    authorizationChainDigest: fixedHex(input.authorizationChainDigest, 'authorizationChainDigest'),
    rootSignerId: input.rootSignerId == null ? null : fixedHex(input.rootSignerId, 'rootSignerId'),
    issuedAt: input.issuedAt ?? Date.now(),
    expiresAt: input.expiresAt ?? 0,
    label: input.label ?? null,
    extraLocators: input.extraLocators || [],
    ...compatibility,
  })
  const encodedBody = encodeCanonical(body)
  if (encodedBody.byteLength > MAX_BOOTSTRAP_LOCATOR_BODY_BYTES) throw new Error('bootstrap locator body exceeds its byte limit')
  const envelope = createApplicationEnvelope({
    recordType: BOOTSTRAP_LOCATOR_RECORD_TYPE,
    body: encodedBody,
    keyPair: input.keyPair,
    issuedAt: body.issuedAt,
    expiresAt: body.expiresAt,
  })
  return { locatorId: toHex(hashCanonical('peartube.bootstrap-locator.id.v1', body)), body, envelope }
}

export async function verifyBootstrapLocator(envelope, options = {}) {
  if (!envelope?.body || envelope.body.byteLength > MAX_BOOTSTRAP_LOCATOR_BODY_BYTES) return false
  const decoded = decodeBody(envelope.body)
  if (!decoded) return false
  let body
  try {
    body = normalizeBody(decoded, { preserveCompatibility: true })
    if (!b4a.equals(encodeCanonical(body), envelope.body)) return false
  } catch {
    return false
  }
  const now = Number(options.now ?? Date.now())
  const skew = Number(options.maxClockSkewMs || 0)
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(skew) || skew < 0) return false
  if (body.expiresAt + skew < now) return false
  if (body.issuedAt - skew > now) return false
  // A locator is self-authenticating metadata. Unknown signers are retained as
  // *unverified candidates* for namespace proof, never treated as trust roots.
  // The optional allowlist is diagnostic/operational policy only.
  const signed = await verifyApplicationEnvelope(envelope, {
    recordType: BOOTSTRAP_LOCATOR_RECORD_TYPE,
    allowedSigners: [envelope?.signer],
    now,
  })
  assertProtocolCompatibility(body, {
    protocolMajor: options.protocolMajor,
    supportedCapabilities: options.supportedCapabilities || [BOOTSTRAP_LOCATOR_CAPABILITY],
    mandatoryCapabilities: [BOOTSTRAP_LOCATOR_CAPABILITY],
  })
  if (!signed) return false
  const signerId = envelope.signer ? toHex(envelope.signer) : null
  const trusted = (options.trustedSigners || []).some(candidate => toHex(candidate) === signerId)
  let catalogChainVerified = false
  if (body.rootSignerId && (options.trustedRootIds || []).includes(body.rootSignerId) && typeof options.verifyCatalogChain === 'function') {
    catalogChainVerified = Boolean(await options.verifyCatalogChain(body))
  }
  return { trusted, catalogChainVerified, acceptedHead: body.catalogHead, signerId, body }
}
