import { createServer } from '#http'
import { createReadStream, rmSync, statSync } from '#fs'
import { basename, dirname, relative, resolve } from '#path'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { isArtworkRendition } from '@peartube/backend/assets'
import { renderArchiveTui, renderArchiveWebHome } from './archive-ui.js'
import { resolveTmdbOptions } from './settings.js'
import { parseBoundary, receiveMultipartUpload } from './multipart.js'
// The relay's own HTTP client rather than fetch(): Bare ships no global fetch,
// so a fetch() here would be a ReferenceError the moment the relay runs.
import { openResponse, readBody } from './media/http-get.js'


// Rendered as a banner after a submission that carried neither a file nor a
// source URL, so an ignored form is visibly ignored.
const EMPTY_SUBMISSION_NOTICE = 'Nothing was archived: attach a video file or paste a source URL first.'
const EMPTY_SUBMISSION_QUERY = 'notice=empty-submission'

function buildArchiveForm(get) {
  return {
    url: get('url') || '',
    invidiousInstance: get('invidiousInstance') || '',
    channelName: get('channelName') || 'Anonymous Archive',
    title: get('title') || '',
    description: get('description') || '',
    publish: get('publish') !== 'false',
    sourceType: get('sourceType') || '',
    sourceUrl: get('sourceUrl') || '',
    sourceVideoId: get('sourceVideoId') || '',
    tmdbType: get('tmdbType') || '',
    tmdbId: get('tmdbId') || '',
    tmdbSeason: get('tmdbSeason') || '',
    tmdbEpisode: get('tmdbEpisode') || '',
    tmdbPosterPath: get('tmdbPosterPath') || '',
    tmdbTitle: get('tmdbTitle') || '',
    tmdbYear: get('tmdbYear') || '',
    // A consumer cannot look a title up, so whatever the match resolved has to
    // travel with the job or it never reaches the claim.
    tmdbOverview: get('tmdbOverview') || '',
    tmdbRuntime: get('tmdbRuntime') || '',
    tmdbGenres: get('tmdbGenres') || ''
  }
}

// Preserve raw form fields for the browser submission parser.
function formFields(params) {
  const fields = {}
  for (const [key, value] of params) fields[key] = value
  return fields
}


function parseCreatorForm(body) {
  const params = new URLSearchParams(body)
  return {
    url: params.get('url') || '',
    label: params.get('label') || '',
    publish: params.get('publish') !== 'false'
  }
}

function parseTmdbForm(body) {
  const params = new URLSearchParams(body)
  const apiKey = (params.get('apiKey') || '').trim()
  return {
    // A blank key field means "keep the stored key" — the form placeholder
    // advertises exactly that ("•••••••• (set)"). Omitting the property makes
    // setTmdbSettings skip the key write; the enable checkbox stays authoritative.
    ...(apiKey ? { apiKey } : {}),
    enabled: params.get('enabled') === 'true' || params.get('enabled') === 'on'
  }
}

function parseClientForm(body) {
  const params = new URLSearchParams(body)
  return {
    key: params.get('key') || '',
    label: params.get('label') || ''
  }
}

async function collectBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function createDefaultServer(handler) {
  return createServer(handler)
}

async function sha256File(filePath) {
  const state = b4a.alloc(sodium.crypto_hash_sha256_STATEBYTES)
  sodium.crypto_hash_sha256_init(state)
  for await (const chunk of createReadStream(filePath)) sodium.crypto_hash_sha256_update(state, chunk)
  const digest = b4a.alloc(32)
  sodium.crypto_hash_sha256_final(state, digest)
  return b4a.toString(digest, 'hex')
}

function ingestContainer(filePath, mimeType) {
  const byMime = String(mimeType || '').toLowerCase()
  if (byMime.includes('matroska')) return 'mkv'
  if (byMime.includes('webm')) return 'webm'
  if (byMime.includes('mp4')) return 'mp4'
  const extension = basename(filePath).split('.').pop()?.toLowerCase()
  return /^[a-z0-9][a-z0-9._+-]{0,63}$/.test(extension || '') ? extension : 'binary'
}

// What the relay answers with before its store is open.
//
// Everything the console reads — the job store, the catalog, the media graph —
// lives behind the universal backend, and bringing that up walks the whole
// store: the media-graph rebuild, the publication-v1 migration and seed-pin
// registration all run before it hands back a context. On a large store that
// takes minutes and can stall indefinitely on a core waiting for a peer. A
// socket opened only afterwards leaves an operator with a refused connection and
// no way to tell a warming relay from a wedged one — observed on a 46 GB relay
// whose P2P side was up with three peers while its console port never opened.
//

function isLoopbackHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
}
// So the socket is bound first and answers from the start, and the console
// adopts it once the store-dependent side exists.
const WARMING_NOTICE = 'The relay is starting. Its storage and verified media view are still opening, so the console is not answering yet.'

function warmingPage() {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>PearTube relay — starting</title><meta http-equiv="refresh" content="5"></head>
<body>
<h1>PearTube relay is starting</h1>
<p>${WARMING_NOTICE}</p>
<p>This page reloads every five seconds and becomes the archive console as soon as the relay is ready.</p>
</body>
</html>
`
}


export function createArchiveHttpSurface({
  host = '127.0.0.1',
  port = 8174,
  logger = null,
  serverFactory = createDefaultServer,
  now = Date.now
} = {}) {
  const createdAt = now()
  let listening = null
  let closed = false
  let boundPort = Number(port)

  function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body, null, 2))
  }


  function warmingHandler(req, res) {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { ok: true, ready: false, waitingFor: 'relay-storage' })
      return
    }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/ui' || req.url.startsWith('/?'))) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(warmingPage())
      return
    }

    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(`${WARMING_NOTICE}\n`)
  }

  let handler = warmingHandler
  const server = serverFactory((req, res) => handler(req, res))

  return {
    server,
    host,
    get port() { return boundPort },
    get adopted() { return handler !== warmingHandler },
    // How long the surface answered as a warming relay, which is what tells an
    // operator "still opening the store" from "stuck".
    warmupMs() { return now() - createdAt },
    adopt(next) {
      if (typeof next !== 'function') throw new Error('archive http surface requires a request handler')
      handler = next
    },
    // Memoized rather than flagged: whoever calls this second — the service, a
    // console adopting the surface, a test — must get the bound port, not an
    // early return while the first bind is still in flight.
    listen() {
      if (!listening) {
        listening = (async () => {
          await new Promise((resolve) => server.listen(Number(port), host, resolve))
          boundPort = server.address?.()?.port || Number(port)
          logger?.archive?.info?.('Archive WebUI bound before the relay store is open', { host, port: boundPort })
          return boundPort
        })()
      }
      return listening
    },
    async close() {
      if (closed) return
      closed = true
      if (!listening) return
      await listening.catch(() => {})
      await new Promise((resolve) => server.close(resolve))
    }
  }
}

const CANDIDATE_REF_PATTERN = /^[A-Za-z0-9_-]{43}$/

function normalizeTmdbEpisodePart(value) {
  const n = Number(value || 0)
  return Number.isFinite(n) && n > 0 ? n : null
}

function tmdbKey(type, id, season = null, episode = null) {
  if (!type || !id) return null
  const normalizedType = type === 'tv' ? 'tv' : 'movie'
  const base = `${normalizedType}:${id}`
  const normalizedSeason = normalizeTmdbEpisodePart(season)
  const normalizedEpisode = normalizeTmdbEpisodePart(episode)
  return normalizedType === 'tv' && normalizedSeason && normalizedEpisode
    ? `${base}:s${normalizedSeason}:e${normalizedEpisode}`
    : base
}

function tmdbKeyFromDiscoverItem(item = {}) {
  return tmdbKey(item.type, item.tmdbId, item.season, item.episode)
}

function tmdbKeyFromVerifiedSource(source = {}) {
  const coordinates = source.mediaCoordinates || source
  return tmdbKey(
    coordinates.contentKind === 'episode' ? 'tv' : coordinates.contentKind,
    coordinates.mediaId,
    coordinates.seasonNumber,
    coordinates.episodeNumber
  )
}

export function buildTmdbNetworkIndex(catalogItems = []) {
  const index = new Map()
  for (const item of catalogItems || []) {
    for (const source of item?.sources || []) {
      const key = tmdbKeyFromVerifiedSource(source)
      if (!key) continue
      const existing = index.get(key) || { status: 'missing', count: 0, seeded: 0, videos: [], seen: new Set() }
      const sourceKey = `${source.publicationId || ''}:${source.renditionId || ''}:${key}`
      if (existing.seen.has(sourceKey)) continue
      existing.seen.add(sourceKey)
      const candidateRef = CANDIDATE_REF_PATTERN.test(source.candidateRef || '') ? source.candidateRef : null
      const playable = candidateRef !== null || source.availability === 'playable' || source.byteAvailability === 'playable'
      existing.count += 1
      if (playable) existing.seeded += 1
      existing.status = playable || existing.seeded > 0 ? 'seeding' : 'in-network'
      existing.videos.push({
        id: source.publicationId || null,
        title: item.title || null,
        candidateRef,
        playable
      })
      index.set(key, existing)
    }
  }
  return index
}

export function annotateTmdbDiscoverItems(items = [], networkIndex = new Map()) {
  return (items || []).map((item) => {
    const found = networkIndex.get(tmdbKeyFromDiscoverItem(item))
    return {
      ...item,
      networkStatus: found?.status || 'missing',
      networkCopies: found?.count || 0,
      seededCopies: found?.seeded || 0,
      networkVideos: found?.videos || []
    }
  })
}

function reserveAdjustedHeadroom(snapshot, reservedBytes) {
  const reserved = Number.isFinite(reservedBytes) && reservedBytes > 0 ? Math.floor(reservedBytes) : 0
  if (reserved <= 0) return snapshot
  if (Number.isFinite(snapshot)) return Math.max(0, Math.floor(snapshot) - reserved)
  if (!snapshot || typeof snapshot !== 'object') return snapshot
  const storage = Number.isFinite(snapshot.storage) ? Math.max(0, Math.floor(snapshot.storage) - reserved) : snapshot.storage
  if (snapshot.sharedVolume === false) return { ...snapshot, storage }
  return {
    ...snapshot,
    tmp: Number.isFinite(snapshot.tmp) ? Math.max(0, Math.floor(snapshot.tmp) - reserved) : snapshot.tmp,
    storage
  }
}

// The shelf a viewer reads, as opposed to the operator sections below it.
//
// A relay that has been running for a while holds more titles than anybody
// scrolls through, and this list is rendered inline into the home page, so the
// shelf is capped: past the first screens the cost is real and the value is
// zero.
const LIBRARY_LIMIT = 60

// The verified query contract caps one page at 50, so the shelf fills its own
// bounded limit by paging rather than asking for unbounded inventory.
const CATALOG_PAGE_LIMIT = 50

// An entityId is a media-graph digest. The poster route takes one straight off
// a URL path, so it is character-checked and bounded before it is used for
// anything — it only ever selects which artwork the media graph resolves, and
// this pattern is what keeps it from ever being anything else.
const ENTITY_ID_PATTERN = /^[0-9a-f]{16,128}$/
const POSTER_ROUTE_PREFIX = '/poster/'

// A cover is a small image. Something larger is not one, and buffering it would
// stall the console for no viewer benefit.
const MAX_POSTER_BYTES = 8 * 1024 * 1024
const POSTER_READ_TIMEOUT_MS = 5000

function posterEntityId(url) {
  let pathname
  try {
    pathname = new URL(url, 'http://relay.local').pathname
  } catch {
    return null
  }
  if (!pathname.startsWith(POSTER_ROUTE_PREFIX)) return null
  // Deliberately not decoded first: a hex digest carries no escapes, so an
  // encoded traversal or separator fails the pattern instead of being unwrapped
  // into something that passes it.
  const raw = pathname.slice(POSTER_ROUTE_PREFIX.length)
  return ENTITY_ID_PATTERN.test(raw) ? raw : null
}

// A publication's video bytes as this relay actually holds them. The catalogue
// reports which publications exist but not how large they are, and the signed
// manifest is the only local answer; the cover rendition is skipped because a
// 40 KB poster is not the size a viewer is asking about.
function publicationBytes(manifest) {
  const rendition = (manifest?.body?.renditions || []).find((candidate) => (
    candidate?.renditionId &&
    candidate.blocked !== true &&
    candidate.superseded !== true &&
    !isArtworkRendition(candidate)
  ))
  const bytes = Number(rendition?.core?.byteLength)
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0
}

function jobRecency(job) {
  const stamp = Number(job?.completedAt || job?.updatedAt || job?.createdAt || 0)
  return Number.isFinite(stamp) && stamp > 0 ? stamp : 0
}

// An archive job is keyed by the work it was asked for — `movie:27205`,
// `show:71728:s2:e4` — not by the media-graph entity its publication later
// lands on. The provider id inside that hint is what a catalogue source carries
// as `mediaId`, which is what ties the two together; the title is the fallback
// for jobs seeded from a bare URL, which never had a hint.
function entityHintMediaId(hint) {
  if (typeof hint !== 'string') return null
  const mediaId = hint.split(':')[1]
  return mediaId || null
}

function libraryTitleKey(title) {
  return typeof title === 'string' ? title.trim().toLowerCase() : ''
}

// Which of several matching jobs describes the title. An in-flight job outranks
// a failure, a failure outranks a finished one, and among equals the newest
// wins: the shelf should say "adding" while a retry is running rather than
// report the attempt it replaced.
const JOB_INTEREST = { running: 3, queued: 3, failed: 2 }

function preferJob(current, candidate) {
  if (!current) return candidate
  const currentRank = JOB_INTEREST[current.status] || 1
  const candidateRank = JOB_INTEREST[candidate.status] || 1
  if (candidateRank !== currentRank) return candidateRank > currentRank ? candidate : current
  return jobRecency(candidate) >= jobRecency(current) ? candidate : current
}

function indexJobsForLibrary(jobs = []) {
  const byMediaId = new Map()
  const byTitle = new Map()
  for (const job of jobs) {
    const mediaId = entityHintMediaId(job?.entityHint)
    if (mediaId) byMediaId.set(mediaId, preferJob(byMediaId.get(mediaId), job))
    const title = libraryTitleKey(job?.title)
    if (title) byTitle.set(title, preferJob(byTitle.get(title), job))
  }
  return { byMediaId, byTitle }
}

function libraryJobFor(item, { byMediaId, byTitle }) {
  for (const source of item?.sources || []) {
    const mediaId = source?.mediaCoordinates?.mediaId
    const job = mediaId == null ? null : byMediaId.get(String(mediaId))
    if (job) return job
  }
  return byTitle.get(libraryTitleKey(item?.title)) || null
}

function mirroredLabel(devices) {
  return devices === 1 ? 'Backed up on 1 other device' : `Backed up on ${devices} other devices`
}

// How safe a title is, said to somebody who has never heard of a swarm, a peer
// or a pledge. archive-ui.js renders `label` verbatim, so this vocabulary lives
// here and nowhere else.
function libraryStatus({ job, freshArchivists, sizeBytes }) {
  if (job?.status === 'queued' || job?.status === 'running') {
    return {
      state: 'publishing',
      label: 'Adding to your library…',
      detail: 'The file is still being copied in. It will be playable once that finishes.'
    }
  }
  // A failed job only reads as a failure while the title has no bytes here. A
  // retry that worked leaves the failed attempt behind it, and reporting that
  // as broken would contradict the copy the viewer can already play.
  if (job?.status === 'failed' && sizeBytes <= 0) {
    return {
      state: 'failed',
      label: 'Could not be added',
      detail: 'The last attempt to add this title did not finish. Try adding it again.'
    }
  }
  if (freshArchivists > 0) {
    return {
      state: 'mirrored',
      label: mirroredLabel(freshArchivists),
      detail: 'Another device is holding a copy, so this title survives even if this one does not.'
    }
  }
  if (sizeBytes > 0) {
    return {
      state: 'stored',
      label: 'Saved on this relay',
      detail: 'The whole file is on this machine and ready to play.'
    }
  }
  return {
    state: 'waiting',
    label: 'Waiting for a backup',
    detail: 'This title is listed, but no copy of the file has arrived yet.'
  }
}

export async function createArchiveConsole({
  service,
  downloader,
  host = '127.0.0.1',
  port = 8174,
  logger = null,
  uploadDir = null,
  uploadStorageHeadroom = null,
  httpSurface = null,
  serverFactory = createDefaultServer,
  storageReservations = null
}) {
  if (!service?.runtime?.ctx?.metaDb) throw new Error('archive console requires a relay service runtime')
  if (typeof service.submitArchiveIngestJob !== 'function' ||
      typeof service.listIngestJobs !== 'function' ||
      typeof service.getVerifiedMediaCatalog !== 'function') {
    throw new Error('archive console requires the verified v2 service')
  }
  const localPlaybackAllowed = isLoopbackHost(host)
  const copyReservations = storageReservations || { bytes: 0 }
  const uploadReservations = new Map()
  const releaseUploadReservation = (reservation) => {
    if (!reservation || reservation.released) return
    reservation.released = true
    copyReservations.bytes = Math.max(0, Math.floor(Number(copyReservations.bytes) || 0) - reservation.bytes)
    reservation.bytes = 0
    copyReservations.invalidate?.()
  }
  const releaseUploadReservationByPath = (uploadPath) => {
    const release = uploadReservations.get(uploadPath)
    if (!release) return
    uploadReservations.delete(uploadPath)
    release()
  }
  const reserveUploadBytes = (reservation, bytes) => {
    const size = Math.max(0, Math.floor(Number(bytes) || 0))
    if (size <= 0) return
    reservation.bytes += size
    copyReservations.bytes = Math.max(0, Math.floor(Number(copyReservations.bytes) || 0)) + size
  }
  const releaseUploadBytes = (reservation, bytes) => {
    const size = Math.max(0, Math.min(reservation.bytes, Math.floor(Number(bytes) || 0)))
    if (size <= 0) return
    reservation.bytes -= size
    copyReservations.bytes = Math.max(0, Math.floor(Number(copyReservations.bytes) || 0) - size)
  }
  const stateForUi = state => ['acquiring', 'verifying', 'publishing'].includes(state) ? 'running' : state
  const entityHintFor = context => context?.kind === 'episode'
    ? `show:${context.seriesIdentifier}:s${context.seasonNumber}:e${context.episodeNumber}`
    : context?.kind === 'movie' ? `movie:${context.identifier}` : null
  const listJobs = async () => (await service.listIngestJobs()).map(job => ({
    id: job.jobId,
    jobId: job.jobId,
    status: stateForUi(job.state),
    state: job.state,
    title: job.title,
    error: job.errorCode,
    errorCode: job.errorCode,
    entityHint: entityHintFor(job.mediaContext),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.state === 'completed' ? job.updatedAt : null
  }))
  const store = { listJobs }

  // Read an archive submission as a browser file upload (multipart/form-data,
  // streamed to disk), a machine API JSON body, or a URL-encoded form. Returns
  // the normalized archive form plus an optional uploaded file descriptor.
  async function readArchiveSubmission(req) {
    const contentType = req.headers?.['content-type'] || req.headers?.['Content-Type'] || ''
    if (/multipart\/form-data/i.test(contentType)) {
      const boundary = parseBoundary(contentType)
      if (!boundary) throw new Error('multipart upload is missing its boundary')
      if (!uploadDir) throw new Error('relay archive upload directory is not configured')
      const reservation = { bytes: 0, released: false }
      const storageHeadroom = typeof uploadStorageHeadroom === 'function'
        ? () => reserveAdjustedHeadroom(uploadStorageHeadroom(), Math.max(0, Math.floor(Number(copyReservations.bytes) || 0) - reservation.bytes))
        : null
      const { fields, file } = await receiveMultipartUpload(req, {
        boundary,
        uploadDir,
        storageHeadroom,
        reserveStorageBytes: (bytes) => reserveUploadBytes(reservation, bytes),
        releaseStorageBytes: (bytes) => releaseUploadBytes(reservation, bytes)
      })
      if (file?.path && typeof file.releaseStorageReservation === 'function') {
        const release = file.releaseStorageReservation
        file.releaseStorageReservation = () => {
          uploadReservations.delete(file.path)
          release()
        }
        uploadReservations.set(file.path, file.releaseStorageReservation)
      }
      return { form: buildArchiveForm((key) => fields[key] ?? ''), file, fields }
    }
    const params = new URLSearchParams(await collectBody(req))
    return { form: buildArchiveForm((key) => params.get(key) || ''), file: null, fields: formFields(params) }
  }


  function discardUploadFile(file) {
    if (!file) return
    try {
      if (file.dir) rmSync(file.dir, { recursive: true, force: true })
    } catch (err) {
      logger?.archive?.warn?.('Discarding a rejected upload failed', { error: err?.message || String(err) })
    } finally {
      if (typeof file.releaseStorageReservation === 'function') {
        try { file.releaseStorageReservation() } catch { /* Cleanup remains best effort. */ }
      } else if (file.path) {
        releaseUploadReservationByPath(file.path)
      }
    }
  }

  async function enqueueCatalogSubmission(form, file) {
    let staged = file
    let accepted = false
    try {
      if (!staged) {
        const downloaded = await downloader.download(form)
        staged = {
          path: downloaded.filePath,
          relativePath: relative(resolve(uploadDir), resolve(downloaded.filePath)).replaceAll('\\', '/'),
          filename: basename(downloaded.filePath),
          mimeType: downloaded.mimeType || 'application/octet-stream',
          size: statSync(downloaded.filePath).size,
          dir: dirname(downloaded.filePath),
          releaseStorageReservation: downloaded.releaseStorageReservation
        }
      }
      const relativePath = staged.relativePath || relative(resolve(uploadDir), resolve(staged.path)).replaceAll('\\', '/')
      if (!relativePath || relativePath === '..' || relativePath.startsWith('../') || relativePath.startsWith('/')) {
        throw new Error('archive upload is outside the ingest spool root')
      }
      const byteLength = Number(staged.size || statSync(staged.path).size)
      const sha256 = await sha256File(staged.path)
      const tmdbId = String(form.tmdbId || '').trim()
      const episode = form.tmdbType === 'tv' && tmdbId && Number(form.tmdbSeason) > 0 && Number(form.tmdbEpisode) > 0
      const mediaContext = episode
        ? {
            kind: 'episode',
            seriesNamespace: 'tmdb',
            seriesIdentifier: tmdbId,
            seasonNumber: Number(form.tmdbSeason),
            episodeNumber: Number(form.tmdbEpisode)
          }
        : {
            kind: 'movie',
            namespace: tmdbId ? 'tmdb' : 'peartube-ui',
            identifier: tmdbId || sha256
          }
      const mimeType = staged.mimeType || 'application/octet-stream'
      const lease = {
        accept(spool) {
          if (spool.filePath !== staged.path ||
              spool.relativePath !== relativePath ||
              spool.byteLength !== byteLength) return false
          accepted = true
          if (typeof staged.releaseStorageReservation === 'function') staged.releaseStorageReservation()
          else releaseUploadReservationByPath(staged.path)
          return true
        }
      }
      const job = await service.submitArchiveIngestJob({
        idempotencyKey: `ui:${tmdbId || 'media'}:${sha256.slice(0, 32)}`,
        request: {
          retentionClass: 'archive-pin',
          mediaContext,
          measuredFacts: {
            byteLength,
            container: ingestContainer(staged.path, mimeType),
            title: form.title || form.tmdbTitle || staged.filename || 'Uploaded video'
          },
          expected: { byteLength, sha256 }
        },
        spool: {
          path: relativePath,
          complete: true,
          mimeType,
          byteLength,
          sha256
        }
      }, { ingestSpoolLease: lease })
      if (!accepted) discardUploadFile(staged)
      return {
        id: job.jobId,
        jobId: job.jobId,
        status: stateForUi(job.state),
        title: form.title || form.tmdbTitle || staged.filename || null,
        entityHint: entityHintFor(mediaContext)
      }
    } catch (err) {
      if (!accepted) discardUploadFile(staged)
      throw err
    }
  }
  const manager = { enqueue: enqueueCatalogSubmission }


  function creatorsView() {
    const creators = service.creators?.getCreators?.() || []
    return [...creators].sort((a, b) => (Number(b.videosUnseeded || 0) - Number(a.videosUnseeded || 0)) || (Number(b.videosArchived || 0) - Number(a.videosArchived || 0)))
  }

  function tmdbView() {
    const opts = service.settings
      ? resolveTmdbOptions(service.config || {}, service.settings)
      : { enabled: false, apiKey: '' }
    return { enabled: Boolean(opts.enabled), hasKey: Boolean(opts.apiKey) }
  }

  async function readVerifiedCatalog() {
    const items = []
    let cursor = null
    while (items.length < LIBRARY_LIMIT) {
      const request = { limit: Math.min(CATALOG_PAGE_LIMIT, LIBRARY_LIMIT - items.length), limitProvided: true }
      if (cursor) request.cursor = cursor
      const page = await service.getVerifiedMediaCatalog(request)
      if (page?.success !== true || !Array.isArray(page.items) || page.items.length === 0) break
      items.push(...page.items)
      cursor = page.nextCursor || null
      if (!cursor) break
    }
    return items
  }

  async function discoverView({ query = '', type = 'movie', page = 1 } = {}, catalogItems = []) {
    const items = typeof service.discoverTmdb === 'function'
      ? await service.discoverTmdb({ query, type, page }).catch(() => [])
      : []
    return {
      query,
      type: type === 'tv' ? 'tv' : 'movie',
      items: annotateTmdbDiscoverItems(items, buildTmdbNetworkIndex(catalogItems))
    }
  }

  // The viewer-facing shelf is built only from the service's verified query
  // view. Jobs and mirror proofs add local status, but never invent a title or
  // a playback target.
  async function libraryView(items, jobs = []) {
    try {
      if (!Array.isArray(items) || items.length === 0) return []

      const mirrors = new Map()
      for (const request of service.getArchiveMirrorRequests?.() || []) {
        if (!request?.publicationId) continue
        mirrors.set(String(request.publicationId), request)
      }
      const jobIndex = indexJobsForLibrary(jobs)
      const manifests = new Map()
      const publicationIds = new Set()
      for (const item of items) {
        for (const source of item?.sources || []) {
          if (source?.publicationId) publicationIds.add(String(source.publicationId))
        }
      }
      await Promise.all([...publicationIds].map(async publicationId => {
        const manifest = await service.getVerifiedManifest?.(publicationId)
        if (manifest) manifests.set(publicationId, manifest)
      }))

      // The verified view is ordered by its durable query key and carries no
      // display timestamp. Local jobs and mirror proofs provide recency when
      // available; titles without either retain verified query order.
      const ranked = items.map((item, order) => {
        const job = libraryJobFor(item, jobIndex)
        let sizeBytes = 0
        let freshArchivists = 0
        let recency = jobRecency(job)
        // A series entity collapses every episode this relay holds, so the
        // seasons and episodes are counted from the coordinates the publisher
        // signed rather than from how many publications happen to be here. Two
        // uploads of the same episode are one episode; an episode with no
        // ordinals is still held, so it is counted without a season.
        const seasons = new Map()
        let looseEpisodes = 0
        for (const source of item?.sources || []) {
          if (!source?.publicationId) continue
          sizeBytes += publicationBytes(manifests.get(String(source.publicationId)))
          const coordinates = source.mediaCoordinates || {}
          if (coordinates.contentKind === 'episode') {
            const season = Number(coordinates.seasonNumber)
            const episode = Number(coordinates.episodeNumber)
            if (Number.isSafeInteger(season) && season > 0 && Number.isSafeInteger(episode) && episode > 0) {
              if (!seasons.has(season)) seasons.set(season, new Set())
              seasons.get(season).add(episode)
            } else {
              looseEpisodes++
            }
          }
          const mirror = mirrors.get(String(source.publicationId))
          if (!mirror) continue
          // Max, not sum: one archivist holding three episodes of a series is
          // one other device, not three.
          freshArchivists = Math.max(freshArchivists, Number(mirror.freshArchivists) || 0)
          recency = Math.max(recency, Number(mirror.requestedAt) || 0)
        }
        const episodeCount = [...seasons.values()].reduce((sum, set) => sum + set.size, 0) + looseEpisodes
        return {
          order,
          recency,
          entry: {
            entityId: String(item?.entityId || ''),
            kind: item?.entityKind || 'unknown',
            title: item?.title || 'Untitled',
            channelName: item?.subtitle || null,
            year: Number.isSafeInteger(item?.releaseYear) ? item.releaseYear : null,
            runtimeMinutes: Number.isSafeInteger(item?.runtimeMinutes) ? item.runtimeMinutes : null,
            genres: Array.isArray(item?.genres) ? item.genres : [],
            overview: typeof item?.overview === 'string' && item.overview ? item.overview : null,
            // What the publisher signed a cover for. Whether its bytes have
            // replicated here is what /poster/<entityId> answers, and that
            // resolve can block on a transfer, so it is not run once per title
            // while a page render waits on it.
            hasPoster: Boolean(item?.posterBlobId || item?.posterUrl),
            sizeBytes: sizeBytes > 0 ? sizeBytes : null,
            // What this relay actually holds of a show, counted from signed
            // coordinates: which seasons, and how many distinct episodes. It
            // is deliberately not "how many episodes the show has" - nothing
            // here knows that, and implying it would be a guess.
            seasonNumbers: [...seasons.keys()].sort((left, right) => left - right),
            episodeCount,
            candidateRef: localPlaybackAllowed
              ? (CANDIDATE_REF_PATTERN.test(item?.candidateRef || '')
                  ? item.candidateRef
                  : (item?.sources || []).find(source => CANDIDATE_REF_PATTERN.test(source?.candidateRef || ''))?.candidateRef || null)
              : null,
            status: libraryStatus({ job, freshArchivists, sizeBytes })
          }
        }
      })
      ranked.sort((left, right) => (right.recency - left.recency) || (left.order - right.order))
      return ranked.map((row) => row.entry)
    } catch (err) {
      logger?.archive?.warn?.('Building the relay library view failed', { error: err?.message || String(err) })
      return []
    }
  }

  // Cover bytes for one shelf entry, read back off the relay's own loopback
  // blob server. The URL is the runtime's own — the caller's entityId only ever
  // chooses which artwork the media graph resolves, and reaches no path, no
  // command and no origin this relay did not pick.
  async function readEntityPoster(entityId) {
    try {
      const artwork = await service.getVerifiedEntityArtwork?.({ entityId })
      if (artwork?.success !== true || artwork.exists !== true || typeof artwork.url !== 'string') return null
      const { res } = await openResponse(artwork.url, {
        timeoutMs: POSTER_READ_TIMEOUT_MS,
        timeoutMessage: 'poster read timed out'
      })
      if ((res.statusCode || 0) !== 200) {
        res.destroy?.()
        return null
      }
      const upstream = res.headers?.['content-type']
      return {
        contentType: typeof upstream === 'string' && upstream.startsWith('image/') ? upstream : 'image/jpeg',
        body: await readBody(res, { maxBytes: MAX_POSTER_BYTES })
      }
    } catch (err) {
      logger?.archive?.warn?.('Reading a library poster failed', { error: err?.message || String(err) })
      return null
    }
  }

  async function model(discoverParams = {}) {
    const status = service.getStatus?.() || {}
    const jobs = await store.listJobs()
    const catalogItems = await readVerifiedCatalog().catch((err) => {
      logger?.archive?.warn?.('Reading the verified media catalog failed', { error: err?.message || String(err) })
      return []
    })
    return {
      status,
      jobs,
      library: await libraryView(catalogItems, jobs),
      creators: creatorsView(),
      unseededTargets: service.getCreatorTargets?.({ limit: 25 }) || status.creators?.unseededTargets || [],
      tmdb: tmdbView(),
      s3: service.s3 || {
        configured: false,
        endpoint: '',
        bucket: '',
        region: '',
        prefix: '',
        offload: { enabled: false, windowBytes: 0, restored: 0, residentBytes: 0 }
      },
      discover: await discoverView(discoverParams, catalogItems),
      trustedClients: service.getTrustedClients?.() || [],
      link: service.getLinkDescriptor?.() || null
    }
  }

  function playbackLocation(req, opened) {
    if (opened?.transport !== 'tcp' ||
        !Number.isSafeInteger(opened.port) ||
        opened.port < 1 ||
        typeof opened.url !== 'string' ||
        !opened.url.startsWith('/api/v2/stream/')) return null
    let host = opened.host
    if (host === '0.0.0.0' || host === '::' || !host) {
      try {
        host = new URL(`http://${req.headers?.host || ''}`).hostname
      } catch {
        return null
      }
    }
    const authority = host.includes(':') ? `[${host}]:${opened.port}` : `${host}:${opened.port}`
    return new URL(opened.url, `http://${authority}`).href
  }

  function playbackCandidateRef(url) {
    let pathname
    try {
      pathname = new URL(url, 'http://relay.local').pathname
    } catch {
      return null
    }
    if (!pathname.startsWith('/play/')) return null
    try {
      const candidateRef = decodeURIComponent(pathname.slice('/play/'.length))
      return CANDIDATE_REF_PATTERN.test(candidateRef) ? candidateRef : null
    } catch {
      return null
    }
  }


  const handleRequest = async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, ready: true }))
        return
      }

      if (req.method === 'GET') {
        const parsed = new URL(req.url, 'http://relay.local')
        if (parsed.pathname === '/' || parsed.pathname === '/ui') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          const home = await model({
            query: parsed.searchParams.get('q') || '',
            type: parsed.searchParams.get('type') || 'movie',
            page: parsed.searchParams.get('page') || '1'
          })
          if (parsed.searchParams.get('notice') === 'empty-submission') home.notice = EMPTY_SUBMISSION_NOTICE
          res.end(renderArchiveWebHome(home))
          return
        }

        if (parsed.pathname.startsWith('/play/')) {
          if (!localPlaybackAllowed) {
            res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
            res.end('playback requires a loopback archive console')
            return
          }
          const candidateRef = playbackCandidateRef(req.url)
          const opened = candidateRef
            ? await service.openVerifiedPlayback?.(candidateRef).catch(() => null)
            : null
          const location = playbackLocation(req, opened)
          if (!location) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
            res.end('playback unavailable')
            return
          }
          res.writeHead(303, { location, 'cache-control': 'no-store' })
          res.end()
          return
        }
      }

      // A cover for one verified shelf entry. Every way of not having one
      // answers 404 so a missing thumbnail cannot make the library look broken.
      // Every way of not having a cover answers 404: an id that is not one, no
      // artwork on the claim, bytes that have not replicated yet, a blob server
      // that is not up. A 500 would paint the whole library as broken because
      // one thumbnail is missing.
      if (req.method === 'GET' && req.url.startsWith(POSTER_ROUTE_PREFIX)) {
        const entityId = posterEntityId(req.url)
        const poster = entityId ? await readEntityPoster(entityId) : null
        if (!poster) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('no cover')
          return
        }
        res.writeHead(200, {
          'content-type': poster.contentType,
          'content-length': String(poster.body.byteLength),
          // Private: the cover is only meaningful behind this relay's console,
          // and five minutes is long enough that a page reload does not re-read
          // every blob while still letting a newly arrived cover appear.
          'cache-control': 'private, max-age=300'
        })
        res.end(poster.body)
        return
      }

      if (req.method === 'GET' && req.url === '/tui') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(renderArchiveTui(await model()))
        return
      }

      if (req.method === 'GET' && req.url === '/jobs') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jobs: await store.listJobs() }, null, 2))
        return
      }

      if (req.method === 'GET' && req.url === '/creators.json') {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store'
        })
        res.end(JSON.stringify({
          schema: 'peartube.relayCreators',
          version: 1,
          updatedAt: Date.now(),
          creators: creatorsView()
        }, null, 2))
        return
      }

      if (req.method === 'GET' && req.url === '/unseeded.json') {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store'
        })
        res.end(JSON.stringify({
          schema: 'peartube.relayUnseededTargets',
          version: 1,
          updatedAt: Date.now(),
          targets: service.getCreatorTargets?.({ limit: 50 }) || []
        }, null, 2))
        return
      }

      if (req.method === 'GET' && req.url === '/clients.json') {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store'
        })
        res.end(JSON.stringify({
          schema: 'peartube.relayTrustedClients',
          version: 1,
          updatedAt: Date.now(),
          clients: service.getTrustedClients?.() || []
        }, null, 2))
        return
      }

      if (req.method === 'GET' && req.url === '/link.json') {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store'
        })
        res.end(JSON.stringify(service.getLinkDescriptor?.() || { schema: 'peartube.relayLink', version: 2, seedPin: { enabled: false, authorizedClients: 0 } }, null, 2))
        return
      }

      if (req.method === 'GET' && req.url.startsWith('/discover.json')) {
        const parsed = new URL(req.url, 'http://relay.local')
        const catalogItems = await readVerifiedCatalog()
        const discover = await discoverView({
          query: parsed.searchParams.get('q') || '',
          type: parsed.searchParams.get('type') || 'movie',
          page: parsed.searchParams.get('page') || '1'
        }, catalogItems)
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store'
        })
        res.end(JSON.stringify({
          schema: 'peartube.relayDiscover',
          version: 1,
          updatedAt: Date.now(),
          ...discover
        }, null, 2))
        return
      }

      if (req.method === 'GET' && req.url.startsWith('/discover/seasons.json')) {
        const parsed = new URL(req.url, 'http://relay.local')
        const seasons = typeof service.discoverTmdbSeasons === 'function'
          ? await service.discoverTmdbSeasons({ tmdbId: parsed.searchParams.get('tmdbId') || '' }).catch(() => [])
          : []
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store'
        })
        res.end(JSON.stringify({ schema: 'peartube.relayTmdbSeasons', version: 1, seasons }, null, 2))
        return
      }

      if (req.method === 'GET' && req.url.startsWith('/discover/episodes.json')) {
        const parsed = new URL(req.url, 'http://relay.local')
        const episodes = typeof service.discoverTmdbEpisodes === 'function'
          ? await service.discoverTmdbEpisodes({
            tmdbId: parsed.searchParams.get('tmdbId') || '',
            season: parsed.searchParams.get('season') || ''
          }).catch(() => [])
          : []
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store'
        })
        res.end(JSON.stringify({ schema: 'peartube.relayTmdbEpisodes', version: 1, episodes }, null, 2))
        return
      }


      if (req.method === 'POST' && req.url === '/discover/archive') {
        const { form, file } = await readArchiveSubmission(req)
        if (!file && !form.url) {
          // A submission with neither a file nor a URL enqueues nothing. Saying
          // so beats a bare redirect that looks exactly like success and leaves
          // the operator waiting for a job that was never created.
          logger?.archive?.warn?.('Archive submission ignored: no file and no source URL')
          res.writeHead(303, { location: `/?${EMPTY_SUBMISSION_QUERY}#discover` })
          res.end()
          return
        }
        await enqueueCatalogSubmission(form, file)
        res.writeHead(303, { location: '/#discover' })
        res.end()
        return
      }

      if (req.method === 'POST' && req.url === '/archive') {
        const { form, file } = await readArchiveSubmission(req)
        if (!file && !form.url) {
          logger?.archive?.warn?.('Archive submission ignored: no file and no source URL')
          res.writeHead(303, { location: `/?${EMPTY_SUBMISSION_QUERY}` })
          res.end()
          return
        }
        await enqueueCatalogSubmission(form, file)
        res.writeHead(303, { location: '/' })
        res.end()
        return
      }

      if (req.method === 'POST' && req.url === '/creators') {
        const form = parseCreatorForm(await collectBody(req))
        if (typeof service.addCreatorSource === 'function') {
          service.addCreatorSource(form).catch((err) => logger?.archive?.error?.('Add creator failed', { error: err?.message || String(err) }))
        }
        res.writeHead(303, { location: '/' })
        res.end()
        return
      }

      if (req.method === 'POST' && req.url === '/settings/tmdb') {
        const form = parseTmdbForm(await collectBody(req))
        if (typeof service.setTmdbSettings === 'function') {
          await service.setTmdbSettings(form)
        }
        res.writeHead(303, { location: '/' })
        res.end()
        return
      }

      if (req.method === 'POST' && req.url === '/clients') {
        const form = parseClientForm(await collectBody(req))
        if (typeof service.authorizeClient === 'function') {
          await service.authorizeClient(form).catch((err) => logger?.archive?.error?.('Authorize client failed', { error: err?.message || String(err) }))
        }
        res.writeHead(303, { location: '/' })
        res.end()
        return
      }

      if (req.method === 'POST' && req.url === '/clients/revoke') {
        const form = parseClientForm(await collectBody(req))
        if (typeof service.revokeClient === 'function') {
          await service.revokeClient(form.key).catch((err) => logger?.archive?.error?.('Revoke client failed', { error: err?.message || String(err) }))
        }
        res.writeHead(303, { location: '/' })
        res.end()
        return
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(err?.message || String(err))
    }
  }

  // Adopt the pre-bound socket, or open one when this console is the only thing
  // serving (tests, and any caller that builds a console on its own).
  const server = httpSurface ? httpSurface.server : await serverFactory(handleRequest)
  const boundPort = () => (httpSurface ? httpSurface.port : Number(port))

  return {
    store,
    manager,
    server,
    async start() {
      // Idempotent on an adopted surface: it is already listening as a warming
      // relay; only adopt the live handler once the v2 ingest service exists.
      if (httpSurface) {
        await httpSurface.listen()
        httpSurface.adopt(handleRequest)
      } else {
        await new Promise((resolve) => server.listen(Number(port), host, resolve))
      }
      logger?.archive?.info?.('Archive WebUI started', httpSurface
        ? { host, port: boundPort(), storeWarmupMs: httpSurface.warmupMs() }
        : { host, port: boundPort() })
      return this
    },
    async close() {
      if (httpSurface) {
        await httpSurface.close()
        return
      }
      await new Promise((resolve) => server.close(resolve))
    }
  }
}
