import { spawn } from '#subprocess'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { mkdirSync, rmSync, existsSync, readFileSync } from '#fs'
import { join } from '#path'

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

function parseReportedFilePath(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (line === 'filepath') continue
    if (line.startsWith('filepath ')) return line.slice('filepath '.length).trim()
    return line
  }
  return null
}

function isSupportedArchiveVideoPath(filePath) {
  return /\.(mp4|m4v|mov|webm|mkv)$/i.test(String(filePath || '').split('?')[0])
}

function getArchiveMimeType(filePath) {
  const ext = String(filePath || '').split('?')[0].toLowerCase().split('.').pop()
  if (ext === 'webm') return 'video/webm'
  if (ext === 'mkv') return 'video/x-matroska'
  if (ext === 'mov') return 'video/quicktime'
  return 'video/mp4'
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
  const url = sanitizeUrl(input.url)
  const createdAt = now()
  const job = {
    id: makeJobId(url),
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
    invidiousInstance: input.invidiousInstance ? String(input.invidiousInstance).trim() : '',
    title: job.title,
    description: job.description,
    channelName: job.channelName,
    publish: job.publish,
    anonymous: job.anonymous
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
      const buildArgs = (extraArgs = [], sourceUrl = input.url) => {
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
        args.push(sourceUrl)
        return args
      }

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
          const result = await new Promise((resolve, reject) => {
            const child = spawnFn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
            let out = ''
            let err = ''
            child.stdout?.on('data', (chunk) => { out += String(chunk) })
            child.stderr?.on('data', (chunk) => { err += String(chunk) })
            child.on('error', reject)
            child.on('close', (code) => {
              if (code === 0) resolve({ stdout: out, stderr: err })
              else reject(new Error(`yt-dlp failed (${code}): ${err || out}`))
            })
          })
          stdout = result.stdout
          filePath = parseReportedFilePath(stdout)
          if (!filePath) throw new Error('yt-dlp did not report an output file')
          if (!attempts[attempt].allowUnknownExtension && !isSupportedArchiveVideoPath(filePath)) {
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
        mimeType: getArchiveMimeType(filePath),
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
    async importVideo({ channel, filePath, title, description, mimeType, category, duration, thumbnail, thumbnailFile, tags, sourceType, sourceUrl, sourceVideoId, creatorSourceId, creatorName, creatorHandle, thumbnailUrl }) {
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
        thumbnailUrl
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

export function createArchiveManager({ store, downloader, publisher, logger = null, onCompleted = null, onFailed = null }) {
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
      if (!privateInput?.url) throw new Error(`Archive job ${id} has no private URL input`)
      await store.updateJob(id, { status: 'running', error: null })
      let downloaded = null

      try {
        downloaded = await downloader.download({ id, ...privateInput })
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
          thumbnailUrl: importedMetadata.thumbnailUrl || downloaded.thumbnailUrl || null
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
        if (typeof onFailed === 'function') {
          try {
            await onFailed(failed, err)
          } catch (hookErr) {
            logger?.archive?.warn?.('Archive failure hook failed', { id, error: hookErr?.message || String(hookErr) })
          }
        }
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
