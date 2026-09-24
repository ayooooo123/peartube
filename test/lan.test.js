import test from 'node:test'
import assert from 'node:assert/strict'
import { selfAddressAdapter } from '../src/lan.js'

// Behind an mDNS reflector the packet's sender is the router. The peer must be
// dialed at the address it advertised for its own DHT, not at the reflector.
test('LAN discovery dials the advertised address, not the mDNS reflector', () => {
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
  adapter.browse({ type: 'hyperdht-mdns' }, { onService: s => seen.push(s) })
  deliver({ txt: { h: '10.0.10.209' }, referer: { address: '10.0.40.1' }, addresses: ['10.0.40.1'] })
  assert.equal(seen[0].referer, null)
  assert.deepEqual(seen[0].addresses, ['10.0.10.209'])

  // A peer without the field (or with junk) passes through unchanged.
  deliver({ txt: { h: 'not-an-ip' }, referer: { address: '10.0.40.1' } })
  assert.deepEqual(seen[1].referer, { address: '10.0.40.1' })
})
