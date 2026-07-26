// Core domain types shared between desktop and mobile

// ============================================
// Identity Types
// ============================================

export interface Identity {
  publicKey: string;
  driveKey?: string;
  name?: string;
  createdAt: number;
  secretKey?: string;
  isActive?: boolean;
  /**
   * BIP39 recovery phrase. Only present on the createIdentity response —
   * the backend never persists it, so the UI must show it immediately
   * (one-time) for the user to back up.
   */
  seedPhrase?: string;
}

export interface CreateIdentityResult {
  success: boolean;
  publicKey: string;
  driveKey: string;
  mnemonic?: string;
}

// ============================================
// Video Types
// ============================================

export interface Video {
  id: string;
  title: string;
  description: string;
  path: string;
  size: number;
  uploadedAt: number;
  channelKey: string;
  mimeType?: string;
  duration?: number;
  thumbnail?: string;
  category?: string;
  creatorName?: string | null;
  publicationId?: string;
  immutablePublication?: {
    publicationId: string;
    manifestId?: string;
    renditionId?: string;
    publisherId?: string;
  };
}

/**
 * Frontend video representation with UI concerns.
 *
 * NOTE: This type is used across mobile + desktop UI.
 * Keep it permissive enough to cover fields that may be present depending on
 * where the data originated (media catalog, search, player, RPC, etc).
 */
export interface VideoData extends Video {
  channel?: {
    name: string;
    key?: string;
    avatarUrl?: string;
  };
  thumbnailUrl?: string | null;

  // Optional fields that can be attached by various backends/paths.
  // Used for casting URL resolution, comments/reactions discovery, etc.
  driveKey?: string;
  publicBeeKey?: string | null;
  blobId?: string | null;
  blobsCoreKey?: string | null;
  byteAvailability?: string | null;
  hasHeadBlock?: boolean;
  contiguousBlocks?: number;
  readyForPlayback?: boolean;
}

export interface UploadVideoResult {
  success: boolean;
  videoId: string;
  metadata: Video;
}

export interface UploadVideoEpisodeMetadata {
  contentKind: 'episode';
  seriesId: string;
  seriesTitle: string;
  mediaProvider: 'tmdb';
  mediaId: string;
  seasonNumber: number;
  episodeNumber: number;
  expectedEpisodeCount: number;
}

export interface UploadVideoRequest {
  filePath: string;
  title: string;
  description?: string;
  category?: string;
  skipThumbnailGeneration?: boolean;
  contentKind?: 'episode' | 'movie';
  seriesId?: string;
  seriesTitle?: string;
  mediaProvider?: 'tmdb';
  mediaId?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  expectedEpisodeCount?: number;
}

// ============================================
// Channel Types
// ============================================

export interface Channel {
  driveKey: string;
  name: string;
  description?: string;
  publicKey?: string;
  avatar?: string;
  createdAt?: number;
}

export interface Subscription {
  driveKey: string;
  name: string;
  subscribedAt?: number;
}

// ============================================
// Backend State & Status
// ============================================

export interface BackendStatus {
  connected: boolean;
  peers: number;
  storage: string;
  blobServerPort: number;
  version: string;
}

export interface BackendState {
  ready: boolean;
  identity: Identity | null;
  channels: Channel[];
  subscriptions: Subscription[];
  videos: Video[];
}

// ============================================
// P2P Video Stats
// ============================================

export interface VideoStats {
  status: 'connecting' | 'resolving' | 'downloading' | 'complete' | 'error' | 'unknown';
  progress: number;
  totalBlocks: number;
  downloadedBlocks: number;
  totalBytes: number;
  downloadedBytes: number;
  initialBlocks?: number;
  sessionDownloadedBlocks?: number;
  sessionDownloadedBytes?: number;
  peerCount: number;
  blobCoreKey?: string | null;
  blobPeerIds?: string[];
  blobPeerIdsJson?: string;
  blobPeers?: Array<{ key?: string | null; remoteAddress?: string | null; type?: string | null }>;
  blobPeersJson?: string;
  speedMBps: string;
  uploadSpeedMBps?: string;
  elapsed: number;
  isComplete: boolean;
  error?: string;
}

// ============================================
// RPC Types
// ============================================

export interface RPCMessage<T = unknown> {
  id: number;
  method: string;
  params?: T;
}

export interface RPCResponse<T = unknown> {
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
  };
}

// ============================================
// Media Catalog Types
// ============================================

export interface MediaRenditionDescriptor {
  renditionId: string;
  purpose: string;
  format: string;
  coreKey: string;
  coreLength: number;
  treeHash: string;
  byteLength: number;
  segmentIndexId?: string | null;
}

/**
 * Local, point-in-time reachability assessment for one immutable rendition.
 * Never a durability or availability guarantee: it expires at `expiresAt`.
 */
export type MediaAvailabilityState =
  | 'awaiting-replication'
  | 'limited'
  | 'healthy'
  | 'unavailable';

export interface MediaAvailability {
  state: MediaAvailabilityState;
  renditionId?: string | null;
  observedAt?: number | null;
  expiresAt?: number | null;
  requiredRangeCount?: number | null;
  reachableRangeCount?: number | null;
  independentPeerCount?: number | null;
  completePeerCount?: number | null;
  offlinePlayable?: boolean | null;
  archivePledged?: boolean | null;
  reasonCodes?: string[] | null;
}

export interface MediaPublicationSource {
  publicationId: string;
  publisherId: string;
  manifestId?: string | null;
  renditionId?: string | null;
  score?: number | null;
  availabilityScore?: number | null;
  formatSupport?: number | null;
  moderationPenalty?: number | null;
  preferred?: boolean | null;
  selected?: boolean | null;
  selectionReasonCodes?: string[] | null;
  rejectionReasonCodes?: string[] | null;
  introductionPublisherIds?: string[] | null;
  introductionIndexIds?: string[] | null;
  moderationFeedIds?: string[] | null;
  claimConflictIds?: string[] | null;
  provenanceClaimIds?: string[] | null;
  scoreMetadataConfidence?: number | null;
  scorePublisherTrust?: number | null;
  scoreAvailability?: number | null;
  scoreFormatSupport?: number | null;
  scoreModerationPenalty?: number | null;
  archiveState?: string | null;
  cacheState?: string | null;
  availabilityState?: 'available' | 'unavailable' | 'unknown' | 'stale' | null;
  stale?: boolean | null;
  incomplete?: boolean | null;
  availability?: MediaAvailability | null;
}

export interface MediaEntitySummary {
  entityId: string;
  entityKind: string;
  localClusterId?: string | null;
  title?: string | null;
  subtitle?: string | null;
  claimCount?: number | null;
  conflictCount?: number | null;
  availability?: MediaAvailability | null;
  sources: MediaPublicationSource[];
  renditions: MediaRenditionDescriptor[];
}

export interface MediaPageRequest {
  cursor?: string;
  limit?: number;
}

export interface MediaCatalogResult {
  success: boolean;
  errorCode?: string | null;
  error?: string | null;
  items: MediaEntitySummary[];
  nextCursor?: string | null;
}

export interface MediaGraphUpdate {
  revision: string;
  changedCount: number;
}

export interface MediaCatalogState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  items: MediaEntitySummary[];
  nextCursor?: string;
  errorCode?: string;
  error?: string;
  revision?: string;
  refreshing: boolean;
  loadingMore: boolean;
}

/**
 * Channel metadata fetched lazily from an explicitly selected channel.
 */
export interface ChannelMetadata {
  name?: string;
  description?: string;
  thumbnail?: string;
  videoCount?: number;
  driveKey?: string;
}
