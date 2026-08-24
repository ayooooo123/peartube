import { createServer } from '#http'
import { existsSync, rmSync, statSync } from '#fs'
import { dirname, relative, resolve, sep } from '#path'
import { isArtworkRendition } from '@peartube/backend/assets'
import { createArchiveJobStore, createArchiveManager } from './archive-manager.js'
import { renderArchiveTui, renderArchiveWebHome } from './archive-ui.js'
import { resolveTmdbOptions } from './settings.js'
import { parseBoundary, receiveMultipartUpload } from './multipart.js'
// The relay's own HTTP client rather than fetch(): Bare ships no global fetch,
// so a fetch() here would be a ReferenceError the moment the relay runs.
import { openResponse, readBody } from './media/http-get.js'
import {
  ARCHIVE_API_PREFIX,
  MAX_JSON_BODY_BYTES,
  archiveApiRoute,
  createArchiveApi,
  createOpenAccessGate,
  isGatedArchiveApiRoute
} from './archive-api.js'


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

// The machine API validates raw submitted fields (contentKind and friends) that
// the archive form does not carry, so both entry points read one parse.
function formFields(params) {
  const fields = {}
  for (const [key, value] of params) fields[key] = value
  return fields
}

// A JSON submission speaks the same field names as the form, so the machine
// API's JSON body and the console's form bodies land in one parse. Scalars are
// stringified because every downstream check reads text, and a number is what a
// typed client naturally sends for tmdbId. Every message here starts with
// "json body" so the API can name the failure as JSON rather than multipart.
function jsonFields(body) {
  let parsed = null
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error('json body is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('json body must be a JSON object')
  }
  const fields = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null || value === undefined) continue
    if (Array.isArray(value)) {
      // tmdbGenres is the list case, and the pipeline reads it as comma-joined
      // text; accepting the array spares every client the join.
      if (value.some((entry) => entry !== null && typeof entry === 'object')) {
        throw new Error(`json body field ${key} must be a scalar or a list of scalars`)
      }
      fields[key] = value.filter((entry) => entry !== null && entry !== undefined).map(String).join(',')
      continue
    }
    if (typeof value === 'object') throw new Error(`json body field ${key} must be a scalar or a list of scalars`)
    fields[key] = String(value)
  }
  return fields
}

function uploadFields(file) {
  if (!file) return {}
  return {
    uploadPath: file.path,
    uploadFilename: file.filename,
    uploadMimeType: file.mimeType,
    uploadSize: file.size
  }
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

// `maxBytes` is opt-in: the console's own form posts are read exactly as they
// always were, and only the machine API's JSON body is bounded.
async function collectBody(req, { maxBytes = 0, kind = 'request' } = {}) {
  return new Promise((resolve, reject) => {
    let body = ''
    let bytes = 0
    req.on('data', (chunk) => {
      if (maxBytes > 0) {
        bytes += chunk?.length ?? 0
        if (bytes > maxBytes) {
          req.destroy?.()
          reject(new Error(`${kind} body exceeds max size of ${maxBytes} bytes`))
          return
        }
      }
      body += String(chunk)
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function createDefaultServer(handler) {
  return createServer(handler)
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
// So the socket is bound first and answers from the start, and the console
// adopts it once the store-dependent side exists.
const WARMING_NOTICE = 'The relay is starting. Its storage and media graph are still opening, so the console and the machine API are not answering yet.'

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

// Which mounted prefix a request target belongs to, read off the request's own
// pathname so this dispatch and the mounted server's own routing agree on what
// the path is. Percent-encodings are left exactly as they arrived — URL#pathname
// decodes none of them, and neither does the companion router — so no request
// can be dispatched to one owner while being routed as if it belonged to the
// other. Only an origin-form target can belong to a mount: absolute-form and
// protocol-relative targets stay with whoever answered them before anything was
// mounted.
function mountedPrefix(mounts, url) {
  const raw = String(url == null ? '/' : url)
  if (!raw.startsWith('/') || raw.startsWith('//')) return null
  let pathname = null
  try {
    pathname = new URL(raw, 'http://relay.local').pathname
  } catch {
    return null
  }
  for (const prefix of mounts.keys()) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return prefix
  }
  return null
}

// The listener a mounted server drives in place of one of its own. Only what a
// mounted server actually calls is here: once/removeListener for the promise it
// wraps around its bind, listen/address for the state it publishes, and
// listening/close for its teardown. Binding, for a mounted server, is taking
// its prefix on the surface's listener and giving it back.
//
// Deliberately no 'connection' event. A server's per-socket timers (a
// first-request deadline, an idle destroy) fire on every socket it is told
// about, and on a shared listener nearly every socket carries requests it never
// sees — the v1 API streams whole videos on one — so a forwarded connection
// would be destroyed mid-response by a deadline meant for a request that never
// arrived. Socket-level exposure does not change by mounting: these are the
// archive listener's sockets, which never had such timers, and the runtime's own
// header and request timeouts still bound an incomplete request.
function createMountedListener({ prefix, requestListener, mounts, address }) {
  const listeners = new Map()
  let mounted = false

  function emit(event, ...args) {
    const handlers = listeners.get(event)
    if (!handlers) return
    listeners.delete(event)
    for (const handler of handlers) handler(...args)
  }

  return {
    get listening() { return mounted },
    address,
    once(event, handler) {
      const handlers = listeners.get(event) || new Set()
      handlers.add(handler)
      listeners.set(event, handlers)
      return this
    },
    removeListener(event, handler) {
      listeners.get(event)?.delete(handler)
      return this
    },
    listen() {
      if (mounted) {
        // Already bound. Answer it anyway: a caller awaiting the event would
        // otherwise wait for one that never comes.
        emit('listening')
        return this
      }
      if (mounts.has(prefix)) {
        emit('error', new Error(`${prefix} is already mounted on the archive HTTP listener`))
        return this
      }
      mounts.set(prefix, requestListener)
      mounted = true
      emit('listening')
      return this
    },
    close(callback) {
      if (mounted && mounts.get(prefix) === requestListener) mounts.delete(prefix)
      mounted = false
      if (typeof callback === 'function') callback()
      return this
    }
  }
}

export function createArchiveHttpSurface({
  host = '127.0.0.1',
  port = 8174,
  apiOpen = false,
  logger = null,
  serverFactory = createDefaultServer,
  now = Date.now
} = {}) {
  const gate = createOpenAccessGate({ bindHost: host, apiOpen })
  const createdAt = now()
  let listening = null
  let closed = false
  let boundPort = Number(port)

  function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body, null, 2))
  }

  function warmingHandler(req, res) {
    const apiPath = archiveApiRoute(req.url)
    if (apiPath !== null) {
      // The gate is decided by the bind, never by readiness: a relay that is
      // still starting must not answer what a started one refuses.
      if (gate.refusal && isGatedArchiveApiRoute(apiPath)) {
        sendJson(res, gate.refusal.status, { error: gate.refusal.error })
        return
      }
      // The same retryable codes the live API answers with while the media graph
      // is unbound, so a client polling the catalog reads 503 and then 200
      // instead of a refused connection.
      const code = apiPath === '/catalog' ? 'CATALOG_UNAVAILABLE' : 'MEDIA_GRAPH_UNAVAILABLE'
      sendJson(res, 503, {
        error: {
          code,
          message: `relay storage is still opening; retry ${ARCHIVE_API_PREFIX}${apiPath === '/' ? '' : apiPath}`,
          field: null
        }
      })
      return
    }

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

  // Request handlers that own a path prefix on this listener, consulted before
  // this surface's own router. See mount() below.
  const mounts = new Map()

  let handler = warmingHandler
  const server = serverFactory((req, res) => {
    const prefix = mounts.size ? mountedPrefix(mounts, req.url) : null
    if (prefix !== null) return mounts.get(prefix)(req, res)
    return handler(req, res)
  })

  return {
    server,
    host,
    get port() { return boundPort },
    get adopted() { return handler !== warmingHandler },
    get mounted() { return [...mounts.keys()] },
    // How long the surface answered as a warming relay, which is what tells an
    // operator "still opening the store" from "stuck".
    warmupMs() { return now() - createdAt },
    adopt(next) {
      if (typeof next !== 'function') throw new Error('archive http surface requires a request handler')
      handler = next
    },
    // Hands another HTTP server this listener instead of a port of its own.
    //
    // The signed companion API (/api/v2) and this surface's v1 API have to
    // answer on one origin: its only real consumer builds both from a single
    // configured relay base URL and sends no auth headers on the v1 half, so a
    // v1/v2 split across two ports leaves half of those calls unroutable
    // whichever port is configured.
    //
    // This surface owns the listener because it binds before the store opens and
    // answers as a warming relay from the first moment; a companion is created
    // minutes later, once the store is up. So rather than re-implementing that
    // server behind this router, mount() returns a factory shaped exactly like
    // the `createServer` injection point such a server already has: it builds
    // itself as always and is handed this listener's requests — the same
    // req/res objects, so method, target, headers and body arrive precisely as
    // they were signed, and its authentication, replay protection, body limits,
    // request deadline and streaming routes all run on their usual code path.
    mount(prefix) {
      if (typeof prefix !== 'string' || !prefix.startsWith('/') || prefix.endsWith('/') || prefix.includes('?')) {
        throw new Error('archive http surface mounts need an absolute path prefix')
      }
      return (requestListener) => {
        if (typeof requestListener !== 'function') {
          throw new Error('archive http surface mounts need a request handler')
        }
        return createMountedListener({
          prefix,
          requestListener,
          mounts,
          // The bind as it really happened, so a mounted server publishes where
          // it is actually reachable rather than what it was configured with.
          address: () => server.address?.() || { address: host, port: boundPort }
        })
      }
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

function normalizeCatalogPreviewVideos(channel, previewVideos = []) {
  const hasLocalBlobEvidence = channel.source === 'local' || channel.localPublished === true
  return (Array.isArray(previewVideos) ? previewVideos : []).map((video) => {
    if (!hasLocalBlobEvidence || !video?.blobId || !video?.blobsCoreKey) return video
    return {
      ...video,
      availability: video.availability === 'playable' ? video.availability : 'playable',
      byteAvailability: video.byteAvailability === 'playable' ? video.byteAvailability : 'playable'
    }
  })
}

function isPlayableCatalogPreview(video) {
  if (!video?.blobId || !video?.blobsCoreKey) return false
  return video.availability === 'playable' || video.byteAvailability === 'playable'
}

function playableCatalogPreviews(channel, previewVideos = []) {
  return normalizeCatalogPreviewVideos(channel, previewVideos).filter(isPlayableCatalogPreview)
}

function normalizeCatalogChannel(channel, previewVideos = []) {
  const channelKey = channel.channelKey || channel.driveKey
  const publicBeeKey = channel.publicBeeKey || null
  const normalizedPreviewVideos = playableCatalogPreviews(channel, previewVideos)
  if (normalizedPreviewVideos.length === 0) return null
  return {
    ...channel,
    channelKey,
    driveKey: channel.driveKey || channelKey,
    publicBeeKey,
    source: channel.source || 'relay-cache',
    relayRole: channel.relayRole || 'cache',
    relayServing: channel.relayServing !== false,
    videoCount: Number(channel.videoCount || normalizedPreviewVideos.length || channel.videosDownloaded || channel.videosFound || 0) || 0,
    manifestUpdatedAt: Number(channel.manifestUpdatedAt || channel.mirroredAt || channel.lastSeenAt || Date.now()) || Date.now(),
    previewVideos: normalizedPreviewVideos
  }
}

// Union preview lists by video id. A channel's stored previews can be a stale
// mirror/seed snapshot; the completed-archive previews are the live source of
// truth. Merging (rather than preferring one) ensures a newly archived video —
// e.g. another episode dropped into the same channel — is never shadowed.
function mergePreviewsById(base = [], extra = []) {
  const byId = new Map()
  for (const video of (Array.isArray(base) ? base : [])) { if (video?.id) byId.set(video.id, video) }
  for (const video of (Array.isArray(extra) ? extra : [])) { if (video?.id) byId.set(video.id, video) }
  return Array.from(byId.values())
}


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

function tmdbKeyFromClassification(classification = {}) {
  return tmdbKey(classification.type, classification.tmdbId, classification.season, classification.episode)
}

function tmdbKeyFromDiscoverItem(item = {}) {
  return tmdbKey(item.type, item.tmdbId, item.season, item.episode)
}

function tmdbSourceVideoId(type, id, season = null, episode = null) {
  const key = tmdbKey(type, id, season, episode)
  return key ? `tmdb:${key}` : ''
}

export function buildTmdbNetworkIndex(catalogChannels = []) {
  const index = new Map()
  for (const channel of catalogChannels || []) {
    for (const video of [...(channel.previewVideos || []), ...(channel.unavailableVideos || [])]) {
      const c = video?.classification || {}
      const key = tmdbKeyFromClassification(c)
      if (!key) continue
      const existing = index.get(key) || { status: 'missing', count: 0, seeded: 0, videos: [], seen: new Set() }
      const videoKey = `${channel.channelKey || channel.driveKey || ''}:${video.id || ''}:${key}`
      if (existing.seen.has(videoKey)) continue
      existing.seen.add(videoKey)
      const playable = video.availability === 'playable' || video.byteAvailability === 'playable' || Boolean(video.blobId && video.blobsCoreKey)
      existing.count += 1
      if (playable) existing.seeded += 1
      existing.status = (playable || existing.seeded > 0) ? 'seeding' : 'in-network'
      existing.videos.push({
        id: video.id,
        title: video.title,
        channelKey: channel.channelKey || channel.driveKey,
        publicBeeKey: channel.publicBeeKey || video.publicBeeKey || null,
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


export async function buildCatalogChannels({ channels = [], store = null } = {}) {
  const previewsByChannel = await store?.getCompletedVideoPreviewsByChannel?.()
  const byKey = new Map()

  for (const channel of channels || []) {
    const channelKey = channel.channelKey || channel.driveKey
    if (!channelKey) continue
    const previewVideos = mergePreviewsById(channel.previewVideos, previewsByChannel?.get?.(channelKey) || [])
    const normalized = normalizeCatalogChannel(channel, previewVideos)
    if (normalized) byKey.set(channelKey, normalized)
  }


  return Array.from(byKey.values())
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

// The consumer catalog refuses a page larger than 50 outright (it throws, and
// the media graph reports that as CONSUMER_CATALOG_UPDATE_FAILED — an empty
// shelf, not an error the console could explain), so the shelf's own cap is
// filled by paging rather than by asking for all of it at once.
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
  publisher,
  host = '127.0.0.1',
  port = 8174,
  logger = null,
  uploadDir = null,
  uploadStorageHeadroom = null,
  // Opens the machine API's enumeration and byte-serving routes on a
  // non-loopback bind. Off unless the operator asked for it.
  apiOpen = false,
  // How the machine API resolves a submitted source host before it will fetch
  // it. Injectable so a test can stand in for the system resolver; the guard
  // itself is never optional.
  sourceLookup = null,
  // A socket already bound and answering as a warming relay. The console adopts
  // it rather than opening its own, so nothing rebinds and no request between
  // bind and readiness is refused.
  httpSurface = null,
  serverFactory = createDefaultServer,
  runQueue = null,
  storageReservations = null
}) {
  if (!service?.runtime?.ctx?.metaDb) throw new Error('archive console requires a relay service runtime')
  const store = createArchiveJobStore({ metaDb: service.runtime.ctx.metaDb })
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
  // Multipart bytes survive a restart with their queued/failed durable jobs.
  // Restore the eventual persisted-copy reservations before this console can
  // accept another byte, or the process would spend the same aggregate room
  // twice.
  for (const job of await store.listJobs()) {
    if (job.status !== 'queued' && job.status !== 'failed') continue
    const privateInput = await store.getPrivateInput(job.id)
    const uploadPath = privateInput?.uploadPath
    if (!uploadPath || uploadReservations.has(uploadPath) || !existsSync(uploadPath)) continue
    let uploadSize = 0
    try {
      const staged = statSync(uploadPath)
      if (typeof staged?.isFile === 'function' && !staged.isFile()) continue
      uploadSize = Math.max(0, Math.floor(Number(staged?.size) || 0))
    } catch {
      continue
    }
    if (uploadSize <= 0) continue
    const reservation = { bytes: 0, released: false }
    reserveUploadBytes(reservation, uploadSize)
    uploadReservations.set(uploadPath, () => releaseUploadReservation(reservation))
  }
  const manager = createArchiveManager({ store, downloader, publisher, logger, canIngest: service.canArchive, onCompleted: (job) => service.publishArchiveJob?.(job), runQueue, onUploadReleased: releaseUploadReservationByPath, stagingRoot: uploadDir })

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
    if (/application\/json/i.test(contentType)) {
      const fields = jsonFields(await collectBody(req, { maxBytes: MAX_JSON_BODY_BYTES, kind: 'json' }))
      return { form: buildArchiveForm((key) => fields[key] ?? ''), file: null, fields }
    }
    const params = new URLSearchParams(await collectBody(req))
    return { form: buildArchiveForm((key) => params.get(key) || ''), file: null, fields: formFields(params) }
  }

  function discardUploadPath(uploadPath) {
    if (!uploadPath || !uploadDir) return
    const root = resolve(uploadDir)
    const targetDir = dirname(resolve(uploadPath))
    const targetRelative = relative(root, targetDir)
    if (!targetRelative || targetRelative === '..' || targetRelative.startsWith(`..${sep}`)) {
      throw new Error('refusing to discard an upload outside the archive staging root')
    }
    try {
      rmSync(targetDir, { recursive: true, force: true })
    } finally {
      releaseUploadReservationByPath(uploadPath)
    }
  }

  function discardUploadFile(file) {
    if (!file) return
    try {
      if (file.dir) rmSync(file.dir, { recursive: true, force: true })
    } catch (err) {
      logger?.archive?.warn?.('Discarding a rejected upload failed', { error: err?.message || String(err) })
    } finally {
      if (typeof file.releaseStorageReservation === 'function') {
        try { file.releaseStorageReservation() } catch {}
      } else if (file.path) {
        releaseUploadReservationByPath(file.path)
      }
    }
  }

  // One enqueue path for a catalogue-identified submission, shared by the
  // browser Discover form and the machine API: they differ in how they answer,
  // never in what they enqueue.
  async function enqueueCatalogSubmission(form, file) {
    if (form.reuseJobId) {
      const previousInput = await store.getPrivateInput(form.reuseJobId)
      if (previousInput?.uploadPath && previousInput.uploadPath !== file?.path) {
        discardUploadPath(previousInput.uploadPath)
      }
    }
    let job
    try {
      job = await manager.enqueue({
        ...form,
        ...uploadFields(file),
        sourceType: form.sourceType || 'tmdb',
        sourceVideoId: form.sourceVideoId || tmdbSourceVideoId(form.tmdbType, form.tmdbId, form.tmdbSeason, form.tmdbEpisode)
      })
    } catch (err) {
      discardUploadFile(file)
      throw err
    }
    manager.runNext().catch((err) => logger?.archive?.error?.('Archive run failed', { error: err?.message || String(err) }))
    return job
  }

  const archiveApi = createArchiveApi({
    readSubmission: readArchiveSubmission,
    enqueue: enqueueCatalogSubmission,
    store,
    // Resolved per request: the console starts before the network-bound runtime,
    // so the media graph it reads from is not bound yet at construction time.
    mediaCatalog: (request) => service.runtime?.api?.getMediaCatalog?.(request),
    publicationSources: (request) => service.runtime?.api?.getPublicationSources?.(request),
    assetManifest: (publicationId) => service.runtime?.ctx?.assetManifestStore?.getManifest?.(publicationId),
    // Serving a rendition's bytes is the only way an off-box consumer can play
    // what this relay published: a core key needs a PearTube node, and the blob
    // server's link is loopback.
    openRendition: (request) => service.runtime?.api?.openMediaRendition?.(request),
    // The gate: catalog and stream answer freely on loopback, and on any other
    // interface only with the operator's switch.
    bindHost: host,
    apiOpen,
    lookup: sourceLookup,
    logger
  })

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

  async function getCatalogChannels() {
    return buildCatalogChannels({
      channels: service.catalog?.getChannels?.() || [],
      store
    })
  }

  async function discoverView({ query = '', type = 'movie', page = 1 } = {}) {
    const rawCatalogChannels = service.catalog?.getChannels?.() || []
    const catalogChannels = [...rawCatalogChannels, ...await getCatalogChannels()]
    const items = typeof service.discoverTmdb === 'function'
      ? await service.discoverTmdb({ query, type, page }).catch(() => [])
      : []
    return {
      query,
      type: type === 'tv' ? 'tv' : 'movie',
      items: annotateTmdbDiscoverItems(items, buildTmdbNetworkIndex(catalogChannels))
    }
  }

  // The viewer-facing shelf, assembled from four sources that each may not
  // exist yet: the media catalogue, the signed asset manifests, the mirror
  // requests this relay has raised, and its own archive jobs.
  //
  // Every read is optional-chained and the whole thing degrades to an empty
  // shelf, for the same reason the machine API's catalog resolver is resolved
  // per request: the console answers from the moment the socket is bound, and a
  // home page that 500s because the media graph is still opening is strictly
  // worse than one that shows no titles yet.
  async function libraryView(jobs = []) {
    try {
      const items = []
      let cursor = null
      while (items.length < LIBRARY_LIMIT) {
        const request = { limit: Math.min(CATALOG_PAGE_LIMIT, LIBRARY_LIMIT - items.length), limitProvided: true }
        if (cursor) request.cursor = cursor
        const page = await service.runtime?.api?.getMediaCatalog?.(request)
        if (page?.success !== true || !Array.isArray(page.items) || page.items.length === 0) break
        items.push(...page.items)
        cursor = page.nextCursor || null
        if (!cursor) break
      }
      if (items.length === 0) return []

      const mirrors = new Map()
      for (const request of service.runtime?.getArchiveMirrorRequests?.() || []) {
        if (!request?.publicationId) continue
        mirrors.set(String(request.publicationId), request)
      }
      const jobIndex = indexJobsForLibrary(jobs)
      const getManifest = (publicationId) => service.runtime?.ctx?.assetManifestStore?.getManifest?.(publicationId)

      // The catalogue is a projection keyed by content, so it carries no
      // timestamps at all — it is ordered by kind and then by digest. The only
      // local evidence of "when" is the work this relay did around a title: the
      // job that brought it in, or the mirror request it raised for one of its
      // publications. Titles with neither keep the catalogue's own order,
      // behind everything that has one.
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
          sizeBytes += publicationBytes(getManifest(source.publicationId))
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
      const artwork = await service.runtime?.api?.getEntityArtwork?.({ entityId })
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
    // One job read, shared: the operator table below the shelf and the shelf's
    // own "adding"/"could not be added" states are the same records.
    const jobs = await store.listJobs()
    return {
      // The relay status is a flat, bounded contract now: network, budgets and
      // publicWork live at the top level, so the console hands over the whole
      // record instead of digging for a `runtime` blob that no longer exists.
      status,
      jobs,
      library: await libraryView(jobs),
      creators: creatorsView(),
      unseededTargets: service.getCreatorTargets?.({ limit: 25 }) || status.creators?.unseededTargets || [],
      tmdb: tmdbView(),
      s3: service.s3 || {
        configured: false,
        endpoint: '',
        bucket: '',
        region: '',
        prefix: '',
        offload: { enabled: false, windowBytes: 0, blocksOffloaded: 0, bytesOffloaded: 0, restored: 0, residentBytes: 0 }
      },
      discover: await discoverView(discoverParams),
      trustedClients: service.getTrustedClients?.() || [],
      link: service.getLinkDescriptor?.() || null
    }
  }

  const handleRequest = async (req, res) => {
    try {
      // Machine-facing routes answer JSON for every outcome, including unknown
      // paths and wrong methods, so a program never receives the HTML console.
      if (archiveApi.owns(req.url)) {
        await archiveApi.handle(req, res)
        return
      }

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
      }

      // A cover for one shelf entry. This belongs to the browser console, not
      // to the machine API — archiveApi.owns() only ever claims /api/v1 — so a
      // consumer's view of the relay is unchanged by it.
      //
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
        const discover = await discoverView({
          query: parsed.searchParams.get('q') || '',
          type: parsed.searchParams.get('type') || 'movie',
          page: parsed.searchParams.get('page') || '1'
        })
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

      if (req.method === 'GET' && req.url === '/catalog.json') {
        const catalogChannels = await getCatalogChannels()
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store'
        })
        res.end(JSON.stringify({
          schema: 'peartube.simpleRelayCatalog',
          version: 1,
          updatedAt: Date.now(),
          channels: catalogChannels
        }, null, 2))
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
      const recovered = await manager.recoverInterruptedJobs()
      if (recovered?.recovered > 0) {
        logger?.archive?.warn?.('Recovered interrupted archive jobs before opening archive console', { recovered: recovered.recovered })
      }
      // Idempotent on an adopted surface: it is already listening as a warming
      // relay; only adopt the live handler after interrupted-job recovery, so a
      // pre-ready request cannot be mistaken for stale work.
      if (httpSurface) {
        await httpSurface.listen()
        httpSurface.adopt(handleRequest)
      } else {
        await new Promise((resolve) => server.listen(Number(port), host, resolve))
      }
      logger?.archive?.info?.('Archive WebUI started', httpSurface
        ? { host, port: boundPort(), storeWarmupMs: httpSurface.warmupMs() }
        : { host, port: boundPort() })
      // Which mode the machine API is in, said once and out loud: an operator
      // should learn it here, not from a 403 or from reading archive-api.js.
      const { openAccess } = archiveApi
      if (openAccess.exposed && !openAccess.enabled) {
        logger?.archive?.warn?.(
          `Relay API is bound to ${openAccess.boundTo}, so ${archiveApi.prefix}/catalog and ${archiveApi.prefix}/stream refuse with OPEN_ACCESS_NOT_ENABLED; pass ${openAccess.flag} (or ${openAccess.env}=1) to open them`,
          { host, port: boundPort(), apiOpen: false }
        )
      } else if (openAccess.enabled) {
        logger?.archive?.warn?.(
          `Relay API is open on ${openAccess.boundTo}: ${archiveApi.prefix}/catalog enumerates every publication and ${archiveApi.prefix}/stream serves media bytes, unauthenticated, to this whole network`,
          { host, port: boundPort(), apiOpen: true }
        )
      }
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
