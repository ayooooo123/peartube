import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..', '..')
const appRoot = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath))
}

const SOURCE_DIRS = ['app', 'components', 'lib', 'hooks']
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs'])

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      yield* walk(fullPath)
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      yield fullPath
    }
  }
}

// @expo/ui pulled the entire Jetpack Compose runtime into the Android APK for
// three trivial widgets, so the pilot was rolled back in favor of plain RN
// components (components/native-ui.tsx).
test('@expo/ui stays removed from the app dependencies', () => {
  const app = readJson('packages/app/package.json')

  assert.equal(app.dependencies['@expo/ui'], undefined)
  assert.equal(app.devDependencies?.['@expo/ui'], undefined)
})

test('no app source imports @expo/ui', () => {
  const violations = []

  for (const dir of SOURCE_DIRS) {
    const root = path.join(appRoot, dir)
    if (!fs.existsSync(root)) continue
    for (const file of walk(root)) {
      const source = fs.readFileSync(file, 'utf8')
      if (/from ['"]@expo\/ui|require\(['"]@expo\/ui/.test(source)) {
        violations.push(path.relative(appRoot, file))
      }
    }
  }

  assert.deepEqual(violations, [], `files importing @expo/ui: ${violations.join(', ')}`)
})

test('native-ui widgets are plain React Native components', () => {
  const source = read('packages/app/components/native-ui.tsx')

  assert.match(source, /from 'react-native'/)
  assert.match(source, /export function NativeButton/)
  assert.match(source, /export function NativeSwitch/)
  assert.match(source, /export function NativeTextInput/)
})

test('diagnostics panel is shared across native platforms without Expo UI', () => {
  const nativeDiagnostics = read('packages/app/components/native-diagnostics/DiagnosticsPanel.native.tsx')
  const webDiagnostics = read('packages/app/components/native-diagnostics/DiagnosticsPanel.web.tsx')

  assert.doesNotMatch(nativeDiagnostics, /@expo\/ui/)
  assert.match(nativeDiagnostics, /from 'react-native'/)
  assert.doesNotMatch(webDiagnostics, /@expo\/ui/)
  assert.match(webDiagnostics, /from 'react-native'/)
  assert.equal(
    fs.existsSync(path.join(appRoot, 'components/native-diagnostics/DiagnosticsPanel.ios.tsx')),
    false,
    'the SwiftUI diagnostics panel should stay deleted',
  )
})
