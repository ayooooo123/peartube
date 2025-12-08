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
        for await (const entry of drive.readdir('/videos').catch(() => [])) {
          if (!entry.endsWith('.json')) continue;
          await drive.get(`/videos/${entry}`).catch(() => null);
          count++;
          if (count >= videoLimit) break;
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
 * 5. Loads existing identities and their channel drives
 *
 * @param {BackendConfig} config - Configuration options
 * @returns {Promise<BackendContext>} - All backend components
 */
export async function createBackendContext(config) {
  const { storagePath, onFeedUpdate, onStatsUpdate } = config;

  console.log('[Orchestrator] ===== INITIALIZING BACKEND =====');
  console.log('[Orchestrator] Storage path:', storagePath);

  // Phase 1: Initialize core storage
  const ctx = await initializeStorage({ storagePath });
  console.log('[Orchestrator] Storage initialized, blob server port:', ctx.blobServerPort);

  // Phase 2: Create managers
  const publicFeed = new PublicFeedManager(ctx.swarm);
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
  // Note: initializeStorage already sets up store.replicate(conn)
  // We add the public feed protocol handler here
  ctx.swarm.on('connection', (conn, info) => {
    // Handle public feed protocol on this connection
    publicFeed.handleConnection(conn, info);
  });

  // Phase 5: Initialize managers
  console.log('[Orchestrator] Initializing seeding manager...');
  await seedingManager.init();

  console.log('[Orchestrator] Loading identities...');
  await identityManager.loadIdentities();
  await identityManager.loadChannelDrives();

  // Warm subscribed / pinned / seeding drives so they rejoin swarm on restart
  try {
    const subs = (await ctx.metaDb.get('subscriptions').catch(() => null))?.value || [];
    const subscriptionKeys = subs.map((s) => s.driveKey).filter(Boolean);
    const pinnedKeys = seedingManager.getPinnedChannels?.() || [];
    const seedKeys = seedingManager.getActiveSeeds?.().map((s) => s.driveKey).filter(Boolean) || [];
    await warmDrives(ctx, [...subscriptionKeys, ...pinnedKeys, ...seedKeys], 'subscriptions/pins/seeds');
    // Light prefetch: channel.json + first video meta to accelerate UI
    await prefetchDriveMetadata(ctx, [...subscriptionKeys, ...pinnedKeys, ...seedKeys], 1);
  } catch (e) {
    console.log('[Orchestrator] Warm-up skipped:', e?.message);
  }

  // Phase 6: Create unified API
  const api = createApi({
    ctx,
    publicFeed,
    seedingManager,
    videoStats
  });

  // Phase 7: Start public feed discovery
  console.log('[Orchestrator] Starting public feed...');
  await publicFeed.start();
  // Immediately request feeds to populate after join
  try {
    publicFeed.requestFeedsFromPeers();
  } catch (e) {
    console.log('[Orchestrator] Initial feed request failed:', e?.message);
  }

  console.log('[Orchestrator] ===== BACKEND READY =====');
  console.log('[Orchestrator] Identities loaded:', identityManager.getIdentities().length);
  console.log('[Orchestrator] Drives cached:', ctx.drives.size);
  console.log('[Orchestrator] Swarm connections:', ctx.swarm.connections.size);

  return {
    ctx,
    api,
    publicFeed,
    seedingManager,
    videoStats,
    identityManager,
    uploadManager
  };
}
