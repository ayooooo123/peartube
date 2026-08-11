import b4a from 'b4a'

import {
  createRenditionDescriptor,
  decodePublicationManifest,
  normalizeAssetCoreRefV2,
  verifyCatalogPublicationManifest,
} from '../assets/index.js'
import { decodeClaimBody, verifyMediaClaim } from '../media-graph/index.js'
import {
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
const MAX_DEADLINE_MS = 30_000
const HEX_32 = /^[0-9a-f]{64}$/

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

async function loadNamespace(binding, expectedPublisherId) {
  const catalog = binding?.catalog
  const view = catalog?.view
  if (!catalog || !view || typeof view.get !== 'function') reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
  if (!HEX_32.test(expectedPublisherId)) reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
  const expectedBytes = b4a.from(expectedPublisherId, 'hex')
  if (!sameBytes(binding.publisherId, expectedBytes) ||
      !sameBytes(derivePublisherId(binding.genesisRootKey), expectedBytes) ||
      !sameBytes(binding.catalogBootstrapKey, catalog.key) ||
      !sameBytes(binding.catalogBootstrapKey, view.key)) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
  }
  const descriptorEntry = await view.get('state/descriptor')
  if (!descriptorEntry?.value) reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
  const descriptor = decodePublisherNamespaceDescriptor(descriptorEntry.value)
  verifyPublisherNamespaceDescriptor(descriptor)
  if (!sameBytes(descriptor.publisherId, expectedBytes) ||
      !sameBytes(descriptor.catalogBootstrapKey, binding.catalogBootstrapKey) ||
      (descriptor.catalogEpoch === 0 && !sameBytes(descriptor.publisherRootKey, binding.genesisRootKey))) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
  }
  const authorization = await getPublisherAuthorizationState(view)
  if (!authorization) reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
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
      operation.policyEpoch < writer.admissionPolicyEpoch) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
  }
  if (writer.revocation && (
    operation.policyEpoch > writer.revocation.revokedFromEpoch ||
    operation.issuerSequence > writer.revocation.acceptedThroughSequence
  )) reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
  if (!writer.revocation && operation.policyEpoch !== authorization.policyEpoch) {
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

async function loadCurrentOperation(view, sourceRecordRef, descriptor, authorization) {
  if (typeof sourceRecordRef !== 'string' || !HEX_32.test(sourceRecordRef)) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
  }
  const accepted = await view.get(`accepted/${sourceRecordRef}`)
  if (!accepted?.value) reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_NOT_CURRENT)
  let operation
  let body
  try {
    operation = decodePublisherCatalogFrame(accepted.value)
    if (!b4a.equals(encodePublisherCatalogFrame(operation), accepted.value)) reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
    if (hex(operation.recordId, 'recordId') !== sourceRecordRef) reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
    body = decodePublisherOperationBody(operation.recordType, operation.canonicalBody)
  } catch (error) {
    if (error instanceof SourceVerificationError) throw error
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID, error)
  }
  verifyAcceptedWriter(operation, body, descriptor, authorization)
  const identity = publisherProjectionIdentity(operation.recordType, body, operation)
  if (!identity?.id) reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
  const projection = await getPublisherProjection(view, identity.kind, identity.id)
  if (!projection || !sameBytes(projection.recordId, operation.recordId)) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_NOT_CURRENT)
  }
  if (!b4a.equals(encodePublisherCatalogFrame(projection), accepted.value)) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_NOT_CURRENT)
  }
  return { operation, body, identity }
}

async function verifyExternalClaim(current, locator, candidate) {
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
  const verified = await verifyMediaClaim(envelope, {
    authorizeSigner: signer => sameBytes(signer, current.operation.signerKey),
    now: current.operation.signedAt,
  })
  if (!verified ||
      hex(envelope.recordId, 'claim envelope recordId') !== hex(current.body.claimId, 'publisher claimId') ||
      current.body.claimType !== claim.claimType ||
      claim.claimType !== 'ExternalReferenceClaim') {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID)
  }
  const expectedRef = candidate.work.externalRefs[0]
  const externalRef = claim.payload?.externalRef
  if (!externalRef || externalRef.namespace !== expectedRef.namespace || externalRef.identifier !== expectedRef.identifier ||
      !claim.subjectRefs.some(subject => subject.entityId === candidate.work.entityId)) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_MISMATCH)
  }
  if (locator.publisherId !== candidate.publication.publisherId) reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_MISMATCH)
  return claim
}

async function verifyPublication(current, locator, descriptor, now) {
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
  const verified = await verifyCatalogPublicationManifest(manifest, {
    publisherId: descriptor.publisherId,
    publicationId: current.body.publicationId,
    manifestId: current.body.manifestId,
    signer: current.operation.signerKey,
    payload: current.body.payload,
    now,
  })
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
      value.expiresAtMs - value.observedAtMs > maximumLifetime) {
    reject(SOURCE_VERIFICATION_ERROR_CODES.AVAILABILITY_INVALID)
  }
  if (value.peers < 1) reject(SOURCE_VERIFICATION_ERROR_CODES.UNAVAILABLE)
  return Object.freeze({ ...value })
}

function deepFreezeCandidate(candidate) {
  return Object.freeze({
    ...candidate,
    work: Object.freeze({ ...candidate.work, externalRefs: Object.freeze(candidate.work.externalRefs.map(ref => Object.freeze({ ...ref }))) }),
    edition: Object.freeze({ ...candidate.edition }),
    publication: Object.freeze({ ...candidate.publication }),
    rendition: Object.freeze({
      ...candidate.rendition,
      hdrFormats: Object.freeze([...candidate.rendition.hdrFormats]),
      audioTracks: Object.freeze([...candidate.rendition.audioTracks]),
      subtitleTracks: Object.freeze([...candidate.rendition.subtitleTracks]),
    }),
    asset: Object.freeze({ ...candidate.asset }),
    provenance: Object.freeze({ ...candidate.provenance }),
    availability: Object.freeze({ ...candidate.availability }),
    verification: Object.freeze({
      ...candidate.verification,
      publisherDescriptor: Object.freeze({ ...candidate.verification.publisherDescriptor }),
      catalogHead: Object.freeze({ ...candidate.verification.catalogHead }),
    }),
    sourceIndexers: Object.freeze(candidate.sourceIndexers.map(value => Object.freeze({ ...value }))),
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

  async function execute(record, signal) {
    const locator = { ...record.locator, candidateManifestId: record.candidate.publication.manifestId }
    let binding
    try {
      binding = await catalogRegistry.resolve(b4a.from(locator.publisherId, 'hex'))
      await binding.catalog?.ready?.()
      await binding.catalog?.update?.()
    } catch (error) {
      reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID, error)
    }
    const namespace = await loadNamespace(binding, locator.publisherId)
    const firstHead = catalogHead(await getPublisherViewHead(namespace.view))
    const externalCurrent = await loadCurrentOperation(namespace.view, locator.sourceRecordRef, namespace.descriptor, namespace.authorization)
    const publicationCurrent = await loadCurrentOperation(namespace.view, locator.publicationSourceRecordRef, namespace.descriptor, namespace.authorization)
    const claim = await verifyExternalClaim(externalCurrent, locator, record.candidate)
    const manifest = await verifyPublication(publicationCurrent, locator, namespace.descriptor, currentTime(now))
    if (!manifest.body.claims.some(value => value.claimId === hex(externalCurrent.body.claimId, 'claimId') && value.entityId === record.candidate.work.entityId)) {
      reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_MISMATCH)
    }
    const selected = verifySelectedRendition(manifest, locator)
    if (
      (record.candidate.work.title != null && record.candidate.work.title !== manifest.body.title) ||
      (record.candidate.rendition.container != null && record.candidate.rendition.container !== selected.rendition.format) ||
      record.candidate.rendition.byteLength !== selected.core.byteLength
    ) reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_MISMATCH)

    const availabilityController = new AbortController()
    const onAbort = () => availabilityController.abort(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    let availabilityTimer
    let availability
    try {
      availabilityTimer = schedule(() => availabilityController.abort(
        new SourceVerificationError(SOURCE_VERIFICATION_ERROR_CODES.AVAILABILITY_TIMEOUT),
      ), availabilityDeadlineMs)
      availability = await raceAbort(availabilityProbe({
        publisherId: locator.publisherId,
        publicationId: locator.publicationId,
        renditionId: locator.renditionId,
        assetId: locator.assetId,
        coreKey: selected.core.key,
        range: Object.freeze({ startBlock: 0, endBlock: 1 }),
        manifest,
        catalog: namespace.catalog,
        descriptor: namespace.descriptor,
        signal: availabilityController.signal,
      }), availabilityController.signal)
    } catch (error) {
      if (error instanceof SourceVerificationError) throw error
      reject(SOURCE_VERIFICATION_ERROR_CODES.UNAVAILABLE, error)
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (availabilityTimer !== undefined) cancelScheduled(availabilityTimer)
    }
    const evidence = validateAvailability(availability, currentTime(now), maximumEvidenceLifetimeMs)
    await namespace.catalog.update?.()
    const finalHead = catalogHead(await getPublisherViewHead(namespace.view))
    const finalDescriptorEntry = await namespace.view.get('state/descriptor')
    const finalDescriptor = finalDescriptorEntry?.value ? decodePublisherNamespaceDescriptor(finalDescriptorEntry.value) : null
    if (!finalDescriptor || finalDescriptor.catalogEpoch !== namespace.descriptor.catalogEpoch || !sameHead(firstHead, finalHead)) {
      reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_NOT_CURRENT)
    }
    await loadCurrentOperation(namespace.view, locator.sourceRecordRef, namespace.descriptor, namespace.authorization)
    await loadCurrentOperation(namespace.view, locator.publicationSourceRecordRef, namespace.descriptor, namespace.authorization)

    return deepFreezeCandidate({
      ...record.candidate,
      edition: null,
      work: {
        entityId: record.candidate.work.entityId,
        title: manifest.body.title,
        releaseYear: null,
        externalRefs: [{ ...claim.payload.externalRef }],
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
          provenance: manifest.body.provenance.map(value => ({ ...value })),
          claims: manifest.body.claims.map(value => ({ ...value })),
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
    try {
      timer = schedule(() => controller.abort(new SourceVerificationError(SOURCE_VERIFICATION_ERROR_CODES.VERIFICATION_TIMEOUT)), verificationDeadlineMs)
      return await raceAbort(execute(record, controller.signal), controller.signal)
    } catch (error) {
      if (error instanceof SourceVerificationError) throw error
      reject(SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID, error)
    } finally {
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
    return true
  }

  return Object.freeze({ verifySelectedCandidate, close })
}

export function createScopedAssetAvailabilityProbe({ scopedNetwork, now = Date.now, evidenceLifetimeMs = 5_000 } = {}) {
  if (!scopedNetwork || typeof scopedNetwork.retainAuthorizedRendition !== 'function' ||
      typeof scopedNetwork.requestAssetBlocks !== 'function' ||
      typeof scopedNetwork.releaseAuthorizedRendition !== 'function') {
    throw new TypeError('scoped asset range transport is required')
  }
  const lifetime = boundedInteger(evidenceLifetimeMs, 5_000, DEFAULT_MAX_EVIDENCE_LIFETIME_MS, 'evidenceLifetimeMs')
  return async function probe({ manifest, publicationId, renditionId, assetId, range, signal }) {
    await scopedNetwork.retainAuthorizedRendition({
      manifest,
      renditionId,
      ownerId: publicationId,
      start: range.startBlock,
      end: range.endBlock,
    })
    try {
      const result = await scopedNetwork.requestAssetBlocks({
        assetId,
        startBlock: range.startBlock,
        endBlock: range.endBlock,
        signal,
      })
      const verified = Array.isArray(result?.verifiedBlockIndexes) && result.verifiedBlockIndexes.includes(range.startBlock)
      const observedAtMs = currentTime(now)
      const peers = verified ? Math.max(1, Array.isArray(result.peerIds) ? result.peerIds.length : 0) : 0
      return { peers, completeSeeders: verified ? 1 : 0, observedAtMs, expiresAtMs: observedAtMs + lifetime }
    } finally {
      await scopedNetwork.releaseAuthorizedRendition({ renditionId, ownerId: publicationId, assetId })
    }
  }
}
