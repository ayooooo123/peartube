import b4a from 'b4a'

import {
  encodeSignedEnvelope,
  encodeMultiSignedEnvelope
} from '../records/index.js'
import { assertBytes, assertUint, equalBytes, isBytes } from '../records/canonical.js'
import {
  PUBLISHER_RECORD_TYPES,
  decodePublisherOperationBody,
  isPublisherRecordType,
  requiredPublisherCapability
} from './canonical.js'
import {
  decodePublisherNamespaceDescriptor,
  encodePublisherNamespaceDescriptor,
  verifyPublisherNamespaceDescriptor
} from './namespace.js'
import { createPublisherKeyProvider } from './key-provider.js'

const ROOT_RECORD_TYPES = new Set([
  PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
  PUBLISHER_RECORD_TYPES.WRITER_REVOCATION
])
const DATA_RECORD_TYPES = new Set([
  PUBLISHER_RECORD_TYPES.PUBLICATION,
  PUBLISHER_RECORD_TYPES.CLAIM,
  PUBLISHER_RECORD_TYPES.COLLECTION_RELEASE,
  PUBLISHER_RECORD_TYPES.RETRACTION,
  PUBLISHER_RECORD_TYPES.OWNER_ACTION,
  PUBLISHER_RECORD_TYPES.VIEW_HEAD
])

class AuthorizationFailure extends Error {
  constructor (code, message) {
    super(message)
    this.code = code
  }
}

function fail (code, message) {
  throw new AuthorizationFailure(code, message)
}

function bytesHex (value, name = 'key') {
  assertBytes(value, 32, name)
  return b4a.toString(value, 'hex')
}

function clone (value) {
  return b4a.from(value)
}

function operationId (value) {
  const id = value?.recordId || value?.transitionId
  assertBytes(id, 32, 'operationId')
  return id
}

function encodedOperation (value) {
  return value?.transitionId ? encodeMultiSignedEnvelope(value) : encodeSignedEnvelope(value)
}

function rootSequenceKey (sequence) {
  return `root:${sequence}`
}

function writerSequenceKey (signerKey, sequence) {
  return `${bytesHex(signerKey, 'signerKey')}:${sequence}`
}

function exactReplay (state, value) {
  const idHex = bytesHex(operationId(value), 'operationId')
  const prior = state.acceptedFrames.get(idHex)
  if (!prior) return null
  const encoded = encodedOperation(value)
  if (!b4a.equals(prior, encoded)) fail('REPLAY_CONFLICT', 'operation ID was reused with different canonical bytes')
  return result(false, 'DUPLICATE', state, value, null, null)
}

function result (accepted, code, state, value, body, effect, error = null) {
  return { accepted, code, state, value, body, effect, error }
}

function rememberAccepted (state, value, sequenceKey) {
  const idHex = bytesHex(operationId(value), 'operationId')
  state.acceptedRecordIds.add(idHex)
  state.acceptedFrames.set(idHex, encodedOperation(value))
  if (sequenceKey) state.sequenceRecordIds.set(sequenceKey, idHex)
}

function assertSchema (value) {
  if (value?.schemaMajor !== 1 || value?.schemaMinor !== 0) fail('UNSUPPORTED_SCHEMA', 'publisher operation schema is not supported')
  if (!isPublisherRecordType(value?.recordType)) fail('UNKNOWN_RECORD_TYPE', `unknown publisher record type ${value?.recordType || ''}`)
  if (value.recordType === PUBLISHER_RECORD_TYPES.NAMESPACE) fail('CONFLICTING_NAMESPACE', 'namespace genesis cannot be applied to initialized authorization state')
  if (!equalBytes(value.issuerIdentityKey, value.issuerIdentityKey)) fail('MALFORMED_OPERATION', 'issuer identity is invalid')
}

function assertIssuer (state, value) {
  if (!equalBytes(state.publisherId, value.issuerIdentityKey)) fail('ISSUER_MISMATCH', 'operation issuer is not this publisher')
}

function sequenceAvailable (state, key, value) {
  const candidate = bytesHex(operationId(value), 'operationId')
  const prior = state.sequenceRecordIds.get(key)
  if (!prior) return
  if (prior === candidate) fail('DUPLICATE', 'operation is already accepted')
  fail('SEQUENCE_CONFLICT', 'issuer sequence is already bound to different bytes')
}

function verifyRootSigned (state, value, keyProvider) {
  const sequenceKey = rootSequenceKey(value.issuerSequence)
  sequenceAvailable(state, sequenceKey, value)
  if (value.policyEpoch !== state.policyEpoch) fail('STALE_POLICY_EPOCH', 'root operation policy epoch is stale')
  if (value.issuerSequence !== state.policySequence + 1) fail('POLICY_SEQUENCE_NOT_MONOTONIC', 'root policy sequence must advance exactly once')
  if (!equalBytes(value.signerKey, state.activeRootKey)) fail('ROOT_AUTHORITY_REQUIRED', 'operation is not signed by the active root')
  try {
    keyProvider.verifySignedEnvelope(value, {
      issuerIdentityKey: state.publisherId,
      policyEpoch: state.policyEpoch,
      authorizeSigner: candidate => equalBytes(candidate.signerKey, state.activeRootKey),
      authorizeSequence: candidate => candidate.issuerSequence === state.policySequence + 1,
      claimReplay: () => true,
      now: value.signedAt,
      maxClockSkew: 0
    })
  } catch (error) {
    fail('SIGNATURE_REJECTED', error?.message || 'root signature verification failed')
  }
  return sequenceKey
}

function verifyWriterSigned (state, value, body, writer, sourceWriterKey, keyProvider) {
  if (!sourceWriterKey || !equalBytes(sourceWriterKey, writer.writerKey)) fail('SOURCE_WRITER_MISMATCH', 'envelope signer is not bound to the Autobase source writer')
  const sequenceKey = writerSequenceKey(value.signerKey, value.issuerSequence)
  sequenceAvailable(state, sequenceKey, value)
  if (value.issuerSequence < writer.firstAcceptedSequence) fail('SEQUENCE_BEFORE_ADMISSION', 'writer sequence predates admission')
  if (value.signedAt > writer.expiresAt) fail('WRITER_EXPIRED', 'writer signed after its bounded admission expiry')
  const capability = requiredPublisherCapability(value.recordType, body)
  if (!capability || !writer.capabilities.includes(capability)) fail('CAPABILITY_REQUIRED', `writer lacks ${capability || 'required'} capability`)
  try {
    keyProvider.verifySignedEnvelope(value, {
      issuerIdentityKey: state.publisherId,
      policyEpoch: value.policyEpoch,
      authorizeSigner: candidate => equalBytes(candidate.signerKey, writer.signerKey),
      authorizeSequence: candidate => candidate.issuerSequence === value.issuerSequence,
      claimReplay: () => true,
      now: value.signedAt,
      maxClockSkew: 0
    })
  } catch (error) {
    fail('SIGNATURE_REJECTED', error?.message || 'writer signature verification failed')
  }
  if (value.issuerSequence <= writer.lastAcceptedSequence) fail('WRITER_SEQUENCE_NOT_MONOTONIC', 'writer sequence must increase with its bound Autobase source feed')
  let cutoff = false
  if (value.policyEpoch < writer.admissionPolicyEpoch) fail('POLICY_EPOCH_BEFORE_ADMISSION', 'writer operation policy epoch predates its admission')
  if (writer.revocation) {
    if (value.policyEpoch > writer.revocation.revokedFromEpoch || value.issuerSequence > writer.revocation.acceptedThroughSequence) fail('REVOKED_WRITER', 'writer operation exceeds the root-authorized revocation cutoff')
    cutoff = true
  } else if (value.policyEpoch !== state.policyEpoch) {
    fail('STALE_POLICY_EPOCH', 'writer operation policy epoch is stale')
  }
  return { sequenceKey, cutoff }
}

function updateDescriptorPolicy (state) {
  state.descriptor = {
    ...state.descriptor,
    publisherRootKey: clone(state.activeRootKey),
    catalogEpoch: state.catalogEpoch,
    profileRef: clone(state.profileRef),
    policySequence: state.policySequence,
    recoveryKeys: state.recoveryKeys.map(clone),
    recoveryThreshold: state.recoveryThreshold
  }
}

function applyAdmission (state, value, keyProvider) {
  const sequenceKey = verifyRootSigned(state, value, keyProvider)
  const body = decodePublisherOperationBody(value.recordType, value.canonicalBody)
  const writerId = bytesHex(body.writerKey, 'writerKey')
  const previous = state.writers.get(writerId)
  const signerId = bytesHex(body.signerKey, 'signerKey')
  const signerOwner = state.signers.get(signerId)
  if (previous && !previous.revocation) fail('WRITER_ALREADY_ACTIVE', 'writer is already admitted')
  if (signerOwner) fail('SIGNER_ALREADY_BOUND', 'signer key remains bound to its original writer generation')
  if (body.expiresAt < value.signedAt) fail('WRITER_EXPIRY_INVALID', 'writer admission expires before it is signed')
  if (previous?.revocation && body.firstAcceptedSequence <= Math.max(previous.revocation.acceptedThroughSequence, previous.lastAcceptedSequence)) fail('SEQUENCE_BEFORE_ADMISSION', 'readmission sequence must advance beyond the prior cutoff and historical source sequence')
  const writer = {
    writerKey: clone(body.writerKey),
    signerKey: clone(body.signerKey),
    capabilities: [...body.capabilities],
    firstAcceptedSequence: body.firstAcceptedSequence,
    lastAcceptedSequence: body.firstAcceptedSequence - 1,
    expiresAt: body.expiresAt,
    admissionNonce: clone(body.admissionNonce),
    admissionPolicyEpoch: state.policyEpoch,
    revocation: null
  }
  state.writers.set(writerId, writer)
  state.signers.set(signerId, writer)
  state.policySequence = value.issuerSequence
  updateDescriptorPolicy(state)
  rememberAccepted(state, value, sequenceKey)
  return result(true, 'ACCEPTED', state, value, body, { type: 'add-writer', writerKey: clone(body.writerKey) })
}

function applyRevocation (state, value, keyProvider) {
  const sequenceKey = verifyRootSigned(state, value, keyProvider)
  const body = decodePublisherOperationBody(value.recordType, value.canonicalBody)
  if (body.newPolicyEpoch !== state.policyEpoch + 1) fail('POLICY_EPOCH_NOT_MONOTONIC', 'revocation policy epoch must advance exactly once')
  for (const entry of body.revocations) {
    const writer = state.writers.get(bytesHex(entry.writerKey, 'writerKey'))
    if (!writer || writer.revocation) fail('WRITER_NOT_ACTIVE', 'revocation names a writer that is not active')
  }
  const removed = []
  for (const entry of body.revocations) {
    const writer = state.writers.get(bytesHex(entry.writerKey, 'writerKey'))
    writer.revocation = {
      revokedFromEpoch: state.policyEpoch,
      revokedAtEpoch: body.newPolicyEpoch,
      acceptedThroughSequence: entry.acceptedThroughSequence
    }
    removed.push(clone(entry.writerKey))
  }
  state.policyEpoch = body.newPolicyEpoch
  state.policySequence = value.issuerSequence
  updateDescriptorPolicy(state)
  rememberAccepted(state, value, sequenceKey)
  return result(true, 'ACCEPTED', state, value, body, { type: 'remove-writers', writerKeys: removed })
}

function applyTransition (state, value, keyProvider) {
  if (value.recordType !== PUBLISHER_RECORD_TYPES.ROOT_TRANSITION) fail('UNKNOWN_RECORD_TYPE', 'not a root transition')
  const sequenceKey = rootSequenceKey(value.issuerSequence)
  sequenceAvailable(state, sequenceKey, value)
  if (value.policyEpoch !== state.policyEpoch) fail('STALE_POLICY_EPOCH', 'transition policy epoch is stale')
  if (value.issuerSequence !== state.policySequence + 1) fail('POLICY_SEQUENCE_NOT_MONOTONIC', 'transition policy sequence must advance exactly once')
  const body = decodePublisherOperationBody(value.recordType, value.canonicalBody)
  if (!equalBytes(body.previousRootKey, state.activeRootKey)) fail('FORKED_ROOT_TRANSITION', 'transition previous root is not active')
  if (body.newCatalogEpoch !== state.catalogEpoch + 1) fail('CATALOG_EPOCH_NOT_MONOTONIC', 'catalog epoch must advance exactly once')
  if (body.mode === 'recovery' && (state.recoveryThreshold === 0 || state.recoveryKeys.length === 0)) fail('RECOVERY_DISABLED', 'publisher recovery is disabled by the committed policy')
  const signerPolicy = body.mode === 'rotation'
    ? { requiredSignerKeys: [state.activeRootKey, body.newRootKey], quorumSignerKeys: [], quorum: 0 }
    : { requiredSignerKeys: [body.newRootKey], quorumSignerKeys: state.recoveryKeys, quorum: state.recoveryThreshold }
  signerPolicy.requiredSignerKeys = signerPolicy.requiredSignerKeys.map(clone).sort(b4a.compare)
  signerPolicy.quorumSignerKeys = signerPolicy.quorumSignerKeys.map(clone).sort(b4a.compare)
  try {
    keyProvider.verifyMultiSignedEnvelope(value, {
      issuerIdentityKey: state.publisherId,
      policyEpoch: state.policyEpoch,
      expectedSequence: state.policySequence + 1,
      signerPolicy,
      claimReplay: () => true
    })
  } catch (error) {
    fail('SIGNER_POLICY_REJECTED', error?.message || 'root transition signer policy failed')
  }
  const previousRootKey = clone(state.activeRootKey)
  state.activeRootKey = clone(body.newRootKey)
  state.catalogEpoch = body.newCatalogEpoch
  state.policySequence = value.issuerSequence
  state.recoveryKeys = body.recoveryKeys.map(clone)
  state.recoveryThreshold = body.recoveryThreshold
  state.profileRef = clone(body.profileRef)
  state.descriptor = {
    publisherId: clone(state.publisherId),
    publisherRootKey: clone(state.activeRootKey),
    catalogBootstrapKey: clone(state.catalogBootstrapKey),
    catalogEpoch: state.catalogEpoch,
    profileRef: clone(state.profileRef),
    policySequence: state.policySequence,
    recoveryKeys: state.recoveryKeys.map(clone),
    recoveryThreshold: state.recoveryThreshold,
    minimumProtocolMajor: state.descriptor.minimumProtocolMajor,
    protocolMinor: state.descriptor.protocolMinor,
    requiredCapabilities: [...state.descriptor.requiredCapabilities],
    previousRootKey,
    rootTransitionProof: clone(value.transitionId)
  }
  rememberAccepted(state, value, sequenceKey)
  return result(true, 'ACCEPTED', state, value, body, { type: 'root-transition', previousRootKey, newRootKey: clone(body.newRootKey) })
}

export function publisherProjectionIdentity (recordType, body, value) {
  switch (recordType) {
    case PUBLISHER_RECORD_TYPES.PUBLICATION: return { kind: 'publication', id: body.publicationId }
    case PUBLISHER_RECORD_TYPES.CLAIM: return { kind: 'claim', id: body.claimId }
    case PUBLISHER_RECORD_TYPES.COLLECTION_RELEASE: return { kind: 'collection', id: body.collectionId }
    case PUBLISHER_RECORD_TYPES.OWNER_ACTION: return { kind: `owner-${body.targetType}`, id: body.targetId }
    case PUBLISHER_RECORD_TYPES.VIEW_HEAD: return { kind: 'view-head', id: value.recordId }
    case PUBLISHER_RECORD_TYPES.RETRACTION: return { kind: `retraction-${body.targetType}`, id: body.targetId }
    default: return null
  }
}

function applyWriterOperation (state, value, sourceWriterKey, keyProvider) {
  const body = decodePublisherOperationBody(value.recordType, value.canonicalBody)
  const writer = state.signers.get(bytesHex(value.signerKey, 'signerKey'))
  if (!writer) fail('WRITER_NOT_ADMITTED', 'signature is valid only if the signer is an admitted publisher writer')
  const { sequenceKey, cutoff } = verifyWriterSigned(state, value, body, writer, sourceWriterKey, keyProvider)
  const identity = publisherProjectionIdentity(value.recordType, body, value)
  writer.lastAcceptedSequence = value.issuerSequence
  rememberAccepted(state, value, sequenceKey)
  return result(true, cutoff ? 'ACCEPTED_THROUGH_CUTOFF' : 'ACCEPTED', state, value, body, { type: 'projection', identity })
}

export function createPublisherAuthorizationState (descriptor) {
  verifyPublisherNamespaceDescriptor(descriptor)
  const canonicalDescriptor = decodePublisherNamespaceDescriptor(encodePublisherNamespaceDescriptor(descriptor))
  return {
    descriptor: canonicalDescriptor,
    publisherId: clone(canonicalDescriptor.publisherId),
    catalogBootstrapKey: clone(canonicalDescriptor.catalogBootstrapKey),
    activeRootKey: clone(canonicalDescriptor.publisherRootKey),
    catalogEpoch: canonicalDescriptor.catalogEpoch,
    policyEpoch: 0,
    policySequence: canonicalDescriptor.policySequence,
    profileRef: clone(canonicalDescriptor.profileRef),
    recoveryKeys: canonicalDescriptor.recoveryKeys.map(clone),
    recoveryThreshold: canonicalDescriptor.recoveryThreshold,
    writers: new Map(),
    signers: new Map(),
    acceptedRecordIds: new Set(),
    acceptedFrames: new Map(),
    sequenceRecordIds: new Map()
  }
}

export function clonePublisherAuthorizationState (state) {
  if (!state || !(state.writers instanceof Map) || !(state.signers instanceof Map)) throw new TypeError('publisher authorization state is invalid')
  const writerCopies = new Map()
  const copyWriter = writer => {
    if (writerCopies.has(writer)) return writerCopies.get(writer)
    const copied = {
      writerKey: clone(writer.writerKey),
      signerKey: clone(writer.signerKey),
      capabilities: [...writer.capabilities],
      firstAcceptedSequence: writer.firstAcceptedSequence,
      lastAcceptedSequence: writer.lastAcceptedSequence,
      expiresAt: writer.expiresAt,
      admissionNonce: clone(writer.admissionNonce),
      admissionPolicyEpoch: writer.admissionPolicyEpoch,
      revocation: writer.revocation ? { ...writer.revocation } : null
    }
    writerCopies.set(writer, copied)
    return copied
  }
  return {
    descriptor: decodePublisherNamespaceDescriptor(encodePublisherNamespaceDescriptor(state.descriptor)),
    publisherId: clone(state.publisherId),
    catalogBootstrapKey: clone(state.catalogBootstrapKey),
    activeRootKey: clone(state.activeRootKey),
    catalogEpoch: state.catalogEpoch,
    policyEpoch: state.policyEpoch,
    policySequence: state.policySequence,
    profileRef: clone(state.profileRef),
    recoveryKeys: state.recoveryKeys.map(clone),
    recoveryThreshold: state.recoveryThreshold,
    writers: new Map([...state.writers].map(([key, writer]) => [key, copyWriter(writer)])),
    signers: new Map([...state.signers].map(([key, writer]) => [key, copyWriter(writer)])),
    acceptedRecordIds: new Set(state.acceptedRecordIds),
    acceptedFrames: new Map([...state.acceptedFrames].map(([key, frame]) => [key, clone(frame)])),
    sequenceRecordIds: new Map(state.sequenceRecordIds)
  }
}

export function reducePublisherOperation (state, value, { keyProvider = createPublisherKeyProvider(), sourceWriterKey = null } = {}) {
  try {
    if (!state || !(state.writers instanceof Map)) fail('INVALID_AUTHORIZATION_STATE', 'authorization state is invalid')
    if (!value || typeof value !== 'object') fail('MALFORMED_OPERATION', 'operation must be an object')
    const replay = exactReplay(state, value)
    if (replay) return replay
    assertSchema(value)
    assertIssuer(state, value)
    if (value.recordType === PUBLISHER_RECORD_TYPES.ROOT_TRANSITION) return applyTransition(state, value, keyProvider)
    if (ROOT_RECORD_TYPES.has(value.recordType)) return value.recordType === PUBLISHER_RECORD_TYPES.WRITER_ADMISSION
      ? applyAdmission(state, value, keyProvider)
      : applyRevocation(state, value, keyProvider)
    if (DATA_RECORD_TYPES.has(value.recordType)) return applyWriterOperation(state, value, sourceWriterKey, keyProvider)
    fail('UNKNOWN_RECORD_TYPE', `unknown publisher record type ${value.recordType}`)
  } catch (error) {
    if (error instanceof AuthorizationFailure) return result(false, error.code, state, value, null, null, error.message)
    return result(false, 'MALFORMED_OPERATION', state, value, null, null, error?.message || String(error))
  }
}

export function comparePublisherOperationEntries (left, right) {
  const a = left.value
  const b = right.value
  const aRoot = ROOT_RECORD_TYPES.has(a.recordType) || a.recordType === PUBLISHER_RECORD_TYPES.ROOT_TRANSITION
  const bRoot = ROOT_RECORD_TYPES.has(b.recordType) || b.recordType === PUBLISHER_RECORD_TYPES.ROOT_TRANSITION
  if (aRoot !== bRoot) return aRoot ? -1 : 1
  if (a.policyEpoch !== b.policyEpoch) return a.policyEpoch - b.policyEpoch
  if (a.issuerSequence !== b.issuerSequence) return a.issuerSequence - b.issuerSequence
  const signerOrder = a.signerKey && b.signerKey ? b4a.compare(a.signerKey, b.signerKey) : 0
  if (signerOrder !== 0) return signerOrder
  return b4a.compare(operationId(a), operationId(b))
}

export function reducePublisherOperations (descriptor, entries, { keyProvider = createPublisherKeyProvider() } = {}) {
  if (!Array.isArray(entries)) throw new TypeError('publisher operation entries must be an array')
  const state = createPublisherAuthorizationState(descriptor)
  // Deterministic order selects among candidates only after authorization.
  // Invalid signatures, source writers, memberships, roles, epochs, and bodies
  // never reserve a claimed signer sequence.
  const ordered = [...entries].sort(comparePublisherOperationEntries)
  const accepted = []
  const rejected = []
  for (const entry of ordered) {
    const reduced = reducePublisherOperation(state, entry.value, { keyProvider, sourceWriterKey: entry.sourceWriterKey })
    if (reduced.accepted || reduced.code === 'DUPLICATE') accepted.push(reduced)
    else rejected.push(reduced)
  }
  return { state, accepted, rejected }
}

export function encodePublisherAuthorizationState (state) {
  const descriptor = encodePublisherNamespaceDescriptor(state.descriptor)
  const writerEntries = [...state.writers.values()].sort((left, right) => b4a.compare(left.writerKey, right.writerKey))
  const chunks = [b4a.from([1]), descriptor, b4a.from([0])]
  const metadata = {
    policyEpoch: state.policyEpoch,
    policySequence: state.policySequence,
    writers: writerEntries.map(writer => ({
      key: bytesHex(writer.writerKey),
      signerKey: bytesHex(writer.signerKey),
      capabilities: writer.capabilities,
      firstAcceptedSequence: writer.firstAcceptedSequence,
      lastAcceptedSequence: writer.lastAcceptedSequence,
      expiresAt: writer.expiresAt,
      admissionPolicyEpoch: writer.admissionPolicyEpoch,
      revocation: writer.revocation
    }))
  }
  const json = b4a.from(JSON.stringify(metadata))
  chunks[2] = b4a.from([json.byteLength & 255, (json.byteLength >>> 8) & 255, (json.byteLength >>> 16) & 255, (json.byteLength >>> 24) & 255])
  return b4a.concat([chunks[0], chunks[2], descriptor, json])
}
