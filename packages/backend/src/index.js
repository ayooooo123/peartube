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

export {
  CONTENT_REPLICATION_CHECKPOINT_VERSION,
  createContentReplication
} from './content-replication.js';

// Modular facades for smaller backend surfaces
// Bare-only media, transcode, and cast surfaces stay available through package
// subpath exports. Do not re-export them from the package root: root import must
// remain safe under Node test runners that do not define Bare.

// Video Stats - P2P download progress tracking
export { VideoStatsTracker } from './video-stats.js';

// Seeding - Distributed content availability
export { SeedingManager } from './seeding.js';

// API - Shared backend methods
export { assessDurableManifest, createApi } from './api.js';
export {
  createDurableOperabilityServices,
  createOperabilityApi,
  createPortableStateRepositoryAdapter,
  getOrCreateDurableOperabilityServices
} from './api/operability.js';
export {
  canonicalDurabilityRefKey,
  canonicalizeDurabilityRefs,
  evaluateDurabilityPolicy,
  intersectFullCopyHolders
} from './durability/aggregate-assessment.js';
export {
  buildCatalogGroupPage,
  buildChannelCatalog,
  buildGroupSummaries,
  classifyCatalogItem,
  compareCatalogItems,
  decodeCatalogCursor,
  encodeCatalogCursor,
  normalizeCatalogProfile
} from './catalog/channel-catalog.js';

// Identity Management
export {
  createIdentityManager,
  generateMnemonic,
  validateMnemonic
} from './identity.js';
export {
  migrateLegacyPublisherRootsInMetaDb,
  runLegacyPublisherRootPreflight
} from './legacy-publisher-root-preflight.js';

// Video Upload
export { createUploadManager } from './upload.js';

// Multi-writer channels (HyperDB)
export { MultiWriterChannel, ChannelPairer } from './channel/index.js';

// Types and constants
export { PROTOCOL_NAME } from './types.js';

// Logger - structured logging with automatic secret redaction
export { logger, setLogLevel, LogLevel } from './logger.js';

// Orchestrator - one-shot initialization for all components
export { createBackendContext } from './orchestrator.js';

// Universal core - shared Bare-native entrypoint across all shells
export { createUniversalCore } from './universal-core.js';
export * as universalCore from './universal-core.js';
export * as peerScorer from './peer-scorer.js';
export * as budgetManager from './budget-manager.js';
export * as network from './network/index.js';
export * as discovery from './discovery/index.js';
export * as playback from './playback/index.js';
export * as archive from './archive/index.js';
export * as indexing from './indexing/index.js';
export * as moderation from './moderation/index.js';
export * as records from './records/index.js';
export * as publisher from './publisher/index.js';
export * as mediaGraph from './media-graph/index.js';
export * as assets from './assets/index.js';
