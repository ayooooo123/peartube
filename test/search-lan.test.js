// Global search over LAN discovery and wait/update behavior:
// 1. A searcher with no followed channels and no public DHT finds and reads a film from a relay on the same LAN.
// 2. A cold search that returns empty still emits onUpdate when a LAN relay connects and answers later.
// 3. A relay whose search call fails does not count as answered and does not cut the collect window short.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import b4a from 'b4a'
import { Duplex } from 'streamx'
import SecretStream from '@hyperswarm/secret-stream'
import { createNode } from '../src/index.js'
import { createLan } from '../src/lan.js'
import { createGlobalSearch, SEARCH_TOPIC } from '../src/search.js'
import { formatWatchUri } from '../src/protocol.js'
import { serveChannel } from '../src/control-channel.js'
import { mdnsBus } from './mdns.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'peartube-search-lan-'))
const sha = buf => createHash('sha256').update(buf).digest('hex')
const mkv = size => { const b = randomBytes(size); b.set([0x1a, 0x45, 0xdf, 0xa3], 0); return b }

function fakeSwarm () {
  const swarm = new EventEmitter()
  swarm.joins = []
  swarm.join = (topic, opts) => {
    const rec = { topic, opts, destroyed: false, destroy: async () => { rec.destroyed = true } }
    swarm.joins.push(rec)
    return rec
  }
  return swarm
}

async function noisePair () {
  let rawB
  const rawA = new Duplex({
    write (data, cb) { rawB.push(data); cb(null) },
    final (cb) { rawB.push(null); cb(null) }
  })
  rawB = new Duplex({
    write (data, cb) { rawA.push(data); cb(null) },
    final (cb) { rawA.push(null); cb(null) }
  })
  const client = new SecretStream(true, rawA)
  const server = new SecretStream(false, rawB)
  await Promise.all([
    new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject) }),
    new Promise((resolve, reject) => { server.once('open', resolve); server.once('error', reject) })
  ])
  return [client, server]
}

test('global search finds and plays a film over LAN alone with no followed channels and no DHT', { timeout: 60_000 }, async t => {
  const bus = mdnsBus()
  const lanFactory = () => kp => createLan({ host: '127.0.0.1', keyPair: kp, adapter: bus(), dialAfter: 500 })
  const closers = []
  t.after(async () => {
    for (const close of closers.reverse()) await close().catch(() => {})
  })

  // Isolated nodes with no DHT bootstrap at all: LAN mDNS is the only way they can meet.
  const relay = await createNode({ storage: tmp(), bootstrap: [], lan: lanFactory() })
  closers.push(() => relay.close())
  const film = mkv(1024 * 1024 + 17)
  const op = await relay.put({ id: 'imdb:tt0000101', title: 'Harbour Light' }, Readable.from([film]))
  await relay.append(op)
  relay.serveSearch({ isMedia: () => true })

  let updates = 0
  const searcher = await createNode({ storage: tmp(), bootstrap: [], lan: lanFactory(), onchange: () => { updates++ } })
  closers.push(() => searcher.close())

  // Searcher follows no channels: starts with 0 LAN peers.
  assert.equal(searcher.status().lanPeers, 0)

  const started = Date.now()
  let rows = await searcher.searchGlobal({ query: 'Harbour Light' })
  if (!rows.length) {
    const deadline = Date.now() + 10_000
    while (!rows.length && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200))
      rows = await searcher.searchGlobal({ query: 'Harbour Light' })
    }
  }
  assert.equal(rows.length, 1, `expected 1 LAN search hit (elapsed ${Date.now() - started}ms, updates=${updates})`)
  assert.equal(rows[0].id, 'imdb:tt0000101')
  assert.equal(rows[0].sha256, op.sha256)
  assert.ok(searcher.status().lanPeers >= 1, 'searcher connected to the relay over LAN')

  // Verify the watch link from the LAN hit streams the exact bytes.
  const opened = await searcher.openUri(rows[0].magnetUrl)
  const res = await fetch(opened.entry.streamUrl)
  assert.equal(res.status, 200)
  const got = Buffer.from(await res.arrayBuffer())
  assert.equal(sha(got), sha(film))
})

test('cold search returning empty still fires onUpdate when a LAN relay connects later', { timeout: 30_000 }, async t => {
  const swarm = fakeSwarm()
  const conns = new Set()
  const listeners = new Set()
  const lanConns = new Set()
  const lanJoined = new Map()
  let updates = 0
  const gs = createGlobalSearch({
    swarm,
    peerConnections: () => conns,
    connListeners: listeners,
    isPrivate: () => false,
    isLan: c => lanConns.has(c),
    isSourcePeer: () => false,
    joinLanTopic: (id, topic) => lanJoined.set(id, topic),
    leaveLanTopic: id => lanJoined.delete(id),
    publicEntries: async () => [],
    onUpdate: () => { updates++ }
  })
  t.after(() => gs.close())

  // 1. Cold search with 0 connected peers: waits the full collect window and returns [].
  const t0 = Date.now()
  const first = await gs.searchGlobal({ query: 'harbour light' })
  const elapsed = Date.now() - t0
  assert.deepEqual(first, [])
  assert.ok(elapsed >= 1800, `cold search returned too early (${elapsed}ms)`)
  assert.ok(lanJoined.has('search:ask') && b4a.equals(lanJoined.get('search:ask'), SEARCH_TOPIC))

  // 2. Relay connects over LAN AFTER the first search returned []: onUpdate must fire with the hit.
  const [clientConn, serverConn] = await noisePair()
  t.after(() => { clientConn.destroy(); serverConn.destroy() })
  const uri = formatWatchUri({
    id: 'imdb:tt0000101',
    title: 'Harbour Light',
    sha256: 'a'.repeat(64),
    blobs: 'b'.repeat(64),
    blob: { blockOffset: 0, blockLength: 10, byteOffset: 0, byteLength: 5000 }
  })
  serveChannel(serverConn, {
    protocol: 'peartube/search/v1',
    label: 'Searcher',
    onRequest: async () => ({ hits: [{ uri }] })
  })
  conns.add(clientConn)
  lanConns.add(clientConn)
  for (const fn of listeners) fn(clientConn)

  const deadline = Date.now() + 3000
  while (updates === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 25))
  assert.ok(updates >= 1, 'onUpdate must fire when a late hit arrives after an empty cold search')

  // 3. Follow-up search returns the hit immediately (< 300 ms).
  const t1 = Date.now()
  const second = await gs.searchGlobal({ query: 'harbour light' })
  assert.equal(second.length, 1)
  assert.equal(second[0].title, 'Harbour Light')
  assert.ok(Date.now() - t1 < 300, 'follow-up after answered relay must return immediately')

  // 4. Serving and searching hold LAN topics independently.
  gs.serve({ isMedia: () => true })
  assert.ok(lanJoined.has('search:serve'))
  gs.suspend()
  assert.equal(lanJoined.has('search:ask'), false, 'suspend releases search:ask')
  assert.equal(lanJoined.has('search:serve'), true, 'suspend keeps search:serve')
  gs.serve(null)
  assert.equal(lanJoined.has('search:serve'), false, 'serve(null) releases search:serve')
})

test('a failed search call does not count as answered or cut the collect window short', { timeout: 20_000 }, async t => {
  const swarm = fakeSwarm()
  const [clientConn, serverConn] = await noisePair()
  t.after(() => { clientConn.destroy(); serverConn.destroy() })
  serveChannel(serverConn, {
    protocol: 'peartube/search/v1',
    label: 'Searcher',
    onRequest: async () => { throw new Error('busy') }
  })
  const conns = new Set([clientConn])
  const listeners = new Set()
  const gs = createGlobalSearch({
    swarm,
    peerConnections: () => conns,
    connListeners: listeners,
    isPrivate: () => false,
    isLan: () => true,
    isSourcePeer: () => false,
    publicEntries: async () => []
  })
  t.after(() => gs.close())

  const started = Date.now()
  const rows = await gs.searchGlobal({ query: 'harbour light' })
  const elapsed = Date.now() - started
  assert.deepEqual(rows, [])
  assert.ok(elapsed >= 1800, `failed search call ended wait early (${elapsed}ms)`)
})
