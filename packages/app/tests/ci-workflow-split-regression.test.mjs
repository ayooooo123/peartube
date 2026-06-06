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

  assert.match(
    releaseAndroid,
    /if:\s*always\(\)[^\n]*startsWith\(github\.ref, 'refs\/tags\/v'\)/,
    'release-android should still publish completed APK artifacts when one matrix ABI flakes after other ABIs uploaded',
  )
  assert.match(
    releaseAndroid,
    /No APK artifacts were downloaded for release publishing/,
    'release-android should fail loudly if no APK artifacts are available to attach to the tag release',
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

test('tagged Android releases build arm64 and x86 APKs', () => {
  const releaseAndroid = readFile('.github/workflows/release-android.yml')
  const abiSplitsPlugin = readFile('packages/app/plugins/withAndroidAbiSplits.js')

  assert.match(
    releaseAndroid,
    /abi:\s*\[arm64-v8a, x86, x86_64\]/,
    'release-android should build arm64-v8a, x86, and x86_64 APKs for tagged releases',
  )
  assert.doesNotMatch(
    releaseAndroid,
    /abi:\s*\[[^\]]*armeabi-v7a/,
    'release-android should skip armv7 APK builds for tagged releases',
  )
  assert.match(
    releaseAndroid,
    /--max-workers\s+2/,
    'release-android should cap Gradle workers so dex merging does not exhaust runner heap',
  )
  assert.match(
    releaseAndroid,
    /org\.gradle\.jvmargs=-Xmx4096m/,
    'release-android should raise Gradle heap for D8 dex merging',
  )
  assert.match(
    abiSplitsPlugin,
    /findProperty\('targetAbis'\)/,
    'ABI split generation should honor the release workflow targetAbis property',
  )
  assert.doesNotMatch(
    abiSplitsPlugin,
    /include "armeabi-v7a", "arm64-v8a", "x86", "x86_64"/,
    'ABI split generation should not hard-code all Android ABIs for arm64-only releases',
  )
})

test('routine validation workflows use path filters to avoid irrelevant runs', () => {
  const workflows = [
    ['ci-fast', readFile('.github/workflows/ci-fast.yml')],
    ['build-relay', readFile('.github/workflows/build-relay.yml')],
    ['build-mobile', readFile('.github/workflows/build-mobile.yml')],
    ['build-desktop', readFile('.github/workflows/build-desktop.yml')],
  ]

  for (const [name, workflow] of workflows) {
    assert.match(
      workflow,
      /paths:\s*\n(?:\s*- '[^']+'\s*\n)+/,
      `${name} should use trigger-level paths filters`,
    )
  }
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
