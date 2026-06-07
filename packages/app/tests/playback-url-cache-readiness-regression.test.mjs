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

test('background warmups may cache speculative URLs but only ready cache entries suppress rewarming', () => {
  const homeSource = readAppFile('app/(tabs)/index.tsx')
  const controllerSource = readAppFile('lib/discover-feed-controller.js')

  const warmBlock = homeSource.slice(homeSource.indexOf('const warmPlaybackUrl = useCallback'), homeSource.indexOf('const refreshFeed', homeSource.indexOf('const warmPlaybackUrl = useCallback')))
  assert.match(warmBlock, /getCachedVideoUrl\(cacheKey, \{ requireReady: true \}\)/, 'Home warmups should re-run when the only cached URL is still unready')
  assert.match(warmBlock, /setCachedVideoUrl\(cacheKey, result\.url, Boolean\(result\.selectedBlobWarmup\?\.readyForPlayback\)\)/, 'Home background warmups should not imply playable bytes merely because a URL exists')
  assert.match(controllerSource, /getCachedVideoUrl\(cacheKey, \{ requireReady: true \}\)/, 'Shorts background warmups should re-run unready cache entries')
  assert.match(controllerSource, /setCachedVideoUrl\(cacheKey, result\.url, Boolean\(result\?\.selectedBlobWarmup\?\.readyForPlayback\)\)/, 'Shorts background warmups should preserve readiness diagnostics')
})

test('Home and Shorts gate fresh and refresh preparePlayback URLs on selected blob readiness', () => {
  const homeSource = readAppFile('app/(tabs)/index.tsx')
  const discoverSource = readAppFile('app/(tabs)/discover.tsx')
  const homePlayStart = homeSource.indexOf('const playVideo = useCallback')
  const homePlayBlock = homeSource.slice(homePlayStart, homeSource.indexOf('// Legacy: Play video in overlay only', homePlayStart))
  const homeOverlayStart = homeSource.indexOf('const playVideoInOverlay = useCallback')
  const homeOverlayBlock = homeSource.slice(homeOverlayStart, homeSource.indexOf('const onRefresh', homeOverlayStart))
  const discoverPlayStart = discoverSource.indexOf('const playVideo = useCallback')
  const discoverPlayBlock = discoverSource.slice(discoverPlayStart, discoverSource.indexOf('useEffect(() => {\n    if (!activeVideo', discoverPlayStart))

  assert.match(homePlayBlock, /if \(result\?\.url && !isSelectedBlobWarmupPending\(result\)\)[\s\S]*loadAndPlayVideo\(video, result\.url\)/, 'Home cached refresh should not replace/attach unready preparePlayback URLs')
  assert.match(homePlayBlock, /if \(isSelectedBlobWarmupPending\(result\)\)[\s\S]*PLAYBACK_READINESS_MAX_RETRIES[\s\S]*playVideoRetryRef\.current\(video, readinessRetry \+ 1\)[\s\S]*return[\s\S]*loadAndPlayVideo\(video, result\.url\)/, 'Home fresh playback should retry instead of attaching unready URLs')
  assert.match(homeOverlayBlock, /if \(result\?\.url && !isSelectedBlobWarmupPending\(result\)\)[\s\S]*loadAndPlayVideo\(video, result\.url\)/, 'Home overlay cached refresh should not attach unready preparePlayback URLs')
  assert.match(homeOverlayBlock, /if \(isSelectedBlobWarmupPending\(result\)\)[\s\S]*PLAYBACK_READINESS_MAX_RETRIES[\s\S]*playVideoInOverlayRetryRef\.current\(video, readinessRetry \+ 1\)[\s\S]*return[\s\S]*loadAndPlayVideo\(video, result\.url\)/, 'Home overlay fresh playback should retry instead of attaching unready URLs')
  assert.match(discoverPlayBlock, /if \(result\?\.url && !isSelectedBlobWarmupPending\(result\)\)[\s\S]*setShortsVideoUrl\(result\.url\)/, 'Shorts cached refresh should not replace/attach unready preparePlayback URLs')
  assert.match(discoverPlayBlock, /if \(isSelectedBlobWarmupPending\(result\)\)[\s\S]*PLAYBACK_READINESS_MAX_RETRIES[\s\S]*playVideoRetryRef\.current\(video, readinessRetry \+ 1\)[\s\S]*return[\s\S]*setShortsVideoUrl\(result\.url\)/, 'Shorts fresh playback should retry instead of attaching unready URLs')
})
