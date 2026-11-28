import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import b4a from 'b4a'
import Hypercore from 'hypercore'
import hypercoreCrypto from 'hypercore-crypto'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { createPrivateGuard } from '../src/private-overlay.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'peartube-meta-test-'))
const blake2bHex = buf => b4a.toString(hypercoreCrypto.hash(buf), 'hex')

async function until (fn, ms = 45_000, label = 'condition') {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 150))
  }
}

function makeMatchingShardBytes (size, targetShardIdx) {
  for (let i = 0; i < 512; i++) {
    const buf = randomBytes(size)
    const h = hypercoreCrypto.hash(buf)
    if ((h[0] & 7) === targetShardIdx) return buf
  }
  throw new Error('Could not generate matching shard bytes')
}

test('end-to-end P2P metadata channel: multi-writer dedup, search snapshot, and sparse worklet follower', { timeout: 90_000 }, async t => {
  const testnet = await createTestnet(3)
  const founderDir = tmp()
  const coWriterDir = tmp()
  const followerDir = tmp()
  const founder = await createNode({ storage: founderDir, bootstrap: testnet.bootstrap })
  const coWriter = await createNode({ storage: coWriterDir, bootstrap: testnet.bootstrap })
  const follower = await createNode({ storage: followerDir, bootstrap: testnet.bootstrap, worklet: true })
  t.after(async () => {
    await Promise.allSettled([follower.close(), coWriter.close(), founder.close()])
    await testnet.destroy()
  })

  assert.equal(typeof founder.meta, 'object', 'node.meta API must exist on founder')
  assert.equal(typeof coWriter.meta, 'object', 'node.meta API must exist on coWriter')
  assert.equal(typeof follower.meta, 'object', 'node.meta API must exist on follower')

  const ch = await founder.meta.createChannel({ alias: 'Community Catalog' })
  assert.equal(ch.writable, true)
  assert.ok(ch.uri.startsWith(`peartube://meta/${ch.key}`))

  // Put two distinct ~96 KiB artworks (2 × 64 KiB blocks each) into the SAME shard core so we can
  // verify sparse reads on the follower download ONLY the requested artwork's blocks.
  const art1Bytes = randomBytes(96 * 1024 + 17)
  const art1ShardIdx = hypercoreCrypto.hash(art1Bytes)[0] & 7
  const art2Bytes = makeMatchingShardBytes(96 * 1024 + 23, art1ShardIdx)

  const art1 = await founder.meta.putArt(ch.key, art1Bytes, { mime: 'image/webp', width: 600, height: 900 })
  assert.equal(art1.deduplicated, false)
  assert.equal(art1.hash, blake2bHex(art1Bytes))

  const art2 = await founder.meta.putArt(ch.key, art2Bytes, { mime: 'image/jpeg', width: 1280, height: 720 })
  assert.equal(art2.deduplicated, false)
  assert.equal(art2.ptr.shardId, art1.ptr.shardId, 'both artworks share one 64 KiB shard core')

  await founder.meta.putCard(ch.key, {
    id: 'imdb:tt0133093',
    kind: 'movie',
    title: 'The Matrix',
    subtitle: 'Sci-Fi Action',
    year: 1999,
    ratingX10: 87,
    genres: ['Action', 'Sci-Fi'],
    runtimeMin: 136,
    posterHash: art1.hash,
    backdropHash: art2.hash
  })
  await founder.meta.putDetail(ch.key, {
    id: 'imdb:tt0133093',
    synopsis: 'A computer hacker learns about the true nature of reality.',
    cast: ['Keanu Reeves', 'Laurence Fishburne'],
    directors: ['Lana Wachowski', 'Lilly Wachowski'],
    tags: ['cyberpunk', 'simulation'],
    backdropHash: art2.hash,
    items: [{ label: 'Feature', subId: 'imdb:tt0133093', season: 0, number: 1, runtimeMin: 136 }],
    externalIds: [{ key: 'tmdb', value: '603' }]
  })

  // Co-writer opens via peartube://meta/ URI, gets granted by founder, deduplicates identical art, and publishes card 2.
  const opened = await coWriter.openUri(ch.uri)
  assert.equal(opened.action, 'meta')
  assert.equal(opened.source.key, ch.key)
  assert.equal(opened.source.writable, false)

  await founder.meta.grantWriter(ch.key, opened.source.writerKey, { role: 'writer', alias: 'curator-2' })
  await until(async () => {
    await coWriter.meta.getCard('imdb:tt0133093')
    return Boolean(coWriter.meta.listSources().find(s => s.key === ch.key)?.writable)
  }, 30_000, 'coWriter becomes writable after founder grant')

  const dupArt = await coWriter.meta.putArt(ch.key, art1Bytes, { mime: 'image/webp', width: 600, height: 900 })
  assert.equal(dupArt.deduplicated, true, 'co-writer identical artwork must deduplicate across writers')
  assert.equal(dupArt.hash, art1.hash)
  assert.equal(dupArt.ptr.shardId, art1.ptr.shardId)

  await coWriter.meta.putCard(ch.key, {
    id: 'imdb:tt0083658',
    kind: 'movie',
    title: 'Blade Runner',
    subtitle: 'Neo-Noir Sci-Fi',
    year: 1982,
    ratingX10: 81,
    genres: ['Sci-Fi', 'Thriller'],
    runtimeMin: 117,
    posterHash: art1.hash
  })

  await until(async () => Boolean(await founder.meta.getCard('imdb:tt0083658')), 30_000, 'founder syncs coWriter card')

  const snap = await founder.meta.publishSearchSnapshot(ch.key, {
    lists: [
      { kind: 'movie', slug: 'popular', title: 'Popular Sci-Fi', ids: ['imdb:tt0133093', 'imdb:tt0083658'], updatedAt: Date.now() }
    ],
    buckets: [
      {
        kind: 'movie',
        prefix: 'mat',
        hits: [{ id: 'imdb:tt0133093', title: 'The Matrix', subtitle: 'Sci-Fi Action', year: 1999, score: 950, posterHash: art1.hash }],
        updatedAt: Date.now()
      },
      {
        kind: 'movie',
        prefix: 'bla',
        hits: [{ id: 'imdb:tt0083658', title: 'Blade Runner', subtitle: 'Neo-Noir Sci-Fi', year: 1982, score: 910, posterHash: art1.hash }],
        updatedAt: Date.now()
      }
    ],
    titleCount: 2
  })
  assert.equal(snap.generation, 1)

  // Sparse worklet follower joins and reads card, detail, verified artwork (1st P2P, 2nd disk LRU), list, and search.
  const folSrc = await follower.meta.addSource(ch.uri)
  assert.equal(folSrc.seedFull, false)

  const card1 = await until(() => follower.meta.getCard('imdb:tt0133093'), 30_000, 'follower syncs card1')
  assert.equal(card1.title, 'The Matrix')
  assert.equal(card1.year, 1999)
  assert.equal(card1.posterHash, art1.hash)

  const card2 = await until(() => follower.meta.getCard('imdb:tt0083658'), 30_000, 'follower syncs card2')
  assert.equal(card2.title, 'Blade Runner')

  const detail1 = await until(() => follower.meta.getDetail('imdb:tt0133093'), 30_000, 'follower syncs detail1')
  assert.equal(detail1.synopsis, 'A computer hacker learns about the true nature of reality.')
  assert.deepEqual(detail1.cast, ['Keanu Reeves', 'Laurence Fishburne'])

  const gotArt1 = await until(() => follower.meta.getArt(art1.hash), 30_000, 'follower fetches verified art1')
  assert.equal(gotArt1.cached, false)
  assert.equal(gotArt1.mime, 'image/webp')
  assert.equal(gotArt1.width, 600)
  assert.equal(gotArt1.height, 900)
  assert.deepEqual(gotArt1.bytes, art1Bytes)

  const gotArt1Cached = await follower.meta.getArt(art1.hash)
  assert.equal(gotArt1Cached.cached, true, 'second getArt must hit flat disk LRU')
  assert.deepEqual(gotArt1Cached.bytes, art1Bytes)

  // Verify the shared shard core on the sparse follower did NOT download art2's blocks (no download(0, -1)).
  const founderShardCore = founder.store.namespace(`meta:${ch.key}`).get({ name: `shard-0-${art1ShardIdx}`, active: false })
  await founderShardCore.ready()
  const sharedShardKey = founderShardCore.key
  assert.equal(founderShardCore.length, 4, 'founder shard holds 2 blocks for art1 + 2 blocks for art2')
  const followerShardProbe = follower.store.get({ key: sharedShardKey, active: false })
  await followerShardProbe.ready()
  const followerBlocks = await followerShardProbe.count(0, followerShardProbe.length)
  assert.ok(followerBlocks > 0 && followerBlocks < founderShardCore.length, `sparse follower must hold only art1 blocks (got ${followerBlocks}/${founderShardCore.length})`)
  await followerShardProbe.close()
  await founderShardCore.close()

  // Verify Discover list hydration and 3-char typeahead search from immutable Hyperbee2 snapshot.
  const popular = await until(() => follower.meta.getList('movie', 'popular'), 30_000, 'follower reads Discover list')
  assert.equal(popular.title, 'Popular Sci-Fi')
  assert.deepEqual(popular.ids, ['imdb:tt0133093', 'imdb:tt0083658'])
  assert.equal(popular.cards.length, 2)

  const hits = await follower.meta.searchIndex('movie', 'mat')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, 'imdb:tt0133093')
  assert.equal(hits[0].title, 'The Matrix')

  // Verify flags and removal/revocation work cleanly.
  assert.equal(follower.meta.isP2pOnly(), false)
  assert.equal(follower.meta.setP2pOnly(true), true)
  assert.equal(follower.meta.isP2pOnly(), true)

  await founder.meta.removeKey(ch.key, 'card/imdb:tt0083658')
  await until(async () => (await follower.meta.getCard('imdb:tt0083658')) === null, 30_000, 'card removal replicates')
  await founder.meta.revokeWriter(ch.key, opened.source.writerKey)
})

test('replication isolation: meta:<key> peer sees zero channel/video discoveryKeys and channel peer sees zero meta discoveryKeys', { timeout: 90_000 }, async t => {
  const testnet = await createTestnet(3)
  const host = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  t.after(async () => {
    await host.close()
    await testnet.destroy()
  })

  assert.equal(typeof host.meta, 'object', 'node.meta API must exist on host')

  // Host publishes a private/public video on its channel AND opens an active video blob core,
  // plus creates a metadata channel with an artwork shard in the exact same single Corestore.
  const vidBytes = randomBytes(64 * 1024 + 19)
  const vidPub = await host.publish({ id: 'imdb:tt0903747', title: 'Channel Secret Video' }, Readable.from([vidBytes]))
  const activeVidCore = await host.blobCore(vidPub.blobs)
  await activeVidCore.ready()

  const metaCh = await host.meta.createChannel({ alias: 'Isolated Meta' })
  const artBytes = randomBytes(32 * 1024 + 7)
  const art = await host.meta.putArt(metaCh.key, artBytes, { mime: 'image/webp', width: 300, height: 450 })
  await host.meta.putCard(metaCh.key, { id: 'imdb:tt0111161', kind: 'movie', title: 'Shawshank', year: 1994, posterHash: art.hash })

  const hostChanDiscBuf = hypercoreCrypto.discoveryKey(b4a.from(host.status().channel, 'hex'))
  const hostChanDiscHex = b4a.toString(hostChanDiscBuf, 'hex')
  const hostVidDiscBuf = hypercoreCrypto.discoveryKey(b4a.from(vidPub.blobs, 'hex'))
  const hostVidDiscHex = b4a.toString(hostVidDiscBuf, 'hex')
  const metaChanDiscHex = b4a.toString(hypercoreCrypto.discoveryKey(b4a.from(metaCh.key, 'hex')), 'hex')
  const shardIdx = hypercoreCrypto.hash(artBytes)[0] & 7
  const hostShardCore = host.store.namespace(`meta:${metaCh.key}`).get({ name: `shard-0-${shardIdx}`, active: false })
  await hostShardCore.ready()
  const metaShardDiscBuf = b4a.from(hostShardCore.discoveryKey)
  const metaShardDiscHex = b4a.toString(metaShardDiscBuf, 'hex')
  await hostShardCore.close()

  // 1) Peer connected ONLY on meta:<key>: must sync metadata cleanly and see ZERO channel/video discoveryKeys.
  const metaPeer = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, worklet: true })
  t.after(() => metaPeer.close())
  const metaSeenAlpha = new Set()
  const metaSeenWakeup = new Set()
  let metaConnToHost = null
  const watchMetaConn = conn => {
    if (conn.remotePublicKey && b4a.toString(conn.remotePublicKey, 'hex') === host.peerKey) metaConnToHost = conn
    const mux = Hypercore.getProtocolMuxer(conn)
    if (!mux) return
    mux.watch({ protocol: 'hypercore/alpha' }, s => { if (s?.id) metaSeenAlpha.add(b4a.toString(s.id, 'hex')) })
    mux.watch({ protocol: 'wakeup' }, s => { if (s?.id) metaSeenWakeup.add(b4a.toString(s.id, 'hex')) })
  }
  metaPeer.onConnection(watchMetaConn)
  await metaPeer.meta.addSource(metaCh.uri)

  const syncedCard = await until(() => metaPeer.meta.getCard('imdb:tt0111161'), 30_000, 'metaPeer syncs card')
  assert.equal(syncedCard.title, 'Shawshank')
  const syncedArt = await until(() => metaPeer.meta.getArt(art.hash), 30_000, 'metaPeer syncs art')
  assert.deepEqual(syncedArt.bytes, artBytes)
  await new Promise(resolve => setTimeout(resolve, 400))

  assert.equal(metaSeenAlpha.has(hostChanDiscHex), false, 'meta peer must see ZERO channel discoveryKeys on hypercore/alpha')
  assert.equal(metaSeenWakeup.has(hostChanDiscHex), false, 'meta peer must see ZERO channel discoveryKeys on wakeup')
  assert.equal(metaSeenAlpha.has(hostVidDiscHex), false, 'meta peer must see ZERO active video discoveryKeys')

  // Hostile probe from metaPeer attempting to open host's active video core over the meta connection MUST be refused.
  assert.ok(metaConnToHost, 'metaPeer has live connection to host')
  const metaMux = Hypercore.getProtocolMuxer(metaConnToHost)
  let videoProbeOpened = false
  const vidProbe = metaMux.createChannel({
    protocol: 'hypercore/alpha',
    id: hostVidDiscBuf,
    onopen () { videoProbeOpened = true }
  })
  if (vidProbe) {
    vidProbe.open()
    await new Promise(resolve => setTimeout(resolve, 500))
    vidProbe.close()
  }
  assert.equal(videoProbeOpened, false, 'host must refuse video core probe over a strict meta:<key> connection')

  // 2) Peer connected ONLY on host's channel: must stream video cleanly and see ZERO meta:<key> discoveryKeys.
  const chanPeer = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker: host.status().channel })
  t.after(() => chanPeer.close())
  const chanSeenAlpha = new Set()
  const chanSeenWakeup = new Set()
  let chanConnToHost = null
  const watchChanConn = conn => {
    if (conn.remotePublicKey && b4a.toString(conn.remotePublicKey, 'hex') === host.peerKey) chanConnToHost = conn
    const mux = Hypercore.getProtocolMuxer(conn)
    if (!mux) return
    mux.watch({ protocol: 'hypercore/alpha' }, s => { if (s?.id) chanSeenAlpha.add(b4a.toString(s.id, 'hex')) })
    mux.watch({ protocol: 'wakeup' }, s => { if (s?.id) chanSeenWakeup.add(b4a.toString(s.id, 'hex')) })
  }
  for (const conn of chanPeer.peerConnections()) watchChanConn(conn)
  chanPeer.onConnection(watchChanConn)

  const [hit] = await until(async () => {
    const res = await chanPeer.search('imdb:tt0903747')
    return res.length ? res : null
  }, 30_000, 'chanPeer syncs host channel')
  const streamed = Buffer.from(await (await fetch(hit.streamUrl)).arrayBuffer())
  assert.deepEqual(streamed, vidBytes)
  await new Promise(resolve => setTimeout(resolve, 400))

  assert.equal(chanSeenAlpha.has(metaChanDiscHex), false, 'channel peer must see ZERO meta discoveryKeys on hypercore/alpha')
  assert.equal(chanSeenWakeup.has(metaChanDiscHex), false, 'channel peer must see ZERO meta discoveryKeys on wakeup')
  assert.equal(chanSeenAlpha.has(metaShardDiscHex), false, 'channel peer must see ZERO meta shard discoveryKeys')

  // Hostile probe from chanPeer attempting to open the meta artwork shard over the channel connection MUST be refused.
  assert.ok(chanConnToHost, 'chanPeer has live connection to host')
  const chanMux = Hypercore.getProtocolMuxer(chanConnToHost)
  let metaProbeOpened = false
  const metaProbe = chanMux.createChannel({
    protocol: 'hypercore/alpha',
    id: metaShardDiscBuf,
    onopen () { metaProbeOpened = true }
  })
  if (metaProbe) {
    metaProbe.open()
    await new Promise(resolve => setTimeout(resolve, 500))
    metaProbe.close()
  }
  assert.equal(metaProbeOpened, false, 'host must refuse meta shard core probe over a channel-only connection')
})

test('corrupt artwork hash verification and flat disk LRU eviction under tight artCacheMaxBytes', { timeout: 90_000 }, async t => {
  const testnet = await createTestnet(3)
  const writerDir = tmp()
  const readerDir = tmp()
  const writer = await createNode({ storage: writerDir, bootstrap: testnet.bootstrap })
  const reader = await createNode({ storage: readerDir, bootstrap: testnet.bootstrap, artCacheMaxBytes: 50 * 1024 })
  t.after(async () => {
    await Promise.allSettled([reader.close(), writer.close()])
    await testnet.destroy()
  })

  assert.equal(typeof writer.meta, 'object', 'node.meta API must exist on writer')
  assert.equal(typeof reader.meta, 'object', 'node.meta API must exist on reader')

  const ch = await writer.meta.createChannel({ alias: 'Cache Test' })
  const a1Bytes = randomBytes(20 * 1024)
  const a2Bytes = randomBytes(20 * 1024)
  const a3Bytes = randomBytes(20 * 1024)
  const a1 = await writer.meta.putArt(ch.key, a1Bytes, { mime: 'image/webp', width: 200, height: 300 })
  const a2 = await writer.meta.putArt(ch.key, a2Bytes, { mime: 'image/webp', width: 200, height: 300 })
  const a3 = await writer.meta.putArt(ch.key, a3Bytes, { mime: 'image/webp', width: 200, height: 300 })

  await reader.meta.addSource(ch.uri)

  const r1 = await until(() => reader.meta.getArt(a1.hash), 30_000, 'reader gets a1')
  assert.equal(r1.cached, false)
  const r2 = await until(() => reader.meta.getArt(a2.hash), 30_000, 'reader gets a2')
  assert.equal(r2.cached, false)

  // Touch a1 so a2 becomes the least-recently-used entry on disk (~40 KiB <= 50 KiB cap).
  const r1Hit = await reader.meta.getArt(a1.hash)
  assert.equal(r1Hit.cached, true, 'a1 must be served from disk LRU')

  // Reading a3 (~20 KiB) exceeds the 50 KiB cap and must evict a2 (oldest), keeping a1 and a3 cached!
  const r3 = await until(() => reader.meta.getArt(a3.hash), 30_000, 'reader gets a3')
  assert.equal(r3.cached, false)
  assert.equal((await reader.meta.getArt(a1.hash)).cached, true, 'recently touched a1 must stay in disk LRU')
  assert.equal((await reader.meta.getArt(a3.hash)).cached, true, 'newly fetched a3 must be in disk LRU')

  const cacheDir = join(readerDir, 'art-cache')
  const files = readdirSync(cacheDir).filter(f => f.endsWith('.art'))
  const totalBytes = files.reduce((sum, f) => sum + statSync(join(cacheDir, f)).size, 0)
  assert.ok(totalBytes <= 50 * 1024, `disk LRU must stay within 50 KiB ceiling (got ${totalBytes})`)
  assert.equal(existsSync(join(cacheDir, `${a2.hash}.art`)), false, 'LRU must have evicted oldest entry a2')

  // Corrupt artwork hash test: append a putArt op whose hash mismatches the bytes at goodArt.ptr.
  const { encodeMetaOp } = await import('../src/meta-wire.js')
  const Autobee = (await import('autobee')).default
  const { makeMetaApply } = await import('../src/node/meta.js')
  const badHash = 'f'.repeat(64)
  const badCh = await writer.meta.createChannel({ alias: 'Corrupt Art Test' })
  const goodArt = await writer.meta.putArt(badCh.key, randomBytes(8 * 1024), { mime: 'image/webp', width: 100, height: 100 })
  await writer.meta.removeSource(badCh.key)
  const forgeBee = new Autobee(writer.store.namespace(`meta:${badCh.key}`), b4a.from(badCh.key, 'hex'), {
    apply: makeMetaApply(() => badCh.key),
    optimistic: false,
    fastForward: false
  })
  await forgeBee.ready()
  await forgeBee.append(encodeMetaOp({ type: 'putArt', hash: badHash, ptr: goodArt.ptr }))
  await forgeBee.updated()
  await forgeBee.close()

  // Reopen owned badCh on writer (also verifies writable persistence across close/reopen) and publish canary card.
  const reopened = await writer.meta.addSource(badCh.uri)
  assert.equal(reopened.writable, true, 'owned metadata channel stays writable after close and reopen')
  await writer.meta.putCard(badCh.key, { id: 'imdb:tt0000777', kind: 'movie', title: 'Corrupt Canary', year: 2025 })
  await reader.meta.addSource(badCh.uri)
  await until(() => reader.meta.getCard('imdb:tt0000777'), 30_000, 'reader syncs corrupt channel canary')

  await assert.rejects(
    () => reader.meta.getArt(badHash),
    /hash|verification|mismatch/i,
    'getArt must reject artwork whose BLAKE2b hash does not match the requested hash'
  )
  assert.equal(existsSync(join(cacheDir, `${badHash}.art`)), false, 'corrupt artwork must never enter disk LRU')
})

test('2-hop privateRouting metadata sync and artwork streaming over stateless guards with zero public fallback bytes', { timeout: 120_000 }, async t => {
  const testnet = await createTestnet(4)
  const guards = []
  const nodes = []
  t.after(async () => {
    await Promise.allSettled(nodes.map(n => n.close()))
    await Promise.allSettled(guards.map(g => g.close()))
    await testnet.destroy()
  })

  guards.push(await createPrivateGuard({ host: '127.0.0.1', bootstrap: testnet.bootstrap }))
  guards.push(await createPrivateGuard({ host: '127.0.0.1', bootstrap: testnet.bootstrap }))

  const seeder = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, privateRouting: true })
  nodes.push(seeder)
  const reader = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, privateRouting: true, worklet: true })
  nodes.push(reader)

  assert.equal(typeof seeder.meta, 'object', 'node.meta API must exist on private seeder')
  assert.equal(typeof reader.meta, 'object', 'node.meta API must exist on private reader')

  const ch = await seeder.meta.createChannel({ alias: 'Private Meta Mirror' })
  const artBytes = randomBytes(80 * 1024 + 13)
  const art = await seeder.meta.putArt(ch.key, artBytes, { mime: 'image/webp', width: 500, height: 750 })
  await seeder.meta.putCard(ch.key, {
    id: 'imdb:tt1375666',
    kind: 'movie',
    title: 'Inception',
    subtitle: 'Sci-Fi Thriller',
    year: 2010,
    ratingX10: 88,
    genres: ['Sci-Fi', 'Thriller'],
    runtimeMin: 148,
    posterHash: art.hash
  })
  await seeder.meta.putDetail(ch.key, {
    id: 'imdb:tt1375666',
    synopsis: 'A thief enters dreams to plant an idea.',
    cast: ['Leonardo DiCaprio'],
    directors: ['Christopher Nolan']
  })
  await seeder.meta.publishSearchSnapshot(ch.key, {
    lists: [{ kind: 'movie', slug: 'featured', title: 'Featured', ids: ['imdb:tt1375666'], updatedAt: Date.now() }],
    buckets: [{
      kind: 'movie',
      prefix: 'inc',
      hits: [{ id: 'imdb:tt1375666', title: 'Inception', subtitle: 'Sci-Fi Thriller', year: 2010, score: 940, posterHash: art.hash }],
      updatedAt: Date.now()
    }],
    titleCount: 1
  })

  await reader.meta.addSource(ch.uri)

  const card = await until(() => reader.meta.getCard('imdb:tt1375666'), 60_000, 'private reader syncs card over 2-hop guards')
  assert.equal(card.title, 'Inception')
  const detail = await until(() => reader.meta.getDetail('imdb:tt1375666'), 30_000, 'private reader syncs detail')
  assert.equal(detail.directors[0], 'Christopher Nolan')
  const gotArt = await until(() => reader.meta.getArt(art.hash), 30_000, 'private reader streams verified art over 2-hop guards')
  assert.deepEqual(gotArt.bytes, artBytes)
  const list = await until(() => reader.meta.getList('movie', 'featured'), 30_000, 'private reader reads search snapshot list')
  assert.equal(list.cards.length, 1)
  const hits = await reader.meta.searchIndex('movie', 'inc')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, 'imdb:tt1375666')

  const rStat = reader.status()
  const sStat = seeder.status()
  assert.equal(rStat.routes.public.rxBytes, 0, 'private reader must have zero public rxBytes')
  assert.equal(rStat.routes.public.txBytes, 0, 'private reader must have zero public txBytes')
  assert.equal(sStat.routes.public.rxBytes, 0, 'private seeder must have zero public rxBytes')
  assert.equal(sStat.routes.public.txBytes, 0, 'private seeder must have zero public txBytes')
  assert.ok(rStat.routes.private.rxBytes > 0, 'private reader must receive bytes over 2-hop private route')
  assert.equal(seeder.swarm.dht.privateRouting.exposureReport().directDestinationSends, 0)
  assert.equal(reader.swarm.dht.privateRouting.exposureReport().directDestinationSends, 0)
})
