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
