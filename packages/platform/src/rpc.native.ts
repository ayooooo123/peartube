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
  prefetchVideo(req: { channelKey: string; videoId: string; publicBeeKey?: string }): Promise<any>;
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
  globalSearchVideos(req: { query: string; topK?: number }): Promise<any>;
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
  castAvailable(req: {}): Promise<any>;
  castStartDiscovery(req: {}): Promise<any>;
  castStopDiscovery(req: {}): Promise<any>;
  castGetDevices(req: {}): Promise<any>;
  castAddManualDevice(req: { name: string; host: string; port?: number; protocol?: string }): Promise<any>;
  castConnect(req: { deviceId: string }): Promise<any>;
  castDisconnect(req: {}): Promise<any>;
  castPlay(req: { url: string; contentType: string; title?: string; thumbnail?: string; time?: number; volume?: number }): Promise<any>;
  castPause(req: {}): Promise<any>;
  castResume(req: {}): Promise<any>;
  castStop(req: {}): Promise<any>;
  castSeek(req: { time: number }): Promise<any>;
  castSetVolume(req: { volume: number }): Promise<any>;
  castGetState(req: {}): Promise<any>;
  castIsConnected(req: {}): Promise<any>;
  onEventReady(handler: (data: any) => void): void;
  onEventError(handler: (data: any) => void): void;
  onEventVideoStats(handler: (data: any) => void): void;
  onEventUploadProgress(handler: (data: any) => void): void;
  onEventDownloadProgress(handler: (data: any) => void): void;
  onEventFeedUpdate(handler: (data: any) => void): void;
  onEventLog(handler: (data: any) => void): void;
  onEventCastDeviceFound(handler: (data: any) => void): void;
  onEventCastDeviceLost(handler: (data: any) => void): void;
  onEventCastPlaybackState(handler: (data: any) => void): void;
  onEventCastTimeUpdate(handler: (data: any) => void): void;
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

// Transcoder worklet state
let transcodeWorklet: InstanceType<typeof Worklet> | null = null;
let _transcodeCallbacks: {
  onProgress?: (data: any) => void;
  onSegment?: (data: any) => void;
  onComplete?: (data: any) => void;
  onError?: (data: any) => void;
} = {};
let _transcodeResolve: ((data: any) => void) | null = null;
let _transcodeReject: ((error: Error) => void) | null = null;

// Event callback types
type ReadyCallback = (data: { blobServerPort: number }) => void;
type ErrorCallback = (data: { message: string }) => void;
type VideoStatsCallback = (data: { channelKey: string; videoId: string; stats: VideoStats }) => void;
type UploadProgressCallback = (data: { progress: number; videoId?: string }) => void;
type DownloadProgressCallback = (data: { id: string; progress: number; bytesDownloaded?: number; totalBytes?: number }) => void;
type FeedUpdateCallback = (data: { action?: string; channelKey?: string }) => void;
type CastDeviceFoundCallback = (data: { device: { id: string; name: string; host: string; port: number; protocol: string } }) => void;
type CastDeviceLostCallback = (data: { deviceId: string }) => void;
type CastPlaybackStateCallback = (data: { state: string; error?: string }) => void;
type CastTimeUpdateCallback = (data: { currentTime: number }) => void;

// Event callback storage
const eventCallbacks = {
  ready: [] as ReadyCallback[],
  error: [] as ErrorCallback[],
  videoStats: [] as VideoStatsCallback[],
  uploadProgress: [] as UploadProgressCallback[],
  downloadProgress: [] as DownloadProgressCallback[],
  feedUpdate: [] as FeedUpdateCallback[],
  castDeviceFound: [] as CastDeviceFoundCallback[],
  castDeviceLost: [] as CastDeviceLostCallback[],
  castPlaybackState: [] as CastPlaybackStateCallback[],
  castTimeUpdate: [] as CastTimeUpdateCallback[],
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
  onCastDeviceFound: (cb: CastDeviceFoundCallback) => {
    eventCallbacks.castDeviceFound.push(cb);
    return () => removeCallback(eventCallbacks.castDeviceFound, cb);
  },
  onCastDeviceLost: (cb: CastDeviceLostCallback) => {
    eventCallbacks.castDeviceLost.push(cb);
    return () => removeCallback(eventCallbacks.castDeviceLost, cb);
  },
  onCastPlaybackState: (cb: CastPlaybackStateCallback) => {
    eventCallbacks.castPlaybackState.push(cb);
    return () => removeCallback(eventCallbacks.castPlaybackState, cb);
  },
  onCastTimeUpdate: (cb: CastTimeUpdateCallback) => {
    eventCallbacks.castTimeUpdate.push(cb);
    return () => removeCallback(eventCallbacks.castTimeUpdate, cb);
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
  downloaderWorkerSource?: string;
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
  const encoding = FS.EncodingType?.UTF8 || 'utf8';

  // Determine storage path
  let storagePath = config.storagePath || FS.documentDirectory || '';
  if (storagePath.startsWith('file://')) {
    storagePath = storagePath.slice(7);
  }

  console.log('[Platform RPC] Initializing with storage:', storagePath);

  if (!config.downloaderWorkerSource) {
    throw new Error('Downloader worker bundle missing');
  }

  const storageDir = storagePath.endsWith('/') ? storagePath : `${storagePath}/`;
  const downloaderWorkerPath = `${storageDir}downloader-worker.bundle.js`;
  const downloaderWorkerUri = `file://${downloaderWorkerPath}`;

  try {
    await FS.writeAsStringAsync(downloaderWorkerUri, config.downloaderWorkerSource, { encoding });
    console.log('[Platform RPC] Downloader worker written:', downloaderWorkerPath);
  } catch (err: any) {
    throw new Error(`Failed to write downloader worker bundle: ${err?.message || err}`);
  }

  // Create worklet and HRPC client before starting to avoid missing early events.
  worklet = new WorkletClass();
  hrpc = new HRPCClass(worklet.IPC);
  console.log('[Platform RPC] HRPC client initialized');

  console.log('[Platform RPC] IPC type:', worklet.IPC?.constructor?.name);

  const { decode: decodeHrpcMessage } = require('@peartube/spec/messages');

  const safeDispatch = <T extends unknown>(label: string, callbacks: Array<(data: T) => void>, data: T) => {
    callbacks.forEach((cb) => {
      if (typeof cb !== 'function') return;
      try {
        const result = cb(data);
        if (result && typeof (result as any).then === 'function') {
          (result as Promise<any>).catch((err) => {
            console.error(`[Platform RPC] ${label} handler rejected:`, err?.message || err);
          });
        }
      } catch (err: any) {
        console.error(`[Platform RPC] ${label} handler threw:`, err?.message || err);
      }
    });
  };

  const handleReady = (data: any) => {
    console.log('[Platform RPC] Backend ready, blobServerPort:', data?.blobServerPort);
    _blobServerPort = data?.blobServerPort || null;
    _isInitialized = true;
    safeDispatch('ready', eventCallbacks.ready, data);
  };

  const handleError = (data: any) => {
    console.error('[Platform RPC] Backend error:', data?.message);
    safeDispatch('error', eventCallbacks.error, data);
  };

  const handleVideoStats = (data: any) => {
    // HRPC payload is `{ stats: VideoStats }` (see spec). Normalize to the callback shape.
    const stats = data?.stats ?? data;
    const channelKey = data?.channelKey ?? stats?.channelKey;
    const videoId = data?.videoId ?? stats?.videoId;

    if (channelKey && videoId && stats) {
      safeDispatch('videoStats', eventCallbacks.videoStats, { channelKey, videoId, stats });
    } else {
      // Fallback: forward raw data for debugging rather than dropping it.
      safeDispatch('videoStats', eventCallbacks.videoStats, data);
    }
  };

  const handleUploadProgress = (data: any) => {
    safeDispatch('uploadProgress', eventCallbacks.uploadProgress, data);
  };

  const handleDownloadProgress = (data: any) => {
    safeDispatch('downloadProgress', eventCallbacks.downloadProgress, data);
  };

  const handleFeedUpdate = (data: any) => {
    safeDispatch('feedUpdate', eventCallbacks.feedUpdate, data);
  };

  const handleCastDeviceFound = (data: any) => {
    safeDispatch('castDeviceFound', eventCallbacks.castDeviceFound, data);
  };

  const handleCastDeviceLost = (data: any) => {
    safeDispatch('castDeviceLost', eventCallbacks.castDeviceLost, data);
  };

  const handleCastPlaybackState = (data: any) => {
    safeDispatch('castPlaybackState', eventCallbacks.castPlaybackState, data);
  };

  const handleCastTimeUpdate = (data: any) => {
    safeDispatch('castTimeUpdate', eventCallbacks.castTimeUpdate, data);
  };

  const handleLog = (data: any) => {
    if (data?.message) {
      console.log('[Platform RPC] Backend log:', data.message);
    } else {
      console.log('[Platform RPC] Backend log:', data);
    }
  };

  const fallbackEventCommands: Record<number, string> = {};
  const rawRpc = (hrpc as any)?._rpc;
  if (rawRpc && !rawRpc._peartubePatched && Object.keys(fallbackEventCommands).length) {
    const originalOnRequest = rawRpc._onrequest;
    rawRpc._onrequest = async (req: any) => {
      try {
        const fallbackEvent = fallbackEventCommands[req?.command];
        if (fallbackEvent) {
          const hasPayload = Boolean(req?.data && req.data.length > 0);
          if (!hasPayload) {
            return await originalOnRequest(req);
          }
          let payload = null;
          try {
            payload = decodeHrpcMessage(fallbackEvent, req.data);
          } catch (decodeErr: any) {
            console.error('[Platform RPC] Fallback decode failed:', decodeErr?.message || decodeErr, 'command:', req?.command);
            return await originalOnRequest(req);
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
  hrpc.onEventCastDeviceFound(handleCastDeviceFound);
  hrpc.onEventCastDeviceLost(handleCastDeviceLost);
  hrpc.onEventCastPlaybackState(handleCastPlaybackState);
  hrpc.onEventCastTimeUpdate(handleCastTimeUpdate);

  // Start worklet after handlers are registered.
  worklet.start('/backend.bundle', config.backendSource, [storagePath, downloaderWorkerPath]);
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

// ============================================
// Transcoder Worklet Management
// ============================================

/**
 * Start the transcoder worklet and begin transcoding
 */
export async function startTranscodeWorklet(config: {
  transcodeSource: string;
  inputUrl: string;
  outputDir: string;
  options?: {
    useHardwareAccel?: boolean;
    videoBitrate?: number;
    audioBitrate?: number;
    segmentDuration?: number;
  };
  onProgress?: (data: { phase: string; percent?: number; frames?: number; bytes?: number; total?: number }) => void;
  onSegment?: (data: { index: number; duration: number; segmentsReady: number }) => void;
}): Promise<{
  success: boolean;
  sessionId?: string;
  hlsDir?: string;
  playlistPath?: string;
  totalFrames?: number;
  totalSegments?: number;
  error?: string;
}> {
  // Get Worklet class at runtime
  const WorkletClass = require('react-native-bare-kit').Worklet;
  const FS = require('expo-file-system');

  // Terminate any existing transcode worklet
  if (transcodeWorklet) {
    console.log('[Platform RPC] Terminating existing transcode worklet');
    try {
      transcodeWorklet.terminate();
    } catch {}
    transcodeWorklet = null;
  }

  return new Promise((resolve, reject) => {
    try {
      console.log('[Platform RPC] Starting transcode worklet...');

      // Store callbacks
      _transcodeCallbacks = {
        onProgress: config.onProgress,
        onSegment: config.onSegment,
      };
      _transcodeResolve = resolve;
      _transcodeReject = reject;

      // Create new worklet
      transcodeWorklet = new WorkletClass();

      // Message buffer for line-based protocol
      let messageBuffer = '';

      // Handle IPC messages from transcode worklet
      transcodeWorklet!.IPC.on('data', (chunk: Uint8Array) => {
        messageBuffer += Buffer.from(chunk).toString();
        const lines = messageBuffer.split('\n');
        messageBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            handleTranscodeMessage(msg, config.inputUrl, config.outputDir, config.options);
          } catch (err: any) {
            console.error('[Platform RPC] Failed to parse transcode message:', err?.message);
          }
        }
      });

      transcodeWorklet!.IPC.on('error', (err: Error) => {
        console.error('[Platform RPC] Transcode worklet IPC error:', err?.message);
        if (_transcodeReject) {
          _transcodeReject(err);
          _transcodeReject = null;
          _transcodeResolve = null;
        }
      });

      // Determine storage path for worklet args
      let storagePath = FS.documentDirectory || '';
      if (storagePath.startsWith('file://')) {
        storagePath = storagePath.slice(7);
      }

      // Start the worklet
      transcodeWorklet!.start('/transcode-worklet.bundle', config.transcodeSource, [storagePath]);
      console.log('[Platform RPC] Transcode worklet started');

    } catch (err: any) {
      console.error('[Platform RPC] Failed to start transcode worklet:', err?.message);
      reject(err);
    }
  });
}

/**
 * Handle messages from transcode worklet
 */
function handleTranscodeMessage(
  msg: any,
  inputUrl: string,
  outputDir: string,
  options?: any
) {
  console.log('[Platform RPC] Transcode message:', msg.type);

  switch (msg.type) {
    case 'ready':
      // Send start command to worklet
      console.log('[Platform RPC] Transcode worklet ready, sending start command');
      const startMsg = JSON.stringify({
        type: 'start',
        inputUrl,
        outputDir,
        options: options || {},
      }) + '\n';
      transcodeWorklet?.IPC.write(Buffer.from(startMsg));
      break;

    case 'progress':
      if (_transcodeCallbacks.onProgress) {
        _transcodeCallbacks.onProgress(msg);
      }
      break;

    case 'segment':
      if (_transcodeCallbacks.onSegment) {
        _transcodeCallbacks.onSegment(msg);
      }
      break;

    case 'complete':
      console.log('[Platform RPC] Transcode complete:', msg.totalFrames, 'frames');
      if (_transcodeResolve) {
        _transcodeResolve({
          success: true,
          sessionId: msg.sessionId,
          hlsDir: msg.hlsDir,
          playlistPath: msg.playlistPath,
          totalFrames: msg.totalFrames,
          totalSegments: msg.totalSegments,
        });
        _transcodeResolve = null;
        _transcodeReject = null;
      }
      // Terminate worklet after completion
      terminateTranscodeWorklet();
      break;

    case 'error':
      console.error('[Platform RPC] Transcode error:', msg.error);
      if (_transcodeReject) {
        _transcodeReject(new Error(msg.error || 'Transcode failed'));
        _transcodeReject = null;
        _transcodeResolve = null;
      }
      // Terminate worklet after error
      terminateTranscodeWorklet();
      break;
  }
}

/**
 * Stop active transcode and terminate worklet
 */
export function terminateTranscodeWorklet(): void {
  if (transcodeWorklet) {
    console.log('[Platform RPC] Terminating transcode worklet');
    try {
      // Send stop command
      const stopMsg = JSON.stringify({ type: 'stop' }) + '\n';
      transcodeWorklet.IPC.write(Buffer.from(stopMsg));

      // Terminate after short delay to allow cleanup
      setTimeout(() => {
        try {
          transcodeWorklet?.terminate();
        } catch {}
        transcodeWorklet = null;
      }, 100);
    } catch (err) {
      console.error('[Platform RPC] Failed to terminate transcode worklet:', err);
      transcodeWorklet = null;
    }
  }
  _transcodeCallbacks = {};
  _transcodeResolve = null;
  _transcodeReject = null;
}

/**
 * Check if transcode worklet is running
 */
export function isTranscodeWorkletRunning(): boolean {
  return transcodeWorklet !== null;
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

  // Search
  async globalSearchVideos(queryOrReq: string | { query: string; topK?: number }, topK?: number): Promise<{ results: Array<{ id: string; score: number; metadata: any }> }> {
    const req = typeof queryOrReq === 'string'
      ? { query: queryOrReq, topK: topK || 20 }
      : queryOrReq;
    return ensureRPC().globalSearchVideos(req);
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

  async castPlay(req: { url: string; contentType: string; title?: string; thumbnail?: string; time?: number; volume?: number }): Promise<{ success: boolean; error?: string | null }> {
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
