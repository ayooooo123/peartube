import b4a from 'b4a'

import { createArchiveDiagnostics } from '../archive/diagnostics.js'
import { createMigrationLifecycle, MIGRATION_LIMITS } from '../migrations/observability.js'
import { createPortableStateService } from '../portability/service.js'
import {
  MAX_PORTABLE_MANIFEST_BYTES,
  PORTABLE_STATE_VERSION
} from '../portability/constants.js'
import { projectPublisherDeviceStatus } from '../publisher/device-status.js'

const MAX_MIGRATION_ID_BYTES = 64
const MAX_STORAGE_PREVIEW_ARRAY_LENGTH = 32
const MAX_ARCHIVE_FAILURE_CODES = 64
const durableServicesByContext = new WeakMap()

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function utf8Bytes (value) {
  return typeof value === 'string' ? b4a.byteLength(value) : -1
}

function hasOnlyFields (request, fields) {
  return isObject(request) && Object.keys(request).every(field => fields.has(field))
}

function validMigrationId (value) {
  const bytes = utf8Bytes(value)
  return bytes > 0 && bytes <= MAX_MIGRATION_ID_BYTES
}

function emptyMigrationStatus (migrationId, errorCode, joined) {
  return {
    success: false,
    migrationId: typeof migrationId === 'string' ? migrationId : '',
    state: 'failed',
    version: 1,
    processedCount: 0,
    importedCount: 0,
    skippedCount: 0,
    quarantinedCount: 0,
    unsupportedCount: 0,
    remainingCount: 0,
    retryable: false,
    updatedAt: 0,
    ...(joined === undefined ? {} : { joined }),
    errorCode
  }
}

function emptyMigrationReport (migrationId, errorCode) {
  return {
    success: false,
    migrationId: typeof migrationId === 'string' ? migrationId : '',
    errorCode
  }
}

function emptyDeviceStatus (reasonCode) {
  return {
    success: false,
    status: 'unavailable',
    reasonCode,
    canPublish: false,
    canPlayLocal: false,
    canExportLocal: false,
    canDeleteLocal: false,
    canRootTransition: false
  }
}

function emptyPortableExport (errorCode) {
  return {
    success: false,
    schemaVersion: PORTABLE_STATE_VERSION,
    itemCount: 0,
    errorCode
  }
}

function emptyPortableRestore (errorCode) {
  return {
    success: false,
    schemaVersion: PORTABLE_STATE_VERSION,
    importedCount: 0,
    skippedCount: 0,
    idempotent: false,
    errorCode,
    error: 'Portable state operation failed'
  }
}

function emptyStoragePreview (requestedMaxBytes, errorCode) {
  return {
    success: false,
    requestedMaxBytes: Number.isSafeInteger(requestedMaxBytes) && requestedMaxBytes >= 0 ? requestedMaxBytes : 0,
    currentUsedBytes: 0,
    requiredEvictionBytes: 0,
    evictableBytes: 0,
    protectedBytes: 0,
    affectedSeedCount: 0,
    affectedCategories: [],
    consequences: [],
    feasible: false,
    errorCode
  }
}

function emptyArchiveStatus (errorCode) {
  return {
    success: false,
    operatorMode: 'unavailable',
    activePledgeCount: 0,
    healthyPledgeCount: 0,
    failedPledgeCount: 0,
    challengeSuccessCount: 0,
    challengeFailureCount: 0,
    capacityRejectionCount: 0,
    offloadRejectionCount: 0,
    recentFailureCodes: [],
    updatedAt: 0,
    errorCode
  }
}

function asBytes (value) {
  return b4a.isBuffer(value) || value instanceof Uint8Array
}

function validOptionalBytes32 (value) {
  return value === undefined || value === null || (asBytes(value) && value.byteLength === 32)
}

function validDigest (value) {
  return value === undefined || value === null || (typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value))
}

function recordValue (record) {
  return isObject(record) && Object.hasOwn(record, 'value') ? record.value : record
}

function prefixedStore (db, prefix) {
  if (!db || typeof db.get !== 'function' || typeof db.put !== 'function') return null
  return {
    get: key => db.get(`${prefix}${key}`),
    put: (key, value) => db.put(`${prefix}${key}`, value)
  }
}

function hasMigrationAdapters (migrations) {
  if (migrations instanceof Map) return migrations.size > 0
  return isObject(migrations) && Object.keys(migrations).length > 0
}

function repositoryMethod (repository, names) {
  for (const name of names) {
    if (typeof repository?.[name] === 'function') return repository[name].bind(repository)
  }
  return null
}

const PORTABLE_COMPONENT_FIELDS = Object.freeze([
  'publisherCatalogs',
  'graphPreferences',
  'indexPreferences',
  'followedPublisherFeeds',
  'followedIndexFeeds',
  'followedModerationFeeds',
  'archiveEvidence',
  'policy'
])

function portableComponentValue (state, field) {
  if (field === 'followedPublisherFeeds') return state.followedFeeds.publishers
  if (field === 'followedIndexFeeds') return state.followedFeeds.indexes
  if (field === 'followedModerationFeeds') return state.followedFeeds.moderation
  return state[field]
}

function assemblePortableState (snapshots) {
  return {
    publisherCatalogs: snapshots.publisherCatalogs,
    graphPreferences: snapshots.graphPreferences,
    indexPreferences: snapshots.indexPreferences,
    followedFeeds: {
      publishers: snapshots.followedPublisherFeeds,
      indexes: snapshots.followedIndexFeeds,
      moderation: snapshots.followedModerationFeeds
    },
    archiveEvidence: snapshots.archiveEvidence,
    policy: snapshots.policy
  }
}

/**
 * Adapt a durable aggregate repository to the portability service without
 * introducing an in-memory fallback. The adapter deliberately requires both
 * snapshot and transactional restore capabilities.
 */
export function createPortableStateRepositoryAdapter (repository) {
  const snapshot = repositoryMethod(repository, ['snapshotPortableState', 'snapshot'])
  const restore = repositoryMethod(repository, ['restorePortableStateTransaction', 'restoreTransaction'])
  if (snapshot && restore) {
    return Object.freeze({
      snapshotPortableState: snapshot,
      restorePortableStateTransaction: restore,
      flush: typeof repository.flush === 'function' ? repository.flush.bind(repository) : async () => {}
    })
  }

  const components = repository?.components
  const transaction = repositoryMethod(repository, ['transaction'])
  const restoredDigests = repository?.restoredDigests
  if (!isObject(components) || !transaction ||
      typeof restoredDigests?.get !== 'function' || typeof restoredDigests?.put !== 'function') return null

  for (const field of PORTABLE_COMPONENT_FIELDS) {
    if (typeof components[field]?.snapshot !== 'function' || typeof components[field]?.restore !== 'function') return null
  }

  let flushPromise = null
  return Object.freeze({
    async snapshotPortableState () {
      const values = await Promise.all(PORTABLE_COMPONENT_FIELDS.map(async field => [
        field,
        await components[field].snapshot()
      ]))
      return assemblePortableState(Object.fromEntries(values))
    },

    async restorePortableStateTransaction ({ manifestDigest, state, itemCount }) {
      const restored = recordValue(await restoredDigests.get(manifestDigest))
      if (restored) return { importedCount: 0, skippedCount: itemCount, idempotent: true }

      await transaction(async transactionHandle => {
        await Promise.all(PORTABLE_COMPONENT_FIELDS.map(field =>
          components[field].restore(transactionHandle, portableComponentValue(state, field))
        ))
        await restoredDigests.put(manifestDigest, { restored: true }, transactionHandle)
      })
      return { importedCount: itemCount, skippedCount: 0, idempotent: false }
    },

    flush () {
      if (!flushPromise) {
        flushPromise = Promise.all([
          ...PORTABLE_COMPONENT_FIELDS.map(field => components[field].flush?.()),
          restoredDigests.flush?.()
        ]).then(() => undefined)
      }
      return flushPromise
    }
  })
}

/**
 * Instantiate durable operability services from injected real repositories and
 * the backend metadata Hyperbee. Missing domain dependencies remain absent so
 * API handlers fail closed rather than consulting fake empty stores.
 */
export async function createDurableOperabilityServices (options = {}) {
  const ctx = options.ctx || null
  const configured = options.operability || ctx?.operability || {}
  const metaDb = options.metaDb || configured.metaDb || ctx?.metaDb || null
  const migrations = options.migrations || configured.migrations || ctx?.migrations || null
  const migrationStore = options.migrationStore || configured.migrationStore || prefixedStore(metaDb, 'operability:')
  const portableRepository = createPortableStateRepositoryAdapter(
    options.portableStateRepository || configured.portableStateRepository || ctx?.portableStateRepository
  )
  const publisherDeviceStatusProvider = options.publisherDeviceStatusProvider || configured.publisherDeviceStatusProvider || ctx?.publisherDeviceStatusProvider || null

  const migrationLifecycle = migrationStore && hasMigrationAdapters(migrations)
    ? createMigrationLifecycle({ store: migrationStore, migrations, now: options.now || configured.now || Date.now })
    : null

  const portabilityService = portableRepository
    ? createPortableStateService({
        snapshotPortableState: portableRepository.snapshotPortableState,
        restoreTransaction: portableRepository.restorePortableStateTransaction,
        verifyArchiveEvidence: options.verifyArchiveEvidence || configured.verifyArchiveEvidence,
        now: options.now || configured.now || Date.now
      })
    : null

  let archiveDiagnostics = options.archiveDiagnostics || configured.archiveDiagnostics || ctx?.archiveDiagnostics || null
  if (!archiveDiagnostics && metaDb) {
    const archiveStateKey = 'operability:archive-diagnostics:v1'
    const stored = recordValue(await metaDb.get(archiveStateKey).catch(() => null))
    archiveDiagnostics = createArchiveDiagnostics({
      state: stored,
      operatorMode: configured.operatorMode,
      now: options.now || configured.now || Date.now,
      maxHistory: MAX_ARCHIVE_FAILURE_CODES,
      persist: state => metaDb.put(archiveStateKey, state)
    })
  }

  let closePromise = null
  const services = {
    migrationLifecycle,
    portabilityService,
    portableRepository,
    publisherDeviceStatusProvider,
    archiveDiagnostics,
    close () {
      if (!closePromise) {
        closePromise = Promise.all([
          archiveDiagnostics?.flush?.(),
          portableRepository?.flush?.()
        ]).then(() => undefined)
      }
      return closePromise
    }
  }

  const lifecycle = options.lifecycle || ctx?.lifecycle
  lifecycle?.ownResource?.('operability durable services', services, 'close', 5_000)
  return Object.freeze(services)
}

export function getOrCreateDurableOperabilityServices (options = {}) {
  const ctx = options.ctx
  if (!ctx || typeof ctx !== 'object') return createDurableOperabilityServices(options)
  let pending = durableServicesByContext.get(ctx)
  if (!pending) {
    pending = createDurableOperabilityServices(options)
    durableServicesByContext.set(ctx, pending)
  }
  return pending
}

export function createOperabilityApi (options = {}) {
  const configuredServices = options.services || null
  const servicesPromise = configuredServices
    ? Promise.resolve(configuredServices)
    : options.servicesPromise || getOrCreateDurableOperabilityServices(options)
  const seedingManager = options.seedingManager || null

  async function services () {
    try {
      return await servicesPromise
    } catch {
      return {}
    }
  }

  return Object.freeze({
    async getMigrationStatus (request = {}) {
      if (!hasOnlyFields(request, new Set(['migrationId'])) || !validMigrationId(request.migrationId)) {
        return emptyMigrationStatus(request?.migrationId, 'MIGRATION_ID_INVALID')
      }
      const lifecycle = (await services()).migrationLifecycle
      if (!lifecycle?.getMigrationStatus) return emptyMigrationStatus(request.migrationId, 'MIGRATION_SERVICE_UNAVAILABLE')
      try {
        return await lifecycle.getMigrationStatus(request)
      } catch {
        return emptyMigrationStatus(request.migrationId, 'MIGRATION_STATUS_FAILED')
      }
    },

    async retryMigration (request = {}) {
      if (!hasOnlyFields(request, new Set(['migrationId'])) || !validMigrationId(request.migrationId)) {
        return emptyMigrationStatus(request?.migrationId, 'MIGRATION_ID_INVALID', false)
      }
      const lifecycle = (await services()).migrationLifecycle
      if (!lifecycle?.retryMigration) return emptyMigrationStatus(request.migrationId, 'MIGRATION_SERVICE_UNAVAILABLE', false)
      try {
        return await lifecycle.retryMigration(request)
      } catch {
        return emptyMigrationStatus(request.migrationId, 'MIGRATION_RETRY_FAILED', false)
      }
    },

    async exportMigrationReport (request = {}) {
      if (!hasOnlyFields(request, new Set(['migrationId'])) || !validMigrationId(request.migrationId)) {
        return emptyMigrationReport(request?.migrationId, 'MIGRATION_ID_INVALID')
      }
      const lifecycle = (await services()).migrationLifecycle
      if (!lifecycle?.exportMigrationReport) return emptyMigrationReport(request.migrationId, 'MIGRATION_SERVICE_UNAVAILABLE')
      try {
        const result = await lifecycle.exportMigrationReport(request)
        if (result?.reportBytes?.byteLength > MIGRATION_LIMITS.maxReportBytes) {
          return emptyMigrationReport(request.migrationId, 'MIGRATION_REPORT_TOO_LARGE')
        }
        return result
      } catch {
        return emptyMigrationReport(request.migrationId, 'MIGRATION_REPORT_FAILED')
      }
    },

    async getPublisherDeviceStatus (request = {}) {
      if (!hasOnlyFields(request, new Set(['publisherId', 'devicePublicKey'])) ||
          !validOptionalBytes32(request.publisherId) || !validOptionalBytes32(request.devicePublicKey)) {
        return emptyDeviceStatus('PUBLISHER_DEVICE_REQUEST_INVALID')
      }
      const provider = (await services()).publisherDeviceStatusProvider
      if (typeof provider !== 'function') return emptyDeviceStatus('PUBLISHER_DEVICE_STATUS_UNAVAILABLE')
      try {
        const projection = projectPublisherDeviceStatus(await provider(request))
        if (request.publisherId && !b4a.equals(request.publisherId, projection.publisherId)) {
          return emptyDeviceStatus('PUBLISHER_DEVICE_NOT_FOUND')
        }
        if (request.devicePublicKey && (!projection.devicePublicKey || !b4a.equals(request.devicePublicKey, projection.devicePublicKey))) {
          return emptyDeviceStatus('PUBLISHER_DEVICE_NOT_FOUND')
        }
        return { success: true, ...projection }
      } catch {
        return emptyDeviceStatus('PUBLISHER_DEVICE_STATUS_UNAVAILABLE')
      }
    },

    async exportPortableState (request = {}) {
      if (!hasOnlyFields(request, new Set())) return emptyPortableExport('PORTABLE_STATE_INVALID_REQUEST')
      const service = (await services()).portabilityService
      if (!service?.exportPortableState) return emptyPortableExport('PORTABLE_STATE_UNAVAILABLE')
      try {
        const result = await service.exportPortableState(request)
        if (!result?.success) return { ...emptyPortableExport(result?.errorCode || 'PORTABLE_STATE_EXPORT_FAILED') }
        if (!asBytes(result.manifestBytes) || result.manifestBytes.byteLength > MAX_PORTABLE_MANIFEST_BYTES) {
          return emptyPortableExport('PORTABLE_STATE_TOO_LARGE')
        }
        return result
      } catch {
        return emptyPortableExport('PORTABLE_STATE_EXPORT_FAILED')
      }
    },

    async restorePortableState (request = {}) {
      if (!hasOnlyFields(request, new Set(['manifestBytes', 'manifestDigest'])) || !asBytes(request.manifestBytes)) {
        return emptyPortableRestore('PORTABLE_STATE_INVALID_REQUEST')
      }
      if (request.manifestBytes.byteLength > MAX_PORTABLE_MANIFEST_BYTES) {
        return emptyPortableRestore('PORTABLE_STATE_TOO_LARGE')
      }
      if (!validDigest(request.manifestDigest)) return emptyPortableRestore('PORTABLE_STATE_INVALID_FIELD')
      const service = (await services()).portabilityService
      if (!service?.restorePortableState) return emptyPortableRestore('PORTABLE_STATE_UNAVAILABLE')
      try {
        const result = await service.restorePortableState(request)
        if (!result?.success) return { ...emptyPortableRestore(result?.errorCode || 'PORTABLE_STATE_INVALID_FIELD') }
        return result
      } catch {
        return emptyPortableRestore('PORTABLE_STATE_TRANSACTION_FAILED')
      }
    },

    async previewStorageLimit (request = {}) {
      if (!hasOnlyFields(request, new Set(['maxBytes'])) || !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 0) {
        return emptyStoragePreview(request?.maxBytes, 'INVALID_STORAGE_LIMIT')
      }
      if (typeof seedingManager?.previewStorageLimit !== 'function') {
        return emptyStoragePreview(request.maxBytes, 'STORAGE_SERVICE_UNAVAILABLE')
      }
      try {
        const result = await seedingManager.previewStorageLimit(request)
        if (!Array.isArray(result?.affectedCategories) || !Array.isArray(result?.consequences) ||
            result.affectedCategories.length > MAX_STORAGE_PREVIEW_ARRAY_LENGTH || result.consequences.length > MAX_STORAGE_PREVIEW_ARRAY_LENGTH) {
          return emptyStoragePreview(request.maxBytes, 'STORAGE_PREVIEW_BOUNDS_EXCEEDED')
        }
        return result
      } catch {
        return emptyStoragePreview(request.maxBytes, 'STORAGE_PREVIEW_FAILED')
      }
    },

    async getArchiveOperatorStatus (request = {}) {
      if (!hasOnlyFields(request, new Set())) return emptyArchiveStatus('ARCHIVE_REQUEST_INVALID')
      const diagnostics = (await services()).archiveDiagnostics
      if (!diagnostics?.getArchiveOperatorStatus) return emptyArchiveStatus('ARCHIVE_DIAGNOSTICS_UNAVAILABLE')
      try {
        const result = await diagnostics.getArchiveOperatorStatus()
        if (!Array.isArray(result?.recentFailureCodes) || result.recentFailureCodes.length > MAX_ARCHIVE_FAILURE_CODES) {
          return emptyArchiveStatus('ARCHIVE_DIAGNOSTICS_BOUNDS_EXCEEDED')
        }
        return result
      } catch {
        return emptyArchiveStatus('ARCHIVE_DIAGNOSTICS_FAILED')
      }
    },

    async getStorageStats () {
      if (typeof seedingManager?.getStorageStats !== 'function') {
        return { success: false, errorCode: 'STORAGE_SERVICE_UNAVAILABLE' }
      }
      try {
        // Say so explicitly. The stats object carries no success field of its
        // own, so every caller that checked one - the CLI status line among
        // them - reported a healthy measurement as a failure.
        return { success: true, ...(await seedingManager.getStorageStats()) }
      } catch {
        return { success: false, errorCode: 'STORAGE_STATS_FAILED' }
      }
    }
  })
}
