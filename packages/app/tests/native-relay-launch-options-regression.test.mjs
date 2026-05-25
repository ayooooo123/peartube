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

test('native root does not ship app-level relay peers into the mobile backend worklet', () => {
  const source = readAppFile('app/_layout.tsx')

  assert.doesNotMatch(source, /MOBILE_RELAY_PEERS/)
  assert.doesNotMatch(source, /network:\s*\{\s*relayPeers:/)
  assert.doesNotMatch(source, /swarmOptions:\s*\{\s*knownPeers:/)
  assert.match(source, /initPlatformRPC\(\{[\s\S]*loadBackendSource:[\s\S]*loadDownloaderWorkerSource:/)
})
