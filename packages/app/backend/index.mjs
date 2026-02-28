/**
 * PearTube Mobile Backend - Thin HRPC shim over @peartube/backend
 *
 * This is a minimal wrapper that:
 * 1. Initializes storage and the backend context via createBackendContext()
 * 2. Attaches mobile handler implementations via mobile-handlers.mjs
 * 3. Attaches cast handlers via mobile-cast.mjs
 * 4. Registers shared HRPC handlers via registerSharedHandlers()
 * 5. Registers mobile-only handlers directly on rpc
 * 6. Handles BareKit IPC lifecycle, owner lock, and feed cache
 */

let HRPC = null
let createBackendContext = null
let setIsShuttingDown = null
let shutdownBackend = null
let setCastActive = null
let isCastActive = null
let prefetchVideoForCast = null
let generateAndStoreThumbnail = null
let path = null
let fs = null
let b4a = null
let http1 = null
let transcoder = null
let castTranscoder = null
let fsNativeExtensions = null

async function loadBackendModules() {
  const [
    specMod, orchestratorMod, storageMod, thumbnailMod,
    pathMod, fsMod, b4aMod, http1Mod,
    fsNativeExtensionsMod, transcoderMod, castTranscoderMod,
  ] = await Promise.all([
    import('@peartube/spec'),
    import('@peartube/backend/orchestrator'),
    import('@peartube/backend/storage'),
    import('@peartube/backend/thumbnail'),
    import('bare-path'),
    import('bare-fs'),
    import('b4a'),
    import('bare-http1'),
    import('fs-native-extensions'),
    import('./transcoder.mjs'),
    import('@peartube/backend/transcode/cast-transcoder'),
  ])
  HRPC = specMod?.default ?? specMod
  createBackendContext = orchestratorMod?.createBackendContext
  setIsShuttingDown = orchestratorMod?.setIsShuttingDown
  shutdownBackend = storageMod?.shutdownBackend
  setCastActive = storageMod?.setCastActive
  isCastActive = storageMod?.isCastActive
  prefetchVideoForCast = storageMod?.prefetchVideoForCast
  generateAndStoreThumbnail = thumbnailMod?.generateAndStoreThumbnail
  path = pathMod?.default ?? pathMod
  fs = fsMod?.default ?? fsMod
  b4a = b4aMod?.default ?? b4aMod
  http1 = http1Mod?.default ?? http1Mod
  fsNativeExtensions = fsNativeExtensionsMod?.default ?? fsNativeExtensionsMod
  transcoder = transcoderMod
  castTranscoder = castTranscoderMod
  if (!HRPC || !createBackendContext || !setIsShuttingDown || !shutdownBackend || !generateAndStoreThumbnail || !path || !fs || !b4a || !http1 || !transcoder || !castTranscoder || !fsNativeExtensions || !setCastActive || !isCastActive || !prefetchVideoForCast) {
    throw new Error('Missing required backend modules after dynamic import')
  }
}

const { IPC } = BareKit
let bareStorageDir = null
try { bareStorageDir = require('bare-storage').persistent() } catch {}
const storagePath = Bare.argv[0] || bareStorageDir || ''
const workerBundlePath = Bare.argv[1] || ''
if (workerBundlePath) { globalThis.__PEARTUBE_WORKER_PATH__ = workerBundlePath }

let rpc = null
let handlersRegistered = false

function formatError(err) {
  if (!err) return 'Unknown error'
  if (err instanceof Error) return err.stack || err.message || String(err)
  if (typeof err === 'string') return err
  try { return JSON.stringify(err) } catch { return String(err) }
}

function reportBackendError(label, err) {
  const message = err instanceof Error ? err.message : (typeof err === 'string' ? err : 'Unknown error')
  console.error(`[Backend] ${label}:`, message)
  if (err?.stack) console.error(err.stack)
  try { rpc?.eventError?.({ message: `${label}: ${message}` }) } catch {}
}

function ensureRpc() {
  if (rpc) return true
  try {
    rpc = new HRPC(IPC)
    try {
      const rawRpc = rpc?._rpc
      if (rawRpc && !rawRpc._peartubeCompat) {
        const orig = rawRpc._onrequest
        rawRpc._onrequest = async (req) => {
          try {
            const hasPayload = Boolean(req?.data && req.data.length > 0)
            if (req?.command === 16 && !hasPayload) req.command = 18
            if (req?.command === 24 && hasPayload) req.command = 30
          } catch {}
          if (!handlersRegistered) throw new Error('Backend not ready')
          try { return await orig(req) } catch (err) { reportBackendError(`HRPC request failed (${req?.command})`, err); throw err }
        }
        rawRpc._peartubeCompat = true
      }
    } catch {}
    return true
  } catch (e) { console.log('[Backend] HRPC init failed:', e?.message); return false }
}

function attachUnhandledHandlers() {
  const notify = (label, err) => reportBackendError(label, err)
  if (typeof Bare !== 'undefined' && Bare?.on) {
    Bare.on('unhandledRejection', (reason) => { try { console.error('[Backend] Unhandled rejection:', formatError(reason)) } catch {}; return true })
    Bare.on('uncaughtException', (err) => { try { console.error('[Backend] Uncaught exception:', formatError(err)) } catch {}; return true })
  }
  const proc = typeof process !== 'undefined' ? process : null
  if (proc?.on) { proc.on('unhandledRejection', (r) => notify('Unhandled rejection', r)); proc.on('uncaughtException', (e) => notify('Uncaught exception', e)) }
  const g = typeof globalThis !== 'undefined' ? globalThis : null
  if (!g) return
  if (typeof g.addEventListener === 'function') {
    g.addEventListener('unhandledrejection', (ev) => { notify('Unhandled rejection', ev?.reason ?? ev); ev?.preventDefault?.() })
    g.addEventListener('error', (ev) => { notify('Uncaught error', ev?.error ?? ev?.message ?? ev) })
  }
}

console.log('[Backend] Starting PearTube mobile backend, storagePath:', storagePath)
attachUnhandledHandlers()
try { await loadBackendModules() } catch (err) { reportBackendError('Backend module import failed', err); throw err }
ensureRpc()

function ipcLog(msg) { try { rpc?.eventLog?.({ level: 'info', message: msg, timestamp: Date.now() }) } catch {} }

const storageDir = path.join(storagePath, 'peartube-data')
try { fs.mkdirSync(storageDir, { recursive: true }) } catch {}

// ============================================
// Owner lock
// ============================================
const OWNER_LOCK_FILE = 'backend-owner.lock'
let ownerLockFd = -1
let backendCtx = null

function closeOwnerLock(reason = 'shutdown') {
  if (ownerLockFd === -1) return; const fd = ownerLockFd; ownerLockFd = -1
  try { fsNativeExtensions?.unlock?.(fd) } catch {}
  try { fs.close(fd, () => {}) } catch {}
}

async function acquireOwnerLock() {
  const tryLock = fsNativeExtensions?.tryLock
  if (typeof tryLock !== 'function') return
  const lockPath = path.join(storageDir, OWNER_LOCK_FILE)
  const fd = await new Promise((resolve, reject) => fs.open(lockPath, 'a+', (err, f) => err ? reject(err) : resolve(f)))
  let acquired = false
  for (let i = 0; i < 10; i++) { try { acquired = tryLock(fd) } catch {}; if (acquired) break; await new Promise(r => setTimeout(r, 200)) }
  if (!acquired) { try { fs.close(fd, () => {}) } catch {}; return }
  ownerLockFd = fd
}

let closeCastProxyServer = () => {}

if (typeof Bare !== 'undefined' && Bare?.on) {
  Bare.on('exit', () => { if (!backendCtx?._isShutdown) shutdownBackend?.(backendCtx).catch(() => {}); closeCastProxyServer('bare-exit'); closeOwnerLock('bare-exit'); return true })
}
if (typeof process !== 'undefined' && process?.on) process.on('exit', () => closeOwnerLock('process-exit'))

// Check stale lock
try {
  const lp = path.join(storageDir, OWNER_LOCK_FILE)
  if (fs.existsSync(lp)) { const pid = parseInt(fs.readFileSync(lp, 'utf8').trim(), 10); if (!isNaN(pid)) { let alive = false; try { process.kill(pid, 0); alive = true } catch {}; if (!alive) fs.unlinkSync(lp) } }
} catch {}

await acquireOwnerLock()
ipcLog('[init] owner lock done')

// Remove stale CORESTORE
try { fs.unlinkSync(path.join(storageDir, 'CORESTORE')) } catch (e) { if (e.code !== 'ENOENT') console.log('[Backend] CORESTORE cleanup skipped:', e.message) }

// Clean stale RocksDB artifacts
function rmdirRecursive(dir) { try { for (const e of fs.readdirSync(dir)) { const f = path.join(dir, e); try { fs.statSync(f).isDirectory() ? rmdirRecursive(f) : fs.unlinkSync(f) } catch {} }; fs.rmdirSync(dir) } catch {} }
try { for (const n of ['logs', 'LOG', 'LOG.old', 'IDENTITY', 'CURRENT', 'MANIFEST-000001']) { const p = path.join(storageDir, n); try { fs.statSync(p).isDirectory() ? rmdirRecursive(p) : fs.unlinkSync(p) } catch {} } } catch {}
ipcLog('[init] CORESTORE cleanup done')

// ============================================
// Initialize backend
// ============================================
let backend = null
try {
  ipcLog('[init] createBackendContext starting')
  backend = await createBackendContext({
    storagePath: storageDir, corestoreWaitForLock: true, ipcLog,
    onFeedUpdate: () => { try { rpc?.eventFeedUpdate?.({ channelKey: 'feed', action: 'update' }) } catch {} },
    onStatsUpdate: (driveKey, videoPath, stats) => { try { rpc?.eventVideoStats?.({ stats: { videoId: videoPath, channelKey: driveKey, ...stats } }) } catch {} }
  })
} catch (err) { reportBackendError('Backend init failed', err); closeOwnerLock('backend-unavailable'); throw err }

const { ctx, api, identityManager, uploadManager, publicFeed, seedingManager, videoStats, initializeIdentityFromMnemonic } = backend
backendCtx = ctx

ensureRpc()
if (!rpc) { reportBackendError('HRPC unavailable', 'Failed to initialize HRPC transport'); throw new Error('Failed to initialize HRPC transport') }

// ============================================
// Attach handler implementations to backend object
// ============================================
const { attachMobileHandlers } = await import('./mobile-handlers.mjs')
attachMobileHandlers(backend, { api, identityManager, uploadManager, ctx, initializeIdentityFromMnemonic, rpc, fs, path, generateAndStoreThumbnail, transcoder, storagePath })

const { attachCastHandlers } = await import('./mobile-cast.mjs')
const castCleanup = attachCastHandlers(backend, { rpc, ctx, api, setCastActive, isCastActive, prefetchVideoForCast, http1, path, fs, transcoder, castTranscoder, storagePath })
closeCastProxyServer = castCleanup.closeCastProxyServer

// ============================================
// Register shared HRPC handlers (lazy dispatch to backend.camelCase(name))
// ============================================
const { registerSharedHandlers } = await import('@peartube/backend/hrpc-handlers')
registerSharedHandlers(rpc, backend)
console.log('[Backend] HRPC handlers registered')
handlersRegistered = true

// ============================================
// Mobile-only handlers (NOT in SHARED_HANDLER_NAMES)
// ============================================
if (typeof rpc.onSearchVideos === 'function') {
  rpc.onSearchVideos(async (req) => {
    try { const raw = await api.searchVideos(req.channelKey, req.query, { topK: req.topK || 10, federated: Boolean(req.federated) }); return { results: (raw || []).map((r) => ({ id: String(r.id || ''), score: r.score != null ? String(r.score) : null, metadata: r.metadata ? JSON.stringify(r.metadata) : null })) } }
    catch { return { results: [] } }
  })
}
if (typeof rpc.onGetRecommendations === 'function') rpc.onGetRecommendations(async () => ({ success: true, recommendations: [] }))
if (typeof rpc.onGetVideoRecommendations === 'function') rpc.onGetVideoRecommendations(async () => ({ success: true, recommendations: [] }))
if (typeof rpc.onIndexVideoVectors === 'function') {
  rpc.onIndexVideoVectors(async (req) => { try { const r = await api.indexVideoVectors?.(req.channelKey, req.videoId); return { success: Boolean(r?.success), error: r?.error || null } } catch (e) { return { success: false, error: e?.message } } })
}
if (typeof rpc.onLogWatchEvent === 'function') rpc.onLogWatchEvent(async () => ({ success: true }))
if (typeof rpc.onRetrySyncChannel === 'function') {
  rpc.onRetrySyncChannel(async (req) => { try { await api.retrySyncChannel?.(req.channelKey); return { success: true } } catch (e) { return { success: false, error: e?.message } } })
}

// ============================================
// IPC shutdown
// ============================================
let shutdownIpcInFlight = null
function parseIpcMsg(chunk) { if (!chunk) return null; try { const t = b4a.toString(chunk).trim(); if (!t || t[0] !== '{') return null; const p = JSON.parse(t); return p && typeof p === 'object' ? p : null } catch { return null } }
async function handleIpcShutdown() {
  if (shutdownIpcInFlight) return shutdownIpcInFlight
  shutdownIpcInFlight = (async () => { setIsShuttingDown(true); await shutdownBackend(ctx); closeCastProxyServer('ipc-shutdown'); closeOwnerLock('shutdown'); try { IPC.write(b4a.from(JSON.stringify({ type: 'shutdown-complete' }))) } catch {} })().finally(() => { shutdownIpcInFlight = null })
  return shutdownIpcInFlight
}
if (IPC?.on) {
  IPC.on('data', (chunk) => { const msg = parseIpcMsg(chunk); if (msg?.type === 'shutdown') handleIpcShutdown().catch(() => {}) })
  IPC.on('close', () => castCleanup.enterHeadlessMode('ipc-close'))
  IPC.on('end', () => castCleanup.enterHeadlessMode('ipc-end'))
}

// ============================================
// Feed cache + eventReady
// ============================================
async function restoreFeedCache() {
  try { const c = await ctx.metaDb.get('public-feed-cache').catch(() => null); const e = c?.value || []; if (Array.isArray(e) && e.length) for (const entry of e) { try { typeof entry === 'object' && entry.driveKey ? publicFeed.addEntry(entry.driveKey, 'peer', entry.publicBeeKey || null) : typeof entry === 'string' && publicFeed.addEntry(entry, 'peer') } catch {} } } catch {}
}
async function persistFeedCache() {
  try { await ctx.metaDb.put('public-feed-cache', publicFeed.getFeed().map((e) => ({ driveKey: e.driveKey, publicBeeKey: e.publicBeeKey || null }))) } catch {}
}

await restoreFeedCache()

const blobPort = ctx.blobServer?.port || ctx.blobServerPort || 0
console.log('[Backend] Backend initialized, blob server port:', blobPort)
try { rpc.eventReady({ blobServerPort: blobPort, blobServerHost: ctx.blobServerHost || '127.0.0.1' }); rpc.eventFeedUpdate({ channelKey: 'feed', action: 'update' }) } catch (e) { console.error('[Backend] Failed to send eventReady:', e.message) }

setInterval(() => { try { publicFeed.requestFeedsFromPeers(); persistFeedCache() } catch {} }, 30000)
publicFeed.setOnFeedUpdate(() => { persistFeedCache(); try { rpc?.eventFeedUpdate?.({ channelKey: 'feed', action: 'update' }) } catch {} })

const preloadFfmpeg = typeof process !== 'undefined' && process?.env?.PEARTUBE_PRELOAD_FFMPEG === '1'
if (preloadFfmpeg) transcoder.loadBareFfmpeg().catch(() => {})
