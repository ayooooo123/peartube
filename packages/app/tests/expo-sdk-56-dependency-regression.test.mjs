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

  assert.match(app.dependencies.expo, /^~56\./)
  assert.equal(root.dependencies.expo, app.dependencies.expo)
  assert.equal(app.dependencies['react-native'], '0.85.3')
  assert.equal(root.dependencies['react-native'], '0.85.3')
  assert.equal(app.dependencies.react, '19.2.3')
  assert.equal(app.dependencies['react-dom'], '19.2.3')
  assert.match(app.dependencies['expo-router'], /^~56\./)
  assert.equal(app.dependencies['expo-router'], '~56.2.5')
  assert.match(app.dependencies['expo-build-properties'], /^~56\./)
})
