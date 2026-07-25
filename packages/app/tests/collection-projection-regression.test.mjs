import test from 'node:test'
import assert from 'node:assert/strict'

import {
  loadCollectionEntity,
  loadCreatorEntity,
} from '../components/routes/media-entity-loaders.js'

test('collection loader fetches every bounded page and preserves explicit missing members', async () => {
  const cursors = []
  const rpc = {
    async getMediaCollection(request) {
      assert.deepEqual(request, { entityId: 'collection-one', includeClaims: true, includeConflicts: true })
      return {
        success: true,
        entity: {
          entityId: 'collection-one',
          title: 'Collection One',
          missingMembers: [{ entityId: 'missing-episode', title: 'Missing Episode' }],
          completeness: { known: 2, missing: 1, hasTrustedStructure: true },
        },
        claims: [{ claimId: 'collection-claim' }],
        conflicts: [],
      }
    },
    async getMediaCollectionItems(request) {
      cursors.push(request.cursor)
      return request.cursor
        ? { success: true, items: [{ entityId: 'episode-two', title: 'Episode Two' }], nextCursor: null }
        : { success: true, items: [{ entityId: 'episode-one', title: 'Episode One' }], nextCursor: 'page-two' }
    },
  }

  const result = await loadCollectionEntity({ rpc, entityId: 'collection-one' })

  assert.deepEqual(cursors, [undefined, 'page-two'])
  assert.deepEqual(result.items.map(item => item.entityId), ['episode-one', 'episode-two'])
  assert.equal(result.missingMembers[0].title, 'Missing Episode')
  assert.equal(result.completeness.hasTrustedStructure, true)
  assert.deepEqual(result.provenance, [{ claimId: 'collection-claim' }])
})

test('creator loader assembles contribution roles across publisher claims', async () => {
  const rpc = {
    async getMediaAgent() {
      return { success: true, entity: { entityId: 'creator-one', title: 'Creator One' }, claims: [], conflicts: [] }
    },
    async getAgentContributions() {
      return {
        success: true,
        items: [
          { agentId: 'creator-one', role: 'performer', publisherId: 'publisher-one' },
          { agentId: 'creator-one', role: 'director', publisherId: 'publisher-two' },
        ],
        nextCursor: null,
      }
    },
  }

  const result = await loadCreatorEntity({ rpc, entityId: 'creator-one' })

  assert.deepEqual(result.contributions.map(item => item.role), ['performer', 'director'])
  assert.deepEqual(result.contributions.map(item => item.publisherId), ['publisher-one', 'publisher-two'])
  assert.equal('globalOwner' in result, false)
})
