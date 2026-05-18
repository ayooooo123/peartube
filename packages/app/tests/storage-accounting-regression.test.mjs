import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const __dirname = path.dirname(new URL(import.meta.url).pathname)
const repoRoot = path.resolve(__dirname, '..', '..', '..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('storage stats HRPC schema preserves total app storage accounting fields', () => {
  const schema = read('packages/spec/schema.cjs')
  const start = schema.indexOf("name: 'get-storage-stats-response'")
  const end = schema.indexOf("name: 'set-storage-limit-request'", start)
  const block = start >= 0 && end >= 0 ? schema.slice(start, end) : ''

  assert.match(block, /usedBytes/)
  assert.match(block, /maxBytes/)
  assert.match(block, /totalStorageBytes/)
  assert.match(block, /totalStorageGB/)
  assert.match(block, /untrackedStorageBytes/)
  assert.match(block, /untrackedStorageGB/)
})

test('mobile backend wires storage usage measurer into SeedingManager', () => {
  const orchestrator = read('packages/backend/src/orchestrator.js')

  assert.match(orchestrator, /createStorageUsageMeasurer/)
  assert.match(orchestrator, /new SeedingManager\(ctx\.store, ctx\.metaDb, \{/)
  assert.match(orchestrator, /getDiskUsageBytes: createStorageUsageMeasurer\(storagePath\)/)
})
