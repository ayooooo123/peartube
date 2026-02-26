import http from 'bare-http1'

import { probeMedia, loadBareFfmpeg } from './transcoder.mjs'
import { safeDestroy, safeUnref, copyCodecParameters } from './ffmpeg-utils.mjs'
import { TempFileReader } from './temp-file-reader.mjs'
import { getHttpFileSize } from './http-file-size.mjs'
import { MemorySegmentStore } from './segment-store.mjs'
import { FMP4Segmenter } from './fmp4-segmenter.mjs'

const sessions = new Map()
let castServer = null
let castServerPort = 0
let castServerReady = null
let ffmpeg = null

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Range,Content-Type,Accept,Origin')
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges')
}

function parseByteRange(rangeHeader, fileSize) {
  if (!rangeHeader) return null
  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/)
  if (!match) return null
  const rawStart = match[1]
  const rawEnd = match[2]

  if (rawStart && rawEnd) {
    const start = parseInt(rawStart, 10)
    const end = parseInt(rawEnd, 10)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return null
    return { start, end: Math.min(end, fileSize - 1) }
  }

  if (rawStart && !rawEnd) {
    const start = parseInt(rawStart, 10)
    if (!Number.isFinite(start) || start < 0) return null
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

function makeSessionId() {
  return `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 10)}`
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
    segmentStore: new MemorySegmentStore({ maxSegments: 50, isFmp4: true }),
    requestStats: {
      playlistRequests: 0,
      initRequests: 0,
      segmentRequests: 0,
      notFoundResponses: 0,
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
  return `http://${host}:${castServerPort}/cast/${sessionId}/playlist.m3u8`
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
      const match = parsed.pathname.match(/^\/cast\/([^/]+)\/(playlist\.m3u8|init\.mp4|seg-\d+\.(?:m4s|ts))$/)
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

      if (fileName === 'playlist.m3u8') {
        session.requestStats.playlistRequests += 1
        session.requestStats.lastPath = fileName
        const playlist = generatePlaylist(session)
        console.log('[cast-transcoder] playlist request', sessionId, 'segments=', session.segmentStore?.getSegmentCount?.() || 0)
        if (!playlist) {
          res.statusCode = 503
          session.requestStats.lastStatus = 503
          session.requestStats.lastError = 'Manifest not ready'
          res.setHeader('Retry-After', '1')
          res.setHeader('Content-Type', 'text/plain')
          res.end('Manifest not ready')
          return
        }
        res.statusCode = 200
        session.requestStats.lastStatus = 200
        session.requestStats.lastError = null
        res.setHeader('Content-Type', 'application/x-mpegURL')
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        res.setHeader('Pragma', 'no-cache')
        res.setHeader('Content-Length', Buffer.byteLength(playlist))
        if (method === 'HEAD') res.end()
        else res.end(playlist)
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
          res.end('Init not ready')
          return
        }
        res.statusCode = 200
        session.requestStats.lastStatus = 200
        session.requestStats.lastError = null
        res.setHeader('Content-Type', 'video/mp4')
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        res.setHeader('Content-Length', initData.length)
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
        res.end('Segment not found')
        return
      }

      const isFmp4 = fileName.endsWith('.m4s')
      res.statusCode = 200
      session.requestStats.lastStatus = 200
      session.requestStats.lastError = null
      res.setHeader('Content-Type', isFmp4 ? 'video/mp4' : 'video/mp2t')
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      res.setHeader('Content-Length', segmentData.length)
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

async function runRemuxCast(session, sourceUrl, onProgress) {
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

    // waitForComplete: true — prevents premature EOF when transcoder catches up to P2P download
    reader = new TempFileReader(sourceUrl, fileSize, { waitForComplete: true })
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
        if (whence === 0) writePos = offset
        else if (whence === 1) writePos += offset
        else if (whence === 2) writePos += offset
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

    while (inputFormat.readFrame(packet)) {
      if (session.cancelled) break

      if (packet.streamIndex === videoStream.index) {
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

async function runFullTranscodeCast(session, sourceUrl) {
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

  let packet = null
  let videoFrame = null
  let scaledFrame = null
  let audioFrame = null
  let resampledFrame = null
  let outputPacket = null
  let reader = null
  let segmenter = null
  let writePos = 0

  try {
    const fileSize = await getHttpFileSize(sourceUrl)
    if (!fileSize) throw new Error('Could not determine source file size for cast')
    reader = new TempFileReader(sourceUrl, fileSize, { waitForComplete: true })
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
        if (whence === 0) writePos = offset
        else if (whence === 1) writePos += offset
        else if (whence === 2) writePos += offset
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

    while (inputFormat.readFrame(packet)) {
      if (session.cancelled) break

      if (packet.streamIndex === videoStream.index) {
        packet.timeBase = videoStream.timeBase
        if (videoDecoder.sendPacket(packet)) {
          while (videoDecoder.receiveFrame(videoFrame)) {
            let frameToEncode = videoFrame
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
                safeUnref(outputPacket)
              }
            }
          }
        }
      } else if (audioStream && audioDecoder && audioEncoder && packet.streamIndex === audioStream.index) {
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
                safeUnref(outputPacket)
              }
            }
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
      safeDestroy(resampledFrame)
      safeDestroy(audioFrame)
      safeDestroy(scaledFrame)
      safeDestroy(videoFrame)
      safeDestroy(outputPacket)
      safeDestroy(packet)
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

async function startCastTranscode(sourceUrl, options = {}) {
  const { sourceKey = null, onProgress } = options

  if (sourceKey) {
    const existing = findSessionBySourceKey(sourceKey)
    if (existing && existing.status !== 'error' && existing.status !== 'cancelled') {
      return {
        success: true,
        sessionId: existing.id,
        reused: true,
      }
    }
  }

  const session = createCastSession(sourceUrl, sourceKey)

  try {
    await startCastFileServer()
    await ensureFfmpegLoaded()
    const probeResult = await probeMedia(sourceUrl)
    const needsVideoTranscode = !!probeResult.needsVideoTranscode
    const needsAudioTranscode = !!probeResult.needsAudioTranscode
    const needsRemux = !!probeResult.needsRemux
    void needsRemux

    ;(async () => {
      try {
        if (needsVideoTranscode || needsAudioTranscode) {
          await runFullTranscodeCast(session, sourceUrl)
        } else {
          await runRemuxCast(session, sourceUrl, onProgress)
        }
      } catch (err) {
        if (session.cancelled) {
          session.status = 'cancelled'
          session.error = session.error || 'cancelled'
        } else {
          session.status = 'error'
          session.error = err?.message || 'Cast transcode failed'
        }
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
