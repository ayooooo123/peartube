import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const inlineViewPath = new URL('../components/video-player/PearInlineVideoView.tsx', import.meta.url)
const contextPath = new URL('../lib/VideoPlayerContext.tsx', import.meta.url)

async function source(url) {
  return readFile(url, 'utf8')
}

test('Android keeps initial desired play state when expo-video emits a pre-play paused event', async () => {
  const src = await source(inlineViewPath)
  const handlerStart = src.indexOf("useEventListener(player, 'playingChange'")
  assert.notEqual(handlerStart, -1, 'expected expo-video playingChange handler')
  const handler = src.slice(handlerStart, src.indexOf("useEventListener(player, 'statusChange'", handlerStart))

  assert.match(handler, /!hasReceivedPlayEventRef\.current && isPlayingRef\.current/, 'pre-play paused events while desired playback is true should be ignored')
  assert.match(handler, /requestNativePlayback\(\)/, 'ignored pre-play paused events should reassert native play')
  assert.doesNotMatch(handler, /Platform\.OS === 'web' && !hasReceivedPlayEventRef\.current/, 'the pre-play paused guard must not be web-only')
})

test('native inline player verifies each play request against native state until the first play event', async () => {
  const src = await source(inlineViewPath)

  const verifyStart = src.indexOf('const scheduleAutoplayVerify')
  assert.notEqual(verifyStart, -1, 'expected a scheduleAutoplayVerify helper — event-driven guards alone miss dropped play() calls that leave ExoPlayer paused without emitting further events')
  const verify = src.slice(verifyStart, src.indexOf('}, [clearAutoplayVerify])', verifyStart))

  assert.doesNotMatch(verify, /Platform\.OS === 'web'\) return/, 'desktop web playback must also retry a dropped initial play() call')
  assert.match(verify, /attempt >= AUTOPLAY_VERIFY_MAX_ATTEMPTS\) return/, 'verification must be bounded — no standing interval, just a capped retry chain')
  assert.match(verify, /scheduleAutoplayVerify\(attempt \+ 1\)/, 'a failed verification must re-arm itself, since the dropped-play state emits no event to react to')
  assert.match(verify, /hasReceivedPlayEventRef\.current \|\| !isPlayingRef\.current\) return/, 'verification stops once a real play event arrived or playback is no longer desired')
  assert.match(verify, /\.playing\)[\s\S]*\.play\(\)/, 'verification reasserts play() based on the actual native playing state, not JS-side bookkeeping')

  const applySourceStart = src.indexOf('const applySource = async () => {')
  assert.notEqual(applySourceStart, -1, 'expected the applySource effect')
  const applySource = src.slice(applySourceStart, src.indexOf('void applySource()', applySourceStart))
  assert.match(applySource, /requestNativePlayback\(\)\s*\n\s*scheduleAutoplayVerify\(\)/, 'applying a source with desired playback must schedule a verification')

  const playingChangeStart = src.indexOf("useEventListener(player, 'playingChange'")
  const playingChange = src.slice(playingChangeStart, src.indexOf("useEventListener(player, 'statusChange'", playingChangeStart))
  assert.match(playingChange, /hasReceivedPlayEventRef\.current = true[\s\S]*clearAutoplayVerify\(\)/, 'the first native play event must cancel pending verification')
})

test('desktop web autoplay verification uses the real HTML video element state', async () => {
  const src = await source(inlineViewPath)

  assert.match(src, /const nativeVideoViewRef = useRef<any>\(null\)/, 'desktop web should retain the VideoView ref that exposes the underlying HTML video element')
  assert.match(src, /function getWebNativeVideoElement\(\)/, 'desktop web should have a helper for reading VideoView.nativeRef.current')
  assert.match(src, /nativeVideoViewRef\.current\?\.nativeRef\?\.current/, 'the helper should read Expo VideoView nativeRef.current on web')
  assert.match(
    src,
    /const webVideo = getWebNativeVideoElement\(\)[\s\S]*webVideo\.paused[\s\S]*webVideo\.play\(\)/,
    'verification must use HTMLVideoElement.paused/play() because expo-video web sets player.playing optimistically',
  )
  assert.match(
    src,
    /onFirstFrameRender=\{\(\) => \{[\s\S]*requestNativePlayback\(\)/,
    'loaded first-frame events should reassert desired playback on desktop web without waiting for a pause/play toggle',
  )
  assert.match(src, /ref=\{nativeVideoViewRef\}/, 'VideoView should receive the ref used for real web video state')
})

test('desktop web reasserts playback from real media readiness events', async () => {
  const src = await source(inlineViewPath)

  assert.match(src, /const WEB_MEDIA_START_EVENTS = \[/, 'desktop web should declare the media readiness events that can unblock startup')
  assert.match(src, /'loadedmetadata'[\s\S]*'loadeddata'[\s\S]*'canplay'/, 'metadata/data/canplay should trigger immediate startup checks')
  assert.match(src, /const webVideoEventTargetRef = useRef<HTMLVideoElement \| null>\(null\)/, 'the attached DOM video element should be tracked for listener cleanup')
  assert.match(src, /function attachWebVideoStartListeners\(\)/, 'desktop web should attach listeners to the real HTML video element')
  assert.match(src, /webVideo\.addEventListener\(eventName, handleStartupEvent\)/, 'startup events should reassert playback immediately')
  assert.match(src, /webVideo\.addEventListener\('playing', handlePlaying\)/, 'real DOM playing should clear optimistic Expo retry state')
  assert.match(src, /webVideo\.addEventListener\('pause', handlePause\)/, 'early real DOM pauses should be resisted while playback is desired')
  assert.match(src, /webVideoEventTargetRef\.current = null/, 'detached DOM video listeners must clear their target ref')
})

test('desktop web autoplay verifier starts with a short retry delay', async () => {
  const src = await source(inlineViewPath)

  assert.match(src, /const AUTOPLAY_VERIFY_BASE_DELAY_MS = 100/, 'desktop startup should not wait 400ms before the first fallback retry')
  assert.match(src, /AUTOPLAY_VERIFY_BASE_DELAY_MS \* 2 \*\* attempt/, 'retry delay should remain bounded exponential backoff')
})

test('Android reasserts desired play when source first becomes ready before native playing event', async () => {
  const src = await source(inlineViewPath)
  const handlerStart = src.indexOf("useEventListener(player, 'statusChange'")
  assert.notEqual(handlerStart, -1, 'expected expo-video statusChange handler')
  const handler = src.slice(handlerStart, src.indexOf("useEventListener(player, 'playToEnd'", handlerStart))

  assert.match(handler, /status === 'readyToPlay'[\s\S]*!hasReceivedPlayEventRef\.current[\s\S]*isPlayingRef\.current[\s\S]*requestNativePlayback\(\)/, 'readyToPlay should reassert play when Android has desired playback but has not emitted native playing yet')
  assert.ok(handler.indexOf("status === 'readyToPlay'") < handler.indexOf('Date.now() <= seekPlaybackRecoveryUntilRef.current'), 'initial ready-to-play reassertion should run before seek-only recovery')
})

test('Android startup pause events do not clear desired playback during source replacement', async () => {
  const src = await source(contextPath)

  assert.match(src, /const STARTUP_AUTOPLAY_GUARD_MS = 3000/, 'startup autoplay guard should be short and bounded')
  assert.match(src, /const startupAutoplayGuardRef = useRef<\{ key: string; until: number \} \| null>\(null\)/, 'context should track the guarded startup handoff')
  assert.match(src, /const startupAutoplayReassertTimersRef = useRef<NodeJS\.Timeout\[\]>\(\[\]\)/, 'startup guard should own bounded reassert timers')
  assert.match(src, /const clearStartupAutoplayGuard = useCallback/, 'startup guard should be cleared through one helper')
  assert.match(src, /const scheduleStartupAutoplayReassertions = useCallback/, 'startup guard should actively reassert desired playback while the source is attaching')
  assert.match(src, /for \(const delayMs of \[50, 150, 350, 750\]\)/, 'startup reassertion should be bounded to a short retry window')
  assert.match(src, /setDesiredPlaying\(true\)[\s\S]*getPlayerPort\(\)\?\.play\?\.\(\)/, 'startup reassertion should restore desired play and re-call native play')

  const startBlockStart = src.indexOf('const performPlaybackStartNow = useCallback')
  assert.notEqual(startBlockStart, -1, 'expected playback start helper')
  const startBlock = src.slice(startBlockStart, src.indexOf('const drainQueuedPlaybackStart', startBlockStart))
  assert.match(startBlock, /startupAutoplayGuardRef\.current = \{[\s\S]*key: playbackKey,[\s\S]*until: now \+ STARTUP_AUTOPLAY_GUARD_MS/, 'loadAndPlayVideo should arm the startup autoplay guard before source replacement can emit pause')
  assert.ok(
    startBlock.indexOf('startupAutoplayGuardRef.current = {') < startBlock.indexOf('scheduleStartupAutoplayReassertions(playbackKey)'),
    'the startup guard must be armed before scheduling playback reassertions',
  )
  assert.ok(
    startBlock.indexOf('currentVideoRef.current = video') < startBlock.indexOf('getPlayerPort()?.stop?.()'),
    'active video ref must be set before native stop/pause can emit a startup paused event',
  )
  assert.ok(
    startBlock.indexOf('videoUrlRef.current = url') < startBlock.indexOf('getPlayerPort()?.stop?.()'),
    'active URL ref must be set before native stop/pause can emit a startup paused event',
  )

  const pausedStart = src.indexOf('const onPaused = useCallback')
  assert.notEqual(pausedStart, -1, 'expected pause handler')
  const pausedBlock = src.slice(pausedStart, src.indexOf('const onBuffering = useCallback', pausedStart))
  assert.match(pausedBlock, /const startupGuard = startupAutoplayGuardRef\.current/, 'pause handler should inspect startup guard')
  assert.match(pausedBlock, /Date\.now\(\) <= startupGuard\.until/, 'startup guard should expire automatically')
  assert.match(pausedBlock, /lastPlaybackStartKeyRef\.current === startupGuard\.key/, 'pause guard should preserve autoplay even if the active source ref is briefly behind the pending playback key')
  assert.match(pausedBlock, /setDesiredPlaying\(true\)/, 'startup pause should preserve desired play state')
  assert.match(pausedBlock, /getPlayerPort\(\)\?\.play\?\.\(\)/, 'startup pause should reassert play when the new source is active')
  assert.ok(pausedBlock.indexOf('const startupGuard = startupAutoplayGuardRef.current') < pausedBlock.indexOf('setIsPlaying(false)'), 'startup guard must run before a pause can set isPlaying=false')

  const pauseStart = src.indexOf('const pauseVideo = useCallback')
  const pauseBlock = src.slice(pauseStart, src.indexOf('const resumeVideo = useCallback', pauseStart))
  assert.match(pauseBlock, /clearStartupAutoplayGuard\(\)/, 'explicit pause should clear startup guard and reassert timers')

  const playingStart = src.indexOf('const onPlaying = useCallback')
  const playingBlock = src.slice(playingStart, src.indexOf('const onPaused = useCallback', playingStart))
  assert.match(playingBlock, /clearStartupAutoplayGuard\(\)/, 'real playing event should clear startup guard and reassert timers')
})
