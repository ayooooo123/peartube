import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { createSearchApi } from '../src/api/search.js'
import { createApi } from '../src/api.js'

const repoRoot = path.resolve(import.meta.dirname, '../../..')
const apiSource = fs.readFileSync(path.join(repoRoot, 'packages/backend/src/api/search.js'), 'utf8')
const semanticFinderSource = fs.readFileSync(path.join(repoRoot, 'packages/backend/src/search/semantic-finder.js'), 'utf8')

test('global search keeps preview/direct-ref results without blocking on hydration', () => {
  assert.match(apiSource, /const hasDirectRefs = Boolean\(meta\.blobId && meta\.blobsCoreKey\)/)
  assert.match(apiSource, /const previewVideo = getPreviewVideoFromFeed\(channelKey, r\.id, meta\.publicBeeKey\)/)
  assert.match(apiSource, /if \(hasDirectRefs \|\| previewVideo\?\.blobId\)/)
  assert.match(apiSource, /blobId: meta\.blobId \|\| previewVideo\?\.blobId \|\| null/)
  assert.match(apiSource, /blobsCoreKey: meta\.blobsCoreKey \|\| previewVideo\?\.blobsCoreKey \|\| null/)
})

test('search index metadata includes direct playback and thumbnail refs', () => {
  assert.match(semanticFinderSource, /blobId: video\.blobId \|\| null/)
  assert.match(semanticFinderSource, /blobsCoreKey: video\.blobsCoreKey \|\| null/)
  assert.match(semanticFinderSource, /thumbnailBlobId: video\.thumbnailBlobId \|\| null/)
  assert.match(semanticFinderSource, /thumbnailBlobsCoreKey: video\.thumbnailBlobsCoreKey \|\| null/)
  assert.match(semanticFinderSource, /availability: video\.availability \|\| null/)
})

test('semantic search remains local and does not create a broadcast coordinator', async () => {
  const calls = []
  const ctx = {
    lifecycle: { signal: new AbortController().signal },
    swarm: {
      join() {
        throw new Error('local semantic search must not join a broadcast topic')
      },
    },
    semanticFinder: {
      async search(query, limit) {
        calls.push({ query, limit })
        return [{ id: 'local-result', score: 1, metadata: {} }]
      },
    },
  }
  const api = createSearchApi({
    ctx,
    ensureSemanticFinder: async () => ctx.semanticFinder,
  })

  const results = await api.searchVideos('21'.repeat(32), 'local query', {
    topK: 3,
    federated: true,
  })
  assert.deepEqual(results, [{ id: 'local-result', score: 1, metadata: {} }])
  assert.deepEqual(calls, [{ query: 'local query', limit: 3 }])
  assert.equal(ctx.federatedSearch, undefined)
})

test('root API exposes search methods and keeps global direct refs callable', async () => {
  const calls = []
  let previewReads = 0
  const directBlobId = {
    blockOffset: 4,
    blockLength: 2,
    byteOffset: 0,
    byteLength: 1234,
  }
  const ctx = {
    channels: new Map(),
    semanticFinder: {
      async search(query, limit) {
        calls.push({ method: 'search', query, limit })
        return [{ id: 'local', score: 1, metadata: {} }]
      },
      async globalSearch(query, limit) {
        calls.push({ method: 'globalSearch', query, limit })
        if (query === 'hydrate query') {
          return [{ id: 'hydrate', score: 1, metadata: { channelKey: 'channel-b' } }]
        }
        return [{
          id: 'direct',
          score: 1,
          metadata: {
            channelKey: 'channel-a',
            blobId: directBlobId,
            blobsCoreKey: 'ab'.repeat(32),
          },
        }]
      },
    },
  }
  const api = createApi({
    ctx,
    getPreviewVideoFromFeed() {
      previewReads++
      return null
    },
  })

  assert.equal(typeof api.searchVideos, 'function')
  assert.equal(typeof api.globalSearchVideos, 'function')
  assert.equal(typeof api.indexVideoVectors, 'function')
  assert.deepEqual(
    await api.searchVideos('21'.repeat(32), 'local query', { topK: 3 }),
    [{ id: 'local', score: 1, metadata: {} }],
  )
  const global = await api.globalSearchVideos('global query', { topK: 4 })
  assert.equal(global.length, 1)
  assert.deepEqual(global[0].metadata.blobId, directBlobId)
  assert.equal(global[0].metadata.blobsCoreKey, 'ab'.repeat(32))
  api.getVideoData = async function (channelKey, videoId) {
    assert.equal(this, api)
    assert.equal(channelKey, 'channel-b')
    assert.equal(videoId, 'hydrate')
    return { id: videoId }
  }
  const hydrated = await api.globalSearchVideos('hydrate query', { topK: 1 })
  assert.equal(hydrated.length, 1)
  assert.deepEqual(calls, [
    { method: 'search', query: 'local query', limit: 3 },
    { method: 'globalSearch', query: 'global query', limit: 4 },
    { method: 'globalSearch', query: 'hydrate query', limit: 1 },
  ])
  assert.equal(previewReads, 2)
})
