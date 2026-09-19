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

test('iOS builds get their addons from the pruned bare-kit set, not a committed prebuilds tree', () => {
  const repoFile = (p) => path.join(repoRoot, p)

  for (const gone of [
    'packages/app/BareAddons.podspec',
    'packages/app/scripts/create-xcframeworks.sh',
    'packages/app/scripts/build-addons.sh',
    'packages/app/prebuilds',
    'packages/app/prebuilds-sim',
  ]) {
    assert.equal(
      fs.existsSync(repoFile(gone)),
      false,
      `${gone} shipped stale duplicate addon versions beside the ones bare-link produces`,
    )
  }

  const packageJson = JSON.parse(readFile('packages/app/package.json'))
  assert.equal(packageJson.scripts['ios:prepare'], undefined)

  for (const workflow of ['.github/workflows/build-mobile.yml', '.github/workflows/release-ios.yml']) {
    assert.doesNotMatch(readFile(workflow), /ios:prepare/, `${workflow} must not call the deleted prepare step`)
  }

  assert.doesNotMatch(
    readFile('packages/app/ios/Podfile'),
    /BareAddons/,
    'the Podfile must not vendor a second, separately versioned addon source',
  )
})

test('mobile iOS build scripts install pods through the repo helper with Homebrew on PATH', () => {
  const packageJson = JSON.parse(readFile('packages/app/package.json'))
  const helper = readFile('packages/app/scripts/install-ios-pods.sh')
  const runHelper = readFile('packages/app/scripts/run-ios.sh')

  assert.equal(
    packageJson.scripts['ios:pods'],
    'bash ./scripts/install-ios-pods.sh',
    'iOS pod installation should live in one helper script',
  )
  assert.equal(
    packageJson.scripts['ios:run'],
    'bash ./scripts/run-ios.sh',
    'Expo iOS simulator launch should use the PATH-normalizing helper',
  )
  assert.equal(
    packageJson.scripts['ios:run:device'],
    'bash ./scripts/run-ios.sh --device',
    'Expo iOS device launch should use the PATH-normalizing helper',
  )

  for (const scriptName of ['ios', 'build:ios', 'build:ios:device']) {
    assert.match(
      packageJson.scripts[scriptName],
      /npm run ios:pods/,
      `${scriptName} should use the PATH-normalizing CocoaPods helper`,
    )
  }
  assert.match(packageJson.scripts.ios, /npm run ios:run/)
  assert.match(packageJson.scripts['build:ios'], /npm run ios:run/)
  assert.match(packageJson.scripts['build:ios:device'], /npm run ios:run:device/)

  assert.match(
    helper,
    /\/opt\/homebrew\/bin:\/usr\/local\/bin:\$PATH/,
    'helper should expose common Homebrew bin directories to npm-launched builds',
  )
  assert.match(
    helper,
    /cd "\$MOBILE_DIR\/ios"/,
    'helper should run CocoaPods from the generated iOS project directory',
  )
  assert.match(
    helper,
    /pod install/,
    'helper should use the installed CocoaPods CLI directly when available',
  )
  assert.match(
    runHelper,
    /\/opt\/homebrew\/bin:\/usr\/local\/bin:\$PATH/,
    'Expo run helper should expose CocoaPods and Homebrew to expo run:ios',
  )
  assert.match(
    runHelper,
    /expo run:ios "\$@"/,
    'Expo run helper should forward simulator/device flags to expo run:ios',
  )
})

test('every addon the packed bundles name by exact dyld install name survives the prune', async () => {
  const { collectLinkedAddonNames } = await import('../scripts/prune-bare-addons.mjs')

  const bundles = [
    path.join(repoRoot, 'packages/app/backend.bundle.js'),
    path.join(repoRoot, 'packages/app/downloader-worker.bundle.js'),
  ]
  if (!bundles.every((file) => fs.existsSync(file))) return

  const keep = collectLinkedAddonNames(bundles, 'ios')
  assert.ok(keep.size > 0, 'the bundles must link at least one addon')

  for (const name of keep) {
    assert.match(
      name,
      /^[a-z0-9-]+\.\d+\.\d+\.\d+\.xcframework$/,
      'the keep-set is matched against dyld install names, so each entry must stay exactly versioned',
    )
  }
})
