import { readdirSync, statSync } from '#fs'
import { basename, extname, join } from '#path'
import { spawn as defaultSpawn } from '#subprocess'

const defaultPath = {
  join,
  dirname(path) {
    const parts = String(path || '').split('/')
    parts.pop()
    return parts.join('/') || '/'
  }
}

const DEFAULT_VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi'])
const DIRECT_PLAY_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm'])

const MIME_BY_EXT = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo'
}

function isDirectPlayPath(filePath) {
  return DIRECT_PLAY_EXTENSIONS.has(extname(String(filePath || '')).toLowerCase())
}

function remuxedOutputPath(filePath, { path = defaultPath } = {}) {
  const source = String(filePath || '')
  const ext = extname(source)
  const base = ext ? basename(source).slice(0, -ext.length) : basename(source)
  return path.join(path.dirname(source), `.peartube-remux-${base || 'video'}.mp4`)
}

async function remuxLocalVideoForWebPlayback(filePath, {
  ffmpegPath = null,
  fs = { statSync },
  path = defaultPath,
  spawnFn = defaultSpawn,
  logger = null
} = {}) {
  if (isDirectPlayPath(filePath)) {
    return { filePath, cleanup: null, remuxed: false, mimeType: mimeTypeForPath(filePath) }
  }

  const bin = ffmpegPath || 'ffmpeg'
  const outputPath = remuxedOutputPath(filePath, { path })
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', filePath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-movflags', '+faststart',
    outputPath
  ]

  await new Promise((resolve, reject) => {
    const child = spawnFn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on?.('data', (chunk) => { stderr += String(chunk) })
    child.on?.('error', reject)
    child.on?.('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg remux failed (${code}): ${stderr.trim() || 'unknown error'}`))
    })
  })

  const stat = fs.statSync(outputPath)
  if (!Number.isFinite(Number(stat?.size)) || Number(stat.size) <= 0) {
    throw new Error('ffmpeg remux produced empty output')
  }

  logger?.archive?.info?.('Local drive video remuxed for web playback', { source: filePath, output: outputPath })
  return {
    filePath: outputPath,
    cleanup: () => {
      try { fs.rmSync?.(outputPath, { force: true }) } catch {}
    },
    remuxed: true,
    mimeType: 'video/mp4'
  }
}

function normalizeExtensions(extensions = DEFAULT_VIDEO_EXTENSIONS) {
  const values = extensions instanceof Set ? [...extensions] : extensions
  return new Set([...values].map((ext) => String(ext || '').trim().toLowerCase()).filter(Boolean).map((ext) => ext.startsWith('.') ? ext : `.${ext}`))
}

function titleFromPath(filePath) {
  const name = basename(String(filePath || '')).trim()
  const ext = extname(name)
  return (ext ? name.slice(0, -ext.length) : name) || 'Local video'
}

function mimeTypeForPath(filePath) {
  return MIME_BY_EXT[extname(String(filePath || '')).toLowerCase()] || 'video/mp4'
}

function fingerprintVideo(video) {
  return `${video.filePath}:${video.size}:${video.mtimeMs}`
}

export function createLocalDriveMirrorState(seed = null) {
  return {
    seen: new Map(seed?.seen || [])
  }
}

export function listLocalDriveVideos(rootPath, {
  fs = { readdirSync, statSync },
  path = defaultPath,
  recursive = true,
  extensions = DEFAULT_VIDEO_EXTENSIONS,
  maxFiles = Infinity
} = {}) {
  const root = String(rootPath || '').trim()
  if (!root) throw new Error('local drive path is required')
  const allowed = normalizeExtensions(extensions)
  const results = []

  function walk(dir) {
    if (results.length >= maxFiles) return
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (results.length >= maxFiles) break
      if (!entry || entry.name.startsWith('.')) continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory?.()) {
        if (recursive) walk(fullPath)
        continue
      }
      if (!entry.isFile?.()) continue
      const ext = extname(entry.name).toLowerCase()
      if (!allowed.has(ext)) continue
      const stat = fs.statSync(fullPath)
      if (!Number.isFinite(Number(stat?.size)) || Number(stat.size) <= 0) continue
      results.push({
        filePath: fullPath,
        title: titleFromPath(fullPath),
        mimeType: mimeTypeForPath(fullPath),
        size: Number(stat.size),
        mtimeMs: Number(stat.mtimeMs || 0) || 0
      })
    }
  }

  walk(root)
  return results.sort((a, b) => a.filePath.localeCompare(b.filePath))
}

export async function mirrorLocalDriveToRelayChannel({
  rootPath,
  publisher,
  channelName = 'Local Drive Mirror',
  description = '',
  recursive = true,
  maxFiles = Infinity,
  fs = { readdirSync, statSync },
  path = defaultPath,
  state = null,
  logger = null,
  ffmpegPath = null,
  spawnFn = defaultSpawn
} = {}) {
  if (!publisher) throw new Error('publisher is required')
  const videos = listLocalDriveVideos(rootPath, { fs, path, recursive, maxFiles })
  const pendingVideos = state?.seen
    ? videos.filter((video) => state.seen.get(video.filePath) !== fingerprintVideo(video))
    : videos
  const channelInfo = await publisher.ensureAnonymousChannel({ channelName })
  const imported = []
  const failed = []

  for (const video of pendingVideos) {
    let prepared = null
    try {
      prepared = await remuxLocalVideoForWebPlayback(video.filePath, { ffmpegPath, fs, path, spawnFn, logger })
      const importPath = prepared.filePath
      const importMimeType = prepared.mimeType || video.mimeType
      const importStat = importPath === video.filePath ? null : fs.statSync(importPath)
      const importSize = Number(importStat?.size || video.size || 0) || video.size
      const result = await publisher.importVideo({
        channel: channelInfo.channel,
        filePath: importPath,
        title: video.title,
        description,
        mimeType: importMimeType
      })
      const metadata = result?.metadata || result || {}
      const previewVideo = result?.videoId ? {
        id: result.videoId,
        title: video.title,
        description,
        path: metadata.path || `/videos/${result.videoId}.mp4`,
        uploadedAt: metadata.uploadedAt || Date.now(),
        duration: Number(metadata.duration || 0) || 0,
        size: Number(metadata.size || importSize || 0) || 0,
        mimeType: metadata.mimeType || importMimeType,
        availability: 'playable',
        blobId: metadata.blobId || null,
        blobsCoreKey: metadata.blobsCoreKey || null,
        thumbnailBlobId: metadata.thumbnailBlobId || null,
        thumbnailBlobsCoreKey: metadata.thumbnailBlobsCoreKey || null,
        thumbnailMimeType: metadata.thumbnailMimeType || null
      } : null
      imported.push({ ...video, videoId: result?.videoId || null, previewVideo, remuxed: Boolean(prepared.remuxed) })
      state?.seen?.set(video.filePath, fingerprintVideo(video))
      logger?.archive?.info?.('Local drive video imported', { file: video.filePath, videoId: result?.videoId || null, remuxed: Boolean(prepared.remuxed) })
    } catch (err) {
      failed.push({ ...video, error: err?.message || String(err) })
      logger?.archive?.error?.('Local drive video import failed', { file: video.filePath, error: err?.message || String(err) })
    } finally {
      try { prepared?.cleanup?.() } catch {}
    }
  }

  const previewVideos = imported.map((entry) => entry.previewVideo).filter(Boolean)
  if (previewVideos.length > 0) {
    await publisher.publishChannel(channelInfo, { previewVideos })
    await publisher.seedChannel({ ...channelInfo, previewVideos })
  }

  return {
    channelKey: channelInfo.channelKey,
    publicBeeKey: channelInfo.publicBeeKey || null,
    scanned: videos.length,
    imported: imported.length,
    skipped: videos.length - pendingVideos.length,
    failed: failed.length,
    videos: imported.map(({ filePath, title, size, mimeType, videoId }) => ({ filePath, title, size, mimeType, videoId })),
    failures: failed.map(({ filePath, error }) => ({ filePath, error }))
  }
}
