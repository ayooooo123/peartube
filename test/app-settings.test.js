import test from 'node:test'
import assert from 'node:assert/strict'
import { APP_SETTINGS_DEFAULTS, nodeOptions, normalizeAppSettings } from '../src/app-settings.js'

const KEY_A = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const KEY_B = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'

test('APP_SETTINGS_DEFAULTS includes backwards-compatible P2P metadata defaults', () => {
  assert.deepEqual(APP_SETTINGS_DEFAULTS.metaSources, [])
  assert.equal(APP_SETTINGS_DEFAULTS.p2pOnlyMetadata, false)
  assert.equal(APP_SETTINGS_DEFAULTS.seedFullMetadata, false)
})

test('normalizeAppSettings accepts v0.5.0 settings without metadata fields', () => {
  const legacy = {
    tracker: '',
    sources: [{ key: KEY_A, kind: 'channel', alias: 'Main' }],
    relayThrough: [],
    bootstrap: [],
    lanDiscovery: true,
    privateRouting: false,
    cacheMaxGb: 10
  }
  const normalized = normalizeAppSettings(legacy, { requireChannel: true })
  assert.deepEqual(normalized.metaSources, [])
  assert.equal(normalized.p2pOnlyMetadata, false)
  assert.equal(normalized.seedFullMetadata, false)
})

test('normalizeAppSettings normalizes metaSources from URIs, keys, strings, and objects', () => {
  const fromArray = normalizeAppSettings({
    metaSources: [
      `peartube://meta/${KEY_A.toUpperCase()}?name=Lumen%20Public%20Meta`,
      KEY_B,
      { uri: `peartube://meta/${KEY_A}` }
    ],
    p2pOnlyMetadata: true,
    seedFullMetadata: true
  })
  assert.deepEqual(fromArray.metaSources, [KEY_A, KEY_B])
  assert.equal(fromArray.p2pOnlyMetadata, true)
  assert.equal(fromArray.seedFullMetadata, true)

  const fromText = normalizeAppSettings({
    metaSources: `peartube://meta/${KEY_A}\n${KEY_B}, meta:${KEY_A}`
  })
  assert.deepEqual(fromText.metaSources, [KEY_A, KEY_B])
})

test('normalizeAppSettings rejects invalid metadata source entries', () => {
  assert.throws(
    () => normalizeAppSettings({ metaSources: [`peartube://channel/${KEY_A}`] }),
    /Expected peartube:\/\/meta\//
  )
  assert.throws(
    () => normalizeAppSettings({ metaSources: ['not-a-valid-meta-key'] }),
    /Invalid metadata key/
  )
})

test('nodeOptions forwards metaSources, p2pOnlyMetadata, and seedFullMetadata', () => {
  const normalized = normalizeAppSettings({
    tracker: KEY_A,
    metaSources: [`peartube://meta/${KEY_B}?name=Catalog`],
    p2pOnlyMetadata: true,
    seedFullMetadata: true
  })
  const opts = nodeOptions(normalized, { trackersDir: '/tmp/trackers', defaultFolder: 'default' })
  assert.deepEqual(opts.metaSources, [KEY_B])
  assert.equal(opts.p2pOnlyMetadata, true)
  assert.equal(opts.seedFullMetadata, true)
})
