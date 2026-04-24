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
  const workflow = readFile('.github/workflows/ci-fast.yml')
  const setupAction = readFile('.github/actions/setup-node-workspace/action.yml')
  const rootPackage = JSON.parse(readFile('package.json'))

  assert.match(
    workflow,
    /uses:\s+\.\/\.github\/actions\/setup-node-workspace/,
    'fast CI should use the shared Node workspace setup action',
  )
  assert.doesNotMatch(
    setupAction,
    /cache:\s*'npm'/,
    'shared Node setup should not enable setup-node npm cache without a root lockfile strategy',
  )
  assert.doesNotMatch(
    setupAction,
    /\bnpm ci\b/,
    'shared Node setup should not use root npm ci in this monorepo',
  )
  assert.match(
    setupAction,
    /npm run install:all/,
    'shared Node setup should install dependencies via the repo install:all script',
  )
  assert.match(
    rootPackage.scripts['install:all'],
    /packages\/spec/,
    'install:all should install packages/spec so schema generation can require hrpc-swift in CI',
  )
  assert.match(
    rootPackage.scripts['install:all'],
    /packages\/platform/,
    'install:all should install packages/platform so typecheck has its local deps in CI',
  )
})
