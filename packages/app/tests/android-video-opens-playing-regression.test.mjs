import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const inlineViewPath = new URL('../components/video-player/PearInlineVideoView.tsx', import.meta.url)

async function source(url) {
  return readFile(url, 'utf8')
}

test('Android keeps initial desired play state when expo-video emits a pre-play paused event', async () => {
  const src = await source(inlineViewPath)
  const handlerStart = src.indexOf("useEventListener(player, 'playingChange'")
  assert.notEqual(handlerStart, -1, 'expected expo-video playingChange handler')
  const handler = src.slice(handlerStart, src.indexOf("useEventListener(player, 'statusChange'", handlerStart))

  assert.match(handler, /!hasReceivedPlayEventRef\.current && isPlayingRef\.current/, 'pre-play paused events while desired playback is true should be ignored')
  assert.match(handler, /player\.play\(\)/, 'ignored pre-play paused events should reassert native play')
  assert.doesNotMatch(handler, /Platform\.OS === 'web' && !hasReceivedPlayEventRef\.current/, 'the pre-play paused guard must not be web-only')
})

test('Android verifies each play request against native state until the first play event', async () => {
  const src = await source(inlineViewPath)

  const verifyStart = src.indexOf('const scheduleAutoplayVerify')
  assert.notEqual(verifyStart, -1, 'expected a scheduleAutoplayVerify helper — event-driven guards alone miss dropped play() calls that leave ExoPlayer paused without emitting further events')
  const verify = src.slice(verifyStart, src.indexOf('}, [clearAutoplayVerify])', verifyStart))

  assert.match(verify, /attempt >= AUTOPLAY_VERIFY_MAX_ATTEMPTS\) return/, 'verification must be bounded — no standing interval, just a capped retry chain')
  assert.match(verify, /scheduleAutoplayVerify\(attempt \+ 1\)/, 'a failed verification must re-arm itself, since the dropped-play state emits no event to react to')
  assert.match(verify, /hasReceivedPlayEventRef\.current \|\| !isPlayingRef\.current\) return/, 'verification stops once a real play event arrived or playback is no longer desired')
  assert.match(verify, /\.playing\)[\s\S]*\.play\(\)/, 'verification reasserts play() based on the actual native playing state, not JS-side bookkeeping')

  const applySourceStart = src.indexOf('const applySource = async () => {')
  assert.notEqual(applySourceStart, -1, 'expected the applySource effect')
  const applySource = src.slice(applySourceStart, src.indexOf('void applySource()', applySourceStart))
  assert.match(applySource, /player\.play\(\)\s*\n\s*scheduleAutoplayVerify\(\)/, 'applying a source with desired playback must schedule a verification')

  const playingChangeStart = src.indexOf("useEventListener(player, 'playingChange'")
  const playingChange = src.slice(playingChangeStart, src.indexOf("useEventListener(player, 'statusChange'", playingChangeStart))
  assert.match(playingChange, /hasReceivedPlayEventRef\.current = true[\s\S]*clearAutoplayVerify\(\)/, 'the first native play event must cancel pending verification')
})

test('Android reasserts desired play when source first becomes ready before native playing event', async () => {
  const src = await source(inlineViewPath)
  const handlerStart = src.indexOf("useEventListener(player, 'statusChange'")
  assert.notEqual(handlerStart, -1, 'expected expo-video statusChange handler')
  const handler = src.slice(handlerStart, src.indexOf("useEventListener(player, 'playToEnd'", handlerStart))

  assert.match(handler, /status === 'readyToPlay'[\s\S]*!hasReceivedPlayEventRef\.current[\s\S]*isPlayingRef\.current[\s\S]*player\.play\(\)/, 'readyToPlay should reassert play when Android has desired playback but has not emitted native playing yet')
  assert.ok(handler.indexOf("status === 'readyToPlay'") < handler.indexOf('Date.now() <= seekPlaybackRecoveryUntilRef.current'), 'initial ready-to-play reassertion should run before seek-only recovery')
})
