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
export { PublicFeed, PublicFeed as PublicFeedManager } from './public-feed.js';

// Modular facades for smaller backend surfaces
export { createBackendRuntime } from './runtime.js';
export * as feed from './feed.js';
// Bare-only media, transcode, and cast surfaces stay available through package
// subpath exports. Do not re-export them from the package root: root import must
// remain safe under Node test runners that do not define Bare.

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
  validateMnemonic
} from './identity.js';

// Video Upload
export { createUploadManager } from './upload.js';

// Multi-writer channels (HyperDB)
export { MultiWriterChannel, ChannelPairer } from './channel/index.js';

// Types and constants
export { NETWORK_TOPIC_STRING, PROTOCOL_NAME } from './types.js';

// Logger - structured logging with automatic secret redaction
export { logger, setLogLevel, LogLevel } from './logger.js';

// Orchestrator - one-shot initialization for all components
export { createBackendContext } from './orchestrator.js';

// Universal core - shared Bare-native entrypoint across all shells
export { createUniversalCore, createUniversalHrpcSurface } from './universal-core.js';
export * as universalCore from './universal-core.js';
