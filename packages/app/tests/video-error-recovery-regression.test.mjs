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
