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

test('native tabs expose a vertical discovery doomscroll surface', () => {
  const tabsLayout = readAppFile('app/(tabs)/_layout.tsx')
  const tabBar = readAppFile('components/PillTabBar.tsx')

  assert.match(tabsLayout, /<Tabs\.Screen name="discover"/, 'discover tab route should be registered')
  assert.match(tabBar, /path:\s*'\/discover'/, 'bottom nav should link to vertical discovery')
  assert.match(tabBar, /icon:\s*'zap'/, 'vertical discovery should have a fast-mode tab icon')
})

test('vertical discovery uses paged full-screen feed and plays inline in the shorts surface', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')

  assert.match(source, /FlatList/, 'vertical discovery should use FlatList for a swipe feed')
  assert.match(source, /pagingEnabled/, 'vertical discovery should page one video at a time')
  assert.match(source, /snapToInterval=\{pageHeight\}/, 'vertical discovery should snap to full-screen item height')
  assert.match(source, /onViewableItemsChanged/, 'vertical discovery should track the active page')
  assert.match(source, /viewabilityConfig/, 'vertical discovery should use explicit viewability thresholds')
  assert.match(source, /<VerticalShortsPlayer[\s\S]*testID="vertical-discovery-inline-player"/, 'active vertical item should render through the dedicated shorts player surface')
  assert.doesNotMatch(source, /<VideoContainer/, 'vertical discovery must not embed the normal watch player container')
  assert.doesNotMatch(source, /loadAndPlayVideo\(/, 'vertical playback must not open the normal mobile playback overlay')
  assert.match(source, /useVideoPlayerContext\(/, 'vertical discovery should coordinate with the global player for playback handoff')
  assert.match(source, /handoffToShorts\(\)/, 'vertical discovery should pause and close the global player before Shorts starts')
  assert.match(source, /preparePlayback\(playbackRequest\)/, 'vertical player should resolve playback through backend preparePlayback')
  assert.match(source, /getCachedVideoUrl\(cacheKey\)/, 'vertical player should use the short playback URL cache')
  assert.match(source, /setShortsVideoUrl\(/, 'vertical player should keep playback URL in local shorts-player state')
  assert.match(source, /handoffToShorts\(\)[\s\S]*const cachedUrl = cacheKey \? getCachedVideoUrl\(cacheKey\) : null/, 'handoff should happen before cached Shorts playback attaches')
  assert.match(source, /handoffToShorts\(\)[\s\S]*const result = await rpc\.preparePlayback\(playbackRequest\)/, 'handoff should happen before prepared Shorts playback attaches')
})

test('vertical discovery handoff pauses and hides the global player while preserving return position', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')

  assert.match(source, /const \{[\s\S]*currentVideo,[\s\S]*playerMode,[\s\S]*pauseVideo,[\s\S]*closeVideo,[\s\S]*\} = useVideoPlayerContext\(\)/, 'Discover should read global player state and controls')
  assert.match(source, /if \(!currentVideo \|\| playerMode === 'hidden'\) return/, 'handoff should no-op when no in-app player is active')
  assert.match(source, /pauseVideo\(\)/, 'handoff should pause the active global player immediately')
  assert.match(source, /closeVideo\(\)/, 'handoff should hide/detach the global player surface before Shorts plays')
})

test('vertical discovery uses a dedicated shorts player surface instead of the watch player frame', () => {
  const source = readAppFile('components/discovery/VerticalShortsPlayer.tsx')

  assert.match(source, /PearInlineVideoView/, 'shorts player should paint the native inline video surface directly')
  assert.doesNotMatch(source, /VideoContainer/, 'shorts player must not wrap the normal watch player container')
  assert.match(source, /\.\.\.StyleSheet\.absoluteFillObject/, 'shorts player should own the full vertical card surface')
  assert.match(source, /landscapeVideoSurface/, 'shorts player should have a landscape-specific presentation mode')
  assert.match(source, /onVideoStateChange=\{handleVideoStateChange\}/, 'shorts player should react to loaded video dimensions')
})

test('vertical discovery keeps channel navigation and detail escape hatches', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')

  assert.match(source, /router\.push\(\{\s*pathname:\s*'\/channel\/\[key\]'/, 'vertical cards should open channel pages')
  assert.match(source, /router\.push\(\{\s*pathname:\s*'\/video\/\[id\]'/, 'vertical cards should expose full watch/details route')
  assert.match(source, /Feather name="message-circle"/, 'vertical player should include a comments/details affordance')
  assert.match(source, /Feather name="user"/, 'vertical player should include a channel affordance')
})
