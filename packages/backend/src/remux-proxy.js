/**
 * Remux Proxy — transparent HTTP proxy that detects MKV containers
 * and remuxes them to MP4 on-the-fly. Sits between the client and
 * the blob server. Non-MKV content passes through unchanged.
 *
 * MKV detection: first 4 bytes are EBML header (0x1A 0x45 0xDF 0xA3)
 */

import http from 'bare-http1'

const EBML_HEADER = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])

let ffmpeg = null
let ffmpegLoading = null

async function ensureFFmpeg () {
  if (ffmpeg) return ffmpeg
  if (ffmpegLoading) return ffmpegLoading
  ffmpegLoading = (async () => {
    try {
      const mod = await import('bare-ffmpeg')
      ffmpeg = mod.default || mod
      console.log('[RemuxProxy] FFmpeg loaded')
      return ffmpeg
    } catch (err) {
      console.error('[RemuxProxy] Failed to load FFmpeg:', err.message)
      return null
    }
  })()
  return ffmpegLoading
}

/**
 * Create a remux proxy server that wraps the blob server.
 * @param {number} blobServerPort - The port the blob server listens on
 * @param {string} host - Host to bind to (default: 127.0.0.1)
 * @returns {{ port: number, server: object }}
 */
export async function createRemuxProxy (blobServerPort, host = '127.0.0.1') {
  const server = http.createServer(async (req, res) => {
    // Forward the request to the blob server
    const blobUrl = `http://127.0.0.1:${blobServerPort}${req.url}`

    try {
      const blobRes = await fetch(blobUrl, {
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${blobServerPort}` }
      })

      // Check if this is a video response
      const contentType = blobRes.headers.get('content-type') || ''
      const isVideo = contentType.startsWith('video/')

      if (!isVideo || req.method === 'HEAD') {
        // Non-video or HEAD: pass through
        res.statusCode = blobRes.status
        for (const [key, value] of blobRes.headers) {
          if (key !== 'transfer-encoding') res.setHeader(key, value)
        }
        if (blobRes.body) {
          const reader = blobRes.body.getReader()
          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read()
              if (done) { res.end(); break }
              res.write(Buffer.from(value))
            }
          }
          pump().catch(() => res.end())
        } else {
          res.end()
        }
        return
      }

      // Video response — peek at first bytes to detect container
      const reader = blobRes.body.getReader()
      const { value: firstChunk } = await reader.read()

      if (!firstChunk || firstChunk.length < 4) {
        // Too small to detect, pass through
        res.statusCode = blobRes.status
        for (const [key, value] of blobRes.headers) {
          if (key !== 'transfer-encoding') res.setHeader(key, value)
        }
        if (firstChunk) res.write(Buffer.from(firstChunk))
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read()
            if (done) { res.end(); break }
            res.write(Buffer.from(value))
          }
        }
        pump().catch(() => res.end())
        return
      }

      const headerBytes = Buffer.from(firstChunk.slice(0, 4))
      const isMKV = headerBytes.equals(EBML_HEADER)

      if (!isMKV) {
        // Not MKV — pass through with original headers
        res.statusCode = blobRes.status
        for (const [key, value] of blobRes.headers) {
          if (key !== 'transfer-encoding') res.setHeader(key, value)
        }
        res.write(Buffer.from(firstChunk))
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read()
            if (done) { res.end(); break }
            res.write(Buffer.from(value))
          }
        }
        pump().catch(() => res.end())
        return
      }

      // MKV detected — remux to MP4 on-the-fly
      console.log('[RemuxProxy] MKV detected, remuxing to MP4')
      const ff = await ensureFFmpeg()
      if (!ff) {
        // FFmpeg not available — pass through as-is (will fail in player)
        console.warn('[RemuxProxy] FFmpeg not available, passing MKV through')
        res.statusCode = blobRes.status
        for (const [key, value] of blobRes.headers) {
          if (key !== 'transfer-encoding') res.setHeader(key, value)
        }
        res.write(Buffer.from(firstChunk))
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read()
            if (done) { res.end(); break }
            res.write(Buffer.from(value))
          }
        }
        pump().catch(() => res.end())
        return
      }

      // Set response headers for MP4 output
      res.statusCode = 200
      res.setHeader('Content-Type', 'video/mp4')
      res.setHeader('Cache-Control', 'no-cache')
      // No Content-Length (streaming remux, unknown output size)
      // No Accept-Ranges (can't seek in remuxed stream)

      // Collect ALL data first, then remux
      // (FFmpeg needs seekable input for MKV container parsing)
      const chunks = [Buffer.from(firstChunk)]
      let totalSize = firstChunk.length
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(Buffer.from(value))
          totalSize += value.length
        }
      }
      await pump()

      const inputBuffer = Buffer.concat(chunks, totalSize)
      console.log('[RemuxProxy] MKV buffered:', (totalSize / 1024 / 1024).toFixed(1), 'MB, starting remux')

      // Use FFmpeg to remux MKV → MP4 (faststart)
      const inputIO = new ff.IOContext(inputBuffer.length, {
        onread: (() => {
          let pos = 0
          return (buf) => {
            if (pos >= inputBuffer.length) return -1 // EOF
            const toRead = Math.min(buf.length, inputBuffer.length - pos)
            inputBuffer.copy(buf, 0, pos, pos + toRead)
            pos += toRead
            return toRead
          }
        })(),
        onseek: (() => {
          let pos = 0
          return (offset, whence) => {
            const AVSEEK_SIZE = 0x10000
            if (whence === AVSEEK_SIZE) return inputBuffer.length
            if (whence === 0) pos = offset
            else if (whence === 1) pos += offset
            else if (whence === 2) pos = inputBuffer.length + offset
            return pos
          }
        })()
      })

      const outputChunks = []
      let writePos = 0
      const outputIO = new ff.IOContext(1024 * 1024, {
        onwrite: (buf) => {
          outputChunks.push(Buffer.from(buf))
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
        }
      })

      try {
        const inputFormat = new ff.InputFormatContext(inputIO)
        const outputFormat = new ff.OutputFormatContext('mp4', outputIO)

        // Copy all streams
        const streamMap = []
        for (let i = 0; i < inputFormat.streams.length; i++) {
          const inStream = inputFormat.streams[i]
          const outStream = outputFormat.createStream()
          // Copy codec parameters (no re-encoding)
          const { copyCodecParameters } = await import('./transcode/ffmpeg-utils.mjs')
          copyCodecParameters(outStream.codecParameters, inStream.codecParameters)
          outStream.timeBase = inStream.timeBase
          streamMap.push({ inIndex: inStream.index, outIndex: outStream.index })
        }

        const dict = ff.Dictionary.from({ movflags: 'frag_keyframe+empty_moov+default_base_moof' })
        outputFormat.writeHeader(dict)

        const packet = new ff.Packet()
        while (inputFormat.readFrame(packet)) {
          const mapping = streamMap.find(m => m.inIndex === packet.streamIndex)
          if (mapping) {
            packet.streamIndex = mapping.outIndex
            outputFormat.writeFrame(packet)
          }
          packet.unref()
        }

        outputFormat.writeTrailer()

        // Send all output to response
        for (const chunk of outputChunks) {
          res.write(chunk)
        }
        res.end()

        console.log('[RemuxProxy] Remux complete:', (writePos / 1024 / 1024).toFixed(1), 'MB output')

        // Cleanup
        try { dict.close() } catch {}
        try { packet.close() } catch {}
        try { outputFormat.close() } catch {}
        try { inputFormat.close() } catch {}
        try { outputIO.close() } catch {}
        try { inputIO.close() } catch {}
      } catch (remuxErr) {
        console.error('[RemuxProxy] Remux failed:', remuxErr.message)
        // Try to send whatever we have
        for (const chunk of outputChunks) {
          try { res.write(chunk) } catch {}
        }
        res.end()
      }
    } catch (err) {
      console.error('[RemuxProxy] Proxy error:', err.message)
      res.statusCode = 502
      res.end('Proxy error')
    }
  })

  return new Promise((resolve, reject) => {
    server.listen(0, host, () => {
      const port = server.address().port
      console.log('[RemuxProxy] Listening on port:', port, '(proxying to blob server:', blobServerPort, ')')
      resolve({ port, server })
    })
    server.on('error', reject)
  })
}
