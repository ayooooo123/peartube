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

test('VideoPlayerContext exposes focused session, progress, and action hooks', () => {
  const source = readAppFile('lib/VideoPlayerContext.tsx')

  assert.match(source, /const VideoPlayerSessionContext = createContext/)
  assert.match(source, /const VideoPlayerProgressContext = createContext/)
  assert.match(source, /const VideoPlayerActionsContext = createContext/)
  assert.match(source, /export function useVideoPlayerSession\(\)/)
  assert.match(source, /export function useVideoPlayerProgress\(\)/)
  assert.match(source, /export function useVideoPlayerActions\(\)/)
})

test('low-frequency UI consumers avoid the combined high-frequency player context', () => {
  for (const relativePath of ['lib/SocialContext.tsx', 'components/PillTabBar.tsx']) {
    const source = readAppFile(relativePath)

    assert.match(source, /useVideoPlayerSession/)
    assert.doesNotMatch(source, /useVideoPlayerContext\(/)
  }
})

test('command-only screens use the action context instead of progress-carrying context', () => {
  for (const relativePath of [
    'app/search.tsx',
    'app/(tabs)/studio.tsx',
  ]) {
    const source = readAppFile(relativePath)

    assert.match(source, /useVideoPlayerActions/)
    assert.doesNotMatch(source, /useVideoPlayerContext\(/)
  }
})

test('watch page composes focused player hooks without subscribing to progress ticks', () => {
  const source = readAppFile('app/video/[id].tsx')

  assert.match(source, /useVideoPlayerSession\(\)/)
  assert.match(source, /useVideoPlayerActions\(\)/)
  assert.doesNotMatch(source, /useVideoPlayerContext\(/)
  assert.doesNotMatch(source, /\bonProgress\b/)
  assert.doesNotMatch(source, /\bonPlaying\b/)
  assert.doesNotMatch(source, /\bonPaused\b/)
  assert.doesNotMatch(source, /\bonBuffering\b/)
  assert.doesNotMatch(source, /\bonEnded\b/)
  assert.doesNotMatch(source, /\bonError\b/)
})
