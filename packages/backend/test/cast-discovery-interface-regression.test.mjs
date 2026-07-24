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
const chromecastSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'cast', 'chromecast.js'),
  'utf8',
)
const mobileCastSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'app', 'backend', 'mobile-cast.mjs'),
  'utf8',
)
const desktopCastSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'app', 'workers', 'desktop', 'index.ts'),
  'utf8',
)

// Regression: on Android (and any multi-homed host) the mDNS socket must be
// able to *receive* the multicast answers/announcements Cast devices send to
// 224.0.0.251:5353. Binding a specific unicast interface address makes the
// kernel drop inbound multicast (destination is the group, not our address),
// and binding an ephemeral port only ever caught a one-shot unicast reply — so
// the device picker stayed empty. The socket must bind 0.0.0.0:5353 and select
// the interface via the multicast membership join instead.

test('discovery resolves the LAN IPv4 through bare-os before binding the mDNS socket', () => {
  assert.match(discoverySource, /_resolveLocalIPv4\s*\(/, 'helper that resolves the LAN interface should exist')
  assert.match(discoverySource, /from 'bare-os'/, 'helper should use the Holepunch OS interface API')
  assert.match(discoverySource, /networkInterfaces\(\)/, 'helper should enumerate OS interfaces')
  assert.match(discoverySource, /const localIp = await this\._resolveLocalIPv4\(\)/, '_startMdns should resolve the interface before binding')
})

test('cast address discovery never constructs an ad-hoc UDX transport', () => {
  for (const source of [discoverySource, chromecastSource, mobileCastSource, desktopCastSource]) {
    assert.doesNotMatch(source, /(?:from\s+|import\s*\()['"]udx-native['"]/, 'cast code must not load the P2P transport for interface discovery')
    assert.doesNotMatch(source, /new UDX\s*\(/, 'cast code must not construct a UDX transport for interface discovery')
  }
})

test('discovery binds 0.0.0.0 on the mDNS port so multicast responses arrive', () => {
  assert.match(discoverySource, /\{ port: MDNS_PORT, host: '0\.0\.0\.0' \}/, 'primary bind target should be 0.0.0.0:5353')
  assert.match(discoverySource, /\{ port: 0, host: '0\.0\.0\.0' \}/, 'should fall back to an ephemeral 0.0.0.0 port')
  assert.match(discoverySource, /this\._socket\.bind\(target\.port, target\.host\)/, 'socket should bind to the chosen target')
  assert.doesNotMatch(discoverySource, /bind\(0, bindHost\)/, 'socket must not bind to the unicast LAN IP (breaks multicast reception)')
  assert.doesNotMatch(discoverySource, /const bindHost = localIp/, 'bind host must not be derived from the unicast LAN IP')
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
