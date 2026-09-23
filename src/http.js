import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

const MAX_BODY = 64 * 1024

// Machine API for one trusted client (e.g. MediaStorm) on the LAN.
// Every route needs `Authorization: Bearer <secret>`.
export function createApi ({ node, acquirer, secret }) {
  const expected = Buffer.from(`Bearer ${secret}`)
  const authorized = header => {
    const given = Buffer.from(header || '')
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

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
    let status = 200
    let payload
    try {
      if (!authorized(req.headers.authorization)) {
        status = 401
        payload = { error: 'unauthorized' }
      } else {
        payload = await route(req, new URL(req.url, 'http://relay'))
        if (payload === undefined || payload === null) { status = 404; payload = { error: 'not found' } }
      }
    } catch (err) {
      status = err.status || 400
      payload = { error: err.message }
    }
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  })
}
