import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

async function readSource(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), 'utf8')
}

test('mobile backend entry wires universal core to the real backend orchestrator', async () => {
  const source = await readSource('../src/backend-entry.js')

  assert.match(source, /import \{ createBackendContext \} from '\.\/orchestrator\.js'/)
  assert.match(source, /createUniversalCore\(\{[\s\S]*?createBackendContext,[\s\S]*?onStatsUpdate: onVideoStats,[\s\S]*?\}\)/)
})
