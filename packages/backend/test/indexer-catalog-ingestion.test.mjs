import test from 'brittle'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import b4a from 'b4a'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import crypto from 'hypercore-crypto'

import {
  COLLECTIONS,
  INDEXER_CORE_NAME,
  INDEXES,
  createCatalogIngestor,
  createIndexerStore,
  createVerifiedQueryView,
  openIndexerDatabase,
} from '../src/indexer/index.js'
import {
  PUBLISHER_RECORD_TYPES,
  createPublisherAuthorizationState,
  createPublisherNamespaceDescriptor,
  decodePublisherOperationBody,
  encodePublisherCatalogFrame,
  encodePublisherAuthorizationState,
  encodePublisherNamespaceDescriptor,
  encodePublisherOperationBody,
  getPublisherViewHead,
} from '../src/publisher/index.js'
import {
  createPublicationManifest,
  createRenditionDescriptor,
  createStaticAssetManifest,
  encodePublicationManifest,
} from '../src/assets/index.js'
import { createEntityReference, createMediaClaim } from '../src/media-graph/index.js'
import { encodeApplicationEnvelope } from '../src/records/application-envelope.js'
import {
  attachSignedEnvelopeSignature,
  prepareSignedEnvelope,
  signedRecordSignaturePreimage,
} from '../src/records/index.js'

const high = () => ({ maxRetainedBytes: 20_000_000, maxRows: 2_000 })
const limits = () => ({
  global: high(),
  shard: high(),
  publisher: high(),
  trustClasses: { untrusted: high(), trusted: high() },
})
const hex = value => b4a.toString(value, 'hex')
const bytes = value => b4a.from(value, 'hex')

function signPublisherOperation({ descriptor, signer, recordType, sequence, body, signedAt = 100, policyEpoch = 0 }) {
  const prepared = prepareSignedEnvelope({
    recordType,
    schemaMajor: 1,
    schemaMinor: 0,
    issuerIdentityKey: descriptor.publisherId,
    signerKey: signer.publicKey,
    policyEpoch,
    issuerSequence: sequence,
    signedAt,
    canonicalBody: encodePublisherOperationBody(recordType, body),
  }, { hash: crypto.hash })
  return attachSignedEnvelopeSignature(
    prepared,
    crypto.sign(signedRecordSignaturePreimage(prepared), signer.secretKey),
  )
}

function assetRef(seed, byteLength) {
  const descriptor = createStaticAssetManifest({
    treeHash: b4a.alloc(32, seed),
    blockLength: Math.ceil(byteLength / (256 * 1024)),
    byteLength,
  })
  return {
    kind: descriptor.kind,
    key: descriptor.key,
    treeHash: descriptor.treeHash,
    length: descriptor.length,
    byteLength: descriptor.byteLength,
    blockSize: descriptor.blockSize,
    assetId: descriptor.assetId,
  }
}

function rendition(seed, purpose, format, byteLength) {
  return createRenditionDescriptor({ purpose, format, core: assetRef(seed, byteLength) })
}

function publicationManifest(fixture, sequence = 1, title = '  Pilot   Episode  ', claims = []) {
  return createPublicationManifest({
    publisherId: fixture.descriptor.publisherId,
    sequence,
    title,
    description: 'A signed catalog publication',
    renditions: [rendition(31 + sequence, 'original', 'video/mp4', 300_000)],
    artwork: [rendition(41 + sequence, 'poster', 'image/jpeg', 20_000)],
    subtitles: [rendition(51 + sequence, 'subtitles', 'text/vtt', 2_000)],
    claims,
    provenance: [{ type: 'upload', source: 'fixture' }],
    keyPair: fixture.device,
    signedAt: 100,
  })
}

function publicationOperation(fixture, manifest, sequence, policyEpoch = 0) {
  return signPublisherOperation({
    descriptor: fixture.descriptor,
    signer: fixture.device,
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    sequence,
    policyEpoch,
    body: {
      publicationId: bytes(manifest.publicationId),
      manifestId: bytes(manifest.body.manifestId),
      payload: encodePublicationManifest(manifest),
    },
  })
}

function claimOperation(fixture, claimType, subjectRefs, payload, sequence) {
  const claim = createMediaClaim({
    claimType,
    subjectRefs,
    payload,
    confidence: 900,
    issuerSequence: sequence,
    policyEpoch: 0,
    keyPair: fixture.device,
    signedAt: 100,
  })
  return signPublisherOperation({
    descriptor: fixture.descriptor,
    signer: fixture.device,
    recordType: PUBLISHER_RECORD_TYPES.CLAIM,
    sequence,
    body: {
      claimId: bytes(claim.claimId),
      claimType: claim.body.claimType,
      payload: encodeApplicationEnvelope(claim.envelope),
    },
  })
}

function externalClaimOperation(fixture, sequence = 2) {
  const subject = createEntityReference({
    entityKind: 'work',
    namespace: 'catalog-test',
    normalizedIdentifier: 'pilot-episode',
  })
  return claimOperation(fixture, 'ExternalReferenceClaim', [subject], {
    externalRef: { namespace: 'imdb-title', identifier: 'TT0903747' },
  }, sequence)
}

function metadataClaimOperation(fixture, sequence = 2) {
  const subject = createEntityReference({
    entityKind: 'work',
    namespace: 'issuer-native',
    issuerRootKey: fixture.descriptor.publisherRootKey,
    issuerLocalId: 'pilot-episode',
  })
  return claimOperation(fixture, 'EntityMetadataClaim', [subject], {
    title: 'Claim-only title',
    releaseYear: 2008,
  }, sequence)
}
function availabilityWithoutAssetOperation(fixture, sequence = 2) {
  const subject = createEntityReference({
    entityKind: 'work',
    namespace: 'issuer-native',
    issuerRootKey: fixture.descriptor.publisherRootKey,
    issuerLocalId: 'pilot-episode',
  })
  return claimOperation(fixture, 'AvailabilityObservation', [subject], {
    publicationId: 'publication-without-asset',
    availabilityStatus: 'available',
  }, sequence)
}

function recordingOfOperation(fixture, {
  sequence = 2,
  subjectKind = 'recording',
  workKind = 'work',
} = {}) {
  const subject = createEntityReference({
    entityKind: subjectKind,
    namespace: 'issuer-native',
    issuerRootKey: fixture.descriptor.publisherRootKey,
    issuerLocalId: `${subjectKind}-pilot-episode`,
  })
  const workRef = createEntityReference({
    entityKind: workKind,
    namespace: 'issuer-native',
    issuerRootKey: fixture.descriptor.publisherRootKey,
    issuerLocalId: `${workKind}-pilot-episode`,
  })
  return claimOperation(fixture, 'RecordingOfClaim', [subject], { workRef }, sequence)
}


function claimProjectionId(operation) {
  return hex(decodePublisherOperationBody(operation.recordType, operation.canonicalBody).claimId)
}

async function putProjection(fixture, kind, id, operation) {
  await fixture.view.put(`projection/${kind}/${id}`, encodePublisherCatalogFrame(operation))
}

async function setWriterPolicyEpoch(fixture, { admissionPolicyEpoch, policyEpoch }) {
  fixture.persistedWriter.admissionPolicyEpoch = admissionPolicyEpoch
  fixture.authorizationState.policyEpoch = policyEpoch
  await fixture.view.put('state/authorization', encodePublisherAuthorizationState(fixture.authorizationState))
}

async function publisherRows(store, publisherId) {
  const db = await openIndexerDatabase(store, { name: INDEXER_CORE_NAME })
  try {
    const rows = {}
    for (const [shortName, index] of Object.entries(INDEXES.publisherPrefix)) {
      rows[shortName] = await db.find(index, { publisherId }).toArray()
    }
    return rows
  } finally {
    await db.close()
  }
}

async function fixture(t, { injectableIndexFailure = false, writerExpiresAt = Number.MAX_SAFE_INTEGER } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-catalog-ingestor-'))
  const catalogStore = new Corestore(path.join(directory, 'catalog'))
  const indexStore = new Corestore(path.join(directory, 'index'))
  await Promise.all([catalogStore.ready(), indexStore.ready()])

  let failNextIndexAppend = false
  const storeForIndex = injectableIndexFailure
    ? {
        root: indexStore,
        get(options) {
          const core = indexStore.get(options)
          const append = core.append.bind(core)
          core.append = async (...args) => {
            if (failNextIndexAppend) {
              failNextIndexAppend = false
              throw new Error('forced index transaction failure')
            }
            return append(...args)
          }
          return core
        },
      }
    : indexStore

  const index = await createIndexerStore({ store: storeForIndex, limits: limits() })
  const core = catalogStore.get({ name: 'publisher-catalog-ingestion-view' })
  const view = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'binary', extension: false })
  await view.ready()

  const root = crypto.keyPair(b4a.alloc(32, 11))
  const device = crypto.keyPair(b4a.alloc(32, 12))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: view.key,
  })
  const authorizationState = createPublisherAuthorizationState(descriptor)
  const persistedWriter = {
    writerKey: b4a.from(view.key),
    signerKey: b4a.from(device.publicKey),
    capabilities: ['announce', 'claim', 'moderate', 'publish'],
    firstAcceptedSequence: 1,
    lastAcceptedSequence: Number.MAX_SAFE_INTEGER,
    expiresAt: writerExpiresAt,
    admissionNonce: b4a.alloc(32, 13),
    admissionPolicyEpoch: 0,
    revocation: null,
  }
  authorizationState.writers.set(hex(persistedWriter.writerKey), persistedWriter)
  authorizationState.signers.set(hex(persistedWriter.signerKey), persistedWriter)
  await view.put('state/descriptor', encodePublisherNamespaceDescriptor(descriptor))
  await view.put('state/authorization', encodePublisherAuthorizationState(authorizationState))

  const checkouts = { opened: 0, closed: 0 }
  const checkout = view.checkout.bind(view)
  view.checkout = (version, options) => {
    checkouts.opened++
    const pinned = checkout(version, options)
    const close = pinned.close.bind(pinned)
    let closed = false
    pinned.close = async () => {
      if (!closed) {
        closed = true
        checkouts.closed++
      }
      return close()
    }
    return pinned
  }

  const authorization = {
    policyEpoch: 0,
    policySequence: 0,
    writers: [{
      key: hex(view.key),
      signerKey: hex(device.publicKey),
      capabilities: ['announce', 'claim', 'moderate', 'publish'],
      firstAcceptedSequence: 1,
      lastAcceptedSequence: Number.MAX_SAFE_INTEGER,
      expiresAt: writerExpiresAt,
      admissionPolicyEpoch: 0,
      revocation: null,
    }],
  }
  const catalog = {
    key: view.key,
    view,
    async update() {},
    async getViewHead() { return getPublisherViewHead(view) },
    async getAuthorizationState() { return authorization },
  }
  const value = {
    index,
    indexStore,
    catalogStore,
    view,
    descriptor,
    publisherId: hex(descriptor.publisherId),
    root,
    device,
    catalog,
    authorizationState,
    persistedWriter,
    checkouts,
    armIndexFailure() { failNextIndexAppend = true },
  }

  t.teardown(async () => {
    await index.close().catch(() => {})
    await view.close().catch(() => {})
    await Promise.all([catalogStore.close().catch(() => {}), indexStore.close().catch(() => {})])
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return value
}

function ingestor(fixture, index = fixture.index) {
  return createCatalogIngestor({ index, now: () => 1_000 })
}

test('initial ingestion materializes canonical raw publication and claim records plus normalized publication rendition asset and external-reference rows', async (t) => {
  const f = await fixture(t)
  const manifest = publicationManifest(f)
  const publication = publicationOperation(f, manifest, 1)
  const claim = externalClaimOperation(f)
  await putProjection(f, 'publication', manifest.publicationId, publication)
  await putProjection(f, 'claim', claimProjectionId(claim), claim)

  const result = await ingestor(f).ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog })
  const rows = await publisherRows(f.indexStore, f.publisherId)

  t.is(result.mode, 'bootstrap')
  t.is(rows.sourceRecords.length, 2)
  t.is(rows.publicationProjections.length, 1)
  t.is(rows.publicationProjections[0].publicationId, manifest.publicationId)
  t.is(rows.publicationProjections[0].workEntityId, manifest.publicationId, 'a publication without an exact signed work ref remains an isolated work group')
  t.is(rows.publicationProjections[0].normalizedTitle, 'pilot episode')
  t.is(rows.renditionProjections.length, 3)
  t.is(rows.relationshipEdges.filter(row => row.relationType === 'publication-rendition').length, 3)
  t.is(rows.relationshipEdges.filter(row => row.relationType === 'rendition-asset').length, 3)
  t.alike(
    rows.relationshipEdges
      .filter(row => row.relationType === 'title-token')
      .map(row => row.fromId)
      .sort(),
    ['episode', 'pilot'],
  )
  t.ok(rows.relationshipEdges
    .filter(row => row.relationType === 'title-token')
    .every(row => row.toId === manifest.publicationId))
  t.is(rows.externalReferenceProjections.length, 2)
  t.ok(rows.externalReferenceProjections.some(row => row.namespace === 'imdb-title' && row.normalizedIdentifier === 'tt0903747'))
  t.is(rows.sourceCursors.length, 1)
  t.is(rows.sourceCursors[0].viewVersion, f.view.version)
  t.is(rows.sourceCursors[0].catalogBootstrapKey, hex(f.view.key))
  t.is(f.checkouts.opened, 1)
  t.is(f.checkouts.closed, 1)
})

test('every canonical raw-only projection key kind retains its exact source frame without unsupported derived rows', async (t) => {
  const f = await fixture(t)
  let sequence = 1
  const projections = []
  const collectionId = b4a.alloc(32, 61)
  projections.push({
    key: `projection/collection/${hex(collectionId)}`,
    operation: signPublisherOperation({
      descriptor: f.descriptor,
      signer: f.device,
      recordType: PUBLISHER_RECORD_TYPES.COLLECTION_RELEASE,
      sequence: sequence++,
      body: {
        collectionId,
        releaseId: b4a.alloc(32, 62),
        payload: b4a.from('canonical collection release'),
      },
    }),
  })
  for (const [offset, targetType] of ['claim', 'collection', 'publication'].entries()) {
    const ownerTargetId = b4a.alloc(32, 70 + offset)
    projections.push({
      key: `projection/owner-${targetType}/${hex(ownerTargetId)}`,
      operation: signPublisherOperation({
        descriptor: f.descriptor,
        signer: f.device,
        recordType: PUBLISHER_RECORD_TYPES.OWNER_ACTION,
        sequence: sequence++,
        body: {
          action: 'feature',
          targetType,
          targetId: ownerTargetId,
          reason: b4a.from('publisher selection'),
        },
      }),
    })
    const retractionTargetId = b4a.alloc(32, 80 + offset)
    projections.push({
      key: `projection/retraction-${targetType}/${hex(retractionTargetId)}`,
      operation: signPublisherOperation({
        descriptor: f.descriptor,
        signer: f.device,
        recordType: PUBLISHER_RECORD_TYPES.RETRACTION,
        sequence: sequence++,
        body: {
          targetType,
          targetId: retractionTargetId,
          reason: b4a.from('publisher retraction'),
        },
      }),
    })
  }
  projections.push({
    key: 'projection/view-head/latest',
    operation: signPublisherOperation({
      descriptor: f.descriptor,
      signer: f.device,
      recordType: PUBLISHER_RECORD_TYPES.VIEW_HEAD,
      sequence,
      body: {
        viewKey: f.view.key,
        length: 7,
        digest: b4a.alloc(32, 90),
        authorizationStateDigest: b4a.alloc(32, 91),
      },
    }),
  })
  for (const projection of projections) {
    await f.view.put(projection.key, encodePublisherCatalogFrame(projection.operation))
  }

  const result = await ingestor(f).ingest({
    publisherId: f.publisherId,
    descriptor: f.descriptor,
    catalog: f.catalog,
  })
  const rows = await publisherRows(f.indexStore, f.publisherId)
  const expectedFrames = new Map(projections.map(({ operation }) => [
    hex(operation.recordId),
    encodePublisherCatalogFrame(operation),
  ]))

  t.is(result.mode, 'bootstrap')
  t.is(rows.sourceRecords.length, projections.length)
  for (const source of rows.sourceRecords) {
    t.ok(b4a.equals(source.canonicalEnvelope, expectedFrames.get(source.recordId)))
  }
  t.is(rows.publicationProjections.length, 0)
  t.is(rows.renditionProjections.length, 0)
  t.is(rows.externalReferenceProjections.length, 0)
  t.is(rows.availabilityProjections.length, 0)
  t.is(rows.relationshipEdges.length, 0)
  t.is(rows.sourceCursors.length, 1)
})

test('active writer epochs accept the current transitioned policy and reject pre-admission or stale operations', async (t) => {
  for (const scenario of [
    { operationPolicyEpoch: 2, accepted: true },
    { operationPolicyEpoch: 0, error: /predates writer admission/ },
    { operationPolicyEpoch: 1, error: /stale against pinned authorization state/ },
  ]) {
    const f = await fixture(t)
    await setWriterPolicyEpoch(f, { admissionPolicyEpoch: 1, policyEpoch: 2 })
    const manifest = publicationManifest(f)
    const operation = publicationOperation(f, manifest, 1, scenario.operationPolicyEpoch)
    await putProjection(f, 'publication', manifest.publicationId, operation)

    const ingestion = ingestor(f).ingest({
      publisherId: f.publisherId,
      descriptor: f.descriptor,
      catalog: f.catalog,
    })
    if (scenario.accepted) {
      const result = await ingestion
      const rows = await publisherRows(f.indexStore, f.publisherId)
      t.is(result.mode, 'bootstrap')
      t.is(rows.sourceRecords.length, 1)
      t.is(rows.sourceRecords[0].recordId, hex(operation.recordId))
    } else {
      await t.exception(ingestion, scenario.error)
      t.absent(await f.index.getSourceCursor({ publisherId: f.publisherId, catalogEpoch: 0 }))
    }
  }
})

test('token-prefix lookup uses the normalized token as fromId and returns the ingested work target', async (t) => {
  const f = await fixture(t)
  const manifest = publicationManifest(f)
  await putProjection(f, 'publication', manifest.publicationId, publicationOperation(f, manifest, 1))
  await ingestor(f).ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog })

  const db = await openIndexerDatabase(f.indexStore, { name: INDEXER_CORE_NAME })
  try {
    const found = await db.find(INDEXES.tokenPrefix, {
      relationType: 'title-token',
      fromId: 'pilot',
      limit: 10,
    }).toArray()
    t.is(found.length, 1)
    t.is(found[0].fromId, 'pilot')
    t.is(found[0].toId, manifest.publicationId)
  } finally {
    await db.close()
  }
})

test('same-fork update diffs from the exact stored cursor and advances only the changed source projection', async (t) => {
  const f = await fixture(t)
  const manifest = publicationManifest(f)
  const first = publicationOperation(f, manifest, 1)
  const claim = externalClaimOperation(f)
  await putProjection(f, 'publication', manifest.publicationId, first)
  await putProjection(f, 'claim', claimProjectionId(claim), claim)
  const catalogIngestor = ingestor(f)
  await catalogIngestor.ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog })
  const firstCursor = await f.index.getSourceCursor({ publisherId: f.publisherId, catalogEpoch: 0 })

  const replacement = publicationOperation(f, manifest, 3)
  await putProjection(f, 'publication', manifest.publicationId, replacement)
  const result = await catalogIngestor.ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog })
  const rows = await publisherRows(f.indexStore, f.publisherId)

  t.is(result.mode, 'incremental')
  t.ok(result.changed > 0)
  t.is(rows.sourceRecords.length, 2)
  t.ok(rows.sourceRecords.some(row => row.recordId === hex(replacement.recordId)))
  t.ok(rows.sourceRecords.some(row => row.recordId === hex(claim.recordId)), 'unchanged claim source remains byte-for-byte addressed by its prior record id')
  t.absent(rows.sourceRecords.some(row => row.recordId === hex(first.recordId)))
  t.ok(rows.sourceCursors[0].viewVersion > firstCursor.viewVersion)
  t.is(rows.externalReferenceProjections.length, 2, 'unchanged claim-derived rows are not rebuilt')
})

test('concurrent ingestion cannot regress a publisher cursor or normalized slice', async (t) => {
  const f = await fixture(t)
  const manifest = publicationManifest(f)
  await putProjection(f, 'publication', manifest.publicationId, publicationOperation(f, manifest, 1))
  await ingestor(f).ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog })
  await putProjection(f, 'publication', manifest.publicationId, publicationOperation(f, manifest, 3))

  let observedResolve
  const observed = new Promise(resolve => { observedResolve = resolve })
  let releaseResolve
  const release = new Promise(resolve => { releaseResolve = resolve })
  const staleIndex = {
    async getPublisherSourceCursor(input) {
      const cursor = await f.index.getPublisherSourceCursor(input)
      observedResolve()
      await release
      return cursor
    },
    getSourceCursor: input => f.index.getSourceCursor(input),
    getPublisherAdmissionLimits: input => f.index.getPublisherAdmissionLimits(input),
    replacePublisherSlice: input => f.index.replacePublisherSlice(input),
    applyPublisherChanges: input => f.index.applyPublisherChanges(input),
  }
  const staleIngestion = ingestor(f, staleIndex)
    .ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog })
  await observed

  const newest = publicationOperation(f, manifest, 4)
  await putProjection(f, 'publication', manifest.publicationId, newest)
  const freshResult = await ingestor(f)
    .ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog })
  releaseResolve()

  await t.exception(staleIngestion, /source cursor changed/)
  const rows = await publisherRows(f.indexStore, f.publisherId)
  t.is(freshResult.mode, 'incremental')
  t.is(rows.sourceRecords.length, 1)
  t.is(rows.sourceRecords[0].recordId, hex(newest.recordId))
  t.is(rows.sourceCursors[0].viewVersion, f.view.version)
})

test('re-ingesting the same pinned head is an idempotent no-op with no store mutation', async (t) => {
  const f = await fixture(t)
  const manifest = publicationManifest(f)
  await putProjection(f, 'publication', manifest.publicationId, publicationOperation(f, manifest, 1))
  const calls = { replace: 0, apply: 0 }
  const observedIndex = {
    getSourceCursor: input => f.index.getSourceCursor(input),
    getPublisherSourceCursor: input => f.index.getPublisherSourceCursor(input),
    getPublisherAdmissionLimits: input => f.index.getPublisherAdmissionLimits(input),
    replacePublisherSlice(input) { calls.replace++; return f.index.replacePublisherSlice(input) },
    applyPublisherChanges(input) { calls.apply++; return f.index.applyPublisherChanges(input) },
  }
  const catalogIngestor = ingestor(f, observedIndex)
  await catalogIngestor.ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog })
  const beforeRows = await publisherRows(f.indexStore, f.publisherId)
  const beforeUsage = await f.index.snapshotUsage()

  const replay = await catalogIngestor.ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog })

  t.is(replay.mode, 'noop')
  t.alike(calls, { replace: 1, apply: 0 })
  t.alike(await publisherRows(f.indexStore, f.publisherId), beforeRows)
  t.alike(await f.index.snapshotUsage(), beforeUsage)
})

test('same-head replay revalidates time-dependent writer authorization', async (t) => {
  const f = await fixture(t, { writerExpiresAt: 1_500 })
  const manifest = publicationManifest(f)
  await putProjection(f, 'publication', manifest.publicationId, publicationOperation(f, manifest, 1))
  let now = 1_000
  const catalogIngestor = createCatalogIngestor({ index: f.index, now: () => now })
  await catalogIngestor.ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog })
  const beforeRows = await publisherRows(f.indexStore, f.publisherId)
  now = 2_000

  await t.exception(
    catalogIngestor.ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog }),
    /authorization is expired/,
  )

  t.alike(await publisherRows(f.indexStore, f.publisherId), beforeRows)
})

test('aggregate normalized rows and bytes are bounded before index mutation', async (t) => {
  const f = await fixture(t)
  const manifest = publicationManifest(f)
  await putProjection(f, 'publication', manifest.publicationId, publicationOperation(f, manifest, 1))

  for (const [limits, pattern] of [
    [{ maxRows: 4, maxRetainedBytes: 20_000_000 }, /ingestion row budget/],
    [{ maxRows: 2_000, maxRetainedBytes: 1 }, /ingestion byte budget/],
  ]) {
    const calls = { replace: 0, apply: 0 }
    const boundedIndex = {
      getPublisherAdmissionLimits() { return limits },
      getSourceCursor: input => f.index.getSourceCursor(input),
      getPublisherSourceCursor: input => f.index.getPublisherSourceCursor(input),
      replacePublisherSlice(input) { calls.replace++; return f.index.replacePublisherSlice(input) },
      applyPublisherChanges(input) { calls.apply++; return f.index.applyPublisherChanges(input) },
    }

    await t.exception(
      createCatalogIngestor({ index: boundedIndex, now: () => 1_000 })
        .ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog }),
      pattern,
    )

    t.alike(calls, { replace: 0, apply: 0 })
    t.absent(await f.index.getSourceCursor({ publisherId: f.publisherId, catalogEpoch: 0 }))
  }
})

test('revoked writer operation within the authorized cutoff remains raw and projected', async (t) => {
  const f = await fixture(t)
  f.authorizationState.policyEpoch = 1
  f.persistedWriter.revocation = {
    revokedFromEpoch: 0,
    revokedAtEpoch: 1,
    acceptedThroughSequence: 1,
  }
  await f.view.put('state/authorization', encodePublisherAuthorizationState(f.authorizationState))
  const manifest = publicationManifest(f)
  const operation = publicationOperation(f, manifest, 1, 0)
  await putProjection(f, 'publication', manifest.publicationId, operation)

  const result = await ingestor(f).ingest({
    publisherId: f.publisherId,
    descriptor: f.descriptor,
    catalog: f.catalog,
  })
  const rows = await publisherRows(f.indexStore, f.publisherId)

  t.is(result.mode, 'bootstrap')
  t.is(rows.sourceRecords.length, 1)
  t.is(rows.sourceRecords[0].recordId, hex(operation.recordId))
  t.is(rows.publicationProjections.length, 1)
  t.is(rows.publicationProjections[0].publicationId, manifest.publicationId)
})

test('authorization-only view changes revalidate unchanged projections before cursor advancement', async (t) => {
  const f = await fixture(t)
  const manifest = publicationManifest(f)
  await putProjection(f, 'publication', manifest.publicationId, publicationOperation(f, manifest, 1))
  const catalogIngestor = ingestor(f)
  await catalogIngestor.ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog })
  const beforeRows = await publisherRows(f.indexStore, f.publisherId)
  const beforeCursor = await f.index.getSourceCursor({ publisherId: f.publisherId, catalogEpoch: 0 })

  f.persistedWriter.revocation = {
    revokedFromEpoch: 0,
    revokedAtEpoch: 1,
    acceptedThroughSequence: 0,
  }
  await f.view.put('state/authorization', encodePublisherAuthorizationState(f.authorizationState))

  await t.exception(
    catalogIngestor.ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog }),
    /revoked/,
  )

  t.alike(await publisherRows(f.indexStore, f.publisherId), beforeRows)
  t.alike(await f.index.getSourceCursor({ publisherId: f.publisherId, catalogEpoch: 0 }), beforeCursor)
})

test('projection removal deletes the exact prior raw and derived rows while atomically advancing the cursor', async (t) => {
  const f = await fixture(t)
  const manifest = publicationManifest(f)
  await putProjection(f, 'publication', manifest.publicationId, publicationOperation(f, manifest, 1))
  const catalogIngestor = ingestor(f)
  await catalogIngestor.ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog })
  const beforeCursor = await f.index.getSourceCursor({ publisherId: f.publisherId, catalogEpoch: 0 })

  await f.view.del(`projection/publication/${manifest.publicationId}`)
  await catalogIngestor.ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog })
  const rows = await publisherRows(f.indexStore, f.publisherId)

  t.is(rows.sourceRecords.length, 0)
  t.is(rows.publicationProjections.length, 0)
  t.is(rows.renditionProjections.length, 0)
  t.is(rows.relationshipEdges.length, 0)
  t.is(rows.sourceCursors.length, 1)
  t.ok(rows.sourceCursors[0].viewVersion > beforeCursor.viewVersion)
  t.is((await f.index.snapshotUsage()).global.rows, 1, 'only the source cursor remains charged')
})

test('publisher-mismatched projection fails closed before rows or cursor change', async (t) => {
  const f = await fixture(t)
  const manifest = publicationManifest(f)
  const operation = publicationOperation(f, manifest, 1)
  await putProjection(f, 'publication', 'ff'.repeat(32), operation)

  await t.exception(
    ingestor(f).ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog }),
    /projection|publicationId|mismatch/,
  )

  const rows = await publisherRows(f.indexStore, f.publisherId)
  t.is(rows.sourceRecords.length, 0)
  t.is(rows.publicationProjections.length, 0)
  t.is(rows.sourceCursors.length, 0)
  t.absent(await f.index.getSourceCursor({ publisherId: f.publisherId, catalogEpoch: 0 }))
})

test('real index transaction failure rolls back source derived rows and cursor together', async (t) => {
  const f = await fixture(t, { injectableIndexFailure: true })
  const manifest = publicationManifest(f)
  await putProjection(f, 'publication', manifest.publicationId, publicationOperation(f, manifest, 1))
  const faultingIndex = {
    async getPublisherSourceCursor(input) {
      const cursor = await f.index.getPublisherSourceCursor(input)
      f.armIndexFailure()
      return cursor
    },
    getSourceCursor: input => f.index.getSourceCursor(input),
    getPublisherAdmissionLimits: input => f.index.getPublisherAdmissionLimits(input),
    replacePublisherSlice: input => f.index.replacePublisherSlice(input),
    applyPublisherChanges: input => f.index.applyPublisherChanges(input),
  }


  await t.exception(
    ingestor(f, faultingIndex).ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog }),
    /forced index transaction failure/,
  )

  const rows = await publisherRows(f.indexStore, f.publisherId)
  t.is(rows.sourceRecords.length, 0)
  t.is(rows.publicationProjections.length, 0)
  t.is(rows.sourceCursors.length, 0)
  t.absent(await f.index.getSourceCursor({ publisherId: f.publisherId, catalogEpoch: 0 }))
})

test('valid metadata claims remain explicit raw-only records when the installed schema cannot represent work facts', async (t) => {
  const f = await fixture(t)
  const claim = metadataClaimOperation(f)
  await putProjection(f, 'claim', claimProjectionId(claim), claim)

  const result = await ingestor(f).ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog })
  const rows = await publisherRows(f.indexStore, f.publisherId)

  t.is(result.mode, 'bootstrap')
  t.is(rows.sourceRecords.length, 1)
  t.is(rows.externalReferenceProjections.length, 0)
  t.is(rows.publicationProjections.length, 0)
  t.is(rows.renditionProjections.length, 0)
  t.is(rows.availabilityProjections.length, 0)
  t.is(rows.relationshipEdges.length, 0)
  t.is(rows.sourceCursors.length, 1)
})

test('valid RecordingOfClaim with a recording subject stays raw-only when no work-recording edge exists', async (t) => {
  const f = await fixture(t)
  const claim = recordingOfOperation(f)
  await putProjection(f, 'claim', claimProjectionId(claim), claim)

  const result = await ingestor(f).ingest({
    publisherId: f.publisherId,
    descriptor: f.descriptor,
    catalog: f.catalog,
  })
  const rows = await publisherRows(f.indexStore, f.publisherId)

  t.is(result.mode, 'bootstrap')
  t.is(rows.sourceRecords.length, 1)
  t.is(rows.relationshipEdges.length, 0)
  t.is(rows.sourceCursors.length, 1)
})

test('RecordingOfClaim rejects non-work targets and non-recording subjects before index mutation', async (t) => {
  for (const options of [{ workKind: 'edition' }, { subjectKind: 'rendition' }]) {
    const f = await fixture(t)
    const claim = recordingOfOperation(f, options)
    await putProjection(f, 'claim', claimProjectionId(claim), claim)

    await t.exception(
      ingestor(f).ingest({
        publisherId: f.publisherId,
        descriptor: f.descriptor,
        catalog: f.catalog,
      }),
      /RecordingOfClaim/,
    )
    t.absent(await f.index.getSourceCursor({ publisherId: f.publisherId, catalogEpoch: 0 }))
  }
})


test('zero-expiry writer authorization is expired at a positive ingestion time', async (t) => {
  const f = await fixture(t, { writerExpiresAt: 0 })
  const manifest = publicationManifest(f)
  await putProjection(f, 'publication', manifest.publicationId, publicationOperation(f, manifest, 1))

  await t.exception(
    ingestor(f).ingest({
      publisherId: f.publisherId,
      descriptor: f.descriptor,
      catalog: f.catalog,
    }),
    /authorization is expired/,
  )

  const rows = await publisherRows(f.indexStore, f.publisherId)
  t.is(rows.sourceRecords.length, 0)
  t.is(rows.publicationProjections.length, 0)
  t.is(rows.sourceCursors.length, 0)
  t.alike(f.checkouts, { opened: 1, closed: 1 })
})

test('same-fork source behind the durable cursor rejects without publisher replacement or cursor mutation', async (t) => {
  const f = await fixture(t)
  const manifest = publicationManifest(f)
  await putProjection(f, 'publication', manifest.publicationId, publicationOperation(f, manifest, 1))
  await ingestor(f).ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog })
  const cursor = await f.index.getSourceCursor({ publisherId: f.publisherId, catalogEpoch: 0 })
  const futureCursor = {
    ...cursor,
    viewVersion: cursor.viewVersion + 10,
    sourceHead: cursor.sourceHead + 10,
  }
  await f.index.applyPublisherChanges({ publisherId: f.publisherId, operations: [], cursor: futureCursor })
  const beforeRows = await publisherRows(f.indexStore, f.publisherId)
  const calls = { replace: 0, apply: 0 }
  const observedIndex = {
    getSourceCursor: input => f.index.getSourceCursor(input),
    getPublisherSourceCursor: input => f.index.getPublisherSourceCursor(input),
    getPublisherAdmissionLimits: input => f.index.getPublisherAdmissionLimits(input),
    replacePublisherSlice(input) {
      calls.replace++
      return f.index.replacePublisherSlice(input)
    },
    applyPublisherChanges(input) {
      calls.apply++
      return f.index.applyPublisherChanges(input)
    },
  }

  await t.exception(
    ingestor(f, observedIndex).ingest({
      publisherId: f.publisherId,
      descriptor: f.descriptor,
      catalog: f.catalog,
    }),
    /behind.*cursor/,
  )

  t.alike(calls, { replace: 0, apply: 0 })
  t.alike(await publisherRows(f.indexStore, f.publisherId), beforeRows)
  t.alike(
    await f.index.getSourceCursor({ publisherId: f.publisherId, catalogEpoch: 0 }),
    futureCursor,
  )
})

test('lower-version cursor with another catalog and descriptor identity repairs from the pinned source', async (t) => {
  const f = await fixture(t)
  const manifest = publicationManifest(f)
  await putProjection(f, 'publication', manifest.publicationId, publicationOperation(f, manifest, 1))
  const catalogIngestor = ingestor(f)
  await catalogIngestor.ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog })
  const cursor = await f.index.getSourceCursor({ publisherId: f.publisherId, catalogEpoch: 0 })
  await putProjection(f, 'publication', manifest.publicationId, publicationOperation(f, manifest, 3))
  const mismatchedCursor = {
    ...cursor,
    catalogBootstrapKey: 'fd'.repeat(32),
    lastVerifiedDescriptor: 'fc'.repeat(32),
  }
  const storedRows = await publisherRows(f.indexStore, f.publisherId)
  const replacementRows = Object.entries(storedRows).flatMap(([shortName, records]) => (
    shortName === 'sourceCursors'
      ? []
      : records.map(record => ({ collection: COLLECTIONS[shortName], record }))
  ))
  await f.index.replacePublisherSlice({
    publisherId: f.publisherId,
    rows: replacementRows,
    cursor: mismatchedCursor,
    expectedCursor: cursor,
  })

  const repaired = await catalogIngestor.ingest({
    publisherId: f.publisherId,
    descriptor: f.descriptor,
    catalog: f.catalog,
  })

  t.is(repaired.status, 'repaired')
  t.is(repaired.mode, 'repair')
  t.is(repaired.reason, 'source-identity-changed')
  const rows = await publisherRows(f.indexStore, f.publisherId)
  t.is(rows.publicationProjections.length, 1)
  t.alike(rows.sourceCursors[0], repaired.cursor)
  t.unlike(rows.sourceCursors[0], mismatchedCursor)
})

test('unsupported non-ASCII projection keys fail closed before cursor advancement', async (t) => {
  const f = await fixture(t)
  const manifest = publicationManifest(f)
  const operation = publicationOperation(f, manifest, 1)
  await f.view.put(`projection/😀/${manifest.publicationId}`, encodePublisherCatalogFrame(operation))

  await t.exception(
    ingestor(f).ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog }),
    /projection key.*invalid|unsupported/,
  )

  t.absent(await f.index.getSourceCursor({ publisherId: f.publisherId, catalogEpoch: 0 }))
})

test('valid availability without an exact asset remains raw without inventing an asset projection', async (t) => {
  const f = await fixture(t)
  const claim = availabilityWithoutAssetOperation(f)
  await putProjection(f, 'claim', claimProjectionId(claim), claim)

  await ingestor(f).ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog })
  const rows = await publisherRows(f.indexStore, f.publisherId)

  t.is(rows.sourceRecords.length, 1)
  t.is(rows.availabilityProjections.length, 0)
  t.is(rows.relationshipEdges.length, 0)
})

test('catalog readiness is established before reading its key and view', async (t) => {
  const f = await fixture(t)
  const manifest = publicationManifest(f)
  await putProjection(f, 'publication', manifest.publicationId, publicationOperation(f, manifest, 1))
  let ready = false
  const lazyCatalog = {
    get key() { return ready ? f.view.key : null },
    get view() { return ready ? f.view : null },
    async update() { ready = true },
    async getViewHead() { throw new Error('mutable catalog head must not be read') },
    async getAuthorizationState() { throw new Error('mutable catalog authorization must not be read') },
  }

  const result = await ingestor(f).ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: lazyCatalog })

  t.is(result.mode, 'bootstrap')
  t.is((await publisherRows(f.indexStore, f.publisherId)).sourceRecords.length, 1)
})

test('missing pinned authorization state fails before index rows or cursor mutation', async (t) => {
  const f = await fixture(t)
  await f.view.del('state/authorization')

  await t.exception(
    ingestor(f).ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog }),
    /authorization/,
  )

  t.is((await publisherRows(f.indexStore, f.publisherId)).sourceCursors.length, 0)
  t.alike(f.checkouts, { opened: 1, closed: 1 })
})

test('ingest validates AbortSignal input and rejects native pre-abort before opening a checkout', async (t) => {
  const f = await fixture(t)
  const manifest = publicationManifest(f)
  await putProjection(f, 'publication', manifest.publicationId, publicationOperation(f, manifest, 1))

  let invalidSignalError = null
  try {
    await ingestor(f).ingest({
      publisherId: f.publisherId,
      descriptor: f.descriptor,
      catalog: f.catalog,
      signal: { aborted: false },
    })
  } catch (error) {
    invalidSignalError = error
  }
  t.ok(invalidSignalError)
  t.ok(/signal.*AbortSignal/.test(invalidSignalError.message))

  const controller = new AbortController()
  controller.abort(new Error('catalog ingestion cancelled'))
  await t.exception(
    ingestor(f).ingest({
      publisherId: f.publisherId,
      descriptor: f.descriptor,
      catalog: f.catalog,
      signal: controller.signal,
    }),
    /catalog ingestion cancelled/,
  )

  t.alike(f.checkouts, { opened: 0, closed: 0 })
  t.is((await publisherRows(f.indexStore, f.publisherId)).sourceCursors.length, 0)
})

test('incremental ingestion aborts after diff collection without applying rows or cursor', async (t) => {
  const f = await fixture(t)
  const manifest = publicationManifest(f)
  await putProjection(f, 'publication', manifest.publicationId, publicationOperation(f, manifest, 1))
  await ingestor(f).ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog })
  const beforeRows = await publisherRows(f.indexStore, f.publisherId)
  await putProjection(f, 'publication', manifest.publicationId, publicationOperation(f, manifest, 3))

  const controller = new AbortController()
  const reason = new Error('incremental ingestion cancelled')
  const checkout = f.view.checkout.bind(f.view)
  f.view.checkout = (...args) => {
    const pinned = checkout(...args)
    const createDiffStream = pinned.createDiffStream.bind(pinned)
    pinned.createDiffStream = (...streamArgs) => {
      const stream = createDiffStream(...streamArgs)
      return {
        async *[Symbol.asyncIterator]() {
          for await (const difference of stream) yield difference
          controller.abort(reason)
        },
      }
    }
    return pinned
  }
  let applyCalls = 0
  const observedIndex = {
    getSourceCursor: input => f.index.getSourceCursor(input),
    getPublisherSourceCursor: input => f.index.getPublisherSourceCursor(input),
    getPublisherAdmissionLimits: input => f.index.getPublisherAdmissionLimits(input),
    replacePublisherSlice: input => f.index.replacePublisherSlice(input),
    applyPublisherChanges(input) {
      applyCalls++
      return f.index.applyPublisherChanges(input)
    },
  }

  await t.exception(
    ingestor(f, observedIndex).ingest({
      publisherId: f.publisherId,
      descriptor: f.descriptor,
      catalog: f.catalog,
      signal: controller.signal,
    }),
    /incremental ingestion cancelled/,
  )

  t.is(applyCalls, 0)
  t.alike(await publisherRows(f.indexStore, f.publisherId), beforeRows)
  t.alike(f.checkouts, { opened: 2, closed: 2 })
})

test('explicit repair aborts after replacement collection without calling publisher mutation', async (t) => {
  const f = await fixture(t)
  const manifest = publicationManifest(f)
  await putProjection(f, 'publication', manifest.publicationId, publicationOperation(f, manifest, 1))
  await ingestor(f).ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog })
  const beforeRows = await publisherRows(f.indexStore, f.publisherId)

  const controller = new AbortController()
  const reason = new Error('publisher repair cancelled')
  const checkout = f.view.checkout.bind(f.view)
  f.view.checkout = (...args) => {
    const pinned = checkout(...args)
    const createReadStream = pinned.createReadStream.bind(pinned)
    pinned.createReadStream = (...streamArgs) => {
      const stream = createReadStream(...streamArgs)
      return {
        async *[Symbol.asyncIterator]() {
          for await (const entry of stream) yield entry
          controller.abort(reason)
        },
      }
    }
    return pinned
  }
  let replacementCalls = 0
  const observedIndex = {
    getSourceCursor: input => f.index.getSourceCursor(input),
    getPublisherSourceCursor: input => f.index.getPublisherSourceCursor(input),
    getPublisherAdmissionLimits: input => f.index.getPublisherAdmissionLimits(input),
    replacePublisherSlice(input) {
      replacementCalls++
      return f.index.replacePublisherSlice(input)
    },
    applyPublisherChanges: input => f.index.applyPublisherChanges(input),
  }
  const catalogIngestor = createCatalogIngestor({ index: observedIndex, now: () => 1_000 })

  await t.exception(
    catalogIngestor.repairPublisher({
      publisherId: f.publisherId,
      descriptor: f.descriptor,
      catalog: f.catalog,
      reason: 'source-fork-changed',
      signal: controller.signal,
    }),
    /publisher repair cancelled/,
  )

  t.is(replacementCalls, 0)
  t.alike(await publisherRows(f.indexStore, f.publisherId), beforeRows)
  t.alike(f.checkouts, { opened: 2, closed: 2 })
})

test('every exact pinned checkout closes after both successful and rejected ingestion', async (t) => {
  const f = await fixture(t)
  const manifest = publicationManifest(f)
  await putProjection(f, 'publication', manifest.publicationId, publicationOperation(f, manifest, 1))
  const catalogIngestor = ingestor(f)
  await catalogIngestor.ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog })
  t.alike(f.checkouts, { opened: 1, closed: 1 })
  const cursor = await f.index.getSourceCursor({ publisherId: f.publisherId, catalogEpoch: 0 })

  await f.view.put(`projection/claim/${'ee'.repeat(32)}`, b4a.from('not a publisher frame'))
  await t.exception(
    catalogIngestor.ingest({ publisherId: f.publisherId, descriptor: f.descriptor, catalog: f.catalog }),
    /frame|operation|variant/,
  )

  t.alike(f.checkouts, { opened: 2, closed: 2 })
  t.alike(await f.index.getSourceCursor({ publisherId: f.publisherId, catalogEpoch: 0 }), cursor)
})

test('verified query view backfills an existing episode and resolves its accepted publication manifest and rendition', async t => {
  const f = await fixture(t)
  const subject = createEntityReference({
    entityKind: 'work',
    namespace: 'tmdb',
    normalizedIdentifier: 'show:95350:s1:e2',
  })
  const manifest = publicationManifest(f, 1, 'Lanterns S01E02', [])
  const claimValue = createMediaClaim({
    claimType: 'AvailabilityObservation',
    subjectRefs: [subject],
    payload: {
      availabilityStatus: 'available',
      publicationId: manifest.publicationId,
      renditionId: manifest.body.renditions[0].renditionId,
    },
    confidence: 900,
    issuerSequence: 2,
    policyEpoch: 0,
    keyPair: f.device,
    signedAt: 100,
  })
  const claim = signPublisherOperation({
    descriptor: f.descriptor,
    signer: f.device,
    recordType: PUBLISHER_RECORD_TYPES.CLAIM,
    sequence: 2,
    body: {
      claimId: bytes(claimValue.claimId),
      claimType: claimValue.body.claimType,
      payload: encodeApplicationEnvelope(claimValue.envelope),
    },
  })
  await putProjection(f, 'publication', manifest.publicationId, publicationOperation(f, manifest, 1))
  await putProjection(f, 'claim', claimProjectionId(claim), claim)

  const indexingErrors = []
  const view = await createVerifiedQueryView({
    store: f.catalogStore,
    catalogRegistry: {
      async listBindings() {
        return [{
          publisherId: bytes(f.publisherId),
          namespaceDescriptor: f.descriptor,
          catalog: f.catalog,
        }]
      },
    },
    onError: error => indexingErrors.push(error),
  })
  t.teardown(() => view.close())
  t.alike(await view.refresh(), { indexed: 1, failed: 0 })
  if (indexingErrors.length > 0) throw indexingErrors[0]

  const page = await view.query({
    selectors: [{
      type: 'exact-external-ref',
      namespace: 'tmdb',
      identifier: 'show:95350:s1:e2',
    }],
    limit: 64,
  })
  t.is(page.results.length, 1)
  t.is(page.results[0].entityId, subject.entityId)
  t.is((await view.getPublication({ publicationId: manifest.publicationId })).manifestId, manifest.body.manifestId)
  t.is((await view.getManifest({ publicationId: manifest.publicationId })).publicationId, manifest.publicationId)
  const entity = await view.getEntity({ entityKind: 'work', entityId: subject.entityId })
  t.is(entity.publications.length, 1)
  t.is(entity.publications[0].manifest.publicationId, manifest.publicationId)
  t.alike((await view.listEntities()).map(item => item.entityId), [subject.entityId])
  t.is((await view.getRendition({
    publicationId: manifest.publicationId,
    renditionId: manifest.body.renditions[0].renditionId,
  })).requirement.coreKey, manifest.body.renditions[0].core.key)
  t.ok(await view.authorizeRendition({
    publicationId: manifest.publicationId,
    renditionId: manifest.body.renditions[0].renditionId,
    start: 0,
    end: 1,
    operation: 'stream',
  }))
})

test('verified query pagination is deterministic, revision-bound, and fills pages after moderation', async t => {
  const f = await fixture(t)
  for (const sequence of [2, 3, 4]) {
    const claim = externalClaimOperation(f, sequence)
    await putProjection(f, 'claim', claimProjectionId(claim), claim)
  }
  const hidden = new Set()
  let moderationRevision = 0
  let entropy = 0
  const view = await createVerifiedQueryView({
    store: f.catalogStore,
    catalogRegistry: {
      async listBindings() {
        return [{ publisherId: bytes(f.publisherId), namespaceDescriptor: f.descriptor, catalog: f.catalog }]
      },
    },
    moderationPolicy: {
      revision: () => moderationRevision,
      isVisible: record => !hidden.has(record.sourceRecordRef),
    },
    randomBytes: size => b4a.alloc(size, ++entropy),
  })
  t.teardown(() => view.close())
  await view.refresh()
  const selectors = [{ type: 'exact-external-ref', namespace: 'imdb-title', identifier: 'tt0903747' }]
  const complete = await view.query({ selectors, limit: 64 })
  t.is(complete.results.length, 3)

  const first = await view.query({ selectors, limit: 1 })
  const wrongRevision = `${first.sourceRevision.slice(0, -1)}${first.sourceRevision.endsWith('0') ? '1' : '0'}`
  const pinned = await view.query({ selectors, limit: 1, sourceRevision: first.sourceRevision })
  t.alike(pinned.results, first.results)
  await t.exception(view.query({ selectors, limit: 1, sourceRevision: wrongRevision }), { code: 'STALE_CURSOR' })
  const second = await view.query({ selectors, limit: 1, cursor: first.nextCursor })
  await t.exception(view.query({
    selectors,
    limit: 1,
    cursor: first.nextCursor,
    sourceRevision: wrongRevision,
  }), { code: 'STALE_CURSOR' })
  t.alike([first.results[0], second.results[0]], complete.results.slice(0, 2))
  await t.exception(view.query({ selectors, limit: 1, cursor: 'x'.repeat(43) }), { code: 'INVALID_CURSOR' })

  hidden.add(first.results[0].sourceRecordRef)
  moderationRevision++
  await t.exception(view.query({ selectors, limit: 1, cursor: second.nextCursor }), { code: 'STALE_CURSOR' })
  const filled = await view.query({ selectors, limit: 1 })
  t.alike(filled.results, [complete.results[1]])

  const changed = externalClaimOperation(f, 5)
  await putProjection(f, 'claim', claimProjectionId(changed), changed)
  await view.refresh()
  await t.exception(view.query({ selectors, limit: 1, cursor: filled.nextCursor }), { code: 'STALE_CURSOR' })
})

test('verified query rows and exact source heads persist across restart', async t => {
  const f = await fixture(t)
  const manifest = publicationManifest(f)
  await putProjection(f, 'publication', manifest.publicationId, publicationOperation(f, manifest, 1))
  const registry = {
    async listBindings() {
      return [{ publisherId: bytes(f.publisherId), namespaceDescriptor: f.descriptor, catalog: f.catalog }]
    },
  }
  const first = await createVerifiedQueryView({ store: f.catalogStore, catalogRegistry: registry })
  await first.refresh()
  const source = await first.sourceState({ publisherId: f.publisherId })
  await first.close()

  const restarted = await createVerifiedQueryView({ store: f.catalogStore, catalogRegistry: registry })
  t.teardown(() => restarted.close())
  t.alike(await restarted.sourceState({ publisherId: f.publisherId }), source)
  t.is((await restarted.getManifest({ publicationId: manifest.publicationId })).publicationId, manifest.publicationId)
})

test('one rejected publisher binding does not block another publisher refresh', async t => {
  const accepted = await fixture(t)
  const rejected = await fixture(t)
  const manifest = publicationManifest(accepted)
  await putProjection(accepted, 'publication', manifest.publicationId, publicationOperation(accepted, manifest, 1))
  const errors = []
  const view = await createVerifiedQueryView({
    store: accepted.catalogStore,
    catalogRegistry: {
      async listBindings() {
        return [
          { publisherId: bytes(rejected.publisherId), namespaceDescriptor: accepted.descriptor, catalog: rejected.catalog },
          { publisherId: bytes(accepted.publisherId), namespaceDescriptor: accepted.descriptor, catalog: accepted.catalog },
        ]
      },
    },
    onError: (error, context) => errors.push({ error, context }),
  })
  t.teardown(() => view.close())
  t.alike(await view.refresh(), { indexed: 1, failed: 1 })
  t.is(errors.length, 1)
  t.is((await view.getPublication({ publicationId: manifest.publicationId })).publisherId, accepted.publisherId)
})

test('verified query refresh rejects a forged accepted-row writer signature', async t => {
  const f = await fixture(t)
  const manifest = publicationManifest(f)
  const signed = publicationOperation(f, manifest, 1)
  const forged = { ...signed, signature: b4a.from(signed.signature) }
  forged.signature[0] ^= 1
  await putProjection(f, 'publication', manifest.publicationId, forged)
  const errors = []
  const view = await createVerifiedQueryView({
    store: f.catalogStore,
    catalogRegistry: {
      async listBindings() {
        return [{ publisherId: bytes(f.publisherId), namespaceDescriptor: f.descriptor, catalog: f.catalog }]
      },
    },
    onError: error => errors.push(error),
  })
  t.teardown(() => view.close())
  t.alike(await view.refresh(), { indexed: 0, failed: 1 })
  t.is(errors.length, 1)
  t.absent(await view.sourceState({ publisherId: f.publisherId }))
})
