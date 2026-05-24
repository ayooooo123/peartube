import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const contextPath = new URL('../lib/VideoPlayerContext.tsx', import.meta.url)
const videoRoutePath = new URL('../app/video/[id].tsx', import.meta.url)
const overlayPath = new URL('../components/VideoPlayerOverlayImpl.tsx', import.meta.url)

async function source(url) {
  return readFile(url, 'utf8')
}

test('VideoPlayerContext clears loading when the native player reports load', async () => {
  const src = await source(contextPath)
  const loadHandlerStart = src.indexOf('const onLoaded = useCallback')
  assert.notEqual(loadHandlerStart, -1, 'expected VideoPlayerContext onLoaded callback')
  const loadHandler = src.slice(loadHandlerStart, src.indexOf('const onPlaying', loadHandlerStart))
  assert.match(loadHandler, /setIsLoading\(false\)/, 'onLoaded must clear global player loading')
  assert.match(loadHandler, /isBufferingRef\.current\s*=\s*false/, 'onLoaded must clear buffering ref')
})

test('VideoPlayerContext also clears the connecting gate once backend stats show bytes are available', async () => {
  const src = await source(contextPath)
  const statsHandlerStart = src.indexOf('Received stats event')
  assert.notEqual(statsHandlerStart, -1, 'expected video stats handler')
  const statsHandler = src.slice(statsHandlerStart, src.indexOf('})\n     return () => { unsubscribe() }', statsHandlerStart))
  assert.match(statsHandler, /stats\.progress[^\n]+>\s*0/, 'stats handler must treat positive progress as media-ready')
  assert.match(statsHandler, /setIsLoading\(false\)/, 'stats handler must clear global player loading')
  assert.match(statsHandler, /isBufferingRef\.current\s*=\s*false/, 'stats handler must clear buffering ref')
})

test('mobile/native route uses the shared overlay player instead of an inline player shell', async () => {
  const src = await source(videoRoutePath)
  assert.match(src, /Video is rendered by VideoPlayerOverlay on all platforms/, 'route should not own the native video load event directly')
  assert.doesNotMatch(src, /onLoad=\{onLoaded\}/, 'route should not try to wire a nonexistent inline player load handler')
})

test('mobile/native route cancels delayed stats polling when closed quickly', async () => {
  const src = await source(videoRoutePath)

  assert.match(src, /const statsPollingDelayRef = useRef/, 'watch route should track delayed stats polling timers')
  assert.match(src, /const mountedRef = useRef\(true\)/, 'watch route should guard async work after unmount')
  assert.match(src, /const clearStatsPolling = useCallback/, 'watch route should centralize stats polling cleanup')
  assert.match(src, /const scheduleStatsPolling = useCallback/, 'watch route should schedule stats polling through a cancellable helper')
  assert.doesNotMatch(src, /setTimeout\(\(\) => startStatsPolling\(\), 500\)/, 'stats polling should not be started by uncancellable delayed callbacks')
})

test('VideoPlayerContext suppresses the loading gate for mid-playback buffering events', async () => {
  const src = await source(contextPath)
  const bufferingStart = src.indexOf('const onBuffering = useCallback')
  assert.notEqual(bufferingStart, -1, 'expected VideoPlayerContext onBuffering callback')
  const bufferingHandler = src.slice(bufferingStart, src.indexOf('const onEnded', bufferingStart))

  assert.match(bufferingHandler, /data\.isBuffering && currentTimeRef\.current > 0/, 'buffering while playback has advanced should be treated as transient')
  assert.match(bufferingHandler, /Keep the stats\/details[\s\S]*visible/, 'transient mid-playback buffering should keep stats/details visible')
  assert.match(bufferingHandler, /setIsLoading\(data\.isBuffering\)/, 'initial buffering should still show loading before playback starts')
})

test('desktop/native overlay forwards load events into shared player context before local handling', async () => {
  const src = await source(overlayPath)
  assert.match(src, /onLoaded,/, 'overlay must read onLoaded from useVideoPlayerContext')
  const handlerStart = src.indexOf('const handleVideoLoad = useCallback')
  assert.notEqual(handlerStart, -1, 'expected wrapped overlay load handler')
  const handler = src.slice(handlerStart, src.indexOf('// Animation progress', handlerStart))
  assert.match(handler, /onLoaded\(\)/, 'overlay load handler must notify shared context')
  assert.match(src, /onLoad=\{handleVideoLoad\}/, 'overlay player must use the wrapped load handler')
})
