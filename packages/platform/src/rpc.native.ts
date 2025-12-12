/**
 * RPC Client - Native (React Native / Mobile)
 *
 * Unified platform RPC layer for mobile apps.
 * Handles BareKit Worklet initialization, HRPC setup, and event subscriptions.
 */

import type { VideoStats } from './types';

// Types for external dependencies (provided at runtime)
declare const Worklet: new () => {
  start(name: string, source: string, args?: string[]): void;
  terminate(): void;
  IPC: any;
};

// HRPC class from @peartube/spec
declare const HRPC: new (stream: any) => {
  createIdentity(req: { name: string }): Promise<any>;
  getIdentity(req: {}): Promise<any>;
  getIdentities(req: {}): Promise<any>;
  setActiveIdentity(req: { publicKey: string }): Promise<any>;
  listVideos(req: { channelKey: string }): Promise<any>;
  getVideoUrl(req: { channelKey: string; videoId: string }): Promise<any>;
  prefetchVideo(req: { channelKey: string; videoId: string }): Promise<any>;
  getVideoStats(req: { channelKey: string; videoId: string }): Promise<any>;
  getVideoThumbnail(req: { channelKey: string; videoId: string }): Promise<any>;
  setVideoThumbnail(req: { videoId: string; imageData: string; mimeType: string }): Promise<any>;
  getChannel(req: { publicKey: string }): Promise<any>;
  subscribeChannel(req: { channelKey: string }): Promise<any>;
  joinChannel(req: { channelKey: string }): Promise<any>;
  getSubscriptions(req: {}): Promise<any>;
  getPublicFeed(req: {}): Promise<any>;
  refreshFeed(req: {}): Promise<any>;
  submitToFeed(req: {}): Promise<any>;
  unpublishFromFeed(req: {}): Promise<any>;
  isChannelPublished(req: {}): Promise<any>;
  getChannelMeta(req: { channelKey: string }): Promise<any>;
  getStatus(req: {}): Promise<any>;
  getSwarmStatus(req: {}): Promise<any>;
  uploadVideo(req: { filePath: string; title: string; description: string; category?: string }): Promise<any>;
  downloadVideo(req: { channelKey: string; videoId: string; destPath: string }): Promise<any>;
  pickVideoFile(req: {}): Promise<any>;
  pickImageFile(req: {}): Promise<any>;
  onEventReady(handler: (data: any) => void): void;
  onEventError(handler: (data: any) => void): void;
  onEventVideoStats(handler: (data: any) => void): void;
  onEventUploadProgress(handler: (data: any) => void): void;
};

// FileSystem from expo-file-system
declare const FileSystem: {
  documentDirectory: string | null;
};

// Module state
let worklet: InstanceType<typeof Worklet> | null = null;
let hrpc: InstanceType<typeof HRPC> | null = null;
let _blobServerPort: number | null = null;
let _isInitialized = false;

// Event callback types
type ReadyCallback = (data: { blobServerPort: number }) => void;
type ErrorCallback = (data: { message: string }) => void;
type VideoStatsCallback = (data: { channelKey: string; videoId: string; stats: VideoStats }) => void;
type UploadProgressCallback = (data: { progress: number; videoId?: string }) => void;
type FeedUpdateCallback = (data: { action?: string; channelKey?: string }) => void;

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

/**
 * Initialize platform RPC for mobile
 *
 * @param config.backendSource - Backend bundle source code
 * @param config.storagePath - Optional storage path (defaults to documentDirectory)
 */
export async function initPlatformRPC(config: {
  backendSource: string;
  storagePath?: string;
}): Promise<void> {
  if (_isInitialized && worklet) {
    console.log('[Platform RPC] Already initialized');
    return;
  }

  // Get dependencies at runtime
  const WorkletClass = require('react-native-bare-kit').Worklet;
  const HRPCClass = require('@peartube/spec');
  const FS = require('expo-file-system');

  // Determine storage path
  let storagePath = config.storagePath || FS.documentDirectory || '';
  if (storagePath.startsWith('file://')) {
    storagePath = storagePath.slice(7);
  }

  console.log('[Platform RPC] Initializing with storage:', storagePath);

  // Create and start worklet
  worklet = new WorkletClass();
  worklet.start('/backend.bundle', config.backendSource, [storagePath]);
  console.log('[Platform RPC] Worklet started');

  // Setup HRPC client
  hrpc = new HRPCClass(worklet.IPC);
  console.log('[Platform RPC] HRPC client initialized');

  // Wire event handlers
  hrpc.onEventReady((data: any) => {
    console.log('[Platform RPC] Backend ready, blobServerPort:', data?.blobServerPort);
    _blobServerPort = data?.blobServerPort || null;
    _isInitialized = true;
    eventCallbacks.ready.forEach(cb => cb(data));
  });

  hrpc.onEventError((data: any) => {
    console.error('[Platform RPC] Backend error:', data?.message);
    eventCallbacks.error.forEach(cb => cb(data));
  });

  hrpc.onEventVideoStats((data: any) => {
    eventCallbacks.videoStats.forEach(cb => cb(data));
  });

  hrpc.onEventUploadProgress((data: any) => {
    eventCallbacks.uploadProgress.forEach(cb => cb(data));
  });

  if ((hrpc as any).onEventFeedUpdate) {
    (hrpc as any).onEventFeedUpdate((data: any) => {
      eventCallbacks.feedUpdate.forEach(cb => cb(data));
    });
  }
}

/**
 * Terminate platform RPC (for app lifecycle management)
 */
export function terminatePlatformRPC(): void {
  if (worklet) {
    console.log('[Platform RPC] Terminating worklet');
    try {
      worklet.terminate();
    } catch (err) {
      console.error('[Platform RPC] Failed to terminate:', err);
    }
    worklet = null;
    hrpc = null;
    _isInitialized = false;
  }
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
  return hrpc;
}

// Helper to ensure RPC is ready
function ensureRPC() {
  if (!hrpc) throw new Error('Platform RPC not initialized');
  return hrpc;
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

  async getVideoThumbnail(channelKeyOrReq: string | { channelKey: string; videoId: string }, videoId?: string) {
    const req = typeof channelKeyOrReq === 'string'
      ? { channelKey: channelKeyOrReq, videoId: videoId! }
      : channelKeyOrReq;
    return ensureRPC().getVideoThumbnail(req);
  },

  async setVideoThumbnail(req: { videoId: string; imageData: string; mimeType: string }) {
    return ensureRPC().setVideoThumbnail(req);
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

  async submitToFeed(): Promise<{ success: boolean }> {
    return ensureRPC().submitToFeed({});
  },

  async unpublishFromFeed(): Promise<{ success: boolean }> {
    return ensureRPC().unpublishFromFeed({});
  },

  async isChannelPublished(): Promise<{ published: boolean }> {
    return ensureRPC().isChannelPublished({});
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

  // File pickers
  async pickVideoFile() {
    return ensureRPC().pickVideoFile({});
  },

  async pickImageFile() {
    return ensureRPC().pickImageFile({});
  },

  // Storage management
  async getStorageStats(): Promise<{ usedBytes: number; maxBytes: number; usedGB: string; maxGB: number; seedCount: number; pinnedCount: number }> {
    return ensureRPC().getStorageStats({});
  },

  async setStorageLimit(maxGBOrReq: number | { maxGB: number }): Promise<{ success: boolean }> {
    const req = typeof maxGBOrReq === 'number' ? { maxGB: maxGBOrReq } : maxGBOrReq;
    return ensureRPC().setStorageLimit(req);
  },

  async clearCache(): Promise<{ success: boolean; clearedBytes?: number }> {
    return ensureRPC().clearCache({});
  },
};

export type RPCClient = typeof rpc;
