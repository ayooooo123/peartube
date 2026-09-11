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

test('test workflow uses the locked install:all strategy in CI', () => {
  const workflow = readFile('.github/workflows/ci-fast.yml')
  const setupAction = readFile('.github/actions/setup-node-workspace/action.yml')
  const rootPackage = JSON.parse(readFile('package.json'))
  const specPackage = JSON.parse(readFile('packages/spec/package.json'))

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
    setupAction,
    /for attempt in 1 2 3/,
    'shared Node setup should retry transient npm registry/network failures before failing the workflow',
  )
  assert.match(
    setupAction,
    /npm cache verify \|\| true/,
    'shared Node setup should verify cache between install retries without masking the final install failure',
  )
  const installCommands = rootPackage.scripts['install:all'].split('&&').map(command => command.trim())
  assert.deepEqual(
    installCommands,
    [
      'npm ci',
      'npm ci --prefix packages/spec',
      'npm ci --prefix packages/backend',
      'npm ci --prefix packages/cli',
      'npm ci --prefix packages/host',
      'npm ci --prefix packages/platform',
      'npm ci --prefix packages/app --legacy-peer-deps',
    ],
    'install:all should preserve the complete locked root and workspace install chain',
  )
  assert.notEqual(
    specPackage.dependencies['hrpc'],
    `^${rootPackage.version}`,
    'release bumps must not rewrite the external hrpc generator dependency to the PearTube app version',
  )
})
