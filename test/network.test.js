import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
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
  await b.publish({ id: 'imdb:tt0068646', title: 'Kept' }, [randomBytes(1000)])
  const [entry] = await until(async () => (await a.search('imdb:tt0068646')).length && a.search('imdb:tt0068646'))

  await a.remove(entry.key)
  await new Promise(resolve => setTimeout(resolve, 1000))
  assert.equal((await a.search('imdb:tt0068646')).length, 1)
  assert.equal((await b.search('imdb:tt0068646')).length, 1)

  await b.remove(entry.key)
  await until(async () => (await a.search('imdb:tt0068646')).length === 0)
})
