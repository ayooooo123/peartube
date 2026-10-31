import test from 'node:test'
import assert from 'node:assert/strict'
import HyperDHT from 'hyperdht'
import b4a from 'b4a'
import { selfAddressAdapter, createLan } from '../src/lan.js'
import { mdnsBus } from './mdns.js'

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
