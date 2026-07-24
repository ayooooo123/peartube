import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { buildStorageConfig } from '../src/orchestrator.js'

async function readSource(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), 'utf8')
}

test('mobile backend entry wires universal core to the real backend orchestrator', async () => {
  const source = await readSource('../src/backend-entry.js')

  assert.match(source, /import \{ createBackendContext \} from '\.\/orchestrator\.js'/)
  assert.match(source, /createUniversalCore\(\{[\s\S]*?createBackendContext,[\s\S]*?onStatsUpdate: onVideoStats,[\s\S]*?\}\)/)
})


test('mobile backend context forwards platform and explicit network policy to storage', () => {
  const network = { bootstrap: ['bootstrap.example:49737'] }
  const swarmOptions = { maxPeers: 23, maxParallel: 7 }

  const storageConfig = buildStorageConfig({
    storagePath: '/tmp/peartube-mobile-wiring',
    platform: 'mobile',
    network,
    swarmOptions,
  }, Buffer.alloc(32, 1))

  assert.equal(storageConfig.platform, 'mobile')
  assert.equal(storageConfig.network, network)
  assert.equal(storageConfig.swarmOptions, swarmOptions)
})
