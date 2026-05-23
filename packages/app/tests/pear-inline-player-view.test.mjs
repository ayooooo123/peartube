import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

function readAppFile(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

test('PearInlineVideoView uses react-native-video as the native inline renderer', () => {
  const source = readAppFile('components/video-player/PearInlineVideoView.tsx')

  assert.match(source, /react-native-video/)
  assert.match(source, /<Video/)
  assert.match(source, /autoEnterPipOnLeave = true/)
  assert.match(source, /showNotificationControls = autoEnterPipOnLeave/)
  assert.match(source, /enterPictureInPictureOnLeave=\{autoEnterPipOnLeave\}/)
  assert.match(source, /showNotificationControls=\{showNotificationControls\}/)
  assert.match(source, /playInBackground=\{showNotificationControls\}/)
  assert.match(source, /playWhenInactive=\{showNotificationControls\}/)
  assert.match(source, /useTextureView=\{false\}/)
  assert.match(source, /bufferConfig=\{Platform\.OS === 'android' \? ANDROID_BUFFER_CONFIG : undefined\}/)
  assert.doesNotMatch(source, /expo-pear-player/)
  assert.doesNotMatch(source, /createPearPlayer/)
  assert.doesNotMatch(source, /<PearPlayerView/)
})

test('PearInlineVideoView adapter controls the shared VideoRef directly', () => {
  const source = readAppFile('components/video-player/PearInlineVideoView.tsx')

  assert.match(source, /play:\s*async \(\)\s*=> \{\s*videoRef\.current\?\.resume\?\.\(\)\s*}/)
  assert.match(source, /pause:\s*async \(\)\s*=> \{\s*videoRef\.current\?\.pause\?\.\(\)\s*}/)
  assert.match(
    source,
    /stop:\s*async \(\)\s*=> \{[\s\S]*videoRef\.current\?\.pause\?\.\(\)[\s\S]*videoRef\.current\?\.seek\(0\)/,
  )
  assert.match(source, /seek:\s*async \(timeSeconds: number\) => \{[\s\S]*videoRef\.current\?\.seek\(/)
  assert.doesNotMatch(source, /controller\./)
})

test('PearInlineVideoView declares the adapter before AppState effects use it', () => {
  const source = readAppFile('components/video-player/PearInlineVideoView.tsx')
  const adapterDeclarationIndex = source.indexOf('const adapter = useMemo')
  const appStateEffectIndex = source.indexOf("AppState.addEventListener('change'")

  assert.notEqual(adapterDeclarationIndex, -1, 'adapter useMemo should exist')
  assert.notEqual(appStateEffectIndex, -1, 'Android AppState effect should exist')
  assert.ok(
    adapterDeclarationIndex < appStateEffectIndex,
    'adapter must be initialized before AppState effect closes over it; otherwise playback mount can crash from TDZ access',
  )
})

test('legacy MpvMobileVideoView implementation stays removed or only exists as a shim', () => {
  const shimPath = path.join(appRoot, 'components/video-player/MpvMobileVideoView.tsx')
  if (!fs.existsSync(shimPath)) {
    assert.equal(fs.existsSync(shimPath), false)
    return
  }

  const source = readAppFile('components/video-player/MpvMobileVideoView.tsx')
  assert.match(source, /PearInlineVideoView as MpvMobileVideoView/)
  assert.equal(
    source.includes('expo-pear-player'),
    false,
    'legacy compatibility file should not own playback logic anymore',
  )
})

test('video-player index exports PearInlineVideoView without hiding it behind mpv naming', () => {
  const source = readAppFile('components/video-player/index.ts')

  assert.match(source, /PearInlineVideoView/)
  assert.match(source, /getPearInlinePlayerId/)
})

test('VideoContainer uses PearInlineVideoView directly and the dead native MpvVideoView file stays removed', () => {
  const source = readAppFile('components/video-player/VideoContainer.tsx')
  const deadHostPath = path.join(appRoot, 'components/video-player/MpvVideoView.tsx')

  assert.match(source, /PearInlineVideoView/)
  assert.doesNotMatch(source, /MpvMobileVideoView/)
  assert.equal(fs.existsSync(deadHostPath), false)
})
