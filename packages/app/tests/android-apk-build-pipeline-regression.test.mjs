import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appRoot, '..', '..')
const require = createRequire(import.meta.url)

function readFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('Android Gradle files use the generated Node resolver instead of assuming node is on PATH', () => {
  const settingsGradle = readFile('packages/app/android/settings.gradle')
  const appBuildGradle = readFile('packages/app/android/app/build.gradle')
  const appConfig = readFile('packages/app/app.json')

  for (const [name, source] of [
    ['settings.gradle', settingsGradle],
    ['app build.gradle', appBuildGradle],
  ]) {
    assert.match(source, /resolveNodeExecutable/, `${name} should define a Node executable resolver`)
    assert.doesNotMatch(source, /commandLine\("node"/, `${name} should not hard-code node for Gradle exec providers`)
    assert.doesNotMatch(source, /commandLine "node"/, `${name} should not hard-code node for Gradle Exec tasks`)
    assert.doesNotMatch(source, /\[["']node["']/, `${name} should not hard-code node for Gradle execute calls`)
  }

  assert.match(appConfig, /withAndroidAbiSplits\.js"[\s\S]*withAndroidNodeResolver\.js"/, 'prebuild should run the Node resolver after ABI split tasks are injected')
})

test('Android Node resolver config plugin rewrites generated Gradle', () => {
  const { _patchSettingsGradle, _patchAppBuildGradle } = require('../plugins/withAndroidNodeResolver.js')
  const patchedSettings = _patchSettingsGradle(`pluginManagement {
  providers.exec {
    commandLine("node", "--print", "require.resolve('react-native/package.json')")
  }
}
`)
  assert.match(patchedSettings, /resolveNodeExecutable/, 'settings plugin transform should inject the Node resolver')
  assert.doesNotMatch(patchedSettings, /commandLine\("node"/, 'settings plugin transform should rewrite provider exec calls')

  const patchedAppBuild = _patchAppBuildGradle(`def projectRoot = rootDir.getAbsoluteFile().getParentFile().getAbsolutePath()
react {
    entryFile = file(["node", "-e", "require('expo/scripts/resolveAppEntry')", projectRoot, "android", "absolute"].execute(null, rootDir).text.trim())
    cliFile = new File(["node", "--print", "require.resolve('@expo/cli', { paths: [require.resolve('expo/package.json')] })"].execute(null, rootDir).text.trim())
    bundleCommand = "export:embed"
}
tasks.register("ensureBackendBundles", Exec) {
    commandLine "node", "scripts/ensure-backend-bundles.js"
}
`)
  assert.match(patchedAppBuild, /resolveNodeExecutable/, 'app build plugin transform should inject the Node resolver')
  assert.doesNotMatch(patchedAppBuild, /commandLine "node"/, 'app build plugin transform should rewrite Exec task calls')
  assert.doesNotMatch(patchedAppBuild, /\[["']node["']/, 'app build plugin transform should rewrite execute calls')
})

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
    assert.match(
      setupAction,
      /for attempt in 1 2 3/,
      `${name} workflow family should retry transient npm install failures before failing`,
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

test('Android engine workflows swap the JS engine without patching BareKit source', () => {
  const engineAbWorkflow = readFile('.github/workflows/android-engine-ab.yml')
  const engineBuildWorkflow = readFile('.github/workflows/build-bare-kit-engine.yml')

  for (const [name, source] of [
    ['android-engine-ab', engineAbWorkflow],
    ['build-bare-kit-engine', engineBuildWorkflow],
  ]) {
    assert.match(
      source,
      /-DBARE_ENGINE=/,
      `${name} should still build BareKit with the selected engine`,
    )
    assert.doesNotMatch(
      source,
      /Patch QJS worklet bootstrap|git apply <<'PATCH'|shared\/worklet\.(c|js)|__BareKitWorkletBootstrap|bootstrap=barefix|PATCHES/,
      `${name} should not patch holepunchto/bare-kit source at build time`,
    )
  }

  assert.equal(
    fs.existsSync(path.join(repoRoot, 'packages/app/bare-kit-engine/patches/bare-escape-handle.patch')),
    false,
    'Bare source patches should not be tracked in the app engine overlay directory',
  )
})
