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

test('PearInlineVideoView uses Expo Video as the native inline renderer', () => {
  const source = readAppFile('components/video-player/PearInlineVideoView.tsx')

  assert.match(source, /from 'expo-video'/)
  assert.match(source, /<VideoView/)
  assert.match(source, /useVideoPlayer\(/)
  assert.match(source, /allowsPictureInPicture=\{autoEnterPipOnLeave\}/)
  assert.match(source, /startsPictureInPictureAutomatically=\{autoEnterPipOnLeave\}/)
  assert.match(source, /surfaceType="surfaceView"/)
  assert.match(source, /player\.showNowPlayingNotification = showNotificationControls/)
  assert.match(source, /player\.staysActiveInBackground = showNotificationControls/)
  assert.doesNotMatch(source, /from 'react-native-video'/)
  assert.doesNotMatch(source, /<Video\b/)
  assert.doesNotMatch(source, /expo-pear-player/)
  assert.doesNotMatch(source, /createPearPlayer/)
  assert.doesNotMatch(source, /<PearPlayerView/)
})

test('PearInlineVideoView hosts the web MSE backend behind the existing player surface', () => {
  const source = readAppFile('components/video-player/PearInlineVideoView.tsx')
  const renderStart = source.indexOf('  return (')
  assert.notEqual(renderStart, -1, 'PearInlineVideoView should render a single player surface')
  const renderBlock = source.slice(renderStart)

  assert.match(source, /import \{ WebMseVideoBackend \} from '\.\/WebMseVideoBackend'/)
  assert.match(source, /import type \{ CompatPlaybackResult \} from '\.\/WebMseVideoBackend\.types'/)
  assert.match(source, /webPlaybackBackend\?: 'native' \| 'mse'/)
  assert.match(source, /requestCompatPlayback\?: \(\) => Promise<CompatPlaybackResult>/)
  assert.match(source, /const useMseBackend = Platform\.OS === 'web' && webPlaybackBackend === 'mse'/)
  assert.match(renderBlock, /useMseBackend \? \(/)
  assert.match(renderBlock, /<WebMseVideoBackend/)
  assert.match(renderBlock, /requestCompatPlayback=\{requestCompatPlayback\}/)
  assert.match(renderBlock, /\) : \(\s*<VideoView/)
})

test('PearInlineVideoView disables native Expo source and ref effects while web MSE is active', () => {
  const source = readAppFile('components/video-player/PearInlineVideoView.tsx')

  assert.match(
    source,
    /useEffect\(\(\) => \{[\s\S]*if \(useMseBackend\) return[\s\S]*const applySource = async/,
    'native source replacement should not run while the MSE backend owns the media element',
  )
  assert.match(
    source,
    /useEffect\(\(\) => \{[\s\S]*if \(useMseBackend\) return[\s\S]*player\.playbackRate = playbackRate/,
    'native playback-rate writes should not target the dormant Expo player while MSE is active',
  )
  assert.match(
    source,
    /useEffect\(\(\) => \{[\s\S]*if \(useMseBackend\) return[\s\S]*if \(isPlaying\)/,
    'native play-pause writes should not fight the MSE backend',
  )
  assert.match(
    source,
    /useEffect\(\(\) => \{[\s\S]*if \(!playerRef \|\| useMseBackend\) return[\s\S]*playerRef\.current = adapter/,
    'the native PlayerPort adapter should not overwrite the MSE backend port',
  )
})

test('PearInlineVideoView adapter controls the shared Expo Video player directly', () => {
  const source = readAppFile('components/video-player/PearInlineVideoView.tsx')

  assert.match(source, /play:\s*async \(\)\s*=> \{\s*player\.play\(\)\s*}/)
  assert.match(source, /pause:\s*async \(\)\s*=> \{\s*player\.pause\(\)\s*}/)
  assert.match(
    source,
    /stop:\s*async \(\)\s*=> \{[\s\S]*player\.pause\(\)[\s\S]*player\.currentTime = 0/,
  )
  assert.match(source, /seek:\s*async \(timeSeconds: number\) => \{[\s\S]*player\.currentTime = Math\.max\(0, timeSeconds\)/)
  assert.doesNotMatch(source, /controller\./)
})

test('PearInlineVideoView declares the adapter before AppState effects use it', () => {
  const source = readAppFile('components/video-player/PearInlineVideoView.tsx')
  const adapterDeclarationIndex = source.indexOf('const adapter = useMemo')
  const appStateEffectIndex = source.indexOf("AppState.addEventListener('change'")

  assert.notEqual(adapterDeclarationIndex, -1, 'adapter useMemo should exist')
  assert.notEqual(appStateEffectIndex, -1, 'Android AppState effect should exist')
  assert.ok(
    adapterDeclarationIndex < appStateEffectIndex,
    'adapter must be initialized before AppState effect closes over it; otherwise playback mount can crash from TDZ access',
  )
})

test('PearInlineVideoView uses Expo Video on native SDK 56 to avoid react-native-video Android mount crash', () => {
  const source = readAppFile('components/video-player/PearInlineVideoView.tsx')

  assert.match(source, /from 'expo-video'/)
  assert.match(source, /<VideoView/)
  assert.match(source, /useVideoPlayer\(/)
  assert.match(source, /surfaceType="surfaceView"/)
  assert.doesNotMatch(source, /from 'react-native-video'/)
})

test('PearInlineVideoView keeps one Expo Video player and replaces sources without remounting the VideoView', () => {
  const source = readAppFile('components/video-player/PearInlineVideoView.tsx')

  assert.match(source, /useVideoPlayer\(null,/)
  assert.match(source, /replaceAsync/)
  assert.match(source, /\.replace\(videoSource\)/)
  assert.doesNotMatch(source, /key=\{`expo-video-/)
})

test('legacy MpvMobileVideoView implementation stays removed or only exists as a shim', () => {
  const shimPath = path.join(appRoot, 'components/video-player/MpvMobileVideoView.tsx')
  if (!fs.existsSync(shimPath)) {
    assert.equal(fs.existsSync(shimPath), false)
    return
  }

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

test('dead VideoContainer and native MpvVideoView player hosts stay removed', () => {
  const deadContainerPath = path.join(appRoot, 'components/video-player/VideoContainer.tsx')
  const deadHostPath = path.join(appRoot, 'components/video-player/MpvVideoView.tsx')

  assert.equal(fs.existsSync(deadContainerPath), false)
  assert.equal(fs.existsSync(deadHostPath), false)
})
