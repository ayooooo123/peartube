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

function readJson(relativePath) {
  return JSON.parse(readFile(relativePath))
}

test('SDK 56 app code does not directly import React Navigation packages', () => {
  const appPackage = readJson('packages/app/package.json')
  const dependencies = appPackage.dependencies || {}
  const forbidden = Object.keys(dependencies).filter((name) => name.startsWith('@react-navigation/'))

  assert.deepEqual(forbidden, [], 'expo-router SDK 56 owns React Navigation dependencies')

  const sourceFiles = [
    'packages/app/app/video/[id].tsx',
  ]

  for (const file of sourceFiles) {
    assert.doesNotMatch(readFile(file), /from ['"]@react-navigation\//, `${file} should import navigation shims from expo-router`)
  }
})

test('SDK 56 native video config uses the Expo Video plugin', () => {
  const appConfig = readJson('packages/app/app.json')
  const plugins = appConfig.expo?.plugins || []
  const expoVideoPlugin = plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-video')

  assert.ok(expoVideoPlugin, 'expo-video should own native player background/PiP configuration on SDK 56')
  assert.equal(expoVideoPlugin[1]?.supportsBackgroundPlayback, true)
  assert.equal(expoVideoPlugin[1]?.supportsPictureInPicture, true)
})
