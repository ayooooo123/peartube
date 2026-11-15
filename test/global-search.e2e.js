// Global search (src/search.js) on a local HyperDHT testnet: a searcher that follows nothing finds media on a relay
// it has never met, by words in any order, and plays it from that relay; the relay offers only public files it holds
// whole and has checked are media; junk frames leave the connection working; the relay rate-limits and can stop
// answering; a privately routed node refuses; a searcher closes what it dialed a minute after its last search.
// Writes desktop/target/e2e/global-search-result.json.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import Protomux from 'protomux'
import c from 'compact-encoding'
import b4a from 'b4a'
import { createNode } from '../src/index.js'
import { createMirrorHost } from '../src/mirror.js'
import { createPrivateGuard } from '../src/private-overlay.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'peartube-search-'))
const sha = buf => createHash('sha256').update(buf).digest('hex')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until (fn, ms = 120_000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error('timed out')
    await sleep(500)
  }
}

async function publish (node, id, title, bytes, opts = {}) {
  const op = await node.put({ id, title, ...opts }, Readable.from([bytes]))
  await node.append(op)
  return op
}

// A Matroska file as far as its first bytes go; random after that.
const mkv = size => { const b = randomBytes(size); b.set([0x1a, 0x45, 0xdf, 0xa3], 0); return b }

test('global search finds, checks, plays and tears down', { timeout: 420_000 }, async t => {
  const result = { startedAt: new Date().toISOString() }
  const testnet = await createTestnet(3)
  const closers = []
  t.after(async () => {
    for (const close of closers.reverse()) await close().catch(() => {})
    await testnet.destroy()
  })
  const open = async opts => {
    const node = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, ...opts })
    closers.push(() => node.close())
    return node
  }

  // The relay: a film, a non-media file with a matching title, a private film, and a followed channel's title it
  // holds no copy of.
  const relayStorage = tmp()
  const relay = await createNode({ storage: relayStorage, bootstrap: testnet.bootstrap })
  closers.push(() => relay.close())
  const film = mkv(3 * 1024 * 1024 + 11)
  const filmOp = await publish(relay, 'imdb:tt0079944', 'Stalker (1979)', film)
  const junk = randomBytes(1024 * 1024)
  junk[0] = 0x00
  const junkOp = await publish(relay, 'clip:stalkerjunk', 'Stalker 1979 notes', junk)
  const privateOp = await publish(relay, 'clip:stalkerprivate', 'Stalker 1979 private cut', mkv(600 * 1024), { private: true })
  const other = await open()
  await publish(other, 'clip:stalkerelsewhere', 'Stalker 1979 elsewhere', mkv(700 * 1024))
  await relay.addSource({ key: other.status().channel, kind: 'channel', alias: 'other' })
  await until(async () => (await relay.search(null, { query: 'elsewhere' })).length)

  const mirror = await createMirrorHost({ node: relay, storage: relayStorage, acquirer: null, mirrorChannel: false, mediaCheck: true, pollIntervalMs: 0 })
  closers.push(() => mirror.close())
  await until(async () => (await mirror.run('media-check')).checked === 0 && mirror.list().find(p => p.name === 'media-check').checkedFiles >= 2, 30_000)
  const checkedFile = join(relayStorage, 'media-checked.json')
  const checked = JSON.parse(readFileSync(checkedFile, 'utf8')).checked
  const keyOf = op => `${op.blobs}:${op.blob.blockOffset}`
  assert.equal(statSync(checkedFile).mode & 0o777, 0o600, 'media-checked.json is private')
  assert.equal(checked[keyOf(filmOp)], true, 'the film is media')
  assert.equal(checked[keyOf(junkOp)], false, 'the non-media file is not')
  assert.equal(keyOf(privateOp) in checked, false, 'a private file is never read for search')
  result.mediaChecked = checked
  relay.serveSearch({ isMedia: key => mirror.isMedia(key) })

  // A searcher that follows nothing finds the film, words in any order, through the search topic.
  const searcher = await open()
  const t0 = Date.now()
  const rows = await until(async () => {
    const r = await searcher.searchGlobal({ query: '1979 stalker' })
    return r.length && r
  })
  result.firstHitMs = Date.now() - t0
  result.rows = rows
  assert.deepEqual(rows.map(r => r.id), ['imdb:tt0079944'], 'only the checked, public, held film is offered')
  assert.equal(rows[0].sha256, filmOp.sha256)
  assert.equal(rows[0].magnetUrl.includes('source='), false, 'a hit never names a channel')
  assert.equal((await searcher.searchGlobal({ id: 'imdb:tt0079944' })).length, 1, 'a media id finds it too')

  // It plays from the relay that answered.
  const played = await searcher.openUri(rows[0].magnetUrl)
  const bytes = Buffer.from(await (await fetch(played.entry.streamUrl)).arrayBuffer())
  assert.equal(sha(bytes), filmOp.sha256, 'the played hit is the exact file')
  result.playedSha256 = sha(bytes)

  // Junk on the search channel neither closes the connection nor stops the relay answering on it.
  const prober = await open()
  const conn = await prober.connectPeer(relay.peerKey, { timeoutMs: 90_000 })
  const replies = new Map()
  let opened
  const openedP = new Promise(resolve => { opened = resolve })
  const channel = Protomux.from(conn).createChannel({ protocol: 'peartube/search/v1', onopen: () => opened(true), onclose: () => opened(false) })
  const raw = channel.addMessage({ encoding: c.raw, onmessage: buf => { try { const m = c.decode(c.json, buf); replies.set(m.id, m) } catch {} } })
  channel.open()
  assert.equal(await openedP, true, 'a relay that answers takes the channel')
  raw.send(b4a.alloc(70 * 1024, 0x61))
  raw.send(c.encode(c.json, [1]))
  raw.send(c.encode(c.json, 42))
  raw.send(b4a.from([5, 0x7b, 0x7b, 0x7b]))
  const ask = id => raw.send(c.encode(c.json, { id, type: 'search', q: 'stalker' }))
  ask(1)
  const first = await until(() => replies.get(1), 10_000)
  assert.equal(first.ok, true)
  assert.equal(first.result.hits.length, 1)
  assert.equal(conn.destroyed, false, 'junk frames left the connection open')
  for (let id = 2; id <= 5; id++) ask(id)
  const fifth = await until(() => replies.get(5), 10_000)
  assert.deepEqual({ ok: fifth.ok, error: fifth.error }, { ok: false, error: 'busy' }, 'the fifth query in 10 s is refused')
  const probed = await prober.openUri(first.result.hits[0].uri)
  const probedBytes = Buffer.from(await (await fetch(probed.entry.streamUrl)).arrayBuffer())
  assert.equal(sha(probedBytes), filmOp.sha256, 'a download on the same connection still works')

  // Turned off, the relay closes its search channels and refuses new ones.
  relay.serveSearch(null)
  await until(() => channel.closed, 10_000)
  const refused = await new Promise(resolve => {
    const ch = Protomux.from(conn).createChannel({ protocol: 'peartube/search/v1', onopen: () => resolve(false), onclose: () => resolve(true) })
    assert.ok(ch, 'the closed channel left room for a new one')
    ch.open()
  })
  assert.equal(refused, true, 'a relay that stopped answering refuses the channel')
  relay.serveSearch({ isMedia: key => mirror.isMedia(key) })

  // A privately routed node never searches.
  const guards = []
  for (let i = 0; i < 2; i++) guards.push(await createPrivateGuard({ host: '127.0.0.1', bootstrap: testnet.bootstrap }))
  closers.push(() => Promise.all(guards.map(g => g.close())))
  const hidden = await open({ privateRouting: true })
  await assert.rejects(hidden.searchGlobal({ query: 'stalker' }), /routed privately/)

  // A searcher that only searched closes its search connection a minute after its last search.
  const idle = await open()
  await until(async () => (await idle.searchGlobal({ query: 'stalker' })).length)
  const relayKey = b4a.from(relay.peerKey, 'hex')
  const toRelay = () => [...idle.peerConnections()].filter(cn => !cn.destroyed && cn.remotePublicKey && b4a.equals(cn.remotePublicKey, relayKey)).length
  assert.ok(toRelay() >= 1, 'the search connected to the relay')
  await sleep(65_000)
  assert.equal(toRelay(), 0, 'no search-only connection is left after the idle time')

  result.finishedAt = new Date().toISOString()
  mkdirSync('desktop/target/e2e', { recursive: true })
  writeFileSync('desktop/target/e2e/global-search-result.json', JSON.stringify(result, null, 2))
})
