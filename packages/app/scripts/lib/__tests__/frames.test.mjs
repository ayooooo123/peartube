import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evenTimestamps, ffmpegGrabArgs } from '../frames.mjs'

test('evenly spaced, centered, clamped to end', () => {
  assert.deepEqual(evenTimestamps(10, 5), [1, 3, 5, 7, 9])
})

test('clamps past-the-end grabs', () => {
  const ts = evenTimestamps(2, 6)
  assert.ok(ts.every(t => t <= 1.9 + 1e-9))
})

test('ffmpeg args scale to 1568 long edge and grab one frame', () => {
  const args = ffmpegGrabArgs('/v.mp4', 3.5, '/out/03.jpg')
  assert.ok(args.includes('-ss') && args.includes('3.5'))
  assert.ok(args.join(' ').includes("scale='min(1568,iw)'"))
  assert.ok(args.includes('-frames:v') && args.includes('1'))
})
