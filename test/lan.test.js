import test from 'node:test'
import assert from 'node:assert/strict'
import HyperDHT from 'hyperdht'
import Hyperswarm from 'hyperswarm'
import Protomux from 'protomux'
import c from 'compact-encoding'
import b4a from 'b4a'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import createTestnet from 'hyperdht/testnet.js'
import { getEncoding } from '../spec/hyperschema/index.js'
import { CAST } from '../spec/protocols.js'
import { createNode } from '../src/index.js'
import { createReceiver, idleCastState } from '../src/cast.js'
import { commandToWire, openControl, pairedFromWire, stateFromWire, stateToWire } from '../src/cast-control.js'
import { selfAddressAdapter, createLan } from '../src/lan.js'
import { mdnsBus } from './mdns.js'

// Errors that reach the process: a peer's bytes must never cause one.
function processFaults (t) {
  const faults = []
  const onFault = err => faults.push(err)
  process.on('unhandledRejection', onFault)
  process.on('uncaughtException', onFault)
  t.after(() => {
    process.off('unhandledRejection', onFault)
    process.off('uncaughtException', onFault)
  })
  return faults
}

// Behind an mDNS reflector the packet's sender is the router. The peer must be
// dialed at the address it advertised for its own DHT, not at the reflector.
test('LAN discovery dials the advertised address, not the mDNS reflector', async () => {
  const published = []
  let deliver
  const inner = {
    advertise: record => { published.push(record); return { stop: async () => {} } },
    browse: (query, handlers) => { deliver = handlers.onService; return { stop: async () => {} } }
  }
  const adapter = selfAddressAdapter('10.0.40.100', inner)

  adapter.advertise({ name: 'n', txt: { v: '1', peerKey: 'k' } }, {})
  assert.deepEqual(published[0].txt, { v: '1', peerKey: 'k', h: '10.0.40.100' })

  const seen = []
  const browse = adapter.browse({ type: 'hyperdht-mdns' }, { onService: s => seen.push(s) })
  deliver({ txt: { h: '10.0.10.209' }, referer: { address: '10.0.40.1' }, addresses: ['10.0.40.1'] })
  assert.equal(seen[0].referer, null)
  assert.deepEqual(seen[0].addresses, ['10.0.10.209'])

  // A peer without the field (or with junk) passes through unchanged.
  deliver({ txt: { h: 'not-an-ip' }, referer: { address: '10.0.40.1' } })
  assert.deepEqual(seen[1].referer, { address: '10.0.40.1' })
  await browse.stop()
})

// A browse asks once. On Wi-Fi a phone can miss the one answer, and a peer
// stops announcing itself about 55 minutes after it starts, so the browse must
// start over to ask again. Ways that could fail: it never asks again; it stops the
// old browse before starting the new one, which closes the shared mDNS socket;
// old browses pile up; it keeps browsing after stop; or a failing browse throws
// out of the timer and takes the relay down.
test('a lost mDNS answer is asked for again: browsing starts over', async () => {
  const browses = []
  let running = 0
  let fewest = Infinity
  let failNext = false
  const inner = {
    advertise: () => ({ stop: async () => {} }),
    browse: (query, handlers) => {
      if (failNext) { failNext = false; throw new Error('mdns socket closed') }
      running++
      const browse = { handlers, stopped: false, stop: async () => { browse.stopped = true; running--; fewest = Math.min(fewest, running) } }
      browses.push(browse)
      return browse
    }
  }
  const errors = []
  const seen = []
  const adapter = selfAddressAdapter('10.0.40.100', inner, { rebrowse: 20 })
  const handle = adapter.browse({ type: 'hyperdht-mdns' }, { onService: s => seen.push(s), onError: err => errors.push(err.message) })

  // The first browse's answer is lost: nothing ever arrives on it.
  await new Promise(resolve => setTimeout(resolve, 75))
  assert.ok(browses.length >= 3, 'browsing started over and asked again')
  assert.ok(browses.slice(0, -1).every(b => b.stopped), 'each earlier browse was stopped')
  assert.equal(fewest, 1, 'a browse was always running, so the mDNS socket stayed open')

  failNext = true
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(errors, ['mdns socket closed'], 'a failed browse is reported, not thrown')
  assert.equal(browses.at(-1).stopped, false, 'the last good browse keeps running')

  browses.at(-1).handlers.onService({ txt: { h: '10.0.10.120' }, referer: { address: '10.0.10.1' } })
  assert.deepEqual(seen[0].addresses, ['10.0.10.120'], 'a later answer still finds the peer')

  await handle.stop()
  const count = browses.length
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(browses.length, count, 'no browsing after stop')
  assert.ok(browses.every(b => b.stopped), 'every browse was stopped')
})

// mDNS failures arrive asynchronously as 'error' events. Unhandled, one would
// throw out of a timer and take the whole relay (streaming, acquisitions) down.
test('an mDNS discovery error is reported, not fatal', async () => {
  const errors = []
  const original = console.error
  console.error = line => errors.push(line)
  const failing = {
    advertise: () => ({ stop: async () => {} }),
    browse: (query, handlers) => {
      setImmediate(() => handlers.onError(new Error('mdns socket closed')))
      return { stop: async () => {} }
    }
  }
  const lan = createLan({ host: '127.0.0.1', adapter: failing })
  try {
    await lan.ready()
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.ok(errors.some(line => line.includes('mdns socket closed')), 'the error was reported')
  } finally {
    console.error = original
    await lan.destroy()
  }
})

// The core hands each LAN connection to replication, which handles its errors.
// Here nothing else would: a peer closing first resets the other side.
const quiet = (...lans) => { for (const lan of lans) lan.on('connection', socket => socket.on('error', () => {})) }

// LAN discovery dials first from the peer with the smaller key. When that peer
// cannot reach the other (macOS's firewall drops unsolicited UDP to an app it
// has not allowed), the larger-key side dials after dialAfter. Ways a fix could
// fail: the larger-key side never dials; it dials a peer it already has a
// connection to; a failed dial throws; it dials after destroy.
test('a peer that cannot reach us is dialed from our side', async () => {
  const [low, high] = [HyperDHT.keyPair(), HyperDHT.keyPair()].sort((x, y) => b4a.compare(x.publicKey, y.publicKey))
  const bus = mdnsBus()
  const topic = b4a.alloc(32, 7)
  // low sees high at a port where nothing answers, as if high's firewall
  // dropped everything low sends. high sees low as it is.
  const unreachable = service => ({ ...service, port: 9 })
  const a = createLan({ host: '127.0.0.1', keyPair: low, adapter: bus(unreachable), dialAfter: 200 })
  const b = createLan({ host: '127.0.0.1', keyPair: high, adapter: bus(service => service), dialAfter: 200 })
  quiet(a, b)
  try {
    const opened = [a, b].map(lan => new Promise(resolve => lan.once('connection', resolve)))
    await Promise.all([a.ready(), b.ready()])
    a.join(topic)
    b.join(topic)
    const [fromA, fromB] = await Promise.race([
      Promise.all(opened),
      new Promise((resolve, reject) => setTimeout(reject, 10_000, new Error('the two never connected')))
    ])
    const said = new Promise(resolve => fromB.once('data', resolve))
    fromA.write(b4a.from('hello'))
    assert.equal(b4a.toString(await said), 'hello')

    // Once connected, nobody dials again.
    await new Promise(resolve => setTimeout(resolve, 800))
    assert.equal(a.connections.size, 1)
    assert.equal(b.connections.size, 1)
  } finally {
    await a.destroy()
    await b.destroy()
  }
})

// Two LAN peers dial each other at most once, and only for a shared topic.
async function pair ({ topics, dialAfter = 1000, wait = 2500 }) {
  const bus = mdnsBus()
  const lans = topics.map(() => createLan({ host: '127.0.0.1', keyPair: HyperDHT.keyPair(), adapter: bus(s => s), dialAfter }))
  quiet(...lans)
  const dials = []
  for (const lan of lans) {
    const connect = lan.dht.connect.bind(lan.dht)
    lan.dht.connect = (...args) => { dials.push(lan); return connect(...args) }
  }
  try {
    await Promise.all(lans.map(lan => lan.ready()))
    lans.forEach((lan, i) => lan.join(topics[i]))
    await new Promise(resolve => setTimeout(resolve, wait))
    return { connections: lans.map(lan => lan.connections.size), dials: dials.length }
  } finally {
    for (const lan of lans) await lan.destroy()
  }
}

// When both sides can reach each other, the smaller key dials and the other
// side must not add a second connection.
test('two peers that reach each other keep one connection', async () => {
  const topic = b4a.alloc(32, 8)
  const { connections, dials } = await pair({ topics: [topic, topic] })
  assert.deepEqual(connections, [1, 1])
  assert.equal(dials, 1, 'only the smaller key dialed')
})

// Two relays of different trackers on one network see each other over mDNS.
// Neither may dial: the other side would only drop the connection again.
test('peers with no topic in common never dial', async () => {
  const { connections, dials } = await pair({ topics: [b4a.alloc(32, 9), b4a.alloc(32, 10)], dialAfter: 200 })
  assert.deepEqual(connections, [0, 0])
  assert.equal(dials, 0)
})

// bonjour-service does not throw when an advertisement's name is taken: it logs and silently stops it. A name this
// peer used before can still be answered for (a cache, a reflector echoing the old record), so the same name must
// never be advertised twice. Ways a fix could fail: the topics A → A+B → A bring back A's name and the peer vanishes
// from the network; a peer that joins later never hears it; the old advertisement is left up instead.
test('a peer whose topics change back stays visible on the network', async () => {
  const bus = mdnsBus()
  const used = new Set()
  // Like bonjour-service on a network that remembers names: a name heard before is dropped without an error.
  const remembers = (adapter, { deaf = false } = {}) => ({
    advertise (record, handlers) {
      if (used.has(record.name)) return { stop: async () => {} }
      used.add(record.name)
      return adapter.advertise(record, handlers)
    },
    browse: (query, handlers) => deaf ? { stop: async () => {} } : adapter.browse(query, handlers)
  })
  const [x, y] = [b4a.alloc(32, 11), b4a.alloc(32, 12)]
  // a hears nobody, so the two connect only if b hears a's advertisement.
  const a = createLan({ host: '127.0.0.1', keyPair: HyperDHT.keyPair(), adapter: remembers(bus(s => s), { deaf: true }), dialAfter: 200 })
  quiet(a)
  let b = null
  try {
    await a.ready()
    const settle = () => new Promise(resolve => setTimeout(resolve, 150))
    a.join(x)
    await settle()
    a.join(y)
    await settle()
    a.leave(y)
    await settle()
    // b arrives now, so it can only learn of a from a's current advertisement.
    b = createLan({ host: '127.0.0.1', keyPair: HyperDHT.keyPair(), adapter: remembers(bus(s => s)), dialAfter: 200 })
    quiet(b)
    const opened = new Promise(resolve => b.once('connection', resolve))
    await b.ready()
    b.join(x)
    await Promise.race([opened, new Promise((resolve, reject) => setTimeout(reject, 10_000, new Error('a was not visible to b')))])
    assert.equal(b.connections.size, 1)
  } finally {
    await a.destroy()
    await b?.destroy()
  }
})

// Roaming off Wi-Fi onto cellular must never strand a peer that Hyperswarm saw while LAN was up,
// live `setAllowedPeers` updates must unban newly admitted keys and sever revoked ones, and `suspend`/`resume`
// must park and wake both Hyperswarm and Corestore cleanly.
test('roaming from LAN to public DHT, live setAllowedPeers unban, and node suspend/resume recover cleanly', async t => {
  const testnet = await createTestnet(3)
  const bus = mdnsBus()
  const mkTmp = () => mkdtempSync(join(tmpdir(), 'peartube-lan-roam-'))
  const until = async (fn, ms = 30_000, msg = 'timed out') => {
    const end = Date.now() + ms
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() > end) throw new Error(msg)
      await new Promise(resolve => setTimeout(resolve, 150))
    }
  }
  const zero = '0'.repeat(64)
  const blob = { blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 1 }
  const announce = id => ({ type: 'announce', id, title: id, size: 1, sha256: zero, blobs: zero, blob })

  const a = await createNode({
    storage: mkTmp(),
    bootstrap: testnet.bootstrap,
    lan: kp => createLan({ host: '127.0.0.1', keyPair: kp, adapter: bus(s => s), dialAfter: 200 })
  })
  await a.append(announce('imdb:tt9000001'))
  const channelKey = a.status().channel

  const b = await createNode({
    storage: mkTmp(),
    bootstrap: testnet.bootstrap,
    tracker: channelKey,
    lan: kp => createLan({ host: '127.0.0.1', keyPair: kp, adapter: bus(s => s), dialAfter: 200 })
  })
  t.after(async () => {
    await b.close()
    await a.close()
    await testnet.destroy()
  })

  await until(() => a.status().lanPeers === 1 && b.status().lanPeers === 1, 20_000, 'LAN link up')
  // Force Hyperswarm to touch the peer while LAN is active; the old firewall permanently banned it here.
  a.joinPeer(b.peerKey)
  await until(() => a.swarm.peers.has(b.peerKey), 10_000, 'Hyperswarm observed LAN peer without banning it')
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(a.swarm.peers.get(b.peerKey)?.banned ?? false, false, 'LAN peer was never banned in Hyperswarm')

  // Simulate walking off Wi-Fi onto public DHT only.
  await b.setLan(null)
  await a.setLan(null)
  await until(() => a.status().peers >= 1 && b.status().peers >= 1, 20_000, 'reconnected over public DHT after LAN drop')
  await a.append(announce('imdb:tt9000002'))
  await until(async () => (await b.search('imdb:tt9000002')).length === 1, 20_000, 'synced new publish over public DHT')

  // Live allowlist: revoking b drops its live connection and firewall-bans its next knock; re-admitting unbans it.
  a.setAllowedPeers(['f'.repeat(64)])
  await until(() => a.status().peers === 0, 10_000, 'revoked peer disconnected immediately')
  b.joinPeer(a.peerKey)
  await new Promise(resolve => setTimeout(resolve, 600))
  assert.equal(a.status().peers, 0, 'unlisted peer kept out')
  a.setAllowedPeers([b.peerKey])
  a.joinPeer(b.peerKey)
  await until(() => a.status().peers >= 1 && b.status().peers >= 1, 20_000, 'newly allowlisted peer unbanned and reconnected')

  // Suspend + resume parks and restores both Hyperswarm and Corestore without corrupting storage.
  await b.suspend()
  assert.equal(b.status().peers, 0, 'suspended node dropped swarm connections')
  await b.resume()
  b.joinPeer(a.peerKey)
  await a.append(announce('imdb:tt9000003'))
  await until(async () => (await b.search('imdb:tt9000003')).length === 1, 20_000, 'resumed node synced new entry')
})

// The cast channel spoken by hand (peartube-cast/v2 frames, spec/protocols.js), to send what a real sender or receiver
// never would. These fail before v2: the cast channel was peartube-cast/v1 with JSON messages.
const FRAME = getEncoding('@peartube/frame')
const REMOTE_ERROR = getEncoding('@peartube/remote-error')
const PAIR = getEncoding('@peartube/cast-pair')
const COMMAND = getEncoding('@peartube/cast-command')
const STATE = getEncoding('@peartube/cast-state')
const castOp = name => CAST.ops.findIndex(o => o.name === name)
const frame = (kind, op, id, value) => c.encode(FRAME, { kind, op, id, value })
const varint53 = b4a.from([0xff, 0, 0, 0, 0, 0, 0, 0x20, 0])
const hugeCount = b4a.from([0xfe, 0x00, 0x00, 0x10, 0x00]) // an array count of 1,048,576
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// The first connection `swarm` gets after it dials `publicKey`.
function dial (swarm, publicKey) {
  return new Promise(resolve => {
    swarm.once('connection', conn => { conn.on('error', () => {}); resolve(conn) })
    swarm.joinPeer(publicKey)
  })
}

// A raw channel under `protocol`: every frame the other side sends, by id, and whether it ever opened.
function rawChannel (conn, protocol = CAST.protocol) {
  const frames = new Map()
  let opened
  const openedP = new Promise(resolve => { opened = resolve })
  const channel = Protomux.from(conn).createChannel({ protocol, id: null, onopen: () => opened(true), onclose: () => opened(false) })
  const msg = channel.addMessage({ encoding: c.raw, onmessage: buf => { const f = c.decode(FRAME, buf); frames.set(f.id, f) } })
  channel.open()
  return { channel, frames, opened: openedP, send: buf => msg.send(buf) }
}

async function reply (peer, id, ms = 5000) {
  const end = Date.now() + ms
  while (!peer.frames.has(id) && Date.now() < end) await sleep(50)
  return peer.frames.get(id) || null
}

test('a receiver outlives hostile frames on its cast channel, refuses the old protocol, and asks a far peer for its token', async t => {
  const faults = processFaults(t)
  const testnet = await createTestnet(3)
  const mkTmp = () => mkdtempSync(join(tmpdir(), 'peartube-cast-cap-'))
  const node = await createNode({ storage: mkTmp(), bootstrap: testnet.bootstrap })
  const receiver = await createReceiver({ storage: mkTmp(), node, openAuth: true })
  const stranger = new Hyperswarm({ bootstrap: testnet.bootstrap })
  t.after(async () => {
    await stranger.destroy({ force: true })
    await receiver.close()
    await node.close()
    await testnet.destroy()
  })

  const conn = await dial(stranger, b4a.from(receiver.publicKey, 'hex'))
  const peer = rawChannel(conn)
  assert.equal(await peer.opened, true, 'a receiver takes the cast channel')
  peer.send(b4a.alloc(70 * 1024, 0x61)) // over the frame cap
  peer.send(b4a.concat([varint53, b4a.from([0, 1, 0])])) // kind at 2^53
  peer.send(b4a.concat([b4a.from([0]), varint53, b4a.from([1, 0])])) // op at 2^53
  peer.send(b4a.concat([b4a.from([0, 0]), varint53, b4a.from([0])])) // id at 2^53
  peer.send(frame(4, 0, 90, b4a.alloc(0))) // kind 4
  peer.send(frame(0, castOp('command'), 0, c.encode(COMMAND, commandToWire({ action: 'status' }, '')))) // id 0
  peer.send(frame(0, castOp('command'), 20, b4a.from([0xff]))) // a value that does not decode
  const askedUnknown = Date.now()
  peer.send(frame(0, castOp('state'), 21, b4a.alloc(0))) // an event op as a request
  peer.send(frame(0, 9, 22, b4a.alloc(0))) // beyond the op list
  peer.send(frame(0, castOp('command'), 9, c.encode(COMMAND, commandToWire({ action: 'status' }, ''))))
  peer.send(frame(0, castOp('pair'), 10, c.encode(PAIR, { code: '' })))
  const errorOf = async id => c.decode(REMOTE_ERROR, (await reply(peer, id)).value)
  assert.equal((await errorOf(20)).code, 'DECODE_ERROR')
  assert.equal((await errorOf(21)).code, 'UNKNOWN_OP')
  assert.equal((await errorOf(22)).code, 'UNKNOWN_OP')
  assert.ok(Date.now() - askedUnknown < 1000, 'unknown ops are answered at once')
  const unauthorized = await errorOf(9)
  assert.equal(unauthorized.code, 'HANDLER_ERROR')
  assert.match(unauthorized.message, /Unauthorized/, 'an open receiver still asks a peer from across the DHT for its token')
  assert.match((await errorOf(10)).message, /Invalid TV pairing code/, 'and still asks it for the TV code')
  assert.equal(peer.frames.has(0) || peer.frames.has(90), false, 'id 0 and kind 4 are not answered')
  assert.equal(conn.destroyed, false, 'hostile frames do not cost the peer its connection')

  // That was seven bad frames; the eighth closes the channel, and the connection stays.
  peer.send(b4a.from([0xff]))
  for (let i = 0; i < 100 && !peer.channel.closed; i++) await sleep(50)
  assert.equal(peer.channel.closed, true, 'eight bad frames close the channel')
  const again = rawChannel(conn)
  assert.equal(await again.opened, true, 'a new channel on the same connection')
  again.send(frame(0, castOp('pair'), 1, c.encode(PAIR, { code: '' })))
  assert.ok(await reply(again, 1), 'is answered')

  // A sender on the old version opens the old name: refused, and the connection stays.
  assert.equal(await rawChannel(conn, 'peartube-cast/v1').opened, false, 'the receiver refuses peartube-cast/v1')
  assert.equal(conn.destroyed, false)
  assert.equal(receiver.info().protocol, 'peartube-cast/v2')
  assert.deepEqual(faults, [], 'no frame from a peer reaches the process as an error')
})

// An open receiver is open to the room it is in, not to every peer that can find it: a LAN link pairs without a code
// and gets no permanent token, so only a device on that link can control this TV. Its commands reach the TV's host
// as the objects they did before v2.
test('an open receiver hands its LAN link no pair token, and applies each command as before', async t => {
  const faults = processFaults(t)
  const testnet = await createTestnet(3)
  const bus = mdnsBus()
  const mkTmp = () => mkdtempSync(join(tmpdir(), 'peartube-cast-open-'))
  const lan = keyPair => createLan({ host: '127.0.0.1', keyPair, adapter: bus(s => s), dialAfter: 200 })
  const receiverNode = await createNode({ storage: mkTmp(), bootstrap: testnet.bootstrap, lan })
  const senderNode = await createNode({ storage: mkTmp(), bootstrap: testnet.bootstrap, lan })
  const hostGot = []
  const receiver = await createReceiver({ storage: mkTmp(), node: receiverNode, openAuth: true, onCommand: cmd => { hostGot.push(cmd) } })
  t.after(async () => {
    await receiver.close()
    for (const n of [senderNode, receiverNode]) await n.close()
    await testnet.destroy()
  })

  // LAN discovery links two peers that share a topic: the sender's link to the receiver.
  const topic = b4a.alloc(32, 13)
  receiverNode.joinLanTopic('test-cast', topic)
  senderNode.joinLanTopic('test-cast', topic)
  const deadline = Date.now() + 20_000
  let conn = null
  while (!conn && Date.now() < deadline) {
    conn = [...senderNode.peerConnections()].find(c => c.remotePublicKey && b4a.toString(c.remotePublicKey, 'hex') === receiver.publicKey) || null
    if (!conn) await sleep(100)
  }
  assert.ok(conn, 'the sender found the receiver on its LAN')

  const pushed = [] // the volume of each state the receiver pushes
  const control = await openControl(conn, { onState: s => pushed.push(s.volume) })
  const paired = pairedFromWire(await control.call('pair', { code: '' }))
  assert.equal(paired.deviceId, receiver.deviceId, 'the LAN link pairs without a code')
  assert.equal(paired.publicKey, receiver.publicKey)
  assert.equal(paired.token, '', 'and is handed no token that would keep working after the room is left')
  const command = async cmd => stateFromWire(await control.call('command', commandToWire(cmd, '')))
  assert.equal((await command({ action: 'status' })).status, 'idle', 'a LAN link controls the TV with no token')

  assert.equal((await command({ action: 'volume', volume: 0.4 })).volume, 0.4)
  const muted = await command({ action: 'volume', muted: true })
  assert.equal(muted.muted, true)
  assert.equal(muted.volume, 0.4, 'a volume command that sets only muted leaves the volume as it is')
  assert.equal((await command({ action: 'seek', positionMs: 1234.5 })).positionMs, 1235, 'a fractional seek, in whole ms')
  await command({ action: 'seek', positionMs: 20_000 })
  assert.equal((await command({ action: 'skip', deltaMs: -10_000 })).positionMs, 10_000, 'back 10 s')
  assert.equal((await command({ action: 'skip', deltaMs: -30_000 })).positionMs, 0, 'the playhead stays at 0 or more')
  assert.equal((await command({ action: 'selectAudio', stream: -1 })).audio, -1, 'audio off')
  // What the TV's host got: the action, its own arguments and the receiver's sequence number, as before v2.
  assert.deepEqual(hostGot.map(({ seq: _seq, ...cmd }) => cmd), [
    { action: 'volume', volume: 0.4 },
    { action: 'volume', muted: true },
    { action: 'seek', positionMs: 1235 },
    { action: 'seek', positionMs: 20_000 },
    { action: 'skip', deltaMs: -10_000, positionMs: 10_000 },
    { action: 'skip', deltaMs: -30_000, positionMs: 0 },
    { action: 'selectAudio', stream: -1 }
  ])
  assert.ok(hostGot.every((cmd, i) => i === 0 || cmd.seq === hostGot[i - 1].seq + 1))

  // load, play, pause, togglePlay, selectSubtitle and stop, as the host gets them. The load carries an entry far over
  // the cast-entry bounds (a real sender bounds it first): the receiver bounds it again before it keeps it.
  await receiverNode.publish({ id: 'imdb:tt0000042', title: 'Host Shapes' }, Readable.from([b4a.alloc(64 * 1024, 7)]))
  const [film] = await receiverNode.search('imdb:tt0000042')
  const oversized = { key: 'k'.repeat(1000), id: 'i'.repeat(1000), title: 't'.repeat(1000), size: 65_536, sha256: 's'.repeat(1000) }
  const bounded = { key: 'k'.repeat(256), id: 'i'.repeat(128), title: 't'.repeat(80), size: 65_536, sha256: 's'.repeat(64) }
  const loaded = await control.call('command', { ...commandToWire({ action: 'load', magnetUrl: film.magnetUrl, startPositionMs: 1500 }, ''), entry: oversized })
  assert.deepEqual(receiver.state().entry, bounded, 'the receiver keeps the entry within the bounds')
  assert.deepEqual(stateFromWire(loaded).entry, bounded)
  const buttons = [{ action: 'play' }, { action: 'pause' }, { action: 'togglePlay' }, { action: 'selectSubtitle', stream: 2 }, { action: 'stop' }]
  for (const cmd of buttons) await command(cmd)
  const [load, ...pressed] = hostGot.slice(7).map(({ seq: _seq, ...cmd }) => cmd)
  assert.match(load.streamUrl, /^http:\/\/127\.0\.0\.1:\d+\/cast\/v1\/p2p\/[0-9a-f]{32}$/)
  assert.deepEqual(load, { action: 'load', entry: bounded, mode: 'p2p', streamUrl: load.streamUrl, startPositionMs: 1500 })
  assert.deepEqual(pressed, buttons)

  // State pushes when the receiver's connection says "wait for drain" (its write returns false): one push, then
  // nothing until 'drain'; then the newest state once, if one came meanwhile, and that push's answer counts like the
  // first. No state already sent goes twice, and the 'drain' listener goes with the channel.
  const rconns = [...receiverNode.peerConnections()].filter(c => c.remotePublicKey && b4a.equals(c.remotePublicKey, conn.publicKey))
  assert.ok(rconns.length, 'the receiver\'s end of the connection')
  const writes = rconns.map(c => c.write)
  const stall = on => rconns.forEach((c, i) => { c.write = on ? function (...args) { writes[i].apply(this, args); return false } : writes[i] })
  const drains = () => rconns.reduce((n, c) => n + c.listenerCount('drain'), 0)
  const drain = () => rconns.forEach(c => c.emit('drain'))
  const volume = v => command({ action: 'volume', volume: v })
  await control.call('subscribe', { token: '' })
  const base = drains()
  stall(true)
  await volume(0.1)
  assert.equal(drains(), base + 1, 'a push answered false waits for drain')
  await volume(0.2)
  await volume(0.3)
  assert.deepEqual(pushed, [0.1], 'nothing more is pushed before drain')
  stall(false)
  drain()
  await sleep(200)
  assert.deepEqual(pushed, [0.1, 0.3], 'on drain, the newest state once')
  assert.equal(drains(), base)
  stall(true)
  await volume(0.6)
  drain() // nothing changed after 0.6
  await volume(0.7)
  await volume(0.8)
  drain() // 0.8 goes, and its false waits again
  await volume(0.9)
  await sleep(200)
  assert.deepEqual(pushed, [0.1, 0.3, 0.6, 0.7, 0.8], 'a state already sent is not sent again, and a push on drain answered false waits too')
  assert.equal(drains(), base + 1)
  stall(false)
  control.close()
  for (let i = 0; i < 100 && drains() > base; i++) await sleep(50)
  assert.equal(drains(), base, 'the drain listener goes with the channel')
  assert.deepEqual(faults, [], 'no frame from a peer reaches the process as an error')
})

test('a cast sender outlives hostile frames from a receiver', async t => {
  const faults = processFaults(t)
  const testnet = await createTestnet(3)
  const receiver = new Hyperswarm({ bootstrap: testnet.bootstrap })
  const sender = new Hyperswarm({ bootstrap: testnet.bootstrap })
  t.after(async () => {
    await sender.destroy({ force: true })
    await receiver.destroy({ force: true })
    await testnet.destroy()
  })
  // A receiver that answers every request with junk first (an oversized frame, a kind at 2^53, answers to ids and
  // ops nobody asked, a state event that declares a million tracks), then with the answer.
  receiver.on('connection', conn => {
    conn.on('error', () => {})
    const mux = Protomux.from(conn)
    mux.pair({ protocol: CAST.protocol }, () => {
      const channel = mux.createChannel({ protocol: CAST.protocol, id: null })
      const msg = channel.addMessage({
        encoding: c.raw,
        onmessage (buf) {
          const req = c.decode(FRAME, buf)
          const idle = c.encode(STATE, stateToWire(idleCastState()))
          msg.send(b4a.alloc(70 * 1024))
          msg.send(b4a.concat([varint53, b4a.from([0, 1, 0])]))
          msg.send(frame(1, req.op, req.id + 100, idle))
          msg.send(frame(1, castOp('pair'), req.id, idle))
          msg.send(frame(3, castOp('state'), 0, b4a.concat([b4a.from([0]), hugeCount])))
          msg.send(frame(1, req.op, req.id, idle))
          msg.send(frame(3, castOp('state'), 0, idle))
        }
      })
      channel.open()
    })
  })
  await receiver.listen()

  const states = []
  const control = await openControl(await dial(sender, receiver.keyPair.publicKey), { onState: s => states.push(s) })
  assert.equal(stateFromWire(await control.call('subscribe', { token: '' })).status, 'idle', 'the answer to this call is the one taken')
  for (let i = 0; i < 100 && !states.length; i++) await sleep(50)
  assert.equal(states.length, 1, 'only the event that decodes reaches the sender')
  assert.equal(states[0].status, 'idle')
  assert.equal(control.closed, false, 'three bad frames do not close the channel')
  assert.deepEqual(faults, [], 'no frame from a receiver reaches the process as an error')
})
