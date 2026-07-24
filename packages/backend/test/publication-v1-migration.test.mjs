import test from 'brittle'

import { migratePublicationV1 } from '../src/migrations/publication-v1.js'

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
