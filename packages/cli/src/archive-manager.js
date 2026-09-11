import { spawn } from '#subprocess'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { mkdirSync, rmSync, existsSync, readFileSync } from '#fs'
import { join, basename } from '#path'
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
import { createOneShotSourceReader, createSourceReader } from '@peartube/backend/assets'

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
function resolvePosterUrl(tmdbPosterPath) {
  const posterPath = tmdbPosterPath ? String(tmdbPosterPath).trim() : ''
  if (!posterPath || !posterPath.startsWith('/')) return null
  // Stored once and replicated to every peer, so size the fetch for a poster
  // card rather than pulling the original: w500 covers a 118dp card at 3x.
  return `https://image.tmdb.org/t/p/w500${posterPath}`
}

function validatePosterResponse(res) {
  const status = res.statusCode || 0
  if (status < 200 || status >= 300) return null
  const mimeType = String(res.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase()
  if (!POSTER_MIME_TYPES.has(mimeType)) return null
  const declared = Number(res.headers?.['content-length'] || 0)
  if (Number.isFinite(declared) && declared > MAX_POSTER_BYTES) return null
  return mimeType
}

export async function fetchPosterBytes(tmdbPosterPath, { http = posterHttp, timeoutMs = POSTER_TIMEOUT_MS } = {}) {
  const url = resolvePosterUrl(tmdbPosterPath)
  if (!url) return null

  let res = null
  try {
    // Headers first, body second, so a wrong type or an oversized cover is
    // refused without pulling it. The origin is one this function chose, not a
    // caller's, which is why this uses the plain client and not the guarded
    // downloader — but the redirect budget is still bounded, where the global
    // fetch this replaced would have followed twenty of them anywhere.
    ({ res } = await posterRequest(http, url, timeoutMs))
    const mimeType = validatePosterResponse(res)
    if (!mimeType) return null
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

function reserveAdjustedArchiveHeadroom(snapshot, reservedBytes = 0) {
  const reserved = Math.max(0, Math.floor(Number(reservedBytes) || 0))
  if (Number.isFinite(snapshot)) return Math.max(0, snapshot - reserved)
  if (!snapshot || typeof snapshot !== 'object') return snapshot
  if (snapshot.sharedVolume === false) {
    return { ...snapshot, storage: Math.max(0, Number(snapshot.storage) - reserved) }
  }
  return {
    ...snapshot,
    tmp: Math.max(0, Number(snapshot.tmp) - reserved),
    storage: Math.max(0, Number(snapshot.storage) - reserved)
  }
}

function archiveFileSizeLimit(snapshot) {
  // bv*+ba/b may hold separate video, audio, and merged output in staging.
  // The persisted archive is a fourth copy on a shared volume.
  if (Number.isFinite(snapshot)) return Math.max(0, Math.floor(snapshot / 4))
  if (!snapshot || typeof snapshot !== 'object') return 0
  const tmp = Number(snapshot.tmp)
  const storage = Number(snapshot.storage)
  if (!Number.isFinite(tmp) || !Number.isFinite(storage)) return 0
  return snapshot.sharedVolume === false
    ? Math.max(0, Math.floor(Math.min(tmp / 3, storage)))
    : Math.max(0, Math.floor(Math.min(tmp, storage) / 4))
}

function archiveHeadroomExhausted(snapshot) {
  return archiveFileSizeLimit(snapshot) <= 0
}

function createStorageReservationManager(storageHeadroom, storageReservations) {
  const existingReservations = Math.max(0, Math.floor(Number(storageReservations?.bytes) || 0))
  const maxFileSize = typeof storageHeadroom === 'function'
    ? archiveFileSizeLimit(reserveAdjustedArchiveHeadroom(storageHeadroom(), existingReservations))
    : 0
  if (typeof storageHeadroom === 'function' && maxFileSize <= 0) {
    throw new Error('relay has no measurable archive storage headroom for yt-dlp')
  }
  let reservationReleased = false
  const releaseReservation = () => {
    if (reservationReleased || !storageReservations) return
    reservationReleased = true
    storageReservations.bytes = Math.max(0, Math.floor(Number(storageReservations.bytes) || 0) - maxFileSize)
    storageReservations.invalidate?.()
  }
  if (storageReservations && maxFileSize > 0) {
    storageReservations.bytes = existingReservations + maxFileSize
    storageReservations.invalidate?.()
  }
  return { maxFileSize, releaseReservation }
}

function createMonitoredSpawn({ spawnFn, storageHeadroom, storageReservations, onStorageChanged, onStorageExceeded }) {
  return (...args) => {
    const child = spawnFn(...args)
    if (typeof storageHeadroom !== 'function' || typeof child?.kill !== 'function') return child
    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
    }
    const timer = setInterval(() => {
      onStorageChanged?.()
      storageReservations?.invalidate?.()
      const reservedBytes = Math.max(0, Math.floor(Number(storageReservations?.bytes) || 0))
      const remaining = reserveAdjustedArchiveHeadroom(storageHeadroom(), reservedBytes)
      if (!archiveHeadroomExhausted(remaining)) return
      onStorageExceeded()
      stop()
      child.kill('SIGTERM')
    }, 100)
    child.on?.('close', stop)
    child.on?.('error', stop)
    return child
  }
}

async function executeYtDlpAttempts({ bin, attempts, buildArgs, monitoredSpawn, targetDir, fs }) {
  let filePath = null
  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    const args = buildArgs(attempts[attempt].args, attempts[attempt].url)
    try {
      const result = await runYtDlp(bin, args, { spawnFn: monitoredSpawn })
      filePath = parseReportedFilePath(result.stdout)
      if (!filePath) throw new Error('yt-dlp did not report an output file')
      if (!attempts[attempt].allowUnknownExtension && !isSupportedVideoPath(filePath)) {
        throw new Error(`yt-dlp reported unsupported archive output file: ${filePath}`)
      }
      return filePath
    } catch (err) {
      const message = err?.message || String(err)
      const canRetry = /Sign in to confirm.*not a bot|LOGIN_REQUIRED|HTTP Error (?:400|403|418|429|500)|Requested format is not available|unsupported archive output file/i.test(message)
      if (!canRetry || attempt === attempts.length - 1) throw err
      fs.rmSync(targetDir, { recursive: true, force: true })
      fs.mkdirSync(targetDir, { recursive: true })
    }
  }
  return filePath
}

function readYtDlpInfoFile(infoPath, fs) {
  if (typeof fs.existsSync !== 'function' || !fs.existsSync(infoPath) || typeof fs.readFileSync !== 'function') {
    return null
  }
  try {
    const parsed = JSON.parse(String(fs.readFileSync(infoPath, 'utf8') || '{}'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function trimmedMetadataString(info, key) {
  const value = info?.[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function readYtDlpMetadata(filePath, fs) {
  const stem = filePath.replace(/\.[^.]+$/, '')
  const info = readYtDlpInfoFile(`${stem}.info.json`, fs)
  const sourceTitle = trimmedMetadataString(info, 'title')
  const sourceDescription = typeof info?.description === 'string' ? info.description : null
  const sourceDuration = Number.isFinite(info?.duration) ? Number(info.duration) : undefined
  const thumbnailUrl = trimmedMetadataString(info, 'thumbnail')
  const thumbnailFile = ['jpg', 'jpeg', 'webp', 'png']
    .map((ext) => `${stem}.${ext}`)
    .find((candidate) => typeof fs.existsSync === 'function' && fs.existsSync(candidate)) || null
  const creatorName = trimmedMetadataString(info, 'uploader')
  return { sourceTitle, sourceDescription, sourceDuration, thumbnailUrl, thumbnailFile, creatorName }
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
  storageHeadroom = null,
  storageReservations = null,
  onStorageChanged = null,
  spawnFn = spawn,
  fs = { mkdirSync, rmSync, existsSync, readFileSync },
  path = { join }
} = {}) {
  if (!outputDir) throw new Error('outputDir is required')

  return {
    async download(input) {
      const { maxFileSize, releaseReservation } = createStorageReservationManager(storageHeadroom, storageReservations)
      let storageExceeded = false
      let targetDir = null
      try {
        const id = input.id || makeJobId(input.url)
        targetDir = path.join(outputDir, id)
        fs.mkdirSync(targetDir, { recursive: true })
        const outputTemplate = path.join(targetDir, '%(title).200B [%(id)s].%(ext)s')
        const buildArgs = (extraArgs = [], sourceUrl = input.url) => buildDownloadArgs({
          format,
          outputTemplate,
          ffmpegPath,
          cookiesPath,
          maxFileSize,
          jsRuntime,
          extraArgs,
          sourceUrl
        })
        const monitoredSpawn = createMonitoredSpawn({
          spawnFn,
          storageHeadroom,
          storageReservations,
          onStorageChanged,
          onStorageExceeded: () => { storageExceeded = true }
        })

        const invidiousFallbackUrls = buildInvidiousFallbackUrls(input.url, input.invidiousInstance)
        const attempts = [
          { args: safeArgsArray(ytDlpExtraArgs), url: input.url, allowUnknownExtension: false },
          ...safeArray(ytDlpRetryExtraArgs).map((args) => ({ args: safeArgsArray(args), url: input.url, allowUnknownExtension: false })),
          ...invidiousFallbackUrls.map((url) => ({ args: [], url, allowUnknownExtension: false }))
        ]
        const filePath = await executeYtDlpAttempts({
          bin,
          attempts,
          buildArgs,
          monitoredSpawn,
          targetDir,
          fs
        })

        if (!filePath) throw new Error('yt-dlp did not report an output file')
        if (typeof fs.existsSync === 'function' && !fs.existsSync(filePath)) {
          throw new Error(`yt-dlp reported output file does not exist: ${filePath}`)
        }

        const meta = readYtDlpMetadata(filePath, fs)
        const titleFallback = input.title || meta.sourceTitle || filePath.split('/').pop()?.replace(/\.[^.]+$/, '') || 'Archived video'
        const descFallback = input.description || meta.sourceDescription || `Archived anonymously from ${new URL(input.url).hostname}`

        return {
          filePath,
          title: titleFallback,
          description: descFallback,
          duration: meta.sourceDuration,
          thumbnailUrl: meta.thumbnailUrl,
          thumbnailFile: meta.thumbnailFile,
          creatorName: meta.creatorName,
          mimeType: getVideoMimeType(filePath),
          releaseStorageReservation: releaseReservation,
          cleanup() {
            try {
              fs.rmSync(targetDir, { recursive: true, force: true })
            } catch {
              // Best effort: stale archive temp directories are harmless and can be cleaned on the next run.
            } finally {
              onStorageChanged?.()
              releaseReservation()
            }
          }
        }
      } catch (err) {
        releaseReservation()
        if (targetDir) {
          try { fs.rmSync(targetDir, { recursive: true, force: true }) } catch { /* Preserve the download failure. */ }
        }
        throw storageExceeded
          ? new Error('relay archive storage headroom exhausted during yt-dlp download')
          : err
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
      // With block offload configured the direct downloader can hand the body
      // straight to the ingest, so the title is never staged on the volume as a
      // file and its size stops being the bound. Without offload there is
      // nowhere for the blocks to go but here, and the temp-file path is the
      // one that stays correct — so that is what an unbounded downloader gets,
      // unchanged.
      if (useDirect && downloader.bounded === true && typeof downloader.downloadStream === 'function') {
        return downloader.downloadStream(input)
      }
      return downloader.download(input)
    }
  }
}

const SHA256_BYTES = 32

function sha256Hasher () {
  const state = b4a.alloc(sodium.crypto_hash_sha256_STATEBYTES)
  sodium.crypto_hash_sha256_init(state)
  return {
    update (chunk) { sodium.crypto_hash_sha256_update(state, chunk) },
    digest () {
      const out = b4a.alloc(SHA256_BYTES)
      sodium.crypto_hash_sha256_final(state, out)
      return b4a.toString(out, 'hex')
    }
  }
}

function assertValidReadRange(byteOffset, requestedLength, length) {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset > length) {
    throw new Error(`granted source cannot open at byte ${byteOffset} of ${length}`)
  }
  if (!Number.isSafeInteger(requestedLength) || requestedLength < 0 || byteOffset + requestedLength > length) {
    throw new Error(`granted source cannot read ${requestedLength} bytes at ${byteOffset} of ${length}`)
  }
}

function assertDigestMatches(hasher, expectedDigest) {
  if (hasher !== null && hasher.digest() !== expectedDigest) {
    const mismatch = new Error('granted source bytes do not match the expected SHA-256 digest')
    mismatch.code = 'HASH_MISMATCH'
    throw mismatch
  }
}

function bindAbortSignal(signal, onAbort) {
  signal?.addEventListener?.('abort', onAbort, { once: true })
  if (signal?.aborted === true) onAbort()
  return () => signal?.removeEventListener?.('abort', onAbort)
}

function logRangeServed({ logger, jobId, rangeBytes, fetchMs, consumeStartedAt }) {
  logger?.archive?.info?.('[archive-range] served', {
    jobId,
    bytes: rangeBytes,
    fetchMs,
    consumeMs: Date.now() - consumeStartedAt
  })
}
/**
 * A GRANTED source is a byte-addressable origin: the grant states the total
 * length up front, carries an ETag that survives the origin re-resolving the
 * same content, and answers one bounded range at a time with HTTP 206.
 *
 * That is precisely what a resumable ingest needs and what a one-shot response
 * body can never be. An attempt that was interrupted forty minutes in asks for
 * the bytes after the prefix it already staged instead of pulling the title
 * again from byte zero, and the ETag travelling on every range as `If-Match` is
 * what makes splicing those two reads into one content-addressed core safe.
 *
 * Nothing here touches the disk. The ranges are handed straight to the asset
 * writer, which is the whole reason a title may be larger than the volume it is
 * being archived on.
 */
export function createGrantedRangedSource ({
  client,
  capability,
  jobId,
  etag,
  length,
  sha256 = null,
  signal = null,
  onProgress = null,
  // Called with the failure that stopped a read, before it is thrown. The
  // upload manager reports a failure as a message rather than as the exception
  // it was, so a caller that has to tell a lapsed grant from a revoked one
  // needs to see the exception while it still exists.
  onFailure = null,
  logger = null
} = {}) {
  if (!client || typeof client.getRange !== 'function') {
    throw new Error('granted source requires a range-capable source client')
  }
  const chunkBytes = Number(client.chunkBytes)
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
    throw new Error('granted source client must declare a positive chunkBytes')
  }
  if (!Number.isSafeInteger(length) || length < 1) {
    throw new Error('granted source requires the authoritative total length')
  }
  if (typeof jobId !== 'string' || jobId.length === 0) throw new Error('granted source requires the ingest job id')
  if (typeof etag !== 'string' || etag.length === 0) throw new Error('granted source requires the grant ETag')
  const digest = typeof sha256 === 'string' && sha256.length > 0 ? sha256 : null

  // A range in flight and a range being consumed, and never more than that.
  //
  // getRange pushes chunks through a callback rather than yielding them, so a
  // range is materialised whole before any of it can be handed on. Asking for
  // the NEXT range the moment the current one's body has ended keeps the
  // upstream pulling while this one is hashed, appended and — under block
  // offload — uploaded, work the asset writer awaits per block and which would
  // otherwise leave the connection idle for the whole of it.
  //
  // Exactly one request is ever open, because the read-ahead is issued after
  // its predecessor's body ended rather than alongside it, and at most one
  // completed range is held unconsumed. So an ingest's resident cost is two
  // ranges and still does not grow with the title. Reading further ahead would
  // put the title back in memory, which is the one thing this path exists to
  function fetchRange (start, stop, readSignal) {
    const end = Math.min(start + chunkBytes, stop) - 1
    const parts = []
    const pending = client.getRange({
      capability,
      jobId,
      etag,
      length,
      start,
      end,
      signal: readSignal,
      onChunk: (chunk) => { parts.push(chunk) }
    }).then(() => ({ parts, end }))
    pending.catch(() => {})
    return pending
  }
  async function *readFrom (byteOffset, requestedLength = length - byteOffset) {
    const reads = new AbortController()
    const abortReads = () => reads.abort()
    const unbindSignal = bindAbortSignal(signal, abortReads)
    try {
      assertValidReadRange(byteOffset, requestedLength, length)
      const readEnd = byteOffset + requestedLength
      const hasher = digest === null ? null : sha256Hasher()
      let pending = byteOffset < readEnd ? fetchRange(byteOffset, readEnd, reads.signal) : null
      while (pending !== null) {
        // Where an archive's time actually goes. The read-ahead means awaiting
        // the upstream should cost nothing once the first range has landed, so a
        // non-zero wait says the source is the limit, and a large consume says
        // this relay's own hash/append/offload path is. Measured because the
        // arithmetic was wrong twice: cold opens were eliminated and throughput
        // did not move.
        const fetchStartedAt = Date.now()
        const { parts, end } = await pending
        const fetchMs = Date.now() - fetchStartedAt
        const position = end + 1
        pending = position < readEnd ? fetchRange(position, readEnd, reads.signal) : null
        const consumeStartedAt = Date.now()
        let rangeBytes = 0
        for (const part of parts) {
          hasher?.update(part)
          rangeBytes += part.byteLength ?? part.length ?? 0
          yield part
        }
        logRangeServed({ logger, jobId, rangeBytes, fetchMs, consumeStartedAt })
        if (onProgress) await onProgress(position)
      }
      assertDigestMatches(hasher, digest)
    } catch (error) {
      onFailure?.(error)
      throw error
    } finally {
      unbindSignal()
      reads.abort()
    }
  }

  return {
    id: jobId,
    etag,
    sha256: digest,
    length,
    // A whole-file digest can only be checked by an attempt that reads the
    // whole file, so a request that states one is ingested in a single pass
    // from byte zero rather than resumed from a staged prefix — the digest
    // stays exactly as verifiable as it was when the title was spooled and
    // re-read. A remote range source normally cannot state one without pulling
    // the whole file first, so production grants carry an ETag and no digest,
    // and take the resumable shape.
    resumable: digest === null,
    open: (byteOffset) => readFrom(byteOffset),
    openRange: ({ offset, length: rangeLength }) => readFrom(offset, rangeLength)
  }
}

async function initializeSourceChannelMetadata (channel, { name, sourceKey }) {
  const meta = await channel.getMetadata?.().catch(() => null)
  const isFresh = !meta || (typeof meta === 'object' && Object.keys(meta).length === 0)
  if (isFresh) {
    await channel.updateMetadata?.({ name, createdAt: Date.now(), createdBy: sourceKey }).catch(() => {})
  }
  await channel.ensureLocalBlobDrive?.({ deviceName: 'archive' }).catch(() => {})
  if (!channel.blobs) throw new Error('source channel blobs not initialized')
}

async function signAndPublishSourceChannel ({ channel, name, identityManager, ensureRelayIdentity, relayPublisher }) {
  const relayIdentity = await ensureRelayIdentity(name)
  const signed = await identityManager.signChannelRootDescriptorForOwnedChannel?.(channel, { profile: { name } })
  if (!signed?.ok) throw new Error(`source channel descriptor signing failed: ${signed?.reason || 'unavailable'}`)
  const catalogPublisherId = (await relayPublisher?.ensureLocalPublisher())?.publisherId || relayIdentity.publicKey
  return { publisherId: catalogPublisherId, identityPublicKey: relayIdentity.publicKey }
}

function resolveSecretDir (storagePath, runtime) {
  return storagePath || runtime?.ctx?.storagePath || null
}

function readPersistedPersonalSecret (secretDir, fsModule) {
  let secret = null
  let bootstrapKey = null
  for (const candidate of [`${secretDir}/db/personal-secret`, `${secretDir}/personal-secret`]) {
    if (secret) break
    try {
      const raw = fsModule.readFileSync(candidate, 'utf8')
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
  return { secret, bootstrapKey }
}

function calculateRequestedBytes({ granted, stream, byteLength, filePath, fs }) {
  if (granted) return granted.length
  if (stream) return Math.max(0, Math.floor(Number(byteLength) || 0))
  return Number(fs?.statSync?.(filePath)?.size || 0)
}

function resolveSourceFileName(sourceFileName, filePath) {
  if (typeof sourceFileName === 'string' && sourceFileName) return sourceFileName
  return filePath ? basename(filePath) : null
}

async function dispatchVideoUpload({
  uploadManager,
  channel,
  granted,
  stream,
  filePath,
  requestedBytes,
  mimeType,
  videoId,
  uploadOptions,
  fs
}) {
  if (granted) {
    const reader = createSourceReader({
      resumable: granted.resumable,
      maxReadBytes: requestedBytes,
      async describe() {
        return {
          identity: granted.sha256
            ? { kind: 'sha256', value: granted.sha256 }
            : { kind: 'etag', value: granted.etag },
          byteLength: requestedBytes,
          mimeType: mimeType || 'application/octet-stream',
        }
      },
      open({ offset, length }) {
        return granted.openRange({ offset, length })
      },
      async close() {},
    })
    return uploadManager.uploadFromStream(channel, reader, {
      ...uploadOptions,
      resumeId: granted.resumable ? granted.id : undefined,
    })
  }
  if (stream) {
    const reader = createOneShotSourceReader({
      source: stream,
      identity: { kind: 'etag', value: `one-shot:${videoId}:${requestedBytes}` },
      byteLength: requestedBytes,
      mimeType: mimeType || 'application/octet-stream',
    })
    return uploadManager.uploadFromStream(channel, reader, {
      ...uploadOptions,
      byteLength: requestedBytes
    })
  }
  return uploadManager.uploadFromPath(channel, filePath, uploadOptions, fs)
}

function buildSeedRecordOptions({ metadata, channel, requestedBytes, mimeType }) {
  return {
    byteLength: Number(metadata.size || requestedBytes) || 0,
    thumbnailByteLength: Number(metadata.thumbnailSize || 0) || 0,
    publicBeeKey: metadata.publicBeeKey || channel.publicBeeKey || null,
    blobId: metadata.blobId || null,
    blobsCoreKey: metadata.blobsCoreKey || channel.blobsKeyHex || null,
    thumbnailBlobId: metadata.thumbnailBlobId || null,
    thumbnailBlobsCoreKey: metadata.thumbnailBlobsCoreKey || null,
    mimeType: metadata.mimeType || mimeType || null,
    thumbnailMimeType: metadata.thumbnailMimeType || null
  }
}

async function registerImportSeed({ runtime, channel, result, requestedBytes, retentionClass, mimeType }) {
  if (!runtime?.seedingManager?.addSeed) return
  const metadata = result.metadata || result
  const retentionDriveKey = b4a.isBuffer(channel.key)
    ? b4a.toString(channel.key, 'hex')
    : String(channel.key || channel.discoveryKey || metadata.driveKey || 'local-publication')
  const seedOptions = buildSeedRecordOptions({ metadata, channel, requestedBytes, mimeType })
  await runtime.seedingManager.addSeed(
    retentionDriveKey,
    String(metadata.path || `/videos/${result.videoId}.mp4`),
    retentionClass === 'archive-pin' ? 'archive' : 'watched',
    seedOptions,
    { authorized: true, protectSelf: retentionClass === 'archive-pin' }
  )
}

async function attachThumbnailFile({ thumbnailFile, uploadManager, channel, result, fs }) {
  if (!thumbnailFile || typeof fs?.readFileSync !== 'function') return
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

export function createArchivePublisher({ identityManager, uploadManager, api, runtime, fs, storagePath = null, publisherShell = null, createChannelFn = null, canPublish = () => false }) {
  if (!identityManager) throw new Error('identityManager is required')
  if (!uploadManager) throw new Error('uploadManager is required')
  if (!api) throw new Error('api is required')

  // Publishing an upload requires a writable, admitted publisher catalog, and
  // the relay has to authorize its own. Without it every upload fails late with
  // "No admitted publisher catalog is available", after the file is on disk.
  const relayPublisher = publisherShell || (storagePath
    ? createRelayPublisherShell({ api, storagePath, fs, logger: runtime?.logger })
    : null)

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
    await initializeSourceChannelMetadata(channel, { name, sourceKey })
    const publicBeeKey = await resolvePublicBeeKey(channel)
    if (!channelKey || !publicBeeKey) throw new Error('source channel keys unavailable')
    const { publisherId, identityPublicKey } = await signAndPublishSourceChannel({
      channel,
      name,
      identityManager,
      ensureRelayIdentity,
      relayPublisher
    })
    return { channel, channelKey, publicBeeKey, publisherId, identityPublicKey }
  }

  // A relay is its own platform. On a phone the OS keychain generates and
  // holds the 32-byte personal-store secret and hands it to the backend; a
  // headless relay has no keychain, so it keeps the secret beside the
  // corestore primary key at 0600 and provisions it the same way. Without
  // this, creating the relay identity leaves its personal store closed and
  // the first archive job dies with PERSONAL_STORE_SECRET_UNAVAILABLE.
  async function ensureRelayPersonalSecret ({ deviceLocal = false } = {}) {
    const secretDir = resolveSecretDir(storagePath, runtime)
    if (!secretDir || typeof api.provisionPersonalEncryption !== 'function') return false
    const fsModule = fs || await import('#fs')
    const secretPath = `${secretDir}/personal-secret`
    let { secret, bootstrapKey } = readPersistedPersonalSecret(secretDir, fsModule)
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

  async function tryEnsureGroupedChannel ({ sourceKey, channelName, sourceIdentity, requireSourceChannel }) {
    if (sourceChannels.has(sourceKey)) return sourceChannels.get(sourceKey)
    try {
      const name = channelName || sourceIdentity?.creatorName || 'Archive'
      const entry = await ensureSourceChannel(sourceKey, name)
      sourceChannels.set(sourceKey, entry)
      return entry
    } catch (err) {
      if (requireSourceChannel) throw err
      runtime?.logger?.archive?.warn?.('Grouped source channel failed; using shared channel', {
        sourceId: sourceKey,
        error: err?.message || String(err)
      })
      return null
    }
  }

  async function ensureAnonymousIdentity (channelName, sourceIdentity) {
    let identity = identityManager.getActiveIdentity?.()
    const defaultName = channelName || sourceIdentity?.creatorName || 'Anonymous Archive'
    if (!identity?.driveKey) {
      await ensureRelayPersonalSecret({ deviceLocal: true })
      const created = await identityManager.createIdentity(defaultName, true)
      await ensureRelayPersonalSecret()
      return {
        publicKey: created.publicKey,
        driveKey: created.driveKey,
        channelKey: created.driveKey,
        name: defaultName
      }
    }
    // A relay that created its identity before it had secret custody still
    // has an unopenable personal store. Provisioning is idempotent, so do
    // it here too rather than leaving those relays permanently broken.
    await ensureRelayPersonalSecret()
    return identity
  }

  return {
    async ensureAnonymousChannel({ channelName, sourceIdentity = null, requireSourceChannel = false, retentionClass } = {}) {
      assertRetentionPermission(retentionClass)
      const sourceKey = sourceIdentity?.sourceId || null
      if (sourceKey) {
        const grouped = await tryEnsureGroupedChannel({ sourceKey, channelName, sourceIdentity, requireSourceChannel })
        if (grouped) return grouped
      }
      if (requireSourceChannel) throw new Error('deterministic source channel is required')

      const identity = await ensureAnonymousIdentity(channelName, sourceIdentity)
      const channel = await identityManager.getActiveChannel?.()
      if (!channel?.blobs) throw new Error('Anonymous channel blobs not initialized')
      const meta = await channel.getMetadata?.().catch(() => null)
      const publicBeeKey = channel.publicBeeKey || meta?.publicBeeKey || null
      const catalogPublisherId = (await relayPublisher?.ensureLocalPublisher())?.publisherId || identity.publicKey
      return {
        channel,
        channelKey: identity.driveKey || identity.channelKey,
        publicBeeKey,
        publisherId: catalogPublisherId,
        identityPublicKey: identity.publicKey
      }
    },
    async importVideo({
      retentionClass,
      channel,
      filePath,
      stream,
      sourceGrant,
      byteLength,
      videoId,
      signal,
      title,
      sourceFileName,
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
      tmdbPosterPath,
      tmdbYear,
      tmdbOverview,
      tmdbRuntime,
      tmdbGenres,
      publish
    }) {
      const granted = sourceGrant ? createGrantedRangedSource({ ...sourceGrant, signal, logger: runtime?.logger }) : null
      const requestedBytes = calculateRequestedBytes({ granted, stream, byteLength, filePath, fs })
      assertRetentionPermission(retentionClass, requestedBytes)
      await relayPublisher?.ensureLocalPublisher()
      const poster = await publishPosterArtwork(channel, await fetchPosterBytes(tmdbPosterPath))
      const mediaCoordinates = contentKind
        ? { contentKind, mediaProvider, mediaId, seasonNumber, episodeNumber }
        : deriveMediaCoordinates({ tmdbType, tmdbId, tmdbSeason, tmdbEpisode })
      const uploadOptions = {
        mediaMetadata: describeTmdbMedia({ tmdbYear, tmdbOverview, tmdbRuntime, tmdbGenres }),
        title,
        sourceFileName: resolveSourceFileName(sourceFileName, filePath),
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
        ...mediaCoordinates,
        ...poster
      }
      const result = await dispatchVideoUpload({
        uploadManager,
        channel,
        granted,
        stream,
        filePath,
        requestedBytes,
        mimeType,
        videoId,
        uploadOptions,
        fs
      })
      if (!result?.success) throw new Error(result?.error || 'Archive import failed')
      await registerImportSeed({ runtime, channel, result, requestedBytes, retentionClass, mimeType })
      await attachThumbnailFile({ thumbnailFile, uploadManager, channel, result, fs })
      return result
    },
    async publishCatalog({ publisherId, retentionClass }) {
      assertRetentionPermission(retentionClass)
      if (typeof runtime?.publishPublisherCatalog !== 'function') {
        throw new Error('publisher catalog is unavailable')
      }
      // The catalog is addressed by the publisher root, which is a different
      // key from the channel identity the caller carries around. Publishing
      // under the identity key would resolve a catalog the relay cannot write.
      const catalogPublisherId = (await relayPublisher?.ensureLocalPublisher())?.publisherId || publisherId
      if (!catalogPublisherId) throw new Error('publisher catalog is unavailable')
      const result = await runtime.publishPublisherCatalog({ publisherId: catalogPublisherId, retentionClass })
      // 'refreshed' comes back when the local publisher scope already existed
      // and was rebound; it is a success, not a failure.
      if (result?.status !== 'published' && result?.status !== 'already-published' && result?.status !== 'refreshed') {
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
            renditionId: publication.renditionId,
            retentionClass
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
