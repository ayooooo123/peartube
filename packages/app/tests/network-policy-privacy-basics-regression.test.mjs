import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '..')
const read = rel => fs.readFileSync(path.join(appRoot, rel), 'utf8')

test('network policy privacy basics distinguish local-only decisions from network-visible activity', () => {
  const network = read('app/network-policy.tsx')

  // Section is present and reuses the existing heading language.
  assert.match(network, /Privacy basics/i)

  // Local-only decisions: trust, moderation, retention stay on device.
  assert.match(network, /local-only/i)
  assert.match(network, /Trust, moderation, and retention/i)
  assert.match(network, /on this device/i)
})

test('network policy privacy basics enumerate every network-visible leakage category', () => {
  const network = read('app/network-policy.tsx')
  for (const token of [
    'Following publishers and indexes',
    'Catalog and asset requests',
    'Archive challenges and pledges',
    'Seeding',
    'mDNS',
    'IP address',
    'correlate',
  ]) {
    assert.ok(network.includes(token), `privacy basics missing network-visible category: ${token}`)
  }
})

test('network policy privacy basics warn about non-anonymity and make no privacy guarantee', () => {
  const network = read('app/network-policy.tsx')

  // Explicit non-anonymity warning.
  assert.match(network, /does not provide anonymity/i)

  // Copy must not promise privacy/anonymity.
  assert.doesNotMatch(
    network,
    /keeps? you anonymous|makes? you anonymous|fully anonymous|browsing is private|activity is private|guarantees? (your )?(privacy|anonymity)|privacy is guaranteed/i,
  )
})
