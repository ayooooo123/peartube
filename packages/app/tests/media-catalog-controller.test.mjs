import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createMediaCatalogController,
  describeMediaCatalogState,
} from '../lib/media-catalog-controller.mjs'

const entity = (entityId, overrides = {}) => ({
  entityId,
  entityKind: 'work',
  title: entityId,
  subtitle: '',
  claimCount: 1,
  conflictCount: 0,
  sources: [],
  renditions: [],
  ...overrides,
})

const deferred = () => {
  let resolve
  const promise = new Promise((next) => { resolve = next })
  return { promise, resolve }
}

test('loads a bounded first media catalog page and exposes entity summaries', async () => {
  const requests = []
  const controller = createMediaCatalogController({
    getMediaCatalog: async (request) => {
      requests.push(request)
      return { success: true, items: [entity('work:alpha')], nextCursor: 'cursor-1' }
    },
  })
  await controller.load()

  assert.deepEqual(requests, [{ cursor: undefined, limit: 20 }])
  assert.equal(controller.getState().status, 'ready')
  assert.deepEqual(controller.getState().items.map((item) => item.entityId), ['work:alpha'])
  assert.equal(controller.getState().nextCursor, 'cursor-1')
})

test('loads deterministic pages without duplicating resolved entities', async () => {
  const requests = []
  const controller = createMediaCatalogController({
    pageSize: 200,
    getMediaCatalog: async (request) => {
      requests.push(request)
      if (!request.cursor) return { success: true, items: [entity('a'), entity('b')], nextCursor: 'next' }
      return { success: true, items: [entity('b'), entity('c')] }
    },
  })

  await controller.load()
  await controller.loadNext()

  assert.deepEqual(requests, [
    { cursor: undefined, limit: 50 },
    { cursor: 'next', limit: 50 },
  ])
  assert.deepEqual(controller.getState().items.map((item) => item.entityId), ['a', 'b', 'c'])
  assert.equal(controller.getState().nextCursor, undefined)
})

test('coalesces overlapping next-page requests', async () => {
  const nextPage = deferred()
  let calls = 0
  const controller = createMediaCatalogController({
    getMediaCatalog: async (request) => {
      calls += 1
      if (!request.cursor) return { success: true, items: [entity('a')], nextCursor: 'next' }
      return nextPage.promise
    },
  })
  await controller.load()

  const first = controller.loadNext()
  const overlapping = controller.loadNext()
  assert.equal(calls, 2)
  nextPage.resolve({ success: true, items: [entity('b')] })
  await Promise.all([first, overlapping])

  assert.deepEqual(controller.getState().items.map((item) => item.entityId), ['a', 'b'])
})

test('ignores stale responses after a newer refresh and after disposal', async () => {
  const first = deferred()
  const second = deferred()
  let calls = 0
  const controller = createMediaCatalogController({
    getMediaCatalog: () => (++calls === 1 ? first.promise : second.promise),
  })

  const oldLoad = controller.load()
  const refresh = controller.refresh()
  second.resolve({ success: true, items: [entity('new')] })
  await refresh
  first.resolve({ success: true, items: [entity('stale')] })
  await oldLoad
  assert.deepEqual(controller.getState().items.map((item) => item.entityId), ['new'])

  const disposed = deferred()
  const disposable = createMediaCatalogController({ getMediaCatalog: () => disposed.promise })
  const pending = disposable.load()
  disposable.destroy()
  disposed.resolve({ success: true, items: [entity('late')] })
  await pending
  assert.deepEqual(disposable.getState().items, [])
})

test('refreshes on graph updates and foreground activation without polling timers', async () => {
  const revisions = []
  let calls = 0
  const controller = createMediaCatalogController({
    getMediaCatalog: async () => ({ success: true, items: [entity(`work:${++calls}`)] }),
  })

  await controller.load()
  await controller.handleGraphUpdate({ revision: '7', changedCount: 2 })
  revisions.push(controller.getState().revision)
  await controller.handleForeground()

  assert.equal(calls, 3)
  assert.deepEqual(revisions, ['7'])
  assert.deepEqual(controller.getState().items.map((item) => item.entityId), ['work:3'])
})

test('returns structured empty and scoped error diagnostics', async () => {
  const emptyController = createMediaCatalogController({
    getMediaCatalog: async () => ({ success: true, items: [] }),
  })
  await emptyController.load()
  assert.deepEqual(describeMediaCatalogState(emptyController.getState(), {
    startupStatus: 'Joining authorized publisher catalogs',
  }), {
    kind: 'empty',
    title: 'No media is available yet',
    detail: 'Joining authorized publisher catalogs',
    actionLabel: 'Refresh catalog',
  })

  const errorController = createMediaCatalogController({
    getMediaCatalog: async () => ({ success: false, errorCode: 'CATALOG_UNAVAILABLE', error: 'Catalog replay incomplete' }),
  })
  await errorController.load()
  assert.deepEqual(describeMediaCatalogState(errorController.getState(), {}), {
    kind: 'error',
    title: 'Media catalog unavailable',
    detail: 'Catalog replay incomplete',
    errorCode: 'CATALOG_UNAVAILABLE',
    actionLabel: 'Try again',
  })
})
