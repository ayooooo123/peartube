import test from 'node:test'
import assert from 'node:assert/strict'

import { createChannelCatalogState } from '../lib/channel-catalog-state.js'


function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function catalogResponse(name, groups = [{ id: 'latest', kind: 'latest', title: 'Latest', itemCount: 2, seasonNumber: 0 }]) {
  return {
    success: true,
    errorCode: null,
    error: null,
    profile: {
      channelKey: `${name}-key`,
      name,
      description: null,
      profileKind: 'creator',
      sources: null,
      artwork: null,
    },
    groups,
  }
}

function itemsResponse(group, items, nextCursor = null) {
  return {
    success: true,
    errorCode: null,
    error: null,
    group,
    items,
    nextCursor,
  }
}

const latestGroup = { id: 'latest', kind: 'latest', title: 'Latest', itemCount: 2, seasonNumber: 0 }
const videosGroup = { id: 'videos', kind: 'videos', title: 'Videos', itemCount: 1, seasonNumber: 0 }
const item = (id) => ({
  id,
  title: `Title ${id}`,
  channelKey: 'channel-key',
  publicBeeKey: 'public-bee-key',
  thumbnailUrl: null,
  thumbnailBlobId: `thumb-${id}`,
  thumbnailBlobsCoreKey: `core-${id}`,
  thumbnailMimeType: 'image/jpeg',
})


test('catalog state requests catalog before items, publishes profile first, and propagates publicBeeKey', async () => {
  const catalog = deferred()
  const page = deferred()
  const calls = []
  const snapshots = []
  const controller = createChannelCatalogState({
    rpc: {
      getContentCatalog(request) {
        calls.push(['catalog', request])
        return catalog.promise
      },
      getContentItems(request) {
        calls.push(['items', request])
        return page.promise
      },
    },
    bound: (promise) => promise,
    onChange: (snapshot) => snapshots.push(snapshot),
  })

  const load = controller.loadCatalog({ channelKey: 'channel-key', publicBeeKey: 'public-bee-key' })
  assert.deepEqual(calls, [['catalog', { channelKey: 'channel-key', publicBeeKey: 'public-bee-key' }]])

  catalog.resolve(catalogResponse('Creator'))
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(calls[1], ['items', {
    channelKey: 'channel-key',
    publicBeeKey: 'public-bee-key',
    groupId: 'latest',
    limit: 24,
  }])
  assert.equal(snapshots.at(-1).catalog.profile.name, 'Creator')
  assert.equal(snapshots.at(-1).pages.latest.loading, true)

  page.resolve(itemsResponse(latestGroup, [item('a')]))
  await load
  assert.deepEqual(controller.getSnapshot().pages.latest.cards.map((card) => card.id), ['a'])
})

test('catalog state ignores late route and selected-group responses', async () => {
  const oldCatalog = deferred()
  const oldGroup = deferred()
  const calls = []
  const controller = createChannelCatalogState({
    rpc: {
      getContentCatalog(request) {
        calls.push(['catalog', request])
        if (request.channelKey === 'old') return oldCatalog.promise
        return Promise.resolve(catalogResponse('New', [latestGroup, videosGroup]))
      },
      getContentItems(request) {
        calls.push(['items', request])
        if (request.channelKey === 'old' || request.groupId === 'videos') return oldGroup.promise
        return Promise.resolve(itemsResponse(latestGroup, [item('new')]))
      },
    },
    bound: (promise) => promise,
  })

  const oldLoad = controller.loadCatalog({ channelKey: 'old', publicBeeKey: 'old-bee' })
  const newLoad = controller.loadCatalog({ channelKey: 'new', publicBeeKey: 'new-bee' })
  oldCatalog.resolve(catalogResponse('Old'))
  await Promise.all([oldLoad, newLoad])
  assert.equal(controller.getSnapshot().catalog.profile.name, 'New')
  assert.deepEqual(controller.getSnapshot().pages.latest.cards.map((card) => card.id), ['new'])
  assert.equal(calls.some(([kind, request]) => kind === 'items' && request.channelKey === 'old'), false)

  const staleGroupLoad = controller.selectGroup('videos')
  const cachedGroupLoad = controller.selectGroup('latest')
  oldGroup.resolve(itemsResponse(videosGroup, [item('stale')]))
  await Promise.all([staleGroupLoad, cachedGroupLoad])
  assert.equal(controller.getSnapshot().selectedGroupId, 'latest')
  assert.equal(controller.getSnapshot().pages.videos?.loaded, true)
  assert.deepEqual(controller.getSnapshot().pages.videos.cards.map((card) => card.id), ['stale'])
})

test('catalog state appends in backend order and deduplicates stable ids', async () => {
  const requests = []
  const controller = createChannelCatalogState({
    rpc: {
      getContentCatalog: async () => catalogResponse('Creator'),
      getContentItems: async (request) => {
        requests.push(request)
        return request.cursor
          ? itemsResponse(latestGroup, [item('b'), item('c')])
          : itemsResponse(latestGroup, [item('a'), item('b')], 'next-page')
      },
    },
    bound: (promise) => promise,
  })

  await controller.loadCatalog({ channelKey: 'channel-key', publicBeeKey: 'public-bee-key' })
  await controller.loadMore()
  assert.deepEqual(controller.getSnapshot().pages.latest.cards.map((card) => card.id), ['a', 'b', 'c'])
  assert.equal(requests[1].cursor, 'next-page')
  assert.equal(controller.getSnapshot().pages.latest.nextCursor, null)
})

test('INVALID_CURSOR discards only its group and retries cursorless once without looping', async () => {
  const groupCalls = []
  let latestCalls = 0
  const controller = createChannelCatalogState({
    rpc: {
      getContentCatalog: async () => catalogResponse('Creator', [latestGroup, videosGroup]),
      getContentItems: async (request) => {
        groupCalls.push(request)
        if (request.groupId === 'videos') return itemsResponse(videosGroup, [item('video')])
        latestCalls += 1
        if (latestCalls === 1) return itemsResponse(latestGroup, [item('a')], 'expired')
        return {
          success: false,
          errorCode: 'INVALID_CURSOR',
          error: 'Cursor expired',
          group: latestGroup,
          items: [],
          nextCursor: null,
        }
      },
    },
    bound: (promise) => promise,
  })

  await controller.loadCatalog({ channelKey: 'channel-key', publicBeeKey: 'public-bee-key' })
  await controller.selectGroup('videos')
  await controller.selectGroup('latest')
  const callsBeforeMore = groupCalls.length
  await controller.loadMore()

  assert.equal(groupCalls.length - callsBeforeMore, 2)
  assert.equal(groupCalls.at(-2).cursor, 'expired')
  assert.equal(Object.hasOwn(groupCalls.at(-1), 'cursor'), false)
  assert.deepEqual(controller.getSnapshot().pages.latest.cards, [])
  assert.equal(controller.getSnapshot().pages.latest.error, 'Cursor expired')
  assert.deepEqual(controller.getSnapshot().pages.videos.cards.map((card) => card.id), ['video'])
})

test('a deferred load-more settles after another group loads and can continue when revisited', async () => {
  const deferredMore = deferred()
  const requests = []
  const controller = createChannelCatalogState({
    rpc: {
      getContentCatalog: async () => catalogResponse('Creator', [latestGroup, videosGroup]),
      getContentItems: async (request) => {
        requests.push(request)
        if (request.groupId === 'videos') return itemsResponse(videosGroup, [item('video')])
        if (!request.cursor) return itemsResponse(latestGroup, [item('a')], 'cursor-a')
        if (request.cursor === 'cursor-a') return deferredMore.promise
        return itemsResponse(latestGroup, [item('c')])
      },
    },
    bound: (promise) => promise,
  })

  await controller.loadCatalog({ channelKey: 'channel-key', publicBeeKey: 'public-bee-key' })
  const pendingMore = controller.loadMore()
  await controller.selectGroup('videos')
  deferredMore.resolve(itemsResponse(latestGroup, [item('b')], 'cursor-b'))
  await pendingMore
  await controller.selectGroup('latest')

  let page = controller.getSnapshot().pages.latest
  assert.equal(page.loading, false)
  assert.equal(page.loadingMore, false)
  assert.deepEqual(page.cards.map((card) => card.id), ['a', 'b'])
  await controller.loadMore()
  page = controller.getSnapshot().pages.latest
  assert.deepEqual(page.cards.map((card) => card.id), ['a', 'b', 'c'])
  assert.equal(requests.at(-1).cursor, 'cursor-b')
})

test('a rejected background load-more clears its flags and remains retryable after group switches', async () => {
  const deferredMore = deferred()
  let retried = false
  const controller = createChannelCatalogState({
    rpc: {
      getContentCatalog: async () => catalogResponse('Creator', [latestGroup, videosGroup]),
      getContentItems: async (request) => {
        if (request.groupId === 'videos') return itemsResponse(videosGroup, [item('video')])
        if (!request.cursor) return itemsResponse(latestGroup, [item('a')], 'cursor-a')
        if (retried) return itemsResponse(latestGroup, [item('b')])
        return deferredMore.promise
      },
    },
    bound: (promise) => promise,
  })

  await controller.loadCatalog({ channelKey: 'channel-key' })
  const pendingMore = controller.loadMore()
  await controller.selectGroup('videos')
  deferredMore.reject(new Error('Background page failed'))
  await pendingMore
  await controller.selectGroup('latest')

  let page = controller.getSnapshot().pages.latest
  assert.equal(page.loadingMore, false)
  assert.equal(page.error, 'Background page failed')
  retried = true
  await controller.loadMore()
  page = controller.getSnapshot().pages.latest
  assert.deepEqual(page.cards.map((card) => card.id), ['a', 'b'])
  assert.equal(page.loadingMore, false)
})

test('a newer same-group request wins and settles without an older completion overwriting it', async () => {
  const older = deferred()
  let cursorRequests = 0
  const controller = createChannelCatalogState({
    rpc: {
      getContentCatalog: async () => catalogResponse('Creator'),
      getContentItems: async (request) => {
        if (request.cursor) {
          cursorRequests += 1
          return older.promise
        }
        return cursorRequests === 0
          ? itemsResponse(latestGroup, [item('initial')], 'cursor')
          : itemsResponse(latestGroup, [item('fresh')])
      },
    },
    bound: (promise) => promise,
  })

  await controller.loadCatalog({ channelKey: 'channel-key' })
  const olderLoad = controller.loadMore()
  await controller.retrySelectedGroup()
  older.resolve(itemsResponse(latestGroup, [item('stale')]))
  await olderLoad

  const page = controller.getSnapshot().pages.latest
  assert.deepEqual(page.cards.map((card) => card.id), ['fresh'])
  assert.equal(page.loading, false)
  assert.equal(page.loadingMore, false)
})

test('a route change clears in-flight group state and ignores its eventual completion', async () => {
  const oldItems = deferred()
  const controller = createChannelCatalogState({
    rpc: {
      getContentCatalog: async (request) => catalogResponse(request.channelKey),
      getContentItems: async (request) => (
        request.channelKey === 'old'
          ? oldItems.promise
          : itemsResponse(latestGroup, [item('new')])
      ),
    },
    bound: (promise) => promise,
  })

  const oldLoad = controller.loadCatalog({ channelKey: 'old' })
  await Promise.resolve()
  await Promise.resolve()
  await controller.loadCatalog({ channelKey: 'new' })
  oldItems.resolve(itemsResponse(latestGroup, [item('old')]))
  await oldLoad

  assert.equal(controller.getSnapshot().route.channelKey, 'new')
  assert.deepEqual(controller.getSnapshot().pages.latest.cards.map((card) => card.id), ['new'])
  assert.equal(controller.getSnapshot().pages.latest.loading, false)
})
