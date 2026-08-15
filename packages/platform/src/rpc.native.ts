/* eslint-disable no-empty, @typescript-eslint/no-empty-object-type */
/**
 * RPC Client - Native (React Native / Mobile)
 *
 * Unified platform RPC layer for mobile apps.
 * Handles BareKit Worklet initialization, HRPC setup, and event subscriptions.
 */

import {
  createChannelCatalogRpc,
  createMediaGraphRpc,
  createOperabilityRpc,
  createPlatformRpcBridge,
  createPersonalRpc,
  createPublisherRootOperationRpc,
} from './rpc.shared';
import type {
  PublisherRootIntentRequest,
  PublisherSignerBridgeLike,
  StorageStatsResponse,
} from './rpc.shared';
import {
  createNativeRunner,
  runNativeLegacyPublisherRootPreflight,
} from './runner.native';
import type { LegacyPublisherRootMigrationCallback } from './runner.native';
import { createJsonFrameParser, encodeJsonFrame } from './ipc-json-framing.js';
import {
  createBundleCachePaths,
  normalizeBundleFilePath,
  shouldReusePersistedBundleCache,
} from './native-bundle-cache.js';
import { PROTOCOL_VERSION } from '@peartube/host/contracts'
import type { VideoStats } from './types';

declare function require(moduleName: string): any;
declare const Buffer: any;

// Types for external dependencies (provided at runtime)
declare const Worklet: new () => {
  start(name: string, source: string, args?: string[]): void;
  start(path: string, args?: string[]): void;
  terminate(): void;
  IPC: any;
};


// FileSystem from expo-file-system
declare const FileSystem: {
  documentDirectory: string | null;
};

// Module state
let _blobServerPort: number | null = null;
let _initPromise: Promise<void> | null = null;
let _isInitialized = false;
let _startupState: 'idle' | 'initializing' | 'starting-worklet' | 'ready' | 'error' = 'idle';
let _isTerminating = false;
let _publisherSignerBridge: PublisherSignerBridgeLike | null = null;
const BACKEND_WORKLET_ID = '/peartube-backend-core.bundle'
const SHUTDOWN_TIMEOUT_MS = 4000
const BLOB_SERVER_HEALTH_TIMEOUT_MS = 1500

type BareWorkletCtor = new (name?: string) => {
  start(name: string, source: string, args?: string[]): void;
  start(path: string, args?: string[]): void;
  terminate(): void;
  IPC: any;
};

const nativeRuntimeConfig: {
  WorkletCtor: BareWorkletCtor | null;
  backendSource: string;
  backendPath: string;
  storagePath: string;
  workerArgs: string[];
} = {
  WorkletCtor: null,
  backendSource: '',
  backendPath: '',
  storagePath: '',
  workerArgs: [],
};

function withHostProtocolLaunchOption(args: string[], protocolVersion: number): string[] {
  const nextArgs = args.slice()
  for (let index = 0; index < nextArgs.length; index += 1) {
    const candidate = nextArgs[index]
    if (typeof candidate !== 'string' || !candidate.trim().startsWith('{')) continue
    try {
      const parsed = JSON.parse(candidate)
      if (parsed?.__peartubeLaunchOptions !== true) continue
      nextArgs[index] = JSON.stringify({ ...parsed, protocolVersion })
      return nextArgs
    } catch {}
  }
  nextArgs.unshift(JSON.stringify({ __peartubeLaunchOptions: true, protocolVersion }))
  return nextArgs
}

const mainRunner = createNativeRunner({
  get WorkletCtor() {
    if (!nativeRuntimeConfig.WorkletCtor) {
      throw new Error('Native worklet runtime is not configured');
    }
    return nativeRuntimeConfig.WorkletCtor;
  },
  get backendSource() {
    return nativeRuntimeConfig.backendSource;
  },
  get backendPath() {
    return nativeRuntimeConfig.backendPath;
  },
  workletId: BACKEND_WORKLET_ID,
  resolveLaunchArgs(options) {
    return [
      options.storagePath,
      options.entrypoint,
      ...withHostProtocolLaunchOption(nativeRuntimeConfig.workerArgs, options.protocolVersion),
    ];
  },
});

const mainBridge = createPlatformRpcBridge({
  platform: 'mobile',
  runner: mainRunner,
  entrypoint: 'mobile-entry',
  getStoragePath() {
    return nativeRuntimeConfig.storagePath;
  },
  getArgs() {
    return nativeRuntimeConfig.workerArgs;
  },
  getPublisherSigner: () => _publisherSignerBridge,
});

mainBridge.events.onReady((data: any) => {
  _blobServerPort = data?.blobServerPort ?? null;
  _isInitialized = true;
  _startupState = 'ready';
});

mainBridge.events.onError((data: any) => {
  if (_isInitialized || mainBridge.isInitialized()) {
    console.warn('[Platform RPC] Received host error after bridge was already initialized:', data?.message || data)
    return;
  }

  _isInitialized = false;
  _startupState = 'error';
});

/**
 * Send a shutdown signal via IPC and wait for acknowledgment.
 * Resolves when shutdown-complete is received or rejects on timeout.
 */
function sendShutdownSignalViaIpc(instance: InstanceType<typeof Worklet>): Promise<void> {
  const ipc = instance?.IPC;
  if (!ipc?.write) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('shutdown-timeout'));
    }, SHUTDOWN_TIMEOUT_MS);

    const parser = createJsonFrameParser();

    function onData(chunk: any) {
      for (const msg of parser.push(chunk)) {
        if (msg?.type === 'shutdown-complete') {
          cleanup();
          resolve();
          return;
        }
      }
    }

    function onClose() {
      cleanup();
      resolve(); // Worklet closed — shutdown effectively complete
    }

    function cleanup() {
      clearTimeout(timer);
      try { ipc.removeListener?.('data', onData); } catch {}
      try { ipc.removeListener?.('close', onClose); } catch {}
    }

    try {
      ipc.on('data', onData);
      ipc.on('close', onClose);
    } catch {
      cleanup();
      resolve();
      return;
    }

    try {
      const shutdownPayload = encodeJsonFrame({ type: 'shutdown' })
      if (typeof shutdownPayload !== 'string' || shutdownPayload.length === 0) {
        cleanup()
        resolve()
        return
      }
      ipc.write(Buffer.from(shutdownPayload))
    } catch {
      cleanup();
      resolve(); // Write failed — proceed to terminate
    }
  });
}

/**
 * Gracefully shut down a worklet: send shutdown signal, wait, then terminate.
 * Always calls terminate() even if the signal times out or fails.
 */
async function terminateWorkletWithDelay(instance: InstanceType<typeof Worklet> | null): Promise<void> {
  if (!instance) return;
  try {
    await sendShutdownSignalViaIpc(instance);
    console.log('[Platform RPC] Worklet shutdown acknowledged');
  } catch {
    console.log('[Platform RPC] Worklet shutdown timed out, forcing terminate');
  }
  try {
    instance.terminate();
  } catch {}
}

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
type ReadyCallback = (data: { blobServerPort: number | null }) => void;
type ErrorCallback = (data: { message: string }) => void;
type VideoStatsCallback = (data: { channelKey: string; videoId: string; stats: VideoStats }) => void;
type UploadProgressCallback = (data: { progress: number; videoId?: string }) => void;
type DownloadProgressCallback = (data: { id: string; progress: number; bytesDownloaded?: number; totalBytes?: number }) => void;
type CastDeviceFoundCallback = (data: { device: { id: string; name: string; host: string; port: number; protocol: string } }) => void;
type CastDeviceLostCallback = (data: { deviceId: string }) => void;
type CastPlaybackStateCallback = (data: { state: string; error?: string }) => void;
type CastTimeUpdateCallback = (data: { currentTime: number }) => void;

function resolveStorageUri(FS: any, FSLegacy: any, configuredPath?: string): string {
  if (configuredPath && configuredPath.length > 0) {
    return configuredPath.startsWith('file://') ? configuredPath : `file://${configuredPath}`;
  }

  const candidates = [
    FS?.Paths?.document?.uri,
    FSLegacy?.documentDirectory,
    FS?.documentDirectory,
    FS?.Paths?.cache?.uri,
    FSLegacy?.cacheDirectory,
    FS?.cacheDirectory,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }

  throw new Error('No writable storage directory available from expo-file-system');
}

function normalizeFsModule(mod: any): any {
  return mod?.default ?? mod;
}

async function readOptionalTextAsync(FSLegacy: any, uri: string, encoding: string): Promise<string | null> {
  if (typeof FSLegacy?.readAsStringAsync !== 'function') return null;

  try {
    const value = await FSLegacy.readAsStringAsync(uri, { encoding });
    return typeof value === 'string' ? value.trim() : null;
  } catch {
    return null;
  }
}

async function writeOptionalTextAsync(FSLegacy: any, uri: string, contents: string, encoding: string): Promise<boolean> {
  if (typeof FSLegacy?.writeAsStringAsync !== 'function') return false;

  try {
    await FSLegacy.writeAsStringAsync(uri, contents, { encoding });
    return true;
  } catch {
    return false;
  }
}

async function resolveBundleLaunchFiles(
  FSLegacy: any,
  storageUri: string,
  encoding: string,
  config: {
    backendSource?: string;
    downloaderWorkerSource?: string;
    backendVersionKey?: string;
    loadBackendSource?: () => Promise<string>;
    loadDownloaderWorkerSource?: () => Promise<string | null | undefined>;
  }
): Promise<{
  backendPath: string;
  backendSource: string;
  downloaderWorkerPath: string;
}> {
  const {
    backendBundleUri,
    downloaderWorkerUri,
    versionMarkerUri,
  } = createBundleCachePaths(storageUri);

  const getInfoAsync = FSLegacy?.getInfoAsync;
  const needsDownloaderWorker = Boolean(
    config.downloaderWorkerSource || config.loadDownloaderWorkerSource
  );

  let backendInfo = { exists: false };
  let downloaderInfo = { exists: false };
  let cachedVersionKey: string | null = null;

  if (typeof getInfoAsync === 'function') {
    const [backendResult, downloaderResult] = await Promise.all([
      getInfoAsync(backendBundleUri),
      getInfoAsync(downloaderWorkerUri),
    ]);

    backendInfo = backendResult ?? backendInfo;
    downloaderInfo = downloaderResult ?? downloaderInfo;
    cachedVersionKey = await readOptionalTextAsync(FSLegacy, versionMarkerUri, encoding);
  }

  const expectedVersionKey = config.backendVersionKey ?? '';
  if (shouldReusePersistedBundleCache({
    expectedVersionKey,
    cachedVersionKey,
    backendBundleExists: backendInfo.exists === true,
    downloaderWorkerExists: downloaderInfo.exists === true,
    needsDownloaderWorker,
  })) {
    return {
      backendPath: normalizeBundleFilePath(backendBundleUri),
      backendSource: '',
      downloaderWorkerPath: needsDownloaderWorker
        ? normalizeBundleFilePath(downloaderWorkerUri)
        : '',
    };
  }

  let backendSource = typeof config.backendSource === 'string' ? config.backendSource : '';
  if (!backendSource && typeof config.loadBackendSource === 'function') {
    const loaded = await config.loadBackendSource();
    backendSource = typeof loaded === 'string' ? loaded : '';
  }

  if (!backendSource) {
    throw new Error('Native backend source is not configured');
  }

  const backendPath = await writeOptionalTextAsync(FSLegacy, backendBundleUri, backendSource, encoding)
    ? normalizeBundleFilePath(backendBundleUri)
    : '';

  let downloaderWorkerPath = '';
  if (needsDownloaderWorker) {
    let downloaderWorkerSource =
      typeof config.downloaderWorkerSource === 'string'
        ? config.downloaderWorkerSource
        : '';

    if (!downloaderWorkerSource && typeof config.loadDownloaderWorkerSource === 'function') {
      const loaded = await config.loadDownloaderWorkerSource();
      downloaderWorkerSource = typeof loaded === 'string' ? loaded : '';
    }

    if (downloaderWorkerSource) {
      const wroteWorker = await writeOptionalTextAsync(
        FSLegacy,
        downloaderWorkerUri,
        downloaderWorkerSource,
        encoding
      );

      if (wroteWorker) {
        downloaderWorkerPath = normalizeBundleFilePath(downloaderWorkerUri);
      }
    }
  }

  if (backendPath && expectedVersionKey) {
    await writeOptionalTextAsync(FSLegacy, versionMarkerUri, expectedVersionKey, encoding);
  }

  return {
    backendPath,
    backendSource,
    downloaderWorkerPath,
  };
}

/**
 * Check if a headless cast session is active
 * Asynchronously checks if the cast flag file exists using expo-file-system
 * This allows detection of active cast sessions even after the app UI closes
 */
export async function isHeadlessCastActive(): Promise<boolean> {
  try {
    // Get the storage path the same way initPlatformRPC does
    const FS = normalizeFsModule(require('expo-file-system'));
    const FSLegacy = normalizeFsModule(require('expo-file-system/legacy'));
    const storageUri = resolveStorageUri(FS, FSLegacy);
    const flagUri = storageUri.endsWith('/')
      ? `${storageUri}.peartube-cast-headless`
      : `${storageUri}/.peartube-cast-headless`;
    const getInfoAsync = FSLegacy?.getInfoAsync;
    if (typeof getInfoAsync !== 'function') {
      throw new Error('expo-file-system/legacy getInfoAsync is unavailable');
    }
    const info = await getInfoAsync(flagUri);
    return info.exists === true;
  } catch (err) {
    console.error('[Platform RPC] isHeadlessCastActive error:', err);
    return false;
  }
}

/**
 * Event subscription system
 */
export const events = mainBridge.events;

async function probeBlobServerHealth(port?: number | null): Promise<boolean> {
  const healthPort = Number(port || mainBridge.getBlobServerPort() || _blobServerPort || 0) || 0;
  if (healthPort <= 0) return false;

  const fetchImpl = (globalThis as any).fetch;
  if (typeof fetchImpl !== 'function') return false;

  const AbortControllerCtor = (globalThis as any).AbortController;
  const controller = typeof AbortControllerCtor === 'function'
    ? new AbortControllerCtor()
    : null;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  try {
    const timeoutPromise = new Promise<null>((resolve) => {
      timeout = setTimeout(() => {
        try { controller?.abort?.(); } catch {}
        resolve(null);
      }, BLOB_SERVER_HEALTH_TIMEOUT_MS);
    });

    const response = await Promise.race([
      fetchImpl(`http://127.0.0.1:${healthPort}/?pt_health=1`, {
        method: 'HEAD',
        cache: 'no-store',
        signal: controller?.signal,
      }),
      timeoutPromise,
    ]);

    if (!response) return false;
    const status = Number(response.status || 0) || 0;
    return status >= 200 && status < 500;
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function resetStaleMainBridge(reason: string): Promise<void> {
  console.warn('[Platform RPC] Resetting stale native bridge:', reason);
  try {
    await mainBridge.terminate();
  } catch (err) {
    console.warn('[Platform RPC] Failed to terminate stale bridge:', (err as any)?.message || err);
  }
  _isInitialized = false;
  _startupState = 'idle';
  _blobServerPort = null;
}

async function canReuseMainBridge(reason: string): Promise<boolean> {
  if (!mainBridge.isInitialized()) return false;

  const port = mainBridge.getBlobServerPort();
  if (await probeBlobServerHealth(port)) {
    _isInitialized = true;
    _startupState = 'ready';
    _blobServerPort = typeof port === 'number' ? port : _blobServerPort;
    console.log('[Platform RPC] Reusing healthy initialized bridge:', reason);
    return true;
  }

  await resetStaleMainBridge(reason);
  return false;
}

/**
 * Initialize platform RPC for mobile
 *
 * `backendSource` remains supported for hot reload and test harnesses, but the
 * preferred path is to persist the generated bundle and start the worklet from
 * that file on subsequent launches.
 */
export async function initPlatformRPC(config: {
  backendSource?: string;
  downloaderWorkerSource?: string;
  backendVersionKey?: string;
  loadBackendSource?: () => Promise<string>;
  loadDownloaderWorkerSource?: () => Promise<string | null | undefined>;
  storagePath?: string;
  publisherSigner?: PublisherSignerBridgeLike | null;
  migrateLegacyPublisherRoot?: LegacyPublisherRootMigrationCallback;

  launchOptions?: {
    network?: Record<string, unknown>;
    swarmOptions?: Record<string, unknown>;
    player?: string;
  };
} = {}): Promise<void> {
  if (config.publisherSigner !== undefined) {
    _publisherSignerBridge = config.publisherSigner;
  }

  if (_isInitialized && await canReuseMainBridge('already initialized')) {
    return;
  }

  if (await canReuseMainBridge('shared bridge initialized')) {
    return;
  }

  if (_initPromise) {
    await _initPromise;
    return;
  }

  _initPromise = (async () => {
    _startupState = 'initializing';

    // Get dependencies at runtime
    const WorkletClass = require('react-native-bare-kit').Worklet as BareWorkletCtor;
    const FS = normalizeFsModule(require('expo-file-system'));
    const FSLegacy = normalizeFsModule(require('expo-file-system/legacy'));
    const encoding = FSLegacy.EncodingType?.UTF8 || FS.EncodingType?.UTF8 || 'utf8';

    // Determine storage path
    const storageUri = resolveStorageUri(FS, FSLegacy, config.storagePath);
    let storagePath = storageUri;
    if (storagePath.startsWith('file://')) {
      storagePath = storagePath.slice(7);
    }

    nativeRuntimeConfig.WorkletCtor = WorkletClass;
    nativeRuntimeConfig.backendSource = '';
    nativeRuntimeConfig.backendPath = '';
    nativeRuntimeConfig.storagePath = storagePath;
    nativeRuntimeConfig.workerArgs = [];

    console.log('[Platform RPC] Initializing with storage:', storagePath);

    const headlessCastActive = await isHeadlessCastActive()
    console.log('[CastDiag] initPlatformRPC: isHeadlessCastActive =', headlessCastActive)
    if (headlessCastActive) {
      console.log('[CastDiag] Headless cast was active, sending shutdown to old worklet');

      const cleanupWorklet = new WorkletClass(BACKEND_WORKLET_ID);
      try {
        await sendShutdownSignalViaIpc(cleanupWorklet);
        console.log('[CastDiag] Shutdown signal sent to old worklet');
      } catch (err: any) {
        console.warn('[CastDiag] Shutdown signal failed:', err?.message || err);
      }

      const lockUri = `${storageUri.endsWith('/') ? storageUri : storageUri + '/'}corestore/primary/LOCK`;
      const flagUri = `${storageUri.endsWith('/') ? storageUri : storageUri + '/'}${'.peartube-cast-headless'}`;

      try {
        await FSLegacy.deleteAsync(lockUri, { idempotent: true });
        console.log('[CastDiag] Deleted stale Corestore LOCK file');
      } catch (e: any) {
        console.warn('[CastDiag] Could not delete LOCK file:', e?.message);
      }

      try {
        await FSLegacy.deleteAsync(flagUri, { idempotent: true });
        console.log('[CastDiag] Cleared stale headless cast flag file');
      } catch (e: any) {
        console.warn('[CastDiag] Could not delete headless cast flag file:', e?.message);
      }

      console.log('[CastDiag] Waiting 2s for old headless worklet cleanup');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    const {
      backendPath,
      backendSource,
      downloaderWorkerPath,
    } = await resolveBundleLaunchFiles(FSLegacy, storageUri, encoding, config);

    nativeRuntimeConfig.backendPath = backendPath;
    nativeRuntimeConfig.backendSource = backendPath ? '' : backendSource;
    // OS-native player id for the playback compatibility layer (consumed by the
    // worklet only when PEARTUBE_AVPLAYER_COMPAT is enabled; harmless otherwise).
    let derivedPlayer: string | null = config.launchOptions?.player ?? null;
    if (!derivedPlayer) {
      try {
        const os = require('react-native')?.Platform?.OS;
        if (os === 'ios') derivedPlayer = 'avplayer';
        else if (os === 'android') derivedPlayer = 'exoplayer';
      } catch { /* Platform unavailable — leave player unset */ }
    }
    if (derivedPlayer && !config.launchOptions) config.launchOptions = {};
    const launchOptionsArg = config.launchOptions
      ? JSON.stringify({
        __peartubeLaunchOptions: true,
        network: config.launchOptions.network,
        swarmOptions: config.launchOptions.swarmOptions,
        player: derivedPlayer ?? undefined,
        protocolVersion: PROTOCOL_VERSION,
      })
      : null;
    nativeRuntimeConfig.workerArgs = [
      ...(launchOptionsArg ? [launchOptionsArg] : []),
      ...(downloaderWorkerPath ? [downloaderWorkerPath] : []),
    ];

    if (backendPath) {
      console.log('[Platform RPC] Backend worklet will launch from file:', backendPath);
    } else {
      console.warn('[Platform RPC] Backend bundle file cache unavailable, falling back to source launch');
    }

    if (downloaderWorkerPath) {
      console.log('[Platform RPC] Downloader worker ready:', downloaderWorkerPath);
    }

    if (typeof config.migrateLegacyPublisherRoot === 'function') {
      try {
        const summary = await runNativeLegacyPublisherRootPreflight({
          WorkletCtor: WorkletClass,
          backendPath,
          backendSource: backendPath ? '' : backendSource,
          storagePath,
          migrateLegacyPublisherRoot: config.migrateLegacyPublisherRoot,
        });
        if (summary.status === 'complete' && summary.migrated > 0) {
          console.log('[Platform RPC] Legacy publisher-root migration completed:', summary.migrated);
        }
      } catch {
        console.warn('[Platform RPC] Legacy publisher-root preflight unavailable');
      }
    }

    _startupState = 'starting-worklet';
    await mainBridge.init();
    _blobServerPort = mainBridge.getBlobServerPort();
    console.log('[Platform RPC] Worklet started');
  })();

  try {
    await _initPromise;
  } catch (err) {
    await mainBridge.terminate().catch(() => {});
    _isInitialized = false;
    _startupState = 'error';
    _blobServerPort = null;
    throw err;
  } finally {
    _initPromise = null;
  }
}

/**
 * Terminate platform RPC (for app lifecycle management).
 * Sends a graceful shutdown signal to the backend via IPC before terminating.
 * Idempotent: safe to call multiple times.
 */
export function terminatePlatformRPC(): void {
  if (_isTerminating) return;
  if (!mainBridge.isInitialized()) {
    _startupState = 'idle';
    return;
  }
  _isTerminating = true;
  _isInitialized = false;
  _startupState = 'idle';
  _blobServerPort = null;

  (async () => {
    try {
      await mainBridge.terminate();
    } catch (err) {
      console.error('[Platform RPC] Failed to terminate:', err);
    }
    _isTerminating = false;
  })().catch(() => {
    _isTerminating = false;
  });
}

/**
 * Check if RPC is initialized
 */
export function isInitialized(): boolean {
  return _isInitialized;
}

export function getStartupState(): 'idle' | 'initializing' | 'starting-worklet' | 'ready' | 'error' {
  return _startupState;
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
  const FS = normalizeFsModule(require('expo-file-system'));
  const FSLegacy = normalizeFsModule(require('expo-file-system/legacy'));

  // Terminate any existing transcode worklet, settling its pending promise
  // so the previous caller is not left hanging forever.
  if (transcodeWorklet) {
    console.log('[Platform RPC] Terminating existing transcode worklet');
    try {
      transcodeWorklet.terminate();
    } catch {}
    transcodeWorklet = null;
    if (_transcodeReject) {
      _transcodeReject(new Error('Transcode superseded by a new request'));
    }
    _transcodeResolve = null;
    _transcodeReject = null;
    _transcodeCallbacks = {};
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
      let storagePath = resolveStorageUri(FS, FSLegacy);
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
    case 'ready': {
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
    }

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
  // Settle a still-pending transcode promise (no-op after complete/error,
  // which clear these before terminating).
  if (_transcodeReject) {
    _transcodeReject(new Error('Transcode terminated'));
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
  const rpc = mainBridge.getRpc();
  if (!rpc) throw new Error('Platform RPC not initialized');
  return rpc;
}

function ensureProtocolClient() {
  const client = mainBridge.getClient();
  if (!client) throw new Error('Platform RPC not initialized');
  return client;
}

function ensurePublisherProtocolClient() {
  const client = ensureProtocolClient();
  if (!client.publisher) {
    throw new Error('Host protocol client does not expose publisher root operations');
  }
  return { publisher: client.publisher };
}

/**
 * RPC Client - Typed methods for backend communication
 * Methods accept either individual args or object params for flexibility
 */
export const rpc = {
  // Personal sync (playlists / history / settings / encryption)
  ...createPersonalRpc(ensureRPC),
  // Structured channel catalog
  ...createChannelCatalogRpc(ensureProtocolClient),
  // Typed media graph queries with bounded page presence.
  ...createMediaGraphRpc(ensureProtocolClient),
  // Bounded operability, recovery, storage-preview, and archive diagnostics
  ...createOperabilityRpc(ensureRPC),
  async authorizePublisherRootOperation(request: PublisherRootIntentRequest) {
    return createPublisherRootOperationRpc(
      ensurePublisherProtocolClient,
      mainBridge.getPublisherSigner(),
    ).authorizePublisherRootOperation(request);
  },


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

  async getVideoThumbnail(channelKeyOrReq: string | { channelKey: string; videoId: string; thumbnailBlobId?: string | null; thumbnailBlobsCoreKey?: string | null; thumbnailMimeType?: string | null }, videoId?: string) {
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
    return ensureProtocolClient().system.getSwarmStatus({});
  },

  // File pickers
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
  async getStorageStats(): Promise<StorageStatsResponse> {
    return ensureRPC().getStorageStats({});
  },

  async setStorageLimit(maxGBOrReq: number | { maxGB: number }): Promise<{ success: boolean }> {
    const req = typeof maxGBOrReq === 'number' ? { maxGB: maxGBOrReq } : maxGBOrReq;
    return ensureRPC().setStorageLimit(req);
  },




  async clearCache(): Promise<{ success: boolean; clearedBytes?: number }> {
    return ensureRPC().clearCache({});
  },

  // Seeding / pinning
  async getSeedingStatus(): Promise<{ status: { enabled: boolean; usedStorage?: number; maxStorage?: number; seedingCount?: number } }> {
    return ensureRPC().getSeedingStatus({});
  },

  async setSeedingConfig(config: { enabled?: boolean; maxStorage?: number; maxBandwidth?: number }): Promise<{ success: boolean }> {
    return ensureRPC().setSeedingConfig({ config });
  },

  async pinChannel(req: { channelKey: string }): Promise<{ success: boolean }> {
    return ensureRPC().pinChannel(req);
  },

  async unpinChannel(req: { channelKey: string }): Promise<{ success: boolean }> {
    return ensureRPC().unpinChannel(req);
  },

  async getPinnedChannels(): Promise<{ channels: string[] }> {
    return ensureRPC().getPinnedChannels({});
  },

  async retrySyncChannel(req: { channelKey: string }): Promise<{ success: boolean }> {
    return ensureRPC().retrySyncChannel(req);
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

  // Network lifecycle (background playback)
  async suspendNetwork(): Promise<{ success: boolean; error?: string }> {
    return ensureProtocolClient().system.suspendNetwork({})
  },

  async resumeNetwork(): Promise<{ success: boolean; error?: string }> {
    return ensureProtocolClient().system.resumeNetwork({})
  },

  async setPlaybackActive(req: { active: boolean; ttlMs?: number }): Promise<{ success: boolean; active: boolean }> {
    return ensureProtocolClient().system.setPlaybackActive(req)
  },

  // Channel and metadata updates
  async updateChannel(req: { name?: string; description?: string; avatar?: string }) {
    return ensureRPC().updateChannel(req);
  },

  async updateVideoMetadata(req: { channelKey: string; videoId: string; title?: string; description?: string; category?: string }) {
    return ensureRPC().updateVideoMetadata(req);
  },

  async updateChannelAvatar(req: { imageData: string; mimeType: string }) {
    return ensureRPC().updateChannelAvatar(req);
  },
};

export type RPCClient = typeof rpc;
