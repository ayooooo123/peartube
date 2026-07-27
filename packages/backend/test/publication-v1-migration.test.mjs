import test from 'brittle'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import Corestore from 'corestore'

import {
  attachSignedEnvelopeSignature,
  prepareSignedEnvelope,
  signedRecordSignaturePreimage,
} from '@peartube/backend/records'
import { MultiWriterChannel } from '../src/channel/multi-writer-channel.js'
import { createPublisherCatalogProjection } from '../src/media-graph/catalog-projection.js'
import {
  createLegacyCatalogResolver,
  createPublicationV1CheckpointRepository,
  createPublicationV1LegacyRepository,
  createPublicationV1StartupLifecycle,
  migratePublicationV1,
  runPublicationV1StartupMigration,
} from '../src/migrations/publication-v1.js'
import {
  PUBLISHER_RECORD_TYPES,
  PublisherCatalog,
  createPublisherNamespaceDescriptor,
  derivePublisherId,
  encodePublisherNamespaceDescriptor,
  encodePublisherOperationBody,
} from '../src/publisher/index.js'

test('publication v1 migration preserves provenance and stable ids without inventing abstract equivalence', (t) => {
  const legacy = {
    ownerPublisherId: 'a'.repeat(64),
    videos: [
      { id: 'legacy-video-1', title: 'Movie', contentHash: 'b'.repeat(64), blobRef: { coreKey: 'c'.repeat(64), start: 0, end: 10 }, thumbnail: { coreKey: 'd'.repeat(64), start: 0, end: 1 }, deleted: false },
      { id: 'legacy-deleted', title: 'Deleted', deleted: true, source: 'public-feed-cache' },
    ],
    snapshots: [{ sourceId: 'canonical-feed', videoId: 'legacy-video-1', observedAt: 123 }],
  }
  const first = migratePublicationV1(legacy)
  const second = migratePublicationV1(legacy)
  t.alike(second, first)
  t.is(first.publications.length, 2)
  t.ok(first.publications[0].publicationId)
  t.is(first.publications[0].publisherId, legacy.ownerPublisherId)
  t.is(first.publications[0].legacySourceId, 'legacy-video-1')
  t.is(first.publications[0].entityRef, null)
  t.is(first.publications[0].agentRef, null)
  t.is(first.publications[1].tombstone, true)
  t.ok(first.claims.every(claim => claim.provenance))
})

test('publication v1 migration resumes from checkpoint without duplicate imports', (t) => {
  const legacy = { ownerPublisherId: 'a'.repeat(64), videos: [{ id: 'one', contentHash: 'b'.repeat(64) }, { id: 'two', contentHash: 'c'.repeat(64) }] }
  const checkpoint = migratePublicationV1(legacy, { stopAfter: 1 }).checkpoint
  const resumed = migratePublicationV1(legacy, { checkpoint })
  t.is(resumed.publications.length, 2)
  t.is(new Set(resumed.publications.map(p => p.publicationId)).size, 2)
})

function memoryMetaDb() {
  const values = new Map()
  return {
    values,
    async get(key) {
      return values.has(key) ? { value: structuredClone(values.get(key)) } : null
    },
    async put(key, value) {
      values.set(key, structuredClone(value))
    },
  }
}

function signedCatalogOperation({ descriptor, signer, recordType, sequence, body }) {
  const canonicalBody = recordType === PUBLISHER_RECORD_TYPES.NAMESPACE
    ? encodePublisherNamespaceDescriptor(body)
    : encodePublisherOperationBody(recordType, body)
  const prepared = prepareSignedEnvelope({
    recordType,
    schemaMajor: 1,
    schemaMinor: 0,
    issuerIdentityKey: descriptor.publisherId,
    signerKey: signer.publicKey,
    policyEpoch: 0,
    issuerSequence: sequence,
    signedAt: 1_700_000_000_000,
    canonicalBody,
  }, { hash: crypto.hash })
  return attachSignedEnvelopeSignature(
    prepared,
    crypto.sign(signedRecordSignaturePreimage(prepared), signer.secretKey),
  )
}

async function catalogHarness(store, root, device) {
  const publisherId = derivePublisherId(root.publicKey)
  const catalog = new PublisherCatalog(store, {
    publisherId,
    deviceSigner: {
      signerKey: b4a.from(device.publicKey),
      sign: preimage => crypto.sign(preimage, device.secretKey),
    },
  })
  await catalog.ready()
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: catalog.key,
    profileRef: b4a.from('profile:legacy-migration'),
    recoveryKeys: [],
    recoveryThreshold: 0,
  })
  await catalog.append(signedCatalogOperation({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    sequence: 0,
    body: descriptor,
  }))
  await catalog.append(signedCatalogOperation({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    sequence: 1,
    body: {
      writerKey: catalog.localWriterKey,
      signerKey: device.publicKey,
      capabilities: ['claim', 'publish'],
      firstAcceptedSequence: 1,
      expiresAt: Number.MAX_SAFE_INTEGER,
      admissionNonce: b4a.alloc(16, 9),
    },
  }))
  await catalog.update()
  return { publisherId, catalog }
}

test('startup migration reads real legacy channel storage, resumes after catalog commit, and projects once with exact provenance', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-publication-v1-'))
  const store = new Corestore(directory)
  const metaDb = memoryMetaDb()
  let channel
  let catalog
  try {
    await store.ready()
    channel = new MultiWriterChannel(store, { name: 'legacy-migration-owner', encrypt: false })
    await channel.ready()
    const sourceVideo = {
      id: 'legacy-video-1',
      title: 'Legacy Movie',
      description: 'kept exactly',
      uploadedAt: 1_700_000_000_000,
      blobId: '2:3:0:4096',
      blobsCoreKey: 'c'.repeat(64),
      mimeType: 'video/mp4',
      contentFingerprint: `sha256:${'d'.repeat(64)}`,
      sourceProvider: 'youtube',
      sourceVideoId: 'source-42',
    }
    await channel.addVideo(sourceVideo, { syncPublic: false })

    const root = crypto.keyPair(b4a.alloc(32, 7))
    const device = crypto.keyPair(b4a.alloc(32, 8))
    const harness = await catalogHarness(store, root, device)
    const publisherId = harness.publisherId
    catalog = harness.catalog
    const binding = { publisherId, catalog }
    const registry = {
      async listBindings() { return [binding] },
    }
    const projection = createPublisherCatalogProjection({
      catalogRegistry: registry,
      now: () => 1_700_000_000_100,
    })
    const identityManager = {
      getIdentities() {
        return [{ publicKey: b4a.toString(root.publicKey, 'hex'), driveKey: channel.keyHex }]
      },
    }
    const sourceRepository = createPublicationV1LegacyRepository({
      identityManager,
      loadChannel: async (_driveKey) => channel,
    })
    const checkpointRepository = createPublicationV1CheckpointRepository(metaDb)
    let interrupted = false
    try {
      await runPublicationV1StartupMigration({
        sourceRepository,
        checkpointRepository,
        resolveCatalog: async () => binding,
        deviceKeyPair: device,
        mediaCatalogProjection: projection,
        now: () => 1_700_000_000_100,
        afterCatalogCommit() {
          if (!interrupted) {
            interrupted = true
            throw new Error('simulated process interruption')
          }
        },
      })
      t.fail('first migration run must be interrupted')
    } catch (error) {
      t.is(error.message, 'simulated process interruption')
    }

    t.is((await catalog.listProjections('publication')).items.length, 1, 'catalog commit happened before interruption')
    t.is((await catalog.listProjections('claim')).items.length, 1, 'publication provenance claim committed in the same batch')
    t.ok(await channel.getVideo(sourceVideo.id), 'legacy source remains present after interruption')

    const resumed = await runPublicationV1StartupMigration({
      sourceRepository,
      checkpointRepository,
      resolveCatalog: async () => binding,
      deviceKeyPair: device,
      mediaCatalogProjection: projection,
      now: () => 1_700_000_000_200,
    })
    t.is(resumed.status, 'complete')
    const publicationRows = await catalog.listProjections('publication')
    const claimRows = await catalog.listProjections('claim')
    t.is(publicationRows.items.length, 1, 'resume does not duplicate the catalog publication')
    t.is(claimRows.items.length, 1, 'resume does not duplicate the catalog claim')

    const publicationId = b4a.toString(publicationRows.items[0].body.publicationId, 'hex')
    const manifest = projection.assetManifestStore.getManifest(publicationId)
    const manifests = projection.assetManifestStore.getManifestsByRendition(
      manifest.body.renditions[0].renditionId,
    )
    t.is(manifests.length, 1, 'replacement manifest projection is visible exactly once')
    const claims = projection.mediaGraphStore.getClaims()
    t.is(claims.length, 1, 'replacement graph visibility is exactly once')
    t.is(claims[0].body.claimType, 'EntityMetadataClaim')
    t.is(claims[0].body.subjectRefs[0].entityKind, 'publication', 'migration invents no work entity')
    t.absent(claims[0].body.subjectRefs.some(ref => ref.entityKind === 'agent'), 'migration invents no agent claim')
    t.alike(claims[0].body.payload.provenance, {
      source: 'legacy-owner-channel',
      sourceKey: channel.keyHex,
      ownerPublisherId: b4a.toString(root.publicKey, 'hex'),
      legacySourceId: sourceVideo.id,
      blobsCoreKey: sourceVideo.blobsCoreKey,
      blobId: sourceVideo.blobId,
      contentFingerprint: sourceVideo.contentFingerprint,
      mimeType: sourceVideo.mimeType,
      uploadedAt: sourceVideo.uploadedAt,
      sourceProvider: sourceVideo.sourceProvider,
      sourceVideoId: sourceVideo.sourceVideoId,
    })
    t.ok(await channel.getVideo(sourceVideo.id), 'durable completion preserves legacy source data')
  } finally {
    await catalog?.close?.().catch(() => {})
    await channel?.close?.().catch(() => {})
    await store.close().catch(() => {})
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('startup migration quarantines malformed legacy storage and fails closed without deleting source', async t => {
  const source = {
    source: 'legacy-owner-channel',
    sourceKey: 'e'.repeat(64),
    ownerPublisherId: 'a'.repeat(64),
    video: { id: 'broken', title: 'Broken', blobId: 'not-a-blob', blobsCoreKey: 'f'.repeat(64) },
  }
  const metaDb = memoryMetaDb()
  let writes = 0
  try {
    await runPublicationV1StartupMigration({
      sourceRepository: { async list() { return [source] } },
      checkpointRepository: createPublicationV1CheckpointRepository(metaDb),
      resolveCatalog: async () => { writes++; return null },
      deviceKeyPair: crypto.keyPair(b4a.alloc(32, 9)),
      mediaCatalogProjection: { async rebuild() {} },
      now: () => 100,
    })
    t.fail('malformed migration must fail')
  } catch (error) {
    t.is(error.code, 'PUBLICATION_V1_SOURCE_MALFORMED')
  }
  t.is(writes, 0, 'malformed source reaches no replacement writer')
  t.is(source.video.id, 'broken', 'source object is not mutated or deleted')
  const checkpoint = await createPublicationV1CheckpointRepository(metaDb).load()
  t.is(checkpoint.status, 'failed')
  t.is(checkpoint.quarantined.length, 1)
  t.is(checkpoint.quarantined[0].sourceKey, `${source.sourceKey}:broken`)
})

test('startup lifecycle gates initial projection discovery until migration becomes complete', async t => {
  const results = [{ status: 'pending' }, { status: 'complete' }]
  let migrations = 0
  let starts = 0
  const lifecycle = createPublicationV1StartupLifecycle({
    async migrate() {
      return results[migrations++]
    },
    async startDiscovery() {
      starts++
    },
  })

  const initial = await lifecycle.initialize()
  t.is(initial.status, 'pending')
  t.is(starts, 0, 'initial discovery remains closed while migration is pending')
  const [first, second] = await Promise.all([lifecycle.complete(), lifecycle.complete()])
  t.is(first.status, 'complete')
  t.is(second.status, 'complete')
  t.is(migrations, 2, 'concurrent retries share one migration attempt')
  t.is(starts, 1, 'initial discovery starts once only after durable migration completion')
  await lifecycle.complete()
  t.is(migrations, 2, 'completed lifecycle is idempotent')
  t.is(starts, 1, 'completed lifecycle never starts discovery twice')
})

// A relay keys its catalog by a publisher root rather than by the channel
// identity that owns the legacy videos. Before the fallback existed nothing
// resolved, the migration stayed pending forever, and because
// completeAdmissionLifecycle runs on every provisionPublisherCatalog the relay
// could never publish again after its first restart.
test('legacy sources fall back to the sole local writable catalog', async (t) => {
  const ownerPublisherId = b4a.toString(b4a.alloc(32, 71), 'hex')
  const localBinding = { publisherId: b4a.alloc(32, 72), catalog: { writable: true } }
  const asked = []

  const resolve = createLegacyCatalogResolver({
    catalogRegistry: {
      async resolve(publisherId) {
        asked.push(b4a.toString(publisherId, 'hex'))
        const error = new Error('PUBLISHER_CATALOG_UNAVAILABLE')
        error.code = 'PUBLISHER_CATALOG_UNAVAILABLE'
        throw error
      },
      async getWritableBindings() {
        return [localBinding]
      },
    },
    derivePublisherId: key => crypto.hash(key),
  })

  const resolved = await resolve({ ownerPublisherId })
  t.is(resolved, localBinding, 'the local writable catalog adopts the legacy source')
  t.is(asked.length, 1, 'the owner-derived catalog is still tried first')
})

test('a catalog owned by the source key wins over the local fallback', async (t) => {
  const ownerPublisherId = b4a.toString(b4a.alloc(32, 73), 'hex')
  const ownedBinding = { publisherId: b4a.alloc(32, 74), catalog: { writable: true } }

  const resolve = createLegacyCatalogResolver({
    catalogRegistry: {
      async resolve() { return ownedBinding },
      async getWritableBindings() {
        t.fail('the fallback must not run when the source owns a catalog')
        return []
      },
    },
    derivePublisherId: key => crypto.hash(key),
  })

  t.is(await resolve({ ownerPublisherId }), ownedBinding, 'the owned catalog is used')
})

// Guessing which of several publishers owns the history would attribute a
// device's videos to the wrong catalog.
test('ambiguous local catalogs resolve nothing rather than guessing', async (t) => {
  const resolve = createLegacyCatalogResolver({
    catalogRegistry: {
      async resolve() { return null },
      async getWritableBindings() {
        return [{ publisherId: b4a.alloc(32, 75) }, { publisherId: b4a.alloc(32, 76) }]
      },
    },
    derivePublisherId: key => crypto.hash(key),
  })

  t.is(await resolve({ ownerPublisherId: b4a.toString(b4a.alloc(32, 77), 'hex') }), null, 'no catalog is chosen')
})
