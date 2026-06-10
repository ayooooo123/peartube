import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

test('mobile watch page keeps live context stats ahead of stale polled stats', () => {
  const source = read('app/video/[id].tsx')

  assert.match(
    source,
    /const displayedStats = videoStats \|\| localStats/,
    'event-driven VideoPlayerContext stats should win over older local polling snapshots',
  )
  assert.match(
    source,
    /<P2PStatsOverlay[\s\S]*stats=\{displayedStats\}/,
    'inline overlay should use the same fresh stats source',
  )
  assert.match(
    source,
    /<P2PStatsBar stats=\{displayedStats\}/,
    'detail stats bar should use the same fresh stats source',
  )
})

test('mobile watch page reattaches stats when returning to an already playing video', () => {
  const source = read('app/video/[id].tsx')

  assert.match(
    source,
    /if \(isSameVideoAsCurrent && videoUrl && \(Platform\.OS !== 'web' \|\| isPear\)\) \{[\s\S]*setIsLoading\(false\)[\s\S]*startStatsPolling\(\)/,
    'returning to the active video should poll stats instead of replaying preparePlayback and showing the loading gate',
  )
  assert.doesNotMatch(
    source,
    /fromMiniPlayer && isSameVideoAsCurrent/,
    'same-video lifecycle handling must not depend only on fromMiniPlayer route params',
  )
})

test('mobile watch page clears stale local stats only when starting a different load', () => {
  const source = read('app/video/[id].tsx')
  const loadStart = source.indexOf('const loadVideo = useCallback(async () =>')
  assert.notEqual(loadStart, -1, 'expected loadVideo callback')
  const loadBlock = source.slice(loadStart, source.indexOf('  // Load video when videoData is available', loadStart))

  assert.match(
    loadBlock,
    /clearStatsPolling\(\)[\s\S]*setLocalStats\(null\)[\s\S]*setIsLoading\(true\)/,
    'new playback loads should drop stale local snapshots before showing a loading state',
  )
})

test('useP2PVideo gates async completions by request generation', () => {
  const source = read('../core/src/hooks/useP2PVideo.ts')

  assert.match(source, /const requestGenerationRef = useRef\(0\)/, 'hook should use a monotonic request generation')
  assert.match(source, /cleanup\(\);\s*const requestId = requestGenerationRef\.current \+ 1[\s\S]*const isCurrentRequest = \(\) => requestGenerationRef\.current === requestId/, 'each start should clear old polling and capture its own generation')
  assert.match(source, /if \(!isCurrentRequest\(\)\) return/, 'async prepare/get-url/get-stats completions should be gated')
  assert.match(source, /const interval = setInterval[\s\S]*const stopThisInterval = \(\) => \{[\s\S]*if \(pollIntervalRef\.current === interval\)/, 'polling ticks should own and clear only their own interval')
  assert.match(source, /requestGenerationRef\.current !== requestId \|\| Date\.now\(\) - startTimeRef\.current > opts\.pollTimeout/, 'polling ticks should ignore stale generations')
})

test('cached playback refreshes active URL only for the current session', () => {
  const source = read('app/video/[id].tsx')
  const cachedStart = source.indexOf('if (cachedUrl) {')
  const cachedBlock = source.slice(cachedStart, source.indexOf('const result = await preparePlaybackWhenReady(', cachedStart))
  assert.notEqual(cachedBlock.length, 0, 'expected cached playback block before the bounded readiness wait')

  assert.match(cachedBlock, /loadGenerationRef\.current !== generation/, 'background preparePlayback should be generation-gated')
  assert.match(cachedBlock, /if \(result\?\.url && !isWaitingForSelectedBlob\(result\)\) \{[\s\S]*setCachedVideoUrl[\s\S]*loadAndPlayVideo\(videoData, result\.url\)/, 'fresh prepared URL should replace the cached URL only in the active generation after selected blob readiness is proven')
})
