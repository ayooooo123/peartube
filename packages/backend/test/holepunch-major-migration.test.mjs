import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '../../..')

function readPackageJson(relativePath) {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
  )
}

test('major Holepunch dependency migrations are applied consistently', () => {
  const rootPkg = readPackageJson('package.json')
  const appPkg = readPackageJson('packages/app/package.json')
  const backendPkg = readPackageJson('packages/backend/package.json')
  const cliPkg = readPackageJson('packages/cli/package.json')

  assert.equal(
    appPkg.devDependencies['bare-build'],
    '^0.5.3',
    'app should use the current bare-build line',
  )
  assert.equal(
    cliPkg.devDependencies['bare-build'],
    '^0.5.3',
    'cli should use the current bare-build line',
  )
  assert.equal(
    appPkg.devDependencies['bare-pack'],
    '^2.1.3',
    'app should use the current bare-pack major line',
  )
  assert.equal(
    cliPkg.dependencies['bare-subprocess'],
    '^6.0.0',
    'cli should use the current bare-subprocess line',
  )
  assert.ok(
    !('hyperdb' in appPkg.devDependencies),
    'app should not keep an unused direct hyperdb dependency',
  )
  assert.ok(
    !('hyperdb' in cliPkg.dependencies),
    'cli should not keep an unused direct hyperdb dependency',
  )
  assert.equal(
    backendPkg.dependencies.hyperdb,
    '^6.7.0',
    'backend should keep hyperdb as a direct dependency because channel state now uses it',
  )
  assert.equal(
    rootPkg.dependencies['bare-runtime'],
    '^1.28.4',
    'root runtime should stay on the latest compatible bare-runtime line',
  )
  assert.equal(
    appPkg.overrides?.bogon,
    '1.2.0',
    'app installs should keep bogon on the isReserved-compatible line',
  )
  assert.equal(
    backendPkg.overrides?.bogon,
    '1.2.0',
    'backend installs should keep bogon on the isReserved-compatible line',
  )
})

test('HyperDHT resolves a bogon build with isReserved', () => {
  const requireFromHyperdht = createRequire(
    path.join(repoRoot, 'packages/backend/node_modules/hyperdht/lib/connect.js')
  )
  const bogon = requireFromHyperdht('bogon')
  const bogonPkg = requireFromHyperdht('bogon/package.json')

  assert.equal(bogonPkg.version, '1.2.0')
  assert.equal(typeof bogon.isReserved, 'function')
})
