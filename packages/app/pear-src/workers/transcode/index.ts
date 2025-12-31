/**
 * Transcode Worker
 *
 * Runs in a separate bare-worker thread to transcode/remux video for
 * Chromecast compatibility.
 *
 * Uses bare-ffmpeg native bindings exclusively for all media processing.
 */

import Worker from 'bare-worker'
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
      console.log('[TranscodeWorker] bare-ffmpeg loaded')
      return true
    }
  } catch (err: any) {
    ffmpegLoadError = err?.message || 'Failed to load bare-ffmpeg'
    console.warn('[TranscodeWorker] bare-ffmpeg not available:', ffmpegLoadError)
  }
  return false
}

interface TranscodeSession {
  id: string
  outputPath: string
  inputUrl: string
  status: 'starting' | 'transcoding' | 'complete' | 'error'
  progress: number
  duration: number
  error?: string
  mode: 'transcode' | 'remux'
}

interface TranscodeCommand {
  type: 'start' | 'stop' | 'status'
  id: string
  inputUrl?: string
  duration?: number
  mode?: 'transcode' | 'remux'
}

interface TranscodeEvent {
  type: 'ready' | 'started' | 'progress' | 'complete' | 'error'
  id?: string
  port?: number
  servingUrl?: string
  percent?: number
  bytesWritten?: number
  error?: string
}

// Only run worker logic if not in main thread
if (!Worker.isMainThread) {
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

  // Handle HTTP requests for transcoded fragments
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

    if (!session || !session.outputPath) {
      res.statusCode = 404
      res.end('Session not found')
      return
    }

    // Check if file exists
    let stat: any
    try {
      stat = fs.statSync(session.outputPath)
    } catch (err) {
      res.statusCode = 404
      res.end('File not ready')
      return
    }

    const range = parseRange(req.headers?.range, stat.size)

    // Set CORS headers for Chromecast access
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', 'video/mp4')

    if (range) {
      // Partial content response
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`)
      res.setHeader('Content-Length', range.end - range.start + 1)

      const stream = fs.createReadStream(session.outputPath, { start: range.start, end: range.end })
      stream.pipe(res)
    } else {
      // Full content response
      res.statusCode = 200
      res.setHeader('Content-Length', stat.size)

      const stream = fs.createReadStream(session.outputPath)
      stream.pipe(res)
    }
  }

  // Get file size safely
  function getFileSize(filePath: string): number {
    try {
      const stat = fs.statSync(filePath)
      return stat.size
    } catch {
      return 0
    }
  }

  /**
   * Fetch data from HTTP URL
   */
  async function fetchHttpData(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? require('bare-https') : require('bare-http1')

      protocol.get(url, (res: any) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      }).on('error', reject)
    })
  }

  /**
   * Remux using bare-ffmpeg native bindings (fast, no re-encoding)
   * Copies streams from input container to MP4 container
   */
  async function remuxWithBareFFmpeg(
    session: TranscodeSession,
    inputData: Buffer
  ): Promise<void> {
    console.log('[TranscodeWorker] Remuxing with bare-ffmpeg (stream copy)')

    const inputIO = new ffmpeg.IOContext(inputData)
    const inputFormat = new ffmpeg.InputFormatContext(inputIO)

    const videoStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.VIDEO)
    const audioStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.AUDIO)

    if (!videoStream) {
      throw new Error('No video stream found')
    }

    // Prepare output
    const outputChunks: Buffer[] = []
    const outputIO = new ffmpeg.IOContext(4 * 1024 * 1024, {
      onwrite: (chunk: Buffer) => {
        outputChunks.push(Buffer.from(chunk))
        return chunk.length
      }
    })

    const outputFormat = new ffmpeg.OutputFormatContext('mp4', outputIO)

    // Copy video stream
    const outVideoStream = outputFormat.createStream()
    outVideoStream.codecParameters.copyFrom(videoStream.codecParameters)
    outVideoStream.timeBase = videoStream.timeBase

    // Copy audio stream if present
    let outAudioStream: any = null
    if (audioStream) {
      outAudioStream = outputFormat.createStream()
      outAudioStream.codecParameters.copyFrom(audioStream.codecParameters)
      outAudioStream.timeBase = audioStream.timeBase
    }

    outputFormat.writeHeader()

    const packet = new ffmpeg.Packet()
    let packetCount = 0
    let totalPackets = 0

    // Count packets for progress
    while (inputFormat.readFrame(packet)) {
      totalPackets++
      packet.unref()
    }

    // Reset and re-read
    inputIO.destroy()
    inputFormat.destroy()

    const inputIO2 = new ffmpeg.IOContext(inputData)
    const inputFormat2 = new ffmpeg.InputFormatContext(inputIO2)
    const videoStream2 = inputFormat2.getBestStream(ffmpeg.constants.mediaTypes.VIDEO)
    const audioStream2 = inputFormat2.getBestStream(ffmpeg.constants.mediaTypes.AUDIO)

    // Copy packets
    while (inputFormat2.readFrame(packet)) {
      packetCount++

      if (packet.streamIndex === videoStream2.index) {
        packet.streamIndex = outVideoStream.index
        outputFormat.writeFrame(packet)
      } else if (audioStream2 && outAudioStream && packet.streamIndex === audioStream2.index) {
        packet.streamIndex = outAudioStream.index
        outputFormat.writeFrame(packet)
      }

      packet.unref()

      // Report progress
      if (totalPackets > 0 && packetCount % 100 === 0) {
        const percent = Math.min(99, Math.round((packetCount / totalPackets) * 100))
        session.progress = percent
        Worker.parentPort.postMessage({
          type: 'progress',
          id: session.id,
          percent,
          bytesWritten: getFileSize(session.outputPath)
        } as TranscodeEvent)
      }
    }

    outputFormat.writeTrailer()

    // Write output to file
    const outputBuffer = Buffer.concat(outputChunks)
    fs.writeFileSync(session.outputPath, outputBuffer)

    // Cleanup
    inputIO2.destroy()
    inputFormat2.destroy()
    outputIO.destroy()
    outputFormat.destroy()
  }

  /**
   * Transcode audio using bare-ffmpeg (video copy, audio to AAC)
   * For files with compatible video but incompatible audio (AC3, DTS, etc.)
   */
  async function transcodeAudioWithBareFFmpeg(
    session: TranscodeSession,
    inputData: Buffer
  ): Promise<void> {
    console.log('[TranscodeWorker] Transcoding audio with bare-ffmpeg (video copy, audio to AAC)')

    const inputIO = new ffmpeg.IOContext(inputData)
    const inputFormat = new ffmpeg.InputFormatContext(inputIO)

    const videoStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.VIDEO)
    const audioStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.AUDIO)

    if (!videoStream) {
      throw new Error('No video stream found')
    }

    // Prepare output
    const outputChunks: Buffer[] = []
    const outputIO = new ffmpeg.IOContext(4 * 1024 * 1024, {
      onwrite: (chunk: Buffer) => {
        outputChunks.push(Buffer.from(chunk))
        return chunk.length
      }
    })

    const outputFormat = new ffmpeg.OutputFormatContext('mp4', outputIO)

    // Copy video stream
    const outVideoStream = outputFormat.createStream()
    outVideoStream.codecParameters.copyFrom(videoStream.codecParameters)
    outVideoStream.timeBase = videoStream.timeBase

    // Set up audio transcoding to AAC
    let audioDecoder: any = null
    let audioEncoder: any = null
    let resampler: any = null
    let outAudioStream: any = null

    if (audioStream) {
      outAudioStream = outputFormat.createStream()
      outAudioStream.codecParameters.type = ffmpeg.constants.mediaTypes.AUDIO
      outAudioStream.codecParameters.id = ffmpeg.constants.codecs.AAC
      outAudioStream.codecParameters.sampleRate = audioStream.codecParameters.sampleRate || 48000
      outAudioStream.codecParameters.channelLayout = ffmpeg.constants.channelLayouts.STEREO
      outAudioStream.codecParameters.format = ffmpeg.constants.sampleFormats.FLTP
      outAudioStream.timeBase = { numerator: 1, denominator: outAudioStream.codecParameters.sampleRate }

      // Decoder
      const decoderCodec = new ffmpeg.Codec(audioStream.codecParameters.id)
      audioDecoder = new ffmpeg.CodecContext(decoderCodec)
      audioDecoder.sampleRate = audioStream.codecParameters.sampleRate
      audioDecoder.channelLayout = audioStream.codecParameters.channelLayout
      audioDecoder.sampleFormat = audioStream.codecParameters.format
      audioDecoder.timeBase = audioStream.timeBase
      audioDecoder.open()

      // Encoder
      const encoderCodec = new ffmpeg.Codec(ffmpeg.constants.codecs.AAC)
      audioEncoder = new ffmpeg.CodecContext(encoderCodec)
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

    const packet = new ffmpeg.Packet()
    const frame = new ffmpeg.Frame()
    const resampledFrame = new ffmpeg.Frame()
    const outputPacket = new ffmpeg.Packet()

    if (outAudioStream) {
      resampledFrame.format = ffmpeg.constants.sampleFormats.FLTP
      resampledFrame.channelLayout = ffmpeg.constants.channelLayouts.STEREO
      resampledFrame.sampleRate = audioEncoder.sampleRate
      resampledFrame.nbSamples = 1024
      resampledFrame.alloc()
    }

    let packetCount = 0
    let totalPackets = 0

    // Count packets
    while (inputFormat.readFrame(packet)) {
      totalPackets++
      packet.unref()
    }

    // Reset
    inputIO.destroy()
    inputFormat.destroy()

    const inputIO2 = new ffmpeg.IOContext(inputData)
    const inputFormat2 = new ffmpeg.InputFormatContext(inputIO2)
    const videoStream2 = inputFormat2.getBestStream(ffmpeg.constants.mediaTypes.VIDEO)
    const audioStream2 = inputFormat2.getBestStream(ffmpeg.constants.mediaTypes.AUDIO)

    // Process packets
    while (inputFormat2.readFrame(packet)) {
      packetCount++

      if (packet.streamIndex === videoStream2.index) {
        packet.streamIndex = outVideoStream.index
        outputFormat.writeFrame(packet)
      } else if (audioStream2 && outAudioStream && packet.streamIndex === audioStream2.index) {
        packet.timeBase = audioStream2.timeBase

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

      // Report progress
      if (totalPackets > 0 && packetCount % 100 === 0) {
        const percent = Math.min(99, Math.round((packetCount / totalPackets) * 100))
        session.progress = percent
        Worker.parentPort.postMessage({
          type: 'progress',
          id: session.id,
          percent,
          bytesWritten: getFileSize(session.outputPath)
        } as TranscodeEvent)
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

    // Write to file
    const outputBuffer = Buffer.concat(outputChunks)
    fs.writeFileSync(session.outputPath, outputBuffer)

    // Cleanup
    inputIO2.destroy()
    inputFormat2.destroy()
    outputIO.destroy()
    outputFormat.destroy()
    if (audioDecoder) audioDecoder.destroy()
    if (audioEncoder) audioEncoder.destroy()
    if (resampler) resampler.destroy()
  }

  /**
   * Full transcode using bare-ffmpeg (video + audio re-encoding)
   * Used when video codec needs to be changed (HEVC → H.264)
   */
  async function transcodeVideoWithBareFFmpeg(
    session: TranscodeSession,
    inputData: Buffer
  ): Promise<void> {
    console.log('[TranscodeWorker] Full transcode with bare-ffmpeg (video + audio)')

    const inputIO = new ffmpeg.IOContext(inputData)
    const inputFormat = new ffmpeg.InputFormatContext(inputIO)

    const videoStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.VIDEO)
    const audioStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.AUDIO)

    if (!videoStream) {
      throw new Error('No video stream found')
    }

    // Prepare output
    const outputChunks: Buffer[] = []
    const outputIO = new ffmpeg.IOContext(4 * 1024 * 1024, {
      onwrite: (chunk: Buffer) => {
        outputChunks.push(Buffer.from(chunk))
        return chunk.length
      }
    })

    const outputFormat = new ffmpeg.OutputFormatContext('mp4', outputIO)

    // Set up video transcoding to H.264
    const outVideoStream = outputFormat.createStream()
    outVideoStream.codecParameters.type = ffmpeg.constants.mediaTypes.VIDEO
    outVideoStream.codecParameters.id = ffmpeg.constants.codecs.H264
    outVideoStream.codecParameters.width = videoStream.codecParameters.width
    outVideoStream.codecParameters.height = videoStream.codecParameters.height
    outVideoStream.codecParameters.format = ffmpeg.constants.pixelFormats.YUV420P
    outVideoStream.timeBase = videoStream.timeBase

    // Video decoder
    const videoDecoderCodec = new ffmpeg.Codec(videoStream.codecParameters.id)
    const videoDecoder = new ffmpeg.CodecContext(videoDecoderCodec)
    videoDecoder.width = videoStream.codecParameters.width
    videoDecoder.height = videoStream.codecParameters.height
    videoDecoder.pixelFormat = videoStream.codecParameters.format
    videoDecoder.timeBase = videoStream.timeBase
    videoDecoder.open()

    // Video encoder (H.264)
    const videoEncoderCodec = new ffmpeg.Codec(ffmpeg.constants.codecs.H264)
    const videoEncoder = new ffmpeg.CodecContext(videoEncoderCodec)
    videoEncoder.width = videoStream.codecParameters.width
    videoEncoder.height = videoStream.codecParameters.height
    videoEncoder.pixelFormat = ffmpeg.constants.pixelFormats.YUV420P
    videoEncoder.timeBase = videoStream.timeBase
    videoEncoder.bitRate = 8000000 // 8 Mbps
    videoEncoder.open()

    // Video scaler for pixel format conversion if needed
    let scaler: any = null
    if (videoStream.codecParameters.format !== ffmpeg.constants.pixelFormats.YUV420P) {
      scaler = new ffmpeg.Scaler(
        videoStream.codecParameters.width,
        videoStream.codecParameters.height,
        videoStream.codecParameters.format,
        videoStream.codecParameters.width,
        videoStream.codecParameters.height,
        ffmpeg.constants.pixelFormats.YUV420P
      )
    }

    // Set up audio transcoding to AAC
    let audioDecoder: any = null
    let audioEncoder: any = null
    let resampler: any = null
    let outAudioStream: any = null

    if (audioStream) {
      outAudioStream = outputFormat.createStream()
      outAudioStream.codecParameters.type = ffmpeg.constants.mediaTypes.AUDIO
      outAudioStream.codecParameters.id = ffmpeg.constants.codecs.AAC
      outAudioStream.codecParameters.sampleRate = audioStream.codecParameters.sampleRate || 48000
      outAudioStream.codecParameters.channelLayout = ffmpeg.constants.channelLayouts.STEREO
      outAudioStream.codecParameters.format = ffmpeg.constants.sampleFormats.FLTP
      outAudioStream.timeBase = { numerator: 1, denominator: outAudioStream.codecParameters.sampleRate }

      // Decoder
      const decoderCodec = new ffmpeg.Codec(audioStream.codecParameters.id)
      audioDecoder = new ffmpeg.CodecContext(decoderCodec)
      audioDecoder.sampleRate = audioStream.codecParameters.sampleRate
      audioDecoder.channelLayout = audioStream.codecParameters.channelLayout
      audioDecoder.sampleFormat = audioStream.codecParameters.format
      audioDecoder.timeBase = audioStream.timeBase
      audioDecoder.open()

      // Encoder
      const encoderCodec = new ffmpeg.Codec(ffmpeg.constants.codecs.AAC)
      audioEncoder = new ffmpeg.CodecContext(encoderCodec)
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

    const packet = new ffmpeg.Packet()
    const videoFrame = new ffmpeg.Frame()
    const scaledFrame = new ffmpeg.Frame()
    const audioFrame = new ffmpeg.Frame()
    const resampledFrame = new ffmpeg.Frame()
    const outputPacket = new ffmpeg.Packet()

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
    let totalPackets = 0

    // Count packets
    while (inputFormat.readFrame(packet)) {
      totalPackets++
      packet.unref()
    }

    // Reset
    inputIO.destroy()
    inputFormat.destroy()

    const inputIO2 = new ffmpeg.IOContext(inputData)
    const inputFormat2 = new ffmpeg.InputFormatContext(inputIO2)
    const videoStream2 = inputFormat2.getBestStream(ffmpeg.constants.mediaTypes.VIDEO)
    const audioStream2 = inputFormat2.getBestStream(ffmpeg.constants.mediaTypes.AUDIO)

    // Process packets
    while (inputFormat2.readFrame(packet)) {
      packetCount++

      if (packet.streamIndex === videoStream2.index) {
        packet.timeBase = videoStream2.timeBase

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
      } else if (audioStream2 && outAudioStream && packet.streamIndex === audioStream2.index) {
        packet.timeBase = audioStream2.timeBase

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

      // Report progress
      if (totalPackets > 0 && packetCount % 100 === 0) {
        const percent = Math.min(99, Math.round((packetCount / totalPackets) * 100))
        session.progress = percent
        Worker.parentPort.postMessage({
          type: 'progress',
          id: session.id,
          percent,
          bytesWritten: getFileSize(session.outputPath)
        } as TranscodeEvent)
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

    // Write to file
    const outputBuffer = Buffer.concat(outputChunks)
    fs.writeFileSync(session.outputPath, outputBuffer)

    // Cleanup
    inputIO2.destroy()
    inputFormat2.destroy()
    outputIO.destroy()
    outputFormat.destroy()
    videoDecoder.destroy()
    videoEncoder.destroy()
    if (scaler) scaler.destroy()
    if (audioDecoder) audioDecoder.destroy()
    if (audioEncoder) audioEncoder.destroy()
    if (resampler) resampler.destroy()
  }

  /**
   * Start transcoding or remuxing a video
   */
  async function startTranscode(id: string, inputUrl: string, duration: number = 0, mode: 'transcode' | 'remux' = 'transcode') {
    const outputPath = path.join(os.tmpdir(), `peartube_transcode_${id}.mp4`)

    const session: TranscodeSession = {
      id,
      outputPath,
      inputUrl,
      status: 'starting',
      progress: 0,
      duration,
      mode
    }
    sessions.set(id, session)

    // Notify that we're starting
    Worker.parentPort.postMessage({
      type: 'started',
      id,
      servingUrl: `http://127.0.0.1:${httpPort}/transcode/${id}`
    } as TranscodeEvent)

    session.status = 'transcoding'

    try {
      // Load bare-ffmpeg
      const loaded = await loadBareFfmpeg()
      if (!loaded) {
        throw new Error(ffmpegLoadError || 'bare-ffmpeg not available')
      }

      // Get input data
      let inputData: Buffer
      if (inputUrl.startsWith('http://') || inputUrl.startsWith('https://')) {
        console.log('[TranscodeWorker] Fetching HTTP source...')
        inputData = await fetchHttpData(inputUrl)
      } else {
        inputData = fs.readFileSync(inputUrl)
      }

      console.log('[TranscodeWorker] Input size:', inputData.length, 'bytes')

      if (mode === 'remux') {
        // REMUX: just copy streams to MP4 container
        await remuxWithBareFFmpeg(session, inputData)
      } else {
        // TRANSCODE: re-encode video and/or audio
        // First try audio-only transcode (video copy, audio to AAC)
        // If that fails, do full video + audio transcode
        try {
          await transcodeAudioWithBareFFmpeg(session, inputData)
        } catch (err: any) {
          console.log('[TranscodeWorker] Audio transcode failed, trying full video transcode:', err?.message)
          await transcodeVideoWithBareFFmpeg(session, inputData)
        }
      }

      session.status = 'complete'
      session.progress = 100
      Worker.parentPort.postMessage({
        type: 'complete',
        id,
        bytesWritten: getFileSize(outputPath)
      } as TranscodeEvent)

    } catch (err: any) {
      session.status = 'error'
      session.error = err?.message || 'Transcode failed'
      console.error('[TranscodeWorker] Error:', session.error)
      Worker.parentPort.postMessage({
        type: 'error',
        id,
        error: session.error
      } as TranscodeEvent)
    }
  }

  // Stop transcoding and cleanup
  function stopTranscode(id: string) {
    const session = sessions.get(id)
    if (!session) return

    try {
      fs.unlinkSync(session.outputPath)
    } catch {}

    sessions.delete(id)
  }

  // Initialize HTTP server
  httpServer = http.createServer(handleRequest)

  httpServer.listen(0, '127.0.0.1', () => {
    const addr = httpServer.address()
    httpPort = addr.port

    Worker.parentPort.postMessage({
      type: 'ready',
      port: httpPort
    } as TranscodeEvent)
  })

  // Listen for commands
  Worker.parentPort.on('message', (cmd: TranscodeCommand) => {
    switch (cmd.type) {
      case 'start':
        if (cmd.inputUrl) {
          startTranscode(cmd.id, cmd.inputUrl, cmd.duration || 0, cmd.mode || 'transcode')
        }
        break

      case 'stop':
        stopTranscode(cmd.id)
        break

      case 'status':
        const session = sessions.get(cmd.id)
        if (session) {
          Worker.parentPort.postMessage({
            type: 'progress',
            id: cmd.id,
            percent: session.progress,
            bytesWritten: getFileSize(session.outputPath)
          } as TranscodeEvent)
        }
        break
    }
  })

  // Cleanup on exit
  process.on('exit', () => {
    for (const [id] of sessions) {
      stopTranscode(id)
    }
    if (httpServer) {
      httpServer.close()
    }
  })
}

export type { TranscodeCommand, TranscodeEvent, TranscodeSession }
