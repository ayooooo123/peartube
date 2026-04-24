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

test('build workflows stay separate from publish workflows', () => {
  const buildMobile = readFile('.github/workflows/build-mobile.yml')
  const releaseAndroid = readFile('.github/workflows/release-android.yml')
  const buildRelay = readFile('.github/workflows/build-relay.yml')
  const releaseRelay = readFile('.github/workflows/release-relay.yml')

  assert.doesNotMatch(
    buildMobile,
    /softprops\/action-gh-release/,
    'build-mobile should not publish GitHub releases',
  )
  assert.match(
    releaseAndroid,
    /softprops\/action-gh-release@v2/,
    'release-android should own GitHub release publishing',
  )

  assert.doesNotMatch(
    buildRelay,
    /docker\/login-action/,
    'build-relay should not log in to GHCR or publish images',
  )
  assert.match(
    releaseRelay,
    /docker\/login-action@v3/,
    'release-relay should own GHCR publishing',
  )
  assert.match(
    releaseRelay,
    /packages:\s*write/,
    'release-relay should request package write permissions for GHCR publish',
  )
  assert.doesNotMatch(
    buildRelay,
    /packages:\s*write/,
    'build-relay should not request package publish permissions',
  )
})
