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

test('PearInlineVideoView uses react-native-video as the native inline renderer', () => {
  const source = readAppFile('components/video-player/PearInlineVideoView.tsx')

  assert.match(source, /react-native-video/)
  assert.match(source, /<Video/)
  assert.match(source, /useTextureView=\{Platform\.OS === 'android'\}/)
  assert.match(source, /bufferConfig=\{Platform\.OS === 'android' \? ANDROID_BUFFER_CONFIG : undefined\}/)
  assert.doesNotMatch(source, /expo-pear-player/)
  assert.doesNotMatch(source, /createPearPlayer/)
  assert.doesNotMatch(source, /<PearPlayerView/)
})

test('PearInlineVideoView adapter controls the shared VideoRef directly', () => {
  const source = readAppFile('components/video-player/PearInlineVideoView.tsx')

  assert.match(source, /play:\s*async \(\)\s*=> \{\s*videoRef\.current\?\.resume\?\.\(\)\s*}/)
  assert.match(source, /pause:\s*async \(\)\s*=> \{\s*videoRef\.current\?\.pause\?\.\(\)\s*}/)
  assert.match(
    source,
    /stop:\s*async \(\)\s*=> \{[\s\S]*videoRef\.current\?\.pause\?\.\(\)[\s\S]*videoRef\.current\?\.seek\(0\)/,
  )
  assert.match(source, /seek:\s*async \(timeSeconds: number\) => \{[\s\S]*videoRef\.current\?\.seek\(/)
  assert.doesNotMatch(source, /controller\./)
})

test('legacy MpvMobileVideoView file is only a compatibility shim', () => {
  const source = readAppFile('components/video-player/MpvMobileVideoView.tsx')

  assert.match(source, /PearInlineVideoView as MpvMobileVideoView/)
  assert.equal(
    source.includes('expo-pear-player'),
    false,
    'legacy compatibility file should not own playback logic anymore',
  )
})

test('video-player index exports PearInlineVideoView without hiding it behind mpv naming', () => {
  const source = readAppFile('components/video-player/index.ts')

  assert.match(source, /PearInlineVideoView/)
  assert.match(source, /getPearInlinePlayerId/)
})
