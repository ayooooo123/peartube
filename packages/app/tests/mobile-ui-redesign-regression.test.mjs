import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appRoot, '../..')

function readApp(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

function readRepo(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('mobile design tokens move away from Twitch purple toward a restrained PearTube dark system', () => {
  const source = readRepo('packages/core/src/utils/index.ts')

  assert.match(source, /primary:\s*'#5e6ad2'/, 'primary accent should use restrained indigo instead of the old saturated Twitch purple')
  assert.match(source, /bg:\s*'#08090a'/, 'mobile surface should use near-black Linear-style base')
  assert.match(source, /surfaceBorder:\s*'rgba\(255,255,255,0\.08\)'/, 'surface borders should use translucent dark-mode-native separators')
  assert.doesNotMatch(source, /primary:\s*'#9147ff'/, 'old Twitch purple should not remain as the primary brand color')
})

test('native video cards use premium app-native surfaces and cover thumbnails', () => {
  const cardSource = readApp('components/video/VideoCard.tsx')
  const thumbnailSource = readApp('components/video/ThumbnailImage.tsx')

  assert.match(cardSource, /styles\.surface/, 'native VideoCard should wrap content in a deliberate surface')
  assert.match(cardSource, /styles\.thumbnailFrame/, 'native VideoCard should give thumbnails a controlled framed media area')
  assert.match(cardSource, /borderColor:\s*'rgba\(255,255,255,0\.08\)'/, 'VideoCard surface should use subtle translucent borders')
  assert.doesNotMatch(cardSource, /textDecorationLine:\s*'underline'/, 'channel labels should not look like cheap underlined web links on mobile')
  assert.match(thumbnailSource, /resizeMode="cover"/, 'mobile thumbnails should fill their media frame instead of letterboxing with contain')
})

test('opening a channel video on mobile pushes the watch route without suppressing minimize behavior', () => {
  const channelSource = readApp('app/channel/[key].tsx')
  const videoSource = readApp('app/video/[id].tsx')

  assert.match(
    channelSource,
    /router\.push\(\{\s*pathname: '\/video\/\[id\]'[\s\S]*?videoData: JSON\.stringify/,
    'channel video taps should push the watch route with full videoData params',
  )
  assert.doesNotMatch(
    channelSource,
    /fromChannel: 'true'/,
    'channel video taps should not mark a special navigation mode that suppresses normal player lifecycle',
  )
  assert.doesNotMatch(
    videoSource,
    /const fromChannel = params\.fromChannel === 'true'/,
    'watch route should not branch player lifecycle for channel-origin navigation',
  )
  assert.match(
    videoSource,
    /navigation\.addListener\('beforeRemove'[\s\S]*?minimizePlayer\(\)/,
    'leaving the watch route should use the normal shared-player minimize behavior',
  )
})

test('channel page presents a polished mobile-native header and concise video count context', () => {
  const source = readApp('app/channel/[key].tsx')

  assert.match(source, /const channelVideoCountText =/, 'channel page should compute a concise video-count label')
  assert.match(source, /styles\.hero/, 'channel page should use a designed hero block instead of a plain row')
  assert.match(source, /styles\.videoCountPill/, 'channel page should show count/context in a restrained pill')
  assert.match(source, /styles\.videoListSection/, 'channel video list should have a named composed section')
})
