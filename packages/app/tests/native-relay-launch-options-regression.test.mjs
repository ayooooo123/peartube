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

test('native root does not ship hardcoded relay peers into the mobile backend worklet', () => {
  const source = readAppFile('app/_layout.tsx')

  assert.doesNotMatch(
    source,
    /const MOBILE_RELAY_PEERS = \[/,
    'mobile app should not ship a static relay public-key allowlist',
  )
  assert.doesNotMatch(
    source,
    /relayPeers:\s*MOBILE_RELAY_PEERS/,
    'mobile backend launch should not direct-dial baked-in relay peers',
  )
  assert.doesNotMatch(
    source,
    /knownPeers:\s*MOBILE_RELAY_PEERS/,
    'mobile backend launch should not direct-dial baked-in known peers',
  )
})
