import http from 'bare-http1'

import { probeMedia, loadBareFfmpeg } from './transcoder.mjs'
import { decidePlayback } from './playback-compat.mjs'
import { safeDestroy, safeUnref, copyCodecParameters } from './ffmpeg-utils.mjs'
import { TempFileReader } from './temp-file-reader.mjs'
import { getHttpFileSize } from './http-file-size.mjs'
import { MemorySegmentStore } from './segment-store.mjs'
import { FMP4Segmenter } from './fmp4-segmenter.mjs'
import { getVideoToolboxDecodeSettings } from './videotoolbox-settings.mjs'

const sessions = new Map()
let castServer = null
let castServerPort = 0
let castServerReady = null
let ffmpeg = null
const CAST_PROGRESSIVE_STARTUP_BUFFER_BYTES = 128 * 1024 * 1024
const CAST_TRANSCODE_MAX_AHEAD_MS = 4 * 1000
const CAST_TRANSCODE_FAST_START_MS = 10 * 1000

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Range,Content-Type,Accept,Origin')
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges')
}

function parseByteRange(rangeHeader, fileSize) {
  if (!rangeHeader) return null
  if (!Number.isFinite(fileSize) || fileSize <= 0) return null
  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/)
  if (!match) return null
  const rawStart = match[1]
  const rawEnd = match[2]

  if (rawStart && rawEnd) {
    const start = parseInt(rawStart, 10)
    const end = parseInt(rawEnd, 10)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return null
    if (start >= fileSize) return null
    const boundedEnd = Math.min(end, fileSize - 1)
    if (boundedEnd < start) return null
    return { start, end: boundedEnd }
  }

  if (rawStart && !rawEnd) {
    const start = parseInt(rawStart, 10)
    if (!Number.isFinite(start) || start < 0 || start >= fileSize) return null
    return { start, end: fileSize - 1 }
  }

  if (!rawStart && rawEnd) {
    const suffixLength = parseInt(rawEnd, 10)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null
    const start = Math.max(0, fileSize - suffixLength)
    return { start, end: fileSize - 1 }
  }

  return null
}

function logHttpResponse(session, fileName, method, rangeHeader, statusCode, contentLength) {
  try {
    console.log(
      '[CastDiag] HTTP response',
      method,
      fileName,
      'session:',
      session?.id?.slice(0, 8) || 'unknown',
      'range:',
      rangeHeader || 'none',
      'status:',
      statusCode,
      'length:',
      Number.isFinite(contentLength) ? contentLength : 'unknown',
    )
  } catch {}
}

function makeSessionId() {
  return `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 10)}`
}

async function throttleTranscodeToSourcePace(state, pts, timeBase) {
  if (!state || !timeBase || !Number.isFinite(timeBase.numerator) || !Number.isFinite(timeBase.denominator)) return
  if (timeBase.denominator <= 0) return
  const numericPts = Number(pts)
  if (!Number.isFinite(numericPts) || numericPts < 0) return

  const ptsMs = (numericPts * timeBase.numerator * 1000) / timeBase.denominator
  if (!Number.isFinite(ptsMs)) return

  if (!Number.isFinite(state.firstPtsMs)) {
    state.firstPtsMs = ptsMs
    state.wallStartMs = Date.now()
    return
  }

  const mediaElapsedMs = Math.max(0, ptsMs - state.firstPtsMs)
  if (mediaElapsedMs < CAST_TRANSCODE_FAST_START_MS) return

  const wallElapsedMs = Math.max(0, Date.now() - state.wallStartMs)
  const aheadMs = mediaElapsedMs - wallElapsedMs
  if (aheadMs <= CAST_TRANSCODE_MAX_AHEAD_MS) return

  const sleepMs = Math.min(120, Math.max(10, aheadMs - CAST_TRANSCODE_MAX_AHEAD_MS))
  await new Promise((resolve) => setTimeout(resolve, sleepMs))
}

function ensureFfmpegLoaded() {
  if (ffmpeg) return Promise.resolve(ffmpeg)
  return (async () => {
    const ok = await loadBareFfmpeg()
    if (!ok) {
      throw new Error('bare-ffmpeg not available')
    }
    let mod = null
    if (typeof require === 'function') {
      try {
        mod = require('bare-ffmpeg')
      } catch {}
    }
    if (!mod) {
      mod = await import('bare-ffmpeg')
    }
    ffmpeg = mod?.default ?? mod
    if (!ffmpeg) throw new Error('Failed to initialize bare-ffmpeg')
    return ffmpeg
  })()
}

function selectDecoderForId(codecId) {
  if (!ffmpeg) return null

  const vtSettings = getVideoToolboxDecodeSettings()
  const vtEnabled = vtSettings.videoToolboxDecodeEnabled

  const hwDecoders = new Set([
    'h264_mediacodec',
    'hevc_mediacodec',
    'h264_videotoolbox',
    'hevc_videotoolbox'
  ])

  const vtDecoders = new Set([
    'h264_videotoolbox',
    'hevc_videotoolbox'
  ])

  let candidates = []
  if (codecId === ffmpeg.constants.codecs.H264) {
    candidates = ['h264_mediacodec', 'h264_videotoolbox', 'h264']
  } else if (codecId === ffmpeg.constants.codecs.HEVC) {
    candidates = ['hevc_mediacodec', 'hevc_videotoolbox', 'hevc']
  }

  // Filter out VideoToolbox decoders when VT decode is disabled (default on Pear)
  if (!vtEnabled) {
    candidates = candidates.filter(name => !vtDecoders.has(name))
  }

  for (const name of candidates) {
    try {
      const decoder = ffmpeg.findDecoderByName?.(name)
      if (decoder && decoder._handle) {
        try {
          console.log('[cast-transcoder] selected decoder', name, 'hw=', hwDecoders.has(name))
        } catch {}
        return { decoder, name, isHardware: hwDecoders.has(name) }
      }
    } catch {}
  }

  const codec = ffmpeg.Codec?.for?.(codecId)
  const decoder = codec?.decoder
  if (decoder && decoder._handle) {
    try {
      console.log('[cast-transcoder] selected decoder codec fallback', codecId)
    } catch {}
    return { decoder, name: `codec:${codecId}`, isHardware: false }
  }
  return null
}

function selectH264Encoder() {
  if (!ffmpeg) return null
  const candidates = ['libx264', 'h264']
  for (const name of candidates) {
    try {
      const encoder = ffmpeg.findEncoderByName?.(name)
      if (encoder && encoder._handle) {
        return {
          encoder,
          name,
          pixelFormat: ffmpeg.constants.pixelFormats.YUV420P,
        }
      }
    } catch {}
  }
  const fallback = ffmpeg.Codec?.H264?.encoder
  if (fallback && fallback._handle) {
    return {
      encoder: fallback,
      name: 'codec:H264',
      pixelFormat: ffmpeg.constants.pixelFormats.YUV420P,
    }
  }
  return null
}

function selectAacEncoder() {
  if (!ffmpeg) return null
  const candidates = ['aac']
  for (const name of candidates) {
    try {
      const encoder = ffmpeg.findEncoderByName?.(name)
      if (encoder && encoder._handle) return { encoder, name }
    } catch {}
  }
  const fallback = ffmpeg.Codec?.AAC?.encoder
  if (fallback && fallback._handle) return { encoder: fallback, name: 'codec:AAC' }
  return null
}

function getCastServerPort() {
  return castServerPort
}

function createCastSession(sourceUrl, sourceKey = null) {
  const id = makeSessionId()
  const session = {
    id,
    sourceUrl,
    sourceKey,
    status: 'pending',
    isComplete: false,
    cancelled: false,
    ffmpegCleanup: null,
    segmenter: null,
    error: null,
    // Preserve a larger startup window so segments referenced in initial
    // playlists are not evicted before Chromecast fetches them.
    segmentStore: new MemorySegmentStore({
      maxSegments: 240,
      isFmp4: true,
      startupPinned: true,
      startupPinnedSegments: 240,
    }),
    requestStats: {
      playlistRequests: 0,
      initRequests: 0,
      segmentRequests: 0,
      notFoundResponses: 0,
      lastPlaylistLogAt: 0,
      lastPath: null,
      lastStatus: null,
      lastError: null,
    },
    createdAt: Date.now(),
  }
  sessions.set(id, session)
  return session
}

function getCastSession(sessionId) {
  return sessions.get(sessionId) || null
}

function findSessionBySourceKey(sourceKey) {
  if (!sourceKey) return null
  for (const session of sessions.values()) {
    if (session.sourceKey === sourceKey) return session
  }
  return null
}

function getCastStatus(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) return { error: 'Session not found' }
  return {
    id: session.id,
    sourceKey: session.sourceKey,
    status: session.status,
    error: session.error,
    cancelled: session.cancelled,
    fragmentCount: session.segmentStore?.getSegmentCount?.() || 0,
    isComplete: session.isComplete,
    requestStats: session.requestStats,
    storeSnapshot: session.segmentStore?.debugSnapshot?.() || null,
  }
}

function getCastHlsUrl(sessionId, host = '127.0.0.1') {
  if (!castServerPort) return null
  return `http://${host}:${castServerPort}/cast/${sessionId}/master.m3u8`
}

function stopCastTranscode(sessionId, reason = 'cancelled') {
  const session = sessions.get(sessionId)
  if (!session) return { success: false, error: 'Session not found' }

  session.cancelled = true
  if (session.status !== 'complete' && session.status !== 'error') {
    session.status = 'cancelled'
    session.error = reason
  }

  if (typeof session.ffmpegCleanup === 'function' && (session.isComplete || session.status === 'error')) {
    try {
      session.ffmpegCleanup()
    } catch (err) {
      console.warn('[cast-transcoder] stop cleanup error:', err?.message || err)
    }
    session.ffmpegCleanup = null
  }

  if (session.segmenter) {
    try { session.segmenter.finish?.() } catch {}
    session.segmenter = null
  }

  try { session.segmentStore?.destroy?.() } catch {}

  return { success: true }
}

function generatePlaylist(session) {
  return session.segmentStore?.generateManifest?.() || null
}

function generateMasterPlaylist() {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,AVERAGE-BANDWIDTH=2500000,CODECS="avc1.640029,mp4a.40.2"',
    'playlist.m3u8',
    '',
  ].join('\n')
}

function shouldLogPlaylistRequest(session) {
  const now = Date.now()
  const last = session?.requestStats?.lastPlaylistLogAt || 0
  if (now - last < 1000) return false
  session.requestStats.lastPlaylistLogAt = now
  return true
}

function sendPlaylistResponse(res, session, fileName, method, rangeHeader, playlist) {
  const payload = Buffer.from(playlist)
  const range = parseByteRange(rangeHeader, payload.length)

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  res.setHeader('Pragma', 'no-cache')

  if (rangeHeader && !range) {
    res.statusCode = 416
    session.requestStats.lastStatus = 416
    session.requestStats.lastError = 'Range not satisfiable'
    res.setHeader('Content-Range', `bytes */${payload.length}`)
    logHttpResponse(session, fileName, method, rangeHeader, 416, 0)
    res.end()
    return
  }

  if (range) {
    const chunk = payload.subarray(range.start, range.end + 1)
    res.statusCode = 206
    session.requestStats.lastStatus = 206
    session.requestStats.lastError = null
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${payload.length}`)
    res.setHeader('Content-Length', chunk.length)
    logHttpResponse(session, fileName, method, rangeHeader, 206, chunk.length)
    if (method === 'HEAD') res.end()
    else res.end(chunk)
    return
  }

  res.statusCode = 200
  session.requestStats.lastStatus = 200
  session.requestStats.lastError = null
  res.setHeader('Content-Length', payload.length)
  logHttpResponse(session, fileName, method, rangeHeader, 200, payload.length)
  if (method === 'HEAD') res.end()
  else res.end(payload)
}

function startCastFileServer() {
  if (castServerPort) return Promise.resolve(castServerPort)
  if (castServerReady) return castServerReady

  castServerReady = new Promise((resolve, reject) => {
    castServer = http.createServer((req, res) => {
      setCorsHeaders(res)
      const method = (req.method || 'GET').toUpperCase()
      if (method === 'OPTIONS') {
        res.statusCode = 204
        res.end()
        return
      }
      if (method !== 'GET' && method !== 'HEAD') {
        res.statusCode = 405
        res.setHeader('Allow', 'GET,HEAD,OPTIONS')
        res.setHeader('Content-Type', 'text/plain')
        res.end('Method not allowed')
        return
      }

      const parsed = new URL(req.url || '/', 'http://localhost')
      const match = parsed.pathname.match(/^\/cast\/([^/]+)\/(master\.m3u8|playlist\.m3u8|init\.mp4|seg-\d+\.(?:m4s|ts))$/)
      if (!match) {
        res.statusCode = 404
        res.setHeader('Content-Type', 'text/plain')
        res.end('Not found')
        return
      }

      const sessionId = match[1]
      const fileName = match[2]
      const session = sessions.get(sessionId)
      if (!session) {
        res.statusCode = 404
        res.setHeader('Content-Type', 'text/plain')
        res.end('Session not found')
        return
      }
      const isPlaylistRequest = fileName === 'master.m3u8' || fileName === 'playlist.m3u8'
      if (!isPlaylistRequest || shouldLogPlaylistRequest(session)) {
        console.log('[CastDiag] HTTP', method, fileName, 'session:', sessionId.slice(0, 8))
      }

      if (fileName === 'master.m3u8') {
        session.requestStats.playlistRequests += 1
        session.requestStats.lastPath = fileName
        const playlist = generateMasterPlaylist()
        sendPlaylistResponse(res, session, fileName, method, req.headers?.range, playlist)
        return
      }

      if (fileName === 'playlist.m3u8') {
        session.requestStats.playlistRequests += 1
        session.requestStats.lastPath = fileName
        const playlist = generatePlaylist(session)
        if (shouldLogPlaylistRequest(session)) {
          console.log('[cast-transcoder] playlist request', sessionId, 'segments=', session.segmentStore?.getSegmentCount?.() || 0)
        }
        if (!playlist) {
          res.statusCode = 503
          session.requestStats.lastStatus = 503
          session.requestStats.lastError = 'Manifest not ready'
          res.setHeader('Retry-After', '1')
          res.setHeader('Content-Type', 'text/plain')
          logHttpResponse(session, fileName, method, req.headers?.range, 503, 0)
          res.end('Manifest not ready')
          return
        }
        sendPlaylistResponse(res, session, fileName, method, req.headers?.range, playlist)
        return
      }

      if (fileName === 'init.mp4') {
        session.requestStats.initRequests += 1
        session.requestStats.lastPath = fileName
        const initData = session.segmentStore?.getInit?.()
        if (!initData) {
          res.statusCode = 404
          session.requestStats.notFoundResponses += 1
          session.requestStats.lastStatus = 404
          session.requestStats.lastError = 'Init not ready'
          res.setHeader('Content-Type', 'text/plain')
          logHttpResponse(session, fileName, method, req.headers?.range, 404, 0)
          res.end('Init not ready')
          return
        }
        res.statusCode = 200
        session.requestStats.lastStatus = 200
        session.requestStats.lastError = null
        res.setHeader('Content-Type', 'video/mp4')
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        res.setHeader('Accept-Ranges', 'bytes')
        const range = parseByteRange(req.headers?.range, initData.length)
        if (req.headers?.range && !range) {
          res.statusCode = 416
          session.requestStats.lastStatus = 416
          session.requestStats.lastError = 'Range not satisfiable'
          res.setHeader('Content-Range', `bytes */${initData.length}`)
          logHttpResponse(session, fileName, method, req.headers?.range, 416, 0)
          res.end()
          return
        }
        if (range) {
          const length = range.end - range.start + 1
          res.statusCode = 206
          session.requestStats.lastStatus = 206
          session.requestStats.lastError = null
          res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${initData.length}`)
          res.setHeader('Content-Length', length)
          logHttpResponse(session, fileName, method, req.headers?.range, 206, length)
          if (method === 'HEAD') res.end()
          else res.end(initData.subarray(range.start, range.end + 1))
          return
        }
        res.setHeader('Content-Length', initData.length)
        logHttpResponse(session, fileName, method, req.headers?.range, 200, initData.length)
        if (method === 'HEAD') res.end()
        else res.end(initData)
        return
      }

      session.requestStats.segmentRequests += 1
      session.requestStats.lastPath = fileName
      const segmentData = session.segmentStore?.getSegment?.(fileName)
      if (!segmentData) {
        res.statusCode = 404
        session.requestStats.notFoundResponses += 1
        session.requestStats.lastStatus = 404
        session.requestStats.lastError = 'Segment not found'
        res.setHeader('Content-Type', 'text/plain')
        logHttpResponse(session, fileName, method, req.headers?.range, 404, 0)
        res.end('Segment not found')
        return
      }

      const isFmp4 = fileName.endsWith('.m4s')
      res.statusCode = 200
      session.requestStats.lastStatus = 200
      session.requestStats.lastError = null
      res.setHeader('Content-Type', isFmp4 ? 'video/mp4' : 'video/mp2t')
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      res.setHeader('Accept-Ranges', 'bytes')
      const range = parseByteRange(req.headers?.range, segmentData.length)
      if (req.headers?.range && !range) {
        res.statusCode = 416
        session.requestStats.lastStatus = 416
        session.requestStats.lastError = 'Range not satisfiable'
        res.setHeader('Content-Range', `bytes */${segmentData.length}`)
        logHttpResponse(session, fileName, method, req.headers?.range, 416, 0)
        res.end()
        return
      }
      if (range) {
        const length = range.end - range.start + 1
        res.statusCode = 206
        session.requestStats.lastStatus = 206
        session.requestStats.lastError = null
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${segmentData.length}`)
        res.setHeader('Content-Length', length)
        logHttpResponse(session, fileName, method, req.headers?.range, 206, length)
        if (method === 'HEAD') res.end()
        else res.end(segmentData.subarray(range.start, range.end + 1))
        return
      }
      res.setHeader('Content-Length', segmentData.length)
      logHttpResponse(session, fileName, method, req.headers?.range, 200, segmentData.length)
      if (method === 'HEAD') res.end()
      else res.end(segmentData)
    })

    castServer.on('error', (err) => {
      castServerPort = 0
      castServerReady = null
      castServer = null
      reject(err)
    })

    castServer.on('close', () => {
      castServerPort = 0
      castServerReady = null
      castServer = null
    })

    castServer.listen(0, '0.0.0.0', () => {
      const addr = castServer.address?.() || null
      castServerPort = addr?.port || 0
      resolve(castServerPort)
    })
  })

  return castServerReady
}

function stopCastFileServer() {
  if (!castServer) return Promise.resolve()
  return new Promise((resolve) => {
    const server = castServer
    castServer = null
    castServerReady = null
    castServerPort = 0
    try {
      server.close(() => resolve())
    } catch {
      resolve()
    }
  })
}

async function runRemuxCast(session, sourceUrl, onProgress, { isVideoComplete = true } = {}) {
  let inputFormat = null
  let outputIO = null
  let outputFormat = null
  let packet = null
  let dict = null
  let reader = null
  let segmenter = null
  let writePos = 0

  try {
    const fileSize = await getHttpFileSize(sourceUrl)
    if (!fileSize) throw new Error('Could not determine source file size for cast')

    // For cast startup we need first fragments quickly:
    // - fully synced source: waiting for complete file is fine
    // - partially synced source: start after initial buffer to avoid long idle-timeout stalls
    reader = new TempFileReader(sourceUrl, fileSize, {
      waitForComplete: isVideoComplete,
      ...(isVideoComplete ? {} : { initialBufferBytes: CAST_PROGRESSIVE_STARTUP_BUFFER_BYTES }),
    })
    await reader.startDownload()

    const inputIO = reader.createIOContext(ffmpeg)
    inputFormat = new ffmpeg.InputFormatContext(inputIO)
    const videoStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.VIDEO)
    const audioStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.AUDIO)
    if (!videoStream) throw new Error('No video stream found')

    // Create segmenter — bytes from IOContext onwrite flow directly into MemorySegmentStore
    segmenter = new FMP4Segmenter(session.segmentStore, { targetDuration: 6 })
    session.segmenter = segmenter

    // Non-seekable output — fMP4 with empty_moov writes sequentially
    outputIO = new ffmpeg.IOContext(1024 * 1024, {
      onwrite: (buf) => {
        segmenter.write(Buffer.from(buf))
        writePos += buf.length
        return buf.length
      },
      onseek: (offset, whence) => {
        const AVSEEK_SIZE = 0x10000
        if (whence === AVSEEK_SIZE) return writePos
        const safeOffset = Number.isFinite(offset) ? offset : 0
        if (whence === 0) writePos = safeOffset
        else if (whence === 1) writePos += safeOffset
        else if (whence === 2) writePos += safeOffset
        writePos = Math.max(0, writePos)
        return writePos
      },
    })

    outputFormat = new ffmpeg.OutputFormatContext('mp4', outputIO)

    const outVideo = outputFormat.createStream()
    copyCodecParameters(outVideo.codecParameters, videoStream.codecParameters)
    outVideo.timeBase = videoStream.timeBase

    let outAudio = null
    if (audioStream) {
      outAudio = outputFormat.createStream()
      copyCodecParameters(outAudio.codecParameters, audioStream.codecParameters)
      outAudio.timeBase = audioStream.timeBase
    }

    dict = ffmpeg.Dictionary.from({ movflags: 'frag_keyframe+empty_moov+default_base_moof' })
    outputFormat.writeHeader(dict)
    session.status = 'transcoding'

    packet = new ffmpeg.Packet()
    let packetCount = 0
    const transcodeThrottle = { firstPtsMs: NaN, wallStartMs: NaN }

    while (inputFormat.readFrame(packet)) {
      if (session.cancelled) break

      if (packet.streamIndex === videoStream.index) {
        await throttleTranscodeToSourcePace(transcodeThrottle, packet.pts, videoStream.timeBase)
        packet.streamIndex = outVideo.index
        outputFormat.writeFrame(packet)
      } else if (audioStream && outAudio && packet.streamIndex === audioStream.index) {
        packet.streamIndex = outAudio.index
        outputFormat.writeFrame(packet)
      }

      safeUnref(packet)

      if (onProgress && packetCount % 200 === 0) {
        onProgress(Math.min(99, Math.round(packetCount / 10)))
      }

      packetCount++
      if (packetCount % 50 === 0) {
        await new Promise((r) => setImmediate(r))
      }
    }

    if (!session.cancelled) {
      if (reader?.downloadUnderflow) {
        throw new Error('Cast transcode source underflowed before completion')
      }
      outputFormat.writeTrailer()
      segmenter.finish()
      session.isComplete = true
      session.status = 'complete'
    }
  } finally {
    const cleanup = () => {
      safeDestroy(dict)
      safeDestroy(packet)
      safeDestroy(outputFormat)
      safeDestroy(outputIO)
      safeDestroy(inputFormat)
      if (reader) { try { reader.destroy() } catch {} reader = null }
    }
    session.ffmpegCleanup = cleanup
    cleanup()
    session.ffmpegCleanup = null
  }
}

async function runFullTranscodeCast(session, sourceUrl, { isVideoComplete = true } = {}) {
  let inputFormat = null
  let outputIO = null
  let outputFormat = null
  let dict = null

  let videoDecoder = null
  let videoEncoder = null
  let scaler = null
  let audioDecoder = null
  let audioEncoder = null
  let resampler = null
  let audioFifo = null

  let packet = null
  let videoFrame = null
  let scaledFrame = null
  let audioFrame = null
  let resampledFrame = null
  let encoderFrame = null
  let outputPacket = null
  let reader = null
  let segmenter = null
  let writePos = 0

  try {
    const fileSize = await getHttpFileSize(sourceUrl)
    if (!fileSize) throw new Error('Could not determine source file size for cast')
    reader = new TempFileReader(sourceUrl, fileSize, {
      waitForComplete: isVideoComplete,
      ...(isVideoComplete ? {} : { initialBufferBytes: CAST_PROGRESSIVE_STARTUP_BUFFER_BYTES }),
    })
    await reader.startDownload()
    const inputIO = reader.createIOContext(ffmpeg)
    inputFormat = new ffmpeg.InputFormatContext(inputIO)
    const videoStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.VIDEO)
    const audioStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.AUDIO)
    if (!videoStream) throw new Error('No video stream found')

    // Create segmenter — bytes from IOContext onwrite flow directly into MemorySegmentStore
    segmenter = new FMP4Segmenter(session.segmentStore, { targetDuration: 6 })
    session.segmenter = segmenter

    outputIO = new ffmpeg.IOContext(1024 * 1024, {
      onwrite: (buf) => {
        segmenter.write(Buffer.from(buf))
        writePos += buf.length
        return buf.length
      },
      onseek: (offset, whence) => {
        const AVSEEK_SIZE = 0x10000
        if (whence === AVSEEK_SIZE) return writePos
        const safeOffset = Number.isFinite(offset) ? offset : 0
        if (whence === 0) writePos = safeOffset
        else if (whence === 1) writePos += safeOffset
        else if (whence === 2) writePos += safeOffset
        writePos = Math.max(0, writePos)
        return writePos
      },
    })
    outputFormat = new ffmpeg.OutputFormatContext('mp4', outputIO)

    const outVideoStream = outputFormat.createStream()
    outVideoStream.codecParameters.type = ffmpeg.constants.mediaTypes.VIDEO
    outVideoStream.codecParameters.id = ffmpeg.constants.codecs.H264
    outVideoStream.codecParameters.width = videoStream.codecParameters.width
    outVideoStream.codecParameters.height = videoStream.codecParameters.height
    outVideoStream.timeBase = videoStream.timeBase

    const decoderSelection = selectDecoderForId(videoStream.codecParameters.id)
    if (!decoderSelection) throw new Error('Video decoder not available')
    videoDecoder = new ffmpeg.CodecContext(decoderSelection.decoder)
    videoStream.codecParameters.toContext(videoDecoder)
    videoDecoder.timeBase = videoStream.timeBase
    videoDecoder.open()

    const h264Selection = selectH264Encoder()
    if (!h264Selection) throw new Error('H.264 encoder not available')

    videoEncoder = new ffmpeg.CodecContext(h264Selection.encoder)
    videoEncoder.width = videoStream.codecParameters.width
    videoEncoder.height = videoStream.codecParameters.height
    videoEncoder.pixelFormat = ffmpeg.constants.pixelFormats.YUV420P
    videoEncoder.timeBase = videoStream.timeBase
    videoEncoder.gopSize = 48
    videoEncoder.maxBFrames = 0
    videoEncoder.bitRate = 4000000
    try { videoEncoder.setOption('preset', 'ultrafast') } catch {}
    try { videoEncoder.setOption('profile', 'high') } catch {}
    try { videoEncoder.setOption('level', '41') } catch {}
    try { videoEncoder.setOption('bf', '0') } catch {}
    videoEncoder.open()

    const decoderPixelFormat = videoDecoder.pixelFormat
    const yuv420 = ffmpeg.constants.pixelFormats.YUV420P
    const needsScale = decoderPixelFormat && decoderPixelFormat > 0 && decoderPixelFormat !== yuv420
    if (needsScale) {
      scaler = new ffmpeg.Scaler(
        decoderPixelFormat,
        videoStream.codecParameters.width,
        videoStream.codecParameters.height,
        yuv420,
        videoStream.codecParameters.width,
        videoStream.codecParameters.height,
      )
    }

    let outAudioStream = null
    if (audioStream) {
      outAudioStream = outputFormat.createStream()
      outAudioStream.codecParameters.type = ffmpeg.constants.mediaTypes.AUDIO
      outAudioStream.codecParameters.id = ffmpeg.constants.codecs.AAC
      outAudioStream.timeBase = { numerator: 1, denominator: 48000 }

      const audioDecoderSelection = selectDecoderForId(audioStream.codecParameters.id)
      if (audioDecoderSelection) {
        audioDecoder = new ffmpeg.CodecContext(audioDecoderSelection.decoder)
        audioStream.codecParameters.toContext(audioDecoder)
        audioDecoder.timeBase = audioStream.timeBase
        audioDecoder.open()

        const aacSelection = selectAacEncoder()
        if (!aacSelection) throw new Error('AAC encoder not available')
        audioEncoder = new ffmpeg.CodecContext(aacSelection.encoder)
        audioEncoder.sampleRate = 48000
        audioEncoder.channelLayout = ffmpeg.constants.channelLayouts.STEREO
        audioEncoder.sampleFormat = ffmpeg.constants.sampleFormats.FLTP
        audioEncoder.timeBase = outAudioStream.timeBase
        audioEncoder.bitRate = 128000
        audioEncoder.open()

        resampler = new ffmpeg.Resampler(
          audioDecoder.sampleRate,
          audioDecoder.channelLayout,
          audioDecoder.sampleFormat,
          audioEncoder.sampleRate,
          audioEncoder.channelLayout,
          audioEncoder.sampleFormat,
        )

        // AudioFIFO buffers resampled audio so the AAC encoder always receives
        // exactly 1024-sample frames, regardless of input frame size (e.g. E-AC3
        // produces 1536-sample frames which AAC-LC cannot accept directly).
        audioFifo = new ffmpeg.AudioFIFO(
          ffmpeg.constants.sampleFormats.FLTP,
          2, // stereo
          1024,
        )
      }
    }

    dict = ffmpeg.Dictionary.from({ movflags: 'frag_keyframe+empty_moov+default_base_moof' })
    outputFormat.writeHeader(dict)
    session.status = 'transcoding'

    packet = new ffmpeg.Packet()
    outputPacket = new ffmpeg.Packet()
    videoFrame = new ffmpeg.Frame()
    scaledFrame = new ffmpeg.Frame()
    audioFrame = new ffmpeg.Frame()
    resampledFrame = new ffmpeg.Frame()

    if (scaler) {
      scaledFrame.width = videoStream.codecParameters.width
      scaledFrame.height = videoStream.codecParameters.height
      scaledFrame.format = yuv420
      scaledFrame.alloc()
    }

    if (audioEncoder) {
      resampledFrame.format = ffmpeg.constants.sampleFormats.FLTP
      resampledFrame.channelLayout = ffmpeg.constants.channelLayouts.STEREO
      resampledFrame.sampleRate = audioEncoder.sampleRate
      resampledFrame.nbSamples = 1024
      resampledFrame.alloc()
    }

    let packetCount = 0
    const transcodeThrottle = { firstPtsMs: NaN, wallStartMs: NaN }

    while (inputFormat.readFrame(packet)) {
      if (session.cancelled) break

      if (packet.streamIndex === videoStream.index) {
        packet.timeBase = videoStream.timeBase
        if (videoDecoder.sendPacket(packet)) {
          while (videoDecoder.receiveFrame(videoFrame)) {
            let frameToEncode = videoFrame
            if (scaler) {
              // Re-allocate scaledFrame each iteration to prevent use-after-free
              safeUnref(scaledFrame)
              scaledFrame.width = videoStream.codecParameters.width
              scaledFrame.height = videoStream.codecParameters.height
              scaledFrame.format = yuv420
              scaledFrame.alloc()
              scaler.scale(videoFrame, scaledFrame)
              scaledFrame.pts = videoFrame.pts
              scaledFrame.timeBase = videoFrame.timeBase
              frameToEncode = scaledFrame
            }
            if (videoEncoder.sendFrame(frameToEncode)) {
              while (videoEncoder.receivePacket(outputPacket)) {
                await throttleTranscodeToSourcePace(transcodeThrottle, outputPacket.pts, outVideoStream.timeBase)
                outputPacket.streamIndex = outVideoStream.index
                outputFormat.writeFrame(outputPacket)
                safeUnref(outputPacket)
              }
            }
            safeUnref(videoFrame)
            if (scaler) safeUnref(scaledFrame)
          }
        }
      } else if (audioStream && audioDecoder && audioEncoder && packet.streamIndex === audioStream.index) {
        packet.timeBase = audioStream.timeBase
        if (audioDecoder.sendPacket(packet)) {
          while (audioDecoder.receiveFrame(audioFrame)) {
            const inputSamples = Math.max(1, audioFrame.nbSamples || 0)
            const inputRate = Math.max(1, audioDecoder.sampleRate || audioEncoder.sampleRate || 48000)
            const outputRate = Math.max(1, audioEncoder.sampleRate || 48000)
            const targetSamples = Math.max(1024, Math.ceil((inputSamples * outputRate) / inputRate) + 32)

            safeUnref(resampledFrame)
            resampledFrame.format = ffmpeg.constants.sampleFormats.FLTP
            resampledFrame.channelLayout = ffmpeg.constants.channelLayouts.STEREO
            resampledFrame.sampleRate = outputRate
            resampledFrame.nbSamples = targetSamples
            resampledFrame.alloc()

            const samplesConverted = resampler.convert(audioFrame, resampledFrame)
            resampledFrame.nbSamples = samplesConverted
            resampledFrame.pts = audioFrame.pts
            resampledFrame.timeBase = audioFrame.timeBase

            // Write resampled audio into FIFO, then drain in 1024-sample chunks
            audioFifo.write(resampledFrame)
            while (audioFifo.size >= 1024) {
              safeUnref(encoderFrame)
              encoderFrame = new ffmpeg.Frame()
              encoderFrame.format = ffmpeg.constants.sampleFormats.FLTP
              encoderFrame.channelLayout = ffmpeg.constants.channelLayouts.STEREO
              encoderFrame.sampleRate = outputRate
              encoderFrame.nbSamples = 1024
              encoderFrame.alloc()
              audioFifo.read(encoderFrame, 1024)
              encoderFrame.pts = audioFrame.pts
              encoderFrame.timeBase = audioFrame.timeBase
              if (audioEncoder.sendFrame(encoderFrame)) {
                while (audioEncoder.receivePacket(outputPacket)) {
                  outputPacket.streamIndex = outAudioStream.index
                  outputFormat.writeFrame(outputPacket)
                  safeUnref(outputPacket)
                }
              }
            }
            safeUnref(audioFrame)
          }
        }
      }

      safeUnref(packet)
      packetCount++
      if (packetCount % 50 === 0) {
        await new Promise((r) => setImmediate(r))
      }
    }

    if (!session.cancelled) {
      if (reader?.downloadUnderflow) {
        throw new Error('Cast transcode source underflowed before completion')
      }
      videoEncoder.sendFrame(null)
      while (videoEncoder.receivePacket(outputPacket)) {
        outputPacket.streamIndex = outVideoStream.index
        outputFormat.writeFrame(outputPacket)
        safeUnref(outputPacket)
      }

      if (audioEncoder) {
        audioEncoder.sendFrame(null)
        while (audioEncoder.receivePacket(outputPacket)) {
          outputPacket.streamIndex = outAudioStream.index
          outputFormat.writeFrame(outputPacket)
          safeUnref(outputPacket)
        }
      }

      outputFormat.writeTrailer()
      segmenter.finish()
      session.isComplete = true
      session.status = 'complete'
    }
  } finally {
    const cleanup = () => {
      safeDestroy(encoderFrame)
      safeDestroy(resampledFrame)
      safeDestroy(audioFrame)
      safeDestroy(scaledFrame)
      safeDestroy(videoFrame)
      safeDestroy(outputPacket)
      safeDestroy(packet)
      if (audioFifo) { try { audioFifo.destroy() } catch {} audioFifo = null }
      safeDestroy(resampler)
      safeDestroy(audioEncoder)
      safeDestroy(audioDecoder)
      safeDestroy(scaler)
      safeDestroy(videoEncoder)
      safeDestroy(videoDecoder)
      safeDestroy(dict)
      safeDestroy(outputFormat)
      safeDestroy(outputIO)
      safeDestroy(inputFormat)
      if (reader) { try { reader.destroy() } catch {} reader = null }
      reader = null
      segmenter = null
    }
    session.ffmpegCleanup = cleanup
    cleanup()
    session.ffmpegCleanup = null
  }
}

/**
 * Copy video stream + transcode audio to AAC.
 * Much faster than full transcode — only audio is decoded/re-encoded.
 * Used for desktop playback when audio codec (AC3/EAC3/DTS) isn't web-compatible.
 */
async function runVideoCopyAudioTranscode(session, sourceUrl, onProgress, { isVideoComplete = true } = {}) {
  let inputFormat = null
  let outputIO = null
  let outputFormat = null
  let dict = null
  let audioDecoder = null
  let audioEncoder = null
  let resampler = null
  let audioFifo = null
  let packet = null
  let audioFrame = null
  let resampledFrame = null
  let outputPacket = null
  let reader = null
  let segmenter = null
  let writePos = 0

  try {
    const fileSize = await getHttpFileSize(sourceUrl)
    if (!fileSize) throw new Error('Could not determine source file size')

    reader = new TempFileReader(sourceUrl, fileSize, {
      waitForComplete: isVideoComplete,
      ...(isVideoComplete ? {} : { initialBufferBytes: CAST_PROGRESSIVE_STARTUP_BUFFER_BYTES }),
    })
    await reader.startDownload()

    const inputIO = reader.createIOContext(ffmpeg)
    inputFormat = new ffmpeg.InputFormatContext(inputIO)
    const videoStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.VIDEO)
    const audioStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.AUDIO)
    if (!videoStream) throw new Error('No video stream found')

    segmenter = new FMP4Segmenter(session.segmentStore, { targetDuration: 6 })
    session.segmenter = segmenter

    outputIO = new ffmpeg.IOContext(1024 * 1024, {
      onwrite: (buf) => {
        segmenter.write(Buffer.from(buf))
        writePos += buf.length
        return buf.length
      },
      onseek: (offset, whence) => {
        const AVSEEK_SIZE = 0x10000
        if (whence === AVSEEK_SIZE) return writePos
        const safeOffset = Number.isFinite(offset) ? offset : 0
        if (whence === 0) writePos = safeOffset
        else if (whence === 1) writePos += safeOffset
        else if (whence === 2) writePos += safeOffset
        writePos = Math.max(0, writePos)
        return writePos
      },
    })

    outputFormat = new ffmpeg.OutputFormatContext('mp4', outputIO)

    // Video: stream copy (no decode/encode)
    const outVideo = outputFormat.createStream()
    copyCodecParameters(outVideo.codecParameters, videoStream.codecParameters)
    outVideo.timeBase = videoStream.timeBase

    // Audio: decode + re-encode to AAC stereo
    let outAudio = null
    if (audioStream) {
      outAudio = outputFormat.createStream()
      outAudio.codecParameters.type = ffmpeg.constants.mediaTypes.AUDIO
      outAudio.codecParameters.id = ffmpeg.constants.codecs.AAC
      outAudio.timeBase = { numerator: 1, denominator: 48000 }

      const audioDecoderSelection = selectDecoderForId(audioStream.codecParameters.id)
      if (audioDecoderSelection) {
        audioDecoder = new ffmpeg.CodecContext(audioDecoderSelection.decoder)
        audioStream.codecParameters.toContext(audioDecoder)
        audioDecoder.timeBase = audioStream.timeBase
        audioDecoder.open()

        const aacSelection = selectAacEncoder()
        if (!aacSelection) throw new Error('AAC encoder not available')
        audioEncoder = new ffmpeg.CodecContext(aacSelection.encoder)
        audioEncoder.sampleRate = 48000
        audioEncoder.channelLayout = ffmpeg.constants.channelLayouts.STEREO
        audioEncoder.sampleFormat = ffmpeg.constants.sampleFormats.FLTP
        audioEncoder.timeBase = outAudio.timeBase
        audioEncoder.bitRate = 128000
        audioEncoder.open()

        resampler = new ffmpeg.Resampler(
          audioDecoder.sampleRate,
          audioDecoder.channelLayout,
          audioDecoder.sampleFormat,
          audioEncoder.sampleRate,
          audioEncoder.channelLayout,
          audioEncoder.sampleFormat,
        )

        audioFifo = new ffmpeg.AudioFIFO(
          ffmpeg.constants.sampleFormats.FLTP,
          2,
          1024,
        )
      } else {
        // Can't decode this audio — drop it, at least video will play
        console.warn('[WebTranscode] No decoder for audio codec, dropping audio track')
        outAudio = null
      }
    }

    dict = ffmpeg.Dictionary.from({ movflags: 'frag_keyframe+empty_moov+default_base_moof' })
    outputFormat.writeHeader(dict)
    session.status = 'transcoding'

    packet = new ffmpeg.Packet()
    outputPacket = new ffmpeg.Packet()
    audioFrame = new ffmpeg.Frame()
    resampledFrame = new ffmpeg.Frame()

    if (audioEncoder) {
      resampledFrame.format = ffmpeg.constants.sampleFormats.FLTP
      resampledFrame.channelLayout = ffmpeg.constants.channelLayouts.STEREO
      resampledFrame.sampleRate = audioEncoder.sampleRate
      resampledFrame.nbSamples = 1024
      resampledFrame.alloc()
    }

    let packetCount = 0
    const transcodeThrottle = { firstPtsMs: NaN, wallStartMs: NaN }

    while (inputFormat.readFrame(packet)) {
      if (session.cancelled) break

      if (packet.streamIndex === videoStream.index) {
        // Video: stream copy — just write the packet directly
        await throttleTranscodeToSourcePace(transcodeThrottle, packet.pts, videoStream.timeBase)
        packet.streamIndex = outVideo.index
        outputFormat.writeFrame(packet)
      } else if (audioStream && outAudio && audioDecoder && packet.streamIndex === audioStream.index) {
        // Audio: decode → resample → FIFO → encode to AAC
        audioDecoder.sendPacket(packet)
        while (audioDecoder.receiveFrame(audioFrame)) {
          resampler.convert(audioFrame, resampledFrame)
          audioFifo.write(resampledFrame)
          while (audioFifo.read(resampledFrame, 1024)) {
            audioEncoder.sendFrame(resampledFrame)
            while (audioEncoder.receivePacket(outputPacket)) {
              outputPacket.streamIndex = outAudio.index
              outputFormat.writeFrame(outputPacket)
              safeUnref(outputPacket)
            }
          }
          safeUnref(audioFrame)
        }
      }

      safeUnref(packet)

      if (onProgress && packetCount % 200 === 0) {
        onProgress(Math.min(99, Math.round(packetCount / 10)))
      }

      packetCount++
      if (packetCount % 50 === 0) {
        await new Promise((r) => setImmediate(r))
      }
    }

    // Flush audio encoder
    if (audioEncoder && !session.cancelled) {
      audioEncoder.sendFrame(null)
      while (audioEncoder.receivePacket(outputPacket)) {
        if (outAudio) outputPacket.streamIndex = outAudio.index
        outputFormat.writeFrame(outputPacket)
        safeUnref(outputPacket)
      }
    }

    if (!session.cancelled) {
      if (reader?.downloadUnderflow) {
        throw new Error('Web transcode source underflowed before completion')
      }
      outputFormat.writeTrailer()
      segmenter.finish()
      session.isComplete = true
      session.status = 'complete'
    }
  } finally {
    const cleanup = () => {
      safeDestroy(dict)
      safeDestroy(packet)
      safeDestroy(outputPacket)
      safeDestroy(audioFrame)
      safeDestroy(resampledFrame)
      safeDestroy(audioFifo)
      safeDestroy(resampler)
      safeDestroy(audioEncoder)
      safeDestroy(audioDecoder)
      safeDestroy(outputFormat)
      safeDestroy(outputIO)
      safeDestroy(inputFormat)
      if (reader) { try { reader.destroy() } catch {} reader = null }
    }
    session.ffmpegCleanup = cleanup
    cleanup()
    session.ffmpegCleanup = null
  }
}

/**
 * Start a web-optimized transcode session.
 * Probes the source and only transcodes what's needed for Chromium playback.
 * If only audio needs transcoding (AC3/EAC3/DTS → AAC), uses fast video-copy path.
 */
/**
 * Start a transcode session targeting a specific OS-native player, using the
 * per-player capability policy in playback-compat.mjs. Produces fMP4 HLS served
 * by the cast file server (bound 0.0.0.0, so reachable at 127.0.0.1 for local
 * device/AVPlayer playback as well as Chromecast).
 *
 * @param {string} sourceUrl
 * @param {object} [options]
 * @param {string} [options.player='webkit'] - avplayer | exoplayer | webkit | chromecast
 * @param {string|null} [options.sourceKey]
 * @param {Function} [options.onProgress]
 * @param {boolean} [options.isVideoComplete=true]
 * @returns {Promise<{success:boolean, sessionId:string, mode?:string, reused?:boolean, reason?:string, error?:string}>}
 */
async function startCompatTranscode(sourceUrl, options = {}) {
  const { player = 'webkit', sourceKey = null, onProgress, isVideoComplete = true } = options

  if (sourceKey) {
    const existing = findSessionBySourceKey(sourceKey)
    if (existing && existing.status !== 'error' && existing.status !== 'cancelled' && existing.status !== 'complete') {
      return { success: true, sessionId: existing.id, reused: true }
    }
    if (existing && existing.status === 'complete') {
      stopCastTranscode(existing.id, 'replaced')
    }
  }

  const session = createCastSession(sourceUrl, sourceKey)

  try {
    await startCastFileServer()
    await ensureFfmpegLoaded()
    const probeResult = await probeMedia(sourceUrl)

    const decision = decidePlayback({
      player,
      videoCodec: probeResult.videoCodec,
      audioCodec: probeResult.audioCodec,
      container: probeResult.container,
      videoProfile: probeResult.videoProfile,
      videoLevel: probeResult.videoLevel,
    })

    if (decision.mode === 'direct') {
      session.status = 'complete'
      return { success: false, sessionId: session.id, reason: 'no-transcode-needed' }
    }

    console.log('[CompatTranscode] Starting:', decision.mode, 'for', player, '|', decision.reason)

    ;(async () => {
      try {
        if (decision.mode === 'full') {
          await runFullTranscodeCast(session, sourceUrl, { isVideoComplete })
        } else if (decision.mode === 'audio-only') {
          await runVideoCopyAudioTranscode(session, sourceUrl, onProgress, { isVideoComplete })
        } else {
          // Remux only (e.g. MKV → fMP4, no re-encoding)
          await runRemuxCast(session, sourceUrl, onProgress, { isVideoComplete })
        }
      } catch (err) {
        if (session.cancelled) {
          session.status = 'cancelled'
          session.error = session.error || 'cancelled'
        } else {
          session.status = 'error'
          session.error = err?.message || 'Compat transcode failed'
          console.error('[CompatTranscode] Error:', err?.message || err)
        }
        try { session.segmentStore?.setFinished?.() } catch {}
      }
    })()

    return { success: true, sessionId: session.id, mode: decision.mode, reused: false }
  } catch (err) {
    session.status = 'error'
    session.error = err?.message || 'Compat transcode startup failed'
    return { success: false, error: session.error, sessionId: session.id }
  }
}

/**
 * Back-compat entry for Electrobun/web (WKWebView/Chromium) playback.
 * Delegates to startCompatTranscode with the webkit policy.
 */
async function startWebTranscode(sourceUrl, options = {}) {
  return startCompatTranscode(sourceUrl, { ...options, player: 'webkit' })
}

async function startCastTranscode(sourceUrl, options = {}) {
  const { sourceKey = null, onProgress, isVideoComplete = true } = options

  if (sourceKey) {
    const existing = findSessionBySourceKey(sourceKey)
    if (existing && existing.status !== 'error' && existing.status !== 'cancelled' && existing.status !== 'complete') {
      return {
        success: true,
        sessionId: existing.id,
        reused: true,
      }
    }
    // If existing session is 'complete', clean it up so a fresh one is created
    if (existing && existing.status === 'complete') {
      stopCastTranscode(existing.id, 'replaced')
    }
  }

  const session = createCastSession(sourceUrl, sourceKey)

  try {
    await startCastFileServer()
    await ensureFfmpegLoaded()
    const probeResult = await probeMedia(sourceUrl)
    const needsVideoTranscode = !!probeResult.needsVideoTranscode
    const needsAudioTranscode = !!probeResult.needsAudioTranscode

    ;(async () => {
      try {
        if (needsVideoTranscode || needsAudioTranscode) {
          await runFullTranscodeCast(session, sourceUrl, { isVideoComplete })
        } else {
          await runRemuxCast(session, sourceUrl, onProgress, { isVideoComplete })
        }
      } catch (err) {
        if (session.cancelled) {
          session.status = 'cancelled'
          session.error = session.error || 'cancelled'
        } else {
          session.status = 'error'
          session.error = err?.message || 'Cast transcode failed'
        }
        try {
          // Ensure terminal sessions expose a finite playlist (ENDLIST)
          // so players do not stall indefinitely waiting for new segments.
          session.segmentStore?.setFinished?.()
        } catch {}
      }
    })()

    return {
      success: true,
      sessionId: session.id,
      reused: false,
    }
  } catch (err) {
    session.status = 'error'
    session.error = err?.message || 'Cast transcode startup failed'
    return {
      success: false,
      error: session.error,
      sessionId: session.id,
      reused: false,
    }
  }
}

export { startCastFileServer, stopCastFileServer, getCastServerPort }
export { createCastSession, getCastSession, findSessionBySourceKey, getCastStatus, stopCastTranscode, getCastHlsUrl }
export { generatePlaylist }
export { startCastTranscode }
export { startWebTranscode }
export { startCompatTranscode }
