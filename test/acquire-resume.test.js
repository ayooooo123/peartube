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
