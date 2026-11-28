import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import b4a from 'b4a'
import Hypercore from 'hypercore'
import Hyperswarm from 'hyperswarm'
import hypercoreCrypto from 'hypercore-crypto'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { SEARCH_TOPIC } from '../src/search.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'peartube-scope-test-'))

async function until (fn, ms = 30_000, label = 'condition') {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 150))
  }
}

test('single-Corestore scoped replication never leaks unshared channel or active video discoveryKeys to another channel peer', async t => {
  const testnet = await createTestnet(3)
  const ch2Owner = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const nodeA = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  t.after(async () => {
    await nodeA.close()
    await ch2Owner.close()
    await testnet.destroy()
  })

  // Channel 1 (owned by nodeA) and Channel 2 (separate channel followed by nodeA, with an actively open video core).
  const ch1Bytes = randomBytes(64 * 1024 + 13)
  const ch1Pub = await nodeA.publish({ id: 'imdb:tt0133093', title: 'Channel 1 Movie' }, Readable.from([ch1Bytes]))
  const ch2Bytes = randomBytes(64 * 1024 + 29)
  const ch2Pub = await ch2Owner.publish({ id: 'imdb:tt0903747', title: 'Channel 2 Secret' }, Readable.from([ch2Bytes]))

  await nodeA.addSource(ch2Owner.status().channel)
  await until(async () => (await nodeA.search('imdb:tt0903747')).length === 1, 30_000, 'nodeA syncs ch2')
  // Open Channel 2's remote video core so it is actively open & downloading inside nodeA's single Corestore!
  const ch2ActiveCore = await nodeA.blobCore(ch2Pub.blobs)
  await ch2ActiveCore.ready()

  const ch1KeyHex = nodeA.status().channel
  const ch2KeyHex = ch2Owner.status().channel
  const ch1DiscHex = b4a.toString(hypercoreCrypto.discoveryKey(b4a.from(ch1KeyHex, 'hex')), 'hex')
  const ch2DiscHex = b4a.toString(hypercoreCrypto.discoveryKey(b4a.from(ch2KeyHex, 'hex')), 'hex')
  const ch2BlobDiscHex = b4a.toString(hypercoreCrypto.discoveryKey(b4a.from(ch2Pub.blobs, 'hex')), 'hex')

  // Peer B follows ONLY Channel 1. Observe every Protomux channel opened by nodeA on the wire.
  const seenAlpha = new Set()
  const seenWakeup = new Set()
  const peerB = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker: ch1KeyHex })
  t.after(() => peerB.close())
  const watchConn = conn => {
    const mux = Hypercore.getProtocolMuxer(conn)
    if (!mux) return
    mux.watch({ protocol: 'hypercore/alpha' }, s => { if (s?.id) seenAlpha.add(b4a.toString(s.id, 'hex')) })
    mux.watch({ protocol: 'wakeup' }, s => { if (s?.id) seenWakeup.add(b4a.toString(s.id, 'hex')) })
  }
  for (const conn of peerB.peerConnections()) watchConn(conn)
  peerB.onConnection(watchConn)

  const [hit] = await until(async () => {
    const res = await peerB.search('imdb:tt0133093')
    return res.length ? res : null
  }, 30_000, 'peerB syncs ch1')
  assert.equal(hit.sha256, ch1Pub.sha256)
  const fetched = Buffer.from(await (await fetch(hit.streamUrl)).arrayBuffer())
  assert.deepEqual(fetched, ch1Bytes, 'peerB streams Channel 1 video cleanly')

  // Open another video core in Channel 2 AFTER Peer B is already connected to verify no mid-session broadcast leak.
  const ch2Pub2 = await ch2Owner.publish({ id: 'imdb:tt0903748', title: 'Channel 2 Late' }, Readable.from([randomBytes(32 * 1024)]))
  const ch2Blob2DiscHex = b4a.toString(hypercoreCrypto.discoveryKey(b4a.from(ch2Pub2.blobs, 'hex')), 'hex')
  await until(async () => (await nodeA.search('imdb:tt0903748')).length === 1, 30_000, 'nodeA syncs ch2 late')
  await nodeA.blobCore(ch2Pub2.blobs)
  await new Promise(resolve => setTimeout(resolve, 600))

  assert.ok(seenAlpha.has(ch1DiscHex) || seenWakeup.has(ch1DiscHex), 'Peer B saw Channel 1 traffic')
  assert.equal(seenAlpha.has(ch2DiscHex), false, 'Channel 2 discoveryKey must NOT leak over hypercore/alpha to Channel 1 peer')
  assert.equal(seenWakeup.has(ch2DiscHex), false, 'Channel 2 discoveryKey must NOT leak over wakeup to Channel 1 peer')
  assert.equal(seenAlpha.has(ch2BlobDiscHex), false, 'Channel 2 active video core must NOT leak to Channel 1 peer')
  assert.equal(seenAlpha.has(ch2Blob2DiscHex), false, 'Channel 2 late-opened video core must NOT broadcast to Channel 1 peer')
})

test('global search connection stays strictly isolated: zero channel leaks and refuses unoffered private core probes', async t => {
  const testnet = await createTestnet(3)
  const relay = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const searcher = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  t.after(async () => {
    await searcher.close()
    await relay.close()
    await testnet.destroy()
  })

  const pubBytes = randomBytes(48 * 1024 + 5)
  const privBytes = randomBytes(48 * 1024 + 11)
  const pubEntry = await relay.publish({ id: 'imdb:tt0111161', title: 'Public Search Film' }, Readable.from([pubBytes]))
  const privEntry = await relay.publish({ id: 'imdb:tt0999999', title: 'Hidden NonMedia File' }, Readable.from([privBytes]))
  const relayChanDiscHex = b4a.toString(hypercoreCrypto.discoveryKey(b4a.from(relay.status().channel, 'hex')), 'hex')
  const privDiscBuf = hypercoreCrypto.discoveryKey(b4a.from(privEntry.blobs, 'hex'))
  const privDiscHex = b4a.toString(privDiscBuf, 'hex')

  // Relay offers ONLY pubEntry in global search (`isMedia` rejects privEntry).
  relay.serveSearch({ isMedia: key => key === `${pubEntry.blobs}:0` })

  // Observe every hypercore/alpha and wakeup channel opened on searcher's connection to relay.
  const seenAlpha = new Set()
  const seenWakeup = new Set()
  let searchConn = null
  const watchSearchConn = conn => {
    if (conn.remotePublicKey && b4a.toString(conn.remotePublicKey, 'hex') === relay.peerKey) searchConn = conn
    const mux = Hypercore.getProtocolMuxer(conn)
    if (!mux) return
    mux.watch({ protocol: 'hypercore/alpha' }, s => { if (s?.id) seenAlpha.add(b4a.toString(s.id, 'hex')) })
    mux.watch({ protocol: 'wakeup' }, s => { if (s?.id) seenWakeup.add(b4a.toString(s.id, 'hex')) })
  }
  searcher.onConnection(watchSearchConn)
  await relay.swarm.flush()

  const res = await until(async () => {
    const out = await searcher.searchGlobal({ query: 'Public Search Film' })
    return out.length ? out : null
  }, 30_000, 'global search hit')
  assert.equal(res.length, 1)
  assert.equal(res[0].sha256, pubEntry.sha256)

  // Searcher must NEVER have seen relay's channel or wakeup or hidden file on the search connection.
  assert.equal(seenAlpha.has(relayChanDiscHex), false, 'Relay channel core must NOT leak onto a global search connection')
  assert.equal(seenWakeup.has(relayChanDiscHex), false, 'Relay channel wakeup must NOT leak onto a global search connection')
  assert.equal(seenAlpha.has(privDiscHex), false, 'Unoffered file must NOT leak onto a global search connection')

  // Hostile probe: stranger tries opening unoffered core `privEntry.blobs` directly over the search connection!
  assert.ok(searchConn, 'search connection to relay is open')
  const probeMux = Hypercore.getProtocolMuxer(searchConn)
  const probeCh = probeMux.createChannel({
    protocol: 'hypercore/alpha',
    id: privDiscBuf,
    onopen () { relayOpenedForbidden = true }
  })
  let relayOpenedForbidden = !probeCh
  if (probeCh) {
    probeCh.open()
    await new Promise(resolve => setTimeout(resolve, 600))
    probeCh.close()
  }
  assert.equal(relayOpenedForbidden, false, 'Relay must refuse unoffered core discoveryKey probe on a strict search connection')

  // Meanwhile, opening and streaming the legitimately offered search hit works over the exact same connection!
  const opened = await searcher.openUri(res[0].magnetUrl)
  const body = Buffer.from(await (await fetch(opened.entry.streamUrl)).arrayBuffer())
  assert.deepEqual(body, pubBytes, 'Searcher streams the offered global-search hit cleanly')

  // Opening a single offered video core must NEVER transitively grant its enclosing channel or sibling unoffered cores!
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(seenAlpha.has(relayChanDiscHex), false, 'Opening offered video must NOT transitively grant relay channel core')
  assert.equal(seenWakeup.has(relayChanDiscHex), false, 'Opening offered video must NOT transitively grant relay channel wakeup')
  const probeCh2 = probeMux.createChannel({
    protocol: 'hypercore/alpha',
    id: privDiscBuf,
    onopen () { relayOpenedForbiddenAfter = true }
  })
  let relayOpenedForbiddenAfter = !probeCh2
  if (probeCh2) {
    probeCh2.open()
    await new Promise(resolve => setTimeout(resolve, 400))
    probeCh2.close()
  }
  assert.equal(relayOpenedForbiddenAfter, false, 'Opening one offered video must NOT unlock sibling unoffered cores in the same channel')

  // Upgrading a strict search connection when the user later follows that relay's channel must sync without deadlocking!
  await searcher.addSource(relay.status().channel)
  await until(async () => (await searcher.search('imdb:tt0999999')).length === 1, 30_000, 'searcher upgrades strict search conn after following relay channel')
})

test('peers sharing two channels sync both over one connection without cross-leaking a third unshared channel', async t => {
  const testnet = await createTestnet(3)
  const a = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const ch2 = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const ch3 = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  t.after(async () => {
    await a.close()
    await ch2.close()
    await ch3.close()
    await testnet.destroy()
  })

  await a.publish({ id: 'imdb:tt0000001', title: 'Shared One' }, Readable.from([randomBytes(16 * 1024)]))
  await ch2.publish({ id: 'imdb:tt0000002', title: 'Shared Two' }, Readable.from([randomBytes(16 * 1024)]))
  await ch3.publish({ id: 'imdb:tt0000003', title: 'Private Three' }, Readable.from([randomBytes(16 * 1024)]))

  await a.addSource(ch2.status().channel)
  await a.addSource(ch3.status().channel)
  await until(async () => (await a.search('imdb:tt0000002')).length === 1 && (await a.search('imdb:tt0000003')).length === 1, 30_000, 'nodeA syncs ch2 & ch3')

  // Peer B shares ch1 (a) AND ch2, but NOT ch3.
  const b = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker: a.status().channel })
  t.after(() => b.close())
  const seenOnB = new Set()
  const trackB = conn => {
    const mux = Hypercore.getProtocolMuxer(conn)
    if (!mux) return
    mux.watch({ protocol: 'hypercore/alpha' }, s => { if (s?.id) seenOnB.add(b4a.toString(s.id, 'hex')) })
    mux.watch({ protocol: 'wakeup' }, s => { if (s?.id) seenOnB.add(b4a.toString(s.id, 'hex')) })
  }
  b.onConnection(trackB)
  await b.addSource(ch2.status().channel)

  await until(async () => (await b.search('imdb:tt0000001')).length === 1 && (await b.search('imdb:tt0000002')).length === 1, 30_000, 'peerB syncs both shared channels')
  const ch3DiscHex = b4a.toString(hypercoreCrypto.discoveryKey(b4a.from(ch3.status().channel, 'hex')), 'hex')
  assert.equal(seenOnB.has(ch3DiscHex), false, 'Unshared Channel 3 must not leak to Peer B even when sharing Channels 1 and 2')
})

test('outbound raw Hyperswarm stranger on SEARCH_TOPIC sees zero proactive channel opens', async t => {
  const testnet = await createTestnet(3)
  const relay = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const strangerSwarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  t.after(async () => {
    await strangerSwarm.destroy()
    await relay.close()
    await testnet.destroy()
  })

  await relay.publish({ id: 'imdb:tt0123456', title: 'Only On Relay' }, Readable.from([randomBytes(16 * 1024)]))
  relay.serveSearch({ isMedia: () => true })
  await relay.swarm.flush()

  const seen = new Set()
  let connected = false
  strangerSwarm.on('connection', conn => {
    connected = true
    const stream = Hypercore.createProtocolStream(conn, {
      ondiscoverykey: dk => seen.add(b4a.toString(dk, 'hex'))
    })
    const mux = Hypercore.getProtocolMuxer(stream)
    mux.watch({ protocol: 'wakeup' }, s => { if (s?.id) seen.add(b4a.toString(s.id, 'hex')) })
  })
  strangerSwarm.join(SEARCH_TOPIC, { server: false, client: true })
  await until(() => connected, 20_000, 'stranger connects on SEARCH_TOPIC')
  await new Promise(resolve => setTimeout(resolve, 600))

  assert.equal(seen.size, 0, `Inbound relay on SEARCH_TOPIC must send zero proactive opens (saw ${seen.size})`)
})
