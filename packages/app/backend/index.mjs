/**
 * PearTube Mobile Backend - Thin HRPC layer over @peartube/backend
 *
 * This is a minimal wrapper that:
 * 1. Initializes the backend using createBackendContext
 * 2. Registers HRPC handlers that delegate to backend API
 * 3. Handles mobile-specific concerns (BareKit IPC, single identity)
 */

import HRPC from '@peartube/spec'
import { createBackendContext } from '@peartube/backend/orchestrator'
import { loadDrive } from '@peartube/backend/storage'
import path from 'bare-path'
import fs from 'bare-fs'
import b4a from 'b4a'
import http1 from 'bare-http1'

// Get IPC from BareKit, args from Bare
const { IPC } = BareKit
const storagePath = Bare.argv[0] || ''

// Debug: Log storagePath to identify initialization issues
console.log('[Backend] Raw storagePath from Bare.argv[0]:', storagePath || '(empty)')
console.log('[Backend] Bare.argv:', JSON.stringify(Bare.argv))

// Warn if storagePath looks invalid but continue
if (!storagePath || !storagePath.startsWith('/')) {
  console.warn('[Backend] WARNING: storagePath may be invalid:', storagePath)
}

// HRPC instance (initialized early so we can surface init errors)
let rpc = null

// ============================================
// Cast (FCast/Chromecast) helpers
// ============================================

let castProxyServer = null
let castProxyPort = 0
let castProxyReady = null
const castProxySessions = new Map()
const CAST_PROXY_TTL_MS = 30 * 60 * 1000

let CastContext = null
let castLoadError = null
let castLoadPromise = null
let castContext = null

const CAST_LOCALHOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1'])

function cleanupCastProxySessions(now = Date.now()) {
  for (const [token, entry] of castProxySessions.entries()) {
    if (now - entry.createdAt > CAST_PROXY_TTL_MS) {
      castProxySessions.delete(token)
    }
  }
}

function buildLocalProxyTarget(url) {
  try {
    const parsed = new URL(url)
    if (CAST_LOCALHOSTS.has(parsed.hostname)) {
      parsed.hostname = '127.0.0.1'
    }
    return parsed
  } catch {
    return null
  }
}

async function ensureCastProxyServer() {
  if (castProxyPort) return castProxyPort
  if (castProxyReady) return castProxyReady

  castProxyReady = new Promise((resolve, reject) => {
    castProxyServer = http1.createServer((req, res) => {
      try {
        console.log('[CastProxy] incoming', req.method || 'GET', req.url || '/')
      } catch {}
      const now = Date.now()
      cleanupCastProxySessions(now)
      const base = 'http://localhost'
      const parsed = new URL(req.url || '/', base)
      if (parsed.pathname === '/cast/ping') {
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/plain')
        res.end('pong')
        return
      }
      const parts = parsed.pathname.split('/').filter(Boolean)
      const token = parts[0] === 'cast' ? parts[1] : null

      if (!token || !castProxySessions.has(token)) {
        console.warn('[CastProxy] missing token or session', token || 'none')
        res.statusCode = 404
        res.setHeader('Content-Type', 'text/plain')
        res.end('Cast proxy session not found.')
        return
      }

      const entry = castProxySessions.get(token)
      const target = entry ? buildLocalProxyTarget(entry.url) : null
      if (!target) {
        console.warn('[CastProxy] invalid target url for token', token)
        res.statusCode = 500
        res.setHeader('Content-Type', 'text/plain')
        res.end('Cast proxy target invalid.')
        return
      }
      try {
        const remote = req.socket?.remoteAddress || 'unknown'
        console.log('[CastProxy] request from', remote, '->', target.host)
      } catch {}

      const proxyReq = http1.request({
        method: req.method || 'GET',
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        headers: {
          range: req.headers?.range,
        },
      }, (proxyRes) => {
        res.statusCode = proxyRes.statusCode || 502
        try {
          console.log('[CastProxy] upstream status', proxyRes.statusCode, 'len', proxyRes.headers?.['content-length'] || 'unknown')
        } catch {}
        if (proxyRes.headers) {
          for (const [key, value] of Object.entries(proxyRes.headers)) {
            if (value !== undefined) {
              res.setHeader(key, value)
            }
          }
        }
        proxyRes.pipe(res)
      })

      proxyReq.on('error', (err) => {
        console.warn('[CastProxy] upstream error:', err?.message || err)
        if (!res.headersSent) {
          res.statusCode = 502
          res.setHeader('Content-Type', 'text/plain')
          res.end(`Cast proxy upstream error: ${err?.message || err}`)
          return
        }
        res.end()
      })

      if (req.method === 'HEAD') {
        proxyReq.end()
      } else {
        req.pipe(proxyReq)
      }
    })

    castProxyServer.on('error', (err) => {
      console.error('[CastProxy] server error:', err?.message || err)
      reject(err)
    })

    castProxyServer.listen(0, '0.0.0.0', () => {
      const addr = castProxyServer.address?.() || null
      castProxyPort = addr?.port || 0
      console.log('[CastProxy] listening on', addr?.address || '0.0.0.0', 'port:', castProxyPort)
      resolve(castProxyPort)
    })
  })

  return castProxyReady
}

function isUsableIPv4(address, family) {
  if (!address) return false
  if (address.includes(':')) return false
  if (CAST_LOCALHOSTS.has(address)) return false
  if (address.startsWith('127.')) return false
  if (family && family !== 4 && family !== 'IPv4') return false
  return true
}

async function getLocalIPv4ForTarget(targetHost) {
  if (!targetHost) return null

  try {
    const mod = await import('bare-dgram')
    const dgram = mod?.default || mod
    const socket = (() => {
      try {
        return dgram.createSocket('udp4')
      } catch {}
      try {
        return dgram.createSocket({ type: 'udp4' })
      } catch {}
      return dgram.createSocket()
    })()
    await new Promise((resolve) => socket.bind(0, resolve))
    socket.connect(1, targetHost)
    const addr = socket.address?.()
    const local = addr?.address || null
    await socket.close?.()
    if (isUsableIPv4(local, addr?.family)) {
      return local
    }
  } catch (err) {
    console.warn('[Backend] bare-dgram local IP detection failed:', err?.message || err)
  }

  let targetPrefix = null
  const parts = targetHost.split('.')
  if (parts.length === 4) {
    targetPrefix = parts.slice(0, 3).join('.')
  }

  try {
    const mod = await import('udx-native')
    const UDX = mod?.default || mod
    const udx = new UDX()
    let fallback = null

    for (const iface of udx.networkInterfaces()) {
      if (iface.family !== 4 || iface.internal) continue
      if (!isUsableIPv4(iface.host, iface.family)) continue
      if (targetPrefix && iface.host.startsWith(`${targetPrefix}.`)) {
        return iface.host
      }
      if (!fallback) fallback = iface.host
    }

    return fallback
  } catch (err) {
    console.warn('[Backend] udx-native not available for IP detection:', err?.message || err)
    return null
  }
}

function rewriteUrlHost(url, host) {
  try {
    const parsed = new URL(url)
    parsed.hostname = host
    return parsed.toString()
  } catch {
    return url
  }
}

async function createCastProxyUrl(targetHost, sourceUrl) {
  const localIp = await getLocalIPv4ForTarget(targetHost)
  if (!localIp || !castProxyPort) {
    console.warn('[Backend] Cast proxy unavailable', {
      localIp: localIp || null,
      port: castProxyPort || 0
    })
    return null
  }
  console.log('[Backend] Cast proxy local IP selected:', localIp, 'targetHost:', targetHost || 'unknown')
  cleanupCastProxySessions()
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  castProxySessions.set(token, { url: sourceUrl, createdAt: Date.now() })
  return `http://${localIp}:${castProxyPort}/cast/${token}`
}

async function loadBareFcast() {
  if (CastContext || castLoadError) return
  if (castLoadPromise) return castLoadPromise
  castLoadPromise = (async () => {
    let lastError
    if (typeof require === 'function') {
      try {
        const mod = require('bare-fcast')
        CastContext = mod?.CastContext ?? mod?.default ?? mod
        console.log('[Backend] bare-fcast loaded')
        return
      } catch (err) {
        lastError = err
      }
    }
    try {
      const mod = await import('bare-fcast')
      CastContext = mod?.CastContext ?? mod?.default ?? mod
      console.log('[Backend] bare-fcast loaded')
      return
    } catch (err) {
      lastError = err
    }
    castLoadError = lastError?.message || 'Unknown error'
    console.warn('[Backend] bare-fcast not available:', castLoadError)
  })()
  return castLoadPromise
}

function getCastContext() {
  if (!castContext && CastContext) {
    castContext = new CastContext()

    castContext.on('deviceFound', (device) => {
      try {
        rpc?.eventCastDeviceFound?.({ device: {
          id: device.id,
          name: device.name,
          host: device.host,
          port: device.port,
          protocol: device.protocol,
        }})
      } catch {}
    })

    castContext.on('deviceLost', (deviceId) => {
      try {
        rpc?.eventCastDeviceLost?.({ deviceId })
      } catch {}
    })

    castContext.on('playbackStateChanged', (state) => {
      try {
        rpc?.eventCastPlaybackState?.({ state })
      } catch {}
    })

    castContext.on('timeChanged', (time) => {
      try {
        rpc?.eventCastTimeUpdate?.({ currentTime: time })
      } catch {}
    })

    castContext.on('error', (error) => {
      try {
        const message = error?.message || String(error)
        console.warn('[Backend] Cast error:', message)
        rpc?.eventCastPlaybackState?.({ state: 'error', error: message })
      } catch {}
    })
  }
  return castContext
}

function formatError(err) {
  if (!err) return 'Unknown error'
  if (err instanceof Error) {
    return err.stack || err.message || String(err)
  }
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function reportBackendError(label, err) {
  const message = err instanceof Error ? err.message : (typeof err === 'string' ? err : 'Unknown error')
  console.error(`[Backend] ${label}:`, message)
  if (err?.stack) {
    console.error(err.stack)
  } else if (message && message !== 'Unknown error') {
    console.error('[Backend] Detail:', formatError(err))
  }
  try {
    rpc?.eventError?.({ message: `${label}: ${message}` })
  } catch {}
}

function ensureRpc() {
  if (rpc) return true
  try {
    rpc = new HRPC(IPC)
    console.log('[Backend] HRPC initialized')

    // Backward-compat shim: some mobile bundles still send old command ids.
    // Map old refresh-feed id (16) to the new id (18) only when payload is empty,
    // so normal join-channel requests (which include data) keep working.
    try {
      const rawRpc = rpc?._rpc
      if (rawRpc && !rawRpc._peartubeCompat) {
        const originalOnRequest = rawRpc._onrequest
        rawRpc._onrequest = async (req) => {
          try {
            if (req?.command === 16 && (!req.data || req.data.length === 0)) {
              req.command = 18
            }
          } catch {}
          try {
            return await originalOnRequest(req)
          } catch (err) {
            console.error('[Backend] HRPC request failed:', req?.command, err?.message || err)
            return
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

  if (typeof Bare !== 'undefined' && Bare?.on) {
    Bare.on('unhandledRejection', (reason) => {
      notify('Unhandled rejection', reason)
    })
  }

  const proc = typeof process !== 'undefined' ? process : null
  if (proc && typeof proc.on === 'function') {
    proc.on('unhandledRejection', (reason) => notify('Unhandled rejection', reason))
    proc.on('uncaughtException', (err) => notify('Uncaught exception', err))
    console.log('[Backend] process error handlers attached')
  }

  const g = typeof globalThis !== 'undefined' ? globalThis : null
  if (!g) return

  if (typeof g.addEventListener === 'function') {
    g.addEventListener('unhandledrejection', (event) => {
      notify('Unhandled rejection', event?.reason ?? event)
      event?.preventDefault?.()
    })
    g.addEventListener('error', (event) => {
      notify('Uncaught error', event?.error ?? event?.message ?? event)
    })
    console.log('[Backend] global error handlers attached')
    return
  }

  if ('onunhandledrejection' in g) {
    const prev = g.onunhandledrejection
    g.onunhandledrejection = (event) => {
      notify('Unhandled rejection', event?.reason ?? event)
      if (typeof prev === 'function') prev(event)
    }
  }

  if ('onerror' in g) {
    const prev = g.onerror
    g.onerror = (message, source, lineno, colno, error) => {
      notify('Uncaught error', error || message)
      if (typeof prev === 'function') return prev(message, source, lineno, colno, error)
      return false
    }
  }
}

console.log('[Backend] Starting PearTube mobile backend')
console.log('[Backend] Storage path:', storagePath)

ensureRpc()
attachUnhandledHandlers()

// Initialize storage directory
const storageDir = path.join(storagePath, 'peartube-data')
try {
  fs.mkdirSync(storageDir, { recursive: true })
} catch (e) {
  // Directory may already exist
}

// Helps confirm which backend bundle is actually running on device.
const BACKEND_BUNDLE_VERSION = 'mw-sync-debug-2025-12-15'
console.log('[Backend] Bundle version:', BACKEND_BUNDLE_VERSION)

// Initialize backend
let backend = null
try {
  backend = await createBackendContext({
    storagePath: storageDir,
    onFeedUpdate: () => {
      if (rpc) {
        try {
          rpc.eventFeedUpdate({ channelKey: 'feed', action: 'update' })
        } catch (e) {
          console.log('[Backend] Failed to send feed update:', e.message)
        }
      }
    },
    onStatsUpdate: (driveKey, videoPath, stats) => {
      if (rpc) {
        try {
          // HRPC `event-video-stats` expects `{ stats: VideoStats }` where VideoStats matches the schema:
          // status/progress/totalBlocks/downloadedBlocks/totalBytes/downloadedBytes/peerCount/speedMBps/uploadSpeedMBps/elapsed/isComplete
          rpc.eventVideoStats({
            stats: {
              // Ensure identifiers are always present for routing on the client side.
              videoId: videoPath,
              channelKey: driveKey,
              // The backend VideoStatsTracker already produces schema-compatible fields.
              ...stats
            }
          })
        } catch (e) {
          console.log('[Backend] Failed to send video stats:', e.message)
        }
      }
    }
  })
} catch (err) {
  reportBackendError('Backend init failed', err)
}

if (!backend) {
  console.log('[Backend] Backend unavailable; skipping HRPC handler registration')
  await new Promise(() => {})
}

const { ctx, api, identityManager, uploadManager, publicFeed, seedingManager, videoStats } = backend

const blobPort = ctx.blobServer?.port || ctx.blobServerPort || 0
console.log('[Backend] Backend initialized, blob server port:', blobPort, '(from blobServer.port:', ctx.blobServer?.port, ', from ctx.blobServerPort:', ctx.blobServerPort, ')')

ensureRpc()
if (!rpc) {
  reportBackendError('HRPC unavailable', 'Failed to initialize HRPC transport')
  await new Promise(() => {})
}

function getThumbnailMime(thumbPath) {
  const ext = thumbPath.split('.').pop()?.toLowerCase() || 'jpg'
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'image/jpeg'
}

// Migrate existing thumbnails to blob-backed entries (so URLs persist across restarts)
async function migrateThumbnails(drive) {
  try {
    for await (const name of drive.readdir('/thumbnails').catch(() => [])) {
      const thumbPath = `/thumbnails/${name}`
      const entry = await drive.entry(thumbPath).catch(() => null)
      if (entry && entry.value?.blob) continue

      const buf = await drive.get(thumbPath, { wait: true, timeout: 3000 }).catch(() => null)
      if (!buf) continue

      console.log('[Backend] Migrating inline thumbnail to blob:', thumbPath)
      await new Promise((resolve, reject) => {
        const ws = drive.createWriteStream(thumbPath)
        ws.on('error', reject)
        ws.on('close', resolve)
        ws.end(buf)
      })
    }
  } catch (e) {
    console.log('[Backend] Thumbnail migration skipped:', e?.message)
  }
}

const activeDriveForMigration = identityManager.getActiveDrive?.()
if (activeDriveForMigration) {
  migrateThumbnails(activeDriveForMigration)
}

// Restore cached public feed so restart doesn't start from empty
async function restoreFeedCache() {
  try {
    const cached = await ctx.metaDb.get('public-feed-cache').catch(() => null)
    const keys = cached?.value || []
    if (Array.isArray(keys) && keys.length) {
      console.log('[Backend] Restoring public feed cache, entries:', keys.length)
      for (const key of keys) {
        try {
          publicFeed.addEntry(key, 'peer')
        } catch {}
      }
    }
  } catch (e) {
    console.log('[Backend] Feed cache restore skipped:', e?.message)
  }
}

// Persist feed cache
async function persistFeedCache() {
  try {
    const entries = publicFeed.getFeed().map((e) => e.driveKey)
    await ctx.metaDb.put('public-feed-cache', entries)
    console.log('[Backend] Saved public feed cache:', entries.length)
  } catch (e) {
    console.log('[Backend] Feed cache save skipped:', e?.message)
  }
}

await restoreFeedCache()

// ============================================
// HRPC Handler Registration - Thin delegation layer
// ============================================

// Identity handlers
rpc.onCreateIdentity(async (req) => {
  console.log('[HRPC] createIdentity:', req.name)
  const result = await identityManager.createIdentity(req.name || 'New Channel', true)
  return {
    identity: {
      publicKey: result.publicKey,
      name: req.name || 'New Channel',
      seedPhrase: result.mnemonic || ''
    }
  }
})

rpc.onGetIdentity(async () => {
  console.log('[HRPC] getIdentity')
  const ident = identityManager.getActiveIdentity()
  return { identity: ident || null }
})

rpc.onGetIdentities(async () => {
  console.log('[HRPC] getIdentities')
  const identities = identityManager.getIdentities()
  const active = identityManager.getActiveIdentity()
  return {
    identities: identities.map(i => ({
      ...i,
      isActive: active?.publicKey === i.publicKey
    }))
  }
})

rpc.onSetActiveIdentity(async (req) => {
  console.log('[HRPC] setActiveIdentity:', req.publicKey?.slice(0, 16))
  await identityManager.setActiveIdentity(req.publicKey)
  return { success: true }
})

rpc.onRecoverIdentity(async (req) => {
  console.log('[HRPC] recoverIdentity')
  try {
    const result = await identityManager.recoverIdentity(req.seedPhrase, req.name)
    return { identity: result }
  } catch (e) {
    console.error('[HRPC] Recovery failed:', e.message)
    return { identity: null }
  }
})

// Channel handlers
rpc.onGetChannel(async (req) => {
  console.log('[HRPC] getChannel:', req.publicKey?.slice(0, 16))
  const channel = await api.getChannel(req.publicKey || '')
  return { channel }
})

rpc.onUpdateChannel(async (req) => {
  console.log('[HRPC] updateChannel')
  const active = identityManager.getActiveIdentity()
  if (active) {
    await api.updateChannel(active.driveKey, req.name, req.description)
  }
  return { channel: {} }
})

// Video handlers
rpc.onListVideos(async (req) => {
  const channelKey = req?.channelKey || ''
  console.log('[HRPC] listVideos:', channelKey?.slice(0, 16))

  // Always respond quickly; never let listVideos hang the client.
  if (!channelKey) return { videos: [] }

  let rawVideos = []
  try {
    rawVideos = await api.listVideos(channelKey)
  } catch (e) {
    console.log('[HRPC] listVideos failed:', e?.message)
    return { videos: [] }
  }

  // IMPORTANT: Keep listVideos fast. Thumbnails are fetched lazily by the UI via getVideoThumbnail.
  // Doing per-video thumbnail resolution here can easily trigger the app-side listVideos timeout on mobile.
  // IMPORTANT: HRPC encoding expects `id` and `title` as strings. If we return malformed items,
  // HRPC can fail to encode and the request will never resolve on the client (leading to timeouts).
  const videos = (rawVideos || [])
    .map((v) => {
      const id = v?.id ? String(v.id) : ''
      if (!id) return null

      const title = v?.title ? String(v.title) : 'Untitled'
      const createdAt = Number(v?.createdAt || v?.uploadedAt || Date.now()) || 0

      return {
        id,
        title,
        description: v?.description ? String(v.description) : null,
        path: v?.path ? String(v.path) : null,
        duration: Number(v?.duration || 0) || 0,
        thumbnail: v?.thumbnail ? String(v.thumbnail) : null,
        channelKey: v?.channelKey || channelKey,
        channelName: v?.channelName ? String(v.channelName) : '',
        createdAt,
        views: Number(v?.views || 0) || 0,
        category: v?.category ? String(v.category) : null
      }
    })
    .filter(Boolean)

  return { videos }
})

rpc.onGetVideoUrl(async (req) => {
  console.log('[HRPC] getVideoUrl:', req.channelKey?.slice(0, 16), req.videoId)
  const result = await api.getVideoUrl(req.channelKey, req.videoId)
  return { url: result.url }
})

rpc.onGetVideoData(async (req) => {
  console.log('[HRPC] getVideoData:', req.channelKey?.slice(0, 16), req.videoId)
  const video = await api.getVideoData(req.channelKey, req.videoId)
  return { video: video || { id: req.videoId, title: 'Unknown' } }
})

rpc.onUploadVideo(async (req) => {
  console.log('[HRPC] uploadVideo:', req.title, 'filePath:', req.filePath)
  const active = identityManager.getActiveIdentity()
  if (!active?.driveKey) {
    throw new Error('No active identity')
  }
  const channel = await identityManager.getActiveChannel?.()
  if (!channel) throw new Error('No active channel')

  // Ensure blobs are ready for upload
  if (!channel.blobs) {
    throw new Error('Channel blobs not initialized')
  }

  let filePath = req.filePath
  if (!filePath) {
    throw new Error('No file path provided')
  }

  // Handle file:// prefix
  if (filePath.startsWith('file://')) {
    filePath = filePath.slice(7)
  }

  const ext = filePath.split('.').pop()?.toLowerCase() || 'mp4'
  const mimeTypes = {
    'mp4': 'video/mp4',
    'm4v': 'video/mp4',
    'webm': 'video/webm',
    'mkv': 'video/x-matroska',
    'mov': 'video/quicktime',
    'avi': 'video/x-msvideo',
  }
  const mimeType = mimeTypes[ext] || 'video/mp4'
  console.log('[HRPC] Streaming upload from:', filePath, 'mime:', mimeType)

  // Use streaming upload - file streams directly to Hyperblobs
  const result = await uploadManager.uploadFromPath(
    channel,  // Pass channel (has blobs property for Hyperblobs)
    filePath,
    {
      title: req.title,
      description: req.description || '',
      mimeType,
      category: req.category || ''
    },
    fs,  // Pass bare-fs for file reading
    (progress, bytesWritten, totalBytes) => {
      // Emit progress event
      rpc.eventUploadProgress({ progress })
    }
  )

  console.log('[HRPC] Upload result:', JSON.stringify({ success: result?.success, videoId: result?.videoId, blobId: result?.metadata?.blobId }))

  // Note: uploadManager.uploadFromPath already calls channel.addVideo internally
  if (!result?.success) {
    console.error('[HRPC] Upload failed:', result?.error)
  }

  console.log('[HRPC] Returning upload response')
  return {
    video: {
      id: result?.videoId || '',
      title: req.title,
      description: req.description || '',
      channelKey: active.driveKey
    }
  }
})

rpc.onDownloadVideo(async (req, ctx) => {
  console.log('[HRPC] downloadVideo:', req.channelKey?.slice(0, 16), req.videoId, 'destPath:', req.destPath)

  try {
    // Get video metadata for filename and size
    const meta = await api.getVideoData(req.channelKey, req.videoId, req.publicBeeKey)
    if (!meta) {
      return { success: false, error: 'Video metadata not found' }
    }

    // Generate filename
    const sanitizedTitle = (meta.title || 'video')
      .replace(/[^a-zA-Z0-9\s\-_]/g, '')
      .replace(/\s+/g, '_')
      .slice(0, 50)
    const ext = meta.mimeType?.includes('webm') ? 'webm' :
                meta.mimeType?.includes('mkv') ? 'mkv' : 'mp4'
    const filename = `${sanitizedTitle}_${req.videoId}.${ext}`

    // Save to Downloads subdirectory
    const downloadsDir = path.join(storagePath, 'Downloads')
    console.log('[HRPC] storagePath:', storagePath)
    console.log('[HRPC] downloadsDir:', downloadsDir)

    // Create downloads directory synchronously before download
    try {
      const stat = fs.statSync(downloadsDir)
      console.log('[HRPC] downloads dir exists, isDir:', stat.isDirectory())
    } catch (statErr) {
      console.log('[HRPC] downloads dir does not exist, creating...')
      fs.mkdirSync(downloadsDir)
      console.log('[HRPC] Created downloads directory')
    }

    const destPath = req.destPath || path.join(downloadsDir, filename)

    console.log('[HRPC] Downloading to:', destPath)

    // Use the API's downloadVideo method which streams with progress
    const result = await api.downloadVideo(
      req.channelKey,
      req.videoId,
      destPath,
      fs,
      (progress, bytesWritten, totalBytes) => {
        // Emit progress event to frontend
        try {
          rpc.eventDownloadProgress({
            id: `${req.channelKey}:${req.videoId}`,
            progress,
            bytesDownloaded: bytesWritten,
            totalBytes
          })
        } catch (e) {
          // Ignore event emission errors
        }
      }
    )

    if (!result?.success) {
      return { success: false, error: result?.error || 'Download failed' }
    }

    console.log('[HRPC] Download complete:', destPath)
    return {
      success: true,
      filePath: destPath,
      size: result.size || 0
    }
  } catch (err) {
    console.error('[HRPC] downloadVideo failed:', err?.message)
    return { success: false, error: err?.message || 'download failed' }
  }
})

// Delete video handler
rpc.onDeleteVideo(async (req) => {
  console.log('[HRPC] deleteVideo:', req.videoId)
  const channel = await identityManager.getActiveChannel?.()
  if (!channel) return { success: false, error: 'No active channel' }
  try {
    await channel.deleteVideo(req.videoId)
    return { success: true }
  } catch (e) {
    return { success: false, error: e?.message || 'Delete failed' }
  }
})

// Subscription handlers
rpc.onSubscribeChannel(async (req) => {
  console.log('[HRPC] subscribeChannel:', req.channelKey?.slice(0, 16))
  await api.subscribeChannel(req.channelKey)
  return { success: true }
})

rpc.onUnsubscribeChannel(async (req) => {
  console.log('[HRPC] unsubscribeChannel:', req.channelKey?.slice(0, 16))
  await api.unsubscribeChannel(req.channelKey)
  return { success: true }
})

rpc.onGetSubscriptions(async () => {
  console.log('[HRPC] getSubscriptions')
  const subs = await api.getSubscriptions()
  return {
    subscriptions: subs.map(s => ({
      channelKey: s.driveKey,
      channelName: s.name
    }))
  }
})

rpc.onJoinChannel(async (req) => {
  console.log('[HRPC] joinChannel:', req.channelKey?.slice(0, 16))
  await api.subscribeChannel(req.channelKey)
  return { success: true }
})

// Public Feed handlers
rpc.onGetPublicFeed(async () => {
  console.log('[HRPC] getPublicFeed')
  const result = await api.getPublicFeed()
  return {
    entries: result.entries.map(e => ({
      channelKey: e.driveKey || e.channelKey,
      channelName: e.name,
      videoCount: e.videoCount || 0,
      peerCount: e.peerCount || 0,
      lastSeen: e.lastSeen || 0
    }))
  }
})

rpc.onRefreshFeed(async () => {
  console.log('[HRPC] refreshFeed')
  await api.refreshFeed()
  return { success: true }
})

rpc.onSubmitToFeed(async () => {
  console.log('[HRPC] submitToFeed')
  const active = identityManager.getActiveIdentity()
  if (active?.driveKey) {
    await api.submitToFeed(active.driveKey)
  }
  return { success: true }
})

rpc.onUnpublishFromFeed(async () => {
  console.log('[HRPC] unpublishFromFeed')
  const active = identityManager.getActiveIdentity()
  if (active?.driveKey) {
    await api.unpublishFromFeed(active.driveKey)
  }
  return { success: true }
})

rpc.onIsChannelPublished(async () => {
  console.log('[HRPC] isChannelPublished')
  const active = identityManager.getActiveIdentity()
  if (active?.driveKey) {
    return api.isChannelPublished(active.driveKey)
  }
  return { published: false }
})

rpc.onHideChannel(async (req) => {
  console.log('[HRPC] hideChannel:', req.channelKey?.slice(0, 16))
  await api.hideChannel(req.channelKey)
  return { success: true }
})

rpc.onGetChannelMeta(async (req) => {
  console.log('[HRPC] getChannelMeta:', req.channelKey?.slice(0, 16))
  const meta = await api.getChannelMeta(req.channelKey)
  return {
    name: meta.name,
    description: meta.description,
    videoCount: meta.videoCount || 0
  }
})

rpc.onGetSwarmStatus(async () => {
  console.log('[HRPC] getSwarmStatus')
  const status = await api.getSwarmStatus()
  return {
    connected: status.swarmConnections > 0,
    peerCount: status.swarmConnections
  }
})

// Multi-device pairing
rpc.onCreateDeviceInvite(async (req) => {
  console.log('[HRPC] createDeviceInvite:', req.channelKey?.slice(0, 16))
  const res = await api.createDeviceInvite(req.channelKey)
  return { inviteCode: res.inviteCode }
})

rpc.onPairDevice(async (req) => {
  console.log('[HRPC] pairDevice')
  const res = await api.pairDevice(req.inviteCode, req.deviceName || '')
  // If this device doesn't have an identity yet, create one that points at the paired channel.
  try {
    const existing = identityManager.getIdentities?.() || []
    if (existing.length === 0 && res?.channelKey) {
      await identityManager.addPairedChannelIdentity?.(res.channelKey, 'Paired Channel')
    }
  } catch (e) {
    console.log('[HRPC] addPairedChannelIdentity skipped:', e?.message)
  }
  return { success: Boolean(res.success), channelKey: res.channelKey }
})

rpc.onListDevices(async (req) => {
  console.log('[HRPC] listDevices:', req.channelKey?.slice(0, 16))
  const res = await api.listDevices(req.channelKey)
  // HRPC schema expects Device[]; backend returns writer records (keyHex, role, deviceName...)
  return { devices: res.devices || [] }
})

rpc.onRetrySyncChannel(async (req) => {
  console.log('[HRPC] retrySyncChannel:', req.channelKey?.slice(0, 16))
  // Response format: { success, error? }
  try {
    await api.retrySyncChannel?.(req.channelKey)
    return { success: true }
  } catch (e) {
    console.log('[HRPC] retrySyncChannel failed:', e?.message)
    return { success: false, error: e?.message }
  }
})

// Video prefetch and stats
rpc.onPrefetchVideo(async (req) => {
  console.log('[HRPC] prefetchVideo:', req.channelKey?.slice(0, 16), req.videoId)
  await api.prefetchVideo(req.channelKey, req.videoId, req.publicBeeKey)
  return { success: true }
})

rpc.onGetVideoStats(async (req) => {
  console.log('[HRPC] getVideoStats:', req.channelKey?.slice(0, 16), req.videoId)
  const stats = await api.getVideoStats(req.channelKey, req.videoId)
  return {
    stats: {
      // Ensure identifiers exist (schema supports these fields too)
      videoId: req.videoId,
      channelKey: req.channelKey,
      // Prefer the backend's schema-shaped stats object.
      ...(stats || {})
    }
  }
})

// Seeding handlers
rpc.onGetSeedingStatus(async () => {
  console.log('[HRPC] getSeedingStatus')
  const status = await api.getSeedingStatus()
  return {
    status: {
      enabled: status.config?.autoSeedWatched || false,
      usedStorage: status.storageUsedBytes || 0,
      maxStorage: (status.maxStorageGB || 10) * 1024 * 1024 * 1024,
      seedingCount: status.activeSeeds || 0
    }
  }
})

rpc.onSetSeedingConfig(async (req) => {
  console.log('[HRPC] setSeedingConfig')
  await api.setSeedingConfig(req.config || {})
  return { success: true }
})

rpc.onPinChannel(async (req) => {
  console.log('[HRPC] pinChannel:', req.channelKey?.slice(0, 16))
  await api.pinChannel(req.channelKey)
  return { success: true }
})

rpc.onUnpinChannel(async (req) => {
  console.log('[HRPC] unpinChannel:', req.channelKey?.slice(0, 16))
  await api.unpinChannel(req.channelKey)
  return { success: true }
})

rpc.onGetPinnedChannels(async () => {
  console.log('[HRPC] getPinnedChannels')
  const result = await api.getPinnedChannels()
  return { channels: result.channels || [] }
})

// Storage management handlers
rpc.onGetStorageStats(async () => {
  console.log('[HRPC] getStorageStats')
  return api.getStorageStats()
})

rpc.onSetStorageLimit(async (req) => {
  console.log('[HRPC] setStorageLimit:', req.maxGB)
  return await api.setStorageLimit(req.maxGB)
})

rpc.onClearCache(async () => {
  console.log('[HRPC] clearCache')
  return await api.clearCache()
})

// Thumbnail handlers
rpc.onGetVideoThumbnail(async (req) => {
  console.log('[HRPC] getVideoThumbnail:', req.channelKey?.slice(0, 16), req.videoId)
  const result = await api.getVideoThumbnail(req.channelKey, req.videoId)
  return { url: result.url || null, exists: result.exists || false, dataUrl: null }
})

rpc.onGetVideoMetadata(async (req) => {
  console.log('[HRPC] getVideoMetadata:', req.channelKey?.slice(0, 16), req.videoId)
  const video = await api.getVideoData(req.channelKey, req.videoId)
  return { video: video || { id: req.videoId, title: 'Unknown' } }
})

rpc.onSetVideoThumbnail(async (req) => {
  console.log('[HRPC] setVideoThumbnail:', req.videoId)
  const active = identityManager.getActiveIdentity()
  if (!active?.driveKey) return { success: false, error: 'No active identity' }

  const channel = await identityManager.getActiveChannel?.()
  if (!channel) return { success: false, error: 'No active channel' }

  if (!channel.blobs) return { success: false, error: 'Channel blobs not initialized' }

  const result = await uploadManager.setThumbnailFromBuffer(
    channel,
    req.videoId,
    Buffer.from(req.imageData || '', 'base64'),
    req.mimeType
  )

  return { success: result.success, error: result.error }
})

// Status handlers
rpc.onGetStatus(async () => {
  console.log('[HRPC] getStatus')
  const active = identityManager.getActiveIdentity()
  return {
    status: {
      ready: true,
      hasIdentity: active !== null,
      blobServerPort: ctx.blobServer?.port || ctx.blobServerPort || 0
    }
  }
})

rpc.onGetBlobServerPort(async () => {
  console.log('[HRPC] getBlobServerPort')
  return { port: ctx.blobServer?.port || ctx.blobServerPort || 0 }
})

// Desktop-specific handlers (stubs for mobile)
rpc.onPickVideoFile(async () => {
  console.log('[HRPC] pickVideoFile - not supported on mobile')
  return { filePath: null, cancelled: true }
})

rpc.onPickImageFile(async () => {
  console.log('[HRPC] pickImageFile - not supported on mobile')
  return { filePath: null, cancelled: true }
})

rpc.onSetVideoThumbnailFromFile(async () => {
  console.log('[HRPC] setVideoThumbnailFromFile - not supported on mobile')
  return { success: false }
})

// Cast handlers (FCast/Chromecast)
rpc.onCastAvailable(async () => {
  await loadBareFcast()
  return { available: CastContext !== null, error: castLoadError }
})

rpc.onCastStartDiscovery(async () => {
  await loadBareFcast()
  if (!CastContext) {
    return { success: false, error: castLoadError || 'bare-fcast not available' }
  }
  try {
    const ctx = getCastContext()
    await ctx.startDiscovery()
    return { success: true }
  } catch (err) {
    console.error('[Backend] Cast discovery error:', err)
    return { success: false, error: err?.message }
  }
})

rpc.onCastStopDiscovery(async () => {
  if (!castContext) return { success: true }
  try {
    castContext.stopDiscovery()
    return { success: true }
  } catch (err) {
    return { success: false, error: err?.message }
  }
})

rpc.onCastGetDevices(async () => {
  if (!castContext) return { devices: [] }
  try {
    const devices = castContext.getDevices()
    return { devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      host: d.host,
      port: d.port,
      protocol: d.protocol,
    })) }
  } catch {
    return { devices: [] }
  }
})

rpc.onCastAddManualDevice(async (req) => {
  await loadBareFcast()
  if (!CastContext) {
    return { success: false, error: castLoadError || 'bare-fcast not available' }
  }
  try {
    const ctx = getCastContext()
    const device = ctx._discoverer.addManualDevice({
      name: req.name,
      host: req.host,
      port: req.port,
      protocol: req.protocol || 'fcast',
    })
    return { success: true, device: {
      id: device.id,
      name: device.name,
      host: device.host,
      port: device.port,
      protocol: device.protocol,
    } }
  } catch (err) {
    return { success: false, error: err?.message }
  }
})

rpc.onCastConnect(async (req) => {
  if (!castContext) {
    return { success: false, error: 'Cast not initialized' }
  }
  let deviceInfo = null
  try {
    try {
      const devices = castContext.getDevices?.() || []
      const device = devices.find((d) => d.id === req.deviceId)
      if (device) {
        console.log('[Backend] Cast connect:', device.name, device.protocol, device.host + ':' + device.port)
        deviceInfo = device
      } else {
        console.log('[Backend] Cast connect: device not found for', req.deviceId)
      }
    } catch {}
    await castContext.connect(req.deviceId)
    return deviceInfo ? {
      success: true,
      device: {
        id: deviceInfo.id,
        name: deviceInfo.name,
        host: deviceInfo.host,
        port: deviceInfo.port,
        protocol: deviceInfo.protocol,
      },
    } : { success: true }
  } catch (err) {
    return { success: false, error: err?.message }
  }
})

rpc.onCastDisconnect(async () => {
  if (!castContext) return { success: true }
  try {
    await castContext.disconnect()
    castProxySessions.clear()
    return { success: true }
  } catch (err) {
    return { success: false, error: err?.message }
  }
})

rpc.onCastPlay(async (req) => {
  if (!castContext?.isConnected()) {
    return { success: false, error: 'Not connected to cast device' }
  }
  try {
    let url = req.url
    try {
      const protocol = castContext?._connectedDevice?.deviceInfo?.protocol
      if (protocol === 'chromecast') {
        let usedProxy = false
        try {
          await ensureCastProxyServer()
          const deviceHost = castContext?._connectedDevice?.deviceInfo?.host
          const proxyUrl = await createCastProxyUrl(deviceHost, req.url)
          if (proxyUrl) {
            url = proxyUrl
            usedProxy = true
            console.log('[Backend] Cast play: using proxy URL', proxyUrl)
          }
        } catch (err) {
          console.warn('[Backend] Cast proxy init failed:', err?.message || err)
        }
        if (!usedProxy) {
          const parsed = new URL(req.url)
          if (CAST_LOCALHOSTS.has(parsed.hostname)) {
            const deviceHost = castContext?._connectedDevice?.deviceInfo?.host
            const localIp = await getLocalIPv4ForTarget(deviceHost)
            if (localIp) {
              url = rewriteUrlHost(req.url, localIp)
              console.log('[Backend] Cast play: rewrote host to', localIp)
            }
          }
        }
      }
    } catch {}
    try {
      let host = 'unknown'
      try {
        const parsed = new URL(url)
        host = parsed.host
      } catch {}
      const protocol = castContext?._connectedDevice?.deviceInfo?.protocol
      console.log('[Backend] Cast play:', protocol || 'unknown', 'contentType:', req.contentType, 'host:', host)
    } catch {}
    await castContext.play({
      url,
      contentType: req.contentType,
      title: req.title,
      thumbnail: req.thumbnail,
      time: req.time,
      volume: req.volume,
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: err?.message }
  }
})

rpc.onCastPause(async () => {
  if (!castContext?.isConnected()) {
    return { success: false, error: 'Not connected' }
  }
  try {
    await castContext.pause()
    return { success: true }
  } catch (err) {
    return { success: false, error: err?.message }
  }
})

rpc.onCastResume(async () => {
  if (!castContext?.isConnected()) {
    return { success: false, error: 'Not connected' }
  }
  try {
    await castContext.resume()
    return { success: true }
  } catch (err) {
    return { success: false, error: err?.message }
  }
})

rpc.onCastStop(async () => {
  if (!castContext?.isConnected()) {
    return { success: false, error: 'Not connected' }
  }
  try {
    await castContext.stop()
    castProxySessions.clear()
    return { success: true }
  } catch (err) {
    return { success: false, error: err?.message }
  }
})

rpc.onCastSeek(async (req) => {
  if (!castContext?.isConnected()) {
    return { success: false, error: 'Not connected' }
  }
  try {
    await castContext.seek(req.time)
    return { success: true }
  } catch (err) {
    return { success: false, error: err?.message }
  }
})

rpc.onCastSetVolume(async (req) => {
  if (!castContext?.isConnected()) {
    return { success: false, error: 'Not connected' }
  }
  try {
    await castContext.setVolume(req.volume)
    return { success: true }
  } catch (err) {
    return { success: false, error: err?.message }
  }
})

rpc.onCastGetState(async () => {
  if (!castContext) {
    return { state: 'idle', currentTime: 0, duration: 0, volume: 1.0 }
  }
  try {
    const state = castContext.getPlaybackState()
    return {
      state: state.state || 'idle',
      currentTime: state.currentTime || 0,
      duration: state.duration || 0,
      volume: state.volume ?? 1.0,
    }
  } catch {
    return { state: 'idle', currentTime: 0, duration: 0, volume: 1.0 }
  }
})

rpc.onCastIsConnected(async () => {
  return { connected: Boolean(castContext?.isConnected()) }
})

rpc.onMpvAvailable(async () => ({ available: false, error: 'MPV not supported on mobile' }))
rpc.onMpvCreate(async () => ({ success: false, error: 'MPV not supported on mobile' }))
rpc.onMpvLoadFile(async () => ({ success: false, error: 'MPV not supported on mobile' }))
rpc.onMpvPlay(async () => ({ success: false, error: 'MPV not supported on mobile' }))
rpc.onMpvPause(async () => ({ success: false, error: 'MPV not supported on mobile' }))
rpc.onMpvSeek(async () => ({ success: false, error: 'MPV not supported on mobile' }))
rpc.onMpvGetState(async () => ({ success: false, currentTime: 0, duration: 0, paused: true }))
rpc.onMpvRenderFrame(async () => ({ success: false, error: 'MPV not supported on mobile' }))
rpc.onMpvDestroy(async () => ({ success: false, error: 'MPV not supported on mobile' }))

// Event handlers (client -> server, usually no-ops)
rpc.onEventReady(() => {
  console.log('[HRPC] Client acknowledged ready')
})

rpc.onEventError((data) => {
  console.error('[HRPC] Client reported error:', data?.message)
})

rpc.onEventCastDeviceFound?.(() => {})
rpc.onEventCastDeviceLost?.(() => {})
rpc.onEventCastPlaybackState?.(() => {})
rpc.onEventCastTimeUpdate?.(() => {})

rpc.onEventUploadProgress(() => {})
rpc.onEventFeedUpdate(() => {})
rpc.onEventLog(() => {})
rpc.onEventVideoStats(() => {})

console.log('[Backend] HRPC handlers registered')

// Send ready event
try {
  const port = ctx.blobServer?.port || ctx.blobServerPort || 0
  rpc.eventReady({ blobServerPort: port, blobServerHost: ctx.blobServerHost || '127.0.0.1' })
  console.log('[Backend] Sent eventReady via HRPC, blobServerPort:', port, 'host:', ctx.blobServerHost || '127.0.0.1')
} catch (e) {
  console.error('[Backend] Failed to send eventReady:', e.message)
}

// Keep discovery fresh: ask peers for feeds periodically and persist cache
setInterval(() => {
  try {
    publicFeed.requestFeedsFromPeers()
    persistFeedCache()
  } catch (e) {
    console.log('[Backend] Feed refresh tick failed:', e?.message)
  }
}, 30000)

// Persist feed when it changes
publicFeed.setOnFeedUpdate(() => {
  persistFeedCache()
  try {
    rpc?.eventFeedUpdate?.({ channelKey: 'feed', action: 'update' })
  } catch {}
})

// ============================================
// Search, Comments, Reactions, Recommendations handlers
// Note: Comments/Reactions are real (backed by CommentsAutobase); keep response shapes aligned with HRPC schema.
// ============================================

// Search handlers
if (typeof rpc.onSearchVideos === 'function') {
  rpc.onSearchVideos(async (req) => {
    console.log('[HRPC] searchVideos:', req.query)
    try {
      const rawResults = await api.searchVideos(req.channelKey, req.query, {
        topK: req.topK || 10,
        federated: Boolean(req.federated)
      })
      const results = (rawResults || []).map((r) => ({
        id: String(r.id || ''),
        score: r.score != null ? String(r.score) : null,
        metadata: r.metadata ? JSON.stringify(r.metadata) : null
      }))
      return { results }
    } catch (e) {
      console.log('[HRPC] searchVideos failed:', e?.message)
      return { results: [] }
    }
  })
} else {
  console.warn('[HRPC] searchVideos handler not registered (client too old)')
}

if (typeof rpc.onGlobalSearchVideos === 'function') {
  rpc.onGlobalSearchVideos(async (req) => {
    console.log('[HRPC] globalSearchVideos:', req.query)
    try {
      const rawResults = await api.globalSearchVideos(req.query, { topK: req.topK || 20 })
      const results = (rawResults || []).map((r) => ({
        id: String(r.id || ''),
        score: r.score != null ? String(r.score) : null,
        metadata: r.metadata ? JSON.stringify(r.metadata) : null
      }))
      return { results }
    } catch (e) {
      console.log('[HRPC] globalSearchVideos failed:', e?.message)
      return { results: [] }
    }
  })
} else {
  console.warn('[HRPC] globalSearchVideos handler not registered (client too old)')
}

if (typeof rpc.onIndexVideoVectors === 'function') {
  rpc.onIndexVideoVectors(async (req) => {
    console.log('[HRPC] indexVideoVectors:', req.channelKey?.slice(0, 16), req.videoId)
    try {
      const result = await api.indexVideoVectors?.(req.channelKey, req.videoId)
      return { success: Boolean(result?.success), error: result?.error || null }
    } catch (e) {
      console.log('[HRPC] indexVideoVectors failed:', e?.message)
      return { success: false, error: e?.message || 'Indexing failed' }
    }
  })
} else {
  console.warn('[HRPC] indexVideoVectors handler not registered (client too old)')
}

// Comment handlers
rpc.onAddComment(async (req) => {
  console.log('[HRPC] addComment:', req.channelKey?.slice(0, 16), req.videoId)
  // Response format: { success, commentId?, queued?, error? }
  try {
    const result = await api.addComment?.(req.channelKey, req.videoId, req.text, req.parentId, req.publicBeeKey)
    return { success: Boolean(result?.success), commentId: result?.commentId || null, queued: false, error: result?.error || null }
  } catch (e) {
    console.log('[HRPC] addComment failed:', e?.message)
    return { success: false, error: e?.message || 'Failed to add comment' }
  }
})

rpc.onListComments(async (req) => {
  console.log('[HRPC] listComments:', req.channelKey?.slice(0, 16), req.videoId)
  // Response format: { success, comments: array, error? }
  try {
    const result = await api.listComments?.(req.channelKey, req.videoId, { page: req.page || 0, limit: req.limit || 50, publicBeeKey: req.publicBeeKey })

    const raw = (result && typeof result === 'object' && Array.isArray(result.comments)) ? result.comments : []
    const comments = raw.map((c) => ({
      videoId: String(c?.videoId || req.videoId || ''),
      commentId: String(c?.commentId || c?.id || ''),
      text: String(c?.text || ''),
      authorKeyHex: String(c?.authorKeyHex || c?.author || ''),
      timestamp: typeof c?.timestamp === 'number' ? c.timestamp : 0,
      parentId: c?.parentId ? String(c.parentId) : null,
      isAdmin: Boolean(c?.isAdmin)
    })).filter((c) => Boolean(c.videoId && c.commentId))

    return { success: Boolean(result?.success), comments, error: result?.error || null }
  } catch (e) {
    console.log('[HRPC] listComments failed:', e?.message)
    return { success: false, comments: [], error: e?.message }
  }
})

rpc.onHideComment(async (req) => {
  console.log('[HRPC] hideComment:', req.commentId)
  // Response format: { success, error? }
  try {
    const result = await api.hideComment?.(req.channelKey, req.videoId, req.commentId, req.publicBeeKey)
    return { success: Boolean(result?.success), error: result?.error || null }
  } catch (e) {
    console.log('[HRPC] hideComment failed:', e?.message)
    return { success: false, error: e?.message }
  }
})

rpc.onRemoveComment(async (req) => {
  console.log('[HRPC] removeComment:', req.commentId)
  // Response format: { success, error? }
  try {
    const result = await api.removeComment?.(req.channelKey, req.videoId, req.commentId, req.publicBeeKey)
    return { success: Boolean(result?.success), queued: false, error: result?.error || null }
  } catch (e) {
    console.log('[HRPC] removeComment failed:', e?.message)
    return { success: false, queued: false, error: e?.message }
  }
})

// Reaction handlers
rpc.onAddReaction(async (req) => {
  console.log('[HRPC] addReaction:', req.channelKey?.slice(0, 16), req.videoId, req.reactionType)
  // Response format: { success, error? }
  try {
    const result = await api.addReaction?.(req.channelKey, req.videoId, req.reactionType, req.publicBeeKey)
    return { success: Boolean(result?.success), queued: false, error: result?.error || null }
  } catch (e) {
    console.log('[HRPC] addReaction failed:', e?.message)
    return { success: false, queued: false, error: e?.message }
  }
})

rpc.onRemoveReaction(async (req) => {
  console.log('[HRPC] removeReaction:', req.channelKey?.slice(0, 16), req.videoId, req.reactionType)
  // Response format: { success, error? }
  try {
    const result = await api.removeReaction?.(req.channelKey, req.videoId, req.publicBeeKey)
    return { success: Boolean(result?.success), queued: false, error: result?.error || null }
  } catch (e) {
    console.log('[HRPC] removeReaction failed:', e?.message)
    return { success: false, queued: false, error: e?.message }
  }
})

rpc.onGetReactions(async (req) => {
  console.log('[HRPC] getReactions:', req.channelKey?.slice(0, 16), req.videoId)
  // Response format: { success, counts: [{reactionType, count}], userReaction?, error? }
  try {
    const result = await api.getReactions?.(req.channelKey, req.videoId, req.publicBeeKey)
    const countsObj = (result && typeof result === 'object' && result.counts && typeof result.counts === 'object')
      ? result.counts
      : {}
    const counts = Object.entries(countsObj).map(([reactionType, count]) => ({
      reactionType: String(reactionType),
      count: typeof count === 'number' ? count : 0
    }))
    return { success: Boolean(result?.success), counts, userReaction: result?.userReaction || null, error: result?.error || null }
  } catch (e) {
    console.log('[HRPC] getReactions failed:', e?.message)
    return { success: false, counts: [], error: e?.message }
  }
})

// Recommendation handlers
rpc.onLogWatchEvent(async (req) => {
  console.log('[HRPC] logWatchEvent:', req.channelKey?.slice(0, 16), req.videoId)
  // Stub: watch event logging not implemented on mobile yet
  // Response format: { success, error? }
  return { success: true }
})

rpc.onGetRecommendations(async (req) => {
  console.log('[HRPC] getRecommendations')
  // Stub: return empty recommendations
  // Response format: { success, recommendations: array, error? }
  return { success: true, recommendations: [] }
})

rpc.onGetVideoRecommendations(async (req) => {
  console.log('[HRPC] getVideoRecommendations:', req.channelKey?.slice(0, 16), req.videoId)
  // Stub: return empty recommendations
  // Response format: { success, recommendations: array, error? }
  return { success: true, recommendations: [] }
})

console.log('[Backend] Search/Comments/Reactions/Recommendations handlers registered')
