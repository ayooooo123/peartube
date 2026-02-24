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

import { initializeStorage, loadChannel } from './storage.js';
import { PublicFeedManager } from './public-feed.js';
import { VideoStatsTracker } from './video-stats.js';
import { SeedingManager } from './seeding.js';
import { createApi } from './api.js';
import { createIdentityManager } from './identity.js';
import { createUploadManager } from './upload.js';
import { readIdentityKeyFile, writeIdentityKeyFile } from './identity-key-file.js';
import { derivePrimaryKey } from './peartube-identity.js';
import { initFileLogger } from './logger.js';
import { getVideoToolboxDecodeSettings, setVideoToolboxDecodeEnabled, setVideoToolboxHwMapEnabled } from './transcode/hls-transcoder.mjs';

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
    ipcLog: _ipcLog
  } = config;

  const ipcLog = typeof _ipcLog === 'function' ? _ipcLog : () => {}

  const defer =
    typeof setImmediate === 'function'
      ? setImmediate
      : (fn) => setTimeout(fn, 0)

  console.log('[Orchestrator] ===== INITIALIZING BACKEND =====');
  console.log('[Orchestrator] Storage path:', storagePath);
  ipcLog('[orchestrator] reading identity key file')

  let primaryKey = null;
  const identityKeyData = await readIdentityKeyFile(storagePath);
  if (identityKeyData) {
    primaryKey = identityKeyData.primaryKey;
    console.log('[Orchestrator] Identity key file found, using deterministic primaryKey');
  } else {
    console.log('[Orchestrator] No identity key file, Corestore will use random primaryKey');
  }

  const isCorestoreSeedMismatch = (err) => {
    const message = err instanceof Error ? err.message : String(err || '')
    return message.includes('Another corestore is stored here')
  }

  const isCorestoreLockError = (err) => {
    const message = (err instanceof Error ? err.message : String(err || '')).toLowerCase()
    return message.includes('file descriptor could not be locked') ||
      (message.includes('corestore') && message.includes('locked'))
  }

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const initializeStorageWithRetry = async (opts) => {
    const maxAttempts = 20
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await initializeStorage(opts)
      } catch (err) {
        if (!isCorestoreLockError(err) || attempt === maxAttempts) {
          if (isCorestoreLockError(err)) {
            console.warn('[Orchestrator] All retries exhausted. Attempting stale lock recovery...')
            try {
              const _fs = (await import('bare-fs')).default
              const _path = (await import('bare-path')).default
              const lockFile = _path.join(opts.storagePath, 'LOCK')
              const corestoreFile = _path.join(opts.storagePath, 'CORESTORE')
              try { _fs.unlinkSync(lockFile) } catch {}
              try { _fs.unlinkSync(corestoreFile) } catch {}
              const result = await initializeStorage(opts)
              console.log('[Orchestrator] Stale lock recovery succeeded')
              return result
            } catch {
              throw err
            }
          }
          throw err
        }
        const backoffMs = Math.min(350 * attempt, 5000)
        console.warn(`[Orchestrator] Corestore lock detected during init. Retrying in ${backoffMs}ms (attempt ${attempt}/${maxAttempts})`)
        await delay(backoffMs)
      }
    }
  }

  let ctx
  ipcLog('[orchestrator] initializeStorage starting')
  try {
    ctx = await initializeStorageWithRetry({
      storagePath,
      blobServerHost,
      blobServerBindHost,
      primaryKey,
      corestoreWaitForLock
    });
  } catch (err) {
    if (!primaryKey || !isCorestoreSeedMismatch(err)) throw err

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
      }
    } catch (persistErr) {
      console.warn('[Orchestrator] Failed to persist reconciled identity key file:', persistErr?.message)
    }
  }

  ipcLog('[orchestrator] storage initialized, port: ' + ctx.blobServerPort)

  try {
    const _fs = (await import('bare-fs')).default
    const _path = (await import('bare-path')).default
    const logsDir = _path.join(storagePath, 'logs')
    _fs.mkdirSync(logsDir, { recursive: true })
    await initFileLogger(_path.join(logsDir, 'peartube.log'))
    console.log('[Orchestrator] File logger initialized at:', _path.join(logsDir, 'peartube.log'))
  } catch (err) {
    console.log('[Orchestrator] File logger setup skipped:', err?.message)
  }
  ipcLog('[orchestrator] managers creating')

  // Phase 2: Create managers (synchronous, fast)
  const publicFeed = new PublicFeedManager(ctx.swarm, ctx.metaDb);
  const videoStats = new VideoStatsTracker();
  const seedingManager = new SeedingManager(ctx.store, ctx.metaDb);
  const identityManager = createIdentityManager({ ctx });
  const uploadManager = createUploadManager({ ctx });

  // Phase 3: Wire up callbacks
  if (onFeedUpdate) {
    publicFeed.setOnFeedUpdate(onFeedUpdate);
  }

  if (onStatsUpdate) {
    videoStats.setOnStatsUpdate(onStatsUpdate);
  }

  // Phase 4: Wire up swarm connection handling
  ctx.swarm.on('connection', (conn, info) => {
    console.log('[Orchestrator] Swarm connection received, passing to publicFeed.handleConnection');
    publicFeed.handleConnection(conn, info);
  });
  ipcLog('[orchestrator] seedingManager.init starting')

  // Phase 5: Initialize seeding manager (fast - just loads config from db)
  await seedingManager.init();
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
  await identityManager.loadIdentities();
  ipcLog('[orchestrator] loadIdentities done')

  // Phase 6.5: Start public feed discovery immediately so UIs can get updates without waiting
  ipcLog('[orchestrator] publicFeed.start starting')
  try {
    await publicFeed.start();
    try {
      publicFeed.requestFeedsFromPeers();
    } catch (e) {
      console.log('[Orchestrator] Initial feed request failed:', e?.message);
    }
  } catch (e) {
    console.error('[Orchestrator] Public feed start failed:', e?.message);
  }
  ipcLog('[orchestrator] publicFeed.start done')

  // Phase 7: Create unified API
  const api = createApi({
    ctx,
    publicFeed,
    seedingManager,
    videoStats
  });

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
        const seedKeys = seedingManager.getActiveSeeds?.().map((s) => s.driveKey).filter(Boolean) || []
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
