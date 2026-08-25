import test from 'brittle'
import b4a from 'b4a'
import { createTorBoxSourceClient } from '../src/companion/sources/torbox-source.js'

test('TorBoxSourceClient head fetches download link and probes content-length', async (t) => {
  const fileBytes = b4a.from('Hello world this is a test media file for TorBox!')
  const calls = []

  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers })
    if (url.includes('/torrents/requestdl')) {
      return {
        ok: true,
        status: 200,
        async json () {
          return { success: true, data: 'https://cdn.torbox.app/download/test-stream-123' }
        }
      }
    }
    if (url.includes('cdn.torbox.app') && init.method === 'HEAD') {
      return {
        ok: true,
        status: 200,
        headers: new Map([
          ['content-length', String(fileBytes.byteLength)],
          ['content-type', 'video/mp4'],
          ['etag', '"torbox-etag-123"']
        ])
      }
    }
    throw new Error(`Unexpected request: ${url}`)
  }

  const client = createTorBoxSourceClient({
    apiKey: 'test-api-key-123',
    fetchImpl
  })

  const head = await client.head({ torrentId: '83683870', fileId: 0 })
  t.is(head.length, fileBytes.byteLength, 'length matches file size')
  t.is(head.etag, '"torbox-etag-123"', 'etag matches CDN header')
  t.is(head.mimeType, 'video/mp4', 'mimeType matches CDN header')
  t.is(calls.length, 2, 'called requestdl and then HEAD on CDN')
})

test('TorBoxSourceClient getRange streams byte ranges to onChunk', async (t) => {
  const fileBytes = b4a.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz')
  const cdnUrl = 'https://cdn.torbox.app/download/test-stream-123'

  const fetchImpl = async (url, init = {}) => {
    if (url.includes('/torrents/requestdl')) {
      return {
        ok: true,
        status: 200,
        async json () {
          return { success: true, data: cdnUrl }
        }
      }
    }
    if (url === cdnUrl) {
      const range = init.headers?.Range
      const match = range?.match(/bytes=(\d+)-(\d+)/)
      const start = Number(match[1])
      const end = Number(match[2])
      const slice = fileBytes.subarray(start, end + 1)

      return {
        ok: true,
        status: 206,
        headers: new Map([
          ['content-length', String(slice.byteLength)],
          ['content-range', `bytes ${start}-${end}/${fileBytes.byteLength}`]
        ]),
        async arrayBuffer () {
          return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength)
        }
      }
    }
    throw new Error(`Unexpected request: ${url}`)
  }

  const client = createTorBoxSourceClient({
    apiKey: 'test-api-key-123',
    fetchImpl
  })

  const chunks = []
  await client.getRange({
    torrentId: '123',
    fileId: 0,
    start: 10,
    end: 25,
    onChunk: (chunk) => chunks.push(chunk)
  })

  const received = b4a.concat(chunks)
  t.alike(received, fileBytes.subarray(10, 26), 'exact byte range received')
})

test('TorBoxSourceClient getRange auto-refreshes expired CDN link on 401/403/410', async (t) => {
  const fileBytes = b4a.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ')
  let cdnCalls = 0
  let requestdlCalls = 0

  const fetchImpl = async (url, init = {}) => {
    if (url.includes('/torrents/requestdl')) {
      requestdlCalls++
      return {
        ok: true,
        status: 200,
        async json () {
          return { success: true, data: `https://cdn.torbox.app/download/link-v${requestdlCalls}` }
        }
      }
    }
    if (url.includes('cdn.torbox.app/download/link-v1')) {
      cdnCalls++
      // First link is expired (410 Gone)
      return {
        ok: false,
        status: 410,
        headers: new Map()
      }
    }
    if (url.includes('cdn.torbox.app/download/link-v2')) {
      cdnCalls++
      const range = init.headers?.Range
      const match = range?.match(/bytes=(\d+)-(\d+)/)
      const start = Number(match[1])
      const end = Number(match[2])
      const slice = fileBytes.subarray(start, end + 1)
      return {
        ok: true,
        status: 206,
        headers: new Map([
          ['content-length', String(slice.byteLength)]
        ]),
        async arrayBuffer () {
          return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength)
        }
      }
    }
    throw new Error(`Unexpected request: ${url}`)
  }

  const client = createTorBoxSourceClient({
    apiKey: 'test-api-key-123',
    fetchImpl
  })

  const chunks = []
  await client.getRange({
    torrentId: '123',
    fileId: 0,
    start: 0,
    end: 15,
    onChunk: (chunk) => chunks.push(chunk)
  })

  t.is(requestdlCalls, 2, 'requestdl called twice (cached then fresh)')
  t.is(cdnCalls, 2, 'cdn requested twice (expired then fresh)')
  t.alike(b4a.concat(chunks), fileBytes.subarray(0, 16), 'successfully received bytes after link refresh')
})
