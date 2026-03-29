/**
 * PearTube Mobile Cast - Chromecast casting support for mobile backend
 *
 * Extracted from index.mjs to keep the main shim thin.
 * Provides cast handler implementations that are attached to the backend object.
 */

let CastContext = null
let castLoadError = null
let castLoadPromise = null
let castContext = null
let isHeadlessMode = false
let headlessShutdownTimer = null
const HEADLESS_SHUTDOWN_DELAY_MS = 8 * 60 * 60 * 1000

let castProxyServer = null
let castProxyPort = 0
let castProxyReady = null
const castProxySessions = new Map()
const castProxyPlaylistLogged = new Set()
const CAST_PROXY_TTL_MS = 8 * 60 * 60 * 1000

const CAST_LOCALHOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1'])

let activeCastTranscodeId = null
let activeCastSourceKey = null
let castStallMonitor = null
const castSessionsWithLoadSent = new Set()
let castPrefetchAbortController = null
let castPlayInProgress = false
let lastCastPlayTime = 0
let castLoadCompletedAt = 0
const CAST_PLAY_DEBOUNCE_MS = 2000
const CAST_POST_LOAD_GRACE_MS = 5000

function normalizeCastVolume(volume) {
  const value = typeof volume === 'number' && Number.isFinite(volume) ? volume : 1
  if (value > 1) {
    return Math.max(0, Math.min(100, value)) / 100
  }
  return Math.max(0, Math.min(1, value))
}

function cleanupCastProxySessions(now = Date.now(), isCastActiveFn) {
  if (isCastActiveFn && isCastActiveFn()) return
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

/**
 * Attach all cast handler implementations to the backend object.
 *
 * @param {Object} B - The backend object to attach handlers to
 * @param {Object} deps - Dependencies
 * @param {Object} deps.rpc - HRPC instance
 * @param {Object} deps.ctx - Storage context
 * @param {Object} deps.api - API methods
 * @param {Function} deps.setCastActive - Set cast active flag
 * @param {Function} deps.isCastActive - Check if cast is active
 * @param {Function} deps.prefetchVideoForCast - Prefetch video for cast
 * @param {Object} deps.http1 - bare-http1 module
 * @param {Object} deps.path - bare-path module
 * @param {Object} deps.fs - bare-fs module
 * @param {Object} deps.transcoder - Transcoder module
 * @param {Object} deps.castTranscoder - Cast transcoder module
 * @param {string} deps.storagePath - Storage path
 */
export function attachCastHandlers(B, deps) {
  const { rpc, ctx, api, setCastActive, isCastActive, prefetchVideoForCast, http1, path, fs, transcoder, castTranscoder, storagePath } = deps

  function setHeadlessCastFlag(active) {
    const flagPath = path.join(storagePath, '.peartube-cast-headless')
    try {
      if (active) {
        const data = JSON.stringify({ pid: Bare.pid, startedAt: Date.now() })
        fs.writeFileSync(flagPath, data, 'utf8')
      } else {
        try {
          fs.unlinkSync(flagPath)
        } catch (err) {
          if (err.code !== 'ENOENT') throw err
        }
      }
    } catch (err) {
      console.error('[Backend] setHeadlessCastFlag error:', err.message)
    }
  }

  function enterHeadlessMode(reason = 'ipc-close') {
    if (isHeadlessMode) return
    isHeadlessMode = true
    console.log('[CastDiag] Entering headless mode:', reason)
  }

async function loadCastContext() {
    if (CastContext || castLoadError) return
    if (castLoadPromise) return castLoadPromise
    castLoadPromise = (async () => {
      let lastError
      if (typeof require === 'function') {
        try {
          const mod = require('@peartube/backend/cast')
          CastContext = mod?.CastContext ?? mod?.default ?? mod
          console.log('[Backend] cast context loaded')
          return
        } catch (err) {
          lastError = err
        }
      }
      try {
        const mod = await import('@peartube/backend/cast')
        CastContext = mod?.CastContext ?? mod?.default ?? mod
        console.log('[Backend] cast context loaded')
        return
      } catch (err) {
        lastError = err
      }
      castLoadError = lastError?.message || 'Unknown error'
      console.warn('[Backend] cast context not available:', castLoadError)
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
          console.log('[CastDiag] playbackStateChanged:', state)
          if (state === 'playing' || state === 'paused' || state === 'buffering') {
            castLoadCompletedAt = 0
            setHeadlessCastFlag(true)
            if (headlessShutdownTimer) {
              clearTimeout(headlessShutdownTimer)
              headlessShutdownTimer = null
            }
          }
          if (state === 'stopped' || state === 'idle' || state === 'disconnected') {
            activeCastSourceKey = null
            if (activeCastTranscodeId) castSessionsWithLoadSent.delete(activeCastTranscodeId)
            setHeadlessCastFlag(false)
            if (isHeadlessMode) {
              if (headlessShutdownTimer) clearTimeout(headlessShutdownTimer)
              headlessShutdownTimer = setTimeout(() => {
                headlessShutdownTimer = null
                setHeadlessCastFlag(false)
                Bare.exit(0)
              }, HEADLESS_SHUTDOWN_DELAY_MS)
            }
          }
          rpc?.eventCastPlaybackState?.({ state })
        } catch {}
      })

      castContext.on('timeChanged', (time) => {
        try {
          rpc?.eventCastTimeUpdate?.({ currentTime: Math.max(1, Math.floor(time || 0)) })
        } catch {}
      })

      castContext.on('error', (error) => {
        try {
          activeCastSourceKey = null
          if (activeCastTranscodeId) castSessionsWithLoadSent.delete(activeCastTranscodeId)
          const message = error?.message || String(error)
          console.warn('[Backend] Cast error:', message)

          if (castPlayInProgress) {
            console.log('[Backend] Cast error suppressed (load in progress):', message)
            return
          }

          const sinceLoad = castLoadCompletedAt > 0 ? Date.now() - castLoadCompletedAt : Infinity
          if (sinceLoad < CAST_POST_LOAD_GRACE_MS && message.includes('media error')) {
            console.log('[Backend] Cast error suppressed (post-load grace):', message)
            return
          }

          rpc?.eventCastPlaybackState?.({ state: 'error', error: message })
        } catch {}
      })
    }
    return castContext
  }

  function rewriteHlsPlaylist(body) {
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

    const maxSegments = 10000
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
          console.log('[CastProxy] incoming', req.method || 'GET', req.url?.substring(0, 80))
        } catch {}
        setCorsHeaders(res)
        if ((req.method || '').toUpperCase() === 'OPTIONS') {
          res.statusCode = 204
          res.end()
          return
        }
        const now = Date.now()
        cleanupCastProxySessions(now, isCastActive)
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

        if (!token || !castProxySessions.has(token)) {
          res.statusCode = 404
          res.setHeader('Content-Type', 'text/plain')
          res.end('Cast proxy session not found.')
          return
        }

        const entry = castProxySessions.get(token)
        if (entry) entry.lastAccessAt = Date.now()
        const target = entry ? buildLocalProxyTarget(entry.url) : null
        if (!target) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'text/plain')
          res.end('Cast proxy target invalid.')
          return
        }

        const method = (req.method || 'GET').toUpperCase()
        let targetPathname = target.pathname
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
              if (!res.headersSent) { res.statusCode = 502; res.end('Cast proxy upstream error') }
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
              if (!res.headersSent) { res.statusCode = 502; res.end('Cast proxy upstream error') }
            })
            return
          }

          res.statusCode = proxyRes.statusCode || 502
          if (proxyRes.headers) {
            for (const [key, value] of Object.entries(proxyRes.headers)) {
              if (value !== undefined) res.setHeader(key, value)
            }
          }
          setCorsHeaders(res)

          let pipeCleanedUp = false
          const cleanupPipe = () => {
            if (pipeCleanedUp) return
            pipeCleanedUp = true
            try { proxyRes.unpipe?.(res) } catch {}
            try { proxyRes.destroy?.() } catch {}
          }

          proxyRes.on('error', () => cleanupPipe())
          res.on('error', () => cleanupPipe())
          res.on('close', () => cleanupPipe())

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

  async function createCastProxyUrl(targetHost, sourceUrl) {
    const localIp = await getLocalIPv4ForTarget(targetHost)
    if (!localIp || !castProxyPort) {
      console.warn('[Backend] Cast proxy unavailable', { localIp: localIp || null, port: castProxyPort || 0 })
      return null
    }
    cleanupCastProxySessions(Date.now(), isCastActive)
    const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    const now = Date.now()
    const isHls = sourceUrl.endsWith('.m3u8') || sourceUrl.includes('.m3u8?')
    castProxySessions.set(token, { url: sourceUrl, isHls, createdAt: now, lastAccessAt: now })
    const suffix = isHls ? '/index.m3u8' : ''
    const proxyUrl = `http://${localIp}:${castProxyPort}/cast/${token}${suffix}`
    console.log('[Backend] Cast proxy created:', proxyUrl)
    return proxyUrl
  }

  // --- Attach cast handlers to backend ---

  B.castAvailable = async () => {
    await loadCastContext()
    return { available: CastContext !== null, error: castLoadError }
  }

  B.castStartDiscovery = async () => {
    await loadCastContext()
    if (!CastContext) return { success: false, error: castLoadError || 'cast context not available' }
    try {
      const ctx = getCastContext()
      await ctx.startDiscovery()
      return { success: true }
    } catch (err) {
      return { success: false, error: err?.message }
    }
  }

  B.castStopDiscovery = async () => {
    if (!castContext) return { success: true }
    try {
      castContext.stopDiscovery()
      return { success: true }
    } catch (err) {
      return { success: false, error: err?.message }
    }
  }

  B.castGetDevices = async () => {
    if (!castContext) return { devices: [] }
    try {
      const devices = castContext.getDevices()
      return { devices: devices.map((d) => ({
        id: d.id, name: d.name, host: d.host, port: d.port, protocol: d.protocol,
      })) }
    } catch {
      return { devices: [] }
    }
  }

  B.castAddManualDevice = async (r) => {
    await loadCastContext()
    if (!CastContext) return { success: false, error: castLoadError || 'cast context not available' }
    try {
      const ctx = getCastContext()
      const device = ctx.addManualDevice({
        name: r.name, host: r.host, port: r.port, protocol: r.protocol || 'chromecast',
      })
      return { success: true, device: {
        id: device.id, name: device.name, host: device.host, port: device.port, protocol: device.protocol,
      } }
    } catch (err) {
      return { success: false, error: err?.message }
    }
  }

  B.castConnect = async (r) => {
    const normalizeErrorMessage = (err, fallback) => {
      if (!err) return fallback
      if (typeof err === 'string' && err.trim()) return err
      if (err && typeof err.message === 'string' && err.message.trim()) return err.message
      try {
        const serialized = JSON.stringify(err)
        if (serialized && serialized !== '{}') return serialized
      } catch (jsonErr) {
        // ignore serialization errors
      }
      const asString = String(err)
      return asString && asString !== '[object Object]' ? asString : fallback
    }

    await loadCastContext()
    if (!CastContext) return { success: false, error: castLoadError || 'cast context not available' }
    const c = getCastContext()
    try {
      const devices = c.getDevices?.() || []
      const device = devices.find((d) => d.id === r.deviceId)
      await c.connect(r.deviceId)
      setCastActive(true)
      return device ? {
        success: true,
        device: { id: device.id, name: device.name, host: device.host, port: device.port, protocol: device.protocol },
      } : { success: true }
    } catch (err) {
      return { success: false, error: normalizeErrorMessage(err, 'Cannot connect to Chromecast device') }
    }
  }

  B.castDisconnect = async () => {
    if (castPrefetchAbortController) {
      castPrefetchAbortController.abort()
      castPrefetchAbortController = null
    }
    if (!castContext) return { success: true }
    try {
      await castContext.disconnect()
      castProxySessions.clear()
      if (activeCastTranscodeId) {
        castSessionsWithLoadSent.delete(activeCastTranscodeId)
        castTranscoder.stopCastTranscode(activeCastTranscodeId)
        activeCastTranscodeId = null
        activeCastSourceKey = null
      }
      setCastActive(false)
      return { success: true }
    } catch (err) {
      return { success: false, error: err?.message }
    }
  }

  B.castPause = async () => {
    if (!castContext?.isConnected()) return { success: false, error: 'Not connected' }
    try { await castContext.pause(); return { success: true } } catch (err) { return { success: false, error: err?.message } }
  }

  B.castResume = async () => {
    if (!castContext?.isConnected()) return { success: false, error: 'Not connected' }
    try { await castContext.resume(); return { success: true } } catch (err) { return { success: false, error: err?.message } }
  }

  B.castStop = async () => {
    if (castPrefetchAbortController) {
      castPrefetchAbortController.abort()
      castPrefetchAbortController = null
    }
    if (!castContext?.isConnected()) return { success: false, error: 'Not connected' }
    try {
      await castContext.stop()
      castProxySessions.clear()
      if (castStallMonitor) { clearInterval(castStallMonitor); castStallMonitor = null }
      if (activeCastTranscodeId) {
        castSessionsWithLoadSent.delete(activeCastTranscodeId)
        castTranscoder.stopCastTranscode(activeCastTranscodeId)
        activeCastTranscodeId = null
        activeCastSourceKey = null
      }
      setCastActive(false)
      return { success: true }
    } catch (err) {
      return { success: false, error: err?.message }
    }
  }

  B.castSeek = async (r) => {
    if (!castContext?.isConnected()) return { success: false, error: 'Not connected' }
    const seekTime = Number.isFinite(r?.time) ? Math.max(0, Number(r.time)) : NaN
    if (!Number.isFinite(seekTime)) return { success: false, error: 'Invalid seek time' }
    try { await castContext.seek(seekTime); return { success: true } } catch (err) { return { success: false, error: err?.message } }
  }

  B.castSetVolume = async (r) => {
    if (!castContext?.isConnected()) return { success: false, error: 'Not connected' }
    try { await castContext.setVolume(normalizeCastVolume(r.volume)); return { success: true } } catch (err) { return { success: false, error: err?.message } }
  }

  B.castGetState = async () => {
    refreshCastProxySessions()
    if (!castContext) return { state: 'idle' }
    try {
      const state = castContext.getPlaybackState()
      const result = { state: state.state || 'idle' }
      if (state.currentTime > 0) result.currentTime = Math.floor(state.currentTime)
      if (state.duration > 0) result.duration = Math.floor(state.duration)
      if (state.volume > 0) result.volume = Math.floor(state.volume * 100)
      return result
    } catch {
      return { state: 'idle' }
    }
  }

  B.castIsConnected = async () => ({ connected: Boolean(castContext?.isConnected()) })

  B.castPlay = async (r) => {
    const now = Date.now()
    if (now - lastCastPlayTime < CAST_PLAY_DEBOUNCE_MS) {
      return { success: true, reason: 'debounced' }
    }
    if (castPlayInProgress) {
      return { success: true, reason: 'in-progress' }
    }

    castPlayInProgress = true
    if (castStallMonitor) { clearInterval(castStallMonitor); castStallMonitor = null }
    lastCastPlayTime = now
    setCastActive(true)

    if (castPrefetchAbortController) {
      castPrefetchAbortController.abort()
      castPrefetchAbortController = null
    }

    const castPrefetchTarget = extractCastPrefetchTarget(r?.url)
    if (castPrefetchTarget?.driveKey && castPrefetchTarget?.filePath) {
      const channel = ctx?.channels?.get?.(castPrefetchTarget.driveKey)
      const drive = channel?.drive || channel?.hyperdrive || null
      if (drive && typeof prefetchVideoForCast === 'function') {
        castPrefetchAbortController = new AbortController()
        prefetchVideoForCast(drive, castPrefetchTarget.filePath, castPrefetchAbortController.signal)
          .catch((err) => {
            if (err?.name !== 'AbortError') console.warn('[CastDiag] Cast pre-buffer failed:', err?.message || err)
          })
      }
    }

    try {
      if (!castContext?.isConnected()) {
        return { success: false, error: 'Not connected to cast device' }
      }

      let url = r.url
      let contentType = r.contentType
      let currentTranscodeSessionId = null
      let transcodeRequired = false

      const protocol = castContext?._connectedDevice?.deviceInfo?.protocol
      const deviceHost = castContext?._connectedDevice?.deviceInfo?.host
      const requestedUrl = normalizeLocalUrlForCast(r.url)
      const requestedKey = buildTranscodeCacheKey(requestedUrl) || requestedUrl

      let probeResult = null
      if (protocol === 'chromecast') {
        transcodeRequired = true

        try {
          probeResult = await transcoder.probeMedia(requestedUrl, r.title)
          console.log('[CastDiag] probeMedia', {
            videoCodec: probeResult?.videoCodec,
            audioCodec: probeResult?.audioCodec,
            container: probeResult?.container,
            needsVideoTranscode: probeResult?.needsVideoTranscode,
            needsAudioTranscode: probeResult?.needsAudioTranscode,
            needsRemux: probeResult?.needsRemux,
          })
        } catch (probeErr) {
          console.warn('[Backend] Cast play: probe failed:', probeErr?.message)
        }

        const localIp = await getLocalIPv4ForTarget(deviceHost)
        if (!localIp) throw new Error('Could not determine LAN IP for HLS cast URL')

        const result = await castTranscoder.startCastTranscode(requestedUrl, {
          sourceKey: requestedKey,
          // Keep transcode startup progressive so cast can begin before full source sync.
          // Underflowed sessions are now rejected in cast-transcoder.
          isVideoComplete: false,
        })

        if (!result.success) throw new Error(result.error || 'Cast transcode failed')

        currentTranscodeSessionId = result.sessionId

        const MAX_WAIT_MS = 90 * 1000
        const POLL_INTERVAL_MS = 500
        const MIN_STARTUP_FRAGMENTS = 1
        const waitStart = Date.now()
        let fragmentCount = 0
        let hasInit = false
        let startupStatus = 'pending'
        while (Date.now() - waitStart < MAX_WAIT_MS) {
          const status = castTranscoder.getCastStatus(result.sessionId)
          fragmentCount = status?.fragmentCount || 0
          const snapshot = status?.storeSnapshot || null
          hasInit = !!snapshot?.hasInit
          startupStatus = status?.status || startupStatus
          if (hasInit && fragmentCount >= MIN_STARTUP_FRAGMENTS) break
          if (status?.status === 'error') throw new Error(status.error || 'Cast transcode failed')
          if (status?.status === 'cancelled') throw new Error(status.error || 'Cast transcode cancelled')
          await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
        }
        if (!hasInit || fragmentCount < MIN_STARTUP_FRAGMENTS) {
          throw new Error(
            `Cast transcode startup timeout: only ${fragmentCount}/${MIN_STARTUP_FRAGMENTS} fragments ready (init=${hasInit ? 1 : 0}, status=${startupStatus})`
          )
        }

        const hlsUrl = castTranscoder.getCastHlsUrl(result.sessionId, localIp)
        if (!hlsUrl) throw new Error('Could not get cast HLS URL')
        console.log('[CastDiag] Chromecast HLS URL:', hlsUrl)
        console.log('[CastDiag] Chromecast HLS probe:', `curl -sv "${hlsUrl}"`)
        url = hlsUrl
        contentType = 'application/vnd.apple.mpegurl'
      } else {
        // Non-Chromecast protocols: use cast proxy
        await ensureCastProxyServer()
        const proxyUrl = await createCastProxyUrl(deviceHost, requestedUrl)
        if (!proxyUrl) throw new Error('Could not create cast proxy URL for cast device')
        url = proxyUrl
      }

      const probedDuration = Number(probeResult?.duration || 0)
      const requestedDuration = Number(r.duration || 0)
      const castDuration = requestedDuration > 0 ? requestedDuration : (probedDuration > 0 ? probedDuration : 0)
      const requestedStartTime = Number.isFinite(r?.time) ? Math.max(0, Number(r.time)) : 0
      const isHlsCast = contentType === 'application/x-mpegURL' || contentType === 'application/vnd.apple.mpegurl'
      const hasKnownDuration = castDuration > 0
      const streamType = isHlsCast
        ? 'LIVE'
        : (hasKnownDuration ? 'BUFFERED' : 'LIVE')
      const loadDuration = (streamType === 'BUFFERED' && hasKnownDuration) ? castDuration : undefined

      try {
        await castContext.stop()
        await new Promise(resolve => setTimeout(resolve, 200))
      } catch {}

      // Cleanup previous session
      const previousSessionId = activeCastTranscodeId
      if (previousSessionId && previousSessionId !== currentTranscodeSessionId) {
        if (!currentTranscodeSessionId && activeCastSourceKey === requestedKey) {
          // Keep existing session for same source
        } else {
          castSessionsWithLoadSent.delete(previousSessionId)
          castTranscoder.stopCastTranscode(previousSessionId)
          if (!currentTranscodeSessionId) {
            activeCastTranscodeId = null
            activeCastSourceKey = null
          }
        }
      }
      if (currentTranscodeSessionId) {
        activeCastTranscodeId = currentTranscodeSessionId
        activeCastSourceKey = requestedKey
      }

      let playRejected = null
      try {
        await castContext.play({
          url, contentType, title: r.title, thumbnail: r.thumbnail,
          time: requestedStartTime, volume: normalizeCastVolume(r.volume),
          duration: loadDuration, streamType,
          startTimeoutMs: 30000,
        })
      } catch (playErr) {
        playRejected = playErr
      }

      if (playRejected) {
        const isCastTimeoutIdle = /timed out waiting for chromecast playback to start/i.test(String(playRejected?.message || ''))
          && /state=IDLE/i.test(String(playRejected?.message || ''))
          && /idle=none/i.test(String(playRejected?.message || ''))

        const isHlsTranscodeSession = !!currentTranscodeSessionId
          && (contentType === 'application/x-mpegURL' || contentType === 'application/vnd.apple.mpegurl')

        if (isCastTimeoutIdle && isHlsTranscodeSession) {
          const status = castTranscoder.getCastStatus(currentTranscodeSessionId)
          const stats = status?.requestStats || {}
          const segmentHits = Number(stats.successfulSegmentResponses || status?.fragmentCount || 0)
          const playlistHits = Number(stats.playlistRequests || (segmentHits > 0 ? 2 : 0))
          const hasReceiverConsumption = segmentHits >= 3 && playlistHits >= 2

          if (hasReceiverConsumption) {
            console.warn(
              '[CastDiag] IDLE timeout with sustained HLS fetches; waiting longer and nudging resume',
              'session=',
              currentTranscodeSessionId,
              'segmentHits=',
              segmentHits,
              'playlistHits=',
              playlistHits,
            )
            try {
              await new Promise(resolve => setTimeout(resolve, 6000))
              await castContext.resume()
            } catch {}
          } else {
            throw playRejected
          }
        } else {
          throw playRejected
        }
      }

      castLoadCompletedAt = Date.now()

      if (requestedStartTime > 0) {
        const initialSeekAttempts = 4
        const initialSeekDelayMs = 700
        let seekSucceeded = false
        for (let attempt = 1; attempt <= initialSeekAttempts; attempt += 1) {
          try {
            await castContext.seek(requestedStartTime)
            seekSucceeded = true
            break
          } catch (seekErr) {
            if (attempt === initialSeekAttempts) {
              console.warn('[CastDiag] Initial cast seek failed after', initialSeekAttempts, 'attempts:', seekErr?.message || seekErr)
              // Emit user-facing error so the UI can inform the user
              try {
                rpc?.eventCastPlaybackState?.({
                  state: 'error',
                  error: `Failed to seek to ${Math.floor(requestedStartTime)}s after ${initialSeekAttempts} attempts. Playback will start from the beginning.`,
                })
              } catch {}
              break
            }
            await new Promise(resolve => setTimeout(resolve, initialSeekDelayMs))
          }
        }
      }

      if (activeCastTranscodeId && (contentType === 'application/x-mpegURL' || contentType === 'application/vnd.apple.mpegurl')) {
        castSessionsWithLoadSent.add(activeCastTranscodeId)

        if (castStallMonitor) { clearInterval(castStallMonitor); castStallMonitor = null }
        let lastStallSegmentCount = 0
        let stallCheckCount = 0
        const monitorSessionId = activeCastTranscodeId
        castStallMonitor = setInterval(() => {
          try {
            const status = castTranscoder.getCastStatus(monitorSessionId)
            if (status && status.fragmentCount !== undefined) {
              if (status.fragmentCount > lastStallSegmentCount) {
                lastStallSegmentCount = status.fragmentCount
                stallCheckCount = 0
              } else {
                stallCheckCount++
                if (stallCheckCount >= 6) {
                  clearInterval(castStallMonitor)
                  castStallMonitor = null
                  rpc.eventLog?.({ message: '[Cast] Stall detected: no new fragments for 60s' })
                }
              }
            }
          } catch {}
        }, 10000)
      }

      lastCastPlayTime = Date.now()
      return { success: true }
    } catch (err) {
      console.error('[Backend] Cast play error:', err?.message || err)
      return { success: false, error: err?.message }
    } finally {
      castPlayInProgress = false
    }
  }

  // Return cleanup function
  return {
    closeCastProxyServer(reason = 'shutdown') {
      if (!castProxyServer) return
      try { castProxyServer.close() } catch {}
      castProxyServer = null
      castProxyPort = 0
      castProxyReady = null
      console.log('[Backend] Closed cast proxy server:', reason)
    },
    enterHeadlessMode,
  }
}
