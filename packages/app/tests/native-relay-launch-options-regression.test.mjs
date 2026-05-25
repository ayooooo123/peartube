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
    /const MOBILE_RELAY_PEERS = \[[\s\S]*9890785d1a1b5af8e4bfba0f585f54272b6951e3dc0fdc43a30ed73f1d740f13[\s\S]*d10f6fbdae2d8e439cf9b6e29cbb42199fff101a8e707345eb455faab92e7d7a[\s\S]*8cdc6bc7d9d1bfe99644d06dee042023c54d55af178cfa12bf778fe51f01152a[\s\S]*43f48db991cc40002ebd9661239b49e83c1d6b41c86b06b94a57925d00e5ab05[\s\S]*\]/,
    'mobile app should ship the known relay public keys used for Android bootstrap',
  )
  assert.match(
    source,
    /launchOptions:\s*\{[\s\S]*__peartubeLaunchOptions:\s*true[\s\S]*network:\s*\{\s*relayPeers:\s*MOBILE_RELAY_PEERS\s*\}[\s\S]*\}/,
    'mobile backend launch should direct-dial the configured relays before relying on topic discovery',
  )
  assert.doesNotMatch(source, /swarmOptions:\s*\{\s*knownPeers:\s*MOBILE_RELAY_PEERS\s*\}/)
})
