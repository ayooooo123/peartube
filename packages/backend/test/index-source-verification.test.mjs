import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import Corestore from 'corestore'

import { episodeWorkIdentifier } from '../src/channel/structured-content.js'
import { createCompanionRouter } from '../../cli/src/companion/routes.js'
import { createApi } from '../src/api.js'
import {
  createPublicationManifest,
  createRenditionDescriptor,
  createStaticAssetManifest,
  encodePublicationManifest,
} from '../src/assets/index.js'
import {
  PUBLISHER_RECORD_TYPES,
  createPublisherAuthorizationState,
  createPublisherNamespaceDescriptor,
  encodePublisherAuthorizationState,
  encodePublisherCatalogFrame,
  encodePublisherNamespaceDescriptor,
  encodePublisherOperationBody,
} from '../src/publisher/index.js'
import {
  attachSignedEnvelopeSignature,
  prepareSignedEnvelope,
  signedRecordSignaturePreimage,
} from '../src/records/index.js'
import { createEntityReference, createMediaClaim } from '../src/media-graph/index.js'
import { encodeApplicationEnvelope } from '../src/records/application-envelope.js'
import { createIndexFederation } from '../src/search/index-federation.js'
import {
  SOURCE_VERIFICATION_ERROR_CODES,
  createLocalAssetAvailabilityProbe,
  createScopedAssetAvailabilityProbe,
  createSourceVerifier,
} from '../src/search/source-verifier.js'
import {
  normalizeIndexCandidateForTransport,
  normalizeIndexCandidateFromTransport,
  searchIndexCandidatesForTransport,
  verifyIndexCandidateForTransport,
} from '../src/search/candidate-contract.js'
import { COLLECTIONS, createIndexerStore } from '../src/indexer/index.js'
import { createIndexVerificationRuntime } from '../src/runtime.js'

const NOW = 1_800_000_000_000
const EPISODE_SELECTOR = Object.freeze({ namespace: 'tmdb', identifier: '95350', kind: 'episode', season: 1, episode: 2 })
const SELECTOR = Object.freeze({ namespace: 'tmdb', identifier: '348', kind: 'movie' })
const require = createRequire(import.meta.url)
const schemaCodecs = require('../../spec/spec/schema/index.js')

function hex(value) {
  return b4a.toString(value, 'hex')
}

function randomSource(start = 0) {
  let value = start
  return size => b4a.alloc(size, ++value)
}

function exactResult(fixture) {
  return {
    type: 'external-ref',
    publisherId: fixture.publisherId,
    sourceRecordRef: fixture.sourceRecordRef,
    namespace: fixture.selector.namespace,
    identifier: fixture.workIdentifier,
    entityKind: 'work',
    entityId: fixture.workEntityId,
    evidenceWeight: 10,
  }
}

function serviceFor(fixture, state = {}) {
  return {
    indexerId: '91'.repeat(32),
    async queryIndexService({ query }) {
      state.searchCalls = (state.searchCalls || 0) + 1
      let results
      if (query.selectors[0].type === 'exact-external-ref') {
        results = [{ ...exactResult(fixture), ...state.indexOverrides?.external }]
      } else if (query.selectors[0].type === 'publication-by-work') {
        results = [{
          type: 'publication',
          publisherId: fixture.publisherId,
          sourceRecordRef: fixture.publicationSourceRecordRef,
          publicationId: fixture.manifest.publicationId,
          workEntityId: fixture.workEntityId,
          normalizedTitle: fixture.manifest.body.unsignedBody.title,
          releaseYear: null,
          manifestId: fixture.manifest.body.manifestId,
          provenanceSummary: null,
          ...state.indexOverrides?.publication,
        }]
      } else {
        results = fixture.renditions.map(({ descriptor: rendition, asset }) => ({
          type: 'rendition',
          publisherId: fixture.publisherId,
          sourceRecordRef: fixture.publicationSourceRecordRef,
          publicationId: fixture.manifest.publicationId,
          renditionId: rendition.renditionId,
          assetId: asset.assetId,
          format: rendition.format,
          codec: null,
          dimensions: null,
          mediaFeatures: rendition.purpose,
          byteLength: asset.byteLength,
          ...state.indexOverrides?.rendition,
        }))
      }
      return {
        queryId: query.queryId,
        results,
        nextCursor: null,
        sourceRevision: '0:1',
      }
    },
  }
}

function unsafeKeys(value, path = '') {
  if (!value || typeof value !== 'object') return []
  const found = []
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key
    if (/(?:url|credential|cookie|header|control|sourceRecordRef|secretKey)/i.test(key)) found.push(childPath)
    found.push(...unsafeKeys(child, childPath))
  }
  return found
}

class MemoryView {
  constructor(key) {
    this.key = b4a.from(key)
    this.core = { length: 0 }
    this.entries = new Map()
  }

  async ready() {}

  async get(key) {
    const value = this.entries.get(String(key))
    return value === undefined ? null : { key: String(key), value }
  }

  async put(key, value) {
    this.entries.set(String(key), b4a.from(value))
    this.core.length++
  }

  async del(key) {
    if (this.entries.delete(String(key))) this.core.length++
  }

  async * createReadStream() {
    const entries = [...this.entries].sort(([left], [right]) => left.localeCompare(right))
    for (const [key, value] of entries) yield { key: b4a.from(key), value }
  }
}

function signPublisherOperation({ descriptor, signer, recordType = PUBLISHER_RECORD_TYPES.PUBLICATION, body, sequence = 1 }) {
  const prepared = prepareSignedEnvelope({
    recordType,
    schemaMajor: 1,
    schemaMinor: 0,
    issuerIdentityKey: descriptor.publisherId,
    signerKey: signer.publicKey,
    policyEpoch: 0,
    issuerSequence: sequence,
    signedAt: NOW - 1_000,
    canonicalBody: encodePublisherOperationBody(recordType, body),
  }, { hash: crypto.hash })
  return attachSignedEnvelopeSignature(
    prepared,
    crypto.sign(signedRecordSignaturePreimage(prepared), signer.secretKey),
  )
}

async function sourceFixture(options = {}) {
  const selector = options.selector || SELECTOR
  const workIdentifier = selector.kind === 'episode'
    ? episodeWorkIdentifier(selector.identifier, selector.season, selector.episode)
    : selector.identifier
  const catalogKey = options.catalogKey || b4a.alloc(32, 31)
  const view = new MemoryView(options.viewKey || b4a.alloc(32, 32))
  const root = crypto.keyPair(b4a.alloc(32, options.rootSeed || 11))
  const device = crypto.keyPair(b4a.alloc(32, options.deviceSeed || 12))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: catalogKey,
  })
  const work = createEntityReference({
    entityKind: 'work',
    namespace: selector.namespace,
    normalizedIdentifier: workIdentifier,
  })
  let externalClaim = createMediaClaim({
    claimType: 'ExternalReferenceClaim',
    subjectRefs: [work],
    payload: {
      externalRef: {
        namespace: selector.namespace,
        identifier: workIdentifier,
        ...(options.externalRefExtras || {}),
      },
      ...(options.claimPayloadExtras || {}),
    },
    confidence: 900,
    issuerSequence: 1,
    policyEpoch: 0,
    keyPair: device,
    signedAt: NOW - 1_000,
  })
  const staticAsset = createStaticAssetManifest({
    treeHash: b4a.alloc(32, options.assetSeed || 41),
    blockLength: 2,
    byteLength: 256 * 1024 + 17,
  })
  const rendition = createRenditionDescriptor({
    purpose: 'original',
    format: 'video/mp4',
    core: staticAsset,
  })
  const secondStaticAsset = options.twoRenditions
    ? createStaticAssetManifest({
      treeHash: b4a.alloc(32, options.secondAssetSeed || 42),
      blockLength: 3,
      byteLength: 2 * 256 * 1024 + 17,
    })
    : null
  const secondRendition = secondStaticAsset
    ? createRenditionDescriptor({ purpose: 'original', format: 'video/webm', core: secondStaticAsset })
    : null
  const renditionFixtures = [
    { descriptor: rendition, asset: staticAsset },
    ...(secondRendition ? [{ descriptor: secondRendition, asset: secondStaticAsset }] : []),
  ]
  const manifest = createPublicationManifest({
    publisherId: descriptor.publisherId,
    sequence: 1,
    title: 'Current signed source',
    renditions: renditionFixtures.map(value => value.descriptor),
    provenance: options.provenance || [{ sourceKind: 'upload', releaseName: 'Current signed source' }],
    keyPair: device,
    claims: options.unlinkedManifest ? [] : [{ claimId: externalClaim.claimId, role: 'work', entityId: work.entityId }],
    signedAt: NOW - 1_000,
  })
  if (options.publicationBoundClaim) {
    externalClaim = createMediaClaim({
      claimType: 'EntityMetadataClaim',
      subjectRefs: [work],
      payload: {
        presentationKind: selector.kind,
        publicationId: manifest.publicationId,
        title: 'Current signed source',
        sourceFileName: 'Current.signed.source.1080p.WEB-DL.mkv',
      },
      confidence: 900,
      issuerSequence: 1,
      policyEpoch: 0,
      keyPair: device,
      signedAt: NOW - 1_000,
    })
  }
  const operation = signPublisherOperation({
    descriptor,
    signer: device,
    body: {
      publicationId: b4a.from(manifest.publicationId, 'hex'),
      manifestId: b4a.from(options.operationManifestId || manifest.body.manifestId, 'hex'),
      payload: options.manifestPayload || encodePublicationManifest(manifest),
    },
  })
  const claimOperation = signPublisherOperation({
    descriptor,
    signer: device,
    recordType: PUBLISHER_RECORD_TYPES.CLAIM,
    sequence: 2,
    body: {
      claimId: b4a.from(externalClaim.claimId, 'hex'),
      claimType: externalClaim.body.claimType,
      payload: encodeApplicationEnvelope(externalClaim.envelope),
    },
  })
  const frame = encodePublisherCatalogFrame(operation)
  const claimFrame = encodePublisherCatalogFrame(claimOperation)
  const publicationSourceRecordRef = hex(operation.recordId)
  const sourceRecordRef = hex(claimOperation.recordId)
  const authorization = createPublisherAuthorizationState(descriptor)
  const writer = {
    writerKey: b4a.from(catalogKey),
    signerKey: b4a.from(device.publicKey),
    capabilities: ['announce', 'claim', 'moderate', 'publish'],
    firstAcceptedSequence: 1,
    lastAcceptedSequence: 2,
    expiresAt: NOW + 60_000,
    admissionNonce: b4a.alloc(32, 13),
    admissionPolicyEpoch: 0,
    revocation: null,
  }
  authorization.writers.set(hex(writer.writerKey), writer)
  authorization.signers.set(hex(writer.signerKey), writer)
  await view.put('state/descriptor', encodePublisherNamespaceDescriptor(descriptor))
  await view.put('state/authorization', encodePublisherAuthorizationState(authorization))
  await view.put(`accepted/${publicationSourceRecordRef}`, options.legacyAcceptedEntries ? frame : b4a.concat([writer.writerKey, frame]))
  await view.put(`accepted/${sourceRecordRef}`, options.legacyAcceptedEntries ? claimFrame : b4a.concat([writer.writerKey, claimFrame]))
  await view.put(`projection/publication/${manifest.publicationId}`, frame)
  await view.put(`projection/claim/${externalClaim.claimId}`, claimFrame)

  let fixture
  const catalog = {
    key: b4a.from(catalogKey),
    view,
    updateCalls: 0,
    async update() {
      this.updateCalls++
      await options.onUpdate?.(this.updateCalls, fixture)
    },
  }
  const binding = {
    catalog,
    publisherId: b4a.from(descriptor.publisherId),
    genesisRootKey: b4a.from(root.publicKey),
    catalogBootstrapKey: b4a.from(catalogKey),
    namespaceDescriptor: descriptor,
  }
  const registry = {
    resolveCalls: 0,
    async resolve(publisherId) {
      this.resolveCalls++
      if (hex(publisherId) !== hex(descriptor.publisherId)) throw new Error('unknown publisher')
      return binding
    },
  }
  fixture = {
    view,
    root,
    device,
    descriptor,
    staticAsset,
    rendition,
    renditions: renditionFixtures,
    secondRendition,
    secondStaticAsset,
    manifest,
    operation,
    frame,
    claimOperation,
    claimFrame,
    externalClaim,
    selector,
    workIdentifier,
    workEntityId: work.entityId,
    publicationSourceRecordRef,
    sourceRecordRef,
    publisherId: hex(descriptor.publisherId),
    catalog,
    binding,
    registry,
  }
  return fixture
}

async function candidateHarness(options = {}) {
  const fixture = options.fixture || await sourceFixture(options)
  const cache = options.cache || new Map()
  const state = { indexOverrides: options.indexOverrides || null }
  const federation = createIndexFederation({
    services: [serviceFor(fixture, state)],
    cache,
    now: options.now || (() => NOW),
    limits: {
      randomBytes: options.randomBytes || randomSource(options.randomStart),
      candidateTtlMs: options.candidateTtlMs || 30_000,
      deadlineMs: 1_000,
    },
  })
  const [candidate] = await federation.search({ selector: fixture.selector, limit: 1 })
  const probeState = { calls: 0 }
  const availabilityProbe = options.availabilityProbe || (async () => {
    probeState.calls++
    return { peers: 2, completeSeeders: 1, observedAtMs: NOW, expiresAtMs: NOW + 5_000 }
  })
  const verifier = createSourceVerifier({
    federation,
    catalogRegistry: fixture.registry,
    availabilityProbe,
    now: options.now || (() => NOW),
    limits: {
      verificationDeadlineMs: 1_000,
      availabilityDeadlineMs: 500,
      ...(options.limits || {}),
    },
  })
  return { fixture, cache, state, federation, candidate, verifier, probeState }
}

async function expectCode(t, promise, code) {
  const outcome = await promise.then(
    value => ({ value }),
    error => ({ error }),
  )
  t.ok(outcome.error, `${code} rejection is required`)
  if (!outcome.error) return
  t.is(outcome.error.code, code)
  t.ok(
    typeof outcome.error.message === 'string' && outcome.error.message.length > 0 && outcome.error.message.length <= 128,
    'rejection has a bounded message',
  )
}

test('selected current source verifies exact canonical descriptors and fresh availability without minting a URL', async t => {
  const harness = await candidateHarness()
  t.is(harness.probeState.calls, 0, 'search remains deferred and does not probe availability')

  const verified = await harness.verifier.verifySelectedCandidate({ candidateRef: harness.candidate.candidateRef })

  t.is(harness.fixture.registry.resolveCalls, 1)
  t.is(harness.probeState.calls, 1)
  t.is(verified.verification.state, 'source-verified')
  t.is(verified.publication.publicationId, harness.fixture.manifest.publicationId)
  t.is(verified.publication.publisherId, harness.fixture.publisherId)
  t.is(verified.publication.manifestId, harness.fixture.manifest.body.manifestId)
  t.is(verified.rendition.renditionId, harness.fixture.rendition.renditionId)
  t.is(verified.rendition.container, harness.fixture.rendition.format)
  t.is(verified.asset.assetId, harness.fixture.staticAsset.assetId)
  t.is(verified.asset.coreKey, hex(harness.fixture.staticAsset.key))
  t.is(verified.asset.blockLength, harness.fixture.staticAsset.length)
  t.is(verified.asset.byteLength, harness.fixture.staticAsset.byteLength)
  t.alike(verified.availability, { peers: 2, completeSeeders: 1, observedAtMs: NOW, expiresAtMs: NOW + 5_000 })
  t.is(verified.verification.publisherDescriptor.publisherId, harness.fixture.publisherId)
  t.is(verified.verification.publisherDescriptor.catalogEpoch, 0)
  t.is(verified.edition, null)
  t.is(Object.isFrozen(verified.publication.descriptor), true)
  t.alike(Object.keys(verified.publication.descriptor).sort(), ['manifestId', 'publicationId', 'title'])
  t.is(Object.isFrozen(verified.rendition.descriptor.core), true)
  t.is(Object.isFrozen(verified.asset.descriptor), true)
  t.alike(verified.provenance, {
    sourceKind: null,
    releaseName: null,
    publicInfohash: null,
  })
  t.is(verified.verification.catalogHead.digest, verified.publication.catalogHead)
  t.alike(unsafeKeys(verified), [])
  t.is(Object.isFrozen(verified), true)
  t.is(Object.isFrozen(verified.verification.publisherDescriptor), true)
  const transported = normalizeIndexCandidateForTransport(verified)
  t.is(transported.verification.publisherDescriptor.publisherRootKey, hex(harness.fixture.descriptor.publisherRootKey))
  t.is(transported.verification.publisherDescriptor.policySequence, harness.fixture.descriptor.policySequence)
})

test('legacy accepted entries without writer provenance still verify', async t => {
  const harness = await candidateHarness({ legacyAcceptedEntries: true })
  const verified = await harness.verifier.verifySelectedCandidate({ candidateRef: harness.candidate.candidateRef })
  t.is(verified.verification.state, 'source-verified')
  await harness.verifier.close()
  await harness.federation.close()
})

test('real null-fact federation candidate searches, verifies, transports, and codec-round-trips without sentinels', async t => {
  const harness = await candidateHarness({
    indexOverrides: { rendition: { format: null, byteLength: null } },
  })
  t.is(harness.candidate.rendition.container, null)
  t.is(harness.candidate.rendition.byteLength, null)
  t.is(harness.candidate.asset.byteLength, null)

  const searched = await searchIndexCandidatesForTransport({
    searchIndexCandidates: async () => [harness.candidate],
  }, { selector: SELECTOR })
  t.ok(searched.success)
  t.absent(Object.hasOwn(searched.candidates[0].rendition, 'container'))
  t.is(searched.candidates[0].rendition.byteLength, 0)
  t.is(searched.candidates[0].rendition.byteLengthPresent, false)
  t.is(searched.candidates[0].asset.byteLength, 0)
  t.is(searched.candidates[0].asset.byteLengthPresent, false)
  const searchedDecoded = schemaCodecs.decode(
    '@peartube/index-candidate-v2',
    schemaCodecs.encode('@peartube/index-candidate-v2', searched.candidates[0]),
  )
  t.is(searchedDecoded.rendition.container, null)
  t.is(searchedDecoded.rendition.byteLengthPresent, false)
  t.is(searchedDecoded.asset.byteLengthPresent, false)
  const searchedPublic = normalizeIndexCandidateFromTransport(searchedDecoded)
  t.is(searchedPublic.rendition.byteLength, null)
  t.is(searchedPublic.asset.byteLength, null)

  const verified = await verifyIndexCandidateForTransport({
    verifyIndexCandidate: candidateRef => harness.verifier.verifySelectedCandidate({ candidateRef }),
  }, { candidateRef: harness.candidate.candidateRef })
  t.ok(verified.success)
  t.is(verified.candidate.rendition.container, harness.fixture.rendition.format)
  t.is(verified.candidate.rendition.byteLength, harness.fixture.staticAsset.byteLength)
  t.is(verified.candidate.asset.byteLength, harness.fixture.staticAsset.byteLength)
  t.is(verified.candidate.verification.publisherDescriptor.publisherRootKey, hex(harness.fixture.descriptor.publisherRootKey))
  t.is(verified.candidate.verification.publisherDescriptor.policySequence, harness.fixture.descriptor.policySequence)
  const verifiedDecoded = schemaCodecs.decode(
    '@peartube/index-candidate-v2',
    schemaCodecs.encode('@peartube/index-candidate-v2', verified.candidate),
  )
  t.is(verifiedDecoded.rendition.byteLengthPresent, true)
  const verifiedPublic = normalizeIndexCandidateFromTransport(verifiedDecoded)
  t.is(verifiedPublic.rendition.byteLength, harness.fixture.staticAsset.byteLength)
  t.is(verifiedDecoded.rendition.byteLength, harness.fixture.staticAsset.byteLength)
  t.is(verifiedDecoded.verification.publisherDescriptor.publisherRootKey, hex(harness.fixture.descriptor.publisherRootKey))
})

test('forged publisher root and bootstrap bindings fail before manifest or availability use', async t => {
  for (const mutation of ['root', 'bootstrap', 'catalog-key', 'descriptor-policy']) {
    const harness = await candidateHarness()
    if (mutation === 'root') harness.fixture.binding.genesisRootKey = b4a.alloc(32, 99)
    if (mutation === 'bootstrap') harness.fixture.binding.catalogBootstrapKey = b4a.alloc(32, 98)
    if (mutation === 'catalog-key') harness.fixture.catalog.key = b4a.alloc(32, 97)
    if (mutation === 'descriptor-policy') {
      await harness.fixture.view.put('state/descriptor', encodePublisherNamespaceDescriptor({
        ...harness.fixture.descriptor,
        policySequence: harness.fixture.descriptor.policySequence + 1,
      }))
    }

    await expectCode(
      t,
      harness.verifier.verifySelectedCandidate({ candidateRef: harness.candidate.candidateRef }),
      SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID,
    )
    t.is(harness.probeState.calls, 0)
  }
})

test('wrong manifest, rendition, asset, and reconstructed static-key facts fail closed', async t => {
  const wrongManifest = await candidateHarness({ operationManifestId: 'ff'.repeat(32) })
  await expectCode(
    t,
    wrongManifest.verifier.verifySelectedCandidate({ candidateRef: wrongManifest.candidate.candidateRef }),
    SOURCE_VERIFICATION_ERROR_CODES.SOURCE_MISMATCH,
  )
  for (const rendition of [
    { renditionId: 'ee'.repeat(32) },
    { assetId: 'dd'.repeat(32) },
  ]) {
    const harness = await candidateHarness({ indexOverrides: { rendition } })
    await expectCode(
      t,
      harness.verifier.verifySelectedCandidate({ candidateRef: harness.candidate.candidateRef }),
      SOURCE_VERIFICATION_ERROR_CODES.SOURCE_MISMATCH,
    )
    t.is(harness.probeState.calls, 0)
  }
  const misleading = await candidateHarness({
    indexOverrides: {
      external: { entityId: 'fa'.repeat(32) },
      publication: { workEntityId: 'fa'.repeat(32), normalizedTitle: 'Untrusted index title' },
      rendition: { format: 'video/webm', byteLength: 1 },
    },
  })
  const corrected = await misleading.verifier.verifySelectedCandidate({
    candidateRef: misleading.candidate.candidateRef,
  })
  t.is(misleading.candidate.work.entityId, 'fa'.repeat(32))
  t.is(corrected.work.entityId, misleading.fixture.workEntityId)
  t.is(corrected.work.title, misleading.fixture.manifest.body.title)
  t.is(corrected.rendition.container, misleading.fixture.rendition.format)
  t.is(corrected.rendition.byteLength, misleading.fixture.staticAsset.byteLength)
  t.is(corrected.asset.byteLength, misleading.fixture.staticAsset.byteLength)
  t.is(misleading.probeState.calls, 1)


  for (const offset of [17, 73, 141]) {
    const harness = await candidateHarness()
    const forged = b4a.from(harness.fixture.frame)
    forged[offset] ^= 0xff
    await harness.fixture.view.put(`accepted/${harness.fixture.sourceRecordRef}`, forged)
    await harness.fixture.view.put(`projection/publication/${harness.fixture.manifest.publicationId}`, forged)
    await expectCode(
      t,
      harness.verifier.verifySelectedCandidate({ candidateRef: harness.candidate.candidateRef }),
      SOURCE_VERIFICATION_ERROR_CODES.SOURCE_INVALID,
    )
  }
})

test('accepted but retracted, superseded, or non-current source records are rejected', async t => {
  const retracted = await candidateHarness()
  await retracted.fixture.view.del(`projection/publication/${retracted.fixture.manifest.publicationId}`)
  await expectCode(
    t,
    retracted.verifier.verifySelectedCandidate({ candidateRef: retracted.candidate.candidateRef }),
    SOURCE_VERIFICATION_ERROR_CODES.SOURCE_NOT_CURRENT,
  )

  const superseded = await candidateHarness()
  const replacement = await sourceFixture({ rootSeed: 11, deviceSeed: 12, assetSeed: 53, catalogKey: superseded.fixture.view.key })
  const externalRetracted = await candidateHarness()
  await externalRetracted.fixture.view.del(`projection/claim/${externalRetracted.fixture.externalClaim.claimId}`)
  await expectCode(
    t,
    externalRetracted.verifier.verifySelectedCandidate({ candidateRef: externalRetracted.candidate.candidateRef }),
    SOURCE_VERIFICATION_ERROR_CODES.SOURCE_NOT_CURRENT,
  )

  await superseded.fixture.view.put(
    `projection/publication/${superseded.fixture.manifest.publicationId}`,
    replacement.frame,
  )
  await expectCode(
    t,
    superseded.verifier.verifySelectedCandidate({ candidateRef: superseded.candidate.candidateRef }),
    SOURCE_VERIFICATION_ERROR_CODES.SOURCE_NOT_CURRENT,
  )

  const neverAccepted = await candidateHarness()
  await neverAccepted.fixture.view.del(`accepted/${neverAccepted.fixture.sourceRecordRef}`)
  await expectCode(
    t,
    neverAccepted.verifier.verifySelectedCandidate({ candidateRef: neverAccepted.candidate.candidateRef }),
    SOURCE_VERIFICATION_ERROR_CODES.SOURCE_NOT_CURRENT,
  )
})

test('catalog head or epoch changes during the live probe invalidate the selected source', async t => {
  const changedHead = await candidateHarness({
    availabilityProbe: async ({ catalog }) => {
      await catalog.view.put('state/unrelated-current-change', b4a.from('changed'))
      return { peers: 1, completeSeeders: 1, observedAtMs: NOW, expiresAtMs: NOW + 1_000 }
    },
  })
  await expectCode(
    t,
    changedHead.verifier.verifySelectedCandidate({ candidateRef: changedHead.candidate.candidateRef }),
    SOURCE_VERIFICATION_ERROR_CODES.SOURCE_NOT_CURRENT,
  )

  const changedEpoch = await candidateHarness({
    availabilityProbe: async ({ catalog, descriptor }) => {
      const nextRoot = crypto.keyPair(b4a.alloc(32, 77))
      const rotated = createPublisherNamespaceDescriptor({
        genesisRootKey: changedEpoch.fixture.root.publicKey,
        publisherRootKey: nextRoot.publicKey,
        catalogBootstrapKey: catalog.key,
        catalogEpoch: descriptor.catalogEpoch + 1,
        previousRootKey: descriptor.publisherRootKey,
        rootTransitionProof: b4a.alloc(32, 78),
      })
      await catalog.view.put('state/descriptor', encodePublisherNamespaceDescriptor(rotated))
      return { peers: 1, completeSeeders: 1, observedAtMs: NOW, expiresAtMs: NOW + 1_000 }
    },
  })
  await expectCode(
    t,
    changedEpoch.verifier.verifySelectedCandidate({ candidateRef: changedEpoch.candidate.candidateRef }),
    SOURCE_VERIFICATION_ERROR_CODES.SOURCE_NOT_CURRENT,
  )
})

test('expired, forged, and cross-federation candidate references remain local and fail closed', async t => {
  let now = NOW
  const expired = await candidateHarness({ now: () => now, candidateTtlMs: 10 })
  now += 11
  await expectCode(
    t,
    expired.verifier.verifySelectedCandidate({ candidateRef: expired.candidate.candidateRef }),
    SOURCE_VERIFICATION_ERROR_CODES.CANDIDATE_EXPIRED,
  )
  await expectCode(
    t,
    expired.verifier.verifySelectedCandidate({ candidateRef: 'A'.repeat(43) }),
    SOURCE_VERIFICATION_ERROR_CODES.CANDIDATE_EXPIRED,
  )

  const sharedCache = new Map()
  const first = await candidateHarness({ cache: sharedCache, randomStart: 0 })
  const second = await candidateHarness({ cache: sharedCache, randomStart: 0 })
  await expectCode(
    t,
    second.verifier.verifySelectedCandidate({ candidateRef: first.candidate.candidateRef }),
    SOURCE_VERIFICATION_ERROR_CODES.CANDIDATE_EXPIRED,
  )
})

test('availability timeout, malformed evidence, unavailable evidence, and caller abort have explicit codes', async t => {
  let timeoutAbort = false
  const timeout = await candidateHarness({ availabilityProbe: ({ signal }) => new Promise(() => {
    signal.addEventListener('abort', () => { timeoutAbort = true }, { once: true })
  }) })
  await expectCode(
    t,
    timeout.verifier.verifySelectedCandidate({ candidateRef: timeout.candidate.candidateRef }),
    SOURCE_VERIFICATION_ERROR_CODES.AVAILABILITY_TIMEOUT,
  )
  t.is(timeoutAbort, true)

  for (const evidence of [
    { peers: 1, completeSeeders: 2, observedAtMs: NOW, expiresAtMs: NOW + 1_000 },
    { peers: 1, completeSeeders: 1, observedAtMs: NOW, expiresAtMs: NOW + 60_000, extra: true },
    { peers: 1, completeSeeders: 1, observedAtMs: NOW + 1, expiresAtMs: NOW + 1_000 },
    { peers: 1, completeSeeders: 1, observedAtMs: NOW, expiresAtMs: NOW + 60_000 },
    { peers: 129, completeSeeders: 0, observedAtMs: NOW, expiresAtMs: NOW + 1_000 },
  ]) {
    const malformed = await candidateHarness({ availabilityProbe: async () => evidence })
    await expectCode(
      t,
      malformed.verifier.verifySelectedCandidate({ candidateRef: malformed.candidate.candidateRef }),
      SOURCE_VERIFICATION_ERROR_CODES.AVAILABILITY_INVALID,
    )
  }

  const unavailable = await candidateHarness({
    availabilityProbe: async () => ({ peers: 0, completeSeeders: 0, observedAtMs: NOW, expiresAtMs: NOW + 1_000 }),
  })
  await expectCode(
    t,
    unavailable.verifier.verifySelectedCandidate({ candidateRef: unavailable.candidate.candidateRef }),
    SOURCE_VERIFICATION_ERROR_CODES.UNAVAILABLE,
  )

  const aborted = await candidateHarness()
  const controller = new AbortController()
  controller.abort()
  await expectCode(
    t,
    aborted.verifier.verifySelectedCandidate({ candidateRef: aborted.candidate.candidateRef, signal: controller.signal }),
    SOURCE_VERIFICATION_ERROR_CODES.ABORTED,
  )
})

test('scoped availability probe entropy does not require the Web Crypto global', t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined })
  try {
    const probe = createScopedAssetAvailabilityProbe({
      scopedNetwork: {
        retainAuthorizedRendition() {},
        requestAssetBlocks() {},
        releaseAuthorizedRendition() {},
      },
    })
    t.is(typeof probe, 'function')
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor)
    else delete globalThis.crypto
  }
})

test('scoped one-block availability reports contributors without claiming a complete seeder', async t => {
  const calls = []
  const probe = createScopedAssetAvailabilityProbe({
    scopedNetwork: {
      async retainAuthorizedRendition(request) {
        calls.push(['retain', request])
      },
      async requestAssetBlocks(request) {
        calls.push(['request', request])
        return { verifiedBlockIndexes: [0], peerIds: ['peer-a', 'peer-b'] }
      },
      async releaseAuthorizedRendition(request) {
        calls.push(['release', request])
      },
    },
    now: () => NOW,
    evidenceLifetimeMs: 1_000,
    randomBytes: size => b4a.alloc(size, 7),
  })
  const request = {
    manifest: { publicationId: 'manifest' },
    publicationId: 'publication',
    renditionId: 'rendition',
    assetId: 'asset',
    range: { startBlock: 0, endBlock: 1 },
    signal: new AbortController().signal,
  }
  const evidence = await probe(request)
  const secondEvidence = await probe(request)
  t.alike(evidence, { peers: 2, completeSeeders: 0, observedAtMs: NOW, expiresAtMs: NOW + 1_000 })
  t.alike(secondEvidence, evidence)
  t.alike(calls.map(([kind]) => kind), ['retain', 'request', 'release', 'retain', 'request', 'release'])
  t.is(calls.filter(([kind]) => kind === 'request').every(([, value]) => value.requirePeerEvidence === true), true)
  const ownerIds = calls.filter(([kind]) => kind === 'retain').map(([, value]) => value.ownerId)
  const releasedOwnerIds = calls.filter(([kind]) => kind === 'release').map(([, value]) => value.ownerId)
  t.is(new Set(ownerIds).size, 2)
  t.is(ownerIds.includes('publication'), false)
  t.alike(releasedOwnerIds, ownerIds)
})
test('availability timeout returns promptly but close waits for delayed retain rollback', async t => {
  let retainStarted
  const started = new Promise(resolve => { retainStarted = resolve })
  let finishRetain
  const delayedRetain = new Promise(resolve => { finishRetain = resolve })
  const calls = []
  const availabilityProbe = createScopedAssetAvailabilityProbe({
    scopedNetwork: {
      async retainAuthorizedRendition(request) {
        calls.push(['retain', request])
        retainStarted()
        return delayedRetain
      },
      async requestAssetBlocks(request) {
        calls.push(['request', request])
        return { verifiedBlockIndexes: [0], peerIds: ['peer'] }
      },
      async releaseAuthorizedRendition(request) {
        calls.push(['release', request])
      },
    },
    now: () => NOW,
    randomBytes: size => b4a.alloc(size, 8),
  })
  const harness = await candidateHarness({
    availabilityProbe,
    limits: { availabilityDeadlineMs: 20, verificationDeadlineMs: 100 },
  })
  const verification = harness.verifier.verifySelectedCandidate({
    candidateRef: harness.candidate.candidateRef,
  })
  await started
  await expectCode(t, verification, SOURCE_VERIFICATION_ERROR_CODES.AVAILABILITY_TIMEOUT)

  let closeSettled = false
  const closing = harness.verifier.close().then(value => {
    closeSettled = true
    return value
  })
  await new Promise(resolve => setImmediate(resolve))
  t.is(closeSettled, false)
  finishRetain()
  t.is(await closing, true)
  t.alike(calls.map(([kind]) => kind), ['retain', 'release'])
})

test('verification timeout drains execute and prevents a late catalog resolution from continuing', async t => {
  const harness = await candidateHarness({ limits: { verificationDeadlineMs: 20 } })
  let release
  const stalled = new Promise(resolve => { release = resolve })
  let readyCalls = 0
  harness.fixture.registry.resolve = async () => {
    await stalled
    return harness.fixture.binding
  }
  harness.fixture.binding.catalog.ready = async () => { readyCalls++ }

  await expectCode(
    t,
    harness.verifier.verifySelectedCandidate({ candidateRef: harness.candidate.candidateRef }),
    SOURCE_VERIFICATION_ERROR_CODES.VERIFICATION_TIMEOUT,
  )
  t.is(await harness.verifier.close(), true)
  release()
  await Promise.resolve()
  await Promise.resolve()
  t.is(readyCalls, 0)
})

test('close aborts and drains verification, invalidates owned refs, and preserves caller cache entries', async t => {
  let probeStarted
  const started = new Promise(resolve => { probeStarted = resolve })
  let probeAborted = false
  const external = Object.freeze({ owner: 'caller', candidate: 'keep' })
  const cache = new Map([['external', external]])
  const harness = await candidateHarness({
    cache,
    availabilityProbe: ({ signal }) => new Promise((resolve, reject) => {
      probeStarted()
      signal.addEventListener('abort', () => {
        probeAborted = true
        reject(signal.reason)
      }, { once: true })
    }),
  })
  const pending = harness.verifier.verifySelectedCandidate({ candidateRef: harness.candidate.candidateRef })
  await started
  const closing = harness.verifier.close()
  await expectCode(t, pending, SOURCE_VERIFICATION_ERROR_CODES.VERIFIER_CLOSED)
  await closing
  t.is(probeAborted, true)
  await harness.federation.close()
  t.is(cache.get('external'), external)
  t.is(cache.has(harness.candidate.candidateRef), false)
})

test('real index store traversal emits two rendition candidates and verifies only client application selected second tuple', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-selected-source-'))
  const store = new Corestore(directory)
  await store.ready()
  const high = { maxRetainedBytes: 20_000_000, maxRows: 200 }
  const index = await createIndexerStore({
    store,
    limits: {
      global: high,
      shard: high,
      publisher: high,
      trustClasses: { untrusted: high, trusted: high },
    },
  })
  t.teardown(async () => {
    await index.close()
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const fixture = await sourceFixture({ twoRenditions: true })
  const rows = [
    {
      collection: COLLECTIONS.externalReferenceProjections,
      record: {
        publisherId: fixture.publisherId,
        sourceRecordRef: fixture.sourceRecordRef,
        namespace: SELECTOR.namespace,
        normalizedIdentifier: SELECTOR.identifier,
        entityKind: 'work',
        entityId: fixture.workEntityId,
        evidenceWeight: 10,
      },
    },
    {
      collection: COLLECTIONS.publicationProjections,
      record: {
        publisherId: fixture.publisherId,
        sourceRecordRef: fixture.publicationSourceRecordRef,
        publicationId: fixture.manifest.publicationId,
        workEntityId: fixture.workEntityId,
        normalizedTitle: fixture.manifest.body.title,
        manifestId: fixture.manifest.body.manifestId,
      },
    },
  ]
  for (const { descriptor, asset } of fixture.renditions) {
    rows.push({
      collection: COLLECTIONS.renditionProjections,
      record: {
        publisherId: fixture.publisherId,
        sourceRecordRef: fixture.publicationSourceRecordRef,
        renditionId: descriptor.renditionId,
        assetId: asset.assetId,
        format: descriptor.format,
        mediaFeatures: descriptor.purpose,
        byteLength: asset.byteLength,
      },
    }, {
      collection: COLLECTIONS.relationshipEdges,
      record: {
        publisherId: fixture.publisherId,
        sourceRecordRef: fixture.publicationSourceRecordRef,
        relationType: 'publication-rendition',
        fromId: fixture.manifest.publicationId,
        toId: descriptor.renditionId,
      },
    })
  }
  await index.replacePublisherSlice({
    publisherId: fixture.publisherId,
    rows,
    cursor: {
      publisherId: fixture.publisherId,
      catalogEpoch: 0,
      catalogBootstrapKey: hex(fixture.view.key),
      viewFork: 0,
      viewVersion: 1,
      sourceHead: 2,
      lastVerifiedDescriptor: 'current',
    },
  })
  const service = {
    indexerId: '92'.repeat(32),
    async queryIndexService({ query, signal }) {
      const pageResult = await index.queryIndexPage({
        selectors: query.selectors,
        limit: query.limit,
        continuation: null,
        sourceRevision: query.sourceRevision ?? undefined,
        signal,
      })
      const type = query.selectors[0].type
      const results = pageResult.results.map(row => {
        if (type === 'exact-external-ref') {
          return {
            type: 'external-ref', publisherId: row.publisherId, sourceRecordRef: row.sourceRecordRef,
            namespace: row.namespace, identifier: row.normalizedIdentifier, entityKind: row.entityKind,
            entityId: row.entityId, evidenceWeight: row.evidenceWeight ?? null,
          }
        }
        if (type === 'publication-by-work') {
          return {
            type: 'publication', publisherId: row.publisherId, sourceRecordRef: row.sourceRecordRef,
            publicationId: row.publicationId, workEntityId: row.workEntityId,
            normalizedTitle: row.normalizedTitle, releaseYear: row.releaseYear ?? null,
            manifestId: row.manifestId, provenanceSummary: row.provenanceSummary ?? null,
          }
        }
        return {
          type: 'rendition', publisherId: row.publisherId, sourceRecordRef: row.sourceRecordRef,
          publicationId: row.publicationId, renditionId: row.renditionId, assetId: row.assetId,
          format: row.format ?? null, codec: row.codec ?? null, dimensions: row.dimensions ?? null,
          mediaFeatures: row.mediaFeatures ?? null, byteLength: row.byteLength ?? null,
        }
      })
      return { queryId: query.queryId, results, nextCursor: null, sourceRevision: pageResult.sourceRevision }
    },
  }
  const federation = createIndexFederation({
    services: [service],
    cache: new Map(),
    now: () => NOW,
    limits: { randomBytes: randomSource(), maxCandidates: 2 },
  })
  const candidates = await federation.search({ selector: SELECTOR, limit: 2 })
  t.is(candidates.length, 2)
  const selected = candidates.find(candidate => candidate.rendition.renditionId === fixture.secondRendition.renditionId)
  t.ok(selected)
  let probedRenditionId = null
  const verifier = createSourceVerifier({
    federation,
    catalogRegistry: fixture.registry,
    now: () => NOW,
    availabilityProbe: async request => {
      probedRenditionId = request.renditionId
      return { peers: 1, completeSeeders: 1, observedAtMs: NOW, expiresAtMs: NOW + 1_000 }
    },
  })
  const verified = await verifier.verifySelectedCandidate({ candidateRef: selected.candidateRef })
  t.is(probedRenditionId, fixture.secondRendition.renditionId)
  t.is(verified.rendition.renditionId, fixture.secondRendition.renditionId)
  t.is(verified.asset.assetId, fixture.secondStaticAsset.assetId)
  await verifier.close()
  await federation.close()
})

test('root API and runtime defer source resolution until client application selects a candidate', async t => {
  const fixture = await sourceFixture({
    externalRefExtras: {
      url: 'https://forbidden.invalid/play',
      cookie: 'session=secret',
      credential: 'bearer-secret',
      headers: { authorization: 'secret' },
    },
    claimPayloadExtras: {
      playbackUrl: 'https://forbidden.invalid/signed-claim',
      credential: 'signed-claim-secret',
      controlCapability: { bearer: 'signed-control-secret' },
    },
    provenance: [{
      sourceKind: 'https://forbidden.invalid/source-kind',
      releaseName: 'https://forbidden.invalid/source-release',
      publicInfohash: 'publisher-secret-infohash',
    }],
  })
  const state = { searchCalls: 0, probeCalls: 0 }
  const lifecycle = {
    signal: new AbortController().signal,
    owned: [],
    ownResource(label, resource, method) {
      this.owned.push({ label, resource, method })
      return true
    },
  }
  const runtime = createIndexVerificationRuntime({
    services: [serviceFor(fixture, state)],
    catalogRegistry: fixture.registry,
    availabilityProbe: async () => {
      state.probeCalls++
      return { peers: 1, completeSeeders: 1, observedAtMs: NOW, expiresAtMs: NOW + 1_000 }
    },
    lifecycle,
    now: () => NOW,
    limits: { randomBytes: randomSource(), verificationDeadlineMs: 1_000, availabilityDeadlineMs: 500 },
  })
  const api = createApi({ ctx: { lifecycle }, indexVerificationRuntime: runtime })

  const [candidate] = await api.searchIndexCandidates(SELECTOR)
  t.is(state.searchCalls, 3)
  t.is(fixture.registry.resolveCalls, 0)
  t.is(state.probeCalls, 0)
  t.is(candidate.verification.state, 'unverified')

  const verified = await api.verifyIndexCandidate(candidate.candidateRef)
  t.is(verified.verification.state, 'source-verified')
  t.is(fixture.registry.resolveCalls, 1)
  t.is(state.probeCalls, 1)
  t.alike(unsafeKeys(verified), [])
  t.absent(JSON.stringify(verified).includes('forbidden.invalid'))
  t.absent(JSON.stringify(verified).includes('publisher-secret'))
  t.absent(JSON.stringify(verified).includes('bearer-secret'))
  t.is(lifecycle.owned.some(entry => entry.resource === runtime && entry.method === 'close'), true)
  const requestController = new AbortController()
  requestController.abort()
  await t.exception(api.searchIndexCandidates(SELECTOR, { signal: requestController.signal }), /aborted/i)
  await t.exception(api.verifyIndexCandidate(candidate.candidateRef, { signal: requestController.signal }), /aborted/i)
  await runtime.close()
})

test('local index candidates use verified local custody before remote peer probing', async t => {
  const fixture = await sourceFixture()
  const state = { localCalls: 0, networkCalls: 0 }
  const localService = serviceFor(fixture)
  localService.indexerId = 'local-relay-index'
  const runtime = createIndexVerificationRuntime({
    services: [localService],
    catalogRegistry: fixture.registry,
    availabilityProbe: async () => {
      state.networkCalls++
      return { peers: 0, completeSeeders: 0, observedAtMs: NOW, expiresAtMs: NOW + 1_000 }
    },
    localIndexServiceId: localService.indexerId,
    localAvailabilityProbe: async () => {
      state.localCalls++
      return { peers: 1, completeSeeders: 0, observedAtMs: NOW, expiresAtMs: NOW + 1_000 }
    },
    now: () => NOW,
    limits: { randomBytes: randomSource(), verificationDeadlineMs: 1_000, availabilityDeadlineMs: 500 },
  })
  t.teardown(() => runtime.close())

  const [candidate] = await runtime.searchIndexCandidates({ selector: SELECTOR, limit: 1 })
  const verified = await runtime.verifyIndexCandidate({ candidateRef: candidate.candidateRef })
  t.is(verified.verification.state, 'source-verified')
  t.is(state.localCalls, 1, 'the relay proved the candidate from its own custody')
  t.is(state.networkCalls, 0, 'a local candidate did not require a second network peer')
  t.is(verified.availability.peers, 1)
  t.is(verified.availability.completeSeeders, 0)
})

test('local custody probe restores and reads a block before closing its core session', async t => {
  const calls = []
  const probe = createLocalAssetAvailabilityProbe({
    now: () => NOW,
    openAssetCore: async key => {
      calls.push(['open', key])
      return {
        async get(index, options) { calls.push(['get', index, options]); return b4a.from('held') },
        async close() { calls.push(['close']) },
      }
    },
  })
  const result = await probe({
    coreKey: 'aa'.repeat(32),
    range: { startBlock: 0, endBlock: 1 },
    signal: new AbortController().signal,
  })
  t.alike(result, { peers: 1, completeSeeders: 0, observedAtMs: NOW, expiresAtMs: NOW + 5_000 })

  t.alike(calls, [
    ['open', 'aa'.repeat(32)],
    ['get', 0, { wait: false }],
    ['close'],
  ])
})

test('companion episode search opens a locally indexed candidate and reads a range', async t => {
  const fixture = await sourceFixture({
    selector: EPISODE_SELECTOR,
    unlinkedManifest: true,
    publicationBoundClaim: true,
  })
  const localService = serviceFor(fixture)
  localService.indexerId = 'local-relay-index'
  const runtime = createIndexVerificationRuntime({
    services: [localService],
    catalogRegistry: fixture.registry,
    availabilityProbe: async () => ({ peers: 0, completeSeeders: 0, observedAtMs: NOW, expiresAtMs: NOW + 1_000 }),
    localIndexServiceId: localService.indexerId,
    localAvailabilityProbe: async () => ({ peers: 1, completeSeeders: 0, observedAtMs: NOW, expiresAtMs: NOW + 1_000 }),
    now: () => NOW,
    limits: { randomBytes: randomSource(), verificationDeadlineMs: 1_000, availabilityDeadlineMs: 500 },
  })
  t.teardown(() => runtime.close())

  const streamCtx = { staticAssetPlaybackEntries: new Map() }
  const streamNetwork = {
    async retainAuthorizedRendition() {},
    async releaseAuthorizedRendition() { return { released: true } },
    getActiveAssetSession() { return { assetId: fixture.staticAsset.assetId, coreRef: fixture.staticAsset } },
    getActiveAssetPeerIds() { return [] },
    async listPeerAssetRanges() { return { ranges: [], nextCursor: null } },
    async hasVerifiedAssetBlock() { return true },
    async readVerifiedAssetBlock() { return b4a.alloc(fixture.staticAsset.blockSize, 7) },
    async requestAssetBlocks() { throw new Error('local verified bytes should be reused') },
  }
  const streamApi = createApi({ ctx: streamCtx, scopedNetwork: streamNetwork })
  const router = createCompanionRouter({
    clock: () => NOW,
    config: { client: { id: 'client' } },
    service: {
      async search({ selector, limit, signal }) {
        return { candidates: await runtime.searchIndexCandidates({ selector, limit, signal }), nextCursor: null }
      },
      async openStream({ candidateRef, signal }) {
        const candidate = await runtime.verifyIndexCandidate({ candidateRef, signal })
        const asset = await streamApi.openVerifiedCandidateStream(candidate)
        return { candidate, asset }
      },
    },
  })
  t.teardown(async () => {
    router.capabilities.clear()
    await router.capabilities.drain()
  })

  const principal = { id: 'client', publisherId: fixture.publisherId, scopes: new Set(['*']) }
  const search = await router.dispatch({
    method: 'GET',
    url: '/api/v2/search?episode=2&identifier=95350&kind=episode&namespace=tmdb&season=1',
    principal,
  })
  t.is(search.statusCode, 200)
  t.is(search.body.candidates.length, 1)

  const candidate = search.body.candidates[0]
  const directVerified = await runtime.verifyIndexCandidate({ candidateRef: candidate.candidateRef })
  t.is(directVerified.verification.state, 'source-verified')
  const opened = await router.dispatch({
    method: 'POST',
    url: '/api/v2/streams/open',
    body: b4a.from(JSON.stringify({ candidateRef: candidate.candidateRef })),
    principal,
  })
  t.is(opened.statusCode, 200)
  const streamUrl = new URL(opened.body.url, 'http://relay.local')
  const acquisition = router.capabilities.consume(streamUrl.searchParams.get('cap'), {
    publicationId: opened.body.publicationId,
    renditionId: opened.body.renditionId,
    method: 'GET',
  })
  const range = await acquisition.asset.requestRange({
    assetId: acquisition.asset.assetId,
    byteStart: 0,
    byteEnd: 1_024,
    deadlineMs: 1_000,
  })
  acquisition.release()
  t.is(range.status, 'ok')
  t.is(range.verified, true)
  t.is(range.bytes.byteLength, 1_024)
})

test('root search API forwards caller limits and abort signals to federation', async t => {
  const lifecycle = { signal: new AbortController().signal }
  const caller = new AbortController()
  let received = null
  const api = createApi({
    ctx: { lifecycle },
    indexVerificationRuntime: {
      async searchIndexCandidates (input) {
        received = input
        return []
      }
    }
  })

  await api.searchIndexCandidates(SELECTOR, { limit: 1, signal: caller.signal })
  t.is(received.limit, 1)
  t.is(received.signal, caller.signal)
})
