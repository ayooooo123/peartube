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

test('mobile iOS framework preparation avoids bash 4-only associative arrays on macOS runners', () => {
  const workflow = readFile('.github/workflows/build-mobile.yml')
  const script = readFile('packages/app/scripts/create-xcframeworks.sh')

  assert.doesNotMatch(
    script,
    /declare -A|\$\{[A-Z_]+\[[^\]]+\]:-/,
    'GitHub macOS runners execute npm scripts with old /bin/bash; ios:prepare must not require bash 4 associative arrays',
  )
  assert.match(
    workflow,
    /Prepare iOS frameworks[\s\S]*?shell:\s+bash/,
    'keep the workflow shell explicit while the script itself stays compatible with macOS bash 3.x',
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

test('mobile iOS framework preparation keeps exact versioned runtime dependencies', () => {
  const podfile = readFile('packages/app/ios/Podfile')
  const script = readFile('packages/app/scripts/create-xcframeworks.sh')

  assert.match(
    script,
    /contains_line "\$name_without_ext" "\$SKIP_FRAMEWORKS_FILE"/,
    'framework generation should skip exact duplicates already provided by react-native-bare-kit',
  )
  assert.doesNotMatch(
    script,
    /SKIP_FAMILIES_FILE|framework_family_name|addon family/,
    'framework generation must not skip a local addon just because BareKit provides a different version in the same family',
  )
  assert.doesNotMatch(
    podfile,
    /overlapping_families|framework_family|addon-family/,
    'pod install should not remove versioned BareAddons that satisfy exact dyld install names',
  )
})
