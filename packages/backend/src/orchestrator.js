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

import { initializeStorage, loadDrive } from './storage.js';
import { PublicFeedManager } from './public-feed.js';
import { VideoStatsTracker } from './video-stats.js';
import { SeedingManager } from './seeding.js';
import { createApi } from './api.js';
import { createIdentityManager } from './identity.js';
import { createUploadManager } from './upload.js';

/**
 * @typedef {Object} BackendConfig
 * @property {string} storagePath - Path to storage directory
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

async function warmDrives(ctx, driveKeys, label) {
  const unique = Array.from(new Set((driveKeys || []).filter(Boolean)));
  if (!unique.length) return;
  console.log(`[Orchestrator] Warming ${label}:`, unique.length);
  for (const key of unique) {
    try {
      await loadDrive(ctx, key, { waitForSync: false });
    } catch (e) {
      console.log('[Orchestrator] Warm failed for', key.slice(0, 16), e?.message);
    }
  }
}

async function prefetchDriveMetadata(ctx, driveKeys, videoLimit = 1) {
  const unique = Array.from(new Set((driveKeys || []).filter(Boolean)));
  if (!unique.length) return;
  for (const key of unique) {
    try {
      const drive = await loadDrive(ctx, key, { waitForSync: false, syncTimeout: 4000 });
      // Touch channel metadata to pull first blocks
      await drive.get('/channel.json').catch(() => null);

      if (videoLimit > 0) {
        let count = 0;
        try {
          for await (const entry of drive.readdir('/videos')) {
            if (!entry.endsWith('.json')) continue;
            await drive.get(`/videos/${entry}`).catch(() => null);
            count++;
            if (count >= videoLimit) break;
          }
        } catch {
          // /videos may not exist on some drives
        }
      }
    } catch (e) {
      console.log('[Orchestrator] Prefetch skipped for', key.slice(0, 16), e?.message);
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
 * 5. Loads existing identities and their channel drives (in background)
 *
 * @param {BackendConfig} config - Configuration options
 * @returns {Promise<BackendContext>} - All backend components
 */
export async function createBackendContext(config) {
  const { storagePath, onFeedUpdate, onStatsUpdate } = config;

  console.log('[Orchestrator] ===== INITIALIZING BACKEND =====');
  console.log('[Orchestrator] Storage path:', storagePath);

  // Phase 1: Initialize core storage (fast - just creates corestore, blob server, swarm)
  const ctx = await initializeStorage({ storagePath });
  console.log('[Orchestrator] Storage initialized, blob server port:', ctx.blobServerPort);

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
    publicFeed.handleConnection(conn, info);
  });

  // Phase 5: Initialize seeding manager (fast - just loads config from db)
  await seedingManager.init();

  // Phase 6: Load identities (fast - reads from disk, needed before eventReady)
  console.log('[Orchestrator] Loading identities...');
  await identityManager.loadIdentities();

  // Phase 7: Create unified API
  const api = createApi({
    ctx,
    publicFeed,
    seedingManager,
    videoStats
  });

  // Return result - heavy drive warming happens in background
  const result = {
    ctx,
    api,
    publicFeed,
    seedingManager,
    videoStats,
    identityManager,
    uploadManager
  };

  console.log('[Orchestrator] ===== BACKEND READY =====');
  console.log('[Orchestrator] Identities loaded:', identityManager.getIdentities().length);

  // Phase 8: Heavy initialization in background (non-blocking)
  // Drive warming and feed discovery can happen after UI is ready
  const defer =
    typeof setImmediate === 'function'
      ? setImmediate
      : (fn) => setTimeout(fn, 0)

  defer(async () => {
    try {
      // Load channels/drives and run legacy migration in the background.
      // This can be slow (sync + readdir + metadata replay) and should NOT block worker init.
      try {
        await identityManager.loadChannelDrives();
        await identityManager.migrateLegacyIdentities?.();
      } catch (e) {
        console.error('[Orchestrator] Identity background init error:', e?.message);
      }

      // Start public feed discovery
      await publicFeed.start();
      try {
        publicFeed.requestFeedsFromPeers();
      } catch (e) {
        console.log('[Orchestrator] Initial feed request failed:', e?.message);
      }

      // Warm subscribed / pinned / seeding drives (can be slow)
      try {
        const subs = (await ctx.metaDb.get('subscriptions').catch(() => null))?.value || [];
        const subscriptionKeys = subs.map((s) => s.driveKey).filter(Boolean);
        const pinnedKeys = seedingManager.getPinnedChannels?.() || [];
        const seedKeys = seedingManager.getActiveSeeds?.().map((s) => s.driveKey).filter(Boolean) || [];
        await warmDrives(ctx, [...subscriptionKeys, ...pinnedKeys, ...seedKeys], 'subscriptions/pins/seeds');
        // Skip prefetch - it was causing errors and slowing things down
      } catch (e) {
        console.log('[Orchestrator] Warm-up skipped:', e?.message);
      }

      console.log('[Orchestrator] ===== BACKGROUND INIT COMPLETE =====');
      console.log('[Orchestrator] Drives cached:', ctx.drives.size);
      console.log('[Orchestrator] Swarm connections:', ctx.swarm.connections.size);
    } catch (e) {
      console.error('[Orchestrator] Background init error:', e?.message);
    }
  });

  return result;
}
