import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..', '..')

function readFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('test workflow avoids root npm cache and npm ci because the repo has no root lockfile', () => {
  const workflow = readFile('.github/workflows/test.yml')

  assert.doesNotMatch(
    workflow,
    /cache:\s*'npm'/,
    'test workflow should not enable setup-node npm cache without a root lockfile',
  )
  assert.doesNotMatch(
    workflow,
    /\bnpm ci\b/,
    'test workflow should not use root npm ci in this monorepo',
  )
  assert.match(
    workflow,
    /npm run install:all/,
    'test workflow should install dependencies via the repo install:all script',
  )
})
