import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import * as catalogController from '../lib/media-catalog-controller.mjs'

const appRoot = path.resolve(import.meta.dirname, '..')
const searchSource = fs.readFileSync(path.join(appRoot, 'app/search.tsx'), 'utf8')
const librarySource = fs.readFileSync(path.join(appRoot, 'app/(tabs)/library.tsx'), 'utf8')

test('consumer search pages through the moderated catalog and never queries legacy results or thumbnails', async () => {
  assert.equal(
    typeof catalogController.searchMediaCatalog,
    'function',
    'the shared catalog controller must expose bounded consumer search',
  )
  let legacyCalls = 0
  let thumbnailCalls = 0
  const catalogRequests = []
  const rpc = {
    async globalSearchVideos() {
      legacyCalls++
      return {
        results: [{
          id: 'blocked-legacy-video',
          metadata: { title: 'Needle blocked by local policy', thumbnail: 'https://blocked.invalid/poster' },
        }],
      }
    },
    async getThumbnailUrl() {
      thumbnailCalls++
      return { url: 'https://blocked.invalid/poster' }
    },
    async getMediaCatalog(request) {
      catalogRequests.push(request)
      if (!request.cursor) {
        return {
          success: true,
          items: [{ entityId: 'work:other', entityKind: 'movie', title: 'Other title', sources: [], renditions: [] }],
          nextCursor: 'work:other',
        }
      }
      return {
        success: true,
        items: [{
          entityId: 'work:visible',
          entityKind: 'movie',
          title: 'Visible Needle',
          sources: [{ publicationId: 'publication:visible', publisherId: 'publisher:visible' }],
          renditions: [],
        }],
        nextCursor: null,
      }
    },
  }

  const result = await catalogController.searchMediaCatalog({
    getMediaCatalog: request => rpc.getMediaCatalog(request),
    query: 'needle',
    limit: 20,
  })

  assert.equal(result.success, true)
  assert.deepEqual(result.items.map(item => item.entityId), ['work:visible'])
  assert.equal(legacyCalls, 0, 'a blocked legacy result is never consulted')
  assert.equal(thumbnailCalls, 0, 'filtering completes before any thumbnail or artwork request')
  assert.deepEqual(catalogRequests, [
    { cursor: undefined, limit: 50 },
    { cursor: 'work:other', limit: 50 },
  ])
})

test('normal Search is a consumer catalog route rather than a legacy publisher search surface', () => {
  assert.match(searchSource, /getMediaCatalog/)
  assert.match(searchSource, /searchMediaCatalog/)
  assert.match(searchSource, /MediaCatalogView/)
  assert.doesNotMatch(searchSource, /globalSearchVideos|fetchThumbnailUrlWithRetry/)
  assert.match(librarySource, /router\.push\('\/search'\)/)
})
