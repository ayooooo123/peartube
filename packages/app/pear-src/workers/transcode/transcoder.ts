/**
 * Transcoder Module
 *
 * Provides transcoding/remuxing functions for Chromecast compatibility.
 * Uses bare-ffmpeg native bindings exclusively.
 *
 * This module is imported directly into the main worker (not a separate thread)
 * since bare-worker doesn't work in Pear's sandboxed environment.
 */

import fs from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'
import http from 'bare-http1'

// Load bare-ffmpeg
let ffmpeg: any = null
let ffmpegLoadError: string | null = null

async function loadBareFfmpeg(): Promise<boolean> {
  if (ffmpeg) return true
  if (ffmpegLoadError) return false

  try {
    if (typeof require === 'function') {
      const mod = require('bare-ffmpeg')
      ffmpeg = mod?.default ?? mod
      console.log('[Transcoder] bare-ffmpeg loaded')
      return true
    }
  } catch (err: any) {
    ffmpegLoadError = err?.message || 'Failed to load bare-ffmpeg'
    console.warn('[Transcoder] bare-ffmpeg not available:', ffmpegLoadError)
  }
  return false
}

export interface TranscodeSession {
  id: string
  outputPath: string
  inputUrl: string
  status: 'starting' | 'transcoding' | 'complete' | 'error'
  progress: number
  duration: number
  error?: string
  mode: 'transcode' | 'remux'
}

// Active sessions
const sessions = new Map<string, TranscodeSession>()
let httpServer: any = null
let httpPort = 0

// Parse range header for HTTP range requests
function parseRange(rangeHeader: string | undefined, fileSize: number): { start: number, end: number } | null {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) return null

  const range = rangeHeader.slice(6)
  const [startStr, endStr] = range.split('-')
  const start = parseInt(startStr, 10) || 0
  const end = endStr ? parseInt(endStr, 10) : fileSize - 1

  if (start >= fileSize || end >= fileSize || start > end) return null
  return { start, end }
}

// Handle HTTP requests for transcoded files
function handleRequest(req: any, res: any) {
  const url = req.url || '/'

  // Extract session ID from URL: /transcode/{sessionId}
  const match = url.match(/^\/transcode\/([^\/]+)/)
  if (!match) {
    res.statusCode = 404
    res.end('Not found')
    return
  }

  const sessionId = match[1]
  const session = sessions.get(sessionId)

  if (!session) {
    res.statusCode = 404
    res.end('Session not found')
    return
  }

  if (!fs.existsSync(session.outputPath)) {
    res.statusCode = 404
    res.end('Output file not ready')
    return
  }

  try {
    const stat = fs.statSync(session.outputPath)
    const fileSize = stat.size
    const range = parseRange(req.headers?.range, fileSize)

    res.setHeader('Content-Type', 'video/mp4')
    res.setHeader('Accept-Ranges', 'bytes')

    if (range) {
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${fileSize}`)
      res.setHeader('Content-Length', range.end - range.start + 1)
      const stream = fs.createReadStream(session.outputPath, { start: range.start, end: range.end })
      stream.pipe(res)
    } else {
      res.statusCode = 200
      res.setHeader('Content-Length', fileSize)
      const stream = fs.createReadStream(session.outputPath)
      stream.pipe(res)
    }
  } catch (err: any) {
    console.error('[Transcoder] Error serving file:', err?.message)
    res.statusCode = 500
    res.end('Error serving file')
  }
}

// Initialize HTTP server for serving transcoded files
export async function initHttpServer(): Promise<number> {
  if (httpServer && httpPort > 0) return httpPort

  return new Promise((resolve, reject) => {
    try {
      httpServer = http.createServer(handleRequest)
      httpServer.listen(0, '127.0.0.1', () => {
        const addr = httpServer.address()
        httpPort = typeof addr === 'object' ? addr.port : 0
        console.log('[Transcoder] HTTP server listening on port:', httpPort)
        resolve(httpPort)
      })
    } catch (err: any) {
      console.error('[Transcoder] Failed to start HTTP server:', err?.message)
      reject(err)
    }
  })
}

// Fetch input data from URL
async function fetchInputData(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? require('bare-https') : require('bare-http1')

    const req = protocol.get(url, (res: any) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        fetchInputData(res.headers.location).then(resolve).catch(reject)
        return
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }

      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const buffer = Buffer.concat(chunks)
        resolve(buffer)
      })
      res.on('error', reject)
    })

    req.on('error', reject)
  })
}

// Remux using bare-ffmpeg (container change only, no transcoding)
async function remuxWithBareFFmpeg(session: TranscodeSession, inputData: Buffer): Promise<void> {
  if (!ffmpeg) throw new Error('bare-ffmpeg not loaded')

  console.log('[Transcoder] Starting remux with bare-ffmpeg, input size:', inputData.length)

  // Create input context from buffer
  const inputIO = new ffmpeg.IOContext(inputData)
  const inputFmt = new ffmpeg.InputFormatContext(inputIO)
  await inputFmt.openInput()
  await inputFmt.findStreamInfo()

  // Create output context
  const outputIO = new ffmpeg.IOContext(null, { writable: true })
  const outputFmt = new ffmpeg.OutputFormatContext('mp4', outputIO)

  // Copy stream info (remux - no transcoding)
  for (let i = 0; i < inputFmt.streams.length; i++) {
    const inStream = inputFmt.streams[i]
    outputFmt.addStream(inStream.codecParameters)
  }

  // Write header
  await outputFmt.writeHeader({
    movflags: 'frag_keyframe+empty_moov+default_base_moof'
  })

  // Copy packets
  const packet = new ffmpeg.Packet()
  let packetsProcessed = 0

  while (true) {
    const ret = await inputFmt.readFrame(packet)
    if (ret < 0) break // EOF or error

    // Update progress
    packetsProcessed++
    if (packetsProcessed % 100 === 0) {
      session.progress = Math.min(95, packetsProcessed / 10) // Rough estimate
    }

    await outputFmt.writeFrame(packet)
    packet.unref()
  }

  // Write trailer
  await outputFmt.writeTrailer()

  // Get output data and write to file
  const outputData = outputIO.getBuffer()
  fs.writeFileSync(session.outputPath, outputData)

  console.log('[Transcoder] Remux complete, output size:', outputData.length)
}

// Transcode audio only (video stream copy, audio to AAC)
async function transcodeAudioWithBareFFmpeg(session: TranscodeSession, inputData: Buffer): Promise<void> {
  if (!ffmpeg) throw new Error('bare-ffmpeg not loaded')

  console.log('[Transcoder] Starting audio transcode with bare-ffmpeg')

  const inputIO = new ffmpeg.IOContext(inputData)
  const inputFmt = new ffmpeg.InputFormatContext(inputIO)
  await inputFmt.openInput()
  await inputFmt.findStreamInfo()

  const outputIO = new ffmpeg.IOContext(null, { writable: true })
  const outputFmt = new ffmpeg.OutputFormatContext('mp4', outputIO)

  let audioStreamIndex = -1
  let audioDecoder: any = null
  let audioEncoder: any = null
  let resampler: any = null

  // Set up streams
  for (let i = 0; i < inputFmt.streams.length; i++) {
    const inStream = inputFmt.streams[i]

    if (inStream.codecParameters.codecType === ffmpeg.constants.mediaTypes.AUDIO && audioStreamIndex === -1) {
      audioStreamIndex = i

      // Set up audio decoder
      const decoderCodec = new ffmpeg.Codec(inStream.codecParameters.id)
      audioDecoder = new ffmpeg.CodecContext(decoderCodec)
      audioDecoder.setParameters(inStream.codecParameters)
      await audioDecoder.open()

      // Set up AAC encoder
      const encoderCodec = new ffmpeg.Codec(ffmpeg.constants.codecs.AAC)
      audioEncoder = new ffmpeg.CodecContext(encoderCodec)
      audioEncoder.sampleRate = 48000
      audioEncoder.channelLayout = ffmpeg.constants.channelLayouts.STEREO
      audioEncoder.sampleFormat = ffmpeg.constants.sampleFormats.FLTP
      audioEncoder.bitRate = 192000
      await audioEncoder.open()

      // Set up resampler if needed
      if (audioDecoder.sampleRate !== audioEncoder.sampleRate ||
          audioDecoder.channelLayout !== audioEncoder.channelLayout ||
          audioDecoder.sampleFormat !== audioEncoder.sampleFormat) {
        resampler = new ffmpeg.Resampler(
          audioDecoder.channelLayout, audioDecoder.sampleFormat, audioDecoder.sampleRate,
          audioEncoder.channelLayout, audioEncoder.sampleFormat, audioEncoder.sampleRate
        )
      }

      // Add output stream with encoder parameters
      outputFmt.addStream(audioEncoder.codecParameters)
    } else {
      // Copy other streams (including video)
      outputFmt.addStream(inStream.codecParameters)
    }
  }

  await outputFmt.writeHeader({ movflags: 'frag_keyframe+empty_moov+default_base_moof' })

  // Process packets
  const packet = new ffmpeg.Packet()
  const frame = new ffmpeg.Frame()
  let packetsProcessed = 0

  while (true) {
    const ret = await inputFmt.readFrame(packet)
    if (ret < 0) break

    packetsProcessed++
    if (packetsProcessed % 100 === 0) {
      session.progress = Math.min(95, packetsProcessed / 10)
    }

    if (packet.streamIndex === audioStreamIndex) {
      // Decode audio
      await audioDecoder.sendPacket(packet)

      while (true) {
        const decRet = await audioDecoder.receiveFrame(frame)
        if (decRet < 0) break

        // Resample if needed
        let processedFrame = frame
        if (resampler) {
          processedFrame = await resampler.convert(frame)
        }

        // Encode to AAC
        await audioEncoder.sendFrame(processedFrame)

        const outPacket = new ffmpeg.Packet()
        while (true) {
          const encRet = await audioEncoder.receivePacket(outPacket)
          if (encRet < 0) break
          await outputFmt.writeFrame(outPacket)
          outPacket.unref()
        }

        frame.unref()
      }
    } else {
      // Copy non-audio packets directly
      await outputFmt.writeFrame(packet)
    }

    packet.unref()
  }

  // Flush encoder
  await audioEncoder.sendFrame(null)
  const flushPacket = new ffmpeg.Packet()
  while (true) {
    const encRet = await audioEncoder.receivePacket(flushPacket)
    if (encRet < 0) break
    await outputFmt.writeFrame(flushPacket)
    flushPacket.unref()
  }

  await outputFmt.writeTrailer()

  const outputData = outputIO.getBuffer()
  fs.writeFileSync(session.outputPath, outputData)

  console.log('[Transcoder] Audio transcode complete, output size:', outputData.length)
}

// Full transcode (video to H.264, audio to AAC)
async function transcodeVideoWithBareFFmpeg(session: TranscodeSession, inputData: Buffer): Promise<void> {
  if (!ffmpeg) throw new Error('bare-ffmpeg not loaded')

  console.log('[Transcoder] Starting full transcode with bare-ffmpeg')

  const inputIO = new ffmpeg.IOContext(inputData)
  const inputFmt = new ffmpeg.InputFormatContext(inputIO)
  await inputFmt.openInput()
  await inputFmt.findStreamInfo()

  const outputIO = new ffmpeg.IOContext(null, { writable: true })
  const outputFmt = new ffmpeg.OutputFormatContext('mp4', outputIO)

  let videoStreamIndex = -1
  let audioStreamIndex = -1
  let videoDecoder: any = null
  let videoEncoder: any = null
  let audioDecoder: any = null
  let audioEncoder: any = null
  let scaler: any = null
  let resampler: any = null

  // Set up streams
  for (let i = 0; i < inputFmt.streams.length; i++) {
    const inStream = inputFmt.streams[i]
    const codecType = inStream.codecParameters.codecType

    if (codecType === ffmpeg.constants.mediaTypes.VIDEO && videoStreamIndex === -1) {
      videoStreamIndex = i

      // Video decoder
      const decoderCodec = new ffmpeg.Codec(inStream.codecParameters.id)
      videoDecoder = new ffmpeg.CodecContext(decoderCodec)
      videoDecoder.setParameters(inStream.codecParameters)
      await videoDecoder.open()

      // H.264 encoder
      const encoderCodec = new ffmpeg.Codec(ffmpeg.constants.codecs.H264)
      videoEncoder = new ffmpeg.CodecContext(encoderCodec)
      videoEncoder.width = videoDecoder.width
      videoEncoder.height = videoDecoder.height
      videoEncoder.pixelFormat = ffmpeg.constants.pixelFormats.YUV420P
      videoEncoder.timeBase = { num: 1, den: 30 }
      videoEncoder.bitRate = 8000000 // 8 Mbps
      videoEncoder.gopSize = 30
      videoEncoder.maxBFrames = 2

      // Set H.264 profile
      videoEncoder.setOption('profile', 'high')
      videoEncoder.setOption('level', '4.1')
      videoEncoder.setOption('preset', 'fast')

      await videoEncoder.open()

      // Scaler for pixel format conversion
      if (videoDecoder.pixelFormat !== videoEncoder.pixelFormat) {
        scaler = new ffmpeg.Scaler(
          videoDecoder.width, videoDecoder.height, videoDecoder.pixelFormat,
          videoEncoder.width, videoEncoder.height, videoEncoder.pixelFormat
        )
      }

      outputFmt.addStream(videoEncoder.codecParameters)

    } else if (codecType === ffmpeg.constants.mediaTypes.AUDIO && audioStreamIndex === -1) {
      audioStreamIndex = i

      // Audio decoder
      const decoderCodec = new ffmpeg.Codec(inStream.codecParameters.id)
      audioDecoder = new ffmpeg.CodecContext(decoderCodec)
      audioDecoder.setParameters(inStream.codecParameters)
      await audioDecoder.open()

      // AAC encoder
      const encoderCodec = new ffmpeg.Codec(ffmpeg.constants.codecs.AAC)
      audioEncoder = new ffmpeg.CodecContext(encoderCodec)
      audioEncoder.sampleRate = 48000
      audioEncoder.channelLayout = ffmpeg.constants.channelLayouts.STEREO
      audioEncoder.sampleFormat = ffmpeg.constants.sampleFormats.FLTP
      audioEncoder.bitRate = 192000
      await audioEncoder.open()

      // Resampler
      if (audioDecoder.sampleRate !== audioEncoder.sampleRate ||
          audioDecoder.channelLayout !== audioEncoder.channelLayout ||
          audioDecoder.sampleFormat !== audioEncoder.sampleFormat) {
        resampler = new ffmpeg.Resampler(
          audioDecoder.channelLayout, audioDecoder.sampleFormat, audioDecoder.sampleRate,
          audioEncoder.channelLayout, audioEncoder.sampleFormat, audioEncoder.sampleRate
        )
      }

      outputFmt.addStream(audioEncoder.codecParameters)
    }
  }

  await outputFmt.writeHeader({ movflags: 'frag_keyframe+empty_moov+default_base_moof' })

  // Process packets
  const packet = new ffmpeg.Packet()
  const frame = new ffmpeg.Frame()
  let packetsProcessed = 0

  while (true) {
    const ret = await inputFmt.readFrame(packet)
    if (ret < 0) break

    packetsProcessed++
    if (packetsProcessed % 50 === 0) {
      session.progress = Math.min(95, packetsProcessed / 20)
    }

    if (packet.streamIndex === videoStreamIndex && videoDecoder && videoEncoder) {
      await videoDecoder.sendPacket(packet)

      while (true) {
        const decRet = await videoDecoder.receiveFrame(frame)
        if (decRet < 0) break

        let processedFrame = frame
        if (scaler) {
          processedFrame = await scaler.scale(frame)
        }

        await videoEncoder.sendFrame(processedFrame)

        const outPacket = new ffmpeg.Packet()
        while (true) {
          const encRet = await videoEncoder.receivePacket(outPacket)
          if (encRet < 0) break
          outPacket.streamIndex = 0 // Video is first output stream
          await outputFmt.writeFrame(outPacket)
          outPacket.unref()
        }

        frame.unref()
      }
    } else if (packet.streamIndex === audioStreamIndex && audioDecoder && audioEncoder) {
      await audioDecoder.sendPacket(packet)

      while (true) {
        const decRet = await audioDecoder.receiveFrame(frame)
        if (decRet < 0) break

        let processedFrame = frame
        if (resampler) {
          processedFrame = await resampler.convert(frame)
        }

        await audioEncoder.sendFrame(processedFrame)

        const outPacket = new ffmpeg.Packet()
        while (true) {
          const encRet = await audioEncoder.receivePacket(outPacket)
          if (encRet < 0) break
          outPacket.streamIndex = 1 // Audio is second output stream
          await outputFmt.writeFrame(outPacket)
          outPacket.unref()
        }

        frame.unref()
      }
    }

    packet.unref()
  }

  // Flush encoders
  if (videoEncoder) {
    await videoEncoder.sendFrame(null)
    const flushPacket = new ffmpeg.Packet()
    while (true) {
      const encRet = await videoEncoder.receivePacket(flushPacket)
      if (encRet < 0) break
      flushPacket.streamIndex = 0
      await outputFmt.writeFrame(flushPacket)
      flushPacket.unref()
    }
  }

  if (audioEncoder) {
    await audioEncoder.sendFrame(null)
    const flushPacket = new ffmpeg.Packet()
    while (true) {
      const encRet = await audioEncoder.receivePacket(flushPacket)
      if (encRet < 0) break
      flushPacket.streamIndex = 1
      await outputFmt.writeFrame(flushPacket)
      flushPacket.unref()
    }
  }

  await outputFmt.writeTrailer()

  const outputData = outputIO.getBuffer()
  fs.writeFileSync(session.outputPath, outputData)

  console.log('[Transcoder] Full transcode complete, output size:', outputData.length)
}

// Progress callback type
export type ProgressCallback = (sessionId: string, progress: number) => void

// Start a transcode session
export async function startTranscode(
  id: string,
  inputUrl: string,
  mode: 'transcode' | 'remux',
  onProgress?: ProgressCallback
): Promise<{ sessionId: string, servingUrl: string }> {
  // Ensure FFmpeg is loaded
  const ffmpegLoaded = await loadBareFfmpeg()
  if (!ffmpegLoaded) {
    throw new Error('bare-ffmpeg not available: ' + ffmpegLoadError)
  }

  // Ensure HTTP server is running
  const port = await initHttpServer()

  // Create session
  const tmpDir = os.tmpdir()
  const outputPath = path.join(tmpDir, `transcode_${id}.mp4`)

  const session: TranscodeSession = {
    id,
    outputPath,
    inputUrl,
    status: 'starting',
    progress: 0,
    duration: 0,
    mode,
  }
  sessions.set(id, session)

  // Start transcoding in background (async)
  ;(async () => {
    try {
      session.status = 'transcoding'

      // Fetch input data
      console.log('[Transcoder] Fetching input from:', inputUrl)
      const inputData = await fetchInputData(inputUrl)
      console.log('[Transcoder] Input fetched, size:', inputData.length)

      // Process based on mode
      if (mode === 'remux') {
        await remuxWithBareFFmpeg(session, inputData)
      } else {
        // Full transcode - check if we need video or just audio transcoding
        // For now, do full transcode
        await transcodeVideoWithBareFFmpeg(session, inputData)
      }

      session.status = 'complete'
      session.progress = 100
      onProgress?.(id, 100)
    } catch (err: any) {
      console.error('[Transcoder] Error:', err?.message || err)
      session.status = 'error'
      session.error = err?.message || 'Transcode failed'
    }
  })()

  // Set up progress reporting
  if (onProgress) {
    const progressInterval = setInterval(() => {
      const s = sessions.get(id)
      if (!s || s.status === 'complete' || s.status === 'error') {
        clearInterval(progressInterval)
        return
      }
      onProgress(id, s.progress)
    }, 1000)
  }

  return {
    sessionId: id,
    servingUrl: `http://127.0.0.1:${port}/transcode/${id}`,
  }
}

// Stop a transcode session
export function stopTranscode(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (session) {
    // Clean up output file
    try {
      if (fs.existsSync(session.outputPath)) {
        fs.unlinkSync(session.outputPath)
      }
    } catch (err) {
      console.warn('[Transcoder] Failed to clean up output file:', err)
    }
    sessions.delete(sessionId)
  }
}

// Get session status
export function getSessionStatus(sessionId: string): TranscodeSession | null {
  return sessions.get(sessionId) || null
}

// Get HTTP server port
export function getHttpPort(): number {
  return httpPort
}
