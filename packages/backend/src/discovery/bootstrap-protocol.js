import b4a from 'b4a'

import { encodeCanonical, hashCanonical, toHex } from '../publisher/canonical.js'
import { createSignedEnvelope, verifySignedEnvelope } from '../records/signed-envelope.js'

export const BOOTSTRAP_LOCATOR_RECORD_TYPE = 'peartube.bootstrap-locator.v1'
export const MAX_BOOTSTRAP_EXTRA_LOCATORS = 64
export const MAX_BOOTSTRAP_LABEL_BYTES = 2048

function fixedHex(value, name) {
  const next = String(value || '').toLowerCase()
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

export function createBootstrapLocator(input = {}) {
  const extraLocators = input.extraLocators || []
  if (extraLocators.length > MAX_BOOTSTRAP_EXTRA_LOCATORS) throw new Error('too many extra locators')
  if (b4a.byteLength(input.label || '') > MAX_BOOTSTRAP_LABEL_BYTES) throw new Error('label too large')
  const body = {
    version: 1,
    publisherId: fixedHex(input.publisherId, 'publisherId'),
    catalogBootstrapKey: fixedHex(input.catalogBootstrapKey, 'catalogBootstrapKey'),
    catalogHead: fixedHex(input.catalogHead, 'catalogHead'),
    catalogEpoch: Number(input.catalogEpoch || 0),
    authorizationChainDigest: fixedHex(input.authorizationChainDigest, 'authorizationChainDigest'),
    rootSignerId: input.rootSignerId ? fixedHex(input.rootSignerId, 'rootSignerId') : null,
    issuedAt: Number(input.issuedAt || Date.now()),
    expiresAt: Number(input.expiresAt || 0),
    label: input.label || null,
    extraLocators,
  }
  if (!Number.isSafeInteger(body.expiresAt) || body.expiresAt <= body.issuedAt) throw new Error('expiresAt must be after issuedAt')
  const envelope = createSignedEnvelope({ recordType: BOOTSTRAP_LOCATOR_RECORD_TYPE, body: encodeCanonical(body), keyPair: input.keyPair, issuedAt: body.issuedAt, expiresAt: body.expiresAt })
  return { locatorId: toHex(hashCanonical('peartube.bootstrap-locator.id.v1', body)), body, envelope }
}

export async function verifyBootstrapLocator(envelope, options = {}) {
  if (!envelope?.body) return false
  const body = decodeBody(envelope.body)
  if (!body) return false
  const now = Number(options.now || Date.now())
  const skew = Number(options.maxClockSkewMs || 0)
  if (body.expiresAt + skew < now) return false
  if (body.issuedAt - skew > now) return false
  const trustedSigners = options.trustedSigners || []
  const signed = await verifySignedEnvelope(envelope, { recordType: BOOTSTRAP_LOCATOR_RECORD_TYPE, allowedSigners: trustedSigners, now })
  const signerId = envelope.signer ? toHex(envelope.signer) : null
  const trusted = Boolean(signed)
  let catalogChainVerified = false
  if (!trusted && body.rootSignerId && (options.trustedRootIds || []).includes(body.rootSignerId) && typeof options.verifyCatalogChain === 'function') {
    catalogChainVerified = Boolean(await options.verifyCatalogChain(body))
  }
  if (!trusted && !catalogChainVerified) return false
  return { trusted, catalogChainVerified, acceptedHead: body.catalogHead, signerId, body }
}
