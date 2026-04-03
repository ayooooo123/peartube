import fs from 'fs'
import path from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

const packageRoot = path.resolve(import.meta.dirname, '..')

const barePackScriptPaths = [
  'scripts/ensure-barekit-echo-bundle.mjs',
  'scripts/ensure-barekit-bare-fs-bundle.mjs',
  'scripts/ensure-barekit-corestore-bundle.mjs',
  'scripts/ensure-host-sidecar-bundle.mjs',
  'scripts/ensure-host-worklet-bundle.mjs',
]

const bareLinkScriptPaths = [
  'scripts/ensure-host-sidecar-frameworks.mjs',
]

test('desktop-native bare-pack scripts use --host instead of removed --target flag', () => {
  for (const relativePath of barePackScriptPaths) {
    const absolutePath = path.join(packageRoot, relativePath)
    const source = fs.readFileSync(absolutePath, 'utf8')

    assert.doesNotMatch(
      source,
      /--target\b/,
      `${relativePath} should not pass the removed bare-pack --target flag`
    )
    assert.match(
      source,
      /--host\b/,
      `${relativePath} should pass bare-pack --host`
    )
  }
})

test('desktop-native bare-link scripts use --host instead of removed --target flag', () => {
  for (const relativePath of bareLinkScriptPaths) {
    const absolutePath = path.join(packageRoot, relativePath)
    const source = fs.readFileSync(absolutePath, 'utf8')

    assert.doesNotMatch(
      source,
      /--target\b/,
      `${relativePath} should not pass the removed bare-link --target flag`
    )
    assert.match(
      source,
      /--host\b/,
      `${relativePath} should pass bare-link --host`
    )
  }
})

test('native host worklet bundler falls back to app node_modules for workspace package links', () => {
  const absolutePath = path.join(packageRoot, 'scripts/ensure-host-worklet-bundle.mjs')
  const source = fs.readFileSync(absolutePath, 'utf8')

  assert.match(
    source,
    /packages', 'app', 'node_modules'/,
    'ensure-host-worklet-bundle should use packages/app/node_modules as a workspace fallback',
  )
  assert.match(
    source,
    /linkPackageNodeModules/,
    'ensure-host-worklet-bundle should link package-local node_modules into the temp bundle tree',
  )
  assert.match(
    source,
    /const fallbackSourcePath = appNodeModulesPath/,
    'ensure-host-worklet-bundle should define an app node_modules fallback source',
  )
  assert.match(
    source,
    /fs\.existsSync\(fallbackSourcePath\)/,
    'ensure-host-worklet-bundle should use the app node_modules fallback when a package-local directory is missing',
  )
})

test('native host sidecar bundler stages a temp bundle tree with app node_modules fallback', () => {
  const absolutePath = path.join(packageRoot, 'scripts/ensure-host-sidecar-bundle.mjs')
  const source = fs.readFileSync(absolutePath, 'utf8')

  assert.match(
    source,
    /packages', 'app', 'node_modules'/,
    'ensure-host-sidecar-bundle should use packages/app/node_modules as a workspace fallback',
  )
  assert.match(
    source,
    /function findNodeModulesRoot\(/,
    'ensure-host-sidecar-bundle should resolve a node_modules root for temp bundling',
  )
  assert.match(
    source,
    /function linkPackageNodeModules\(/,
    'ensure-host-sidecar-bundle should link package-local node_modules into the temp bundle tree',
  )
  assert.match(
    source,
    /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), 'peartube-native-sidecar-'\)\)/,
    'ensure-host-sidecar-bundle should stage a temporary bundle root',
  )
})
