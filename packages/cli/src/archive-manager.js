import { spawn } from '#subprocess'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { mkdirSync, rmSync, existsSync, readFileSync } from '#fs'
import { join } from '#path'
import {
  runYtDlp,
  parseReportedFilePath,
  isSupportedVideoPath,
  getVideoMimeType,
  buildDownloadArgs
} from './media/yt-dlp.js'
import { isDirectVideoUrl } from './media/direct-download.js'

const JOBS_KEY = 'relay-archive-jobs'
const PRIVATE_INPUTS_KEY = 'relay-archive-job-inputs'

function now() {
  return Date.now()
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function safeArgsArray(value) {
  return safeArray(value).map((entry) => String(entry)).filter(Boolean)
}

function parseArchiveUrl(value) {
  const url = String(value || '').trim()
  if (!url) throw new Error('archive url is required')
  if (!/^https?:\/\//i.test(url)) throw new Error('archive url must be http(s)')
  return new URL(url)
}

function sanitizeUrl(value) {
  return parseArchiveUrl(value).toString()
}

function normalizeInvidiousInstance(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const instance = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  if (!/^https?:$/i.test(instance.protocol)) throw new Error('Invidious instance must be http(s)')
  instance.pathname = ''
  instance.search = ''
  instance.hash = ''
  return instance.toString().replace(/\/$/, '')
}

function extractYouTubeVideoId(url) {
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || null
  if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'm.youtube.com') {
    if (url.pathname === '/watch') return url.searchParams.get('v')
    const parts = url.pathname.split('/').filter(Boolean)
    if (['shorts', 'embed', 'live'].includes(parts[0])) return parts[1] || null
  }
  return null
}

function buildInvidiousFallbackUrls(sourceUrl, instance) {
  const normalizedInstance = normalizeInvidiousInstance(instance)
  if (!normalizedInstance) return []
  const url = parseArchiveUrl(sourceUrl)
  const videoId = extractYouTubeVideoId(url)
  if (!videoId) return []
  const encoded = encodeURIComponent(videoId)
  return [
    `${normalizedInstance}/latest_version?id=${encoded}&itag=18&local=true`,
    `${normalizedInstance}/watch?v=${encoded}`
  ]
}

function sanitizeName(value) {
  const name = String(value || '').trim()
  return name || 'Anonymous Archive'
}

function publicJob(job) {
  const { url, ...safe } = job || {}
  return safe
}

function makeJobId(url) {
  const digest = b4a.toString(crypto.hash(Buffer.from(`${url}:${now()}:${b4a.toString(crypto.randomBytes(8), 'hex')}`)), 'hex').slice(0, 16)
  return `arch_${digest}`
}

// Map TMDB discover coordinates onto the backend's structured-content fields.
// Movies must NOT carry season/episode; TV needs BOTH season and episode to be
// a valid 'episode' identity — anything partial stays a plain video so the
// structured-content validation cannot reject the import.
export function deriveMediaCoordinates({ tmdbType, tmdbId, tmdbSeason, tmdbEpisode } = {}) {
  const id = tmdbId != null && String(tmdbId).trim() !== '' ? String(tmdbId).trim() : null
  if (!id) return {}
  if (tmdbType === 'tv') {
    const seasonNumber = Number(tmdbSeason || 0) || null
    const episodeNumber = Number(tmdbEpisode || 0) || null
    if (!seasonNumber || !episodeNumber) return {}
    return { contentKind: 'episode', mediaProvider: 'tmdb', mediaId: id, seasonNumber, episodeNumber }
  }
  return { contentKind: 'movie', mediaProvider: 'tmdb', mediaId: id }
}

async function readValue(metaDb, key, fallback) {
  const entry = await metaDb.get(key).catch(() => null)
  return entry?.value ?? fallback
}

export function createArchiveJobStore({ metaDb }) {
  if (!metaDb) throw new Error('metaDb is required')

  async function readJobsRaw() {
    return safeArray(await readValue(metaDb, JOBS_KEY, []))
  }

  async function writeJobsRaw(jobs) {
    await metaDb.put(JOBS_KEY, safeArray(jobs).map(publicJob))
  }

  async function readPrivateInputs() {
    const raw = await readValue(metaDb, PRIVATE_INPUTS_KEY, {})
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  }

  async function writePrivateInputs(inputs) {
    await metaDb.put(PRIVATE_INPUTS_KEY, inputs || {})
  }

  return {
    async listJobs() {
      return (await readJobsRaw()).map(publicJob)
    },
    async getPrivateInput(id) {
      const inputs = await readPrivateInputs()
      return inputs[id] || null
    },
    async addJob(job, privateInput) {
      const jobs = await readJobsRaw()
      jobs.unshift(publicJob(job))
      await writeJobsRaw(jobs)
      const inputs = await readPrivateInputs()
      inputs[job.id] = privateInput
      await writePrivateInputs(inputs)
      return publicJob(job)
    },
    async updateJob(id, patch) {
      const jobs = await readJobsRaw()
      const updated = jobs.map((job) => job.id === id ? publicJob({ ...job, ...patch, updatedAt: now() }) : job)
      await writeJobsRaw(updated)
      return updated.find((job) => job.id === id) || null
    },
    async getCompletedVideoPreviewsByChannel() {
      const jobs = await readJobsRaw()
      const byChannel = new Map()
      for (const job of jobs) {
        if (job?.status !== 'completed') continue
        if (!job?.channelKey || !job?.previewVideo?.id) continue
        const list = byChannel.get(job.channelKey) || []
        list.push({
          ...job.previewVideo,
          publicBeeKey: job.publicBeeKey || job.previewVideo.publicBeeKey || null,
          channelKey: job.channelKey,
          driveKey: job.channelKey,
        })
        byChannel.set(job.channelKey, list)
      }
      return byChannel
    }
  }
}

export async function enqueueArchiveJob(store, input = {}) {
  const uploadPath = input.uploadPath ? String(input.uploadPath) : null
  const url = uploadPath ? null : sanitizeUrl(input.url)
  const createdAt = now()
  const job = {
    id: makeJobId(url || uploadPath),
    status: 'queued',
    channelName: sanitizeName(input.channelName),
    title: input.title ? String(input.title) : null,
    description: input.description ? String(input.description) : '',
    publish: input.publish !== false,
    anonymous: input.anonymous !== false,
    createdAt,
    updatedAt: createdAt,
    error: null
  }

  return store.addJob(job, {
    url,
    uploadPath,
    uploadFilename: input.uploadFilename ? String(input.uploadFilename) : null,
    uploadMimeType: input.uploadMimeType ? String(input.uploadMimeType) : null,
    uploadSize: Number(input.uploadSize) || null,
    invidiousInstance: input.invidiousInstance ? String(input.invidiousInstance).trim() : '',
    title: job.title,
    description: job.description,
    channelName: job.channelName,
    publish: job.publish,
    anonymous: job.anonymous,
    creatorSourceId: input.creatorSourceId ? String(input.creatorSourceId) : null,
    creatorName: input.creatorName ? String(input.creatorName) : null,
    creatorHandle: input.creatorHandle ? String(input.creatorHandle) : null,
    sourceType: input.sourceType ? String(input.sourceType) : null,
    sourceUrl: input.sourceUrl ? String(input.sourceUrl) : (url || null),
    sourceVideoId: input.sourceVideoId ? String(input.sourceVideoId) : null,
    tmdbType: input.tmdbType ? String(input.tmdbType) : null,
    tmdbId: input.tmdbId ? String(input.tmdbId) : null,
    tmdbSeason: input.tmdbSeason ? String(input.tmdbSeason) : null,
    tmdbEpisode: input.tmdbEpisode ? String(input.tmdbEpisode) : null,
    tmdbPosterPath: input.tmdbPosterPath ? String(input.tmdbPosterPath) : null,
    tmdbTitle: input.tmdbTitle ? String(input.tmdbTitle) : null,
    tmdbYear: input.tmdbYear ? String(input.tmdbYear) : null
  })
}

export function createYtDlpDownloader({
  bin = 'yt-dlp',
  outputDir,
  format = 'bv*+ba/b',
  ffmpegPath = null,
  cookiesPath = null,
  jsRuntime = null,
  ytDlpExtraArgs = [],
  ytDlpRetryExtraArgs = [],
  spawnFn = spawn,
  fs = { mkdirSync, rmSync, existsSync, readFileSync },
  path = { join }
} = {}) {
  if (!outputDir) throw new Error('outputDir is required')

  return {
    async download(input) {
      const id = input.id || makeJobId(input.url)
      const targetDir = path.join(outputDir, id)
      fs.mkdirSync(targetDir, { recursive: true })
      const outputTemplate = path.join(targetDir, '%(title).200B [%(id)s].%(ext)s')
      const buildArgs = (extraArgs = [], sourceUrl = input.url) => buildDownloadArgs({
        format,
        outputTemplate,
        ffmpegPath,
        cookiesPath,
        jsRuntime,
        extraArgs,
        sourceUrl
      })

      const invidiousFallbackUrls = buildInvidiousFallbackUrls(input.url, input.invidiousInstance)
      const attempts = [
        { args: safeArgsArray(ytDlpExtraArgs), url: input.url, allowUnknownExtension: false },
        ...safeArray(ytDlpRetryExtraArgs).map((args) => ({ args: safeArgsArray(args), url: input.url, allowUnknownExtension: false })),
        ...invidiousFallbackUrls.map((url) => ({ args: [], url, allowUnknownExtension: false }))
      ]
      let stdout = ''
      let filePath = null

      for (let attempt = 0; attempt < attempts.length; attempt += 1) {
        const args = buildArgs(attempts[attempt].args, attempts[attempt].url)
        try {
          const result = await runYtDlp(bin, args, { spawnFn })
          stdout = result.stdout
          filePath = parseReportedFilePath(stdout)
          if (!filePath) throw new Error('yt-dlp did not report an output file')
          if (!attempts[attempt].allowUnknownExtension && !isSupportedVideoPath(filePath)) {
            throw new Error(`yt-dlp reported unsupported archive output file: ${filePath}`)
          }
          break
        } catch (err) {
          const message = err?.message || String(err)
          const canRetry = /Sign in to confirm.*not a bot|LOGIN_REQUIRED|HTTP Error (?:400|403|418|429|500)|Requested format is not available|unsupported archive output file/i.test(message)
          if (!canRetry || attempt === attempts.length - 1) throw err
          fs.rmSync(targetDir, { recursive: true, force: true })
          fs.mkdirSync(targetDir, { recursive: true })
        }
      }

      if (!filePath) throw new Error('yt-dlp did not report an output file')
      if (typeof fs.existsSync === 'function' && !fs.existsSync(filePath)) {
        throw new Error(`yt-dlp reported output file does not exist: ${filePath}`)
      }

      const stem = filePath.replace(/\.[^.]+$/, '')
      const infoPath = `${stem}.info.json`
      let info = null
      if (typeof fs.existsSync === 'function' && fs.existsSync(infoPath) && typeof fs.readFileSync === 'function') {
        try {
          const parsed = JSON.parse(String(fs.readFileSync(infoPath, 'utf8') || '{}'))
          if (parsed && typeof parsed === 'object') info = parsed
        } catch {
          info = null
        }
      }
      const sourceTitle = typeof info?.title === 'string' && info.title.trim()
        ? info.title.trim()
        : null
      const sourceDescription = typeof info?.description === 'string'
        ? info.description
        : null
      const sourceDuration = Number.isFinite(info?.duration) ? Number(info.duration) : undefined
      const thumbnailUrl = typeof info?.thumbnail === 'string' && info.thumbnail.trim()
        ? info.thumbnail.trim()
        : null
      const thumbnailFile = ['jpg', 'jpeg', 'webp', 'png']
        .map((ext) => `${stem}.${ext}`)
        .find((candidate) => typeof fs.existsSync === 'function' && fs.existsSync(candidate)) || null
      const creatorName = typeof info?.uploader === 'string' && info.uploader.trim()
        ? info.uploader.trim()
        : null

      return {
        filePath,
        title: input.title || sourceTitle || filePath.split('/').pop()?.replace(/\.[^.]+$/, '') || 'Archived video',
        description: input.description || sourceDescription || `Archived anonymously from ${new URL(input.url).hostname}`,
        duration: sourceDuration,
        thumbnailUrl,
        thumbnailFile,
        creatorName,
        mimeType: getVideoMimeType(filePath),
        cleanup() {
          try {
            fs.rmSync(targetDir, { recursive: true, force: true })
          } catch (err) {
            // Best effort: stale archive temp directories are harmless and can be cleaned on the next run.
          }
        }
      }
    }
  }
}

// Pick the right downloader per job: a plain link to the media file (a TMDB
// show/movie import, or any direct video URL) is fetched straight over HTTP;
// platform pages (YouTube/Rumble/…) go through yt-dlp. This is why an episode
// whose source URL is a direct download no longer fails in yt-dlp.
export function createRoutingDownloader ({ directDownloader, ytDlpDownloader } = {}) {
  return {
    async download (input = {}) {
      const preferDirect = Boolean(directDownloader) && (Boolean(input.tmdbType) || isDirectVideoUrl(input.url))
      const downloader = preferDirect ? directDownloader : ytDlpDownloader
      if (!downloader) throw new Error('no downloader available for this archive source')
      return downloader.download(input)
    }
  }
}

export function createArchivePublisher({ identityManager, uploadManager, api, runtime, fs }) {
  if (!identityManager) throw new Error('identityManager is required')
  if (!uploadManager) throw new Error('uploadManager is required')
  if (!api) throw new Error('api is required')

  const sourceChannels = new Map()
  const previousActiveIdentity = identityManager.getActiveIdentity?.()

  return {
    async ensureAnonymousChannel({ channelName, sourceIdentity = null } = {}) {
      const sourceKey = sourceIdentity?.sourceId || null
      if (sourceKey && sourceChannels.has(sourceKey)) return sourceChannels.get(sourceKey)

      let identity = sourceKey ? previousActiveIdentity : identityManager.getActiveIdentity?.()
      if (!identity?.driveKey || sourceKey) {
        const created = sourceKey && typeof identityManager.createSourceIdentity === 'function'
          ? await identityManager.createSourceIdentity(sourceIdentity, channelName || sourceIdentity.creatorName || 'Anonymous Archive')
          : await identityManager.createIdentity(channelName || sourceIdentity?.creatorName || 'Anonymous Archive', true)
        identity = {
          publicKey: created.publicKey,
          driveKey: created.driveKey,
          channelKey: created.driveKey,
          name: channelName || sourceIdentity?.creatorName || 'Anonymous Archive'
        }
      }

      const channel = sourceKey && typeof identityManager.getChannelForIdentity === 'function'
        ? await identityManager.getChannelForIdentity(identity)
        : await identityManager.getActiveChannel?.()
      if (!channel?.blobs) throw new Error('Anonymous channel blobs not initialized')
      const meta = await channel.getMetadata?.().catch(() => null)
      const publicBeeKey = channel.publicBeeKey || meta?.publicBeeKey || null
      const entry = { channel, channelKey: identity.driveKey || identity.channelKey, publicBeeKey }
      if (sourceKey) sourceChannels.set(sourceKey, entry)
      return entry
    },
    async importVideo({ channel, filePath, title, description, mimeType, category, duration, thumbnail, thumbnailFile, tags, sourceType, sourceUrl, sourceVideoId, creatorSourceId, creatorName, creatorHandle, thumbnailUrl, tmdbType, tmdbId, tmdbSeason, tmdbEpisode }) {
      const result = await uploadManager.uploadFromPath(channel, filePath, {
        title,
        description,
        mimeType,
        category: category || 'archive',
        duration,
        thumbnail,
        tags,
        sourceType,
        sourceUrl,
        sourceVideoId,
        creatorSourceId,
        creatorName,
        creatorHandle,
        thumbnailUrl,
        // TMDB coordinates make the movie/TV identity durable on the canonical
        // video record (schema already supports these fields), not just on the
        // relay-side job/feed previews.
        ...deriveMediaCoordinates({ tmdbType, tmdbId, tmdbSeason, tmdbEpisode })
      }, fs)
      if (!result?.success) throw new Error(result?.error || 'Archive import failed')

      if (thumbnailFile && typeof fs?.readFileSync === 'function') {
        try {
          const image = fs.readFileSync(thumbnailFile)
          const lower = String(thumbnailFile).toLowerCase()
          const thumbnailMimeType = lower.endsWith('.webp')
            ? 'image/webp'
            : lower.endsWith('.png')
              ? 'image/png'
              : 'image/jpeg'
          const thumbnailResult = await uploadManager.setThumbnailFromBuffer(channel, result.videoId, image, thumbnailMimeType)
          if (thumbnailResult?.success) {
            result.metadata = {
              ...(result.metadata || {}),
              thumbnailBlobId: thumbnailResult.thumbnailBlobId || result.metadata?.thumbnailBlobId || null,
              thumbnailBlobsCoreKey: channel.blobsKeyHex || result.metadata?.thumbnailBlobsCoreKey || null,
              thumbnailMimeType
            }
          }
        } catch {
          // Thumbnail attachment is best-effort; keep the imported video publishable.
        }
      }
      return result
    },
    async publishChannel({ channelKey }) {
      return api.submitToFeed(channelKey)
    },
    async seedChannel({ channelKey, publicBeeKey, previewVideos }) {
      if (channelKey && publicBeeKey) {
        const playablePreviews = Array.isArray(previewVideos) ? previewVideos.filter(Boolean) : []
        await runtime?.cacheManager?.addChannel?.(channelKey, publicBeeKey, 'private', {
          previewVideos: playablePreviews
        }).catch(() => {})
        await runtime?.publicFeed?.submitChannel?.(channelKey, publicBeeKey, {
          previewVideos: playablePreviews,
          videoCount: playablePreviews.length,
          manifestUpdatedAt: Date.now()
        }).catch(() => {})
        const seedStats = await runtime?.seeder?.seedChannel?.({
          driveKey: channelKey,
          publicBeeKey,
          previewVideos: playablePreviews
        }).catch(() => null)
        const catalogEntry = seedStats?.catalogEntry || {
          schema: 'peartube.relayCatalog',
          catalogVersion: 1,
          driveKey: channelKey,
          publicBeeKey,
          source: 'archive-job',
          retentionClass: 'private',
          relayRole: 'cache',
          relayServing: true,
          previewVideos: playablePreviews,
          videoCount: playablePreviews.length,
          manifestUpdatedAt: Date.now()
        }
        await runtime?.publishRelayCatalogEntry?.({
          ...catalogEntry,
          source: 'archive-job',
          retentionClass: 'private'
        }).catch(() => {})
      }
    }
  }
}

// Adapt a browser-uploaded file into the same shape `downloader.download`
// returns, so an upload job flows through the identical import/publish/seed
// path as a URL archive — no yt-dlp involved. TMDB coordinates and the title
// ride in from the private input just like the URL case.
function loadUploadedFile (privateInput) {
  const filePath = String(privateInput.uploadPath || '')
  if (!filePath || !existsSync(filePath)) {
    throw new Error(`Uploaded file is missing: ${filePath || '(none)'}`)
  }
  const separator = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const dir = separator > 0 ? filePath.slice(0, separator) : null
  const baseName = (privateInput.uploadFilename || filePath.slice(separator + 1) || 'Uploaded video')
  const stem = baseName.replace(/\.[^.]+$/, '') || 'Uploaded video'
  return {
    filePath,
    title: privateInput.title || stem,
    description: privateInput.description || '',
    duration: undefined,
    thumbnailUrl: null,
    thumbnailFile: null,
    creatorName: privateInput.creatorName || null,
    mimeType: privateInput.uploadMimeType || getVideoMimeType(filePath),
    cleanup () {
      try { if (dir) rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }
}

export function createArchiveManager({ store, downloader, publisher, logger = null, onCompleted = null }) {
  if (!store) throw new Error('store is required')
  if (!downloader) throw new Error('downloader is required')
  if (!publisher) throw new Error('publisher is required')

  return {
    enqueue(input) {
      return enqueueArchiveJob(store, input)
    },
    async runNext() {
      const jobs = await store.listJobs()
      const job = jobs.find((item) => item.status === 'queued' || item.status === 'failed')
      if (!job) return null
      return this.runJob(job.id)
    },
    async runJob(id) {
      const privateInput = await store.getPrivateInput(id)
      const isUpload = Boolean(privateInput?.uploadPath)
      if (!isUpload && !privateInput?.url) throw new Error(`Archive job ${id} has no private URL input`)
      await store.updateJob(id, { status: 'running', error: null })
      let downloaded = null

      try {
        downloaded = isUpload
          ? loadUploadedFile(privateInput)
          : await downloader.download({ id, ...privateInput })
        const channelInfo = await publisher.ensureAnonymousChannel(privateInput)
        const sourceTitle = downloaded.title || privateInput.title
        const sourceDescription = downloaded.description || privateInput.description
        const imported = await publisher.importVideo({
          ...privateInput,
          ...downloaded,
          channel: channelInfo.channel,
          title: sourceTitle,
          description: sourceDescription
        })
        const importedMetadata = imported?.metadata || imported

        const previewVideo = imported?.videoId ? {
          id: imported.videoId,
          title: sourceTitle || imported.videoId,
          description: sourceDescription || '',
          path: importedMetadata.path || `/videos/${imported.videoId}.mp4`,
          uploadedAt: importedMetadata.uploadedAt || now(),
          duration: Number(importedMetadata.duration || downloaded.duration || 0) || 0,
          size: Number(importedMetadata.size || downloaded.size || 0) || 0,
          mimeType: importedMetadata.mimeType || downloaded.mimeType || 'video/mp4',
          sourceVideoId: privateInput.sourceVideoId || downloaded.sourceVideoId || null,
          creatorSourceId: privateInput.creatorSourceId || downloaded.creatorSourceId || null,
          creatorName: privateInput.creatorName || downloaded.creatorName || null,
          creatorHandle: privateInput.creatorHandle || downloaded.creatorHandle || null,
          availability: 'playable',
          blobId: importedMetadata.blobId || null,
          blobsCoreKey: importedMetadata.blobsCoreKey || null,
          thumbnailBlobId: importedMetadata.thumbnailBlobId || null,
          thumbnailBlobsCoreKey: importedMetadata.thumbnailBlobsCoreKey || null,
          thumbnailMimeType: importedMetadata.thumbnailMimeType || null,
          thumbnailUrl: importedMetadata.thumbnailUrl || downloaded.thumbnailUrl || null,
          // Content-type coordinates ride the feed previews so clients can
          // group/badge movies and episodes without loading the channel.
          ...deriveMediaCoordinates(privateInput),
          classification: privateInput.tmdbId ? {
            type: privateInput.tmdbType || 'movie',
            tmdbId: Number(privateInput.tmdbId) || privateInput.tmdbId,
            title: privateInput.tmdbTitle || sourceTitle || null,
            year: Number(privateInput.tmdbYear || 0) || null,
            posterPath: privateInput.tmdbPosterPath || null,
            season: Number(privateInput.tmdbSeason || 0) || null,
            episode: Number(privateInput.tmdbEpisode || 0) || null,
            classifiedAt: now()
          } : undefined
        } : null
        if (privateInput.publish !== false) {
          await publisher.publishChannel(channelInfo)
          await publisher.seedChannel({ ...channelInfo, previewVideos: previewVideo ? [previewVideo] : [] })
        }

        const completed = await store.updateJob(id, {
          status: 'completed',
          title: sourceTitle || downloaded.title,
          videoId: imported.videoId,
          channelKey: channelInfo.channelKey,
          publicBeeKey: channelInfo.publicBeeKey || null,
          previewVideo,
          completedAt: now(),
          error: null
        })
        if (typeof onCompleted === 'function') {
          await onCompleted(completed)
        }
        return completed
      } catch (err) {
        logger?.archive?.error?.('Archive job failed', { id, error: err?.message || String(err) })
        const failed = await store.updateJob(id, { status: 'failed', error: err?.message || String(err) })
        return failed
      } finally {
        try {
          downloaded?.cleanup?.()
        } catch (err) {
          // Best effort: import result is already persisted before cleanup runs.
        }
      }
    }
  }
}
