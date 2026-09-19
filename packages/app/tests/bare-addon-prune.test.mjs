import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import {
  collectLinkedAddonNames,
  pruneBareAddons,
} from '../scripts/prune-bare-addons.mjs'

const require = createRequire(import.meta.url)
const Bundle = require('bare-bundle')
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

function writeWrappedBundle(outputPath, resolutionsByModule) {
  const bundle = new Bundle()

  for (const [modulePath, imports] of Object.entries(resolutionsByModule)) {
    bundle.write(modulePath, 'module.exports = null\n', { imports })
  }

  const serialized = bundle.toBuffer().toString('utf8')
  fs.writeFileSync(outputPath, `module.exports = ${JSON.stringify(serialized)}\n`)
}

function touch(filePath, contents = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents)
}

test('collectLinkedAddonNames reads Android linked libraries from bare bundle headers', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-addon-bundle-'))
  const backendBundle = path.join(tempDir, 'backend.bundle.js')
  const workerBundle = path.join(tempDir, 'downloader-worker.bundle.js')

  writeWrappedBundle(backendBundle, {
    '/backend/index.mjs': {
      'bare-fs': {
        android: 'linked:libbare-fs.4.7.2.so',
        ios: 'linked:bare-fs.4.7.2.framework/bare-fs.4.7.2',
      },
      'bare-tls': {
        android: 'linked:libbare-tls.2.2.3.so',
        ios: 'linked:bare-tls.2.2.3.framework/bare-tls.2.2.3',
      },
      './local.mjs': '/backend/local.mjs',
      './not-an-android-so': {
        android: 'linked:bare-addon.framework/bare-addon',
      },
    },
  })

  writeWrappedBundle(workerBundle, {
    '/backend/downloader-worker.mjs': {
      'bare-thread': {
        android: 'linked:libbare-thread.1.2.2.so',
      },
    },
  })

  assert.deepEqual(
    [...collectLinkedAddonNames([backendBundle, workerBundle], 'android')].sort(),
    [
      'libbare-fs.4.7.2.so',
      'libbare-thread.1.2.2.so',
      'libbare-tls.2.2.3.so',
    ],
  )

  assert.deepEqual(
    [...collectLinkedAddonNames([backendBundle, workerBundle], 'ios')].sort(),
    [
      'bare-fs.4.7.2.xcframework',
      'bare-tls.2.2.3.xcframework',
    ],
    'an addon linked only under the android condition must not ship on iOS',
  )
})

test('pruneBareAddons removes unreferenced Android libraries from ABI directories only', () => {
  const addonsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-addons-'))
  const keepNames = new Set(['libbare-fs.4.7.2.so', 'libbare-tls.2.2.3.so'])

  for (const abi of ['arm64-v8a', 'x86_64']) {
    touch(path.join(addonsRoot, abi, 'libbare-fs.4.7.2.so'), 'keep')
    touch(path.join(addonsRoot, abi, 'libbare-tls.2.2.3.so'), 'keep')
    touch(path.join(addonsRoot, abi, 'libbare-tls.3.1.7.so'), 'drop')
    touch(path.join(addonsRoot, abi, 'librabin-native.2.0.0.so'), 'drop')
    touch(path.join(addonsRoot, abi, 'bare-addon.classes.jar'), 'keep jar')
  }

  touch(path.join(addonsRoot, 'README.txt'), 'keep root file')

  const result = pruneBareAddons({ platform: 'android', addonsRoot, keepNames })

  assert.deepEqual(
    result.removed.map((entry) => `${entry.abi}/${entry.name}`).sort(),
    [
      'arm64-v8a/libbare-tls.3.1.7.so',
      'arm64-v8a/librabin-native.2.0.0.so',
      'x86_64/libbare-tls.3.1.7.so',
      'x86_64/librabin-native.2.0.0.so',
    ],
  )

  for (const abi of ['arm64-v8a', 'x86_64']) {
    assert.equal(fs.existsSync(path.join(addonsRoot, abi, 'libbare-fs.4.7.2.so')), true)
    assert.equal(fs.existsSync(path.join(addonsRoot, abi, 'libbare-tls.2.2.3.so')), true)
    assert.equal(fs.existsSync(path.join(addonsRoot, abi, 'libbare-tls.3.1.7.so')), false)
    assert.equal(fs.existsSync(path.join(addonsRoot, abi, 'librabin-native.2.0.0.so')), false)
    assert.equal(fs.existsSync(path.join(addonsRoot, abi, 'bare-addon.classes.jar')), true)
  }
  assert.equal(fs.existsSync(path.join(addonsRoot, 'README.txt')), true)
})

test('pruneBareAddons removes unreferenced iOS XCFrameworks', () => {
  const addonsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-ios-addons-'))
  const keepNames = new Set(['bare-fs.4.7.2.xcframework', 'sodium-native.5.0.10.xcframework'])

  for (const name of [
    'bare-fs.4.7.2.xcframework',
    'sodium-native.5.0.10.xcframework',
    'bare-fs.4.5.2.xcframework',
    'bare-heif.1.0.7.xcframework',
  ]) {
    touch(path.join(addonsRoot, name, 'Info.plist'), name)
  }

  const result = pruneBareAddons({ platform: 'ios', addonsRoot, keepNames })

  assert.deepEqual(
    result.removed.map((entry) => entry.name).sort(),
    ['bare-fs.4.5.2.xcframework', 'bare-heif.1.0.7.xcframework'],
  )
  assert.equal(fs.existsSync(path.join(addonsRoot, 'bare-fs.4.7.2.xcframework')), true)
  assert.equal(fs.existsSync(path.join(addonsRoot, 'sodium-native.5.0.10.xcframework')), true)
  assert.equal(fs.existsSync(path.join(addonsRoot, 'bare-fs.4.5.2.xcframework')), false)
  assert.equal(
    fs.existsSync(path.join(addonsRoot, 'bare-heif.1.0.7.xcframework')),
    false,
    'image codecs the bundles never decode must not ship',
  )
})

test('pruneBareAddons refuses to run with an empty keep-set', () => {
  const addonsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-empty-keep-'))
  touch(path.join(addonsRoot, 'bare-fs.4.7.2.xcframework', 'Info.plist'), 'x')

  assert.throws(
    () => pruneBareAddons({ platform: 'ios', addonsRoot, keepNames: [] }),
    /empty linked keep-set/,
  )
  assert.equal(fs.existsSync(path.join(addonsRoot, 'bare-fs.4.7.2.xcframework')), true)
})

test('iOS pod install links Bare addons then prunes to the linked set', () => {
  const podfile = fs.readFileSync(path.join(appRoot, 'ios', 'Podfile'), 'utf8')

  assert.match(
    podfile,
    /pre_install do \|installer\|[\s\S]*prune_bare_kit_addons!/,
    'pruning must happen before CocoaPods globs ios/addons into the Pods project',
  )
  assert.match(
    podfile,
    /react-native-bare-kit\/ios\/link\.mjs/,
    'the Podfile must run the bare-kit linker itself, because prepare_command is skipped for :path pods',
  )
  assert.match(
    podfile,
    /scripts\/prune-bare-addons\.mjs/,
    'the Podfile must call the bundle-header based prune script',
  )
  assert.match(
    podfile,
    /'--platform',\s*'ios'/,
    'the Podfile must prune the iOS addon set',
  )
})

test('Android release packaging prunes Bare addons after react-native-bare-kit links them', () => {
  const buildGradle = fs.readFileSync(path.join(appRoot, 'android', 'app', 'build.gradle'), 'utf8')
  const abiSplitsPlugin = fs.readFileSync(path.join(appRoot, 'plugins', 'withAndroidAbiSplits.js'), 'utf8')

  assert.match(
    buildGradle,
    /tasks\.register\("pruneBareAndroidAddons",\s*Exec\)/,
    'app Gradle should declare a Bare addon prune task',
  )
  assert.match(
    buildGradle,
    /tasks\.register\("ensureBackendBundles",\s*Exec\)/,
    'app Gradle should declare a backend bundle freshness task',
  )
  assert.match(
    buildGradle,
    /scripts\/ensure-backend-bundles\.js/,
    'the freshness task should call the backend bundle ensure script',
  )
  assert.match(
    buildGradle,
    /dependsOn\(tasks\.named\("ensureBackendBundles"\)\)/,
    'addon pruning should wait for fresh backend bundles',
  )
  assert.match(
    buildGradle,
    /it\.name\.startsWith\("createBundle"\)[\s\S]*it\.name\.endsWith\("JsAndAssets"\)[\s\S]*dependsOn\(ensureBundlesTask\)/,
    'React Native JS bundling should wait for fresh backend bundles',
  )
  assert.match(
    buildGradle,
    /scripts\/prune-bare-addons\.mjs/,
    'the prune task should call the bundle-header based prune script',
  )
  assert.match(
    buildGradle,
    /resolveAndroidTargetAbis\(\)\.each\s*\{\s*abi\s*->[\s\S]*args\s+"--abi",\s*abi/,
    'the prune task should prune only the ABIs selected for the current build',
  )
  assert.match(
    buildGradle,
    /pruneTask\.configure\s*\{[\s\S]*dependsOn\(bareKitLinkTask\)/,
    'the prune task should run after react-native-bare-kit has linked addons',
  )
  assert.match(
    buildGradle,
    /it\.name == "mergeReleaseNativeLibs"[\s\S]*dependsOn\(pruneTask\)/,
    'release native-lib merging should wait for addon pruning',
  )

  const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'))
  assert.match(
    packageJson.scripts['build:android:apk:arm64'],
    /npm run prepare:mobile-backend/,
    'Android APK scripts should build the bundle headers before Gradle prunes addons',
  )

  assert.match(
    abiSplitsPlugin,
    /ensureBackendBundles/,
    'the Expo prebuild plugin should preserve backend bundle freshness checks',
  )
  assert.match(
    abiSplitsPlugin,
    /pruneBareAndroidAddons/,
    'the Expo prebuild plugin should preserve Bare addon pruning when android/app/build.gradle is regenerated',
  )
  assert.match(
    abiSplitsPlugin,
    /scripts\/prune-bare-addons\.mjs/,
    'the Expo prebuild plugin should inject the bundle-header based prune script',
  )
  assert.match(
    abiSplitsPlugin,
    /normalizeAbiSplitInclude/,
    'the Expo prebuild plugin should normalize older generated ABI include blocks',
  )
})
