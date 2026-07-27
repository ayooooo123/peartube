/**
 * Backend Orchestrator - One-shot initialization for all backend components
 *
 * This is the single entry point for both mobile and desktop backends.
 * It initializes storage, managers, and wires up all components.
 *
 * Usage:
 *   const backend = await createBackendContext({ storagePath: '/path/to/storage', expectedProtocolVersion: hostProtocolVersion });
 *   const { ctx, api, identityManager, uploadManager, scopedNetwork, seedingManager, videoStats } = backend;
 */

import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import {
  DEFAULT_STORED_PROTOCOL_MIGRATIONS,
  initializeStorage,
  createBackendLifecycle,
  isPlaybackActive,
  loadChannel,
  shutdownBackend,
  resumeNetworking,
  suspendNetworking,
} from './storage.js';
import { VideoStatsTracker } from './video-stats.js';
import { SeedingManager } from './seeding.js';
import { createPlaybackWindowCache } from './playback-window-cache.js';
import { createPlaybackForwardFill } from './playback-forward-fill.js';
import { createApi } from './api.js';
import { getOrCreateDurableOperabilityServices } from './api/operability.js'
import {
  assertNetworkPolicyRuntimeSupported,
  createNetworkPolicyRuntime,
  createPolicyApi,
  loadNetworkPolicy,
  resolveNetworkPolicyForEnvironment,
} from './api/policy.js'
import { createIdentityManager } from './identity.js';
import { createPersonalManager } from './personal/personal-manager.js';
import { createUploadManager } from './upload.js';
import { createPublisherCatalogRegistry } from './api/publisher.js'
import { createScopedNetworkRuntime } from './network/scoped-runtime.js'
import {
  createConsumerCatalogProjection,
  createPublisherCatalogProjection,
  projectAuthenticatedPublisherMediaRecords,
} from './media-graph/catalog-projection.js'
import { createAvailabilityEvidenceStore } from './assets/availability-evidence.js'
import { createLocalMediaIndex } from './indexing/local-index.js'
import { createIndexFeedManager } from './indexing/feed-manager.js'
import { createIndexPublisherFollowReconciler } from './indexing/publisher-follow-reconciler.js'
import {
  CONSUMER_MODERATION_PROFILE_SETTING_KEY,
  createConsumerModerationPolicy,
  createConsumerModerationProfileController,
  createConsumerModerationProfileTransaction,
  createConsumerWorkRevalidator,
  createModerationManager,
} from './moderation/index.js'
import {
  createPublicationV1CheckpointRepository,
  createPublicationV1LegacyRepository,
  createPublicationV1StartupLifecycle,
  runPublicationV1StartupMigration,
} from './migrations/publication-v1.js'
import { derivePublisherId } from './publisher/index.js'
import {
  authorizeArchiveRequestFromManifestStore,
  createArchiveStore,
  createArchivePolicy,
  createPermissionlessArchiveNetwork,
} from './archive/index.js'
import {
  createBackendSeedPinAdmission,
  registerSeedPinProtocol,
  installSeedPinIdentityMutationHooks,
  resolveSeedPinClientAuth,
} from './seed-pin/index.js';


import {
  readIdentityKeyFile,
  readPrimaryKeyFile,
  writeIdentityKeyFile,
  writePrimaryKeyFile
} from './identity-key-file.js';
import { derivePrimaryKey } from './peartube-identity.js';
import { initFileLogger } from './logger.js';
import { getVideoToolboxDecodeSettings, setVideoToolboxDecodeEnabled, setVideoToolboxHwMapEnabled } from './transcode/videotoolbox-settings.mjs';
import {
  loadBareFsModule,
  loadBarePathModule,
  resolveBareFsModuleSync,
  resolveBarePathModuleSync,
  resolveBareOrNodeFsModuleSync,
  resolveBareOrNodePathModuleSync,
} from './runtime-modules.js'
import {
  isCorestoreLockError,
  shouldRetryCorestoreSeedFallback
} from './corestore-error-utils.js'
import { createStartupGate } from './startup-gates.js'
import { appendDebugLine } from './debug-log.js'

const STARTUP_GATE_WARMUP_WAIT_MS = 2000

export { createBackendLifecycle }

export function buildStorageConfig(config, primaryKey) {
  return {
    storagePath: config.storagePath,
    blobServerHost: config.blobServerHost,
    blobServerBindHost: config.blobServerBindHost,
    primaryKey,
    corestoreWaitForLock: config.corestoreWaitForLock ?? false,
    platform: config.platform ?? 'desktop',
    network: config.network ?? {},
    swarmOptions: config.swarmOptions ?? {},
    expectedProtocolVersion: config.expectedProtocolVersion,
    storedProtocolMigrations: config.storedProtocolMigrations ?? DEFAULT_STORED_PROTOCOL_MIGRATIONS,
    lifecycle: config.lifecycle,
  }
}

// Resolve an async stat/readdir for whichever fs flavour the runtime provides.
// bare-fs on mobile does not reliably expose `fs.promises`, so the original
// `fs.promises?.stat` path returned undefined and the whole measurer bailed to
// null — leaving Android storage stats stuck at zero. Fall back to the sync API
// (always present on bare-fs and node) wrapped in a promise.
function resolveAsyncFsOp(fs, name) {
  const promiseFn = fs.promises?.[name]
  if (typeof promiseFn === 'function') {
    return (target) => promiseFn.call(fs.promises, target)
  }
  const syncFn = fs[`${name}Sync`]
  if (typeof syncFn === 'function') {
    return async (target) => syncFn.call(fs, target)
  }
  return null
}

function createStorageUsageMeasurer(storagePath) {
  return async function getDiskUsageBytes() {
    const fs = resolveBareOrNodeFsModuleSync()
    const path = resolveBareOrNodePathModuleSync()
    if (!fs || !path || !storagePath) return null
    const stat = resolveAsyncFsOp(fs, 'stat')
    const readdir = resolveAsyncFsOp(fs, 'readdir')
    if (!stat || !readdir) return null

    async function walk(targetPath) {
      let info
      try {
        info = await stat(targetPath)
      } catch {
        return 0
      }
      if (!info?.isDirectory?.()) return Number(info?.size || 0) || 0
      let total = 0
      let entries = []
      try {
        entries = await readdir(targetPath)
      } catch {
        return 0
      }
      for (const entry of entries) {
        total += await walk(path.join(targetPath, entry))
      }
      return total
    }

    return walk(storagePath)
  }
}


function isContextShuttingDown(ctx) {
  return Boolean(ctx && (ctx.isShuttingDown || ctx._isShutdown))
}

/**
 * @typedef {Object} BackendConfig
 * @property {string} storagePath - Path to storage directory
 * @property {string} [blobServerHost] - Hostname to use when generating blob URLs
 * @property {string} [blobServerBindHost] - Host to bind the blob server listener
 * @property {(driveKey: string, videoPath: string, stats: any) => void} [onStatsUpdate] - Callback for video stats
 */

/**
 * @typedef {Object} BackendContext
 * @property {import('./types.js').StorageContext} ctx - Storage context
 * @property {ReturnType<typeof createScopedNetworkRuntime>} scopedNetwork - scoped P2P runtime
 * @property {SeedingManager} seedingManager - Seeding manager
 * @property {VideoStatsTracker} videoStats - Video stats tracker
 * @property {ReturnType<typeof createIdentityManager>} identityManager - Identity manager
 * @property {ReturnType<typeof createUploadManager>} uploadManager - Upload manager
 */

async function warmChannels(ctx, channelKeys, label) {
  const unique = Array.from(new Set((channelKeys || []).filter(Boolean)));
  if (!unique.length) return;
  console.log(`[Orchestrator] Warming ${label}:`, unique.length);
  for (const key of unique) {
    if (ctx?.lifecycle?.signal?.aborted) return
    try {
      await loadChannel(ctx, key);
    } catch (e) {
      console.log('[Orchestrator] Warm failed for', key.slice(0, 16), e?.message);
    }
  }
}


export async function startBackendSeedPin({
  ctx,
  identityManager,
  seedPin = {},
  register = registerSeedPinProtocol,
  resolveClientAuth = resolveSeedPinClientAuth,
  createAdmission = createBackendSeedPinAdmission,
} = {}) {
  const enabled = seedPin?.enabled !== false
  if (!enabled) return null
  const clientAuthResolver = () => resolveClientAuth({ ctx, identityManager })
  const admission = typeof seedPin?.admission === 'function'
    ? seedPin.admission
    : createAdmission({ identityManager })
  const { enabled: _enabled, admission: _admission, ...registrationOptions } = seedPin || {}
  const registration = register(ctx, {
    ...registrationOptions,
    enabled: true,
    admission,
    resolveClientAuth: clientAuthResolver,
  })
  ctx?.lifecycle?.own('seed-pin registration', async () => {
    await registration?.unregister?.()
    if (ctx?.seedPinRegistration === registration) ctx.seedPinRegistration = null
  }, 2000)
  ctx.seedPinRegistration = registration
  await registration?.ready
  await registration?.refreshClientAuth?.()
  return registration
}

/**
 * Create and initialize the complete backend context.
 *
 * This function initializes storage, managers, bounded scoped discovery, and
 * the universal API before returning. Heavy local channel warming remains
 * deferred so startup is not coupled to remote peer availability.
 *
 * @param {BackendConfig} config - Configuration options
 * @returns {Promise<BackendContext>} - All backend components
 */
export async function createBackendContext(config) {
  const {
    storagePath,
    platform = 'desktop',
    blobServerHost,
    blobServerBindHost,
    onStatsUpdate,
    corestoreWaitForLock = false,
    disableStandalonePrimaryKeyFile = false,
    network = {},
    swarmOptions = {},
    expectedProtocolVersion,
    peerScorer = null,
    seedPin = {},
    archive = {},
    networkPolicy = {},
    ipcLog: _ipcLog,
    onMediaGraphUpdate,
  } = config;

  if (!Number.isSafeInteger(expectedProtocolVersion) || expectedProtocolVersion <= 0) {
    throw new TypeError('createBackendContext requires a host-provided expectedProtocolVersion')
  }

  const ipcLog = typeof _ipcLog === 'function' ? _ipcLog : () => {}
  const lifecycle = config.lifecycle || createBackendLifecycle()
  const storageConfig = { ...config, platform, lifecycle }


  console.log('[Orchestrator] ===== INITIALIZING BACKEND =====');
  console.log('[Orchestrator] Storage path:', storagePath);
  await appendDebugLine(`[orchestrator] createBackendContext start storagePath=${storagePath}`)
  ipcLog('[orchestrator] reading identity key file')
  const useStandalonePrimaryKeyFile = !disableStandalonePrimaryKeyFile

  let primaryKey = null;
  const identityKeyData = await readIdentityKeyFile(storagePath);
  await appendDebugLine(`[orchestrator] readIdentityKeyFile done present=${Boolean(identityKeyData)}`)
  if (identityKeyData) {
    primaryKey = identityKeyData.primaryKey;
    console.log('[Orchestrator] Identity key file found, using deterministic primaryKey');
  } else if (useStandalonePrimaryKeyFile) {
    const storedPrimaryKey = await readPrimaryKeyFile(storagePath);
    if (storedPrimaryKey) {
      primaryKey = storedPrimaryKey;
      console.log('[Orchestrator] Primary key file found, reusing persisted Corestore seed');
      await appendDebugLine('[orchestrator] readPrimaryKeyFile done present=true')
    } else {
      console.log('[Orchestrator] No identity key file, Corestore will use random primaryKey');
      await appendDebugLine('[orchestrator] readPrimaryKeyFile done present=false')
    }
  } else {
    console.log('[Orchestrator] Standalone primary key file disabled for this host path until an identity exists');
    await appendDebugLine('[orchestrator] standalone primary-key file disabled for this host path')
  }

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const getFsModule = async () => resolveBareFsModuleSync() || await loadBareFsModule()
  const getPathModule = async () => resolveBarePathModuleSync() || await loadBarePathModule()

  const initializeStorageWithRetry = async (opts) => {
    // Mobile callers clean stale locks before reaching here, so we only need
    // a few quick retries for genuine race conditions (e.g. two worklets
    // starting near-simultaneously).  Desktop can tolerate a slightly longer
    // window, but 5 attempts at ≤500 ms each keeps total wait under 2 s.
    const maxAttempts = 5
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await initializeStorage(opts)
      } catch (err) {
        if (!isCorestoreLockError(err) || attempt === maxAttempts) {
          if (isCorestoreLockError(err)) {
            console.warn('[Orchestrator] All retries exhausted. Attempting stale lock recovery...')
            try {
              const _fs = await getFsModule()
              const _path = await getPathModule()
              const lockFiles = [
                _path.join(opts.storagePath, 'LOCK'),
                _path.join(opts.storagePath, 'db', 'LOCK'),
                _path.join(opts.storagePath, 'primary', 'LOCK')
              ]
              for (const lockFile of lockFiles) {
                try {
                  _fs.unlinkSync(lockFile)
                } catch (err) {
                  void err
                }
              }
              const result = await initializeStorage(opts)
              console.log('[Orchestrator] Stale lock recovery succeeded')
              return result
            } catch {
              throw err
            }
          }
          throw err
        }
        const backoffMs = Math.min(300 * attempt, 500)
        console.warn(`[Orchestrator] Corestore lock detected during init. Retrying in ${backoffMs}ms (attempt ${attempt}/${maxAttempts})`)
        ipcLog(`[orchestrator] lock retry ${attempt}/${maxAttempts}`)
        await delay(backoffMs)
      }
    }
  }

  let ctx
  ipcLog('[orchestrator] initializeStorage starting')
  await appendDebugLine('[orchestrator] initializeStorage starting')
  try {
    ctx = await initializeStorageWithRetry(buildStorageConfig(storageConfig, primaryKey));
    await appendDebugLine('[orchestrator] initializeStorage done')
  } catch (err) {
    await appendDebugLine(`[orchestrator] initializeStorage error ${err?.message || String(err)}`)
    if (!primaryKey || !shouldRetryCorestoreSeedFallback(err, { hasIdentityKeyFile: Boolean(identityKeyData) })) {
      await lifecycle.shutdown()
      throw err
    }

    console.warn('[Orchestrator] Identity key file primaryKey mismatches existing Corestore seed. Falling back to stored Corestore seed.')
    
    try {
      ctx = await initializeStorageWithRetry(buildStorageConfig(storageConfig, null))
    } catch (retryError) {
      await lifecycle.shutdown()
      throw retryError
    }


    try {
      const identityPublicKey = identityKeyData?.identityPublicKey
      if (ctx?.store?.primaryKey && identityPublicKey) {
        await writeIdentityKeyFile(storagePath, {
          primaryKey: ctx.store.primaryKey,
          identityPublicKey
        })
        console.log('[Orchestrator] Rewrote identity key file to match existing Corestore seed')
      } else if (ctx?.store?.primaryKey && useStandalonePrimaryKeyFile) {
        await writePrimaryKeyFile(storagePath, ctx.store.primaryKey)
        console.log('[Orchestrator] Rewrote primary key file to match existing Corestore seed')
      } else if (ctx?.store?.primaryKey) {
        console.log('[Orchestrator] Skipped standalone primary key persistence for this host path')
      }
    } catch (persistErr) {
      console.warn('[Orchestrator] Failed to persist reconciled identity key file:', persistErr?.message)
    }
  }

  ipcLog('[orchestrator] storage initialized, port: ' + ctx.blobServerPort)
  await appendDebugLine(`[orchestrator] storage initialized port=${ctx.blobServerPort}`)

  if (!identityKeyData && ctx?.store?.primaryKey && useStandalonePrimaryKeyFile) {
    try {
      await writePrimaryKeyFile(storagePath, ctx.store.primaryKey)
      await appendDebugLine('[orchestrator] primary key file written')
    } catch (persistErr) {
      console.warn('[Orchestrator] Failed to persist primary key file:', persistErr?.message)
      await appendDebugLine(`[orchestrator] primary key file write failed ${persistErr?.message || String(persistErr)}`)
    }
  }

  try {
    const _fs = await getFsModule()
    const _path = await getPathModule()
    const logsDir = _path.join(storagePath, 'logs')
    _fs.mkdirSync(logsDir, { recursive: true })
    await initFileLogger(_path.join(logsDir, 'peartube.log'))
    console.log('[Orchestrator] File logger initialized at:', _path.join(logsDir, 'peartube.log'))
  } catch (err) {
    console.log('[Orchestrator] File logger setup skipped:', err?.message)
  }
  ipcLog('[orchestrator] managers creating')
  await appendDebugLine('[orchestrator] managers creating')

  try {
  // Phase 2: Create managers (synchronous, fast)
  const networkPolicyStore = ctx.metaDb
  let initialNetworkPolicy = await loadNetworkPolicy({
    store: networkPolicyStore,
    defaults: networkPolicy,
  })
  const consumerModerationProfile = createConsumerModerationProfileController({
    repository: {
      async load() {
        return ctx.personal?.getSetting
          ? ctx.personal.getSetting(CONSUMER_MODERATION_PROFILE_SETTING_KEY)
          : null
      },
      async save(state) {
        if (ctx.personal?.writable) {
          await ctx.personal.setSetting(CONSUMER_MODERATION_PROFILE_SETTING_KEY, state)
        }
      },
    },
  })
  await consumerModerationProfile.ready
  ctx.consumerModerationProfile = consumerModerationProfile
  initialNetworkPolicy = {
    ...initialNetworkPolicy,
    trustedModerationFeeds: consumerModerationProfile.getEffectiveCuratorSubscriptions(),
  }
  assertNetworkPolicyRuntimeSupported(initialNetworkPolicy)
  const initialNetworkEnvironment = {
    metered: network.metered === true,
    background: false,
  }
  let initialRuntimeNetworkPolicy = resolveNetworkPolicyForEnvironment(
    initialNetworkPolicy,
    initialNetworkEnvironment,
  )
  const deviceKeyPair = ctx.swarm?.keyPair
  const deviceSigner = deviceKeyPair?.publicKey && deviceKeyPair?.secretKey
    ? Object.freeze({
        signerKey: b4a.from(deviceKeyPair.publicKey),
        sign: preimage => crypto.sign(b4a.from(preimage), deviceKeyPair.secretKey)
      })
    : null
  const catalogRegistry = createPublisherCatalogRegistry(ctx, {
    now: () => Date.now(),
    deviceSigner
  })
  lifecycle.ownResource('publisher catalog registry', catalogRegistry, 'close', 5000)
  let scopedNetwork = null
  const protectedArchiveCores = new Map()
  const retainArchiveCore = ({ coreKey }) => {
    protectedArchiveCores.set(coreKey, (protectedArchiveCores.get(coreKey) || 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (protectedArchiveCores.get(coreKey) || 0) - 1
      if (remaining > 0) protectedArchiveCores.set(coreKey, remaining)
      else protectedArchiveCores.delete(coreKey)
    }
  }
  const mediaCatalogProjection = createPublisherCatalogProjection({
    catalogRegistry,
    now: () => Date.now(),
    onUpdate: event => typeof onMediaGraphUpdate === 'function'
      ? onMediaGraphUpdate(event)
      : undefined
  })
  ctx.mediaCatalogProjection = mediaCatalogProjection
  ctx.mediaGraphStore = mediaCatalogProjection.mediaGraphStore
  ctx.assetManifestStore = mediaCatalogProjection.assetManifestStore
  // Availability evidence is collected lazily by the asset/playback layer and
  // read passively by the media graph API. An empty store honestly reports
  // "awaiting replication" rather than inventing reachability.
  ctx.availabilityEvidenceStore = createAvailabilityEvidenceStore()
  // Opens the immutable rendition core a signed manifest names. Playback
  // preparation authorizes the key against the manifest before reading, so this
  // never widens what a selected source is allowed to touch. A core that cannot
  // become ready is closed and reported as a failure, so preparation can fail
  // over instead of handing the player a dead session.
  ctx.openAssetCore = async coreKey => {
    const core = ctx.store.get({ key: b4a.from(String(coreKey), 'hex') })
    try {
      await core.ready()
    } catch (error) {
      try { await core.close() } catch {}
      throw error
    }
    return core
  }
  lifecycle.ownResource('publisher media catalog projection', mediaCatalogProjection, 'close', 5000)
  // These managers are deliberately shared by the scoped transport and local
  // consumer projection. Signed page ingestion happens once; catalog reads only
  // project the resulting local state and never initiate transport work.
  let consumerIndexFeedManager = null
  const indexPublisherFollowReconciler = createIndexPublisherFollowReconciler({
    getScopedNetwork: () => scopedNetwork,
    getRecords: () => consumerIndexFeedManager?.getRecords?.() || [],
  })
  consumerIndexFeedManager = createIndexFeedManager({
    now: () => Date.now(),
    onAcceptedRecord: indexPublisherFollowReconciler.onAcceptedRecord,
    onRecordsRemoved: indexPublisherFollowReconciler.onRecordsRemoved,
    stateRepository: {
      async load() {
        return (await ctx.metaDb.get('consumer-index-feed-state:v1'))?.value || null
      },
      async save(state) {
        await ctx.metaDb.put('consumer-index-feed-state:v1', state)
      },
    },
  })
  let onConsumerModerationRecordsChanged = async () => {}
  const consumerModerationManager = createModerationManager({
    now: () => Date.now(),
    onRecordsChanged: event => onConsumerModerationRecordsChanged(event),
    stateRepository: {
      async load() {
        return (await ctx.metaDb.get('consumer-moderation-feed-state:v1'))?.value || null
      },
      async save(state) {
        await ctx.metaDb.put('consumer-moderation-feed-state:v1', state)
      },
    },
  })
  let consumerCatalogProjection = null
  scopedNetwork = createScopedNetworkRuntime({
    swarm: ctx.swarm,
    store: ctx.store,
    catalogRegistry,
    networkId: network.networkId,
    bootstrapEnabled: network.bootstrapEnabled,
    trustedBootstrapSigners: network.trustedBootstrapSigners,
    trustedBootstrapRootIds: network.trustedBootstrapRootIds,
    authorizePublication: request => mediaCatalogProjection.authorizeRendition(request),
    authorizeConsumerWork: async ({ entityRef, publicationId }) => {
      if (!consumerCatalogProjection) return false
      await mediaCatalogProjection.rebuild()
      consumerCatalogProjection.rebuild()
      if (entityRef != null) return consumerCatalogProjection.isVisible(entityRef)
      if (publicationId != null) return consumerCatalogProjection.isPublicationVisible(publicationId)
      return false
    },
    onCatalogUpdate: async () => {
      try {
        await mediaCatalogProjection.rebuild()
      } finally {
        await scopedNetwork?.revalidateRetainedRenditions?.()
      }
    },
    retainArchiveCore,
    indexFeedManager: consumerIndexFeedManager,
    moderationManager: consumerModerationManager,
    bootstrapLocatorKeyPair: deviceKeyPair,
    publisherSyncStateRepository: {
      async load(publisherId) {
        return (await ctx.metaDb.get(`consumer-publisher-sync-state:v1:${publisherId}`))?.value || null
      },
      async save(publisherId, state) {
        await ctx.metaDb.put(`consumer-publisher-sync-state:v1:${publisherId}`, state)
      },
      async clear(publisherId) {
        await ctx.metaDb.del(`consumer-publisher-sync-state:v1:${publisherId}`)
      },
      async loadGlobal() {
        return (await ctx.metaDb.get('consumer-publisher-sync-budget-global:v1'))?.value || null
      },
      async saveGlobal(state) {
        await ctx.metaDb.put('consumer-publisher-sync-budget-global:v1', state)
      },
    },
    initialNetworkPolicy: initialRuntimeNetworkPolicy,
  })
  ctx.scopedNetwork = scopedNetwork
  await consumerIndexFeedManager.ready
  await indexPublisherFollowReconciler.reconcile()
  lifecycle.ownResource('scoped network runtime', scopedNetwork, 'close', 5000)
  // Consumer projection is a local view over the authenticated publisher graph
  // plus optional bounded index records. It owns neither a feed nor authority.
  const consumerModerationPolicy = createConsumerModerationPolicy({
    profileController: consumerModerationProfile,
    moderationManager: consumerModerationManager,
  })
  consumerCatalogProjection = createConsumerCatalogProjection({
    localIndex: createLocalMediaIndex(),
    indexFeedManager: consumerIndexFeedManager,
    bootstrapManager: { listLocators: () => scopedNetwork.listBootstrapLocators() },
    mediaGraphStore: mediaCatalogProjection.mediaGraphStore,
    moderationPolicy: consumerModerationPolicy,
    publisherRecords: ({ moderationPolicy, visibleClaims } = {}) => projectAuthenticatedPublisherMediaRecords({
      mediaGraphStore: mediaCatalogProjection.mediaGraphStore,
      assetManifestStore: mediaCatalogProjection.assetManifestStore,
      moderationPolicy,
      consumerClaims: visibleClaims,
    }),
  })
  ctx.consumerIndexFeedManager = consumerIndexFeedManager
  ctx.consumerModerationManager = consumerModerationManager
  ctx.consumerCatalogProjection = consumerCatalogProjection
  const configuredOperabilityServices = config.operability?.services
    ? await Promise.resolve(config.operability.services)
    : config.operability?.servicesPromise
      ? await Promise.resolve(config.operability.servicesPromise)
      : await getOrCreateDurableOperabilityServices({ ctx, operability: config.operability })
  const archiveDiagnostics = configuredOperabilityServices?.archiveDiagnostics || null
  ctx.archiveDiagnostics = archiveDiagnostics
  const archiveStore = createArchiveStore({
    diagnostics: archiveDiagnostics,
    maxObservations: archive.maxObservations,
    now: typeof archive.now === 'function' ? archive.now : () => Date.now(),
  })
  const archiveReservationStateKey = 'archive:retention-reservations:v1'
  const archiveParticipationStateKey = 'archive:participation-policy:v1'
  const archivePolicy = createArchivePolicy({
    capacityBytes: archive.capacityBytes,
    diagnostics: archiveDiagnostics,
    now: typeof archive.now === 'function' ? archive.now : () => Date.now(),
    repository: {
      async load() {
        return (await ctx.metaDb.get(archiveReservationStateKey))?.value || null
      },
      async save(state) {
        await ctx.metaDb.put(archiveReservationStateKey, state)
      },
    },
  })
  await archivePolicy.ready

  const desiredArchiveParticipationEnabled =
    archive.enabled !== false &&
    initialNetworkPolicy.retentionMode === 'archive-pledges'
  const permissionlessArchiveNetwork = deviceKeyPair?.publicKey && deviceKeyPair?.secretKey
    ? createPermissionlessArchiveNetwork({
        keyPair: deviceKeyPair,
        scopedNetwork,
        archiveStore,
        archivePolicy,
        participationRepository: {
          async load() {
            return (await ctx.metaDb.get(archiveParticipationStateKey))?.value || null
          },
          async save(state) {
            await ctx.metaDb.put(archiveParticipationStateKey, state)
          },
        },
        enabled: false,
        capacityBytes: archive.capacityBytes,
        maxRequestBytes: archive.maxRequestBytes,
        diagnostics: archiveDiagnostics,
        peerScorer,
        challengeIntervalMs: archive.challengeIntervalMs,
        challengeTimeoutMs: archive.challengeTimeoutMs,
        acceptanceProbability: archive.acceptanceProbability,
        random: archive.random,
        now: archive.now,
        authorizeRequest: request => authorizeArchiveRequestFromManifestStore(request, {
          manifestStore: mediaCatalogProjection.assetManifestStore,
          authorizeRendition: input => mediaCatalogProjection.authorizeRendition(input),
        }),
        authorizeConsumerVisibility: async request => {
          await mediaCatalogProjection.rebuild()
          consumerCatalogProjection.rebuild()
          return consumerCatalogProjection.isPublicationVisible(request.body.publicationId)
        },
      })
    : null
  const revalidateConsumerWork = createConsumerWorkRevalidator({
    mediaCatalogProjection,
    getConsumerCatalogProjection: () => consumerCatalogProjection,
    scopedNetwork,
    getArchiveNetwork: () => permissionlessArchiveNetwork,
  })
  onConsumerModerationRecordsChanged = revalidateConsumerWork
  await permissionlessArchiveNetwork?.ready
  ctx.archiveStore = archiveStore
  ctx.archivePolicy = archivePolicy
  ctx.permissionlessArchiveNetwork = permissionlessArchiveNetwork
  if (permissionlessArchiveNetwork) {
    lifecycle.ownResource('permissionless archive network', permissionlessArchiveNetwork, 'close', 5000)
  }
  ctx.trustedRelayKeys = Array.isArray(network.trustedRelayKeys) ? network.trustedRelayKeys.slice() : []
  ctx.refreshTrustedRelayKeys = async () => ctx.trustedRelayKeys

  const startupGate = createStartupGate()
  const videoStats = new VideoStatsTracker();
  lifecycle.ownResource('video statistics', videoStats)
  const identityManager = createIdentityManager({ ctx });
  lifecycle.ownResource('identity manager', identityManager)
  const personalManager = createPersonalManager({
    ctx,
    identityManager,
    onActiveStoreChanged: async () => {
      await ctx.reloadConsumerModerationProfile?.()
    },
  });
  lifecycle.ownResource('personal manager', personalManager, 'close', 2000)
  ctx.personalManager = personalManager;

  // Keep the active personal store in sync with the active identity across all
  // platforms by wrapping the identity-manager mutators in one place (every
  // platform changes identities through these). Store activation is committed
  // only after the consumer profile and transport subscriptions reconcile.
  const refreshActivePersonalStore = async (publicKey, { allowDeviceLocal = false } = {}) => {
    const pk = publicKey || identityManager.getActivePublicKey?.()
    if (!pk) return
    const store = await personalManager.setActive(pk, { allowDeviceLocal })
    const explicitDeviceLocal = (
      allowDeviceLocal &&
      personalManager.getActivePublicKey() === 'device-local' &&
      personalManager.getAnonymous() === store &&
      ctx.personal === store
    )
    if (explicitDeviceLocal) return store
    if (
      !store ||
      personalManager.getActivePublicKey() !== pk ||
      personalManager.getActive() !== store ||
      ctx.personal !== store
    ) {
      const error = new Error(`Active PersonalStore does not match identity ${pk}`)
      error.code = 'PERSONAL_STORE_IDENTITY_MISMATCH'
      throw error
    }
    return store
  }
  const removeIdentityMutationHooks = installSeedPinIdentityMutationHooks({
    identityManager,
    onMutation: async mutation => {
      const allowDeviceLocal = (
        personalManager.getActivePublicKey() === 'device-local' &&
        (
          mutation.method === 'createIdentity' ||
          mutation.method === 'addPairedChannelIdentity'
        )
      )
      await refreshActivePersonalStore(null, { allowDeviceLocal })
      await ctx.seedPinRegistration?.refreshClientAuth?.()
    },
    onRollback: async ({ previousPublicKey }) => {
      await refreshActivePersonalStore(previousPublicKey, {
        allowDeviceLocal: personalManager.getActivePublicKey() === 'device-local',
      })
      await ctx.seedPinRegistration?.refreshClientAuth?.()
    },
  })
  lifecycle.own('identity mutation hooks', removeIdentityMutationHooks, 2000)

  const seedingManager = new SeedingManager(ctx.store, ctx.metaDb, {
    identityManager,
    getDiskUsageBytes: createStorageUsageMeasurer(storagePath),
    isCacheClearBlocked: isPlaybackActive,
    metaSubspaces: ctx.metaSubspaces,
    protectedArchiveCores,
  });
  lifecycle.own('seeding manager', async () => {
    seedingManager.clearTimer?.(seedingManager._storageMaintenanceTimer)
    seedingManager._storageMaintenanceTimer = null
    await seedingManager.flushSeedPersist?.()
  }, 2000)


  // Keep a single playing video from filling the disk: trim already-played
  // blocks behind a bounded seek-back window while it streams. Unlike the
  // seed-quota sweep this is playhead-aware, so it runs *during* playback.
  const playbackWindowCache = createPlaybackWindowCache({ store: ctx.store });
  lifecycle.ownResource('playback window cache', playbackWindowCache, 'stop', 2000)
  playbackWindowCache.start();
  ctx.playbackWindowCache = playbackWindowCache;
  ctx.registerCleanup?.('playback window cache stop', () => playbackWindowCache.stop?.(), { timeoutMs: 1000 })

  // Symmetric counterpart to the window cache: keep a deep read-ahead window
  // downloading *ahead* of the playhead so a fast peer builds a real buffer
  // instead of the on-demand stream settling at playback bitrate. The window
  // cache trims behind, so the two together bound the on-disk footprint.
  const playbackForwardFill = createPlaybackForwardFill({ store: ctx.store });
  lifecycle.ownResource('playback forward fill', playbackForwardFill, 'stop', 2000)
  playbackForwardFill.start();
  ctx.playbackForwardFill = playbackForwardFill;
  ctx.registerCleanup?.('playback forward fill stop', () => playbackForwardFill.stop?.(), { timeoutMs: 1000 })

  const uploadManager = createUploadManager({
    ctx,
    catalogRegistry,
    mediaCatalogProjection,
    scopedNetwork,
    deviceKeyPair
  });
  lifecycle.ownResource('upload manager', uploadManager)


  if (onStatsUpdate) {
    videoStats.setOnStatsUpdate(onStatsUpdate);
  }


  ipcLog('[orchestrator] seedingManager.init starting')
  await appendDebugLine('[orchestrator] seedingManager.init starting')

  // Phase 5: Initialize seeding manager (fast - just loads config from db)
  await seedingManager.init();
  await seedingManager.applyNetworkPolicy(initialNetworkPolicy)
  await appendDebugLine('[orchestrator] seedingManager.init done')
  ipcLog('[orchestrator] seedingManager.init done')

  // Phase 5.5: Load transcode settings (optional)
  try {
    const stored = await ctx.metaDb.get('transcode-settings').catch(() => null);
    const storedEnabled = stored?.value?.videoToolboxDecodeEnabled;
    const storedHwMap = stored?.value?.videoToolboxHwMapEnabled;
    let appliedSettings = getVideoToolboxDecodeSettings();
    let hasStored = false;
    if (typeof storedEnabled === 'boolean') {
      appliedSettings = setVideoToolboxDecodeEnabled(storedEnabled, 'stored');
      hasStored = true;
    }
    if (typeof storedHwMap === 'boolean') {
      appliedSettings = setVideoToolboxHwMapEnabled(storedHwMap, 'stored');
      hasStored = true;
    }
    if (hasStored) {
      console.log('[Orchestrator] Transcode settings loaded:', appliedSettings);
    } else {
      console.log('[Orchestrator] Transcode settings default:', appliedSettings);
    }
  } catch (e) {
    console.log('[Orchestrator] Transcode settings load skipped:', e?.message);
  }

  ipcLog('[orchestrator] loadIdentities starting')
  await appendDebugLine('[orchestrator] loadIdentities starting')
  await identityManager.loadIdentities();
  await appendDebugLine('[orchestrator] loadIdentities done')
  ipcLog('[orchestrator] loadIdentities done')

  const publicationV1SourceRepository = createPublicationV1LegacyRepository({
    identityManager,
    loadChannel: (driveKey, identity) => loadChannel(ctx, driveKey, {
      preferWritable: true,
      deferPublicProjection: true,
      writerKeyName: identity?.channelWriterKeyName || null,
    }),
  })
  const publicationV1CheckpointRepository = createPublicationV1CheckpointRepository(ctx.metaDb)
  let networkPolicyRuntime = null
  let pendingNetworkPolicy = initialNetworkPolicy
  const publicationV1Startup = createPublicationV1StartupLifecycle({
    migrate: () => runPublicationV1StartupMigration({
      sourceRepository: publicationV1SourceRepository,
      checkpointRepository: publicationV1CheckpointRepository,
      resolveCatalog: async source => {
        const genesisRootKey = b4a.from(source.ownerPublisherId, 'hex')
        const publisherId = derivePublisherId(genesisRootKey)
        try {
          const owned = await catalogRegistry.resolve(publisherId)
          if (owned) return owned
        } catch (error) {
          if (error?.code !== 'PUBLISHER_CATALOG_UNAVAILABLE' &&
              !/PUBLISHER_CATALOG_UNAVAILABLE/.test(error?.message || '')) throw error
        }
        // These sources are this device's own channels. When the local
        // publisher catalog is keyed by a publisher root rather than the
        // channel identity - which is how a relay provisions one - nothing
        // resolves from the owner key, the migration never completes, and
        // every later provisionPublisherCatalog fails PUBLISHER_MIGRATION_
        // PENDING. Migrating them into the one local writable catalog is what
        // the plan already assumes, since it builds operations against
        // binding.publisherId.
        try {
          const writable = await catalogRegistry.getWritableBindings()
          return writable?.length === 1 ? writable[0] : null
        } catch (error) {
          if (error?.code === 'PUBLISHER_CATALOG_UNAVAILABLE' ||
              /PUBLISHER_CATALOG_UNAVAILABLE/.test(error?.message || '')) return null
          throw error
        }
      },
      deviceKeyPair,
      mediaCatalogProjection,
    }),
    startDiscovery: async () => {
      await scopedNetwork.start()
      if (networkPolicyRuntime) {
        await networkPolicyRuntime.start(pendingNetworkPolicy)
      } else if (permissionlessArchiveNetwork && desiredArchiveParticipationEnabled) {
        await permissionlessArchiveNetwork.setParticipation({
          enabled: true,
          capacityBytes: archive.capacityBytes,
          maxRequestBytes: archive.maxRequestBytes,
          acceptanceProbability: archive.acceptanceProbability,
        })
      }
    },
  })
  let startupMayCommitStoredProtocol = false
  const completePublicationV1Migration = async () => {
    const migration = await publicationV1Startup.complete()
    ctx.publicationV1Migration = migration
    if (migration?.status === 'complete' && startupMayCommitStoredProtocol) {
      ctx.storedProtocol?.commit()
    }
    return migration
  }
  ctx.completePublicationV1Migration = completePublicationV1Migration
  lifecycle.own('publication v1 migration hook', () => {
    if (ctx.completePublicationV1Migration === completePublicationV1Migration) {
      ctx.completePublicationV1Migration = null
    }
  })
  await completePublicationV1Migration()

  // Open the active identity's private multi-writer personal store (subscriptions,
  // playlists, watch history, settings) and expose it on ctx. Best-effort: a
  // failure here must not block backend startup.
  await personalManager.init().catch((err) => ipcLog('[orchestrator] personal store init failed: ' + (err?.message || err)))
  // PersonalStore is the durable, encrypted device/paired-device authority for
  // the local moderation profile. Network policy mirrors only its effective
  // feed set so transport has no independent profile state to drift from.
  if (ctx.personal) await consumerModerationProfile.reload()
  initialNetworkPolicy = {
    ...initialNetworkPolicy,
    trustedModerationFeeds: consumerModerationProfile.getEffectiveCuratorSubscriptions(),
  }
  initialRuntimeNetworkPolicy = resolveNetworkPolicyForEnvironment(initialNetworkPolicy, initialNetworkEnvironment)

  networkPolicyRuntime = createNetworkPolicyRuntime({
    initialPolicy: initialNetworkPolicy,
    scopedNetwork,
    seedingManager,
    archiveNetwork: archive.enabled === false ? null : permissionlessArchiveNetwork,
    ...initialNetworkEnvironment,
    suspendTransport: suspendNetworking,
    resumeTransport: resumeNetworking,
  })
  if (publicationV1Startup.ready) await networkPolicyRuntime.start()
  ctx.networkPolicyRuntime = networkPolicyRuntime
  ctx.networkPolicyStore = networkPolicyStore
  ctx.onNetworkPolicyChange = async policy => {
    if (!publicationV1Startup.ready) {
      pendingNetworkPolicy = policy
      return resolveNetworkPolicyForEnvironment(policy, initialNetworkEnvironment)
    }
    const effective = await networkPolicyRuntime.apply(policy)
    pendingNetworkPolicy = policy
    await revalidateConsumerWork()
    return effective
  }
  let consumerPolicyWrites = Promise.resolve()
  const consumerPolicyTransactionQueue = Object.freeze({
    run(operation) {
      const next = consumerPolicyWrites.then(operation, operation)
      consumerPolicyWrites = next.catch(() => {})
      return next
    },
  })
  const policyApi = createPolicyApi({
    store: networkPolicyStore,
    initialPolicy: initialNetworkPolicy,
    onPolicyChange: ctx.onNetworkPolicyChange,
    validatePolicy: policy => networkPolicyRuntime.assertSupported(policy),
    getProfileModerationFeeds: () =>
      consumerModerationProfile.getEffectiveCuratorSubscriptions(),
    transactionQueue: consumerPolicyTransactionQueue,
  })
  const applyProfileState = async (state, transactionContext) => {
    const response = await policyApi.setProfileModerationFeeds(
      state.profile.enabled === false ? [] : state.profile.curatorSubscriptions,
      transactionContext,
    )
    if (response.success === false) throw new Error(response.errorCode || 'consumer moderation profile rejected')
    return state
  }
  const moderationProfileTransaction = createConsumerModerationProfileTransaction({
    profileController: consumerModerationProfile,
    applyState: applyProfileState,
    afterCommit: revalidateConsumerWork,
    transactionQueue: consumerPolicyTransactionQueue,
  })
  ctx.setConsumerModerationProfile = input => moderationProfileTransaction.apply(input)
  ctx.reloadConsumerModerationProfile = () => moderationProfileTransaction.reload()

  // Phase 6: Create the universal API over the single scoped P2P runtime.
  const api = createApi({
    ctx,
    seedingManager,
    videoStats,
    operability: config.operability,
    catalogRegistry,
    scopedNetwork,
    permissionlessArchiveNetwork,
    policyApi,
    networkPolicyRuntime,
  });


  // Sender auth requires the stored descriptor proof, so backfill completes
  // before seed-pin registration and discovery.
  try {
    const descriptorSummary = await identityManager.ensureSignedChannelDescriptors?.()
    if (descriptorSummary) ipcLog('[orchestrator] descriptor backfill: ' + JSON.stringify(descriptorSummary))
  } catch (err) {
    ipcLog('[orchestrator] descriptor backfill failed: ' + (err?.message || err))
  }

  let seedPinRegistration
  try {
    seedPinRegistration = await startBackendSeedPin({
      ctx,
      identityManager,
      seedPin,
    })
  } catch (error) {
    await shutdownBackend(ctx).catch(() => {})
    throw error
  }
  ctx.registerCleanup?.('seed-pin unregister', async () => {
    const registration = ctx.seedPinRegistration
    await registration?.unregister?.()
    if (ctx.seedPinRegistration === registration) ctx.seedPinRegistration = null
  }, { timeoutMs: 2000 })

  // The marker is the durable readiness commit. Keep it last: identities,
  // managers, migrations, seed-pin, and discovery must all initialize before a
  // later host is allowed to treat this state as fully written by this version.
  startupMayCommitStoredProtocol = true
  if (publicationV1Startup.ready) ctx.storedProtocol?.commit()

  // Return result - heavy channel warming happens in background
  const result = {
    ctx,
    api,
    scopedNetwork,
    seedingManager,
    videoStats,
    identityManager,
    personalManager,
    uploadManager,
    mediaCatalogProjection,
    archiveStore,
    permissionlessArchiveNetwork,
    seedPin: seedPinRegistration,
    seedPinClients: seedPinRegistration?.clients || null,
    async destroy() {
      await shutdownBackend(ctx)
    },
    async initializeIdentityFromMnemonic(mnemonic) {
      const pk = await derivePrimaryKey(mnemonic);
      const { identityPublicKey } = await (await import('./peartube-identity.js')).deriveIdentity(mnemonic);
      await writeIdentityKeyFile(storagePath, { primaryKey: pk, identityPublicKey });
      console.log('[Orchestrator] Identity key file written for mnemonic-derived identity');
      return { needsRestart: !primaryKey };
    }
  };

  ipcLog('[orchestrator] ===== BACKEND READY =====')
  console.log('[Orchestrator] Identities loaded:', identityManager.getIdentities().length);

  // Phase 8: Heavy local initialization in background (non-blocking).
  lifecycle.defer('backend warm-up', async (signal) => {
    // Early return if shutdown was initiated during deferred init setup
    if (signal.aborted || isContextShuttingDown(ctx)) {
      console.log('[Orchestrator] Deferred init aborted: shutdown in progress')
      return
    }

    if (ctx.swarm?.connections?.size) {
      startupGate.noteSwarmPeer()
    }

    try {
      const startupMilestones = await startupGate.waitUntilOpen({ timeoutMs: STARTUP_GATE_WARMUP_WAIT_MS })
      if (!startupMilestones) {
        console.log('[Orchestrator] scoped-network startup gate timed out; continuing backend warmup offline')
      } else {
        console.log('[Orchestrator] Startup gate opened, beginning deferred warm-up')
      }
    } catch (e) {
      console.log('[Orchestrator] Startup gate wait failed:', e?.message)
      return
    }
    if (signal.aborted) return
    
    try {
      // Load channels in the background.
      // This can be slow (sync + metadata replay) and should NOT block worker init.
      if (signal.aborted || isContextShuttingDown(ctx)) return
      try {
        await identityManager.loadChannelDrives()
      } catch (e) {
        console.error('[Orchestrator] Identity background init error:', e?.message)
      }
      if (signal.aborted) return
      // Warm local subscribed / pinned / seeding channels without opening
      // unverified remote cores; scoped retention is explicit through the API.
      if (signal.aborted || isContextShuttingDown(ctx)) return
      try {
        const subs = (await ctx.metaDb.get('subscriptions').catch(() => null))?.value || []
        if (signal.aborted) return
        const subscriptionKeys = subs.map((s) => s.driveKey).filter(Boolean)
        const pinnedKeys = seedingManager.getPinnedChannels?.() || []
        const seeds = seedingManager.getActiveSeeds?.() || []
        const seedKeys = seeds.map((s) => s.driveKey).filter(Boolean) || []


        await warmChannels(ctx, [...subscriptionKeys, ...pinnedKeys, ...seedKeys], 'subscriptions/pins/seeds')
        // Skip prefetch - it was causing errors and slowing things down
      } catch (e) {
        console.log('[Orchestrator] Warm-up skipped:', e?.message)
      }

      if (signal.aborted || isContextShuttingDown(ctx)) return
      console.log('[Orchestrator] ===== BACKGROUND INIT COMPLETE =====')
      console.log('[Orchestrator] Channels cached:', ctx.channels?.size || 0)
      console.log('[Orchestrator] Swarm connections:', ctx.swarm.connections.size)
    } catch (e) {
      console.error('[Orchestrator] Background init error:', e?.message)
    }
  })

  return result;
  } catch (error) {
    await lifecycle.shutdown()
    throw error
  }
}
