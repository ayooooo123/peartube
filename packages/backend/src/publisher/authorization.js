import {
  normalizeCapabilities,
  normalizeNonNegativeInteger,
  toHex,
} from './canonical.js'

function bodyHashHex(value) {
  return toHex(value, 32, 'bodyHash')
}

function writerKeyHex(value, name = 'writerKey') {
  return toHex(value, 32, name)
}

function cloneWriter(writer) {
  return {
    writerKey: writer.writerKey,
    capabilities: [...writer.capabilities],
    lastAcceptedSequence: writer.lastAcceptedSequence || 0,
    revoked: Boolean(writer.revoked),
    acceptedThroughSequence: writer.acceptedThroughSequence ?? null,
  }
}

export function createAuthorizationState(input = {}) {
  const rootKey = writerKeyHex(input.rootKey, 'rootKey')
  const writers = {}
  for (const writer of input.writers || []) {
    const writerKey = writerKeyHex(writer.writerKey, 'writerKey')
    writers[writerKey] = {
      writerKey,
      capabilities: normalizeCapabilities(writer.capabilities || []),
      lastAcceptedSequence: 0,
      revoked: false,
      acceptedThroughSequence: null,
    }
  }
  return {
    version: 1,
    rootKey,
    policyEpoch: normalizeNonNegativeInteger(input.policyEpoch, 'policyEpoch', 0),
    writers,
    accepted: {},
  }
}

function cloneState(state) {
  const next = {
    version: 1,
    rootKey: state.rootKey,
    policyEpoch: state.policyEpoch,
    writers: {},
    accepted: { ...(state.accepted || {}) },
  }
  for (const [key, writer] of Object.entries(state.writers || {})) next.writers[key] = cloneWriter(writer)
  return next
}

export function getWriterAuthorization(state, writerKey) {
  const key = writerKeyHex(writerKey, 'writerKey')
  const writer = state?.writers?.[key]
  return writer ? cloneWriter(writer) : null
}

function acceptedKey(writerKey, sequence) {
  return `${writerKey}:${sequence}`
}

function acceptedOperation(state, writerKey, sequence, bodyHash) {
  const key = acceptedKey(writerKey, sequence)
  const previous = state.accepted?.[key]
  if (!previous) return null
  if (previous === bodyHash) return { accepted: true, reason: 'already-accepted', state }
  return { accepted: false, reason: 'sequence-reuse-different-bytes', state }
}

function reject(state, reason) {
  return { accepted: false, reason, state }
}

function accept(state, reason = 'accepted') {
  return { accepted: true, reason, state }
}

function requireRoot(state, op) {
  return writerKeyHex(op.writerKey, 'writerKey') === state.rootKey
}

function applyWriterAuthorization(state, op) {
  if (!requireRoot(state, op)) return reject(state, 'root-authority-required')
  if (normalizeNonNegativeInteger(op.policyEpoch, 'policyEpoch', 0) !== state.policyEpoch) return reject(state, 'stale-policy-epoch')
  const next = cloneState(state)
  const targetWriterKey = writerKeyHex(op.targetWriterKey, 'targetWriterKey')
  next.writers[targetWriterKey] = {
    writerKey: targetWriterKey,
    capabilities: normalizeCapabilities(op.capabilities || []),
    lastAcceptedSequence: next.writers[targetWriterKey]?.lastAcceptedSequence || 0,
    revoked: false,
    acceptedThroughSequence: null,
  }
  next.policyEpoch++
  return accept(next)
}

function applyWriterRevocation(state, op) {
  if (!requireRoot(state, op)) return reject(state, 'root-authority-required')
  if (normalizeNonNegativeInteger(op.policyEpoch, 'policyEpoch', 0) !== state.policyEpoch) return reject(state, 'stale-policy-epoch')
  const next = cloneState(state)
  const targetWriterKey = writerKeyHex(op.targetWriterKey, 'targetWriterKey')
  const existing = next.writers[targetWriterKey]
  if (!existing) return reject(state, 'unknown-writer')
  existing.revoked = true
  existing.acceptedThroughSequence = normalizeNonNegativeInteger(
    op.acceptedThroughSequence,
    'acceptedThroughSequence',
    existing.lastAcceptedSequence || 0,
  )
  next.policyEpoch++
  return accept(next)
}

function applyWriterOperation(state, op) {
  const writerKey = writerKeyHex(op.writerKey, 'writerKey')
  const sequence = normalizeNonNegativeInteger(op.writerSequence, 'writerSequence', 0)
  const bodyHash = bodyHashHex(op.bodyHash)
  const accepted = acceptedOperation(state, writerKey, sequence, bodyHash)
  if (accepted) return accepted

  const writer = state.writers?.[writerKey]
  if (!writer) return reject(state, 'unknown-writer')
  if (writer.revoked && sequence > (writer.acceptedThroughSequence || 0)) return reject(state, 'writer-revoked')
  if (normalizeNonNegativeInteger(op.policyEpoch, 'policyEpoch', 0) !== state.policyEpoch) return reject(state, 'stale-policy-epoch')
  if (!writer.capabilities.includes(op.type)) return reject(state, 'missing-capability')
  if (sequence <= (writer.lastAcceptedSequence || 0)) return reject(state, 'non-monotonic-sequence')

  const next = cloneState(state)
  next.accepted[acceptedKey(writerKey, sequence)] = bodyHash
  next.writers[writerKey].lastAcceptedSequence = sequence
  return accept(next)
}

export function applyPublisherOperation(state, op = {}) {
  const current = cloneState(state)
  if (!op.type) return reject(current, 'missing-operation-type')
  if (op.type === 'writer:authorize') return applyWriterAuthorization(current, op)
  if (op.type === 'writer:revoke') return applyWriterRevocation(current, op)
  return applyWriterOperation(current, op)
}
