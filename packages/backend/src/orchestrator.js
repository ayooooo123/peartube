/**
 * Backend Orchestrator - One-shot initialization for all backend components
 *
 * This is the single entry point for both mobile and desktop backends.
 * It initializes storage, managers, and wires up all components.
 *
 * Usage:
 *   const backend = await createBackendContext({ storagePath: '/path/to/storage' });
 *   const { ctx, api, identityManager, uploadManager, publicFeed, seedingManager, videoStats } = backend;
 */

import {
  initializeStorage,
  createBackendLifecycle,
  isPlaybackActive,
  loadChannel,
  retainPublicBeeContentDiscovery,
  retainSwarmDiscovery,
  shutdownBackend,
} from './storage.js';
import { createContentPublication } from './content-publication.js';
import { VideoStatsTracker } from './video-stats.js';
import { SeedingManager } from './seeding.js';
import { createPlaybackWindowCache } from './playback-window-cache.js';
import { createPlaybackForwardFill } from './playback-forward-fill.js';
import { createApi } from './api.js';
import { createIdentityManager } from './identity.js';
import { createPersonalManager } from './personal/personal-manager.js';
import { createUploadManager } from './upload.js';
import {
  createBackendSeedPinAdmission,
  registerSeedPinProtocol,
  installSeedPinIdentityMutationHooks,
  resolveSeedPinClientAuth,
} from './seed-pin/index.js';

function createNoopFeed() {
  return {
    feedConnections: new Set(),
    feedDiscovery: null,
    getFeed: () => [],
    start: async () => {},
    stop: async () => {},
    addStopHook: () => null,
    setOnRelayMirrorKey: () => {},
    setOnFeedUpdate: () => {},
    setOnFeedConnectionOpen: () => {},
    setOnFeedSync: () => {},
    handleDiscoveredPeer: () => false,
    handleConnection: () => {},
    setAvailabilityHintProvider: () => {},
    setFeedSnapshotProvider: () => {},
    setSignedDescriptorProvider: () => {},
  }
}

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
 * @property {() => void} [onFeedUpdate] - Callback when feed updates
 * @property {(driveKey: string, videoPath: string, stats: any) => void} [onStatsUpdate] - Callback for video stats
 */

/**
 * @typedef {Object} BackendContext
 * @property {import('./types.js').StorageContext} ctx - Storage context
 * @property {ReturnType<typeof createApi>} api - API methods
 * @property {object} publicFeed - scoped discovery facade
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

const OWNED_PUBLICATION_RECONCILER = Symbol('owned-content-publication-reconciler')

function createOwnedPublicationReconciler({
  ctx,
  publicFeed,
  log,
  retryBaseMs,
  retryMaxMs,
}) {
  const entries = new Map()
  const timers = new Map()
  const timerOwnership = new Map()
  const attempts = new Map()
  const state = {
    stopped: false,
    publicFeed,
    log,
    retryBaseMs,
    retryMaxMs,
    removeStopHook: null,
    async execute(entry) {
      const pending = timers.get(entry.channelKey)
      if (pending) {
        clearTimeout(pending)
        timerOwnership.get(entry.channelKey)?.release()
        timerOwnership.delete(entry.channelKey)
        timers.delete(entry.channelKey)
      }
      try {
        const result = await entry.publication.reconcileCanonicalClaims({
          channelKey: entry.channelKey,
          publicBeeKey: entry.channel.publicBee.keyHex,
        })
        attempts.delete(entry.channelKey)
        return result
      } catch (err) {
        state.schedule(entry)
        throw err
      }
    },
    schedule(entry) {
      if (state.stopped || timers.has(entry.channelKey)) return
      const attempt = (attempts.get(entry.channelKey) || 0) + 1
      attempts.set(entry.channelKey, attempt)
      const delay = Math.min(
        state.retryMaxMs,
        state.retryBaseMs * (2 ** Math.min(attempt - 1, 16)),
      )
      const timer = setTimeout(async () => {
        timers.delete(entry.channelKey)
        timerOwnership.get(entry.channelKey)?.release()
        timerOwnership.delete(entry.channelKey)
        if (state.stopped) return
        try {
          await state.execute(entry)
        } catch (err) {
          state.log.warn?.(
            '[Orchestrator] Retried canonical reconciliation failed:',
            entry.channelKey.slice(0, 16),
            err?.message || err,
          )
        }
      }, delay)
      timer.unref?.()
      const ownership = ctx?.lifecycle?.ownTimer(`publication retry ${entry.channelKey.slice(0, 16)}`, timer)
      if (ownership) timerOwnership.set(entry.channelKey, ownership)
      timers.set(entry.channelKey, timer)
    },
    stop() {
      if (state.stopped) return
      state.stopped = true
      for (const timer of timers.values()) clearTimeout(timer)
      for (const ownership of timerOwnership.values()) ownership.release()
      timerOwnership.clear()
      timers.clear()
      attempts.clear()
      for (const entry of entries.values()) {
        entry.publicBee?.setOnCanonicalClaimsSynchronized?.(null)
      }
      entries.clear()
      if (ctx?.[OWNED_PUBLICATION_RECONCILER] === state) {
        delete ctx[OWNED_PUBLICATION_RECONCILER]
      }
    },
    entries,
    timers,
    attempts,
  }
  state.removeStopHook = publicFeed?.addStopHook?.(() => state.stop()) || null
  return state
}

export async function reconcileOwnedContentPublications({
  ctx,
  identityManager,
  publicFeed,
  log = console,
  retryBaseMs = 250,
  retryMaxMs = 30000,
} = {}) {
  const summary = { checked: 0, reconciled: 0, deferred: 0, failed: 0 }
  let coordinator = ctx?.[OWNED_PUBLICATION_RECONCILER]
  if (!coordinator || coordinator.stopped || coordinator.publicFeed !== publicFeed) {
    coordinator?.stop()
    coordinator = createOwnedPublicationReconciler({
      ctx,
      publicFeed,
      log,
      retryBaseMs: Math.max(1, Number(retryBaseMs) || 250),
      retryMaxMs: Math.max(1, Number(retryMaxMs) || 30000),
    })
    ctx[OWNED_PUBLICATION_RECONCILER] = coordinator
    ctx?.lifecycle?.ownResource('publication reconciler', coordinator, 'stop', 2000)
  } else {
    coordinator.log = log
    coordinator.retryBaseMs = Math.max(1, Number(retryBaseMs) || coordinator.retryBaseMs)
    coordinator.retryMaxMs = Math.max(
      coordinator.retryBaseMs,
      Number(retryMaxMs) || coordinator.retryMaxMs,
    )
  }

  const identities = identityManager?.getIdentities?.() || []
  const ownedKeys = Array.from(new Set(identities
    .map((identity) => identity?.channelKey || identity?.driveKey)
    .filter((key) => typeof key === 'string' && key.length > 0)
    .map((key) => key.toLowerCase())))

  for (const channelKey of ownedKeys) {
    summary.checked++
    const channel = ctx?.channels?.get?.(channelKey)
    if (!channel?.publicBee) {
      summary.failed++
      log.warn?.('[Orchestrator] Owned-channel reconciliation skipped: channel unavailable', channelKey.slice(0, 16))
      continue
    }

    let entry = coordinator.entries.get(channelKey)
    if (!entry || entry.channel !== channel || entry.publicBee !== channel.publicBee) {
      entry?.publicBee?.setOnCanonicalClaimsSynchronized?.(null)
      entry = {
        channelKey,
        channel,
        publicBee: channel.publicBee,
        publication: createContentPublication({ channel, publicFeed }),
        handler: null,
      }
      coordinator.entries.set(channelKey, entry)
    }
    entry.handler = async () => {
      try {
        await coordinator.execute(entry)
      } catch (err) {
        log.warn?.(
          '[Orchestrator] Post-sync canonical reconciliation failed:',
          channelKey.slice(0, 16),
          err?.message || err,
        )
      }
    }
    channel.publicBee.setOnCanonicalClaimsSynchronized?.(entry.handler)

    try {
      const result = await coordinator.execute(entry)
      if (result.status === 'deferred') summary.deferred++
      else summary.reconciled++
    } catch (err) {
      summary.failed++
      log.warn?.(
        '[Orchestrator] Startup canonical reconciliation failed:',
        channelKey.slice(0, 16),
        err?.message || err,
      )
    }
  }
  return summary
}
export function installOwnedContentPublicationIdentityHooks({
  ctx,
  identityManager,
  publicFeed,
  refreshActivePersonalStore = async () => {},
  refreshSeedPinClientAuth = async () => {},
  log = console,
} = {}) {
  return installSeedPinIdentityMutationHooks({
    identityManager,
    onMutation: async ({ label, reconcile }) => {
      const activePublicKey = identityManager.getActivePublicKey?.() || null
      let personalFailed = false
      if (activePublicKey) {
        try {
          await refreshActivePersonalStore(activePublicKey)
        } catch (error) {
          personalFailed = true
          log.warn?.(`[Orchestrator] ${label} personal store refresh failed:`, error?.message || error)
        }
      }
      try {
        await refreshSeedPinClientAuth({
          failClosed: personalFailed || activePublicKey === null,
        })
      } catch (error) {
        log.warn?.(`[Orchestrator] ${label} seed-pin auth refresh failed:`, error?.message || error)
      }
      if (reconcile) {
        await reconcileOwnedContentPublications({
          ctx,
          identityManager,
          publicFeed,
          log,
        }).catch((error) => {
          log.warn?.(`[Orchestrator] ${label} reconciliation failed:`, error?.message || error)
        })
      }
    },
  })
}

export async function startBackendSeedPinBeforeDiscovery({
  ctx,
  identityManager,
  publicFeed,
  seedPin = {},
  register = registerSeedPinProtocol,
  resolveClientAuth = resolveSeedPinClientAuth,
  createAdmission = createBackendSeedPinAdmission,
} = {}) {
  if (!publicFeed || typeof publicFeed.start !== 'function') {
    throw new TypeError('publicFeed.start is required')
  }
  const enabled = seedPin?.enabled !== false
  let registration = null
  let registrationOwnership = null
  if (enabled) {
    const clientAuthResolver = () => resolveClientAuth({ ctx, identityManager })
    const admission = typeof seedPin?.admission === 'function'
      ? seedPin.admission
      : createAdmission({ identityManager })
    const { enabled: _enabled, admission: _admission, ...registrationOptions } = seedPin || {}
    registration = register(ctx, {
      ...registrationOptions,
      enabled: true,
      admission,
      resolveClientAuth: clientAuthResolver,
    })
    registrationOwnership = ctx?.lifecycle?.own('seed-pin registration', async () => {
      await registration?.unregister?.()
      if (ctx?.seedPinRegistration === registration) ctx.seedPinRegistration = null
    }, 2000)
    ctx.seedPinRegistration = registration
    await registration?.ready
    await registration?.refreshClientAuth?.()
  }

  const discovery = Promise.resolve()
    .then(() => publicFeed.start())
    .catch(async error => {
      if (registrationOwnership) await registrationOwnership.cleanup()
      else await registration?.unregister?.()
      throw error
    })
  return { registration, discovery }
}

/**
 * Create and initialize the complete backend context.
 *
 * This function:
 * 1. Initializes storage (Corestore, Hyperbee, BlobServer, Hyperswarm)
 * 2. Creates all managers (PublicFeed, Seeding, VideoStats, Identity, Upload)
 * 3. Wires up swarm connection handling for replication and feed protocol
 * 4. Starts the public feed discovery
 * 5. Loads existing identities and their channels (in background)
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
    onFeedUpdate,
    onStatsUpdate,
    corestoreWaitForLock = false,
    disableStandalonePrimaryKeyFile = false,
    network = {},
    swarmOptions = {},
    peerScorer = null,
    seedPin = {},
    ipcLog: _ipcLog
  } = config;

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
  const publicFeed = createNoopFeed()
  ctx.publicFeed = publicFeed
  ctx.trustedRelayKeys = Array.isArray(network.trustedRelayKeys) ? network.trustedRelayKeys.slice() : []
  ctx.refreshTrustedRelayKeys = async () => ctx.trustedRelayKeys
  ctx.blindPeering = { enabled: false, addMirrorKeys: () => 0, close: async () => {} }

  const startupGate = createStartupGate()
  const videoStats = new VideoStatsTracker();
  lifecycle.ownResource('video statistics', videoStats)
  const identityManager = createIdentityManager({ ctx });
  lifecycle.ownResource('identity manager', identityManager)
  const personalManager = createPersonalManager({ ctx, identityManager });
  lifecycle.ownResource('personal manager', personalManager, 'close', 2000)
  ctx.personalManager = personalManager;

  // Keep the active personal store in sync with the active identity across all
  // platforms by wrapping the identity-manager mutators in one place (every
  // platform changes identities through these). Best-effort: a personal-store
  // failure must not break identity switching/creation.
  const refreshActivePersonalStore = async (publicKey) => {
    const pk = publicKey || identityManager.getActivePublicKey?.()
    if (!pk) return
    ctx.personal = null
    await personalManager.setActive(pk)
  }
  installOwnedContentPublicationIdentityHooks({
    ctx,
    identityManager,
    publicFeed,
    refreshActivePersonalStore,
    refreshSeedPinClientAuth: options =>
      ctx.seedPinRegistration?.refreshClientAuth?.(options),
    log: console,
  })

  const seedingManager = new SeedingManager(ctx.store, ctx.metaDb, {
    identityManager,
    getDiskUsageBytes: createStorageUsageMeasurer(storagePath),
    isCacheClearBlocked: isPlaybackActive,
    blindPeering: ctx.blindPeering,
    metaSubspaces: ctx.metaSubspaces
  });
  lifecycle.own('seeding manager', async () => {
    seedingManager.clearTimer?.(seedingManager._storageMaintenanceTimer)
    seedingManager._storageMaintenanceTimer = null
    await seedingManager.flushSeedPersist?.()
  }, 2000)

  // Feed discovery: when a relay-serving feed entry advertises its blind-peer
  // mirror key, adopt it as a mirror and re-mirror retained content to it.
  if (ctx.blindPeering?.enabled) {
    publicFeed.setOnRelayMirrorKey((mirrorKeyHex) => {
      try {
        if (ctx.blindPeering.addMirrorKeys(mirrorKeyHex) > 0) {
          console.log('[Orchestrator] Adopted blind-peer mirror from feed:', mirrorKeyHex.slice(0, 16))
          seedingManager.remirrorAllSeeds()
        }
      } catch (err) {
        console.warn('[Orchestrator] Mirror adoption failed:', err?.message)
      }
    })
  }

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

  const uploadManager = createUploadManager({ ctx });
  lifecycle.ownResource('upload manager', uploadManager)

  // Phase 3: Wire up callbacks
  if (onFeedUpdate) {
    publicFeed.setOnFeedUpdate(onFeedUpdate);
  }
  publicFeed.setOnFeedConnectionOpen(() => {
    startupGate.noteFeedChannelOpen()
  })
  publicFeed.setOnFeedSync(() => {
    startupGate.noteFeedSync()
  })

  if (onStatsUpdate) {
    videoStats.setOnStatsUpdate(onStatsUpdate);
  }

  // Phase 4: Wire up swarm connection handling
  ctx.swarm.on('peer', (peer, topic) => {
    try {
      const handled = publicFeed.handleDiscoveredPeer(peer, topic)
      if (handled) startupGate.noteSwarmPeer()
    } catch (err) {
      console.error('[Orchestrator] publicFeed.handleDiscoveredPeer failed:', err?.message)
    }
  })

  ctx.swarm.on('connection', (conn, info) => {
    console.log('[Orchestrator] Swarm connection received, passing to publicFeed.handleConnection');
    startupGate.noteSwarmPeer()
    try {
      publicFeed.handleConnection(conn, info);
    } catch (err) {
      console.error('[Orchestrator] publicFeed.handleConnection failed:', err?.message);
    }
  });

  ipcLog('[orchestrator] seedingManager.init starting')
  await appendDebugLine('[orchestrator] seedingManager.init starting')

  // Phase 5: Initialize seeding manager (fast - just loads config from db)
  await seedingManager.init();
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

  // Open the active identity's private multi-writer personal store (subscriptions,
  // playlists, watch history, settings) and expose it on ctx. Best-effort: a
  // failure here must not block backend startup.
  await personalManager.init().catch((err) => ipcLog('[orchestrator] personal store init failed: ' + (err?.message || err)))

  // Phase 6: Create unified API before feed start so the initial HAVE_FEED
  // exchange can already include local availability hints and serving manifests.
  const api = createApi({
    ctx,
    publicFeed,
    seedingManager,
    videoStats
  });

  if (typeof api.getAvailabilityHints === 'function') {
    publicFeed.setAvailabilityHintProvider((requests, conn) => api.getAvailabilityHints(requests, conn))
  }
  if (typeof api.getFeedSnapshotEntries === 'function') {
    publicFeed.setFeedSnapshotProvider((entries) => api.getFeedSnapshotEntries(entries, { limitPerChannel: 3 }))
  }
  if (typeof api.getChannelSignedDescriptor === 'function') {
    publicFeed.setSignedDescriptorProvider((driveKey) => api.getChannelSignedDescriptor(driveKey))
  }

  // Sender auth requires the stored descriptor proof, so backfill completes
  // before seed-pin registration and discovery.
  try {
    const descriptorSummary = await identityManager.ensureSignedChannelDescriptors?.()
    if (descriptorSummary) ipcLog('[orchestrator] descriptor backfill: ' + JSON.stringify(descriptorSummary))
  } catch (err) {
    ipcLog('[orchestrator] descriptor backfill failed: ' + (err?.message || err))
  }

  let seedPinStartup
  try {
    seedPinStartup = await startBackendSeedPinBeforeDiscovery({
      ctx,
      identityManager,
      publicFeed,
      seedPin,
    })
  } catch (error) {
    await shutdownBackend(ctx).catch(() => {})
    throw error
  }
  const seedPinRegistration = seedPinStartup.registration
  ctx.registerCleanup?.('seed-pin unregister', async () => {
    const registration = ctx.seedPinRegistration
    await registration?.unregister?.()
    if (ctx.seedPinRegistration === registration) ctx.seedPinRegistration = null
  }, { timeoutMs: 2000 })
  const publicFeedStartPromise = seedPinStartup.discovery


  // Registration is live before discovery. A discovery failure first tears down
  // seed-pin, then the remaining runtime, so no mux/listener/store resources leak.
  try {
    await publicFeedStartPromise
  } catch (error) {
    await shutdownBackend(ctx).catch(() => {})
    throw error
  }
  await appendDebugLine('[orchestrator] publicFeed.start done')
  ipcLog('[orchestrator] publicFeed.start done')

  // Return result - heavy channel warming happens in background
  const result = {
    ctx,
    api,
    publicFeed,
    seedingManager,
    videoStats,
    identityManager,
    personalManager,
    uploadManager,
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

  // Phase 8: Heavy initialization in background (non-blocking)
  // Drive warming and feed discovery can happen after UI is ready
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
        console.log('[Orchestrator] publicFeed startup gate timed out; continuing backend warmup offline')
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
      const publicationReconciliation = await reconcileOwnedContentPublications({
        ctx,
        identityManager,
        publicFeed,
        log: console,
      }).catch((err) => {
        console.warn('[Orchestrator] Owned-channel startup reconciliation failed:', err?.message || err)
        return null
      })
      if (publicationReconciliation) {
        ipcLog('[orchestrator] canonical reconciliation: ' + JSON.stringify(publicationReconciliation))
      }

      // Start public feed discovery
      // Warm subscribed / pinned / seeding channels (can be slow)
      if (signal.aborted || isContextShuttingDown(ctx)) return
      try {
        const subs = (await ctx.metaDb.get('subscriptions').catch(() => null))?.value || []
        if (signal.aborted) return
        const subscriptionKeys = subs.map((s) => s.driveKey).filter(Boolean)
        const pinnedKeys = seedingManager.getPinnedChannels?.() || []
        const seeds = seedingManager.getActiveSeeds?.() || []
        const seedKeys = seeds.map((s) => s.driveKey).filter(Boolean) || []

        // Restore old relay-like serving behavior for normal clients: persisted
        // watched/seeded entries retain their blob-core discovery immediately,
        // without waiting for full channel hydration.
        for (const seed of seeds) {
          if (signal.aborted) return
          if (seed?.blobsCoreKey && ctx.store) {
            try {
              const core = ctx.store.get(Buffer.from(seed.blobsCoreKey, 'hex'))
              ctx.ownResource?.(`seed blob core ${seed.blobsCoreKey.slice(0, 16)}`, core, 'close')
              await core?.ready?.()
              if (signal.aborted) return
              if (core?.discoveryKey) retainSwarmDiscovery(ctx, core.discoveryKey, { label: `seed:${seed.blobsCoreKey.slice(0, 16)}` })
            } catch {
              // Discovery retention is best-effort during startup warmup.
            }
          }
          if (seed?.publicBeeKey) {
            await retainPublicBeeContentDiscovery(ctx, seed.publicBeeKey, {
              label: `seed:${seed.driveKey?.slice?.(0, 16) || 'channel'}`
            })
            if (signal.aborted) return
          }
        }

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
