// A relay restart used to throw away a half-downloaded film: `put()` minted a fresh core per attempt and purged it on
// any error, so a 60 GB remux started again at byte 0. This pins the resume path end to end: kill a transfer mid-flight,
// close the node (a real restart), reopen the same storage, and require the second attempt to ask for the remainder with
// a Range request, land the same sha256, and store byte-identical media.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import createTestnet from 'hyperdht/testnet.js'
import Hyperblobs from 'hyperblobs'
import b4a from 'b4a'
import { createNode } from '../src/index.js'
import { createAcquirer } from '../src/acquire.js'

const BLOCK = 512 * 1024
// hyperblobs appends only once 16 blocks are buffered, so a fixture smaller than that never lands one on disk.
const BATCH = 16 * BLOCK
const FILE = randomBytes(24 * 1024 * 1024 + 12345) // deliberately not block-aligned
const WANT = createHash('sha256').update(FILE).digest('hex')
// Long enough to cross the 64 MiB hash checkpoint, so the resume exercises a saved state rather than a read-back.
const BIG = randomBytes(96 * 1024 * 1024 + 12345)
const WANT_BIG = createHash('sha256').update(BIG).digest('hex')
const CHECKPOINT = 64 * 1024 * 1024

async function until (fn, ms = 90_000, label = 'condition') {
  const end = Date.now() + ms
  for (;;) {
    const val = await fn()
    if (val) return val
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

test('an interrupted acquisition resumes from the core, not from byte 0', { timeout: 180_000 }, async () => {
  const served = { bytes: 0, ranges: [], ifRanges: [] }
  const body = BIG
  const server = createServer((req, res) => {
    const range = /^bytes=(\d+)-(\d*)$/i.exec(req.headers.range || '')
    const start = range ? Number(range[1]) : 0
    const end = range && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1
    served.ranges.push(start)
    served.ifRanges.push(req.headers['if-range'] || null)
    res.writeHead(range ? 206 : 200, {
      'content-type': 'application/octet-stream',
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
      etag: '"resume-fixture"',
      ...(range ? { 'content-range': `bytes ${start}-${end}/${body.length}` } : {})
    })
    // Throttled so the first attempt can be killed mid-film instead of racing to the end.
    let at = start
    const pump = () => {
      if (res.destroyed || at > end) return res.end()
      const next = Math.min(at + 64 * 1024, end + 1)
      served.bytes += next - at
      res.write(body.subarray(at, next))
      at = next
      setTimeout(pump, 4)
    }
    pump()
    req.on('close', () => { res.destroyed = true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/dld/fixture?filename=Resume%20Me%20(2026).mkv`

  const testnet = await createTestnet(2)
  const storage = mkdtempSync(join(tmpdir(), 'peartube-resume-'))
  const jobsFile = join(storage, 'jobs.json')
  let pub = await createNode({ storage, bootstrap: testnet.bootstrap })

  try {
    let acq = createAcquirer(pub, jobsFile, { concurrency: 1, defaultChannel: true, retryDelay: 0 })
    acq.add({ id: 'imdb:tt9900001', title: 'Resume Me 2026', source: { url } })

    // Kill it once a couple of blocks are down.
    const killedAt = await until(() => {
      const job = acq.list()[0]
      return job?.bytes >= 70 * 1024 * 1024 ? job.bytes : 0
    }, 60_000, 'the first blocks to land')
    acq.close()
    await until(() => acq.list()[0]?.status === 'failed', 30_000, 'the interrupted attempt to settle')

    const saved = JSON.parse(readFileSync(jobsFile, 'utf8'))[0]
    assert.ok(saved.store, 'the job keeps its core name across a restart')
    assert.equal(saved.source?.url, url, 'the source survives so the job can continue')
    // The running hash rode along in the job, and continuing it must reproduce the whole film's digest.
    assert.ok(saved.hashState, 'the running sha256 state is checkpointed with the job')
    assert.ok(saved.hashBytes >= CHECKPOINT, `the checkpoint covers ${saved.hashBytes} bytes`)
    const sodium = (await import('sodium-native')).default
    const st = b4a.alloc(sodium.crypto_hash_sha256_STATEBYTES)
    st.set(b4a.from(saved.hashState, 'base64'))
    sodium.crypto_hash_sha256_update(st, body.subarray(saved.hashBytes))
    const dg = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
    sodium.crypto_hash_sha256_final(st, dg)
    assert.equal(b4a.toString(dg, 'hex'), WANT_BIG, 'the saved state continues into the whole film digest')
    const firstRunBytes = served.bytes
    assert.ok(firstRunBytes < body.length, 'the first attempt must not have finished')

    // A real restart: close the node and reopen the same storage.
    await pub.close()
    pub = await createNode({ storage, bootstrap: testnet.bootstrap })

    acq = createAcquirer(pub, jobsFile, { concurrency: 1, defaultChannel: true, retryDelay: 0 })
    const done = await until(() => {
      const job = acq.list()[0]
      if (job?.status === 'failed') throw new Error(`resume failed: ${job.error}`)
      return job?.status === 'done' ? job : null
    }, 120_000, 'the resumed job to finish')

    const resumedAt = served.ranges.find(start => start > 0)
    assert.ok(resumedAt, 'the second attempt asked for a Range, not the whole file')
    assert.equal(resumedAt % BLOCK, 0, 'resume lands on a block boundary')
    assert.equal(served.ifRanges.find(Boolean), '"resume-fixture"', 'the resume proves it is the same file with If-Range')
    assert.ok(resumedAt >= BATCH && resumedAt <= killedAt, `resumed at ${resumedAt} after ~${killedAt} bytes`)
    assert.ok(served.bytes < body.length + BATCH, `served ${served.bytes} bytes for a ${body.length}-byte film`)
    assert.equal(done.size, body.length)
    assert.equal(done.sha256, WANT_BIG, 'the resumed file hashes as the whole film')

    // `publicJob` hides the announce payload, so read it from the private job file the relay itself uses.
    const { announce } = JSON.parse(readFileSync(jobsFile, 'utf8'))[0]
    const core = await pub.blobCore(announce.blobs)
    const stored = await new Hyperblobs(core, { blockSize: BLOCK }).get(announce.blob)
    assert.equal(stored.length, body.length)
    assert.ok(b4a.equals(stored, body), 'the stored media is byte-identical to the source')
  } finally {
    await pub.close().catch(() => {})
    await new Promise(resolve => server.close(resolve))
    await testnet.destroy()
  }
})

// The danger a resume can introduce: a provider that swaps the encode behind the same link. Two halves of two different
// encodes stitch into a file that hashes cleanly against itself and plays garbage. The stored ETag refuses the splice.
test('a rotated source is fetched again, never stitched to the old half', { timeout: 180_000 }, async () => {
  const OTHER = randomBytes(FILE.length) // same length on purpose: only the validator can tell them apart
  const state = { body: FILE, etag: '"v1"' }
  const ranges = []
  const server = createServer((req, res) => {
    const m = /^bytes=(\d+)-(\d*)$/i.exec(req.headers.range || '')
    const start = m ? Number(m[1]) : 0
    const end = m && m[2] ? Math.min(Number(m[2]), state.body.length - 1) : state.body.length - 1
    ranges.push({ start, ifRange: req.headers['if-range'] || null })
    res.writeHead(m ? 206 : 200, {
      'content-type': 'application/octet-stream',
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
      etag: state.etag,
      ...(m ? { 'content-range': `bytes ${start}-${end}/${state.body.length}` } : {})
    })
    let at = start
    const pump = () => {
      if (res.destroyed || at > end) return res.end()
      const next = Math.min(at + 64 * 1024, end + 1)
      res.write(state.body.subarray(at, next))
      at = next
      setTimeout(pump, 8)
    }
    pump()
    req.on('close', () => { res.destroyed = true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/dld/fixture?filename=Rotated%20(2026).mkv`

  const testnet = await createTestnet(2)
  const storage = mkdtempSync(join(tmpdir(), 'peartube-rotate-'))
  const jobsFile = join(storage, 'jobs.json')
  let pub = await createNode({ storage, bootstrap: testnet.bootstrap })

  try {
    let acq = createAcquirer(pub, jobsFile, { concurrency: 1, defaultChannel: true, retryDelay: 20 })
    acq.add({ id: 'imdb:tt9900003', title: 'Rotated 2026', source: { url } })
    await until(() => (acq.list()[0]?.bytes || 0) >= 22 * BLOCK, 60_000, 'the first blocks to land')
    acq.close()
    await until(() => acq.list()[0]?.status === 'failed', 30_000, 'the interrupted attempt to settle')

    // The provider re-encodes the same title at the same length behind the same URL.
    state.body = OTHER
    state.etag = '"v2"'
    await pub.close()
    pub = await createNode({ storage, bootstrap: testnet.bootstrap })

    acq = createAcquirer(pub, jobsFile, { concurrency: 1, defaultChannel: true, retryDelay: 20 })
    const done = await until(() => {
      const job = acq.list()[0]
      if (job?.status === 'failed') throw new Error(`rotation handling failed: ${job.error}`)
      return job?.status === 'done' ? job : null
    }, 120_000, 'the rotated source to land intact')

    assert.equal(done.sha256, createHash('sha256').update(OTHER).digest('hex'), 'the film is the new encode, whole')
    assert.equal(done.size, OTHER.length)
    assert.ok(ranges.some(r => r.ifRange === '"v1"'), 'the resume offered the old validator')
    assert.ok(ranges.some(r => r.start === 0 && r.ifRange === null), 'the mismatched half was thrown away and refetched')
  } finally {
    await pub.close().catch(() => {})
    await new Promise(resolve => server.close(resolve))
    await testnet.destroy()
  }
})

// A crash between the last block and the announce leaves a complete core. Asking the source for `bytes=<size>-` answers
// 416, and a 416 used to purge the file; the finished core must be announced instead.
test('a core that finished without announcing is announced, not re-downloaded', { timeout: 120_000 }, async () => {
  const storage = mkdtempSync(join(tmpdir(), 'peartube-complete-'))
  const jobsFile = join(storage, 'jobs.json')
  const testnet = await createTestnet(2)
  const store = 'video:0123456789abcdef0123456789abcdef'
  let requests = 0
  const server = createServer((req, res) => { requests++; res.writeHead(500); res.end() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/dld/complete?filename=Complete%20(2026).mkv`
  let pub = await createNode({ storage, bootstrap: testnet.bootstrap })

  try {
    // The previous attempt wrote the whole film, then died before the announce.
    await pub.put({ id: 'imdb:tt9900004', title: 'Complete 2026', store, expectedSize: FILE.length }, Readable.from([FILE]))
    await pub.close()
    writeFileSync(jobsFile, JSON.stringify([{
      jobId: 'complete-job',
      id: 'imdb:tt9900004',
      title: 'Complete 2026',
      plugin: 'http-acquire',
      channel: true,
      private: false,
      status: 'queued',
      created: Date.now(),
      store,
      total: FILE.length,
      bytes: FILE.length,
      source: { url, headers: {}, page: false }
    }]))

    pub = await createNode({ storage, bootstrap: testnet.bootstrap })
    const acq = createAcquirer(pub, jobsFile, { concurrency: 1, defaultChannel: true, retryDelay: 20 })
    const done = await until(() => {
      const job = acq.list()[0]
      if (job?.status === 'failed') throw new Error(`finished core was not announced: ${job.error}`)
      return job?.status === 'done' ? job : null
    }, 60_000, 'the finished core to be announced')

    assert.equal(requests, 0, 'a finished core never touches the source again')
    assert.equal(done.sha256, WANT)
    assert.equal(done.size, FILE.length)
    const { announce } = JSON.parse(readFileSync(jobsFile, 'utf8'))[0]
    const core = await pub.blobCore(announce.blobs)
    const stored = await new Hyperblobs(core, { blockSize: BLOCK }).get(announce.blob)
    assert.ok(b4a.equals(stored, FILE), 'the announced media is the whole film')
  } finally {
    await pub.close().catch(() => {})
    await new Promise(resolve => server.close(resolve))
    await testnet.destroy()
  }
})

// A checkpoint can lag the core it belongs to (a crash between checkpoints). The committed gap must be folded into
// the running hash BEFORE the tail streams in, or the digest comes out in the wrong byte order: right length, wrong
// film. This pre-fills half the core with no checkpoint and resumes the other half from the source.
test('a checkpoint behind the core folds the gap in byte order', { timeout: 120_000 }, async () => {
  const FULL = randomBytes(48 * 1024 * 1024 + 999)
  const HALF = 48 * BLOCK // block-aligned so the fold starts on a block boundary
  const WANT_FULL = createHash('sha256').update(FULL).digest('hex')
  const storage = mkdtempSync(join(tmpdir(), 'peartube-fold-'))
  const jobsFile = join(storage, 'jobs.json')
  const store = 'video:fedcba9876543210fedcba9876543210'
  const ranges = []
  const server = createServer((req, res) => {
    const m = /^bytes=(\d+)-(\d*)$/i.exec(req.headers.range || '')
    const start = m ? Number(m[1]) : 0
    const end = m && m[2] ? Math.min(Number(m[2]), FULL.length - 1) : FULL.length - 1
    ranges.push(start)
    res.writeHead(m ? 206 : 200, {
      'content-type': 'application/octet-stream',
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
      ...(m ? { 'content-range': `bytes ${start}-${end}/${FULL.length}` } : {})
    })
    res.end(FULL.subarray(start, end + 1))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/dld/fold?filename=Folded%20(2026).mkv`
  const testnet = await createTestnet(2)
  let pub = await createNode({ storage, bootstrap: testnet.bootstrap })

  try {
    await pub.put({ id: 'imdb:tt9900005', title: 'Folded 2026', store, expectedSize: HALF }, Readable.from([FULL.subarray(0, HALF)]))
    await pub.close()
    writeFileSync(jobsFile, JSON.stringify([{
      jobId: 'fold-job',
      id: 'imdb:tt9900005',
      title: 'Folded 2026',
      plugin: 'http-acquire',
      channel: true,
      private: false,
      status: 'queued',
      created: Date.now(),
      store,
      total: FULL.length,
      bytes: HALF,
      source: { url, headers: {}, page: false }
    }]))

    pub = await createNode({ storage, bootstrap: testnet.bootstrap })
    const acq = createAcquirer(pub, jobsFile, { concurrency: 1, defaultChannel: true, retryDelay: 20 })
    const done = await until(() => {
      const job = acq.list()[0]
      if (job?.status === 'failed') throw new Error(`fold resume failed: ${job.error}`)
      return job?.status === 'done' ? job : null
    }, 90_000, 'the half-stored film to finish')

    assert.deepEqual(ranges, [HALF], 'only the missing half was fetched')
    assert.equal(done.sha256, WANT_FULL, 'the folded prefix and the tail hash in byte order')
    const { announce } = JSON.parse(readFileSync(jobsFile, 'utf8'))[0]
    const core = await pub.blobCore(announce.blobs)
    const stored = await new Hyperblobs(core, { blockSize: BLOCK }).get(announce.blob)
    assert.ok(b4a.equals(stored, FULL), 'the stored media is the whole film')
  } finally {
    await pub.close().catch(() => {})
    await new Promise(resolve => server.close(resolve))
    await testnet.destroy()
  }
})

// A throttled fixture that answers Range requests and records what the acquirer asked for.
async function serveFilm (body, etag, { chunk = 64 * 1024, delay = 4 } = {}) {
  const seen = { bytes: 0, ranges: [], ifRanges: [] }
  const server = createServer((req, res) => {
    const range = /^bytes=(\d+)-(\d*)$/i.exec(req.headers.range || '')
    const start = range ? Number(range[1]) : 0
    const end = range && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1
    seen.ranges.push(start)
    seen.ifRanges.push(req.headers['if-range'] || null)
    res.writeHead(range ? 206 : 200, {
      'content-type': 'application/octet-stream',
      'content-length': String(Math.max(0, end - start + 1)),
      'accept-ranges': 'bytes',
      etag,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${body.length}` } : {})
    })
    let at = start
    const pump = () => {
      if (res.destroyed || at > end) return res.end()
      const next = Math.min(at + chunk, end + 1)
      seen.bytes += next - at
      res.write(body.subarray(at, next))
      at = next
      setTimeout(pump, delay)
    }
    pump()
    req.on('close', () => { res.destroyed = true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, seen, url: `http://127.0.0.1:${server.address().port}/dld/fixture?filename=Fixture%20(2026).mkv` }
}

async function closeServer (server) {
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
}

// A job sits in `announcing` when the process dies between `put()` and `append()`: `source` is null then. `run()`
// still read `job.source.page`, threw before taking the job off `next()`'s list, and re-ran it forever — the relay
// came up wedged, announcing nothing and starting nothing else.
test('a job left announcing is announced instead of wedging the acquirer', { timeout: 120_000 }, async () => {
  const storage = mkdtempSync(join(tmpdir(), 'peartube-announcing-'))
  const jobsFile = join(storage, 'jobs.json')
  const testnet = await createTestnet(2)
  const store = 'video:aaaabbbbccccddddaaaabbbbccccdddd'
  let pub = await createNode({ storage, bootstrap: testnet.bootstrap })

  try {
    // The previous run wrote the whole film and died before the announce was appended.
    const announce = await pub.put({ id: 'imdb:tt9900006', title: 'Announcing 2026', store, expectedSize: FILE.length }, Readable.from([FILE]))
    await pub.close()
    writeFileSync(jobsFile, JSON.stringify([{
      jobId: 'announcing-job',
      id: 'imdb:tt9900006',
      title: 'Announcing 2026',
      plugin: 'http-acquire',
      channel: true,
      private: false,
      status: 'announcing',
      created: Date.now(),
      store,
      total: FILE.length,
      bytes: FILE.length,
      announce,
      source: null
    }]))

    pub = await createNode({ storage, bootstrap: testnet.bootstrap })
    const acq = createAcquirer(pub, jobsFile, { concurrency: 1, defaultChannel: true, retryDelay: 20 })
    // Returning at all is half the fix: the old `next()` spun here and no timer in the process ever ran again.
    await new Promise(resolve => setTimeout(resolve, 200))
    const done = await until(() => {
      const job = acq.list()[0]
      if (job?.status === 'failed') throw new Error(`announcing job failed: ${job.error}`)
      return job?.status === 'done' ? job : null
    }, 60_000, 'the announcing job to be appended')

    assert.equal(done.sha256, WANT)
    assert.equal(done.size, FILE.length)
    acq.close()
  } finally {
    await pub.close().catch(() => {})
    await testnet.destroy()
  }
})

// hyperblobs commits 8 MiB at a time, but the job's size and validator used to stay in memory until the first 64 MiB
// hash checkpoint. A crash in between left jobs.json with no `total`, so the reader could not tell where the film ended:
// it asked for the remainder forever and the resume died on "Truncated transfer".
test('a crash after the first batch resumes with the size the source gave', { timeout: 180_000 }, async () => {
  const body = BIG
  const film = await serveFilm(body, '"early-fixture"')
  const testnet = await createTestnet(2)
  const storage = mkdtempSync(join(tmpdir(), 'peartube-early-'))
  const jobsFile = join(storage, 'jobs.json')
  let pub = await createNode({ storage, bootstrap: testnet.bootstrap })
  let acq = null

  try {
    acq = createAcquirer(pub, jobsFile, { concurrency: 1, defaultChannel: true, retryDelay: 0 })
    acq.add({ id: 'imdb:tt9900007', title: 'Early 2026', source: { url: film.url } })
    const killedAt = await until(() => {
      const job = acq.list()[0]
      return job?.bytes >= 3 * BATCH ? job.bytes : 0
    }, 60_000, 'the first batches to be written')

    // What a crash (no close, no final save) would leave on disk, read while the transfer is still running.
    const crashing = JSON.parse(readFileSync(jobsFile, 'utf8'))[0]
    acq.close()
    await until(() => acq.list()[0]?.status === 'failed', 30_000, 'the interrupted attempt to settle')

    assert.ok(killedAt < CHECKPOINT, `killed at ${killedAt}, before the first hash checkpoint`)
    assert.equal(crashing.total, body.length, 'the size the source announced is durable')
    assert.equal(crashing.etag, '"early-fixture"', 'so is the validator a resume must offer')
    assert.ok(!crashing.hashState, 'no hash checkpoint had been taken yet')

    await pub.close()
    pub = await createNode({ storage, bootstrap: testnet.bootstrap })
    acq = createAcquirer(pub, jobsFile, { concurrency: 1, defaultChannel: true, retryDelay: 0 })
    const done = await until(() => {
      const job = acq.list()[0]
      if (job?.status === 'failed') throw new Error(`early resume failed: ${job.error}`)
      return job?.status === 'done' ? job : null
    }, 120_000, 'the film to finish after the early crash')

    assert.equal(done.size, body.length)
    assert.equal(done.sha256, WANT_BIG, 'the resumed film hashes whole')
    const resumedAt = film.seen.ranges.find(start => start > 0)
    assert.ok(resumedAt > 0 && resumedAt < body.length, `resumed at ${resumedAt}`)
    assert.equal(film.seen.ranges.filter(start => start === body.length).length, 0, 'never asked for bytes past the end')
    assert.equal(film.seen.ifRanges.find(Boolean), '"early-fixture"')
  } finally {
    acq?.close()
    await pub.close().catch(() => {})
    await closeServer(film.server)
    await testnet.destroy()
  }
})

// A queued job never reaches `run()`, so nothing dropped the half-written core an earlier attempt left under its name:
// cancelling it left the bytes on the disk for good.
test('cancelling a queued job purges the core it had already written', { timeout: 120_000 }, async () => {
  const storage = mkdtempSync(join(tmpdir(), 'peartube-cancel-'))
  const jobsFile = join(storage, 'jobs.json')
  const testnet = await createTestnet(2)
  const store = 'video:ccccddddeeeeffffccccddddeeeeffff'
  const HALF = 32 * BLOCK // two full hyperblobs batches, so they are committed
  const stall = createServer(() => {}) // answers nothing: the first job holds the only slot
  await new Promise(resolve => stall.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${stall.address().port}/dld/stall?filename=Stall%20(2026).mkv`
  let pub = await createNode({ storage, bootstrap: testnet.bootstrap })
  let acq = null

  try {
    // An earlier attempt wrote half the film, then the relay died.
    await assert.rejects(pub.put({ id: 'imdb:tt9900008', title: 'Cancelled 2026', store, expectedSize: BIG.length }, Readable.from([BIG.subarray(0, HALF)])))
    await pub.close()
    writeFileSync(jobsFile, JSON.stringify([
      {
        jobId: 'blocker', id: 'imdb:tt9900009', title: 'Blocker 2026', plugin: 'http-acquire', channel: true,
        private: false, status: 'queued', created: Date.now(), store: 'video:99998888777766669999888877776666',
        total: BIG.length, bytes: 0, source: { url, headers: {}, page: false }
      },
      {
        jobId: 'queued-cancel', id: 'imdb:tt9900008', title: 'Cancelled 2026', plugin: 'http-acquire', channel: true,
        private: false, status: 'queued', created: Date.now(), store,
        total: BIG.length, bytes: HALF, source: { url, headers: {}, page: false }
      }
    ]))

    pub = await createNode({ storage, bootstrap: testnet.bootstrap })
    const dropped = []
    const realDrop = pub.dropStore
    pub.dropStore = name => { dropped.push(name); return realDrop(name) }
    acq = createAcquirer(pub, jobsFile, { concurrency: 1, defaultChannel: true, retryDelay: 0 })
    await until(() => acq.list().find(job => job.jobId === 'blocker')?.status === 'running', 15_000, 'the blocker to take the slot')
    assert.equal(acq.get('queued-cancel').status, 'queued')

    const core = pub.store.get({ name: store, active: false })
    await core.ready()
    assert.equal(core.byteLength, HALF, 'the half from the earlier attempt is on disk')

    acq.cancel('queued-cancel')
    assert.deepEqual(dropped, [store], 'the cancelled job dropped its core')
    await until(() => core.byteLength === 0, 15_000, 'the half-written core to be purged')
  } finally {
    acq?.close()
    await pub.close().catch(() => {})
    await closeServer(stall)
    await testnet.destroy()
  }
})

// A checkpoint taken while the hasher runs is up to one hyperblobs batch ahead of what the core committed, and a
// resume throws an ahead state away: the whole prefix was read back into the hash. Every state handed out must cover
// bytes the core really holds.
test('a checkpoint never covers bytes the core has not committed', { timeout: 180_000 }, async () => {
  const body = BIG
  const film = await serveFilm(body, '"checkpoint-fixture"')
  const testnet = await createTestnet(2)
  const storage = mkdtempSync(join(tmpdir(), 'peartube-checkpoint-'))
  const jobsFile = join(storage, 'jobs.json')
  let pub = await createNode({ storage, bootstrap: testnet.bootstrap })
  let acq = null

  const probes = new Map()
  const committed = name => {
    if (!probes.has(name)) probes.set(name, pub.store.get({ name, active: false }))
    return probes.get(name).byteLength
  }
  const observed = []
  const realPut = pub.put
  // Watch every state the acquirer is handed, beside what the core had committed at that moment.
  pub.put = (meta, source, onData) => {
    const inner = meta.onHashState
    return realPut({
      ...meta,
      onHashState: (state, bytes) => {
        observed.push({ bytes, committed: committed(meta.store) })
        inner?.(state, bytes)
      }
    }, source, onData)
  }

  try {
    acq = createAcquirer(pub, jobsFile, { concurrency: 1, defaultChannel: true, retryDelay: 0 })
    acq.add({ id: 'imdb:tt9900010', title: 'Checkpoint 2026', source: { url: film.url } })
    const store = acq.list()[0].store
    await until(() => committed(store) >= CHECKPOINT + 4 * BLOCK, 90_000, 'the core to commit past the first checkpoint')
    acq.close()
    await until(() => acq.list()[0]?.status === 'failed', 30_000, 'the interrupted attempt to settle')

    const crashing = JSON.parse(readFileSync(jobsFile, 'utf8'))[0]
    const committedAtKill = committed(store)
    assert.ok(observed.length >= 1, 'the run checkpointed its hash at all')
    for (const seen of observed) {
      assert.ok(seen.bytes <= seen.committed, `a checkpoint at ${seen.bytes} ran ahead of the ${seen.committed} bytes the core held`)
    }
    assert.ok(crashing.hashState, 'the checkpoint survives the crash')
    assert.ok(crashing.hashBytes <= committedAtKill, `checkpoint ${crashing.hashBytes} is behind the core's ${committedAtKill}`)
    assert.ok(committedAtKill - crashing.hashBytes <= BATCH + 2 * BLOCK, `the resume folds ${committedAtKill - crashing.hashBytes} bytes, not one batch`)

    await pub.close()
    pub = await createNode({ storage, bootstrap: testnet.bootstrap })
    acq = createAcquirer(pub, jobsFile, { concurrency: 1, defaultChannel: true, retryDelay: 0 })
    const done = await until(() => {
      const job = acq.list()[0]
      if (job?.status === 'failed') throw new Error(`checkpoint resume failed: ${job.error}`)
      return job?.status === 'done' ? job : null
    }, 120_000, 'the film to finish from the committed checkpoint')

    assert.equal(done.size, body.length)
    assert.equal(done.sha256, WANT_BIG, 'the folded prefix and tail hash whole')
  } finally {
    acq?.close()
    await pub.close().catch(() => {})
    await closeServer(film.server)
    await testnet.destroy()
  }
})
