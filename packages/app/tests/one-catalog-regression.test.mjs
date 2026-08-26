import test from 'node:test'
import assert from 'node:assert/strict'

import { createMediaCatalogController } from '../lib/media-catalog-controller.mjs'

test('consumer shell requests one paginated catalog and never requires a user-added source', async () => {
  const requests = []
  const controller = createMediaCatalogController({
    getMediaCatalog: async request => {
      requests.push(request)
      return { success: true, items: [{ entityId: 'work:movie', entityKind: 'movie' }], nextCursor: null }
    },
  })

  await controller.load()
  assert.deepEqual(requests, [{ cursor: undefined, limit: 20 }])
  assert.equal(controller.getState().catalogScope, 'consumer')
  assert.deepEqual(controller.getState().items.map(item => item.entityId), ['work:movie'])
  assert.equal(typeof controller.addSource, 'undefined')
})
