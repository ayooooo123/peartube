import b4a from 'b4a'
import test from 'brittle'

import { createTorBoxSourceGrants, TorBoxSourceError } from '../src/companion/sources/torbox.js'

// The v2 TorBox adapter: a source-grant resolver that turns an opaque grant
// token into a resumable SourceReader streaming TorBox CDN ranges. Usenet and
// torrent grants share one reader; only the requestdl route differs.

const API_BASE = 'https://api.torbox.test/v1/api'
const CDN = 'https://cdn.torbox.test/file'

function encodeToken (payload) {
  return b4a.toString(b4a.from(JSON.stringify(payload), 'utf8'), 'base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

// A fetch double: answers the API requestdl route with a link, and the CDN
// with range responses. Records every request it saw.
function createFakeFetch ({ linkStatus = 200, cdnStatus = 206, cdnBody = null, requestdlStatus = 200, onLink = null } = {}) {
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init })
    if (url.startsWith(API_BASE)) {
      if (requestdlStatus !== 200) {
        return response(requestdlStatus, {})
      }
      const link = typeof onLink === 'function' ? onLink(requests.filter(r => r.url.startsWith(API_BASE)).length) : `${CDN}?t=1`
      return response(200, { success: true, data: link })
    }
    if (init.method === 'HEAD') {
      return response(cdnStatus, {}, {
        'content-length': String(cdnBody ? cdnBody.byteLength : 0),
        etag: '"v1"',
        'content-type': 'video/mp4'
      })
    }
    const range = init.headers?.Range || init.headers?.range || ''
    const match = range.match(/bytes=(\d+)-(\d+)/)
    if (!match) return response(200, {}, {}, cdnBody || b4a.alloc(0))
    const start = Number(match[1])
    const end = Number(match[2])
    const slice = (cdnBody || b4a.alloc(0)).subarray(start, end + 1)
    return response(cdnStatus, {}, {
      'content-length': String(slice.byteLength),
      'content-type': 'video/mp4'
    }, slice)
  }
  fetchImpl.requests = requests
  return fetchImpl
}

function response (status, body, headers = {}, buffer = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? headers[name] ?? null },
    async json () { return body },
    async arrayBuffer () { return buffer ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : new ArrayBuffer(0) },
    body: null
  }
}

test('usenet grant resolves a reader that streams the whole range through the usenet route', async (t) => {
  const payload = b4a.alloc(64 * 1024)
  for (let i = 0; i < payload.byteLength; i++) payload[i] = i & 0xff
  const fetchImpl = createFakeFetch({ cdnBody: payload })
  const grants = createTorBoxSourceGrants({ apiKey: 'key1234567890', apiBase: API_BASE, fetchImpl })

  const token = encodeToken({ kind: 'usenet', usenetId: 12345, fileId: 2 })
  const reader = await grants.resolve({ token, length: payload.byteLength, sha256: null, etag: '"v1"' })

  const described = await reader.describe()
  t.is(described.byteLength, payload.byteLength, 'describe reports the granted length')
  t.is(described.identity.value, '"v1"', 'and the granted etag')

  const chunks = []
  for await (const chunk of reader.open({ offset: 0, length: payload.byteLength })) chunks.push(chunk)
  const received = b4a.concat(chunks)
  t.alike(received, payload, 'the full range came back in order')

  const apiRequest = fetchImpl.requests.find(r => r.url.includes('/requestdl'))
  t.ok(apiRequest.url.includes('/usenet/requestdl'), 'the usenet route was used (singular)')
  t.ok(apiRequest.url.includes('usenet_id=12345'), 'with the usenet id')
  t.ok(apiRequest.url.includes('file_id=2'), 'and the file id')
  t.ok(!apiRequest.url.includes('usenets'), 'never the pluralized route')
})

test('torrent grant uses the torrents route', async (t) => {
  const payload = b4a.alloc(1024, 7)
  const fetchImpl = createFakeFetch({ cdnBody: payload })
  const grants = createTorBoxSourceGrants({ apiKey: 'key1234567890', apiBase: API_BASE, fetchImpl })

  const token = encodeToken({ kind: 'torrent', torrentId: 999, fileId: 0 })
  const reader = await grants.resolve({ token, length: payload.byteLength })
  const chunks = []
  for await (const chunk of reader.open({ offset: 0, length: payload.byteLength })) chunks.push(chunk)
  t.alike(b4a.concat(chunks), payload, 'the range streamed')

  const apiRequest = fetchImpl.requests.find(r => r.url.includes('/requestdl'))
  t.ok(apiRequest.url.includes('/torrents/requestdl'), 'the torrents route was used (plural)')
  t.ok(apiRequest.url.includes('torrent_id=999'), 'with the torrent id')
})

test('a token without a kind or ids is refused before any request is made', async (t) => {
  const fetchImpl = createFakeFetch()
  const grants = createTorBoxSourceGrants({ apiKey: 'key1234567890', apiBase: API_BASE, fetchImpl })
  for (const bad of [encodeToken({ foo: 1 }), encodeToken({ kind: 'http' }), '!!!not-base64!!!']) {
    let error = null
    try { await grants.resolve({ token: bad }) } catch (thrown) { error = thrown }
    t.ok(error instanceof TorBoxSourceError && error.code === 'SOURCE_GRANT_INVALID', `refused: ${bad.slice(0, 24)}`)
  }
  t.is(fetchImpl.requests.length, 0, 'no request left the process')
})

test('describe falls back to a CDN HEAD when the grant carries no length', async (t) => {
  const payload = b4a.alloc(2048, 3)
  const fetchImpl = createFakeFetch({ cdnBody: payload })
  const grants = createTorBoxSourceGrants({ apiKey: 'key1234567890', apiBase: API_BASE, fetchImpl })

  const token = encodeToken({ kind: 'usenet', usenetId: 1, fileId: 0 })
  const reader = await grants.resolve({ token })
  const described = await reader.describe()
  t.is(described.byteLength, 2048, 'the HEAD content-length became the byteLength')
  t.is(described.identity.value, '"v1"', 'the HEAD etag became the identity')
})

test('an expired CDN token is retried with a fresh link', async (t) => {
  const payload = b4a.alloc(512, 9)
  let linkRequests = 0
  const fetchImpl = createFakeFetch({
    cdnBody: payload,
    onLink: (count) => {
      linkRequests++
      return count <= 1 ? 'https://cdn.torbox.test/expired' : 'https://cdn.torbox.test/fresh'
    }
  })
  // First CDN GET on the expired link answers 410; the retry must fetch a new
  // link and succeed. The fake maps any cdnStatus to every GET, so simulate
  // expiry by wrapping: requests to /expired answer 410.
  const inner = fetchImpl.requests
  const wrapped = async (url, init = {}) => {
    const res = await fetchImpl(url, init)
    if (url.includes('/expired') && (init.method === 'GET' || !init.method)) {
      return response(410, {})
    }
    return res
  }
  wrapped.requests = inner
  const grants = createTorBoxSourceGrants({ apiKey: 'key1234567890', apiBase: API_BASE, fetchImpl: wrapped })

  const token = encodeToken({ kind: 'usenet', usenetId: 8, fileId: 0 })
  const reader = await grants.resolve({ token, length: payload.byteLength })
  const chunks = []
  for await (const chunk of reader.open({ offset: 0, length: payload.byteLength })) chunks.push(chunk)
  t.alike(b4a.concat(chunks), payload, 'the range still streamed after token expiry')
  t.ok(linkRequests >= 2, 'a fresh link was requested')
})

test('an invalid API key fails closed without retries', async (t) => {
  const fetchImpl = createFakeFetch({ requestdlStatus: 401 })
  const grants = createTorBoxSourceGrants({ apiKey: 'key1234567890', apiBase: API_BASE, fetchImpl })
  const token = encodeToken({ kind: 'usenet', usenetId: 5, fileId: 0 })
  let error = null
  try {
    const reader = await grants.resolve({ token, length: 100 })
    const iterator = reader.open({ offset: 0, length: 100 })[Symbol.asyncIterator]()
    await iterator.next()
  } catch (thrown) { error = thrown }
  t.ok(error instanceof TorBoxSourceError && error.code === 'TORBOX_AUTH_FAILED', 'auth failure is fatal and unrecoverable')
})

test('without an API key the adapter reports itself disabled', async (t) => {
  const fetchImpl = createFakeFetch()
  const grants = createTorBoxSourceGrants({ apiKey: '', apiBase: API_BASE, fetchImpl })
  t.is(grants.enabled, false, 'not enabled')

  const token = encodeToken({ kind: 'usenet', usenetId: 5, fileId: 0 })
  await t.exception(async () => grants.resolve({ token }), /TorBox is not configured/, 'clear failure reason')
})

test('the download link is cached for repeat ranges', async (t) => {
  const payload = b4a.alloc(4096, 1)
  const fetchImpl = createFakeFetch({ cdnBody: payload })
  const grants = createTorBoxSourceGrants({ apiKey: 'key1234567890', apiBase: API_BASE, fetchImpl })

  const token = encodeToken({ kind: 'torrent', torrentId: 3, fileId: 1 })
  const reader = await grants.resolve({ token, length: payload.byteLength })
  for (const [offset, length] of [[0, 1024], [1024, 1024]]) {
    const chunks = []
    for await (const chunk of reader.open({ offset, length })) chunks.push(chunk)
    t.is(b4a.concat(chunks).byteLength, length, `range ${offset}..${offset + length} streamed`)
  }
  const linkRequests = fetchImpl.requests.filter(r => r.url.includes('/requestdl')).length
  t.is(linkRequests, 1, 'one requestdl served both ranges')
})
