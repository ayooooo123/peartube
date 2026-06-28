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
  assert.doesNotMatch(source, /useVideoPlayerContext\(/, 'vertical discovery should not bind the Shorts player to the global watch player context')
  assert.doesNotMatch(source, /handoffToShorts\(\)/, 'Shorts playback should not hand off through the normal player')
  assert.match(source, /preparePlayback\(playbackRequest\)/, 'vertical player should resolve playback through backend preparePlayback')
  assert.doesNotMatch(source, /getCachedVideoUrl\(cacheKey(?:, \{ requireReady: true \})?\)/, 'vertical player must not bypass backend preparation with a cached local URL')
  assert.doesNotMatch(source, /setAmbientVideoContext\(/, 'Shorts playback and comments should not update global watch-player metadata')
  assert.match(source, /setShortsVideoUrl\(/, 'vertical player should keep playback URL in local shorts-player state')
  assert.doesNotMatch(source, /setShortsVideoUrl\(cachedUrl\)/, 'cached Shorts playback should not attach directly before backend preparation')
  assert.match(source, /const result = await rpc\.preparePlayback\(playbackRequest\)/, 'prepared Shorts playback should resolve through a single preparePlayback call and stream on demand')
  assert.doesNotMatch(source, /preparePlaybackWhenReady/, 'Shorts playback should not poll a readiness warmup loop')
})

test('vertical discovery is isolated from the global watch player context', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')

  assert.doesNotMatch(source, /import \{ useVideoPlayerContext \}/, 'Discover should not import the global player context')
  assert.doesNotMatch(source, /currentVideo|playerMode|pauseVideo|closeVideo/, 'Discover should not read or mutate global watch-player state')
  assert.doesNotMatch(source, /keepHidden/, 'Shorts should not use hidden global ambient state as a shadow comments/player model')
})

test('vertical discovery uses a dedicated shorts player surface instead of the watch player frame', () => {
  const source = readAppFile('components/discovery/VerticalShortsPlayer.tsx')

  assert.match(source, /PearInlineVideoView/, 'shorts player should paint the native inline video surface directly')
  assert.match(source, /autoEnterPipOnLeave=\{false\}/, 'shorts mode should not auto-trigger system PiP when leaving the app')
  assert.match(source, /showNotificationControls=\{false\}/, 'shorts mode should not create Android Media3 notification sessions for every swiped card')
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
  assert.match(source, /styles\.shortsAuthorAvatar/, 'vertical player should include a channel avatar affordance')
  assert.match(source, /styles\.shortsFollowButton/, 'vertical player should include a channel follow/open affordance')
})

test('vertical discovery uses PearTube-adapted content chrome without borrowed social affordances', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')

  assert.match(source, /shortsCardChrome/, 'shorts cards should render through a named PearTube content chrome wrapper')
  assert.match(source, /styles\.shortsAuthorAvatar/, 'shorts metadata should include a channel avatar')
  assert.match(source, /styles\.shortsFollowButton/, 'shorts metadata should include a real follow affordance')
  assert.match(source, /styles\.shortsActionRow/, 'shorts metadata should use an inline action row')
  assert.match(source, /styles\.shortsActionCluster/, 'shorts actions should be compact icon+label clusters')
  assert.match(source, /Feather name="share-2"/, 'shorts actions should include a share affordance')
  assert.match(source, /Feather name="message-circle"/, 'shorts actions should include a comments affordance')
  // PearTube has no verification, reposts, view analytics, bookmarks, or @handles —
  // these were borrowed from X and must not be faked with empty/placeholder data.
  assert.doesNotMatch(source, /shortsVerifiedBadge/, 'PearTube should not show a fake verified badge on every channel')
  assert.doesNotMatch(source, /Feather name="repeat"/, 'PearTube has no repost concept — drop the retweet-style action')
  assert.doesNotMatch(source, /Feather name="bar-chart-2"/, 'PearTube feed has no view analytics — drop the view-count glyph')
  assert.doesNotMatch(source, /Feather name="bookmark"/, 'drop the non-functional bookmark affordance')
  assert.doesNotMatch(source, /getShortsHandle|formatShortsActionCount|getShortsActionMetrics/, 'drop synthesized @handles and the all-zero action-count machinery')
  assert.doesNotMatch(source, /x\.com|addressBar|browserChrome|mobile browser/i, 'PearTube should not copy the browser/address-bar chrome from the reference screenshot')
  assert.doesNotMatch(source, /bottomActionRail/, 'large pre-redesign action rail should be removed')
  assert.doesNotMatch(source, /bottomActionButton/, 'large pre-redesign action buttons should be removed')
})

test('vertical discovery wires the Follow button to real subscription state', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')

  assert.match(source, /const toggleFollow = useCallback/, 'shorts should expose a real follow toggle, not a channel-open shim')
  assert.match(source, /onPress=\{\(\) => toggleFollow\(video\)\}/, 'the follow button should call the follow toggle')
  assert.match(source, /\.subscribeChannel\(\{ channelKey \}\)/, 'following should subscribe to the channel over RPC')
  assert.match(source, /\.unsubscribeChannel\(\{ channelKey \}\)/, 'unfollowing should unsubscribe from the channel over RPC')
  assert.match(source, /getSubscriptions/, 'follow state should hydrate from existing subscriptions')
  assert.match(source, /isFollowing \? 'Following' : 'Follow'/, 'the follow button label should reflect subscription state')
  assert.doesNotMatch(source, /style=\{styles\.shortsFollowButton\} accessibilityRole="button" accessibilityLabel="Open channel"/, 'the follow button should no longer be a mislabeled channel-open shim')
})

test('vertical discovery action row exposes only real, honest affordances', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')

  assert.match(source, /accessibilityLabel="Open Shorts comments"/, 'comments action opens the inline comments sheet')
  assert.match(source, /accessibilityLabel="Share video"/, 'share action uses the native share sheet')
  assert.match(source, /accessibilityLabel="React to video"/, 'react action routes to the full player where reactions live')
  // The card surfaces real video metadata (duration) rather than fabricated counts.
  assert.match(source, /formatDuration\(video\.duration\)/, 'cards should show the real video duration')
  assert.doesNotMatch(source, /styles\.shortsActionText/, 'the tabular-num count text for fake metrics should be gone')
})

test('vertical discovery exposes minimal top and playback status affordances', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')

  assert.match(source, /styles\.shortsTopChrome/, 'shorts should have minimal top chrome for back and refresh')
  assert.match(source, /router\.back\(\)/, 'top chrome should expose a native back affordance')
  assert.match(source, /accessibilityLabel="Refresh Shorts feed"/, 'top chrome should expose refresh without browser chrome')
  assert.match(source, /styles\.shortsStatusBadge/, 'playback and degraded feed status should use a compact overlay badge')
  assert.match(source, /isActive=\{activeVideoKey === `\$\{video\.channelKey\}:\$\{video\.id\}` && !commentsSheetVisible\}/, 'comments sheet should pause active shorts playback instead of playing behind the sheet')
})

test('vertical discovery preserves a last-known-good cache across remounts and feed timeouts', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')
  const cacheSource = readAppFile('lib/discover-feed-cache.ts')

  assert.match(source, /readDiscoverFeedCache\(\)/, 'Discover should initialize from the route-local last-known-good cache')
  assert.match(source, /useState<FeedEntry\[\]>\(\(\) => \(cachedDiscoverFeed\?\.feedEntries \|\| \[\]\) as FeedEntry\[\]\)/, 'cached feed entries should seed route state before live P2P refresh')
  assert.match(source, /useState<VideoData\[\]>\(\(\) => \(cachedDiscoverFeed\?\.videos \|\| \[\]\) as VideoData\[\]\)/, 'cached videos should seed the vertical deck on remount')
  assert.match(source, /writeDiscoverFeedCache\(\{ feedEntries, videos \}\)/, 'known-good vertical cards should be cached while mounted')
  assert.match(source, /const timeoutToken = Symbol\('vertical-feed-timeout'\)/, 'public-feed timeouts should be non-authoritative')
  assert.match(source, /if \(result === timeoutToken\) \{[\s\S]*return[\s\S]*const entries = Array\.isArray/, 'timed-out feed refreshes must not overwrite cached entries with empty lists')
  assert.match(source, /const \[cacheRestoredOnly, setCacheRestoredOnly\] = useState\(\(\) => Boolean\(cachedDiscoverFeed\?\.videos\?\.length \|\| cachedDiscoverFeed\?\.feedEntries\?\.length\)\)/, 'Discover should track restored-only cache state')
  assert.match(source, /if \(cacheRestoredOnly \|\| \(videos\.length === 0 && feedEntries\.length === 0\)\) return/, 'restored-only cache state should not be immediately re-saved as fresh')
  assert.match(source, /if \(entries\.length > 0 && hasRichVerticalFeedSnapshot\(entries, \[\]\)\) setCacheRestoredOnly\(false\)/, 'fresh rich public-feed entries should clear restored-only state')
  assert.match(source, /if \(renderable\.length > 0\) setCacheRestoredOnly\(false\)/, 'fresh preview videos should clear restored-only state')
  assert.match(source, /if \(mapped\.length > 0\) setCacheRestoredOnly\(false\)/, 'fresh hydrated videos should clear restored-only state')
  assert.match(cacheSource, /const MAX_CACHE_AGE_MS = 30 \* 60 \* 1000/, 'vertical cache should be short-lived and route-local')
  assert.doesNotMatch(cacheSource, /videoUrl|shortsVideoUrl|url:/, 'vertical cache must not persist transient playback URLs')
})

test('vertical discovery hydrates beyond sparse previews without permanently poisoning timed-out channels', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')
  const hydrateBlock = source.slice(source.indexOf('const hydrateChannelVideos'), source.indexOf('const loadFeed'))

  assert.doesNotMatch(source, /entries\.slice\(0, 8\)/, 'shorts should not cap channel hydration to the first few feed entries')
  assert.match(source, /for \(const entry of mergedEntries\.slice\(0, 24\)\)/, 'shorts should fan out across enough feed channels to expose more than preview videos')
  assert.doesNotMatch(hydrateBlock, /hydratedChannelsRef\.current\.add\(hydrationKey\)[\s\S]*?const result = await withTimeout/, 'timed-out channel list calls must remain retryable')
  assert.match(hydrateBlock, /const timeoutToken = Symbol\('vertical-channel-timeout'\)/, 'channel hydration should distinguish timeout from an authoritative empty video list')
  assert.match(source, /if \(result === timeoutToken\) \{[\s\S]*setHydrationErrors[\s\S]*return[\s\S]*hydratedChannelsRef\.current\.add\(hydrationKey\)/, 'channel hydration should only mark the channel hydrated after a real response')
  assert.match(source, /\(result as any\)\?\.success === false \|\| \(result as any\)\?\.error/, 'failed channel list responses must not be treated as authoritative empty hydration')
  assert.match(source, /setHydrationErrors/, 'channel hydration failures should be represented in degraded UI state')
})

test('vertical discovery no longer prewarms upcoming playback URLs', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')
  const controllerSource = readAppFile('lib/discover-feed-controller.js')

  // Warming was removed: opening a short resolves-and-streams on demand, and
  // no upcoming videos are prefetched.
  assert.doesNotMatch(source, /warmNextPlaybackUrls/, 'shorts should not prewarm upcoming playback URLs')
  assert.doesNotMatch(source, /inflightPlaybackWarmups/, 'shorts should not keep playback warmup de-dupe state')
  assert.doesNotMatch(controllerSource, /warmNextPlaybackUrls/, 'controller should not expose a playback warmup helper')
})

test('Home Discover no longer prewarms visible feed playback URLs', () => {
  const source = readAppFile('app/(tabs)/index.tsx')

  assert.doesNotMatch(source, /warmPlaybackUrl/, 'Home should not prewarm visible feed playback URLs')
  assert.doesNotMatch(source, /inflightPlaybackWarmups/, 'Home should not keep playback warmup de-dupe state')
})

test('Home Discover does not show a peer-fetching badge from feed metadata alone', () => {
  const source = readAppFile('app/(tabs)/index.tsx')
  const playBlock = source.slice(source.indexOf('const playVideo = useCallback'), source.indexOf('// Legacy: Play video in overlay only'))
  const renderBlock = source.slice(source.indexOf('const renderVideoRow = useCallback'), source.indexOf('const renderChannelItem', source.indexOf('const renderVideoRow = useCallback')))

  assert.match(playBlock, /setPlaybackFetchState\(\{ key: playKey, message: 'Fetching video from peers…' \}\)/, 'Home may show a status badge only while an actual playback request is in flight')
  assert.doesNotMatch(renderBlock, /hasDirectBlobRef|isFeedVideoPlaybackReady|directBlobNotReady/, 'feed metadata should not synthesize a playback-blocking badge before the user requests playback')
  assert.doesNotMatch(renderBlock, /message: 'Fetching video from peers…'/, 'card rendering should not claim peer fetching without a playback request')
  assert.match(playBlock, /Could not prepare playback\. Try again shortly\.', isError: true/, 'hard preparation failures should still surface as errors')
})

test('Home Discover falls back to public feed RPC and labels feed entries separately from live peers', () => {
  const source = readAppFile('app/(tabs)/index.tsx')

  assert.match(source, /typeof rpc\.getCanonicalFeed === 'function'[\s\S]*rpc\.getPublicFeed\(\{\}\)/, 'Home should fall back when mobile backend only exposes getPublicFeed')
  assert.match(source, /const displayFeedEntries = Math\.max\([\s\S]*swarmStatus\?\.feedEntries \?\? 0,[\s\S]*feedEntries\.length/, 'Home should display backend feed-entry count separately')
  assert.match(source, />Feed: \{displayFeedEntries\}</, 'Home should label feed entries as Feed, not Peers')
  assert.match(source, />Peers: \{displayPeers\}</, 'Home should keep live peer/connection count under Peers')
  assert.doesNotMatch(source, />Peers: \{feedEntries\.length\}</, 'feed entries must never be shown as peer count')
})

test('vertical discovery subscribes to backend feed-update events instead of only loading once', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')

  assert.match(source, /platformEvents[,\s\S]*\} = useApp\(\)/, 'Discover should receive platform event hooks from app context')
  assert.match(source, /platformEvents as any\)\?\.onFeedUpdate\?\.\(\(\) => \{[\s\S]*?void loadFeed\(\)/, 'Discover should reload the vertical feed when backend gossip announces feed updates')
  assert.match(source, /if \(typeof unsubscribe === 'function'\) unsubscribe\(\)/, 'Discover should unsubscribe from feed events on unmount')
})

test('vertical discovery calls getFeedPreviewVideos through the controller with the shared feed-preview signature', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')
  const controllerSource = readAppFile('lib/discover-feed-controller.js')

  assert.match(source, /getVerticalFeedPreviewVideos\(entries as any, \{[\s\S]*identityDriveKey:[\s\S]*channelMeta:[\s\S]*limit: 40/, 'Shorts route should delegate preview extraction to the feed controller')
  assert.match(controllerSource, /getFeedPreviewVideos\(\s*visibleEntries,\s*channelMeta,\s*identityDriveKey,\s*limit,\s*\)/, 'controller should pass channelMeta, identityDriveKey, and limit separately')
  assert.doesNotMatch(controllerSource, /getFeedPreviewVideos\(visibleEntries, \{\s*identityDriveKey:/, 'controller should not pass an options object into the shared helper')
})


test('vertical discovery hides all card chrome, including progress, when tapped', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')
  const playerSource = readAppFile('components/discovery/VerticalShortsPlayer.tsx')

  assert.match(source, /const \[shortsChromeVisible, setShortsChromeVisible\] = useState\(true\)/, 'Discover should track whether Shorts chrome/buttons are visible')
  assert.match(source, /controlsVisible=\{shortsChromeVisible\}/, 'Discover should pass shared chrome visibility to the Shorts player')
  assert.match(source, /onControlsVisibleChange=\{setShortsChromeVisible\}/, 'Shorts player taps should update route chrome visibility')
  assert.match(source, /const shortsCardChrome = shortsChromeVisible \? \([\s\S]*styles\.bottomMeta/, 'card chrome should hide when Shorts controls are hidden')
  assert.match(source, /verticalVideos\.length > 0 && shortsChromeVisible \? \([\s\S]*styles\.shortsTopChrome/, 'top feed chrome should hide with Shorts controls')
  assert.match(playerSource, /toggleControlsVisibility/, 'Shorts player should toggle controls on tap')
  assert.match(playerSource, /onControlsVisibleChange\?\.\(!controlsVisible\)/, 'Shorts player should notify the parent when controls are toggled')
  assert.match(playerSource, /pointerEvents="box-none"/, 'overlay chrome must not swallow card taps outside actual controls')
  assert.match(playerSource, /style=\{styles\.centerControlButton\}/, 'play/pause should be centered higher on the video instead of taking space near the progress bar')
  assert.match(playerSource, /top: '34%'/, 'centered playback button should sit above the progress rail instead of crowding it')
  assert.match(playerSource, /progressDock:\s*\{[\s\S]*paddingHorizontal: 24/, 'progress bar should have visible side inset like X/Twitter instead of extending edge-to-edge')
  assert.match(playerSource, /progressRail:\s*\{[\s\S]*borderRadius: (?:2|999)/, 'progress rail should be lightly rounded like X/Twitter player chrome')
  assert.match(playerSource, /\(showPlayer \|\| isActive\) && controlsVisible \? \([\s\S]*styles\.progressDock/, 'progress should disappear with the rest of the Shorts chrome when tapped away')
  assert.doesNotMatch(playerSource, /styles\.controlButtons/, 'progress dock should not carry the play/pause controls anymore')
  assert.doesNotMatch(playerSource, /\{controlsVisible \? \([\s\S]*styles\.controlButtons/, 'buttons should no longer sit above the progress bar')
  assert.doesNotMatch(playerSource, /\(showPlayer \|\| isActive\) \? \([\s\S]*styles\.progressDock/, 'progress bar should not remain mounted after controls are hidden')
  assert.match(playerSource, /const showPoster = Boolean\(thumbnailUrl\)/, 'Shorts should keep poster imagery behind playback so black video frames are not visually empty')
  assert.match(playerSource, /const posterOpacity = showPlayer \? 0\.28 : 0\.58/, 'Shorts should dim but preserve posters while the inline player is active')
  assert.match(playerSource, /imageStyle=\{\[styles\.posterImage, \{ opacity: posterOpacity \}\]\}/, 'poster opacity should be dynamic instead of hidden once playback starts')
})

test('shorts player has functional playback buttons and a seekable progress bar', () => {
  const source = readAppFile('components/discovery/VerticalShortsPlayer.tsx')

  assert.match(source, /const \[isPaused, setIsPaused\] = useState\(false\)/, 'Shorts player should own local pause state')
  assert.match(source, /const \[playbackProgress, setPlaybackProgress\]/, 'Shorts player should track current time and duration')
  assert.match(source, /onProgress=\{handleProgress\}/, 'Shorts player should receive native progress events')
  assert.match(source, /seekPosition=\{seekPosition\}/, 'Shorts player should pass seek requests to the native inline player')
  assert.match(source, /accessibilityLabel=\{isPaused \? 'Play Shorts video' : 'Pause Shorts video'\}/, 'play/pause button should keep the existing accessible labels')
  assert.match(source, /playerRef\.current\?\.pause\?\.\(\)/, 'pause button should call the player port')
  assert.match(source, /playerRef\.current\?\.play\?\.\(\)/, 'play button should call the player port')
  assert.match(source, /playerRef\.current\?\.seek\?\.\(0\)/, 'restart button should seek to the beginning')
  assert.match(source, /handleProgressBarPress/, 'progress bar should handle tap-to-seek')
  assert.match(source, /accessibilityLabel="Shorts progress bar"/, 'progress bar should be accessible and testable')
})

test('shorts progress bar keeps prop seekPosition normalized while imperative seek uses seconds', () => {
  const source = readAppFile('components/discovery/VerticalShortsPlayer.tsx')
  const seekBlock = source.slice(source.indexOf('const handleProgressBarPress'), source.indexOf('const showPlayer'))

  assert.match(seekBlock, /const progress = clampProgress\(locationX \/ progressBarWidth\)/, 'tap position should be converted to a normalized 0..1 progress value')
  assert.match(seekBlock, /setSeekPosition\(progress\)/, 'PearInlineVideoView seekPosition prop expects a normalized ratio')
  assert.match(seekBlock, /playerRef\.current\?\.seek\?\.\(nextTime \/ 1000\)/, 'imperative player seek should still use seconds')
  assert.doesNotMatch(seekBlock, /setSeekPosition\(nextTime \/ 1000\)/, 'seconds must not be passed to the normalized seekPosition prop')
  assert.match(source, /pendingSeekMs/, 'pending seek completion should compare progress events using milliseconds, not the normalized ratio')
})

test('vertical discovery ignores stale preparePlayback completions after fast swipes', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')
  const playBlock = source.slice(source.indexOf('const playVideo = useCallback'), source.indexOf('useEffect(() => {\n    if (!activeVideo'))

  assert.match(source, /const playbackRequestSeqRef = useRef\(0\)/, 'Shorts playback should track request generations')
  assert.match(playBlock, /const requestSeq = \+\+playbackRequestSeqRef\.current/, 'each playback attempt should get a newer generation id')
  assert.match(playBlock, /pendingPlayKeyRef\.current !== playKey \|\| playbackRequestSeqRef\.current !== requestSeq/, 'stale async preparePlayback completions should be ignored')
  assert.match(playBlock, /if \(isStalePlaybackRequest\(\) \|\| !result\) return/, 'resolved stale playback URLs must not attach to the active card')
})

test('vertical discovery stabilizes card order across feed refreshes', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')
  const controllerSource = readAppFile('lib/discover-feed-controller.js')

  assert.match(source, /feedLoadInFlightRef/, 'Discover should ignore overlapping feed loads instead of racing state updates')
  assert.doesNotMatch(source, /hydratedChannelsRef\.current\.clear\(\)/, 'manual refresh should not clear hydrated channels and make cards disappear/reappear')
  assert.match(source, /mergeUniqueFeedVideos\(prev, renderable, 80\)/, 'preview feed merges should preserve existing card order through the controller')
  assert.match(source, /mergeUniqueFeedVideos\(prev, mapped, 80\)/, 'hydrated feed merges should preserve existing card order through the controller')
  assert.match(controllerSource, /for \(const video of \[\.\.\.\(previousVideos \|\| \[\]\), \.\.\.\(incomingVideos \|\| \[\]\)\]\)/, 'controller merge should consider existing videos before incoming videos')
  assert.match(source, /mergeVerticalFeedEntries\(prev, entries\)/, 'feed refreshes should merge by channel and preserve richer cached snapshots')
  assert.match(source, /hasRichVerticalFeedSnapshot\(feedEntries, videos\)/, 'cache writes and degraded state should be gated on rich snapshots')
  assert.match(source, /pruneHydratedFeedChannels\(hydratedChannelsRef, mergedEntries\)/, 'Discover should drop hydration keys absent from the canonical feed')
  assert.match(controllerSource, /getVerticalFeedHydrationKey/, 'hydration identity should include channel content signatures')
  assert.match(source, /feedError/, 'Discover should track feed errors separately from empty results')
  assert.match(source, /feedTimedOut/, 'Discover should expose feed timeout state')
  assert.match(source, /usingCachedSnapshot/, 'Discover should distinguish cached/degraded display from genuine empty feed')
})

test('vertical discovery updates feed entries when previews change without channel order changing', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')

  assert.match(source, /function getFeedEntrySignature\(entry: FeedEntry\)/, 'feed-entry signature helper should exist')
  assert.match(source, /previewVideos/, 'signature should include preview video state')
  assert.match(source, /blobId/, 'signature should include direct blob ids')
  assert.match(source, /blobsCoreKey/, 'signature should include direct blob core keys')
  assert.match(source, /prevSignature === nextSignature \? prev : mergedEntries/, 'unchanged signatures may preserve state, changed previews must update entries')
})

test('global overlay cast URL resolution preserves direct blob refs', () => {
  const source = readAppFile('components/VideoPlayerOverlayImpl.tsx')

  const directRefCastCalls = source.match(/rpc\.getVideoUrl\(\{[\s\S]*?publicBeeKey: currentVideoAny\.publicBeeKey,[\s\S]*?blobId: currentVideoAny\.blobId,[\s\S]*?blobsCoreKey: currentVideoAny\.blobsCoreKey,[\s\S]*?mimeType: currentVideo\.mimeType,[\s\S]*?\}\)/g) || []
  assert.equal(directRefCastCalls.length, 2, 'manual and auto cast URL resolution should pass direct playback refs')
})

test('vertical discovery keeps the global watch/mini overlay off the Shorts route', () => {
  const discoverSource = readAppFile('app/(tabs)/discover.tsx')
  const overlaySource = readAppFile('components/VideoPlayerOverlayImpl.tsx')

  assert.doesNotMatch(discoverSource, /setAmbientVideoContext|closeVideo\(\)|pauseVideo\(\)/, 'Shorts route should be completely separate from global watch player mutations')
  assert.match(overlaySource, /usePathname\(\)/, 'global overlay should know the active route')
  assert.match(overlaySource, /useSegments\(\)/, 'global overlay should inspect active route segments when pathname is group-normalized')
  assert.match(overlaySource, /const activeLeafSegment = segments\[segments\.length - 1\]/, 'mobile Discover suppression should inspect only the active leaf segment')
  assert.match(overlaySource, /activeLeafSegment === 'discover'/, 'mobile Discover suppression should still work when Expo Router normalizes pathname')
  assert.doesNotMatch(overlaySource, /segments\.includes\('discover'\)/, 'mobile Discover suppression must not hide Home/watch playback just because a parent navigator knows the Discover tab')
  assert.match(overlaySource, /const hideGlobalOverlayOnDiscover = !isDesktop && isDiscoverPathActive/, 'mobile Discover should suppress the global watch overlay')
  assert.match(overlaySource, /if \(!currentVideo \|\| playerMode === 'hidden'\) \{[\s\S]*return null/, 'hidden ambient Shorts metadata must not render global overlay tap surfaces on Home')
  assert.match(overlaySource, /if \(hideGlobalOverlayOnDiscover\) \{[\s\S]*return null/, 'Discover should suppress the global overlay entirely, including hidden ambient state tap surfaces')
  assert.doesNotMatch(overlaySource, /hideGlobalOverlayOnDiscover && playerMode !== 'hidden'/, 'Discover suppression must not let hidden ambient global overlay surfaces render behind Shorts chrome')
  assert.doesNotMatch(overlaySource, /hideGlobalOverlayOnDiscover && playerMode !== 'hidden' && !isInPipMode/, 'Discover suppression must include stale PiP mode, not exempt it')
  assert.match(discoverSource, /<ShortsCommentsSheet video=\{activeVideo \|\| null\}/, 'Shorts comments should receive route-local active video context')
})

test('vertical discovery preserves raw titles while constraining long-title layout', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')

  assert.doesNotMatch(source, /cleanDiscoverFilenameTitle|getDiscoverDisplayTitle/, 'Discover should not rewrite or clean user/video titles')
  assert.match(source, /<Text style=\{styles\.shortsPostText\} numberOfLines=\{2\} ellipsizeMode="tail">\{video\.title\}<\/Text>/, 'card post text should render the raw title and rely on UI truncation')
  assert.match(source, /bottomMeta:\s*\{[\s\S]*maxHeight: 238[\s\S]*overflow: 'hidden'/, 'metadata/action block should have a hard visual bound')
  assert.match(source, /metaTextBlock:\s*\{[\s\S]*flexShrink: 1/, 'long title text should shrink instead of pushing controls')
  assert.match(source, /videoTitle:\s*\{[\s\S]*flexShrink: 1/, 'raw title text should be layout-constrained, not mutated')
  assert.match(source, /shortsActionRow:\s*\{[\s\S]*flexShrink: 0/, 'status action row should remain visible even when titles are long')
})

test('vertical discovery positions progress and chrome without clumping metadata/actions', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')

  assert.match(source, /useTabBarMetrics\(\)/, 'Discover should read the measured bottom tab bar height')
  assert.match(source, /const bottomChromePadding = Math\.max\(tabBarMetrics\.height \+ 14, insets\.bottom \+ 86, 112\)/, 'Discover controls should clear the floating bottom tab bar and safe area')
  assert.match(source, /const metaBottomPadding = bottomChromePadding/, 'metadata should use the measured tab-safe offset directly')
  assert.match(source, /const progressBottomOffset = metaBottomPadding \+ 208/, 'progress should sit above the richer status metadata/action block')
  assert.match(source, /progressBottomOffset=\{progressBottomOffset\}/, 'Shorts progress should use the separated progress offset')
  assert.match(source, /paddingBottom: metaBottomPadding/, 'metadata should reserve its own larger bottom offset')
  assert.match(source, /!\/\^\\s\*source\\s\*:\/i\.test\(video\.description\)/, 'Discover should hide raw source URL descriptions from primary card chrome')
  assert.match(source, /numberOfLines=\{2\}>\{video\.description\}/, 'description/source copy should not grow into controls while playing')
  assert.match(source, /\{feedEntries\.length\} feeds/, 'feed count pill should label what the number means')
  assert.match(source, /styles\.topChromeFade/, 'header should have a subtle backing fade over active video')
  assert.match(source, /shortsActionRow:\s*\{[\s\S]*flexDirection: 'row'[\s\S]*gap: 10/, 'action buttons should use a tighter bottom row')
  assert.match(source, /accessibilityLabel="Open Shorts comments"/, 'comments action should stay compact and icon-first')
  assert.match(source, /shortsActionLabel:\s*\{[\s\S]*fontWeight: '700'/, 'action clusters should use short text labels, not fabricated counts')
  assert.match(source, /metaTextBlock:\s*\{[\s\S]*minWidth: 0/, 'metadata text should shrink instead of pushing into action controls')
  assert.match(source, /shortsActionCluster:\s*\{[\s\S]*minHeight: 36/, 'bottom action clusters should stay compact instead of heavy pill blocks')
  assert.match(source, /<Feather name="message-circle" color="#f4f7fb" size=\{20\}/, 'action icons should be smaller than oversized controls')
  assert.doesNotMatch(source, /progressBottomOffset=\{Math\.max\(insets\.bottom \+ 140, 158\)\}/, 'old low progress offset caused title/source overlap')
})

test('vertical discovery stops inline Shorts playback when the route unmounts or loses focus', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')

  assert.match(source, /useFocusEffect/, 'Discover should subscribe to route focus lifecycle')
  assert.match(source, /stopShortsPlayback/, 'Discover should centralize Shorts playback teardown')
  assert.match(source, /shortsPlayerRef\.current\?\.exitPictureInPicture\?\.\(\)/, 'teardown should force-exit any stale native PiP window before detaching Shorts')
  assert.match(source, /shortsPlayerRef\.current\?\.stop\?\.\(\)/, 'teardown should stop the native inline player instead of merely hiding React chrome')
  assert.match(source, /shortsPlayerRef\.current\?\.destroy\?\.\(\)/, 'teardown should destroy the route-local native surface so it cannot keep PiP alive')
  assert.doesNotMatch(source, /setAmbientVideoContext\(null, null\)/, 'teardown should not touch hidden ambient global player metadata')
  assert.match(source, /setShortsVideoUrl\(null\)/, 'teardown should detach the playback URL so the inline surface unmounts')
  assert.match(source, /return stopShortsPlayback/, 'Discover should run teardown when tab navigation leaves the Shorts route')
})

test('Shorts comments use route-local social state instead of the global watch-player social context', () => {
  const sheetSource = readAppFile('components/discovery/ShortsCommentsSheet.tsx')
  const hookSource = readAppFile('lib/shorts-social.ts')

  assert.match(sheetSource, /video: VideoData \| null/, 'Shorts comments sheet should accept the active Shorts video directly')
  assert.match(sheetSource, /useShortsSocial\(video\)/, 'Shorts comments should load social data from route-local Shorts state')
  assert.doesNotMatch(sheetSource, /useSocial\(/, 'Shorts comments should not consume global watch-player social context')
  assert.match(hookSource, /export function useShortsSocial\(video: VideoData \| null\)/, 'route-local Shorts social hook should be keyed by explicit video')
  assert.doesNotMatch(hookSource, /useVideoPlayerContext\(/, 'route-local Shorts social hook must not read global player context')
})

test('native inline player exposes explicit PiP exit and tears down its surface on destroy', () => {
  const source = readAppFile('components/video-player/PearInlineVideoView.tsx')
  const portSource = readAppFile('lib/video-player/playerPort.ts')

  assert.match(portSource, /exitPictureInPicture\?: \(\) => void \| Promise<void>/, 'PlayerPort should expose explicit PiP exit for route-local teardown')
  assert.match(source, /from 'expo-video'/, 'native inline player should use Expo Video on SDK 56')
  assert.match(source, /allowsPictureInPicture=\{autoEnterPipOnLeave\}/, 'Expo Video should keep PiP gated by route-local policy')
  assert.match(source, /startsPictureInPictureAutomatically=\{autoEnterPipOnLeave\}/, 'Expo Video should retain automatic PiP when enabled')
  assert.match(source, /exitPictureInPicture:\s*\(\) => \{[\s\S]*Expo Video PiP is controlled through VideoView props/, 'native inline player should bridge explicit PiP exit without react-native-video refs')
  assert.match(source, /destroy: async \(\) => \{[\s\S]*player\.pause\(\)[\s\S]*player\.showNowPlayingNotification = false[\s\S]*player\.staysActiveInBackground = false[\s\S]*player\.currentTime = 0[\s\S]*replaceAsync\(null\)[\s\S]*player\.replace\(null\)/, 'destroy should disable notification/background state and detach the Expo Video source so Android media sessions are released')
})

test('bottom tab screens pad scrollable content by the measured pill tab bar height', () => {
  const indexSource = readAppFile('app/(tabs)/index.tsx')
  const subscriptionsSource = readAppFile('app/(tabs)/subscriptions.tsx')
  const studioSource = readAppFile('app/(tabs)/studio.tsx')
  const downloadsSource = readAppFile('app/(tabs)/downloads.tsx')
  const settingsSource = readAppFile('app/(tabs)/settings.tsx')

  assert.match(subscriptionsSource, /<Redirect href="\/library\?tab=channels" \/>/, 'subscriptions is a redirect-only tab and should delegate padding to Library')
  assert.match(downloadsSource, /<Redirect href="\/library\?tab=downloads" \/>/, 'downloads is a redirect-only tab and should delegate padding to Library')
  assert.match(settingsSource, /<Redirect href="\/profile" \/>/, 'settings is a redirect-only tab and should delegate padding to Profile')

  for (const [label, source] of [
    ['home', indexSource],
    ['studio', studioSource],
  ]) {
    assert.match(source, /useTabBarMetrics\(/, `${label} should read measured tab bar metrics`)
    assert.match(source, /const bottomPadding = Math\.max\(tabBarMetrics\.height \+ 16, insets\.bottom \+ 16\)/, `${label} should reserve enough space for the floating pill nav`)
    assert.doesNotMatch(source, /paddingBottom:\s*insets\.bottom \+ (16|20|100)/, `${label} should not use hard-coded safe-area-only bottom padding`)
  }
})
