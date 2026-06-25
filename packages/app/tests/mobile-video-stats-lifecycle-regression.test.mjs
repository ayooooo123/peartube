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

test('mobile watch page does not keep saying reaching out once playback has byte progress', () => {
  const source = read('app/video/[id].tsx')
  const barStart = source.indexOf('function P2PStatsBar')
  assert.notEqual(barStart, -1, 'expected mobile watch page P2PStatsBar')
  const barBlock = source.slice(barStart, source.indexOf('// Action Button Component', barStart))

  assert.match(
    barBlock,
    /const hasPlayableProgress =/,
    'stats bar should classify playable byte or block progress separately from peers',
  )
  assert.match(
    barBlock,
    /sessionDownloadedBytes > 0[\s\S]*sessionDownloadedBlocks > 0[\s\S]*downloadSpeedValue > 0/,
    'streaming state should depend on bytes from the active playback session, not sampled aggregate progress',
  )
  assert.doesNotMatch(
    barBlock,
    /Number\(stats\?\.progress \?\? 0\) > 0/,
    'sampled aggregate progress should not clear the reaching-out/preparing state by itself',
  )
})

test('backend preparePlayback waits for bounded playback prefetch before URL handoff', () => {
  const source = read('../backend/src/api.js')
  const transcoderSource = read('../backend/src/transcode/transcoder.mjs')

  assert.match(
    source,
    /async function startOnDemandPlaybackStats/,
    'direct blob playback should keep a lightweight stats fallback when startup prefetch is unavailable',
  )
  assert.match(
    source,
    /core\.on\('download', onDownload\)/,
    'direct playback stats should advance from blob core download events',
  )
  assert.match(
    source,
    /await withTimeout\(\s*prefetchPromise,\s*PLAYBACK_HANDOFF_PREFETCH_TIMEOUT_MS,/,
    'preparePlayback should wait briefly for the playback prefetch startup gate before handing off the URL',
  )
  assert.match(
    source,
    /const onDemandStats = await startOnDemandPlaybackStats\(driveKey, videoPath, playbackBlobRef\)/,
    'preparePlayback should keep direct playback stats while startup prefetch runs',
  )
  assert.match(
    transcoderSource,
    /HTTP_CONTENT_LENGTH_TIMEOUT_MS/,
    'compat content-length probing should be bounded so it cannot block mobile playback',
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

test('watch page playback prepares the backend before opening a URL', () => {
  const source = read('app/video/[id].tsx')
  const prepareStart = source.indexOf('const result = await rpc.preparePlayback(playbackRequest)')
  assert.notEqual(prepareStart, -1, 'expected preparePlayback before URL handoff')
  const handoffStart = source.indexOf('loadAndPlayVideo(videoData, result.url)', prepareStart)
  assert.notEqual(handoffStart, -1, 'expected prepared URL handoff after preparePlayback')

  const prepareBlock = source.slice(prepareStart, handoffStart)
  assert.match(prepareBlock, /loadGenerationRef\.current !== generation/, 'preparePlayback completion should be generation-gated')
  assert.match(source, /if \(cacheKey\) setCachedVideoUrl\(cacheKey, result\.url\)/, 'prepared URL should refresh the cache only after backend preparation')
  assert.doesNotMatch(source, /loadAndPlayVideo\(videoData, cachedUrl\)/, 'watch page must not hand cached URLs to the player before backend preparation')
})
