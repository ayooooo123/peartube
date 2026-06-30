import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..', '..')

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'))
}

test('platform tsconfig uses bundler resolution so @peartube/host subpath exports typecheck in CI', () => {
  const tsconfig = readJson('packages/platform/tsconfig.json')
  assert.equal(
    tsconfig.compilerOptions?.moduleResolution,
    'bundler',
    'packages/platform/tsconfig.json should use bundler moduleResolution for exported ESM subpaths',
  )
})
