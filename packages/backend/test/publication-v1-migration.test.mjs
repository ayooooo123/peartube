import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

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
  createPublicationV1StartupLifecycle,
  migratePublicationV1,
  runPublicationV1StartupMigration,
} from '../src/migrations/publication-v1.js'

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

test('startup migration checkpoints byte-less legacy ranges for re-ingest without catalog emission', async (t) => {
  const source = {
    source: 'legacy-owner-channel',
    sourceKey: 'e'.repeat(64),
    ownerPublisherId: 'a'.repeat(64),
    video: {
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
    },
  }
  const metaDb = memoryMetaDb()
  let catalogResolutions = 0
  const result = await runPublicationV1StartupMigration({
    sourceRepository: { async list() { return [source] } },
    checkpointRepository: createPublicationV1CheckpointRepository(metaDb),
    resolveCatalog: async () => { catalogResolutions++; return null },
    deviceKeyPair: crypto.keyPair(b4a.alloc(32, 8)),
    mediaCatalogProjection: { async rebuild() {} },
    now: () => 100,
  })

  t.is(result.status, 'complete')
  t.is(catalogResolutions, 0, 're-ingest disposition reaches no catalog writer')
  const checkpoint = await createPublicationV1CheckpointRepository(metaDb).load()
  t.is(checkpoint.quarantined.length, 1)
  t.is(checkpoint.quarantined[0].sourceKey, `${source.sourceKey}:${source.video.id}`)
  t.is(checkpoint.quarantined[0].disposition, 'reingest-required')
  t.is(source.video.description, 'kept exactly', 'structured metadata remains available for re-ingest')
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
