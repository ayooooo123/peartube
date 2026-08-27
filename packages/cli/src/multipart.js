import { mkdirSync, openSync, writeSync, closeSync, rmSync } from '#fs'
import { join } from '#path'

// Streaming multipart/form-data receiver shared by the archive console and the
// authenticated companion ingest route. File bytes are written directly to a
// unique staging directory; only explicitly bounded text fields are buffered.

const DOUBLE_CRLF = Buffer.from('\r\n\r\n')
const DASH = 0x2d
const CR = 0x0d
const LF = 0x0a
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024
const DEFAULT_MAX_HEADER_BYTES = 16 * 1024
const DEFAULT_MAX_TEXT_BYTES = 1024 * 1024
const DEFAULT_MAX_FIELDS = 32
const DEFAULT_OVERHEAD_BYTES = 1024 * 1024

function multipartError (code, message, statusCode = 400) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

export function parseBoundary (contentType = '') {
  const source = String(contentType || '')
  if (!/^multipart\/form-data(?:\s*;|$)/i.test(source)) return null
  const matches = [...source.matchAll(/(?:^|;)\s*boundary=(?:"([^"]*)"|([^;\s]*))/gi)]
  if (matches.length !== 1) return null
  const boundary = (matches[0][1] || matches[0][2] || '').trim()
  if (!boundary || boundary.length > 70 || !/^[0-9A-Za-z'()+_,./:=?-]+$/.test(boundary)) return null
  return boundary
}

function parsePartHeaders (headerText, strict) {
  const headers = {}
  const lines = headerText.split('\r\n')
  if (strict && (lines.length === 0 || lines.length > 16)) throw multipartError('MULTIPART_HEADERS_INVALID', 'invalid multipart part headers')
  for (const line of lines) {
    const idx = line.indexOf(':')
    if (idx <= 0) {
      if (strict) throw multipartError('MULTIPART_HEADERS_INVALID', 'invalid multipart part headers')
      continue
    }
    const name = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (strict && (!/^[a-z0-9-]{1,64}$/.test(name) || name in headers || !value || value.length > 1024)) {
      throw multipartError('MULTIPART_HEADERS_INVALID', 'invalid multipart part headers')
    }
    if (strict && name !== 'content-disposition' && name !== 'content-type') {
      throw multipartError('MULTIPART_HEADERS_INVALID', 'unsupported multipart part header')
    }
    headers[name] = value
  }
  const disposition = headers['content-disposition'] || ''
  let name = null
  let filename = null
  if (strict) {
    const match = /^form-data;\s*name="([^"\r\n]{1,64})"(?:;\s*filename="([^"\r\n]{0,255})")?$/.exec(disposition)
    if (!match) throw multipartError('MULTIPART_DISPOSITION_INVALID', 'invalid multipart content disposition')
    name = match[1]
    filename = match[2] ?? null
  } else {
    name = /name="([^"]*)"/i.exec(disposition)?.[1] ?? null
    filename = /filename="([^"]*)"/i.exec(disposition)?.[1] ?? null
  }
  return { name, filename, contentType: headers['content-type'] || null }
}

function asBuffer (chunk) {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
}

export function receiveMultipartUpload (req, {
  boundary,
  uploadDir,
  storageHeadroom = null,
  reserveStorageBytes = null,
  releaseStorageBytes = null,
  maxBytes = DEFAULT_MAX_BYTES,
  maxTotalBytes = Math.min(Number.MAX_SAFE_INTEGER, maxBytes + DEFAULT_OVERHEAD_BYTES),
  maxHeaderBytes = DEFAULT_MAX_HEADER_BYTES,
  maxTextFieldBytes = DEFAULT_MAX_TEXT_BYTES,
  maxTextBytes = DEFAULT_MAX_TEXT_BYTES,
  maxFields = DEFAULT_MAX_FIELDS,
  strict = false,
  allowedFields = null,
  requiredFields = [],
  fileField = null,
  onChunk = null,
  signal = null,
  fs = { mkdirSync, openSync, writeSync, closeSync, rmSync },
  path = { join }
} = {}) {
  return new Promise((resolve, reject) => {
    if (!boundary) return reject(multipartError('MULTIPART_BOUNDARY_REQUIRED', 'multipart boundary is required'))
    if (!uploadDir) return reject(multipartError('MULTIPART_STORAGE_REQUIRED', 'uploadDir is required', 503))
    for (const [value, name] of [
      [maxBytes, 'maxBytes'],
      [maxTotalBytes, 'maxTotalBytes'],
      [maxHeaderBytes, 'maxHeaderBytes'],
      [maxTextFieldBytes, 'maxTextFieldBytes'],
      [maxTextBytes, 'maxTextBytes'],
      [maxFields, 'maxFields']
    ]) {
      if (!Number.isSafeInteger(value) || value < 1) return reject(multipartError('MULTIPART_LIMIT_INVALID', `${name} must be a positive integer`, 500))
    }

    const allowed = allowedFields == null ? null : new Set(allowedFields)
    const required = new Set(requiredFields)
    const dashBoundary = Buffer.from(`--${boundary}`)
    const delimiter = Buffer.from(`\r\n--${boundary}`)
    const fields = {}
    const seenNames = new Set()
    let file = null
    let totalBytes = 0
    let totalTextBytes = 0
    let partCount = 0
    let buf = Buffer.alloc(0)
    let state = 'preamble'
    let part = null
    let settled = false
    const headroomState = {}
    let reservedStorageBytes = 0
    const detach = () => {
      req.removeListener?.('data', onData)
      req.removeListener?.('end', onEnd)
      req.removeListener?.('error', onError)
      req.removeListener?.('aborted', onAborted)
      signal?.removeEventListener?.('abort', onAbort)
    }
    const releaseReservedStorage = () => {
      if (reservedStorageBytes <= 0 || typeof releaseStorageBytes !== 'function') return
      const bytes = reservedStorageBytes
      reservedStorageBytes = 0
      releaseStorageBytes(bytes)
    }
    const cleanup = () => {
      if (part?.fd != null) {
        try { fs.closeSync(part.fd) } catch {
          // Best-effort cleanup after a failed or aborted upload.
        }
        part.fd = null
      }
      const dir = part?.dir || file?.dir
      if (dir) {
        try { fs.rmSync(dir, { recursive: true, force: true }) } catch {
          // Best-effort cleanup after a failed or aborted upload.
        }
      }
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      releaseReservedStorage()
      detach()
      reject(error instanceof Error ? error : multipartError('MULTIPART_FAILED', 'multipart upload failed'))
    }
    const done = () => {
      if (settled) return
      if (strict) {
        if (!file) return fail(multipartError('MULTIPART_FILE_REQUIRED', 'multipart request requires exactly one file'))
        for (const name of required) {
          if (!(name in fields)) return fail(multipartError('MULTIPART_FIELD_REQUIRED', `multipart field ${name} is required`))
        }
      }
      settled = true
      detach()
      resolve({ fields, file, totalBytes })
    }

    function beginPart () {
      const idx = buf.indexOf(DOUBLE_CRLF)
      if (idx === -1) {
        if (buf.length > maxHeaderBytes) throw multipartError('MULTIPART_HEADERS_TOO_LARGE', 'multipart part headers are too large', 413)
        return false
      }
      if (idx > maxHeaderBytes) throw multipartError('MULTIPART_HEADERS_TOO_LARGE', 'multipart part headers are too large', 413)
      const meta = parsePartHeaders(buf.slice(0, idx).toString('utf8'), strict)
      buf = buf.slice(idx + DOUBLE_CRLF.length)
      partCount++
      if (strict) {
        if (!meta.name || seenNames.has(meta.name)) throw multipartError('MULTIPART_FIELD_DUPLICATE', 'multipart fields must be unique')
        if (allowed && !allowed.has(meta.name)) throw multipartError('MULTIPART_FIELD_UNKNOWN', `unknown multipart field ${meta.name}`)
        seenNames.add(meta.name)
      }
      part = {
        ...meta,
        isFile: meta.filename != null && meta.filename !== '',
        size: 0,
        fd: null,
        chunks: [],
        filePath: null,
        relativePath: null,
        dir: null
      }
      if (strict) {
        if (part.isFile && part.name !== fileField) throw multipartError('MULTIPART_FILE_FIELD_INVALID', 'multipart file field is invalid')
        if (!part.isFile && part.name === fileField) throw multipartError('MULTIPART_FILE_REQUIRED', 'multipart file field requires a filename')
        if (part.isFile && file) throw multipartError('MULTIPART_FILE_DUPLICATE', 'multipart request requires exactly one file')
      }
      if (partCount > maxFields + 1) throw multipartError('MULTIPART_PARTS_TOO_MANY', 'multipart request has too many parts', 413)
      if (part.isFile && !file) {
        const safeName = (part.filename || 'upload').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-180) || 'upload'
        const uploadsDir = path.join(uploadDir, 'uploads')
        fs.mkdirSync(uploadsDir, { recursive: true })
        let uploadId = null
        let dir = null
        for (let attempt = 0; attempt < 8; attempt++) {
          const candidateId = `up_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
          const candidateDir = path.join(uploadsDir, candidateId)
          try {
            fs.mkdirSync(candidateDir)
            uploadId = candidateId
            dir = candidateDir
            break
          } catch (error) {
            if (error?.code !== 'EEXIST') throw error
          }
        }
        if (!dir) throw multipartError('MULTIPART_STORAGE_COLLISION', 'unable to allocate multipart staging', 503)
        part.dir = dir
        part.relativePath = `uploads/${uploadId}/${safeName}`
        part.filePath = path.join(dir, safeName)
        part.fd = fs.openSync(part.filePath, 'wx')
      }
      state = 'body'
      return true
    }

function uploadHeadroomError(snapshot, written, chunkLength, state = null) {
  const staged = written + chunkLength
  if (Number.isFinite(snapshot)) {
    const room = Math.floor(snapshot)
    if (state && !Number.isFinite(state.sharedRoom)) state.sharedRoom = room
    const baseline = state && Number.isFinite(state.sharedRoom) ? state.sharedRoom : room
    if ((2 * staged) <= baseline && written + (2 * chunkLength) <= room) return null
    return `upload exceeded available storage headroom of ${Math.max(0, room)} bytes`
  }
  if (!snapshot || typeof snapshot !== 'object') return 'upload cannot measure archive storage headroom'
  const tmp = Math.floor(snapshot.tmp)
  const storage = Math.floor(snapshot.storage)
  if (!Number.isFinite(tmp) || !Number.isFinite(storage)) return 'upload cannot measure archive storage headroom'
  if (snapshot.sharedVolume !== false) {
    const room = Math.min(tmp, storage)
    if (state && !Number.isFinite(state.sharedRoom)) state.sharedRoom = room
    const baseline = state && Number.isFinite(state.sharedRoom) ? state.sharedRoom : room
    if ((2 * staged) <= baseline && written + (2 * chunkLength) <= room) return null
    return `upload exceeded available storage headroom of ${Math.max(0, room)} bytes`
  }
  if (state && !Number.isFinite(state.tmpRoom)) state.tmpRoom = tmp
  if (state && !Number.isFinite(state.storageRoom)) state.storageRoom = storage
  const tmpBaseline = state && Number.isFinite(state.tmpRoom) ? state.tmpRoom : tmp
  const storageBaseline = state && Number.isFinite(state.storageRoom) ? state.storageRoom : storage
  if (staged > tmpBaseline || tmp < chunkLength) return `upload exceeded available archive temp headroom of ${Math.max(0, Math.min(tmp, tmpBaseline))} bytes`
  if (staged > storageBaseline || storage < staged) return `upload exceeded available archive storage headroom of ${Math.max(0, Math.min(storage, storageBaseline))} bytes`
  return null
}

    function appendBody (chunk) {
      if (chunk.length === 0) return
      if (part.fd != null) {
        if (typeof storageHeadroom === 'function') {
          const error = uploadHeadroomError(storageHeadroom(), part.size, chunk.length, headroomState)
          if (error) throw new Error(error)
        }
        let reserved = false
        if (typeof reserveStorageBytes === 'function') {
          reserveStorageBytes(chunk.length)
          reservedStorageBytes += chunk.length
          reserved = true
        }
        try {
          fs.writeSync(part.fd, chunk)
          part.size += chunk.length
        } catch (err) {
          if (reserved) {
            reservedStorageBytes -= chunk.length
            if (typeof releaseStorageBytes === 'function') releaseStorageBytes(chunk.length)
          }
          throw err
        }
      } else if (!part.isFile) {
        part.size += chunk.length
        totalTextBytes += chunk.length
        if (part.size > maxTextFieldBytes || totalTextBytes > maxTextBytes) {
          throw multipartError('MULTIPART_FIELD_TOO_LARGE', 'multipart text fields are too large', 413)
        }
        part.chunks.push(chunk)
      }
    }

    function finishPart () {
      if (part.fd != null) {
        try { fs.closeSync(part.fd) } catch {
          // The completed descriptor is still validated by the ingest manager.
        }
        part.fd = null
        file = {
          field: part.name,
          filename: part.filename,
          mimeType: part.contentType,
          path: part.filePath,
          relativePath: part.relativePath,
          dir: part.dir,
          size: part.size,
          releaseStorageReservation: releaseReservedStorage
        }
      } else if (!part.isFile && part.name != null) {
        const encoded = Buffer.concat(part.chunks, part.size)
        const value = encoded.toString('utf8')
        if (strict && Buffer.compare(encoded, Buffer.from(value, 'utf8')) !== 0) {
          throw multipartError('MULTIPART_FIELD_INVALID_UTF8', 'multipart text field is not valid UTF-8')
        }
        fields[part.name] = value
      } else if (strict) {
        throw multipartError('MULTIPART_PART_INVALID', 'invalid multipart part')
      }
      part = null
    }

    function consumeBoundarySuffix () {
      if (buf.length < 2) return false
      if (buf[0] === DASH && buf[1] === DASH) {
        buf = buf.slice(2)
        state = 'done'
        return true
      }
      if (buf[0] === CR && buf[1] === LF) {
        buf = buf.slice(2)
        state = 'headers'
        return true
      }
      if (strict) throw multipartError('MULTIPART_BOUNDARY_INVALID', 'invalid multipart boundary suffix')
      return false
    }

    function process () {
      while (!settled) {
        if (state === 'preamble') {
          if (strict) {
            if (buf.length < dashBoundary.length) return
            if (buf.indexOf(dashBoundary) !== 0) throw multipartError('MULTIPART_PREAMBLE_INVALID', 'multipart preamble is invalid')
            buf = buf.slice(dashBoundary.length)
          } else {
            const idx = buf.indexOf(dashBoundary)
            if (idx === -1) {
              if (buf.length > dashBoundary.length) buf = buf.slice(buf.length - dashBoundary.length)
              return
            }
            buf = buf.slice(idx + dashBoundary.length)
          }
          state = 'boundary'
          continue
        }
        if (state === 'boundary') {
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
          state = 'boundary'
          continue
        }
        if (state === 'done') {
          if (strict) {
            if (buf.length > 2 || (buf.length >= 1 && buf[0] !== CR) || (buf.length === 2 && buf[1] !== LF)) {
              throw multipartError('MULTIPART_TRAILER_INVALID', 'multipart trailer is invalid')
            }
          }
          return
        }
        return
      }
    }

    function onData (chunk) {
      if (settled) return
      try {
        const next = asBuffer(chunk)
        totalBytes += next.length
        onChunk?.(next, totalBytes)
        if (totalBytes > maxTotalBytes) throw multipartError('MULTIPART_BODY_TOO_LARGE', 'multipart request body is too large', 413)
        buf = buf.length === 0 ? next : Buffer.concat([buf, next])
        process()
      } catch (error) {
        fail(error)
      }
    }
    function onEnd () {
      if (settled) return
      try {
        process()
        if (state !== 'done' || (strict && buf.length !== 0 && !(buf.length === 2 && buf[0] === CR && buf[1] === LF))) {
          throw multipartError('MULTIPART_MALFORMED', 'malformed multipart body: unexpected end of stream')
        }
        done()
      } catch (error) {
        fail(error)
      }
    }
    function onError (error) {
      fail(error instanceof Error ? error : multipartError('MULTIPART_FAILED', 'multipart upload failed'))
    }
    function onAborted () {
      fail(multipartError('REQUEST_ABORTED', 'multipart request was aborted'))
    }
    function onAbort () {
      fail(multipartError('REQUEST_CANCELLED', 'multipart request was cancelled', 499))
    }

    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
    req.once('aborted', onAborted)
    signal?.addEventListener?.('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}
