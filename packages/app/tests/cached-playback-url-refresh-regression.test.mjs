import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}


test('watch page playback prepares the backend before opening cached local URLs', () => {
  const source = read('app/video/[id].tsx')

  assert.doesNotMatch(source, /getCachedVideoUrl/)
  assert.doesNotMatch(source, /loadAndPlayVideo\(videoData, cachedUrl\)/)
  assert.match(source, /const result = await rpc\.preparePlayback\(playbackRequest\)/)
  assert.match(source, /if \(result\?\.url\) \{[\s\S]*loadAndPlayVideo\(videoData, result\.url\)/)
})

test('studio playback prepares the backend before opening cached local URLs', () => {
  const source = read('app/(tabs)/studio.tsx')

  assert.doesNotMatch(source, /getCachedVideoUrl/)
  assert.doesNotMatch(source, /loadAndPlayVideo\(video, cachedUrl\)/)
  assert.match(source, /const result = await rpc\.preparePlayback\(playbackRequest\)/)
  assert.match(source, /if \(result\?\.url\) \{[\s\S]*loadAndPlayVideo\(video, result\.url\)/)
})
