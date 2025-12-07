/**
 * Backend Core - Shared P2P backend logic for PearTube
 *
 * This package contains shared code used by both mobile and desktop backends.
 */

// Storage module - Corestore, Hyperdrive, BlobServer
export {
  wrapStoreWithTimeout,
  initializeStorage,
  waitForDriveSync,
  loadDrive,
  createDrive,
  getVideoUrl
} from './storage.js';

// Public Feed - P2P channel discovery
export { PublicFeedManager } from './public-feed.js';

// Video Stats - P2P download progress tracking
export { VideoStatsTracker } from './video-stats.js';

// Seeding - Distributed content availability
export { SeedingManager } from './seeding.js';

// API - Shared backend methods
export { createApi } from './api.js';

// Identity Management
export {
  createIdentityManager,
  generateMnemonic,
  keypairFromMnemonic
} from './identity.js';

// Video Upload
export { createUploadManager } from './upload.js';

// Types and constants
export { FEED_TOPIC_STRING, PROTOCOL_NAME } from './types.js';

// Orchestrator - one-shot initialization for all components
export { createBackendContext } from './orchestrator.js';
