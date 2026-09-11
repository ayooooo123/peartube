import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  createRenditionDescriptor,
  decodePublicationManifest,
  normalizeAssetCoreRefV2,
  verifyCatalogPublicationManifest,
} from '../assets/index.js'
import { decodeClaimBody, verifyMediaClaim } from '../media-graph/index.js'
import {
  decodeAcceptedEntry,
  decodePublisherCatalogFrame,
  decodePublisherNamespaceDescriptor,
  decodePublisherOperationBody,
  derivePublisherId,
  encodePublisherCatalogFrame,
  getPublisherAuthorizationState,
  getPublisherProjection,
  getPublisherViewHead,
  publisherProjectionIdentity,
  requiredPublisherCapability,
  verifyPublisherNamespaceDescriptor,
} from '../publisher/index.js'
import { createPublisherKeyProvider } from '../publisher/key-provider.js'
import { decodeApplicationEnvelope } from '../records/application-envelope.js'
import { INDEX_FEDERATION_PRIVATE } from './index-federation.js'

export const SOURCE_VERIFICATION_ERROR_CODES = Object.freeze({
  CANDIDATE_EXPIRED: 'candidate-expired',
  SOURCE_INVALID: 'source-invalid',
  SOURCE_NOT_CURRENT: 'source-not-current',
  SOURCE_MISMATCH: 'source-mismatch',
  AVAILABILITY_TIMEOUT: 'availability-timeout',
  VERIFICATION_TIMEOUT: 'verification-timeout',
  AVAILABILITY_INVALID: 'availability-invalid',
  UNAVAILABLE: 'unavailable',
  ABORTED: 'aborted',
  VERIFIER_CLOSED: 'verifier-closed',
})

const DEFAULT_VERIFICATION_DEADLINE_MS = 5_000
const DEFAULT_AVAILABILITY_DEADLINE_MS = 2_000
const DEFAULT_MAX_EVIDENCE_LIFETIME_MS = 30_000
const MAX_AVAILABILITY_PEERS = 128
const MAX_DEADLINE_MS = 30_000
const HEX_32 = /^[0-9a-f]{64}$/

export const VERIFIED_CANDIDATE_MANIFEST = Symbol('verified-candidate-manifest')

export function verifiedCandidateManifest(candidate) {
  return candidate?.[VERIFIED_CANDIDATE_MANIFEST] || null
}

class SourceVerificationError extends Error {
  constructor(code, cause = null) {
    super(code)
    this.name = 'SourceVerificationError'
    this.code = code
    if (cause !== null) this.cause = cause
  }
}

function reject(code, cause = null) {
  throw new SourceVerificationError(code, cause)
}

function boundedInteger(value, fallback, maximum, name) {
  const normalized = Number(value ?? fallback)
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > maximum) {
    throw new TypeError(`${name} is outside its bounded limit`)
  }
  return normalized
}

function currentTime(now) {
  const value = Number(now())
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('now must return a non-negative safe integer')
  return value
}

function hex(value, name) {
  let bytes
  try {
    bytes = typeof value === 'string' && HEX_32.test(value) ? b4a.from(value, 'hex') : b4a.from(value)
  } catch (error) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID, error)
  }
  if (bytes.byteLength !== 32) reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID, new Error(`${name} must be 32 bytes`))
  return b4a.toString(bytes, 'hex')
}

function sameBytes(left, right) {
  try {
    const leftBytes = typeof left === 'string' && HEX_32.test(left) ? b4a.from(left, 'hex') : b4a.from(left)
    const rightBytes = typeof right === 'string' && HEX_32.test(right) ? b4a.from(right, 'hex') : b4a.from(right)
    return b4a.equals(leftBytes, rightBytes)
  } catch {
    return false
  }
}

function exactFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === fields.length && fields.every(field => Object.hasOwn(value, field))
}

function abortCode(reason) {
  return reason instanceof SourceVerificationError
    ? reason
    : new SourceVerificationError(SOURCE_VERIFICATION_ERROR_CODES.ABORTED, reason instanceof Error ? reason : null)
}

function raceAbort(work, signal) {
  if (signal.aborted) return Promise.reject(abortCode(signal.reason))
  return new Promise((resolve, rejectPromise) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => finish(rejectPromise, abortCode(signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(work).then(value => finish(resolve, value), error => finish(rejectPromise, error))
  })
}

function throwIfAborted(signal) {
  if (signal.aborted) throw abortCode(signal.reason)
}

async function awaitAbort(work, signal) {
  throwIfAborted(signal)
  const value = await raceAbort(work, signal)
  throwIfAborted(signal)
  return value
}

function catalogHead(head) {
  return Object.freeze({
    viewKey: hex(head.viewKey, 'catalog head viewKey'),
    length: head.length,
    digest: hex(head.digest, 'catalog head digest'),
    authorizationStateDigest: hex(head.authorizationStateDigest, 'catalog authorization digest'),
  })
}

function sameHead(left, right) {
  return left.length === right.length &&
    left.viewKey === right.viewKey &&
    left.digest === right.digest &&
    left.authorizationStateDigest === right.authorizationStateDigest
}

function publicDescriptor(descriptor) {
  return Object.freeze({
    publisherId: hex(descriptor.publisherId, 'publisherId'),
    publisherRootKey: hex(descriptor.publisherRootKey, 'publisherRootKey'),
    catalogBootstrapKey: hex(descriptor.catalogBootstrapKey, 'catalogBootstrapKey'),
    catalogEpoch: descriptor.catalogEpoch,
    policySequence: descriptor.policySequence,
  })
}

async function loadNamespace(binding, expectedPublisherId, signal) {
  const catalog = binding?.catalog
  const view = catalog?.view
  if (!catalog || !view || typeof view.get !== 'function') reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
  if (!HEX_32.test(expectedPublisherId)) reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
  const expectedBytes = b4a.from(expectedPublisherId, 'hex')
  if (!sameBytes(binding.publisherId, expectedBytes) ||
      !sameBytes(derivePublisherId(binding.genesisRootKey), expectedBytes) ||
      !sameBytes(binding.catalogBootstrapKey, catalog.key)) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
  }
  const descriptorEntry = await awaitAbort(view.get('state/descriptor'), signal)
  if (!descriptorEntry?.value) reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
  const descriptor = decodePublisherNamespaceDescriptor(descriptorEntry.value)
  verifyPublisherNamespaceDescriptor(descriptor)
  if (!sameBytes(descriptor.publisherId, expectedBytes) ||
      !sameBytes(descriptor.catalogBootstrapKey, binding.catalogBootstrapKey) ||
      (descriptor.catalogEpoch === 0 && !sameBytes(descriptor.publisherRootKey, binding.genesisRootKey))) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
  }
  const authorization = await awaitAbort(getPublisherAuthorizationState(view), signal)
  if (!authorization || authorization.policySequence !== descriptor.policySequence) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
  }
  return { catalog, view, descriptor, authorization }
}

function verifyAcceptedWriter(operation, body, descriptor, authorization) {
  const signer = hex(operation.signerKey, 'operation signer')
  const writer = authorization.writers.find(candidate => candidate.signerKey === signer)
  if (!writer || !sameBytes(writer.signerKey, operation.signerKey)) reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
  const capability = requiredPublisherCapability(operation.recordType, body)
  if (!capability || !writer.capabilities.includes(capability) ||
      operation.issuerSequence < writer.firstAcceptedSequence ||
      operation.issuerSequence > writer.lastAcceptedSequence ||
      operation.signedAt > writer.expiresAt ||
      (operation.expiresAt !== undefined && operation.expiresAt > 0 && operation.signedAt > operation.expiresAt) ||
      operation.policyEpoch < writer.admissionPolicyEpoch) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
  }
  if (writer.revocation && (
    operation.policyEpoch > writer.revocation.revokedFromEpoch ||
    operation.issuerSequence > writer.revocation.acceptedThroughSequence
  )) reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
  if (operation.policyEpoch > authorization.policyEpoch) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
  }
  const provider = createPublisherKeyProvider()
  try {
    provider.verifySignedEnvelope(operation, {
      issuerIdentityKey: descriptor.publisherId,
      policyEpoch: operation.policyEpoch,
      authorizeSigner: candidate => sameBytes(candidate.signerKey, operation.signerKey),
      authorizeSequence: candidate => candidate.issuerSequence === operation.issuerSequence,
      claimReplay: () => true,
      now: operation.signedAt,
      maxClockSkew: 0,
    })
  } catch (error) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID, error)
  }
}

async function loadCurrentOperation(view, sourceRecordRef, descriptor, authorization, signal) {
  if (typeof sourceRecordRef !== 'string' || !HEX_32.test(sourceRecordRef)) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
  }
  const accepted = await awaitAbort(view.get(`accepted/${sourceRecordRef}`), signal)
  if (!accepted?.value) reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_NOT_CURRENT)
  const decodedAccepted = decodeAcceptedEntry(accepted.value)
  const frame = decodedAccepted?.frame || accepted.value
  let operation
  let body
  try {
    operation = decodedAccepted?.value || decodePublisherCatalogFrame(frame)
    if (!b4a.equals(encodePublisherCatalogFrame(operation), frame)) reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
    if (hex(operation.recordId, 'recordId') !== sourceRecordRef) reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
    body = decodePublisherOperationBody(operation.recordType, operation.canonicalBody)
  } catch (error) {
    if (error instanceof SourceVerificationError) throw error
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID, error)
  }
  verifyAcceptedWriter(operation, body, descriptor, authorization)
  const identity = publisherProjectionIdentity(operation.recordType, body, operation)
  if (!identity?.id) reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
  const projection = await awaitAbort(getPublisherProjection(view, identity.kind, identity.id), signal)
  if (!projection || !sameBytes(projection.recordId, operation.recordId)) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_NOT_CURRENT)
  }
  if (!b4a.equals(encodePublisherCatalogFrame(projection), frame)) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_NOT_CURRENT)
  }
  return { operation, body, identity }
}

function normalizedTitleTokens(title) {
  if (typeof title !== 'string') return []
  const normalized = title.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ')
  return [...new Set(normalized.match(/[\p{L}\p{N}]+/gu) || [])]
}

function signedWorkEntityId(manifest) {
  for (const claim of manifest.body.claims) {
    if (claim?.role === 'work' && typeof claim.entityId === 'string' && HEX_32.test(claim.entityId)) {
      return claim.entityId
    }
  }
  return manifest.publicationId
}

// Title-token index edges are derived from the signed title of a publication
// operation. Verification authenticates that publication once, requires the
// observed edge token among the same normalized title tokens the ingestor used,
// requires every requested query token to prefix-match a signed title token,
// and requires the signed work identity to equal both locator.targetId and the
// candidate work entity. Discovery type is an explicit private locator field —
// never inferred from empty externalRefs.
async function verifyTitleEvidence(current, locator, candidate, descriptor, signal) {
  const discovery = locator.discovery
  if (
    !discovery ||
    discovery.type !== 'title-token' ||
    typeof discovery.token !== 'string' ||
    discovery.token.length === 0 ||
    typeof discovery.targetId !== 'string' ||
    !Array.isArray(discovery.queryTokens) ||
    discovery.queryTokens.length === 0 ||
    discovery.queryTokens.some(token => typeof token !== 'string' || token.length === 0)
  ) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_MISMATCH)
  }
  if (current.operation.recordType !== 'publisher.publication') {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_MISMATCH)
  }
  let manifest
  try {
    manifest = decodePublicationManifest(current.body.payload)
  } catch (error) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID, error)
  }
  const verified = await awaitAbort(verifyCatalogPublicationManifest(manifest, {
    publisherId: descriptor.publisherId,
    publicationId: current.body.publicationId,
    manifestId: current.body.manifestId,
    signer: current.operation.signerKey,
    payload: current.body.payload,
    now: current.operation.signedAt,
  }), signal)
  if (!verified ||
      manifest.publicationId !== hex(current.body.publicationId, 'publicationId') ||
      manifest.body.manifestId !== hex(current.body.manifestId, 'manifestId')) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_MISMATCH)
  }
  const tokens = normalizedTitleTokens(manifest.body.title)
  if (!tokens.includes(discovery.token)) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_MISMATCH)
  }
  if (!discovery.queryTokens.every(queryToken => tokens.some(token => token.startsWith(queryToken)))) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_MISMATCH)
  }
  const workId = signedWorkEntityId(manifest)
  if (workId !== discovery.targetId || workId !== candidate.work.entityId) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_MISMATCH)
  }
  return manifest
}

async function verifyExternalClaim(current, locator, candidate, signal) {
  if (current.operation.recordType !== 'publisher.claim' || hex(current.body.claimId, 'claimId') !== hex(current.identity.id, 'claim identity')) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_MISMATCH)
  }
  let envelope
  let claim
  try {
    envelope = decodeApplicationEnvelope(current.body.payload)
    claim = decodeClaimBody(envelope.body)
  } catch (error) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID, error)
  }
  const verified = await awaitAbort(verifyMediaClaim(envelope, {
    authorizeSigner: signer => sameBytes(signer, current.operation.signerKey),
    now: current.operation.signedAt,
  }), signal)
  if (!verified ||
      hex(envelope.recordId, 'claim envelope recordId') !== hex(current.body.claimId, 'publisher claimId') ||
      current.body.claimType !== claim.claimType) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
  }
  const expectedRef = candidate.work.externalRefs[0]
  const subject = claim.subjectRefs.find(ref =>
    ref.namespace === expectedRef.namespace && ref.normalizedIdentifier === expectedRef.identifier)
  const externalRef = claim.payload?.externalRef
  const externalMatches = claim.claimType === 'ExternalReferenceClaim' &&
    externalRef?.namespace === expectedRef.namespace &&
    externalRef?.identifier === expectedRef.identifier
  const publicationMatches = claim.payload?.publicationId === locator.publicationId
  if ((!subject && !externalMatches) ||
      (claim.claimType !== 'ExternalReferenceClaim' && !publicationMatches) ||
      locator.publisherId !== candidate.publication.publisherId) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_MISMATCH)
  }
  const workSubject = subject || claim.subjectRefs.find(ref => ref.entityKind === 'work')
  if (!workSubject) reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_MISMATCH)
  return { claim, workSubject }
}

async function verifyPublication(current, locator, descriptor, now, signal) {
  if (current.operation.recordType !== 'publisher.publication' ||
      hex(current.body.publicationId, 'publicationId') !== locator.publicationId ||
      hex(current.body.manifestId, 'manifestId') !== locator.candidateManifestId) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_MISMATCH)
  }
  let manifest
  try {
    manifest = decodePublicationManifest(current.body.payload)
  } catch (error) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID, error)
  }
  const verified = await awaitAbort(verifyCatalogPublicationManifest(manifest, {
    publisherId: descriptor.publisherId,
    publicationId: current.body.publicationId,
    manifestId: current.body.manifestId,
    signer: current.operation.signerKey,
    payload: current.body.payload,
    now: current.operation.signedAt,
  }), signal)
  if (!verified || manifest.publicationId !== locator.publicationId || manifest.body.manifestId !== locator.candidateManifestId) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_MISMATCH)
  }
  return manifest
}

function verifySelectedRendition(manifest, locator) {
  const matches = manifest.body.renditions.filter(rendition => rendition.renditionId === locator.renditionId)
  if (matches.length !== 1) reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_MISMATCH)
  let rendition
  let core
  try {
    rendition = createRenditionDescriptor(matches[0])
    core = normalizeAssetCoreRefV2(rendition.core)
  } catch (error) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID, error)
  }
  if (rendition.renditionId !== locator.renditionId || core.assetId !== locator.assetId || core.key !== locator.assetId) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_MISMATCH)
  }
  if (core.length < 1) reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_MISMATCH)
  return { rendition: Object.freeze(rendition), core: Object.freeze(core) }
}

function validateAvailability(value, now, maximumLifetime) {
  const fields = ['peers', 'completeSeeders', 'observedAtMs', 'expiresAtMs']
  if (!exactFields(value, fields)) reject(SOURCE_VERIFICATION_ERROR_CODES.AVAILABILITY_INVALID)
  for (const field of fields) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) reject(SOURCE_VERIFICATION_ERROR_CODES.AVAILABILITY_INVALID)
  }
  if (value.completeSeeders > value.peers || value.observedAtMs > now || value.expiresAtMs <= now ||
      value.peers > MAX_AVAILABILITY_PEERS || value.expiresAtMs - value.observedAtMs > maximumLifetime) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.AVAILABILITY_INVALID)
  }
  if (value.peers < 1) reject(SOURCE_VERIFICATION_ERROR_CODES.UNAVAILABLE)
  return Object.freeze({ ...value })
}

function freezeTree(value) {
  if (!value || typeof value !== 'object') return value
  for (const child of Object.values(value)) freezeTree(child)
  return Object.isFrozen(value) ? value : Object.freeze(value)
}

function deepFreezeCandidate(candidate) {
  return freezeTree({
    ...candidate,
    work: {
      ...candidate.work,
      externalRefs: candidate.work.externalRefs.map(ref => ({ ...ref })),
    },
    edition: candidate.edition == null ? null : { ...candidate.edition },
    publication: { ...candidate.publication },
    rendition: {
      ...candidate.rendition,
      hdrFormats: [...candidate.rendition.hdrFormats],
      audioTracks: candidate.rendition.audioTracks.map(track => ({ ...track })),
      subtitleTracks: candidate.rendition.subtitleTracks.map(track => ({ ...track })),
    },
    asset: { ...candidate.asset },
    provenance: { ...candidate.provenance },
    availability: { ...candidate.availability },
    verification: {
      ...candidate.verification,
      publisherDescriptor: { ...candidate.verification.publisherDescriptor },
      catalogHead: { ...candidate.verification.catalogHead },
    },
    sourceIndexers: candidate.sourceIndexers.map(value => ({ ...value })),
  })
}
async function resolveCatalogBinding (catalogRegistry, publisherId, signal) {
  try {
    const binding = await awaitAbort(catalogRegistry.resolve(b4a.from(publisherId, 'hex')), signal)
    await awaitAbort(binding.catalog?.ready?.(), signal)
    await awaitAbort(binding.catalog?.update?.(), signal)
    return binding
  } catch (error) {
    if (error instanceof SourceVerificationError) throw error
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID, error)
  }
}

async function resolveCandidateWorkEntityId ({
  titleEvidence,
  externalCurrent,
  locator,
  candidate,
  descriptor,
  manifest,
  signal,
}) {
  if (titleEvidence) {
    await awaitAbort(
      verifyTitleEvidence(externalCurrent, locator, candidate, descriptor, signal),
      signal,
    )
    return candidate.work.entityId
  }
  const verifiedClaim = await awaitAbort(verifyExternalClaim(externalCurrent, locator, candidate, signal), signal)
  const claim = verifiedClaim.claim
  const externalClaimId = hex(externalCurrent.body.claimId, 'claimId')
  const claimLinks = manifest.body.claims.filter(value => value.claimId === externalClaimId)
  if (claimLinks.length === 1 && claim.subjectRefs.some(subject => subject.entityId === claimLinks[0].entityId)) {
    return claimLinks[0].entityId
  }
  if (claimLinks.length === 0 && claim.payload?.publicationId === manifest.publicationId) {
    return verifiedClaim.workSubject.entityId
  }
  reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_MISMATCH)
}

async function probeCandidateAvailability ({
  locator,
  selected,
  manifest,
  namespace,
  candidate,
  signal,
  schedule,
  cancelScheduled,
  availabilityDeadlineMs,
  trackAvailability,
}) {
  const availabilityController = new AbortController()
  const onAbort = () => availabilityController.abort(signal.reason)
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  let availabilityTimer
  try {
    availabilityTimer = schedule(() => availabilityController.abort(
      new SourceVerificationError(SOURCE_VERIFICATION_ERROR_CODES.AVAILABILITY_TIMEOUT),
    ), availabilityDeadlineMs)
    const availabilityWork = trackAvailability({
      publisherId: locator.publisherId,
      publicationId: locator.publicationId,
      renditionId: locator.renditionId,
      assetId: locator.assetId,
      coreKey: selected.core.key,
      range: Object.freeze({ startBlock: 0, endBlock: 1 }),
      manifest,
      catalog: namespace.catalog,
      descriptor: namespace.descriptor,
      sourceIndexers: candidate.sourceIndexers,
      signal: availabilityController.signal,
    })
    return await raceAbort(availabilityWork, availabilityController.signal)
  } catch (error) {
    if (error instanceof SourceVerificationError) throw error
    reject(SOURCE_VERIFICATION_ERROR_CODES.UNAVAILABLE, error)
  } finally {
    signal.removeEventListener('abort', onAbort)
    if (availabilityTimer !== undefined) cancelScheduled(availabilityTimer)
  }
}

async function verifyFinalCatalogState ({ namespace, firstHead, locator, signal }) {
  await awaitAbort(namespace.catalog.update?.(), signal)
  const finalHead = catalogHead(await awaitAbort(getPublisherViewHead(namespace.view), signal))
  const finalDescriptorEntry = await awaitAbort(namespace.view.get('state/descriptor'), signal)
  const finalDescriptor = finalDescriptorEntry?.value ? decodePublisherNamespaceDescriptor(finalDescriptorEntry.value) : null
  if (!finalDescriptor || finalDescriptor.catalogEpoch !== namespace.descriptor.catalogEpoch || !sameHead(firstHead, finalHead)) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_NOT_CURRENT)
  }
  await awaitAbort(
    loadCurrentOperation(namespace.view, locator.sourceRecordRef, namespace.descriptor, namespace.authorization, signal),
    signal,
  )
  await awaitAbort(
    loadCurrentOperation(namespace.view, locator.publicationSourceRecordRef, namespace.descriptor, namespace.authorization, signal),
    signal,
  )
  return finalHead
}

function buildVerifiedCandidateRecord ({
  manifest,
  candidate,
  workEntityId,
  titleEvidence,
  locator,
  namespace,
  finalHead,
  selected,
  evidence,
}) {
  return deepFreezeCandidate({
    [VERIFIED_CANDIDATE_MANIFEST]: manifest,
    ...candidate,
    edition: null,
    work: {
      entityId: workEntityId,
      title: manifest.body.title,
      releaseYear: null,
      externalRefs: titleEvidence
        ? []
        : [{ ...candidate.work.externalRefs[0] }],
      episode: null,
    },
    publication: {
      publicationId: manifest.publicationId,
      publisherId: locator.publisherId,
      manifestId: manifest.body.manifestId,
      catalogEpoch: namespace.descriptor.catalogEpoch,
      catalogHead: finalHead.digest,
      descriptor: {
        publicationId: manifest.publicationId,
        manifestId: manifest.body.manifestId,
        title: manifest.body.title,
      },
    },
    rendition: {
      renditionId: selected.rendition.renditionId,
      container: selected.rendition.format,
      videoCodec: null,
      width: null,
      height: null,
      resolutionLabel: null,
      hdrFormats: [],
      audioTracks: [],
      subtitleTracks: [],
      purpose: selected.rendition.purpose,
      descriptor: {
        renditionId: selected.rendition.renditionId,
        purpose: selected.rendition.purpose,
        format: selected.rendition.format,
        core: { ...selected.rendition.core },
      },
      byteLength: selected.core.byteLength,
    },
    asset: {
      assetId: selected.core.assetId,
      coreKey: selected.core.key,
      blockLength: selected.core.length,
      byteLength: selected.core.byteLength,
      treeHash: selected.core.treeHash,
      blockSize: selected.core.blockSize,
      descriptor: { ...selected.core },
    },
    provenance: {
      sourceKind: null,
      releaseName: null,
      publicInfohash: null,
    },
    availability: evidence,
    verification: {
      state: 'source-verified',
      publisherDescriptor: publicDescriptor(namespace.descriptor),
      catalogHead: finalHead,
    },
  })
}

export function createSourceVerifier({ federation, catalogRegistry, availabilityProbe, now = Date.now, limits = {} } = {}) {
  const privateFederation = federation?.[INDEX_FEDERATION_PRIVATE]
  if (!privateFederation || typeof privateFederation.resolveCandidateRecord !== 'function') throw new TypeError('owned index federation is required')
  if (!catalogRegistry || typeof catalogRegistry.resolve !== 'function') throw new TypeError('catalogRegistry.resolve is required')
  if (typeof availabilityProbe !== 'function') throw new TypeError('availabilityProbe is required')
  if (typeof now !== 'function') throw new TypeError('now must be a function')
  const verificationDeadlineMs = boundedInteger(limits.verificationDeadlineMs, DEFAULT_VERIFICATION_DEADLINE_MS, MAX_DEADLINE_MS, 'verificationDeadlineMs')
  const availabilityDeadlineMs = boundedInteger(limits.availabilityDeadlineMs, DEFAULT_AVAILABILITY_DEADLINE_MS, MAX_DEADLINE_MS, 'availabilityDeadlineMs')
  const maximumEvidenceLifetimeMs = boundedInteger(limits.maxEvidenceLifetimeMs, DEFAULT_MAX_EVIDENCE_LIFETIME_MS, 5 * 60_000, 'maxEvidenceLifetimeMs')
  const schedule = limits.setTimeout || setTimeout
  const cancelScheduled = limits.clearTimeout || clearTimeout
  let closed = false
  const controllers = new Set()
  const drainWaiters = new Set()
  const availabilityTasks = new Set()

  function trackAvailability(request) {
    const task = Promise.resolve().then(() => availabilityProbe(request))
    availabilityTasks.add(task)
    const remove = () => availabilityTasks.delete(task)
    task.then(remove, remove)
    return task
  }

  async function execute(record, signal) {
    const locator = record.locator
    const binding = await resolveCatalogBinding(catalogRegistry, locator.publisherId, signal)
    const namespace = await awaitAbort(loadNamespace(binding, locator.publisherId, signal), signal)
    const firstHead = catalogHead(await awaitAbort(getPublisherViewHead(namespace.view), signal))
    const externalCurrent = await awaitAbort(
      loadCurrentOperation(namespace.view, locator.sourceRecordRef, namespace.descriptor, namespace.authorization, signal),
      signal,
    )
    const publicationCurrent = await awaitAbort(
      loadCurrentOperation(namespace.view, locator.publicationSourceRecordRef, namespace.descriptor, namespace.authorization, signal),
      signal,
    )
    const manifest = await awaitAbort(
      verifyPublication(publicationCurrent, locator, namespace.descriptor, currentTime(now), signal),
      signal,
    )
    const titleEvidence = locator.discovery?.type === 'title-token'
    const workEntityId = await resolveCandidateWorkEntityId({
      titleEvidence,
      externalCurrent,
      locator,
      candidate: record.candidate,
      descriptor: namespace.descriptor,
      manifest,
      signal,
    })
    const selected = verifySelectedRendition(manifest, locator)
    const availability = await probeCandidateAvailability({
      locator,
      selected,
      manifest,
      namespace,
      candidate: record.candidate,
      signal,
      schedule,
      cancelScheduled,
      availabilityDeadlineMs,
      trackAvailability,
    })
    throwIfAborted(signal)
    const evidence = validateAvailability(availability, currentTime(now), maximumEvidenceLifetimeMs)
    const finalHead = await verifyFinalCatalogState({ namespace, firstHead, locator, signal })
    throwIfAborted(signal)

    return buildVerifiedCandidateRecord({
      manifest,
      candidate: record.candidate,
      workEntityId,
      titleEvidence,
      locator,
      namespace,
      finalHead,
      selected,
      evidence,
    })
  }

  async function verifySelectedCandidate({ candidateRef, signal } = {}) {
    if (closed) reject(SOURCE_VERIFICATION_ERROR_CODES.VERIFIER_CLOSED)
    if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function')) {
      throw new TypeError('signal must be an AbortSignal')
    }
    if (signal?.aborted) reject(SOURCE_VERIFICATION_ERROR_CODES.ABORTED, signal.reason)
    const record = privateFederation.resolveCandidateRecord(candidateRef)
    if (!record) reject(SOURCE_VERIFICATION_ERROR_CODES.CANDIDATE_EXPIRED)
    const controller = new AbortController()
    controllers.add(controller)
    const onAbort = () => controller.abort(new SourceVerificationError(SOURCE_VERIFICATION_ERROR_CODES.ABORTED, signal.reason))
    signal?.addEventListener('abort', onAbort, { once: true })
    let timer
    let work
    try {
      timer = schedule(() => controller.abort(new SourceVerificationError(SOURCE_VERIFICATION_ERROR_CODES.VERIFICATION_TIMEOUT)), verificationDeadlineMs)
      work = execute(record, controller.signal)
      return await raceAbort(work, controller.signal)
    } catch (error) {
      if (error instanceof SourceVerificationError) throw error
      reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID, error)
    } finally {
      if (work) await Promise.resolve(work).catch(() => {})
      if (timer !== undefined) cancelScheduled(timer)
      signal?.removeEventListener('abort', onAbort)
      controllers.delete(controller)
      if (controllers.size === 0) {
        for (const resolve of drainWaiters) resolve()
        drainWaiters.clear()
      }
    }
  }

  async function close() {
    if (closed) return false
    closed = true
    const error = new SourceVerificationError(SOURCE_VERIFICATION_ERROR_CODES.VERIFIER_CLOSED)
    for (const controller of controllers) controller.abort(error)
    if (controllers.size > 0) await new Promise(resolve => drainWaiters.add(resolve))
    while (availabilityTasks.size > 0) {
      await Promise.allSettled([...availabilityTasks])
    }
    return true
  }

  return Object.freeze({ verifySelectedCandidate, close })
}

export function createLocalAssetAvailabilityProbe({
  openAssetCore,
  now = Date.now,
  evidenceLifetimeMs = 5_000,
} = {}) {
  if (typeof openAssetCore !== 'function') throw new TypeError('openAssetCore is required')
  if (typeof now !== 'function') throw new TypeError('now must be a function')
  const lifetime = boundedInteger(evidenceLifetimeMs, 5_000, DEFAULT_MAX_EVIDENCE_LIFETIME_MS, 'evidenceLifetimeMs')
  return async function probe({ coreKey, range, signal }) {
    let core = null
    try {
      core = await raceAbort(Promise.resolve().then(() => openAssetCore(coreKey)), signal)
      const start = range?.startBlock
      const end = range?.endBlock
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
        throw new TypeError('local availability range is invalid')
      }
      const block = await raceAbort(core.get(start, { wait: false }), signal)
      const observedAtMs = currentTime(now)
      return {
        peers: block ? 1 : 0,
        completeSeeders: 0,
        observedAtMs,
        expiresAtMs: observedAtMs + lifetime,
      }
    } finally {
      await core?.close?.().catch(() => {})
    }
  }
}

export function createScopedAssetAvailabilityProbe({
  scopedNetwork,
  now = Date.now,
  evidenceLifetimeMs = 5_000,
  randomBytes = crypto.randomBytes,
} = {}) {
  if (!scopedNetwork || typeof scopedNetwork.retainAuthorizedRendition !== 'function' ||
      typeof scopedNetwork.requestAssetBlocks !== 'function' ||
      typeof scopedNetwork.releaseAuthorizedRendition !== 'function') {
    throw new TypeError('scoped asset range transport is required')
  }
  if (typeof randomBytes !== 'function') throw new TypeError('randomBytes must be a function')
  const ownerNonce = b4a.from(randomBytes(16))
  if (ownerNonce.byteLength !== 16) throw new TypeError('randomBytes must return 16 bytes')
  const ownerPrefix = b4a.toString(ownerNonce, 'hex')
  let ownerSequence = 0
  const lifetime = boundedInteger(evidenceLifetimeMs, 5_000, DEFAULT_MAX_EVIDENCE_LIFETIME_MS, 'evidenceLifetimeMs')
  return async function probe({ manifest, renditionId, assetId, range, signal }) {
    if (ownerSequence >= Number.MAX_SAFE_INTEGER) throw new Error('availability probe owner sequence exhausted')
    const ownerId = `source-verification:${ownerPrefix}:${ownerSequence++}`
    let retained = false
    let requestWork = null
    const retainWork = Promise.resolve().then(() => scopedNetwork.retainAuthorizedRendition({
      manifest,
      renditionId,
      ownerId,
      start: range.startBlock,
      end: range.endBlock,
    }))
    try {
      await raceAbort(retainWork, signal)
      retained = true
      requestWork = Promise.resolve().then(() => scopedNetwork.requestAssetBlocks({
        assetId,
        startBlock: range.startBlock,
        endBlock: range.endBlock,
        requirePeerEvidence: true,
        signal,
      }))
      const result = await raceAbort(requestWork, signal)
      const verified = Array.isArray(result?.verifiedBlockIndexes) && result.verifiedBlockIndexes.includes(range.startBlock)
      const observedAtMs = currentTime(now)
      const peers = verified && Array.isArray(result.peerIds) ? new Set(result.peerIds).size : 0
      return { peers, completeSeeders: 0, observedAtMs, expiresAtMs: observedAtMs + lifetime }
    } finally {
      try {
        await retainWork
        retained = true
      } catch {
        // A failed retain acquired no ownership.
      }
      if (requestWork) await requestWork.catch(() => {})
      if (retained) {
        await scopedNetwork.releaseAuthorizedRendition({ renditionId, ownerId, assetId })
      }
    }
  }
}
