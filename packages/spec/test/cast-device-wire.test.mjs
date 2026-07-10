import test from 'brittle'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { getEncoding } = require('../spec/hrpc/messages.js')
const c = require('compact-encoding')

// The @peartube/cast-device schema names its protocol field `castProtocol`,
// while the cast stack (backend handlers, useCast, UI) uses `protocol`.
// Devices crossing the RPC boundary MUST be mapped to `castProtocol` — a
// device object carrying only `protocol` makes compact-encoding throw, which
// silently drops deviceFound events and crashes castGetDevices responses.
// The senders map via toWireCastDevice(); these tests pin the wire contract.

const wireDevice = {
  id: '192.168.1.99:46899',
  name: 'FCast-LIVINGROOM',
  host: '192.168.1.99',
  port: 46899,
  castProtocol: 'fcast',
}

test('cast-device round-trips castProtocol (fcast) through the wire codec', (t) => {
  const enc = getEncoding('@peartube/cast-device')
  const decoded = c.decode(enc, c.encode(enc, wireDevice))
  t.is(decoded.castProtocol, 'fcast')
  t.is(decoded.port, 46899)
  t.is(decoded.host, '192.168.1.99')
})

test('event-cast-device-found and cast-get-devices-response carry devices', (t) => {
  const eventEnc = getEncoding('@peartube/event-cast-device-found')
  const event = c.decode(eventEnc, c.encode(eventEnc, { device: wireDevice }))
  t.is(event.device.castProtocol, 'fcast')

  const listEnc = getEncoding('@peartube/cast-get-devices-response')
  const list = c.decode(listEnc, c.encode(listEnc, { devices: [wireDevice, { ...wireDevice, id: 'a:8009', castProtocol: 'chromecast' }] }))
  t.is(list.devices.length, 2)
  t.is(list.devices[0].castProtocol, 'fcast')
  t.is(list.devices[1].castProtocol, 'chromecast')
})

test('a device keyed `protocol` (not castProtocol) fails to encode — senders must map it', (t) => {
  const enc = getEncoding('@peartube/cast-device')
  const internalDevice = { id: 'a:8009', name: 'TV', host: '1.2.3.4', port: 8009, protocol: 'chromecast' }
  // Manual try/catch: brittle's t.exception intentionally lets TypeError escape.
  let threw = false
  try {
    c.encode(enc, internalDevice)
  } catch {
    threw = true
  }
  t.ok(threw, 'encoding an unmapped device must throw')
})

test('cast-add-manual-device-request carries the optional castProtocol', (t) => {
  const enc = getEncoding('@peartube/cast-add-manual-device-request')
  const decoded = c.decode(enc, c.encode(enc, { name: 'Shield', host: '10.0.0.9', port: 46899, castProtocol: 'fcast' }))
  t.is(decoded.castProtocol, 'fcast')

  // Omitted castProtocol decodes as null (backend then defaults to chromecast)
  const bare = c.decode(enc, c.encode(enc, { name: 'TV', host: '10.0.0.8' }))
  t.is(bare.castProtocol, null)
})
