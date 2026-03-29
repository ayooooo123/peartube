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

test('native mobile inline player is backed by react-native-video', () => {
  const source = readAppFile('components/video-player/PearInlineVideoView.tsx')

  assert.match(source, /react-native-video/)
  assert.match(source, /<Video/)
  assert.equal(
    source.includes("./MpvVideoView"),
    false,
    'native mobile inline player should not keep using the mpv-backed host view',
  )
  assert.equal(
    source.includes('expo-pear-player'),
    false,
    'Android inline playback should not depend on the temporary pear-player host anymore',
  )
})

test('Android minimize returns to the in-app mini player when split-player mode is disabled', () => {
  const source = readAppFile('lib/VideoPlayerContext.tsx')
  const minimizeBody =
    source.match(/const minimizePlayer = useCallback\(\(_optionsOrEvent\?: unknown\) => \{([\s\S]*?)\n  }, \[/)?.[1] ?? ''

  assert.ok(minimizeBody, 'minimizePlayer callback should exist')
  assert.match(
    minimizeBody,
    /if \(ENABLE_ANDROID_SPLIT_PLAYER_ACTIVITY\) \{[\s\S]*MediaSession\.openPlayerActivity\(\{/,
  )
  assert.match(
    minimizeBody,
    /dispatch\(\{\s*type: 'MINIMIZE',[\s\S]*platform: Platform\.OS === 'web' \? 'web' : Platform\.OS === 'android' \? 'android' : 'ios'/,
    'when split mode is disabled, Android minimize should dispatch the normal mini-player transition instead of entering PiP directly',
  )
  assert.doesNotMatch(
    minimizeBody,
    /pendingAndroidMinimizeCloseRef\.current = false\s*MediaSession\.enterPictureInPicture\(\)\.catch/,
    'single-host Android minimize should no longer force PiP when split-player mode is disabled',
  )
})

test('Android split-player mode stays disabled in JS state management', () => {
  const contextSource = readAppFile('lib/VideoPlayerContext.tsx')
  const reducerSource = readAppFile('lib/playerStateMachine.ts')

  assert.match(contextSource, /const ENABLE_ANDROID_SPLIT_PLAYER_ACTIVITY = false/)
  assert.match(reducerSource, /const ENABLE_ANDROID_SPLIT_PLAYER_ACTIVITY = false/)
})

test('expo-media-session keeps PlayerActivity helpers as no-op compatibility shims', () => {
  const source = readAppFile('modules/expo-media-session/src/index.ts')

  assert.match(source, /openPlayerActivity\(_payload\?: any\): Promise<boolean> \{ return false }/)
  assert.match(source, /primePlayerActivityPayload\(_payload\?: any\): Promise<void> \{\}/)
  assert.match(source, /launchPrimedPipPlayerActivity\(\): Promise<boolean> \{ return false }/)
  assert.match(source, /isInPlayerActivity\(\): Promise<boolean> \{ return false }/)
})

test('Android PiP bridge targets MainActivity when react-native-video owns playback', () => {
  const source = readAppFile(
    'modules/expo-media-session/android/src/main/java/to/holepunch/modules/mediasession/MediaSessionModule.kt',
  )

  assert.match(source, /With react-native-video, PiP runs in the main activity \(no PlayerActivity handoff\)\./)
  assert.match(source, /return className == "\$\{activity\.packageName}\.MainActivity"/)
})

test('Android single-host playback no longer depends on expo-pear-player', () => {
  const packageSource = readAppFile('package.json')
  const mediaSessionBuildGradle = readAppFile('modules/expo-media-session/android/build.gradle')

  assert.doesNotMatch(packageSource, /"expo-pear-player"/)
  assert.doesNotMatch(mediaSessionBuildGradle, /project\(':expo-pear-player'\)/)
})
