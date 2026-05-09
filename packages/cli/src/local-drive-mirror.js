import { readdirSync, statSync } from '#fs'
import { basename, extname, join } from '#path'
const defaultPath = { join }

const DEFAULT_VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi'])

const MIME_BY_EXT = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo'
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
  logger = null
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
    try {
      const result = await publisher.importVideo({
        channel: channelInfo.channel,
        filePath: video.filePath,
        title: video.title,
        description,
        mimeType: video.mimeType
      })
      const metadata = result?.metadata || result || {}
      const previewVideo = result?.videoId ? {
        id: result.videoId,
        title: video.title,
        description,
        path: metadata.path || `/videos/${result.videoId}.mp4`,
        uploadedAt: metadata.uploadedAt || Date.now(),
        duration: Number(metadata.duration || 0) || 0,
        size: Number(metadata.size || video.size || 0) || 0,
        mimeType: metadata.mimeType || video.mimeType,
        availability: 'playable',
        blobId: metadata.blobId || null,
        blobsCoreKey: metadata.blobsCoreKey || null,
        thumbnailBlobId: metadata.thumbnailBlobId || null,
        thumbnailBlobsCoreKey: metadata.thumbnailBlobsCoreKey || null,
        thumbnailMimeType: metadata.thumbnailMimeType || null
      } : null
      imported.push({ ...video, videoId: result?.videoId || null, previewVideo })
      state?.seen?.set(video.filePath, fingerprintVideo(video))
      logger?.archive?.info?.('Local drive video imported', { file: video.filePath, videoId: result?.videoId || null })
    } catch (err) {
      failed.push({ ...video, error: err?.message || String(err) })
      logger?.archive?.error?.('Local drive video import failed', { file: video.filePath, error: err?.message || String(err) })
    }
  }

  const previewVideos = imported.map((entry) => entry.previewVideo).filter(Boolean)
  if (previewVideos.length > 0) {
    await publisher.publishChannel(channelInfo)
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
