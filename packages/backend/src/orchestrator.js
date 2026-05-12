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

import { initializeStorage, loadChannel, retainPublicBeeContentDiscovery, retainSwarmDiscovery } from './storage.js';
import { PublicFeedManager } from './public-feed.js';
import { VideoStatsTracker } from './video-stats.js';
import { SeedingManager } from './seeding.js';
import { createApi } from './api.js';
import { createIdentityManager } from './identity.js';
import { createUploadManager } from './upload.js';
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
} from './runtime-modules.js'
import {
  isCorestoreLockError,
  shouldRetryCorestoreSeedFallback
} from './corestore-error-utils.js'
import { createStartupGate } from './startup-gates.js'

const STARTUP_GATE_WARMUP_WAIT_MS = 2000

function resolveDebugLogPath() {
  return globalThis?.process?.env?.PEARTUBE_NATIVE_WORKLET_DEBUG_LOG || null
}

async function appendDebugLine(line) {
  const filePath = resolveDebugLogPath()
  if (!filePath) return

  try {
    const fsModule = await import('bare-fs')
    const fs = fsModule?.default ?? fsModule
    if (typeof fs?.appendFileSync !== 'function') return
    fs.appendFileSync(filePath, `${new Date().toISOString()} ${line}\n`)
  } catch (err) {
    void err
  }
}

// Shutdown flag to prevent deferred init from running during cleanup
let isShuttingDown = false;

/**
 * Set the shutdown flag to prevent deferred background init from running
 * @param {boolean} value - Whether the backend is shutting down
 */
export function setIsShuttingDown(value) {
  isShuttingDown = value;
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
 * @property {PublicFeedManager} publicFeed - Public feed manager
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
    try {
      await loadChannel(ctx, key);
    } catch (e) {
      console.log('[Orchestrator] Warm failed for', key.slice(0, 16), e?.message);
    }
  }
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
    blobServerHost,
    blobServerBindHost,
    onFeedUpdate,
    onStatsUpdate,
    corestoreWaitForLock = false,
    disableStandalonePrimaryKeyFile = false,
    ipcLog: _ipcLog
  } = config;

  const ipcLog = typeof _ipcLog === 'function' ? _ipcLog : () => {}

  const defer =
    typeof setImmediate === 'function'
      ? setImmediate
      : (fn) => setTimeout(fn, 0)

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
    ctx = await initializeStorageWithRetry({
      storagePath,
      blobServerHost,
      blobServerBindHost,
      primaryKey,
      corestoreWaitForLock
    });
    await appendDebugLine('[orchestrator] initializeStorage done')
  } catch (err) {
    await appendDebugLine(`[orchestrator] initializeStorage error ${err?.message || String(err)}`)
    if (!primaryKey || !shouldRetryCorestoreSeedFallback(err, { hasIdentityKeyFile: Boolean(identityKeyData) })) {
      throw err
    }

    console.warn('[Orchestrator] Identity key file primaryKey mismatches existing Corestore seed. Falling back to stored Corestore seed.')
    
    // Close the first store before retrying to avoid self-deadlock
    try {
      if (ctx?.store) {
        await ctx.store.close()
      }
    } catch (closeErr) {
      console.warn('[Orchestrator] Error closing store before seed mismatch retry:', closeErr?.message)
    }
    
    ctx = await initializeStorageWithRetry({
      storagePath,
      blobServerHost,
      blobServerBindHost,
      primaryKey: null,
      corestoreWaitForLock
    })

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

  // Phase 2: Create managers (synchronous, fast)
  const publicFeed = new PublicFeedManager(ctx.swarm, ctx.metaDb);
  ctx.publicFeed = publicFeed
  const startupGate = createStartupGate()
  const videoStats = new VideoStatsTracker();
  const seedingManager = new SeedingManager(ctx.store, ctx.metaDb);
  const identityManager = createIdentityManager({ ctx });
  const uploadManager = createUploadManager({ ctx });

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
  ctx.swarm.on('connection', (conn, info) => {
    console.log('[Orchestrator] Swarm connection received, passing to publicFeed.handleConnection');
    startupGate.noteSwarmPeer()
    try {
      publicFeed.handleConnection(conn, info);
    } catch (err) {
      console.error('[Orchestrator] publicFeed.handleConnection failed:', err?.message);
    }
  });
  ctx.swarm.on('peer', (peer, topic) => {
    try {
      if (publicFeed.handleDiscoveredPeer(peer, topic)) {
        startupGate.noteSwarmPeer()
      }
    } catch (err) {
      console.error('[Orchestrator] publicFeed.handleDiscoveredPeer failed:', err?.message)
    }
  })
  // Start public feed discovery before slower local managers/API wiring so DHT
  // lookup, socket setup, and Protomux feed opening overlap backend warm-up.
  ipcLog('[orchestrator] publicFeed.start starting early')
  await appendDebugLine('[orchestrator] publicFeed.start starting early')
  const publicFeedStartPromise = publicFeed.start().catch((e) => {
    console.error('[Orchestrator] Public feed start failed:', e?.message);
  })

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

  // The early start may still be restoring cached feed entries. Await it before
  // exposing backend-ready so initial feed/status snapshots are consistent.
  await publicFeedStartPromise
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
    uploadManager,
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
  defer(async () => {
    // Early return if shutdown was initiated during deferred init setup
    if (isShuttingDown) {
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
    
    try {
      // Load channels in the background.
      // This can be slow (sync + metadata replay) and should NOT block worker init.
      if (isShuttingDown) return
      try {
        await identityManager.loadChannelDrives()
      } catch (e) {
        console.error('[Orchestrator] Identity background init error:', e?.message)
      }

      // Start public feed discovery
      // Warm subscribed / pinned / seeding channels (can be slow)
      if (isShuttingDown) return
      try {
        const subs = (await ctx.metaDb.get('subscriptions').catch(() => null))?.value || []
        const subscriptionKeys = subs.map((s) => s.driveKey).filter(Boolean)
        const pinnedKeys = seedingManager.getPinnedChannels?.() || []
        const seeds = seedingManager.getActiveSeeds?.() || []
        const seedKeys = seeds.map((s) => s.driveKey).filter(Boolean) || []

        // Restore old relay-like serving behavior for normal clients: persisted
        // watched/seeded entries retain their blob-core discovery immediately,
        // without waiting for full channel hydration.
        for (const seed of seeds) {
          if (seed?.blobsCoreKey && ctx.store) {
            try {
              const core = ctx.store.get(Buffer.from(seed.blobsCoreKey, 'hex'))
              await core?.ready?.()
              if (core?.discoveryKey) retainSwarmDiscovery(ctx, core.discoveryKey, { label: `seed:${seed.blobsCoreKey.slice(0, 16)}` })
            } catch {
              // Discovery retention is best-effort during startup warmup.
            }
          }
          if (seed?.publicBeeKey) {
            retainPublicBeeContentDiscovery(ctx, seed.publicBeeKey, { label: `seed:${seed.driveKey?.slice?.(0, 16) || 'channel'}` }).catch(() => {})
          }
        }

        await warmChannels(ctx, [...subscriptionKeys, ...pinnedKeys, ...seedKeys], 'subscriptions/pins/seeds')
        // Skip prefetch - it was causing errors and slowing things down
      } catch (e) {
        console.log('[Orchestrator] Warm-up skipped:', e?.message)
      }

      if (isShuttingDown) return
      console.log('[Orchestrator] ===== BACKGROUND INIT COMPLETE =====')
      console.log('[Orchestrator] Channels cached:', ctx.channels?.size || 0)
      console.log('[Orchestrator] Swarm connections:', ctx.swarm.connections.size)
    } catch (e) {
      console.error('[Orchestrator] Background init error:', e?.message)
    }
  })

  return result;
}
