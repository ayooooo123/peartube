/**
 * Remux Proxy — transparent HTTP proxy that detects MKV containers
 * and remuxes them to MP4 on-the-fly using bare-ffmpeg.
 *
 * MKV detection: first 4 bytes are EBML header (0x1A 0x45 0xDF 0xA3)
 * Non-MKV content passes through unchanged.
 */

import http from 'bare-http1'

const EBML_HEADER = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])

let ffmpeg = null

async function ensureFFmpeg () {
  if (ffmpeg) return ffmpeg
  try {
    const mod = await import('bare-ffmpeg')
    ffmpeg = mod.default || mod
    console.log('[RemuxProxy] FFmpeg loaded')
    return ffmpeg
  } catch (err) {
    console.error('[RemuxProxy] Failed to load FFmpeg:', err.message)
    return null
  }
}

function proxyRequest (blobServerPort, req, res) {
  const opts = {
    hostname: '127.0.0.1',
    port: blobServerPort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${blobServerPort}` }
  }

  const proxyReq = http.request(opts, (proxyRes) => {
    const contentType = proxyRes.headers['content-type'] || ''
    const isVideo = contentType.startsWith('video/')

    if (!isVideo || req.method === 'HEAD') {
      // Non-video or HEAD: pass through unchanged
      res.writeHead(proxyRes.statusCode, proxyRes.headers)
      proxyRes.pipe(res)
      return
    }

    // Video response — collect first chunk to detect MKV
    let firstChunk = null
    let isMKV = false

    proxyRes.once('data', (chunk) => {
      firstChunk = chunk
      if (chunk.length >= 4) {
        isMKV = chunk[0] === 0x1a && chunk[1] === 0x45 && chunk[2] === 0xdf && chunk[3] === 0xa3
      }

      if (!isMKV) {
        // Not MKV — pass through with original headers
        res.writeHead(proxyRes.statusCode, proxyRes.headers)
        res.write(firstChunk)
        proxyRes.pipe(res)
        return
      }

      // MKV detected — buffer entire response then remux
      console.log('[RemuxProxy] MKV detected, buffering for remux...')
      const chunks = [firstChunk]
      let totalSize = firstChunk.length

      proxyRes.on('data', (chunk) => {
        chunks.push(chunk)
        totalSize += chunk.length
        if (totalSize % (50 * 1024 * 1024) < chunk.length) {
          console.log('[RemuxProxy] Buffering:', (totalSize / 1024 / 1024).toFixed(0), 'MB')
        }
      })

      proxyRes.on('end', async () => {
        const inputBuffer = Buffer.concat(chunks, totalSize)
        console.log('[RemuxProxy] Buffered:', (totalSize / 1024 / 1024).toFixed(1), 'MB, remuxing...')

        const ff = await ensureFFmpeg()
        if (!ff) {
          console.warn('[RemuxProxy] FFmpeg not available, sending raw MKV')
          res.writeHead(200, { 'Content-Type': 'video/x-matroska', 'Content-Length': '' + totalSize })
          res.end(inputBuffer)
          return
        }

        try {
          const mp4Buffer = remuxMKVtoMP4(ff, inputBuffer)
          console.log('[RemuxProxy] Remux done:', (mp4Buffer.length / 1024 / 1024).toFixed(1), 'MB')
          res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Length': '' + mp4Buffer.length,
            'Accept-Ranges': 'bytes'
          })
          res.end(mp4Buffer)
        } catch (err) {
          console.error('[RemuxProxy] Remux failed:', err.message)
          res.writeHead(200, { 'Content-Type': 'video/x-matroska', 'Content-Length': '' + totalSize })
          res.end(inputBuffer)
        }
      })
    })

    proxyRes.on('error', (err) => {
      console.error('[RemuxProxy] Upstream error:', err.message)
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
  })

  proxyReq.on('error', (err) => {
    console.error('[RemuxProxy] Request error:', err.message)
    if (!res.headersSent) res.writeHead(502)
    res.end()
  })

  proxyReq.end()
}

function remuxMKVtoMP4 (ff, inputBuffer) {
  let inputPos = 0
  const inputIO = new ff.IOContext(64 * 1024, {
    onread: (buf) => {
      if (inputPos >= inputBuffer.length) return -1
      const toRead = Math.min(buf.length, inputBuffer.length - inputPos)
      inputBuffer.copy(buf, 0, inputPos, inputPos + toRead)
      inputPos += toRead
      return toRead
    },
    onseek: (offset, whence) => {
      const AVSEEK_SIZE = 0x10000
      if (whence === AVSEEK_SIZE) return inputBuffer.length
      if (whence === 0) inputPos = offset
      else if (whence === 1) inputPos += offset
      else if (whence === 2) inputPos = inputBuffer.length + offset
      return inputPos
    }
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

  const inputFormat = new ff.InputFormatContext(inputIO)
  const outputFormat = new ff.OutputFormatContext('mp4', outputIO)

  // Copy all streams (no re-encoding)
  const streamMap = []
  for (let i = 0; i < inputFormat.streams.length; i++) {
    const inStream = inputFormat.streams[i]
    const outStream = outputFormat.createStream()
    outStream.codecParameters.copyFrom(inStream.codecParameters)
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

  // Cleanup
  try { dict.close?.() } catch {}
  try { packet.close?.() } catch {}
  try { outputFormat.close?.() } catch {}
  try { inputFormat.close?.() } catch {}

  return Buffer.concat(outputChunks, writePos)
}

export async function createRemuxProxy (blobServerPort, host = '127.0.0.1') {
  // Pre-load ffmpeg
  ensureFFmpeg().catch(() => {})

  const server = http.createServer((req, res) => {
    proxyRequest(blobServerPort, req, res)
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
