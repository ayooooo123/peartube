import { canonicalLocalResolutionRecord, normalizeLocalDurationSeconds, sha256File } from './local-file-acquisition.js'
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from '#fs'
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
const OPAQUE_KEY = /^[0-9a-f]{64}$/

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

function creatorSourceIdentityForInfo(info) {
  if (!info || typeof info !== 'object') return null
  const channelId = normalizeText(info.channel_id || info.channelId || '', 120)
  const uploaderId = normalizeText(info.uploader_id || info.uploaderId || '', 120)
  const channelName = normalizeText(info.channel || info.uploader || '', 160)
  const creatorHandle = uploaderId.startsWith('@') ? uploaderId : null

  if (channelId) {
    return {
      platform: 'youtube',
      sourceId: `youtube:channel:${channelId}`,
      creatorName: channelName || channelId,
      creatorHandle
    }
  }

  if (creatorHandle) {
    return {
      platform: 'youtube',
      sourceId: `youtube:handle:${creatorHandle}`,
      creatorName: channelName || creatorHandle,
      creatorHandle
    }
  }

  if (channelName) {
    return {
      platform: 'youtube',
      sourceId: `youtube:creator:${safeTag(channelName)}`,
      creatorName: channelName,
      creatorHandle: null
    }
  }

  return null
}

function localThumbnailPathForVideo(filePath, fs) {
  const value = String(filePath || '')
  const ext = extname(value)
  const stem = ext ? value.slice(0, -ext.length) : value
  for (const candidate of [`${stem}.jpg`, `${stem}.jpeg`, `${stem}.webp`, `${stem}.png`]) {
    try {
      if (typeof fs.existsSync === 'function' && fs.existsSync(candidate)) return candidate
    } catch {
      // Ignore unreadable adjacent thumbnail candidates and keep scanning.
    }
  }
  return null
}

function defaultLocalVideoMetadata(video, rawFileName, thumbnailFile) {
  return {
    title: video.title || rawFileName,
    fileName: rawFileName,
    sourceFileName: rawFileName,
    description: '',
    category: 'Local',
    tags: ['local'],
    sourceType: 'local',
    sourceVideoId: null,
    creatorSourceId: null,
    creatorName: null,
    creatorHandle: null,
    sourceIdentity: null,
    duration: 0,
    thumbnailUrl: null,
    thumbnailFile
  }
}

function ytDlpVideoTags(info, category) {
  const ytDlpTags = Array.isArray(info.tags) ? info.tags : []
  return uniqueTags(['youtube', 'yt-dlp', category, ...(info.uploader ? [info.uploader] : []), ...(info.channel ? [info.channel] : []), ...ytDlpTags])
}

function ytDlpSourceIdentityParts(sourceIdentity) {
  return {
    creatorSourceId: sourceIdentity?.sourceId || null,
    creatorName: sourceIdentity?.creatorName || null,
    creatorHandle: sourceIdentity?.creatorHandle || null
  }
}

function metadataForYtDlpVideo(info, video, rawFileName, thumbnailFile) {
  const categories = Array.isArray(info.categories) ? info.categories : []
  const category = normalizeText(categories[0] || info.category || 'YouTube', 80)
  const sourceIdentity = creatorSourceIdentityForInfo(info)
  return {
    title: normalizeText(info.title, 200) || video.title || rawFileName,
    fileName: rawFileName,
    sourceFileName: rawFileName,
    description: normalizeText(info.description || info.fulltitle || '', 5000),
    category,
    tags: ytDlpVideoTags(info, category),
    sourceType: 'yt-dlp',
    sourceVideoId: normalizeText(info.id || info.display_id || '', 160) || null,
    ...ytDlpSourceIdentityParts(sourceIdentity),
    sourceIdentity,
    duration: Number(info.duration || 0) || 0,
    thumbnailUrl: normalizeText(info.thumbnail || '', 1000) || null,
    thumbnailFile
  }
}

function metadataForLocalVideo(video, fs) {
  const info = readYtDlpInfo(video.filePath, fs)
  const thumbnailFile = localThumbnailPathForVideo(video.filePath, fs)
  const rawFileName = basename(String(video.filePath || ''))
  if (!info) {
    return defaultLocalVideoMetadata(video, rawFileName, thumbnailFile)
  }
  return metadataForYtDlpVideo(info, video, rawFileName, thumbnailFile)
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
  if (!record?.previewVideo || typeof record.previewVideo !== 'object') return null
  const preview = { ...record.previewVideo }
  // Old mirror caches predate the private source-grant boundary.
  delete preview.thumbnailUrl
  delete preview.sourceUrl
  return preview
}

function canonicalChannelInfo(info) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) {
    throw new Error('publisher channel info is required')
  }
  const channelKey = String(info.channelKey || '').trim().toLowerCase()
  const publicBeeKey = String(info.publicBeeKey || '').trim().toLowerCase()
  const publisherId = String(info.publisherId || '').trim().toLowerCase()
  if (!OPAQUE_KEY.test(channelKey)) throw new Error('publisher channelKey is invalid')
  if (!OPAQUE_KEY.test(publicBeeKey)) throw new Error('publisher publicBeeKey is invalid')
  if (!OPAQUE_KEY.test(publisherId)) throw new Error('publisher publisherId is invalid')
  return { channelKey, publicBeeKey, publisherId }
}

function safeSourceFileName(filePath) {
  return normalizeText(basename(String(filePath || '')), 255) || 'Local video'
}

function extractPublicationRenditions(record, body) {
  if (Array.isArray(record.renditions)) return record.renditions
  if (Array.isArray(body.renditions)) return body.renditions
  return []
}

function publicationHeaderParts(record, publication, body, fallback) {
  return {
    publicationId: record.publicationId || publication?.publicationId || fallback.publicationId,
    publisherId: record.publisherId || body.publisherId || fallback.publisherId || null,
    manifestId: record.manifestId || body.manifestId || fallback.manifestId || null
  }
}

function publicationRenditionParts(rendition, fallback) {
  return {
    renditionId: rendition?.renditionId || fallback.renditionId || null,
    assetId: rendition?.assetId || rendition?.core?.assetId || fallback.assetId || null,
    byteLength: rendition?.byteLength ?? rendition?.core?.byteLength ?? fallback.byteLength,
    mimeType: rendition?.mimeType || rendition?.format || fallback.mimeType
  }
}

function publicationParts(publication, fallback) {
  const record = publication?.publication || publication || {}
  const manifest = publication?.manifest || null
  const body = manifest?.body || publication?.body || {}
  const renditions = extractPublicationRenditions(record, body)
  const rendition = renditions.find((entry) => entry?.renditionId === fallback.renditionId) || renditions[0] || null
  return {
    ...publicationHeaderParts(record, publication, body, fallback),
    ...publicationRenditionParts(rendition, fallback)
  }
}

export function createLocalDriveMirrorState(seed = null) {
  return {
    seen: new Map(seed?.seen || [])
  }
}

export function listLocalDriveVideos(rootPath, {
  fs = { createReadStream, existsSync, readFileSync, readdirSync, statSync },
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

function buildAcquisitionArtwork(localMetadata) {
  if (localMetadata.thumbnailFile) {
    return [{ role: 'poster', path: localMetadata.thumbnailFile }]
  }
  if (localMetadata.thumbnailUrl) {
    return [{ role: 'poster', url: localMetadata.thumbnailUrl }]
  }
  return []
}

function buildAcquisitionRequest({ video, localMetadata, sha256 }) {
  const canon = canonicalLocalResolutionRecord({
    sha256,
    byteLength: video.size,
    title: localMetadata.title,
    fileName: localMetadata.sourceFileName || basename(video.filePath),
    kind: 'movie',
    namespace: localMetadata.sourceVideoId ? (localMetadata.sourceType || 'local') : null,
    identifier: localMetadata.sourceVideoId || null
  })
  return {
    canon,
    params: {
      idempotencyKey: canon.idempotencyKey,
      title: canon.title,
      selector: canon.selector,
      expectedBytes: canon.expectedBytes,
      retentionClass: canon.retentionClass,
      path: video.filePath,
      mimeType: video.mimeType,
      sourceFileName: canon.sourceFileName,
      description: localMetadata.description || undefined,
      tags: Array.isArray(localMetadata.tags) ? localMetadata.tags : undefined,
      creatorName: localMetadata.creatorName || undefined,
      creatorHandle: localMetadata.creatorHandle || undefined,
      duration: normalizeLocalDurationSeconds(localMetadata.duration) ?? undefined,
      artwork: buildAcquisitionArtwork(localMetadata),
      awaitCompletion: true
    }
  }
}

async function resolveCompletedPublication(service, publicationId, channelInfo, job, video) {
  if (!publicationId) throw new Error('completed acquisition has no publication')
  const publication = typeof service?.getPublication === 'function'
    ? await service.getPublication(publicationId)
    : null
  if (typeof service?.getPublication === 'function' && !publication) {
    throw new Error('completed acquisition publication lookup failed')
  }
  const resolved = publicationParts(publication, {
    publicationId,
    publisherId: channelInfo.publisherId,
    manifestId: job.manifestId,
    renditionId: job.renditionId,
    assetId: job.assetId,
    byteLength: video.size,
    mimeType: video.mimeType
  })
  if (resolved.publicationId !== publicationId) {
    throw new Error('completed acquisition publication does not match its job')
  }
  if (!resolved.manifestId || !resolved.renditionId || !resolved.assetId) {
    throw new Error('completed acquisition publication is incomplete')
  }
  return resolved
}

function createMirrorPreviewVideo({ resolved, localMetadata, video, description }) {
  const playbackSupport = getPlaybackSupportForMimeType(resolved.mimeType || video.mimeType)
  return {
    id: resolved.publicationId,
    publicationId: resolved.publicationId,
    publisherId: resolved.publisherId,
    manifestId: resolved.manifestId,
    renditionId: resolved.renditionId,
    assetId: resolved.assetId,
    title: localMetadata.title,
    description: localMetadata.description || description,
    duration: Number(localMetadata.duration || 0) || 0,
    size: Number(resolved.byteLength ?? video.size ?? 0) || 0,
    mimeType: resolved.mimeType || video.mimeType,
    category: localMetadata.category,
    tags: localMetadata.tags,
    sourceType: localMetadata.sourceType,
    sourceVideoId: localMetadata.sourceVideoId,
    creatorSourceId: localMetadata.creatorSourceId,
    creatorName: localMetadata.creatorName,
    creatorHandle: localMetadata.creatorHandle,
    availability: playbackSupport.availability,
    playbackSupport: playbackSupport.playbackSupport
  }
}

function recordCompletedAcquisition({
  resolved,
  previewVideo,
  video,
  localMetadata,
  channelInfo,
  canon,
  rawFingerprint,
  state,
  imported,
  logger
}) {
  channelInfo.previewVideos.push(previewVideo)
  imported.push({
    title: localMetadata.title,
    sourceFileName: canon.sourceFileName,
    size: Number(resolved.byteLength ?? video.size) || 0,
    mimeType: resolved.mimeType || video.mimeType,
    videoId: resolved.publicationId,
    previewVideo,
    channelKey: channelInfo.channelKey
  })
  if (state?.seen) {
    state.seen.set(video.filePath, {
      fingerprint: rawFingerprint,
      previewVideo,
      channelKey: channelInfo.channelKey,
      publicBeeKey: channelInfo.publicBeeKey || null,
      sourceIdentity: channelInfo.sourceIdentity || null
    })
  }
  logger?.archive?.info?.('Local drive video imported', { file: video.filePath, videoId: resolved.publicationId })
}

function recordFailedAcquisition({ job, video, localMetadata, canon, failed, logger }) {
  failed.push({
    title: localMetadata.title,
    sourceFileName: canon.sourceFileName,
    error: job.errorCode || `acquisition ${job.state}`
  })
  logger?.archive?.error?.('Local drive video acquisition failed', {
    file: video.filePath,
    state: job.state,
    error: job.errorCode || `acquisition ${job.state}`
  })
}

function recordQueuedAcquisition({ job, video, localMetadata, canon, channelInfo, imported, logger }) {
  imported.push({
    title: localMetadata.title,
    sourceFileName: canon.sourceFileName,
    size: video.size,
    mimeType: video.mimeType,
    videoId: job?.acquisitionId || null,
    state: job?.state || 'queued',
    channelKey: channelInfo.channelKey
  })
  logger?.archive?.info?.('Local drive video queued for acquisition', { file: video.filePath, acquisitionId: job?.acquisitionId })
}

async function handleAcquisitionJob({
  job,
  video,
  localMetadata,
  channelInfo,
  canon,
  rawFingerprint,
  service,
  description,
  state,
  imported,
  failed,
  logger
}) {
  if (job?.state === 'completed') {
    const resolved = await resolveCompletedPublication(service, job?.publicationId || null, channelInfo, job, video)
    const previewVideo = createMirrorPreviewVideo({ resolved, localMetadata, video, description })
    recordCompletedAcquisition({
      resolved,
      previewVideo,
      video,
      localMetadata,
      channelInfo,
      canon,
      rawFingerprint,
      state,
      imported,
      logger
    })
  } else if (job?.state === 'failed' || job?.state === 'cancelled') {
    recordFailedAcquisition({ job, video, localMetadata, canon, failed, logger })
  } else {
    recordQueuedAcquisition({ job, video, localMetadata, canon, channelInfo, imported, logger })
  }
}

async function importPendingVideo({
  video,
  metadataByPath,
  fs,
  channelForMetadata,
  acquire,
  service,
  description,
  state,
  imported,
  failed,
  logger
}) {
  try {
    const localMetadata = metadataByPath.get(video.filePath) || metadataForLocalVideo(video, fs)
    const channelInfo = await channelForMetadata(localMetadata)
    const rawFingerprint = fingerprintVideo(video)
    const sha256 = await sha256File(video.filePath, fs)
    const { canon, params } = buildAcquisitionRequest({ video, localMetadata, sha256 })
    const job = await acquire(params)
    await handleAcquisitionJob({
      job,
      video,
      localMetadata,
      channelInfo,
      canon,
      rawFingerprint,
      service,
      description,
      state,
      imported,
      failed,
      logger
    })
  } catch (err) {
    const localMetadata = metadataByPath.get(video.filePath) || null
    failed.push({
      title: localMetadata?.title || video.title,
      sourceFileName: localMetadata?.sourceFileName || safeSourceFileName(video.filePath),
      error: err?.message || String(err)
    })
    logger?.archive?.error?.('Local drive video import failed', { file: video.filePath, error: err?.message || String(err) })
  }
}

function getPendingVideos(videos, state) {
  if (!state?.seen) return videos
  return videos.filter((video) => getSeenFingerprint(state.seen.get(video.filePath)) !== fingerprintVideo(video))
}

function createChannelResolver({ publisher, channelName, channelInfoByKey }) {
  return async function channelForMetadata(localMetadata) {
    const key = localMetadata.sourceIdentity?.sourceId || 'local'
    if (channelInfoByKey.has(key)) return channelInfoByKey.get(key)
    const sourceIdentity = localMetadata.sourceIdentity || null
    const info = publisher?.ensureAnonymousChannel
      ? canonicalChannelInfo(await publisher.ensureAnonymousChannel({
          channelName: sourceIdentity?.creatorName || channelName,
          sourceIdentity,
          retentionClass: 'archive-pin',
        }))
      : { channelKey: null, publicBeeKey: null, publisherId: null }
    const entry = {
      channelKey: info.channelKey,
      publicBeeKey: info.publicBeeKey,
      publisherId: info.publisherId,
      channelName: sourceIdentity?.creatorName || channelName,
      sourceIdentity,
      previewVideos: []
    }
    channelInfoByKey.set(key, entry)
    return entry
  }
}

async function hydrateCachedPreviews({ videos, metadataByPath, state, channelForMetadata }) {
  for (const video of videos) {
    const localMetadata = metadataByPath.get(video.filePath)
    const cachedPreview = getSeenPreviewVideo(state?.seen?.get(video.filePath))
    if (!cachedPreview) continue
    const channelInfo = await channelForMetadata(localMetadata)
    if (!channelInfo.previewVideos.some((preview) => preview.id === cachedPreview.id)) {
      channelInfo.previewVideos.push(cachedPreview)
    }
  }
}

function summarizeMirrorResults({ channelInfoByKey, imported, failed, videos, pendingVideos }) {
  const channels = [...channelInfoByKey.values()].map((entry) => ({
    channelKey: entry.channelKey,
    publicBeeKey: entry.publicBeeKey || null,
    publisherId: entry.publisherId || null,
    channelName: entry.channelName,
    sourceIdentity: entry.sourceIdentity || null,
    imported: imported.filter((video) => video.channelKey === entry.channelKey).length,
    videos: entry.previewVideos
  }))

  return {
    channelKey: channels[0]?.channelKey || null,
    publicBeeKey: channels[0]?.publicBeeKey || null,
    scanned: videos.length,
    imported: imported.length,
    skipped: videos.length - pendingVideos.length,
    failed: failed.length,
    channels,
    videos: imported.map(({ sourceFileName, title, size, mimeType, videoId, channelKey }) => ({ sourceFileName, title, size, mimeType, videoId, channelKey })),
    failures: failed.map(({ sourceFileName, title, error }) => ({ sourceFileName, title, error }))
  }
}

export async function mirrorLocalDriveToRelayChannel({
  rootPath,
  publisher = null,
  requestLocalFileAcquisition = null,
  service = null,
  channelName = 'Local Drive Mirror',
  description = '',
  recursive = true,
  maxFiles = Infinity,
  fs = { createReadStream, existsSync, readFileSync, readdirSync, statSync },
  path = defaultPath,
  state = null,
  logger = null
} = {}) {
  if (publisher !== null && typeof publisher.ensureAnonymousChannel !== 'function') {
    throw new Error('publisher.ensureAnonymousChannel is required')
  }
  const acquire = requestLocalFileAcquisition || service?.requestLocalFileAcquisition
  if (typeof acquire !== 'function') {
    throw new Error('requestLocalFileAcquisition is required')
  }
  const videos = listLocalDriveVideos(rootPath, { fs, path, recursive, maxFiles })
  const pendingVideos = getPendingVideos(videos, state)
  const metadataByPath = new Map(videos.map((video) => [video.filePath, metadataForLocalVideo(video, fs)]))
  const channelInfoByKey = new Map()
  const imported = []
  const failed = []

  const channelForMetadata = createChannelResolver({ publisher, channelName, channelInfoByKey })

  for (const video of pendingVideos) {
    await importPendingVideo({
      video,
      metadataByPath,
      fs,
      channelForMetadata,
      acquire,
      service,
      description,
      state,
      imported,
      failed,
      logger
    })
  }

  await hydrateCachedPreviews({ videos, metadataByPath, state, channelForMetadata })

  return summarizeMirrorResults({ channelInfoByKey, imported, failed, videos, pendingVideos })
}
