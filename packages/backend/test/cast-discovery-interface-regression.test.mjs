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
  assert.match(discoverySource, /resolveLanIPv4\s*\(/, 'helper that resolves the LAN interface should exist')
  assert.match(discoverySource, /networkInterfaces\(\)/, 'helper should enumerate interfaces via udx-native')
  assert.match(discoverySource, /localIp: await Promise\.resolve\(this\._resolveLocalIPv4\(\)\)/, '_startMdns should resolve the interface before binding')
})

test('discovery binds 0.0.0.0 on the mDNS port so multicast responses arrive', () => {
  assert.match(discoverySource, /socket\.bind\(MDNS_PORT, '0\.0\.0\.0'\)/, 'socket should bind 0.0.0.0:5353')
  assert.doesNotMatch(discoverySource, /socket\.bind\(0, '0\.0\.0\.0'\)/, 'an ephemeral port cannot receive multicast announcements')
  assert.doesNotMatch(discoverySource, /bind\(0, bindHost\)/, 'socket must not bind to the unicast LAN IP (breaks multicast reception)')
  assert.doesNotMatch(discoverySource, /const bindHost = localIp/, 'bind host must not be derived from the unicast LAN IP')
})

test('discovery joins the multicast group on the LAN interface', () => {
  assert.match(discoverySource, /innerSocket\.addMembership\(MDNS_ADDRESS, localIp\)/, 'join should pass the interface address when known')
  assert.match(discoverySource, /innerSocket\.addMembership\(MDNS_ADDRESS\)/, 'join should fall back to a default-interface join')
  assert.match(discoverySource, /innerSocket\.dropMembership\(MDNS_ADDRESS, membershipInterface\)/, 'cleanup should leave the same interface-scoped membership')
})

test('discovery resolves the interface for every start attempt', () => {
  assert.match(discoverySource, /this\._resolveLocalIPv4 = dependencies\.resolveLocalIPv4 \|\| resolveLanIPv4/, 'the resolver should be injectable and uncached')
  assert.doesNotMatch(discoverySource, /this\._localIp/, 'a restart should not reuse a stale cached interface')
})

test('discovery pairs the A record with the SRV target when several devices answer', () => {
  assert.match(
    discoverySource,
    /cache\.addressesByTarget\.get\(srv\.target\)/,
    'A records should be resolved through the SRV target hostname',
  )
})
