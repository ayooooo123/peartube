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

test('react-native-video patch script guards Android seek callbacks against released players', () => {
  const source = readAppFile('scripts/patch-react-native-video-pip.js')

  assert.match(
    source,
    /isPaused && isSeeking && !buffering && player != null/,
    'the patch script should require a live player before onBuffering emits seek completion',
  )

  assert.match(
    source,
    /isPlaying && isSeeking && player != null/,
    'the patch script should require a live player before onIsPlayingChanged emits seek completion',
  )

  assert.match(
    source,
    /if \(player == null\) \{[\s\S]*resumeWindow = C\.INDEX_UNSET;[\s\S]*resumePosition = C\.TIME_UNSET;[\s\S]*return;/,
    'the patch script should make updateResumePosition a no-op after player teardown',
  )
})

test('react-native-video patch script detaches the ExoPlayer listener before release', () => {
  const source = readAppFile('scripts/patch-react-native-video-pip.js')

  assert.match(
    source,
    /updateResumePosition\(\);[\s\S]*player\.removeListener\(this\);[\s\S]*player\.release\(\);/,
    'releasePlayer should remove listener callbacks before releasing the native player',
  )
})

test('PearInlineVideoView adapter catches async seek failures from react-native-video', () => {
  const source = readAppFile('components/video-player/PearInlineVideoView.tsx')

  assert.match(
    source,
    /const safeSeek = useCallback\(\(timeSeconds: number\) => \{[\s\S]*Promise\.resolve\(videoRef\.current\?\.seek\(clamped\)\)[\s\S]*\.catch\(/,
    'seek calls should consume async bridge failures instead of leaking unhandled rejections',
  )

  assert.match(
    source,
    /stop: async \(\) => \{[\s\S]*safeSeek\(0\)/,
    'stop should reuse the hardened seek helper',
  )

  assert.match(
    source,
    /destroy: async \(\) => \{[\s\S]*safeSeek\(0\)/,
    'destroy should reuse the hardened seek helper',
  )

  assert.match(
    source,
    /seek: async \(timeSeconds: number\) => \{[\s\S]*safeSeek\(timeSeconds\)/,
    'adapter seek should route through the hardened helper',
  )
})

test('PearInlineVideoView does not opt Android inline playback into notification media-session controls', () => {
  const source = readAppFile('components/video-player/PearInlineVideoView.tsx')

  assert.match(
    source,
    /showNotificationControls=\{Platform\.OS !== 'android'\}/,
    'Android inline playback should not enable react-native-video notification controls, which trigger the foreground-service seek crash path',
  )

  assert.match(
    source,
    /playInBackground=\{true\}/,
    'background playback support should remain enabled',
  )

  assert.match(
    source,
    /enterPictureInPictureOnLeave=\{true\}/,
    'PiP support should remain enabled independently of notification controls',
  )
})

test('react-native-video patch script avoids foreground-service starts for null or non-command intents', () => {
  const source = readAppFile('scripts/patch-react-native-video-pip.js')

  assert.match(
    source,
    /if \(intent == null\) \{[\s\S]*return START_NOT_STICKY[\s\S]*\}/,
    'the service should bail out when Android restarts it with a null intent',
  )

  assert.match(
    source,
    /val actionCommand = intent.getStringExtra\("ACTION"\)[\s\S]*if \(actionCommand == null\) \{[\s\S]*return START_NOT_STICKY/,
    'the service should not try to foreground itself for non-command intents',
  )

  assert.match(
    source,
    /startForeground\(PLACEHOLDER_NOTIFICATION_ID, createPlaceholderNotification\(\)\)/,
    'explicit media command intents should still be allowed to foreground the service',
  )
})

test('react-native-video patch script guards Android 13+ playback service registration and startup', () => {
  const source = readAppFile('scripts/patch-react-native-video-pip.js')

  assert.match(
    source,
    /themedReactContext\.startForegroundService\(intent\)[\s\S]*catch \(RuntimeException e\)[\s\S]*ForegroundServiceStartNotAllowedException/,
    'setupPlaybackService should catch Android foreground-service start denials',
  )

  assert.match(
    source,
    /fun registerPlayer\(player: ExoPlayer, from: Class<Activity>\) \{[\s\S]*try \{[\s\S]*startForeground\(notificationId, buildNotification\(mediaSession\)\)[\s\S]*catch \(e: ForegroundServiceStartNotAllowedException\)/,
    'registerPlayer should catch Android 13+ foreground promotion failures',
  )

  assert.match(
    source,
    /if \(Build.VERSION.SDK_INT >= Build.VERSION_CODES.O\) \{[\s\S]*try \{[\s\S]*startForeground\(PLACEHOLDER_NOTIFICATION_ID, createPlaceholderNotification\(\)\)[\s\S]*catch \(e: ForegroundServiceStartNotAllowedException\)/,
    'onStartCommand should also catch foreground promotion failures for explicit media commands',
  )
})
