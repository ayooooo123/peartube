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
  createDeviceInvite(req: { channelKey: string }): Promise<any>;
  pairDevice(req: { inviteCode: string; deviceName?: string }): Promise<any>;
  listDevices(req: { channelKey: string }): Promise<any>;
  searchVideos(req: { channelKey: string; query: string; topK?: number; federated?: boolean }): Promise<any>;
  indexVideoVectors(req: { channelKey: string; videoId: string }): Promise<any>;
  addComment(req: { channelKey: string; videoId: string; text: string; parentId?: string | null; authorChannelKey?: string | null; publicBeeKey?: string | null }): Promise<any>;
  listComments(req: { channelKey: string; videoId: string; page?: number; limit?: number; publicBeeKey?: string | null }): Promise<any>;
  hideComment(req: { channelKey: string; videoId: string; commentId: string; publicBeeKey?: string | null }): Promise<any>;
  removeComment(req: { channelKey: string; videoId: string; commentId: string; authorChannelKey?: string | null; publicBeeKey?: string | null }): Promise<any>;
  addReaction(req: { channelKey: string; videoId: string; reactionType: string; authorChannelKey?: string | null; publicBeeKey?: string | null }): Promise<any>;
  removeReaction(req: { channelKey: string; videoId: string; authorChannelKey?: string | null; publicBeeKey?: string | null }): Promise<any>;
  getReactions(req: { channelKey: string; videoId: string; authorChannelKey?: string | null; publicBeeKey?: string | null }): Promise<any>;
  logWatchEvent(req: { channelKey: string; videoId: string; duration?: number; completed?: boolean; share?: boolean }): Promise<any>;
  getRecommendations(req: { channelKey: string; limit?: number }): Promise<any>;
  getVideoRecommendations(req: { channelKey: string; videoId: string; limit?: number }): Promise<any>;
  getStatus(req: {}): Promise<any>;
  getSwarmStatus(req: {}): Promise<any>;
  uploadVideo(req: { filePath: string; title: string; description: string; category?: string }): Promise<any>;
  downloadVideo(req: { channelKey: string; videoId: string; destPath: string }): Promise<any>;
  deleteVideo(req: { videoId: string }): Promise<any>;
  getVideoData(req: { channelKey: string; videoId: string }): Promise<any>;
  pickVideoFile(req: {}): Promise<any>;
  pickImageFile(req: {}): Promise<any>;
  recoverIdentity(req: { seedPhrase: string; name?: string }): Promise<any>;
  hideChannel(req: { channelKey: string }): Promise<any>;
  unsubscribeChannel(req: { channelKey: string }): Promise<any>;
  setVideoThumbnailFromFile(req: { videoId: string; filePath: string }): Promise<any>;
  getStorageStats(req: {}): Promise<any>;
  setStorageLimit(req: { maxGB: number }): Promise<any>;
  clearCache(req: {}): Promise<any>;
  onEventReady(handler: (data: any) => void): void;
  onEventError(handler: (data: any) => void): void;
  onEventVideoStats(handler: (data: any) => void): void;
  onEventUploadProgress(handler: (data: any) => void): void;
  onEventDownloadProgress(handler: (data: any) => void): void;
  onEventFeedUpdate(handler: (data: any) => void): void;
  onEventLog(handler: (data: any) => void): void;
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
type DownloadProgressCallback = (data: { id: string; progress: number; bytesDownloaded?: number; totalBytes?: number }) => void;
type FeedUpdateCallback = (data: { action?: string; channelKey?: string }) => void;

// Event callback storage
const eventCallbacks = {
  ready: [] as ReadyCallback[],
  error: [] as ErrorCallback[],
  videoStats: [] as VideoStatsCallback[],
  uploadProgress: [] as UploadProgressCallback[],
  downloadProgress: [] as DownloadProgressCallback[],
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
  onDownloadProgress: (cb: DownloadProgressCallback) => {
    eventCallbacks.downloadProgress.push(cb);
    return () => removeCallback(eventCallbacks.downloadProgress, cb);
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

  // Create worklet and HRPC client before starting to avoid missing early events.
  worklet = new WorkletClass();
  hrpc = new HRPCClass(worklet.IPC);
  console.log('[Platform RPC] HRPC client initialized');

  // Debug: Log IPC stream state and intercept data
  console.log('[Platform RPC] IPC type:', worklet.IPC?.constructor?.name);
  const ipcOnData = worklet.IPC.on.bind(worklet.IPC);
  worklet.IPC.on = (event: string, handler: (...args: any[]) => void) => {
    if (event === 'data') {
      return ipcOnData(event, (data: any) => {
        const len = data?.length || data?.byteLength || 0;
        const type = data?.constructor?.name || typeof data;
        const isBuffer = Buffer.isBuffer(data);
        const first4 = data?.slice?.(0, 4);
        console.log('[Platform RPC] IPC data received:', len, 'bytes, type:', type, 'isBuffer:', isBuffer, 'first4:', first4 ? Array.from(first4) : 'N/A');
        handler(data);
      });
    }
    return ipcOnData(event, handler);
  };

  const { decode: decodeHrpcMessage } = require('@peartube/spec/messages');

  const handleReady = (data: any) => {
    console.log('[Platform RPC] Backend ready, blobServerPort:', data?.blobServerPort);
    _blobServerPort = data?.blobServerPort || null;
    _isInitialized = true;
    eventCallbacks.ready.forEach(cb => cb(data));
  };

  const handleError = (data: any) => {
    console.error('[Platform RPC] Backend error:', data?.message);
    eventCallbacks.error.forEach(cb => cb(data));
  };

  const handleVideoStats = (data: any) => {
    // HRPC payload is `{ stats: VideoStats }` (see spec). Normalize to the callback shape.
    const stats = data?.stats ?? data;
    const channelKey = data?.channelKey ?? stats?.channelKey;
    const videoId = data?.videoId ?? stats?.videoId;

    if (channelKey && videoId && stats) {
      eventCallbacks.videoStats.forEach(cb => cb({ channelKey, videoId, stats }));
    } else {
      // Fallback: forward raw data for debugging rather than dropping it.
      eventCallbacks.videoStats.forEach(cb => cb(data));
    }
  };

  const handleUploadProgress = (data: any) => {
    eventCallbacks.uploadProgress.forEach(cb => cb(data));
  };

  const handleDownloadProgress = (data: any) => {
    eventCallbacks.downloadProgress.forEach(cb => cb(data));
  };

  const handleFeedUpdate = (data: any) => {
    eventCallbacks.feedUpdate.forEach(cb => cb(data));
  };

  const handleLog = (data: any) => {
    if (data?.message) {
      console.log('[Platform RPC] Backend log:', data.message);
    } else {
      console.log('[Platform RPC] Backend log:', data);
    }
  };

  const fallbackEventCommands: Record<number, string> = {
    59: '@peartube/event-ready',
    60: '@peartube/event-error',
    61: '@peartube/event-upload-progress',
    62: '@peartube/event-feed-update',
    63: '@peartube/event-log',
    64: '@peartube/event-video-stats',
  };

  const rawRpc = (hrpc as any)?._rpc;
  if (rawRpc && !rawRpc._peartubePatched) {
    const originalOnRequest = rawRpc._onrequest;
    rawRpc._onrequest = async (req: any) => {
      try {
        const fallbackEvent = fallbackEventCommands[req?.command];
        if (fallbackEvent) {
          let payload = null;
          try {
            payload = req?.data ? decodeHrpcMessage(fallbackEvent, req.data) : null;
          } catch (decodeErr: any) {
            console.error('[Platform RPC] Fallback decode failed:', decodeErr?.message || decodeErr, 'command:', req?.command);
          }

          switch (fallbackEvent) {
            case '@peartube/event-ready':
              handleReady(payload || {});
              break;
            case '@peartube/event-error':
              handleError(payload || {});
              break;
            case '@peartube/event-upload-progress':
              handleUploadProgress(payload || {});
              break;
            case '@peartube/event-download-progress':
              handleDownloadProgress(payload || {});
              break;
            case '@peartube/event-feed-update':
              handleFeedUpdate(payload || {});
              break;
            case '@peartube/event-log':
              handleLog(payload || {});
              break;
            case '@peartube/event-video-stats':
              handleVideoStats(payload || {});
              break;
          }
          return;
        }
        return await originalOnRequest(req);
      } catch (err: any) {
        console.error('[Platform RPC] HRPC handler error:', err?.message || err, 'command:', req?.command);
        return;
      }
    };
    rawRpc._peartubePatched = true;
  }

  // Wire event handlers before starting the worklet.
  hrpc.onEventReady(handleReady);
  hrpc.onEventError(handleError);
  hrpc.onEventVideoStats(handleVideoStats);
  hrpc.onEventUploadProgress(handleUploadProgress);
  hrpc.onEventDownloadProgress(handleDownloadProgress);
  hrpc.onEventFeedUpdate(handleFeedUpdate);
  hrpc.onEventLog(handleLog);

  // Start worklet after handlers are registered.
  worklet.start('/backend.bundle', config.backendSource, [storagePath]);
  console.log('[Platform RPC] Worklet started');
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

  // Multi-device pairing
  async createDeviceInvite(channelKeyOrReq: string | { channelKey: string }) {
    const req = typeof channelKeyOrReq === 'string' ? { channelKey: channelKeyOrReq } : channelKeyOrReq;
    return ensureRPC().createDeviceInvite(req);
  },

  async pairDevice(inviteCodeOrReq: string | { inviteCode: string; deviceName?: string }, deviceName?: string) {
    const req = typeof inviteCodeOrReq === 'string'
      ? { inviteCode: inviteCodeOrReq, deviceName }
      : inviteCodeOrReq;
    return ensureRPC().pairDevice(req);
  },

  async listDevices(channelKeyOrReq: string | { channelKey: string }) {
    const req = typeof channelKeyOrReq === 'string' ? { channelKey: channelKeyOrReq } : channelKeyOrReq;
    return ensureRPC().listDevices(req);
  },

  // Search
  async searchVideos(req: { channelKey: string; query: string; topK?: number; federated?: boolean }) {
    return ensureRPC().searchVideos(req);
  },

  async indexVideoVectors(req: { channelKey: string; videoId: string }) {
    return ensureRPC().indexVideoVectors(req);
  },

  // Comments
  async addComment(req: { channelKey: string; videoId: string; text: string; parentId?: string | null; authorChannelKey?: string | null; publicBeeKey?: string | null }) {
    return ensureRPC().addComment(req);
  },

  async listComments(req: { channelKey: string; videoId: string; page?: number; limit?: number; publicBeeKey?: string | null }) {
    return ensureRPC().listComments(req);
  },

  async hideComment(req: { channelKey: string; videoId: string; commentId: string; publicBeeKey?: string | null }) {
    return ensureRPC().hideComment(req);
  },

  async removeComment(req: { channelKey: string; videoId: string; commentId: string; authorChannelKey?: string | null; publicBeeKey?: string | null }) {
    return ensureRPC().removeComment(req);
  },

  // Reactions
  async addReaction(req: { channelKey: string; videoId: string; reactionType: string; authorChannelKey?: string | null; publicBeeKey?: string | null }) {
    return ensureRPC().addReaction(req);
  },

  async removeReaction(req: { channelKey: string; videoId: string; authorChannelKey?: string | null; publicBeeKey?: string | null }) {
    return ensureRPC().removeReaction(req);
  },

  async getReactions(req: { channelKey: string; videoId: string; authorChannelKey?: string | null; publicBeeKey?: string | null }) {
    return ensureRPC().getReactions(req);
  },

  // Recommendations / watch events
  async logWatchEvent(req: { channelKey: string; videoId: string; duration?: number; completed?: boolean; share?: boolean }) {
    return ensureRPC().logWatchEvent(req);
  },

  async getRecommendations(req: { channelKey: string; limit?: number }) {
    return ensureRPC().getRecommendations(req);
  },

  async getVideoRecommendations(req: { channelKey: string; videoId: string; limit?: number }) {
    return ensureRPC().getVideoRecommendations(req);
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

  // Identity - recovery
  async recoverIdentity(seedPhraseOrReq: string | { seedPhrase: string; name?: string }, name?: string) {
    const req = typeof seedPhraseOrReq === 'string'
      ? { seedPhrase: seedPhraseOrReq, name }
      : seedPhraseOrReq;
    return ensureRPC().recoverIdentity(req);
  },

  // Channel management
  async hideChannel(channelKeyOrReq: string | { channelKey: string }) {
    const req = typeof channelKeyOrReq === 'string' ? { channelKey: channelKeyOrReq } : channelKeyOrReq;
    return ensureRPC().hideChannel(req);
  },

  async unsubscribeChannel(channelKeyOrReq: string | { channelKey: string }) {
    const req = typeof channelKeyOrReq === 'string' ? { channelKey: channelKeyOrReq } : channelKeyOrReq;
    return ensureRPC().unsubscribeChannel(req);
  },

  // Video data
  async getVideoData(channelKeyOrReq: string | { channelKey: string; videoId: string }, videoId?: string) {
    const req = typeof channelKeyOrReq === 'string'
      ? { channelKey: channelKeyOrReq, videoId: videoId! }
      : channelKeyOrReq;
    return ensureRPC().getVideoData(req);
  },

  // Thumbnail from file
  async setVideoThumbnailFromFile(videoIdOrReq: string | { videoId: string; filePath: string }, filePath?: string) {
    const req = typeof videoIdOrReq === 'string'
      ? { videoId: videoIdOrReq, filePath: filePath! }
      : videoIdOrReq;
    return ensureRPC().setVideoThumbnailFromFile(req);
  },
};

export type RPCClient = typeof rpc;
