import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

function readAppFile(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

test('VideoPlayerContext treats seek-time native pauses as buffering, not user pauses', () => {
  const source = readAppFile('lib/VideoPlayerContext.tsx')
  const pausedStart = source.indexOf('const onPaused = useCallback')
  assert.notEqual(pausedStart, -1, 'expected onPaused callback')
  const pausedHandler = source.slice(pausedStart, source.indexOf('const onBuffering', pausedStart))

  assert.match(
    pausedHandler,
    /seekConfirmRef\.current[\s\S]*isPlayingRef\.current[\s\S]*getPlayerPort\(\)\?\.play\?\.\(\)[\s\S]*return/,
    'seek-induced pause events should be ignored and playback reasserted before JS flips isPlaying=false',
  )
})
