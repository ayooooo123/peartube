/**
 * Backend Core - Shared P2P backend logic for PearTube
 *
 * This package contains shared code used by both mobile and desktop backends.
 */

// Storage module - Corestore, BlobServer
export {
  initializeStorage,
  loadChannel,
  createChannel,
  pairDevice
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
  keypairFromMnemonic,
  validateMnemonic
} from './identity.js';

// Video Upload
export { createUploadManager } from './upload.js';

// Transcoding (bare-ffmpeg)
export * as transcode from './transcode/index.js';

// Multi-writer channels (Autobase)
export { MultiWriterChannel, ChannelPairer } from './channel/index.js';

// Types and constants
export { NETWORK_TOPIC_STRING, PROTOCOL_NAME } from './types.js';

// Logger - structured logging with automatic secret redaction
export { logger, setLogLevel, LogLevel } from './logger.js';

// Orchestrator - one-shot initialization for all components
export { createBackendContext } from './orchestrator.js';

export * as cast from './cast/index.js';
