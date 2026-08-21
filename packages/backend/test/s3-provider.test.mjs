import test from 'brittle'

import { createS3ArchiveProvider } from '../src/archive/s3-provider.js'

test('S3 archive provider uses signed requests and supports block lifecycle', async t => {
  const calls = []
  const objects = new Map()
  const provider = createS3ArchiveProvider({
    sign: async ({ operation, key }) => ({ url: `https://s3.test/${operation}/${key}`, headers: { Authorization: 'signed' } }),
    fetch: async (url, init = {}) => {
      calls.push({ url, init })
      const key = url.split('/').pop()
      if (init.method === 'HEAD') return { ok: objects.has(key), status: objects.has(key) ? 200 : 404 }
      if (init.method === 'PUT') {
        objects.set(key, init.body)
        return { ok: true, status: 200 }
      }
      if (init.method === 'DELETE') {
        objects.delete(key)
        return { ok: true, status: 204 }
      }
      return { ok: true, status: 200, arrayBuffer: async () => objects.get(key) }
    },
  })

  await provider.putBlock({ key: 'block-1', data: new Uint8Array([1, 2, 3]), contentHash: 'hash' })
  t.ok(await provider.hasBlock({ key: 'block-1' }))
  t.alike(new Uint8Array(await provider.getBlock({ key: 'block-1' })), new Uint8Array([1, 2, 3]))
  await provider.deleteBlock({ key: 'block-1' })
  t.is(await provider.hasBlock({ key: 'block-1' }), false)
  t.is(calls[0].init.headers.Authorization, 'signed')
  t.is(calls[0].init.headers['x-amz-checksum-sha256'], 'hash')
})
