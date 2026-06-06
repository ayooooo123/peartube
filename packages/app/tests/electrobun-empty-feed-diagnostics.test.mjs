import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const source = () => readFileSync(join(__dirname, '../app/(tabs)/index.web.tsx'), 'utf8')

test('Electrobun empty feed state uses structured swarm diagnostics', () => {
  const src = source()
  assert.match(src, /classifyFeedDiscoveryState/, 'web home should classify feed state with shared diagnostics')
  assert.match(src, /rpc\.getSwarmStatus\(\{\}\)/, 'web home should load structured swarm status')
  assert.match(src, /getWebFeedDiscoveryEmptyCopy/, 'empty copy should be derived from discovery state')
  assert.doesNotMatch(src, /peerCount === 0 \? 'Waiting for peers to connect\.\.\.'/, 'generic peer-count-only empty copy must not be used')
})
