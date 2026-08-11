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
import { buildWriterKeyName } from './archive/source-id.js'

// A publisher proxy that WAITS for the real publisher to be bound instead of
// failing when called early. The relay web console starts before the
// network-bound runtime, so an upload can arrive before the publisher exists;
// throwing there marks the job failed and runJob's finally-cleanup deletes the
// uploaded temp file, permanently losing the upload. Deferring the calls lets
// the background job proceed to import/publish once the runtime is ready.
export function createDeferredPublisher() {
  let target = null
  let markReady = null
  const ready = new Promise((resolve) => { markReady = resolve })
  const resolveTarget = async () => {
    if (!target) await ready
    return target
  }
  const forward = (name) => async (...args) => (await resolveTarget())[name](...args)
  return {
    publisher: {
      ensureAnonymousChannel: forward('ensureAnonymousChannel'),
      importVideo: forward('importVideo'),
      publishCatalog: forward('publishCatalog'),
      retainAssets: forward('retainAssets')
    },
    bind(realPublisher) {
      if (!realPublisher) throw new Error('bind requires a publisher')
      if (target) throw new Error('publisher already bound')
      target = realPublisher
      markReady()
    }
  }
}

// Derive a deterministic per-source identity for an archive job so repeated
// imports for the same title group into ONE channel. TMDB imports key on the
// show/movie (NOT the episode), so every episode of a show lands in the show's
// channel. Returns null for plain single-video archives (they use the relay's
// shared anonymous channel).
export function deriveArchiveSourceIdentity (input = {}) {
  const tmdbId = input.tmdbId != null && String(input.tmdbId).trim() ? String(input.tmdbId).trim() : null
  const tmdbType = input.tmdbType === 'tv' ? 'tv' : (input.tmdbType === 'movie' ? 'movie' : null)
  if (tmdbId && tmdbType) {
    return {
      platform: 'tmdb',
      sourceId: `tmdb:${tmdbType}:${tmdbId}`,
      creatorName: input.tmdbTitle || input.channelName || `TMDB ${tmdbType} ${tmdbId}`,
      creatorHandle: null
    }
  }
  return null
}

async function resolvePublicBeeKey (channel) {
  let publicBeeKey = channel?.publicBeeKey
    ? (b4a.isBuffer(channel.publicBeeKey) ? b4a.toString(channel.publicBeeKey, 'hex') : String(channel.publicBeeKey))
    : null
  if (!publicBeeKey && typeof channel?.getPublicBeeKey === 'function') {
    const resolved = await channel.getPublicBeeKey().catch(() => null)
    if (resolved) publicBeeKey = b4a.isBuffer(resolved) ? b4a.toString(resolved, 'hex') : String(resolved)
  }
  if (!publicBeeKey) {
    const meta = await channel?.getMetadata?.().catch(() => null)
    if (meta?.publicBeeKey) publicBeeKey = String(meta.publicBeeKey)
  }
  return typeof publicBeeKey === 'string' && publicBeeKey.length > 0 ? publicBeeKey : null
}
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
        if (job?.publish === false) continue
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

// Pick the downloader per job. yt-dlp is used ONLY for creator imports — a
// creator is a platform channel/video (YouTube/Rumble/…) that yt-dlp must
// scrape, and those jobs carry a creatorSourceId. Everything else — TMDB
// show/movie imports and the single-video form — is a direct link to the media
// file and streams straight over HTTP.
export function createRoutingDownloader ({ directDownloader, ytDlpDownloader } = {}) {
  return {
    async download (input = {}) {
      const isCreatorImport = Boolean(input.creatorSourceId)
      const useDirect = Boolean(directDownloader) && !isCreatorImport
      const downloader = useDirect ? directDownloader : ytDlpDownloader
      if (!downloader) throw new Error('no downloader available for this archive source')
      return downloader.download(input)
    }
  }
}

export function createArchivePublisher({ identityManager, uploadManager, api, runtime, fs, createChannelFn = null, canPublish = () => false }) {
  if (!identityManager) throw new Error('identityManager is required')
  if (!uploadManager) throw new Error('uploadManager is required')
  if (!api) throw new Error('api is required')

  const assertRetentionPermission = (retentionClass, requestedBytes = 0) => {
    if (canPublish(retentionClass, requestedBytes) === true) return
    const error = new Error('explicit retention consent and budget are required')
    error.code = 'RETENTION_PERMISSION_DENIED'
    throw error
  }

  const sourceChannels = new Map()

  // Deterministic per-source channel keyed by sourceId (writer key seed), so the
  // same show/movie always resolves to the same channel across restarts.
  async function ensureSourceChannel (sourceKey, name) {
    const ctx = runtime?.ctx
    if (!ctx) throw new Error('runtime ctx unavailable for source channel')
    const createChannel = createChannelFn || (await import('@peartube/backend/storage')).createChannel
    const created = await createChannel(ctx, { encrypt: false, writerKeyName: buildWriterKeyName(sourceKey) })
    const channel = created.channel
    const channelKey = created.channelKeyHex || created.channelKey
    if (!channel) throw new Error('createChannel returned no channel')
    if (channel.writable === false) throw new Error(`source channel ${sourceKey} is not writable`)
    const meta = await channel.getMetadata?.().catch(() => null)
    const isFresh = !meta || (typeof meta === 'object' && Object.keys(meta).length === 0)
    if (isFresh) {
      await channel.updateMetadata?.({ name, createdAt: Date.now(), createdBy: sourceKey }).catch(() => {})
    }
    await channel.ensureLocalBlobDrive?.({ deviceName: 'archive' }).catch(() => {})
    if (!channel.blobs) throw new Error('source channel blobs not initialized')
    const publicBeeKey = await resolvePublicBeeKey(channel)
    if (!channelKey || !publicBeeKey) throw new Error('source channel keys unavailable')
    const relayIdentity = await ensureRelayIdentity(name)
    const signed = await identityManager.signChannelRootDescriptorForOwnedChannel?.(channel, { profile: { name } })
    if (!signed?.ok) throw new Error(`source channel descriptor signing failed: ${signed?.reason || 'unavailable'}`)
    return { channel, channelKey, publicBeeKey, publisherId: relayIdentity.publicKey }
  }

  // A grouped channel needs an active identity to vouch for its signed root
  // descriptor. Create the relay's default identity if none exists yet (the
  // shared-channel fallback does the same lazily).
  async function ensureRelayIdentity (fallbackName) {
    const active = identityManager.getActiveIdentity?.()
    if (active?.publicKey) return active
    await identityManager.createIdentity(fallbackName || 'Relay Archive', true)
    return identityManager.getActiveIdentity?.()
  }

  return {
    async ensureAnonymousChannel({ channelName, sourceIdentity = null, requireSourceChannel = false, retentionClass } = {}) {
      assertRetentionPermission(retentionClass)
      const sourceKey = sourceIdentity?.sourceId || null
      if (sourceKey && sourceChannels.has(sourceKey)) return sourceChannels.get(sourceKey)

      // Grouped per-source channel (show/movie). Falls back to the shared
      // anonymous channel on any failure so archiving never hard-fails here.
      if (sourceKey) {
        try {
          const entry = await ensureSourceChannel(sourceKey, channelName || sourceIdentity.creatorName || 'Archive')
          sourceChannels.set(sourceKey, entry)
          return entry
        } catch (err) {
          if (requireSourceChannel) throw err
          runtime?.logger?.archive?.warn?.('Grouped source channel failed; using shared channel', { sourceId: sourceKey, error: err?.message || String(err) })
        }
      }
      if (requireSourceChannel) throw new Error('deterministic source channel is required')

      let identity = identityManager.getActiveIdentity?.()
      if (!identity?.driveKey) {
        const created = await identityManager.createIdentity(channelName || sourceIdentity?.creatorName || 'Anonymous Archive', true)
        identity = {
          publicKey: created.publicKey,
          driveKey: created.driveKey,
          channelKey: created.driveKey,
          name: channelName || sourceIdentity?.creatorName || 'Anonymous Archive'
        }
      }

      const channel = await identityManager.getActiveChannel?.()
      if (!channel?.blobs) throw new Error('Anonymous channel blobs not initialized')
      const meta = await channel.getMetadata?.().catch(() => null)
      const publicBeeKey = channel.publicBeeKey || meta?.publicBeeKey || null
      return { channel, channelKey: identity.driveKey || identity.channelKey, publicBeeKey, publisherId: identity.publicKey }
    },
    async importVideo({
      retentionClass,
      channel,
      filePath,
      videoId,
      signal,
      title,
      description,
      mimeType,
      category,
      duration,
      width,
      height,
      videoCodec,
      thumbnail,
      thumbnailFile,
      tags,
      sourceType,
      sourceUrl,
      sourceVideoId,
      creatorSourceId,
      creatorName,
      creatorHandle,
      thumbnailUrl,
      contentKind,
      mediaProvider,
      mediaId,
      seasonNumber,
      episodeNumber,
      tmdbType,
      tmdbId,
      tmdbSeason,
      tmdbEpisode,
      publish
    }) {
      const requestedBytes = Number(fs?.statSync?.(filePath)?.size || 0)
      assertRetentionPermission(retentionClass, requestedBytes)
      const mediaCoordinates = contentKind
        ? { contentKind, mediaProvider, mediaId, seasonNumber, episodeNumber }
        : deriveMediaCoordinates({ tmdbType, tmdbId, tmdbSeason, tmdbEpisode })
      const result = await uploadManager.uploadFromPath(channel, filePath, {
        title,
        videoId,
        signal,
        retentionClass,
        description,
        mimeType,
        category: category || 'archive',
        duration,
        width,
        height,
        videoCodec,
        thumbnail,
        tags,
        sourceType,
        sourceUrl,
        sourceVideoId,
        creatorSourceId,
        creatorName,
        creatorHandle,
        thumbnailUrl,
        publicationState: publish === false ? 'replicationPending' : undefined,
        // Provider-neutral ingest jobs pass exact coordinates directly; legacy
        // archive jobs continue to derive the same fields from TMDB inputs.
        ...mediaCoordinates
      }, fs)
      if (!result?.success) throw new Error(result?.error || 'Archive import failed')
      if (runtime?.seedingManager?.addSeed) {
        const metadata = result.metadata || result
        const retentionDriveKey = b4a.isBuffer(channel.key)
          ? b4a.toString(channel.key, 'hex')
          : String(channel.key || channel.discoveryKey || metadata.driveKey || 'local-publication')
        await runtime.seedingManager.addSeed(
          retentionDriveKey,
          String(metadata.path || `/videos/${result.videoId}.mp4`),
          retentionClass === 'archive-pin' ? 'archive' : 'watched',
          {
            byteLength: Number(metadata.size || requestedBytes) || 0,
            thumbnailByteLength: Number(metadata.thumbnailSize || 0) || 0,
            publicBeeKey: metadata.publicBeeKey || channel.publicBeeKey || null,
            blobId: metadata.blobId || null,
            blobsCoreKey: metadata.blobsCoreKey || channel.blobsKeyHex || null,
            thumbnailBlobId: metadata.thumbnailBlobId || null,
            thumbnailBlobsCoreKey: metadata.thumbnailBlobsCoreKey || null,
            mimeType: metadata.mimeType || mimeType || null,
            thumbnailMimeType: metadata.thumbnailMimeType || null
          },
          { authorized: true, protectSelf: retentionClass === 'archive-pin' }
        )
      }

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
    async publishCatalog({ publisherId, retentionClass }) {
      assertRetentionPermission(retentionClass)
      if (!publisherId || typeof runtime?.publishPublisherCatalog !== 'function') {
        throw new Error('publisher catalog is unavailable')
      }
      const result = await runtime.publishPublisherCatalog({ publisherId })
      if (result?.status !== 'published' && result?.status !== 'already-published') {
        throw new Error(`publisher catalog publication failed: ${result?.status || 'unknown'}`)
      }
      return result
    },
    async retainAssets({ previewVideos, retentionClass }) {
      assertRetentionPermission(retentionClass)
      const results = []
      for (const video of Array.isArray(previewVideos) ? previewVideos : []) {
        const publication = video?.immutablePublication
        if (publication?.manifest && publication?.renditionId && typeof runtime?.retainRendition === 'function') {
          results.push(await runtime.retainRendition({
            manifest: publication.manifest,
            renditionId: publication.renditionId
          }))
        }
        if (video?.archivePledge && video?.blobsCoreKey && typeof runtime?.retainArchive === 'function') {
          const [start, length] = String(video.blobId || '').split(':').map(Number)
          if (Number.isSafeInteger(start) && Number.isSafeInteger(length) && length > 0) {
            results.push(await runtime.retainArchive({
              pledge: video.archivePledge,
              coreKey: video.blobsCoreKey,
              start,
              end: start + length
            }))
          }
        }
      }
      return results
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

export function createArchiveManager({ store, downloader, publisher, logger = null, onCompleted = null, canIngest = null }) {
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
      // Refuse to download/import when the relay is over its storage threshold
      // or low on free disk, so archive imports (incl. web-console uploads) can't
      // fill the disk and crash the relay. Mark failed WITHOUT touching the
      // staged upload temp so runNext() retries cleanly once space is reclaimed
      // (a URL job re-downloads; an upload re-reads its still-present temp).
      if (typeof canIngest === 'function' && !canIngest()) {
        logger?.archive?.warn?.('[archive-stage] refused: storage threshold reached', { id })
        return store.updateJob(id, { status: 'failed', error: 'relay storage threshold reached; free space or raise storage.maxBytes' })
      }
      await store.updateJob(id, { status: 'running', error: null })
      logger?.archive?.info?.('[archive-stage] running', { id, isUpload })
      let downloaded = null

      try {
        downloaded = isUpload
          ? loadUploadedFile(privateInput)
          : await downloader.download({ id, ...privateInput })
        const sourceIdentity = privateInput.sourceIdentity || deriveArchiveSourceIdentity(privateInput)
        logger?.archive?.info?.('[archive-stage] ensuring-channel', { id, sourceId: sourceIdentity?.sourceId || null })
        const channelInfo = await publisher.ensureAnonymousChannel({
          ...privateInput,
          sourceIdentity,
          retentionClass: 'archive-pin'
        })
        logger?.archive?.info?.('[archive-stage] channel-ready', { id, channelKey: channelInfo?.channelKey || null, publicBeeKey: channelInfo?.publicBeeKey || null })
        const sourceTitle = downloaded.title || privateInput.title
        const sourceDescription = downloaded.description || privateInput.description
        const imported = await publisher.importVideo({
          retentionClass: 'archive-pin',
          ...privateInput,
          ...downloaded,
          channel: channelInfo.channel,
          title: sourceTitle,
          description: sourceDescription
        })
        logger?.archive?.info?.('[archive-stage] imported', { id, videoId: imported?.videoId || null })
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
          immutablePublication: importedMetadata.immutablePublication || null,
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
        logger?.archive?.info?.('[archive-stage] publishing', { id, publish: privateInput.publish !== false })
        if (privateInput.publish !== false) {
          await publisher.publishCatalog({ ...channelInfo, retentionClass: 'archive-pin' })
          await publisher.retainAssets({ ...channelInfo, retentionClass: 'archive-pin', previewVideos: previewVideo ? [previewVideo] : [] })
        }
        logger?.archive?.info?.('[archive-stage] published', { id })

        const completed = await store.updateJob(id, {
          status: 'completed',
          title: sourceTitle || downloaded.title,
          videoId: imported.videoId,
          channelKey: channelInfo.channelKey,
          publicBeeKey: channelInfo.publicBeeKey || null,
          publisherId: channelInfo.publisherId || null,
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
