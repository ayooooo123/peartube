// Global search (src/search.js) on a local HyperDHT testnet: a searcher that follows nothing finds media on a relay
// it has never met, by words in any order, and plays it from that relay; the relay offers only public files it holds
// whole and has checked are media; hostile frames on peartube/search/v2 leave the channel answering and the connection
// working; the relay rate-limits and can stop answering; a peer on the old protocol is refused on both sides; relays
// announce only the v2 topic; a privately routed node refuses; a searcher closes what it dialed a minute after its
// last search.
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
import hypercoreCrypto from 'hypercore-crypto'
import { getEncoding } from '../spec/hyperschema/index.js'
import { SEARCH } from '../spec/protocols.js'
import { createNode } from '../src/index.js'
import { createMirrorHost } from '../src/mirror.js'
import { createPrivateGuard } from '../src/private-overlay.js'
import { SEARCH_TOPIC } from '../src/search.js'
import { serveChannel } from '../src/control-channel.js'

const FRAME = getEncoding('@peartube/frame')
const QUERY = getEncoding('@peartube/search-query')
const HITS = getEncoding('@peartube/search-hits')
const REMOTE_ERROR = getEncoding('@peartube/remote-error')

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
  // Titles whose fold differs by script, for the searches below.
  const yolkaOp = await publish(relay, 'clip:yolka', 'Ёлка (2024)', mkv(600 * 1024))
  const odosOp = await publish(relay, 'clip:odos', 'Οδός (2020)', mkv(600 * 1024))
  const isikOp = await publish(relay, 'clip:isik', 'IŞIK (2021)', mkv(600 * 1024))
  const other = await open()
  await publish(other, 'clip:stalkerelsewhere', 'Stalker 1979 elsewhere', mkv(700 * 1024))
  await relay.addSource({ key: other.status().channel, kind: 'channel', alias: 'other' })
  await until(async () => (await relay.search(null, { query: 'elsewhere' })).length)

  const mirror = await createMirrorHost({ node: relay, storage: relayStorage, acquirer: null, mirrorChannel: false, mediaCheck: true, pollIntervalMs: 0 })
  closers.push(() => mirror.close())
  await until(async () => (await mirror.run('media-check')).checked === 0 && mirror.list().find(p => p.name === 'media-check').checkedFiles >= 5, 30_000)
  const checkedFile = join(relayStorage, 'media-checked.json')
  const checked = JSON.parse(readFileSync(checkedFile, 'utf8')).checked
  const keyOf = op => `${op.blobs}:${op.blob.blockOffset}`
  assert.equal(statSync(checkedFile).mode & 0o777, 0o600, 'media-checked.json is private')
  assert.equal(checked[keyOf(filmOp)], true, 'the film is media')
  assert.equal(checked[keyOf(junkOp)], false, 'the non-media file is not')
  assert.equal(checked[keyOf(yolkaOp)], true, 'a Cyrillic title is media')
  assert.equal(checked[keyOf(odosOp)], true, 'a Greek title is media')
  assert.equal(checked[keyOf(isikOp)], true, 'a Turkish title is media')
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

  // A file the relay gets after a search that missed it shows up when the same search is asked again.
  assert.deepEqual(await searcher.searchGlobal({ query: 'solaris' }), [], 'nothing matches yet')
  const lateOp = await publish(relay, 'imdb:tt0069293', 'Solaris (1972)', mkv(800 * 1024))
  await until(async () => { await mirror.run('media-check'); return mirror.isMedia(keyOf(lateOp)) }, 30_000)
  const t1 = Date.now()
  const late = await until(async () => {
    const r = await searcher.searchGlobal({ query: 'solaris' })
    return r.length && r
  }, 60_000)
  result.lateHitMs = Date.now() - t1
  assert.deepEqual(late.map(r => r.id), ['imdb:tt0069293'], 'the same search finds the file published after it')

  // Titles fold by script (src/search.js): Latin and Greek accents go, Turkish's two i's fold together, and a
  // Cyrillic mark that is a letter is kept. Wait out the relay's 10 s query window first.
  await sleep(10_000)
  const folded = {
    cyrMarked: await searcher.searchGlobal({ query: 'ёлка' }),
    cyrPlain: await searcher.searchGlobal({ query: 'елка' }),
    greek: await searcher.searchGlobal({ query: 'οδοσ' }),
    turkish: await searcher.searchGlobal({ query: 'ışık' })
  }
  assert.deepEqual(folded.cyrMarked.map(r => r.id), ['clip:yolka'], 'a Cyrillic title finds its own mark')
  assert.deepEqual(folded.cyrPlain.map(r => r.id), [], 'a Cyrillic mark is a letter, not an accent')
  assert.deepEqual(folded.greek.map(r => r.id), ['clip:odos'], 'a Greek final sigma folds to sigma')
  assert.deepEqual(folded.turkish.map(r => r.id), ['clip:isik'], "Turkish's two i's fold together")
  result.fold = Object.fromEntries(Object.entries(folded).map(([name, rows]) => [name, rows.map(r => r.id)]))

  // It plays from the relay that answered.
  const played = await searcher.openUri(rows[0].magnetUrl)
  const bytes = Buffer.from(await (await fetch(played.entry.streamUrl)).arrayBuffer())
  assert.equal(sha(bytes), filmOp.sha256, 'the played hit is the exact file')
  result.playedSha256 = sha(bytes)

  // Hostile frames on the relay's search channel are dropped or answered; none closes the connection, and the relay
  // keeps answering on the channel. (Fails before v2: the relay spoke JSON on peartube/search/v1.)
  const prober = await open()
  const conn = await prober.connectPeer(relay.peerKey, { timeoutMs: 90_000 })
  const rawChannel = protocol => {
    const frames = new Map()
    let opened
    const openedP = new Promise(resolve => { opened = resolve })
    const channel = Protomux.from(conn).createChannel({ protocol, onopen: () => opened(true), onclose: () => opened(false) })
    const msg = channel.addMessage({ encoding: c.raw, onmessage: buf => { const f = c.decode(FRAME, buf); frames.set(f.id, f) } })
    channel.open()
    return { channel, frames, opened: openedP, send: buf => msg.send(buf) }
  }
  const frame = (kind, op, id, value) => c.encode(FRAME, { kind, op, id, value })
  const query = (id, q, limit = 20) => frame(0, 0, id, c.encode(QUERY, { q, mid: '', limit }))
  const errorOf = f => c.decode(REMOTE_ERROR, f.value)
  const varint53 = b4a.from([0xff, 0, 0, 0, 0, 0, 0, 0x20, 0])
  const probe = rawChannel(SEARCH.protocol)
  assert.equal(await probe.opened, true, 'a relay that answers takes the channel')
  probe.send(b4a.alloc(70 * 1024, 0x61)) // over the frame cap
  probe.send(b4a.concat([varint53, b4a.from([0, 1, 0])])) // kind at 2^53
  probe.send(b4a.concat([b4a.from([0]), varint53, b4a.from([1, 0])])) // op at 2^53
  probe.send(b4a.concat([b4a.from([0, 0]), varint53, b4a.from([0])])) // id at 2^53
  probe.send(frame(4, 0, 90, b4a.alloc(0))) // kind 4
  probe.send(query(0, 'stalker')) // id 0
  probe.send(frame(0, 0, 91, b4a.from([0xff]))) // a value that does not decode
  const askedUnknown = Date.now()
  probe.send(frame(0, 7, 92, b4a.alloc(0))) // an op search does not have
  assert.equal(errorOf(await until(() => probe.frames.get(91), 10_000)).code, 'DECODE_ERROR')
  assert.equal(errorOf(await until(() => probe.frames.get(92), 10_000)).code, 'UNKNOWN_OP')
  assert.ok(Date.now() - askedUnknown < 1000, 'an unknown op is answered at once')
  assert.equal(probe.frames.has(90) || probe.frames.has(0), false, 'kind 4 and id 0 are not answered')
  probe.send(query(1, 'stalker'))
  const first = await until(() => probe.frames.get(1), 10_000)
  assert.equal(first.kind, 1)
  const firstHits = c.decode(HITS, first.value).hits
  assert.equal(firstHits.length, 1)
  assert.equal(conn.destroyed, false, 'junk frames left the connection open')
  for (let id = 2; id <= 5; id++) probe.send(query(id, 'stalker'))
  const fifth = await until(() => probe.frames.get(5), 10_000)
  assert.deepEqual({ kind: fifth.kind, ...errorOf(fifth) }, { kind: 2, code: 'HANDLER_ERROR', message: 'busy' }, 'the fifth query in 10 s is refused')
  const probed = await prober.openUri(firstHits[0].uri)
  const probedBytes = Buffer.from(await (await fetch(probed.entry.streamUrl)).arrayBuffer())
  assert.equal(sha(probedBytes), filmOp.sha256, 'a download on the same connection still works')

  // Turned off, the relay closes its search channels and refuses new ones.
  relay.serveSearch(null)
  await until(() => probe.channel.closed, 10_000)
  assert.equal(await rawChannel(SEARCH.protocol).opened, false, 'a relay that stopped answering refuses the channel')
  relay.serveSearch({ isMedia: key => mirror.isMedia(key) })

  // Eight undecodable frames close that channel, never the connection; a new channel on it is answered with the hit.
  // (Turning answering off and on above cleared the rate windows.)
  const noisy = rawChannel(SEARCH.protocol)
  assert.equal(await noisy.opened, true)
  for (let i = 0; i < 8; i++) noisy.send(b4a.from([0xff]))
  await until(() => noisy.channel.closed, 10_000)
  const fresh = rawChannel(SEARCH.protocol)
  assert.equal(await fresh.opened, true, 'the relay takes a new search channel on the same connection')
  const hitsOf = async id => {
    const f = await until(() => fresh.frames.get(id), 10_000)
    assert.equal(f.kind, 1, `query ${id} is answered with hits`)
    return c.decode(HITS, f.value).hits.map(h => h.uri)
  }
  fresh.send(query(1, 'stalker'))
  assert.deepEqual(await hitsOf(1), [firstHits[0].uri], 'and answers on it with the hit')
  // limit 0 is the default 20, as released; limit 1 is one. 'imdb' matches both films.
  fresh.send(query(2, 'imdb', 0))
  assert.equal((await hitsOf(2)).length, 2, 'limit 0 means the default')
  fresh.send(query(3, 'imdb', 1))
  assert.equal((await hitsOf(3)).length, 1)
  assert.equal(conn.destroyed, false, 'the connection stays open')

  // A peer on the old version: a v1 asker is refused by the relay and the connection stays; a v1-only peer gets no
  // frame from a new searcher. (Fails before v2: both sides spoke peartube/search/v1.)
  assert.equal(await rawChannel('peartube/search/v1').opened, false, 'the relay refuses the old protocol name')
  assert.equal(conn.destroyed, false)
  const oldPeer = await open()
  let oldOpens = 0
  let v2Asked = 0
  oldPeer.onConnection(cn => {
    const mux = Protomux.from(cn)
    mux.pair({ protocol: 'peartube/search/v1' }, () => { oldOpens++ })
    // Counted, and refused: nothing opens this side's half.
    mux.pair({ protocol: SEARCH.protocol }, () => { v2Asked++ })
  })
  const toOld = await searcher.connectPeer(oldPeer.peerKey, { timeoutMs: 90_000 })
  const mixed = await searcher.searchGlobal({ query: 'roadside picnic' })
  assert.deepEqual(mixed, [], 'no rows from a peer that only speaks the old version')
  assert.ok(v2Asked >= 1, 'the searcher asked it on peartube/search/v2, and was refused')
  assert.equal(oldOpens, 0, 'the old-version peer never sees a search channel')
  assert.equal(toOld.destroyed, false, 'and the connection to it stays')

  // A hit's link is at most 2,048 bytes of UTF-8, not 2,048 characters: a relay's link of about 1,650 characters
  // with accented letters (2 bytes each) is dropped, one that fits in bytes is kept.
  const accented = (name, letters) => `peartube://watch/${randomBytes(32).toString('hex')}:0:1:0:1000?id=clip:${name}&sha256=${'ab'.repeat(32)}&title=${'é'.repeat(letters)}`
  const over = accented('accentover', 1_500)
  const under = accented('accentunder', 900)
  assert.ok(over.length <= 2048 && b4a.byteLength(over) > 2048 && b4a.byteLength(under) <= 2048)
  const fake = await open()
  fake.onConnection(cn => serveChannel(cn, { spec: SEARCH, label: 'Searcher', handlers: { query: () => ({ hits: [{ uri: over }, { uri: under }] }) } }))
  await searcher.connectPeer(fake.peerKey, { timeoutMs: 90_000 })
  const accentRows = await until(async () => {
    const r = await searcher.searchGlobal({ query: 'accent' })
    return r.length && r
  }, 30_000)
  assert.deepEqual(accentRows.map(r => r.id), ['clip:accentunder'], 'a link over 2,048 bytes is dropped')

  // Relays announce, and searchers look up, only the v2 topic.
  assert.ok(b4a.equals(SEARCH_TOPIC, hypercoreCrypto.hash(b4a.from('peartube/search/v2/0'))))
  const announced = async topic => {
    const keys = new Set()
    for await (const reply of testnet.nodes[0].lookup(topic)) for (const peer of reply.peers) keys.add(b4a.toString(peer.publicKey, 'hex'))
    return keys
  }
  assert.equal((await announced(SEARCH_TOPIC)).has(relay.peerKey), true, 'the relay announces the v2 topic')
  assert.equal((await announced(hypercoreCrypto.hash(b4a.from('peartube/search/v1/0')))).has(relay.peerKey), false, 'and not the v1 topic')

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
