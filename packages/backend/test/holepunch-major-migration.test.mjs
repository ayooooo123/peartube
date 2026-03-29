import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
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
  const pearPkg = readPackageJson('packages/app/pear-src/package.json')
  const backendPkg = readPackageJson('packages/backend/package.json')
  const cliPkg = readPackageJson('packages/cli/package.json')

  assert.equal(
    appPkg.devDependencies['bare-build'],
    '^0.4.6',
    'app should use the current bare-build line',
  )
  assert.equal(
    cliPkg.devDependencies['bare-build'],
    '^0.4.6',
    'cli should use the current bare-build line',
  )
  assert.equal(
    appPkg.devDependencies['bare-pack'],
    '^2.0.1',
    'app should use the current bare-pack major line',
  )
  assert.equal(
    pearPkg.dependencies['bare-subprocess'],
    '^5.2.3',
    'pear worker should use the current bare-subprocess line',
  )
  assert.ok(
    !('hyperdb' in appPkg.devDependencies),
    'app should not keep an unused direct hyperdb dependency',
  )
  assert.ok(
    !('hyperdb' in pearPkg.dependencies),
    'pear worker should not keep an unused direct hyperdb dependency',
  )
  assert.ok(
    !('hyperdb' in backendPkg.dependencies),
    'backend should not keep an unused direct hyperdb dependency',
  )
  assert.equal(
    rootPkg.dependencies['bare-runtime'],
    '^1.28.1',
    'root runtime should stay on the latest compatible bare-runtime line',
  )
})
