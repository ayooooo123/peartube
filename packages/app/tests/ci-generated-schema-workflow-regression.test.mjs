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

test('desktop workflows regenerate HRPC schema before desktop builds that import @peartube/spec', () => {
  const workflow = readFile('.github/workflows/build-desktop.yml')
  const validateSubmodulesAction = readFile('.github/actions/validate-submodules/action.yml')
  const appPackage = JSON.parse(readFile('packages/app/package.json'))
  const archiveProjectIndex = workflow.indexOf('Generate native desktop project')
  const archiveSchemaIndex = workflow.lastIndexOf('Generate HRPC schema', archiveProjectIndex)

  assert.match(
    workflow,
    /validate-submodules/,
    'desktop CI must initialize real gitlink submodules before native desktop bundles import bare-ffmpeg',
  )
  assert.match(
    workflow,
    /npm run schema/,
    'desktop CI must regenerate packages/spec/spec/hrpc before Expo/Bare desktop builds resolve @peartube/spec',
  )
  assert.match(
    workflow,
    /npm run schema:full/,
    'native desktop CI must regenerate JS and Swift schema before bundling/testing native desktop sidecar',
  )
  assert.ok(archiveProjectIndex >= 0, 'native desktop archive job should generate an Xcode project')
  assert.ok(
    archiveSchemaIndex >= 0 && archiveSchemaIndex < archiveProjectIndex,
    'native desktop archive must run schema:full before xcodegen so generated Swift HRPC/schema types exist',
  )
  assert.doesNotMatch(
    validateSubmodulesAction,
    /declare -A|mapfile/,
    'validate-submodules must avoid bash 4-only syntax because macOS CI ships old bash',
  )
  assert.match(
    appPackage.scripts['desktop:ecopy'],
    /mkdir -p .*Resources\/app\/workers\/core/,
    'Electrobun copy step must create app resource directories before rsync on clean CI runners',
  )
})

test('fast CI avoids the historical repo-wide lint backlog on both PR and main pushes', () => {
  const workflow = readFile('.github/workflows/ci-fast.yml')
  const rootPackage = JSON.parse(readFile('package.json'))
  const eslintIgnore = readFile('.eslintignore')
  const changedLint = readFile('scripts/lint-changed.mjs')
  const privateRoutesWorkflow = readFile('.github/workflows/private-routes.yml')
  const privateRoutesPackage = JSON.parse(readFile('packages/private-routes/package.json'))

  assert.match(
    rootPackage.scripts['lint:changed'],
    /scripts\/lint-changed\.mjs/,
    'root package should expose a changed-file lint command for Fast CI',
  )
  assert.match(
    workflow,
    /fetch-depth: 0/,
    'lint checkout must fetch enough history for merge-base against origin/main',
  )
  assert.match(
    workflow,
    /npm run lint:changed/,
    'Fast CI should lint changed files because main has a known lint backlog',
  )
  assert.doesNotMatch(
    workflow,
    /npm run lint(\s|$)/,
    'Fast CI must not run repo-wide lint until the historical backlog is cleared',
  )
  assert.match(
    eslintIgnore,
    /^packages\/private-routes\/\*\*$/m,
    'the standalone Holepunch-style package must use its own pinned format and runtime gates',
  )
  assert.match(
    privateRoutesPackage.scripts['format:check'],
    /prettier --check/,
    'the private-routes workflow must retain an explicit package-local format gate',
  )
  assert.match(
    privateRoutesWorkflow,
    /packages\/private-routes\/\*\*/,
    'the package-local workflow must run whenever private-routes changes',
  )
  assert.match(
    privateRoutesWorkflow,
    /npm run format:check/,
    'the package-local workflow must invoke its pinned format gate',
  )
  assert.match(
    changedLint,
    /PACKAGE_LOCAL_LINT_PREFIXES[\s\S]*packages\/private-routes\//,
    'changed-file lint must omit packages governed by their own runtime-native workflow',
  )
})
