import { createServer } from '#http'
import { createArchiveJobStore, createArchiveManager } from './archive-manager.js'
import { renderArchiveTui, renderArchiveWebHome } from './archive-ui.js'
import { resolveTmdbOptions } from './settings.js'
import { parseBoundary, receiveMultipartUpload } from './multipart.js'

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

function parseForm(body) {
  const params = new URLSearchParams(body)
  return buildArchiveForm((key) => params.get(key) || '')
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

async function collectBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function createDefaultServer(handler) {
  return createServer(handler)
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
  serverFactory = createDefaultServer
}) {
  if (!service?.runtime?.ctx?.metaDb) throw new Error('archive console requires a relay service runtime')
  const store = createArchiveJobStore({ metaDb: service.runtime.ctx.metaDb })
  const manager = createArchiveManager({ store, downloader, publisher, logger, canIngest: service.canArchive, onCompleted: (job) => service.publishArchiveJob?.(job) })

  // Read an archive submission as either a browser file upload
  // (multipart/form-data, streamed to disk) or a URL-encoded form. Returns the
  // normalized archive form plus an optional uploaded file descriptor.
  async function readArchiveSubmission(req) {
    const contentType = req.headers?.['content-type'] || req.headers?.['Content-Type'] || ''
    if (/multipart\/form-data/i.test(contentType)) {
      const boundary = parseBoundary(contentType)
      if (!boundary) throw new Error('multipart upload is missing its boundary')
      if (!uploadDir) throw new Error('relay archive upload directory is not configured')
      const { fields, file } = await receiveMultipartUpload(req, { boundary, uploadDir, maxBytes: maxUploadBytes })
      return { form: buildArchiveForm((key) => fields[key] ?? ''), file }
    }
    return { form: parseForm(await collectBody(req)), file: null }
  }

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

  const server = await serverFactory(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
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
        await manager.enqueue({
          ...form,
          ...uploadFields(file),
          sourceType: form.sourceType || 'tmdb',
          sourceVideoId: form.sourceVideoId || tmdbSourceVideoId(form.tmdbType, form.tmdbId, form.tmdbSeason, form.tmdbEpisode)
        })
        manager.runNext().catch((err) => logger?.archive?.error?.('Archive run failed', { error: err?.message || String(err) }))
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
  })

  return {
    store,
    manager,
    server,
    async start() {
      await new Promise((resolve) => server.listen(Number(port), host, resolve))
      logger?.archive?.info?.('Archive WebUI started', { host, port: Number(port) })
      return this
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
    }
  }
}
