import { spawn } from '#subprocess'

const MAX_STDERR = 2000

export class YtDlpError extends Error {
  constructor (message, { code, stderr } = {}) {
    super(message)
    this.name = 'YtDlpError'
    this.code = code
    if (stderr !== undefined) this.stderr = stderr
  }
}

export function truncateStderr (value, max = MAX_STDERR) {
  const text = String(value || '')
  if (text.length <= max) return text
  return `${text.slice(0, max)}… [truncated ${text.length - max} chars]`
}

export function runYtDlp (bin, args, { spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnFn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (cause) {
      reject(missingOrFailure(cause))
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (cause) => reject(missingOrFailure(cause)))
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(new YtDlpError(`yt-dlp failed (${code}): ${truncateStderr(stderr || stdout)}`, {
        code: 'ERR_YTDLP_FAILED',
        stderr: truncateStderr(stderr)
      }))
    })
  })
}

function missingOrFailure (cause) {
  if (cause && cause.code === 'ENOENT') {
    return new YtDlpError(`yt-dlp executable not found: ${cause.message}`, { code: 'ERR_YTDLP_MISSING' })
  }
  return new YtDlpError(`yt-dlp could not start: ${cause.message}`, { code: 'ERR_YTDLP_FAILED' })
}

export function parseYtDlpJson (stdout) {
  try {
    return JSON.parse(String(stdout || ''))
  } catch (cause) {
    throw new YtDlpError('yt-dlp returned invalid JSON', { code: 'ERR_YTDLP_INVALID_OUTPUT' })
  }
}

export function parseReportedFilePath (stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (line === 'filepath') continue
    if (line.startsWith('filepath ')) return line.slice('filepath '.length).trim()
    return line
  }
  return null
}

export function isSupportedVideoPath (filePath) {
  return /\.(mp4|m4v|mov|webm|mkv)$/i.test(String(filePath || '').split('?')[0])
}

export function getVideoMimeType (filePath) {
  const ext = String(filePath || '').split('?')[0].toLowerCase().split('.').pop()
  if (ext === 'webm') return 'video/webm'
  if (ext === 'mkv') return 'video/x-matroska'
  if (ext === 'mov') return 'video/quicktime'
  return 'video/mp4'
}

function cookieArgs (cookiesPath) {
  return cookiesPath ? ['--cookies', cookiesPath] : []
}

export function buildInspectArgs (url, { cookiesPath = null } = {}) {
  return ['--dump-single-json', '--no-warnings', '--no-playlist', ...cookieArgs(cookiesPath), url]
}

export function buildSearchArgs (query, count, { cookiesPath = null } = {}) {
  const safeCount = Number.isInteger(count) && count > 0 ? count : 10
  return ['--dump-single-json', '--no-warnings', '--flat-playlist', ...cookieArgs(cookiesPath), `ytsearch${safeCount}:${query}`]
}

export function buildListArgs (url, { limit = 25, cookiesPath = null } = {}) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 25
  return ['--dump-single-json', '--no-warnings', '--flat-playlist', '--playlist-end', String(safeLimit), ...cookieArgs(cookiesPath), url]
}

export function buildDownloadArgs ({
  format = 'bv*+ba/b',
  outputTemplate,
  ffmpegPath = null,
  cookiesPath = null,
  jsRuntime = null,
  extraArgs = [],
  maxFileSize = 0,
  sourceUrl
} = {}) {
  const args = [
    '--no-playlist',
    '--restrict-filenames',
    '--write-info-json',
    '--print', 'after_move:filepath',
    '-f', format,
    '-o', outputTemplate
  ]
  if (ffmpegPath) args.push('--ffmpeg-location', ffmpegPath)
  if (cookiesPath) args.push('--cookies', cookiesPath)
  if (jsRuntime) args.push('--js-runtimes', jsRuntime)
  if (Array.isArray(extraArgs) && extraArgs.length) args.push(...extraArgs)
  if (Number.isSafeInteger(maxFileSize) && maxFileSize > 0) args.push('--max-filesize', String(maxFileSize))
  args.push(sourceUrl)
  return args
}
