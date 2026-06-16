import { createServer } from '#http'
import { createArchiveJobStore, createArchiveManager } from './archive-manager.js'
import { renderArchiveTui, renderArchiveWebHome, renderModerationTargetDetail } from './archive-ui.js'

function parseForm(body) {
  const params = new URLSearchParams(body)
  return {
    url: params.get('url') || '',
    invidiousInstance: params.get('invidiousInstance') || '',
    channelName: params.get('channelName') || 'Anonymous Archive',
    title: params.get('title') || '',
    description: params.get('description') || '',
    publish: params.get('publish') !== 'false'
  }
}

function parseModerationActionForm(body) {
  const params = new URLSearchParams(body)
  return {
    action: params.get('action') || '',
    targetType: params.get('targetType') || '',
    target: params.get('target') || '',
    reason: params.get('reason') || 'operator-review'
  }
}

function parseModerationReportForm(body) {
  const params = new URLSearchParams(body)
  return {
    targetType: params.get('targetType') || '',
    target: params.get('target') || '',
    reason: params.get('reason') || 'other',
    comment: params.get('comment') || '',
    reporter: 'local'
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
  if (channel?.moderation?.state === 'quarantined' || channel?.moderation?.state === 'blocked') return null
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
    relayServing: channel.relayServing === true,
    videoCount: Number(channel.videoCount || normalizedPreviewVideos.length || channel.videosDownloaded || channel.videosFound || 0) || 0,
    manifestUpdatedAt: Number(channel.manifestUpdatedAt || channel.mirroredAt || channel.lastSeenAt || Date.now()) || Date.now(),
    previewVideos: normalizedPreviewVideos
  }
}

async function readPublishedChannels(metaDb) {
  const node = await metaDb?.get?.('published-channels-v2').catch?.(() => null)
  return Array.isArray(node?.value) ? node.value : []
}

export async function buildCatalogChannels({ channels = [], store = null, publicFeed = null, metaDb = null } = {}) {
  const previewsByChannel = await store?.getCompletedVideoPreviewsByChannel?.()
  const byKey = new Map()
  const hiddenChannelKeys = new Set()

  for (const channel of channels || []) {
    const channelKey = channel.channelKey || channel.driveKey
    if (!channelKey) continue
    if (channel?.moderation?.state === 'quarantined' || channel?.moderation?.state === 'blocked') {
      hiddenChannelKeys.add(channelKey)
      continue
    }
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
    if (!channelKey || byKey.has(channelKey) || hiddenChannelKeys.has(channelKey)) continue
    const previewVideos = Array.isArray(entry.previewVideos) ? entry.previewVideos : []
    if (previewVideos.length === 0 && Number(entry.videoCount || 0) <= 0) continue
    const normalized = normalizeCatalogChannel(entry, previewVideos)
    if (normalized) byKey.set(channelKey, normalized)
  }

  for (const entry of await readPublishedChannels(metaDb)) {
    const channelKey = entry.channelKey || entry.driveKey
    if (!channelKey || hiddenChannelKeys.has(channelKey)) continue
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
  const manager = createArchiveManager({
    store,
    downloader,
    publisher,
    logger,
    onCompleted: (job) => service.publishArchiveJobToFeed?.(job),
    onFailed: (job) => service.recordArchiveJobFailure?.(job, { store })
  })

  async function model() {
    const relayStatus = service.getStatus?.() || {}
    return {
      relayStatus,
      status: relayStatus.runtime || {},
      reviewQueue: relayStatus.reviewQueue || [],
      jobs: await store.listJobs()
    }
  }

  const server = await serverFactory(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || '/', 'http://relay.local')

      if (req.method === 'GET' && requestUrl.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      if (req.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/ui')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(renderArchiveWebHome(await model()))
        return
      }

      if (req.method === 'GET' && requestUrl.pathname === '/tui') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(renderArchiveTui(await model()))
        return
      }

      if (req.method === 'GET' && requestUrl.pathname === '/jobs') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jobs: await store.listJobs() }, null, 2))
        return
      }

      if (req.method === 'GET' && requestUrl.pathname === '/catalog.json') {
        const channels = service.catalog?.getChannels?.() || []
        const catalogChannels = await buildCatalogChannels({
          channels,
          store,
          publicFeed: service.runtime?.publicFeed,
          metaDb: service.runtime?.ctx?.metaDb
        })
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

      if (req.method === 'GET' && requestUrl.pathname === '/moderation/target') {
        if (typeof service.getModerationTargetDetail !== 'function') {
          throw new Error('relay service does not support moderation target details')
        }
        const detail = service.getModerationTargetDetail({
          targetType: requestUrl.searchParams.get('targetType') || '',
          target: requestUrl.searchParams.get('target') || ''
        })
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(renderModerationTargetDetail({ detail }))
        return
      }

      if (req.method === 'GET' && requestUrl.pathname === '/moderation/audit.json') {
        if (typeof service.getModerationAudit !== 'function') {
          throw new Error('relay service does not support moderation audit export')
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store'
        })
        res.end(JSON.stringify(service.getModerationAudit(), null, 2))
        return
      }

      if (req.method === 'POST' && requestUrl.pathname === '/archive') {
        const form = parseForm(await collectBody(req))
        const job = await manager.enqueue(form)
        await service.recordArchiveJobQueued?.(job, { store, input: form })
        manager.runNext().catch((err) => logger?.archive?.error?.('Archive run failed', { error: err?.message || String(err) }))
        res.writeHead(303, { location: '/' })
        res.end()
        return
      }

      if (req.method === 'POST' && requestUrl.pathname === '/moderation/action') {
        if (typeof service.addModerationRule !== 'function') {
          throw new Error('relay service does not support moderation actions')
        }
        const form = parseModerationActionForm(await collectBody(req))
        await service.addModerationRule(form)
        res.writeHead(303, { location: '/' })
        res.end()
        return
      }

      if (req.method === 'POST' && requestUrl.pathname === '/moderation/report') {
        if (typeof service.submitModerationReport !== 'function') {
          throw new Error('relay service does not support moderation reports')
        }
        const form = parseModerationReportForm(await collectBody(req))
        await service.submitModerationReport(form)
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
