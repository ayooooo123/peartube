import { existsSync, readFileSync, readdirSync, statSync } from '#fs'
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

const DIRECT_PLAYABLE_MIME_TYPES = new Set(['video/mp4', 'video/webm'])

function getPlaybackSupportForMimeType(mimeType) {
  const normalized = String(mimeType || '').toLowerCase()
  if (DIRECT_PLAYABLE_MIME_TYPES.has(normalized)) return { availability: 'playable', playbackSupport: 'direct' }
  return { availability: 'playable', playbackSupport: 'unverified-container' }
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


function normalizeText(value, maxLength = 5000) {
  return String(value || '').split('').map((char) => {
    const code = char.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : char
  }).join('').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function safeTag(value) {
  const tag = normalizeText(value, 48).toLowerCase().replace(/[^a-z0-9._ -]+/g, '').replace(/\s+/g, '-').replace(/^-+|-+$/g, '')
  return tag || null
}

function uniqueTags(values) {
  const seen = new Set()
  const tags = []
  for (const value of values || []) {
    const tag = safeTag(value)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
    if (tags.length >= 12) break
  }
  return tags
}

function infoJsonPathForVideo(filePath) {
  const value = String(filePath || '')
  const ext = extname(value)
  return `${ext ? value.slice(0, -ext.length) : value}.info.json`
}

function readYtDlpInfo(filePath, fs) {
  const infoPath = infoJsonPathForVideo(filePath)
  try {
    if (typeof fs.existsSync === 'function' && !fs.existsSync(infoPath)) return null
    if (typeof fs.readFileSync !== 'function') return null
    const parsed = JSON.parse(String(fs.readFileSync(infoPath, 'utf8') || '{}'))
    if (!parsed || typeof parsed !== 'object') return null
    const sourceUrl = normalizeText(parsed.webpage_url || parsed.original_url || parsed.url || '', 1000)
    const extractor = normalizeText(parsed.extractor_key || parsed.extractor || '', 80).toLowerCase()
    const looksLikeYtDlp = Boolean(sourceUrl || parsed.id || parsed.title || extractor)
    if (!looksLikeYtDlp) return null
    return { ...parsed, sourceUrl, infoPath }
  } catch {
    return null
  }
}

function metadataForLocalVideo(video, fs) {
  const info = readYtDlpInfo(video.filePath, fs)
  if (!info) {
    return {
      title: video.title,
      description: '',
      category: 'Local',
      tags: ['local'],
      sourceType: 'local',
      sourceUrl: null,
      duration: 0,
      thumbnailUrl: null
    }
  }
  const categories = Array.isArray(info.categories) ? info.categories : []
  const ytDlpTags = Array.isArray(info.tags) ? info.tags : []
  const category = normalizeText(categories[0] || info.category || 'YouTube', 80)
  return {
    title: normalizeText(info.title, 200) || video.title,
    description: normalizeText(info.description || info.fulltitle || '', 5000),
    category,
    tags: uniqueTags(['youtube', 'yt-dlp', category, ...(info.uploader ? [info.uploader] : []), ...(info.channel ? [info.channel] : []), ...ytDlpTags]),
    sourceType: 'yt-dlp',
    sourceUrl: info.sourceUrl || null,
    duration: Number(info.duration || 0) || 0,
    thumbnailUrl: normalizeText(info.thumbnail || '', 1000) || null
  }
}

function fingerprintVideo(video) {
  return `${video.filePath}:${video.size}:${video.mtimeMs}`
}

function getSeenFingerprint(record) {
  if (!record) return null
  if (typeof record === 'string') return record
  return record.fingerprint || null
}

function getSeenPreviewVideo(record) {
  if (!record || typeof record !== 'object') return null
  return record.previewVideo || null
}

export function createLocalDriveMirrorState(seed = null) {
  return {
    seen: new Map(seed?.seen || [])
  }
}

export function listLocalDriveVideos(rootPath, {
  fs = { existsSync, readFileSync, readdirSync, statSync },
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
  fs = { existsSync, readFileSync, readdirSync, statSync },
  path = defaultPath,
  state = null,
  logger = null
} = {}) {
  if (!publisher) throw new Error('publisher is required')
  const videos = listLocalDriveVideos(rootPath, { fs, path, recursive, maxFiles })
  const pendingVideos = state?.seen
    ? videos.filter((video) => getSeenFingerprint(state.seen.get(video.filePath)) !== fingerprintVideo(video))
    : videos
  const channelInfo = await publisher.ensureAnonymousChannel({ channelName })
  const imported = []
  const failed = []

  for (const video of pendingVideos) {
    try {
      const localMetadata = metadataForLocalVideo(video, fs)
      const result = await publisher.importVideo({
        channel: channelInfo.channel,
        filePath: video.filePath,
        title: localMetadata.title,
        description: localMetadata.description || description,
        mimeType: video.mimeType,
        category: localMetadata.category,
        tags: localMetadata.tags,
        sourceType: localMetadata.sourceType,
        sourceUrl: localMetadata.sourceUrl,
        duration: localMetadata.duration,
        thumbnailUrl: localMetadata.thumbnailUrl
      })
      const metadata = result?.metadata || result || {}
      const playbackSupport = getPlaybackSupportForMimeType(metadata.mimeType || video.mimeType)
      const previewVideo = result?.videoId ? {
        id: result.videoId,
        title: localMetadata.title,
        description: localMetadata.description || description,
        path: metadata.path || `/videos/${result.videoId}.mp4`,
        uploadedAt: metadata.uploadedAt || Date.now(),
        duration: Number(metadata.duration || localMetadata.duration || 0) || 0,
        size: Number(metadata.size || video.size || 0) || 0,
        mimeType: metadata.mimeType || video.mimeType,
        category: metadata.category || localMetadata.category,
        tags: localMetadata.tags,
        sourceType: localMetadata.sourceType,
        sourceUrl: localMetadata.sourceUrl,
        thumbnailUrl: localMetadata.thumbnailUrl,
        availability: playbackSupport.availability,
        playbackSupport: playbackSupport.playbackSupport,
        blobId: metadata.blobId || null,
        blobsCoreKey: metadata.blobsCoreKey || null,
        thumbnailBlobId: metadata.thumbnailBlobId || null,
        thumbnailBlobsCoreKey: metadata.thumbnailBlobsCoreKey || null,
        thumbnailMimeType: metadata.thumbnailMimeType || null
      } : null
      imported.push({ ...video, title: localMetadata.title, videoId: result?.videoId || null, previewVideo })
      if (state?.seen) {
        state.seen.set(video.filePath, {
          fingerprint: fingerprintVideo(video),
          previewVideo
        })
      }
      logger?.archive?.info?.('Local drive video imported', { file: video.filePath, videoId: result?.videoId || null })
    } catch (err) {
      failed.push({ ...video, error: err?.message || String(err) })
      logger?.archive?.error?.('Local drive video import failed', { file: video.filePath, error: err?.message || String(err) })
    }
  }

  const importedPreviewByPath = new Map(imported.map((entry) => [entry.filePath, entry.previewVideo]).filter(([, preview]) => Boolean(preview)))
  const previewVideos = videos
    .map((video) => importedPreviewByPath.get(video.filePath) || getSeenPreviewVideo(state?.seen?.get(video.filePath)))
    .filter(Boolean)
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
