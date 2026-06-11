import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const contextPath = new URL('../lib/VideoPlayerContext.tsx', import.meta.url)
const stateMachinePath = new URL('../lib/playerStateMachine.ts', import.meta.url)

test('foreground return does not seek-nudge while background playback kept running', async () => {
  const src = await readFile(contextPath, 'utf8')

  // The nudge seeks the native player to the JS-side position. When the player
  // kept playing in the background (media notification / staysActiveInBackground),
  // that seek forces a P2P rebuffer — an audible gap on resume — and can jump
  // backwards when the JS position is stale. It must only run when background
  // playback actually stopped.
  assert.match(
    src,
    /!wasInPip && wasPlayingWhenBackgroundedRef\.current && !isPlayingRef\.current && durationRef\.current > 0/,
    'foreground seek nudge must be gated on background playback having stopped (!isPlayingRef.current)',
  )
})

test('reopening the app during background playback surfaces the player page', async () => {
  const stateMachine = await readFile(stateMachinePath, 'utf8')
  const context = await readFile(contextPath, 'utf8')

  // Tapping the media playback notification resumes MainActivity with no extra
  // signal, so APP_FOREGROUND must carry whether the session kept playing in the
  // background and restore the fullscreen player page from mini mode.
  assert.match(
    stateMachine,
    /resumedWithBackgroundPlayback: boolean/,
    'APP_FOREGROUND event must carry resumedWithBackgroundPlayback',
  )
  assert.match(
    stateMachine,
    /event\.wasInPip \|\| event\.resumedWithBackgroundPlayback \? 'fullscreen' : 'mini'/,
    'mini + APP_FOREGROUND must restore fullscreen when playback continued in background',
  )
  assert.match(
    context,
    /resumedWithBackgroundPlayback =\s*\n?\s*!wasInPip && Boolean\(currentVideoRef\.current\) && wasPlayingWhenBackgroundedRef\.current/,
    'AppState foreground handler must compute resumedWithBackgroundPlayback from the backgrounded playback state',
  )
})
