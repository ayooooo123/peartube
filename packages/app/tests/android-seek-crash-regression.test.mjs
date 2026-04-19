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
