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
  const appPackage = JSON.parse(readFile('packages/app/package.json'))

  assert.match(
    workflow,
    /validate-submodules/,
    'desktop CI must initialize real gitlink submodules before native desktop bundles import bare-mpv',
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
  assert.match(
    appPackage.scripts['desktop:ecopy'],
    /mkdir -p .*Resources\/app\/workers\/core/,
    'Electrobun copy step must create app resource directories before rsync on clean CI runners',
  )
})

test('PR lint avoids the historical repo-wide lint backlog', () => {
  const workflow = readFile('.github/workflows/ci-fast.yml')
  const rootPackage = JSON.parse(readFile('package.json'))

  assert.match(
    rootPackage.scripts['lint:changed'],
    /scripts\/lint-changed\.mjs/,
    'root package should expose a changed-file lint command for PR CI',
  )
  assert.match(
    workflow,
    /github\.event_name == 'pull_request'/,
    'fast CI should branch lint behavior for pull requests',
  )
  assert.match(
    workflow,
    /npm run lint:changed/,
    'pull_request lint should only lint changed files because main has a known lint backlog',
  )
})
