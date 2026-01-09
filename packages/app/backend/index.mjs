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
import os from 'bare-os'
import b4a from 'b4a'
import http1 from 'bare-http1'
import * as transcoder from './transcoder.mjs'
import * as hlsTranscoder from './hls-transcoder.mjs'

// Get IPC from BareKit, args from Bare
const { IPC } = BareKit
const storagePath = Bare.argv[0] || ''
const workerBundlePath = Bare.argv[1] || ''

if (workerBundlePath) {
  globalThis.__PEARTUBE_WORKER_PATH__ = workerBundlePath
  console.log('[Backend] Downloader worker path:', workerBundlePath)
}

// Log helper that forwards to React Native via eventLog
function backendLog(msg) {
  console.log(msg)
  // Will be called after rpc is initialized
  if (rpc?.eventLog) {
    try { rpc.eventLog({ message: msg }) } catch {}
  }
}

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
const castProxyPlaylistLogged = new Set()
const CAST_PROXY_TTL_MS = 30 * 60 * 1000

let CastContext = null
let castLoadError = null
let castLoadPromise = null
let castContext = null

const CAST_LOCALHOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1'])

// Note: Transcoding HTTP server is provided by transcoder.mjs

function normalizeCastVolume(volume) {
  const value = typeof volume === 'number' && Number.isFinite(volume) ? volume : 1
  if (value > 1) {
    return Math.max(0, Math.min(100, value)) / 100
  }
  return Math.max(0, Math.min(1, value))
}

function cleanupCastProxySessions(now = Date.now()) {
  for (const [token, entry] of castProxySessions.entries()) {
    const lastSeen = entry.lastAccessAt || entry.createdAt
    if (now - lastSeen > CAST_PROXY_TTL_MS) {
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

  const resetProxyState = () => {
    castProxyPort = 0
    castProxyReady = null
    castProxyServer = null
  }

  castProxyReady = new Promise((resolve, reject) => {
    const setCorsHeaders = (res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Range,Content-Type,Accept,Origin')
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges')
    }

    castProxyServer = http1.createServer((req, res) => {
      try {
        console.log('[CastProxy] incoming', req.method || 'GET', req.url || '/')
      } catch {}
      setCorsHeaders(res)
      if ((req.method || '').toUpperCase() === 'OPTIONS') {
        res.statusCode = 204
        res.end()
        return
      }
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
      const extraSegments = parts[0] === 'cast' ? parts.slice(2) : []
      if (extraSegments.some((seg) => seg === '.' || seg === '..')) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'text/plain')
        res.end('Invalid cast proxy path.')
        return
      }
      const extraPath = extraSegments.join('/')
      const isIndexRequest = extraPath.endsWith('index.m3u8')
      const isStreamRequest = extraPath.endsWith('stream.m3u8')

      const hostHeader = req.headers?.host
      const baseUrl = hostHeader ? `http://${hostHeader}` : ''
      const rewriteHlsPlaylist = (body) => {
        const lines = body.split(/\r?\n/)
        const segments = []
        let targetDuration = null
        let mediaSequence = null
        let pendingInf = null
        let maxDuration = 0

        const rewriteUri = (trimmed) => {
          let pathPart = trimmed
          let query = ''
          if (/^https?:\/\//i.test(trimmed)) {
            try {
              const parsedUrl = new URL(trimmed)
              pathPart = parsedUrl.pathname || ''
              query = parsedUrl.search || ''
            } catch {
              pathPart = trimmed
            }
          } else {
            const qIndex = trimmed.indexOf('?')
            if (qIndex !== -1) {
              pathPart = trimmed.slice(0, qIndex)
              query = trimmed.slice(qIndex)
            }
          }
          if (pathPart.startsWith('/')) {
            pathPart = path.posix.basename(pathPart)
          }
          pathPart = pathPart.replace(/^\.?\//, '').replace(/^(\.\.\/)+/, '')
          if (!pathPart) return ''
          return `${pathPart}${query}`
        }

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          if (trimmed.startsWith('#EXT-X-TARGETDURATION:')) {
            targetDuration = trimmed.split(':')[1]?.trim() || null
            continue
          }
          if (trimmed.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
            const raw = trimmed.split(':')[1]?.trim()
            const parsed = raw ? Number(raw) : NaN
            if (!Number.isNaN(parsed)) mediaSequence = parsed
            continue
          }
          if (trimmed.startsWith('#EXTINF:')) {
            pendingInf = trimmed
            const raw = trimmed.split(':')[1]?.split(',')[0]?.trim()
            const parsed = raw ? Number(raw) : NaN
            if (!Number.isNaN(parsed)) {
              maxDuration = Math.max(maxDuration, parsed)
            }
            continue
          }
          if (trimmed.startsWith('#')) continue

          const rewritten = rewriteUri(trimmed)
          if (!rewritten) continue
          if (pendingInf) {
            segments.push({ inf: pendingInf, uri: rewritten })
          }
          pendingInf = null
        }

        const maxSegments = 10000  // Keep all segments (desktop uses same value)
        const dropCount = Math.max(0, segments.length - maxSegments)
        const kept = segments.slice(-maxSegments)
        let seq = mediaSequence
        if (seq == null && kept.length) {
          const match = kept[0].uri.match(/(\d+)(?:\D+)?$/)
          if (match) seq = Number(match[1])
        }
        if (seq == null) seq = 0
        seq += dropCount

        const output = ['#EXTM3U', '#EXT-X-VERSION:3']
        const targetDurationValue = Math.max(
          targetDuration ? Number(targetDuration) || 0 : 0,
          Math.ceil(maxDuration || 0)
        )
        if (targetDurationValue > 0) {
          output.push(`#EXT-X-TARGETDURATION:${targetDurationValue}`)
        }
        output.push(`#EXT-X-MEDIA-SEQUENCE:${seq}`)
        for (const seg of kept) {
          output.push(seg.inf)
          output.push(seg.uri)
        }
        output.push('')
        return output.join('\r\n')
      }

      if (!token || !castProxySessions.has(token)) {
        console.warn('[CastProxy] missing token or session', token || 'none')
        res.statusCode = 404
        res.setHeader('Content-Type', 'text/plain')
        res.end('Cast proxy session not found.')
        return
      }

      const entry = castProxySessions.get(token)
      if (entry) {
        entry.lastAccessAt = Date.now()
      }
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

      const method = (req.method || 'GET').toUpperCase()
      let targetPathname = target.pathname
      // For index.m3u8 requests, DON'T modify the path - fetch original source
      // The index handler will generate a master playlist pointing to stream.m3u8
      // For stream.m3u8 requests, also use original path (source serves the actual playlist)
      if (extraPath && !isIndexRequest && !isStreamRequest) {
        const basePath = target.pathname || '/'
        const pathApi = path.posix || path
        const baseDir = pathApi.extname(basePath) ? pathApi.dirname(basePath) : basePath
        targetPathname = pathApi.join(baseDir, extraPath)
      }
      const targetPath = `${targetPathname}${target.search || ''}`
      const headers = {}
      if (req.headers?.range) {
        headers.range = req.headers.range
      }
      const proxyReq = http1.request({
        method,
        hostname: target.hostname,
        port: target.port || 80,
        path: targetPath,
        headers,
      }, (proxyRes) => {
        const contentType = (proxyRes.headers?.['content-type'] || '').toString()
        const isM3u8 = extraPath.endsWith('.m3u8')
          || targetPathname.endsWith('.m3u8')
          || contentType.includes('mpegurl')

        if (isIndexRequest && (proxyRes.statusCode || 200) < 400) {
          let body = ''
          proxyRes.setEncoding('utf8')
          proxyRes.on('data', (chunk) => { body += chunk })
          proxyRes.on('end', () => {
            const streamUrl = baseUrl
              ? `${baseUrl}/cast/${token}/stream.m3u8`
              : `/cast/${token}/stream.m3u8`
            const master = [
              '#EXTM3U',
              '#EXT-X-VERSION:3',
              '#EXT-X-STREAM-INF:BANDWIDTH=6000000',
              streamUrl,
              ''
            ].join('\r\n')
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
            res.setHeader('Content-Length', Buffer.byteLength(master))
            res.setHeader('Cache-Control', 'no-cache')
            setCorsHeaders(res)
            res.end(master)
          })
          proxyRes.on('error', (err) => {
            console.warn('[CastProxy] upstream response error:', err?.message || err)
            if (!res.headersSent) {
              res.statusCode = 502
              res.end('Cast proxy upstream error')
            }
          })
          return
        }

        if (isM3u8 && (proxyRes.statusCode || 200) < 400) {
          let body = ''
          proxyRes.setEncoding('utf8')
          proxyRes.on('data', (chunk) => { body += chunk })
          proxyRes.on('end', () => {
            const rewritten = rewriteHlsPlaylist(body)
            const logKey = `${token}:${isStreamRequest ? 'stream' : 'index'}`
            if (!castProxyPlaylistLogged.has(logKey)) {
              castProxyPlaylistLogged.add(logKey)
              const preview = rewritten.split(/\r?\n/).slice(0, 8).join('\n')
              console.log('[CastProxy] playlist sample:\n' + preview)
            }
            const out = Buffer.from(rewritten, 'utf8')
            res.statusCode = proxyRes.statusCode || 200
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
            res.setHeader('Content-Length', out.byteLength)
            res.setHeader('Cache-Control', 'no-cache')
            setCorsHeaders(res)
            res.end(out)
          })
          proxyRes.on('error', (err) => {
            console.warn('[CastProxy] upstream response error:', err?.message || err)
            if (!res.headersSent) {
              res.statusCode = 502
              res.end('Cast proxy upstream error')
            }
          })
          return
        }

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
        setCorsHeaders(res)

        // Use manual piping with error handling instead of .pipe() to prevent
        // "Writable stream closed prematurely" crashes when Chromecast disconnects
        let pipeCleanedUp = false
        const cleanupPipe = () => {
          if (pipeCleanedUp) return
          pipeCleanedUp = true
          try { proxyRes.unpipe?.(res) } catch {}
          try { proxyRes.destroy?.() } catch {}
        }

        proxyRes.on('error', (err) => {
          console.warn('[CastProxy] upstream response error:', err?.message || err)
          cleanupPipe()
        })
        res.on('error', (err) => {
          console.warn('[CastProxy] client response error:', err?.message || err)
          cleanupPipe()
        })
        res.on('close', () => {
          // Client closed connection, clean up upstream
          cleanupPipe()
        })

        proxyRes.on('data', (chunk) => {
          if (pipeCleanedUp) return
          try {
            const canWrite = res.write(chunk)
            if (!canWrite && !pipeCleanedUp) {
              proxyRes.pause?.()
              res.once('drain', () => {
                if (!pipeCleanedUp) proxyRes.resume?.()
              })
            }
          } catch (err) {
            console.warn('[CastProxy] write error:', err?.message || err)
            cleanupPipe()
          }
        })
        proxyRes.on('end', () => {
          if (pipeCleanedUp) return
          try { res.end() } catch {}
        })
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

      const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(method)
        && (req.headers?.['content-length'] || req.headers?.['transfer-encoding'])
      if (hasBody) {
        req.pipe(proxyReq)
      } else {
        proxyReq.end()
      }
    })

    castProxyServer.on('error', (err) => {
      console.error('[CastProxy] server error:', err?.message || err)
      resetProxyState()
      reject(err)
    })
    castProxyServer.on('close', () => {
      resetProxyState()
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
  const now = Date.now()
  // Check if source is HLS content - Chromecast needs .m3u8 extension for HLS
  const isHls = sourceUrl.endsWith('.m3u8') || sourceUrl.includes('.m3u8?')
  console.log('[Backend] Cast proxy sourceUrl:', sourceUrl?.slice(0, 100), 'isHls:', isHls)
  castProxySessions.set(token, { url: sourceUrl, isHls, createdAt: now, lastAccessAt: now })
  // For HLS: add index.m3u8 so Chromecast recognizes it as HLS
  // For non-HLS: no extension needed, Content-Type header is enough
  const suffix = isHls ? '/index.m3u8' : ''
  const proxyUrl = `http://${localIp}:${castProxyPort}/cast/${token}${suffix}`
  console.log('[Backend] Cast proxy created:', proxyUrl)
  return proxyUrl
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
        // compact-encoding uint requires positive integers (>=1), so clamp 0 to 1
        rpc?.eventCastTimeUpdate?.({ currentTime: Math.max(1, Math.floor(time || 0)) })
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
const BACKEND_BUNDLE_VERSION = 'add-audio-fifo-v4'
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
  await loadBareFcast()
  if (!CastContext) {
    return { success: false, error: castLoadError || 'bare-fcast not available' }
  }
  const ctx = getCastContext()
  let deviceInfo = null
  try {
    try {
      const devices = ctx.getDevices?.() || []
      const device = devices.find((d) => d.id === req.deviceId)
      if (device) {
        console.log('[Backend] Cast connect:', device.name, device.protocol, device.host + ':' + device.port)
        deviceInfo = device
      } else {
        console.log('[Backend] Cast connect: device not found for', req.deviceId)
      }
    } catch {}
    await ctx.connect(req.deviceId)
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

    // Cleanup active transcode session (try HLS first, then legacy)
    if (activeCastTranscodeId) {
      hlsSessionsWithLoadSent.delete(activeCastTranscodeId) // Clear LOAD tracking
      try {
        hlsTranscoder.stopHlsTranscode(activeCastTranscodeId)
        console.log('[Backend] Cleaned up HLS transcode session:', activeCastTranscodeId)
      } catch {
        try {
          transcoder.stopTranscode(activeCastTranscodeId)
          console.log('[Backend] Cleaned up legacy transcode session:', activeCastTranscodeId)
        } catch {}
      }
      activeCastTranscodeId = null
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: err?.message }
  }
})

// Active transcode session for casting
let activeCastTranscodeId = null

// Track which HLS sessions have already sent LOAD to Chromecast
// Key: sessionId, Value: true
const hlsSessionsWithLoadSent = new Map()

// Guard against concurrent/repeated castPlay calls
let castPlayInProgress = false
let lastCastPlayTime = 0
const CAST_PLAY_DEBOUNCE_MS = 2000 // Minimum 2 seconds between cast plays

rpc.onCastPlay(async (req) => {
  // Debounce: prevent rapid repeated calls - return success to avoid error UI
  const now = Date.now()
  if (now - lastCastPlayTime < CAST_PLAY_DEBOUNCE_MS) {
    console.log('[Backend] Cast play: DEBOUNCED - too soon after last call (' + (now - lastCastPlayTime) + 'ms), returning success to avoid error')
    return { success: true } // Silent ignore - don't show error to user
  }

  // Prevent concurrent calls - return success to avoid error UI
  if (castPlayInProgress) {
    console.log('[Backend] Cast play: BLOCKED - another cast play is already in progress, returning success to avoid error')
    return { success: true } // Silent ignore - don't show error to user
  }

  castPlayInProgress = true
  lastCastPlayTime = now

  try {
    if (!castContext?.isConnected()) {
      return { success: false, error: 'Not connected to cast device' }
    }

    let url = req.url
    let contentType = req.contentType
    let currentTranscodeSessionId = null  // Track session ID for cleanup logic (needs function scope)

    const protocol = castContext?._connectedDevice?.deviceInfo?.protocol
    const deviceHost = castContext?._connectedDevice?.deviceInfo?.host

    // For Chromecast, probe the media and transcode if needed
    if (protocol === 'chromecast') {
      console.log('[Backend] Cast play: probing media for Chromecast compatibility...')

      // Load bare-ffmpeg lazily (not at startup to avoid potential init issues)
      let ffmpegLoaded = false
      try {
        ffmpegLoaded = await transcoder.loadBareFfmpeg()
      } catch (loadErr) {
        console.warn('[Backend] Cast play: bare-ffmpeg load failed:', loadErr?.message)
      }

      if (ffmpegLoaded) {
        try {
          const probeResult = await transcoder.probeMedia(req.url, req.title)
          console.log('[Backend] Probe result:', {
            video: probeResult.videoCodec,
            audio: probeResult.audioCodec,
            container: probeResult.container,
            needsTranscode: probeResult.needsTranscode,
            needsRemux: probeResult.needsRemux,
            reason: probeResult.reason,
          })

          const needsProcessing = probeResult.needsTranscode || probeResult.needsRemux

          if (needsProcessing) {
            // Use HLS transcoding for real-time streaming
            // Chromecast can start playing as soon as first segments are ready
            console.log('[Backend] Cast play: HLS transcoding needed -', probeResult.reason)

            // Check if video is fully synced before attempting transcode
            // This is ADVISORY ONLY - we don't block casting based on sync status
            // If still downloading from P2P peers, transcoding may fail when it catches up
            // but TempFileReader now handles this gracefully (returns EOF instead of crashing)
            let isVideoComplete = true // Default to true - assume cached
            let syncStatus = null
            try {
              syncStatus = await api.checkVideoSync(req.url)
              console.log('[Backend] Cast play: video sync status -',
                syncStatus.progress + '%',
                '(' + syncStatus.availableBlocks + '/' + syncStatus.totalBlocks + ' blocks)',
                syncStatus.isComplete ? 'COMPLETE' : 'INCOMPLETE',
                syncStatus.assumed ? '(ASSUMED)' : '')

              isVideoComplete = syncStatus.isComplete

              // Just log a warning if not synced, but don't block
              if (!syncStatus.isComplete && !syncStatus.assumed) {
                const sizeMB = Math.round((syncStatus.byteLength || 0) / 1024 / 1024)
                const downloadedMB = Math.round(sizeMB * syncStatus.progress / 100)
                console.warn('[Backend] Cast play: Video may not be fully synced!',
                  downloadedMB + 'MB /', sizeMB + 'MB downloaded.',
                  'Proceeding anyway - TempFileReader will handle gracefully.')
              }
            } catch (syncErr) {
              console.warn('[Backend] Cast play: Could not check sync status:', syncErr?.message)
              // Continue anyway - sync check is best-effort, assume complete
              isVideoComplete = true
              syncStatus = null
            }

            // ============================================
            // HLS Streaming (Chromecast compatible)
            // ============================================
            try {
              console.log('[Backend] Cast play: starting HLS transcode...')
              const result = await hlsTranscoder.startHlsTranscode(req.url, {
                title: req.title || '',
                store: ctx.store,
                isVideoComplete,
                // Direct Hypercore access (HypercoreIOReader) - bypasses HTTP for synced videos
                blobInfo: syncStatus?.blobInfo || null,
                blobsCoreKey: syncStatus?.blobsCoreKey || null,
                onProgress: (sessionId, percent) => {
                  if (percent % 10 === 0) {
                    console.log(`[Backend] HLS transcode progress: ${percent}%`)
                  }
                }
              })

              if (!result.success) {
                console.error('[Backend] Cast play: HLS transcode failed:', result.error)
                // Fall through to try direct play
                throw new Error(result.error)
              }

              // Store session ID for cleanup logic (declared outside try block)
              currentTranscodeSessionId = result.sessionId

              console.log('[Backend] Cast play: HLS transcode started, session:', result.sessionId, 'hlsUrl:', result.hlsUrl, 'reused:', result.reused || false)

              // Skip wait if reusing existing session - segments already exist
              if (result.reused) {
                console.log('[Backend] Cast play: Reusing existing session, skipping segment wait')
                // Still verify we have segments
                const status = hlsTranscoder.getHlsStatus(result.sessionId)
                console.log('[Backend] Cast play: Reused session has', status?.segments || 0, 'segments')

                // CRITICAL: If we already sent LOAD for this session, don't send another one
                // Sending multiple LOADs causes rapid state changes in Chromecast which can
                // lead to memory corruption in the native cast module
                if (hlsSessionsWithLoadSent.has(result.sessionId)) {
                  console.log('[Backend] Cast play: LOAD already sent for this session, skipping duplicate LOAD')
                  return { success: true }
                }
              } else {
                // Wait for at least 1 segment before sending to Chromecast for instant casting
                const MIN_SEGMENTS = 1
                const MAX_WAIT_MS = 30000 // 30 second timeout
                const POLL_INTERVAL_MS = 500
                console.log('[Backend] Cast play: Waiting for', MIN_SEGMENTS, 'HLS segments...')

                const waitStart = Date.now()
                let segmentCount = 0
                let playlistReady = false
                while (Date.now() - waitStart < MAX_WAIT_MS) {
                  const status = hlsTranscoder.getHlsStatus(result.sessionId)
                  segmentCount = status?.segments || 0
                  playlistReady = status?.playlistReady || false

                  const ready = segmentCount >= MIN_SEGMENTS && playlistReady

                  if (ready) {
                    console.log('[Backend] Cast play:', segmentCount, 'segments ready, playlistReady:', playlistReady)
                    break
                  }

                  if (status?.status === 'error') {
                    throw new Error(status.error || 'Transcode failed while waiting for segments')
                  }

                  // Log progress every few seconds
                  const elapsed = Date.now() - waitStart
                  if (elapsed % 3000 < POLL_INTERVAL_MS) {
                    console.log('[Backend] Cast play: waiting...', segmentCount, '/', MIN_SEGMENTS, 'segments, playlistReady:', playlistReady, 'elapsed:', Math.round(elapsed/1000) + 's')
                  }

                  await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
                }

                if (segmentCount < MIN_SEGMENTS) {
                  console.warn('[Backend] Cast play: Timeout waiting for segments, proceeding anyway with', segmentCount, 'segments')
                }
              } // end else (not reused)

              // Get the HLS URL
              // HYBRID APPROACH: Use bare-http1 for PLAYLIST (dynamic, refreshes each fetch)
              // The playlist content contains BlobServer URLs for SEGMENTS (static, safe)
              // This avoids the immutable blob issue where Chromecast can't see new segments
              const localIp = await getLocalIPv4ForTarget(deviceHost)
              let hlsUrl = result.hlsUrl

              if (localIp) {
                hlsUrl = hlsUrl.replace('127.0.0.1', localIp)
                console.log('[Backend] Cast play: using bare-http1 playlist URL with LAN IP:', hlsUrl)
              } else {
                console.warn('[Backend] Cast play: could not get local IP for HLS URL rewrite')
              }

              url = hlsUrl
              contentType = 'application/x-mpegurl'
              // Note: activeCastTranscodeId is set later after cleanup to avoid cleaning up current session
              console.log('[Backend] Cast play: using HLS URL', url)
            } catch (transcodeErr) {
              console.error('[Backend] Cast play: HLS transcode error:', transcodeErr?.message || transcodeErr)
              // Fall through to try direct play
              throw transcodeErr
            }
          }
        } catch (probeErr) {
          console.warn('[Backend] Cast play: probe/transcode failed, trying direct play:', probeErr?.message)
          // Fall through to regular play
        }
      } else {
        console.log('[Backend] Cast play: bare-ffmpeg not available, skipping transcode check')
      }

      // Set up proxy for the URL (original or transcoded)
      // Skip proxy for HLS - the HLS server handles both playlist and segments
      // Proxy would break relative segment URLs in the playlist
      if (contentType === 'application/x-mpegurl') {
        console.log('[Backend] Cast play: skipping proxy for HLS (direct access to segments needed)')
      } else {
        try {
          await ensureCastProxyServer()
          const proxyUrl = await createCastProxyUrl(deviceHost, url)
          if (proxyUrl) {
            url = proxyUrl
            console.log('[Backend] Cast play: using proxy URL', proxyUrl)
          }
        } catch (err) {
          console.warn('[Backend] Cast proxy init failed:', err?.message || err)
          // Try direct IP rewrite
          try {
            const parsed = new URL(url)
            if (CAST_LOCALHOSTS.has(parsed.hostname)) {
              const localIp = await getLocalIPv4ForTarget(deviceHost)
              if (localIp) {
                url = rewriteUrlHost(url, localIp)
                console.log('[Backend] Cast play: rewrote host to', localIp)
              }
            }
          } catch {}
        }
      }
    }

    try {
      let host = 'unknown'
      try {
        const parsed = new URL(url)
        host = parsed.host
      } catch {}
      console.log('[Backend] Cast play:', protocol || 'unknown', 'contentType:', contentType, 'host:', host)
    } catch {}

    // Use LIVE stream type for real-time HLS transcoding
    const streamType = 'LIVE'

    // IMPORTANT: Stop any current media first to clear Chromecast's cached state
    // Otherwise Chromecast may keep polling the old URL instead of loading new one
    try {
      console.log('[Backend] Cast play: Stopping current media before loading new...')
      await castContext.stop()
      // Small delay to ensure Chromecast processes the stop
      await new Promise(resolve => setTimeout(resolve, 200))
    } catch (stopErr) {
      console.log('[Backend] Cast play: Stop before load failed (ok if nothing playing):', stopErr?.message)
    }

    // Cleanup any PREVIOUS HLS transcode sessions (not the current one!)
    // currentTranscodeSessionId is set in the try block above, or null if no transcode
    const previousSessionId = activeCastTranscodeId
    if (previousSessionId && previousSessionId !== currentTranscodeSessionId) {
      console.log('[Backend] Cast play: Cleaning up previous transcode session:', previousSessionId)
      try {
        hlsTranscoder.stopHlsTranscode(previousSessionId)
      } catch {}
    }
    // Update tracking to current session
    if (currentTranscodeSessionId) {
      activeCastTranscodeId = currentTranscodeSessionId
    }

    console.log('[Backend] Cast play: >>> SENDING LOAD TO CHROMECAST <<<')
    console.log('[Backend] Cast play: URL:', url)
    console.log('[Backend] Cast play: contentType:', contentType, 'streamType:', streamType || 'BUFFERED')

    await castContext.play({
      url,
      contentType,
      title: req.title,
      thumbnail: req.thumbnail,
      time: req.time,
      volume: normalizeCastVolume(req.volume),
      streamType,
    })

    console.log('[Backend] Cast play: >>> LOAD SENT SUCCESSFULLY <<<')

    // Track that LOAD was sent for this HLS session to prevent duplicate LOADs
    if (activeCastTranscodeId && contentType === 'application/x-mpegurl') {
      hlsSessionsWithLoadSent.set(activeCastTranscodeId, true)
      console.log('[Backend] Cast play: Marked session', activeCastTranscodeId, 'as LOAD sent')
    }

    // Update debounce time AFTER load completes (not at start) to properly gate subsequent calls
    lastCastPlayTime = Date.now()

    return { success: true }
  } catch (err) {
    console.error('[Backend] Cast play error:', err?.message || err)
    return { success: false, error: err?.message }
  } finally {
    // Ensure flag is reset even if something unexpected happens
    castPlayInProgress = false
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

    // Cleanup active transcode session (try HLS first, then legacy)
    if (activeCastTranscodeId) {
      hlsSessionsWithLoadSent.delete(activeCastTranscodeId) // Clear LOAD tracking
      try {
        hlsTranscoder.stopHlsTranscode(activeCastTranscodeId)
        console.log('[Backend] Cleaned up HLS transcode session:', activeCastTranscodeId)
      } catch {
        try {
          transcoder.stopTranscode(activeCastTranscodeId)
          console.log('[Backend] Cleaned up legacy transcode session:', activeCastTranscodeId)
        } catch {}
      }
      activeCastTranscodeId = null
    }

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
    await castContext.setVolume(normalizeCastVolume(req.volume))
    return { success: true }
  } catch (err) {
    return { success: false, error: err?.message }
  }
})

rpc.onCastGetState(async () => {
  // compact-encoding uint requires positive integers (>=1)
  // For optional uint fields, omit them or use 1 as minimum
  if (!castContext) {
    return { state: 'idle' }  // omit zero uint fields
  }
  try {
    const state = castContext.getPlaybackState()
    const result = { state: state.state || 'idle' }
    // Only include uint fields if they're positive
    if (state.currentTime > 0) result.currentTime = Math.floor(state.currentTime)
    if (state.duration > 0) result.duration = Math.floor(state.duration)
    if (state.volume > 0) result.volume = Math.floor(state.volume * 100)  // convert 0-1 to 0-100
    return result
  } catch {
    return { state: 'idle' }
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
rpc.onMpvGetState(async () => ({ success: false, paused: true }))  // omit zero uint fields
rpc.onMpvRenderFrame(async () => ({ success: false, error: 'MPV not supported on mobile' }))
rpc.onMpvDestroy(async () => ({ success: false, error: 'MPV not supported on mobile' }))

// ============================================
// Transcode handlers (for Chromecast compatibility)
// ============================================

// NOTE: bare-ffmpeg is loaded lazily when Chromecast transcoding is needed.
// DO NOT load it eagerly - on Android, the native module can crash during initialization
// which would take down the entire backend. Lazy loading allows FCast and normal playback
// to work even if bare-ffmpeg has issues.
console.log('[Backend] bare-ffmpeg will be loaded lazily when needed for Chromecast')

if (typeof rpc.onTranscodeStart === 'function') {
  rpc.onTranscodeStart(async (req) => {
    console.log('[HRPC] transcodeStart:', req.sourceUrl)
    try {
      const onProgress = (sessionId, percent) => {
        try {
          rpc.eventTranscodeProgress?.({
            sessionId,
            percent,
            bytesWritten: 0,
          })
        } catch {}
      }

      const result = await transcoder.startTranscode(req.sourceUrl, {
        duration: req.duration || 0,
        title: req.title || '',
        onProgress
      })

      return {
        success: result.success,
        sessionId: result.sessionId || '',
        transcodeUrl: result.transcodeUrl || '',
        error: result.error || '',
      }
    } catch (err) {
      console.error('[HRPC] transcodeStart failed:', err?.message)
      return { success: false, error: err?.message || 'Transcode start failed' }
    }
  })
} else {
  console.warn('[HRPC] transcodeStart handler not available')
}

if (typeof rpc.onTranscodeStop === 'function') {
  rpc.onTranscodeStop(async (req) => {
    console.log('[HRPC] transcodeStop:', req.sessionId)
    try {
      const result = transcoder.stopTranscode(req.sessionId)
      return { success: result.success, error: result.error || '' }
    } catch (err) {
      return { success: false, error: err?.message || 'Stop failed' }
    }
  })
} else {
  console.warn('[HRPC] transcodeStop handler not available')
}

if (typeof rpc.onTranscodeStatus === 'function') {
  rpc.onTranscodeStatus(async (req) => {
    try {
      const status = transcoder.getStatus(req.sessionId)
      return {
        status: status.status || '',
        progress: status.progress || 0,
        bytesWritten: status.bytesWritten || 0,
        error: status.error || '',
      }
    } catch (err) {
      return { status: 'error', progress: 0, bytesWritten: 0, error: err?.message || 'Status check failed' }
    }
  })
} else {
  console.warn('[HRPC] transcodeStatus handler not available')
}

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
rpc.onEventTranscodeProgress(() => {})

console.log('[Backend] HRPC handlers registered')

// Send ready event
try {
  const port = ctx.blobServer?.port || ctx.blobServerPort || 0
  rpc.eventReady({ blobServerPort: port, blobServerHost: ctx.blobServerHost || '127.0.0.1' })
  console.log('[Backend] Sent eventReady via HRPC, blobServerPort:', port, 'host:', ctx.blobServerHost || '127.0.0.1')
} catch (e) {
  console.error('[Backend] Failed to send eventReady:', e.message)
}

// Pre-load bare-ffmpeg at startup for faster cast response
backendLog('[Backend] Pre-loading bare-ffmpeg...')
Promise.all([
  transcoder.loadBareFfmpeg(),
  hlsTranscoder.loadBareFfmpeg()
]).then(([legacyLoaded, hlsLoaded]) => {
  backendLog('[Backend] bare-ffmpeg pre-load: legacy=' + legacyLoaded + ', hls=' + hlsLoaded)
}).catch(err => {
  backendLog('[Backend] bare-ffmpeg pre-load error: ' + (err?.message || err))
})

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
