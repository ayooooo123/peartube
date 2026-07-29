import { requestOnce } from './http-get.js'
import { getVideoMimeType } from './yt-dlp.js'
import { assertPublicHttpUrl, blockedAddressReason } from './public-url-guard.js'
import { DEFAULT_ARCHIVE_MAX_DIRECT_DOWNLOAD_BYTES } from '../constants.js'

// Direct HTTP(S) downloader for archive sources that are a plain link to the
// media file itself (e.g. a show/episode hosted on a file server or CDN) rather
// than a platform page yt-dlp would scrape. Streams the response straight to
// disk (never buffered), follows redirects, and validates the response is a
// video so a stray HTML page fails with a clear message instead of importing
// garbage.
//
// A job marked `requirePublicSource` came from the unauthenticated machine API,
// where the url is a stranger's, so the fetch is guarded rather than trusted:
//
//   every hop        re-checked with the same public-address guard the API door
//                    used, because a public url that 302s to 169.254.169.254 is
//                    the standard way past a door-only check
//   the socket       the address the connection actually reached is checked
//                    before a byte of the response is read, which is what
//                    closes DNS rebinding between the check and the connect
//   the content type the response must say it is a video; a `.mp4` on the end
//                    of a caller-chosen path is not evidence of anything
//   the size         capped, so an unauthenticated caller cannot aim the relay
//                    at an endless body
//
// What this does NOT stop: the TCP connection to a hop is established before
// its socket address can be read, so a redirect into private space still costs
// one completed connection and one GET line before it is dropped unread. That
// is a blind request, never a disclosure — nothing of the response reaches the
// caller, the job, or the log.

const VIDEO_EXT = /\.(mp4|m4v|mkv|webm|mov|avi|ts|m2ts|flv|ogv|ogg|wmv|mpg|mpeg)$/i
const VIDEO_CONTENT_TYPE = /^(video\/|application\/octet-stream|application\/mp4|binary\/octet-stream)/i
const MAX_REDIRECTS = 5
// Fallback ceiling for a guarded fetch when the instance was given none, so an
// unauthenticated caller is never unbounded by omission. Operators set the real
// number with archive.maxDirectDownloadBytes.
const DEFAULT_MAX_GUARDED_BYTES = DEFAULT_ARCHIVE_MAX_DIRECT_DOWNLOAD_BYTES

export function isDirectVideoUrl (url) {
  try {
    return VIDEO_EXT.test(new URL(url).pathname)
  } catch {
    return false
  }
}

function extensionForContentType (contentType) {
  const ct = String(contentType || '').toLowerCase()
  if (ct.includes('webm')) return '.webm'
  if (ct.includes('matroska')) return '.mkv'
  if (ct.includes('quicktime')) return '.mov'
  if (ct.includes('x-msvideo')) return '.avi'
  if (ct.includes('mp2t')) return '.ts'
  return '.mp4'
}

function filenameFromDisposition (value) {
  if (!value) return null
  const star = /filename\*=(?:UTF-8'')?"?([^";]+)"?/i.exec(value)
  if (star) { try { return decodeURIComponent(star[1]) } catch { return star[1] } }
  const plain = /filename="?([^";]+)"?/i.exec(value)
  return plain ? plain[1] : null
}

function safeName (name, fallbackExt) {
  const cleaned = String(name || '').replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '').slice(-180)
  if (!cleaned) return `video${fallbackExt}`
  return VIDEO_EXT.test(cleaned) ? cleaned : `${cleaned}${fallbackExt}`
}

// The address this response actually came from. Read off the socket rather
// than re-resolved, so there is no window between the check and the connect
// for a name to change what it points at.
function assertSocketIsPublic (res, url) {
  const address = res?.socket?.remoteAddress
  // A transport that does not expose one cannot be judged; the per-hop check
  // above is what stands in that case.
  if (!address) return
  const reason = blockedAddressReason(address)
  if (reason) {
    res.destroy?.()
    throw new Error(`refusing ${url}: the connection reached ${address}, which is ${reason}`)
  }
}

async function openStream (url, { maxRedirects = MAX_REDIRECTS, timeoutMs = 0, requirePublicSource = false, lookup = null } = {}) {
  let current = url
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // Every hop, not just the first: the caller only chose the first one, and
    // the host it redirects to is chosen by whoever answered.
    if (requirePublicSource) await assertPublicHttpUrl(current, lookup ? { lookup } : {})
    const res = await requestOnce(current, {
      headers: { 'user-agent': 'PearTube-Relay', accept: '*/*' },
      timeoutMs,
      timeoutMessage: 'direct download timed out'
    })
    if (requirePublicSource) assertSocketIsPublic(res, current)
    const status = res.statusCode || 0
    if (status >= 300 && status < 400 && res.headers?.location) {
      const next = new URL(res.headers.location, current).toString()
      res.destroy?.()
      current = next
      continue
    }
    if (status < 200 || status >= 300) {
      res.destroy?.()
      throw new Error(`direct download failed with HTTP ${status}`)
    }
    return { res, finalUrl: current }
  }
  throw new Error('too many redirects during direct download')
}

function pipeToFile (res, filePath, fs, maxBytes = 0) {
  return new Promise((resolve, reject) => {
    let fd
    try { fd = fs.openSync(filePath, 'w') } catch (err) { reject(err); return }
    let done = false
    let written = 0
    const finish = (err) => {
      if (done) return
      done = true
      try { fs.closeSync(fd) } catch {}
      if (err) reject(err); else resolve()
    }
    res.on('data', (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (maxBytes > 0) {
        written += bytes.length
        if (written > maxBytes) {
          res.destroy?.()
          finish(new Error(`direct download exceeded the ${maxBytes} byte ceiling`))
          return
        }
      }
      try { fs.writeSync(fd, bytes) } catch (err) { res.destroy?.(); finish(err) }
    })
    res.on('end', () => finish())
    res.on('error', (err) => finish(err))
  })
}

// Bytes this download may write. `0` means unbounded, which only a trusted
// (console) source can ask for and only when the operator left no ceiling.
// `headroomBytes` is what the relay's storage gate says is still free above its
// min-free-disk floor: it can only ever lower the ceiling, and is ignored when
// free space cannot be measured (null), which is the Bare/limited-fs case.
export function byteCeiling (maxBytes, requirePublicSource, headroomBytes) {
  let ceiling = maxBytes > 0 ? Math.floor(maxBytes) : 0
  if (requirePublicSource && ceiling === 0) ceiling = DEFAULT_MAX_GUARDED_BYTES
  if (Number.isFinite(headroomBytes) && headroomBytes > 0) {
    const room = Math.floor(headroomBytes)
    ceiling = ceiling > 0 ? Math.min(ceiling, room) : room
  }
  return ceiling
}

// `maxBytes` caps every download this instance performs; 0 leaves a console
// download unbounded, which is what the console has always been, while a
// guarded url seed still falls back to DEFAULT_MAX_GUARDED_BYTES. An operator's
// lower ceiling wins, and so does the storage gate's remaining headroom:
// `storageHeadroom` is an optional `() => bytes|null` reading the same free-disk
// floor archive ingestion is already gated on, so raising the ceiling for real
// media cannot turn into unbounded disk use.
export function createDirectDownloader ({ outputDir, fs, path, timeoutMs = 0, maxBytes = 0, lookup = null, storageHeadroom = null } = {}) {
  if (!outputDir) throw new Error('outputDir is required')
  return {
    async download (input = {}) {
      const url = input.url
      if (!url) throw new Error('direct download requires a url')
      const requirePublicSource = input.requirePublicSource === true
      const id = input.id || `dl_${Date.now()}`
      // Read once, before a byte is fetched: the same free-disk floor archive
      // ingestion is gated on. At or below the floor there is nothing to write
      // into, so say so instead of streaming a body onto a full volume.
      const headroomBytes = typeof storageHeadroom === 'function' ? storageHeadroom() : null
      if (Number.isFinite(headroomBytes) && headroomBytes <= 0) {
        throw new Error('relay is at its minimum free disk floor; refusing direct download')
      }
      const ceiling = byteCeiling(maxBytes, requirePublicSource, headroomBytes)
      const targetDir = path.join(outputDir, id)
      fs.mkdirSync(targetDir, { recursive: true })

      let res
      try {
        ({ res } = await openStream(url, { timeoutMs, requirePublicSource, lookup }))
      } catch (err) {
        try { fs.rmSync(targetDir, { recursive: true, force: true }) } catch {}
        throw err
      }

      const contentType = res.headers?.['content-type'] || ''
      const disposition = res.headers?.['content-disposition'] || ''
      const dispositionName = filenameFromDisposition(disposition)
      // A guarded fetch takes the server's word for what this is and nothing
      // else: the path and the filename are both chosen by the caller, so
      // letting either vouch for the content would make the check decorative.
      const looksVideo = requirePublicSource
        ? VIDEO_CONTENT_TYPE.test(contentType)
        : VIDEO_CONTENT_TYPE.test(contentType) || isDirectVideoUrl(url) || VIDEO_EXT.test(dispositionName || '')
      if (!looksVideo) {
        res.destroy?.()
        try { fs.rmSync(targetDir, { recursive: true, force: true }) } catch {}
        throw new Error(`URL did not return a downloadable video file (content-type: ${contentType || 'unknown'})`)
      }

      const ext = extensionForContentType(contentType)
      let urlName = ''
      try { urlName = decodeURIComponent(new URL(url).pathname.split('/').pop() || '') } catch { urlName = '' }
      const fileName = safeName(dispositionName || urlName, ext)
      const filePath = path.join(targetDir, fileName)

      try {
        await pipeToFile(res, filePath, fs, ceiling)
      } catch (err) {
        try { fs.rmSync(targetDir, { recursive: true, force: true }) } catch {}
        throw err
      }

      const cleanContentType = contentType.split(';')[0].trim()
      const mimeType = cleanContentType && /^video\//i.test(cleanContentType) ? cleanContentType : getVideoMimeType(filePath)

      return {
        filePath,
        title: input.title || fileName.replace(/\.[^.]+$/, '') || 'Archived video',
        description: input.description || '',
        duration: undefined,
        thumbnailUrl: null,
        thumbnailFile: null,
        creatorName: input.creatorName || null,
        mimeType,
        cleanup () {
          try { fs.rmSync(targetDir, { recursive: true, force: true }) } catch { /* best effort */ }
        }
      }
    }
  }
}
