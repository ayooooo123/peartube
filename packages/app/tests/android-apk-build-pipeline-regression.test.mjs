import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appRoot, '..', '..')

function readFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('Android GitHub workflows regenerate HRPC spec and backend bundles before APK builds', () => {
  const buildWorkflow = readFile('.github/workflows/build-mobile.yml')
  const releaseWorkflow = readFile('.github/workflows/release-android.yml')
  const prepareAction = readFile('.github/actions/prepare-mobile-backend/action.yml')
  const setupAction = readFile('.github/actions/setup-node-workspace/action.yml')

  for (const [name, source] of [
    ['build-mobile', buildWorkflow],
    ['release-android', releaseWorkflow],
  ]) {
    assert.match(
      source,
      /prepare-mobile-backend/,
      `${name} workflow should invoke the shared mobile backend preparation action before Android packaging`,
    )
    assert.match(
      source,
      /setup-node-workspace/,
      `${name} workflow should use the shared Node workspace setup action`,
    )
    assert.doesNotMatch(
      source,
      /cache:\s*'npm'/,
      `${name} workflow should not inline setup-node npm caching without a root lockfile strategy`,
    )
    assert.match(
      setupAction,
      /npm run install:all/,
      `${name} workflow family should use the repo install:all flow instead of root npm ci`,
    )
  }

  assert.match(
    prepareAction,
    /npm run prepare:mobile-backend/,
    'the shared prepare-mobile-backend action should regenerate spec+bundle before Android packaging',
  )
  assert.doesNotMatch(
    setupAction,
    /\bnpm ci\b/,
    'the shared Node setup action should not use root npm ci',
  )
})

test('bundle freshness guard watches manifest schema changes and regenerates spec before bundling', async () => {
  const source = readFile('packages/app/scripts/ensure-backend-bundles.js')
  const manifest = await import(pathToFileURL(path.join(repoRoot, 'packages/app/backend-bundles.manifest.mjs')).href)

  assert.ok(
    manifest.default.bundles.every(bundle => bundle.sourceFiles.includes('packages/spec/schema.cjs')),
    'backend bundle manifest should treat schema.cjs as a source dependency for every bundle',
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
