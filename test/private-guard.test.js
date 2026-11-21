// A guard's routes and rendezvous slots belong to the channel session that registered them: another endpoint session
// cannot take over a live route token or overwrite or remove a live slot, and closing the channel releases them and
// its role, while the connection keeps its DHT-rate budget. Frames of a channel are handled in wire order. Hostile
// frames on peartube/private-guard/v2 are dropped or answered and never cost the connection; a peer on the old
// protocol is refused, and a client whose only guards speak the old protocol or refuse its hello stays UNAVAILABLE,
// closes its connections to them and dials nobody. A client drops a guard that closes an accepted channel. The
// standalone publisher needs every step accepted. And every spelling of one IPv6 address lands in one /48 diversity
// bucket. Writes desktop/target/e2e/private-guard-result.json.
// The v2 cases fail before v2: the guard spoke hand-written frames on peartube/private-guard/v1.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import HyperDHT from 'hyperdht'
import createTestnet from 'hyperdht/testnet.js'
import Protomux from 'protomux'
import c from 'compact-encoding'
import b4a from 'b4a'
import { getEncoding } from '../spec/hyperschema/index.js'
import { GUARD } from '../spec/protocols.js'
import { openChannel, serveChannel } from '../src/control-channel.js'
import { createPrivateGuard, createPrivateSwarm, diversityBucketForAddress, publishStandaloneRouteCard } from '../src/private-overlay.js'

const root = new URL('..', import.meta.url).pathname
const artifact = join(root, 'desktop/target/e2e/private-guard-result.json')
const checks = {}
const FRAME = getEncoding('@peartube/frame')
const REMOTE_ERROR = getEncoding('@peartube/remote-error')
const HELLO = getEncoding('@peartube/guard-hello')
const ACK = getEncoding('@peartube/guard-ack')
const REGISTER = getEncoding('@peartube/guard-register')
const op = name => GUARD.ops.findIndex(o => o.name === name)
const frame = (kind, opIndex, id, value) => c.encode(FRAME, { kind, op: opIndex, id, value })
const varint53 = b4a.from([0xff, 0, 0, 0, 0, 0, 0, 0x20, 0])
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const hex = b => b4a.toString(b, 'hex')
const opened = { refused: 'refused', duplicate: 'duplicate', timedOut: 'timed out' }

async function until (fn, ms, label) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${label}`)
    await sleep(50)
  }
}

async function connect (dht, guardKey) {
  const conn = dht.connect(guardKey, { keyPair: HyperDHT.keyPair(randomBytes(32)) })
  conn.on('error', () => {})
  assert.ok(await conn.opened, 'connected to the guard')
  return conn
}

// One endpoint session on the guard, through the v2 envelope.
async function endpoint (dht, guardKey) {
  const conn = await connect(dht, guardKey)
  const rpc = await openChannel(conn, { spec: GUARD, label: 'Guard', ...opened })
  assert.equal((await rpc.call('hello', { role: 'endpoint' })).status, 1)
  return { rpc, conn, close: () => conn.destroy() }
}

// A raw channel under `protocol`: every frame the guard sends, by id, and whether the channel ever opened.
function rawChannel (conn, protocol = GUARD.protocol) {
  const frames = new Map()
  let opened
  const openedP = new Promise(resolve => { opened = resolve })
  const channel = Protomux.from(conn).createChannel({ protocol, onopen: () => opened(true), onclose: () => opened(false) })
  const msg = channel.addMessage({ encoding: c.raw, onmessage: buf => { const f = c.decode(FRAME, buf); frames.set(f.id, f) } })
  channel.open()
  return { channel, frames, opened: openedP, send: buf => msg.send(buf) }
}

async function reply (peer, id, ms = 5000) {
  const end = Date.now() + ms
  while (!peer.frames.has(id) && Date.now() < end) await sleep(50)
  return peer.frames.get(id) || null
}

test('IPv6 diversity buckets do not depend on how an address is written', () => {
  const bucket = 'ipv6:2001:0000:0000/48'
  for (const spelling of ['2001::1', '2001:0:0:0:0:0:0:1', '2001:0000:0000:0000:0000:0000:0000:0001', '[2001::1]', '2001:0::abcd']) {
    assert.equal(diversityBucketForAddress(spelling, 4001), bucket, spelling)
  }
  assert.equal(diversityBucketForAddress('2001:db8:abcd:12::1', 1), diversityBucketForAddress('2001:DB8:ABCD::ffff', 2))
  assert.notEqual(diversityBucketForAddress('2001:db8:abcd::1', 1), diversityBucketForAddress('2001:db8:abce::1', 1))
  assert.equal(diversityBucketForAddress('::ffff:198.51.100.7', 1), diversityBucketForAddress('198.51.100.200', 1), 'IPv4-mapped is its IPv4 /24')
  assert.equal(diversityBucketForAddress('::ffff:c633:6407', 1), diversityBucketForAddress('198.51.100.7', 1), 'hex-mapped too')
  assert.equal(diversityBucketForAddress('::1', 4001, false), null)
  assert.equal(diversityBucketForAddress('::ffff:127.0.0.1', 4001, false), null)
  assert.equal(diversityBucketForAddress('not:an:address::x', 1), null)
})

test('a guard keeps live routes and rendezvous slots with the session that registered them', { timeout: 90_000 }, async t => {
  const testnet = await createTestnet(3)
  const guard = await createPrivateGuard({ host: '127.0.0.1', bootstrap: testnet.bootstrap })
  const dht = new HyperDHT({ host: '127.0.0.1', bootstrap: testnet.bootstrap, port: [0, 0] })
  await dht.ready()
  const sessions = []
  t.after(async () => {
    for (const s of sessions) s.close()
    await dht.destroy({ force: true })
    await guard.close()
    await testnet.destroy()
  })
  const owner = await endpoint(dht, guard.publicKey)
  const thief = await endpoint(dht, guard.publicKey)
  sessions.push(owner, thief)

  const token = randomBytes(32)
  const register = s => s.rpc.call('register', { routeToken: token, ttlMs: 600_000 }).then(r => r.status)
  assert.equal(await register(owner), 1, 'owner registers its route token')
  assert.equal(await register(thief), 0, 'another session cannot take over a live route token')
  assert.equal(await register(owner), 1, 'the owner may refresh its own token')
  assert.equal(guard.stats().registeredRoutes, 1)

  const topic = randomBytes(32)
  const slot = randomBytes(16)
  const cardA = randomBytes(64)
  const cardB = randomBytes(64)
  const rvRegister = (s, slotId, card) => s.rpc.call('rvRegister', { topic, slotId, ttlMs: 600_000, sealedCard: card }).then(r => r.status)
  assert.equal(await rvRegister(owner, slot, cardA), 1, 'owner registers its rendezvous slot')
  assert.equal(await rvRegister(thief, slot, cardB), 0, 'another session cannot overwrite a live slot')
  assert.equal(await rvRegister(thief, randomBytes(16), cardB), 1, 'it may register a slot of its own')
  // Not its slot: ignored. The thief's next request on the same channel is handled after that event.
  thief.rpc.emit('rvUnregister', { topic, slotId: slot })
  await thief.rpc.call('rvFetch', { key: topic })

  const lookup = async s => (await s.rpc.call('rvLookup', { key: topic })).cards.map(hex)
  const listed = await lookup(owner)
  assert.ok(listed.includes(hex(cardA)), 'the owner\'s card survives the overwrite and the unregister')
  assert.ok(listed.includes(hex(cardB)), 'the other session\'s own slot is listed')
  assert.equal(listed.length, 2)

  // A slot registered and withdrawn back to back on one channel (one batch) ends withdrawn: frames are handled in
  // wire order, so the withdrawal never overtakes the registration.
  const batched = randomBytes(32)
  owner.rpc.channel.cork()
  const registering = owner.rpc.call('rvRegister', { topic: batched, slotId: slot, ttlMs: 600_000, sealedCard: cardA })
  owner.rpc.emit('rvUnregister', { topic: batched, slotId: slot })
  owner.rpc.channel.uncork()
  assert.equal((await registering).status, 1)
  assert.equal(guard.stats().rendezvousTopics, 1, 'only the first topic is still registered')

  // DHT-driving ops are rate-limited per connection. A real mutable record makes `getMutable` answer with it until
  // the limit refuses (no record).
  const mKey = HyperDHT.keyPair(randomBytes(32))
  await dht.mutablePut(mKey, Buffer.from('live-card'))
  assert.ok((await owner.rpc.call('getMutable', { key: mKey.publicKey })).record, 'guard sees the mutable record before the burst')
  const hits = await Promise.all(Array.from({ length: 262 }, () => thief.rpc.call('getMutable', { key: mKey.publicKey }).then(r => Boolean(r.record))))
  const okCount = hits.filter(Boolean).length
  const refusedCount = hits.length - okCount
  assert.ok(okCount >= 240 && okCount <= 256, `session gets up to 256 DHT ops per 10 s (got ${okCount})`)
  assert.ok(refusedCount >= 6, `session DHT ops past 256 per 10 s are refused (got ${refusedCount})`)
  // Meanwhile `owner` has its own independent quota and still lists cards cleanly.
  assert.equal((await lookup(owner)).length, 2, 'other sessions are unaffected by a noisy endpoint')

  // The owner's own withdrawal removes its slot (the lookup after it on the same channel sees it gone).
  owner.rpc.emit('rvUnregister', { topic, slotId: slot })
  assert.deepEqual(await lookup(owner), [hex(cardB)], 'the owner\'s own withdrawal removes its slot')

  Object.assign(checks, { routeTakeoverRefused: true, slotOverwriteRefused: true, foreignUnregisterIgnored: true, orderedWithdrawal: true, dhtRateLimited: true, cardsListed: listed.length })
})

// What a guard channel grants belongs to that channel: closing it (the connection stays) releases its route and
// slot, and a channel opened again on the connection has no role until a new hello. The DHT-operation budget is the
// connection's, so opening the channel again does not reset it.
test('a guard channel\'s role and reservations end with the channel; its connection keeps the rate budget', { timeout: 90_000 }, async t => {
  const testnet = await createTestnet(3)
  const guard = await createPrivateGuard({ host: '127.0.0.1', bootstrap: testnet.bootstrap })
  const dht = new HyperDHT({ host: '127.0.0.1', bootstrap: testnet.bootstrap, port: [0, 0] })
  await dht.ready()
  t.after(async () => {
    await dht.destroy({ force: true })
    await guard.close()
    await testnet.destroy()
  })
  const conn = await connect(dht, guard.publicKey)
  const open = () => openChannel(conn, { spec: GUARD, label: 'Guard', ...opened })
  const register = rpc => rpc.call('register', { routeToken: randomBytes(32), ttlMs: 60_000 }).then(r => r.status)
  const mKey = HyperDHT.keyPair(randomBytes(32))
  await dht.mutablePut(mKey, Buffer.from('live-card'))
  const found = rpc => rpc.call('getMutable', { key: mKey.publicKey }).then(r => Boolean(r.record))

  let rpc = await open()
  assert.equal((await rpc.call('hello', { role: 'endpoint' })).status, 1)
  assert.equal(await register(rpc), 1)
  assert.equal((await rpc.call('rvRegister', { topic: randomBytes(32), slotId: randomBytes(16), ttlMs: 60_000, sealedCard: randomBytes(64) })).status, 1)
  assert.deepEqual([guard.stats().registeredRoutes, guard.stats().rendezvousTopics], [1, 1])
  const burst = await Promise.all(Array.from({ length: 256 }, () => found(rpc)))
  assert.ok(burst.filter(Boolean).length >= 240, 'the burst used the budget')
  assert.equal(await found(rpc), false, 'the budget is spent')

  rpc.close()
  await until(() => guard.stats().registeredRoutes === 0 && guard.stats().rendezvousTopics === 0, 5000, 'route and slot released')
  assert.equal(conn.destroyed, false, 'closing the channel leaves the connection')

  rpc = await open()
  assert.equal(await register(rpc), 0, 'a channel opened again has no role before hello')
  assert.equal((await rpc.call('hello', { role: 'endpoint' })).status, 1)
  assert.equal(await found(rpc), false, 'and the connection\'s spent budget stays spent')
  const other = await endpoint(dht, guard.publicKey)
  assert.equal(await found(other.rpc), true, 'while another connection has its own')
  other.close()
  conn.destroy()
  Object.assign(checks, { channelStateReleased: true, reopenedChannelHasNoRole: true, budgetKeptByConnection: true })
})

// As released, a mutable put whose value is over 512 bytes spends one slot of the connection's DHT-rate budget and
// is refused; an empty one is refused without spending one.
test('an oversized mutable put spends a DHT-rate slot, an empty one does not', { timeout: 90_000 }, async t => {
  const testnet = await createTestnet(3)
  const guard = await createPrivateGuard({ host: '127.0.0.1', bootstrap: testnet.bootstrap })
  const dht = new HyperDHT({ host: '127.0.0.1', bootstrap: testnet.bootstrap, port: [0, 0] })
  await dht.ready()
  const owner = await endpoint(dht, guard.publicKey)
  t.after(async () => {
    owner.close()
    await dht.destroy({ force: true })
    await guard.close()
    await testnet.destroy()
  })
  const mKey = HyperDHT.keyPair(randomBytes(32))
  await dht.mutablePut(mKey, Buffer.from('live-card'))
  const found = () => owner.rpc.call('getMutable', { key: mKey.publicKey }).then(r => Boolean(r.record))
  const puts = (n, size) => Promise.all(Array.from({ length: n }, () => owner.rpc.call('putMutable', { publicKey: randomBytes(32), seq: 1, signature: randomBytes(64), value: randomBytes(size) }).then(r => r.status)))
  assert.deepEqual(new Set(await puts(256, 0)), new Set([0]), 'empty values are refused')
  assert.equal(await found(), true, 'without spending the budget (1 of 256 used)')
  assert.deepEqual(new Set(await puts(255, 513)), new Set([0]), 'values over 512 bytes are refused')
  assert.equal(await found(), false, 'after each spent a slot (256 of 256 used)')
  Object.assign(checks, { oversizedPutCharged: true, emptyPutFree: true })
})

test('a guard answers or drops hostile frames on its v2 channel, keeps the connection, and refuses the old protocol', { timeout: 90_000 }, async t => {
  const testnet = await createTestnet(3)
  const guard = await createPrivateGuard({ host: '127.0.0.1', bootstrap: testnet.bootstrap })
  const dht = new HyperDHT({ host: '127.0.0.1', bootstrap: testnet.bootstrap, port: [0, 0] })
  await dht.ready()
  t.after(async () => {
    await dht.destroy({ force: true })
    await guard.close()
    await testnet.destroy()
  })
  const conn = await connect(dht, guard.publicKey)
  const peer = rawChannel(conn)
  assert.equal(await peer.opened, true, 'the guard takes the channel')
  // Each answer as (kind, op, id), then its value.
  const answer = async (id, kind, opIndex, encoding) => {
    const f = await reply(peer, id)
    assert.deepEqual([f?.kind, f?.op, f?.id], [kind, opIndex, id], `the answer to ${id}`)
    return c.decode(encoding, f.value)
  }
  // A request that needs a role, before any hello: refused.
  peer.send(frame(0, op('register'), 19, c.encode(REGISTER, { routeToken: randomBytes(32), ttlMs: 60_000 })))
  assert.equal((await answer(19, 1, op('register'), ACK)).status, 0, 'register before hello is refused')
  assert.equal(guard.stats().registeredRoutes, 0)
  peer.send(b4a.alloc(70 * 1024, 0x61)) // over the frame cap
  peer.send(b4a.concat([varint53, b4a.from([0, 1, 0])])) // kind at 2^53
  peer.send(b4a.concat([b4a.from([0]), varint53, b4a.from([1, 0])])) // op at 2^53
  peer.send(b4a.concat([b4a.from([0, 0]), varint53, b4a.from([0])])) // id at 2^53
  peer.send(frame(4, 0, 90, b4a.alloc(0))) // kind 4
  peer.send(frame(0, op('hello'), 0, c.encode(HELLO, { role: 'endpoint' }))) // id 0
  peer.send(frame(0, op('register'), 20, b4a.from([0xff]))) // a value that does not decode
  const askedUnknown = Date.now()
  peer.send(frame(0, op('circuitDead'), 21, b4a.alloc(0))) // an event op as a request
  peer.send(frame(0, 99, 22, b4a.alloc(0))) // beyond the op list
  peer.send(frame(0, op('hello'), 23, c.encode(HELLO, { role: 'bogus' }))) // not a role
  assert.equal((await answer(20, 2, op('register'), REMOTE_ERROR)).code, 'DECODE_ERROR')
  assert.equal((await answer(21, 2, op('circuitDead'), REMOTE_ERROR)).code, 'UNKNOWN_OP')
  assert.equal((await answer(22, 2, 99, REMOTE_ERROR)).code, 'UNKNOWN_OP')
  assert.ok(Date.now() - askedUnknown < 1000, 'unknown ops are answered at once')
  assert.equal((await answer(23, 1, op('hello'), ACK)).status, 0, 'an unknown role is refused')
  assert.equal(peer.frames.has(0) || peer.frames.has(90), false, 'id 0 and kind 4 are not answered')

  // The same channel still works: hello as an endpoint, then a route.
  peer.send(frame(0, op('hello'), 24, c.encode(HELLO, { role: 'endpoint' })))
  assert.equal((await answer(24, 1, op('hello'), ACK)).status, 1)
  peer.send(frame(0, op('register'), 25, c.encode(REGISTER, { routeToken: randomBytes(32), ttlMs: 60_000 })))
  assert.equal((await answer(25, 1, op('register'), ACK)).status, 1)
  assert.equal(guard.stats().registeredRoutes, 1)
  assert.equal(conn.destroyed, false, 'hostile frames do not cost the connection')

  // Seven bad frames so far; the eighth closes the channel, and the connection stays.
  peer.send(b4a.from([0xff]))
  for (let i = 0; i < 100 && !peer.channel.closed; i++) await sleep(50)
  assert.equal(peer.channel.closed, true, 'eight bad frames close the channel')
  assert.equal(conn.destroyed, false, 'the connection stays')

  // A peer on the old version opens the old name: refused, and the connection stays.
  assert.equal(await rawChannel(conn, 'peartube/private-guard/v1').opened, false, 'the guard refuses peartube/private-guard/v1')
  assert.equal(conn.destroyed, false)
  Object.assign(checks, { hostileFramesAnswered: true, oversizedFrameDropped: true, oldProtocolRefused: true })
})

// publishStandaloneRouteCard needs status 1 at hello, register and putMutable; a refusal at any step closes its
// connection (and its DHT) before the error.
test('the standalone publisher stops at a refused step and closes its connection', { timeout: 90_000 }, async t => {
  const testnet = await createTestnet(3)
  const closers = []
  t.after(async () => {
    for (const close of closers.reverse()) await close().catch(() => {})
    await testnet.destroy()
  })
  const steps = ['hello', 'register', 'putMutable']
  for (const refused of steps) {
    const handlers = Object.fromEntries(steps.map(name => [name, () => ({ status: name === refused ? 0 : 1 })]))
    const fake = await fakeGuard(testnet, closers, [], conn => serveChannel(conn, { spec: GUARD, label: 'Publisher', handlers }))
    const publishing = publishStandaloneRouteCard({ bootstrap: testnet.bootstrap, guardPublicKey: fake.publicKey, advertisedKeyPair: HyperDHT.keyPair(randomBytes(32)) })
    await assert.rejects(publishing, new RegExp(`refused ${refused}`), `a refused ${refused} fails the publication`)
    assert.equal(fake.accepted, 1)
    await until(() => fake.open.size === 0, 2000, `${refused}: the publisher closed its connection`)
  }
  Object.assign(checks, { standaloneRefusalFails: true })
})

// A stand-in guard on the guard topics of `versions` (none: not announced); `serve(conn, fake)` sets up what it
// speaks. It counts the connections clients make to it, keeps the open ones with the time they opened, and when its
// own code closes a channel, the time it did per connection.
async function fakeGuard (testnet, closers, versions, serve) {
  const node = new HyperDHT({ host: '127.0.0.1', bootstrap: testnet.bootstrap, port: [0, 0] })
  closers.push(() => node.destroy({ force: true }))
  const keyPair = HyperDHT.keyPair(randomBytes(32))
  const fake = { publicKey: keyPair.publicKey, accepted: 0, open: new Map(), channelClosed: new Map() }
  const server = node.createServer({ firewall: () => false }, conn => {
    conn.on('error', () => {})
    fake.accepted++
    fake.open.set(conn, Date.now())
    conn.once('close', () => fake.open.delete(conn))
    serve(conn, fake)
  })
  await server.listen(keyPair)
  for (const v of versions) for (let s = 0; s < 4; s++) await node.announce(HyperDHT.hash(b4a.from(`peartube/private-guard/${v}/${s}`)), keyPair).finished()
  return fake
}

// Guards that speak only the old protocol (announced on the old topics and, say by a mistake, on the new ones), and a
// v2 guard that does not accept the client's hello, are not usable: the client never reaches READY, closes each
// connection it made to one at once, and never dials the peer it wants by any other way: no dial to that key reaches
// it, completed or not, over two of the client's 4 s retry cycles.
test('a client whose guards speak only the old protocol, or refuse its hello, stays UNAVAILABLE and dials nobody', { timeout: 120_000 }, async t => {
  const testnet = await createTestnet(3)
  const closers = []
  t.after(async () => {
    for (const close of closers.reverse()) await close().catch(() => {})
    await testnet.destroy()
  })
  let oldOpens = 0
  const oldGuards = []
  for (let i = 0; i < 2; i++) {
    oldGuards.push(await fakeGuard(testnet, closers, ['v1', 'v2'], conn => Protomux.from(conn).pair({ protocol: 'peartube/private-guard/v1' }, () => { oldOpens++ })))
  }
  let refusedHellos = 0
  const refusing = await fakeGuard(testnet, closers, ['v2'], conn => serveChannel(conn, { spec: GUARD, label: 'Endpoint', handlers: { hello: () => { refusedHellos++; return { status: 0 } } } }))
  // The peer the client wants to reach, reachable directly: every handshake that reaches it is counted and refused.
  const destination = new HyperDHT({ host: '127.0.0.1', bootstrap: testnet.bootstrap, port: [0, 0] })
  closers.push(() => destination.destroy({ force: true }))
  let destinationAttempts = 0
  const destinationServer = destination.createServer({ firewall: () => { destinationAttempts++; return true } }, conn => conn.destroy())
  const destinationKey = HyperDHT.keyPair(randomBytes(32))
  await destinationServer.listen(destinationKey)

  const swarm = await createPrivateSwarm({ host: '127.0.0.1', bootstrap: testnet.bootstrap })
  closers.push(() => swarm.destroy())
  await swarm.listening
  swarm.joinPeer(destinationKey.publicKey)
  await sleep(9000)
  assert.equal(swarm.dht.privateRouting.status(), 'UNAVAILABLE', 'no usable guard: the client reports UNAVAILABLE')
  assert.equal(swarm.dht.privateRouting.exposureReport().guards, 0)
  assert.equal(oldOpens, 0, 'the old guards never saw a channel from it')
  assert.ok(refusedHellos >= 1, 'the v2 guard that refuses was asked hello')
  for (const g of [...oldGuards, refusing]) {
    assert.ok(g.accepted >= 1, 'the client tried each guard it found under the v2 topics')
    assert.ok([...g.open.values()].every(at => Date.now() - at < 2000), 'and closed each connection to it at once')
  }
  assert.equal(swarm.connections.size, 0, 'it has no peer connection')
  assert.equal(destinationAttempts, 0, 'no dial to the destination reached it')
  Object.assign(checks, { oldGuardsUnusable: true, refusedHelloUnusable: true, guardConnectionsClosed: true, unavailable: true, noDirectDial: true })
})

// A guard that accepts hello and then closes the channel (not the connection) is no longer usable: the client, an
// endpoint or a guard that dialed it as a hop, closes its connection to it at once.
test('a client closes its connection to a guard that closes an accepted channel', { timeout: 90_000 }, async t => {
  const testnet = await createTestnet(3)
  const closers = []
  t.after(async () => {
    for (const close of closers.reverse()) await close().catch(() => {})
    await testnet.destroy()
  })
  const closesAfterHello = (conn, fake) => serveChannel(conn, {
    spec: GUARD,
    label: 'Client',
    handlers: {
      hello (_, control) {
        setTimeout(() => { fake.channelClosed.set(conn, Date.now()); control.close() }, 200)
        return { status: 1 }
      }
    }
  })
  const closedAtOnce = async (fake, label) => {
    await until(() => fake.channelClosed.size, 20_000, `${label}: accepted, then its channel closed`)
    const [conn] = fake.channelClosed.keys()
    await until(() => !fake.open.has(conn), 1000, `${label}: the connection closed at once`)
  }

  // An endpoint (the private swarm) that found it under the v2 topics.
  const announced = await fakeGuard(testnet, closers, ['v2'], closesAfterHello)
  const swarm = await createPrivateSwarm({ host: '127.0.0.1', bootstrap: testnet.bootstrap })
  closers.push(() => swarm.destroy())
  await closedAtOnce(announced, 'endpoint')

  // A guard asked to dial through it as the next hop.
  const hop = await fakeGuard(testnet, closers, [], closesAfterHello)
  const guard = await createPrivateGuard({ host: '127.0.0.1', bootstrap: testnet.bootstrap })
  closers.push(() => guard.close())
  const dht = new HyperDHT({ host: '127.0.0.1', bootstrap: testnet.bootstrap, port: [0, 0] })
  closers.push(() => dht.destroy({ force: true }))
  const ep = await endpoint(dht, guard.publicKey)
  await ep.rpc.call('dialOpen', { guardKey: hop.publicKey, routeToken: randomBytes(32), udxId: 5, bucket: '' }, 15_000)
  await closedAtOnce(hop, 'hop')
  ep.close()
  Object.assign(checks, { closedChannelGuardDropped: true })
})

// A client is READY, and dials, only with two usable guards (channel open, connection up). Two stand-in guards: the
// primary's putMutable answer is held while the secondary closes its channel (and refuses hello from then on); the
// late answer does not make the client READY, and a dial asked for meanwhile goes nowhere. Once the secondary takes
// hello again the client is READY. Then the guard a dial goes through closes its channel while asked: with one usable
// guard left, the dial goes nowhere else.
test('a client is READY and dials only with two usable guards', { timeout: 120_000 }, async t => {
  const testnet = await createTestnet(3)
  const closers = []
  t.after(async () => {
    for (const close of closers.reverse()) await close().catch(() => {})
    await testnet.destroy()
  })
  // A peer's route card, published through a stand-in the way a real endpoint does, for the guards to hand out.
  const target = HyperDHT.keyPair(randomBytes(32))
  let record = null
  const recorder = await fakeGuard(testnet, closers, [], conn => serveChannel(conn, {
    spec: GUARD,
    label: 'Publisher',
    handlers: { hello: () => ({ status: 1 }), register: () => ({ status: 1 }), putMutable: ({ seq, signature, value }) => { record = { seq, signature, value }; return { status: 1 } } }
  }))
  closers.push(await publishStandaloneRouteCard({ bootstrap: testnet.bootstrap, guardPublicKey: recorder.publicKey, advertisedKeyPair: target }))

  let heldPut = null // the first putMutable: its answer waits for `release`
  const dialOpens = [] // the guard each dialOpen went to; none is ever answered
  const standIn = async () => {
    const fake = await fakeGuard(testnet, closers, ['v2'], (conn, g) => serveChannel(conn, {
      spec: GUARD,
      label: 'Endpoint',
      onOpen: control => { g.control = control },
      handlers: {
        hello: () => ({ status: g.accepting ? 1 : 0 }),
        register: () => ({ status: 1 }),
        putMutable: () => heldPut ? { status: 1 } : new Promise(resolve => { heldPut = { fake: g, release: () => resolve({ status: 1 }) } }),
        rvRegister: () => ({ status: 1 }),
        getMutable: () => ({ record }),
        rvLookup: () => ({ cards: [] }),
        dialOpen: () => { dialOpens.push(g); return new Promise(() => {}) }
      }
    }))
    fake.accepting = true
    return fake
  }
  const a = await standIn()
  const b = await standIn()
  const swarm = await createPrivateSwarm({ host: '127.0.0.1', bootstrap: testnet.bootstrap })
  closers.push(() => swarm.destroy())
  const status = () => swarm.dht.privateRouting.status()
  const usable = () => swarm.dht.privateRouting.exposureReport().guards

  await until(() => heldPut, 20_000, 'the primary was asked putMutable')
  const secondary = heldPut.fake === a ? b : a
  secondary.accepting = false
  secondary.control.close()
  await until(() => usable() === 1, 2000, 'one usable guard left')
  let sawReady = false
  const watch = setInterval(() => { if (status() === 'READY') sawReady = true }, 1)
  heldPut.release()
  swarm.joinPeer(target.publicKey)
  await sleep(1500)
  clearInterval(watch)
  assert.equal(sawReady, false, 'the late putMutable answer does not make a one-guard client READY')
  assert.notEqual(status(), 'READY')
  assert.equal(dialOpens.length, 0, 'and it dials nobody')

  secondary.accepting = true
  await until(() => status() === 'READY', 20_000, 'READY again with a second usable guard')

  await until(() => dialOpens.length === 1, 20_000, 'the client dials the target through one guard')
  const asked = dialOpens[0]
  asked.accepting = false
  asked.control.close()
  await sleep(1500)
  // By name: the stand-ins hold live connections, too large to print in a failure.
  assert.deepEqual(dialOpens.map(g => g === asked ? 'asked' : 'the other guard'), ['asked'], 'with one usable guard left, the dial goes nowhere else')
  Object.assign(checks, { readyOnlyWithTwoUsable: true, noDialWithOneUsable: true })
})

// attemptDirectHopBypass (src/private-overlay.js) folds both probes into one boolean each. Here each is seen on its
// own: an endpoint's hello is accepted and its hopOpen refused with status 0, though the route exists and its owner
// would take any circuit; an unadvertised key that claims the hop role loses its connection.
test('a destination guard refuses hopOpen from an endpoint and cuts off an unadvertised hop claim', { timeout: 90_000 }, async t => {
  const testnet = await createTestnet(3)
  const guard = await createPrivateGuard({ host: '127.0.0.1', bootstrap: testnet.bootstrap })
  const dht = new HyperDHT({ host: '127.0.0.1', bootstrap: testnet.bootstrap, port: [0, 0] })
  await dht.ready()
  const conns = []
  t.after(async () => {
    for (const conn of conns) conn.destroy()
    await dht.destroy({ force: true })
    await guard.close()
    await testnet.destroy()
  })
  let incOpens = 0
  const ownerConn = await connect(dht, guard.publicKey)
  conns.push(ownerConn)
  const owner = await openChannel(ownerConn, { spec: GUARD, label: 'Guard', handlers: { incOpen: () => { incOpens++; return { status: 1, udxId: 7 } } }, ...opened })
  assert.equal((await owner.call('hello', { role: 'endpoint' })).status, 1)
  const routeToken = randomBytes(32)
  assert.equal((await owner.call('register', { routeToken, ttlMs: 60_000 })).status, 1)

  const ep = await endpoint(dht, guard.publicKey) // its hello is accepted
  conns.push(ep.conn)
  assert.deepEqual(await ep.rpc.call('hopOpen', { routeToken, udxId: 9 }), { status: 0, udxId: 0 }, 'an endpoint\'s hopOpen is refused')
  assert.equal(incOpens, 0, 'and the owner was never asked')

  const claimer = await connect(dht, guard.publicKey)
  conns.push(claimer)
  const rpc = await openChannel(claimer, { spec: GUARD, label: 'Guard', ...opened })
  await assert.rejects(rpc.call('hello', { role: 'hop' }, 10_000), /connection closed/, 'no answer to the hop claim')
  await until(() => claimer.destroyed, 5000, 'the guard cut off the connection')
  Object.assign(checks, { endpointHopOpenRefused: true, unadvertisedHopCutOff: true })
  writeResult()
})

function writeResult () {
  mkdirSync(join(root, 'desktop/target/e2e'), { recursive: true })
  writeFileSync(artifact, JSON.stringify({ at: new Date().toISOString(), passed: true, checks }, null, 2) + '\n')
}
