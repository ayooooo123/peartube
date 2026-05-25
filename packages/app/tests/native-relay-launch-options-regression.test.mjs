import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

function readAppFile(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

test('native root passes explicit relay peers into the mobile backend worklet', () => {
  const source = readAppFile('app/_layout.tsx')

  assert.match(
    source,
    /const MOBILE_RELAY_PEERS = \[[\s\S]*e405808fe789b4807f264ed88ea8b2643ae031f0ffb83435a895e0b775963333[\s\S]*c41caf08c970f335583e9d1b37888940c93c136764ecb0b1358bff86fdd64aa4[\s\S]*146cca33794aa29bcecf90a02600945fafabde3a57d745fe8d1e16ada5520760[\s\S]*76e6525250aa442d7c1913ef1ecc4087b03a8e2eba9c76781950a0622a482f8c[\s\S]*\]/,
    'mobile app should ship the current relay public keys used for Android bootstrap',
  )
  assert.match(
    source,
    /launchOptions:\s*\{[\s\S]*__peartubeLaunchOptions:\s*true[\s\S]*network:\s*\{\s*relayPeers:\s*MOBILE_RELAY_PEERS\s*\}[\s\S]*\}/,
    'mobile backend launch should direct-dial the configured relays before relying on topic discovery',
  )
  assert.doesNotMatch(source, /swarmOptions:\s*\{\s*knownPeers:\s*MOBILE_RELAY_PEERS\s*\}/)
})
