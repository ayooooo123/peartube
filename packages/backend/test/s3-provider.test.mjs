import test from 'brittle'

import { createS3ArchiveProvider } from '../src/archive/s3-provider.js'
import { createRemoteBlockStore } from '../src/archive/remote-block-store.js'
import { createHash } from 'node:crypto'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

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

  const body = new Uint8Array([1, 2, 3])
  const checksum = createHash('sha256').update(body).digest('base64')
  await provider.putBlock({ key: 'block-1', data: body, checksumSha256Base64: checksum })
  t.ok(await provider.hasBlock({ key: 'block-1' }))
  t.alike(new Uint8Array(await provider.getBlock({ key: 'block-1' })), new Uint8Array([1, 2, 3]))
  await provider.deleteBlock({ key: 'block-1' })
  t.is(await provider.hasBlock({ key: 'block-1' }), false)
  t.is(calls[0].init.headers.Authorization, 'signed')
  t.is(calls[0].init.headers['x-amz-checksum-sha256'], checksum, 'the checksum is forwarded verbatim')
  t.is(checksum, 'A5BYxvLAy0ksUzsKTRTvd8wPeKvMztUofYShogEc+4E=', 'and it is a real 32-byte SHA-256 digest in base64')
})

test('the remote block store sends a checksum S3 will actually accept', async t => {
  // Regression: this sent a hex Hypercore leaf hash, which is neither base64
  // nor SHA-256. Backblaze rejected every upload with `400 InvalidDigest`, so
  // block offload could not store a single block.
  const seen = []
  const store = createRemoteBlockStore({
    provider: {
      async putBlock (input) { seen.push(input); return { success: true, key: input.key } },
      async getBlock () { throw new Error('not used') }
    },
    coreKey: 'a'.repeat(64)
  })

  const data = b4a.from('a block of media bytes')
  await store.put(0, data)

  const expected = createHash('sha256').update(data).digest('base64')
  t.is(seen.length, 1, 'the block was handed to the provider once')
  t.is(seen[0].checksumSha256Base64, expected, 'as the base64 of a real SHA-256 digest')
  t.absent(/^[0-9a-f]{64}$/i.test(seen[0].checksumSha256Base64), 'never a hex digest')
  t.not(seen[0].checksumSha256Base64, b4a.toString(crypto.data(data), 'hex'), 'and never the Hypercore leaf hash')
})

test('a transient blip is retried, a permanent refusal is not', async t => {
  // Archiving one title is hundreds of block requests. Without a retry a single
  // reset connection failed the whole archive - observed live as a bare
  // `fetch failed` part way through a 20 MiB title.
  const sign = async ({ key }) => ({ url: 'https://s3/' + key, headers: {} })

  let networkCalls = 0
  const flaky = createS3ArchiveProvider({
    sign,
    bucket: 'b',
    fetch: async () => {
      networkCalls++
      if (networkCalls < 3) throw new Error('fetch failed')
      return { ok: true, status: 200 }
    }
  })
  await flaky.putBlock({ key: 'block-1' })
  t.is(networkCalls, 3, 'the put was attempted until it landed')
  const flakyStatus = flaky.getStatus()
  t.is(flakyStatus.requests, 1, 'and still counts as one request')
  t.is(flakyStatus.retries, 2, 'with the blips visible as retries')
  t.is(flakyStatus.failures, 0, 'not as failures')
  t.ok(flakyStatus.healthy, 'so an absorbed blip never marks the provider unhealthy')

  let refusals = 0
  const refused = createS3ArchiveProvider({
    sign,
    bucket: 'b',
    fetch: async () => { refusals++; return { ok: false, status: 400 } }
  })
  await t.exception(refused.putBlock({ key: 'block-2' }), /HTTP 400/)
  t.is(refusals, 1, 'a 400 is the caller\'s fault and is never retried')
  t.absent(refused.getStatus().healthy, 'and it does count against health')

  let unavailable = 0
  const flapping = createS3ArchiveProvider({
    sign,
    bucket: 'b',
    fetch: async () => { unavailable++; return { ok: false, status: 503 } }
  })
  await t.exception(flapping.putBlock({ key: 'block-3' }), /HTTP 503/)
  t.is(unavailable, 4, 'a 503 is retried, but not forever')

  let heads = 0
  const empty = createS3ArchiveProvider({
    sign,
    bucket: 'b',
    fetch: async () => { heads++; return { ok: false, status: 404 } }
  })
  t.is(await empty.hasBlock({ key: 'absent' }), false, 'an absent block is a normal answer')
  t.is(heads, 1, 'so asking about it costs exactly one request')
})
