import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const msePlayerPath = new URL('../components/video-player/MseVideoPlayer.web.tsx', import.meta.url)
const inlineViewPath = new URL('../components/video-player/PearInlineVideoView.tsx', import.meta.url)

async function source(url) {
  return readFile(url, 'utf8')
}

test('MSE player remuxes on demand instead of linearly converting the whole file', async () => {
  const src = await source(msePlayerPath)

  assert.doesNotMatch(src, /Conversion\.init|conversion\.execute/, 'the linear Conversion pipeline must not come back — it forces seeks to wait for everything before the target')
  assert.match(src, /EncodedPacketSink/, 'random-access packet reading is required for seek-on-demand')
  assert.match(src, /getKeyPacket\(/, 'seeks must start from the keyframe at/before the target')
  assert.match(src, /verifyKeyPackets: true/, 'key packet flags must be verified (Matroska key flags are unreliable)')
})

test('MSE player restarts the remux pipeline from the seek target', async () => {
  const src = await source(msePlayerPath)
  const seekStart = src.indexOf('el.onseeking')
  assert.notEqual(seekStart, -1, 'expected onseeking handler')
  const handler = src.slice(seekStart, src.indexOf('await runPipeline(0, generation)', seekStart))

  assert.match(handler, /generation\+\+/, 'seeking must invalidate the previous pipeline generation')
  assert.match(handler, /cancel/, 'the superseded output must be canceled so it stops consuming bandwidth')
  assert.match(handler, /runPipeline\(Math\.max\(0, target - 0\.5\), gen\)/, 'a new pipeline must start from the seek target')
})

test('MSE player reports the full duration up front so the whole timeline is seekable', async () => {
  const src = await source(msePlayerPath)
  assert.match(src, /input\.computeDuration\(\)/, 'duration must come from the container index, not from conversion progress')
  assert.match(src, /ms\.duration = duration/, 'MediaSource duration must be set before playback so seeks anywhere are possible')
})

test('format errors skip stall recovery so the desktop MSE fallback still triggers promptly', async () => {
  const src = await source(inlineViewPath)
  assert.match(src, /isUnrecoverableSourceError/, 'unrecoverable source errors must be detected')
  assert.match(
    src,
    /!isUnrecoverableSourceError\(error\) && tryRecoverFromPlaybackError\(\)/,
    'recovery must be skipped for format errors (code 4) so the watch page can fall back to the MSE player immediately'
  )
})
