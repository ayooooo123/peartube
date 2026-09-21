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
  createProviderRpc,
  createPersonalRpc,
  createPublisherRootOperationRpc,
  parsePearUpdateEvent,
} from './rpc.shared';
import type {
  PearUpdateEvent,
  PearUpdateInfo,
  PearUpdatesRpc,
  PlatformRunner,
  PlatformRunnerSession,
  PublisherRootIntentRequest,
  PublisherSignerBridgeLike,
  StorageStatsResponse,
  UploadVideoRequest,
} from './rpc.shared';
// Screens render update state; they read the contract from the RPC module they
// already import, not from the shared internals.
export type { PearUpdateEvent, PearUpdateInfo, PearUpdateState, PearUpdatesRpc } from './rpc.shared';
import { createNativeRunner } from './runner.native';
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
/** Metro/React Native build flag; absent outside the app bundle. */
declare const __DEV__: boolean | undefined;


// Module state
let _blobServerPort: number | null = null;
let _initPromise: Promise<void> | null = null;
let _isInitialized = false;
let _startupState: 'idle' | 'initializing' | 'starting-worklet' | 'ready' | 'error' = 'idle';
let _isTerminating = false;
let _terminatePromise: Promise<void> | null = null;
let _publisherSignerBridge: PublisherSignerBridgeLike | null = null;
const BACKEND_WORKLET_ID = '/peartube-backend-core.bundle'
const SHUTDOWN_TIMEOUT_MS = 4000
const BLOB_SERVER_HEALTH_TIMEOUT_MS = 1500

// Pear OTA update control frames, mirrored from packages/app/backend/index.mjs.
const PEAR_UPDATE_EVENT_TYPE = 'pear-update'
const PEAR_UPDATE_REQUEST_TYPE = 'pear-update-request'
const PEAR_UPDATE_RESPONSE_TYPE = 'pear-update-response'
const PEAR_UPDATE_REQUEST_TIMEOUT_MS = 60000

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

const workletRunner = createNativeRunner({
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

// The Pear updater talks over the worklet's raw IPC pipe, not HRPC, so the
// update namespace needs the stream the bridge otherwise keeps to itself.
const mainRunner: PlatformRunner = {
  async start(options): Promise<PlatformRunnerSession> {
    const session = await workletRunner.start(options);
    attachPearUpdateTransport(session.stream);
    return session;
  },
};

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

// ============================================
// Pear OTA updates
// ============================================
//
// The updater lives in the Bare worklet; this side only observes state and
// asks for the swap. Frames share the worklet's JSON control channel with the
// shutdown handshake, so the listener set outlives any single worklet and a
// relaunch simply rebinds.

type WorkletIpcStream = {
  on(event: string, listener: (chunk: unknown) => void): void;
  write?(payload: unknown): void;
};

type PearUpdatePending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cancel(): void;
};

const pearUpdateListeners: Array<(event: PearUpdateEvent) => void> = [];
// Keyed by an incrementing request id, inserted and deleted per round trip.
const pearUpdatePending = new Map<number, PearUpdatePending>();
let pearUpdateTransport: WorkletIpcStream | null = null;
let pearUpdateRequestSeq = 0;

function settlePearUpdateResponse(message: Record<string, unknown>): void {
  const id = message.id;
  if (typeof id !== 'number') return;
  const pending = pearUpdatePending.get(id);
  if (!pending) return;

  pearUpdatePending.delete(id);
  pending.cancel();

  if (message.ok === true) {
    pending.resolve(message.result ?? null);
    return;
  }
  pending.reject(new Error(typeof message.error === 'string' ? message.error : 'Pear update request failed'));
}

function failPearUpdateRequests(reason: string): void {
  for (const [id, pending] of pearUpdatePending) {
    pearUpdatePending.delete(id);
    pending.cancel();
    pending.reject(new Error(reason));
  }
}

function attachPearUpdateTransport(ipc: WorkletIpcStream | null | undefined): void {
  if (typeof ipc?.on !== 'function' || pearUpdateTransport === ipc) return;

  pearUpdateTransport = ipc;
  failPearUpdateRequests('Backend worklet restarted');

  const parser = createJsonFrameParser();

  ipc.on('data', (chunk: unknown) => {
    for (const message of parser.push(chunk)) {
      if (message?.type === PEAR_UPDATE_EVENT_TYPE) {
        // Untrusted frame: a malformed payload is dropped rather than shown.
        const event = parsePearUpdateEvent(message);
        if (!event) continue;
        for (const listener of pearUpdateListeners.slice()) {
          try {
            listener(event);
          } catch (error) {
            console.error('[Platform RPC] Pear update listener failed:', error);
          }
        }
        continue;
      }

      if (message?.type === PEAR_UPDATE_RESPONSE_TYPE) settlePearUpdateResponse(message);
    }
  });

  ipc.on('close', () => {
    if (pearUpdateTransport !== ipc) return;
    pearUpdateTransport = null;
    failPearUpdateRequests('Backend transport closed');
  });
}

function requestPearUpdate(action: 'apply' | 'info'): Promise<unknown> {
  const write = pearUpdateTransport?.write;
  if (typeof write !== 'function') {
    return Promise.reject(new Error('Pear updates are unavailable: backend worklet is not running'));
  }
  const transport = pearUpdateTransport;

  const id = ++pearUpdateRequestSeq;

  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pearUpdatePending.delete(id);
      reject(new Error(`Pear update request timed out: ${action}`));
    }, PEAR_UPDATE_REQUEST_TIMEOUT_MS);

    pearUpdatePending.set(id, { resolve, reject, cancel: () => clearTimeout(timer) });

    try {
      write.call(transport, Buffer.from(encodeJsonFrame({ type: PEAR_UPDATE_REQUEST_TYPE, id, action })));
    } catch (error) {
      pearUpdatePending.delete(id);
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function resolveDevSettings(): { reload?: (reason?: string) => void } | null {
  try {
    return require('react-native')?.DevSettings ?? null;
  } catch {
    return null;
  }
}

const pearUpdatesRpc: PearUpdatesRpc = {
  onEvent(listener: (event: PearUpdateEvent) => void) {
    pearUpdateListeners.push(listener);
    return () => {
      const index = pearUpdateListeners.indexOf(listener);
      if (index !== -1) pearUpdateListeners.splice(index, 1);
    };
  },

  async apply(): Promise<void> {
    await requestPearUpdate('apply');
  },

  async restart(): Promise<void> {
    const devSettings = resolveDevSettings();
    if (typeof devSettings?.reload !== 'function') {
      throw new Error('Cannot restart: react-native DevSettings.reload is unavailable in this build');
    }

    // The worklet is a native thread that outlives a JS reload and it holds the
    // Corestore owner lock, so the reloaded bundle would fail to open storage.
    // Terminate it first and wait for the handshake.
    terminatePlatformRPC();
    try {
      await _terminatePromise;
    } catch {}

    // iOS re-reads bundleURL() on reload and picks up the applied payload.
    // Android caches jsBundleFilePath when the React host is created, so there
    // the swap lands on the next full process start instead.
    devSettings.reload('peartube-pear-ota');
  },

  async info(): Promise<PearUpdateInfo> {
    return await requestPearUpdate('info') as PearUpdateInfo;
  },
};

/**
 * Send a shutdown signal via IPC and wait for acknowledgment.
 * Resolves when shutdown-complete is received or rejects on timeout.
 */
function sendShutdownSignalViaIpc(instance: InstanceType<BareWorkletCtor>): Promise<void> {
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
async function terminateWorkletWithDelay(instance: InstanceType<BareWorkletCtor> | null): Promise<void> {
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

type ExpoFile = {
  readonly uri: string;
  readonly exists: boolean;
  text(): Promise<string>;
  write(content: string): void;
  delete(): void;
};

type ExpoFileSystemModule = {
  File?: new (uri: string) => ExpoFile;
  Paths?: {
    document?: { uri?: string };
    cache?: { uri?: string };
  };
};

function openFile(FS: ExpoFileSystemModule | null | undefined, uri: string): ExpoFile | null {
  const FileCtor = FS?.File;
  if (typeof FileCtor !== 'function') return null;
  try {
    return new FileCtor(uri);
  } catch {
    return null;
  }
}

function fileExists(FS: ExpoFileSystemModule, uri: string): boolean {
  const file = openFile(FS, uri);
  if (!file) return false;
  try {
    return file.exists === true;
  } catch {
    return false;
  }
}

function deleteFileIfPresent(FS: ExpoFileSystemModule, uri: string): void {
  const file = openFile(FS, uri);
  if (!file || file.exists !== true) return;
  file.delete();
}

function resolveStorageUri(FS: ExpoFileSystemModule, configuredPath?: string): string {
  if (configuredPath && configuredPath.length > 0) {
    return configuredPath.startsWith('file://') ? configuredPath : `file://${configuredPath}`;
  }

  const candidates = [
    FS?.Paths?.document?.uri,
    FS?.Paths?.cache?.uri,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }

  throw new Error('No writable storage directory available from expo-file-system');
}

function normalizeFsModule(mod: unknown): ExpoFileSystemModule {
  // Metro hands back either the module namespace or a CJS interop wrapper whose
  // real exports hang off `.default`; both shapes expose the same surface.
  const namespace = mod as ExpoFileSystemModule & { default?: ExpoFileSystemModule };
  return namespace?.default ?? namespace;
}

async function readOptionalTextAsync(FS: ExpoFileSystemModule, uri: string): Promise<string | null> {
  const file = openFile(FS, uri);
  if (!file) return null;

  try {
    const value = await file.text();
    return typeof value === 'string' ? value.trim() : null;
  } catch {
    return null;
  }
}

// `File.write` creates the file when it is missing on both iOS and Android.
function writeOptionalText(FS: ExpoFileSystemModule, uri: string, contents: string): boolean {
  const file = openFile(FS, uri);
  if (!file) return false;

  try {
    file.write(contents);
    return true;
  } catch {
    return false;
  }
}

async function inspectPersistedBundleCache(
  FS: ExpoFileSystemModule,
  backendBundleUri: string,
  downloaderWorkerUri: string,
  versionMarkerUri: string,
): Promise<{
  backendBundleExists: boolean;
  downloaderWorkerExists: boolean;
  cachedVersionKey: string | null;
}> {
  return {
    backendBundleExists: fileExists(FS, backendBundleUri),
    downloaderWorkerExists: fileExists(FS, downloaderWorkerUri),
    cachedVersionKey: await readOptionalTextAsync(FS, versionMarkerUri),
  };
}

async function resolveConfiguredBackendSource(config: {
  backendSource?: string;
  loadBackendSource?: () => Promise<string>;
}): Promise<string> {
  let backendSource = typeof config.backendSource === 'string' ? config.backendSource : '';
  if (!backendSource && typeof config.loadBackendSource === 'function') {
    const loaded = await config.loadBackendSource();
    backendSource = typeof loaded === 'string' ? loaded : '';
  }

  if (!backendSource) {
    throw new Error('Native backend source is not configured');
  }

  return backendSource;
}

async function resolveDownloaderWorkerPath(
  FS: ExpoFileSystemModule,
  downloaderWorkerUri: string,
  config: {
    downloaderWorkerSource?: string;
    loadDownloaderWorkerSource?: () => Promise<string | null | undefined>;
  },
): Promise<string> {
  let downloaderWorkerSource =
    typeof config.downloaderWorkerSource === 'string'
      ? config.downloaderWorkerSource
      : '';

  if (!downloaderWorkerSource && typeof config.loadDownloaderWorkerSource === 'function') {
    const loaded = await config.loadDownloaderWorkerSource();
    downloaderWorkerSource = typeof loaded === 'string' ? loaded : '';
  }

  if (downloaderWorkerSource && writeOptionalText(FS, downloaderWorkerUri, downloaderWorkerSource)) {
    return normalizeBundleFilePath(downloaderWorkerUri);
  }

  return '';
}

async function resolveBundleLaunchFiles(
  FS: ExpoFileSystemModule,
  storageUri: string,
  config: {
    backendSource?: string;
    downloaderWorkerSource?: string;
    backendVersionKey?: string;
    loadBackendSource?: () => Promise<string>;
    loadDownloaderWorkerSource?: () => Promise<string | null | undefined>;
  },
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

  const needsDownloaderWorker = Boolean(
    config.downloaderWorkerSource || config.loadDownloaderWorkerSource,
  );

  const cacheState = await inspectPersistedBundleCache(
    FS,
    backendBundleUri,
    downloaderWorkerUri,
    versionMarkerUri,
  );

  const expectedVersionKey = config.backendVersionKey ?? '';
  if (shouldReusePersistedBundleCache({
    expectedVersionKey,
    cachedVersionKey: cacheState.cachedVersionKey,
    backendBundleExists: cacheState.backendBundleExists,
    downloaderWorkerExists: cacheState.downloaderWorkerExists,
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

  const backendSource = await resolveConfiguredBackendSource(config);

  const backendPath = writeOptionalText(FS, backendBundleUri, backendSource)
    ? normalizeBundleFilePath(backendBundleUri)
    : '';

  const downloaderWorkerPath = needsDownloaderWorker
    ? await resolveDownloaderWorkerPath(FS, downloaderWorkerUri, config)
    : '';

  if (backendPath && expectedVersionKey) {
    writeOptionalText(FS, versionMarkerUri, expectedVersionKey);
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
    const storageUri = resolveStorageUri(FS);
    const flagUri = storageUri.endsWith('/')
      ? `${storageUri}.peartube-cast-headless`
      : `${storageUri}/.peartube-cast-headless`;
    const flagFile = openFile(FS, flagUri);
    if (!flagFile) {
      throw new Error('expo-file-system File constructor is unavailable');
    }
    return flagFile.exists === true;
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
async function cleanupHeadlessCastIfActive(
  WorkletClass: BareWorkletCtor,
  FS: ExpoFileSystemModule,
  storageUri: string,
): Promise<void> {
  const headlessCastActive = await isHeadlessCastActive();
  console.log('[CastDiag] initPlatformRPC: isHeadlessCastActive =', headlessCastActive);
  if (!headlessCastActive) return;

  console.log('[CastDiag] Headless cast was active, sending shutdown to old worklet');

  const cleanupWorklet = new WorkletClass(BACKEND_WORKLET_ID);
  try {
    await sendShutdownSignalViaIpc(cleanupWorklet);
    console.log('[CastDiag] Shutdown signal sent to old worklet');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[CastDiag] Shutdown signal failed:', message);
  }

  const lockUri = `${storageUri.endsWith('/') ? storageUri : storageUri + '/'}corestore/primary/LOCK`;
  const flagUri = `${storageUri.endsWith('/') ? storageUri : storageUri + '/'}${'.peartube-cast-headless'}`;

  try {
    deleteFileIfPresent(FS, lockUri);
    console.log('[CastDiag] Deleted stale Corestore LOCK file');
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn('[CastDiag] Could not delete LOCK file:', message);
  }

  try {
    deleteFileIfPresent(FS, flagUri);
    console.log('[CastDiag] Cleared stale headless cast flag file');
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn('[CastDiag] Could not delete headless cast flag file:', message);
  }

  console.log('[CastDiag] Waiting 2s for old headless worklet cleanup');
  await new Promise<void>((resolve) => setTimeout(resolve, 2000));
}

function resolveNativePlayer(configuredPlayer?: string | null): string | null {
  if (configuredPlayer) return configuredPlayer;
  try {
    const os = require('react-native')?.Platform?.OS;
    if (os === 'ios') return 'avplayer';
    if (os === 'android') return 'exoplayer';
  } catch {
    /* Platform unavailable — leave player unset */
  }
  return null;
}

function buildNativeWorkerArgs(
  config: {
    launchOptions?: {
      network?: Record<string, unknown>;
      swarmOptions?: Record<string, unknown>;
      player?: string;
    };
  },
  downloaderWorkerPath: string,
): string[] {
  const derivedPlayer = resolveNativePlayer(config.launchOptions?.player);
  if (derivedPlayer && !config.launchOptions) {
    config.launchOptions = {};
  }
  // The worklet has no `__DEV__`, and the Pear updater needs it: a debug run
  // must mirror a payload immediately instead of somewhere inside the
  // randomised production delay window.
  const debug = typeof __DEV__ !== 'undefined' && __DEV__ === true;
  const launchOptionsArg = config.launchOptions
    ? JSON.stringify({
      __peartubeLaunchOptions: true,
      network: config.launchOptions.network,
      swarmOptions: config.launchOptions.swarmOptions,
      player: derivedPlayer ?? undefined,
      protocolVersion: PROTOCOL_VERSION,
      debug: debug || undefined,
    })
    : null;

  return [
    ...(launchOptionsArg ? [launchOptionsArg] : []),
    ...(downloaderWorkerPath ? [downloaderWorkerPath] : []),
  ];
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

    // Determine storage path
    const storageUri = resolveStorageUri(FS, config.storagePath);
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

    await cleanupHeadlessCastIfActive(WorkletClass, FS, storageUri);

    const {
      backendPath,
      backendSource,
      downloaderWorkerPath,
    } = await resolveBundleLaunchFiles(FS, storageUri, config);

    nativeRuntimeConfig.backendPath = backendPath;
    nativeRuntimeConfig.backendSource = backendPath ? '' : backendSource;
    nativeRuntimeConfig.workerArgs = buildNativeWorkerArgs(config, downloaderWorkerPath);

    if (backendPath) {
      console.log('[Platform RPC] Backend worklet will launch from file:', backendPath);
    } else {
      console.warn('[Platform RPC] Backend bundle file cache unavailable, falling back to source launch');
    }

    if (downloaderWorkerPath) {
      console.log('[Platform RPC] Downloader worker ready:', downloaderWorkerPath);
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
  // `updates.restart()` has to know when the worklet is actually gone before it
  // reloads the bundle, so the in-flight teardown is retained.
  if (_isTerminating) return;
  if (!mainBridge.isInitialized()) {
    _startupState = 'idle';
    _terminatePromise = null;
    return;
  }
  _isTerminating = true;
  _isInitialized = false;
  _startupState = 'idle';
  _blobServerPort = null;

  _terminatePromise = (async () => {
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
  // Provider/acquisition facade shared byte-for-byte with desktop.
  provider: createProviderRpc(ensureProtocolClient),
  // Pear OTA updates; identical surface on desktop, so screens never branch.
  updates: pearUpdatesRpc,
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

  async uploadVideo(filePathOrReq: string | UploadVideoRequest, title?: string, description?: string, category?: string) {
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
