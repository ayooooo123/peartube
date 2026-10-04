import test from 'node:test'
import assert from 'node:assert/strict'
import { selfAddressAdapter, createLan } from '../src/lan.js'

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

// A browse asks once. On Wi-Fi a phone can miss the one answer, and peers stop
// announcing themselves after their first half hour, so the browse must start
// over to ask again. Ways that could fail: it never asks again; it stops the
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
  const lan = createLan({ host: '127.0.0.1', port: 49811, adapter: failing })
  try {
    await lan.ready()
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.ok(errors.some(line => line.includes('mdns socket closed')), 'the error was reported')
  } finally {
    console.error = original
    await lan.destroy()
  }
})
