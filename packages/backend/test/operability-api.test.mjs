import test from 'brittle'
import b4a from 'b4a'

import { createPortableStateService } from '../src/portability/service.js'
import {
  createDurableOperabilityServices,
  createOperabilityApi,
  createPortableStateRepositoryAdapter
} from '../src/api/operability.js'
import { createApi } from '../src/api.js'
import { registerSharedHandlers, SHARED_HANDLER_NAMES } from '../src/hrpc-handlers.js'
import { attachMobileHandlers } from '../src/mobile-handlers.js'
import { createBackendLifecycle } from '../src/storage.js'

function portableState () {
  return {
    publisherCatalogs: [],
    graphPreferences: [],
    indexPreferences: [],
    followedFeeds: { publishers: [], indexes: [], moderation: [] },
    archiveEvidence: [],
    policy: {}
  }
}

function fixture (options = {}) {
  const restored = options.restored || new Map()
  const portabilityService = createPortableStateService({
    snapshotPortableState: async () => portableState(),
    restoreTransaction: async ({ manifestDigest, itemCount }) => {
      if (restored.has(manifestDigest)) return { importedCount: 0, skippedCount: itemCount, idempotent: true }
      restored.set(manifestDigest, true)
      return { importedCount: itemCount, skippedCount: 0, idempotent: false }
    },
    now: () => 1_700_000_000_000
  })
  const archiveDiagnostics = {
    getArchiveOperatorStatus: () => ({
      success: true,
      operatorMode: 'local-first',
      activePledgeCount: 1,
      healthyPledgeCount: 1,
      failedPledgeCount: 0,
      challengeSuccessCount: 2,
      challengeFailureCount: 0,
      capacityRejectionCount: 0,
      offloadRejectionCount: 0,
      recentFailureCodes: [],
      updatedAt: 1_700_000_000_000
    })
  }
  const services = {
    portabilityService,
    archiveDiagnostics,
    publisherDeviceStatusProvider: async () => ({
      authorizationState: {
        publisherId: b4a.alloc(32, 1),
        activeRootKey: b4a.alloc(32, 2),
        catalogEpoch: 1,
        policyEpoch: 1,
        writers: new Map([[b4a.toString(b4a.alloc(32, 4), 'hex'), {
          signerKey: b4a.alloc(32, 3),
          expiresAt: 1_800_000_000_000,
          capabilities: ['publish']
        }]])
      },
      localDevice: {
        devicePublicKey: b4a.alloc(32, 3),
        writerKey: b4a.alloc(32, 4),
        hasRootAuthority: true,
        rootPublicKey: b4a.alloc(32, 2),
        catalogEpoch: 1,
        policyEpoch: 1
      }
    })
  }
  const seedingManager = {
    previewStorageLimit: ({ maxBytes }) => ({
      success: true,
      requestedMaxBytes: maxBytes,
      currentUsedBytes: 100,
      requiredEvictionBytes: Math.max(0, 100 - maxBytes),
      evictableBytes: 100,
      protectedBytes: 0,
      affectedSeedCount: maxBytes < 100 ? 1 : 0,
      affectedCategories: maxBytes < 100 ? ['localCacheBytes'] : [],
      consequences: maxBytes < 100 ? ['local cache eviction'] : [],
      feasible: true
    }),
    async getStorageStats () {
      return {
        usedBytes: 100,
        ownedOriginalBytes: 1,
        immutablePublicationBytes: 2,
        pledgedArchiveBytes: 3,
        localCacheBytes: 4,
        thumbnailBytes: 5,
        indexBytes: 6,
        temporaryTransferBytes: 7,
        totalCategorizedBytes: 28,
        evictableBytes: 22,
        protectedBytes: 6
      }
    }
  }
  return { api: createOperabilityApi({ services, seedingManager }), restored }
}

test('operability API exposes all five successful commands and storage stats extension', async t => {
  const { api } = fixture()

  const device = await api.getPublisherDeviceStatus({})
  t.is(device.success, true)
  t.is(device.status, 'authorized')
  t.is(device.canPublish, true)

  const exported = await api.exportPortableState({})
  t.is(exported.success, true)
  t.ok(exported.manifestBytes.byteLength > 0)
  t.is(exported.itemCount, 1)

  const restored = await api.restorePortableState({ manifestBytes: exported.manifestBytes, manifestDigest: exported.manifestDigest })
  t.is(restored.success, true)
  t.is(restored.importedCount, 1)

  const preview = await api.previewStorageLimit({ maxBytes: 50 })
  t.is(preview.success, true)
  t.is(preview.requiredEvictionBytes, 50)

  const archive = await api.getArchiveOperatorStatus({})
  t.is(archive.success, true)
  t.is(archive.activePledgeCount, 1)

  const stats = await api.getStorageStats()
  t.is(stats.totalCategorizedBytes, 28)
  t.is(stats.protectedBytes, 6)
})

test('operability API rejects contract bounds before invoking domains', async t => {
  let calls = 0
  const api = createOperabilityApi({
    services: {
      portabilityService: {
        restorePortableState: async () => { calls++; return {} }
      },
      publisherDeviceStatusProvider: async () => { calls++; return {} },
      archiveDiagnostics: { getArchiveOperatorStatus: () => ({}) }
    },
    seedingManager: { previewStorageLimit: () => { calls++; return {} } }
  })

  t.is((await api.getPublisherDeviceStatus({ publisherId: b4a.alloc(31) })).reasonCode, 'PUBLISHER_DEVICE_REQUEST_INVALID')
  t.is((await api.restorePortableState({ manifestBytes: b4a.alloc(1_048_577) })).errorCode, 'PORTABLE_STATE_TOO_LARGE')
  t.is((await api.previewStorageLimit({ maxBytes: Number.MAX_SAFE_INTEGER + 1 })).errorCode, 'INVALID_STORAGE_LIMIT')
  t.is(calls, 0)
})

test('operability failures are stable, fail closed, and never expose secrets', async t => {
  const api = createOperabilityApi({ services: {}, seedingManager: null })
  const responses = await Promise.all([
    api.getPublisherDeviceStatus({}),
    api.exportPortableState({}),
    api.restorePortableState({ manifestBytes: b4a.from('{}') }),
    api.previewStorageLimit({ maxBytes: 1 }),
    api.getArchiveOperatorStatus({})
  ])

  t.alike(responses.map(response => response.success), Array(5).fill(false))
  t.alike(responses.map(response => response.errorCode || response.reasonCode), [
    'PUBLISHER_DEVICE_STATUS_UNAVAILABLE',
    'PORTABLE_STATE_UNAVAILABLE',
    'PORTABLE_STATE_UNAVAILABLE',
    'STORAGE_SERVICE_UNAVAILABLE',
    'ARCHIVE_DIAGNOSTICS_UNAVAILABLE'
  ])
  const encoded = JSON.stringify(responses)
  for (const forbidden of ['secret', 'privateKey', 'signingKey', 'rootKey']) t.absent(encoded.includes(forbidden))
})

test('portability results remain durable across API recreation', async t => {
  const restored = new Map()
  const first = fixture({ restored })
  const exported = await first.api.exportPortableState({})
  await first.api.restorePortableState({ manifestBytes: exported.manifestBytes, manifestDigest: exported.manifestDigest })

  const second = fixture({ restored })
  const repeated = await second.api.restorePortableState({ manifestBytes: exported.manifestBytes, manifestDigest: exported.manifestDigest })
  t.is(repeated.idempotent, true)
  t.is(repeated.skippedCount, 1)
})

test('universal API, shared HRPC, and mobile adapters route every operability command', async t => {
  const handlers = [
    ['GetPublisherDeviceStatus', 'getPublisherDeviceStatus'],
    ['ExportPortableState', 'exportPortableState'],
    ['RestorePortableState', 'restorePortableState'],
    ['PreviewStorageLimit', 'previewStorageLimit'],
    ['GetArchiveOperatorStatus', 'getArchiveOperatorStatus']
  ]
  const api = createApi({
    ctx: {},
    seedingManager: null,
    operability: { services: {} }
  })
  const rpc = {}
  const shared = {}
  for (const [handlerName, methodName] of handlers) {
    t.ok(SHARED_HANDLER_NAMES.includes(handlerName), `${handlerName} is registered`)
    t.is(typeof api[methodName], 'function', `${methodName} is on universal API`)
    api[methodName] = async request => ({ methodName, request })
    rpc[`on${handlerName}`] = handler => { shared[handlerName] = handler }
  }
  registerSharedHandlers(rpc, { api })
  const mobile = {}
  attachMobileHandlers(mobile, { api })

  for (const [handlerName, methodName] of handlers) {
    const request = { marker: methodName }
    t.alike(await shared[handlerName](request), { methodName, request })
    t.alike(await mobile[methodName](request), { methodName, request })
  }
})

test('portable repository adapter composes real stores in one durable transaction', async t => {
  const state = portableState()
  const restoredDigests = new Map()
  const restoredFields = []
  let transactions = 0
  const components = Object.fromEntries(Object.entries({
    publisherCatalogs: state.publisherCatalogs,
    graphPreferences: state.graphPreferences,
    indexPreferences: state.indexPreferences,
    followedPublisherFeeds: state.followedFeeds.publishers,
    followedIndexFeeds: state.followedFeeds.indexes,
    followedModerationFeeds: state.followedFeeds.moderation,
    archiveEvidence: state.archiveEvidence,
    policy: state.policy
  }).map(([field, value]) => [field, {
    snapshot: async () => structuredClone(value),
    restore: async (_transaction, incoming) => { restoredFields.push([field, structuredClone(incoming)]) }
  }]))
  const repository = createPortableStateRepositoryAdapter({
    components,
    restoredDigests: {
      async get (digest) { return restoredDigests.get(digest) || null },
      async put (digest, value) { restoredDigests.set(digest, value) }
    },
    async transaction (work) {
      transactions++
      return work({ id: transactions })
    }
  })

  t.alike(await repository.snapshotPortableState(), state)
  const first = await repository.restorePortableStateTransaction({
    manifestDigest: 'a'.repeat(64),
    state,
    itemCount: 1
  })
  const second = await repository.restorePortableStateTransaction({
    manifestDigest: 'a'.repeat(64),
    state,
    itemCount: 1
  })
  t.alike(first, { importedCount: 1, skippedCount: 0, idempotent: false })
  t.alike(second, { importedCount: 0, skippedCount: 1, idempotent: true })
  t.is(transactions, 1)
  t.is(restoredFields.length, 8)
})

test('durable archive diagnostics survive restart and owned services flush exactly once', async t => {
  const records = new Map()
  let writes = 0
  const metaDb = {
    async get (key) { return records.has(key) ? { value: structuredClone(records.get(key)) } : null },
    async put (key, value) { writes++; records.set(key, structuredClone(value)) }
  }
  const lifecycle = createBackendLifecycle()
  const first = await createDurableOperabilityServices({ ctx: { metaDb, lifecycle }, now: () => 1_700_000_000_000 })
  first.archiveDiagnostics.recordOffloadRejection({ reason: 'not-eligible' })
  await lifecycle.shutdown()
  await lifecycle.shutdown()
  t.is(writes, 1)

  const second = await createDurableOperabilityServices({ ctx: { metaDb }, now: () => 1_700_000_000_001 })
  const status = second.archiveDiagnostics.getArchiveOperatorStatus()
  t.is(status.offloadRejectionCount, 1)
  t.alike(status.recentFailureCodes, ['ARCHIVE_OFFLOAD_NOT_ELIGIBLE'])
})
