import test from 'node:test'
import assert from 'node:assert/strict'

import { attachMobileHandlers } from '../src/mobile-handlers.js'

function makeDeps(api) {
  return {
    api,
    identityManager: {
      getActiveIdentity() { return null },
      getIdentities() { return [] },
    },
    uploadManager: {},
    ctx: {},
    initializeIdentityFromMnemonic: async () => ({}),
    rpc: {},
    fs: {},
    path: {},
    generateAndStoreThumbnail: async () => null,
    transcoder: {},
  }
}

test('mobile getPublicFeed forwards visible feed counts into stats for Discover chips', async () => {
  const backend = {}
  attachMobileHandlers(backend, makeDeps({
    async getPublicFeed() {
      return {
        entries: [
          { driveKey: 'a'.repeat(64), publicBeeKey: 'b'.repeat(64), previewVideos: [{ id: 'v1' }] },
          { driveKey: 'c'.repeat(64), publicBeeKey: 'd'.repeat(64), previewVideos: [{ id: 'v2' }] },
        ],
        stats: {
          peerCount: 1,
          feedConnections: 1,
        },
      }
    },
  }))

  const result = await backend.getPublicFeed()

  assert.equal(result.entries.length, 2)
  assert.equal(result.stats.peerCount, 1)
  assert.equal(result.stats.feedConnections, 1)
  assert.equal(result.stats.feedEntries, 2)
  assert.equal(result.stats.totalEntries, 2)
  assert.equal(result.stats.channelsLoaded, 2)
})

test('mobile getPublicFeed preserves explicit backend feed stats when present', async () => {
  const backend = {}
  attachMobileHandlers(backend, makeDeps({
    async getPublicFeed() {
      return {
        entries: [{ driveKey: 'a'.repeat(64), publicBeeKey: 'b'.repeat(64) }],
        stats: {
          peerCount: 3,
          feedConnections: 3,
          feedEntries: 99,
          totalEntries: 100,
          channelsLoaded: 42,
        },
      }
    },
  }))

  const result = await backend.getPublicFeed()

  assert.equal(result.stats.peerCount, 3)
  assert.equal(result.stats.feedConnections, 3)
  assert.equal(result.stats.feedEntries, 99)
  assert.equal(result.stats.totalEntries, 100)
  assert.equal(result.stats.channelsLoaded, 42)
})
