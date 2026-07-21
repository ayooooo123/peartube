import { mkdirSync, openSync, writeSync, closeSync, rmSync } from '#fs'
import { join } from '#path'

// Streaming multipart/form-data receiver for the relay archive console.
//
// The relay runs on bare-http1, which has no body parser. Uploads are videos
// (potentially many GB), so the file part is streamed straight to disk via fd
// writes and NEVER buffered in memory; text fields (small) are buffered. Part
// boundaries are matched across chunk edges by retaining a short tail between
// data events. Only a single file part is captured (the relay archives one
// video per request); any extra file parts are ignored.

const DOUBLE_CRLF = Buffer.from('\r\n\r\n')
const DASH = 0x2d // '-'
const CR = 0x0d
const LF = 0x0a
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024 // 5 GB

export function parseBoundary (contentType = '') {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''))
  if (!match) return null
  const boundary = (match[1] || match[2] || '').trim()
  return boundary || null
}

function parsePartHeaders (headerText) {
  const headers = {}
  for (const line of headerText.split('\r\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
  }
  const disposition = headers['content-disposition'] || ''
  const name = /name="([^"]*)"/i.exec(disposition)?.[1] ?? null
  const filename = /filename="([^"]*)"/i.exec(disposition)?.[1] ?? null
  return { name, filename, contentType: headers['content-type'] || null }
}

function asBuffer (chunk) {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
}

export function receiveMultipartUpload (req, {
  boundary,
  uploadDir,
  maxBytes = DEFAULT_MAX_BYTES,
  fs = { mkdirSync, openSync, writeSync, closeSync, rmSync },
  path = { join }
} = {}) {
  return new Promise((resolve, reject) => {
    if (!boundary) {
      reject(new Error('multipart boundary is required'))
      return
    }
    if (!uploadDir) {
      reject(new Error('uploadDir is required'))
      return
    }

    const dashBoundary = Buffer.from(`--${boundary}`)
    const delimiter = Buffer.from(`\r\n--${boundary}`)
    const fields = {}
    let file = null

    let buf = Buffer.alloc(0)
    let state = 'preamble' // preamble | headers | body | tail | done
    let part = null
    let settled = false

    const detach = () => {
      req.removeListener?.('data', onData)
      req.removeListener?.('end', onEnd)
      req.removeListener?.('error', onError)
    }
    const fail = (err) => {
      if (settled) return
      settled = true
      if (part?.fd != null) { try { fs.closeSync(part.fd) } catch {} }
      if (part?.dir || file?.dir) { try { fs.rmSync(part?.dir || file.dir, { recursive: true, force: true }) } catch {} }
      detach()
      reject(err)
    }
    const done = () => {
      if (settled) return
      settled = true
      detach()
      resolve({ fields, file })
    }

    function beginPart () {
      const idx = buf.indexOf(DOUBLE_CRLF)
      if (idx === -1) return false
      const meta = parsePartHeaders(buf.slice(0, idx).toString('utf8'))
      buf = buf.slice(idx + DOUBLE_CRLF.length)
      // An empty filename (e.g. an untouched <input type="file">) is not a real
      // upload — treat it as an ordinary (empty) field, not a 0-byte file.
      part = { ...meta, isFile: meta.filename != null && meta.filename !== '', size: 0, fd: null, chunks: [], filePath: null, dir: null }
      // Only the first file part is streamed to disk; ignore later ones as fields.
      if (part.isFile && !file) {
        const safeName = (part.filename || 'upload').replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '').slice(-180) || 'upload'
        const dir = path.join(uploadDir, 'uploads', `up_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`)
        fs.mkdirSync(dir, { recursive: true })
        part.dir = dir
        part.filePath = path.join(dir, safeName)
        part.fd = fs.openSync(part.filePath, 'w')
      }
      state = 'body'
      return true
    }

    function appendBody (chunk) {
      if (chunk.length === 0) return
      if (part.fd != null) {
        part.size += chunk.length
        if (part.size > maxBytes) throw new Error(`upload exceeds max size of ${maxBytes} bytes`)
        fs.writeSync(part.fd, chunk)
      } else if (!part.isFile) {
        part.size += chunk.length
        if (part.size > 1_048_576) throw new Error('multipart text field too large')
        part.chunks.push(chunk)
      }
    }

    function finishPart () {
      if (part.fd != null) {
        try { fs.closeSync(part.fd) } catch {}
        file = { field: part.name, filename: part.filename, mimeType: part.contentType, path: part.filePath, dir: part.dir, size: part.size }
      } else if (!part.isFile && part.name != null) {
        fields[part.name] = Buffer.concat(part.chunks).toString('utf8')
      }
      part = null
    }

    // Returns true if the two bytes after a boundary marker were consumed.
    function consumeBoundarySuffix () {
      if (buf.length < 2) { state = 'tail'; return false }
      if (buf[0] === DASH && buf[1] === DASH) { state = 'done'; done(); return true }
      if (buf[0] === CR && buf[1] === LF) { buf = buf.slice(2); state = 'headers'; return true }
      // Tolerate stray bytes; wait for a valid suffix.
      state = 'tail'
      return false
    }

    function process () {
      while (!settled) {
        if (state === 'preamble') {
          const idx = buf.indexOf(dashBoundary)
          if (idx === -1) {
            if (buf.length > dashBoundary.length) buf = buf.slice(buf.length - dashBoundary.length)
            return
          }
          buf = buf.slice(idx + dashBoundary.length)
          if (!consumeBoundarySuffix()) return
          continue
        }
        if (state === 'headers') {
          if (!beginPart()) return
          continue
        }
        if (state === 'body') {
          const idx = buf.indexOf(delimiter)
          if (idx === -1) {
            const keep = delimiter.length - 1
            if (buf.length > keep) {
              appendBody(buf.slice(0, buf.length - keep))
              buf = buf.slice(buf.length - keep)
            }
            return
          }
          appendBody(buf.slice(0, idx))
          finishPart()
          buf = buf.slice(idx + delimiter.length)
          if (!consumeBoundarySuffix()) return
          continue
        }
        if (state === 'tail') {
          if (!consumeBoundarySuffix()) return
          continue
        }
        return
      }
    }

    function onData (chunk) {
      if (settled) return
      try {
        const next = asBuffer(chunk)
        buf = buf.length === 0 ? next : Buffer.concat([buf, next])
        process()
      } catch (err) {
        fail(err)
      }
    }
    function onEnd () {
      if (settled) return
      if (state === 'done') { done(); return }
      try { process() } catch (err) { fail(err); return }
      if (!settled) fail(new Error('malformed multipart body: unexpected end of stream'))
    }
    function onError (err) {
      fail(err instanceof Error ? err : new Error(String(err)))
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}
