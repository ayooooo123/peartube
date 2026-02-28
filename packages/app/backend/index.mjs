/**
 * PearTube Mobile Backend - Thin HRPC shim over @peartube/backend
 *
 * This is a minimal wrapper that:
 * 1. Initializes the backend using createBackend() from backend-entry.js
 * 2. Shared HRPC handlers are registered by createBackend() via registerSharedHandlers()
 * 3. Attaches mobile-specific handler implementations to the backend object
 * 4. Handles mobile-specific concerns (BareKit IPC, owner lock, feed cache)
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
let os = null
let b4a = null
let http1 = null
let transcoder = null
let castTranscoder = null
let fsNativeExtensions = null

async function loadBackendModules() {
  const [
    specMod, orchestratorMod, storageMod, thumbnailMod,
    pathMod, fsMod, osMod, b4aMod, http1Mod,
    fsNativeExtensionsMod, transcoderMod, castTranscoderMod,
  ] = await Promise.all([
    import('@peartube/spec'),
    import('@peartube/backend/orchestrator'),
    import('@peartube/backend/storage'),
    import('@peartube/backend/thumbnail'),
    import('bare-path'),
    import('bare-fs'),
    import('bare-os'),
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
  os = osMod?.default ?? osMod
  b4a = b4aMod?.default ?? b4aMod
  http1 = http1Mod?.default ?? http1Mod
  fsNativeExtensions = fsNativeExtensionsMod?.default ?? fsNativeExtensionsMod
  transcoder = transcoderMod
  castTranscoder = castTranscoderMod

  if (!HRPC || !createBackendContext || !setIsShuttingDown || !shutdownBackend || !generateAndStoreThumbnail || !path || !fs || !os || !b4a || !http1 || !transcoder || !castTranscoder || !fsNativeExtensions || !setCastActive || !isCastActive || !prefetchVideoForCast) {
    throw new Error('Missing required backend modules after dynamic import')
  }
}

const { IPC } = BareKit

let bareStorageDir = null
try {
  const dir = require('bare-storage')
  bareStorageDir = dir.persistent()
} catch {}

const storagePath = Bare.argv[0] || bareStorageDir || ''
const workerBundlePath = Bare.argv[1] || ''

if (workerBundlePath) {
  globalThis.__PEARTUBE_WORKER_PATH__ = workerBundlePath
  console.log('[Backend] Downloader worker path:', workerBundlePath)
}

console.log('[Backend] Raw storagePath from Bare.argv[0]:', storagePath || '(empty)')
if (!storagePath || !storagePath.startsWith('/')) {
  console.warn('[Backend] WARNING: storagePath may be invalid:', storagePath)
}

// HRPC instance (initialized early so we can surface init errors)
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

function backendLog(msg) {
  console.log(msg)
  if (rpc?.eventLog) {
    try { rpc.eventLog({ message: msg }) } catch {}
  }
}

function ensureRpc() {
  if (rpc) return true
  try {
    rpc = new HRPC(IPC)
    console.log('[Backend] HRPC initialized')

    // Backward-compat shim: old command id remapping
    try {
      const rawRpc = rpc?._rpc
      if (rawRpc && !rawRpc._peartubeCompat) {
        const originalOnRequest = rawRpc._onrequest
        rawRpc._onrequest = async (req) => {
          try {
            const hasPayload = Boolean(req?.data && req.data.length > 0)
            if (req?.command === 16 && !hasPayload) req.command = 18
            if (req?.command === 24 && hasPayload) req.command = 30
          } catch {}
          if (!handlersRegistered) {
            throw new Error('Backend not ready: handlers are not registered yet')
          }
          try {
            return await originalOnRequest(req)
          } catch (err) {
            reportBackendError(`HRPC request failed (${req?.command})`, err)
            throw err
          }
        }
        rawRpc._peartubeCompat = true
      }
    } catch {}

    return true
  } catch (e) {
    console.log('[Backend] HRPC init failed:', e?.message)
    return false
  }
}

function attachUnhandledHandlers() {
  const notify = (label, err) => reportBackendError(label, err)
  const notifyBare = (label, err) => {
    try {
      const msg = err instanceof Error ? `${err.message}\n${err.stack || ''}` : formatError(err)
      console.error(`[Backend] ${label}:`, msg)
    } catch {}
  }

  if (typeof Bare !== 'undefined' && Bare?.on) {
    Bare.on('unhandledRejection', (reason) => { notifyBare('Unhandled rejection', reason); return true })
    Bare.on('uncaughtException', (err) => { notifyBare('Uncaught exception', err); return true })
  }

  const proc = typeof process !== 'undefined' ? process : null
  if (proc && typeof proc.on === 'function') {
    proc.on('unhandledRejection', (reason) => notify('Unhandled rejection', reason))
    proc.on('uncaughtException', (err) => notify('Uncaught exception', err))
  }

  const g = typeof globalThis !== 'undefined' ? globalThis : null
  if (!g) return
  if (typeof g.addEventListener === 'function') {
    g.addEventListener('unhandledrejection', (event) => { notify('Unhandled rejection', event?.reason ?? event); event?.preventDefault?.() })
    g.addEventListener('error', (event) => { notify('Uncaught error', event?.error ?? event?.message ?? event) })
    return
  }
  if ('onunhandledrejection' in g) {
    const prev = g.onunhandledrejection
    g.onunhandledrejection = (event) => { notify('Unhandled rejection', event?.reason ?? event); if (typeof prev === 'function') prev(event) }
  }
  if ('onerror' in g) {
    const prev = g.onerror
    g.onerror = (message, source, lineno, colno, error) => { notify('Uncaught error', error || message); if (typeof prev === 'function') return prev(message, source, lineno, colno, error); return false }
  }
}

console.log('[Backend] Starting PearTube mobile backend')
console.log('[Backend] Storage path:', storagePath)

attachUnhandledHandlers()

try {
  await loadBackendModules()
} catch (err) {
  reportBackendError('Backend module import failed', err)
  throw err
}

ensureRpc()

function ipcLog(msg) {
  try { rpc?.eventLog?.({ level: 'info', message: msg, timestamp: Date.now() }) } catch {}
}

// Initialize storage directory
const storageDir = path.join(storagePath, 'peartube-data')
try { fs.mkdirSync(storageDir, { recursive: true }) } catch {}

const BACKEND_BUNDLE_VERSION = 'corestore-cleanup-v3'
console.log('[Backend] Bundle version:', BACKEND_BUNDLE_VERSION)

// ============================================
// Owner lock management
// ============================================
const OWNER_LOCK_FILE = 'backend-owner.lock'
let ownerLockFd = -1
let backendCtx = null

function closeOwnerLock(reason = 'shutdown') {
  if (ownerLockFd === -1) return
  const fd = ownerLockFd
  ownerLockFd = -1
  try { fsNativeExtensions?.unlock?.(fd) } catch {}
  try { fs.close(fd, () => {}) } catch {}
  console.log('[Backend] Released owner lock:', reason)
}

async function acquireOwnerLock() {
  const tryLock = fsNativeExtensions?.tryLock
  if (typeof tryLock !== 'function') {
    console.warn('[Backend] fs-native-extensions.tryLock unavailable, skipping owner lock')
    return
  }
  const lockPath = path.join(storageDir, OWNER_LOCK_FILE)
  const fd = await new Promise((resolve, reject) => {
    fs.open(lockPath, 'a+', (err, openedFd) => {
      if (err) return reject(err)
      resolve(openedFd)
    })
  })
  let acquired = false
  const maxAttempts = 10
  for (let i = 0; i < maxAttempts; i++) {
    try { acquired = tryLock(fd) } catch (err) { console.warn('[Backend] tryLock error:', err.message) }
    if (acquired) break
    await new Promise(r => setTimeout(r, 200))
  }
  if (!acquired) {
    console.warn('[Backend] Could not acquire owner lock after', maxAttempts, 'attempts, proceeding without it')
    try { fs.close(fd, () => {}) } catch {}
    return
  }
  ownerLockFd = fd
  console.log('[Backend] Acquired owner lock fd:', ownerLockFd)
}

let closeCastProxyServer = () => {}

if (typeof Bare !== 'undefined' && Bare?.on) {
  Bare.on('exit', () => {
    if (!backendCtx?._isShutdown) shutdownBackend?.(backendCtx).catch(() => {})
    closeCastProxyServer('bare-exit')
    closeOwnerLock('bare-exit')
    return true
  })
}
if (typeof process !== 'undefined' && process?.on) {
  process.on('exit', () => closeOwnerLock('process-exit'))
}

// Check for stale lock
try {
  const lockPath = path.join(storageDir, OWNER_LOCK_FILE)
  if (fs.existsSync(lockPath)) {
    const lockContent = fs.readFileSync(lockPath, 'utf8').trim()
    const pid = parseInt(lockContent, 10)
    if (!isNaN(pid)) {
      let isAlive = false
      try { process.kill(pid, 0); isAlive = true } catch {}
      if (!isAlive) {
        fs.unlinkSync(lockPath)
        console.log(`[Backend] Removed stale backend-owner.lock (PID ${pid} is dead)`)
      }
    }
  }
} catch (err) {
  console.warn('[Backend] Could not check backend-owner.lock:', err?.message)
}

await acquireOwnerLock()
ipcLog('[init] owner lock done')

// Remove stale CORESTORE device-file
try {
  fs.unlinkSync(path.join(storageDir, 'CORESTORE'))
  console.log('[Backend] Removed stale CORESTORE device file')
} catch (e) {
  if (e.code !== 'ENOENT') console.log('[Backend] CORESTORE cleanup skipped:', e.message)
}

// Clean up stale top-level RocksDB artifacts
function rmdirRecursive(dir) {
  try {
    const entries = fs.readdirSync(dir)
    for (const e of entries) {
      const full = path.join(dir, e)
      try {
        const st = fs.statSync(full)
        if (st.isDirectory()) rmdirRecursive(full)
        else fs.unlinkSync(full)
      } catch {}
    }
    fs.rmdirSync(dir)
  } catch {}
}
try {
  for (const name of ['logs', 'LOG', 'LOG.old', 'IDENTITY', 'CURRENT', 'MANIFEST-000001']) {
    const p = path.join(storageDir, name)
    try {
      const st = fs.statSync(p)
      if (st.isDirectory()) rmdirRecursive(p)
      else fs.unlinkSync(p)
    } catch {}
  }
} catch {}
ipcLog('[init] CORESTORE cleanup done')

// ============================================
// Initialize backend via createBackendContext
// ============================================
let backend = null
try {
  ipcLog('[init] createBackendContext starting')
  backend = await createBackendContext({
    storagePath: storageDir,
    corestoreWaitForLock: true,
    ipcLog,
    onFeedUpdate: () => {
      if (rpc) {
        try { rpc.eventFeedUpdate({ channelKey: 'feed', action: 'update' }) } catch (e) {
          console.log('[Backend] Failed to send feed update:', e.message)
        }
      }
    },
    onStatsUpdate: (driveKey, videoPath, stats) => {
      if (rpc) {
        try {
          rpc.eventVideoStats({ stats: { videoId: videoPath, channelKey: driveKey, ...stats } })
        } catch (e) {
          console.log('[Backend] Failed to send video stats:', e.message)
        }
      }
    }
  })
} catch (err) {
  reportBackendError('Backend init failed', err)
  closeOwnerLock('backend-unavailable')
  throw err
}

const { ctx, api, identityManager, uploadManager, publicFeed, seedingManager, videoStats, initializeIdentityFromMnemonic } = backend
backendCtx = ctx

// ============================================
// Create HRPC RPC and register shared handlers
// ============================================
ensureRpc()
if (!rpc) {
  reportBackendError('HRPC unavailable', 'Failed to initialize HRPC transport')
  throw new Error('Failed to initialize HRPC transport')
}

const specModule = await import('@peartube/spec')
const HRPCSpec = specModule?.default ?? specModule
const { registerSharedHandlers } = await import('@peartube/backend/hrpc-handlers')

// The backend object from createBackendContext doesn't have handler methods yet.
// We need to attach them BEFORE registerSharedHandlers, or at least before any
// RPC call arrives (which is before eventReady is sent).
// registerSharedHandlers creates lazy closures that look up handlers at call time.
const B = backend

// ============================================
// Attach shared handler implementations to backend
// (Same pattern as desktop worker - B.handlerName = async (r) => { ... })
// ============================================

// --- Identity handlers ---
B.createIdentity = async (r) => {
  const result = await identityManager.createIdentity(r.name || 'New Channel', true)
  if (result.mnemonic) {
    try {
      const { needsRestart } = await initializeIdentityFromMnemonic(result.mnemonic)
      if (needsRestart) console.log('[Backend] Identity key file written — restart needed')
    } catch (e) { console.error('[Backend] initializeIdentityFromMnemonic failed:', e.message) }
  }
  return { identity: { publicKey: result.publicKey, driveKey: result.driveKey, name: r.name || 'New Channel', seedPhrase: result.mnemonic || '', isActive: true } }
}
B.getIdentity = async () => ({ identity: identityManager.getActiveIdentity() || null })
B.getIdentities = async () => {
  const identities = identityManager.getIdentities()
  const active = identityManager.getActiveIdentity()
  return { identities: identities.map(i => ({ ...i, isActive: active?.publicKey === i.publicKey })) }
}
B.setActiveIdentity = async (r) => { await identityManager.setActiveIdentity(r.publicKey); return { success: true } }
B.recoverIdentity = async (r) => {
  try {
    const result = await identityManager.recoverIdentity(r.seedPhrase, r.name)
    if (r.seedPhrase) {
      try { const { needsRestart } = await initializeIdentityFromMnemonic(r.seedPhrase); if (needsRestart) console.log('[Backend] Identity key file written for recovery') } catch (e) { console.error('[Backend] initializeIdentityFromMnemonic failed:', e.message) }
    }
    return { identity: result }
  } catch (e) { return { identity: null } }
}
B.bootstrapDevice = async (r) => { const result = await identityManager.bootstrapDevice(r.mnemonic); return { proof: result.proof, identityPublicKey: result.identityPublicKey } }
B.attestDevice = async (r) => { const proof = await identityManager.attestDevice(r.identityKeyPair, r.devicePublicKey, r.proof || null); return { proof } }
B.verifyAttestation = async (r) => {
  try { const result = await identityManager.verifyAttestation(r.proof); return { valid: result.valid, identityPublicKey: result.identityPublicKey || '', devicePublicKey: result.devicePublicKey || '' } }
  catch { return { valid: false, identityPublicKey: '', devicePublicKey: '' } }
}

// --- Channel handlers ---
B.getChannel = async (r) => ({ channel: await api.getChannel(r.publicKey || '') })
B.updateChannel = async (r) => {
  const active = identityManager.getActiveIdentity()
  if (!active?.driveKey) return { success: false, error: 'No active channel' }
  try { return await api.updateChannel(active.driveKey, { name: r.name, description: r.description, avatar: r.avatar }) }
  catch (err) { return { success: false, error: err?.message } }
}
B.updateVideoMetadata = async (r) => {
  const active = identityManager.getActiveIdentity()
  if (!active?.driveKey) return { success: false, error: 'No active channel' }
  try { return await api.updateVideoMetadata(r.channelKey || active.driveKey, r.videoId, { title: r.title, description: r.description, category: r.category }) }
  catch (err) { return { success: false, error: err?.message } }
}
B.updateChannelAvatar = async (r) => {
  const active = identityManager.getActiveIdentity()
  if (!active?.driveKey) return { success: false, error: 'No active channel' }
  try { const imageBuffer = Buffer.from(r.imageData, 'base64'); return await api.updateChannelAvatar(active.driveKey, imageBuffer, r.mimeType || 'image/jpeg') }
  catch (err) { return { success: false, error: err?.message } }
}
B.getChannelMeta = async (r) => { const m = await api.getChannelMeta(r.channelKey, r.publicBeeKey || null); return { name: m.name, description: m.description, videoCount: m.videoCount || 0 } }

// --- Video handlers ---
B.listVideos = async (r) => {
  const channelKey = r?.channelKey || ''
  if (!channelKey) return { videos: [] }
  let rawVideos = []
  try { rawVideos = await api.listVideos(channelKey, r.publicBeeKey) } catch { return { videos: [] } }
  const videos = (rawVideos || []).map((v) => {
    const id = v?.id ? String(v.id) : ''
    if (!id) return null
    return {
      id, title: v?.title ? String(v.title) : 'Untitled',
      description: v?.description ? String(v.description) : null,
      path: v?.path ? String(v.path) : null,
      duration: Number(v?.duration || 0) || 0,
      thumbnail: v?.thumbnail ? String(v.thumbnail) : null,
      channelKey: v?.channelKey || channelKey,
      channelName: v?.channelName ? String(v.channelName) : '',
      createdAt: Number(v?.createdAt || v?.uploadedAt || Date.now()) || 0,
      views: Number(v?.views || 0) || 0,
      category: v?.category ? String(v.category) : null
    }
  }).filter(Boolean)
  return { videos }
}
B.getVideoUrl = async (r) => { const result = await api.getVideoUrl(r.channelKey, r.videoId, r.publicBeeKey); return { url: result.url } }
B.getVideoData = async (r) => { const video = await api.getVideoData(r.channelKey, r.videoId, r.publicBeeKey); return { video: video || { id: r.videoId, title: 'Unknown' } } }
B.getVideoMetadata = async (r) => { const video = await api.getVideoData(r.channelKey, r.videoId); return { video: video || { id: r.videoId, title: 'Unknown' } } }
B.getVideoThumbnail = async (r) => { const result = await api.getVideoThumbnail(r.channelKey, r.videoId); return { url: result.url || null, exists: result.exists || false, dataUrl: null } }
B.setVideoThumbnail = async () => ({ success: false, error: 'setVideoThumbnail is disabled. Use setVideoThumbnailFromFile.' })
B.deleteVideo = async (r) => {
  const active = identityManager.getActiveIdentity?.()
  let channel
  try { channel = await identityManager.getActiveChannel?.() } catch (e) { return { success: false, error: e?.message || 'Failed to load active channel' } }
  if (!channel) return { success: false, error: 'No active channel' }
  if (!channel.writable) return { success: false, error: `Active channel is read-only on this device` }
  try { await channel.deleteVideo(r.videoId); return { success: true } } catch (e) { return { success: false, error: e?.message } }
}
B.prefetchVideo = async (r) => { await api.prefetchVideo(r.channelKey, r.videoId, r.publicBeeKey); return { success: true } }
B.getVideoStats = async (r) => { const stats = await api.getVideoStats(r.channelKey, r.videoId); return { stats: { videoId: r.videoId, channelKey: r.channelKey, ...(stats || {}) } } }

// --- Subscription handlers ---
B.subscribeChannel = async (r) => { await api.subscribeChannel(r.channelKey); return { success: true } }
B.unsubscribeChannel = async (r) => { await api.unsubscribeChannel(r.channelKey); return { success: true } }
B.getSubscriptions = async () => { const subs = await api.getSubscriptions(); return { subscriptions: subs.map(s => ({ channelKey: s.driveKey, channelName: s.name })) } }
B.joinChannel = async (r) => { await api.subscribeChannel(r.channelKey); return { success: true } }

// --- Public Feed handlers ---
B.getPublicFeed = async () => { const result = await api.getPublicFeed(); return { entries: result.entries.map(e => ({ channelKey: e.driveKey || e.channelKey, publicBeeKey: e.publicBeeKey || null, channelName: e.name, videoCount: e.videoCount || 0, peerCount: e.peerCount || 0, lastSeen: e.lastSeen || 0 })) } }
B.refreshFeed = async () => { await api.refreshFeed(); return { success: true } }
B.submitToFeed = async () => { const active = identityManager.getActiveIdentity(); if (active?.driveKey) await api.submitToFeed(active.driveKey); return { success: true } }
B.unpublishFromFeed = async () => { const active = identityManager.getActiveIdentity(); if (active?.driveKey) await api.unpublishFromFeed(active.driveKey); return { success: true } }
B.isChannelPublished = async () => { const active = identityManager.getActiveIdentity(); return active?.driveKey ? api.isChannelPublished(active.driveKey) : { published: false } }
B.hideChannel = async (r) => { await api.hideChannel(r.channelKey); return { success: true } }

// --- Status handlers ---
B.getStatus = async () => ({ status: { ready: true, hasIdentity: identityManager.getActiveIdentity() !== null, blobServerPort: ctx.blobServer?.port || ctx.blobServerPort || 0 } })
B.getBlobServerPort = async () => ({ port: ctx.blobServer?.port || ctx.blobServerPort || 0 })
B.getSwarmStatus = async () => { const status = await api.getSwarmStatus(); return { connected: status.swarmConnections > 0, peerCount: status.swarmConnections } }

// --- Seeding/Storage handlers ---
B.getSeedingStatus = async () => { const s = await api.getSeedingStatus(); return { status: { enabled: s.config?.autoSeedWatched || false, usedStorage: s.storageUsedBytes || 0, maxStorage: (s.maxStorageGB || 10) * 1024 * 1024 * 1024, seedingCount: s.activeSeeds || 0 } } }
B.setSeedingConfig = async (r) => { await api.setSeedingConfig(r.config || {}); return { success: true } }
B.pinChannel = async (r) => { await api.pinChannel(r.channelKey); return { success: true } }
B.unpinChannel = async (r) => { await api.unpinChannel(r.channelKey); return { success: true } }
B.getPinnedChannels = async () => { const result = await api.getPinnedChannels(); return { channels: result.channels || [] } }
B.getStorageStats = async () => api.getStorageStats()
B.setStorageLimit = async (r) => await api.setStorageLimit(r.maxGB)
B.clearCache = async () => await api.clearCache()

// --- Transcode settings ---
B.getTranscodeSettings = async () => api.getTranscodeSettings()
B.setTranscodeSettings = async (r) => api.setTranscodeSettings(r || {})

// --- Multi-device pairing ---
B.createDeviceInvite = async (r) => { const res = await api.createDeviceInvite(r.channelKey); return { inviteCode: res.inviteCode } }
B.pairDevice = async (r) => {
  const res = await api.pairDevice(r.inviteCode, r.deviceName || '')
  try { const existing = identityManager.getIdentities?.() || []; if (existing.length === 0 && res?.channelKey) await identityManager.addPairedChannelIdentity?.(res.channelKey, 'Paired Channel') } catch {}
  return { success: Boolean(res.success), channelKey: res.channelKey }
}
B.listDevices = async (r) => { const res = await api.listDevices(r.channelKey); return { devices: res.devices || [] } }

// --- Comment handlers ---
B.addComment = async (r) => { try { const result = await api.addComment?.(r.channelKey, r.videoId, r.text, r.parentId, r.publicBeeKey); return { success: Boolean(result?.success), commentId: result?.commentId || null, queued: false, error: result?.error || null } } catch (e) { return { success: false, error: e?.message || 'Failed to add comment' } } }
B.listComments = async (r) => {
  try {
    const result = await api.listComments?.(r.channelKey, r.videoId, { page: r.page || 0, limit: r.limit || 50, publicBeeKey: r.publicBeeKey })
    const raw = (result && typeof result === 'object' && Array.isArray(result.comments)) ? result.comments : []
    const comments = raw.map((c) => ({
      videoId: String(c?.videoId || r.videoId || ''), commentId: String(c?.commentId || c?.id || ''),
      text: String(c?.text || ''), authorKeyHex: String(c?.authorKeyHex || c?.author || ''),
      timestamp: typeof c?.timestamp === 'number' ? c.timestamp : 0,
      parentId: c?.parentId ? String(c.parentId) : null, isAdmin: Boolean(c?.isAdmin)
    })).filter((c) => Boolean(c.videoId && c.commentId))
    return { success: Boolean(result?.success), comments, error: result?.error || null }
  } catch (e) { return { success: false, comments: [], error: e?.message } }
}
B.hideComment = async (r) => { try { const result = await api.hideComment?.(r.channelKey, r.videoId, r.commentId, r.publicBeeKey); return { success: Boolean(result?.success), error: result?.error || null } } catch (e) { return { success: false, error: e?.message } } }
B.removeComment = async (r) => { try { const result = await api.removeComment?.(r.channelKey, r.videoId, r.commentId, r.publicBeeKey); return { success: Boolean(result?.success), queued: false, error: result?.error || null } } catch (e) { return { success: false, queued: false, error: e?.message } } }

// --- Reaction handlers ---
B.addReaction = async (r) => { try { const result = await api.addReaction?.(r.channelKey, r.videoId, r.reactionType, r.publicBeeKey); return { success: Boolean(result?.success), queued: false, error: result?.error || null } } catch (e) { return { success: false, queued: false, error: e?.message } } }
B.removeReaction = async (r) => { try { const result = await api.removeReaction?.(r.channelKey, r.videoId, r.publicBeeKey); return { success: Boolean(result?.success), queued: false, error: result?.error || null } } catch (e) { return { success: false, queued: false, error: e?.message } } }
B.getReactions = async (r) => {
  try {
    const result = await api.getReactions?.(r.channelKey, r.videoId, r.publicBeeKey)
    const countsObj = (result?.counts && typeof result.counts === 'object') ? result.counts : {}
    const counts = Object.entries(countsObj).map(([reactionType, count]) => ({ reactionType: String(reactionType), count: typeof count === 'number' ? count : 0 }))
    return { success: Boolean(result?.success), counts, userReaction: result?.userReaction || null, error: result?.error || null }
  } catch (e) { return { success: false, counts: [], error: e?.message } }
}

// --- Desktop-specific stubs (not supported on mobile) ---
B.pickVideoFile = async () => ({ filePath: null, cancelled: true })
B.pickImageFile = async () => ({ filePath: null, cancelled: true })

// --- MPV stubs (not supported on mobile) ---
B.mpvAvailable = async () => ({ available: false, error: 'MPV not supported on mobile' })
B.mpvCreate = async () => ({ success: false, error: 'MPV not supported on mobile' })
B.mpvLoadFile = async () => ({ success: false, error: 'MPV not supported on mobile' })
B.mpvPlay = async () => ({ success: false, error: 'MPV not supported on mobile' })
B.mpvPause = async () => ({ success: false, error: 'MPV not supported on mobile' })
B.mpvSeek = async () => ({ success: false, error: 'MPV not supported on mobile' })
B.mpvGetState = async () => ({ success: false, paused: true })
B.mpvRenderFrame = async () => ({ success: false, error: 'MPV not supported on mobile' })
B.mpvDestroy = async () => ({ success: false, error: 'MPV not supported on mobile' })

// --- Event no-ops (client -> server, usually no-ops) ---
B.eventReady = () => {}
B.eventError = () => {}
B.eventCastDeviceFound = () => {}
B.eventCastDeviceLost = () => {}
B.eventCastPlaybackState = () => {}
B.eventCastTimeUpdate = () => {}
B.eventUploadProgress = () => {}
B.eventFeedUpdate = () => {}
B.eventLog = () => {}
B.eventVideoStats = () => {}
B.eventTranscodeProgress = () => {}

// --- Mobile-specific file handlers (use bare-fs/bare-path) ---
B.uploadVideo = async (r) => {
  const active = identityManager.getActiveIdentity()
  if (!active?.driveKey) throw new Error('No active identity')
  const channel = await identityManager.getActiveChannel?.()
  if (!channel) throw new Error('No active channel')
  if (!channel.blobs) throw new Error('Channel blobs not initialized')
  let filePath = r.filePath
  if (!filePath) throw new Error('No file path provided')
  if (filePath.startsWith('file://')) filePath = filePath.slice(7)
  const ext = filePath.split('.').pop()?.toLowerCase() || 'mp4'
  const mimeTypes = { 'mp4': 'video/mp4', 'm4v': 'video/mp4', 'webm': 'video/webm', 'mkv': 'video/x-matroska', 'mov': 'video/quicktime', 'avi': 'video/x-msvideo' }
  const mimeType = mimeTypes[ext] || 'video/mp4'
  const result = await uploadManager.uploadFromPath(channel, filePath, { title: r.title, description: r.description || '', mimeType, category: r.category || '' }, fs, (progress, bytesWritten, totalBytes, stats) => {
    rpc.eventUploadProgress({ videoId: 'upload', progress, bytesUploaded: bytesWritten, totalBytes, speed: stats?.speed ? Math.max(0, Math.round(stats.speed)) : 0, eta: stats?.eta ? Math.max(0, Math.round(stats.eta)) : 0 })
  })
  if (!result?.success) throw new Error(result?.error || 'Upload failed')
  try { api.invalidateChannelCaches?.(active.driveKey) } catch {}
  if (result?.videoId && !r.skipThumbnailGeneration) {
    try {
      const thumbResult = await generateAndStoreThumbnail(filePath, result.videoId, channel, { frameIndex: 300 })
      if (thumbResult?.thumbnailBlobId) await channel.updateVideo(result.videoId, { thumbnailBlobId: thumbResult.thumbnailBlobId, thumbnailBlobsCoreKey: thumbResult.thumbnailBlobsCoreKey, thumbnailMimeType: thumbResult.thumbnailMimeType })
    } catch (thumbErr) { console.warn('[HRPC] Thumbnail generation failed:', thumbErr?.message) }
  }
  return { video: { id: result?.videoId || '', title: r.title, description: r.description || '', channelKey: active.driveKey } }
}

B.downloadVideo = async (r) => {
  try {
    const meta = await api.getVideoData(r.channelKey, r.videoId, r.publicBeeKey)
    if (!meta) return { success: false, error: 'Video metadata not found' }
    const sanitizedTitle = (meta.title || 'video').replace(/[^a-zA-Z0-9\s\-_]/g, '').replace(/\s+/g, '_').slice(0, 50)
    const ext = meta.mimeType?.includes('webm') ? 'webm' : meta.mimeType?.includes('mkv') ? 'mkv' : 'mp4'
    const filename = `${sanitizedTitle}_${r.videoId}.${ext}`
    const downloadsDir = path.join(storagePath, 'Downloads')
    try { fs.statSync(downloadsDir) } catch { fs.mkdirSync(downloadsDir) }
    const destPath = r.destPath || path.join(downloadsDir, filename)
    const result = await api.downloadVideo(r.channelKey, r.videoId, destPath, fs, (progress, bytesWritten, totalBytes) => {
      try { rpc.eventDownloadProgress({ id: `${r.channelKey}:${r.videoId}`, progress, bytesDownloaded: bytesWritten, totalBytes }) } catch {}
    })
    if (!result?.success) return { success: false, error: result?.error || 'Download failed' }
    return { success: true, filePath: destPath, size: result.size || 0 }
  } catch (err) { return { success: false, error: err?.message || 'download failed' } }
}

B.setVideoThumbnailFromFile = async (r) => {
  const active = identityManager.getActiveIdentity()
  if (!active?.driveKey) return { success: false, error: 'No active identity' }
  const channel = await identityManager.getActiveChannel?.()
  if (!channel) return { success: false, error: 'No active channel' }
  if (!channel.blobs) return { success: false, error: 'Channel blobs not initialized' }
  let filePath = r.filePath
  if (!filePath) return { success: false, error: 'No file path provided' }
  if (filePath.startsWith('file://')) filePath = filePath.slice(7)
  try {
    const buf = fs.readFileSync(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const mimeType = ext === '.webp' ? 'image/webp' : (ext === '.png' ? 'image/png' : 'image/jpeg')
    const result = await uploadManager.setThumbnailFromBuffer(channel, r.videoId, buf, mimeType)
    try { api.invalidateChannelCaches?.(active.driveKey) } catch {}
    return { success: result.success, error: result.error }
  } catch (err) { return { success: false, error: err?.message || String(err) } }
}

// --- Transcode handlers ---
B.transcodeStart = async (r) => {
  try {
    const onProgress = (sessionId, percent) => { try { rpc.eventTranscodeProgress?.({ sessionId, percent, bytesWritten: 0 }) } catch {} }
    const result = await transcoder.startTranscode(r.sourceUrl, { duration: r.duration || 0, title: r.title || '', onProgress })
    return { success: result.success, sessionId: result.sessionId || '', transcodeUrl: result.transcodeUrl || '', error: result.error || '' }
  } catch (err) { return { success: false, error: err?.message || 'Transcode start failed' } }
}
B.transcodeStop = async (r) => { try { const result = transcoder.stopTranscode(r.sessionId); return { success: result.success, error: result.error || '' } } catch (err) { return { success: false, error: err?.message } } }
B.transcodeStatus = async (r) => { try { const status = transcoder.getStatus(r.sessionId); return { status: status.status || '', progress: status.progress || 0, bytesWritten: status.bytesWritten || 0, error: status.error || '' } } catch (err) { return { status: 'error', progress: 0, bytesWritten: 0, error: err?.message } } }

// --- Attach cast handlers from mobile-cast.mjs ---
const { attachCastHandlers } = await import('./mobile-cast.mjs')
const castCleanup = attachCastHandlers(B, {
  rpc, ctx, api, setCastActive, isCastActive, prefetchVideoForCast,
  http1, path, fs, transcoder, castTranscoder, storagePath,
})
closeCastProxyServer = castCleanup.closeCastProxyServer

// ============================================
// Register shared handlers (lazy dispatch to B.handlerName)
// ============================================
registerSharedHandlers(rpc, B)

console.log('[Backend] HRPC handlers registered')
handlersRegistered = true

// ============================================
// Mobile-only handlers (NOT in SHARED_HANDLER_NAMES)
// ============================================
if (typeof rpc.onSearchVideos === 'function') {
  rpc.onSearchVideos(async (req) => {
    try {
      const rawResults = await api.searchVideos(req.channelKey, req.query, { topK: req.topK || 10, federated: Boolean(req.federated) })
      return { results: (rawResults || []).map((r) => ({ id: String(r.id || ''), score: r.score != null ? String(r.score) : null, metadata: r.metadata ? JSON.stringify(r.metadata) : null })) }
    } catch { return { results: [] } }
  })
}

if (typeof rpc.onGetRecommendations === 'function') {
  rpc.onGetRecommendations(async () => ({ success: true, recommendations: [] }))
}

if (typeof rpc.onGetVideoRecommendations === 'function') {
  rpc.onGetVideoRecommendations(async () => ({ success: true, recommendations: [] }))
}

if (typeof rpc.onIndexVideoVectors === 'function') {
  rpc.onIndexVideoVectors(async (req) => {
    try { const result = await api.indexVideoVectors?.(req.channelKey, req.videoId); return { success: Boolean(result?.success), error: result?.error || null } }
    catch (e) { return { success: false, error: e?.message || 'Indexing failed' } }
  })
}

if (typeof rpc.onLogWatchEvent === 'function') {
  rpc.onLogWatchEvent(async () => ({ success: true }))
}

if (typeof rpc.onRetrySyncChannel === 'function') {
  rpc.onRetrySyncChannel(async (req) => {
    try { await api.retrySyncChannel?.(req.channelKey); return { success: true } }
    catch (e) { return { success: false, error: e?.message } }
  })
}

// ============================================
// IPC shutdown handling
// ============================================
let shutdownIpcInFlight = null

async function handleIpcShutdownRequest() {
  if (shutdownIpcInFlight) return shutdownIpcInFlight
  shutdownIpcInFlight = (async () => {
    setIsShuttingDown(true)
    await shutdownBackend(ctx)
    closeCastProxyServer('ipc-shutdown')
    closeOwnerLock('shutdown')
    try { IPC.write(b4a.from(JSON.stringify({ type: 'shutdown-complete' }))) } catch {}
  })().finally(() => { shutdownIpcInFlight = null })
  return shutdownIpcInFlight
}

function parseIpcShutdownMessage(chunk) {
  if (!chunk) return null
  try {
    const text = b4a.toString(chunk).trim()
    if (!text || text[0] !== '{') return null
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch { return null }
}

if (IPC?.on) {
  IPC.on('data', (chunk) => {
    const msg = parseIpcShutdownMessage(chunk)
    if (msg?.type === 'shutdown') handleIpcShutdownRequest().catch((err) => console.warn('[Backend] IPC shutdown failed:', err?.message || err))
  })
  IPC.on('close', () => castCleanup.enterHeadlessMode('ipc-close'))
  IPC.on('end', () => castCleanup.enterHeadlessMode('ipc-end'))
}

// ============================================
// Feed cache + eventReady
// ============================================
async function restoreFeedCache() {
  try {
    const cached = await ctx.metaDb.get('public-feed-cache').catch(() => null)
    const entries = cached?.value || []
    if (Array.isArray(entries) && entries.length) {
      for (const entry of entries) {
        try {
          if (typeof entry === 'object' && entry.driveKey) publicFeed.addEntry(entry.driveKey, 'peer', entry.publicBeeKey || null)
          else if (typeof entry === 'string') publicFeed.addEntry(entry, 'peer')
        } catch {}
      }
    }
  } catch {}
}

async function persistFeedCache() {
  try {
    const entries = publicFeed.getFeed().map((e) => ({ driveKey: e.driveKey, publicBeeKey: e.publicBeeKey || null }))
    await ctx.metaDb.put('public-feed-cache', entries)
  } catch {}
}

await restoreFeedCache()

// Send ready event + initial feed update
const blobPort = ctx.blobServer?.port || ctx.blobServerPort || 0
console.log('[Backend] Backend initialized, blob server port:', blobPort)
try {
  rpc.eventReady({ blobServerPort: blobPort, blobServerHost: ctx.blobServerHost || '127.0.0.1' })
  rpc.eventFeedUpdate({ channelKey: 'feed', action: 'update' })
} catch (e) {
  console.error('[Backend] Failed to send eventReady:', e.message)
}

// Keep discovery fresh
setInterval(() => {
  try { publicFeed.requestFeedsFromPeers(); persistFeedCache() } catch {}
}, 30000)

publicFeed.setOnFeedUpdate(() => {
  persistFeedCache()
  try { rpc?.eventFeedUpdate?.({ channelKey: 'feed', action: 'update' }) } catch {}
})

// Pre-load ffmpeg if requested
const preloadFfmpeg = typeof process !== 'undefined' && process?.env?.PEARTUBE_PRELOAD_FFMPEG === '1'
if (preloadFfmpeg) {
  backendLog('[Backend] Pre-loading bare-ffmpeg...')
  transcoder.loadBareFfmpeg().then((loaded) => backendLog('[Backend] bare-ffmpeg pre-load: ' + loaded)).catch(err => backendLog('[Backend] bare-ffmpeg pre-load error: ' + (err?.message || err)))
}
