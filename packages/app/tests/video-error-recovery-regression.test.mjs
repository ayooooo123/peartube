import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const inlineViewPath = new URL('../components/video-player/PearInlineVideoView.tsx', import.meta.url)

async function source(url) {
  return readFile(url, 'utf8')
}

test('fatal playback errors trigger automatic source recovery instead of freezing', async () => {
  const src = await source(inlineViewPath)
  const handlerStart = src.indexOf("useEventListener(player, 'statusChange'")
  assert.notEqual(handlerStart, -1, 'expected expo-video statusChange handler')
  const handler = src.slice(handlerStart, src.indexOf("useEventListener(player, 'playToEnd'", handlerStart))

  assert.match(
    handler,
    /status === 'error'[\s\S]*tryRecoverFromPlaybackError\(\)\) return/,
    'a fatal player error (e.g. blob server resetting an uncached seek range request) must attempt recovery before surfacing onError'
  )
})

test('error recovery re-attaches the source and resumes from the last playback position', async () => {
  const src = await source(inlineViewPath)
  const recoveryStart = src.indexOf('const tryRecoverFromPlaybackError')
  assert.notEqual(recoveryStart, -1, 'expected tryRecoverFromPlaybackError callback')
  const recovery = src.slice(recoveryStart, src.indexOf('const tryRecoverFromPlaybackErrorRef', recoveryStart))

  assert.match(recovery, /PLAYBACK_ERROR_RECOVERY_MAX_ATTEMPTS/, 'recovery attempts must be bounded')
  assert.match(recovery, /replaceAsync\(videoSource\)/, 'recovery must re-attach the current video source')
  assert.match(recovery, /player\.currentTime = resumeAt/, 'recovery must resume from the last playback position')
  assert.match(recovery, /isPlayingRef\.current/, 'recovery must only auto-play when playback was desired')
  assert.match(recovery, /sourceReplaceGenerationRef\.current !== generation/, 'recovery must abort when a newer source replaced the failed one')
})

test('recovery attempt budget refills once playback advances past the stall', async () => {
  const src = await source(inlineViewPath)
  const handlerStart = src.indexOf("useEventListener(player, 'timeUpdate'")
  assert.notEqual(handlerStart, -1, 'expected expo-video timeUpdate handler')
  const handler = src.slice(handlerStart, src.indexOf("useEventListener(player, 'playingChange'", handlerStart))

  assert.match(
    handler,
    /errorRecoveryResumePositionRef\.current \+ PLAYBACK_ERROR_RECOVERY_PROGRESS_SEC[\s\S]*errorRecoveryAttemptsRef\.current = 0/,
    'advancing past the recovery point must reset the attempt budget so later stalls can recover again'
  )
})

test('a terminal source error latches and stops every automatic fetch', async () => {
  const src = await source(inlineViewPath)

  const handlerStart = src.indexOf("useEventListener(player, 'statusChange'")
  const handler = src.slice(handlerStart, src.indexOf("useEventListener(player, 'playToEnd'", handlerStart))
  assert.match(
    handler,
    /classified\.terminal[\s\S]*terminalPlaybackErrorRef\.current = classified\.code/,
    'an undecodable source must be latched, not retried until some other cap stops it'
  )
  assert.match(handler, /terminal: classified\.terminal/, 'the session must learn the error is terminal')

  // Every path that would hand the peer another range request for the same
  // rejected bytes has to read the latch.
  const recoveryStart = src.indexOf('const tryRecoverFromPlaybackError')
  const recovery = src.slice(recoveryStart, src.indexOf('const tryRecoverFromPlaybackErrorRef', recoveryStart))
  assert.match(recovery, /if \(terminalPlaybackErrorRef\.current\) return false/, 'no further recovery attempts')
  assert.match(
    recovery,
    /sourceReplaceGenerationRef\.current !== generation \|\| terminalPlaybackErrorRef\.current/,
    'an already-scheduled re-attach must abandon itself once the error is known terminal'
  )

  const applyStart = src.indexOf('const applySource = async () => {')
  const applyEffect = src.slice(src.lastIndexOf('useEffect(() => {', applyStart), applyStart)
  assert.match(applyEffect, /if \(terminalPlaybackErrorRef\.current\) return/, 'no source re-apply')

  const verifyStart = src.indexOf('const scheduleAutoplayVerify')
  const verify = src.slice(verifyStart, src.indexOf('useEffect(', verifyStart))
  assert.match(verify, /if \(terminalPlaybackErrorRef\.current\) return/, 'no autoplay re-assertion')

  const resetStart = src.indexOf('errorRecoveryAttemptsRef.current = 0')
  assert.match(
    src.slice(resetStart, resetStart + 400),
    /terminalPlaybackErrorRef\.current = null/,
    'a new source, session, or video key clears the latch so a real retry can run'
  )
})
