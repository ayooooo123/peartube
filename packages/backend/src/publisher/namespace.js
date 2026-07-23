import b4a from 'b4a'

import {
  createMultiSignedEnvelope,
  verifyMultiSignedEnvelope,
} from '../records/index.js'
import {
  encodeCanonical,
  hashCanonical,
  normalizeBytes,
  normalizeNonNegativeInteger,
  sortPlain,
  toHex,
} from './canonical.js'

export const PUBLISHER_NAMESPACE_VERSION = 1
export const PUBLISHER_ID_DOMAIN = 'peartube.publisher.namespace.publisher-id.v1'
export const ROOT_TRANSITION_RECORD_TYPE = 'publisher.namespace.root-transition.v1'

export function derivePublisherId(rootPublicKey) {
  return `ptpub:${toHex(hashCanonical(PUBLISHER_ID_DOMAIN, { rootPublicKey: toHex(rootPublicKey) }))}`
}

function normalizeProfileRef(profileRef) {
  if (!profileRef) return null
  if (typeof profileRef !== 'object') throw new Error('profileRef must be an object')
  return sortPlain(profileRef)
}

function normalizeRecoveryKeys(keys = []) {
  if (!Array.isArray(keys)) throw new Error('recoveryKeys must be an array')
  return Array.from(new Set(keys.map((key) => toHex(key, 32, 'recoveryKey')))).sort()
}

export function createPublisherNamespaceDescriptor(input = {}) {
  const activeRootKey = toHex(input.activeRootKey, 32, 'activeRootKey')
  const catalogBootstrapKey = toHex(input.catalogBootstrapKey, 32, 'catalogBootstrapKey')
  const publisherId = input.publisherId || derivePublisherId(activeRootKey)
  const recoveryKeys = normalizeRecoveryKeys(input.recoveryKeys || [])
  const recoveryThreshold = normalizeNonNegativeInteger(input.recoveryThreshold, 'recoveryThreshold', recoveryKeys.length ? 1 : 0)
  if (recoveryThreshold > recoveryKeys.length) throw new Error('recoveryThreshold exceeds recovery key count')

  return {
    version: PUBLISHER_NAMESPACE_VERSION,
    publisherId,
    activeRootKey,
    catalogBootstrapKey,
    catalogEpoch: normalizeNonNegativeInteger(input.catalogEpoch, 'catalogEpoch', 0),
    profileRef: normalizeProfileRef(input.profileRef),
    policySequence: normalizeNonNegativeInteger(input.policySequence, 'policySequence', 0),
    recoveryKeys,
    recoveryThreshold,
    previousRoot: input.previousRoot ? toHex(input.previousRoot, 32, 'previousRoot') : null,
    transitionId: input.transitionId ? toHex(input.transitionId, 32, 'transitionId') : null,
  }
}

function createTransitionBody({ current, newRootKey, mode = 'rotation' }) {
  const toRoot = toHex(newRootKey, 32, 'newRootKey')
  return {
    version: 1,
    mode,
    publisherId: current.publisherId,
    fromRoot: current.activeRootKey,
    toRoot,
    fromCatalogEpoch: current.catalogEpoch,
    toCatalogEpoch: current.catalogEpoch + 1,
    fromPolicySequence: current.policySequence,
    toPolicySequence: current.policySequence + 1,
  }
}

function decodeTransitionBody(body) {
  const parsed = JSON.parse(b4a.toString(normalizeBytes(body, null, 'transition body'), 'utf8'))
  return sortPlain(parsed)
}

export function createRootTransition(input = {}) {
  const current = createPublisherNamespaceDescriptor(input.current || {})
  const body = createTransitionBody({
    current,
    newRootKey: input.newRootKey,
    mode: input.mode || 'rotation',
  })
  const bodyBytes = encodeCanonical(body)
  const envelope = createMultiSignedEnvelope({
    recordType: ROOT_TRANSITION_RECORD_TYPE,
    body: bodyBytes,
    keyPairs: input.keyPairs || [],
    issuedAt: input.issuedAt || 0,
    expiresAt: input.expiresAt || 0,
  })
  return {
    version: 1,
    mode: body.mode,
    body,
    envelope,
  }
}

function transitionMatchesCurrent(current, body) {
  return body?.version === 1 &&
    body.publisherId === current.publisherId &&
    body.fromRoot === current.activeRootKey &&
    body.fromCatalogEpoch === current.catalogEpoch &&
    body.toCatalogEpoch === current.catalogEpoch + 1 &&
    body.fromPolicySequence === current.policySequence &&
    body.toPolicySequence === current.policySequence + 1
}

export async function verifyPublisherRootTransition(input = {}) {
  const current = createPublisherNamespaceDescriptor(input.current || {})
  const transition = input.transition || {}
  const envelope = transition.envelope || transition
  let body
  try {
    body = decodeTransitionBody(envelope.body)
    if (!transitionMatchesCurrent(current, body)) {
      return { valid: false, reason: 'transition-current-mismatch' }
    }

    const rotationValid = await verifyMultiSignedEnvelope(envelope, {
      recordType: ROOT_TRANSITION_RECORD_TYPE,
      threshold: 1,
      allowedSigners: [current.activeRootKey],
      now: input.now || 0,
    }).catch(() => false)

    let recoveryValid = false
    if (!rotationValid && current.recoveryThreshold > 0) {
      recoveryValid = await verifyMultiSignedEnvelope(envelope, {
        recordType: ROOT_TRANSITION_RECORD_TYPE,
        threshold: current.recoveryThreshold,
        allowedSigners: current.recoveryKeys,
        now: input.now || 0,
      }).catch(() => false)
    }

    if (!rotationValid && !recoveryValid) return { valid: false, reason: 'unauthorized-transition' }

    const next = createPublisherNamespaceDescriptor({
      publisherId: current.publisherId,
      activeRootKey: body.toRoot,
      catalogBootstrapKey: current.catalogBootstrapKey,
      catalogEpoch: body.toCatalogEpoch,
      profileRef: current.profileRef,
      policySequence: body.toPolicySequence,
      recoveryKeys: current.recoveryKeys,
      recoveryThreshold: current.recoveryThreshold,
      previousRoot: current.activeRootKey,
      transitionId: envelope.transitionId,
    })
    return { valid: true, mode: body.mode, next, transitionId: next.transitionId }
  } catch (error) {
    return { valid: false, reason: error?.message || 'invalid-transition' }
  }
}
