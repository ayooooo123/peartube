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
    /softprops\/action-gh-release@v3\.0\.0/,
    'release-android should own GitHub release publishing',
  )

  assert.doesNotMatch(
    buildRelay,
    /docker\/login-action/,
    'build-relay should not log in to GHCR or publish images',
  )
  assert.match(
    releaseRelay,
    /docker\/login-action@v4\.1\.0/,
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

test('GitHub Actions references use Node 24-compatible action majors', () => {
  const files = [
    ...fs.readdirSync(path.join(repoRoot, '.github/workflows')).map((name) => `.github/workflows/${name}`),
    ...fs.readdirSync(path.join(repoRoot, '.github/actions')).map((name) => `.github/actions/${name}/action.yml`),
  ].filter((relativePath) => /\.ya?ml$/.test(relativePath))

  const legacyActionRefs = [
    /actions\/checkout@v[1-5](\D|$)/,
    /actions\/setup-node@v[1-5](\D|$)/,
    /actions\/setup-java@v[1-4](\D|$)/,
    /actions\/upload-artifact@v[1-6](\D|$)/,
    /actions\/download-artifact@v[1-7](\D|$)/,
    /android-actions\/setup-android@v[1-3](\D|$)/,
    /softprops\/action-gh-release@v[1-2](\D|$)/,
    /docker\/setup-qemu-action@v[1-3](\D|$)/,
    /docker\/setup-buildx-action@v[1-3](\D|$)/,
    /docker\/login-action@v[1-3](\D|$)/,
    /docker\/build-push-action@v[1-6](\D|$)/,
  ]

  for (const relativePath of files) {
    const source = readFile(relativePath)
    for (const pattern of legacyActionRefs) {
      assert.doesNotMatch(source, pattern, `${relativePath} should not use ${pattern}`)
    }
  }
})
