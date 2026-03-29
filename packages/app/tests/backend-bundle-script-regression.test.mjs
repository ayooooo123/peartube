import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

function readPackageJson() {
  return JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'))
}

test('mobile backend bundle scripts use bare-pack mobile preset instead of removed target flags', () => {
  const { scripts } = readPackageJson()
  const bundleScriptNames = [
    'bundle:backend',
    'bundle:backend:main',
    'bundle:backend:worker',
    'bundle:test',
  ]

  for (const scriptName of bundleScriptNames) {
    const script = scripts[scriptName]
    assert.ok(script, `${scriptName} should exist`)
    assert.match(
      script,
      /bare-pack --preset mobile --linked/,
      `${scriptName} should invoke bare-pack with the mobile preset`,
    )
    assert.doesNotMatch(
      script,
      /--target\b/,
      `${scriptName} should not use the removed bare-pack --target flag`,
    )
  }
})
