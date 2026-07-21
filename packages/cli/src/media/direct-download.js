import { request as httpsRequest } from '#https'
import { request as httpRequest } from '#http'
import { getVideoMimeType } from './yt-dlp.js'

// Direct HTTP(S) downloader for archive sources that are a plain link to the
// media file itself (e.g. a show/episode hosted on a file server or CDN) rather
// than a platform page yt-dlp would scrape. Streams the response straight to
// disk (never buffered), follows redirects, and validates the response is a
// video so a stray HTML page fails with a clear message instead of importing
// garbage.

const VIDEO_EXT = /\.(mp4|m4v|mkv|webm|mov|avi|ts|m2ts|flv|ogv|ogg|wmv|mpg|mpeg)$/i
const VIDEO_CONTENT_TYPE = /^(video\/|application\/octet-stream|application\/mp4|binary\/octet-stream)/i
const MAX_REDIRECTS = 5

export function isDirectVideoUrl (url) {
  try {
    return VIDEO_EXT.test(new URL(url).pathname)
  } catch {
    return false
  }
}

function requestFor (url) {
  return new URL(url).protocol === 'http:' ? httpRequest : httpsRequest
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

function requestOnce (url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    const doRequest = requestFor(url)
    let req
    try {
      req = doRequest(url, { method: 'GET', headers }, (res) => { settled = true; resolve(res) })
    } catch (err) {
      reject(err)
      return
    }
    if (timeoutMs > 0) {
      const timer = setTimeout(() => { if (!settled) { req.destroy?.(new Error('direct download timed out')) } }, timeoutMs)
      timer?.unref?.()
    }
    req.on('error', (err) => { if (!settled) reject(err) })
    req.end()
  })
}

async function openStream (url, { maxRedirects = MAX_REDIRECTS, timeoutMs = 0 } = {}) {
  let current = url
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const res = await requestOnce(current, { 'user-agent': 'PearTube-Relay', accept: '*/*' }, timeoutMs)
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

function pipeToFile (res, filePath, fs) {
  return new Promise((resolve, reject) => {
    let fd
    try { fd = fs.openSync(filePath, 'w') } catch (err) { reject(err); return }
    let done = false
    const finish = (err) => {
      if (done) return
      done = true
      try { fs.closeSync(fd) } catch {}
      if (err) reject(err); else resolve()
    }
    res.on('data', (chunk) => {
      try { fs.writeSync(fd, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) } catch (err) { res.destroy?.(); finish(err) }
    })
    res.on('end', () => finish())
    res.on('error', (err) => finish(err))
  })
}

export function createDirectDownloader ({ outputDir, fs, path, timeoutMs = 0 } = {}) {
  if (!outputDir) throw new Error('outputDir is required')
  return {
    async download (input = {}) {
      const url = input.url
      if (!url) throw new Error('direct download requires a url')
      const id = input.id || `dl_${Date.now()}`
      const targetDir = path.join(outputDir, id)
      fs.mkdirSync(targetDir, { recursive: true })

      let res
      try {
        ({ res } = await openStream(url, { timeoutMs }))
      } catch (err) {
        try { fs.rmSync(targetDir, { recursive: true, force: true }) } catch {}
        throw err
      }

      const contentType = res.headers?.['content-type'] || ''
      const disposition = res.headers?.['content-disposition'] || ''
      const dispositionName = filenameFromDisposition(disposition)
      const looksVideo = VIDEO_CONTENT_TYPE.test(contentType) || isDirectVideoUrl(url) || VIDEO_EXT.test(dispositionName || '')
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
        await pipeToFile(res, filePath, fs)
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
