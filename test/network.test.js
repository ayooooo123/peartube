import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { createAcquirer } from '../src/acquire.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'peartube-test-'))

async function until (fn, ms = 60000) {
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

  const res = await fetch(hit.streamUrl, { headers: { Range: 'bytes=1000000-1065535' } })
  assert.equal(res.status, 206)
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes.subarray(1000000, 1065536))
  const full = Buffer.from(await (await fetch(hit.streamUrl)).arrayBuffer())
  assert.equal(createHash('sha256').update(full).digest('hex'), hit.sha256)
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
  const done = await until(() => acquirer.get(next.jobId).status === 'done' && acquirer.get(next.jobId), 20000)
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
