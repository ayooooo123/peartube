/**
 * Progressive MKV→MP4 remux to temp file.
 *
 * Remuxes MKV to MP4 on disk using bare-ffmpeg (stream copy, no re-encoding).
 * Returns an HTTP URL to the growing temp file. The HTTP server serves with
 * Range support so WebKit can seek within the already-remuxed portion.
 *
 * Progressive: playback starts while remux is still running.
 */

import http from 'bare-http1'
import fs from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'

const sessions = new Map()
let httpServer = null
let httpPort = 0

// ── HTTP server for serving remuxed temp files ──────────────────────────
function ensureHttpServer () {
  if (httpServer) return Promise.resolve(httpPort)

  return new Promise((resolve, reject) => {
    httpServer = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const sessionId = url.pathname.replace(/^\//, '')
      const session = sessions.get(sessionId)

      if (!session || !session.tempPath) {
        res.writeHead(404)
        res.end('Not found')
        return
      }

      // CORS
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Range')
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

      const stat = fs.statSync(session.tempPath)
      const fileSize = stat.size
      // Use the final expected size for Content-Length so WebKit shows correct duration
      const totalSize = session.expectedSize || fileSize

      res.setHeader('Content-Type', 'video/mp4')
      res.setHeader('Accept-Ranges', 'bytes')

      // Range request
      const range = req.headers.range
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-')
        const start = parseInt(parts[0], 10)
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
        const clampedEnd = Math.min(end, fileSize - 1)

        if (start >= fileSize) {
          // Requested range not yet available — return 416 or wait
          res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` })
          res.end()
          return
        }

        const chunkSize = clampedEnd - start + 1
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${clampedEnd}/${totalSize}`,
          'Content-Length': chunkSize,
        })

        if (req.method === 'HEAD') { res.end(); return }

        const stream = fs.createReadStream(session.tempPath, { start, end: clampedEnd })
        stream.pipe(res)
        stream.on('error', () => res.end())
        return
      }

      // Full request
      res.writeHead(200, { 'Content-Length': totalSize })
      if (req.method === 'HEAD') { res.end(); return }

      const stream = fs.createReadStream(session.tempPath)
      stream.pipe(res)
      stream.on('error', () => res.end())
    })

    httpServer.listen(0, '127.0.0.1', () => {
      httpPort = httpServer.address().port
      console.log('[RemuxFile] HTTP server on port:', httpPort)
      resolve(httpPort)
    })
    httpServer.on('error', reject)
  })
}

// ── Remux MKV→MP4 using bare-ffmpeg ─────────────────────────────────────
export async function startRemuxToFile (sourceUrl, options = {}) {
  const { sourceKey } = options

  // Reuse existing session
  if (sourceKey && sessions.has(sourceKey)) {
    const existing = sessions.get(sourceKey)
    if (existing.status !== 'error') {
      return { url: existing.url, sessionId: sourceKey, reused: true }
    }
  }

  const port = await ensureHttpServer()
  const sessionId = sourceKey || Math.random().toString(36).slice(2, 10)
  const tempPath = path.join(os.tmpdir(), `peartube-remux-${sessionId}.mp4`)

  const session = {
    id: sessionId,
    tempPath,
    sourceUrl,
    status: 'starting',
    expectedSize: 0,
    url: `http://127.0.0.1:${port}/${sessionId}`,
  }
  sessions.set(sessionId, session)

  // Start remux in background
  ;(async () => {
    try {
      const ffmpegMod = await import('bare-ffmpeg')
      const ffmpeg = ffmpegMod.default || ffmpegMod
      const { copyCodecParameters } = await import('./transcode/ffmpeg-utils.mjs')

      // Download source to read — use HTTP streaming IOContext
      const { getHttpFileSize } = await import('./transcode/http-file-size.mjs')
      const { TempFileReader } = await import('./transcode/temp-file-reader.mjs')

      const fileSize = await getHttpFileSize(sourceUrl)
      session.expectedSize = fileSize || 0
      console.log('[RemuxFile] Source size:', ((fileSize || 0) / 1024 / 1024).toFixed(0), 'MB')

      const reader = new TempFileReader(sourceUrl, fileSize, {
        waitForComplete: true,
      })
      await reader.startDownload()

      const inputIO = reader.createIOContext(ffmpeg)
      const inputFormat = new ffmpeg.InputFormatContext(inputIO)

      // Output via IOContext writing to file
      const fd = fs.openSync(tempPath, 'w')
      let writePos = 0
      const outputIO = new ffmpeg.IOContext(1024 * 1024, {
        onwrite: (buf) => {
          fs.writeSync(fd, buf, 0, buf.length, writePos)
          writePos += buf.length
          return buf.length
        },
        onseek: (offset, whence) => {
          const AVSEEK_SIZE = 0x10000
          if (whence === AVSEEK_SIZE) return writePos
          if (whence === 0) writePos = offset
          else if (whence === 1) writePos += offset
          else if (whence === 2) writePos += offset
          return writePos
        },
      })
      const outputFormat = new ffmpeg.OutputFormatContext('mp4', outputIO)

      // Copy video + audio streams only (skip subtitles — PGS/bitmap subs aren't MP4-compatible)
      const streamMap = []
      const VIDEO = ffmpeg.constants.mediaTypes.VIDEO
      const AUDIO = ffmpeg.constants.mediaTypes.AUDIO
      for (let i = 0; i < inputFormat.streams.length; i++) {
        const inStream = inputFormat.streams[i]
        const type = inStream.codecParameters.type
        if (type !== VIDEO && type !== AUDIO) {
          console.log('[RemuxFile] Skipping stream', i, '(not video/audio)')
          continue
        }
        const outStream = outputFormat.createStream()
        copyCodecParameters(outStream.codecParameters, inStream.codecParameters)
        outStream.timeBase = inStream.timeBase
        streamMap.push({ inIndex: inStream.index, outIndex: outStream.index })
      }
      console.log('[RemuxFile] Mapped', streamMap.length, 'streams (video+audio)')

      const dict = ffmpeg.Dictionary.from({ movflags: 'frag_keyframe+empty_moov+default_base_moof' })
      outputFormat.writeHeader(dict)
      session.status = 'remuxing'
      console.log('[RemuxFile] Remuxing started...')

      const packet = new ffmpeg.Packet()
      let packetCount = 0
      while (inputFormat.readFrame(packet)) {
        const mapping = streamMap.find(m => m.inIndex === packet.streamIndex)
        if (mapping) {
          packet.streamIndex = mapping.outIndex
          outputFormat.writeFrame(packet)
        }
        packet.unref()
        packetCount++
        if (packetCount % 5000 === 0) {
          await new Promise(r => setImmediate(r))
        }
      }

      outputFormat.writeTrailer()
      fs.closeSync(fd)
      session.status = 'complete'

      const finalSize = fs.statSync(tempPath).size
      session.expectedSize = finalSize
      console.log('[RemuxFile] Complete:', (finalSize / 1024 / 1024).toFixed(0), 'MB,', packetCount, 'packets')

      // Cleanup ffmpeg
      try { dict.close?.() } catch {}
      try { packet.close?.() } catch {}
      try { outputFormat.close?.() } catch {}
      try { outputIO.close?.() } catch {}
      try { inputFormat.close?.() } catch {}
      try { reader.destroy() } catch {}
    } catch (err) {
      console.error('[RemuxFile] Error:', err?.message)
      session.status = 'error'
      session.error = err?.message
    }
  })()

  // Wait for the first few MB to be written before returning URL
  const waitStart = Date.now()
  while (Date.now() - waitStart < 30000) {
    if (session.status === 'error') break
    try {
      const stat = fs.statSync(tempPath)
      if (stat.size > 1024 * 1024) break // 1MB written
    } catch {}
    await new Promise(r => setTimeout(r, 200))
  }

  if (session.status === 'error') {
    return { url: null, error: session.error }
  }

  console.log('[RemuxFile] URL ready:', session.url)
  return { url: session.url, sessionId, reused: false }
}

export function getRemuxStatus (sessionId) {
  return sessions.get(sessionId) || null
}

export function cleanupRemux (sessionId) {
  const session = sessions.get(sessionId)
  if (session?.tempPath) {
    try { fs.unlinkSync(session.tempPath) } catch {}
  }
  sessions.delete(sessionId)
}
