import test from 'brittle'
import b4a from 'b4a'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFileSourceClient } from '../src/companion/sources/file-source.js'

test('FileSourceClient head and getRange on local file', async (t) => {
  const tmpPath = join(tmpdir(), `peartube-file-test-${Date.now()}.mkv`)
  const content = b4a.from('This is a local media file on disk!')
  writeFileSync(tmpPath, content)

  t.teardown(() => {
    try { unlinkSync(tmpPath) } catch {}
  })

  const client = createFileSourceClient()

  // Test head
  const head = await client.head({ filePath: tmpPath })
  t.is(head.length, content.byteLength, 'length matches file size')
  t.is(head.mimeType, 'video/mp4', 'mimeType is video/mp4')

  // Test getRange
  const chunks = []
  await client.getRange({
    filePath: tmpPath,
    start: 5,
    end: 18,
    onChunk: (chunk) => chunks.push(chunk)
  })

  const received = b4a.concat(chunks)
  t.alike(received, content.subarray(5, 19), 'exact byte range read from local file')
})

test('FileSourceClient enforces allowedPaths whitelist', async (t) => {
  const tmpPath = join(tmpdir(), `peartube-allowed-test-${Date.now()}.mkv`)
  writeFileSync(tmpPath, b4a.from('Secret data'))

  t.teardown(() => {
    try { unlinkSync(tmpPath) } catch {}
  })

  const client = createFileSourceClient({
    allowedPaths: ['/var/media', '/mnt/storage']
  })

  try {
    await client.head({ filePath: tmpPath })
    t.fail('should have thrown access denied')
  } catch (err) {
    t.is(err.code, 'FILE_ACCESS_DENIED', 'access denied for unwhitelisted path')
  }
})

test('FileSourceClient head and getRange via WebDAV mock', async (t) => {
  const content = b4a.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz')
  const calls = []

  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers })
    if (init.method === 'HEAD') {
      return {
        ok: true,
        status: 200,
        headers: new Map([
          ['content-length', String(content.byteLength)],
          ['content-type', 'video/mp4'],
          ['etag', '"webdav-123"']
        ])
      }
    }
    const range = init.headers?.Range
    const match = range?.match(/bytes=(\d+)-(\d+)/)
    const start = Number(match[1])
    const end = Number(match[2])
    const slice = content.subarray(start, end + 1)
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

  const client = createFileSourceClient({
    fetchImpl,
    defaultWebdavBase: 'https://nas.example.com/webdav',
    webdavUsername: 'user',
    webdavPassword: 'password'
  })

  // Test head with relative webdavPath
  const head = await client.head({ webdavPath: 'movies/test.mkv' })
  t.is(head.length, content.byteLength, 'length matches mock WebDAV')
  t.is(calls[0].url, 'https://nas.example.com/webdav/movies/test.mkv', 'resolves against configured WebDAV base')
  t.ok(calls[0].headers.Authorization?.startsWith('Basic '), 'includes Basic Auth header')

  // Test getRange
  const chunks = []
  await client.getRange({
    webdavPath: 'movies/test.mkv',
    start: 10,
    end: 20,
    onChunk: (chunk) => chunks.push(chunk)
  })

  t.alike(b4a.concat(chunks), content.subarray(10, 21), 'exact byte range read from WebDAV')
})
