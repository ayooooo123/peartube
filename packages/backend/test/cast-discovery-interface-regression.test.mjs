import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const discoverySource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'cast', 'discovery.js'),
  'utf8',
)

// Regression: on Android (and any multi-homed host) the mDNS query must
// egress on the Wi-Fi interface and the multicast group must be joined on
// that same interface. Binding 0.0.0.0 sent the _googlecast._tcp query out
// the wrong NIC (cellular/VPN), so no Chromecast ever responded and the
// device picker stayed empty.

test('discovery resolves the LAN IPv4 before binding the mDNS socket', () => {
  assert.match(discoverySource, /_resolveLocalIPv4\s*\(/, 'helper that resolves the LAN interface should exist')
  assert.match(discoverySource, /networkInterfaces\(\)/, 'helper should enumerate interfaces via udx-native')
  assert.match(discoverySource, /const localIp = await this\._resolveLocalIPv4\(\)/, '_startMdns should resolve the interface before binding')
})

test('discovery binds to the resolved interface and falls back to 0.0.0.0', () => {
  assert.match(discoverySource, /const bindHost = localIp \|\| '0\.0\.0\.0'/, 'bind host should prefer the LAN IP and fall back to 0.0.0.0')
  assert.match(discoverySource, /this\._socket\.bind\(0, bindHost\)/, 'socket should bind to the resolved host')
  assert.doesNotMatch(discoverySource, /this\._socket\.bind\(0, '0\.0\.0\.0'\)/, 'socket should no longer hard-code 0.0.0.0')
})

test('discovery joins the multicast group on the LAN interface', () => {
  assert.match(discoverySource, /_joinMulticast\s*\(/, 'multicast join should be its own helper')
  assert.match(discoverySource, /addMembership\(MDNS_ADDRESS, localIp\)/, 'join should pass the interface address when known')
  assert.match(discoverySource, /addMembership\(MDNS_ADDRESS\)/, 'join should fall back to a default-interface join')
})

test('discovery re-resolves the interface after stopping (network may change)', () => {
  assert.match(discoverySource, /this\._localIp = undefined/, 'cached interface should be cleared so a restart re-resolves it')
})

test('discovery pairs the A record with the SRV target when several devices answer', () => {
  assert.match(
    discoverySource,
    /r\.type === DNS_TYPE\.A && r\.name === srvRecord\.target/,
    'A record should be matched to the SRV target hostname first',
  )
})
