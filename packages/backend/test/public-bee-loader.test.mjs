import assert from 'node:assert/strict'
import test from 'node:test'

import { loadPublicBeeFromCache } from '../src/public-bee-loader.js'

test('loadPublicBeeFromCache dedupes concurrent in-flight loads', async () => {
  const cache = new Map()
  const inflight = new Map()
  let loadCalls = 0

  const loadFresh = async () => {
    loadCalls += 1
    await new Promise((resolve) => setTimeout(resolve, 10))
    return { id: 'bee-1', closed: false }
  }

  const [first, second] = await Promise.all([
    loadPublicBeeFromCache({
      cache,
      inflight,
      key: 'bee',
      isUsable: (bee) => !bee.closed,
      closeStale: async () => {},
      loadFresh,
    }),
    loadPublicBeeFromCache({
      cache,
      inflight,
      key: 'bee',
      isUsable: (bee) => !bee.closed,
      closeStale: async () => {},
      loadFresh,
    }),
  ])

  assert.equal(loadCalls, 1)
  assert.equal(first, second)
  assert.equal(cache.get('bee'), first)
  assert.equal(inflight.has('bee'), false)
})

test('loadPublicBeeFromCache evicts stale cache entries before loading a fresh bee', async () => {
  const stale = {
    closed: true,
    closeCalls: 0,
    async close() {
      this.closeCalls += 1
    },
  }
  const cache = new Map([['bee', stale]])
  const inflight = new Map()

  const fresh = await loadPublicBeeFromCache({
    cache,
    inflight,
    key: 'bee',
    isUsable: (bee) => !bee.closed,
    closeStale: async (bee) => {
      await bee?.close?.()
    },
    loadFresh: async () => ({ id: 'fresh', closed: false }),
  })

  assert.equal(stale.closeCalls, 1)
  assert.deepEqual(fresh, { id: 'fresh', closed: false })
  assert.equal(cache.get('bee'), fresh)
})
