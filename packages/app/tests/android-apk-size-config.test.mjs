import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')
const require = createRequire(import.meta.url)

const vectorIconPlugin = require('../plugins/withVectorIconFonts.js')

const androidReleaseWorkflowPath = path.join(repoRoot, '.github/workflows/android-release.yml')
const appPackageJsonPath = path.join(repoRoot, 'packages/app/package.json')
const appConfigPath = path.join(repoRoot, 'packages/app/app.json')

test('Android vector icon plugin only whitelists the icon fonts the app uses on mobile', () => {
  assert.deepEqual(vectorIconPlugin.ANDROID_ICON_FONT_ALLOWLIST, [
    'Feather.ttf',
    'Ionicons.ttf',
  ])

  assert.deepEqual(
    vectorIconPlugin.filterAndroidVectorIconFonts([
      'Feather.ttf',
      'Ionicons.ttf',
      'MaterialIcons.ttf',
      'FontAwesome.ttf',
    ]),
    ['Feather.ttf', 'Ionicons.ttf'],
  )
})

test('Android release config only targets real device architectures and dedupes bare-tls', () => {
  const workflow = fs.readFileSync(androidReleaseWorkflowPath, 'utf8')
  assert.match(workflow, /abi: \[arm64-v8a, armeabi-v7a\]/)
  assert.doesNotMatch(workflow, /x86_64/)
  assert.doesNotMatch(workflow, /\bx86\b/)

  const appPackageJson = JSON.parse(fs.readFileSync(appPackageJsonPath, 'utf8'))
  assert.equal(appPackageJson.overrides?.['bare-tls'], 'file:../bare-tls')
})

test('Expo build-properties config turns on persistent Android release size-saving settings', () => {
  const appConfig = JSON.parse(fs.readFileSync(appConfigPath, 'utf8'))
  const buildPropsEntry = appConfig.expo.plugins.find(
    (entry) => Array.isArray(entry) && entry[0] === 'expo-build-properties',
  )

  assert.ok(buildPropsEntry, 'expo-build-properties plugin must be configured')
  const androidConfig = buildPropsEntry[1]?.android || {}

  assert.equal(androidConfig.enableMinifyInReleaseBuilds, true)
  assert.equal(androidConfig.enableShrinkResourcesInReleaseBuilds, true)
  assert.equal(androidConfig.useLegacyPackaging, true)
})
