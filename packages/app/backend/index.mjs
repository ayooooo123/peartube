/**
 * PearTube Mobile Backend - Thin HRPC layer over @peartube/backend
 *
 * This is a minimal wrapper that:
 * 1. Initializes the backend using createBackendContext
 * 2. Registers HRPC handlers that delegate to backend API
 * 3. Handles mobile-specific concerns (BareKit IPC, single identity)
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
let hlsTranscoder = null
let fsNativeExtensions = null

async function loadBackendModules() {
  const [
    specMod,
    orchestratorMod,
    storageMod,
    thumbnailMod,
    pathMod,
    fsMod,
    osMod,
    b4aMod,
    http1Mod,
    fsNativeExtensionsMod,
    transcoderMod,
    hlsTranscoderMod,
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
    import('./hls-transcoder.mjs'),
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
  hlsTranscoder = hlsTranscoderMod

  if (!HRPC || !createBackendContext || !setIsShuttingDown || !shutdownBackend || !generateAndStoreThumbnail || !path || !fs || !os || !b4a || !http1 || !transcoder || !hlsTranscoder || !fsNativeExtensions || !setCastActive || !isCastActive || !prefetchVideoForCast) {
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
let handlersRegistered = false

// ============================================
// Cast (FCast/Chromecast) helpers
// ============================================

let castProxyServer = null
let castProxyPort = 0
let castProxyReady = null
const castProxySessions = new Map()
const castProxyPlaylistLogged = new Set()
const CAST_PROXY_TTL_MS = 8 * 60 * 60 * 1000

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
  // Skip cleanup entirely when a cast is active to prevent session loss
  if (isCastActive && isCastActive()) {
    return
  }
  for (const [token, entry] of castProxySessions.entries()) {
    const lastSeen = entry.lastAccessAt || entry.createdAt
    if (now - lastSeen > CAST_PROXY_TTL_MS) {
      castProxySessions.delete(token)
    }
  }
}

function refreshCastProxySessions() {
  const now = Date.now()
  for (const entry of castProxySessions.values()) {
    entry.lastAccessAt = now
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
        console.log('[CastDiag] cast proxy: incoming request', req.method || 'GET', req.url?.substring(0, 80));
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
        console.log('[CastDiag] cast proxy: session NOT found for token', token?.substring(0, 8));
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

function normalizeLocalUrlForCast(url) {
  try {
    const parsed = new URL(url)
    if (CAST_LOCALHOSTS.has(parsed.hostname)) {
      parsed.hostname = '127.0.0.1'
      return parsed.toString()
    }
  } catch {}
  return url
}

function buildTranscodeCacheKey(url) {
  try {
    const parsed = new URL(url)
    const keyParam = parsed.searchParams.get('key')
    const blobParam = parsed.searchParams.get('blob')
    if (keyParam && blobParam) {
      return `blob:${keyParam}:${blobParam}`
    }
    parsed.searchParams.delete('token')
    parsed.searchParams.delete('type')
    const entries = Array.from(parsed.searchParams.entries())
    entries.sort((a, b) => {
      if (a[0] === b[0]) return a[1].localeCompare(b[1])
      return a[0].localeCompare(b[0])
    })
    const params = new URLSearchParams()
    for (const [key, value] of entries) {
      params.append(key, value)
    }
    parsed.search = params.toString()
    return parsed.toString()
  } catch {
    return null
  }
}

function decodeMaybe(value) {
  if (typeof value !== 'string') return null
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function normalizeCastFilePath(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const decoded = decodeMaybe(value)?.trim()
  if (!decoded) return null
  return decoded.startsWith('/') ? decoded : `/${decoded}`
}

function extractCastPrefetchTarget(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return null
  try {
    const parsed = new URL(rawUrl)
    const driveKey = parsed.searchParams.get('driveKey') || parsed.searchParams.get('channelKey') || parsed.searchParams.get('dk')
    const pathFromParams = parsed.searchParams.get('videoPath') || parsed.searchParams.get('path') || parsed.searchParams.get('vp')
    const filePath = normalizeCastFilePath(pathFromParams) || (parsed.pathname?.startsWith('/videos/') ? normalizeCastFilePath(parsed.pathname) : null)
    if (!driveKey || !filePath) return null
    return { driveKey, filePath }
  } catch {
    return null
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
        if (state === 'playing' || state === 'paused' || state === 'buffering') {
          castLoadCompletedAt = 0
        }
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

        // During active load sequence, suppress transient errors — the castPlay
        // handler's try/catch will report real failures via the RPC return value.
        if (castPlayInProgress) {
          console.log('[Backend] Cast error suppressed (load in progress):', message)
          return
        }

        // After load completes, stale IDLE:ERROR from old session can still arrive.
        // Suppress media-level errors for a short grace window post-LOAD.
        const sinceLoad = castLoadCompletedAt > 0 ? Date.now() - castLoadCompletedAt : Infinity
        if (sinceLoad < CAST_POST_LOAD_GRACE_MS && message.includes('media error')) {
          console.log('[Backend] Cast error suppressed (post-load grace, ' + sinceLoad + 'ms):', message)
          return
        }

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
    // - old refresh-feed id (16) -> new id (18) only when payload is empty
    // - old get-video-stats id (24) -> new id (30) when payload exists
    // Keep join-channel/get-swarm-status semantics intact for modern clients.
    try {
      const rawRpc = rpc?._rpc
      if (rawRpc && !rawRpc._peartubeCompat) {
        const originalOnRequest = rawRpc._onrequest
        rawRpc._onrequest = async (req) => {
          try {
            const hasPayload = Boolean(req?.data && req.data.length > 0)
            if (req?.command === 16 && !hasPayload) {
              req.command = 18
            }
            if (req?.command === 24 && hasPayload) {
              req.command = 30
            }
          } catch {}
          if (!handlersRegistered) {
            throw new Error('Backend not ready: handlers are not registered yet')
          }
          try {
            return await originalOnRequest(req)
          } catch (err) {
            reportBackendError(`HRPC request failed (${req?.command})`, err)
            // Let HRPC propagate the error back to the caller.
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
    Bare.on('unhandledRejection', (reason) => {
      notifyBare('Unhandled rejection', reason)
      return true
    })

    Bare.on('uncaughtException', (err) => {
      notifyBare('Uncaught exception', err)
      return true
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
try {
  fs.mkdirSync(storageDir, { recursive: true })
} catch (e) {
  // Directory may already exist
}

// Helps confirm which backend bundle is actually running on device.
const BACKEND_BUNDLE_VERSION = 'corestore-cleanup-v3'
console.log('[Backend] Bundle version:', BACKEND_BUNDLE_VERSION)

const OWNER_LOCK_FILE = 'backend-owner.lock'
let ownerLockFd = -1
let backendCtx = null

function closeOwnerLock(reason = 'shutdown') {
  if (ownerLockFd === -1) return
  const fd = ownerLockFd
  ownerLockFd = -1
  try {
    fsNativeExtensions?.unlock?.(fd)
  } catch {}
  try {
    fs.close(fd, () => {})
  } catch {}
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
    try {
      acquired = tryLock(fd)
    } catch (err) {
      console.warn('[Backend] tryLock error:', err.message)
    }
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

if (typeof Bare !== 'undefined' && Bare?.on) {
  Bare.on('exit', () => {
    if (!backendCtx?._isShutdown) {
      shutdownBackend?.(backendCtx).catch(() => {})
    }
    closeCastProxyServer('bare-exit')
    closeOwnerLock('bare-exit')
    return true
  })
}

if (typeof process !== 'undefined' && process?.on) {
  process.on('exit', () => closeOwnerLock('process-exit'))
}

// Check for stale backend-owner.lock before acquiring
try {
  const lockPath = path.join(storageDir, OWNER_LOCK_FILE)
  if (fs.existsSync(lockPath)) {
    const lockContent = fs.readFileSync(lockPath, 'utf8').trim()
    const pid = parseInt(lockContent, 10)
    if (!isNaN(pid)) {
      let isAlive = false
      try {
        process.kill(pid, 0)
        isAlive = true
      } catch {}
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

// Remove stale CORESTORE device-file so Corestore can acquire a fresh FD lock.
// When the previous worklet was killed ungracefully (force-stop, OOM, crash),
// its FD lock on CORESTORE is never released. Since we already hold the owner
// lock, we know no other backend is running — the stale file is safe to delete.
try {
  const corestoreDeviceFile = path.join(storageDir, 'CORESTORE')
  fs.unlinkSync(corestoreDeviceFile)
  console.log('[Backend] Removed stale CORESTORE device file')
} catch (e) {
  if (e.code !== 'ENOENT') console.log('[Backend] CORESTORE cleanup skipped:', e.message)
}

// Clean up stale top-level RocksDB artifacts that should live under db/.
// hypercore-storage's tmpFixStorage migration moves these, but if it ran
// while db/<name> already existed it would ENOTEMPTY. Remove the top-level
// copies so the migration (if it ever re-triggers) won't fail.
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
  const staleTopLevel = ['logs', 'LOG', 'LOG.old', 'IDENTITY', 'CURRENT', 'MANIFEST-000001']
  for (const name of staleTopLevel) {
    const p = path.join(storageDir, name)
    try {
      const st = fs.statSync(p)
      if (st.isDirectory()) {
        rmdirRecursive(p)
      } else {
        fs.unlinkSync(p)
      }
    } catch {}
  }
} catch {}
ipcLog('[init] CORESTORE cleanup done')

let backend = null
try {
  ipcLog('[init] createBackendContext starting')
  backend = await createBackendContext({
    storagePath: storageDir,
    corestoreWaitForLock: true,
    ipcLog,
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
          rpc.eventVideoStats({
            stats: {
              videoId: videoPath,
              channelKey: driveKey,
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
  closeOwnerLock('backend-unavailable')
  throw err
}

const { ctx, api, identityManager, uploadManager, publicFeed, seedingManager, videoStats, initializeIdentityFromMnemonic } = backend
backendCtx = ctx

let shutdownIpcInFlight = null

function closeCastProxyServer(reason = 'shutdown') {
  if (!castProxyServer) return
  try {
    castProxyServer.close()
  } catch {}
  castProxyServer = null
  castProxyPort = 0
  castProxyReady = null
  console.log('[Backend] Closed cast proxy server:', reason)
}

function parseIpcShutdownMessage(chunk) {
  if (!chunk) return null
  try {
    const text = b4a.toString(chunk).trim()
    if (!text || text[0] !== '{') return null
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

async function handleIpcShutdownRequest() {
  if (shutdownIpcInFlight) return shutdownIpcInFlight
  shutdownIpcInFlight = (async () => {
    setIsShuttingDown(true)
    await shutdownBackend(ctx)
    closeCastProxyServer('ipc-shutdown')
    closeOwnerLock('shutdown')
    try {
      IPC.write(b4a.from(JSON.stringify({ type: 'shutdown-complete' })))
    } catch {}
  })().finally(() => {
    shutdownIpcInFlight = null
  })
  return shutdownIpcInFlight
}

if (IPC?.on) {
  IPC.on('data', (chunk) => {
    const msg = parseIpcShutdownMessage(chunk)
    if (msg?.type === 'shutdown') {
      handleIpcShutdownRequest().catch((err) => {
        console.warn('[Backend] IPC shutdown failed:', err?.message || err)
      })
    }
  })
}

const blobPort = ctx.blobServer?.port || ctx.blobServerPort || 0
console.log('[Backend] Backend initialized, blob server port:', blobPort, '(from blobServer.port:', ctx.blobServer?.port, ', from ctx.blobServerPort:', ctx.blobServerPort, ')')

ensureRpc()
if (!rpc) {
  reportBackendError('HRPC unavailable', 'Failed to initialize HRPC transport')
  throw new Error('Failed to initialize HRPC transport')
}

function getThumbnailMime(thumbPath) {
  const ext = thumbPath.split('.').pop()?.toLowerCase() || 'jpg'
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'image/jpeg'
}



// Restore cached public feed so restart doesn't start from empty
async function restoreFeedCache() {
  try {
    const cached = await ctx.metaDb.get('public-feed-cache').catch(() => null)
    const entries = cached?.value || []
    if (Array.isArray(entries) && entries.length) {
      console.log('[Backend] Restoring public feed cache, entries:', entries.length)
      for (const entry of entries) {
        try {
          if (typeof entry === 'object' && entry.driveKey) {
            publicFeed.addEntry(entry.driveKey, 'peer', entry.publicBeeKey || null)
          } else if (typeof entry === 'string') {
            publicFeed.addEntry(entry, 'peer')
          }
        } catch {}
      }
    }
  } catch (e) {
    console.log('[Backend] Feed cache restore skipped:', e?.message)
  }
}

async function persistFeedCache() {
  try {
    const entries = publicFeed.getFeed().map((e) => ({ driveKey: e.driveKey, publicBeeKey: e.publicBeeKey || null }))
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
  try {
    rpc?.eventLog?.({
      level: 'info',
      message: `[createIdentity] start name=${String(req?.name || '').slice(0, 64)}`,
      timestamp: Date.now()
    })
  } catch {}
  const result = await identityManager.createIdentity(req.name || 'New Channel', true)
  // Wire identity key file so Corestore becomes deterministic on next start
  if (result.mnemonic) {
    try {
      const { needsRestart } = await initializeIdentityFromMnemonic(result.mnemonic)
      if (needsRestart) console.log('[Backend] Identity key file written — restart needed for deterministic Corestore')
    } catch (e) {
      console.error('[Backend] initializeIdentityFromMnemonic failed:', e.message)
    }
  }
  try {
    rpc?.eventLog?.({
      level: 'info',
      message: `[createIdentity] done pub=${String(result?.publicKey || '').slice(0, 16)} drive=${String(result?.driveKey || '').slice(0, 16)}`,
      timestamp: Date.now()
    })
  } catch {}
  return {
    identity: {
      publicKey: result.publicKey,
      driveKey: result.driveKey,
      name: req.name || 'New Channel',
      seedPhrase: result.mnemonic || '',
      isActive: true
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
    // Wire identity key file so Corestore becomes deterministic on next start
    if (req.seedPhrase) {
      try {
        const { needsRestart } = await initializeIdentityFromMnemonic(req.seedPhrase)
        if (needsRestart) console.log('[Backend] Identity key file written for recovery — restart needed')
      } catch (e) {
        console.error('[Backend] initializeIdentityFromMnemonic failed:', e.message)
      }
    }
    return { identity: result }
  } catch (e) {
    console.error('[HRPC] Recovery failed:', e.message)
    return { identity: null }
  }
})

rpc.onBootstrapDevice(async (req) => {
  console.log('[HRPC] bootstrapDevice')
  try {
    const result = await identityManager.bootstrapDevice(req.mnemonic)
    return {
      proof: result.proof,
      identityPublicKey: result.identityPublicKey
    }
  } catch (e) {
    console.error('[HRPC] bootstrapDevice failed:', e.message)
    throw e
  }
})

rpc.onAttestDevice(async (req) => {
  console.log('[HRPC] attestDevice')
  try {
    const proof = await identityManager.attestDevice(
      req.identityKeyPair,
      req.devicePublicKey,
      req.proof || null
    )
    return { proof }
  } catch (e) {
    console.error('[HRPC] attestDevice failed:', e.message)
    throw e
  }
})

rpc.onVerifyAttestation(async (req) => {
  console.log('[HRPC] verifyAttestation')
  try {
    const result = await identityManager.verifyAttestation(req.proof)
    return {
      valid: result.valid,
      identityPublicKey: result.identityPublicKey || '',
      devicePublicKey: result.devicePublicKey || ''
    }
  } catch (e) {
    console.error('[HRPC] verifyAttestation failed:', e.message)
    return { valid: false, identityPublicKey: '', devicePublicKey: '' }
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
  if (!active?.driveKey) return { success: false, error: 'No active channel' }
  try {
    const result = await api.updateChannel(active.driveKey, {
      name: req.name,
      description: req.description,
      avatar: req.avatar
    })
    return result
  } catch (err) {
    return { success: false, error: err?.message }
  }
})

rpc.onUpdateVideoMetadata(async (req) => {
  console.log('[HRPC] updateVideoMetadata:', req.videoId)
  const active = identityManager.getActiveIdentity()
  if (!active?.driveKey) return { success: false, error: 'No active channel' }
  try {
    const result = await api.updateVideoMetadata(
      req.channelKey || active.driveKey,
      req.videoId,
      { title: req.title, description: req.description, category: req.category }
    )
    return result
  } catch (err) {
    return { success: false, error: err?.message }
  }
})

rpc.onUpdateChannelAvatar?.(async (req) => {
  console.log('[HRPC] updateChannelAvatar')
  const active = identityManager.getActiveIdentity()
  if (!active?.driveKey) return { success: false, error: 'No active channel' }
  try {
    const imageBuffer = Buffer.from(req.imageData, 'base64')
    const result = await api.updateChannelAvatar(active.driveKey, imageBuffer, req.mimeType || 'image/jpeg')
    return result
  } catch (err) {
    return { success: false, error: err?.message }
  }
})

// Video handlers
rpc.onListVideos(async (req) => {
  const channelKey = req?.channelKey || ''
  const publicBeeKey = req?.publicBeeKey || null
  console.log('[HRPC] listVideos:', channelKey?.slice(0, 16))

  // Always respond quickly; never let listVideos hang the client.
  if (!channelKey) return { videos: [] }

  let rawVideos = []
  try {
    rawVideos = await api.listVideos(channelKey, publicBeeKey)
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
  // Forward publicBeeKey so viewers can resolve metadata fast.
  // Without it, getVideoUrl can fail for public-feed / multi-writer channels
  // where the channel metadata isn't fully replicated yet.
  const result = await api.getVideoUrl(req.channelKey, req.videoId, req.publicBeeKey)
  return { url: result.url }
})

rpc.onGetVideoData(async (req) => {
  console.log('[HRPC] getVideoData:', req.channelKey?.slice(0, 16), req.videoId)
  const video = await api.getVideoData(req.channelKey, req.videoId, req.publicBeeKey)
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
    (progress, bytesWritten, totalBytes, stats) => {
      // Emit progress event (spec requires `videoId`)
      // Note: Use a stable sentinel id for the active upload.
      const speed = stats?.speed ? Math.max(0, Math.round(stats.speed)) : 0
      const eta = stats?.eta ? Math.max(0, Math.round(stats.eta)) : 0
      rpc.eventUploadProgress({
        videoId: 'upload',
        progress,
        bytesUploaded: bytesWritten,
        totalBytes,
        speed,
        eta,
      })
    }
  )

  console.log('[HRPC] Upload result:', JSON.stringify({ success: result?.success, videoId: result?.videoId, blobId: result?.metadata?.blobId }))

  // Note: uploadManager.uploadFromPath already calls channel.addVideo internally
  if (!result?.success) {
    console.error('[HRPC] Upload failed:', result?.error)
    throw new Error(result?.error || 'Upload failed')
  }

  // Invalidate list caches so the UI sees the new video immediately.
  try {
    api.invalidateChannelCaches?.(active.driveKey)
  } catch {}

  // Generate thumbnail using bare-media (unified with desktop)
  if (result?.success && result?.videoId && !req.skipThumbnailGeneration) {
    console.log('[HRPC] Generating thumbnail with bare-media')
    try {
      const thumbResult = await generateAndStoreThumbnail(filePath, result.videoId, channel, {
        frameIndex: 300 // ~10 seconds at 30fps
      })
      if (thumbResult?.thumbnailBlobId) {
        console.log('[HRPC] Thumbnail stored with blobId:', thumbResult.thumbnailBlobId)
        // Update video metadata with thumbnail info
        await channel.updateVideo(result.videoId, {
          thumbnailBlobId: thumbResult.thumbnailBlobId,
          thumbnailBlobsCoreKey: thumbResult.thumbnailBlobsCoreKey,
          thumbnailMimeType: thumbResult.thumbnailMimeType
        })
      }
    } catch (thumbErr) {
      console.warn('[HRPC] Thumbnail generation failed:', thumbErr?.message || thumbErr)
    }
  } else if (req.skipThumbnailGeneration) {
    console.log('[HRPC] Skipping thumbnail - custom thumbnail will be uploaded')
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
  const requestKey = req.publicBeeKey ? req.publicBeeKey.slice(0, 16) : 'missing'
  console.log('[HRPC] downloadVideo request decoded:', req.channelKey?.slice(0, 16), req.videoId, 'publicBeeKey:', requestKey, 'destPath:', req.destPath)

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
  const active = identityManager.getActiveIdentity?.()
  let channel
  try {
    channel = await identityManager.getActiveChannel?.()
  } catch (e) {
    return { success: false, error: e?.message || 'Failed to load active channel' }
  }
  if (!channel) return { success: false, error: 'No active channel' }
  if (!channel.writable) {
    const key = channel.keyHex || active?.driveKey || 'unknown'
    return { success: false, error: `Active channel is read-only on this device (channel=${key.slice(0, 16)})` }
  }
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
      publicBeeKey: e.publicBeeKey || null,
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
  const meta = await api.getChannelMeta(req.channelKey, req.publicBeeKey || null)
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

// Transcode settings handlers
rpc.onGetTranscodeSettings(async () => {
  console.log('[HRPC] getTranscodeSettings')
  return api.getTranscodeSettings()
})

rpc.onSetTranscodeSettings(async (req) => {
  console.log('[HRPC] setTranscodeSettings')
  return api.setTranscodeSettings(req || {})
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
  const result = await api.getVideoThumbnail(req.channelKey, req.videoId)
  return { url: result.url || null, exists: result.exists || false, dataUrl: null }
})

rpc.onGetVideoMetadata(async (req) => {
  console.log('[HRPC] getVideoMetadata:', req.channelKey?.slice(0, 16), req.videoId)
  const video = await api.getVideoData(req.channelKey, req.videoId)
  return { video: video || { id: req.videoId, title: 'Unknown' } }
})

rpc.onSetVideoThumbnail(async (req) => {
  console.log('[HRPC] setVideoThumbnail blocked (base64 disabled):', req.videoId)
  return { success: false, error: 'setVideoThumbnail is disabled. Use setVideoThumbnailFromFile.' }
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

rpc.onSetVideoThumbnailFromFile(async (req) => {
  console.log('[HRPC] setVideoThumbnailFromFile:', req.videoId)
  const active = identityManager.getActiveIdentity()
  if (!active?.driveKey) return { success: false, error: 'No active identity' }

  const channel = await identityManager.getActiveChannel?.()
  if (!channel) return { success: false, error: 'No active channel' }
  if (!channel.blobs) return { success: false, error: 'Channel blobs not initialized' }

  let filePath = req.filePath
  if (!filePath) return { success: false, error: 'No file path provided' }

  // Handle file:// prefix (RN typically uses this)
  if (filePath.startsWith('file://')) {
    filePath = filePath.slice(7)
  }

  try {
    const buf = fs.readFileSync(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const mimeType = ext === '.webp'
      ? 'image/webp'
      : (ext === '.png' ? 'image/png' : 'image/jpeg')

    const result = await uploadManager.setThumbnailFromBuffer(
      channel,
      req.videoId,
      buf,
      mimeType
    )
    try {
      api.invalidateChannelCaches?.(active.driveKey)
    } catch {}
    return { success: result.success, error: result.error }
  } catch (err) {
    console.error('[HRPC] setVideoThumbnailFromFile failed:', err?.message || err)
    return { success: false, error: err?.message || String(err) }
  }
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
    setCastActive(true)
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
  if (castPrefetchAbortController) {
    castPrefetchAbortController.abort()
    castPrefetchAbortController = null
    console.log('[CastDiag] Cast pre-buffer aborted on disconnect')
  }
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
      activeCastSourceKey = null
    }
    setCastActive(false)

    return { success: true }
  } catch (err) {
    return { success: false, error: err?.message }
  }
})

// Active transcode session for casting
let activeCastTranscodeId = null
let activeCastSourceKey = null

// Stall detector for HLS segment generation during cast
let castStallMonitor = null

// Track which HLS sessions have already sent LOAD to Chromecast
// Key: sessionId, Value: true
const hlsSessionsWithLoadSent = new Map()
let castPrefetchAbortController = null

// Guard against concurrent/repeated castPlay calls
let castPlayInProgress = false
let lastCastPlayTime = 0
let castLoadCompletedAt = 0
const CAST_PLAY_DEBOUNCE_MS = 2000
const CAST_POST_LOAD_GRACE_MS = 5000
const CAST_MIN_SYNC_PERCENT = 20
const CAST_TARGET_SYNC_PERCENT = 35
const CAST_SYNC_WAIT_TIMEOUT_MS = 45000
const CAST_SYNC_WAIT_INTERVAL_MS = 3000

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

    // Clear any existing stall monitor from a previous cast (avoid duplicates)
    if (castStallMonitor) {
      clearInterval(castStallMonitor)
      castStallMonitor = null
    }
  lastCastPlayTime = now
  setCastActive(true)

  if (castPrefetchAbortController) {
    castPrefetchAbortController.abort()
    castPrefetchAbortController = null
  }

  const castPrefetchTarget = extractCastPrefetchTarget(req?.url)
  if (castPrefetchTarget?.driveKey && castPrefetchTarget?.filePath) {
    const channel = ctx?.channels?.get?.(castPrefetchTarget.driveKey)
    const drive = channel?.drive || channel?.hyperdrive || null
    if (drive && typeof prefetchVideoForCast === 'function') {
      castPrefetchAbortController = new AbortController()
      console.log('[CastDiag] Starting pre-buffer for cast')
      prefetchVideoForCast(drive, castPrefetchTarget.filePath, castPrefetchAbortController.signal)
        .catch((err) => {
          if (err?.name === 'AbortError') {
            console.log('[CastDiag] Cast pre-buffer aborted')
          } else {
            console.warn('[CastDiag] Cast pre-buffer failed:', err?.message || err)
          }
        })
    } else {
      console.log('[CastDiag] Cast pre-buffer skipped: drive unavailable for key', castPrefetchTarget.driveKey.slice(0, 16))
    }
  }

  try {
    if (!castContext?.isConnected()) {
      return { success: false, error: 'Not connected to cast device' }
    }

    let url = req.url
    let contentType = req.contentType
    let currentTranscodeSessionId = null  // Track session ID for cleanup logic (needs function scope)
    let transcodeRequired = false

    const protocol = castContext?._connectedDevice?.deviceInfo?.protocol
    const deviceHost = castContext?._connectedDevice?.deviceInfo?.host
    const requestedUrl = normalizeLocalUrlForCast(req.url)
    const requestedKey = buildTranscodeCacheKey(requestedUrl) || requestedUrl

    if (
      protocol === 'chromecast' &&
      activeCastTranscodeId &&
      hlsSessionsWithLoadSent.has(activeCastTranscodeId) &&
      activeCastSourceKey === requestedKey
    ) {
      console.log('[Backend] Cast play: HLS already active for this source, skipping reload')
      return { success: true }
    }

    // For Chromecast, ALL videos go through HLS (remux or transcode).
    // HLS segments are stored in memory — once generated, the blob server
    // is no longer needed. This lets casting survive app backgrounding.
    if (protocol === 'chromecast') {
      transcodeRequired = true

      try {
        const probeResult = await transcoder.probeMedia(requestedUrl, req.title)
        console.log('[Backend] Probe result:', {
          video: probeResult.videoCodec,
          audio: probeResult.audioCodec,
          container: probeResult.container,
          needsTranscode: probeResult.needsTranscode,
          needsRemux: probeResult.needsRemux,
          reason: probeResult.reason,
        })
      } catch (probeErr) {
        console.warn('[Backend] Cast play: probe failed (HLS transcoder will re-detect):', probeErr?.message)
      }

      let isVideoComplete = true
      let syncStatus = null
      try {
        syncStatus = await api.checkVideoSync(requestedUrl)
        console.log('[Backend] Cast play: video sync status -',
          syncStatus.progress + '%',
          '(' + syncStatus.availableBlocks + '/' + syncStatus.totalBlocks + ' blocks)',
          syncStatus.isComplete ? 'COMPLETE' : 'INCOMPLETE',
          syncStatus.assumed ? '(ASSUMED)' : '')

        isVideoComplete = syncStatus.isComplete

        if (!syncStatus.isComplete && !syncStatus.assumed) {
          const sizeMB = Math.round((syncStatus.byteLength || 0) / 1024 / 1024)
          const downloadedMB = Math.round(sizeMB * syncStatus.progress / 100)
          console.warn('[Backend] Cast play: Video may not be fully synced!',
            downloadedMB + 'MB /', sizeMB + 'MB downloaded.',
            'Proceeding anyway - TempFileReader will handle gracefully.')
        }
      } catch (syncErr) {
        console.warn('[Backend] Cast play: Could not check sync status:', syncErr?.message)
        isVideoComplete = true
        syncStatus = null
      }

      // Add a short buffering window before starting cast on partially-synced videos.
      // This reduces mid-stream EOF when transcoder read speed briefly exceeds P2P download speed.
      if (!isVideoComplete && syncStatus && !syncStatus.assumed) {
        let latestSyncStatus = syncStatus
        let syncPercent = latestSyncStatus.progress || 0

        if (syncPercent < CAST_TARGET_SYNC_PERCENT) {
          const waitStart = Date.now()
          console.log('[Backend] Cast play: waiting for safer sync level:', syncPercent + '% -> target ' + CAST_TARGET_SYNC_PERCENT + '%')

          while (Date.now() - waitStart < CAST_SYNC_WAIT_TIMEOUT_MS) {
            await new Promise((resolve) => setTimeout(resolve, CAST_SYNC_WAIT_INTERVAL_MS))
            try {
              const refreshed = await api.checkVideoSync(requestedUrl)
              if (refreshed) {
                latestSyncStatus = refreshed
                isVideoComplete = Boolean(refreshed.isComplete)
                syncPercent = refreshed.progress || 0
                console.log('[Backend] Cast play: sync wait progress', syncPercent + '%', isVideoComplete ? '(complete)' : '')
                if (isVideoComplete || syncPercent >= CAST_TARGET_SYNC_PERCENT) {
                  break
                }
              }
            } catch (waitErr) {
              console.warn('[Backend] Cast play: sync wait check failed:', waitErr?.message)
              break
            }
          }
        }

        syncStatus = latestSyncStatus
        const finalSyncPercent = syncStatus.progress || 0
        console.log('[Backend] Cast sync check:', finalSyncPercent + '% synced, min:', CAST_MIN_SYNC_PERCENT + '%, target:', CAST_TARGET_SYNC_PERCENT + '%')
        if (finalSyncPercent < CAST_MIN_SYNC_PERCENT) {
          console.warn('[Backend] Cast rejected: video is only ' + finalSyncPercent + '% downloaded. Need at least ' + CAST_MIN_SYNC_PERCENT + '%.')
          return { success: false, error: 'Video is only ' + finalSyncPercent + '% downloaded. Please wait a bit longer and try again.' }
        }
        if (!isVideoComplete && finalSyncPercent < CAST_TARGET_SYNC_PERCENT) {
          console.warn('[Backend] Cast starting below target sync (' + finalSyncPercent + '%). Playback may still stall on slow peers.')
        }
      }

      console.log('[Backend] Cast play: starting HLS transcode with progressive streaming...')
      const result = await hlsTranscoder.startHlsTranscode(requestedUrl, {
        title: req.title || '',
        store: ctx.store,
        sourceKey: requestedKey,
        // Use actual sync status to determine if video is complete
        isVideoComplete,
        // Enable progressive streaming for better responsiveness
        forceProgressive: true,
        // Force Hypercore stream reader for P2P efficiency
        forceHypercoreStream: true,
        // Force full transcode path for Chromecast stability. Some "compatible"
        // sources fail in remux mode on real devices.
        forceFullTranscode: true,
        blobInfo: syncStatus?.blobInfo || null,
        blobsCoreKey: syncStatus?.blobsCoreKey || null,
        onProgress: (sessionId, percent) => {
          if (percent % 10 === 0) {
            console.log(`[Backend] HLS transcode progress: ${percent}%`)
          }
        }
      })

      if (!result.success) {
        throw new Error(result.error || 'HLS transcode failed')
      }

      currentTranscodeSessionId = result.sessionId
      console.log('[Backend] Cast play: HLS session:', result.sessionId, 'hlsUrl:', result.hlsUrl, 'reused:', result.reused || false)

      if (result.reused) {
        const status = hlsTranscoder.getHlsStatus(result.sessionId)
        console.log('[Backend] Cast play: Reused session has', status?.segments || 0, 'segments')

        if (hlsSessionsWithLoadSent.has(result.sessionId)) {
          activeCastTranscodeId = result.sessionId
          activeCastSourceKey = requestedKey
          console.log('[Backend] Cast play: LOAD already sent for this session, skipping duplicate LOAD')
          return { success: true }
        }
      } else {
        const MIN_SEGMENTS = 1
        // Reliability over startup speed: allow long initial preparation when
        // source data must fully download before transcode starts.
        const MAX_WAIT_MS = 60 * 1000
        const POLL_INTERVAL_MS = 500
        console.log('[Backend] Cast play: Waiting for', MIN_SEGMENTS, 'HLS segments...')

        const waitStart = Date.now()
        let segmentCount = 0
        let playlistReady = false
        while (Date.now() - waitStart < MAX_WAIT_MS) {
          const status = hlsTranscoder.getHlsStatus(result.sessionId)
          segmentCount = status?.segments || 0
          playlistReady = status?.playlistReady || false

          if (segmentCount >= MIN_SEGMENTS && playlistReady) {
            console.log('[Backend] Cast play:', segmentCount, 'segments ready')
            break
          }

          if (status?.status === 'error') {
            throw new Error(status.error || 'Transcode failed while waiting for segments')
          }

          const elapsed = Date.now() - waitStart
          if (elapsed % 3000 < POLL_INTERVAL_MS) {
            console.log('[Backend] Cast play: waiting...', segmentCount, '/', MIN_SEGMENTS, 'segments, elapsed:', Math.round(elapsed/1000) + 's')
          }

          await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
        }

        if (segmentCount < MIN_SEGMENTS) {
          throw new Error('HLS startup timeout: no playable segments generated')
        }
      }

      const localIp = await getLocalIPv4ForTarget(deviceHost)
      let hlsUrl = result.hlsUrl

      if (localIp) {
        hlsUrl = hlsUrl.replace('127.0.0.1', localIp)
        console.log('[Backend] Cast play: HLS URL with LAN IP:', hlsUrl)
      } else {
        throw new Error('Could not determine LAN IP for HLS cast URL')
      }

      url = hlsUrl
      contentType = 'application/x-mpegurl'
      console.log('[Backend] Cast play: using HLS URL', url)
    }

    try {
      let host = 'unknown'
      try {
        const parsed = new URL(url)
        host = parsed.host
      } catch {}
      console.log('[Backend] Cast play:', protocol || 'unknown', 'contentType:', contentType, 'host:', host)
    } catch {}

    const streamType = req.duration && req.duration > 0 ? 'BUFFERED' : 'LIVE'

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
      if (!currentTranscodeSessionId && activeCastSourceKey === requestedKey) {
        console.log('[Backend] Cast play: Keeping existing HLS session for same source')
      } else {
        console.log('[Backend] Cast play: Cleaning up previous transcode session:', previousSessionId)
        hlsSessionsWithLoadSent.delete(previousSessionId)
        try {
          hlsTranscoder.stopHlsTranscode(previousSessionId)
        } catch {}
        if (!currentTranscodeSessionId) {
          activeCastTranscodeId = null
          activeCastSourceKey = null
        }
      }
    }
    // Update tracking to current session
    if (currentTranscodeSessionId) {
      activeCastTranscodeId = currentTranscodeSessionId
      activeCastSourceKey = requestedKey
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
      duration: req.duration,
      streamType,
    })

    console.log('[Backend] Cast play: >>> LOAD SENT SUCCESSFULLY <<<')
    castLoadCompletedAt = Date.now()

    // Track that LOAD was sent for this HLS session to prevent duplicate LOADs
    if (activeCastTranscodeId && contentType === 'application/x-mpegurl') {
      hlsSessionsWithLoadSent.set(activeCastTranscodeId, true)
      console.log('[Backend] Cast play: Marked session', activeCastTranscodeId, 'as LOAD sent')
    }

    // Start stall detector for HLS segment generation
    if (activeCastTranscodeId && contentType === 'application/x-mpegurl') {
      // Clear any previous stall monitor before starting new one
      if (castStallMonitor) {
        clearInterval(castStallMonitor)
        castStallMonitor = null
      }
      let lastStallSegmentCount = 0
      let stallCheckCount = 0
      const monitorSessionId = activeCastTranscodeId
      castStallMonitor = setInterval(() => {
        try {
          const status = hlsTranscoder.getHlsStatus(monitorSessionId)
          if (status && status.segments !== undefined) {
            if (status.segments > lastStallSegmentCount) {
              lastStallSegmentCount = status.segments
              stallCheckCount = 0
            } else {
              stallCheckCount++
              if (stallCheckCount >= 3) {
                console.warn('[Backend] Cast stall detected: no new segments for ' + (stallCheckCount * 10) + 's')
              }
              if (stallCheckCount >= 6) {
                console.error('[Backend] Cast stall critical: no new segments for 60s, notifying frontend')
                clearInterval(castStallMonitor)
                castStallMonitor = null
                rpc.eventLog?.({ message: '[Cast] Stall detected: no new segments for 60s' })
              }
            }
          }
        } catch (e) { /* ignore stall check errors */ }
      }, 10000)
      console.log('[Backend] Cast play: Started stall monitor for session', monitorSessionId)
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
  if (castPrefetchAbortController) {
    castPrefetchAbortController.abort()
    castPrefetchAbortController = null
    console.log('[CastDiag] Cast pre-buffer aborted on stop')
  }
  if (!castContext?.isConnected()) {
    return { success: false, error: 'Not connected' }
  }
  try {
    await castContext.stop()
    castProxySessions.clear()

    // Cleanup stall monitor
    if (castStallMonitor) {
      clearInterval(castStallMonitor)
      castStallMonitor = null
      console.log('[Backend] Cast stop: Cleared stall monitor')
    }

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
      activeCastSourceKey = null
    }
    setCastActive(false)

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
  // Refresh proxy session timestamps during active cast keepalive (called every 15s)
  refreshCastProxySessions()
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
rpc.onEventTranscodeProgress?.(() => {})

console.log('[Backend] HRPC handlers registered')
handlersRegistered = true

// Send ready event + initial feed update
try {
  const port = ctx.blobServer?.port || ctx.blobServerPort || 0
  rpc.eventReady({ blobServerPort: port, blobServerHost: ctx.blobServerHost || '127.0.0.1' })
  console.log('[Backend] Sent eventReady via HRPC, blobServerPort:', port, 'host:', ctx.blobServerHost || '127.0.0.1')
  rpc.eventFeedUpdate({ channelKey: 'feed', action: 'update' })
} catch (e) {
  console.error('[Backend] Failed to send eventReady:', e.message)
}

const preloadFfmpeg = typeof process !== 'undefined' && process?.env?.PEARTUBE_PRELOAD_FFMPEG === '1'
if (preloadFfmpeg) {
  backendLog('[Backend] Pre-loading bare-ffmpeg...')
  Promise.all([
    transcoder.loadBareFfmpeg(),
    hlsTranscoder.loadBareFfmpeg()
  ]).then(([legacyLoaded, hlsLoaded]) => {
    backendLog('[Backend] bare-ffmpeg pre-load: legacy=' + legacyLoaded + ', hls=' + hlsLoaded)
  }).catch(err => {
    backendLog('[Backend] bare-ffmpeg pre-load error: ' + (err?.message || err))
  })
} else {
  backendLog('[Backend] bare-ffmpeg pre-load disabled (set PEARTUBE_PRELOAD_FFMPEG=1 to enable)')
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
