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
}

/**
 * Frontend video representation with UI concerns.
 *
 * NOTE: This type is used across mobile + desktop UI.
 * Keep it permissive enough to cover fields that may be present depending on
 * where the data originated (feed, search, player, RPC, etc).
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
// Public Feed Types (P2P Discovery)
// ============================================

/**
 * A single entry in the public feed - represents a discovered channel
 */
export interface PublicFeedEntry {
  driveKey: string;       // Channel key
  addedAt: number;        // Unix timestamp when discovered
  source: 'peer' | 'local'; // How we learned about it
  channelKey?: string;
  publicBeeKey?: string | null;
  channelName?: string | null;
  videoCount?: number;
  peerCount?: number;
  lastSeen?: number;
  manifestUpdatedAt?: number;
  previewVideos?: Array<{
    id: string;
    title?: string;
    creatorName?: string | null;
    uploadedAt?: number;
    duration?: number;
    thumbnail?: string | null;
    blobId?: string | null;
    blobsCoreKey?: string | null;
    mimeType?: string | null;
    availability?: 'playable' | 'unavailable' | 'unknown';
    thumbnailBlobId?: string | null;
    thumbnailBlobsCoreKey?: string | null;
    thumbnailMimeType?: string | null;
  }>;
}

/**
 * State of the public feed
 */
export interface PublicFeedState {
  status: 'idle' | 'requesting' | 'ready';
  entries: PublicFeedEntry[];
  lastRefresh: number | null;
}

/**
 * Channel metadata fetched lazily from the drive itself
 */
export interface ChannelMetadata {
  name?: string;
  description?: string;
  thumbnail?: string;
  videoCount?: number;
  driveKey?: string;
}

/**
 * Result from getPublicFeed RPC call
 */
export interface PublicFeedResult {
  entries: PublicFeedEntry[];
  stats: { totalEntries: number; hiddenCount: number; peerCount: number };
}

/**
 * Message types for public feed protocol over hyperswarm
 */
export type FeedMessage =
  | { type: 'NEED_FEED' }
  | { type: 'FEED_RESPONSE'; keys: string[] }
  | { type: 'SUBMIT_CHANNEL'; key: string };
