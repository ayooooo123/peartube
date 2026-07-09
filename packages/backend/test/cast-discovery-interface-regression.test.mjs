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

// Regression: on Android (and any multi-homed host) the mDNS socket must be
// able to *receive* the multicast answers/announcements Cast devices send to
// 224.0.0.251:5353. Binding a specific unicast interface address makes the
// kernel drop inbound multicast (destination is the group, not our address),
// and binding an ephemeral port only ever caught a one-shot unicast reply — so
// the device picker stayed empty. The socket must bind 0.0.0.0:5353 and select
// the interface via the multicast membership join instead.

test('discovery resolves the LAN IPv4 before binding the mDNS socket', () => {
  assert.match(discoverySource, /_resolveLocalIPv4\s*\(/, 'helper that resolves the LAN interface should exist')
  assert.match(discoverySource, /networkInterfaces\(\)/, 'helper should enumerate interfaces via udx-native')
  assert.match(discoverySource, /const localIp = await this\._resolveLocalIPv4\(\)/, '_startMdns should resolve the interface before binding')
})

test('discovery enumerates ALL usable LAN IPv4 interfaces, not a single guess', () => {
  assert.match(discoverySource, /_resolveLocalIPv4s\s*\(/, 'helper that resolves every LAN interface should exist')
  assert.match(discoverySource, /const localIps = await this\._resolveLocalIPv4s\(\)/, '_startMdns should resolve all interfaces')
  // Link-local and loopback addresses must be filtered out so a bridge or
  // stale interface cannot shadow the real LAN NIC.
  assert.match(discoverySource, /169\.254\./, 'link-local addresses should be excluded')
})

test('discovery binds 0.0.0.0 on the mDNS port so multicast responses arrive', () => {
  assert.match(discoverySource, /\{ port: MDNS_PORT, host: '0\.0\.0\.0' \}/, 'primary bind target should be 0.0.0.0:5353')
  assert.match(discoverySource, /\{ port: 0, host: '0\.0\.0\.0' \}/, 'should fall back to an ephemeral 0.0.0.0 port')
  assert.match(discoverySource, /this\._socket\.bind\(target\.port, target\.host\)/, 'socket should bind to the chosen target')
  assert.doesNotMatch(discoverySource, /bind\(0, bindHost\)/, 'socket must not bind to the unicast LAN IP (breaks multicast reception)')
  assert.doesNotMatch(discoverySource, /const bindHost = localIp/, 'bind host must not be derived from the unicast LAN IP')
})

test('discovery joins the multicast group on every LAN interface', () => {
  assert.match(discoverySource, /_joinMulticast\s*\(/, 'multicast join should be its own helper')
  assert.match(discoverySource, /for \(const localIp of \(localIps \|\| \[\]\)\)/, 'join should iterate every resolved interface')
  assert.match(discoverySource, /addMembership\(MDNS_ADDRESS, localIp\)/, 'join should pass the interface address when known')
  assert.match(discoverySource, /addMembership\(MDNS_ADDRESS\)/, 'join should fall back to a default-interface join')
})

test('discovery sends queries from per-interface sockets so egress + QU replies work', () => {
  // udx-native has no IP_MULTICAST_IF; the only way to steer the query out a
  // specific NIC is a socket bound to that NIC's address. Those sockets also
  // receive unicast (QU) replies on networks that filter downstream multicast.
  assert.match(discoverySource, /_startTxSockets\s*\(/, 'per-interface query socket setup should exist')
  assert.match(discoverySource, /sock\.bind\(0, ip\)/, 'query sockets should bind an ephemeral port on the interface address')
  assert.match(discoverySource, /sock\.on\('message'/, 'query sockets must receive unicast QU replies')
  assert.match(discoverySource, /MDNS_TTL = 255/, 'queries should be sent with the RFC 6762 IP TTL of 255')
  assert.match(discoverySource, /inner\.send\(query, MDNS_PORT, MDNS_ADDRESS, MDNS_TTL\)/, 'send should use the inner udx socket TTL parameter')
})

test('discovery re-resolves the interfaces after stopping (network may change)', () => {
  assert.match(discoverySource, /this\._localIp = undefined/, 'cached interface should be cleared so a restart re-resolves it')
  assert.match(discoverySource, /this\._localIps = undefined/, 'cached interface list should be cleared so a restart re-resolves it')
  assert.match(discoverySource, /this\._txSockets\.clear\(\)/, 'per-interface query sockets should be torn down on stop')
})

test('discovery pairs the A record with the SRV target when several devices answer', () => {
  assert.match(
    discoverySource,
    /r\.type === DNS_TYPE\.A && r\.name === srvRecord\.target/,
    'A record should be matched to the SRV target hostname first',
  )
})
