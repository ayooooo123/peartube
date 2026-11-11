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
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { createReceiver } from '../src/cast.js'
import { openControl } from '../src/cast-control.js'
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

const CAST_PROTOCOL = 'peartube-cast/v1'
const CAST_JUNK = ['null', '7', '"x"', '[]', '{broken', 'x'.repeat(80 * 1024)]

// The first connection `swarm` gets after it dials `publicKey`.
function dial (swarm, publicKey) {
  return new Promise(resolve => {
    swarm.once('connection', conn => { conn.on('error', () => {}); resolve(conn) })
    swarm.joinPeer(publicKey)
  })
}

test('a receiver outlives junk on its cast channel, and an open receiver is open to its LAN only', async t => {
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

  // The channel spoken by hand, to send what a real sender never would: text that is not a JSON object, and a frame
  // over the size cap.
  const conn = await dial(stranger, b4a.from(receiver.publicKey, 'hex'))
  const replies = []
  const channel = Protomux.from(conn).createChannel({ protocol: CAST_PROTOCOL, id: null })
  const text = channel.addMessage({ encoding: c.string, onmessage: reply => replies.push(JSON.parse(reply)) })
  channel.open()
  for (const junk of CAST_JUNK) text.send(junk)
  text.send(JSON.stringify({ id: 9, type: 'cmd', action: 'status' }))
  text.send(JSON.stringify({ id: 10, type: 'pair' }))
  text.send(JSON.stringify({ id: 11, type: 'cmd', token: '', action: 'status' }))
  const deadline = Date.now() + 5000
  while (replies.length < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))

  assert.deepEqual(replies.map(r => r.id), [9, 10, 11], 'only the requests are answered')
  assert.equal(replies[0].ok, false)
  assert.match(replies[0].error, /Unauthorized/, 'an open receiver still asks a peer from across the DHT for its token')
  assert.equal(replies[1].ok, false)
  assert.match(replies[1].error, /Invalid TV pairing code/, 'and still asks it for the TV code')
  assert.match(replies[2].error, /Unauthorized/, 'an empty token is not the pair token')
  assert.equal(conn.destroyed, false, 'junk does not cost the peer its connection')
  assert.deepEqual(faults, [], 'no frame from a peer reaches the process as an error')
})

// An open receiver is open to the room it is in, not to every peer that can find it: a LAN link pairs without a code
// and gets no permanent token, so only a device on that link can control this TV.
test('an open receiver hands its LAN link no pair token', async t => {
  const faults = processFaults(t)
  const testnet = await createTestnet(3)
  const bus = mdnsBus()
  const mkTmp = () => mkdtempSync(join(tmpdir(), 'peartube-cast-open-'))
  const lan = keyPair => createLan({ host: '127.0.0.1', keyPair, adapter: bus(s => s), dialAfter: 200 })
  const receiverNode = await createNode({ storage: mkTmp(), bootstrap: testnet.bootstrap, lan })
  const senderNode = await createNode({ storage: mkTmp(), bootstrap: testnet.bootstrap, lan })
  const receiver = await createReceiver({ storage: mkTmp(), node: receiverNode, openAuth: true })
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
    if (!conn) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(conn, 'the sender found the receiver on its LAN')

  const control = await openControl(conn)
  const paired = await control.call('pair', { code: '' })
  assert.equal(paired.deviceId, receiver.deviceId, 'the LAN link pairs without a code')
  assert.equal(paired.token, '', 'and is handed no token that would keep working after the room is left')
  const status = await control.call('cmd', { token: '', action: 'status' })
  assert.equal(status.state.status, 'idle', 'a LAN link controls the TV with no token')
  control.close()
  assert.deepEqual(faults, [], 'no frame from a peer reaches the process as an error')
})

test('a cast sender outlives junk from a receiver', async t => {
  const faults = processFaults(t)
  const testnet = await createTestnet(3)
  const receiver = new Hyperswarm({ bootstrap: testnet.bootstrap })
  const sender = new Hyperswarm({ bootstrap: testnet.bootstrap })
  t.after(async () => {
    await sender.destroy({ force: true })
    await receiver.destroy({ force: true })
    await testnet.destroy()
  })
  // A receiver that answers every request with junk first, then with the reply.
  receiver.on('connection', conn => {
    conn.on('error', () => {})
    const mux = Protomux.from(conn)
    mux.pair({ protocol: CAST_PROTOCOL }, () => {
      const channel = mux.createChannel({ protocol: CAST_PROTOCOL, id: null })
      const text = channel.addMessage({
        encoding: c.string,
        onmessage (request) {
          const msg = JSON.parse(request)
          for (const junk of CAST_JUNK) text.send(junk)
          text.send(JSON.stringify({ id: msg.id, ok: true, result: { echo: msg.type } }))
        }
      })
      channel.open()
    })
  })
  await receiver.listen()

  const control = await openControl(await dial(sender, receiver.keyPair.publicKey))
  assert.deepEqual(await control.call('cmd'), { echo: 'cmd' })
  assert.deepEqual(faults, [], 'no frame from a receiver reaches the process as an error')
})
