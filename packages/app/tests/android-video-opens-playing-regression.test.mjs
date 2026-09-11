import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { test } from 'node:test'

const inlineViewPath = new URL('../components/video-player/PearInlineVideoView.tsx', import.meta.url)
const contextPath = new URL('../lib/VideoPlayerContext.tsx', import.meta.url)

async function source(url) {
  return readFile(url, 'utf8')
}

async function loadPlaybackHelpers() {
  const appRoot = fileURLToPath(new URL('..', import.meta.url))
  const stubs = {
    'react-native-test-stub': [
      "import * as RN from 'react-native-web'",
      "export * from 'react-native-web'",
      "export const Platform = { ...RN.Platform, OS: 'android' }",
      '',
    ].join('\n'),
    'expo-test-stub': 'export const useEventListener = () => {}\n',
    'expo-video-test-stub': 'export const useVideoPlayer = () => null\nexport const VideoView = () => null\n',
    'rpc-test-stub': 'export const rpc = {}\n',
    'file-system-test-stub': 'export const documentDirectory = ""\nexport const cacheDirectory = ""\nexport default {}\n',
  }
  const instrument = {
    name: 'instrument-playback-helpers',
    setup(builder) {
      builder.onResolve({ filter: /^react-native$/ }, () => ({ path: 'react-native-test-stub', namespace: 'test-stub' }))
      builder.onResolve({ filter: /^expo$/ }, () => ({ path: 'expo-test-stub', namespace: 'test-stub' }))
      builder.onResolve({ filter: /^expo-video$/ }, () => ({ path: 'expo-video-test-stub', namespace: 'test-stub' }))
      builder.onResolve({ filter: /^@peartube\/platform\/rpc$/ }, () => ({ path: 'rpc-test-stub', namespace: 'test-stub' }))
      builder.onResolve({ filter: /^expo-file-system$/ }, () => ({ path: 'file-system-test-stub', namespace: 'test-stub' }))
      builder.onLoad({ filter: /.*/, namespace: 'test-stub' }, args => ({
        contents: stubs[args.path],
        loader: 'js',
        resolveDir: appRoot,
      }))
      builder.onLoad({ filter: /PearInlineVideoView\.tsx$/ }, async args => ({
        contents: `${await readFile(args.path, 'utf8')}
export { handleStatusChangeNonError }
`,
        loader: 'tsx',
        resolveDir: path.dirname(args.path),
      }))
      builder.onLoad({ filter: /VideoPlayerContext\.tsx$/ }, async args => ({
        contents: `${await readFile(args.path, 'utf8')}
export { shouldInterceptStartupPause }
`,
        loader: 'tsx',
        resolveDir: path.dirname(args.path),
      }))
    },
  }
  const result = await build({
    stdin: {
      contents: [
        "export { handleStatusChangeNonError } from './components/video-player/PearInlineVideoView.tsx'",
        "export { shouldInterceptStartupPause } from './lib/VideoPlayerContext.tsx'",
        '',
      ].join('\n'),
      resolveDir: appRoot,
      sourcefile: 'android-playback-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom'],
    define: { __DEV__: 'false' },
    plugins: [instrument],
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', baseUrl: appRoot, paths: { '@/*': ['./*'] } } },
    write: false,
  })
  const directory = await mkdtemp(path.join(appRoot, '.android-playing-'))
  const output = path.join(directory, 'helpers.cjs')
  await writeFile(output, result.outputFiles[0].text)
  try {
    return await import(`${pathToFileURL(output).href}?${Math.random()}`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
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
  const verify = src.slice(verifyStart, src.indexOf('\n\n  useEffect(() => {', verifyStart))

  assert.doesNotMatch(verify, /Platform\.OS === 'web'\) return/, 'desktop web playback must also retry a dropped initial play() call')
  assert.match(verify, /attempt >= AUTOPLAY_VERIFY_MAX_ATTEMPTS\)[\s\S]*\breturn\b/, 'verification must be bounded — no standing interval, just a capped retry chain')
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

test('desktop web waits for the HTML playing event before confirming playback', async () => {
  const src = await source(inlineViewPath)
  const handlerStart = src.indexOf("useEventListener(player, 'playingChange'")
  assert.notEqual(handlerStart, -1, 'expected expo-video playingChange handler')
  const handler = src.slice(handlerStart, src.indexOf("useEventListener(player, 'statusChange'", handlerStart))
  const webGuard = handler.indexOf("Platform.OS === 'web'")
  const confirmation = handler.indexOf('hasReceivedPlayEventRef.current = true')

  assert.notEqual(webGuard, -1, 'expo-video web onplay is optimistic and must have a dedicated guard')
  assert.ok(webGuard < confirmation, 'the web guard must run before playback is marked as confirmed')
  assert.match(
    handler.slice(webGuard, confirmation),
    /scheduleAutoplayVerify\(\)[\s\S]*return/,
    'optimistic web onplay must keep verification armed until HTMLMediaElement emits playing',
  )
})

test('desktop progress confirmation clears transient playback recovery state', async () => {
  const src = await source(inlineViewPath)
  const timeUpdateStart = src.indexOf("useEventListener(player, 'timeUpdate'")
  const timeUpdate = src.slice(timeUpdateStart, src.indexOf("useEventListener(player, 'playingChange'", timeUpdateStart))

  assert.match(timeUpdate, /pipExitPlayingRef\.current = false/, 'confirmed progress should clear stale PiP-exit recovery')
  assert.match(timeUpdate, /seekPlaybackRecoveryUntilRef\.current = 0/, 'confirmed progress should clear stale seek recovery')
  assert.match(timeUpdate, /playbackStartedAtRef\.current = Date\.now\(\)/, 'confirmed progress should record actual startup time')
  assert.match(timeUpdate, /onPlaying\?\.\(\)/, 'progress confirmation should notify the parent even if the DOM playing event was missed')
})

test('desktop web confirms startup only after media time advances', async () => {
  const src = await source(inlineViewPath)
  const listenerStart = src.indexOf('function attachWebVideoStartListeners()')
  const listenerBlock = src.slice(listenerStart, src.indexOf('const requestNativePlayback', listenerStart))
  const playingStart = listenerBlock.indexOf('const handlePlaying = () => {')
  const playingEnd = listenerBlock.indexOf('const handlePause = () => {', playingStart)
  const playingHandler = listenerBlock.slice(playingStart, playingEnd)
  const timeUpdateStart = src.indexOf("useEventListener(player, 'timeUpdate'")
  const timeUpdate = src.slice(timeUpdateStart, src.indexOf("useEventListener(player, 'playingChange'", timeUpdateStart))

  assert.doesNotMatch(
    playingHandler,
    /hasReceivedPlayEventRef\.current = true/,
    'a DOM playing event at time zero can still be followed by a source-replacement pause',
  )
  assert.match(
    timeUpdate,
    /currentTime > 0\.1[\s\S]*Platform\.OS === 'web'[\s\S]*hasReceivedPlayEventRef\.current = true[\s\S]*clearAutoplayVerify\(\)/,
    'desktop startup is confirmed only once playback has measurably advanced',
  )
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

test('desktop web autoplay verification spans slow P2P startup', async () => {
  const src = await source(inlineViewPath)

  assert.match(
    src,
    /const AUTOPLAY_VERIFY_MAX_ATTEMPTS = 7/,
    'bounded retries should reach 12.7 seconds so a video that becomes ready after the initial 1.5-second window still starts',
  )
})

test('desktop web readiness events cannot restart the active retry budget', async () => {
  const src = await source(inlineViewPath)
  const verifyStart = src.indexOf('const scheduleAutoplayVerify')
  const verify = src.slice(verifyStart, src.indexOf('\n\n  useEffect(() => {', verifyStart))
  const activeTimerGuard = verify.indexOf('attempt === 0 && autoplayVerifyTimerRef.current')
  const clearTimer = verify.indexOf('clearAutoplayVerify()')

  assert.notEqual(activeTimerGuard, -1, 'an already-running retry chain should ignore duplicate event-driven scheduling')
  assert.ok(activeTimerGuard < clearTimer, 'the active timer guard must run before clearing the current retry')
})

test('desktop autoplay callback changes do not reload the active media source', async () => {
  const src = await source(inlineViewPath)
  const verifyStart = src.indexOf('const scheduleAutoplayVerify')
  const verifyEnd = src.indexOf('\n\n  useEffect(() => {', verifyStart)
  const verify = src.slice(verifyStart, verifyEnd)

  assert.match(src, /const onPausedRef = useRef\(onPaused\)/, 'the latest parent callback should be stored without changing verifier identity')
  assert.match(src, /onPausedRef\.current = onPaused/, 'the callback ref must follow the latest parent render')
  assert.match(verify, /onPausedRef\.current\?\.\(\)/, 'retry exhaustion should invoke the current parent callback')
  assert.doesNotMatch(verify, /\[clearAutoplayVerify, onPaused\]/, 'an inline parent callback must not recreate the verifier and reload the source')
})

test('desktop web exposes manual play when bounded startup retries are exhausted', async () => {
  const src = await source(inlineViewPath)
  const verifyStart = src.indexOf('const scheduleAutoplayVerify')
  const verify = src.slice(verifyStart, src.indexOf('\n\n  useEffect(() => {', verifyStart))

  assert.match(
    verify,
    /attempt >= AUTOPLAY_VERIFY_MAX_ATTEMPTS[\s\S]*Platform\.OS === 'web'[\s\S]*webVideo\?\.paused[\s\S]*isPlayingRef\.current = false[\s\S]*onPausedRef\.current\?\.\(\)/,
    'a permanently paused web element must return the UI to a clickable Play state instead of remaining stuck on Pause',
  )
})

test('Android reasserts desired play when source first becomes ready before native playing event', async () => {
  const { handleStatusChangeNonError } = await loadPlaybackHelpers()
  const playCalls = []
  const buffering = []

  handleStatusChangeNonError({
    status: 'readyToPlay',
    previousStatusRef: { current: null },
    onBuffering: value => buffering.push(value),
    hasReceivedPlayEventRef: { current: false },
    isPlayingRef: { current: true },
    requestNativePlayback: () => playCalls.push('play'),
    seekPlaybackRecoveryUntilRef: { current: 0 },
  })

  assert.deepEqual(playCalls, ['play'], 'the real ready-to-play helper should reassert the requested Android playback')
  assert.deepEqual(buffering, [{ isBuffering: false }], 'ready media should clear buffering before reasserting play')
  const seekRecoveryCalls = []
  handleStatusChangeNonError({
    status: 'readyToPlay',
    previousStatusRef: { current: null },
    onBuffering: () => {},
    hasReceivedPlayEventRef: { current: true },
    isPlayingRef: { current: true },
    requestNativePlayback: () => seekRecoveryCalls.push('play'),
    seekPlaybackRecoveryUntilRef: { current: Date.now() + 1_000 },
  })
  assert.deepEqual(seekRecoveryCalls, ['play'], 'the same helper should reassert a desired seek recovery before its deadline')
})

test('Android ignores startup pause events until the replacement source starts', async () => {
  const { shouldInterceptStartupPause } = await loadPlaybackHelpers()
  const desiredStates = []
  const playCalls = []
  const clearedGuards = []
  const key = 'replacement-source'

  const intercepted = shouldInterceptStartupPause(
    { key, until: Date.now() + 3_000 },
    key,
    () => clearedGuards.push('clear'),
    value => desiredStates.push(value),
    () => ({ play: () => playCalls.push('play') }),
  )

  assert.equal(intercepted, true, 'the startup pause guard should consume Android’s pre-play pause')
  assert.deepEqual(desiredStates, [true], 'consuming the pause should restore the desired state')
  assert.deepEqual(playCalls, ['play'], 'consuming the pause should reassert the native player')
  assert.deepEqual(clearedGuards, [], 'a live startup guard must not be cleared')

  const expired = shouldInterceptStartupPause(
    { key, until: Date.now() - 1 },
    key,
    () => clearedGuards.push('clear'),
    () => {},
    () => null,
  )
  assert.equal(expired, false, 'an expired guard must stop intercepting ordinary pauses')
  assert.deepEqual(clearedGuards, ['clear'], 'expired startup state should be cleared')
})
