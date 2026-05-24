import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..', '..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath))
}

test('Expo UI dependency stays available for native mobile UI pilots', () => {
  const app = readJson('packages/app/package.json')
  assert.equal(app.dependencies['@expo/ui'], '56.0.13')
})

test('settings screen imports native Expo UI wrappers and native diagnostics panel', () => {
  const settingsSource = read('packages/app/app/(tabs)/settings.tsx')

  assert.match(settingsSource, /import DiagnosticsPanel from '@\/components\/native-diagnostics\/DiagnosticsPanel'/)
  assert.match(settingsSource, /import \{ NativeButton, NativeSwitch, NativeTextInput \} from '@\/components\/native-ui'/)
  assert.match(settingsSource, /<NativeSwitch\b/)
  assert.match(settingsSource, /<NativeTextInput\b/)
  assert.match(settingsSource, /<NativeButton\b/)
})

test('web desktop keeps its own diagnostics implementation without Expo UI imports', () => {
  const webDiagnostics = read('packages/app/components/native-diagnostics/DiagnosticsPanel.web.tsx')

  assert.doesNotMatch(webDiagnostics, /@expo\/ui/)
  assert.match(webDiagnostics, /from 'react-native'/)
})

test('native diagnostics use platform-specific Expo UI implementations', () => {
  const androidDiagnostics = read('packages/app/components/native-diagnostics/DiagnosticsPanel.android.tsx')
  const iosDiagnostics = read('packages/app/components/native-diagnostics/DiagnosticsPanel.ios.tsx')

  assert.match(androidDiagnostics, /from '@expo\/ui\/jetpack-compose'/)
  assert.match(iosDiagnostics, /from '@expo\/ui\/swift-ui'/)
})

test('Expo UI pilot stays out of player and shorts playback surfaces', () => {
  const forbiddenFiles = [
    'packages/app/components/video-player/PearInlineVideoView.tsx',
    'packages/app/components/video-player/P2PStatsBar.tsx',
    'packages/app/components/discovery/VerticalShortsPlayer.tsx',
    'packages/app/components/VideoPlayerOverlayImpl.tsx',
    'packages/app/app/video/[id].tsx',
  ]

  for (const file of forbiddenFiles) {
    assert.doesNotMatch(read(file), /@expo\/ui/, `${file} should not import Expo UI during the settings/forms pilot`)
  }
})
