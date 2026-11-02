import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdtempSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import Autobee from 'autobee'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import { createNode } from '../src/index.js'
import { createAcquirer } from '../src/acquire.js'
import { createApi } from '../src/http.js'
import { createPrivateGuard } from '../src/private-overlay.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'peartube-test-'))

async function until (fn, ms = 120000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

async function network (t) {
  const testnet = await createTestnet(3)
  const a = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const b = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker: a.status().tracker })
  t.after(async () => { await a.close(); await b.close(); await testnet.destroy() })
  return { a, b }
}

test('a relay acquires a source; another relay finds it and streams exact bytes', async t => {
  const { a, b } = await network(t)
  const bytes = randomBytes(2 * 1024 * 1024 + 7)
  const source = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer source-secret')
    res.end(bytes)
  })
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve))
  t.after(() => source.close())

  const acquirer = createAcquirer(b, join(tmp(), 'jobs.json'))
  const job = acquirer.add({
    id: 'imdb:tt0111161',
    title: 'Fixture',
    source: { url: `http://127.0.0.1:${source.address().port}/file`, headers: { authorization: 'Bearer source-secret' } }
  })
  assert.equal('source' in job, false, 'job views never expose the source')
  const done = await until(() => acquirer.get(job.jobId).status === 'done' && acquirer.get(job.jobId))
  assert.equal(done.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(JSON.stringify(acquirer.list()).includes('source-secret'), false)

  const [hit] = await until(async () => (await a.search('imdb:tt0111161')).length && a.search('imdb:tt0111161'))
  assert.equal(hit.local, false)
  assert.equal(hit.sha256, done.sha256)

  const api = createApi({ node: a, acquirer: null })
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  t.after(() => api.close())
  const listed = await (await fetch(`http://127.0.0.1:${api.address().port}/v1/entries`)).json()
  assert.deepEqual(listed.results, [hit], 'the whole tracker lists the entry')

  const res = await fetch(hit.streamUrl, { headers: { Range: 'bytes=1000000-1065535' } })
  assert.equal(res.status, 206)
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes.subarray(1000000, 1065536))
  const full = Buffer.from(await (await fetch(hit.streamUrl)).arrayBuffer())
  assert.equal(createHash('sha256').update(full).digest('hex'), hit.sha256)
  const received = a.status()
  assert.ok(received.routes.public.rxBytes >= bytes.length, 'the public DHT stream carried the bytes')
  assert.equal(received.routes.private.rxBytes + received.routes.lan.rxBytes, 0, 'no private or LAN stream carried the bytes')
  assert.equal(received.rxBytes, received.routes.public.rxBytes, 'the path counters account for all received bytes')
})

test('a writer cannot remove another writer\'s entry', async t => {
  const { a, b } = await network(t)
  await b.publish({ id: 'imdb:tt0068646', title: 'Kept' }, Readable.from([randomBytes(1000)]))
  const [entry] = await until(async () => (await a.search('imdb:tt0068646')).length && a.search('imdb:tt0068646'))

  await a.remove(entry.key)
  await new Promise(resolve => setTimeout(resolve, 1000))
  assert.equal((await a.search('imdb:tt0068646')).length, 1)
  assert.equal((await b.search('imdb:tt0068646')).length, 1)

  await b.remove(entry.key)
  await until(async () => (await a.search('imdb:tt0068646')).length === 0)
})

test('a source that dies mid-transfer fails its job and does not block the next one', async t => {
  const { b } = await network(t)
  const good = randomBytes(300 * 1024)
  const source = createServer((req, res) => {
    if (req.url === '/broken') {
      res.writeHead(200, { 'content-length': String(10 * 1024 * 1024) })
      res.write(randomBytes(64 * 1024), () => res.socket.destroy())
    } else {
      res.end(good)
    }
  })
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve))
  t.after(() => source.close())
  const base = `http://127.0.0.1:${source.address().port}`

  const acquirer = createAcquirer(b, join(tmp(), 'jobs.json'))
  const broken = acquirer.add({ id: 'imdb:tt0000001', title: 'Broken', source: { url: `${base}/broken` } })
  const next = acquirer.add({ id: 'imdb:tt0000002', title: 'Next', source: { url: `${base}/good` } })
  await until(() => acquirer.get(broken.jobId).status === 'failed')
  const done = await until(() => acquirer.get(next.jobId).status === 'done' && acquirer.get(next.jobId))
  assert.equal(done.sha256, createHash('sha256').update(good).digest('hex'))
})

test('a malformed announce from a peer does not break anyone\'s tracker', async t => {
  const { a, b } = await network(t)
  const hostile = { type: 'announce', id: { toString: null, valueOf: null }, blobs: { toString: null }, sha256: 'x', title: 't', size: 1, blob: {} }
  await b.tracker.append(Buffer.from(JSON.stringify(hostile)), { optimistic: true })
  await a.publish({ id: 'imdb:tt0000003', title: 'After' }, Readable.from([randomBytes(500)]))
  const [hit] = await until(async () => (await b.search('imdb:tt0000003')).length && b.search('imdb:tt0000003'))
  assert.equal(hit.title, 'After')
  assert.equal(a.tracker.closed, false)
  assert.equal(b.tracker.closed, false)
})

test('relays keep publishing and converging after the founder goes offline', async t => {
  const testnet = await createTestnet(3)
  const a = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const tracker = a.status().tracker
  const b = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker })
  const c = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker })
  t.after(async () => { await b.close(); await c.close(); await testnet.destroy() })

  await a.publish({ id: 'imdb:tt0000010', title: 'Founder' }, Readable.from([randomBytes(100)]))
  await until(async () => (await b.search('imdb:tt0000010')).length && (await c.search('imdb:tt0000010')).length)
  await a.close()

  await b.publish({ id: 'imdb:tt0000011', title: 'B one' }, Readable.from([randomBytes(100)]))
  await b.publish({ id: 'imdb:tt0000012', title: 'B two' }, Readable.from([randomBytes(100)]))
  await c.publish({ id: 'imdb:tt0000013', title: 'C one' }, Readable.from([randomBytes(100)]))

  const ids = ['imdb:tt0000010', 'imdb:tt0000011', 'imdb:tt0000012', 'imdb:tt0000013']
  const sees = node => async () => (await Promise.all(ids.map(id => node.search(id)))).every(r => r.length === 1)
  await until(sees(b))
  await until(sees(c))
})

test('a new relay can publish twice before it has synced the tracker', async t => {
  const { a, b } = await network(t)
  await b.publish({ id: 'imdb:tt0000021', title: 'First' }, Readable.from([randomBytes(100)]))
  await b.publish({ id: 'imdb:tt0000022', title: 'Second' }, Readable.from([randomBytes(100)]))
  await until(async () => (await a.search('imdb:tt0000021')).length && (await a.search('imdb:tt0000022')).length)
})

test('an acquire finished before first sync survives a restart and is announced', async t => {
  const net = await createTestnet(3)
  const isolated = await createTestnet(3)
  const a = await createNode({ storage: tmp(), bootstrap: net.bootstrap })
  const tracker = a.status().tracker
  const bytes = randomBytes(200 * 1024)
  const source = createServer((req, res) => res.end(bytes))
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve))
  const dir = tmp()
  const jobsFile = join(dir, 'jobs.json')

  // B joins but cannot reach anyone: the file is stored, the announce cannot be durable yet.
  let b = await createNode({ storage: dir, bootstrap: isolated.bootstrap, tracker })
  let acquirer = createAcquirer(b, jobsFile)
  const job = acquirer.add({ id: 'imdb:tt0000031', title: 'Offline', source: { url: `http://127.0.0.1:${source.address().port}/` } })
  await until(() => acquirer.get(job.jobId).status === 'announcing')
  assert.notEqual(acquirer.get(job.jobId).status, 'done')
  await b.close()
  source.close()

  b = await createNode({ storage: dir, bootstrap: net.bootstrap, tracker })
  t.after(async () => { await a.close(); await b.close(); await net.destroy(); await isolated.destroy() })
  acquirer = createAcquirer(b, jobsFile)
  await until(() => acquirer.get(job.jobId).status === 'done')
  const [hit] = await until(async () => (await a.search('imdb:tt0000031')).length && a.search('imdb:tt0000031'))
  assert.equal(hit.sha256, createHash('sha256').update(bytes).digest('hex'))
})

test('a peer far ahead with a forging apply cannot hand its view to a new relay', async t => {
  const testnet = await createTestnet(3)
  const a = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const tracker = a.status().tracker
  await a.publish({ id: 'imdb:tt0000001', title: 'Honest' }, Readable.from([randomBytes(100)]))

  // M's apply forges an entry under A's writer key. Autobee's default
  // fast-forward would let a new relay adopt M's view without running apply.
  const zero = '0'.repeat(64)
  const blob = { blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 1 }
  const forgedKey = `imdb:tt6666666/${a.status().writer}/${zero}:0`
  const forged = JSON.stringify({ type: 'announce', id: 'imdb:tt6666666', title: 'Forged', size: 1, sha256: zero, blobs: zero, blob })
  async function forgingApply (nodes, view, host) {
    for (const node of nodes) {
      await host.addWriter(node.key, { isIndexer: false })
      const w = view.write()
      w.tryPut(Buffer.from(forgedKey), Buffer.from(forged))
      await w.flush()
    }
  }
  const mStore = new Corestore(tmp())
  const m = new Autobee(mStore.namespace('tracker'), Buffer.from(tracker, 'hex'), { apply: forgingApply, optimistic: true })
  await m.ready()
  const mSwarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  mSwarm.on('connection', conn => m.replicate(conn))
  mSwarm.join(m.discoveryKey)
  let c = null
  t.after(async () => { await c?.close(); await a.close(); await mSwarm.destroy(); await m.close(); await mStore.close(); await testnet.destroy() })

  // Well past Autobee's 32-flush fast-forward distance, each write durable.
  for (let i = 0; i <= 40; i++) {
    const before = m.local.length
    await m.append(Buffer.from(JSON.stringify({ type: 'announce', id: `imdb:tt${5000000 + i}`, title: 'M', size: 1, sha256: zero, blobs: zero, blob })), { optimistic: !m.writable })
    while (m.local.length <= before) { await new Promise(resolve => setTimeout(resolve, 300)); await m.update() }
  }
  assert.ok(await m.view.get(Buffer.from(forgedKey)), 'the forging peer built the forged view')

  c = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker })
  const forgedOn = async node => (await node.search('imdb:tt6666666')).length
  await until(async () => (await c.search('imdb:tt0000001')).length || await forgedOn(c), 120000)
  assert.equal(await forgedOn(c), 0, 'the new relay adopted a view with a forged entry')
  await until(async () => (await c.search('imdb:tt5000040')).length, 120000)
  assert.equal(await forgedOn(c), 0)
})

test('ten peers with 2-hop private routing sync the tracker and stream exact bytes over stateless guards', async t => {
  const testnet = await createTestnet(4)
  const guards = await Promise.all([
    createPrivateGuard({ host: '127.0.0.1', bootstrap: testnet.bootstrap }),
    createPrivateGuard({ host: '127.0.0.1', bootstrap: testnet.bootstrap })
  ])
  const founder = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, privateRouting: true })
  const tracker = founder.status().tracker
  const rest = await Promise.all(Array.from({ length: 9 }, () =>
    createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker, privateRouting: true })
  ))
  const nodes = [founder, ...rest]
  t.after(async () => {
    await Promise.all(nodes.map(n => n.close()))
    await Promise.all(guards.map(g => g.close()))
    await testnet.destroy()
  })
  const bytes = randomBytes(2 * 1024 * 1024 + 13)
  const expectedSha = createHash('sha256').update(bytes).digest('hex')
  const chunks = Array.from({ length: Math.ceil(bytes.length / 8192) }, (_, i) => bytes.subarray(i * 8192, (i + 1) * 8192))
  const published = await nodes[9].publish({ id: 'imdb:tt0133093', title: 'Private Matrix' }, Readable.from(chunks))
  assert.equal(published.blob.blockLength, 5, 'small source chunks are coalesced into 512 KiB Hypercore blocks')

  const [hit] = await until(async () => (await nodes[0].search('imdb:tt0133093')).length && nodes[0].search('imdb:tt0133093'))
  assert.equal(hit.local, false)
  assert.equal(hit.sha256, expectedSha)

  const range = await fetch(hit.streamUrl, { headers: { Range: 'bytes=500000-1048575' } })
  assert.equal(range.status, 206)
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(500000, 1048576))

  const full = Buffer.from(await (await fetch(hit.streamUrl)).arrayBuffer())
  assert.equal(createHash('sha256').update(full).digest('hex'), expectedSha)
  for (const n of nodes) {
    assert.equal(n.swarm.dht.privateRouting.exposureReport().directDestinationSends, 0)
    assert.equal(n.swarm.status(n.tracker.discoveryKey), null, 'private routing uses a blinded rotating topic, never tracker.discoveryKey')
  }
})

test('clearCache flushes RocksDB WAL and BlobDB so on-disk corestore bytes shrink immediately', async t => {
  const { readdirSync, statSync } = await import('node:fs')
  const dirBytes = dir => readdirSync(dir, { withFileTypes: true }).reduce((sum, f) => {
    const p = join(dir, f.name)
    return sum + (f.isDirectory() ? dirBytes(p) : statSync(p).size)
  }, 0)

  const testnet = await createTestnet(3)
  const pubDir = tmp()
  const viewDir = tmp()
  const pub = await createNode({ storage: pubDir, bootstrap: testnet.bootstrap })
  const viewer = await createNode({ storage: viewDir, bootstrap: testnet.bootstrap, tracker: pub.status().tracker })
  t.after(async () => { await viewer.close(); await pub.close(); await testnet.destroy() })

  const payload = randomBytes(16 * 1024 * 1024)
  await pub.publish({ id: 'imdb:tt0816692', title: 'Interstellar' }, Readable.from([payload]))
  const [hit] = await until(async () => (await viewer.search('imdb:tt0816692')).length && viewer.search('imdb:tt0816692'))
  const downloaded = Buffer.from(await (await fetch(hit.streamUrl)).arrayBuffer())
  assert.equal(downloaded.byteLength, payload.byteLength)

  const beforeDisk = dirBytes(join(viewDir, 'corestore', 'db'))
  assert.ok(beforeDisk >= 16 * 1024 * 1024, `expected >= 16 MiB on disk before clearCache, got ${beforeDisk}`)

  const res = await viewer.clearCache()
  const afterDisk = dirBytes(join(viewDir, 'corestore', 'db'))
  assert.ok(res.reclaimedBytes >= 14 * 1024 * 1024, `expected >= 14 MiB reclaimed, got ${res.reclaimedBytes}`)
  assert.ok(afterDisk < 1024 * 1024, `expected < 1 MiB on disk after clearCache compaction, got ${afterDisk}`)
  assert.equal(viewer.status().cachedBytes, 0)
})

test('streaming cache cleanup reclaims the spent prefix in one call without stalling the live tail', { timeout: 240_000 }, async t => {
  const testnet = await createTestnet(3)
  const source = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const viewDir = tmp()
  const viewer = await createNode({ storage: viewDir, bootstrap: testnet.bootstrap, tracker: source.status().tracker })
  t.after(async () => { await viewer.close(); await source.close(); await testnet.destroy() })

  // Big enough to span several ~64 MiB blob files, as a film does: streaming cleanup drops the ones fully spent.
  const bytes = randomBytes(256 * 1024 * 1024)
  const published = await source.publish({ id: 'imdb:tt0209144', title: 'Memento' }, Readable.from([bytes]))
  const [entry] = await until(async () => (await viewer.search('imdb:tt0209144')).length && viewer.search('imdb:tt0209144'))
  assert.deepEqual(Buffer.from(await (await fetch(entry.streamUrl)).arrayBuffer()), bytes)
  const initial = viewer.status().cachedBytes
  assert.equal(initial, bytes.length)
  const diskBytes = dir => readdirSync(dir, { withFileTypes: true }).reduce((sum, f) => {
    const p = join(dir, f.name)
    return sum + (f.isDirectory() ? diskBytes(p) : statSync(p).size)
  }, 0)
  const dbDir = join(viewDir, 'corestore', 'db')
  await viewer.gcStorage()
  const beforeDisk = diskBytes(dbDir)

  const keepBehind = 8 * 1024 * 1024
  const tailStart = bytes.length - keepBehind
  const range = `bytes=${bytes.length - 524288}-${bytes.length - 1}`
  let probing = true
  let probes = 0
  let slowestRangeMs = 0
  const probeStarts = []
  const liveTail = (async () => {
    while (probing) {
      const start = performance.now()
      probeStarts.push(start)
      const response = await fetch(entry.streamUrl, { headers: { Range: range } })
      assert.equal(response.status, 206)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(bytes.length - 524288))
      slowestRangeMs = Math.max(slowestRangeMs, performance.now() - start)
      probes++
      await new Promise(resolve => setTimeout(resolve, 75))
    }
  })()
  let remaining = initial
  const cleanupStarted = performance.now()
  try {
    await viewer.evictBehind(published.blobs, published.blob, { playheadByte: bytes.length - 524288, keepBehindBytes: keepBehind })
    remaining = viewer.status().cachedBytes
  } finally {
    probing = false
    await liveTail
  }
  const cleanupEnded = performance.now()
  const cadence = [cleanupStarted, ...probeStarts.filter(at => at > cleanupStarted), cleanupEnded]
  const slowestCadenceMs = Math.max(...cadence.slice(1).map((at, i) => at - cadence[i]))
  assert.ok(remaining <= 16 * 1024 * 1024, 'one cleanup keeps pace: it reclaims the whole spent prefix')

  assert.ok(probes > 0, 'concurrent Range requests reached the active receiver')
  assert.ok(slowestRangeMs < 2500, `live cached Range stalled for ${Math.round(slowestRangeMs)} ms during cleanup`)
  assert.ok(slowestCadenceMs < 750, `live receiver made no new Range attempt for ${Math.round(slowestCadenceMs)} ms`)
  const afterDisk = diskBytes(dbDir)
  assert.ok(beforeDisk - afterDisk >= 96 * 1024 * 1024, `cleanup must reclaim physical BlobDB bytes, not just clear a bitfield (${beforeDisk - afterDisk})`)

  const tail = await fetch(entry.streamUrl, { headers: { Range: `bytes=${tailStart}-${bytes.length - 1}` } })
  assert.equal(tail.status, 206)
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(tailStart))
  assert.equal(viewer.status().cachedBytes, remaining, 'the protected playhead tail was already local')
  const artifactDir = join('desktop', 'target', 'e2e')
  mkdirSync(artifactDir, { recursive: true })
  writeFileSync(join(artifactDir, 'cache-reclaim-result.json'), JSON.stringify({
    publishedSha256: published.sha256,
    cachedBefore: initial,
    cachedAfter: remaining,
    diskBytesBefore: beforeDisk,
    diskBytesAfter: afterDisk,
    concurrentRanges: probes,
    slowestRangeMs: Math.round(slowestRangeMs),
    cleanupMs: Math.round(cleanupEnded - cleanupStarted),
    slowestCadenceMs: Math.round(slowestCadenceMs)
  }, null, 2) + '\n')
})

test('acquirer strips cross-origin auth on redirect, resumes mid-stream resets and stalls via Range, dead-letters 403s, and never triggers live-blob rewrite', async t => {
  const testnet = await createTestnet(3)
  const aDir = tmp()
  const bDir = tmp()
  const a = await createNode({ storage: aDir, bootstrap: testnet.bootstrap })
  const b = await createNode({ storage: bDir, bootstrap: testnet.bootstrap, tracker: a.status().tracker })
  t.after(async () => { await a.close(); await b.close(); await testnet.destroy() })

  // Seed a foreign clip on `a` and pull it into `b`'s cache first so we prove `acquire` never wipes peer cache
  // and explicit `b.clearCache()` reclaims foreign cache without relocating `b`'s owned `.blob` files.
  const foreignBytes = randomBytes(8 * 1024 * 1024)
  await a.publish({ id: 'imdb:tt0000040', title: 'Foreign Cache Clip' }, Readable.from([foreignBytes]))
  const [foreignHit] = await until(async () => (await b.search('imdb:tt0000040')).length && b.search('imdb:tt0000040'))
  assert.equal((await (await fetch(foreignHit.streamUrl)).arrayBuffer()).byteLength, foreignBytes.byteLength)
  assert.equal(b.status().cachedBytes, foreignBytes.byteLength)

  const bytes = randomBytes(1536 * 1024 + 19)
  let cdnHits = 0
  let forbiddenHits = 0

  const cdn = createServer((req, res) => {
    // Presigned S3/R2 edges reject leaked cross-origin Authorization headers or missing User-Agents with 403.
    if (req.headers.authorization || !String(req.headers['user-agent'] || '').startsWith('VLC/')) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    cdnHits++
    if (cdnHits === 1) {
      assert.equal(req.headers.range, undefined)
      res.writeHead(200, { 'content-length': String(bytes.length), 'accept-ranges': 'bytes', etag: '"v1"' })
      res.write(bytes.subarray(0, 700 * 1024), () => res.socket.destroy())
      return
    }
    const m = String(req.headers.range || '').match(/^bytes=(\d+)-$/)
    assert.ok(m, `expected Range header on reconnect #${cdnHits}`)
    const start = Number(m[1])
    assert.equal(req.headers['if-range'], '"v1"')
    if (cdnHits === 2) {
      // Hang before headers arrive (un-flushed upstream seek): openSource times out inside readResumable without purging.
      return
    }
    if (cdnHits === 3) {
      res.writeHead(502)
      res.end('upstream hiccup')
      return
    }
    res.writeHead(206, {
      'content-length': String(bytes.length - start),
      'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
      etag: '"v1"'
    })
    res.flushHeaders()
    if (cdnHits === 4) {
      // Simulate a Usenet skipReader seek (> 1x stallTimeout before byte 1), then 400 KiB followed by a mid-body stall.
      const timer = setTimeout(() => { if (!res.destroyed) res.write(bytes.subarray(start, start + 400 * 1024)) }, 260)
      timer.unref?.()
      return
    }
    res.end(bytes.subarray(start))
  })
  await new Promise(resolve => cdn.listen(0, '127.0.0.1', resolve))
  t.after(() => { cdn.closeAllConnections?.(); cdn.close() })

  const gateway = createServer((req, res) => {
    if (req.url === '/forbidden') {
      forbiddenHits++
      res.writeHead(403)
      res.end('denied')
      return
    }
    assert.equal(req.headers.authorization, 'Bearer one-shot-secret')
    res.writeHead(302, { location: `http://127.0.0.1:${cdn.address().port}/video.mkv` })
    res.end()
  })
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
  t.after(() => { gateway.closeAllConnections?.(); gateway.close() })

  const jobsFile = join(tmp(), 'jobs.json')
  const acquirer = createAcquirer(b, jobsFile, { concurrency: 1, retryDelay: 100, stallTimeout: 200 })
  t.after(() => acquirer.close())
  const gwBase = `http://127.0.0.1:${gateway.address().port}`

  const dead = acquirer.add({ id: 'imdb:tt0000041', title: 'Dead 403', source: { url: `${gwBase}/forbidden` } })
  const resumed = acquirer.add({
    id: 'imdb:tt0000042',
    title: 'Resumed Film',
    source: { url: `${gwBase}/source`, headers: { Authorization: 'Bearer one-shot-secret' } }
  })

  await until(() => acquirer.get(dead.jobId)?.status === 'failed')
  const done = await until(() => acquirer.get(resumed.jobId)?.status === 'done' && acquirer.get(resumed.jobId))
  await new Promise(resolve => setTimeout(resolve, 350))

  assert.equal(forbiddenHits, 1, 'terminal 403 must not loop retries or starve queued jobs')
  assert.equal(cdnHits, 5, 'initial open + header-timeout Range retry + 502 Range retry + slow-seek/stall Range retry + finish')
  assert.equal(done.attempts, undefined, 'Range reconnect hiccups must never purge the partial core or burn job attempts')
  assert.equal(done.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(b.status().cachedBytes, foreignBytes.byteLength, 'acquire must never wipe foreign cached peer blobs')
  const savedDead = JSON.parse(readFileSync(jobsFile, 'utf8')).find(j => j.jobId === dead.jobId)
  assert.equal(savedDead.source, null, 'terminal 403 clears stored source so restarts never resurrect it')

  const [hit] = await until(async () => (await a.search('imdb:tt0000042')).length && a.search('imdb:tt0000042'))
  const streamed = Buffer.from(await (await fetch(hit.streamUrl)).arrayBuffer())
  assert.equal(createHash('sha256').update(streamed).digest('hex'), done.sha256)

  // Flush `b`'s owned `.blob` file to disk, then prove `b.clearCache()` clears the foreign cache without rewriting live `.blob` files.
  await b.gcStorage()
  const bDb = join(bDir, 'corestore', 'db')
  const blobsBefore = readdirSync(bDb).filter(f => f.endsWith('.blob')).sort()
  assert.ok(blobsBefore.length > 0, 'expected owned blob files on disk after flush')
  const cleared = await b.clearCache()
  assert.equal(cleared.clearedBytes, foreignBytes.byteLength)
  assert.equal(b.status().cachedBytes, 0)
  const blobsAfterClear = readdirSync(bDb).filter(f => f.endsWith('.blob')).sort()
  assert.equal(blobsAfterClear.some(f => blobsBefore.includes(f)), true, 'owned live .blob file must not be relocated into new blob files during clearCache')
  const noopClear = await b.clearCache()
  assert.deepEqual(noopClear, { clearedBytes: 0, reclaimedBytes: 0 })
  assert.deepEqual(readdirSync(bDb).filter(f => f.endsWith('.blob')).sort(), blobsAfterClear, 'zero-byte clearCache must be a complete RocksDB no-op')

  const artifactDir = join('desktop', 'target', 'e2e')
  mkdirSync(artifactDir, { recursive: true })
  writeFileSync(join(artifactDir, 'acquire-resilience-result.json'), JSON.stringify({
    sha256: done.sha256,
    bytes: bytes.length,
    cdnHits,
    forbiddenHits,
    blobsBefore,
    blobsAfterClear
  }, null, 2) + '\n')
})
