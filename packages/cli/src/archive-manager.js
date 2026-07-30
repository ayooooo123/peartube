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
import { openResponse, readBody } from './media/http-get.js'
import { buildWriterKeyName } from './archive/source-id.js'
import { createRelayPublisherShell } from './publisher-shell.js'

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

const MAX_POSTER_BYTES = 4 * 1024 * 1024
const POSTER_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const POSTER_TIMEOUT_MS = 15_000

// The HTTP client, named once here so the default below is a module-scope
// reference rather than a global lookup. It used to be `fetchImpl = fetch`,
// which read the global at every call — and the relay runs on Bare, which has
// no global fetch, so every publish died on `fetch is not defined` before the
// function body ran. Node has one, so all 45 test files passed while the
// feature was broken in production. Same story for the AbortController that
// used to time this out; the timeout now lives in the request itself.
const posterHttp = { open: openResponse, read: readBody }

// A consumer holds no metadata-provider credentials, so cover art has to be
// published with the record or every catalog renders as blank placeholders.
// Publishing a metadata-provider URL would not fix that: the consumer would
// have to reach an origin outside the swarm, which leaks who is browsing what,
// fails wherever that origin is unreachable, and is simply unavailable offline.
// The bytes are fetched once, here, by the publisher that already holds the
// credentials, and everything downstream reads them from the swarm.
export async function fetchPosterBytes(tmdbPosterPath, { http = posterHttp, timeoutMs = POSTER_TIMEOUT_MS } = {}) {
  const posterPath = tmdbPosterPath ? String(tmdbPosterPath).trim() : ''
  if (!posterPath) return null
  // Stored once and replicated to every peer, so size the fetch for a poster
  // card rather than pulling the original: w500 covers a 118dp card at 3x.
  const url = posterPath.startsWith('/') ? `https://image.tmdb.org/t/p/w500${posterPath}` : null
  if (!url) return null

  let res = null
  try {
    // Headers first, body second, so a wrong type or an oversized cover is
    // refused without pulling it. The origin is one this function chose, not a
    // caller's, which is why this uses the plain client and not the guarded
    // downloader — but the redirect budget is still bounded, where the global
    // fetch this replaced would have followed twenty of them anywhere.
    ;({ res } = await posterRequest(http, url, timeoutMs))
    const status = res.statusCode || 0
    if (status < 200 || status >= 300) return null
    const mimeType = String(res.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (!POSTER_MIME_TYPES.has(mimeType)) return null
    const declared = Number(res.headers?.['content-length'] || 0)
    if (Number.isFinite(declared) && declared > MAX_POSTER_BYTES) return null
    const bytes = await http.read(res, { maxBytes: MAX_POSTER_BYTES })
    res = null
    if (!bytes || bytes.byteLength === 0) return null
    return { bytes, mimeType }
  } catch {
    // An unreachable provider costs the archive its cover, never the archive.
    return null
  } finally {
    res?.destroy?.()
  }
}

function posterRequest(http, url, timeoutMs) {
  return http.open(url, {
    headers: { 'user-agent': 'PearTube-Relay', accept: 'image/*' },
    timeoutMs,
    timeoutMessage: 'poster fetch timed out'
  })
}

// The job carries what the metadata match resolved as strings from a form. The
// claim wants typed, bounded values, and a viewer sees nothing at all unless
// they make that trip, so convert here rather than publishing raw form input.
export function describeTmdbMedia({ tmdbYear, tmdbOverview, tmdbRuntime, tmdbGenres } = {}) {
  const out = {}
  const year = Number.parseInt(String(tmdbYear ?? '').trim(), 10)
  if (Number.isSafeInteger(year) && year >= 1870 && year <= 2200) out.releaseYear = year
  const runtime = Number.parseInt(String(tmdbRuntime ?? '').trim(), 10)
  if (Number.isSafeInteger(runtime) && runtime > 0) out.runtimeMinutes = runtime
  const overview = String(tmdbOverview ?? '').trim()
  if (overview) out.overview = overview
  const genres = String(tmdbGenres ?? '')
    .split(',')
    .map(genre => genre.trim())
    .filter(Boolean)
  if (genres.length > 0) out.genres = genres
  return out
}

// The poster lives in the publisher's own blob core, so it replicates on the
// same swarm as the video and needs no origin of its own.
export async function publishPosterArtwork(channel, poster) {
  if (!channel || !poster?.bytes?.byteLength) return {}
  const blobsCoreKey = channel.blobsKeyHex
  if (!blobsCoreKey) return {}
  const stored = await channel.putBlob(poster.bytes)
  const blobId = stored?.id == null ? null : String(stored.id)
  if (!blobId) return {}
  return {
    artwork: [{
      role: 'poster',
      blobId,
      blobsCoreKey,
      mimeType: poster.mimeType,
    }],
  }
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
    // Someone who picked this title out of a catalogue told us its name. Only
    // falling back to the filename stem meant every card read
    // "WeddingCrashers2005REPACK1080pBluRay51YTSMX-xpost" - the release
    // scene's name for a file, not the film's name.
    title: input.title ? String(input.title) : (input.tmdbTitle ? String(input.tmdbTitle) : null),
    description: input.description
      ? String(input.description)
      : (input.tmdbOverview ? String(input.tmdbOverview) : ''),
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
    // Set only by the machine API's url ingest: this job fetches a url a
    // stranger supplied, so the downloader re-checks every redirect hop and
    // caps what it will pull. A console submission never sets it, and the
    // console's downloads are unchanged.
    requirePublicSource: input.requirePublicSource === true,
    tmdbType: input.tmdbType ? String(input.tmdbType) : null,
    tmdbId: input.tmdbId ? String(input.tmdbId) : null,
    tmdbSeason: input.tmdbSeason ? String(input.tmdbSeason) : null,
    tmdbEpisode: input.tmdbEpisode ? String(input.tmdbEpisode) : null,
    tmdbPosterPath: input.tmdbPosterPath ? String(input.tmdbPosterPath) : null,
    tmdbTitle: input.tmdbTitle ? String(input.tmdbTitle) : null,
    tmdbYear: input.tmdbYear ? String(input.tmdbYear) : null,
    // Carried so the publisher can put them on the claim: a consumer holds no
    // provider credentials, so anything the relay knows and does not publish is
    // lost to every viewer downstream.
    tmdbOverview: input.tmdbOverview ? String(input.tmdbOverview) : null,
    tmdbRuntime: input.tmdbRuntime ? String(input.tmdbRuntime) : null,
    tmdbGenres: input.tmdbGenres ? String(input.tmdbGenres) : null
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

export function createArchivePublisher({ identityManager, uploadManager, api, runtime, fs, storagePath = null, publisherShell = null, createChannelFn = null }) {
  if (!identityManager) throw new Error('identityManager is required')
  if (!uploadManager) throw new Error('uploadManager is required')
  if (!api) throw new Error('api is required')

  // Publishing an upload requires a writable, admitted publisher catalog, and
  // the relay has to authorize its own. Without it every upload fails late with
  // "No admitted publisher catalog is available", after the file is on disk.
  const relayPublisher = publisherShell || (storagePath
    ? createRelayPublisherShell({ api, storagePath, fs, logger: runtime?.logger })
    : null)

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
    // The archive job carries this id into catalog publication, so it must be
    // the publisher-root catalog id, not the channel identity key.
    const catalogPublisherId = (await relayPublisher?.ensureLocalPublisher())?.publisherId || relayIdentity.publicKey
    return { channel, channelKey, publicBeeKey, publisherId: catalogPublisherId, identityPublicKey: relayIdentity.publicKey }
  }

  // A relay is its own platform. On a phone the OS keychain generates and
  // holds the 32-byte personal-store secret and hands it to the backend; a
  // headless relay has no keychain, so it keeps the secret beside the
  // corestore primary key at 0600 and provisions it the same way. Without
  // this, creating the relay identity leaves its personal store closed and
  // the first archive job dies with PERSONAL_STORE_SECRET_UNAVAILABLE.
  async function ensureRelayPersonalSecret ({ deviceLocal = false } = {}) {
    const secretDir = storagePath || runtime?.ctx?.storagePath || null
    if (!secretDir || typeof api.provisionPersonalEncryption !== 'function') return false
    const fsModule = fs || await import('#fs')
    const secretPath = `${secretDir}/personal-secret`
    let secret = null
    let bootstrapKey = null
    // hypercore-storage sweeps unrecognized root entries into db/ when it
    // opens, so a secret written during one run lives under db/ on the next.
    // Reading only the root path would mint a fresh secret and strand the
    // encrypted personal store written under the old one.
    for (const candidate of [`${secretDir}/db/personal-secret`, secretPath]) {
      if (secret) break
      try {
        const raw = fsModule.readFileSync(candidate, 'utf8')
        // bare-fs can return a Buffer despite the encoding request.
        const stored = (typeof raw === 'string' ? raw : b4a.toString(raw, 'utf8')).trim()
        if (/^[0-9a-f]{64}$/.test(stored)) {
          secret = stored
        } else {
          const parsed = JSON.parse(stored)
          if (/^[0-9a-f]{64}$/.test(parsed?.secret || '')) secret = parsed.secret
          if (parsed?.bootstrapKey) bootstrapKey = parsed.bootstrapKey
        }
      } catch {
        // Missing or unreadable here; try the next location, then provision.
      }
    }
    if (!secret) secret = b4a.toString(crypto.randomBytes(32), 'hex')

    // The device-local store is keyed by a bootstrap key the backend derives on
    // first provision. Persisting it alongside the secret is what lets a
    // restarted relay reopen the same anonymous store instead of stranding it.
    const request = { secret }
    if (deviceLocal) {
      request.deviceLocal = true
      if (bootstrapKey) request.bootstrapKey = bootstrapKey
    }
    const result = await api.provisionPersonalEncryption(request)
    if (!result?.success) throw new Error(`relay personal store provisioning failed: ${result?.error || 'unknown'}`)

    // provisionSecret returns the opened store's key for either mode, so only
    // the device-local call yields the anonymous bootstrap key. Recording the
    // identity-keyed one here would overwrite it with the wrong store's key.
    const nextBootstrapKey = deviceLocal ? (result.bootstrapKey || bootstrapKey || null) : bootstrapKey
    const record = `${JSON.stringify({ secret, bootstrapKey: nextBootstrapKey || null })}\n`
    fsModule.writeFileSync(secretPath, record, { mode: 0o600 })
    return true
  }

  // A grouped channel needs an active identity to vouch for its signed root
  // descriptor. Create the relay's default identity if none exists yet (the
  // shared-channel fallback does the same lazily).
  async function ensureRelayIdentity (fallbackName) {
    const active = identityManager.getActiveIdentity?.()
    if (active?.publicKey) {
      await ensureRelayPersonalSecret()
      return active
    }
    // Creating an identity activates it, and activation opens its personal
    // store. On a fresh relay no secret exists yet, so seed the device-local
    // store first: that gives activation something to fall back to instead of
    // throwing before we ever reach the identity-keyed provisioning below.
    await ensureRelayPersonalSecret({ deviceLocal: true })
    await identityManager.createIdentity(fallbackName || 'Relay Archive', true)
    // The real secret is keyed by the active identity, so it can only be
    // provisioned once that identity exists.
    await ensureRelayPersonalSecret()
    return identityManager.getActiveIdentity?.()
  }

  return {
    async ensureAnonymousChannel({ channelName, sourceIdentity = null } = {}) {
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
          runtime?.logger?.archive?.warn?.('Grouped source channel failed; using shared channel', { sourceId: sourceKey, error: err?.message || String(err) })
        }
      }

      let identity = identityManager.getActiveIdentity?.()
      if (!identity?.driveKey) {
        await ensureRelayPersonalSecret({ deviceLocal: true })
        const created = await identityManager.createIdentity(channelName || sourceIdentity?.creatorName || 'Anonymous Archive', true)
        await ensureRelayPersonalSecret()
        identity = {
          publicKey: created.publicKey,
          driveKey: created.driveKey,
          channelKey: created.driveKey,
          name: channelName || sourceIdentity?.creatorName || 'Anonymous Archive'
        }
      } else {
        // A relay that created its identity before it had secret custody still
        // has an unopenable personal store. Provisioning is idempotent, so do
        // it here too rather than leaving those relays permanently broken.
        await ensureRelayPersonalSecret()
      }

      const channel = await identityManager.getActiveChannel?.()
      if (!channel?.blobs) throw new Error('Anonymous channel blobs not initialized')
      const meta = await channel.getMetadata?.().catch(() => null)
      const publicBeeKey = channel.publicBeeKey || meta?.publicBeeKey || null
      const catalogPublisherId = (await relayPublisher?.ensureLocalPublisher())?.publisherId || identity.publicKey
      return { channel, channelKey: identity.driveKey || identity.channelKey, publicBeeKey, publisherId: catalogPublisherId, identityPublicKey: identity.publicKey }
    },
    async importVideo({ channel, filePath, title, description, mimeType, category, duration, thumbnail, thumbnailFile, tags, sourceType, sourceUrl, sourceVideoId, creatorSourceId, creatorName, creatorHandle, thumbnailUrl, tmdbType, tmdbId, tmdbSeason, tmdbEpisode, tmdbPosterPath, tmdbYear, tmdbOverview, tmdbRuntime, tmdbGenres, publish }) {
      // upload.js refuses to publish unless the registry hands back exactly one
      // writable binding, so the catalog has to exist before the file moves.
      await relayPublisher?.ensureLocalPublisher()
      // Store the cover before the upload so the metadata claim can name it:
      // the claim is authored during the upload, and artwork attached after the
      // fact would never reach a consumer that already read the claim.
      const poster = await publishPosterArtwork(channel, await fetchPosterBytes(tmdbPosterPath))
      const result = await uploadManager.uploadFromPath(channel, filePath, {
        mediaMetadata: describeTmdbMedia({ tmdbYear, tmdbOverview, tmdbRuntime, tmdbGenres }),
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
        publicationState: publish === false ? 'replicationPending' : undefined,
        // TMDB coordinates make the movie/TV identity durable on the canonical
        // video record (schema already supports these fields), not just on the
        // relay-side job/feed previews.
        ...deriveMediaCoordinates({ tmdbType, tmdbId, tmdbSeason, tmdbEpisode }),
        ...poster
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
    async publishCatalog({ publisherId }) {
      if (typeof runtime?.publishPublisherCatalog !== 'function') {
        throw new Error('publisher catalog is unavailable')
      }
      // The catalog is addressed by the publisher root, which is a different
      // key from the channel identity the caller carries around. Publishing
      // under the identity key would resolve a catalog the relay cannot write.
      const catalogPublisherId = (await relayPublisher?.ensureLocalPublisher())?.publisherId || publisherId
      if (!catalogPublisherId) throw new Error('publisher catalog is unavailable')
      const result = await runtime.publishPublisherCatalog({ publisherId: catalogPublisherId })
      // 'refreshed' comes back when the local publisher scope already existed
      // and was rebound; it is a success, not a failure.
      if (result?.status !== 'published' && result?.status !== 'already-published' && result?.status !== 'refreshed') {
        throw new Error(`publisher catalog publication failed: ${result?.status || 'unknown'}`)
      }
      return result
    },
    async retainAssets({ previewVideos }) {
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


function normalizeStagingPath(value) {
  const raw = String(value || '').replace(/\\/g, '/')
  const absolute = raw.startsWith('/')
  const parts = []
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
      else if (!absolute) parts.push('..')
      continue
    }
    parts.push(part)
  }
  return `${absolute ? '/' : ''}${parts.join('/')}` || (absolute ? '/' : '.')
}

export function createArchiveManager({ store, downloader, publisher, logger = null, onCompleted = null, canIngest = null, runQueue = null, onUploadReleased = null, stagingRoot = null }) {
  if (!store) throw new Error('store is required')
  if (!downloader) throw new Error('downloader is required')
  if (!publisher) throw new Error('publisher is required')

  const queue = runQueue || { tail: Promise.resolve() }
  if (!queue.tail || typeof queue.tail.then !== 'function') queue.tail = Promise.resolve()
  const runExclusive = (fn) => {
    const next = queue.tail.then(fn, fn)
    queue.tail = next.catch(() => {})
    return next
  }


  function safeRemoveStagingTarget(target) {
    const root = normalizeStagingPath(stagingRoot)
    const candidate = normalizeStagingPath(target)
    if (!stagingRoot || !target) return false
    if (candidate === root) return false
    const inside = candidate.startsWith(`${root}/`)
    if (!inside) return false
    try {
      rmSync(candidate, { recursive: true, force: true })
      return true
    } catch (err) {
      logger?.archive?.warn?.('Interrupted archive staging cleanup failed', { path: candidate, error: err?.message || String(err) })
      return false
    }
  }

  function uploadStagingDir(privateInput) {
    const filePath = String(privateInput?.uploadPath || '')
    if (!filePath) return null
    const separator = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
    return separator > 0 ? filePath.slice(0, separator) : null
  }

  function directStagingDir(job) {
    const id = String(job?.id || '')
    if (!id || id.includes('..') || /[\\/]/.test(id)) return null
    return join(String(stagingRoot || ''), id)
  }

  async function recoverInterruptedJobsUnlocked() {
    const jobs = await store.listJobs()
    const running = jobs.filter((job) => job?.status === 'running')
    let recovered = 0
    for (const job of running) {
      const privateInput = await store.getPrivateInput(job.id).catch(() => null)
      const isUpload = Boolean(privateInput?.uploadPath)
      const cleanupTarget = isUpload ? uploadStagingDir(privateInput) : directStagingDir(job)
      const cleaned = cleanupTarget ? safeRemoveStagingTarget(cleanupTarget) : false
      const status = isUpload ? 'skipped' : 'failed'
      const error = isUpload
        ? 'archive upload interrupted by relay restart; staged upload was discarded and cannot be retried'
        : 'archive job interrupted by relay restart; staged bytes were discarded'
      await store.updateJob(job.id, {
        status,
        error,
        recoveredAt: now()
      })
      logger?.archive?.warn?.('[archive-stage] recovered interrupted job', { id: job.id, isUpload, cleaned })
      recovered += 1
    }
    return { recovered }
  }

  async function runJobUnlocked(id) {
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
      const channelInfo = await publisher.ensureAnonymousChannel({ ...privateInput, sourceIdentity })
      logger?.archive?.info?.('[archive-stage] channel-ready', { id, channelKey: channelInfo?.channelKey || null, publicBeeKey: channelInfo?.publicBeeKey || null })
      const sourceTitle = downloaded.title || privateInput.title
      const sourceDescription = downloaded.description || privateInput.description
      const imported = await publisher.importVideo({
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
        await publisher.publishCatalog(channelInfo)
        await publisher.retainAssets({ ...channelInfo, previewVideos: previewVideo ? [previewVideo] : [] })
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
      if (isUpload && typeof onUploadReleased === 'function') {
        try { onUploadReleased(privateInput.uploadPath) } catch {}
      }
    }
  }

  return {
    enqueue(input) {
      return enqueueArchiveJob(store, input)
    },
    runNext() {
      return runExclusive(async () => {
        const jobs = await store.listJobs()
        const job = jobs.find((item) => item.status === 'queued' || item.status === 'failed')
        if (!job) return null
        return runJobUnlocked(job.id)
      })
    },
    runJob(id) {
      return runExclusive(() => runJobUnlocked(id))
    },
    recoverInterruptedJobs() {
      return runExclusive(recoverInterruptedJobsUnlocked)
    }
  }
}
