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

test('VideoPlayerContext treats seek-time native pauses as buffering, not user pauses', () => {
  const source = readAppFile('lib/VideoPlayerContext.tsx')
  const pausedStart = source.indexOf('const onPaused = useCallback')
  assert.notEqual(pausedStart, -1, 'expected onPaused callback')
  const pausedHandler = source.slice(pausedStart, source.indexOf('const onBuffering', pausedStart))

  assert.match(
    pausedHandler,
    /seekConfirmRef\.current[\s\S]*isPlayingRef\.current[\s\S]*getPlayerPort\(\)\?\.play\?\.\(\)[\s\S]*return/,
    'seek-induced pause events should be ignored and playback reasserted before JS flips isPlaying=false',
  )
})

test('PearInlineVideoView reasserts desired playback after seek buffering resolves', () => {
  const source = readAppFile('components/video-player/PearInlineVideoView.tsx')
  const adapterStart = source.indexOf('const adapter = useMemo')
  assert.notEqual(adapterStart, -1, 'expected PlayerPort adapter')
  const adapterBlock = source.slice(adapterStart, source.indexOf('useEffect(() => {\n    player.playbackRate', adapterStart))
  const statusStart = source.indexOf("useEventListener(player, 'statusChange'")
  assert.notEqual(statusStart, -1, 'expected statusChange listener')
  const statusBlock = source.slice(statusStart, source.indexOf("useEventListener(player, 'playToEnd'", statusStart))

  assert.match(
    source,
    /const SEEK_PLAYBACK_RECOVERY_MS = \d+/,
    'native player should have a bounded seek recovery window',
  )
  assert.match(
    adapterBlock,
    /seekPlaybackRecoveryUntilRef\.current = Date\.now\(\) \+ SEEK_PLAYBACK_RECOVERY_MS[\s\S]*player\.currentTime = Math\.max\(0, timeSeconds\)/,
    'imperative seeks should mark a recovery window before moving the native currentTime',
  )
  assert.match(
    statusBlock,
    /status === 'readyToPlay'[\s\S]*Date\.now\(\) <= seekPlaybackRecoveryUntilRef\.current[\s\S]*isPlayingRef\.current[\s\S]*player\.play\(\)/,
    'readyToPlay after a seek should reassert the desired playing state',
  )
})
