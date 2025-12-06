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
}

/**
 * Frontend video representation with UI concerns
 * Extends Video with channel info for display
 */
export interface VideoData extends Omit<Video, 'mimeType'> {
  channel?: { name: string };
  thumbnailUrl?: string | null;
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
  driveKey: string;       // Hyperdrive key (channel ID)
  addedAt: number;        // Unix timestamp when discovered
  source: 'peer' | 'local'; // How we learned about it
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
