import { spawn } from '#subprocess'

const PRINT_FILEPATH_TOKEN = '__PEARTUBE_FILEPATH__'

function runYtDlp(binary, args, { signal, env, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env || undefined
      })
    } catch (err) {
      reject(err)
      return
    }

    let stdout = ''
    let stderr = ''
    let aborted = false

    const onAbort = () => {
      aborted = true
      try { child.kill('SIGTERM') } catch { /* best effort */ }
    }

    if (signal) {
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (typeof onStderr === 'function') {
        try { onStderr(chunk) } catch { /* swallow */ }
      }
    })

    child.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort)
      reject(err)
    })

    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort)
      if (aborted) {
        const err = new Error('yt-dlp aborted')
        err.code = 'ABORTED'
        reject(err)
        return
      }
      if (code !== 0) {
        const err = new Error(`yt-dlp exited with code ${code}: ${stderr.trim() || 'unknown error'}`)
        err.code = code
        err.stderr = stderr
        err.stdout = stdout
        reject(err)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function parseListLine(line) {
  if (!line) return null
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    return null
  }
  if (!entry || typeof entry !== 'object') return null
  if (!entry.id) return null
  return {
    id: String(entry.id),
    title: typeof entry.title === 'string' ? entry.title : '',
    duration: Number.isFinite(entry.duration) ? Number(entry.duration) : null,
    uploader: typeof entry.uploader === 'string' ? entry.uploader : null,
    uploadDate: typeof entry.upload_date === 'string' ? entry.upload_date : null,
    url: typeof entry.url === 'string' ? entry.url : null,
    webpageUrl: typeof entry.webpage_url === 'string' ? entry.webpage_url : null
  }
}

export function createYtDlp({ binary = 'yt-dlp' } = {}) {
  return {
    binary,
    /**
     * List videos in a channel / playlist URL (flat — no download).
     * @param {string} url
     * @param {{ maxItems?: number, signal?: AbortSignal, extraArgs?: string[] }} [opts]
     * @returns {Promise<Array<{id:string,title:string,duration:number|null,uploader:string|null,uploadDate:string|null,url:string|null,webpageUrl:string|null}>>}
     */
    async listVideos(url, opts = {}) {
      const args = [
        '--flat-playlist',
        '--no-warnings',
        '--print-json',
        '--ignore-errors'
      ]
      if (Number.isFinite(opts.maxItems) && opts.maxItems > 0) {
        args.push('--playlist-end', String(opts.maxItems))
      }
      if (Array.isArray(opts.extraArgs)) args.push(...opts.extraArgs)
      args.push(url)

      const { stdout } = await runYtDlp(binary, args, { signal: opts.signal })
      const lines = stdout.split('\n')
      const results = []
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const parsed = parseListLine(trimmed)
        if (parsed) results.push(parsed)
      }
      return results
    },

    /**
     * Download a single video plus thumbnail + metadata into workDir.
     * @param {string} url
     * @param {{ workDir: string, format: string, videoId: string, signal?: AbortSignal, extraArgs?: string[] }} opts
     * @returns {Promise<{videoFile:string|null,thumbnailFile:string|null,infoFile:string|null,stderr:string}>}
     */
    async downloadVideo(url, opts) {
      if (!opts || typeof opts.workDir !== 'string') throw new Error('workDir required')
      if (typeof opts.videoId !== 'string' || !opts.videoId) throw new Error('videoId required')
      const format = typeof opts.format === 'string' && opts.format ? opts.format : 'b'

      const outputTemplate = `${opts.videoId}.%(ext)s`

      const args = [
        '-f', format,
        '--no-playlist',
        '--no-warnings',
        '--restrict-filenames',
        '--write-thumbnail',
        '--convert-thumbnail', 'jpg',
        '--write-info-json',
        '--print', `after_move:${PRINT_FILEPATH_TOKEN} %(filepath)s`,
        '-P', opts.workDir,
        '-o', outputTemplate
      ]
      if (Array.isArray(opts.extraArgs)) args.push(...opts.extraArgs)
      args.push(url)

      const { stdout, stderr } = await runYtDlp(binary, args, { signal: opts.signal })

      let videoFile = null
      for (const rawLine of stdout.split('\n')) {
        const line = rawLine.trim()
        if (!line.startsWith(PRINT_FILEPATH_TOKEN)) continue
        const filepath = line.slice(PRINT_FILEPATH_TOKEN.length).trim()
        if (filepath) videoFile = filepath
      }

      // Thumbnail and info-json files are placed alongside the video using the
      // same stem ("<videoId>.jpg", "<videoId>.info.json"). Resolve by deriving
      // from videoFile (preferred) or falling back to videoId.
      let thumbnailFile = null
      let infoFile = null
      if (videoFile) {
        const lastDot = videoFile.lastIndexOf('.')
        const stem = lastDot > 0 ? videoFile.slice(0, lastDot) : videoFile
        thumbnailFile = `${stem}.jpg`
        infoFile = `${stem}.info.json`
      }

      return { videoFile, thumbnailFile, infoFile, stderr }
    }
  }
}
