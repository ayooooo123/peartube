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

test('engine-first package boundaries do not keep deleted backend stack dependencies alive', () => {
  const backendPkg = readPackageJson('packages/backend/package.json')
  const appPkg = readPackageJson('packages/app/package.json')
  const cliPkg = readPackageJson('packages/cli/package.json')

  assert.equal(
    backendPkg.dependencies['@peartube/engine'],
    'file:../engine',
    'backend should route the P2P runtime through @peartube/engine',
  )

  for (const name of [
    'autobase',
    'hyperblobs',
    'corestore',
    'hyperbee',
    'hypercore',
    'hyperdispatch',
    'hyperswarm',
    'protomux',
    'hypercore-blob-server',
    'hypercore-crypto',
    'hyperbee-diff-stream',
    'hyperswarm-stats',
    'protomux-wakeup',
    'blind-pairing',
    'blind-peer',
    'blind-peering',
    'compact-encoding',
    'ready-resource',
    'z32',
  ]) {
    assert.ok(
      !(name in backendPkg.dependencies),
      `backend should not keep unused direct ${name} dependency after engine migration`,
    )
  }

  for (const name of [
    'autobase',
    'hyperblobs',
    'corestore',
    'hyperbee',
    'hypercore',
    'hyperdispatch',
    'hyperswarm',
    'protomux',
    'hypercore-blob-server',
    'hypercore-crypto',
    'hyperswarm-stats',
    'protomux-wakeup',
    'blind-pairing',
    'compact-encoding',
    'ready-resource',
    'z32',
  ]) {
    assert.ok(
      !(name in (appPkg.dependencies || {})),
      `app should not keep unused direct runtime ${name} dependency`,
    )
    assert.ok(
      !(name in (appPkg.devDependencies || {})),
      `app should not keep unused direct dev ${name} dependency`,
    )
  }

  assert.ok(
    !('test:multiwriter' in backendPkg.scripts),
    'backend should not expose deleted Autobase multi-writer test script',
  )
  assert.ok(
    cliPkg.scripts.test,
    'CLI keeps its test entrypoint while old backend internals are removed',
  )
})
