/**
 * RPC Client - Web (Pear Desktop)
 *
 * Unified platform RPC layer for Pear desktop apps.
 * Uses the existing PearWorkerClient set up by worker-client.js (unbundled script).
 *
 * NOTE: The actual HRPC/pear-run initialization happens in worker-client.js,
 * which is loaded as an unbundled ESM script in Pear. This module just
 * provides a clean interface to that existing infrastructure.
 */

import type { VideoStats } from './types';

// PearWorkerClient is set on window by worker-client.js (unbundled)
declare global {
  interface Window {
    PearWorkerClient?: {
      rpc: any;
      isConnected: boolean;
      blobServerPort: number | null;
      initialize(): Promise<void>;
      getRpc(): any;
    };
  }
}

// Module state
let _blobServerPort: number | null = null;
let _isInitialized = false;

// Event callback types
type ReadyCallback = (data: { blobServerPort: number }) => void;
type ErrorCallback = (data: { message: string }) => void;
type VideoStatsCallback = (data: { channelKey: string; videoId: string; stats: VideoStats }) => void;
type UploadProgressCallback = (data: { progress: number; videoId?: string }) => void;
type FeedUpdateCallback = (data: { channelKey: string; action: string }) => void;

// Event callback storage
const eventCallbacks = {
  ready: [] as ReadyCallback[],
  error: [] as ErrorCallback[],
  videoStats: [] as VideoStatsCallback[],
  uploadProgress: [] as UploadProgressCallback[],
  feedUpdate: [] as FeedUpdateCallback[],
};

// Helper to remove callback
function removeCallback<T>(arr: T[], cb: T) {
  const idx = arr.indexOf(cb);
  if (idx !== -1) arr.splice(idx, 1);
}

/**
 * Event subscription system
 */
export const events = {
  onReady: (cb: ReadyCallback) => {
    eventCallbacks.ready.push(cb);
    return () => removeCallback(eventCallbacks.ready, cb);
  },
  onError: (cb: ErrorCallback) => {
    eventCallbacks.error.push(cb);
    return () => removeCallback(eventCallbacks.error, cb);
  },
  onVideoStats: (cb: VideoStatsCallback) => {
    eventCallbacks.videoStats.push(cb);
    return () => removeCallback(eventCallbacks.videoStats, cb);
  },
  onUploadProgress: (cb: UploadProgressCallback) => {
    eventCallbacks.uploadProgress.push(cb);
    return () => removeCallback(eventCallbacks.uploadProgress, cb);
  },
  onFeedUpdate: (cb: FeedUpdateCallback) => {
    eventCallbacks.feedUpdate.push(cb);
    return () => removeCallback(eventCallbacks.feedUpdate, cb);
  },
};

// Event listeners for window events (dispatched by worker-client.js)
let eventListenersSetup = false;

function setupEventListeners() {
  if (eventListenersSetup || typeof window === 'undefined') return;
  eventListenersSetup = true;

  window.addEventListener('pearVideoStats', ((e: CustomEvent) => {
    eventCallbacks.videoStats.forEach(cb => cb(e.detail));
  }) as EventListener);

  window.addEventListener('pearUploadProgress', ((e: CustomEvent) => {
    eventCallbacks.uploadProgress.forEach(cb => cb(e.detail));
  }) as EventListener);

  window.addEventListener('pearFeedUpdate', ((e: CustomEvent) => {
    eventCallbacks.feedUpdate.forEach(cb => cb(e.detail));
  }) as EventListener);
}

/**
 * Initialize platform RPC for Pear desktop
 *
 * This initializes the PearWorkerClient which spawns the worker process.
 * The worker-client.js script must be loaded before calling this.
 */
export async function initPlatformRPC(): Promise<void> {
  if (_isInitialized) {
    console.log('[Platform RPC] Already initialized');
    return;
  }

  if (typeof window === 'undefined') {
    throw new Error('Platform RPC can only be initialized in browser context');
  }

  const workerClient = window.PearWorkerClient;
  if (!workerClient) {
    throw new Error('PearWorkerClient not available - ensure worker-client.js is loaded');
  }

  console.log('[Platform RPC] Initializing via PearWorkerClient...');

  // Set up DOM event listeners for worker events
  setupEventListeners();

  try {
    // Initialize the worker client (spawns worker, sets up HRPC)
    await workerClient.initialize();

    _blobServerPort = workerClient.blobServerPort;
    _isInitialized = true;

    console.log('[Platform RPC] Initialized, blobServerPort:', _blobServerPort);

    // Fire ready callbacks
    eventCallbacks.ready.forEach(cb => cb({ blobServerPort: _blobServerPort! }));
  } catch (err) {
    console.error('[Platform RPC] Failed to initialize:', err);
    throw err;
  }
}

/**
 * Terminate platform RPC
 */
export function terminatePlatformRPC(): void {
  const workerClient = window?.PearWorkerClient;
  if (workerClient && (workerClient as any).close) {
    console.log('[Platform RPC] Closing worker client');
    (workerClient as any).close();
  }
  _isInitialized = false;
  _blobServerPort = null;
}

/**
 * Check if RPC is initialized
 */
export function isInitialized(): boolean {
  return _isInitialized;
}

/**
 * Get blob server port
 */
export function getBlobServerPort(): number | null {
  return _blobServerPort;
}

/**
 * Get raw HRPC instance (for advanced use cases)
 */
export function getHRPCInstance(): any {
  return window?.PearWorkerClient?.getRpc?.() || window?.PearWorkerClient?.rpc;
}

// Helper to get RPC and ensure it's ready
function ensureRPC() {
  const rpc = getHRPCInstance();
  if (!rpc) throw new Error('Platform RPC not initialized');
  return rpc;
}

// Helper to normalize string or object params
function normalizeParam<T extends string>(
  arg: T | { [K in T]: string },
  key: T
): { [K in T]: string } {
  if (typeof arg === 'string') {
    return { [key]: arg } as { [K in T]: string };
  }
  return arg as { [K in T]: string };
}

/**
 * RPC Client - Typed methods for backend communication
 * Methods accept either individual args or object params for flexibility
 */
export const rpc = {
  // Identity
  async createIdentity(nameOrReq: string | { name: string }) {
    const req = typeof nameOrReq === 'string' ? { name: nameOrReq } : nameOrReq;
    return ensureRPC().createIdentity(req);
  },

  async getIdentity() {
    return ensureRPC().getIdentity({});
  },

  async getIdentities() {
    return ensureRPC().getIdentities({});
  },

  async setActiveIdentity(publicKeyOrReq: string | { publicKey: string }) {
    const req = typeof publicKeyOrReq === 'string' ? { publicKey: publicKeyOrReq } : publicKeyOrReq;
    return ensureRPC().setActiveIdentity(req);
  },

  async recoverIdentity(seedPhraseOrReq: string | { seedPhrase: string; name?: string }, name?: string) {
    const req = typeof seedPhraseOrReq === 'string'
      ? { seedPhrase: seedPhraseOrReq, name }
      : seedPhraseOrReq;
    return ensureRPC().recoverIdentity(req);
  },

  // Videos
  async listVideos(channelKeyOrReq: string | { channelKey: string }) {
    const req = typeof channelKeyOrReq === 'string' ? { channelKey: channelKeyOrReq } : channelKeyOrReq;
    return ensureRPC().listVideos(req);
  },

  async getVideoUrl(channelKeyOrReq: string | { channelKey: string; videoId: string }, videoId?: string) {
    const req = typeof channelKeyOrReq === 'string'
      ? { channelKey: channelKeyOrReq, videoId: videoId! }
      : channelKeyOrReq;
    return ensureRPC().getVideoUrl(req);
  },

  async prefetchVideo(channelKeyOrReq: string | { channelKey: string; videoId: string }, videoId?: string) {
    const req = typeof channelKeyOrReq === 'string'
      ? { channelKey: channelKeyOrReq, videoId: videoId! }
      : channelKeyOrReq;
    return ensureRPC().prefetchVideo(req);
  },

  async getVideoStats(channelKeyOrReq: string | { channelKey: string; videoId: string }, videoId?: string): Promise<{ stats: VideoStats }> {
    const req = typeof channelKeyOrReq === 'string'
      ? { channelKey: channelKeyOrReq, videoId: videoId! }
      : channelKeyOrReq;
    return ensureRPC().getVideoStats(req);
  },

  async uploadVideo(filePathOrReq: string | { filePath: string; title: string; description: string; category?: string }, title?: string, description?: string, category?: string) {
    const req = typeof filePathOrReq === 'string'
      ? { filePath: filePathOrReq, title: title!, description: description!, category }
      : filePathOrReq;
    return ensureRPC().uploadVideo(req);
  },

  async downloadVideo(channelKeyOrReq: string | { channelKey: string; videoId: string; destPath: string }, videoId?: string, destPath?: string): Promise<{ success: boolean; filePath?: string; size?: number; error?: string }> {
    const req = typeof channelKeyOrReq === 'string'
      ? { channelKey: channelKeyOrReq, videoId: videoId!, destPath: destPath! }
      : channelKeyOrReq;
    return ensureRPC().downloadVideo(req);
  },

  async deleteVideo(videoIdOrReq: string | { videoId: string }): Promise<{ success: boolean; error?: string }> {
    const req = typeof videoIdOrReq === 'string' ? { videoId: videoIdOrReq } : videoIdOrReq;
    return ensureRPC().deleteVideo(req);
  },

  async setVideoThumbnail(videoIdOrReq: string | { videoId: string; imageData: string; mimeType: string }, imageData?: string, mimeType?: string) {
    const req = typeof videoIdOrReq === 'string'
      ? { videoId: videoIdOrReq, imageData: imageData!, mimeType: mimeType! }
      : videoIdOrReq;
    return ensureRPC().setVideoThumbnail(req);
  },

  async setVideoThumbnailFromFile(videoIdOrReq: string | { videoId: string; filePath: string }, filePath?: string) {
    const req = typeof videoIdOrReq === 'string'
      ? { videoId: videoIdOrReq, filePath: filePath! }
      : videoIdOrReq;
    return ensureRPC().setVideoThumbnailFromFile(req);
  },

  async getVideoThumbnail(channelKeyOrReq: string | { channelKey: string; videoId: string }, videoId?: string) {
    const req = typeof channelKeyOrReq === 'string'
      ? { channelKey: channelKeyOrReq, videoId: videoId! }
      : channelKeyOrReq;
    return ensureRPC().getVideoThumbnail(req);
  },

  // Channels
  async getChannel(publicKeyOrReq: string | { publicKey: string }) {
    const req = typeof publicKeyOrReq === 'string' ? { publicKey: publicKeyOrReq } : publicKeyOrReq;
    return ensureRPC().getChannel(req);
  },

  async subscribeChannel(channelKeyOrReq: string | { channelKey: string }) {
    const req = typeof channelKeyOrReq === 'string' ? { channelKey: channelKeyOrReq } : channelKeyOrReq;
    return ensureRPC().subscribeChannel(req);
  },

  // Alias for subscribeChannel (used by some UI components)
  async joinChannel(channelKeyOrReq: string | { channelKey: string }) {
    const req = typeof channelKeyOrReq === 'string' ? { channelKey: channelKeyOrReq } : channelKeyOrReq;
    return ensureRPC().joinChannel(req);
  },

  async unsubscribeChannel(channelKeyOrReq: string | { channelKey: string }) {
    const req = typeof channelKeyOrReq === 'string' ? { channelKey: channelKeyOrReq } : channelKeyOrReq;
    return ensureRPC().unsubscribeChannel(req);
  },

  async getSubscriptions() {
    return ensureRPC().getSubscriptions({});
  },

  // Public Feed
  async getPublicFeed() {
    return ensureRPC().getPublicFeed({});
  },

  async refreshFeed() {
    return ensureRPC().refreshFeed({});
  },

  async submitToFeed() {
    return ensureRPC().submitToFeed({});
  },

  async hideChannel(channelKeyOrReq: string | { channelKey: string }) {
    const req = typeof channelKeyOrReq === 'string' ? { channelKey: channelKeyOrReq } : channelKeyOrReq;
    return ensureRPC().hideChannel(req);
  },

  async getChannelMeta(channelKeyOrReq: string | { channelKey: string }) {
    const req = typeof channelKeyOrReq === 'string' ? { channelKey: channelKeyOrReq } : channelKeyOrReq;
    return ensureRPC().getChannelMeta(req);
  },

  // Status
  async getStatus() {
    return ensureRPC().getStatus({});
  },

  async getSwarmStatus() {
    return ensureRPC().getSwarmStatus({});
  },

  async getBlobServerPort() {
    return ensureRPC().getBlobServerPort({});
  },

  // Desktop-specific: Native file picker
  async pickVideoFile() {
    return ensureRPC().pickVideoFile({});
  },

  async pickImageFile() {
    return ensureRPC().pickImageFile({});
  },
};

export type RPCClient = typeof rpc;
