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

test('player port contract declares shared backend controls and optional capabilities', () => {
  const source = readAppFile('lib/video-player/playerPort.ts')

  assert.match(source, /export type PlayerBackendKind = 'native' \| 'web-mse' \| 'cast' \| 'desktop-native' \| 'unknown'/)
  assert.match(source, /export interface PlayerPort \{[\s\S]*play\(\): void \| Promise<void>/)
  assert.match(source, /export interface PlayerPort \{[\s\S]*pause\(\): void \| Promise<void>/)
  assert.match(source, /export interface PlayerPort \{[\s\S]*stop\(\): void \| Promise<void>/)
  assert.match(source, /export interface PlayerPort \{[\s\S]*seek\(timeSeconds: number\): void \| Promise<void>/)
  assert.match(source, /setPlaybackRate\?\(rate: number\): void \| Promise<void>/)
  assert.match(source, /enterPictureInPicture\?\(\): void \| Promise<void>/)
  assert.match(source, /startCasting\?\(\): void \| Promise<void>/)
  assert.match(source, /export type PlayerPortCapabilities = \{[\s\S]*pictureInPicture\?: boolean[\s\S]*cast\?: boolean[\s\S]*playbackRate\?: boolean/)
})

test('legacy native and web player refs are adapted behind PlayerPort', () => {
  const source = readAppFile('lib/video-player/playerPort.ts')

  assert.match(source, /export function createPlayerPort\([\s\S]*backend: LegacyPlayerRef,[\s\S]*metadata: PlayerPortMetadata,[\s\S]*\): PlayerPort/)
  assert.match(source, /play: \(\) => backend\.play\?\.\(\) \?\? backend\.resume\?\.\(true\)/)
  assert.match(source, /pause: \(\) => backend\.pause\?\.\(\) \?\? backend\.resume\?\.\(false\)/)
  assert.match(source, /seek: \(timeSeconds: number\) => backend\.seek\?\.\(Math\.max\(0, timeSeconds\)\)/)
  assert.match(source, /export function createWebMsePlayerPort\(video: HTMLVideoElement\): PlayerPort/)
  assert.match(source, /export function createWebMsePlayerPort\(backend: LegacyPlayerRef\): PlayerPort/)
  assert.match(source, /videoOrBackend: HTMLVideoElement \| LegacyPlayerRef/)
  assert.match(source, /kind: 'web-mse'/)
})

test('VideoPlayerContext talks to the resolved PlayerPort instead of raw imperative refs', () => {
  const source = readAppFile('lib/VideoPlayerContext.tsx')

  assert.match(source, /import type \{ PlayerMode, PlayerPort \} from '\.\/video-player'/)
  assert.match(source, /playerRef: React\.MutableRefObject<PlayerPort \| null>/)
  assert.match(source, /const playerRef = useRef<PlayerPort \| null>\(null\)/)
  assert.match(source, /const getPlayerPort = useCallback\(\(\) => resolvePlayerPort\(playerRef\.current\), \[\]\)/)
  assert.match(source, /getPlayerPort\(\)\?\.pause\?\.\(\)/)
  assert.match(source, /getPlayerPort\(\)\?\.play\?\.\(\)/)
  assert.match(source, /getPlayerPort\(\)\?\.stop\?\.\(\)/)
  assert.doesNotMatch(source, /playerRef\.current\?\.pause\?\.\(\)/)
  assert.doesNotMatch(source, /playerRef\.current\?\.play\?\.\(\)/)
  assert.doesNotMatch(source, /playerRef\.current\?\.stop\?\.\(\)/)
})

test('native and web player components publish typed PlayerPort adapters', () => {
  const pearSource = readAppFile('components/video-player/PearInlineVideoView.tsx')

  assert.match(pearSource, /import \{ createPlayerPort, type PlayerPort \} from '@\/lib\/video-player'/)
  assert.match(pearSource, /playerRef: RefObject<PlayerPort \| null>/)
  assert.match(pearSource, /createPlayerPort\(/)
  assert.match(pearSource, /kind: 'native'/)
  assert.match(pearSource, /pictureInPicture: Platform\.OS === 'android'/)

  const mseSource = readAppFile('components/video-player/WebMseVideoBackend.web.tsx')
  const mseTypesSource = readAppFile('components/video-player/WebMseVideoBackend.types.ts')
  assert.match(mseSource, /import \{ createWebMsePlayerPort, type PlayerPort \} from '@\/lib\/video-player'/)
  assert.match(mseTypesSource, /playerRef\?: React\.RefObject<PlayerPort \| null>/)
  assert.match(mseSource, /const controller = createWebMseBackendController\(el\)[\s\S]*const port = createWebMsePlayerPort\(controller\)[\s\S]*playerRef\.current = port/)

  const verticalShortsSource = readAppFile('components/discovery/VerticalShortsPlayer.tsx')
  assert.match(verticalShortsSource, /playerRef: RefObject<PlayerPort \| null>/)
})

test('video-player barrel exports the PlayerPort contract for future backends', () => {
  const source = readAppFile('lib/video-player/index.ts')

  assert.match(source, /createPlayerPort/)
  assert.match(source, /createWebMsePlayerPort/)
  assert.match(source, /resolvePlayerPort/)
  assert.match(source, /PlayerBackendKind/)
  assert.match(source, /PlayerPortCapabilities/)
})
