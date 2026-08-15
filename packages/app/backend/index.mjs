/* eslint-disable no-empty, no-undef, @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-expressions */
/**
 * PearTube Mobile Backend Entry
 *
 * The module now exposes a testable `startMobileBackend()` entry that routes
 * lifecycle through `@peartube/host`, while preserving the existing BareKit
 * mobile runtime under the default `createMobileRuntimeBackend()` path.
 */

import { startMobileBackend as startMobileBackendContract } from './mobile-start.mjs'
import { createJsonFrameParser, encodeJsonFrame } from '@peartube/platform/ipc-json-framing'
import * as specModule from '@peartube/spec'
import * as orchestratorModule from '@peartube/backend/orchestrator'
import * as storageModule from '@peartube/backend/storage'
import { setHyperswarmModuleForRuntime } from '@peartube/backend/runtime-modules'
import { isExpectedBlobRequestCancellation } from '@peartube/backend/blob-request-cancellation'
import { runLegacyPublisherRootPreflight } from '@peartube/backend/legacy-publisher-root-preflight'

import * as pathModule from 'bare-path'
import * as fsModule from 'bare-fs'
import * as b4aModule from 'b4a'
import { attachMobileHandlers } from '@peartube/backend/mobile-handlers'
import { registerSharedHandlers } from '@peartube/backend/hrpc-handlers'
import { attachLazyCastHandlers } from './lazy-cast-handlers.mjs'
import { attachCastHandlers as importedAttachCastHandlers } from './mobile-cast.mjs'
import * as mobileTranscoderModule from './transcoder.mjs'
import * as mobileCastTranscoderModule from '@peartube/backend/transcode/cast-transcoder'
import * as http1Module from 'bare-http1'
import HyperswarmModule from 'hyperswarm'

let HRPC = null
let createBackendContext = null
let shutdownBackend = null
let setCastActive = null
let isCastActive = null
let prefetchVideoForCast = null
let prepareStoredProtocolState = null
let storedProtocolMigrations = null
let generateAndStoreThumbnail = null
let path = null
let fs = null
let b4a = null
let http1 = null
let transcoder = null
let castTranscoder = null
let fsNativeExtensions = null
let attachCastHandlers = null
let transcoderPromise = null
let castTranscoderPromise = null
let thumbnailModule = null
let thumbnailModulePromise = null
let httpModulePromise = null
let fsNativeExtensionsPromise = null

async function loadBackendModules() {
  // libqjs/Bare worklets do not support runtime dynamic module loading, so every module that
  // is required for startup must be statically imported at bundle evaluation
  // time. Optional feature modules remain lazy below.
  setHyperswarmModuleForRuntime(HyperswarmModule)
  HRPC = specModule?.default ?? specModule
  createBackendContext = orchestratorModule?.createBackendContext
  shutdownBackend = storageModule?.shutdownBackend
  setCastActive = storageModule?.setCastActive
  isCastActive = storageModule?.isCastActive
  prefetchVideoForCast = storageModule?.prefetchVideoForCast
  prepareStoredProtocolState = storageModule?.prepareStoredProtocolState
  storedProtocolMigrations = storageModule?.DEFAULT_STORED_PROTOCOL_MIGRATIONS
  path = pathModule?.default ?? pathModule
  fs = fsModule?.default ?? fsModule
  b4a = b4aModule?.default ?? b4aModule
  transcoder = mobileTranscoderModule
  castTranscoder = mobileCastTranscoderModule
  http1 = http1Module?.default ?? http1Module

  const checks = {
    HRPC,
    createBackendContext,
    shutdownBackend,
    setCastActive,
    isCastActive,
    prefetchVideoForCast,
    prepareStoredProtocolState,
    storedProtocolMigrations,
    path,
    fs,
    b4a
  }

  const missing = Object.entries(checks)
    .filter(([, value]) => !value)
    .map(([name]) => name)

  if (missing.length) {
    throw new Error(`Missing required backend modules: ${missing.join(', ')}`)
  }
}

async function ensureBackendThumbnailModule() {
  if (thumbnailModule) return thumbnailModule
  if (!thumbnailModulePromise) {
    thumbnailModulePromise = import('@peartube/backend/thumbnail')
      .then((module) => {
        thumbnailModule = module
        generateAndStoreThumbnail = module?.generateAndStoreThumbnail
        return module
      })
      .catch((error) => {
        thumbnailModulePromise = null
        throw error
      })
  }

  return thumbnailModulePromise
}

async function ensureHttpModule() {
  if (http1) return http1
  if (!httpModulePromise) {
    httpModulePromise = import('bare-http1')
      .then((module) => {
        http1 = module?.default ?? module
        return http1
      })
      .catch((error) => {
        httpModulePromise = null
        throw error
      })
  }

  return httpModulePromise
}

async function ensureFsNativeExtensionsModule() {
  if (fsNativeExtensions) return fsNativeExtensions
  if (!fsNativeExtensionsPromise) {
    fsNativeExtensionsPromise = import('fs-native-extensions')
      .then((module) => {
        fsNativeExtensions = module?.default ?? module
        return fsNativeExtensions
      })
      .catch(() => {
        fsNativeExtensions = null
        return null
      })
  }

  return fsNativeExtensionsPromise
}

async function ensureTranscoderModule() {
  if (transcoder) return transcoder
  if (!transcoderPromise) {
    transcoderPromise = import('./transcoder.mjs')
      .then((module) => {
        transcoder = module
        return module
      })
      .catch((error) => {
        transcoderPromise = null
        throw error
      })
  }

  return transcoderPromise
}

async function ensureCastTranscoderModule() {
  if (castTranscoder) return castTranscoder
  if (!castTranscoderPromise) {
    castTranscoderPromise = import('@peartube/backend/transcode/cast-transcoder')
      .then((module) => {
        castTranscoder = module
        return module
      })
      .catch((error) => {
        castTranscoderPromise = null
        throw error
      })
  }

  return castTranscoderPromise
}

function ensureMobileCastHandlers() {
  if (attachCastHandlers) return attachCastHandlers

  attachCastHandlers = importedAttachCastHandlers

  if (typeof attachCastHandlers !== 'function') {
    throw new Error('Missing mobile cast handlers')
  }

  return attachCastHandlers
}

// Lazy cast-transcoder wrapper for the AVPlayer/OS-native compatibility layer.
function createLazyCastTranscoder() {
  return {
    async startCompatTranscode(...args) {
      const module = await ensureCastTranscoderModule()
      return module.startCompatTranscode(...args)
    },
    async getCastHlsUrl(...args) {
      const module = await ensureCastTranscoderModule()
      return module.getCastHlsUrl(...args)
    },
    async getCastStatus(...args) {
      const module = await ensureCastTranscoderModule()
      return module.getCastStatus(...args)
    },
  }
}

function formatError(error) {
  if (!error) return 'Unknown error'
  if (error instanceof Error) return error.stack || error.message || String(error)
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function attachUnhandledHandlers(reportBackendError) {
  const consumeExpectedCancellation = (reason) => {
    try {
      return isExpectedBlobRequestCancellation(reason)
    } catch {
      return false
    }
  }

  if (typeof Bare !== 'undefined' && Bare?.on) {
    Bare.on('unhandledRejection', (reason) => {
      if (consumeExpectedCancellation(reason)) return true
      try {
        console.error('[Backend] Unhandled rejection:', formatError(reason))
      } catch {}
      return true
    })

    Bare.on('uncaughtException', (error) => {
      try {
        console.error('[Backend] Uncaught exception:', formatError(error))
      } catch {}
      return true
    })
  }

  const proc = typeof process !== 'undefined' ? process : null
  if (proc?.on) {
    proc.on('unhandledRejection', (reason) => {
      if (consumeExpectedCancellation(reason)) return
      reportBackendError('Unhandled rejection', reason)
    })
    proc.on('uncaughtException', (error) => reportBackendError('Uncaught exception', error))
  }

  if (typeof globalThis?.addEventListener === 'function') {
    globalThis.addEventListener('unhandledrejection', (event) => {
      if (consumeExpectedCancellation(event?.reason ?? event)) {
        event?.preventDefault?.()
        return
      }
      reportBackendError('Unhandled rejection', event?.reason ?? event)
      event?.preventDefault?.()
    })

    globalThis.addEventListener('error', (event) => {
      reportBackendError('Uncaught error', event?.error ?? event?.message ?? event)
    })
  }
}

function attachMobileOnlyRpcHandlers(rpc, api) {
  if (typeof rpc.onSearchVideos === 'function') {
    rpc.onSearchVideos(async (request) => {
      try {
        const raw = await api.searchVideos(request.channelKey, request.query, {
          topK: request.topK || 10,
          federated: Boolean(request.federated)
        })

        return {
          results: (raw || []).map((result) => ({
            id: String(result.id || ''),
            score: result.score != null ? String(result.score) : null,
            metadata: result.metadata ? JSON.stringify(result.metadata) : null
          }))
        }
      } catch {
        return { results: [] }
      }
    })
  }

  if (typeof rpc.onGetRecommendations === 'function') {
    rpc.onGetRecommendations(async () => ({ success: true, recommendations: [] }))
  }

  if (typeof rpc.onGetVideoRecommendations === 'function') {
    rpc.onGetVideoRecommendations(async () => ({ success: true, recommendations: [] }))
  }

  if (typeof rpc.onIndexVideoVectors === 'function') {
    rpc.onIndexVideoVectors(async (request) => {
      try {
        const result = await api.indexVideoVectors?.(request.channelKey, request.videoId)
        return { success: Boolean(result?.success), error: result?.error || null }
      } catch (error) {
        return { success: false, error: error?.message }
      }
    })
  }

  if (typeof rpc.onLogWatchEvent === 'function') {
    rpc.onLogWatchEvent(async () => ({ success: true }))
  }

  if (typeof rpc.onRetrySyncChannel === 'function') {
    rpc.onRetrySyncChannel(async (request) => {
      try {
        await api.retrySyncChannel?.(request.channelKey)
        return { success: true }
      } catch (error) {
        return { success: false, error: error?.message }
      }
    })
  }
}

export function parseMobileLaunchArgsForTest(args = []) {
  const candidates = [0, 1]
  for (const index of candidates) {
    const arg = args[index]
    if (typeof arg !== 'string' || !arg.trim().startsWith('{')) continue
    try {
      const parsed = JSON.parse(arg)
      if (parsed?.__peartubeLaunchOptions === true) {
        return { launchOptions: parsed, workerArgs: [...args.slice(0, index), ...args.slice(index + 1)].filter((value) => value !== 'mobile-entry') }
      }
    } catch {}
  }

  const workerArgs = args[0] === 'mobile-entry' ? args.slice(1) : args
  return { launchOptions: null, workerArgs }
}

function parseMobileLaunchArgs(args = []) {
  return parseMobileLaunchArgsForTest(args)
}

const LEGACY_ROOT_PREFLIGHT_ENTRYPOINT = 'legacy-publisher-root-preflight'
const LEGACY_ROOT_MAX_FRAME_BYTES = 8192
const LEGACY_ROOT_MAX_REQUESTS = 64
const LEGACY_ROOT_ACK_TIMEOUT_MS = 25000

function fixedLegacyRootBytes(value, length, bytes) {
  let result = null
  if (typeof value === 'string' && value.length === length * 2 && /^[0-9a-f]+$/i.test(value)) {
    result = bytes.from(value, 'hex')
  } else if (bytes.isBuffer(value) || value instanceof Uint8Array) {
    result = bytes.from(value)
  }
  return result?.byteLength === length ? result : null
}

function safeLegacyRootPreflightSummary(value) {
  const status = ['complete', 'pending', 'no-legacy-roots', 'unavailable'].includes(value?.status)
    ? value.status
    : 'unavailable'
  const count = (candidate) => Number.isFinite(candidate) && candidate > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(candidate))
    : 0
  const summary = {
    status,
    scanned: count(value?.scanned),
    migrated: count(value?.migrated),
    remaining: count(value?.remaining),
  }
  if (
    status === 'unavailable' &&
    ['STORAGE_LOCKED', 'STORAGE_UNAVAILABLE', 'MIGRATION_UNAVAILABLE'].includes(value?.errorCode)
  ) {
    summary.errorCode = value.errorCode
  }
  return summary
}

export async function startLegacyPublisherRootPreflightWorklet(options = {}) {
  const IPC = options.stream ?? globalThis.BareKit?.IPC
  const storagePath = options.storagePath ?? globalThis.Bare?.argv?.[0] ?? ''
  const bytes = b4aModule?.default ?? b4aModule
  const paths = pathModule?.default ?? pathModule
  if (!IPC?.on || !IPC?.write || !storagePath) {
    return safeLegacyRootPreflightSummary(null)
  }

  const parser = createJsonFrameParser()
  let pendingFrameBytes = 0
  let requestCount = 0
  let pending = null

  const clearPending = () => {
    if (!pending) return
    clearTimeout(pending.timer)
    pending = null
  }

  const rejectPending = () => {
    if (!pending) return
    const reject = pending.reject
    clearPending()
    reject(new Error('MIGRATION_UNAVAILABLE'))
  }

  const onData = (chunk) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk ?? '')
    pendingFrameBytes += text.length
    if (pendingFrameBytes > LEGACY_ROOT_MAX_FRAME_BYTES) {
      parser.reset()
      pendingFrameBytes = 0
      rejectPending()
      return
    }

    const messages = parser.push(text)
    if (messages.length > 0) pendingFrameBytes = 0
    for (const message of messages) {
      if (message?.type !== 'legacy-publisher-root-migration-ack' ||
          !pending ||
          message.id !== pending.id) continue

      const resolve = pending.resolve
      if (
        message.ok !== true ||
        message.version !== 1 ||
        message.durable !== true
      ) {
        rejectPending()
        continue
      }
      const publicKey = fixedLegacyRootBytes(message.publicKey, 32, bytes)
      const challengeSignature = fixedLegacyRootBytes(message.challengeSignature, 64, bytes)
      if (!publicKey || !challengeSignature) {
        rejectPending()
        continue
      }
      clearPending()
      resolve({
        version: 1,
        durable: true,
        publicKey,
        challengeSignature,
      })
    }
  }

  const onClose = () => rejectPending()
  IPC.on('data', onData)
  IPC.on('close', onClose)
  IPC.on('end', onClose)

  const migrateLegacyPublisherRoot = async (request) => {
    if (pending || requestCount >= LEGACY_ROOT_MAX_REQUESTS) {
      throw new Error('MIGRATION_UNAVAILABLE')
    }
    const identityPublicKey = fixedLegacyRootBytes(request?.identityPublicKey, 32, bytes)
    const secretKey = fixedLegacyRootBytes(request?.secretKey, 64, bytes)
    const challenge = fixedLegacyRootBytes(request?.challenge, 108, bytes)
    if (request?.version !== 1 || !identityPublicKey || !secretKey || !challenge) {
      secretKey?.fill(0)
      challenge?.fill(0)
      throw new Error('MIGRATION_UNAVAILABLE')
    }

    requestCount += 1
    const id = requestCount
    let encoded = encodeJsonFrame({
      type: 'legacy-publisher-root-migration-request',
      id,
      version: 1,
      identityPublicKey: bytes.toString(identityPublicKey, 'hex'),
      secretKey: bytes.toString(secretKey, 'hex'),
      challenge: bytes.toString(challenge, 'hex'),
    })
    secretKey.fill(0)
    challenge.fill(0)
    if (encoded.length > LEGACY_ROOT_MAX_FRAME_BYTES) {
      encoded = ''
      throw new Error('MIGRATION_UNAVAILABLE')
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending?.id !== id) return
        clearPending()
        reject(new Error('MIGRATION_UNAVAILABLE'))
      }, LEGACY_ROOT_ACK_TIMEOUT_MS)
      pending = { id, resolve, reject, timer }
      try {
        IPC.write(bytes.from(encoded))
      } catch {
        clearPending()
        reject(new Error('MIGRATION_UNAVAILABLE'))
      } finally {
        encoded = ''
      }
    })
  }

  let summary
  try {
    summary = safeLegacyRootPreflightSummary(await runLegacyPublisherRootPreflight({
      storagePath: paths.join(storagePath, 'peartube-data'),
      migrateLegacyPublisherRoot,
      waitForLock: false,
    }))
  } catch {
    summary = safeLegacyRootPreflightSummary(null)
  } finally {
    rejectPending()
    try { IPC.removeListener?.('data', onData) } catch {}
    try { IPC.removeListener?.('close', onClose) } catch {}
    try { IPC.removeListener?.('end', onClose) } catch {}
  }

  try {
    const resultFrame = encodeJsonFrame({
      type: 'legacy-publisher-root-preflight-result',
      summary,
    })
    if (resultFrame.length <= LEGACY_ROOT_MAX_FRAME_BYTES) IPC.write(bytes.from(resultFrame))
  } catch {}
  return summary
}

export function buildMobileBackendContextOptions(options = {}) {
  return { ...options, platform: 'mobile' }
}

export async function startMobileBackend(options = {}) {
  return startMobileBackendContract({
    createBackendImpl: createMobileRuntimeBackend,
    ...options
  })
}

export async function createMobileRuntimeBackend(options = {}) {
  const {
    storagePath,
    platform = 'mobile',
    stream,
    args = [],
    protocolVersion,
    onReady = () => {},
    onError = () => {}
  } = options

  if (!stream) throw new Error('createMobileRuntimeBackend requires a stream transport')
  if (!storagePath) throw new Error('createMobileRuntimeBackend requires a storagePath')
  if (platform !== 'mobile') throw new Error('createMobileRuntimeBackend requires the mobile platform')

  const IPC = stream
  const { launchOptions, workerArgs } = parseMobileLaunchArgs(args)
  const workerBundlePath = workerArgs[0] || ''
  if (workerBundlePath) globalThis.__PEARTUBE_WORKER_PATH__ = workerBundlePath

  // OS-native-player compatibility layer. launchOptions.player ('avplayer' on
  // iOS / 'exoplayer' on Android) is supplied by the RN side; preparePlayback
  // can then route unstreamable/unsupported direct blob URLs through local HLS.
  // Keep an env opt-out for debugging native-player regressions.
  const nativePlayerCompatDisabled =
    globalThis.process?.env?.PEARTUBE_NATIVE_PLAYER_COMPAT === '0' ||
    globalThis.process?.env?.PEARTUBE_AVPLAYER_COMPAT === '0'
  const compatDeps = (!nativePlayerCompatDisabled && launchOptions?.player)
    ? { player: launchOptions.player, castTranscoder: createLazyCastTranscoder() }
    : {}

  let rpc = null
  let handlersRegistered = false
  let ownerLockFd = -1
  let backendCtx = null
  let closeCastProxyServer = () => {}
  let shutdownInFlight = null

  function reportBackendError(label, error) {
    const message = error instanceof Error ? error.message : (typeof error === 'string' ? error : 'Unknown error')
    const code = typeof error?.code === 'string' ? error.code : undefined
    const readinessMessage = code === 'STORED_PROTOCOL_VERSION_UNSUPPORTED'
      ? `${label}: ${message} (storedVersion=${Number.isSafeInteger(error?.storedVersion) ? error.storedVersion : 'unknown'}, expectedVersion=${Number.isSafeInteger(error?.expectedVersion) ? error.expectedVersion : 'unknown'})`
      : `${label}: ${message}`
    console.error(`[Backend] ${label}:`, message)
    if (error?.stack) console.error(error.stack)
    try {
      rpc?.eventError?.({ code, message: readinessMessage, retryable: false })
    } catch {}
    try {
      onError(error instanceof Error ? error : new Error(message))
    } catch {}
  }

  function ensureRpc() {
    if (rpc) return true

    try {
      rpc = new HRPC(IPC)

      try {
        const rawRpc = rpc?._rpc
        if (rawRpc && !rawRpc._peartubeCompat) {
          const originalOnRequest = rawRpc._onrequest
          rawRpc._onrequest = async (request) => {
            try {
              const hasPayload = Boolean(request?.data && request.data.length > 0)
              if (request?.command === 16 && !hasPayload) request.command = 18
              if (request?.command === 24 && hasPayload) request.command = 30
            } catch {}

            if (!handlersRegistered) throw new Error('Backend not ready')

            try {
              return await originalOnRequest(request)
            } catch (error) {
              reportBackendError(`HRPC request failed (${request?.command})`, error)
              throw error
            }
          }
          rawRpc._peartubeCompat = true
        }
      } catch {}

      return true
    } catch (error) {
      console.log('[Backend] HRPC init failed:', error?.message)
      return false
    }
  }

  function ipcLog(message) {
    try {
      rpc?.eventLog?.({ level: 'info', message, timestamp: Date.now() })
    } catch {}
  }

  function closeOwnerLock() {
    if (ownerLockFd === -1) return
    const fd = ownerLockFd
    ownerLockFd = -1
    try { fsNativeExtensions?.unlock?.(fd) } catch {}
    try { fs.close(fd, () => {}) } catch {}
  }

  async function acquireOwnerLock(storageDir) {
    const extensions = await ensureFsNativeExtensionsModule()
    const tryLock = extensions?.tryLock
    if (typeof tryLock !== 'function') return

    const lockPath = path.join(storageDir, 'backend-owner.lock')
    const fd = await new Promise((resolve, reject) => {
      fs.open(lockPath, 'a+', (error, handle) => error ? reject(error) : resolve(handle))
    })

    let acquired = false
    for (let index = 0; index < 10; index++) {
      try {
        acquired = tryLock(fd)
      } catch {}
      if (acquired) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    if (!acquired) {
      try { fs.close(fd, () => {}) } catch {}
      return
    }

    ownerLockFd = fd
  }

function removeStaleLocks(storageDir) {
  try { fs.unlinkSync(path.join(storageDir, 'CORESTORE')) } catch (error) { if (error.code !== 'ENOENT') console.log('[Backend] CORESTORE cleanup skipped:', error.message) }
  try { fs.unlinkSync(path.join(storageDir, 'LOCK')) } catch (error) { if (error.code !== 'ENOENT') console.log('[Backend] LOCK cleanup skipped:', error.message) }
  try { fs.unlinkSync(path.join(storageDir, 'primary', 'LOCK')) } catch (error) { if (error?.code !== 'ENOENT') {} }
  try { fs.unlinkSync(path.join(storageDir, 'db', 'LOCK')) } catch (error) { if (error?.code !== 'ENOENT') {} }

  function removeDirRecursive(dir) {
      try {
        for (const entry of fs.readdirSync(dir)) {
          const file = path.join(dir, entry)
          try {
            fs.statSync(file).isDirectory() ? removeDirRecursive(file) : fs.unlinkSync(file)
          } catch {}
        }
        fs.rmdirSync(dir)
      } catch {}
    }

    for (const name of ['logs', 'LOG', 'LOG.old', 'IDENTITY', 'CURRENT', 'MANIFEST-000001']) {
      const filePath = path.join(storageDir, name)
      try {
        fs.statSync(filePath).isDirectory() ? removeDirRecursive(filePath) : fs.unlinkSync(filePath)
      } catch {}
    }
  }

  const ipcFrameParser = createJsonFrameParser()

  function parseIpcMessage(chunk) {
    const messages = ipcFrameParser.push(chunk)
    return messages.length > 0 ? messages[0] : null
  }

  function encodeIpcMessage(value) {
    return b4a.from(encodeJsonFrame(value))
  }

  attachUnhandledHandlers(reportBackendError)
  await loadBackendModules()
  ensureRpc()

  const storageDir = path.join(storagePath, 'peartube-data')
  try {
    prepareStoredProtocolState({
      storagePath: storageDir,
      expectedVersion: protocolVersion,
      fs,
      path,
      migrations: storedProtocolMigrations,
    })
  } catch (error) {
    reportBackendError('Backend init failed', error)
    throw error
  }
  try { fs.mkdirSync(storageDir, { recursive: true }) } catch {}

  try {
    const lockPath = path.join(storageDir, 'backend-owner.lock')
    if (fs.existsSync(lockPath)) {
      const pid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10)
      if (!Number.isNaN(pid)) {
        let alive = false
        try {
          process.kill(pid, 0)
          alive = true
        } catch {}
        if (!alive) fs.unlinkSync(lockPath)
      }
    }
  } catch {}

  await acquireOwnerLock(storageDir)
  ipcLog('[init] owner lock done')

  removeStaleLocks(storageDir)
  ipcLog('[init] CORESTORE + LOCK cleanup done')

  let backend = null
  try {
    ipcLog('[init] createBackendContext starting')
    backend = await createBackendContext(buildMobileBackendContextOptions({
      storagePath: storageDir,
      corestoreWaitForLock: false,
      platform: 'mobile',
      network: launchOptions?.network,
      swarmOptions: launchOptions?.swarmOptions,
      expectedProtocolVersion: protocolVersion,
      ipcLog,
      onMediaGraphUpdate: (update) => {
        try {
          rpc?.eventMediaGraphUpdate?.({
            revision: update.revision,
            changedCount: update.changedCount
          })
        } catch {}
      },
      onStatsUpdate: (driveKey, videoPath, stats) => {
        try {
          rpc?.eventVideoStats?.({
            stats: { videoId: videoPath, channelKey: driveKey, ...stats }
          })
        } catch {}
      }
    }))
  } catch (error) {
    reportBackendError('Backend init failed', error)
    closeOwnerLock()
    throw error
  }

  const {
    ctx,
    api,
    identityManager,
    uploadManager,
    initializeIdentityFromMnemonic
  } = backend

  backendCtx = ctx
  ctx.registerCleanup?.('mobile backend owner lock', () => closeOwnerLock(), { timeoutMs: 1000 })
  ctx.registerCleanup?.('mobile cast proxy close', () => closeCastProxyServer('host-terminate'), { timeoutMs: 1000 })

  ensureRpc()
  if (!rpc) {
    throw new Error('Failed to initialize HRPC transport')
  }

  const lazyTranscoder = {
    async startTranscode(...args) {
      const module = await ensureTranscoderModule()
      return module.startTranscode(...args)
    },
    async stopTranscode(...args) {
      const module = await ensureTranscoderModule()
      return module.stopTranscode(...args)
    },
    async getStatus(...args) {
      const module = await ensureTranscoderModule()
      return module.getStatus(...args)
    },
    async probeMedia(...args) {
      const module = await ensureTranscoderModule()
      return module.probeMedia(...args)
    },
    async loadBareFfmpeg(...args) {
      const module = await ensureTranscoderModule()
      return module.loadBareFfmpeg(...args)
    }
  }

  attachMobileHandlers(backend, {
    api,
    protocolVersion,
    identityManager,
    uploadManager,
    ctx,
    initializeIdentityFromMnemonic,
    rpc,
    fs,
    path,
    generateAndStoreThumbnail: async (...args) => {
      const module = await ensureBackendThumbnailModule()
      return module.generateAndStoreThumbnail(...args)
    },
    transcoder: lazyTranscoder,
    ...compatDeps,
    storagePath
  })

  let castCleanup = { enterHeadlessMode: null, closeCastProxyServer: null }
  let castHandlersReadyPromise = null
  const ensureCastHandlersAttached = async () => {
    if (!castHandlersReadyPromise) {
      castHandlersReadyPromise = (async () => {
        const [
          transcoderModule,
          castTranscoderModule,
          httpModule,
        ] = await Promise.all([
          ensureTranscoderModule(),
          ensureCastTranscoderModule(),
          ensureHttpModule(),
        ])
        const attachCastHandlersImpl = ensureMobileCastHandlers()

        castCleanup = attachCastHandlersImpl(backend, {
          rpc,
          ctx,
          api,
          setCastActive,
          isCastActive,
          prefetchVideoForCast,
          http1: httpModule,
          path,
          fs,
          transcoder: transcoderModule,
          castTranscoder: castTranscoderModule,
          storagePath
        })

        closeCastProxyServer = castCleanup.closeCastProxyServer || (() => {})
      })().catch((error) => {
        castHandlersReadyPromise = null
        throw error
      })
    }

    return castHandlersReadyPromise
  }

  attachLazyCastHandlers(backend, ensureCastHandlersAttached)

  registerSharedHandlers(rpc, backend)
  handlersRegistered = true
  attachMobileOnlyRpcHandlers(rpc, api)

  async function destroy() {
    if (shutdownInFlight) return shutdownInFlight

    shutdownInFlight = (async () => {
      await shutdownBackend(ctx)
    })().finally(() => {
      shutdownInFlight = null
    })

    return shutdownInFlight
  }

  if (IPC?.on) {
    IPC.on('data', (chunk) => {
      const message = parseIpcMessage(chunk)
      if (message?.type !== 'shutdown') return

      destroy()
        .then(() => {
          try {
            IPC.write(encodeIpcMessage({ type: 'shutdown-complete' }))
          } catch {}
        })
        .catch(() => {})
    })

    IPC.on('close', () => castCleanup.enterHeadlessMode?.('ipc-close'))
    IPC.on('end', () => castCleanup.enterHeadlessMode?.('ipc-end'))
  }

  const blobPort = ctx.blobServer?.port || ctx.blobServerPort || 0
  onReady({ blobServerPort: blobPort, protocolVersion })

  try {
    rpc.eventReady({ blobServerPort: blobPort, protocolVersion })
  } catch (error) {
    console.error('[Backend] Failed to send eventReady:', error.message)
  }


  if (typeof Bare !== 'undefined' && Bare?.on) {
    Bare.on('exit', () => {
      if (!backendCtx?._isShutdown) destroy().catch(() => {})
      return true
    })
  }

  if (typeof process !== 'undefined' && process?.on) {
    process.on('exit', () => closeOwnerLock())
  }

  if (typeof process !== 'undefined' && process?.env?.PEARTUBE_PRELOAD_FFMPEG === '1') {
    lazyTranscoder.loadBareFfmpeg().catch(() => {})
  }

  return {
    rpc,
    backend,
    handlerDeps: {
      api,
      identityManager,
      uploadManager,
      ctx,
      initializeIdentityFromMnemonic,
      rpc,
      fs,
      path,
      generateAndStoreThumbnail: async (...args) => {
        const module = await ensureBackendThumbnailModule()
        return module.generateAndStoreThumbnail(...args)
      },
      transcoder: lazyTranscoder,
      ...compatDeps,
      storagePath
    },
    destroy
  }
}

if (globalThis.BareKit?.IPC && (typeof Bare !== 'undefined')) {
  if (Bare.argv?.[1] === LEGACY_ROOT_PREFLIGHT_ENTRYPOINT) {
    await startLegacyPublisherRootPreflightWorklet()
  } else {
    await startMobileBackend()
  }
}
