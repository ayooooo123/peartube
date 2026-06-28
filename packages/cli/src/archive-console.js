import { createServer } from '#http'
import { createArchiveJobStore, createArchiveManager } from './archive-manager.js'
import { renderArchiveTui, renderArchiveWebHome } from './archive-ui.js'
import { resolveTmdbOptions } from './settings.js'

function parseForm(body) {
  const params = new URLSearchParams(body)
  return {
    url: params.get('url') || '',
    invidiousInstance: params.get('invidiousInstance') || '',
    channelName: params.get('channelName') || 'Anonymous Archive',
    title: params.get('title') || '',
    description: params.get('description') || '',
    publish: params.get('publish') !== 'false',
    sourceType: params.get('sourceType') || '',
    sourceUrl: params.get('sourceUrl') || '',
    sourceVideoId: params.get('sourceVideoId') || '',
    tmdbType: params.get('tmdbType') || '',
    tmdbId: params.get('tmdbId') || '',
    tmdbSeason: params.get('tmdbSeason') || '',
    tmdbEpisode: params.get('tmdbEpisode') || '',
    tmdbPosterPath: params.get('tmdbPosterPath') || '',
    tmdbTitle: params.get('tmdbTitle') || '',
    tmdbYear: params.get('tmdbYear') || ''
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
  return {
    apiKey: params.get('apiKey') || '',
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


function tmdbKey(type, id) {
  if (!type || !id) return null
  return `${type}:${id}`
}

export function buildTmdbNetworkIndex(catalogChannels = []) {
  const index = new Map()
  for (const channel of catalogChannels || []) {
    for (const video of [...(channel.previewVideos || []), ...(channel.unavailableVideos || [])]) {
      const c = video?.classification || {}
      const key = tmdbKey(c.type, c.tmdbId)
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
    const found = networkIndex.get(tmdbKey(item.type, item.tmdbId))
    return {
      ...item,
      networkStatus: found?.status || 'missing',
      networkCopies: found?.count || 0,
      seededCopies: found?.seeded || 0,
      networkVideos: found?.videos || []
    }
  })
}

async function readPublishedChannels(metaDb) {
  const node = await metaDb?.get?.('published-channels-v2').catch?.(() => null)
  return Array.isArray(node?.value) ? node.value : []
}

export async function buildCatalogChannels({ channels = [], store = null, publicFeed = null, metaDb = null } = {}) {
  const previewsByChannel = await store?.getCompletedVideoPreviewsByChannel?.()
  const byKey = new Map()

  for (const channel of channels || []) {
    const channelKey = channel.channelKey || channel.driveKey
    if (!channelKey) continue
    const previewVideos = Array.isArray(channel.previewVideos) && channel.previewVideos.length > 0
      ? channel.previewVideos
      : (previewsByChannel?.get?.(channelKey) || [])
    const normalized = normalizeCatalogChannel(channel, previewVideos)
    if (normalized) byKey.set(channelKey, normalized)
  }

  const feedEntries = typeof publicFeed?.getFeed === 'function'
    ? publicFeed.getFeed()
    : Array.from(publicFeed?.entries?.values?.() || [])

  for (const entry of feedEntries || []) {
    const channelKey = entry.channelKey || entry.driveKey
    if (!channelKey || byKey.has(channelKey)) continue
    const previewVideos = Array.isArray(entry.previewVideos) ? entry.previewVideos : []
    if (previewVideos.length === 0 && Number(entry.videoCount || 0) <= 0) continue
    const normalized = normalizeCatalogChannel(entry, previewVideos)
    if (normalized) byKey.set(channelKey, normalized)
  }

  for (const entry of await readPublishedChannels(metaDb)) {
    const channelKey = entry.channelKey || entry.driveKey
    if (!channelKey) continue
    const previewVideos = Array.isArray(entry.previewVideos) ? entry.previewVideos : []
    if (previewVideos.length === 0 && Number(entry.videoCount || 0) <= 0) continue
    const normalized = normalizeCatalogChannel({ source: 'local', relayRole: 'publisher', ...entry }, previewVideos)
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
  serverFactory = createDefaultServer
}) {
  if (!service?.runtime?.ctx?.metaDb) throw new Error('archive console requires a relay service runtime')
  const store = createArchiveJobStore({ metaDb: service.runtime.ctx.metaDb })
  const manager = createArchiveManager({ store, downloader, publisher, logger, onCompleted: (job) => service.publishArchiveJobToFeed?.(job) })

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
      store,
      publicFeed: service.runtime?.publicFeed,
      metaDb: service.runtime?.ctx?.metaDb
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
          res.end(renderArchiveWebHome(await model({
            query: parsed.searchParams.get('q') || '',
            type: parsed.searchParams.get('type') || 'movie',
            page: parsed.searchParams.get('page') || '1'
          })))
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
        res.end(JSON.stringify(service.getLinkDescriptor?.() || { schema: 'peartube.relayLink', version: 1, relayMirrorKey: null }, null, 2))
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
        const form = parseForm(await collectBody(req))
        await manager.enqueue({
          ...form,
          sourceType: form.sourceType || 'tmdb',
          sourceVideoId: form.sourceVideoId || (form.tmdbType && form.tmdbId ? `tmdb:${form.tmdbType}:${form.tmdbId}` : '')
        })
        manager.runNext().catch((err) => logger?.archive?.error?.('Archive run failed', { error: err?.message || String(err) }))
        res.writeHead(303, { location: '/#discover' })
        res.end()
        return
      }

      if (req.method === 'POST' && req.url === '/archive') {
        const form = parseForm(await collectBody(req))
        await manager.enqueue(form)
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
