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

test('PearInlineVideoView uses Expo Video as the native inline renderer', () => {
  const source = readAppFile('components/video-player/PearInlineVideoView.tsx')

  assert.match(source, /from 'expo-video'/)
  assert.match(source, /<VideoView/)
  assert.match(source, /useVideoPlayer\(/)
  assert.match(source, /allowsPictureInPicture=\{autoEnterPipOnLeave\}/)
  assert.match(source, /startsPictureInPictureAutomatically=\{autoEnterPipOnLeave\}/)
  assert.match(source, /surfaceType="surfaceView"/)
  assert.match(source, /player\.showNowPlayingNotification = showNotificationControls/)
  assert.match(source, /player\.staysActiveInBackground = showNotificationControls/)
  assert.doesNotMatch(source, /from 'react-native-video'/)
  assert.doesNotMatch(source, /<Video\b/)
  assert.doesNotMatch(source, /expo-pear-player/)
  assert.doesNotMatch(source, /createPearPlayer/)
  assert.doesNotMatch(source, /<PearPlayerView/)
})

test('PearInlineVideoView adapter controls the shared Expo Video player directly', () => {
  const source = readAppFile('components/video-player/PearInlineVideoView.tsx')

  assert.match(source, /play:\s*async \(\)\s*=> \{\s*player\.play\(\)\s*}/)
  assert.match(source, /pause:\s*async \(\)\s*=> \{\s*player\.pause\(\)\s*}/)
  const stopBody = source.match(/stop:\s*async \(\)\s*=> \{([\s\S]*?)\n\s*},/)?.[1] ?? ''
  const destroyBody = source.match(/destroy:\s*async \(\)\s*=> \{([\s\S]*?)\n\s*},/)?.[1] ?? ''
  assert.match(stopBody, /player\.pause\(\)/)
  assert.match(destroyBody, /player\.pause\(\)/)
  assert.doesNotMatch(stopBody, /currentTime = 0|seek\(0\)/, 'rapid Android open/close teardown should not seek the player before unmount')
  assert.doesNotMatch(destroyBody, /currentTime = 0|seek\(0\)/, 'destroy should avoid a redundant seek when native resources are being torn down')
  assert.match(source, /seek:\s*async \(timeSeconds: number\) => \{[\s\S]*player\.currentTime = Math\.max\(0, timeSeconds\)/)
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

test('PearInlineVideoView uses Expo Video on native SDK 56 to avoid react-native-video Android mount crash', () => {
  const source = readAppFile('components/video-player/PearInlineVideoView.tsx')

  assert.match(source, /from 'expo-video'/)
  assert.match(source, /<VideoView/)
  assert.match(source, /useVideoPlayer\(/)
  assert.match(source, /surfaceType="surfaceView"/)
  assert.doesNotMatch(source, /from 'react-native-video'/)
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
