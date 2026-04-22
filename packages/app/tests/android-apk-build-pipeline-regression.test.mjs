import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appRoot, '..', '..')

function readFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('Android GitHub workflows regenerate HRPC spec and backend bundles before APK builds', () => {
  const buildWorkflow = readFile('.github/workflows/android-build.yml')
  const releaseWorkflow = readFile('.github/workflows/android-release.yml')

  for (const [name, source] of [
    ['android-build', buildWorkflow],
    ['android-release', releaseWorkflow],
  ]) {
    assert.match(
      source,
      /npm run prepare:mobile-backend/,
      `${name} workflow should regenerate spec+bundle before Android packaging`,
    )
  }
})

test('bundle freshness guard watches schema changes and regenerates spec before bundling', () => {
  const source = readFile('packages/app/scripts/ensure-backend-bundles.js')

  assert.match(
    source,
    /packages', 'spec', 'schema\.cjs'/,
    'ensure-backend-bundles should treat schema.cjs as a source dependency',
  )
  assert.match(
    source,
    /spawnSync\('npm', \['run', 'schema']/,
    'ensure-backend-bundles should regenerate the HRPC spec before rebuilding bundles',
  )
  assert.match(
    source,
    /spawnSync\('npm', \['run', 'bundle:backend']/,
    'ensure-backend-bundles should still rebuild the backend bundle after regenerating spec',
  )
})
