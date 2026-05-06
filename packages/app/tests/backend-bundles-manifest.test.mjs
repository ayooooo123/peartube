import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import manifest from '../backend-bundles.manifest.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appRoot, '..', '..')

function resolveRepoPath(relativePath) {
  return path.resolve(repoRoot, relativePath)
}

function readPackageJson() {
  return JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'))
}

test('backend bundle manifest declares every mobile Bare bundle and runtime cache target', () => {
  assert.equal(manifest.bundles.length, 2)

  const bundlesById = new Map(manifest.bundles.map(bundle => [bundle.id, bundle]))
  assert.deepEqual([...bundlesById.keys()].sort(), ['backend', 'downloader-worker'])

  assert.equal(bundlesById.get('backend').entry, 'packages/app/backend/index.mjs')
  assert.equal(bundlesById.get('backend').output, 'packages/app/backend.bundle.js')
  assert.equal(bundlesById.get('backend').cacheId, 'backend')
  assert.equal(bundlesById.get('backend').runtime.cacheFilename, 'backend.bundle')
  assert.equal(bundlesById.get('backend').runtime.workletId, '/peartube-backend-core.bundle')
  assert.equal(bundlesById.get('backend').runtime.required, true)

  assert.equal(bundlesById.get('downloader-worker').entry, 'packages/app/backend/downloader-worker.mjs')
  assert.equal(bundlesById.get('downloader-worker').output, 'packages/app/downloader-worker.bundle.js')
  assert.equal(bundlesById.get('downloader-worker').cacheId, 'downloader-worker')
  assert.equal(bundlesById.get('downloader-worker').runtime.cacheFilename, 'downloader-worker.bundle.js')
  assert.equal(bundlesById.get('downloader-worker').runtime.launchArg, true)
})

test('manifest paths resolve from repo root no matter the current working directory', () => {
  const originalCwd = process.cwd()
  const cwdCases = [repoRoot, appRoot, path.dirname(appRoot)]

  try {
    for (const cwd of cwdCases) {
      process.chdir(cwd)
      for (const bundle of manifest.bundles) {
        assert.ok(fs.existsSync(resolveRepoPath(bundle.entry)), `${bundle.id} entry exists from ${cwd}`)
        for (const sourceRoot of bundle.sourceRoots) {
          if (sourceRoot === 'packages/spec/spec' && !fs.existsSync(resolveRepoPath(sourceRoot))) continue
          assert.ok(fs.existsSync(resolveRepoPath(sourceRoot)), `${bundle.id} source root ${sourceRoot} exists from ${cwd}`)
        }
        for (const sourceFile of bundle.sourceFiles) {
          assert.ok(fs.existsSync(resolveRepoPath(sourceFile)), `${bundle.id} source file ${sourceFile} exists from ${cwd}`)
        }
      }
    }
  } finally {
    process.chdir(originalCwd)
  }
})

test('package bundle scripts are generated from manifest bundle definitions', () => {
  const { scripts } = readPackageJson()
  const builderSource = fs.readFileSync(path.join(appRoot, 'scripts', 'build-backend-bundles.js'), 'utf8')

  assert.match(scripts['bundle:backend'], /node \.\/scripts\/build-backend-bundles\.js/)
  assert.match(builderSource, /manifest\.bundles/)
  assert.match(builderSource, /--out/)
  assert.match(builderSource, /bundle\.output/)
  assert.match(builderSource, /bundle\.entry/)
  assert.match(builderSource, /pack\.flags/)

  for (const bundle of manifest.bundles) {
    assert.ok(bundle.pack.flags.includes('--preset'))
    assert.ok(bundle.pack.flags.includes('mobile'))
    assert.ok(bundle.pack.flags.includes('--linked'))
  }
})

test('ensure script and native cache validation consume the manifest source of truth', () => {
  const ensureScript = fs.readFileSync(path.join(appRoot, 'scripts', 'ensure-backend-bundles.js'), 'utf8')
  const layoutSource = fs.readFileSync(path.join(appRoot, 'app', '_layout.tsx'), 'utf8')
  const nativeCacheSource = fs.readFileSync(path.join(repoRoot, 'packages/platform/src/native-bundle-cache.js'), 'utf8')

  assert.match(ensureScript, /backend-bundles\.manifest\.mjs/)
  assert.match(ensureScript, /manifest\.bundles/)
  assert.doesNotMatch(ensureScript, /const bundleFiles = \[/)
  assert.doesNotMatch(ensureScript, /const sourceRoots = \[/)

  for (const bundle of manifest.bundles) {
    assert.match(ensureScript, new RegExp(`bundle\\.${'output'}`), 'ensure script validates every manifest output')
    assert.match(nativeCacheSource, new RegExp(bundle.runtime.cacheFilename.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')))
    assert.match(layoutSource, new RegExp(bundle.output.replace('packages/app/', '../').replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')))
  }
})
