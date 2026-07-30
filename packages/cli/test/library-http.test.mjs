import test from 'brittle'
import { createArchiveConsole } from '../src/archive-console.js'

function createMockReqRes({ method = 'GET', url = '/', body = '' } = {}) {
  const listeners = { data: [], end: [], error: [] }
  const req = {
    method,
    url,
    on(event, cb) {
      listeners[event]?.push(cb)
      if (event === 'end') {
        queueMicrotask(() => {
          if (body) for (const fn of listeners.data) fn(body)
          for (const fn of listeners.end) fn()
        })
      }
      return req
    }
  }
  let statusCode = 0
  let responseBody = ''
  const headers = {}
  const res = {
    writeHead(code, hdrs = {}) {
      statusCode = code
      Object.assign(headers, hdrs)
    },
    end(chunk = '') {
      responseBody += String(chunk)
    }
  }
  return {
    req,
    res,
    get statusCode() { return statusCode },
    get headers() { return headers },
    get body() { return responseBody },
    async settled() {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
}

test('archive console exposes library status and control routes', async (t) => {
  let handler = null
  const service = {
    runtime: { ctx: { metaDb: { get: async () => null } } },
    getLibraryStatus() {
      return {
        enabled: true,
        folders: 1,
        totalItems: 2,
        items: { durable: 1, 'self-only': 1, failed: 0 },
        bytes: 42,
        capBytes: 100,
        importsPaused: false,
        hiverelay: { enabled: true, endpoint: 'http://hr:9100' }
      }
    },
    async libraryScanOnce() {
      return { scanned: 2, imported: 1, skipped: 1, failed: 0 }
    },
    async confirmLibraryFolder(path) {
      t.is(path, '/media/Public')
      return { confirmed: true }
    },
    async libraryUnseed(target) {
      t.is(target, 'vid-1')
      return { unseeded: 1, state: 'unseeded' }
    },
    async libraryReconcile() {
      return { verified: 2, failures: 0 }
    },
    catalog: { getChannels() { return [] } }
  }

  const console = await createArchiveConsole({
    service,
    downloader: {},
    publisher: {},
    serverFactory: async (h) => {
      handler = h
      return {
        listen(_port, _host, cb) { cb?.() },
        close(cb) { cb?.() }
      }
    }
  })

  t.ok(handler)

  {
    const http = createMockReqRes({ method: 'GET', url: '/library/status' })
    await handler(http.req, http.res)
    await http.settled()
    t.is(http.statusCode, 200)
    const body = JSON.parse(http.body)
    t.is(body.enabled, true)
    t.is(body.totalItems, 2)
    t.is(body.durableItems, 1)
    t.is(body.selfOnlyItems, 1)
    t.is(body.hiverelayEndpoint, 'http://hr:9100')
  }

  {
    const http = createMockReqRes({ method: 'POST', url: '/library/scan', body: '{}' })
    await handler(http.req, http.res)
    await http.settled()
    t.is(http.statusCode, 200)
    t.alike(JSON.parse(http.body), { scanned: 2, imported: 1, skipped: 1, failed: 0 })
  }

  {
    const http = createMockReqRes({ method: 'POST', url: '/library/confirm', body: JSON.stringify({ folderPath: '/media/Public' }) })
    await handler(http.req, http.res)
    await http.settled()
    t.is(http.statusCode, 200)
    t.alike(JSON.parse(http.body), { confirmed: true })
  }

  {
    const http = createMockReqRes({ method: 'POST', url: '/library/unseed', body: JSON.stringify({ target: 'vid-1' }) })
    await handler(http.req, http.res)
    await http.settled()
    t.is(http.statusCode, 200)
    t.alike(JSON.parse(http.body), { unseeded: 1, state: 'unseeded' })
  }

  {
    const http = createMockReqRes({ method: 'POST', url: '/library/verify', body: '{}' })
    await handler(http.req, http.res)
    await http.settled()
    t.is(http.statusCode, 200)
    t.alike(JSON.parse(http.body), { verified: 2, failures: 0 })
  }

  await console.close()
})
