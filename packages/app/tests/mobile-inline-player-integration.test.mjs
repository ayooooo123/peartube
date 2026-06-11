import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')
const require = createRequire(import.meta.url)
const { _normalizePipActivities } = require(path.join(appRoot, 'plugins/withAndroidPiP.js'))

function readAppFile(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

test('native mobile inline player is backed by Expo Video', () => {
  const source = readAppFile('components/video-player/PearInlineVideoView.tsx')

  assert.match(source, /from 'expo-video'/)
  assert.match(source, /<VideoView/)
  assert.doesNotMatch(source, /react-native-video/)
  assert.equal(
    source.includes('./MpvVideoView'),
    false,
    'native mobile inline player should not keep using the mpv-backed host view',
  )
  assert.equal(
    source.includes('expo-pear-player'),
    false,
    'Android inline playback should not depend on the temporary pear-player host anymore',
  )
})

test('react-native-video stays removed from the app package', () => {
  const packageJson = readAppFile('package.json')
  const appConfig = readAppFile('app.json')

  assert.doesNotMatch(packageJson, /"react-native-video"/)
  assert.doesNotMatch(packageJson, /patch-react-native-video-pip/)
  assert.doesNotMatch(appConfig, /react-native-video/)
  assert.equal(
    fs.existsSync(path.join(appRoot, 'scripts/patch-react-native-video-pip.js')),
    false,
    'the react-native-video PiP patch script should stay deleted',
  )
})

test('Android minimize restores the in-app mini player path', () => {
  const source = readAppFile('lib/VideoPlayerContext.tsx')
  const minimizeBody =
    source.match(/const minimizePlayer = useCallback\(\(_optionsOrEvent\?: unknown\) => \{([\s\S]*?)\n {2}}, \[/)?.[1] ?? ''

  assert.ok(minimizeBody, 'minimizePlayer callback should exist')
  assert.match(minimizeBody, /dispatch\(\{[\s\S]*type: 'MINIMIZE'/)
  assert.doesNotMatch(minimizeBody, /MediaSession\.openPlayerActivity\(/)
})

test('Android split-player mode stays removed from JS state management', () => {
  const videoPlayerContext = readAppFile('lib/VideoPlayerContext.tsx')
  const playerStateMachine = readAppFile('lib/playerStateMachine.ts')

  assert.doesNotMatch(videoPlayerContext, /ENABLE_ANDROID_SPLIT_PLAYER_ACTIVITY/)
  assert.doesNotMatch(playerStateMachine, /ENABLE_ANDROID_SPLIT_PLAYER_ACTIVITY/)
})

test('Android single-host playback no longer depends on expo-pear-player', () => {
  const packageSource = readAppFile('package.json')

  assert.doesNotMatch(packageSource, /"expo-pear-player"/)
})

test('stale split-player experiment directories are absent from the app package', () => {
  const pearPlayerModuleRoot = path.join(appRoot, 'modules/expo-pear-player')
  const androidPlaybackRoot = path.join(appRoot, 'lib/android-playback')

  assert.equal(fs.existsSync(pearPlayerModuleRoot), false)
  assert.equal(fs.existsSync(androidPlaybackRoot), false)
})

test('Android inline player suppresses stuck-playback reloads during PiP/background handoff', () => {
  const source = readAppFile('components/video-player/PearInlineVideoView.tsx')

  assert.match(source, /AppState\.addEventListener\('change'/)
  assert.match(source, /const shouldSuppressStuckPlaybackRecovery = useCallback\(\(\) => \{/)
  assert.match(source, /if \(isInPipMode\) return true/)
  assert.match(source, /if \(appStateRef\.current !== 'active'\) return true/)
  assert.match(source, /const suppressStuckRecovery = shouldSuppressStuckPlaybackRecovery\(\)/)
  assert.match(source, /suppressStuckRecovery && playbackStartedAtRef\.current !== null/)
})

test('Android PiP manifest plugin strips stale PlayerActivity PiP attrs during prebuild', () => {
  const application = {
    activity: [
      {
        $: {
          'android:name': '.MainActivity',
          'android:configChanges': 'keyboard|uiMode',
        },
      },
      {
        $: {
          'android:name': '.PlayerActivity',
          'android:configChanges': 'keyboard|keyboardHidden|orientation',
          'android:theme': '@style/PlayerActivityTheme',
          'android:supportsPictureInPicture': 'true',
          'android:resizeableActivity': 'true',
        },
      },
    ],
  }

  const { mainActivity, playerActivity } = _normalizePipActivities(application)

  assert.equal(mainActivity?.$['android:supportsPictureInPicture'], 'true')
  assert.equal(mainActivity?.$['android:resizeableActivity'], 'true')
  assert.match(mainActivity?.$['android:configChanges'] ?? '', /screenSize/)
  assert.match(mainActivity?.$['android:configChanges'] ?? '', /smallestScreenSize/)
  assert.match(mainActivity?.$['android:configChanges'] ?? '', /screenLayout/)
  assert.equal(playerActivity?.$['android:supportsPictureInPicture'], undefined)
  assert.equal(playerActivity?.$['android:resizeableActivity'], undefined)
  assert.equal(playerActivity?.$['android:theme'], '@style/PlayerActivityTheme')
})

test('Expo Android plugins keep MainActivity as the PiP host and preserve ExoPlayer resources', () => {
  const appConfig = readAppFile('app.json')
  const pipPlugin = readAppFile('plugins/withAndroidPiP.js')
  const keepPlugin = readAppFile('plugins/withExoplayerKeepResources.js')
  const keepXmlPath = path.join(appRoot, 'android/app/src/main/res/raw/keep.xml')

  assert.match(appConfig, /withExoplayerKeepResources\.js/)
  assert.match(pipPlugin, /mainActivity\.\$\['android:supportsPictureInPicture'\] = 'true'/)
  assert.match(pipPlugin, /mainActivity\.\$\['android:resizeableActivity'\] = 'true'/)
  assert.match(keepPlugin, /keep\.xml/)
  assert.equal(fs.existsSync(keepXmlPath), true)
})

test('Android app declares explicit Media3 dependencies for native playback', () => {
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
