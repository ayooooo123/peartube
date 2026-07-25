import test from 'node:test'
import assert from 'node:assert/strict'

let selectLocalIPv4ForTarget
try {
  ;({ selectLocalIPv4ForTarget } = await import('@peartube/backend/cast/network-address'))
} catch {}

test('Cast routing selects the interface whose subnet contains the receiver', () => {
  assert.equal(typeof selectLocalIPv4ForTarget, 'function', 'Cast network address selector must exist')

  const interfaces = {
    en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false, netmask: '255.255.255.0' }],
    en7: [{ address: '10.42.8.12', family: 'IPv4', internal: false, netmask: '255.255.0.0' }],
  }

  assert.equal(selectLocalIPv4ForTarget('10.42.200.40', interfaces), '10.42.8.12')
})

test('Cast routing falls back to the platform Wi-Fi interface for non-IPv4 targets', () => {
  assert.equal(typeof selectLocalIPv4ForTarget, 'function', 'Cast network address selector must exist')

  const interfaces = {
    bridge0: [{ address: '172.16.0.2', family: 'IPv4', internal: false, netmask: '255.255.0.0' }],
    wlan0: [{ address: '192.168.50.9', family: 'IPv4', internal: false, netmask: '255.255.255.0' }],
  }

  assert.equal(selectLocalIPv4ForTarget('living-room.local', interfaces), '192.168.50.9')
})

test('Cast routing rejects loopback and malformed interface records', () => {
  assert.equal(typeof selectLocalIPv4ForTarget, 'function', 'Cast network address selector must exist')

  const interfaces = {
    lo0: [
      { address: '127.0.0.1', family: 'IPv4', internal: false, netmask: '255.0.0.0' },
      { address: '127.1.2.3', family: 'IPv4', internal: false, netmask: '255.0.0.0' },
    ],
    en0: [
      { address: '0.0.0.0', family: 'IPv4', internal: false, netmask: '0.0.0.0' },
      { address: 'not-an-ip', family: 'IPv4', internal: false, netmask: '255.255.255.0' },
      { address: '192.168.1.10', family: 'IPv6', internal: false, netmask: '255.255.255.0' },
    ],
  }

  assert.equal(selectLocalIPv4ForTarget('192.168.1.40', interfaces), null)
})
