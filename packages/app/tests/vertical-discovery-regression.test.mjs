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

test('vertical discovery hydrates beyond sparse previews without permanently poisoning timed-out channels', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')
  const hydrateBlock = source.slice(source.indexOf('const hydrateChannelVideos'), source.indexOf('const loadFeed'))

  assert.doesNotMatch(source, /entries\.slice\(0, 8\)/, 'shorts should not cap channel hydration to the first few feed entries')
  assert.match(source, /entries\.slice\(0, 24\)/, 'shorts should fan out across enough feed channels to expose more than preview videos')
  assert.doesNotMatch(hydrateBlock, /hydratedChannelsRef\.current\.add\(channelKey\)[\s\S]*?const result = await withTimeout/, 'timed-out channel list calls must remain retryable')
  assert.match(hydrateBlock, /const timeoutToken = Symbol\('vertical-channel-timeout'\)/, 'channel hydration should distinguish timeout from an authoritative empty video list')
  assert.match(hydrateBlock, /if \(result === timeoutToken\) return[\s\S]*hydratedChannelsRef\.current\.add\(channelKey\)/, 'channel hydration should only mark the channel hydrated after a real response')
})

test('vertical discovery preloads the next few videos into the playback URL cache', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')

  assert.match(source, /warmNextPlaybackUrls\(\{[\s\S]*videos,[\s\S]*activeIndex,[\s\S]*makePlaybackRequest/, 'shorts should warm the next few videos through the feed controller')
  assert.match(source, /preparePlayback:\s*rpc\.preparePlayback\?\.bind\(rpc\)/, 'preload should route through backend preparePlayback')
})


test('vertical discovery lets the shorts player hide card chrome', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')
  const playerSource = readAppFile('components/discovery/VerticalShortsPlayer.tsx')

  assert.match(source, /const \[shortsChromeVisible, setShortsChromeVisible\] = useState\(true\)/, 'Discover should track whether Shorts chrome/buttons are visible')
  assert.match(source, /controlsVisible=\{shortsChromeVisible\}/, 'Discover should pass shared chrome visibility to the Shorts player')
  assert.match(source, /onControlsVisibleChange=\{setShortsChromeVisible\}/, 'Shorts player taps should update route chrome visibility')
  assert.match(source, /\{shortsChromeVisible \? \([\s\S]*styles\.bottomMeta/, 'channel/details/replay buttons should hide when Shorts controls are hidden')
  assert.match(playerSource, /toggleControlsVisibility/, 'Shorts player should toggle controls on tap')
  assert.match(playerSource, /onControlsVisibleChange\?\.\(!controlsVisible\)/, 'Shorts player should notify the parent when controls are toggled')
})

test('shorts player has functional playback buttons and a seekable progress bar', () => {
  const source = readAppFile('components/discovery/VerticalShortsPlayer.tsx')

  assert.match(source, /const \[isPaused, setIsPaused\] = useState\(false\)/, 'Shorts player should own local pause state')
  assert.match(source, /const \[playbackProgress, setPlaybackProgress\]/, 'Shorts player should track current time and duration')
  assert.match(source, /onProgress=\{handleProgress\}/, 'Shorts player should receive native progress events')
  assert.match(source, /seekPosition=\{seekPosition\}/, 'Shorts player should pass seek requests to the native inline player')
  assert.match(source, /playerRef\.current\?\.pause\?\.\(\)/, 'pause button should call the player port')
  assert.match(source, /playerRef\.current\?\.play\?\.\(\)/, 'play button should call the player port')
  assert.match(source, /playerRef\.current\?\.seek\?\.\(0\)/, 'restart button should seek to the beginning')
  assert.match(source, /handleProgressBarPress/, 'progress bar should handle tap-to-seek')
  assert.match(source, /accessibilityLabel="Shorts progress bar"/, 'progress bar should be accessible and testable')
})

test('vertical discovery stops inline Shorts playback when the route unmounts or loses focus', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')

  assert.match(source, /useFocusEffect/, 'Discover should subscribe to route focus lifecycle')
  assert.match(source, /stopShortsPlayback/, 'Discover should centralize Shorts playback teardown')
  assert.match(source, /shortsPlayerRef\.current\?\.stop\?\.\(\)/, 'teardown should stop the native inline player instead of merely hiding React chrome')
  assert.match(source, /setShortsVideoUrl\(null\)/, 'teardown should detach the playback URL so the inline surface unmounts')
  assert.match(source, /return stopShortsPlayback/, 'Discover should run teardown when tab navigation leaves the Shorts route')
})

test('bottom tab screens pad scrollable content by the measured pill tab bar height', () => {
  const indexSource = readAppFile('app/(tabs)/index.tsx')
  const subscriptionsSource = readAppFile('app/(tabs)/subscriptions.tsx')
  const studioSource = readAppFile('app/(tabs)/studio.tsx')
  const downloadsSource = readAppFile('app/(tabs)/downloads.tsx')
  const settingsSource = readAppFile('app/(tabs)/settings.tsx')

  for (const [label, source] of [
    ['home', indexSource],
    ['subscriptions', subscriptionsSource],
    ['studio', studioSource],
    ['downloads', downloadsSource],
    ['settings', settingsSource],
  ]) {
    assert.match(source, /useTabBarMetrics\(/, `${label} should read measured tab bar metrics`)
    assert.match(source, /const bottomPadding = Math\.max\(tabBarMetrics\.height \+ 16, insets\.bottom \+ 16\)/, `${label} should reserve enough space for the floating pill nav`)
    assert.doesNotMatch(source, /paddingBottom:\s*insets\.bottom \+ (16|20|100)/, `${label} should not use hard-coded safe-area-only bottom padding`)
  }
})
