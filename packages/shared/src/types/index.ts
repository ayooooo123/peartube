// Core domain types shared between desktop and mobile

export interface Identity {
  publicKey: string;
  driveKey?: string;
  name?: string;
  createdAt: number;
  secretKey?: string;
}

export interface Video {
  id: string;
  title: string;
  description: string;
  path: string;
  size: number;
  uploadedAt: number;
  channelKey: string;
  duration?: number;
  thumbnail?: string;
}

export interface Channel {
  driveKey: string;
  name: string;
  description?: string;
  publicKey?: string;
  avatar?: string;
}

export interface Subscription {
  driveKey: string;
  name: string;
  subscribedAt?: number;
}

export interface BackendState {
  ready: boolean;
  identity: Identity | null;
  channels: Channel[];
  subscriptions: Subscription[];
  videos: Video[];
}

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
}

/**
 * Message types for public feed protocol over hyperswarm
 */
export type FeedMessage =
  | { type: 'NEED_FEED' }
  | { type: 'FEED_RESPONSE'; keys: string[] }
  | { type: 'SUBMIT_CHANNEL'; key: string };
