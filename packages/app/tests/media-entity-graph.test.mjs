import test from 'node:test'
import assert from 'node:assert/strict'

import { projectMediaEntityGraph } from '../lib/media-entity-graph.js'

test('projects one work with alternate publications, creator roles, provenance, and conflicts', () => {
  const projected = projectMediaEntityGraph({
    entity: { entityId: 'work:alpha', title: 'Alpha', creator: 'Alice' },
    publications: [
      { publicationId: 'pub-a', publisherId: 'publisher-a', sourceProvider: 'Publisher A', renditionId: 'rend-a', availabilityState: 'available', rejectionReasonCodes: [] },
      { publicationId: 'pub-b', publisherId: 'publisher-b', sourceProvider: 'Publisher B', renditionId: 'rend-b', availabilityState: 'available', rejectionReasonCodes: [] },
    ],
    contributions: [
      { agentId: 'agent:alice', name: 'Alice', role: 'performer' },
      { agentId: 'agent:bob', name: 'Bob', role: 'director' },
    ],
    provenance: ['claim-a', 'claim-b'],
    conflicts: [{ field: 'title', values: ['Alpha', 'Alfa'] }],
  })
  assert.equal(projected.id, 'work:alpha')
  assert.equal(projected.sources.length, 2)
  assert.equal(projected.primarySource.publicationId, 'pub-a')
  assert.deepEqual(projected.creatorRoles.map(role => role.role).sort(), ['director', 'performer'])
  assert.deepEqual(projected.provenance, ['claim-a', 'claim-b'])
  assert.equal(projected.conflicts.length, 1)
})

test('entity projection never falls back to an unauthorized first source', () => {
  const projected = projectMediaEntityGraph({
    entity: { entityId: 'work:blocked', title: 'Blocked' },
    publications: [{
      publicationId: 'pub-blocked',
      renditionId: 'rend-blocked',
      playable: true,
      availabilityState: 'available',
      rejectionReasonCodes: ['UNAUTHORIZED_PUBLICATION'],
    }],
  })
  assert.equal(projected.primarySource, null)
  assert.equal(projected.playbackRef, null)
})

test('partial collections preserve placeholders and do not collapse remasters', () => {
  const projected = projectMediaEntityGraph({
    entity: { entityId: 'collection:season-1', title: 'Season 1' },
    collectionItems: [
      { entityId: 'work:e1', title: 'Episode 1', position: 1, available: true },
      { entityId: 'work:e2', title: 'Episode 2', position: 2, available: false },
      { entityId: 'work:e1-remaster', title: 'Episode 1 Remaster', position: 1, edition: 'remaster', available: true },
    ],
  })
  assert.equal(projected.collection.items.length, 3)
  assert.equal(projected.collection.items.find(item => item.entityId === 'work:e2').available, false)
  assert.equal(projected.collection.items.filter(item => item.position === 1).length, 2)
})
