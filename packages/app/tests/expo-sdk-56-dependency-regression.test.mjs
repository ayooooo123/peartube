import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..', '..')

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'))
}

test('app dependencies target Expo SDK 56', () => {
  const root = readJson('package.json')
  const app = readJson('packages/app/package.json')

  assert.equal(app.dependencies.expo, '~56.0.4')
  assert.equal(root.dependencies.expo, app.dependencies.expo)
  assert.equal(app.dependencies['react-native'], '0.85.3')
  assert.equal(root.dependencies['react-native'], '0.85.3')
  assert.equal(app.dependencies.react, '19.2.3')
  assert.equal(app.dependencies['react-dom'], '19.2.3')
  assert.equal(app.dependencies['expo-router'], '~56.2.6')
  assert.match(app.dependencies['expo-build-properties'], /^~56\./)
  assert.match(app.dependencies['expo-splash-screen'], /^~56\./)
  assert.equal(app.dependencies['react-native-screens'], '4.25.2')
})

test('SDK 56 splash config uses expo-splash-screen plugin instead of legacy top-level splash', () => {
  const app = readJson('packages/app/app.json')
  const expo = app.expo || {}
  const plugins = expo.plugins || []
  const splashPlugin = plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen')

  assert.equal(expo.splash, undefined, 'legacy top-level expo.splash should be removed for SDK 56')
  assert.ok(splashPlugin, 'expo-splash-screen plugin should own native splash config')
  assert.deepEqual(splashPlugin[1], {
    image: './assets/images/splash.png',
    resizeMode: 'contain',
    backgroundColor: '#0e0e10'
  })
})
