import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const contextPath = new URL('../lib/VideoPlayerContext.tsx', import.meta.url)
const videoRoutePath = new URL('../app/video/[id].tsx', import.meta.url)
const overlayPath = new URL('../components/VideoPlayerOverlayImpl.tsx', import.meta.url)
const homePath = new URL('../app/(tabs)/index.tsx', import.meta.url)
const searchTabPath = new URL('../app/(tabs)/search.tsx', import.meta.url)
const searchPath = new URL('../app/search.tsx', import.meta.url)
const socialPath = new URL('../lib/SocialContext.tsx', import.meta.url)

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

test('VideoPlayerContext keeps player debug logging behind an explicit opt-in gate', async () => {
  const src = await source(contextPath)

  assert.match(src, /function debugPlayerLog\(\.\.\.args: unknown\[\]\)/, 'expected a dedicated player debug logger')
  assert.match(src, /__PEARTUBE_DEBUG_VIDEO_PLAYER__/, 'debug logging should be controlled by an explicit global flag')
  assert.doesNotMatch(src, /console\.log\(/, 'player hot paths should not write directly to console.log')
})

test('feed and picker screens use action-only player context to avoid progress-driven rerenders', async () => {
  const contextSource = await source(contextPath)
  const homeSource = await source(homePath)
  const searchTabSource = await source(searchTabPath)
  const searchSource = await source(searchPath)

  assert.match(contextSource, /export function useVideoPlayerActions\(\)/, 'VideoPlayerContext should expose an action-only hook')
  for (const [name, src] of [
    ['home tab', homeSource],
    ['search tab', searchTabSource],
    ['search route', searchSource],
  ]) {
    assert.match(src, /useVideoPlayerActions/, `${name} should use the stable action-only hook`)
    assert.doesNotMatch(src, /useVideoPlayerContext/, `${name} should not subscribe to high-frequency player state`)
  }
})

test('SocialProvider subscribes only to stable player session fields', async () => {
  const contextSource = await source(contextPath)
  const socialSource = await source(socialPath)

  assert.match(contextSource, /export function useVideoPlayerSession\(\)/, 'VideoPlayerContext should expose a stable session-only hook')
  assert.match(socialSource, /useVideoPlayerSession/, 'SocialProvider should use the session-only hook')
  assert.doesNotMatch(socialSource, /useVideoPlayerContext/, 'SocialProvider should not rerender on playback progress or stats changes')
})

test('mobile/native route uses the shared overlay player instead of an inline player shell', async () => {
  const src = await source(videoRoutePath)
  assert.match(src, /Video is rendered by VideoPlayerOverlay on all platforms/, 'route should not own the native video load event directly')
  assert.doesNotMatch(src, /onLoad=\{onLoaded\}/, 'route should not try to wire a nonexistent inline player load handler')
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
