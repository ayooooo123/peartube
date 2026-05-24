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

test('native root passes relay peer launch options into the mobile backend worklet', () => {
  const source = readAppFile('app/_layout.tsx')

  assert.match(
    source,
    /const MOBILE_RELAY_PEERS = \[/,
    'native root should define explicit mobile relay peers for launch options',
  )
  assert.match(
    source,
    /launchOptions:\s*{[\s\S]*network:\s*{\s*relayPeers:\s*MOBILE_RELAY_PEERS\s*}[\s\S]*swarmOptions:\s*{\s*knownPeers:\s*MOBILE_RELAY_PEERS\s*}[\s\S]*}/,
    'initPlatformRPC should receive relay peer launch options so Android can direct-dial relays during startup',
  )
})
