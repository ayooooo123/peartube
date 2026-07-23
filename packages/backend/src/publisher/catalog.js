import b4a from 'b4a'

import {
  applyPublisherOperation,
} from './authorization.js'
import {
  normalizeNonNegativeInteger,
  sortPlain,
  toHex,
} from './canonical.js'

function writerKeyHex(value) {
  return toHex(value, 32, 'writerKey')
}

function bodyHashHex(value) {
  return toHex(value, 32, 'bodyHash')
}

function operationKey(op) {
  return `${writerKeyHex(op.writerKey)}:${normalizeNonNegativeInteger(op.writerSequence, 'writerSequence', 0)}`
}

function cloneState(state) {
  return {
    version: 1,
    publisherId: state.publisherId,
    authorizationState: state.authorizationState,
    publications: { ...(state.publications || {}) },
    operations: { ...(state.operations || {}) },
  }
}

function normalizePublication(op = {}) {
  if (typeof op.publicationId !== 'string' || op.publicationId.length === 0) throw new Error('publicationId is required')
  if (typeof op.manifestId !== 'string' || op.manifestId.length === 0) throw new Error('manifestId is required')
  return {
    publicationId: op.publicationId,
    manifestId: op.manifestId,
    writerKey: writerKeyHex(op.writerKey),
    writerSequence: normalizeNonNegativeInteger(op.writerSequence, 'writerSequence', 0),
    bodyHash: bodyHashHex(op.bodyHash || b4a.alloc(32)),
    claims: Array.isArray(op.claims) ? sortPlain(op.claims) : [],
  }
}

export function createPublisherCatalogState(input = {}) {
  if (!input.publisherId) throw new Error('publisherId is required')
  if (!input.authorizationState) throw new Error('authorizationState is required')
  return {
    version: 1,
    publisherId: input.publisherId,
    authorizationState: input.authorizationState,
    publications: {},
    operations: {},
  }
}

export function getCatalogPublications(state) {
  return Object.values(state.publications || {})
    .map(item => ({ ...item, claims: sortPlain(item.claims || []) }))
    .sort((left, right) => {
      if (left.publicationId !== right.publicationId) return left.publicationId.localeCompare(right.publicationId)
      if (left.manifestId !== right.manifestId) return left.manifestId.localeCompare(right.manifestId)
      if (left.writerKey !== right.writerKey) return left.writerKey.localeCompare(right.writerKey)
      return left.writerSequence - right.writerSequence
    })
}

export function applyCatalogOperation(state, op = {}) {
  try {
    const key = operationKey(op)
    const bodyHash = bodyHashHex(op.bodyHash || b4a.alloc(32))
    const previousOperation = state.operations?.[key]
    if (previousOperation) {
      if (previousOperation.bodyHash === bodyHash) return { accepted: true, reason: 'already-accepted', state }
      return { accepted: false, reason: 'sequence-reuse-different-bytes', state }
    }

    const authResult = applyPublisherOperation(state.authorizationState, op)
    if (!authResult.accepted) return { accepted: false, reason: authResult.reason, state }
    if (authResult.reason === 'already-accepted') return { accepted: true, reason: 'already-accepted', state }

    const publication = normalizePublication(op)
    const next = cloneState(state)
    next.authorizationState = authResult.state
    next.operations[key] = {
      key,
      writerKey: publication.writerKey,
      writerSequence: publication.writerSequence,
      bodyHash,
      publicationId: publication.publicationId,
      manifestId: publication.manifestId,
    }
    next.publications[publication.publicationId] = publication
    return { accepted: true, reason: 'accepted', state: next }
  } catch (error) {
    return { accepted: false, reason: error?.message || 'invalid-catalog-operation', state }
  }
}
