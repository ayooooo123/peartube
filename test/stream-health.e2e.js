// Stream health, the same file in two swarms, and feed items that converge on an existing core, on a local testnet.
// An announce's sha256 is only its publisher's claim, so every test here has a channel that lies about it.
//
// 1. Privacy: a viewer that follows channels publishing the same file reads no header and opens no core for a title
//    it does not hold; live health goes only to its owner, never to another site's page.
// 2. Failover: with the listed copy's publisher gone, the viewer streams exact bytes from the honest other copy and
//    never from a liar's core that claims the same sha256 and size; with only the liar left, it serves nothing.
// 3. Converge: a relay mirroring a feed item whose sha256 a followed channel claims copies that core only when the
//    whole copy hashes to the feed's digest (zero requests to the URL, the same core key); a liar's core is cleared
//    and the item downloads from its URL; with the publisher gone it falls back to the URL too.
// Writes desktop/target/e2e/stream-health-result.json.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { createAcquirer } from '../src/acquire.js'
import { createApi } from '../src/http.js'
import { createMirrorHost } from '../src/mirror.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'peartube-health-'))
// Feeds and acquire sources are loopback HTTP servers: opt in to private URLs (src/ssrf.js).
process.env.PEARTUBE_ALLOW_PRIVATE_URLS = '1'
const sha = b => createHash('sha256').update(b).digest('hex')
const result = { checks: {} }
const outDir = join(import.meta.dirname, '..', 'desktop', 'target', 'e2e')

async function until (fn, ms = 180_000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

async function apiFor (t, node) {
  const api = createApi({ node, acquirer: null })
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  t.after(() => api.close())
  const base = `http://127.0.0.1:${api.address().port}`
  return (key, headers = {}, extra = '') => fetch(`${base}/v1/entries/info?key=${encodeURIComponent(key)}${extra}`, { headers }).then(r => r.json())
}

// A channel that announces `honest`'s sha256 and size over different bytes.
async function publishLie (node, id, honest) {
  const op = await node.put({ id, title: 'Same File' }, Readable.from([randomBytes(honest.length)]))
  await node.append({ ...op, sha256: sha(honest) })
  return op
}

// A viewer following `publishers` in order (the first is the copy it lists), that has read the listed copy's first
// and last bytes while its publisher was online.
async function viewer (t, testnet, publishers, id, copies) {
  const v = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  for (const p of publishers) await v.addSource({ key: p.status().channel, kind: 'channel' })
  const info = await apiFor(t, v)
  const [hit] = await until(async () => {
    const list = await v.search(id)
    return list.length === 1 && (await info(list[0].key)).health?.otherCopies === copies && list
  })
  return { v, info, hit }
}

test.after(() => {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'stream-health-result.json'), JSON.stringify(result, null, 2))
})

test('the same file in other swarms: private by default, and playback moves only to a copy with the same bytes', { timeout: 300_000 }, async t => {
  const testnet = await createTestnet(3)
  const a = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const liar = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const c = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const closed = new Set()
  t.after(async () => { for (const n of [c, liar, a]) if (!closed.has(n)) await n.close(); await testnet.destroy() })

  const bytes = randomBytes(3 * 1024 * 1024 + 11)
  const id = 'imdb:tt0062622'
  const pubA = await a.publish({ id, title: 'Same File' }, Readable.from([bytes]))
  const lie = await publishLie(liar, id, bytes)
  const pubC = await c.publish({ id, title: 'Same File' }, Readable.from([bytes]))
  assert.notEqual(pubA.blobs, pubC.blobs, 'two uploads of one file are two cores')
  const { v, info, hit } = await viewer(t, testnet, [a, liar, c], id, 2)
  t.after(() => v.close())
  assert.equal((await v.findEntry(hit.key)).blobs, pubA.blobs, 'the first followed channel\'s copy is listed')

  const before = await info(hit.key)
  assert.equal(before.mediaDeferred, true, 'no header is read for a title this node does not hold')
  assert.equal(before.media, undefined)
  assert.equal(before.health.open, false, 'listing and asking open no core, so no peer learns the title is wanted')
  const foreign = await info(hit.key, { origin: 'http://evil.example' }, '&read=1')
  assert.equal('health' in foreign, false, 'another site\'s page gets no live numbers')
  assert.equal(foreign.mediaDeferred, true, 'and cannot make the relay read the header')
  assert.equal((await info(hit.key)).health.open, false)
  assert.equal(JSON.stringify(before).includes(c.peerKey), false, 'no peer key in the reply')
  result.checks.privateByDefault = { mediaDeferred: before.mediaDeferred, open: before.health.open, otherCopies: before.health.otherCopies }

  // The viewer starts watching while the listed copy's publisher is online: its first and last bytes.
  assert.deepEqual(Buffer.from(await (await fetch(hit.streamUrl, { headers: { Range: 'bytes=0-65535' } })).arrayBuffer()), bytes.subarray(0, 65536))
  assert.deepEqual(Buffer.from(await (await fetch(hit.streamUrl, { headers: { Range: 'bytes=-4096' } })).arrayBuffer()), bytes.subarray(bytes.length - 4096))

  closed.add(a)
  await a.close()
  // A malformed/tampered blob= query must not permanently poison the honest alternate before a real read arrives.
  const poisoned = new URL(hit.streamUrl)
  poisoned.searchParams.set('blob', `0:${Math.ceil(bytes.length / (512 * 1024))}:0:${bytes.length - 1}`)
  try { await fetch(poisoned, { headers: { Range: 'bytes=0-15' }, signal: AbortSignal.timeout(12_000) }) } catch {}
  const started = Date.now()
  const full = Buffer.from(await (await fetch(hit.streamUrl)).arrayBuffer())
  assert.equal(sha(full), sha(bytes), 'exact bytes: the honest copy, never poisoned by a bad blob= query and never the liar\'s core')
  const after = await info(hit.key)
  assert.equal(after.health.usingOtherCopy, true, 'health reports the copy that serves')
  assert.ok(after.health.peers >= 1)
  result.checks.failover = { fullReadMs: Date.now() - started, liarCore: lie.blobs, health: after.health }
})

test('with only a liar\'s copy left, the viewer serves no byte of it', { timeout: 300_000 }, async t => {
  const testnet = await createTestnet(3)
  const a = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const liar = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  let aClosed = false
  t.after(async () => { if (!aClosed) await a.close(); await liar.close(); await testnet.destroy() })

  const bytes = randomBytes(2 * 1024 * 1024 + 3)
  const id = 'imdb:tt0062623'
  await a.publish({ id, title: 'Same File' }, Readable.from([bytes]))
  await publishLie(liar, id, bytes)
  const { v, info, hit } = await viewer(t, testnet, [a, liar], id, 1)
  t.after(() => v.close())
  assert.deepEqual(Buffer.from(await (await fetch(hit.streamUrl, { headers: { Range: 'bytes=-4096' } })).arrayBuffer()), bytes.subarray(bytes.length - 4096))

  aClosed = true
  await a.close()
  // The read waits 5 s for the listed copy, proves the liar's tree different, refuses it, and then has no peer:
  // the blob server sends nothing (its headers go out with the first byte).
  let got = Buffer.alloc(0)
  try {
    const res = await fetch(hit.streamUrl, { headers: { Range: 'bytes=0-1048575' }, signal: AbortSignal.timeout(30_000) })
    for await (const chunk of res.body) got = Buffer.concat([got, chunk])
  } catch (err) {
    assert.equal(err.name, 'TimeoutError')
  }
  assert.equal(got.length, 0, 'no byte arrives: the only other copy is not the same file')
  const after = await info(hit.key)
  assert.equal(after.health.usingOtherCopy, false, 'the liar\'s core was never put in place')
  result.checks.liarOnly = { bytesServed: got.length, usingOtherCopy: after.health.usingOtherCopy }
})

test('a feed item a followed channel claims is copied only when its bytes match, else downloaded from its URL', { timeout: 300_000 }, async t => {
  const testnet = await createTestnet(3)
  const a = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const liar = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const relayStorage = tmp()
  const r = await createNode({ storage: relayStorage, bootstrap: testnet.bootstrap })
  let aClosed = false
  t.after(async () => { await r.close(); await liar.close(); if (!aClosed) await a.close(); await testnet.destroy() })

  const files = { first: randomBytes(2 * 1024 * 1024 + 5), second: randomBytes(1024 * 1024 + 3), third: randomBytes(1536 * 1024 + 9) }
  const pub1 = await a.publish({ id: 'imdb:tt0083658', title: 'First' }, Readable.from([files.first]))
  await a.publish({ id: 'imdb:tt0083659', title: 'Second' }, Readable.from([files.second]))
  const lie = await publishLie(liar, 'imdb:tt0083660', files.third)
  const hits = { first: 0, second: 0, third: 0 }
  const source = createServer((req, res) => {
    const name = req.url.slice(1)
    hits[name]++
    res.end(files[name])
  })
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve))
  t.after(() => source.close())
  const item = (name, id) => ({ id, title: name, sha256: sha(files[name]), url: `http://127.0.0.1:${source.address().port}/${name}` })

  await r.addSource({ key: a.status().channel, kind: 'channel' })
  await r.addSource({ key: liar.status().channel, kind: 'channel' })
  await until(async () => (await r.search('imdb:tt0083658')).length && (await r.search('imdb:tt0083659')).length && (await r.search('imdb:tt0083660')).length)
  const acquirer = createAcquirer(r, join(relayStorage, 'jobs.json'), { copyStall: 3000, retryDelay: 0 })
  t.after(() => acquirer.close())
  const mirror = await createMirrorHost({ node: r, storage: relayStorage, acquirer, pollIntervalMs: 0 })
  t.after(() => mirror.close())
  const own = async id => until(async () => (await r.search(id, { source: r.status().channel })).find(e => e.source === r.status().channel))
  const done = async run => until(() => acquirer.get(run.jobs[0].jobId)?.status === 'done' && acquirer.get(run.jobs[0].jobId))
  const kept = () => JSON.parse(readFileSync(join(relayStorage, 'kept-copies.json'), 'utf8'))

  const run1 = await mirror.run('feed-mirror', { items: [item('first', 'imdb:tt0083658')] })
  const job1 = await done(run1)
  assert.equal(hits.first, 0, 'the item\'s URL is never asked')
  assert.equal(job1.sha256, sha(files.first))
  assert.equal((await r.findEntry((await own('imdb:tt0083658')).key)).blobs, pub1.blobs, 'the relay\'s channel names the existing core')
  assert.ok(kept().includes(pub1.blobs), 'the copy is kept out of the cache ceiling')
  assert.equal((await mirror.run('feed-mirror', { items: [item('first', 'imdb:tt0083658')] })).enqueued, 0, 'and not copied twice')
  acquirer.cancel(job1.jobId)
  assert.equal(acquirer.get(job1.jobId), null, 'dismissed finished copy job')
  assert.equal((await mirror.run('feed-mirror', { items: [item('first', 'imdb:tt0083658')] })).enqueued, 0, 'a dismissed kept copy still counts as local and is not copied again')

  const run3 = await mirror.run('feed-mirror', { items: [item('third', 'imdb:tt0083660')] })
  const job3 = await done(run3)
  assert.equal(hits.third, 1, 'a copy whose bytes do not match the feed\'s digest gives way to the URL')
  assert.equal(job3.sha256, sha(files.third))
  const announced = await r.findEntry((await own('imdb:tt0083660')).key)
  assert.notEqual(announced.blobs, lie.blobs, 'the liar\'s core is never announced by this relay')
  assert.equal(kept().includes(lie.blobs), false, 'nor kept')

  aClosed = true
  await a.close()
  const job2 = await done(await mirror.run('feed-mirror', { items: [item('second', 'imdb:tt0083659')] }))
  assert.equal(hits.second, 1, 'with no peer holding it, the item downloads from its URL once')
  assert.equal(job2.sha256, sha(files.second))
  result.checks.converge = { copiedCore: pub1.blobs, urlHits: hits, liarCore: lie.blobs, announcedForLie: announced.blobs }
})
