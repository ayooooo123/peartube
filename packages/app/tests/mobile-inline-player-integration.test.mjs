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

test('Android minimize restores the in-app mini player path', () => {
  const source = readAppFile('lib/VideoPlayerContext.tsx')
  const minimizeBody =
    source.match(/const minimizePlayer = useCallback\(\(_optionsOrEvent\?: unknown\) => \{([\s\S]*?)\n  }, \[/)?.[1] ?? ''

  assert.ok(minimizeBody, 'minimizePlayer callback should exist')
  assert.match(minimizeBody, /dispatch\(\{[\s\S]*type: 'MINIMIZE'/)
  assert.doesNotMatch(minimizeBody, /MediaSession\.openPlayerActivity\(/)
})

test('Android split-player mode is disabled in JS state management', () => {
  const videoPlayerContext = readAppFile('lib/VideoPlayerContext.tsx')
  const playerStateMachine = readAppFile('lib/playerStateMachine.ts')

  assert.match(videoPlayerContext, /const ENABLE_ANDROID_SPLIT_PLAYER_ACTIVITY = false/)
  assert.match(playerStateMachine, /const ENABLE_ANDROID_SPLIT_PLAYER_ACTIVITY = false/)
})


test('VideoPlayerContext avoids split-player launch listeners but keeps PlayerActivity payloads primed for PiP handoff', () => {
  const contextSource = readAppFile('lib/VideoPlayerContext.tsx')

  assert.doesNotMatch(contextSource, /addPlayerLaunchPayloadListener/)
  assert.doesNotMatch(contextSource, /consumePendingPlayerLaunchPayload/)
  assert.match(contextSource, /MediaSession\.primePlayerActivityPayload\(/)
})

test('expo-media-session keeps the PlayerActivity helpers wired to the native module', () => {
  const source = readAppFile('modules/expo-media-session/src/index.ts')

  assert.match(source, /if \(!native\.openPlayerActivity\) return false/)
  assert.match(source, /return native\.openPlayerActivity\(payload \?\? null\)/)
  assert.match(source, /primePlayerActivityPayload\(payload\?: any\): Promise<void>/)
  assert.match(source, /launchPrimedPipPlayerActivity\(\): Promise<boolean> \{ return false }/)
  assert.match(source, /if \(!native\.isInPlayerActivity\) return false/)
})

test('Android PlayerActivity is a native Media3 host instead of a ReactActivity shell', () => {
  const source = readAppFile('android/app/src/main/java/com/peartube/app/PlayerActivity.kt')

  assert.match(source, /class PlayerActivity : AppCompatActivity\(\)/)
  assert.match(source, /PlayerView/)
  assert.match(source, /ExoPlayer/)
  assert.doesNotMatch(source, /ReactActivity/)
  assert.match(source, /requestPipOnLaunch/)
  assert.match(source, /PipBridge\.enterPictureInPictureDirect/)
})

test('Android PlayerActivity plugin sources the native host template for prebuilds', () => {
  const pluginSource = readAppFile('plugins/withAndroidPiP.js')
  const templateSource = readAppFile('plugins/templates/PlayerActivity.kt.template')

  assert.match(pluginSource, /PlayerActivity\.kt\.template/)
  assert.match(templateSource, /class PlayerActivity : AppCompatActivity\(\)/)
  assert.match(templateSource, /PlayerView/)
  assert.match(templateSource, /ExoPlayer/)
  assert.doesNotMatch(templateSource, /ReactActivity/)
})

test('MainActivity PiP callbacks route directly into the native PiP bridge', () => {
  const activitySource = readAppFile('android/app/src/main/java/com/peartube/app/MainActivity.kt')
  const pluginSource = readAppFile('plugins/withMainActivityPiPCallback.js')

  assert.match(activitySource, /PipBridge\.onUserLeaveHint\(this\)/)
  assert.doesNotMatch(activitySource, /delegateMainActivityLeaveHintToPlayer/)
  assert.match(activitySource, /PipBridge\.notifyPipBoundsChanged\(this, newConfig\)/)
  assert.match(activitySource, /PipBridge\.notifyPipUiStateChanged\(this, pipState\)/)
  assert.match(pluginSource, /PipBridge\.onUserLeaveHint\(this\)/)
})

test('Android PiP host checks are aligned to the MainActivity single-host flow', () => {
  const source = readAppFile(
    'modules/expo-media-session/android/src/main/java/to/holepunch/modules/mediasession/MediaSessionModule.kt',
  )
  const bridgeSource = readAppFile(
    'modules/expo-media-session/android/src/main/java/to/holepunch/modules/mediasession/PlayerHostBridge.kt',
  )

  assert.match(bridgeSource, /interface NativePlaybackController/)
  assert.match(bridgeSource, /fun dispatchPlay\(\): Boolean/)
  assert.match(bridgeSource, /fun dispatchPause\(\): Boolean/)
  assert.match(bridgeSource, /fun dispatchSeekBy\(deltaMs: Long\): Boolean/)
  assert.match(source, /PlaybackHostBridge\.dispatchPlay\(\)/)
  assert.match(source, /PlaybackHostBridge\.dispatchPause\(\)/)
  assert.match(source, /PlaybackHostBridge\.dispatchStop\(/)
  assert.match(source, /PlaybackHostBridge\.dispatchSeekTo\(pos\)/)
  assert.match(source, /PlaybackHostBridge\.dispatchSeekBy\(10000\)/)
  assert.match(source, /fun isPipHostActivity\(activity: Activity\): Boolean \{[\s\S]*className == "\$\{activity\.packageName}\.MainActivity"/)
  assert.doesNotMatch(source, /className == "\$\{activity\.packageName}\.PlayerActivity"/)
  assert.match(source, /if \(!PipBridge\.isPipHostActivity\(activity\)\) \{[\s\S]*skip non-PiP host/)
})

test('Android single-host playback no longer depends on expo-pear-player', () => {
  const packageSource = readAppFile('package.json')
  const mediaSessionBuildGradle = readAppFile('modules/expo-media-session/android/build.gradle')

  assert.doesNotMatch(packageSource, /"expo-pear-player"/)
  assert.doesNotMatch(mediaSessionBuildGradle, /project\(':expo-pear-player'\)/)
})

test('stale split-player experiment directories are absent from the app package', () => {
  const pearPlayerModuleRoot = path.join(appRoot, 'modules/expo-pear-player')
  const androidPlaybackRoot = path.join(appRoot, 'lib/android-playback')

  assert.equal(fs.existsSync(pearPlayerModuleRoot), false)
  assert.equal(fs.existsSync(androidPlaybackRoot), false)
})

test('Expo Android plugins keep MainActivity as the PiP host and preserve ExoPlayer resources', () => {
  const appConfig = readAppFile('app.json')
  const pipPlugin = readAppFile('plugins/withAndroidPiP.js')
  const keepPlugin = readAppFile('plugins/withExoplayerKeepResources.js')
  const keepXmlPath = path.join(appRoot, 'android/app/src/main/res/raw/keep.xml')

  assert.match(appConfig, /withExoplayerKeepResources\.js/)
  assert.match(pipPlugin, /PlayerActivity/)
  assert.match(pipPlugin, /mainActivity\.\$\['android:supportsPictureInPicture'\] = 'true'/)
  assert.match(pipPlugin, /mainActivity\.\$\['android:resizeableActivity'\] = 'true'/)
  assert.match(appConfig, /withMainActivityPiPCallback\.js/)
  assert.match(keepPlugin, /keep\.xml/)
  assert.equal(fs.existsSync(keepXmlPath), true)
})

test('Android app declares explicit Media3 dependencies for the native PlayerActivity host', () => {
  const buildGradle = readAppFile('android/app/build.gradle')

  assert.match(buildGradle, /implementation\("androidx\.media3:media3-exoplayer:1\.8\.0"\)/)
  assert.match(buildGradle, /implementation\("androidx\.media3:media3-ui:1\.8\.0"\)/)
})

test('Android manifest keeps MainActivity as the PiP-capable native host', () => {
  const manifestSource = readAppFile('android/app/src/main/AndroidManifest.xml')

  assert.match(manifestSource, /android:name="\.MainActivity"[^>]*android:supportsPictureInPicture="true"/)
  assert.match(manifestSource, /android:name="\.MainActivity"[^>]*android:resizeableActivity="true"/)
  assert.doesNotMatch(manifestSource, /android:name="\.PlayerActivity"[^>]*android:supportsPictureInPicture="true"/)
})
