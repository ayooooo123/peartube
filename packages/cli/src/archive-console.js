import { createServer } from '#http'
import { createArchiveJobStore, createArchiveManager } from './archive-manager.js'
import { renderArchiveTui, renderArchiveWebHome } from './archive-ui.js'
import { resolveTmdbOptions } from './settings.js'
import { parseBoundary, receiveMultipartUpload } from './multipart.js'
import {
  ARCHIVE_API_PREFIX,
  MAX_JSON_BODY_BYTES,
  archiveApiRoute,
  createArchiveApi,
  createOpenAccessGate,
  isGatedArchiveApiRoute
} from './archive-api.js'

const DEFAULT_MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024 // 5 GB

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

export async function createArchiveConsole({
  service,
  downloader,
  publisher,
  host = '127.0.0.1',
  port = 8174,
  logger = null,
  uploadDir = null,
  maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES,
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
  serverFactory = createDefaultServer
}) {
  if (!service?.runtime?.ctx?.metaDb) throw new Error('archive console requires a relay service runtime')
  const store = createArchiveJobStore({ metaDb: service.runtime.ctx.metaDb })
  const manager = createArchiveManager({ store, downloader, publisher, logger, canIngest: service.canArchive, onCompleted: (job) => service.publishArchiveJob?.(job) })

  // Read an archive submission as a browser file upload (multipart/form-data,
  // streamed to disk), a machine API JSON body, or a URL-encoded form. Returns
  // the normalized archive form plus an optional uploaded file descriptor.
  async function readArchiveSubmission(req) {
    const contentType = req.headers?.['content-type'] || req.headers?.['Content-Type'] || ''
    if (/multipart\/form-data/i.test(contentType)) {
      const boundary = parseBoundary(contentType)
      if (!boundary) throw new Error('multipart upload is missing its boundary')
      if (!uploadDir) throw new Error('relay archive upload directory is not configured')
      const { fields, file } = await receiveMultipartUpload(req, { boundary, uploadDir, maxBytes: maxUploadBytes })
      return { form: buildArchiveForm((key) => fields[key] ?? ''), file, fields }
    }
    if (/application\/json/i.test(contentType)) {
      const fields = jsonFields(await collectBody(req, { maxBytes: MAX_JSON_BODY_BYTES, kind: 'json' }))
      return { form: buildArchiveForm((key) => fields[key] ?? ''), file: null, fields }
    }
    const params = new URLSearchParams(await collectBody(req))
    return { form: buildArchiveForm((key) => params.get(key) || ''), file: null, fields: formFields(params) }
  }

  // One enqueue path for a catalogue-identified submission, shared by the
  // browser Discover form and the machine API: they differ in how they answer,
  // never in what they enqueue.
  async function enqueueCatalogSubmission(form, file) {
    const job = await manager.enqueue({
      ...form,
      ...uploadFields(file),
      sourceType: form.sourceType || 'tmdb',
      sourceVideoId: form.sourceVideoId || tmdbSourceVideoId(form.tmdbType, form.tmdbId, form.tmdbSeason, form.tmdbEpisode)
    })
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

  async function model(discoverParams = {}) {
    const status = service.getStatus?.() || {}
    return {
      status: status.runtime || {},
      jobs: await store.listJobs(),
      creators: creatorsView(),
      unseededTargets: service.getCreatorTargets?.({ limit: 25 }) || status.creators?.unseededTargets || [],
      tmdb: tmdbView(),
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
        await manager.enqueue({ ...form, ...uploadFields(file) })
        manager.runNext().catch((err) => logger?.archive?.error?.('Archive run failed', { error: err?.message || String(err) }))
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
  httpSurface?.adopt(handleRequest)
  const boundPort = () => (httpSurface ? httpSurface.port : Number(port))

  return {
    store,
    manager,
    server,
    async start() {
      // Idempotent on an adopted surface: it is already listening, and this is
      // the moment the store-dependent side became answerable.
      if (httpSurface) await httpSurface.listen()
      else await new Promise((resolve) => server.listen(Number(port), host, resolve))
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
