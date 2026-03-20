/**
 * RPC Client - Web (Pear Desktop)
 *
 * Unified platform RPC layer for Pear desktop apps.
 * Uses the shared runner/bridge contract on top of the PearWorkerClient
 * transport exposed by worker-client.js.
 */

import { createPlatformRpcBridge } from './rpc.shared';
import { createWebRunner } from './runner.web';
import type { VideoStats } from './types';

// PearWorkerClient is set on window by worker-client.js (unbundled)
declare global {
  interface Window {
    PearWorkerClient?: {
      isConnected: boolean;
      blobServerPort: number | null;
      initialize(): Promise<void>;
      connect(): Promise<{ stream: any; client?: any; terminate?: () => Promise<void> | void }>;
      getRpc(): any;
      close(): void;
    };
  }
}

// Module state
let _blobServerPort: number | null = null;
let _isInitialized = false;
const mainRunner = createWebRunner({
  async connectTransport() {
    if (typeof window === 'undefined') {
      throw new Error('Platform RPC can only be initialized in browser context');
    }

    const workerClient = window.PearWorkerClient;
    if (!workerClient) {
      throw new Error('PearWorkerClient not available - ensure worker-client.js is loaded');
    }

    return workerClient.connect();
  }
});

const mainBridge = createPlatformRpcBridge({
  platform: 'desktop',
  runner: mainRunner,
  entrypoint: 'legacy-desktop',
  getStoragePath() {
    return 'pear-desktop';
  }
});

mainBridge.events.onReady((data: any) => {
  _blobServerPort = data?.blobServerPort ?? null;
  _isInitialized = true;
});

mainBridge.events.onError(() => {
  _isInitialized = false;
});

/**
 * Event subscription system
 */
export const events = mainBridge.events;

/**
 * Initialize platform RPC for Pear desktop
 *
 * This initializes the PearWorkerClient which spawns the worker process.
 * The worker-client.js script must be loaded before calling this.
 */
export async function initPlatformRPC(): Promise<void> {
  if (_isInitialized && mainBridge.isInitialized()) {
    console.log('[Platform RPC] Already initialized');
    return;
  }

  if (typeof window === 'undefined') {
    throw new Error('Platform RPC can only be initialized in browser context');
  }

  if (!window.PearWorkerClient) {
    throw new Error('PearWorkerClient not available - ensure worker-client.js is loaded');
  }

  console.log('[Platform RPC] Initializing via PearWorkerClient...');

  try {
    await mainBridge.init();

    _blobServerPort = mainBridge.getBlobServerPort();
    console.log('[Platform RPC] Initialized, blobServerPort:', _blobServerPort);
  } catch (err) {
    console.error('[Platform RPC] Failed to initialize:', err);
    throw err;
  }
}

/**
 * Terminate platform RPC
 */
export function terminatePlatformRPC(): void {
  if (!mainBridge.isInitialized()) {
    _isInitialized = false;
    _blobServerPort = null;
    return;
  }

  _isInitialized = false;
  _blobServerPort = null;

  void mainBridge.terminate().catch((err) => {
    console.error('[Platform RPC] Failed to terminate:', err);
  });
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
  return mainBridge.getRpc();
}

// Helper to get RPC and ensure it's ready
function ensureRPC() {
  const rpc = mainBridge.getRpc();
  if (!rpc) throw new Error('Platform RPC not initialized');
  return rpc;
}

// Helper to normalize string or object params
function normalizeParam<T extends string>(
  arg: T | { [K in T]: string },
  key: T
): { [K in T]: string } {
  if (typeof arg === 'string') {
    const out = Object.create(null) as { [K in T]: string };
    out[key] = arg;
    return out;
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

  async prefetchVideo(channelKeyOrReq: string | { channelKey: string; videoId: string; publicBeeKey?: string }, videoId?: string) {
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

  updateChannel: (req: any) => ensureRPC().updateChannel(req),

  updateVideoMetadata: (req: any) => ensureRPC().updateVideoMetadata(req),

  updateChannelAvatar: (req: any) => ensureRPC().updateChannelAvatar(req),

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

  async unpublishFromFeed(): Promise<{ success: boolean }> {
    return ensureRPC().unpublishFromFeed({});
  },

  async isChannelPublished(): Promise<{ published: boolean }> {
    return ensureRPC().isChannelPublished({});
  },

  async hideChannel(channelKeyOrReq: string | { channelKey: string }) {
    const req = typeof channelKeyOrReq === 'string' ? { channelKey: channelKeyOrReq } : channelKeyOrReq;
    return ensureRPC().hideChannel(req);
  },

  async getChannelMeta(
    channelKeyOrReq: string | { channelKey: string; publicBeeKey?: string | null },
    publicBeeKey?: string | null
  ) {
    const req = typeof channelKeyOrReq === 'string'
      ? { channelKey: channelKeyOrReq, publicBeeKey: publicBeeKey ?? undefined }
      : channelKeyOrReq;
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

  // Transcode settings (Pear troubleshooting)
  async getTranscodeSettings() {
    return ensureRPC().getTranscodeSettings({});
  },

  async setTranscodeSettings(req: { videoToolboxDecodeEnabled?: boolean; videoToolboxHwMapEnabled?: boolean }) {
    return ensureRPC().setTranscodeSettings(req);
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

  // Comments
  async addComment(req: { channelKey: string; videoId: string; text: string; parentId?: string | null; authorChannelKey?: string | null; publicBeeKey?: string | null }): Promise<{ success: boolean; commentId?: string | null; queued?: boolean; error?: string | null }> {
    return ensureRPC().addComment(req);
  },

  async listComments(req: { channelKey: string; videoId: string; page?: number; limit?: number; publicBeeKey?: string | null }): Promise<{ success: boolean; comments: any[]; error?: string | null }> {
    return ensureRPC().listComments(req);
  },

  async hideComment(req: { channelKey: string; videoId: string; commentId: string; publicBeeKey?: string | null }): Promise<{ success: boolean; error?: string | null }> {
    return ensureRPC().hideComment(req);
  },

  async removeComment(req: { channelKey: string; videoId: string; commentId: string; authorChannelKey?: string | null; publicBeeKey?: string | null }): Promise<{ success: boolean; queued?: boolean; error?: string | null }> {
    return ensureRPC().removeComment(req);
  },

  // Reactions
  async addReaction(req: { channelKey: string; videoId: string; reactionType: string; authorChannelKey?: string | null; publicBeeKey?: string | null }): Promise<{ success: boolean; queued?: boolean; error?: string | null }> {
    return ensureRPC().addReaction(req);
  },

  async removeReaction(req: { channelKey: string; videoId: string; authorChannelKey?: string | null; publicBeeKey?: string | null }): Promise<{ success: boolean; queued?: boolean; error?: string | null }> {
    return ensureRPC().removeReaction(req);
  },

  async getReactions(req: { channelKey: string; videoId: string; authorChannelKey?: string | null; publicBeeKey?: string | null }): Promise<{ success: boolean; counts: Array<{ reactionType: string; count: number }>; userReaction?: string | null; error?: string | null }> {
    return ensureRPC().getReactions(req);
  },

  // Search
  async globalSearchVideos(queryOrReq: string | { query: string; topK?: number }, topK?: number): Promise<{ results: Array<{ id: string; score: number; metadata: any }> }> {
    const req = typeof queryOrReq === 'string'
      ? { query: queryOrReq, topK: topK || 20 }
      : queryOrReq;
    return ensureRPC().globalSearchVideos(req);
  },

  // MPV Player (Universal Codec Support)
  async mpvAvailable(): Promise<{ available: boolean }> {
    return ensureRPC().mpvAvailable({});
  },

  async mpvCreate(req: { width?: number; height?: number }): Promise<{ success: boolean; playerId?: string; frameServerPort?: number; error?: string }> {
    return ensureRPC().mpvCreate(req);
  },

  async mpvLoadFile(req: { playerId: string; url: string }): Promise<{ success: boolean; error?: string }> {
    return ensureRPC().mpvLoadFile(req);
  },

  async mpvPlay(req: { playerId: string }): Promise<{ success: boolean; error?: string }> {
    return ensureRPC().mpvPlay(req);
  },

  async mpvPause(req: { playerId: string }): Promise<{ success: boolean; error?: string }> {
    return ensureRPC().mpvPause(req);
  },

  async mpvSeek(req: { playerId: string; time: number }): Promise<{ success: boolean; error?: string }> {
    return ensureRPC().mpvSeek(req);
  },

  async mpvGetState(req: { playerId: string }): Promise<{ success: boolean; currentTime?: number; duration?: number; paused?: boolean; error?: string }> {
    return ensureRPC().mpvGetState(req);
  },

  async mpvRenderFrame(req: { playerId: string }): Promise<{ success: boolean; hasFrame?: boolean; width?: number; height?: number; frameData?: string; error?: string }> {
    return ensureRPC().mpvRenderFrame(req);
  },

  async mpvDestroy(req: { playerId: string }): Promise<{ success: boolean; error?: string }> {
    return ensureRPC().mpvDestroy(req);
  },

  // Casting (FCast/Chromecast)
  async castAvailable(): Promise<{ available: boolean; error?: string | null }> {
    return ensureRPC().castAvailable({});
  },

  async castStartDiscovery(): Promise<{ success: boolean; error?: string | null }> {
    return ensureRPC().castStartDiscovery({});
  },

  async castStopDiscovery(): Promise<{ success: boolean; error?: string | null }> {
    return ensureRPC().castStopDiscovery({});
  },

  async castGetDevices(): Promise<{ devices: Array<{ id: string; name: string; host: string; port: number; protocol: string }> }> {
    return ensureRPC().castGetDevices({});
  },

  async castAddManualDevice(req: { name: string; host: string; port?: number; protocol?: string }): Promise<{ success: boolean; device?: { id: string; name: string; host: string; port: number; protocol: string }; error?: string | null }> {
    return ensureRPC().castAddManualDevice(req);
  },

  async castConnect(req: { deviceId: string }): Promise<{ success: boolean; error?: string | null }> {
    return ensureRPC().castConnect(req);
  },

  async castDisconnect(): Promise<{ success: boolean; error?: string | null }> {
    return ensureRPC().castDisconnect({});
  },

  async castPlay(req: { url: string; contentType: string; title?: string; thumbnail?: string; time?: number; volume?: number; duration?: number; forceTranscode?: boolean }): Promise<{ success: boolean; error?: string | null }> {
    return ensureRPC().castPlay(req);
  },

  async castPause(): Promise<{ success: boolean; error?: string | null }> {
    return ensureRPC().castPause({});
  },

  async castResume(): Promise<{ success: boolean; error?: string | null }> {
    return ensureRPC().castResume({});
  },

  async castStop(): Promise<{ success: boolean; error?: string | null }> {
    return ensureRPC().castStop({});
  },

  async castSeek(req: { time: number }): Promise<{ success: boolean; error?: string | null }> {
    return ensureRPC().castSeek(req);
  },

  async castSetVolume(req: { volume: number }): Promise<{ success: boolean; error?: string | null }> {
    return ensureRPC().castSetVolume(req);
  },

  async castGetState(): Promise<{ state: string; currentTime: number; duration: number; volume: number }> {
    return ensureRPC().castGetState({});
  },

  async castIsConnected(): Promise<{ connected: boolean }> {
    return ensureRPC().castIsConnected({});
  },
};

export type RPCClient = typeof rpc;
