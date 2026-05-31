import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const overlayPath = new URL('../components/VideoPlayerOverlayImpl.tsx', import.meta.url)
const contextPath = new URL('../lib/VideoPlayerContext.tsx', import.meta.url)

async function source(url) {
  return readFile(url, 'utf8')
}

test('watch-page play button keeps desired playback true after Android opens initially paused', async () => {
  const src = await source(overlayPath)
  const handlerStart = src.indexOf('const handlePlayPause = useCallback')
  assert.notEqual(handlerStart, -1, 'expected handlePlayPause callback')
  const handler = src.slice(handlerStart, src.indexOf('const handleDesktopSeekStart', handlerStart))

  assert.match(handler, /if \(isStartingPlayback\) \{\s*resumeVideo\(\)/, 'startup state should reassert resume instead of pausing')
  assert.match(handler, /else if \(isPlaying\) \{\s*pauseVideo\(\)/, 'native playing state should still pause on deliberate tap after startup')
  assert.ok(handler.indexOf('if (isStartingPlayback)') < handler.indexOf('else if (isPlaying)'), 'startup guard must run before normal isPlaying pause branch')
})

test('VideoPlayerContext exposes desired startup state separately from native playing state', async () => {
  const src = await source(contextPath)

  assert.match(src, /const isStartingPlayback = Boolean\(currentVideo && isLoading && isPlaying\)/, 'context should expose startup intent while native playback is still loading')
  assert.match(src, /isStartingPlayback,/, 'session value should include isStartingPlayback for Android controls')
})
