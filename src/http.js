import { createServer } from 'node:http'
import { page } from './ui.js'

const MAX_BODY = 64 * 1024

// The relay's one HTTP port: the UI at / and the /v1 machine API. No auth for
// now, so bind it to a trusted network only.
export function createApi ({ node, acquirer }) {
  async function body (req) {
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY) throw Object.assign(new Error('Body too large'), { status: 413 })
      chunks.push(chunk)
    }
    try { return JSON.parse(Buffer.concat(chunks)) } catch { throw Object.assign(new Error('Body must be JSON'), { status: 400 }) }
  }

  async function route (req, url) {
    const path = url.pathname
    if (req.method === 'GET' && path === '/v1/status') return node.status()
    if (req.method === 'GET' && path === '/v1/search') {
      const id = url.searchParams.get('id')
      if (!id) throw Object.assign(new Error('id is required'), { status: 400 })
      return { results: await node.search(id) }
    }
    if (req.method === 'GET' && path === '/v1/entries') return { results: await node.search() }
    if (req.method === 'POST' && path === '/v1/acquire') {
      const { id, title, source } = await body(req)
      return acquirer.add({ id, title, source })
    }
    if (req.method === 'GET' && path === '/v1/jobs') return { jobs: acquirer.list() }
    const match = path.match(/^\/v1\/jobs\/([0-9a-f-]{36})$/)
    if (match && req.method === 'GET') return acquirer.get(match[1])
    if (match && req.method === 'DELETE') return acquirer.cancel(match[1])
    return undefined
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://relay')
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page)
      return
    }
    let status = 200
    let payload
    try {
      payload = await route(req, url)
      if (payload === undefined || payload === null) { status = 404; payload = { error: 'not found' } }
    } catch (err) {
      status = err.status || 400
      payload = { error: err.message }
    }
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  })
}
