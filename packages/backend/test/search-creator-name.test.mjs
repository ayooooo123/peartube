import test from 'brittle'

import { buildMetadataEnvelope, buildSearchText } from '../src/search/metadata-envelope.js'
import { SemanticFinder } from '../src/search/semantic-finder.js'
import { createSearchApi } from '../src/api/search.js'
import { createBackendLifecycle } from '../src/storage.js'
import { FederatedSearch } from '../src/search/federated-search.js'

test('search metadata envelope indexes creatorName separately from channelName', (t) => {
  const envelope = buildMetadataEnvelope({
    id: 'archived-video',
    title: 'Archived debate clip',
    description: 'Source mirror',
    channelName: 'Channel',
    creatorName: 'Original Creator',
  }, {
    channelKey: 'relay-archive',
  })

  t.is(envelope.creatorName, 'Original Creator')
  t.is(envelope.sourceFields.creatorName, true)
  t.ok(envelope.searchText.includes('Original Creator'))
  t.ok(buildSearchText(envelope).includes('Original Creator'))
})

test('semantic finder keeps creatorName in stored vector metadata', async (t) => {
  const finder = new SemanticFinder()
  finder.initialized = true

  await finder.indexFromMetadata({
    id: 'archived-video',
    title: 'Archived debate clip',
    channelName: 'Channel',
    creatorName: 'Original Creator',
  }, 'relay-archive')

  const stored = finder.globalIndex.vectors.get('archived-video')?.metadata
  t.is(stored.creatorName, 'Original Creator')
  t.ok(stored.searchText.includes('Original Creator'))
})

test('semantic finder refreshes older vectors when creatorName becomes available', async (t) => {
  const finder = new SemanticFinder()
  finder.initialized = true

  await finder.indexFromMetadata({
    id: 'archived-video',
    title: 'Archived debate clip',
  }, 'relay-archive')

  t.is(finder.needsMetadataRefresh({
    id: 'archived-video',
    creatorName: 'Original Creator',
  }), true)

  await finder.indexFromMetadata({
    id: 'archived-video',
    title: 'Archived debate clip',
    creatorName: 'Original Creator',
  }, 'relay-archive')

  t.is(finder.needsMetadataRefresh({
    id: 'archived-video',
    creatorName: 'Original Creator',
  }), false)
})

test('federated search closes discovery, listeners, channels, and pending query timers once', async (t) => {
  let connectionHandler = null
  let discoveryDestroyCalls = 0
  let channelCloseCalls = 0
  let listenerRemovals = 0
  const swarm = {
    connections: new Set(),
    join() {
      return {
        async destroy() {
          discoveryDestroyCalls += 1
        },
      }
    },
    on(event, handler) {
      if (event === 'connection') connectionHandler = handler
    },
    off(event, handler) {
      if (event === 'connection' && handler === connectionHandler) listenerRemovals += 1
    },
  }
  const search = new FederatedSearch(swarm, {
    async search() {
      return []
    },
  })
  search.setupTopic(Buffer.alloc(32, 1))
  search.peerChannels.set({}, {
    messages: [{ send() {} }],
    close() {
      channelCloseCalls += 1
    },
  })
  const pending = search._broadcastSearch('query', 5, 60_000, null)

  await Promise.all([search.close(), search.close()])
  t.alike(await pending, [])
  t.is(discoveryDestroyCalls, 1)
  t.is(listenerRemovals, 1)
  t.is(channelCloseCalls, 1)
  t.is(search.pendingQueries.size, 0)
  t.is(search.peerChannels.size, 0)
})

test('search API owns its lazy coordinator and does not create it after shutdown', async (t) => {
  const lifecycle = createBackendLifecycle()
  const ownedLabels = []
  let joinCalls = 0
  let destroyCalls = 0
  const swarm = {
    connections: new Set(),
    join() {
      joinCalls += 1
      return {
        destroy() {
          destroyCalls += 1
        },
      }
    },
    on() {},
    off() {},
  }
  const ctx = {
    lifecycle,
    swarm,
    semanticFinder: {
      async search() {
        return []
      },
    },
    ownResource(label, resource, methods, timeoutMs) {
      ownedLabels.push(label)
      return lifecycle.ownResource(label, resource, methods, timeoutMs)
    },
  }
  const api = createSearchApi({
    ctx,
    ensureSemanticFinder: async () => ctx.semanticFinder,
  })
  t.alike(await api.searchVideos('21'.repeat(32), 'query', { federated: false }), [])
  t.ok(ownedLabels.includes('federated search'))
  t.is(joinCalls, 1)
  const interrupted = api.searchVideos('21'.repeat(32), 'pending', { federated: true })
  await new Promise((resolve) => setImmediate(resolve))
  await lifecycle.shutdown()
  await t.exception(interrupted, /shutting down/)
  t.is(destroyCalls, 1)

  const afterShutdown = createSearchApi({
    ctx: { ...ctx, federatedSearch: null },
    ensureSemanticFinder: async () => ctx.semanticFinder,
  })
  await t.exception(
    afterShutdown.searchVideos('22'.repeat(32), 'query', { federated: false }),
    /shutting down/
  )
  t.is(joinCalls, 1)
})
