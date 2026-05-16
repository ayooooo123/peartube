/**
 * RPC Client - Web (Pear Desktop)
 *
 * Unified platform RPC layer for Pear desktop apps.
 *
 * Two transport paths:
 * 1. Electron bridge (new): window.bridge from preload.js — virtual pipe over Electron IPC
 * 2. PearWorkerClient (legacy pear run): worker-client.js loaded as unbundled script
 */

import { createProtocolClient } from '@peartube/protocol';
import { createPlatformRpcBridge } from './rpc.shared';
import { createWebRunner } from './runner.web';
import type { VideoStats } from './types';

// Worker specifier for Electron bridge path
const BACKEND_WORKER = '/pear/build/workers/core/index.js';

// Electron bridge exposed by electron/preload.js
declare global {
  interface Window {
    bridge?: {
      pkg(): any;
      applyUpdate(): Promise<void>;
      appRestart(): Promise<void>;
      onPearEvent(name: string, listener: (...args: any[]) => void): () => void;
      startWorker(specifier: string): Promise<boolean>;
      writeWorkerIPC(specifier: string, data: any): Promise<boolean>;
      onWorkerIPC(specifier: string, listener: (data: any) => void): () => void;
      onWorkerStdout(specifier: string, listener: (data: any) => void): () => void;
      onWorkerStderr(specifier: string, listener: (data: any) => void): () => void;
      onWorkerExit(specifier: string, listener: (code: number) => void): () => void;
    };
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

/**
 * Create a virtual duplex pipe over Electron's bridge IPC.
 * Implements the minimal stream interface that HRPC/protomux needs.
 */
function createBridgePipe(specifier: string) {
  const bridge = window.bridge!;
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  let destroyed = false;
  let unsubscribe: (() => void) | null = null;

  const pipe: any = {
    write(data: any) {
      if (destroyed) return false;
      bridge.writeWorkerIPC(specifier, data instanceof ArrayBuffer ? new Uint8Array(data) : data);
      return true;
    },
    on(event: string, cb: (...args: any[]) => void) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(cb);
      return pipe;
    },
    removeListener(event: string, cb: (...args: any[]) => void) {
      const cbs = listeners.get(event);
      if (cbs) { const idx = cbs.indexOf(cb); if (idx !== -1) cbs.splice(idx, 1); }
      return pipe;
    },
    emit(event: string, ...args: any[]) {
      const cbs = listeners.get(event);
      if (cbs) for (const cb of [...cbs]) cb(...args);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      pipe.emit('end');
      pipe.emit('close');
      listeners.clear();
      if (unsubscribe) unsubscribe();
    },
    get destroyed() { return destroyed; },
    get writable() { return !destroyed; },
    get readable() { return !destroyed; },
  };

  // Subscribe to incoming data from worker via main process relay
  unsubscribe = bridge.onWorkerIPC(specifier, (data: any) => {
    if (!destroyed) pipe.emit('data', data);
  });

  // Log worker stdout/stderr
  const offStdout = bridge.onWorkerStdout(specifier, (data: any) => {
    console.log('[Worker stdout]', new TextDecoder().decode(data));
  });
  const offStderr = bridge.onWorkerStderr(specifier, (data: any) => {
    console.error('[Worker stderr]', new TextDecoder().decode(data));
  });
  const offExit = bridge.onWorkerExit(specifier, (code: number) => {
    console.log('[Worker] Exited with code:', code);
    offStdout(); offStderr(); offExit();
    if (!destroyed) pipe.destroy();
  });

  return pipe;
}

/**
 * Connect to backend via Electron bridge (new path) or PearWorkerClient (legacy).
 */
async function connectTransport() {
  if (typeof window === 'undefined') {
    throw new Error('Platform RPC can only be initialized in browser context');
  }

  // New path: Electron bridge from preload.js
  if (window.bridge?.startWorker) {
    console.log('[Platform RPC] Using Electron bridge transport');
    await window.bridge.startWorker(BACKEND_WORKER);
    console.log('[Platform RPC] Worker started:', BACKEND_WORKER);
    const stream = createBridgePipe(BACKEND_WORKER);
    const client = createProtocolClient({ stream });
    return { stream, client, terminate: () => stream.destroy() };
  }

  // Legacy path: PearWorkerClient from worker-client.js (pear run)
  console.log('[Platform RPC] Using PearWorkerClient transport (legacy)');
  const workerClient = await waitForPearWorkerClient();
  return workerClient.connect();
}

function waitForPearWorkerClient(timeoutMs = 10000) {
  const existingClient = window.PearWorkerClient ?? null;
  if (existingClient) return Promise.resolve(existingClient);

  const startedAt = Date.now();
  return new Promise<NonNullable<Window['PearWorkerClient']>>((resolve, reject) => {
    const poll = () => {
      const wc = window.PearWorkerClient ?? null;
      if (wc) { resolve(wc); return; }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('PearWorkerClient not available'));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

// Module state
let _blobServerPort: number | null = null;
let _isInitialized = false;

const mainRunner = createWebRunner({ connectTransport });

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

  // Electron bridge path: window.bridge is set by preload.js — skip PearWorkerClient
  // Legacy pear run path: wait for PearWorkerClient from worker-client.js
  if (!window.bridge?.startWorker) {
    await waitForPearWorkerClient();
  }

  console.log('[Platform RPC] Initializing...');

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

  async getVideoUrl(channelKeyOrReq: string | { channelKey: string; videoId: string; publicBeeKey?: string; blobId?: string; blobsCoreKey?: string; mimeType?: string }, videoId?: string) {
    const req = typeof channelKeyOrReq === 'string'
      ? { channelKey: channelKeyOrReq, videoId: videoId! }
      : channelKeyOrReq;
    return ensureRPC().getVideoUrl(req);
  },

  async preparePlayback(channelKeyOrReq: string | { channelKey: string; videoId: string; publicBeeKey?: string; blobId?: string; blobsCoreKey?: string; mimeType?: string }, videoId?: string) {
    const req = typeof channelKeyOrReq === 'string'
      ? { channelKey: channelKeyOrReq, videoId: videoId! }
      : channelKeyOrReq;
    return ensureRPC().preparePlayback(req);
  },

  async webPreparePlayback(req: { channelKey: string; videoId: string }): Promise<{ url: string; transcoded?: boolean; audioCodec?: string; transcodeError?: string }> {
    const rpcInstance = ensureRPC();
    if (typeof rpcInstance.webPreparePlayback === 'function') {
      return rpcInstance.webPreparePlayback(req);
    }
    // Fallback to regular preparePlayback if webPreparePlayback not available
    return rpcInstance.preparePlayback(req);
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
  async getCanonicalFeed() {
    return ensureRPC().getCanonicalFeed({});
  },

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
