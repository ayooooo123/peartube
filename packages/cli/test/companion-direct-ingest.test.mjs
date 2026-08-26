import test from 'brittle'
import b4a from 'b4a'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createIngestJobStore } from '../src/companion/ingest-job-store.js'
import { createIngestManager } from '../src/companion/ingest-manager.js'
import { decodeIngestJobBody } from '../src/companion/contracts.js'
import { createSourceProviderRegistry } from '../src/companion/sources/index.js'
import { createGrantedRangedSource } from '../src/archive-manager.js'

function fakeBee ({ failFlush = false, beforeGet = null, afterFlush = null } = {}) {
  const map = new Map()
  const clone = value => JSON.parse(JSON.stringify(value))
  return {
    map,
    async get (key) {
      await beforeGet?.(key)
      return map.has(key) ? { value: clone(map.get(key)) } : null
    },
    batch () {
      const operations = []
      return {
        async put (key, value) { operations.push(['put', key, clone(value)]) },
        async del (key) { operations.push(['del', key]) },
        async flush () {
          if (failFlush) throw new Error(`database exploded ${'secret'.repeat(1000)}`)
          for (const [operation, key, value] of operations) {
            if (operation === 'put') map.set(key, value)
            else map.delete(key)
          }
          await afterFlush?.()
        }
      }
    },
    async * createReadStream ({ gte, lt } = {}) {
      for (const key of [...map.keys()].sort()) {
        if (gte !== undefined && key < gte) continue
        if (lt !== undefined && key >= lt) continue
        yield { key, value: clone(map.get(key)) }
      }
    }
  }
}

function fakePublisher (onConsumedBytes = () => {}) {
  const videos = new Map()
  const id = value => createHash('sha256').update(String(value)).digest('hex')
  return {
    videos,
    async ensureAnonymousChannel () {
      return {
        channelId: 'test-channel',
        channelKey: id('channel-key-001'),
        publisherId: id('publisher-id-001'),
        publicBeeKey: id('publicbee-key-001'),
        channel: {
          async getVideo (videoId) { return videos.get(videoId) || null }
        }
      }
    },
    async importVideo (opts) {
      const videoId = opts.videoId
      const immutablePublication = {
        publicationId: id(`publication-${videoId}`),
        manifestId: id(`manifest-${videoId}`),
        renditionId: id(`rendition-${videoId}`),
        assetId: id(`asset-${videoId}`),
        coreKey: id(`core-${videoId}`),
        manifest: { publicationId: id(`publication-${videoId}`), body: { renditions: [] } }
      }
      const metadata = { id: videoId, immutablePublication }
      videos.set(videoId, metadata)

      // REAL consumption of the granted ranged source!
      if (opts.sourceGrant) {
        const rangedSource = createGrantedRangedSource({
          ...opts.sourceGrant,
          signal: opts.signal
        })
        const chunks = []
        for await (const chunk of rangedSource.open(0)) {
          chunks.push(chunk)
        }
        const fullBytes = b4a.concat(chunks)
        onConsumedBytes(fullBytes)
      }
      return { success: true, metadata, result: { publicationId: immutablePublication.publicationId } }
    },
    async retainAssets () {}
  }
}

function validMovieRequest (bytes, patch = {}) {
  return {
    retentionClass: 'archive-pin',
    mediaContext: {
      kind: 'movie',
      namespace: 'tmdb',
      identifier: '284053'
    },
    measuredFacts: {
      title: 'Thor: Ragnarok',
      byteLength: bytes.byteLength,
      durationMs: 7_800_000,
      container: 'mkv',
      videoCodec: 'hevc',
      width: 3840,
      height: 2160
    },
    expected: {
      byteLength: bytes.byteLength,
      etag: '"torbox-direct-etag"'
    },
    ...patch
  }
}

test('contracts.js decodes sourceDescriptor in ingest job body', (t) => {
  const body = JSON.stringify({
    idempotencyKey: 'test-job-001',
    request: {
      mediaContext: { kind: 'movie', namespace: 'tmdb', identifier: '284053' },
      measuredFacts: { title: 'Thor: Ragnarok', byteLength: 1000, container: 'mkv', durationMs: 1000, videoCodec: 'h264', width: 1920, height: 1080 },
      expected: { byteLength: 1000, etag: '"284053"' },
      retentionClass: 'archive-pin'
    },
    sourceDescriptor: {
      provider: 'torbox',
      torrentId: 83683870,
      fileId: 0
    }
  })

  const decoded = decodeIngestJobBody(body)
  t.is(decoded.idempotencyKey, 'test-job-001')
  t.is(decoded.sourceDescriptor.provider, 'torbox')
  t.is(decoded.sourceDescriptor.torrentId, 83683870)
  t.is(decoded.sourceDescriptor.fileId, 0)
})

test('direct TorBox ingest job completes, streams bytes and publishes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'peartube-direct-torbox-'))
  const spoolRoot = join(root, 'spool')
  mkdirSync(spoolRoot, { recursive: true })
  t.teardown(() => rmSync(root, { recursive: true, force: true }))

  const fileBytes = b4a.from('Direct TorBox media data streamed directly from CDN into Hypercore!')
  const cdnUrl = 'https://cdn.torbox.app/download/direct-test-stream'

  const fetchImpl = async (url, init = {}) => {
    if (url.includes('/torrents/requestdl')) {
      return {
        ok: true,
        status: 200,
        async json () { return { success: true, data: cdnUrl } }
      }
    }
    if (url === cdnUrl && init.method === 'HEAD') {
      return {
        ok: true,
        status: 200,
        headers: new Map([
          ['content-length', String(fileBytes.byteLength)],
          ['content-type', 'video/mp4'],
          ['etag', '"torbox-direct-etag"']
        ])
      }
    }
    if (url === cdnUrl) {
      return {
        ok: true,
        status: 206,
        headers: new Map([['content-length', String(fileBytes.byteLength)]]),
        async arrayBuffer () {
          return fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength)
        }
      }
    }
    throw new Error(`Unexpected request: ${url}`)
  }

  const sourceRegistry = createSourceProviderRegistry({
    config: {
      sources: {
        torbox: { apiKey: 'test-key-123' }
      }
    },
    fetchImpl
  })

  let consumedBytes = null
  const manager = createIngestManager({
    store: createIngestJobStore({ bee: fakeBee() }),
    publisher: fakePublisher((bytes) => { consumedBytes = bytes }),
    spoolRoot,
    sourceRegistry,
    canIngest: () => true
  })

  await manager.start()

  const submitRes = await manager.submitJob({
    idempotencyKey: 'torbox-direct-001',
    request: validMovieRequest(fileBytes),
    sourceDescriptor: {
      provider: 'torbox',
      torrentId: 83683870,
      fileId: 0
    }
  })

  t.is(submitRes.jobId.startsWith('ing_'), true, 'jobId generated')

  let current = await manager.getJob(submitRes.jobId)
  for (let i = 0; i < 30; i++) {
    if (current.state === 'completed' || current.state === 'failed') break
    await new Promise(r => setTimeout(r, 50))
    current = await manager.getJob(submitRes.jobId)
  }

  t.is(current.state, 'completed', 'job completed via direct TorBox ingest')
  t.is(current.errorCode, null, 'no error code')
  t.alike(consumedBytes, fileBytes, 'publisher consumed byte-identical TorBox stream')

  await manager.close()
})

test('direct local file ingest job completes, streams bytes and publishes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'peartube-direct-file-'))
  const spoolRoot = join(root, 'spool')
  mkdirSync(spoolRoot, { recursive: true })
  const filePath = join(root, 'video.mkv')
  const fileBytes = b4a.from('Direct local disk media bytes read via file descriptor at disk speed!')
  writeFileSync(filePath, fileBytes)
  t.teardown(() => rmSync(root, { recursive: true, force: true }))

  const sourceRegistry = createSourceProviderRegistry()
  const headProbe = await sourceRegistry.getFileClient().head({ filePath })

  let consumedBytes = null
  const manager = createIngestManager({
    store: createIngestJobStore({ bee: fakeBee() }),
    publisher: fakePublisher((bytes) => { consumedBytes = bytes }),
    spoolRoot,
    sourceRegistry,
    canIngest: () => true
  })

  await manager.start()

  const submitRes = await manager.submitJob({
    idempotencyKey: 'file-direct-001',
    request: validMovieRequest(fileBytes, {
      mediaContext: { kind: 'movie', namespace: 'tmdb', identifier: '1184918' },
      measuredFacts: { title: 'The Wild Robot', byteLength: fileBytes.byteLength, durationMs: 6_000_000, container: 'mkv', videoCodec: 'hevc', width: 3840, height: 2160 },
      expected: { byteLength: fileBytes.byteLength, etag: headProbe.etag }
    }),
    sourceDescriptor: {
      provider: 'file',
      filePath
    }
  })

  let current = await manager.getJob(submitRes.jobId)
  for (let i = 0; i < 30; i++) {
    if (current.state === 'completed' || current.state === 'failed') break
    await new Promise(r => setTimeout(r, 50))
    current = await manager.getJob(submitRes.jobId)
  }
  if (current.state !== 'completed') {
    t.fail(`job did not complete: state=${current.state} errorCode=${current.errorCode}`)
  }
  t.is(current.state, 'completed', 'job completed via direct local file ingest')
  t.is(current.errorCode, null, 'no error code')
  t.alike(consumedBytes, fileBytes, 'publisher consumed byte-identical local file stream')

  await manager.close()
})
