/**
 * Mobile Transcoder Module
 *
 * Provides HLS segment-based transcoding for Chromecast compatibility.
 * Uses bare-ffmpeg with MPEGTS output, manually segmented for streaming.
 *
 * Key approach:
 * - Download input file to temp (with progress)
 * - Transcode to MPEGTS segments (streamable format)
 * - Write m3u8 playlist that updates as segments complete
 * - Chromecast starts playing as soon as first segments are ready
 */

import fs from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'
import http from 'bare-http1'

console.log('[Transcoder] Module loaded')

// HLS segment duration in seconds (low latency)
const HLS_SEGMENT_DURATION = 2
const HLS_MAX_SEGMENTS = 12

// Chromecast supported codecs
const CHROMECAST_VIDEO_CODECS = ['h264', 'avc1', 'vp8', 'vp9', 'av1']
const CHROMECAST_AUDIO_CODECS = ['aac', 'mp3', 'opus', 'flac', 'vorbis']
const CHROMECAST_CONTAINERS = ['mp4', 'mov', 'webm', 'mkv', 'matroska']

// bare-ffmpeg module (loaded dynamically)
let ffmpeg = null
let ffmpegLoadError = null
let ffmpegLoadPromise = null

/**
 * Load bare-ffmpeg module
 */
export async function loadBareFfmpeg() {
  console.log('[Transcoder] loadBareFfmpeg called, ffmpeg:', !!ffmpeg, 'error:', ffmpegLoadError)
  if (ffmpeg) return true
  if (ffmpegLoadError) return false
  if (ffmpegLoadPromise) return ffmpegLoadPromise

  ffmpegLoadPromise = (async () => {
    let lastError
    console.log('[Transcoder] Attempting to load bare-ffmpeg via require...')
    if (typeof require === 'function') {
      try {
        const mod = require('bare-ffmpeg')
        ffmpeg = mod?.default ?? mod
        console.log('[Transcoder] bare-ffmpeg loaded successfully')
        console.log('[Transcoder] ffmpeg exports:', Object.keys(ffmpeg || {}))
        return true
      } catch (err) {
        console.warn('[Transcoder] require failed:', err?.message)
        console.warn('[Transcoder] require stack:', err?.stack)
        lastError = err
      }
    } else {
      console.log('[Transcoder] require not available')
    }
    console.log('[Transcoder] Attempting to load bare-ffmpeg via dynamic import...')
    try {
      const mod = await import('bare-ffmpeg')
      ffmpeg = mod?.default ?? mod
      console.log('[Transcoder] bare-ffmpeg loaded via dynamic import')
      console.log('[Transcoder] ffmpeg exports:', Object.keys(ffmpeg || {}))
      return true
    } catch (err) {
      console.warn('[Transcoder] dynamic import failed:', err?.message)
      console.warn('[Transcoder] import stack:', err?.stack)
      lastError = err
    }
    ffmpegLoadError = lastError?.message || 'Failed to load bare-ffmpeg'
    console.warn('[Transcoder] bare-ffmpeg not available:', ffmpegLoadError)
    return false
  })()
  return ffmpegLoadPromise
}

/**
 * Check if bare-ffmpeg is available
 */
export function isAvailable() {
  return ffmpeg !== null
}

/**
 * Get load error if any
 */
export function getLoadError() {
  return ffmpegLoadError
}

function selectDecoderForId(codecId) {
  if (!ffmpeg) return null

  const hwDecoders = new Set([
    'h264_mediacodec',
    'hevc_mediacodec',
    'h264_videotoolbox',
    'hevc_videotoolbox'
  ])

  let candidates = []
  if (codecId === ffmpeg.constants.codecs.H264) {
    candidates = ['h264_mediacodec', 'h264_videotoolbox', 'h264']
  } else if (codecId === ffmpeg.constants.codecs.HEVC) {
    candidates = ['hevc_mediacodec', 'hevc_videotoolbox', 'hevc']
  }

  for (const name of candidates) {
    try {
      const decoder = ffmpeg.findDecoderByName?.(name)
      if (decoder && decoder._handle) {
        return { decoder, name, isHardware: hwDecoders.has(name) }
      }
    } catch {}
  }

  const codec = ffmpeg.Codec?.for?.(codecId)
  const decoder = codec?.decoder
  if (decoder && decoder._handle) {
    return { decoder, name: `codec:${codecId}`, isHardware: false }
  }
  return null
}

function selectH264Encoder() {
  if (!ffmpeg) return null

  const hwEncoders = new Set(['h264_mediacodec', 'h264_videotoolbox'])
  const candidates = [
    'h264_mediacodec',
    'h264_videotoolbox',
    'libx264',
    'h264'
  ]

  for (const name of candidates) {
    try {
      const encoder = ffmpeg.findEncoderByName?.(name)
      if (encoder && encoder._handle) {
        return {
          encoder,
          name,
          isHardware: hwEncoders.has(name),
          pixelFormat: hwEncoders.has(name)
            ? ffmpeg.constants.pixelFormats.NV12
            : ffmpeg.constants.pixelFormats.YUV420P
        }
      }
    } catch {}
  }
  const fallback = ffmpeg.Codec?.H264?.encoder
  if (fallback && fallback._handle) {
    return {
      encoder: fallback,
      name: 'codec:H264',
      isHardware: false,
      pixelFormat: ffmpeg.constants.pixelFormats.YUV420P
    }
  }
  return null
}

function selectAacEncoder() {
  if (!ffmpeg) return null
  const candidates = ['aac', 'libfdk_aac', 'libvo_aacenc']
  for (const name of candidates) {
    try {
      const encoder = ffmpeg.findEncoderByName?.(name)
      if (encoder && encoder._handle) {
        return { encoder, name }
      }
    } catch {}
  }
  const fallback = ffmpeg.Codec?.AAC?.encoder
  if (fallback && fallback._handle) return { encoder: fallback, name: 'codec:AAC' }
  return null
}

/**
 * Transcode session state
 */
const sessions = new Map()

/**
 * HTTP server for serving transcoded files
 */
let httpServer = null
let httpPort = 0
let httpReady = null

/**
 * Parse HTTP range header
 */
function parseRange(rangeHeader, fileSize) {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) return null
  const range = rangeHeader.slice(6)
  const [startStr, endStr] = range.split('-')
  const start = parseInt(startStr, 10) || 0
  const end = endStr ? parseInt(endStr, 10) : fileSize - 1
  if (start >= fileSize || end >= fileSize || start > end) return null
  return { start, end }
}

/**
 * Get file size safely
 */
function getFileSize(filePath) {
  try {
    const stat = fs.statSync(filePath)
    return stat.size
  } catch {
    return 0
  }
}

/**
 * Generate HLS m3u8 playlist for a session
 */
function generateM3u8Playlist(session) {
  const segments = session.segments || []
  const isComplete = session.status === 'complete'

  let playlist = '#EXTM3U\n'
  playlist += '#EXT-X-VERSION:3\n'
  playlist += `#EXT-X-TARGETDURATION:${HLS_SEGMENT_DURATION + 1}\n`
  playlist += '#EXT-X-MEDIA-SEQUENCE:0\n'

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    playlist += `#EXTINF:${seg.duration.toFixed(3)},\n`
    playlist += `segment${i}.ts\n`
  }

  if (isComplete) {
    playlist += '#EXT-X-ENDLIST\n'
  }

  return playlist
}

/**
 * Handle HTTP requests for HLS streams
 */
function handleHttpRequest(req, res) {
  const url = req.url || '/'

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Range')
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges')

  if ((req.method || '').toUpperCase() === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  // Parse URL: /transcode/{sessionId}/stream.m3u8 or /transcode/{sessionId}/segment{N}.ts
  const playlistMatch = url.match(/^\/transcode\/([^\/]+)\/stream\.m3u8/)
  const segmentMatch = url.match(/^\/transcode\/([^\/]+)\/segment(\d+)\.ts/)

  // Also support legacy single-file URL: /transcode/{sessionId}
  const legacyMatch = url.match(/^\/transcode\/([^\/]+)$/)

  let sessionId = null
  let requestType = null
  let segmentIndex = null

  if (playlistMatch) {
    sessionId = playlistMatch[1]
    requestType = 'playlist'
  } else if (segmentMatch) {
    sessionId = segmentMatch[1]
    requestType = 'segment'
    segmentIndex = parseInt(segmentMatch[2], 10)
  } else if (legacyMatch) {
    // Redirect legacy URL to HLS playlist
    sessionId = legacyMatch[1]
    res.statusCode = 302
    res.setHeader('Location', `/transcode/${sessionId}/stream.m3u8`)
    res.end()
    return
  } else {
    res.statusCode = 404
    res.end('Not found')
    return
  }

  const session = sessions.get(sessionId)
  if (!session) {
    res.statusCode = 404
    res.end('Session not found')
    return
  }

  if (requestType === 'playlist') {
    // Serve m3u8 playlist
    const playlist = generateM3u8Playlist(session)
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
    res.setHeader('Cache-Control', 'no-cache')
    res.end(playlist)
    return
  }

  if (requestType === 'segment') {
    const segments = session.segments || []
    if (segmentIndex >= segments.length) {
      res.statusCode = 404
      res.end('Segment not ready')
      return
    }

    const segment = segments[segmentIndex]
    const segmentPath = segment.path

    let stat
    try {
      stat = fs.statSync(segmentPath)
    } catch {
      res.statusCode = 404
      res.end('Segment file not found')
      return
    }

    const range = parseRange(req.headers?.range, stat.size)

    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', 'video/mp2t')

    if (range) {
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`)
      res.setHeader('Content-Length', range.end - range.start + 1)
      const stream = fs.createReadStream(segmentPath, { start: range.start, end: range.end })
      stream.pipe(res)
    } else {
      res.statusCode = 200
      res.setHeader('Content-Length', stat.size)
      const stream = fs.createReadStream(segmentPath)
      stream.pipe(res)
    }
  }
}

/**
 * Ensure HTTP server is running
 */
async function ensureHttpServer() {
  if (httpPort) return httpPort
  if (httpReady) return httpReady

  httpReady = new Promise((resolve, reject) => {
    httpServer = http.createServer(handleHttpRequest)
    // Listen on 0.0.0.0 so Chromecast (external device) can connect
    httpServer.listen(0, '0.0.0.0', () => {
      const addr = httpServer.address()
      httpPort = addr.port
      console.log('[Transcoder] HTTP server listening on port', httpPort)
      resolve(httpPort)
    })
    httpServer.on('error', (err) => {
      console.error('[Transcoder] HTTP server error:', err)
      reject(err)
    })
  })
  return httpReady
}

/**
 * Get content length from HTTP
 * Uses GET with Range: bytes=0-0 to get Content-Range header which contains total size
 * Falls back to HEAD request if Range not supported
 */
async function getHttpContentLength(url) {
  return new Promise((resolve, reject) => {
    let parsedUrl
    try {
      parsedUrl = new URL(url)
    } catch (e) {
      reject(new Error(`Invalid URL: ${url}`))
      return
    }

    // First try GET with Range header - more reliable than HEAD
    const options = {
      method: 'GET',
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 80,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'Range': 'bytes=0-0'
      }
    }

    console.log('[Transcoder] Getting content length via Range request...')

    const req = http.request(options, (res) => {
      // Check Content-Range header for total size (e.g., "bytes 0-0/1234567")
      const contentRange = res.headers['content-range']
      let resolved = false

      if (contentRange) {
        const match = contentRange.match(/\/(\d+)$/)
        if (match) {
          const size = parseInt(match[1], 10)
          console.log('[Transcoder] Got content length from Content-Range:', size)
          resolved = true
          // Consume the response body before resolving (important to free the connection)
          res.on('data', () => {})
          res.on('end', () => resolve(size))
          res.on('error', () => resolve(size))
          return
        }
      }

      // Fall back to Content-Length header
      const contentLength = parseInt(res.headers['content-length'], 10) || 0
      if (contentLength > 0 && !resolved) {
        console.log('[Transcoder] Got content length from Content-Length:', contentLength)
        res.on('data', () => {})
        res.on('end', () => resolve(contentLength))
        res.on('error', () => resolve(contentLength))
        return
      }

      // Consume body then try HEAD request as last resort
      res.on('data', () => {})
      res.on('end', () => {
        console.log('[Transcoder] Range request failed, trying HEAD...')
        const headOptions = {
          method: 'HEAD',
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || 80,
          path: parsedUrl.pathname + parsedUrl.search,
        }

        const headReq = http.request(headOptions, (headRes) => {
          const headLength = parseInt(headRes.headers['content-length'], 10) || 0
          console.log('[Transcoder] Got content length from HEAD:', headLength)
          resolve(headLength)
        })
        headReq.on('error', () => resolve(0))
        headReq.end()
      })
    })

    req.on('error', (err) => {
      console.error('[Transcoder] Content length request failed:', err.message)
      reject(err)
    })
    req.end()
  })
}

/**
 * HTTP range request - reads a chunk from HTTP URL
 */
function httpRangeReadSync(url, start, length) {
  return new Promise((resolve, reject) => {
    let parsedUrl
    try {
      parsedUrl = new URL(url)
    } catch (e) {
      reject(new Error(`Invalid URL: ${url}`))
      return
    }

    const end = start + length - 1
    const options = {
      method: 'GET',
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 80,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'Range': `bytes=${start}-${end}`
      }
    }

    console.log('[Transcoder] HTTP range request:', start, '-', end, '(' + Math.round(length / 1024 / 1024) + 'MB)')

    const chunks = []
    let bytesReceived = 0
    let lastLog = 0

    const req = http.request(options, (res) => {
      console.log('[Transcoder] HTTP range response status:', res.statusCode)

      if (res.statusCode !== 200 && res.statusCode !== 206) {
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }

      res.on('data', (chunk) => {
        chunks.push(chunk)
        bytesReceived += chunk.length

        // Log progress every 5MB
        if (bytesReceived - lastLog > 5 * 1024 * 1024) {
          lastLog = bytesReceived
          console.log('[Transcoder] HTTP range progress:', Math.round(bytesReceived / 1024 / 1024) + 'MB /' + Math.round(length / 1024 / 1024) + 'MB')
        }
      })

      res.on('end', () => {
        const result = Buffer.concat(chunks)
        console.log('[Transcoder] HTTP range complete:', result.length, 'bytes')
        resolve(result)
      })

      res.on('error', (err) => {
        console.error('[Transcoder] HTTP range response error:', err.message)
        reject(err)
      })
    })

    req.on('error', (err) => {
      console.error('[Transcoder] HTTP range request error:', err.message)
      reject(err)
    })

    // Timeout after 60 seconds
    req.setTimeout(60000, () => {
      console.error('[Transcoder] HTTP range request timeout')
      req.destroy()
      reject(new Error('HTTP request timeout'))
    })

    req.end()
  })
}

/**
 * Create a streaming HTTP IOContext for bare-ffmpeg
 * Reads directly from HTTP URL using range requests - no temp file needed
 *
 * IMPORTANT: This pre-buffers data before returning the IOContext.
 * Call prepareHttpStreamingIOContext() to create and wait for initial buffer.
 */
async function prepareHttpStreamingIOContext(url, fileSize) {
  let currentPos = 0

  // Read-ahead buffer - must be large enough for FFmpeg header parsing
  const BUFFER_SIZE = 8 * 1024 * 1024 // 8MB buffer (reduced for faster initial load)
  let buffers = [] // Array of { start, end, data } chunks
  let pendingFetch = null

  // Fetch a chunk and add to buffers
  async function fetchChunk(position, size) {
    const readSize = Math.min(size || BUFFER_SIZE, fileSize - position)
    if (readSize <= 0) return null

    try {
      console.log('[Transcoder] HTTP fetch:', position, 'size:', readSize)
      const data = await httpRangeReadSync(url, position, readSize)
      const chunk = { start: position, end: position + data.length, data }

      // Add to buffers, keeping sorted by start position
      buffers.push(chunk)
      buffers.sort((a, b) => a.start - b.start)

      // Limit buffer count to prevent memory bloat (keep last 4 chunks = 128MB max)
      while (buffers.length > 4) {
        buffers.shift()
      }

      console.log('[Transcoder] HTTP fetched:', position, '-', chunk.end, '/', fileSize, 'buffers:', buffers.length)
      return chunk
    } catch (err) {
      console.error('[Transcoder] HTTP fetch error:', err.message)
      return null
    }
  }

  // Find data in buffers for position
  function findInBuffer(position, length) {
    for (const chunk of buffers) {
      if (position >= chunk.start && position < chunk.end) {
        const offset = position - chunk.start
        const available = chunk.end - position
        const toRead = Math.min(length, available)
        return { data: chunk.data, offset, length: toRead }
      }
    }
    return null
  }

  // Pre-fetch initial data (header area) - BLOCKING
  console.log('[Transcoder] Pre-fetching initial buffer...')
  await fetchChunk(0, BUFFER_SIZE)

  // Also fetch end of file for MOV/MP4 moov atom detection
  if (fileSize > BUFFER_SIZE * 2) {
    const endPos = Math.max(0, fileSize - BUFFER_SIZE)
    console.log('[Transcoder] Pre-fetching end of file for index...')
    await fetchChunk(endPos, BUFFER_SIZE)
  }

  const ioContext = new ffmpeg.IOContext(65536, {
    onread: (outputBuffer) => {
      if (currentPos >= fileSize) {
        return 0 // EOF
      }

      // Try to find data in buffer
      const found = findInBuffer(currentPos, outputBuffer.length)
      if (found) {
        found.data.copy(outputBuffer, 0, found.offset, found.offset + found.length)
        currentPos += found.length

        // Trigger background prefetch if we're near buffer end
        const highestBufferEnd = buffers.length > 0 ? Math.max(...buffers.map(b => b.end)) : 0
        if (currentPos > highestBufferEnd - BUFFER_SIZE / 2 && highestBufferEnd < fileSize && !pendingFetch) {
          pendingFetch = fetchChunk(highestBufferEnd, BUFFER_SIZE).finally(() => { pendingFetch = null })
        }

        return found.length
      }

      // Buffer miss - this is bad, FFmpeg needs data NOW
      // Try to fetch synchronously by waiting (busy loop with yield)
      console.log('[Transcoder] Buffer miss at:', currentPos, '- fetching synchronously')

      // We can't truly block in JS, so return what we can
      // Return 0 bytes read - FFmpeg will likely fail or retry
      return 0
    },

    onseek: (offset, whence) => {
      const SEEK_SET = 0
      const SEEK_CUR = 1
      const SEEK_END = 2
      const AVSEEK_SIZE = 0x10000

      if (whence === AVSEEK_SIZE) {
        return fileSize
      }

      let newPos = currentPos
      if (whence === SEEK_SET) {
        newPos = offset
      } else if (whence === SEEK_CUR) {
        newPos += offset
      } else if (whence === SEEK_END) {
        newPos = fileSize + offset
      }

      newPos = Math.max(0, Math.min(newPos, fileSize))

      // Check if new position is in buffer
      const found = findInBuffer(newPos, 1)
      if (!found && !pendingFetch) {
        console.log('[Transcoder] Seek to unbuffered position:', newPos)
        // Trigger fetch for new position
        pendingFetch = fetchChunk(newPos, BUFFER_SIZE).finally(() => { pendingFetch = null })
      }

      currentPos = newPos
      return currentPos
    }
  })

  ioContext._cleanup = () => {
    buffers = []
  }

  return ioContext
}

/**
 * Download HTTP data to temp file with simultaneous read support
 * Returns { path, size, getBytesWritten } where getBytesWritten() returns current progress
 *
 * Key features:
 * - Writes directly to disk, no memory accumulation
 * - fsync every 100MB to ensure data is flushed
 * - Returns immediately after headers, download continues in background
 * - getBytesWritten() allows checking download progress for read-while-write
 */
function startBackgroundDownload(url, onProgress, onComplete, onError) {
  let parsedUrl
  try {
    parsedUrl = new URL(url)
  } catch (e) {
    onError(new Error(`Invalid URL: ${url}`))
    return null
  }

  const tmpPath = path.join(os.tmpdir(), `transcode_input_${Date.now()}.tmp`)
  let fd = null
  let bytesWritten = 0
  let contentLength = 0
  let lastProgressLog = 0
  let lastFsync = 0
  let complete = false
  let error = null

  try {
    fd = fs.openSync(tmpPath, 'w')
  } catch (e) {
    onError(e)
    return null
  }

  console.log('[Transcoder] Starting background download to:', tmpPath)

  const options = {
    method: 'GET',
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || 80,
    path: parsedUrl.pathname + parsedUrl.search,
  }

  const req = http.request(options, (res) => {
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      try { fs.closeSync(fd) } catch {}
      try { fs.unlinkSync(tmpPath) } catch {}
      onError(new Error(`HTTP ${res.statusCode}`))
      return
    }

    contentLength = parseInt(res.headers['content-length'], 10) || 0
    console.log('[Transcoder] Download Content-Length:', contentLength)

    res.on('data', (chunk) => {
      try {
        // Write directly to file
        fs.writeSync(fd, chunk, 0, chunk.length)
        bytesWritten += chunk.length

        // Fsync every 100MB to ensure data is on disk
        if (bytesWritten - lastFsync > 100 * 1024 * 1024) {
          lastFsync = bytesWritten
          try { fs.fsyncSync(fd) } catch {}
        }

        // Log progress every 50MB
        if (bytesWritten - lastProgressLog > 50 * 1024 * 1024) {
          lastProgressLog = bytesWritten
          const pct = contentLength > 0 ? Math.round(bytesWritten / contentLength * 100) : 0
          console.log('[Transcoder] Download progress:', pct + '%', '(' + Math.round(bytesWritten / 1024 / 1024) + 'MB)')
          if (onProgress) onProgress(pct)
        }
      } catch (e) {
        console.error('[Transcoder] Write error:', e.message)
        error = e
        res.destroy()
      }
    })

    res.on('end', () => {
      try { fs.fsyncSync(fd) } catch {}
      try { fs.closeSync(fd) } catch {}
      complete = true
      console.log('[Transcoder] Download complete:', bytesWritten, 'bytes')
      onComplete(bytesWritten)
    })

    res.on('error', (err) => {
      try { fs.closeSync(fd) } catch {}
      error = err
      console.error('[Transcoder] Download error:', err.message)
      onError(err)
    })
  })

  req.on('error', (err) => {
    try { fs.closeSync(fd) } catch {}
    error = err
    console.error('[Transcoder] Request error:', err.message)
    onError(err)
  })

  req.end()

  return {
    path: tmpPath,
    contentLength: () => contentLength,
    getBytesWritten: () => bytesWritten,
    isComplete: () => complete,
    getError: () => error,
    cleanup: () => {
      try { fs.unlinkSync(tmpPath) } catch {}
    }
  }
}

/**
 * Create IOContext that reads from a file that's still being written
 * Waits for data if read position exceeds written bytes
 *
 * @param {string} filePath - Path to the file being written
 * @param {number} totalSize - Total expected file size (for AVSEEK_SIZE)
 * @param {function} getBytesWritten - Returns current bytes written
 * @param {function} isComplete - Returns true when download is complete
 */
function createGrowingFileIOContext(filePath, totalSize, getBytesWritten, isComplete) {
  const fd = fs.openSync(filePath, 'r')
  let currentPos = 0
  let waitCount = 0
  let lastWaitLog = 0

  const ioContext = new ffmpeg.IOContext(65536, {
    onread: (buffer) => {
      const available = getBytesWritten()

      // If we've caught up to the download, wait for more data
      while (currentPos >= available && !isComplete()) {
        waitCount++
        const now = Date.now()
        if (now - lastWaitLog > 1000) {
          lastWaitLog = now
          console.log('[Transcoder] Waiting for download... pos:', Math.round(currentPos / 1024 / 1024) + 'MB, available:', Math.round(available / 1024 / 1024) + 'MB')
        }
        // Busy wait - not ideal but FFmpeg needs sync read
        const start = Date.now()
        while (Date.now() - start < 10) {
          // Spin
        }
      }

      const nowAvailable = getBytesWritten()
      if (currentPos >= nowAvailable && isComplete()) {
        return 0 // True EOF - download complete and we've read all data
      }

      const bytesToRead = Math.min(buffer.length, nowAvailable - currentPos)
      if (bytesToRead <= 0) {
        return 0
      }

      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, currentPos)
      currentPos += bytesRead
      return bytesRead
    },

    onseek: (offset, whence) => {
      const SEEK_SET = 0
      const SEEK_CUR = 1
      const SEEK_END = 2
      const AVSEEK_SIZE = 0x10000

      if (whence === AVSEEK_SIZE) {
        // Return TOTAL expected file size, not just bytes written
        // This is critical for FFmpeg to parse MKV Cues properly
        return totalSize
      }

      if (whence === SEEK_SET) {
        currentPos = offset
      } else if (whence === SEEK_CUR) {
        currentPos += offset
      } else if (whence === SEEK_END) {
        // SEEK_END uses total size, not current bytes written
        currentPos = totalSize + offset
      }

      currentPos = Math.max(0, currentPos)
      console.log('[Transcoder] Seek to:', Math.round(currentPos / 1024 / 1024) + 'MB')
      return currentPos
    }
  })

  ioContext._fd = fd
  ioContext._cleanup = () => {
    try { fs.closeSync(fd) } catch {}
  }

  return ioContext
}

/**
 * Wait for minimum download before starting transcode
 * MKV files have index at end, so we need end portion available
 */
async function waitForMinimumDownload(download, minBytes, timeoutMs = 60000) {
  const startTime = Date.now()

  while (download.getBytesWritten() < minBytes) {
    if (download.getError()) {
      throw download.getError()
    }
    if (Date.now() - startTime > timeoutMs) {
      throw new Error('Download timeout waiting for minimum data')
    }
    // Wait 100ms
    await new Promise(r => setTimeout(r, 100))
  }

  console.log('[Transcoder] Minimum download reached:', download.getBytesWritten(), 'bytes')
}

/**
 * Create a streaming IOContext that reads from a file via fs.readSync
 * This avoids loading the entire file into memory
 */
function createFileReadIOContext(filePath, fileSize) {
  const fd = fs.openSync(filePath, 'r')
  let currentPos = 0

  const ioContext = new ffmpeg.IOContext(16384, {
    onread: (buffer) => {
      if (currentPos >= fileSize) {
        return 0 // EOF
      }
      const bytesToRead = Math.min(buffer.length, fileSize - currentPos)
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, currentPos)
      currentPos += bytesRead
      return bytesRead
    },

    onseek: (offset, whence) => {
      const SEEK_SET = 0
      const SEEK_CUR = 1
      const SEEK_END = 2
      const AVSEEK_SIZE = 0x10000

      if (whence === AVSEEK_SIZE) {
        return fileSize
      }

      if (whence === SEEK_SET) {
        currentPos = offset
      } else if (whence === SEEK_CUR) {
        currentPos += offset
      } else if (whence === SEEK_END) {
        currentPos = fileSize + offset
      }

      currentPos = Math.max(0, Math.min(currentPos, fileSize))
      return currentPos
    }
  })

  // Store fd for cleanup
  ioContext._fd = fd
  ioContext._cleanup = () => {
    try { fs.closeSync(fd) } catch {}
  }

  return ioContext
}

/**
 * Create a streaming output IOContext that writes directly to a file
 * This avoids buffering the entire output in memory
 */
function createFileWriteIOContext(filePath) {
  const fd = fs.openSync(filePath, 'w')
  let currentPos = 0

  const ioContext = new ffmpeg.IOContext(1024 * 1024, {
    onwrite: (buffer) => {
      const written = fs.writeSync(fd, buffer, 0, buffer.length, currentPos)
      currentPos += written
      return written
    },

    onseek: (offset, whence) => {
      const SEEK_SET = 0
      const SEEK_CUR = 1
      const SEEK_END = 2
      const AVSEEK_SIZE = 0x10000

      if (whence === AVSEEK_SIZE) {
        return currentPos
      }

      if (whence === SEEK_SET) {
        currentPos = offset
      } else if (whence === SEEK_CUR) {
        currentPos += offset
      } else if (whence === SEEK_END) {
        // For output, SEEK_END is relative to current position
        currentPos = currentPos + offset
      }

      currentPos = Math.max(0, currentPos)
      return currentPos
    }
  })

  ioContext._fd = fd
  ioContext._cleanup = () => {
    try { fs.closeSync(fd) } catch {}
  }

  return ioContext
}

/**
 * Probe media file to check if transcoding is needed
 *
 * CRITICAL: bare-ffmpeg native library crashes on Android with SIGSEGV
 * when parsing video buffers. We skip native probing entirely and use
 * URL + title-based detection which is fast and reliable.
 *
 * @param {string} url - Video URL (may be blob URL without file extension)
 * @param {string} title - Video title (often contains codec info like "H.265", "DDP.5.1")
 */
export async function probeMedia(url, title = '') {
  const result = {
    videoCodec: null,
    audioCodec: null,
    container: null,
    duration: 0,
    needsTranscode: false,
    needsVideoTranscode: false,
    needsAudioTranscode: false,
    needsRemux: false,
    reason: '',
  }

  // Use URL + title-based detection - bare-ffmpeg crashes on Android
  console.log('[Transcoder] Using URL+title detection, title:', title?.substring(0, 50) || 'none')
  checkTranscodeNeeded(result, url, title)
  return result
}

/**
 * Map FFmpeg codec ID to name
 */
function mapCodecIdToName(codecId, type) {
  if (!codecId) return null

  // Common video codecs
  const videoCodecs = {
    [ffmpeg.constants?.codecs?.H264]: 'h264',
    [ffmpeg.constants?.codecs?.HEVC]: 'hevc',
    [ffmpeg.constants?.codecs?.VP8]: 'vp8',
    [ffmpeg.constants?.codecs?.VP9]: 'vp9',
    [ffmpeg.constants?.codecs?.AV1]: 'av1',
  }

  // Common audio codecs
  const audioCodecs = {
    [ffmpeg.constants?.codecs?.AAC]: 'aac',
    [ffmpeg.constants?.codecs?.MP3]: 'mp3',
    [ffmpeg.constants?.codecs?.AC3]: 'ac3',
    [ffmpeg.constants?.codecs?.EAC3]: 'eac3',
    [ffmpeg.constants?.codecs?.DTS]: 'dts',
    [ffmpeg.constants?.codecs?.OPUS]: 'opus',
    [ffmpeg.constants?.codecs?.FLAC]: 'flac',
    [ffmpeg.constants?.codecs?.VORBIS]: 'vorbis',
  }

  const map = type === 'video' ? videoCodecs : audioCodecs
  return map[codecId] || `codec-${codecId}`
}

/**
 * Check if transcoding is needed for Chromecast
 *
 * Detection strategy (in order of reliability):
 * 1. MIME type from blob URL's `type` parameter (reliable for container)
 * 2. Video title patterns (often contains codec info like "H.265", "DDP.5.1")
 * 3. URL path patterns (file extensions like .mkv)
 *
 * @param {object} result - Probe result object to populate
 * @param {string} url - Video URL (may be blob URL with type param)
 * @param {string} title - Video title (often contains codec info)
 */
function checkTranscodeNeeded(result, url, title = '') {
  const reasons = []

  // Check video codec
  if (result.videoCodec) {
    const videoSupported = CHROMECAST_VIDEO_CODECS.includes(result.videoCodec)
    if (!videoSupported) {
      result.needsVideoTranscode = true
      reasons.push(`Video codec ${result.videoCodec} not supported`)
    }
  }

  // Check audio codec
  if (result.audioCodec) {
    const audioSupported = CHROMECAST_AUDIO_CODECS.includes(result.audioCodec)
    if (!audioSupported) {
      result.needsAudioTranscode = true
      reasons.push(`Audio codec ${result.audioCodec} not supported`)
    }
  }

  // Check container - MKV needs remux even if codecs are compatible
  if (result.container) {
    const containerNeedsRemux = result.container.includes('matroska') ||
                                 result.container.includes('mkv') ||
                                 result.container.includes('avi') ||
                                 result.container.includes('flv')

    if (containerNeedsRemux && !result.needsVideoTranscode) {
      result.needsRemux = true
      reasons.push(`Container ${result.container} needs remux to MP4`)
    }
  }

  // Fallback detection from URL + title when no codec info available
  if (!result.videoCodec && !result.audioCodec) {
    const urlLower = url.toLowerCase()
    const titleLower = (title || '').toLowerCase()

    // Parse MIME type from blob URL's `type` query parameter
    // e.g., http://127.0.0.1:PORT/?key=...&type=video%2Fx-matroska
    let mimeType = ''
    try {
      const urlObj = new URL(url)
      mimeType = (urlObj.searchParams.get('type') || '').toLowerCase()
    } catch {}

    console.log('[Transcoder] Detection - URL:', urlLower.substring(0, 60), 'MIME:', mimeType, 'Title:', titleLower.substring(0, 50))

    // Container detection from MIME type (most reliable for blob URLs)
    if (mimeType.includes('matroska') || mimeType.includes('x-mkv')) {
      result.needsRemux = true
      result.container = 'matroska'
      reasons.push('MKV container detected from MIME type')
    } else if (mimeType.includes('avi') || mimeType.includes('x-msvideo')) {
      result.needsRemux = true
      result.container = 'avi'
      reasons.push('AVI container detected from MIME type')
    }

    // Video codec detection from title
    // Patterns: H.265, H265, HEVC, x265
    if (titleLower.includes('hevc') || titleLower.includes('h265') ||
        titleLower.includes('h.265') || titleLower.includes('x265')) {
      result.needsVideoTranscode = true
      reasons.push('HEVC/H.265 video detected from title')
    }

    // Audio codec detection from title
    // DDP = Dolby Digital Plus (E-AC3), DD = Dolby Digital (AC3), DTS, TrueHD
    if (titleLower.includes('ddp') || titleLower.includes('dd+') ||
        titleLower.includes('e-ac3') || titleLower.includes('eac3')) {
      result.needsAudioTranscode = true
      reasons.push('Dolby Digital Plus (E-AC3) audio detected from title')
    } else if (titleLower.match(/\bdd\b/) || titleLower.includes('ac3') || titleLower.includes('ac-3')) {
      result.needsAudioTranscode = true
      reasons.push('Dolby Digital (AC3) audio detected from title')
    } else if (titleLower.includes('dts')) {
      result.needsAudioTranscode = true
      reasons.push('DTS audio detected from title')
    } else if (titleLower.includes('truehd')) {
      result.needsAudioTranscode = true
      reasons.push('TrueHD audio detected from title')
    }

    // Fallback: URL path patterns (for direct file URLs)
    if (!result.needsRemux && urlLower.includes('.mkv')) {
      result.needsRemux = true
      reasons.push('MKV container detected from URL')
    }
    if (!result.needsVideoTranscode && (urlLower.includes('hevc') || urlLower.includes('h265') || urlLower.includes('x265'))) {
      result.needsVideoTranscode = true
      reasons.push('HEVC detected from URL')
    }
    if (!result.needsAudioTranscode && (urlLower.includes('dts') || urlLower.includes('ac3') || urlLower.includes('truehd'))) {
      result.needsAudioTranscode = true
      reasons.push('Incompatible audio detected from URL')
    }
  }

  result.needsTranscode = result.needsVideoTranscode || result.needsAudioTranscode
  result.reason = reasons.join('; ') || 'Compatible'
}

/**
 * Create input IOContext based on source type
 * @param {object} inputSource - { type: 'file' | 'http' | 'growing', path?, url?, size, getBytesWritten?, isComplete? }
 */
async function createInputIOContext(inputSource) {
  if (inputSource.type === 'http') {
    return await prepareHttpStreamingIOContext(inputSource.url, inputSource.size)
  } else if (inputSource.type === 'growing') {
    return createGrowingFileIOContext(inputSource.path, inputSource.size, inputSource.getBytesWritten, inputSource.isComplete)
  } else {
    return createFileReadIOContext(inputSource.path, inputSource.size)
  }
}

/**
 * Remux using bare-ffmpeg (fast, no re-encoding)
 * Uses streaming I/O to avoid OOM on large files
 *
 * For HTTP sources, uses single-pass processing with byte-based progress.
 * For file sources, uses two-pass for accurate packet-based progress.
 */
async function remuxWithBareFFmpeg(session, inputSource, onProgress) {
  const inputSize = inputSource.size
  console.log('[Transcoder] Remuxing with bare-ffmpeg (stream copy), input size:', inputSize)

  // Declare ALL native objects at top for proper cleanup
  let inputIO = null
  let inputFormat = null
  let outputIO = null
  let outputFormat = null
  let packet = null

  try {
    // Create input IOContext based on source type
    console.log('[Transcoder] Creating input IOContext for', inputSource.type, '...')
    inputIO = await createInputIOContext(inputSource)
    console.log('[Transcoder] IOContext created, creating InputFormatContext...')
    inputFormat = new ffmpeg.InputFormatContext(inputIO)
    console.log('[Transcoder] InputFormatContext created, getting streams...')

    const videoStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.VIDEO)
    console.log('[Transcoder] Video stream:', videoStream ? 'found' : 'not found')
    const audioStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.AUDIO)
    console.log('[Transcoder] Audio stream:', audioStream ? 'found' : 'not found')

    if (!videoStream) {
      throw new Error('No video stream found')
    }

    // Use streaming output IOContext that writes directly to file
    outputIO = createFileWriteIOContext(session.outputPath)
    outputFormat = new ffmpeg.OutputFormatContext('mp4', outputIO)

    // Copy video stream
    const outVideoStream = outputFormat.createStream()
    outVideoStream.codecParameters.copyFrom(videoStream.codecParameters)
    outVideoStream.timeBase = videoStream.timeBase

    // Copy audio stream if present
    let outAudioStream = null
    if (audioStream) {
      outAudioStream = outputFormat.createStream()
      outAudioStream.codecParameters.copyFrom(audioStream.codecParameters)
      outAudioStream.timeBase = audioStream.timeBase
    }

    outputFormat.writeHeader()

    packet = new ffmpeg.Packet()
    let packetCount = 0
    let bytesProcessed = 0
    let lastProgressPercent = 0

    // Single-pass processing with byte-based progress
    while (inputFormat.readFrame(packet)) {
      packetCount++
      bytesProcessed += packet.size || 0

      if (packet.streamIndex === videoStream.index) {
        packet.streamIndex = outVideoStream.index
        outputFormat.writeFrame(packet)
      } else if (audioStream && outAudioStream && packet.streamIndex === audioStream.index) {
        packet.streamIndex = outAudioStream.index
        outputFormat.writeFrame(packet)
      }

      packet.unref()

      // Report progress based on bytes processed
      if (inputSize > 0 && packetCount % 500 === 0) {
        const percent = Math.min(99, Math.round((bytesProcessed / inputSize) * 100))
        if (percent > lastProgressPercent) {
          lastProgressPercent = percent
          session.progress = percent
          if (onProgress) onProgress(percent)
          console.log('[Transcoder] Remux progress:', percent + '%', '(' + Math.round(bytesProcessed / 1024 / 1024) + 'MB)')
        }
      }
    }

    outputFormat.writeTrailer()
    console.log('[Transcoder] Remux complete, output written to:', session.outputPath)

  } finally {
    // Destroy ALL native objects in reverse order
    if (packet) packet.destroy()
    if (outputFormat) outputFormat.destroy()
    if (outputIO) {
      if (outputIO._cleanup) outputIO._cleanup()
      outputIO.destroy()
    }
    if (inputFormat) inputFormat.destroy()
    if (inputIO) {
      if (inputIO._cleanup) inputIO._cleanup()
      inputIO.destroy()
    }
  }
}

/**
 * Transcode audio (video copy, audio to AAC)
 * Uses streaming I/O to avoid OOM on large files
 */
async function transcodeAudioWithBareFFmpeg(session, inputSource, onProgress) {
  const inputSize = inputSource.size
  console.log('[Transcoder] Transcoding audio (video copy, audio to AAC), input size:', inputSize)

  // Declare ALL native objects at top for proper cleanup
  let inputIO = null
  let inputFormat = null
  let outputIO = null
  let outputFormat = null
  let audioDecoder = null
  let audioEncoder = null
  let resampler = null
  let packet = null
  let frame = null
  let resampledFrame = null
  let outputPacket = null

  try {
    // Create input IOContext based on source type
    console.log('[Transcoder] Creating input IOContext for', inputSource.type, '...')
    inputIO = await createInputIOContext(inputSource)
    inputFormat = new ffmpeg.InputFormatContext(inputIO)

    const videoStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.VIDEO)
    const audioStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.AUDIO)

    if (!videoStream) {
      throw new Error('No video stream found')
    }

    // Use streaming output IOContext that writes directly to file
    outputIO = createFileWriteIOContext(session.outputPath)
    outputFormat = new ffmpeg.OutputFormatContext('mp4', outputIO)

    // Copy video stream
    const outVideoStream = outputFormat.createStream()
    outVideoStream.codecParameters.copyFrom(videoStream.codecParameters)
    outVideoStream.timeBase = videoStream.timeBase

    // Set up audio transcoding to AAC
    let outAudioStream = null

    if (audioStream) {
      outAudioStream = outputFormat.createStream()
      outAudioStream.codecParameters.type = ffmpeg.constants.mediaTypes.AUDIO
      outAudioStream.codecParameters.id = ffmpeg.constants.codecs.AAC
      outAudioStream.codecParameters.sampleRate = audioStream.codecParameters.sampleRate || 48000
      outAudioStream.codecParameters.channelLayout = ffmpeg.constants.channelLayouts.STEREO
      outAudioStream.codecParameters.format = ffmpeg.constants.sampleFormats.FLTP
      outAudioStream.timeBase = { numerator: 1, denominator: outAudioStream.codecParameters.sampleRate }

      // Audio decoder - use stream's decoder() helper which copies codec parameters
      try {
        audioDecoder = audioStream.decoder()
        console.log('[Transcoder] Audio decoder created via stream.decoder()')
      } catch (e) {
        console.log('[Transcoder] stream.decoder() failed, creating manually:', e?.message)
        const decoderCodec = selectDecoderForId(audioStream.codecParameters.id)
        if (!decoderCodec) {
          throw new Error('Audio decoder not available')
        }
        audioDecoder = new ffmpeg.CodecContext(decoderCodec)
        audioStream.codecParameters.toContext(audioDecoder)
      }
      audioDecoder.timeBase = audioStream.timeBase
      audioDecoder.open()

      // Encoder
      const aacSelection = selectAacEncoder()
      if (!aacSelection) {
        throw new Error('AAC encoder not available')
      }
      console.log('[Transcoder] Using AAC encoder:', aacSelection.name)
      audioEncoder = new ffmpeg.CodecContext(aacSelection.encoder)
      audioEncoder.sampleRate = outAudioStream.codecParameters.sampleRate
      audioEncoder.channelLayout = ffmpeg.constants.channelLayouts.STEREO
      audioEncoder.sampleFormat = ffmpeg.constants.sampleFormats.FLTP
      audioEncoder.timeBase = outAudioStream.timeBase
      audioEncoder.open()

      // Resampler
      resampler = new ffmpeg.Resampler(
        audioDecoder.sampleRate,
        audioDecoder.channelLayout,
        audioDecoder.sampleFormat,
        audioEncoder.sampleRate,
        audioEncoder.channelLayout,
        audioEncoder.sampleFormat
      )
    }

    outputFormat.writeHeader()

    packet = new ffmpeg.Packet()
    frame = new ffmpeg.Frame()
    resampledFrame = new ffmpeg.Frame()
    outputPacket = new ffmpeg.Packet()

    if (outAudioStream) {
      resampledFrame.format = ffmpeg.constants.sampleFormats.FLTP
      resampledFrame.channelLayout = ffmpeg.constants.channelLayouts.STEREO
      resampledFrame.sampleRate = audioEncoder.sampleRate
      resampledFrame.nbSamples = 1024
      resampledFrame.alloc()
    }

    let packetCount = 0
    let bytesProcessed = 0
    let lastProgressPercent = 0

    // Single-pass processing with byte-based progress
    while (inputFormat.readFrame(packet)) {
      packetCount++
      bytesProcessed += packet.size || 0

      if (packet.streamIndex === videoStream.index) {
        packet.streamIndex = outVideoStream.index
        outputFormat.writeFrame(packet)
      } else if (audioStream && outAudioStream && packet.streamIndex === audioStream.index) {
        packet.timeBase = audioStream.timeBase

        if (audioDecoder.sendPacket(packet)) {
          while (audioDecoder.receiveFrame(frame)) {
            const samplesConverted = resampler.convert(frame, resampledFrame)
            resampledFrame.nbSamples = samplesConverted
            resampledFrame.pts = frame.pts
            resampledFrame.timeBase = frame.timeBase

            if (audioEncoder.sendFrame(resampledFrame)) {
              while (audioEncoder.receivePacket(outputPacket)) {
                outputPacket.streamIndex = outAudioStream.index
                outputFormat.writeFrame(outputPacket)
                outputPacket.unref()
              }
            }
          }
        }
      }

      packet.unref()

      // Report progress based on bytes processed
      if (inputSize > 0 && packetCount % 500 === 0) {
        const percent = Math.min(99, Math.round((bytesProcessed / inputSize) * 100))
        if (percent > lastProgressPercent) {
          lastProgressPercent = percent
          session.progress = percent
          if (onProgress) onProgress(percent)
          console.log('[Transcoder] Audio transcode progress:', percent + '%')
        }
      }
    }

    // Flush audio encoder
    if (audioEncoder) {
      audioEncoder.sendFrame(null)
      while (audioEncoder.receivePacket(outputPacket)) {
        outputPacket.streamIndex = outAudioStream.index
        outputFormat.writeFrame(outputPacket)
        outputPacket.unref()
      }
    }

    outputFormat.writeTrailer()
    console.log('[Transcoder] Audio transcode complete, output written to:', session.outputPath)

  } finally {
    // Destroy ALL native objects in reverse order
    if (resampledFrame) resampledFrame.destroy()
    if (frame) frame.destroy()
    if (outputPacket) outputPacket.destroy()
    if (packet) packet.destroy()
    if (resampler) resampler.destroy()
    if (audioEncoder) audioEncoder.destroy()
    if (audioDecoder) audioDecoder.destroy()
    if (outputFormat) outputFormat.destroy()
    if (outputIO) {
      if (outputIO._cleanup) outputIO._cleanup()
      outputIO.destroy()
    }
    if (inputFormat) inputFormat.destroy()
    if (inputIO) {
      if (inputIO._cleanup) inputIO._cleanup()
      inputIO.destroy()
    }
  }
}

/**
 * Full transcode (video + audio re-encoding)
 * Uses streaming I/O to avoid OOM on large files
 */
async function transcodeVideoWithBareFFmpeg(session, inputSource, onProgress) {
  const inputSize = inputSource.size
  console.log('[Transcoder] Full transcode (HEVC → H.264, audio to AAC), input size:', inputSize)

  // Declare ALL native objects at top for proper cleanup
  let inputIO = null
  let inputFormat = null
  let outputIO = null
  let outputFormat = null
  let videoDecoder = null
  let videoEncoder = null
  let scaler = null
  let audioDecoder = null
  let audioEncoder = null
  let resampler = null
  let packet = null
  let videoFrame = null
  let scaledFrame = null
  let audioFrame = null
  let resampledFrame = null
  let outputPacket = null

  try {
    // Create input IOContext based on source type
    console.log('[Transcoder] Creating input IOContext for', inputSource.type, '...')
    inputIO = await createInputIOContext(inputSource)
    console.log('[Transcoder] IOContext created, creating InputFormatContext...')
    inputFormat = new ffmpeg.InputFormatContext(inputIO)
    console.log('[Transcoder] InputFormatContext created, getting streams...')

    const videoStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.VIDEO)
    console.log('[Transcoder] Video stream:', videoStream ? 'found' : 'not found')
    const audioStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.AUDIO)
    console.log('[Transcoder] Audio stream:', audioStream ? 'found' : 'not found')

    if (!videoStream) {
      throw new Error('No video stream found')
    }

    // Use streaming output IOContext that writes directly to file
    outputIO = createFileWriteIOContext(session.outputPath)
    outputFormat = new ffmpeg.OutputFormatContext('mp4', outputIO)

    // Set up video transcoding to H.264
    const outVideoStream = outputFormat.createStream()
    outVideoStream.codecParameters.type = ffmpeg.constants.mediaTypes.VIDEO
    outVideoStream.codecParameters.id = ffmpeg.constants.codecs.H264
    outVideoStream.codecParameters.width = videoStream.codecParameters.width
    outVideoStream.codecParameters.height = videoStream.codecParameters.height
    // Output format will be aligned to the selected encoder below
    outVideoStream.timeBase = videoStream.timeBase

    // Video decoder - use stream's decoder() helper which copies codec parameters
    // This is critical for HEVC which needs extradata (VPS/SPS/PPS)
    try {
      videoDecoder = videoStream.decoder()
      console.log('[Transcoder] Video decoder created via stream.decoder()')
    } catch (e) {
      // Fallback to manual creation if stream.decoder() fails
      console.log('[Transcoder] stream.decoder() failed, creating manually:', e?.message)
      const videoDecoderSelection = selectDecoderForId(videoStream.codecParameters.id)
      if (!videoDecoderSelection) {
        throw new Error('Video decoder not available')
      }
      videoDecoder = new ffmpeg.CodecContext(videoDecoderSelection.decoder)
      // Copy codec parameters from stream (includes extradata)
      videoStream.codecParameters.toContext(videoDecoder)
    }
    videoDecoder.timeBase = videoStream.timeBase
    videoDecoder.open()

    // Video encoder (H.264)
    const h264Selection = selectH264Encoder()
    if (!h264Selection) {
      throw new Error('H.264 encoder not available')
    }
    console.log('[Transcoder] Using H.264 encoder:', h264Selection.name)
    outVideoStream.codecParameters.format = h264Selection.pixelFormat
    videoEncoder = new ffmpeg.CodecContext(h264Selection.encoder)
    videoEncoder.width = videoStream.codecParameters.width
    videoEncoder.height = videoStream.codecParameters.height
    videoEncoder.pixelFormat = h264Selection.pixelFormat
    videoEncoder.timeBase = videoStream.timeBase
    videoEncoder.bitRate = 8000000 // 8 Mbps
    videoEncoder.gopSize = 48
    videoEncoder.maxBFrames = 0

    if (h264Selection.isHardware) {
      try {
        videoEncoder.setOption('b', '8000000')
        videoEncoder.setOption('profile', 'main')
        videoEncoder.setOption('level', '4.1')
        videoEncoder.setOption('i-frame-interval', '2')
        videoEncoder.setOption('g', '48')
      } catch {}
    }
    videoEncoder.open()

    // Video scaler for pixel format conversion if needed
    const decoderPixelFormat = videoDecoder.pixelFormat
    const NONE = ffmpeg.constants.pixelFormats.NONE
    let inputPixelFormat = decoderPixelFormat
    if (!inputPixelFormat || inputPixelFormat === NONE || inputPixelFormat === 0 || inputPixelFormat < 0) {
      inputPixelFormat = ffmpeg.constants.pixelFormats.YUV420P
      console.log('[Transcoder] Decoder format unknown (' + decoderPixelFormat + '), assuming YUV420P')
    }

    // Scaler args: srcPixelFormat, srcWidth, srcHeight, dstPixelFormat, dstWidth, dstHeight
    if (inputPixelFormat !== h264Selection.pixelFormat) {
      scaler = new ffmpeg.Scaler(
        inputPixelFormat,
        videoStream.codecParameters.width,
        videoStream.codecParameters.height,
        h264Selection.pixelFormat,
        videoStream.codecParameters.width,
        videoStream.codecParameters.height
      )
    }

    // Set up audio transcoding to AAC
    let outAudioStream = null

    if (audioStream) {
      outAudioStream = outputFormat.createStream()
      outAudioStream.codecParameters.type = ffmpeg.constants.mediaTypes.AUDIO
      outAudioStream.codecParameters.id = ffmpeg.constants.codecs.AAC
      outAudioStream.codecParameters.sampleRate = audioStream.codecParameters.sampleRate || 48000
      outAudioStream.codecParameters.channelLayout = ffmpeg.constants.channelLayouts.STEREO
      outAudioStream.codecParameters.format = ffmpeg.constants.sampleFormats.FLTP
      outAudioStream.timeBase = { numerator: 1, denominator: outAudioStream.codecParameters.sampleRate }

      // Audio decoder - use stream's decoder() helper which copies codec parameters
      try {
        audioDecoder = audioStream.decoder()
        console.log('[Transcoder] Audio decoder created via stream.decoder()')
      } catch (e) {
        console.log('[Transcoder] stream.decoder() failed, creating manually:', e?.message)
        const decoderSelection = selectDecoderForId(audioStream.codecParameters.id)
        if (!decoderSelection) {
          throw new Error('Audio decoder not available')
        }
        audioDecoder = new ffmpeg.CodecContext(decoderSelection.decoder)
        audioStream.codecParameters.toContext(audioDecoder)
      }
      audioDecoder.timeBase = audioStream.timeBase
      audioDecoder.open()

      // Encoder
      const aacSelection = selectAacEncoder()
      if (!aacSelection) {
        throw new Error('AAC encoder not available')
      }
      console.log('[Transcoder] Using AAC encoder:', aacSelection.name)
      audioEncoder = new ffmpeg.CodecContext(aacSelection.encoder)
      audioEncoder.sampleRate = outAudioStream.codecParameters.sampleRate
      audioEncoder.channelLayout = ffmpeg.constants.channelLayouts.STEREO
      audioEncoder.sampleFormat = ffmpeg.constants.sampleFormats.FLTP
      audioEncoder.timeBase = outAudioStream.timeBase
      audioEncoder.open()

      // Resampler
      resampler = new ffmpeg.Resampler(
        audioDecoder.sampleRate,
        audioDecoder.channelLayout,
        audioDecoder.sampleFormat,
        audioEncoder.sampleRate,
        audioEncoder.channelLayout,
        audioEncoder.sampleFormat
      )
    }

    outputFormat.writeHeader()

    packet = new ffmpeg.Packet()
    videoFrame = new ffmpeg.Frame()
    scaledFrame = new ffmpeg.Frame()
    audioFrame = new ffmpeg.Frame()
    resampledFrame = new ffmpeg.Frame()
    outputPacket = new ffmpeg.Packet()

    // Allocate scaled frame if scaler is needed
    if (scaler) {
      scaledFrame.width = videoStream.codecParameters.width
      scaledFrame.height = videoStream.codecParameters.height
      scaledFrame.format = ffmpeg.constants.pixelFormats.YUV420P
      scaledFrame.alloc()
    }

    if (outAudioStream) {
      resampledFrame.format = ffmpeg.constants.sampleFormats.FLTP
      resampledFrame.channelLayout = ffmpeg.constants.channelLayouts.STEREO
      resampledFrame.sampleRate = audioEncoder.sampleRate
      resampledFrame.nbSamples = 1024
      resampledFrame.alloc()
    }

    let packetCount = 0
    let bytesProcessed = 0
    let lastProgressPercent = 0

    // Single-pass processing with byte-based progress
    while (inputFormat.readFrame(packet)) {
      packetCount++
      bytesProcessed += packet.size || 0

      if (packet.streamIndex === videoStream.index) {
        packet.timeBase = videoStream.timeBase

        if (videoDecoder.sendPacket(packet)) {
          while (videoDecoder.receiveFrame(videoFrame)) {
            let frameToEncode = videoFrame

            // Scale if needed
            if (scaler) {
              scaler.scale(videoFrame, scaledFrame)
              scaledFrame.pts = videoFrame.pts
              scaledFrame.timeBase = videoFrame.timeBase
              frameToEncode = scaledFrame
            }

            if (videoEncoder.sendFrame(frameToEncode)) {
              while (videoEncoder.receivePacket(outputPacket)) {
                outputPacket.streamIndex = outVideoStream.index
                outputFormat.writeFrame(outputPacket)
                outputPacket.unref()
              }
            }
          }
        }
      } else if (audioStream && outAudioStream && packet.streamIndex === audioStream.index) {
        packet.timeBase = audioStream.timeBase

        if (audioDecoder.sendPacket(packet)) {
          while (audioDecoder.receiveFrame(audioFrame)) {
            const samplesConverted = resampler.convert(audioFrame, resampledFrame)
            resampledFrame.nbSamples = samplesConverted
            resampledFrame.pts = audioFrame.pts
            resampledFrame.timeBase = audioFrame.timeBase

            if (audioEncoder.sendFrame(resampledFrame)) {
              while (audioEncoder.receivePacket(outputPacket)) {
                outputPacket.streamIndex = outAudioStream.index
                outputFormat.writeFrame(outputPacket)
                outputPacket.unref()
              }
            }
          }
        }
      }

      packet.unref()

      // Report progress based on bytes processed
      if (inputSize > 0 && packetCount % 500 === 0) {
        const percent = Math.min(99, Math.round((bytesProcessed / inputSize) * 100))
        if (percent > lastProgressPercent) {
          lastProgressPercent = percent
          session.progress = percent
          if (onProgress) onProgress(percent)
          console.log('[Transcoder] Video transcode progress:', percent + '%', '(' + Math.round(bytesProcessed / 1024 / 1024) + 'MB)')
        }
      }
    }

    // Flush video encoder
    videoEncoder.sendFrame(null)
    while (videoEncoder.receivePacket(outputPacket)) {
      outputPacket.streamIndex = outVideoStream.index
      outputFormat.writeFrame(outputPacket)
      outputPacket.unref()
    }

    // Flush audio encoder
    if (audioEncoder) {
      audioEncoder.sendFrame(null)
      while (audioEncoder.receivePacket(outputPacket)) {
        outputPacket.streamIndex = outAudioStream.index
        outputFormat.writeFrame(outputPacket)
        outputPacket.unref()
      }
    }

    outputFormat.writeTrailer()
    console.log('[Transcoder] Video transcode complete, output written to:', session.outputPath)

  } finally {
    // Destroy ALL native objects in reverse order
    if (resampledFrame) resampledFrame.destroy()
    if (audioFrame) audioFrame.destroy()
    if (scaledFrame) scaledFrame.destroy()
    if (videoFrame) videoFrame.destroy()
    if (outputPacket) outputPacket.destroy()
    if (packet) packet.destroy()
    if (resampler) resampler.destroy()
    if (audioEncoder) audioEncoder.destroy()
    if (audioDecoder) audioDecoder.destroy()
    if (scaler) scaler.destroy()
    if (videoEncoder) videoEncoder.destroy()
    if (videoDecoder) videoDecoder.destroy()
    if (outputFormat) outputFormat.destroy()
    if (outputIO) {
      if (outputIO._cleanup) outputIO._cleanup()
      outputIO.destroy()
    }
    if (inputFormat) inputFormat.destroy()
    if (inputIO) {
      if (inputIO._cleanup) inputIO._cleanup()
      inputIO.destroy()
    }
  }
}

/**
 * Start a transcode session
 * @param {string} sourceUrl - Video URL
 * @param {object} options - Options: { duration, title, onProgress }
 */
export async function startTranscode(sourceUrl, options = {}) {
  const { duration = 0, title = '', onProgress } = options

  if (!ffmpeg) {
    const loaded = await loadBareFfmpeg()
    if (!loaded) {
      return { success: false, error: ffmpegLoadError || 'bare-ffmpeg not available' }
    }
  }

  // Ensure HTTP server is running
  await ensureHttpServer()

  const sessionId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const outputPath = path.join(os.tmpdir(), `peartube_transcode_${sessionId}.mp4`)

  const session = {
    id: sessionId,
    outputPath,
    sourceUrl,
    status: 'starting',
    progress: 0,
    duration,
    error: null,
  }
  sessions.set(sessionId, session)

  const transcodeUrl = `http://127.0.0.1:${httpPort}/transcode/${sessionId}`

  // Wrap onProgress to include sessionId
  const progressCallback = (percent) => {
    if (onProgress) onProgress(sessionId, percent)
  }

  // Start transcoding in background
  ;(async () => {
    try {
      session.status = 'probing'

      // Probe to determine transcode mode (pass title for codec detection)
      const probeResult = await probeMedia(sourceUrl, title)
      console.log('[Transcoder] Probe result:', probeResult)

      // Prepare input source
      session.status = 'downloading'
      let inputSource
      let download = null

      if (sourceUrl.startsWith('http://') || sourceUrl.startsWith('https://')) {
        // Start background download with streaming write
        console.log('[Transcoder] Starting streaming download...')

        let downloadComplete = false
        let downloadError = null

        download = startBackgroundDownload(
          sourceUrl,
          (pct) => {
            // Download progress shown in logs only - transcode progress takes over UI
            console.log('[Transcoder] Download:', pct + '%')
          },
          (finalSize) => {
            downloadComplete = true
            console.log('[Transcoder] Download complete:', finalSize, 'bytes')
          },
          (err) => {
            downloadError = err
            console.error('[Transcoder] Download error:', err.message)
          }
        )

        if (!download) {
          throw new Error('Failed to start download')
        }

        // Wait for content-length to be known (header received)
        let waitCount = 0
        while (download.contentLength() === 0 && !downloadError && waitCount < 100) {
          await new Promise(r => setTimeout(r, 100))
          waitCount++
        }

        if (downloadError) {
          throw downloadError
        }

        const totalSize = download.contentLength()
        console.log('[Transcoder] Content-Length received:', totalSize, 'bytes')

        // Create input source that reads from growing file
        inputSource = {
          type: 'growing',
          path: download.path,
          size: totalSize,
          getBytesWritten: () => download.getBytesWritten(),
          isComplete: () => download.isComplete(),
          cleanup: () => download.cleanup()
        }
        console.log('[Transcoder] Starting transcode while download in progress...')
      } else {
        // Local file
        const inputSize = fs.statSync(sourceUrl).size
        inputSource = { type: 'file', path: sourceUrl, size: inputSize }
      }
      console.log('[Transcoder] Input ready, size:', inputSource.size, 'bytes')

      session.status = 'transcoding'

      // Progress callback - transcode progress is now the main progress (0-100%)
      // Download happens in parallel and transcode waits for data as needed
      const transcodeProgressCallback = (percent) => {
        session.progress = percent
        if (progressCallback) progressCallback(session.progress)
      }

      if (probeResult.needsVideoTranscode) {
        // Full video + audio transcode
        await transcodeVideoWithBareFFmpeg(session, inputSource, transcodeProgressCallback)
      } else if (probeResult.needsAudioTranscode) {
        // Video copy, audio transcode
        await transcodeAudioWithBareFFmpeg(session, inputSource, transcodeProgressCallback)
      } else if (probeResult.needsRemux) {
        // Just remux (fast copy)
        await remuxWithBareFFmpeg(session, inputSource, transcodeProgressCallback)
      } else {
        // Still do a remux to ensure MP4 container
        await remuxWithBareFFmpeg(session, inputSource, transcodeProgressCallback)
      }

      session.status = 'complete'
      session.progress = 100
      console.log('[Transcoder] Transcode complete:', sessionId)

    } catch (err) {
      session.status = 'error'
      session.error = err?.message || 'Transcode failed'
      console.error('[Transcoder] Error:', session.error, err?.stack)
    }
    // No temp file cleanup needed - we use HTTP streaming directly
  })()

  return {
    success: true,
    sessionId,
    transcodeUrl,
  }
}

/**
 * Stop a transcode session
 */
export function stopTranscode(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) {
    return { success: false, error: 'Session not found' }
  }

  try {
    fs.unlinkSync(session.outputPath)
  } catch {}

  sessions.delete(sessionId)
  return { success: true }
}

/**
 * Get transcode session status
 */
export function getStatus(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) {
    return { error: 'Session not found' }
  }

  return {
    status: session.status,
    progress: session.progress,
    bytesWritten: getFileSize(session.outputPath),
    error: session.error,
  }
}

/**
 * Get all active sessions
 */
export function getSessions() {
  return Array.from(sessions.values())
}

/**
 * Cleanup all sessions
 */
export function cleanup() {
  for (const [id, session] of sessions) {
    try {
      fs.unlinkSync(session.outputPath)
    } catch {}
  }
  sessions.clear()

  if (httpServer) {
    httpServer.close()
    httpServer = null
    httpPort = 0
    httpReady = null
  }
}
