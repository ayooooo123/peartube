// A guarded fetch (src/ssrf.js) must refuse a private host even when another, unguarded request to the same host
// left a kept-alive socket in the global agent's pool: a pooled socket is reused without a new DNS lookup, so the
// guard's lookup would never run. Runs under Node (`npm test`) and Bare (`bare test/ssrf.test.js`).
import proc from 'node:process'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

globalThis.process ??= proc
const { createAcquirer } = await import('../src/acquire.js')
const { send } = await import('../src/art.js')
const { addressReason } = await import('../src/ssrf.js')
const check = (cond, msg) => { if (!cond) throw new Error(msg) }
// Leaves one kept-alive socket to localhost:port in the global agent's free pool.
function prewarm (port) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: 'localhost', port, path: '/warm', headers: { connection: 'keep-alive' } }, res => {
      res.resume()
      res.on('end', () => setTimeout(resolve, 50))
    })
    req.on('error', reject)
    req.end()
  })
}

async function run (after) {
  check(addressReason('64:ff9b::a9fe:a9fe') === 'link-local', 'NAT64 cloud metadata is link-local')
  check(addressReason('64:ff9b::7f00:1') === 'loopback', 'NAT64 loopback is loopback')
  check(addressReason('64:ff9b::a00:1') === 'private', 'NAT64 RFC1918 is private')
  let nat64Err = null
  try { await send('http://[64:ff9b::a9fe:a9fe]/latest/meta-data/', { allowPrivate: true }) } catch (err) { nat64Err = err }
  check(nat64Err?.code === 'ERR_SSRF', `expected ERR_SSRF for NAT64 metadata even with allowPrivate, got ${nat64Err?.code || 'ok'}`)

  const hits = []
  const srv = createServer((req, res) => {
    hits.push(req.url)
    res.writeHead(200, { 'content-length': '2', connection: 'keep-alive' })
    res.end('ok')
  })
  srv.keepAliveTimeout = 10_000
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
  after(() => { srv.closeAllConnections?.(); srv.close() })
  const port = srv.address().port

  await prewarm(port)
  let sendErr = null
  try { await send(`http://localhost:${port}/send`, { allowPrivate: false }) } catch (err) { sendErr = err }
  check(sendErr?.code === 'ERR_SSRF', `expected ERR_SSRF from send, got ${sendErr?.code || 'ok'}`)

  await prewarm(port)
  // `put` opens the source the way the real one does (the factory at offset 0); nothing is stored.
  const node = { put: async (_meta, source) => { await source(0); throw new Error('stored') } }
  const acq = createAcquirer(node, join(mkdtempSync(join(os.tmpdir(), 'peartube-ssrf-')), 'jobs.json'), { allowPrivateUrls: false, retryDelay: 0 })
  after(() => acq.close())
  const job = acq.add({ id: 'clip:ssrfprobe', title: 'probe', source: { url: `http://localhost:${port}/acquire` } })
  const end = Date.now() + 10_000
  while (!['failed', 'done'].includes(acq.get(job.jobId).status) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50))
  check(acq.get(job.jobId).status === 'failed', `expected failed job, got ${acq.get(job.jobId).status}`)
  check(/Refusing to fetch/.test(acq.get(job.jobId).error || ''), `expected SSRF refusal, got ${acq.get(job.jobId).error}`)
  check(hits.length === 2 && hits.every(h => h === '/warm'), `no guarded request should reach private host, got ${JSON.stringify(hits)}`)
}

if (typeof Bare !== 'undefined') {
  const cleanups = []
  try {
    await run(fn => cleanups.push(fn))
    console.log('ok - a pooled socket to a private host does not bypass the guard (Bare)')
  } finally {
    for (const fn of cleanups.reverse()) fn()
  }
} else {
  const { default: test } = await import('node:test')
  test('a pooled socket to a private host does not bypass the guard', { timeout: 30_000 }, async t => {
    await run(fn => t.after(fn))
  })
}
