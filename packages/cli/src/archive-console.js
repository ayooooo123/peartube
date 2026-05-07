import { createServer } from '#http'
import { createArchiveJobStore, createArchiveManager } from './archive-manager.js'
import { renderArchiveTui, renderArchiveWebHome } from './archive-ui.js'

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
  const manager = createArchiveManager({ store, downloader, publisher, logger })

  async function model() {
    return {
      status: service.getStatus?.().runtime || {},
      jobs: await store.listJobs()
    }
  }

  const server = await serverFactory(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      if (req.method === 'GET' && (req.url === '/' || req.url === '/ui')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(renderArchiveWebHome(await model()))
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

      if (req.method === 'POST' && req.url === '/archive') {
        const form = parseForm(await collectBody(req))
        await manager.enqueue(form)
        manager.runNext().catch((err) => logger?.archive?.error?.('Archive run failed', { error: err?.message || String(err) }))
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
