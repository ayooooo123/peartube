/**
 * HLS Transcoder Module
 *
 * Real-time HLS transcoding for Chromecast casting using bare-ffmpeg.
 * Uses main-thread temp file reader for sync IOContext.
 *
 * Architecture:
 * - TempFileReader downloads head + tail for MKV cues, provides sync reads
 * - HlsSegmentManager stores MPEGTS segments
 * - HTTP server serves HLS playlist and segments
 *
 * Key features:
 * - Playback starts as soon as first segments are ready
 * - Memory-efficient: only recent segments in memory
 * - Keyframe-based segmentation with 8s max cap
 */

import os from 'bare-os'
import http from 'bare-http1'

import { HlsSegmentManager } from './hls-segment-manager.mjs'
import { getHttpFileSize } from './channel-stream-reader.mjs'
import TempFileReader from './temp-file-reader.mjs'
import { HypercoreIOReader } from './hypercore-io-reader.mjs'

console.log('[HlsTranscoder] Module loaded')

/**
 * Parse MPEG-TS buffer to extract PAT and PMT packets for HLS segment injection.
 * PAT (PID 0) must be first for players to locate PMT -> audio/video streams.
 * 
 * @param {Buffer} buffer - MPEG-TS data to scan
 * @returns {Buffer|null} - PAT+PMT concatenated buffer, or null if not found
 */
function extractPatPmtHeader(buffer) {
  if (!buffer || buffer.length < 188) return null
  
  const bufLen = buffer.length
  let patPacket = null
  let pmtPid = null
  let pmtPacket = null
  
  // First pass: find PAT (PID 0) and parse it to get PMT PID
  for (let offset = 0; offset + 188 <= bufLen; offset += 188) {
    if (buffer[offset] !== 0x47) continue // MPEG-TS sync byte
    const pid = ((buffer[offset + 1] & 0x1f) << 8) | buffer[offset + 2]
    
    if (pid === 0) {
      // PAT found - extract packet and parse for PMT PID
      patPacket = buffer.slice(offset, offset + 188)
      
      // Parse PAT to find PMT PID:
      // TS header: 4 bytes, then adaptation field if present
      const adaptationFieldControl = (buffer[offset + 3] >> 4) & 0x03
      let payloadStart = offset + 4
      if (adaptationFieldControl === 2 || adaptationFieldControl === 3) {
        // Adaptation field present
        const adaptLen = buffer[offset + 4]
        payloadStart = offset + 5 + adaptLen
      }
      
      // Check payload unit start indicator for pointer field
      const payloadUnitStart = (buffer[offset + 1] & 0x40) !== 0
      if (payloadUnitStart && payloadStart < offset + 188) {
        const pointerField = buffer[payloadStart]
        payloadStart += 1 + pointerField
      }
      
      // PAT table structure:
      // table_id (1) + section_syntax (2) + transport_stream_id (2) + 
      // version/current (1) + section_number (1) + last_section (1) = 8 bytes header
      // Then: program_number (2) + reserved + program_map_PID (13 bits in 2 bytes)
      const tableStart = payloadStart
      if (tableStart + 12 <= offset + 188) {
        // Skip 8 bytes of table header to get to first program entry
        const programStart = tableStart + 8
        // program_number is 2 bytes, then 3 reserved bits + 13-bit PMT PID
        pmtPid = ((buffer[programStart + 2] & 0x1f) << 8) | buffer[programStart + 3]
        if (pmtPid > 0 && pmtPid < 0x1fff) {
          console.log('[HlsTranscoder] PAT parsed, PMT PID:', pmtPid, '(0x' + pmtPid.toString(16) + ')')
        } else {
          pmtPid = null // Invalid PMT PID
        }
      }
      break // Found PAT, stop searching
    }
  }
  
  // Second pass: find PMT using the PID extracted from PAT
  if (patPacket && pmtPid) {
    for (let offset = 0; offset + 188 <= bufLen; offset += 188) {
      if (buffer[offset] !== 0x47) continue
      const pid = ((buffer[offset + 1] & 0x1f) << 8) | buffer[offset + 2]
      if (pid === pmtPid) {
        pmtPacket = buffer.slice(offset, offset + 188)
        console.log('[HlsTranscoder] PMT found at PID:', pmtPid)
        break
      }
    }
  }
  
  // Return PAT + PMT (PAT must be first!)
  if (patPacket && pmtPacket) {
    console.log('[HlsTranscoder] Cached PAT+PMT header: 376 bytes (PAT @ PID 0, PMT @ PID ' + pmtPid + ')')
    return Buffer.concat([patPacket, pmtPacket])
  } else if (patPacket) {
    console.log('[HlsTranscoder] Cached PAT only: 188 bytes (PMT not found in buffer)')
    return patPacket
  }
  
  return null
}

/**
 * Get LAN IP for Chromecast access
 */
async function getLanIp() {
  try {
    const mod = await import('udx-native')
    const UDX = mod?.default || mod
    const udx = new UDX()

    for (const iface of udx.networkInterfaces()) {
      if (iface.family !== 4 || iface.internal) continue
      // Prefer 192.168.x.x addresses
      if (iface.host.startsWith('192.168.')) return iface.host
    }

    // Fallback to any non-internal IPv4
    for (const iface of udx.networkInterfaces()) {
      if (iface.family !== 4 || iface.internal) continue
      return iface.host
    }
  } catch (err) {
    console.warn('[HlsTranscoder] LAN IP detection failed:', err?.message)
  }
  return '127.0.0.1'
}

// bare-ffmpeg module (loaded dynamically)
let ffmpeg = null
let ffmpegLoadError = null
let ffmpegLoadPromise = null

/**
 * Load bare-ffmpeg module
 */
export async function loadBareFfmpeg() {
  if (ffmpeg) return true
  if (ffmpegLoadError) return false
  if (ffmpegLoadPromise) return ffmpegLoadPromise

  ffmpegLoadPromise = (async () => {
    let lastError
    console.log('[HlsTranscoder] Attempting to load bare-ffmpeg...')

    if (typeof require === 'function') {
      try {
        const mod = require('bare-ffmpeg')
        ffmpeg = mod?.default ?? mod
        console.log('[HlsTranscoder] bare-ffmpeg loaded via require')
        return true
      } catch (err) {
        console.warn('[HlsTranscoder] require failed:', err?.message)
        lastError = err
      }
    }

    try {
      const mod = await import('bare-ffmpeg')
      ffmpeg = mod?.default ?? mod
      console.log('[HlsTranscoder] bare-ffmpeg loaded via import')
      return true
    } catch (err) {
      console.warn('[HlsTranscoder] import failed:', err?.message)
      lastError = err
    }

    ffmpegLoadError = lastError?.message || 'Failed to load bare-ffmpeg'
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

// Active HLS sessions
const sessions = new Map()

/**
 * Convert H.264 extradata from AVCC format to Annex B format
 * AVCC format: used by MP4/MOV containers, contains SPS/PPS with length prefixes
 * Annex B format: used by MPEGTS/raw H.264, uses start codes (0x00000001)
 *
 * @param {Buffer} avcc - AVCC format extradata
 * @returns {Buffer} Annex B format SPS/PPS NALUs
 */
function convertAvccToAnnexB(avcc) {
  if (!avcc || avcc.length < 7) {
    console.warn('[convertAvccToAnnexB] Invalid AVCC data, length:', avcc?.length)
    return null
  }

  // AVCC format structure:
  // [0] configurationVersion (always 0x01)
  // [1] AVCProfileIndication
  // [2] profile_compatibility
  // [3] AVCLevelIndication
  // [4] lengthSizeMinusOne (& 0x03) -> NALU length size (usually 4)
  // [5] numOfSPS (& 0x1F)
  // [6..] SPS entries: 2-byte length + SPS data
  // [...] numOfPPS (1 byte)
  // [...] PPS entries: 2-byte length + PPS data

  const parts = []
  const startCode = Buffer.from([0x00, 0x00, 0x00, 0x01])

  try {
    let offset = 5
    const numSps = avcc[offset] & 0x1f
    offset++

    // Parse SPS entries
    for (let i = 0; i < numSps; i++) {
      if (offset + 2 > avcc.length) break
      const spsLen = (avcc[offset] << 8) | avcc[offset + 1]
      offset += 2
      if (offset + spsLen > avcc.length) break
      const sps = avcc.slice(offset, offset + spsLen)
      parts.push(startCode)
      parts.push(sps)
      offset += spsLen
      console.log('[convertAvccToAnnexB] Found SPS, length:', spsLen)
    }

    // Parse PPS entries
    if (offset < avcc.length) {
      const numPps = avcc[offset]
      offset++

      for (let i = 0; i < numPps; i++) {
        if (offset + 2 > avcc.length) break
        const ppsLen = (avcc[offset] << 8) | avcc[offset + 1]
        offset += 2
        if (offset + ppsLen > avcc.length) break
        const pps = avcc.slice(offset, offset + ppsLen)
        parts.push(startCode)
        parts.push(pps)
        offset += ppsLen
        console.log('[convertAvccToAnnexB] Found PPS, length:', ppsLen)
      }
    }

    if (parts.length === 0) {
      console.warn('[convertAvccToAnnexB] No SPS/PPS found in AVCC data')
      return null
    }

    const result = Buffer.concat(parts)
    console.log('[convertAvccToAnnexB] Converted', parts.length / 2, 'NALUs, total bytes:', result.length)
    return result

  } catch (err) {
    console.error('[convertAvccToAnnexB] Parse error:', err?.message)
    return null
  }
}

// HTTP server for HLS content
let httpServer = null
let httpPort = 0
let httpReady = null

// CRITICAL: Mutex to prevent concurrent access between transcoding and HTTP handler
// When this is > 0, HTTP handler should wait or return 503
let transcodingBusy = 0

/**
 * Handle HTTP requests for HLS streams
 * Wrapped in try-catch to prevent server crashes
 * Async to support Hyperblobs segment retrieval
 */
async function handleHttpRequest(req, res) {
  try {
    const url = req.url || '/'

    // Log ALL incoming requests with full details
    console.log('[HlsTranscoder] HTTP request:', req.method, url)
    console.log('[HlsTranscoder] Active sessions:', Array.from(sessions.keys()).join(', ') || 'none')

    // CORS headers - must be set before any response
    try {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Range')
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges')
    } catch (headerErr) {
      console.error('[HlsTranscoder] Failed to set CORS headers:', headerErr?.message)
    }

    if ((req.method || '').toUpperCase() === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    // Health check endpoint
    if (url === '/ping' || url === '/') {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/plain')
      res.end('HLS server OK, sessions: ' + sessions.size)
      return
    }

    // Parse URL: /hls/{sessionId}/stream.m3u8 or /hls/{sessionId}/segment{N}.ts
    const playlistMatch = url.match(/^\/hls\/([^\/]+)\/stream\.m3u8/)
    const segmentMatch = url.match(/^\/hls\/([^\/]+)\/segment(\d+)\.ts/)

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
    } else {
      console.log('[HlsTranscoder] 404 - URL pattern not matched:', url)
      res.statusCode = 404
      res.end('Not found - invalid URL pattern')
      return
    }

    console.log('[HlsTranscoder] Request for session:', sessionId, 'type:', requestType, 'segment:', segmentIndex)

    const session = sessions.get(sessionId)
    if (!session) {
      console.log('[HlsTranscoder] 404 - Session not found:', sessionId)
      console.log('[HlsTranscoder] Known sessions:', Array.from(sessions.keys()))
      res.statusCode = 404
      res.end('Session not found: ' + sessionId)
      return
    }

    const { segmentManager } = session

    if (requestType === 'playlist') {
      const stats = segmentManager.getStats()
      const highestSeg = segmentManager.getHighestSegmentIndex()
      
      // Get host from request for absolute URLs (Chromecast requirement)
      const hostHeader = req.headers.host || '127.0.0.1:49808'
      const playlist = segmentManager.generatePlaylist({
        hostForPlaylist: hostHeader,
        sessionId: sessionId
      })
      const playlistBuf = Buffer.from(playlist, 'utf8')

      // Log playlist content for debugging (first 20 lines)
      const playlistPreview = playlist.split('\n').slice(0, 20).join('\n')
      console.log('[HlsTranscoder] Playlist preview:\n' + playlistPreview)
      if (playlist.split('\n').length > 20) {
        console.log('[HlsTranscoder] ... (more lines)')
      }

      // Log every playlist request to track Chromecast polling
      const segmentLines = playlist.split('\n').filter(l => l.startsWith('segment') || l.startsWith('http')).length
      console.log('[HlsTranscoder] Playlist request - totalSegs:', stats.totalSegments,
        'inPlaylist:', segmentLines, 'highest:', highestSeg, 'complete:', stats.isComplete,
        'hostForPlaylist:', hostHeader)

      res.statusCode = 200
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
      res.setHeader('Content-Length', playlistBuf.length)
      // Prevent any caching - Chromecast must always get fresh playlist
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
      res.setHeader('Pragma', 'no-cache')
      res.setHeader('Expires', '0')
      res.end(playlistBuf)
      return
    }

    if (requestType === 'segment') {
      const highestAvailable = segmentManager.getHighestSegmentIndex()
      console.log('[HlsTranscoder] Segment request:', segmentIndex, 'highest available:', highestAvailable)

      // NOTE: Removed transcodingBusy check - completed segments are immutable and safe to serve
      // The old check was returning 503 for almost ALL requests during active transcoding,
      // causing Chromecast to give up. Segments are stored atomically, so once hasSegment()
      // returns true, the segment data is complete and safe to read.

      if (!segmentManager.hasSegment(segmentIndex)) {
        console.log('[HlsTranscoder] 503 - Segment', segmentIndex, 'not ready (highest:', highestAvailable, ')')
        res.statusCode = 503
        res.setHeader('Retry-After', '1')
        res.end('Segment not ready')
        return
      }

      const segmentData = segmentManager.getSegment(segmentIndex)
      if (!segmentData) {
        console.log('[HlsTranscoder] 404 - Segment data null:', segmentIndex)
        res.statusCode = 404
        res.end('Segment not found')
        return
      }

      // CRITICAL: Create defensive copy for HTTP response
      const segLen = segmentData.length
      const responseBuf = Buffer.alloc(segLen)
      for (let i = 0; i < segLen; i++) {
        responseBuf[i] = segmentData[i]
      }

      console.log('[HlsTranscoder] Serving segment', segmentIndex, '- size:', Math.round(segLen/1024), 'KB')
      res.statusCode = 200
      res.setHeader('Content-Type', 'video/mp2t')
      res.setHeader('Content-Length', segLen)
      res.setHeader('Cache-Control', 'max-age=3600')
      res.end(responseBuf)
    }
  } catch (err) {
    console.error('[HlsTranscoder] HTTP handler error:', err?.message || err)
    console.error('[HlsTranscoder] Stack:', err?.stack)
    try {
      if (!res.headersSent) {
        res.statusCode = 500
        res.end('Internal server error: ' + (err?.message || 'unknown'))
      }
    } catch {}
  }
}

/**
 * Ensure HTTP server is running
 */
async function ensureHttpServer() {
  // If server already running and healthy, return port
  if (httpPort && httpServer) {
    try {
      const addr = httpServer.address()
      if (addr) {
        console.log('[HlsTranscoder] HTTP server already running on port', httpPort)
        return httpPort
      }
    } catch {}
    // Server died, reset state
    console.log('[HlsTranscoder] HTTP server died, restarting...')
    httpPort = 0
    httpServer = null
    httpReady = null
  }

  if (httpReady) return httpReady

  console.log('[HlsTranscoder] Creating new HTTP server...')

  httpReady = new Promise((resolve, reject) => {
    try {
      // Wrap async handler to catch any unhandled promise rejections
      httpServer = http.createServer((req, res) => {
        handleHttpRequest(req, res).catch((err) => {
          console.error('[HlsTranscoder] Async handler error:', err?.message || err)
          try {
            if (!res.headersSent) {
              res.statusCode = 500
              res.end('Internal server error')
            }
          } catch {}
        })
      })

      // MINIMAL connection tracking - avoid socket property access which may cause crashes
      let connectionCount = 0
      httpServer.on('connection', () => {
        connectionCount++
        console.log('[HlsTranscoder] Connection #' + connectionCount)
        // NOTE: Removed socket.remoteAddress access and socket event handlers
        // These may have been causing "write after free" crashes on Android
      })

      // Listen on 0.0.0.0 so Chromecast (external device) can connect
      httpServer.listen(0, '0.0.0.0', () => {
        const addr = httpServer.address()
        httpPort = addr?.port || 0
        console.log('[HlsTranscoder] HTTP server listening on 0.0.0.0:' + httpPort)
        console.log('[HlsTranscoder] Server address info:', JSON.stringify(addr))
        resolve(httpPort)
      })

      httpServer.on('error', (err) => {
        console.error('[HlsTranscoder] HTTP server error:', err?.message || err)
        httpPort = 0
        httpServer = null
        httpReady = null
        reject(err)
      })

      httpServer.on('close', () => {
        console.log('[HlsTranscoder] HTTP server closed')
        httpPort = 0
        httpServer = null
        httpReady = null
      })

    } catch (createErr) {
      console.error('[HlsTranscoder] Failed to create HTTP server:', createErr?.message || createErr)
      reject(createErr)
    }
  })

  return httpReady
}

/**
 * Check if transcoding is needed based on URL/title detection
 */
function detectTranscodeNeeded(url, title = '') {
  const result = {
    needsVideoTranscode: false,
    needsAudioTranscode: false,
    needsRemux: false,
    reason: ''
  }

  const urlLower = url.toLowerCase()
  const titleLower = (title || '').toLowerCase()

  // Parse MIME type from blob URL
  let mimeType = ''
  try {
    const urlObj = new URL(url)
    mimeType = (urlObj.searchParams.get('type') || '').toLowerCase()
  } catch {}

  console.log('[HlsTranscoder] Detection - MIME:', mimeType, 'Title:', titleLower.substring(0, 50))

  const reasons = []

  // Container detection
  if (mimeType.includes('matroska') || mimeType.includes('x-mkv') || urlLower.includes('.mkv')) {
    result.needsRemux = true
    reasons.push('MKV container')
  }

  // Video codec detection
  if (titleLower.includes('hevc') || titleLower.includes('h265') ||
      titleLower.includes('h.265') || titleLower.includes('x265')) {
    result.needsVideoTranscode = true
    reasons.push('HEVC video')
  }

  // Audio codec detection
  if (titleLower.includes('ddp') || titleLower.includes('dd+') ||
      titleLower.includes('e-ac3') || titleLower.includes('eac3') ||
      titleLower.match(/\bdd\b/) || titleLower.includes('ac3') ||
      titleLower.includes('dts') || titleLower.includes('truehd')) {
    result.needsAudioTranscode = true
    reasons.push('Incompatible audio')
  }

  result.reason = reasons.join(', ') || 'Compatible'
  return result
}

/**
 * HLS Remux - Copy streams to MPEGTS with bitstream filters
 */
async function hlsRemux(session, inputIO, segmentManager, totalSize, onProgress) {
  console.log('[HlsTranscoder] Starting HLS remux...')

  let inputFormat = null
  let outputFormat = null
  let outputIO = null
  let packet = null
  let bsf = null
  let currentSegmentBuffer = []
  
  // PAT/PMT header cache for segment injection
  // MPEG-TS segments must start with PAT for Chromecast compatibility
  let cachedPatPmt = null

  try {
    inputFormat = new ffmpeg.InputFormatContext(inputIO)

    const videoStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.VIDEO)
    const audioStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.AUDIO)

    if (!videoStream) {
      throw new Error('No video stream found')
    }

    console.log('[HlsTranscoder] REMUX Video codec ID:', videoStream.codecParameters.id)
    if (audioStream) {
      console.log('[HlsTranscoder] REMUX Audio codec ID:', audioStream.codecParameters.id)
    }

    // Create in-memory output context for MPEGTS
    let totalBytesWritten = 0
    let writeCount = 0
    outputIO = new ffmpeg.IOContext(1024 * 1024, {
      onwrite: (buffer) => {
        writeCount++
        const bufLen = buffer.length
        totalBytesWritten += bufLen

        // CRITICAL: Manual byte-by-byte copy to guarantee no shared memory
        const bufCopy = Buffer.alloc(bufLen)
        for (let i = 0; i < bufLen; i++) {
          bufCopy[i] = buffer[i]
        }

        // Extract PAT+PMT from first write for segment header injection
        if (!cachedPatPmt && bufLen >= 188) {
          cachedPatPmt = extractPatPmtHeader(bufCopy)
        }

        currentSegmentBuffer.push(bufCopy)
        // Log more frequently to diagnose buffer issues
        if (writeCount <= 10 || writeCount % 50 === 0) {
          console.log('[HlsTranscoder] REMUX IOWrite #' + writeCount + ':', bufLen, 'bytes, buffers:', currentSegmentBuffer.length,
            'segTotal:', currentSegmentBuffer.reduce((s,b) => s + b.length, 0))
        }
        return bufLen
      },
      onseek: () => 0
    })

    outputFormat = new ffmpeg.OutputFormatContext('mpegts', outputIO)

    // CRITICAL: MPEGTS muxer options for HLS compatibility
    // These ensure each segment is independently decodable
    // Options are passed via Dictionary to writeHeader()
    const muxerOptionsDict = ffmpeg.Dictionary.from({
      'mpegts_flags': 'pat_pmt_at_frames',  // Write PAT/PMT at each keyframe
      'pcr_period': '20',                    // Frequent PCR for sync
      'flush_packets': '1',                  // CRITICAL: Force immediate flush to IOContext after each packet
      'max_delay': '0',                      // Eliminate interleave buffering delay
    })
    console.log('[HlsTranscoder] REMUX: MPEGTS muxer options prepared for writeHeader():',
      'mpegts_flags=pat_pmt_at_frames, pcr_period=20, flush_packets=1, max_delay=0')

    // Copy video stream
    const outVideoStream = outputFormat.createStream()
    outVideoStream.codecParameters.copyFrom(videoStream.codecParameters)
    outVideoStream.timeBase = videoStream.timeBase

    // Create bitstream filter for H.264 -> Annex B
    const isH264 = videoStream.codecParameters.id === ffmpeg.constants.codecs.H264
    if (isH264 && ffmpeg.BitstreamFilter) {
      try {
        bsf = new ffmpeg.BitstreamFilter('h264_mp4toannexb')
        bsf.codecParameters = videoStream.codecParameters
        bsf.timeBase = videoStream.timeBase
        bsf.init()
        console.log('[HlsTranscoder] Using h264_mp4toannexb bitstream filter')
      } catch (err) {
        console.warn('[HlsTranscoder] Bitstream filter failed:', err.message)
        bsf = null
      }
    }

    // Copy audio stream if present
    let outAudioStream = null
    if (audioStream) {
      outAudioStream = outputFormat.createStream()
      outAudioStream.codecParameters.copyFrom(audioStream.codecParameters)
      outAudioStream.timeBase = audioStream.timeBase
    }

    outputFormat.writeHeader(muxerOptionsDict)
    console.log('[HlsTranscoder] REMUX: Header written with muxer options (PAT/PMT at keyframes)')

    packet = new ffmpeg.Packet()
    let packetCount = 0
    let lastProgressPct = 0
    let bytesProcessed = 0

    // Get video time base for PTS conversion
    const videoTimeBase = videoStream.timeBase
    const ptsToSeconds = (pts) => {
      if (!pts || pts < 0) return 0
      return (pts * videoTimeBase.numerator) / videoTimeBase.denominator
    }

    // Segmentation state - transcoder creates complete segments
    let segmentIndex = 0
    let segmentStartPts = 0
    let lastKeyframePts = 0
    const TARGET_SEGMENT_DURATION = 2.0 // Target ~2 second segments for faster startup

    // Finalize current segment and start a new one
    const finalizeSegment = async (endPts) => {
      // DEBUG: Log buffer state before finalization
      const bufferCount = currentSegmentBuffer.length
      const totalBufferBytes = currentSegmentBuffer.reduce((sum, b) => sum + b.length, 0)
      console.log('[HlsTranscoder] REMUX finalizeSegment - buffers:', bufferCount,
        'totalBytes:', totalBufferBytes, 'endPts:', endPts.toFixed(3))

      if (currentSegmentBuffer.length === 0) return

      let data = Buffer.concat(currentSegmentBuffer)
      const duration = endPts - segmentStartPts

      console.log('[HlsTranscoder] REMUX After concat - data.length:', data.length,
        'expected:', totalBufferBytes, 'match:', data.length === totalBufferBytes)

      if (duration > 0.1 && data.length > 1000) {
        // Check if segment starts with PAT (PID 0) - required for Chromecast
        const needsPatInjection = data.length >= 188 && data[0] === 0x47 &&
          (((data[1] & 0x1f) << 8) | data[2]) !== 0

        if (needsPatInjection && cachedPatPmt) {
          // Prepend cached PAT/PMT to make segment independently decodable
          data = Buffer.concat([cachedPatPmt, data])
          console.log('[HlsTranscoder] Segment', segmentIndex, '- INJECTED PAT/PMT header (' + cachedPatPmt.length + ' bytes)')
        }

        console.log('[HlsTranscoder] Segment', segmentIndex, '- duration:', duration.toFixed(2) + 's, size:', Math.round(data.length / 1024) + 'KB')
        try {
          await segmentManager.addSegment(segmentIndex, duration, data)
          console.log('[HlsTranscoder] Segment', segmentIndex, 'STORED successfully')
        } catch (addErr) {
          console.error('[HlsTranscoder] Segment', segmentIndex, 'FAILED to store:', addErr?.message, addErr?.stack)
        }
        segmentIndex++
      }

      currentSegmentBuffer = []
      segmentStartPts = endPts
    }

    while (inputFormat.readFrame(packet)) {
      transcodingBusy++

      packetCount++
      const packetBytes = packet.data ? packet.data.length : 0
      bytesProcessed += packetBytes

      if (packet.streamIndex === videoStream.index) {
        const isKeyframe = (packet.flags & 1) !== 0
        const pts = ptsToSeconds(packet.pts)

        // On keyframe: check if we should start a new segment
        if (isKeyframe) {
          const segmentDuration = pts - segmentStartPts
          const bufferBytes = currentSegmentBuffer.reduce((s,b) => s + b.length, 0)
          if (packetCount <= 200 || packetCount % 500 === 0) {
            console.log('[HlsTranscoder] REMUX Keyframe at pts:', pts.toFixed(2) + 's',
              'segDur:', segmentDuration.toFixed(2) + 's', 'bufBytes:', bufferBytes,
              'finalize?', segmentDuration >= TARGET_SEGMENT_DURATION && currentSegmentBuffer.length > 0)
          }
          if (segmentDuration >= TARGET_SEGMENT_DURATION && currentSegmentBuffer.length > 0) {
            // CRITICAL: Flush muxer's interleave buffer before finalizing segment
            // This ensures all buffered audio/video data is written to IOContext
            outputFormat.flush()
            await finalizeSegment(pts)
          }
          lastKeyframePts = pts
        }

        // Mux the packet
        if (bsf) {
          if (bsf.sendPacket(packet)) {
            while (bsf.receivePacket(packet)) {
              packet.streamIndex = outVideoStream.index
              outputFormat.writeFrame(packet)
            }
          }
        } else {
          packet.streamIndex = outVideoStream.index
          outputFormat.writeFrame(packet)
        }
      } else if (audioStream && outAudioStream && packet.streamIndex === audioStream.index) {
        packet.streamIndex = outAudioStream.index
        outputFormat.writeFrame(packet)
      }

      packet.unref()

      // Progress
      if (packetCount % 100 === 0) {
        const pct = Math.min(99, Math.round((bytesProcessed / totalSize) * 100))
        console.log('[HlsTranscoder] Progress:', packetCount, 'packets,', pct + '%,', Math.round(bytesProcessed / 1024 / 1024) + 'MB')
        if (pct > lastProgressPct) {
          lastProgressPct = pct
          session.progress = pct
          if (onProgress) onProgress(pct)
        }
      }

      transcodingBusy--

      if (packetCount % 50 === 0) {
        await new Promise(resolve => setImmediate(resolve))
      }
    }

    // Finalize last segment
    try {
      // Flush remaining muxer buffer before trailer
      outputFormat.flush()
      outputFormat.writeTrailer()
      console.log('[HlsTranscoder] Trailer written successfully')
    } catch (trailerErr) {
      console.log('[HlsTranscoder] writeTrailer error (non-fatal):', trailerErr?.message)
    }
    await finalizeSegment(lastKeyframePts)
    segmentManager.finish()

    console.log('[HlsTranscoder] Remux complete, segments:', segmentManager.totalSegments)

  } finally {
    // CRITICAL: Destroy in reverse order, set to null to prevent GC double-free
    if (bsf) { try { bsf.destroy() } catch {} bsf = null }
    if (packet) { try { packet.destroy() } catch {} packet = null }
    if (outputFormat) { try { outputFormat.destroy() } catch {} outputFormat = null }
    if (outputIO) { try { outputIO.destroy() } catch {} outputIO = null }
    if (inputFormat) { try { inputFormat.destroy() } catch {} inputFormat = null }
    console.log('[HlsTranscoder] Cleanup complete')
  }
}

/**
 * Check if H.264 encoder is available (requires GPL build with x264)
 * Returns encoder info including whether it's a hardware encoder (needs NV12)
 * @param {boolean} preferSoftware - If true, prefer software encoder (fallback mode)
 */
function selectH264Encoder(preferSoftware = false) {
  if (!ffmpeg) return null

  // Hardware encoders require NV12 pixel format
  const hwEncoders = new Set(['h264_mediacodec', 'h264_videotoolbox'])

  // Encoder candidates - order depends on preferSoftware flag
  // Prefer hardware encoders for performance, fall back to software.
  const candidates = preferSoftware
    ? [
        'libx264',            // Software encoder (GPL) - proper keyframe control
        'h264',               // Generic software fallback
        'h264_mediacodec',    // Android hardware encoder (fallback)
        'h264_videotoolbox',  // iOS/macOS hardware encoder (fallback)
      ]
    : [
        'h264_mediacodec',    // Android hardware encoder
        'h264_videotoolbox',  // iOS/macOS hardware encoder
        'libx264',            // Software fallback (GPL)
        'h264'                // Generic fallback
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
  if (fallback && fallback._handle) {
    return { encoder: fallback, name: 'codec:AAC' }
  }

  return null
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

function isH264EncoderAvailable() {
  if (!ffmpeg) return false

  try {
    const selection = selectH264Encoder()
    if (!selection) return false

    if (!selection.encoder?._handle) return false
    const ctx = new ffmpeg.CodecContext(selection.encoder)
    ctx.width = 64
    ctx.height = 64
    ctx.pixelFormat = selection.pixelFormat // Use correct pixel format for encoder type
    ctx.timeBase = { numerator: 1, denominator: 25 }
    ctx.bitRate = 100000
    ctx.gopSize = 12
    ctx.maxBFrames = 0
    try {
      ctx.open()
      ctx.destroy()
      return true
    } catch (e) {
      try { ctx.destroy() } catch {}
      return false
    }
  } catch (e) {
    console.log('[HlsTranscoder] H.264 encoder check failed:', e?.message || e)
    return false
  }
}

// Cache encoder availability check
let h264EncoderAvailable = null

/**
 * HLS Full Transcode - HEVC to H.264, audio to AAC
 * Note: Requires bare-ffmpeg built with BARE_FFMPEG_ENABLE_GPL=ON for x264
 */
async function hlsTranscodeVideo(session, inputIO, segmentManager, totalSize, onProgress) {
  console.log('[HlsTranscoder] Starting HLS full video transcode (per-segment muxing)...')
  console.log('[HlsTranscoder] TRANSCODER_VERSION: add-audio-fifo-v4')

  // Check encoder availability (cached)
  if (h264EncoderAvailable === null) {
    h264EncoderAvailable = isH264EncoderAvailable()
    console.log('[HlsTranscoder] H.264 encoder available:', h264EncoderAvailable)
  }

  if (!h264EncoderAvailable) {
    throw new Error('H.264 encoder not available. bare-ffmpeg needs BARE_FFMPEG_ENABLE_GPL=ON build with x264.')
  }

  let inputFormat = null
  let videoDecoder = null
  let videoEncoder = null
  let scaler = null
  let audioDecoder = null
  let audioEncoder = null
  let resampler = null
  let audioFifo = null      // Buffer between resampler and encoder (handles frame size differences)
  let encoderFrame = null   // Frame for reading from FIFO to send to encoder
  let packet = null
  let videoFrame = null
  let scaledFrame = null
  let audioFrame = null
  let resampledFrame = null
  let outputPacket = null

  // Per-segment muxer state (created fresh for each segment)
  let continuousMuxer = null  // Single muxer for entire stream: { io, format, videoStream, audioStream }

  try {
    // DEBUG: Test IOContext before FFmpeg uses it
    console.log('[HlsTranscoder] Testing IOContext before InputFormatContext...')
    console.log('[HlsTranscoder] inputIO type:', typeof inputIO, 'constructor:', inputIO?.constructor?.name)

    // Test: Allocate a small buffer and try to read
    const testBuf = Buffer.alloc(16)
    console.log('[HlsTranscoder] Test read buffer allocated, size:', testBuf.length)

    // Note: IOContext doesn't have direct read method - FFmpeg calls onread callback
    // The InputFormatContext will trigger reads, so we just verify the object exists
    console.log('[HlsTranscoder] IOContext object verified, proceeding with InputFormatContext...')

    inputFormat = new ffmpeg.InputFormatContext(inputIO)

    const videoStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.VIDEO)
    const audioStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.AUDIO)

    if (!videoStream) {
      throw new Error('No video stream found')
    }

    console.log('[HlsTranscoder] Input video:', videoStream.codecParameters.width, 'x', videoStream.codecParameters.height)

    // Select encoder - prefer hardware for performance
    const h264Selection = selectH264Encoder(false)
    if (!h264Selection) {
      throw new Error('H.264 encoder not available')
    }
    console.log('[HlsTranscoder] Using H.264 encoder:', h264Selection.name, '(hw:', h264Selection.isHardware, ')')

    const encoderPixelFormat = h264Selection.pixelFormat
    console.log('[HlsTranscoder] Encoder pixel format:', encoderPixelFormat === ffmpeg.constants.pixelFormats.NV12 ? 'NV12' : 'YUV420P')

    // ═══════════════════════════════════════════════════════════════════════════
    // SINGLE CONTINUOUS MUXER APPROACH
    // One MPEGTS muxer for the entire stream - segments are collected via flush()
    // No timestamp rebasing needed - FFmpeg handles A/V sync naturally
    // ═══════════════════════════════════════════════════════════════════════════

    let segmentBuffer = []  // Collects data for current segment
    let totalWriteCount = 0

    /**
     * Create the continuous muxer (called once at start)
     */
    const createContinuousMuxer = (hasAudio) => {
      segmentBuffer = []

      const io = new ffmpeg.IOContext(1024 * 1024, {
        onwrite: (data) => {
          totalWriteCount++
          // Copy buffer to avoid shared memory issues
          const copy = Buffer.alloc(data.length)
          for (let i = 0; i < data.length; i++) copy[i] = data[i]
          segmentBuffer.push(copy)
          return data.length
        },
        onseek: () => 0
      })

      const format = new ffmpeg.OutputFormatContext('mpegts', io)

      // Create video stream with MPEGTS timebase
      const vidStream = format.createStream()
      vidStream.codecParameters.type = ffmpeg.constants.mediaTypes.VIDEO
      vidStream.codecParameters.id = ffmpeg.constants.codecs.H264
      vidStream.codecParameters.width = videoStream.codecParameters.width
      vidStream.codecParameters.height = videoStream.codecParameters.height
      vidStream.codecParameters.format = encoderPixelFormat
      vidStream.timeBase = { numerator: 1, denominator: 90000 }  // MPEGTS timebase

      // Copy encoder extradata if available (note: property is extraData in bare-ffmpeg)
      if (videoEncoder?.extradata?.length > 0) {
        vidStream.codecParameters.extraData = videoEncoder.extradata
        console.log('[HlsTranscoder] Video extraData copied:', videoEncoder.extradata.length, 'bytes')
      }

      // Create audio stream if needed
      let audStream = null
      if (hasAudio && audioEncoder) {
        audStream = format.createStream()
        audStream.codecParameters.fromContext(audioEncoder)
        audStream.timeBase = { numerator: 1, denominator: 90000 }  // MPEGTS timebase

        // Log audio codec parameters for debugging
        const audCP = audStream.codecParameters
        console.log('[HlsTranscoder] Audio stream codecParams:',
          'id=' + audCP.id, 'sampleRate=' + audCP.sampleRate,
          'nbChannels=' + audCP.nbChannels, 'profile=' + audCP.profile,
          'extraData.length=' + (audCP.extraData?.length || 0))

        // Generate AAC AudioSpecificConfig (ASC) if not available from encoder
        // ASC format: 5 bits object type + 4 bits sample rate index + 4 bits channel config + 3 bits padding
        // For AAC-LC (type=2), 48kHz (index=3), stereo (config=2): 0x11 0x90
        // NOTE: Use extraData (camelCase) - bare-ffmpeg's property name
        let aacExtraData = audioEncoder.extraData
        console.log('[HlsTranscoder] Encoder extraData check:', aacExtraData?.length || 0, 'bytes')

        if (!aacExtraData || aacExtraData.length === 0) {
          // Manually create ASC for Chromecast compatibility
          // CRITICAL: Chromecast requires valid AAC AudioSpecificConfig in MPEGTS PMT
          const sampleRate = audioEncoder.sampleRate || 48000
          const channels = audioEncoder.channelLayout?.nbChannels || 2

          // Sample rate index lookup (ISO 14496-3)
          const sampleRateIndex = {
            96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5,
            24000: 6, 22050: 7, 16000: 8, 12000: 9, 11025: 10, 8000: 11
          }[sampleRate] || 3  // Default to 48kHz

          // AAC-LC object type = 2 (most compatible)
          // ASC = (objectType << 11) | (sampleRateIndex << 7) | (channelConfig << 3)
          const asc = (2 << 11) | (sampleRateIndex << 7) | (channels << 3)
          aacExtraData = Buffer.alloc(2)
          aacExtraData[0] = (asc >> 8) & 0xFF
          aacExtraData[1] = asc & 0xFF

          console.log('[HlsTranscoder] Generated AAC ASC: 0x' + aacExtraData[0].toString(16).padStart(2, '0') +
            ' 0x' + aacExtraData[1].toString(16).padStart(2, '0'),
            '(objectType=2, sampleRateIdx=' + sampleRateIndex + ', channels=' + channels + ')')
        } else {
          console.log('[HlsTranscoder] Using encoder AAC extraData:', aacExtraData.length, 'bytes,',
            '0x' + aacExtraData[0]?.toString(16).padStart(2, '0'), '0x' + aacExtraData[1]?.toString(16).padStart(2, '0'))
        }

        // Set the extraData on the stream codec parameters
        // This is CRITICAL for Chromecast - the ASC must be in the MPEGTS PMT descriptor
        audStream.codecParameters.extraData = aacExtraData

        // Verify it was set correctly
        const verifyExtraData = audStream.codecParameters.extraData
        console.log('[HlsTranscoder] AAC extraData verification:', verifyExtraData?.length || 0, 'bytes',
          verifyExtraData ? '0x' + verifyExtraData[0]?.toString(16).padStart(2, '0') + ' 0x' + verifyExtraData[1]?.toString(16).padStart(2, '0') : 'NULL')
      }

      // Write header with muxer options for Chromecast compatibility
      // - pat_pmt_at_frames: Write PAT/PMT at each keyframe for segment independence
      // - pcr_period: Frequent PCR timestamps for player sync
      // - pes_payload_size: Limit PES packet size for better compatibility
      const muxerOpts = ffmpeg.Dictionary.from({
        'mpegts_flags': 'pat_pmt_at_frames',
        'pcr_period': '20',
        'pes_payload_size': '2930',  // Optimal for HLS streaming
      })
      format.writeHeader(muxerOpts)

      // Log audio stream details for Chromecast debugging
      if (audStream) {
        console.log('[HlsTranscoder] Audio stream for muxer:',
          'index=' + audStream.index,
          'codecId=' + audStream.codecParameters.id,
          'sampleRate=' + audStream.codecParameters.sampleRate,
          'channels=' + audStream.codecParameters.nbChannels,
          'extraData=' + (audStream.codecParameters.extraData?.length || 0) + ' bytes')
      }

      console.log('[HlsTranscoder] Created continuous muxer, hasAudio:', hasAudio,
        'audioStream:', audStream ? 'index=' + audStream.index : 'null')

      return { io, format, videoStream: vidStream, audioStream: audStream }
    }

    /**
     * Flush muxer and collect current segment data
     * Called at keyframe boundaries
     */
    // Track pending segment storage promises so we can await them at finalization
    const pendingSegmentStorage = []

    /**
     * Flush muxer and store segment data - NON-BLOCKING
     * Storage happens in background to avoid blocking transcoding throughput
     */
    const flushAndStoreSegment = (muxer, segmentIdx, duration) => {
      // Flush muxer's internal interleave buffer (synchronous)
      try {
        muxer.format.flush()
      } catch (flushErr) {
        console.log('[HlsTranscoder] Segment', segmentIdx, 'flush warning:', flushErr?.message)
      }

      // Collect segment data - this captures the buffer immediately
      const data = Buffer.concat(segmentBuffer)
      segmentBuffer = []  // Clear for next segment

      if (data.length > 1000 && duration > 0.1) {
        console.log('[HlsTranscoder] Segment', segmentIdx, '- duration:', duration.toFixed(2) + 's, size:', Math.round(data.length / 1024) + 'KB')

        // Fire-and-forget storage - don't block the transcode loop
        const storagePromise = segmentManager.addSegment(segmentIdx, duration, data)
          .then(() => {
            console.log('[HlsTranscoder] Segment', segmentIdx, 'STORED successfully')
          })
          .catch((addErr) => {
            console.error('[HlsTranscoder] Segment', segmentIdx, 'FAILED to store:', addErr?.message)
          })

        pendingSegmentStorage.push(storagePromise)
      } else {
        console.log('[HlsTranscoder] Segment', segmentIdx, 'skipped (too small):', data.length, 'bytes')
      }
    }

    /**
     * Finalize the muxer at end of stream
     * Awaits all pending segment storage to ensure nothing is lost
     */
    const finalizeContinuousMuxer = async (muxer, segmentIdx, duration) => {
      try {
        muxer.format.writeTrailer()
      } catch (err) {
        console.log('[HlsTranscoder] Final segment writeTrailer warning:', err?.message)
      }

      // Collect final segment data
      const data = Buffer.concat(segmentBuffer)
      segmentBuffer = []

      if (data.length > 1000 && duration > 0.1) {
        console.log('[HlsTranscoder] Final segment', segmentIdx, '- duration:', duration.toFixed(2) + 's, size:', Math.round(data.length / 1024) + 'KB')
        try {
          await segmentManager.addSegment(segmentIdx, duration, data)
          console.log('[HlsTranscoder] Final segment', segmentIdx, 'STORED successfully')
        } catch (addErr) {
          console.error('[HlsTranscoder] Final segment', segmentIdx, 'FAILED to store:', addErr?.message)
        }
      }

      // Wait for all pending segment storage to complete before finishing
      if (pendingSegmentStorage.length > 0) {
        console.log('[HlsTranscoder] Waiting for', pendingSegmentStorage.length, 'pending segments to finish storage...')
        await Promise.all(pendingSegmentStorage)
        console.log('[HlsTranscoder] All segments stored')
      }

      // Cleanup
      try { muxer.format.destroy() } catch {}
    }
    // ═══════════════════════════════════════════════════════════════════════════

    // Video decoder - use stream's decoder() helper which copies codec parameters
    // This is critical for HEVC which needs extradata (VPS/SPS/PPS)
    try {
      videoDecoder = videoStream.decoder()
      console.log('[HlsTranscoder] Video decoder created via stream.decoder()')
    } catch (e) {
      // Fallback to manual creation if stream.decoder() fails
      console.log('[HlsTranscoder] stream.decoder() failed, creating manually:', e?.message)
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

    // Get actual pixel format from decoder after opening (may differ from stream metadata)
    const decoderPixelFormat = videoDecoder.pixelFormat
    console.log('[HlsTranscoder] Decoder pixel format:', decoderPixelFormat)

    videoEncoder = new ffmpeg.CodecContext(h264Selection.encoder)
    videoEncoder.width = videoStream.codecParameters.width
    videoEncoder.height = videoStream.codecParameters.height
    videoEncoder.pixelFormat = encoderPixelFormat
    videoEncoder.timeBase = { numerator: 1, denominator: 1000 }  // Use milliseconds timebase for encoder
    videoEncoder.bitRate = 8000000 // 8 Mbps
    videoEncoder.gopSize = 48 // Keyframe every ~2 seconds
    videoEncoder.maxBFrames = 0

    // Set frame rate (important for hardware encoders)
    // Get from stream's avgFramerate, fall back to decoder or default 24fps
    let inputFrameRate = videoStream.avgFramerate
    if (!inputFrameRate || inputFrameRate.numerator === 0) {
      inputFrameRate = videoDecoder?.frameRate
    }
    if (!inputFrameRate || inputFrameRate.numerator === 0) {
      inputFrameRate = { numerator: 24, denominator: 1 }
    }
    console.log('[HlsTranscoder] Frame rate:', inputFrameRate.numerator + '/' + inputFrameRate.denominator)
    try {
      videoEncoder.frameRate = inputFrameRate
    } catch (e) {
      // Some encoders don't support setting frameRate, continue anyway
      console.log('[HlsTranscoder] Could not set frame rate:', e?.message)
    }

    // CRITICAL: Set libx264 options BEFORE open() to force no B-frames
    // The maxBFrames property alone may not be applied
    if (!h264Selection.isHardware) {
      // CRITICAL: Clear GLOBAL_HEADER flag to force SPS/PPS in bitstream
      // This makes each IDR frame self-contained (required for HLS segment independence)
      // AV_CODEC_FLAG_GLOBAL_HEADER = 0x00400000 = 4194304
      try {
        const currentFlags = videoEncoder.flags || 0
        const GLOBAL_HEADER_FLAG = 0x00400000
        if (currentFlags & GLOBAL_HEADER_FLAG) {
          videoEncoder.flags = currentFlags & ~GLOBAL_HEADER_FLAG
          console.log('[HlsTranscoder] Cleared GLOBAL_HEADER flag for inline SPS/PPS')
        } else {
          console.log('[HlsTranscoder] GLOBAL_HEADER flag not set, SPS/PPS will be inline')
        }
      } catch (flagsErr) {
        console.log('[HlsTranscoder] Could not modify encoder flags:', flagsErr?.message)
      }

      // Try each option individually since some may not be supported
      // Optimized for FAST transcoding to build segment look-ahead buffer
      const optionsToSet = [
        ['preset', 'ultrafast'],  // Fastest encoding preset
        ['profile', 'high'],      // CRITICAL: High profile for Chromecast compatibility (not Baseline)
        ['level', '4.1'],         // Level 4.1 for 1080p support
        ['bf', '0'],              // Explicitly disable B-frames for lowest latency
        ['tune', 'zerolatency'],  // Low latency tuning
        ['g', '48'],              // GOP size (~2 sec at 24fps) for seeking
        ['threads', '0'],         // Auto-detect threads (use all CPU cores)
        ['thread_type', 'slice'], // Slice-based threading for lower latency
        // CRITICAL: Use x264-params to pass repeat-headers directly to x264
        // This ensures SPS/PPS is included with every keyframe for HLS segment independence
        ['x264-params', 'repeat-headers=1:bframes=0:annexb=1:sliced-threads=1'],
      ]
      const setOptions = []
      for (const [key, value] of optionsToSet) {
        try {
          videoEncoder.setOption(key, value)
          setOptions.push(`${key}=${value}`)
        } catch (e) {
          console.log('[HlsTranscoder] libx264 option', key, 'failed:', e?.message || 'unknown')
        }
      }
      console.log('[HlsTranscoder] libx264 options set:', setOptions.join(', ') || 'none')
    } else {
      // Hardware encoders (h264_mediacodec, h264_videotoolbox)
      // CRITICAL: Must disable B-frames to prevent MPEGTS muxer errors
      const hwOptions = [
        // B-frame disabling - MUST be set to prevent writeFrame errors
        ['max_b_frames', '0'],     // FFmpeg AVOption for max B-frames
        ['bf', '0'],               // Alternative B-frame option name
        // Use constrained_baseline profile - NO B-frames by definition
        // (main profile allows B-frames which causes MPEGTS DTS errors)
        ['profile', 'constrained_baseline'],
        ['level', '4.0'],          // Level 4.0 for baseline compatibility
        // Bitrate and GOP settings
        ['b', '8000000'],          // 8 Mbps bitrate
        ['g', '48'],               // GOP size in frames
        ['i-frame-interval', '2'], // MediaCodec-specific: keyframe every 2 seconds
      ]
      const hwSetOptions = []
      for (const [key, value] of hwOptions) {
        try {
          videoEncoder.setOption(key, value)
          hwSetOptions.push(`${key}=${value}`)
        } catch (e) {
          // Some options may not be supported by specific encoder
          console.log('[HlsTranscoder] HW encoder option', key, 'failed:', e?.message || 'unknown')
        }
      }
      console.log('[HlsTranscoder] HW encoder options set:', hwSetOptions.join(', ') || 'none')
    }

    videoEncoder.open()
    console.log('[HlsTranscoder] Video encoder opened')

    // CRITICAL: Copy encoder's extradata (SPS/PPS) to output stream's codecParameters
    // H.264 in MPEGTS needs SPS/PPS for proper playback
    let spsPpsNalus = null  // Will store Annex B format SPS/PPS for manual injection
    try {
      if (videoEncoder.extradata && videoEncoder.extradata.length > 0) {
        const extradata = videoEncoder.extradata
        // NOTE: Continuous muxer uses encoder extradata set during createContinuousMuxer()
        console.log('[HlsTranscoder] H.264 extradata available:', extradata.length, 'bytes')

        // Log extradata hex for debugging
        const hexPreview = Array.from(extradata.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' ')
        console.log('[HlsTranscoder] Extradata hex (first 32 bytes):', hexPreview)

        // Check if extradata is AVCC format (starts with 0x01) or Annex B (starts with 0x00 0x00)
        if (extradata[0] === 0x01) {
          console.log('[HlsTranscoder] Extradata is AVCC format - will convert to Annex B for segment injection')
          spsPpsNalus = convertAvccToAnnexB(extradata)
        } else if (extradata[0] === 0x00 && extradata[1] === 0x00) {
          console.log('[HlsTranscoder] Extradata is Annex B format')
          spsPpsNalus = Buffer.from(extradata)
        } else {
          console.log('[HlsTranscoder] Unknown extradata format, first byte:', extradata[0])
        }

        if (spsPpsNalus) {
          console.log('[HlsTranscoder] SPS/PPS NALUs prepared for injection:', spsPpsNalus.length, 'bytes')
        }
      } else {
        console.warn('[HlsTranscoder] WARNING: No H.264 extradata available from encoder')
      }
    } catch (extradataErr) {
      console.warn('[HlsTranscoder] Could not copy H.264 extradata:', extradataErr?.message)
    }

    // Scaler - convert from decoder output format to encoder input format
    // Use decoder's actual pixel format (not stream metadata which may be NONE)
    let inputPixelFormat = decoderPixelFormat
    // If decoder format is still NONE/0/-1, default to YUV420P (most common for video)
    // This can happen when the codec hasn't decoded a frame yet
    const NONE = ffmpeg.constants.pixelFormats.NONE
    if (!inputPixelFormat || inputPixelFormat === NONE || inputPixelFormat === 0 || inputPixelFormat < 0) {
      inputPixelFormat = ffmpeg.constants.pixelFormats.YUV420P
      console.log('[HlsTranscoder] Decoder format unknown (' + decoderPixelFormat + '), assuming YUV420P (' + inputPixelFormat + ')')
    }

    // Always create scaler if formats differ
    if (inputPixelFormat !== encoderPixelFormat) {
      const width = videoStream.codecParameters.width
      const height = videoStream.codecParameters.height
      console.log('[HlsTranscoder] Creating scaler:', inputPixelFormat, '->', encoderPixelFormat, '(' + width + 'x' + height + ')')
      // Scaler args: srcPixelFormat, srcWidth, srcHeight, dstPixelFormat, dstWidth, dstHeight
      scaler = new ffmpeg.Scaler(
        inputPixelFormat,
        width,
        height,
        encoderPixelFormat,
        width,
        height
      )
    } else {
      console.log('[HlsTranscoder] No scaler needed, formats match:', inputPixelFormat)
    }

    // Audio setup - decoder and encoder (per-segment muxer handles output streams)
    console.log('[HlsTranscoder] Audio stream available:', !!audioStream)
    if (audioStream) {
      // Audio decoder - use stream's decoder() helper which copies codec parameters
      // This ensures extradata and other codec-specific data is properly transferred
      try {
        audioDecoder = audioStream.decoder()
        console.log('[HlsTranscoder] Audio decoder created via stream.decoder()')
      } catch (e) {
        // Fallback to manual creation if stream.decoder() fails
        console.log('[HlsTranscoder] stream.decoder() failed, creating manually:', e?.message)
        const decoderSelection = selectDecoderForId(audioStream.codecParameters.id)
        if (!decoderSelection) {
          throw new Error('Audio decoder not available')
        }
        audioDecoder = new ffmpeg.CodecContext(decoderSelection.decoder)
        // Copy codec parameters from stream (includes extradata)
        audioStream.codecParameters.toContext(audioDecoder)
      }
      console.log('[HlsTranscoder] Setting audio decoder timeBase... audioStream.timeBase:', audioStream.timeBase)
      audioDecoder.timeBase = audioStream.timeBase
      console.log('[HlsTranscoder] Opening audio decoder...')
      audioDecoder.open()
      console.log('[HlsTranscoder] Audio decoder opened successfully')

      console.log('[HlsTranscoder] Selecting AAC encoder...')
      const aacSelection = selectAacEncoder()
      console.log('[HlsTranscoder] AAC encoder selection result:', aacSelection ? aacSelection.name : 'null')
      if (!aacSelection) {
        throw new Error('AAC encoder not available')
      }
      console.log('[HlsTranscoder] Using AAC encoder:', aacSelection.name)
      audioEncoder = new ffmpeg.CodecContext(aacSelection.encoder)

      // Configure AAC encoder using CORRECT bare-ffmpeg API
      // CodecContext properties: sampleRate, sampleFormat, channelLayout, timeBase
      // Use setOption() for: bitrate ('b'), profile ('profile')
      const targetSampleRate = 48000

      try {
        // Set required CodecContext properties
        audioEncoder.sampleRate = targetSampleRate
        audioEncoder.sampleFormat = ffmpeg.constants.sampleFormats.FLTP
        audioEncoder.timeBase = { numerator: 1, denominator: targetSampleRate }

        // Set stereo channel layout - use the constant or number
        // ffmpeg.constants.channelLayouts.STEREO or just pass number/string
        audioEncoder.channelLayout = ffmpeg.constants.channelLayouts.STEREO
        console.log('[HlsTranscoder] Set channelLayout to STEREO')

        // Set codec options via setOption() - bitrate and profile
        try {
          audioEncoder.setOption('b', '128000')  // 128 kbps bitrate
          console.log('[HlsTranscoder] Set audio bitrate to 128k')
        } catch (e) {
          console.log('[HlsTranscoder] Could not set bitrate option:', e?.message)
        }

        // Set AAC profile to LC (Low Complexity) via option
        try {
          audioEncoder.setOption('profile', 'aac_low')  // AAC-LC profile
          console.log('[HlsTranscoder] Set AAC profile to aac_low (LC)')
        } catch (e) {
          console.log('[HlsTranscoder] Could not set profile option:', e?.message)
        }

        // Try additional encoder options
        try { audioEncoder.setOption('aac_coder', 'twoloop') } catch {}
        try { audioEncoder.setOption('aac_pns', '0') } catch {}

        console.log('[HlsTranscoder] Audio encoder config before open:',
          'sampleRate=' + audioEncoder.sampleRate,
          'sampleFormat=' + audioEncoder.sampleFormat,
          'channelLayout.nbChannels=' + audioEncoder.channelLayout?.nbChannels)

        console.log('[HlsTranscoder] Opening audio encoder...')
        audioEncoder.open()
        console.log('[HlsTranscoder] Audio encoder opened successfully')

        // After open(), log actual encoder values (with defensive try/catch)
        try {
          console.log('[HlsTranscoder] Getting audio encoder timeBase...')
          const aEncTB = audioEncoder.timeBase
          console.log('[HlsTranscoder] Audio encoder after open:',
            'timeBase=' + aEncTB?.numerator + '/' + aEncTB?.denominator,
            'frameSize=' + audioEncoder.frameSize)  // frameSize is read-only, set by encoder
        } catch (tbErr) {
          console.error('[HlsTranscoder] Error accessing audio encoder properties:', tbErr?.message)
        }
        // NOTE: Continuous muxer copies encoder params during createContinuousMuxer()
      } catch (audioEncErr) {
        console.error('[HlsTranscoder] Audio encoder setup FAILED:', audioEncErr?.message)
        // Fail fast - audio transcoding is required for Chromecast compatibility
        throw new Error('Audio transcoding failed: ' + (audioEncErr?.message || 'AAC encoder setup failed'))
      }

      // Continue with audio setup if encoder opened successfully
      if (audioEncoder) {
        // Log extradata availability (will be used by continuous muxer via fromContext)
        if (audioEncoder.extradata && audioEncoder.extradata.length > 0) {
          console.log('[HlsTranscoder] AAC extradata available:', audioEncoder.extradata.length, 'bytes')
        } else {
          console.warn('[HlsTranscoder] WARNING: No AAC extradata available from encoder')
        }

        console.log('[HlsTranscoder] Creating resampler...')

        try {
          // Get source audio properties using correct bare-ffmpeg API
          const srcSampleRate = audioDecoder.sampleRate || 48000
          const srcSampleFormat = audioDecoder.sampleFormat

          // IMPORTANT: Pass ChannelLayout object directly to Resampler, not integer mask
          // The Resampler constructor uses ChannelLayout.from() which handles objects via copyChannelLayout
          // This preserves the exact layout including non-standard variants like 5.1(side)
          let srcChannelLayout = audioDecoder.channelLayout
          const srcChannels = srcChannelLayout?.nbChannels || 2
          const srcMask = srcChannelLayout?.mask || 0

          console.log('[HlsTranscoder] Source audio: channelLayout.mask=' + srcMask +
            ' nbChannels=' + srcChannels)

          // If mask is 0/invalid, fall back to a default constant
          if (!srcMask || srcMask === 0) {
            // Use constants directly (not integer masks) for proper ChannelLayout handling
            const defaultLayouts = {
              1: ffmpeg.constants.channelLayouts.MONO,
              2: ffmpeg.constants.channelLayouts.STEREO,
              6: ffmpeg.constants.channelLayouts['5.1'],
              8: ffmpeg.constants.channelLayouts['7.1']
            }
            srcChannelLayout = defaultLayouts[srcChannels] || ffmpeg.constants.channelLayouts.STEREO
            console.log('[HlsTranscoder] Using default channelLayout for', srcChannels, 'channels')
          }

          // Force stereo output regardless of input channel count
          const dstSampleRate = audioEncoder.sampleRate
          const dstChannelLayout = ffmpeg.constants.channelLayouts.STEREO  // Use constant
          const dstSampleFormat = audioEncoder.sampleFormat

          console.log('[HlsTranscoder] Resampler params: src sampleRate=' + srcSampleRate +
            ' channelLayoutMask=' + srcMask + ' sampleFormat=' + srcSampleFormat)
          console.log('[HlsTranscoder] Resampler params: dst sampleRate=' + dstSampleRate +
            ' channelLayout=STEREO sampleFormat=' + dstSampleFormat)

          // CRITICAL: bare-ffmpeg Resampler constructor order is:
          // inputSampleRate, inputChannelLayout, inputSampleFormat,
          // outputSampleRate, outputChannelLayout, outputSampleFormat
          // See: packages/bare-ffmpeg/docs/resampler.md
          resampler = new ffmpeg.Resampler(
            srcSampleRate,
            srcChannelLayout,
            srcSampleFormat,
            dstSampleRate,
            dstChannelLayout,
            dstSampleFormat
          )

          console.log('[HlsTranscoder] Resampler created, audio setup complete')
        } catch (resamplerErr) {
          console.error('[HlsTranscoder] Resampler creation FAILED:', resamplerErr?.message)
          // Fail fast - audio transcoding is required for Chromecast compatibility
          throw new Error('Audio resampler failed: ' + (resamplerErr?.message || 'Resampler setup failed'))
        }
      }
    }

    // Pre-calculate timebase conversion factor for frame PTS rescaling
    const inputTB = videoStream.timeBase
    const encoderTB = videoEncoder.timeBase
    const rescaleNum = inputTB.numerator * encoderTB.denominator
    const rescaleDen = inputTB.denominator * encoderTB.numerator
    console.log('[HlsTranscoder] PTS rescale: input TB', inputTB.numerator + '/' + inputTB.denominator,
      '-> encoder TB', encoderTB.numerator + '/' + encoderTB.denominator)

    // Allocate persistent frames and packets (reused across segments)
    packet = new ffmpeg.Packet()
    videoFrame = new ffmpeg.Frame()
    scaledFrame = new ffmpeg.Frame()
    audioFrame = new ffmpeg.Frame()
    resampledFrame = new ffmpeg.Frame()
    outputPacket = new ffmpeg.Packet()
    console.log('[HlsTranscoder] Packets and frames allocated')

    if (scaler) {
      scaledFrame.width = videoStream.codecParameters.width
      scaledFrame.height = videoStream.codecParameters.height
      scaledFrame.format = encoderPixelFormat
      scaledFrame.alloc()
    }

    const hasAudio = !!audioStream && !!audioEncoder
    const aacFrameSize = 1024  // AAC-LC always uses 1024 samples per frame
    if (hasAudio) {
      resampledFrame.format = audioEncoder.sampleFormat
      resampledFrame.channelLayout = ffmpeg.constants.channelLayouts.STEREO
      resampledFrame.sampleRate = audioEncoder.sampleRate
      // CRITICAL: Allocate extra samples for resampling ratio differences
      // When resampling 44100->48000 Hz, 1024 input samples become ~1114 output samples
      // Allocate 4096 to handle any ratio plus resampler's internal buffering flush
      resampledFrame.nbSamples = 4096
      resampledFrame.alloc()
      console.log('[HlsTranscoder] resampledFrame allocated with 4096 samples buffer')

      // AudioFIFO: Buffers resampled samples and outputs exact frame sizes for encoder
      // E-AC3/DDP = 1536 samples/frame, AAC = 1024 samples/frame - FIFO handles the mismatch
      audioFifo = new ffmpeg.AudioFIFO(
        audioEncoder.sampleFormat,  // Output format from resampler
        2,  // Stereo channels
        aacFrameSize * 4  // Initial buffer for 4 AAC frames
      )
      console.log('[HlsTranscoder] AudioFIFO created, initial capacity:', aacFrameSize * 4, 'samples')

      // Encoder frame: Used to read exact frame size from FIFO
      encoderFrame = new ffmpeg.Frame()
      encoderFrame.format = audioEncoder.sampleFormat
      encoderFrame.channelLayout = ffmpeg.constants.channelLayouts.STEREO
      encoderFrame.sampleRate = audioEncoder.sampleRate
      encoderFrame.nbSamples = aacFrameSize
      encoderFrame.alloc()
      console.log('[HlsTranscoder] encoderFrame allocated with', aacFrameSize, 'samples (AAC frame size)')
    }

    console.log('[HlsTranscoder] Audio setup summary: hasAudio:', hasAudio,
      'audioStream:', audioStream ? 'index=' + audioStream.index : 'null',
      'audioEncoder:', audioEncoder ? 'sampleRate=' + audioEncoder.sampleRate : 'null')
    console.log('[HlsTranscoder] Starting decode/encode loop (CONTINUOUS MUXER - no timestamp rebasing)...')

    let packetCount = 0
    let lastProgressPct = 0
    let bytesProcessed = 0

    const videoTimeBase = videoStream.timeBase
    const ptsToSeconds = (pts) => {
      if (!pts || pts < 0) return 0
      return (pts * videoTimeBase.numerator) / videoTimeBase.denominator
    }

    // Segmentation state
    let segmentIndex = 0
    let segmentStartPts = 0  // In seconds, for segment duration calculation
    let lastKeyframePts = 0
    const TARGET_SEGMENT_DURATION = 2.0

    // Create the ONE continuous muxer (used for entire stream)
    continuousMuxer = createContinuousMuxer(hasAudio)

    console.log('[HlsTranscoder] segmentManager check:', typeof segmentManager, 'addSegment:', typeof segmentManager?.addSegment)

    let firstVideoFrame = true
    let firstAudioFrame = true
    let firstVideoPtsMs = 0  // Track first video PTS to sync audio
    let videoFrameCount = 0
    let audioFrameCount = 0
    let totalEncoderPackets = 0  // Track video encoder packets
    let totalAudioPackets = 0    // Track audio input packets
    let totalAudioEncoderPackets = 0  // Track audio encoder output packets
    let audioSamplesSent = 0  // Track total samples sent to encoder for stats
    let audioBasePtsMs = null  // First audio packet PTS (set once)
    let audioSamplesOutput = 0  // Track samples output by encoder for PTS calculation

    while (inputFormat.readFrame(packet)) {
      // CRITICAL: Set busy flag while processing FFmpeg data
      // This prevents HTTP handler from accessing segment data mid-operation
      transcodingBusy++

      packetCount++
      const packetBytes = packet.data ? packet.data.length : 0
      bytesProcessed += packetBytes

      if (packetCount <= 5) {
        console.log('[HlsTranscoder] Packet', packetCount, 'stream:', packet.streamIndex, 'size:', packetBytes)
      }

      if (packet.streamIndex === videoStream.index) {
        packet.timeBase = videoStream.timeBase

        if (packetCount <= 5) console.log('[HlsTranscoder] Sending video packet to decoder...')
        try {
          if (videoDecoder.sendPacket(packet)) {
            if (packetCount <= 5) console.log('[HlsTranscoder] Video packet sent, receiving frames...')
            while (videoDecoder.receiveFrame(videoFrame)) {
              videoFrameCount++
              if (firstVideoFrame) {
                // Record first video PTS for audio sync
                const originalPts = videoFrame.pts || 0
                firstVideoPtsMs = Math.round((originalPts * rescaleNum) / rescaleDen)
                console.log('[HlsTranscoder] First video frame received, format:', videoFrame.format,
                  'size:', videoFrame.width, 'x', videoFrame.height, 'firstVideoPtsMs:', firstVideoPtsMs)
                firstVideoFrame = false
              }

              let frameToEncode = videoFrame

              if (scaler) {
                if (packetCount <= 5) console.log('[HlsTranscoder] Scaling frame...')
                try {
                  scaler.scale(videoFrame, scaledFrame)
                  // CRITICAL: Rescale PTS from decoder timebase to encoder timebase
                  // This fixes the duration issue (segments showing ~85ms instead of ~5s)
                  const originalPts = videoFrame.pts || 0
                  const rescaledPts = Math.round((originalPts * rescaleNum) / rescaleDen)
                  scaledFrame.pts = rescaledPts
                  scaledFrame.timeBase = encoderTB
                  frameToEncode = scaledFrame
                  if (packetCount <= 5) console.log('[HlsTranscoder] Frame scaled, pts:', originalPts, '->', rescaledPts)
                } catch (scaleErr) {
                  console.error('[HlsTranscoder] Scale error at frame', videoFrameCount, ':', scaleErr?.message || scaleErr)
                  continue // Skip this frame
                }
              } else {
                // No scaler, but still need to rescale PTS for encoder
                // Since we can't modify the original frame, we'll use scaledFrame as a container
                // Copy frame data and rescale PTS
                const originalPts = videoFrame.pts || 0
                const rescaledPts = Math.round((originalPts * rescaleNum) / rescaleDen)
                // For non-scaled path, we need to set pts on the frame going to encoder
                // Since we can't modify videoFrame directly, we'll track rescaled pts separately
                videoFrame.pts = rescaledPts  // This may cause issues - see below
                videoFrame.timeBase = encoderTB
                if (packetCount <= 5) console.log('[HlsTranscoder] Frame pts rescaled:', originalPts, '->', rescaledPts)
              }

            const framePts = frameToEncode.pts

            if (videoFrameCount <= 5 || videoFrameCount % 500 === 0) {
              console.log('[HlsTranscoder] Frame', videoFrameCount, 'pts:', framePts)
            }

            // Track the frame PTS for output packet timestamping
            // libx264 may not preserve our input PTS, so we need to override
            const currentFramePtsMs = framePts  // Already in encoder timebase (milliseconds)

            if (packetCount <= 5) console.log('[HlsTranscoder] Sending frame to encoder, pts:', framePts)
            try {
              // Send the frame to encoder
              if (videoEncoder.sendFrame(frameToEncode)) {
                if (packetCount <= 5) console.log('[HlsTranscoder] Frame sent, receiving packets...')
                while (videoEncoder.receivePacket(outputPacket)) {
                  totalEncoderPackets++
                  const isKeyframe = (outputPacket.flags & 1) !== 0
                  const packetSize = outputPacket.data ? outputPacket.data.length : 0

                  // Defensive check: verify packet has valid data
                  if (!outputPacket.data || packetSize === 0) {
                    console.warn('[HlsTranscoder] Warning: encoder packet #' + totalEncoderPackets + ' has no data, skipping')
                    outputPacket.unref()
                    continue
                  }

                  // FIXED: Use encoder's native output PTS - it correctly tracks buffering/delay
                  // Previous bug: overwriting with currentFramePtsMs caused non-monotonic DTS
                  // because encoder output packets don't correspond 1:1 to input frames
                  const encTB = videoEncoder.timeBase  // 1/1000 (milliseconds)
                  const encoderPtsMs = outputPacket.pts || 0  // Encoder's output PTS in ms

                  // Convert to seconds for segment timing calculation
                  // Encoder timebase is 1/1000, so pts in seconds = outputPacket.pts / 1000
                  const pts = encoderPtsMs / 1000

                  if (totalEncoderPackets === 1) {
                    console.log('[HlsTranscoder] First encoder packet! pts:', pts.toFixed(2), 'keyframe:', isKeyframe, 'size:', packetSize,
                      'encoderPtsMs:', encoderPtsMs, 'inputFramePts:', currentFramePtsMs, 'encTB:', encTB.numerator + '/' + encTB.denominator)
                  } else if (totalEncoderPackets % 500 === 0) {
                    console.log('[HlsTranscoder] Encoder packet #' + totalEncoderPackets + ' pts:', pts.toFixed(2), 'keyframe:', isKeyframe, 'encoderPtsMs:', encoderPtsMs)
                  }

                  // On keyframe: check if we should start a new segment
                  if (isKeyframe) {
                    const segmentDuration = pts - segmentStartPts
                    if (segmentDuration >= TARGET_SEGMENT_DURATION && continuousMuxer) {
                      // Flush current segment data - NON-BLOCKING (storage in background)
                      flushAndStoreSegment(continuousMuxer, segmentIndex, segmentDuration)
                      segmentIndex++
                      segmentStartPts = pts
                      // Note: NO new muxer created - we continue with the same one
                    }
                    lastKeyframePts = pts

                    // CRITICAL: Hardware encoders only include SPS/PPS in first keyframe
                    // For HLS segments to be independently decodable, we need SPS/PPS in EVERY keyframe
                    // Check ALL keyframes and inject SPS/PPS when missing
                    try {
                      const packetData = outputPacket.data
                      let hasSPS = false, hasPPS = false, hasIDR = false
                      let spsStart = -1, ppsStart = -1, idrStart = -1

                      // Scan packet for NAL units
                      for (let i = 0; i < Math.min(packetData.length - 4, 2000); i++) {
                        // Check for 4-byte start code (0x00 0x00 0x00 0x01)
                        if (packetData[i] === 0 && packetData[i+1] === 0 && packetData[i+2] === 0 && packetData[i+3] === 1) {
                          const nalType = packetData[i+4] & 0x1f
                          if (nalType === 7) { hasSPS = true; spsStart = i }
                          if (nalType === 8) { hasPPS = true; ppsStart = i }
                          if (nalType === 5) { hasIDR = true; idrStart = i }
                        // Check for 3-byte start code (0x00 0x00 0x01)
                        } else if (packetData[i] === 0 && packetData[i+1] === 0 && packetData[i+2] === 1) {
                          const nalType = packetData[i+3] & 0x1f
                          if (nalType === 7) { hasSPS = true; spsStart = i }
                          if (nalType === 8) { hasPPS = true; ppsStart = i }
                          if (nalType === 5) { hasIDR = true; idrStart = i }
                        }
                      }

                      // Log for first few keyframes or periodically
                      if (totalEncoderPackets <= 5 || segmentIndex <= 3 || segmentIndex % 10 === 0) {
                        console.log('[HlsTranscoder] Keyframe #' + totalEncoderPackets + ' seg ' + segmentIndex +
                          ': SPS=' + hasSPS + ' PPS=' + hasPPS + ' IDR=' + hasIDR)
                      }

                      // HARDWARE ENCODER FIX: Extract SPS/PPS from first keyframe if not yet captured
                      if (hasSPS && hasPPS && !spsPpsNalus) {
                        // First keyframe with SPS/PPS - extract and save for later injection
                        console.log('[HlsTranscoder] Extracting SPS/PPS from first hardware encoder keyframe')

                        // Extract SPS and PPS NAL units from packet
                        const nalUnits = []
                        let i = 0
                        while (i < packetData.length - 4) {
                          // Find start code
                          let startCodeLen = 0
                          if (packetData[i] === 0 && packetData[i+1] === 0 && packetData[i+2] === 0 && packetData[i+3] === 1) {
                            startCodeLen = 4
                          } else if (packetData[i] === 0 && packetData[i+1] === 0 && packetData[i+2] === 1) {
                            startCodeLen = 3
                          }

                          if (startCodeLen > 0) {
                            const nalType = packetData[i + startCodeLen] & 0x1f
                            // Find end of this NAL (next start code or end of data)
                            let nalEnd = packetData.length
                            for (let j = i + startCodeLen + 1; j < packetData.length - 3; j++) {
                              if (packetData[j] === 0 && packetData[j+1] === 0 &&
                                  (packetData[j+2] === 1 || (packetData[j+2] === 0 && packetData[j+3] === 1))) {
                                nalEnd = j
                                break
                              }
                            }

                            // Save SPS (7) and PPS (8) NAL units with 4-byte start codes
                            if (nalType === 7 || nalType === 8) {
                              const nalData = packetData.slice(i + startCodeLen, nalEnd)
                              // Use 4-byte start code for Annex B format
                              nalUnits.push(Buffer.concat([Buffer.from([0, 0, 0, 1]), nalData]))
                              console.log('[HlsTranscoder] Captured NAL type', nalType, 'length:', nalData.length)
                            }

                            i = nalEnd
                          } else {
                            i++
                          }
                        }

                        if (nalUnits.length >= 2) {
                          spsPpsNalus = Buffer.concat(nalUnits)
                          console.log('[HlsTranscoder] Captured SPS/PPS from keyframe:', spsPpsNalus.length, 'bytes')
                        }
                      }

                      // INJECT SPS/PPS into keyframes that don't have them
                      // DISABLED: Direct data modification causes writeFrame errors
                      // TODO: Find proper way to inject SPS/PPS or configure encoder
                      if (!hasSPS && !hasPPS && spsPpsNalus && spsPpsNalus.length > 0) {
                        console.log('[HlsTranscoder] SKIPPING SPS/PPS injection for keyframe #' + totalEncoderPackets + ' (causes muxer errors)')
                        // outputPacket.data = Buffer.concat([spsPpsNalus, packetData])
                      }
                    } catch (nalCheckErr) {
                      console.log('[HlsTranscoder] NAL check error:', nalCheckErr?.message)
                    }
                  }

                  // FIXED: Don't overwrite encoder's output PTS - it handles buffering correctly
                  // Just set stream index and DTS (= PTS since B-frames disabled)
                  outputPacket.streamIndex = continuousMuxer.videoStream.index
                  // DON'T set outputPacket.pts - encoder's value is correct!
                  // Set DTS = PTS (no B-frames means no reordering)
                  outputPacket.dts = outputPacket.pts
                  outputPacket.timeBase = videoEncoder.timeBase  // 1/1000

                  // Rescale to MPEGTS timebase (1/90000)
                  const mpegtsTimeBase = { numerator: 1, denominator: 90000 }
                  outputPacket.rescaleTimestamps(videoEncoder.timeBase, mpegtsTimeBase)
                  outputPacket.timeBase = mpegtsTimeBase

                  if (totalEncoderPackets <= 5 || totalEncoderPackets % 500 === 0) {
                    console.log('[HlsTranscoder] Video packet #' + totalEncoderPackets + ': pts=', outputPacket.pts, 'dts=', outputPacket.dts)
                  }

                  try {
                    continuousMuxer.format.writeFrame(outputPacket)
                  } catch (writeErr) {
                    console.error('[HlsTranscoder] VIDEO writeFrame FAILED at packet', totalEncoderPackets, ':', writeErr?.message)
                    throw writeErr  // Re-throw to see where it goes
                  }
                  outputPacket.unref()
                }
              }
            } catch (encodeErr) {
              // Log more details about the failing frame to diagnose encoder issues
              if (videoFrameCount <= 400 || videoFrameCount % 100 === 0) {
                console.error('[HlsTranscoder] Encode error at frame', videoFrameCount, ':', encodeErr?.message || encodeErr,
                  'pts:', frameToEncode?.pts, 'format:', frameToEncode?.format,
                  'size:', frameToEncode?.width, 'x', frameToEncode?.height)
              }
              // Continue with next frame instead of crashing
            }
          }
        }
        } catch (decodeErr) {
          console.error('[HlsTranscoder] Decode error at packet', packetCount, ':', decodeErr?.message || decodeErr)
          // Continue with next packet instead of crashing
        }
      } else if (audioStream && continuousMuxer?.audioStream && packet.streamIndex === audioStream.index) {
        // AUDIO PROCESSING: Track base PTS from first packet, increment by encoder output samples
        // This handles AAC's encoder delay and non-1:1 input/output mapping correctly
        totalAudioPackets++

        // Capture first packet's PTS as the audio timeline base
        const packetPts = packet.pts || 0
        const packetTimeBase = audioStream.timeBase || { numerator: 1, denominator: 48000 }
        const packetPtsMs = (packetPts * packetTimeBase.numerator * 1000) / packetTimeBase.denominator

        // Set base PTS from FIRST audio packet only
        if (audioBasePtsMs === null) {
          audioBasePtsMs = packetPtsMs
          console.log('[HlsTranscoder] Audio base PTS set:', audioBasePtsMs.toFixed(1), 'ms')
        }

        if (totalAudioPackets <= 5) {
          console.log('[HlsTranscoder] Audio packet', totalAudioPackets,
            'pts:', packetPts, 'ptsMs:', packetPtsMs.toFixed(1), 'basePtsMs:', audioBasePtsMs.toFixed(1))
        }

        packet.timeBase = packetTimeBase

        try {
          if (audioDecoder.sendPacket(packet)) {
            while (audioDecoder.receiveFrame(audioFrame)) {
              audioFrameCount++

              if (firstAudioFrame) {
                console.log('[HlsTranscoder] First audio frame: samples:', audioFrame.nbSamples,
                  'sampleRate:', audioFrame.sampleRate, 'format:', audioFrame.format,
                  'channels:', audioFrame.channelLayout?.nbChannels, 'layoutMask:', audioFrame.channelLayout?.mask)
                firstAudioFrame = false

                // CRITICAL: Recreate resampler with ACTUAL frame properties
                // Decoder properties before first frame may be incorrect
                if (resampler) {
                  try { resampler.destroy() } catch {}
                }

                const actualSampleRate = audioFrame.sampleRate || 48000
                const actualFormat = audioFrame.format
                
                // CRITICAL: Pass ChannelLayout.from() to handle layout object properly
                // This ensures proper handling of 6-channel downmix to stereo
                const actualChannelLayout = ffmpeg.ChannelLayout.from(audioFrame.channelLayout) || ffmpeg.constants.channelLayouts.STEREO
                const actualChannels = actualChannelLayout?.nbChannels || 2

                console.log('[HlsTranscoder] Creating resampler (using frame layout):',
                  'srcRate=' + actualSampleRate, 'srcFormat=' + actualFormat,
                  'srcLayout=' + (actualChannelLayout?.mask || actualChannelLayout || 3), 'srcChannels=' + actualChannels)

                const dstSampleRate = audioEncoder.sampleRate
                const dstChannelLayout = ffmpeg.constants.channelLayouts.STEREO.mask || 3
                const dstSampleFormat = audioEncoder.sampleFormat

                console.log('[HlsTranscoder] Resampler dst: rate=' + dstSampleRate,
                  'format=' + dstSampleFormat, 'layout=' + dstChannelLayout)

                resampler = new ffmpeg.Resampler(
                  actualSampleRate,
                  actualChannelLayout,
                  actualFormat,
                  dstSampleRate,
                  dstChannelLayout,
                  dstSampleFormat
                )
                console.log('[HlsTranscoder] Resampler recreated with actual frame properties')
              }

              // Debug: log frame state before convert (first 3 frames only)
              if (audioFrameCount <= 3) {
                console.log('[HlsTranscoder] Pre-convert audioFrame #' + audioFrameCount + ':',
                  'nbSamples=' + audioFrame.nbSamples,
                  'format=' + audioFrame.format,
                  'sampleRate=' + audioFrame.sampleRate,
                  'layoutMask=' + audioFrame.channelLayout?.mask)
                console.log('[HlsTranscoder] Pre-convert resampledFrame:',
                  'nbSamples=' + resampledFrame.nbSamples,
                  'format=' + resampledFrame.format,
                  'sampleRate=' + resampledFrame.sampleRate,
                  'layoutMask=' + resampledFrame.channelLayout?.mask)
              }

                // CRITICAL: Save the allocated buffer size before convert modifies nbSamples
                const resampledBufferSize = resampledFrame.nbSamples

                const samplesConverted = resampler.convert(audioFrame, resampledFrame)
                console.log('[HlsTranscoder] Audio convert: inputSamples=', audioFrame.nbSamples, 'bufferSize=', resampledBufferSize, 'converted=', samplesConverted)

                // Set actual sample count for FIFO write
                resampledFrame.nbSamples = samplesConverted
                audioSamplesSent += samplesConverted

              // Write resampled samples to FIFO (handles frame size mismatch: E-AC3=1536, AAC=1024)
              const samplesWritten = audioFifo.write(resampledFrame)

              // CRITICAL: Restore buffer size for next convert to avoid buffer overflow
              resampledFrame.nbSamples = resampledBufferSize

              if (audioFrameCount <= 5) {
                console.log('[HlsTranscoder] FIFO write:', samplesWritten, 'samples, FIFO size now:', audioFifo.size)
              }

              // Process AAC frames from FIFO - limit iterations to prevent runaway loops
              // E-AC3=1536 samples, AAC=1024 samples, so max 2 AAC frames per input
              const encoderSampleRate = audioEncoder.sampleRate || 48000
              let framesEncodedThisIteration = 0
              const maxFramesPerIteration = 3  // Safety limit

              while (audioFifo.size >= aacFrameSize && framesEncodedThisIteration < maxFramesPerIteration) {
                // Ensure encoderFrame buffer is not shared with the encoder before refilling
                // avcodec_send_frame may keep a reference, so we allocate a fresh buffer each time
                encoderFrame.unref()
                encoderFrame.format = audioEncoder.sampleFormat
                encoderFrame.channelLayout = ffmpeg.constants.channelLayouts.STEREO
                encoderFrame.sampleRate = audioEncoder.sampleRate
                encoderFrame.nbSamples = aacFrameSize
                encoderFrame.alloc()

                // Read exactly aacFrameSize samples from FIFO into encoderFrame
                const samplesRead = audioFifo.read(encoderFrame, aacFrameSize)
                if (samplesRead !== aacFrameSize) {
                  console.warn('[HlsTranscoder] FIFO read unexpected:', samplesRead, 'expected:', aacFrameSize)
                  break
                }

                // Set frame PTS for encoder - use audioSamplesOutput for consistent timing
                encoderFrame.pts = audioSamplesOutput
                encoderFrame.timeBase = audioEncoder.timeBase
                encoderFrame.nbSamples = aacFrameSize

                if (audioFrameCount <= 5) {
                  console.log('[HlsTranscoder] Sending encoderFrame: nbSamples=', encoderFrame.nbSamples,
                    'pts=', encoderFrame.pts, 'FIFO remaining:', audioFifo.size)
                }

                if (audioEncoder.sendFrame(encoderFrame)) {
                  audioSamplesOutput += aacFrameSize
                  framesEncodedThisIteration++

                  // CRITICAL: Drain ALL packets from encoder before next sendFrame
                  // This ensures encoder has fully consumed the frame data
                  while (audioEncoder.receivePacket(outputPacket)) {
                    totalAudioEncoderPackets++

                    if (outputPacket.pts < 0) {
                      if (totalAudioEncoderPackets <= 2) {
                        console.log('[HlsTranscoder] Audio priming packet skipped, pts:', outputPacket.pts)
                      }
                      outputPacket.unref()
                      continue
                    }

                    const packetPtsMs = audioBasePtsMs + (outputPacket.pts * 1000 / encoderSampleRate)
                    outputPacket.streamIndex = continuousMuxer.audioStream.index
                    const mpegtsTimeBase = { numerator: 1, denominator: 90000 }
                    const audioPts90k = Math.round(packetPtsMs * 90)
                    outputPacket.pts = audioPts90k
                    outputPacket.dts = audioPts90k
                    outputPacket.timeBase = mpegtsTimeBase

                    if (totalAudioEncoderPackets <= 5 || totalAudioEncoderPackets % 200 === 0) {
                      console.log('[HlsTranscoder] Audio encoder packet', totalAudioEncoderPackets,
                        'packetPtsMs:', packetPtsMs.toFixed(1), 'pts90k:', audioPts90k,
                        'samplesOutput:', audioSamplesOutput)
                    }

                    try {
                      continuousMuxer.format.writeFrame(outputPacket)
                    } catch (writeErr) {
                      console.error('[HlsTranscoder] AUDIO writeFrame FAILED at packet', totalAudioEncoderPackets, ':', writeErr?.message)
                      throw writeErr
                    }
                    outputPacket.unref()
                  }
                } else {
                  // Encoder rejected frame - break to avoid infinite loop
                  break
                }
              }

              // Release decoder-owned buffers before the next receiveFrame call
              audioFrame.unref()
            }
          }
        } catch (audioErr) {
          if (totalAudioPackets <= 10) {
            console.error('[HlsTranscoder] Audio error:', audioErr?.message)
          }
        }
      }

      packet.unref()

      // Log progress every 100 packets for debugging
      if (packetCount % 100 === 0) {
        const pct = Math.min(99, Math.round((bytesProcessed / totalSize) * 100))
        console.log('[HlsTranscoder] Progress:', packetCount, 'packets,', pct + '%,', Math.round(bytesProcessed / 1024 / 1024) + 'MB')
        if (pct > lastProgressPct) {
          lastProgressPct = pct
          session.progress = pct
          if (onProgress) onProgress(pct)
        }
      }

      // Clear busy flag BEFORE yielding to allow HTTP handler to run safely
      transcodingBusy--

      // Yield to event loop every 50 packets to allow HTTP requests to be processed
      // The busy flag protects against concurrent access during FFmpeg operations
      if (packetCount % 50 === 0) {
        await new Promise(resolve => setImmediate(resolve))
      }
    }

    console.log('[HlsTranscoder] Main loop exited after', packetCount, 'packets,', videoFrameCount, 'video frames,', 
      totalEncoderPackets, 'video encoder packets,', totalAudioPackets, 'audio input packets,', 
      audioFrameCount, 'audio frames decoded,', totalAudioEncoderPackets, 'audio encoder packets')

    // Flush encoders to continuous muxer - SIMPLIFIED (no rebasing)
    const mpegtsTimeBase = { numerator: 1, denominator: 90000 }

    if (continuousMuxer) {
      // Flush video encoder with error handling
      try {
        videoEncoder.sendFrame(null)
        let flushVideoPackets = 0
        while (videoEncoder.receivePacket(outputPacket)) {
          outputPacket.streamIndex = continuousMuxer.videoStream.index
          outputPacket.timeBase = videoEncoder.timeBase
          outputPacket.rescaleTimestamps(videoEncoder.timeBase, mpegtsTimeBase)
          outputPacket.timeBase = mpegtsTimeBase
          try {
            continuousMuxer.format.writeFrame(outputPacket)
            flushVideoPackets++
          } catch (writeErr) {
            console.warn('[HlsTranscoder] Flush video writeFrame failed:', writeErr?.message)
          }
          outputPacket.unref()
        }
        console.log('[HlsTranscoder] Flushed', flushVideoPackets, 'video packets')
      } catch (flushErr) {
        console.warn('[HlsTranscoder] Video encoder flush failed:', flushErr?.message)
      }

      // Flush audio encoder with error handling
      if (audioEncoder && continuousMuxer.audioStream) {
        try {
          audioEncoder.sendFrame(null)
          const audioEncTB = audioEncoder.timeBase
          let flushAudioPackets = 0
          while (audioEncoder.receivePacket(outputPacket)) {
            if (outputPacket.pts < 0) {
              outputPacket.unref()
              continue
            }
            outputPacket.streamIndex = continuousMuxer.audioStream.index
            outputPacket.timeBase = audioEncTB
            outputPacket.rescaleTimestamps(audioEncTB, mpegtsTimeBase)
            outputPacket.timeBase = mpegtsTimeBase
            try {
              continuousMuxer.format.writeFrame(outputPacket)
              flushAudioPackets++
            } catch (writeErr) {
              console.warn('[HlsTranscoder] Flush audio writeFrame failed:', writeErr?.message)
            }
            outputPacket.unref()
          }
          console.log('[HlsTranscoder] Flushed', flushAudioPackets, 'audio packets')
        } catch (flushErr) {
          console.warn('[HlsTranscoder] Audio encoder flush failed:', flushErr?.message)
        }
      }

      // Finalize last segment with writeTrailer
      const finalDuration = lastKeyframePts - segmentStartPts
      await finalizeContinuousMuxer(continuousMuxer, segmentIndex, finalDuration)
      continuousMuxer = null
    }

    segmentManager.finish()

    console.log('[HlsTranscoder] Video transcode complete, segments:', segmentManager.totalSegments)

  } finally {
    // CRITICAL: Destroy in reverse order of creation, set to null to prevent GC double-free
    // Frames first
    if (encoderFrame) { try { encoderFrame.destroy() } catch {} encoderFrame = null }
    if (resampledFrame) { try { resampledFrame.destroy() } catch {} resampledFrame = null }
    if (audioFrame) { try { audioFrame.destroy() } catch {} audioFrame = null }
    if (scaledFrame) { try { scaledFrame.destroy() } catch {} scaledFrame = null }
    if (videoFrame) { try { videoFrame.destroy() } catch {} videoFrame = null }
    if (outputPacket) { try { outputPacket.destroy() } catch {} outputPacket = null }
    if (packet) { try { packet.destroy() } catch {} packet = null }

    // Codec helpers
    if (audioFifo) { try { audioFifo.destroy() } catch {} audioFifo = null }
    if (resampler) { try { resampler.destroy() } catch {} resampler = null }
    if (scaler) { try { scaler.destroy() } catch {} scaler = null }
    
    // Encoders/Decoders
    if (audioEncoder) { try { audioEncoder.destroy() } catch {} audioEncoder = null }
    if (audioDecoder) { try { audioDecoder.destroy() } catch {} audioDecoder = null }
    if (videoEncoder) { try { videoEncoder.destroy() } catch {} videoEncoder = null }
    if (videoDecoder) { try { videoDecoder.destroy() } catch {} videoDecoder = null }
    
    // Continuous muxer cleanup (if not already finalized)
    // NOTE: format.destroy() also destroys the IO context
    if (continuousMuxer) {
      try { continuousMuxer.format.destroy() } catch {}
      continuousMuxer = null
    }

    // Format contexts LAST (after all streams/codecs using them)
    if (inputFormat) { try { inputFormat.destroy() } catch {} inputFormat = null }
    
    console.log('[HlsTranscoder] Cleanup complete')
  }
}

/**
 * Start HLS transcode session
 * @param {string} sourceUrl - Video URL (from blob server)
 * @param {object} options - { title, onProgress, store, isVideoComplete, blobInfo, blobsCoreKey }
 *   - store: Corestore instance (for direct Hypercore access)
 *   - isVideoComplete: If true, video is fully synced - enables direct Hypercore read
 *   - blobInfo/blobsCoreKey: For direct Hypercore block access (fastest path)
 */
export async function startHlsTranscode(sourceUrl, options = {}) {
  const {
    title = '',
    onProgress,
    store,
    isVideoComplete = false,
    // Optional: Direct Hypercore access (bypasses HTTP)
    blobInfo = null,        // { blockOffset, blockLength, byteOffset, byteLength }
    blobsCoreKey = null     // hex string of the blobs Hypercore key
  } = options

  // Check for existing session for this URL - reuse if still active
  for (const [id, session] of sessions) {
    if (session.sourceUrl === sourceUrl && session.status !== 'error') {
      console.log('[HlsTranscoder] Reusing existing session for URL:', id, 'status:', session.status)
      // Use LAN URL from the existing session for Chromecast access
      const sessionLanHost = session.lanHost || '127.0.0.1'
      const hlsUrlLocal = `http://127.0.0.1:${httpPort}/hls/${id}/stream.m3u8`
      const hlsUrlLan = `http://${sessionLanHost}:${httpPort}/hls/${id}/stream.m3u8`
      return {
        success: true,
        sessionId: id,
        hlsUrl: hlsUrlLan,
        hlsUrlLocal,
        hlsUrlLan,
        reused: true,
      }
    }
  }

  // Cleanup old sessions for DIFFERENT videos only
  if (sessions.size > 0) {
    console.log('[HlsTranscoder] Cleaning up', sessions.size, 'old session(s) before starting new one')
    for (const [id, session] of sessions) {
      console.log('[HlsTranscoder] Stopping old session:', id)
      try {
        if (session.inputIO?._cleanup) session.inputIO._cleanup()
      } catch {}
      try {
        if (session.streamReader) session.streamReader.destroy()
      } catch {}
      try {
        if (session.segmentManager) session.segmentManager.destroy()
      } catch {}
    }
    sessions.clear()
    console.log('[HlsTranscoder] All old sessions cleaned up')
  }

  if (!ffmpeg) {
    const loaded = await loadBareFfmpeg()
    if (!loaded) {
      return { success: false, error: ffmpegLoadError || 'bare-ffmpeg not available' }
    }
  }

  const serverPort = await ensureHttpServer()
  console.log('[HlsTranscoder] ensureHttpServer returned port:', serverPort)

  // Verify server is actually running
  if (!serverPort || !httpServer) {
    return { success: false, error: 'HTTP server failed to start' }
  }

  // Double-check server is listening
  try {
    const addr = httpServer.address()
    console.log('[HlsTranscoder] Server address check:', JSON.stringify(addr))
    if (!addr || !addr.port) {
      return { success: false, error: 'HTTP server not listening' }
    }
  } catch (addrErr) {
    console.error('[HlsTranscoder] Server address check failed:', addrErr?.message)
    return { success: false, error: 'HTTP server check failed: ' + addrErr?.message }
  }

  const sessionId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

  // Get file size
  let fileSize
  try {
    fileSize = await getHttpFileSize(sourceUrl)
    if (!fileSize) {
      return { success: false, error: 'Could not determine file size' }
    }
  } catch (err) {
    return { success: false, error: `Failed to get file size: ${err.message}` }
  }

  console.log('[HlsTranscoder] Starting session', sessionId, 'size:', Math.round(fileSize / 1024 / 1024) + 'MB')
  console.log('[HlsTranscoder] HTTP server port:', httpPort, 'server exists:', !!httpServer)

  // Get LAN IP for Chromecast access
  const lanHost = await getLanIp()
  console.log('[HlsTranscoder] LAN host for Chromecast:', lanHost)

  // Use simple transient segment manager (memory + disk spillover)
  // Hyperblobs append-only log is not ideal for temporary HLS segments
  const segmentManager = new HlsSegmentManager(sessionId, os.tmpdir())
  console.log('[HlsTranscoder] Using HlsSegmentManager (transient storage)')

  const session = {
    id: sessionId,
    sourceUrl,
    status: 'starting',
    progress: 0,
    error: null,
    segmentManager,
    streamReader: null,
    inputIO: null,
    lanHost,
    isVideoComplete,  // If true, wait for full HTTP download before transcoding
  }
  sessions.set(sessionId, session)
  console.log('[HlsTranscoder] Session registered, total sessions:', sessions.size)

  // Generate HLS URLs for the main transcoder HTTP server
  const hlsUrlLocal = `http://127.0.0.1:${httpPort}/hls/${sessionId}/stream.m3u8`
  const hlsUrlLan = `http://${lanHost}:${httpPort}/hls/${sessionId}/stream.m3u8`
  const hlsUrl = hlsUrlLan  // LAN URL for Chromecast
  console.log('[HlsTranscoder] HLS URL (LAN):', hlsUrlLan)
  console.log('[HlsTranscoder] HLS URL (local):', hlsUrlLocal)

  // Self-test: verify server is reachable from within the app
  try {
    const testUrl = `http://127.0.0.1:${httpPort}/ping`
    console.log('[HlsTranscoder] Self-test: pinging', testUrl)
    const testRes = await new Promise((resolve, reject) => {
      const testReq = http.request(testUrl, { method: 'GET' }, (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode, body }))
        res.on('error', reject)
      })
      testReq.on('error', reject)
      testReq.end()
    })
    console.log('[HlsTranscoder] Self-test result:', testRes.status, testRes.body)
  } catch (testErr) {
    console.error('[HlsTranscoder] Self-test FAILED:', testErr?.message || testErr)
    console.error('[HlsTranscoder] WARNING: HTTP server may not be reachable!')
  }

  // Start transcoding in background
  ;(async () => {
    let hypercoreReader = null

    try {
      // ============================================
      // Input source selection
      // ============================================
      session.status = 'initializing'

      let inputIO = null

      // Option 1: Direct Hypercore access (fastest, no HTTP overhead)
      // Requires: blobInfo, blobsCoreKey, store
      // NOTE: We don't require isVideoComplete - let isFullySynced() make the actual check
      // because checkVideoSync() can give false negatives due to sampling/contiguousLength issues
      if (blobInfo && blobsCoreKey && store) {
        console.log('[HlsTranscoder] Attempting direct Hypercore read (isVideoComplete hint:', isVideoComplete, ')...')
        try {
          const blobsCore = store.get(Buffer.from(blobsCoreKey, 'hex'))
          await blobsCore.ready()

          console.log('[HlsTranscoder] Creating HypercoreIOReader with blobInfo:')
          console.log('[HlsTranscoder]   blockOffset:', blobInfo.blockOffset)
          console.log('[HlsTranscoder]   blockLength:', blobInfo.blockLength)
          console.log('[HlsTranscoder]   byteOffset:', blobInfo.byteOffset)
          console.log('[HlsTranscoder]   byteLength:', blobInfo.byteLength)
          hypercoreReader = new HypercoreIOReader(blobsCore, blobInfo)
          console.log('[HlsTranscoder] HypercoreIOReader created, checking sync...')

          // Verify fully synced
          const synced = await hypercoreReader.isFullySynced()
          console.log('[HlsTranscoder] isFullySynced result:', synced)
          if (synced) {
            console.log('[HlsTranscoder] Video fully synced, using HypercoreIOReader')
            console.log('[HlsTranscoder] Calling preload()...')
            await hypercoreReader.preload()
            console.log('[HlsTranscoder] preload() complete')

            // DEBUG: Test direct read from HypercoreIOReader before creating IOContext
            console.log('[HlsTranscoder] Testing direct read from HypercoreIOReader...')
            console.log('[HlsTranscoder] Reader position:', hypercoreReader.position, 'totalSize:', hypercoreReader.totalSize)
            console.log('[HlsTranscoder] Blocks loaded:', hypercoreReader.blocks?.size)

            // Also log raw first block bytes for comparison
            const firstBlock = hypercoreReader.blocks.get(hypercoreReader.startBlock)
            if (firstBlock) {
              const rawHex = []
              const startOff = hypercoreReader.byteOffset
              console.log('[HlsTranscoder] First block size:', firstBlock.length, 'byteOffset:', startOff)
              for (let i = 0; i < Math.min(16, firstBlock.length - startOff); i++) {
                rawHex.push(firstBlock[startOff + i].toString(16).padStart(2, '0'))
              }
              console.log('[HlsTranscoder] Raw first block bytes at byteOffset:', rawHex.join(' '))
              // Also show bytes at offset 0 of first block for comparison
              const raw0Hex = []
              for (let i = 0; i < Math.min(16, firstBlock.length); i++) {
                raw0Hex.push(firstBlock[i].toString(16).padStart(2, '0'))
              }
              console.log('[HlsTranscoder] Raw first block bytes at offset 0:', raw0Hex.join(' '))
            }

            const testBuffer = Buffer.alloc(64)
            const bytesRead = hypercoreReader.syncRead(testBuffer)
            console.log('[HlsTranscoder] Test read returned:', bytesRead, 'bytes')

            if (bytesRead > 0) {
              // Log first 16 bytes as hex for debugging
              const hexBytes = []
              for (let i = 0; i < Math.min(16, bytesRead); i++) {
                hexBytes.push(testBuffer[i].toString(16).padStart(2, '0'))
              }
              console.log('[HlsTranscoder] First bytes:', hexBytes.join(' '))

              // Check for valid video signatures
              // MKV: 1A 45 DF A3 (EBML header)
              // MP4: xx xx xx xx 66 74 79 70 (ftyp at offset 4)
              const isMkv = testBuffer[0] === 0x1A && testBuffer[1] === 0x45 && testBuffer[2] === 0xDF && testBuffer[3] === 0xA3
              const isMp4 = testBuffer[4] === 0x66 && testBuffer[5] === 0x74 && testBuffer[6] === 0x79 && testBuffer[7] === 0x70
              console.log('[HlsTranscoder] Signature check: MKV=' + isMkv + ' MP4=' + isMp4)

              // Reset position after test read
              hypercoreReader.seek(0, 0) // SEEK_SET
              console.log('[HlsTranscoder] Position reset to:', hypercoreReader.position)
            } else {
              console.error('[HlsTranscoder] Test read failed! bytesRead:', bytesRead)
            }

            console.log('[HlsTranscoder] Creating IOContext...')
            inputIO = hypercoreReader.createIOContext(ffmpeg)
            console.log('[HlsTranscoder] IOContext created:', !!inputIO)
            session.hypercoreReader = hypercoreReader
          } else {
            console.log('[HlsTranscoder] Video not fully synced, falling back to HTTP')
            hypercoreReader = null
          }
        } catch (err) {
          console.warn('[HlsTranscoder] Hypercore reader failed:', err?.message)
          hypercoreReader = null
        }
      }

      // Option 2: HTTP temp file reader (fallback)
      if (!inputIO) {
        console.log('[HlsTranscoder] Using TempFileReader (HTTP)')

        const streamReader = new TempFileReader(sourceUrl, fileSize, {
          waitForComplete: isVideoComplete
        })
        session.streamReader = streamReader
        console.log('[HlsTranscoder] TempFileReader created, waitForComplete:', isVideoComplete)

        const { downloadPromise } = await streamReader.startDownload((downloadedBytes, totalBytes) => {
          const pct = Math.round((downloadedBytes / totalBytes) * 100)
          if (pct % 10 === 0) {
            console.log('[HlsTranscoder] Download:', pct + '%')
          }
        })
        if (downloadPromise) {
          downloadPromise.catch((err) => {
            console.warn('[HlsTranscoder] Download error after start:', err?.message || err)
          })
        }

        inputIO = streamReader.createIOContext(ffmpeg)
      }

      session.status = 'transcoding'
      session.inputIO = inputIO
      console.log('[HlsTranscoder] Input source:', session.hypercoreReader ? 'HypercoreIOReader' : 'TempFileReader', 'inputIO:', !!inputIO)

      // Detect transcode mode
      const detection = detectTranscodeNeeded(sourceUrl, title)
      console.log('[HlsTranscoder] Detection:', detection)

      // Check H.264 encoder availability for HEVC transcoding
      if (detection.needsVideoTranscode) {
        if (h264EncoderAvailable === null) {
          h264EncoderAvailable = isH264EncoderAvailable()
        }
        if (!h264EncoderAvailable) {
          console.warn('[HlsTranscoder] HEVC video detected but H.264 encoder not available')
          console.warn('[HlsTranscoder] Falling back to remux (Chromecast may not support HEVC)')
          detection.needsVideoTranscode = false
          detection.needsRemux = true
          detection.reason += ' (x264 unavailable, remux fallback)'
        }
      }

      const progressCallback = (pct) => {
        if (onProgress) onProgress(sessionId, pct)
      }

      // Use transcode path when video OR audio needs transcoding
      // HEVC video -> H.264, E-AC3/DDP/DTS audio -> AAC
      const needsTranscode = detection.needsVideoTranscode || detection.needsAudioTranscode
      console.log('[HlsTranscoder] Transcode decision: needsVideo=' + detection.needsVideoTranscode + 
        ' needsAudio=' + detection.needsAudioTranscode + ' -> ' + (needsTranscode ? 'TRANSCODE' : 'REMUX'))

      if (needsTranscode) {
        await hlsTranscodeVideo(session, inputIO, segmentManager, fileSize, progressCallback)
      } else {
        await hlsRemux(session, inputIO, segmentManager, fileSize, progressCallback)
      }

      session.status = 'complete'
      session.progress = 100
      console.log('[HlsTranscoder] Session complete:', sessionId)

    } catch (err) {
      session.status = 'error'
      session.error = err?.message || 'Transcode failed'
      console.error('[HlsTranscoder] Error:', session.error)
      if (err?.stack) console.error(err.stack)
    } finally {
      // Cleanup
      if (session.inputIO?._cleanup) {
        try { session.inputIO._cleanup() } catch {}
      }
      if (session.streamReader) {
        try { session.streamReader.destroy() } catch {}
      }
      if (session.hypercoreReader) {
        try { session.hypercoreReader.destroy() } catch {}
      }
    }
  })()

  return {
    success: true,
    sessionId,
    hlsUrl,           // LAN URL (for Chromecast)
    hlsUrlLocal,      // Localhost URL (for local testing)
    hlsUrlLan,        // LAN URL (explicit)
  }
}

/**
 * Stop HLS transcode session
 */
export function stopHlsTranscode(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) {
    return { success: false, error: 'Session not found' }
  }

  // Cleanup
  if (session.inputIO?._cleanup) {
    try { session.inputIO._cleanup() } catch {}
  }
  if (session.streamReader) {
    try { session.streamReader.destroy() } catch {}
  }
  if (session.hypercoreReader) {
    try { session.hypercoreReader.destroy() } catch {}
  }
  if (session.segmentManager) {
    try { session.segmentManager.destroy() } catch {}
  }

  sessions.delete(sessionId)
  return { success: true }
}

/**
 * Get HLS session status
 */
export function getHlsStatus(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) {
    return { error: 'Session not found' }
  }

  const segmentStats = session.segmentManager?.getStats() || {}
  const totalSegments = segmentStats.totalSegments ?? 0

  return {
    status: session.status,
    progress: session.progress,
    error: session.error,
    segments: totalSegments,
    playlistReady: segmentStats.playlistReady || false,
    highestSegment: session.segmentManager?.getHighestSegmentIndex() || -1,
    memoryMB: segmentStats.memoryUsageMB || 0,
    diskMB: segmentStats.diskUsageMB || 0,
  }
}

/**
 * Get all active HLS sessions
 */
export function getHlsSessions() {
  return Array.from(sessions.values()).map(s => ({
    id: s.id,
    status: s.status,
    progress: s.progress,
    error: s.error,
  }))
}

export default {
  loadBareFfmpeg,
  isAvailable,
  getLoadError,
  startHlsTranscode,
  stopHlsTranscode,
  getHlsStatus,
  getHlsSessions,
}
