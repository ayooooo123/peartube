import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

function readAppFile(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

test('playback URL cache records selected blob readiness, not only blob-server URLs', () => {
  const cacheSource = readAppFile('lib/video-url-cache.ts')

  assert.match(cacheSource, /readyForPlayback\?:\s*boolean/, 'cache entries should store whether selected blob warmup proved bytes or peers')
  assert.match(cacheSource, /setCachedVideoUrl\([^)]*readyForPlayback\?:\s*boolean/s, 'cache writes should accept readiness from preparePlayback diagnostics')
  assert.match(cacheSource, /getCachedVideoUrl\([^)]*requireReady\?:\s*boolean/s, 'cache reads should support requiring ready playback instead of any URL')
  assert.match(cacheSource, /if \(options\.requireReady && !cached\.readyForPlayback\) return null/, 'tap playback should not reuse a URL cached before selected blob acquisition was ready')
})

test('home and vertical tap playback require ready cached URLs before attaching native player', () => {
  const homeSource = readAppFile('app/(tabs)/index.tsx')
  const discoverSource = readAppFile('app/(tabs)/discover.tsx')

  const homePlayStart = homeSource.indexOf('const playVideo = useCallback')
  const homePlayBlock = homeSource.slice(homePlayStart, homeSource.indexOf('// Legacy: Play video in overlay only', homePlayStart))
  assert.match(homePlayBlock, /getCachedVideoUrl\(cacheKey, \{ requireReady: true \}\)/, 'Home taps should not attach speculative warmup URLs that are not ready')
  assert.match(homePlayBlock, /setCachedVideoUrl\(cacheKey, result\.url, Boolean\(result\.selectedBlobWarmup\?\.readyForPlayback\)\)/, 'Home taps should record selected blob readiness')

  const discoverPlayStart = discoverSource.indexOf('const playVideo = useCallback')
  const discoverPlayBlock = discoverSource.slice(discoverPlayStart, discoverSource.indexOf('useEffect(() => {\n    if (!activeVideo', discoverPlayStart))
  assert.match(discoverPlayBlock, /getCachedVideoUrl\(cacheKey, \{ requireReady: true \}\)/, 'Shorts taps should not attach speculative warmup URLs that are not ready')
  assert.match(discoverPlayBlock, /setCachedVideoUrl\(cacheKey, result\.url, Boolean\(result\.selectedBlobWarmup\?\.readyForPlayback\)\)/, 'Shorts taps should record selected blob readiness')
})

test('tap playback shows fetching state then plays the URL after bounded readiness wait', () => {
  const homeSource = readAppFile('app/(tabs)/index.tsx')
  const discoverSource = readAppFile('app/(tabs)/discover.tsx')

  assert.match(homeSource, /preparePlaybackWhenReady/, 'Home taps should poll bounded readiness for selected direct blobs')
  assert.match(homeSource, /Fetching video from peers…/, 'Home taps should expose visible fetching state while selected bytes warm up')
  // After the bounded readiness wait, play the resolved URL regardless of
  // head-block warmup and let the blob server stream on demand — matching the
  // full-screen player (video/[id].tsx). Gating on readiness here stranded
  // slow single-peer links on a non-retrying "try again" toast.
  assert.match(homeSource, /if \(result\?\.url\) \{[\s\S]*?loadAndPlayVideo\(video, result\.url\)/, 'Home taps should play the resolved URL after the bounded readiness wait')
  assert.doesNotMatch(homeSource, /Video is still fetching from peers\. Try again shortly\./, 'Home taps should not dead-end on a non-retrying not-ready toast')

  assert.match(discoverSource, /preparePlaybackWhenReady/, 'Vertical taps should poll bounded readiness for selected direct blobs')
  assert.match(discoverSource, /setShortsPlaybackMessage\(\{ key: playKey, text: 'Fetching video from peers…' \}\)/, 'Vertical taps should expose visible fetching state')
  assert.match(discoverSource, /if \(result\?\.url\) \{[\s\S]*?setShortsVideoUrl\(result\.url\)/, 'Vertical taps should play the resolved URL after the bounded readiness wait')
  assert.doesNotMatch(discoverSource, /Video is still fetching from peers\. Try again shortly\./, 'Vertical taps should not dead-end on a non-retrying not-ready toast')
})

test('background warmups may cache speculative URLs but mark them unready until diagnostics prove playback', () => {
  const homeSource = readAppFile('app/(tabs)/index.tsx')
  const controllerSource = readAppFile('lib/discover-feed-controller.js')

  const warmBlock = homeSource.slice(homeSource.indexOf('const warmPlaybackUrl = useCallback'), homeSource.indexOf('const refreshFeed', homeSource.indexOf('const warmPlaybackUrl = useCallback')))
  assert.match(warmBlock, /setCachedVideoUrl\(cacheKey, result\.url, Boolean\(result\.selectedBlobWarmup\?\.readyForPlayback\)\)/, 'Home background warmups should not imply playable bytes merely because a URL exists')
  assert.match(controllerSource, /setCachedVideoUrl\(cacheKey, result\.url, Boolean\(result\?\.selectedBlobWarmup\?\.readyForPlayback\)\)/, 'Shorts background warmups should preserve readiness diagnostics')
})
