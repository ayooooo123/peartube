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

test('mobile design tokens move away from Twitch purple toward the PearTube pear-green premium dark system', () => {
  const source = readRepo('packages/core/src/utils/index.ts')

  assert.match(source, /primary:\s*'#a3e635'/, 'primary accent should use the pear-green brand token instead of the old saturated Twitch purple')
  assert.match(source, /bg:\s*'#0a0c0a'/, 'mobile surface should use the current green-tinted near-black base')
  assert.match(source, /surfaceBorder:\s*'rgba\(255,255,255,0\.08\)'/, 'surface borders should use translucent dark-mode-native separators')
  assert.doesNotMatch(source, /primary:\s*'#9147ff'/, 'old Twitch purple should not remain as the primary brand color')
})

test('native video cards use premium app-native surfaces and cover thumbnails', () => {
  const cardSource = readApp('components/video/VideoCard.tsx')
  const thumbnailSource = readApp('components/video/ThumbnailImage.tsx')

  assert.match(cardSource, /styles\.surface/, 'native VideoCard should wrap content in a deliberate surface')
  assert.match(cardSource, /styles\.thumbnailFrame/, 'native VideoCard should give thumbnails a controlled framed media area')
  assert.match(cardSource, /borderColor:\s*colors\.glassBorder/, 'VideoCard surface should use the shared subtle glass-border token')
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

test('channel page presents a polished mobile-native hero and named catalog section', () => {
  const source = readApp('app/channel/[key].tsx')

  assert.match(source, /const channelVideoCountText =/, 'channel page should compute a concise video-count label')
  assert.match(source, /styles\.hero/, 'channel page should use a designed hero block instead of a plain row')
  assert.match(source, /styles\.videoCountPill/, 'channel page should show count/context in a restrained pill')
  assert.match(source, /styles\.tabRow/, 'channel catalog should expose named content tabs')
  assert.match(source, /accessibilityRole="tab"/, 'channel catalog tabs should be semantic native tabs')
  assert.match(source, /styles\.sectionHeading/, 'channel content should have a named section heading')
  assert.match(source, /style=\{styles\.sectionTitle\}>\{selectedTab\?\.sectionLabel \|\| 'Latest'\}/, 'selected catalog tab should label the active content section')
})

test('media cockpit components stay presentational', () => {
  const componentPaths = [
    'components/media/NetworkStatusPill.tsx',
    'components/media/HeroFeatureCard.tsx',
    'components/media/MediaRail.tsx',
    'components/media/MediaPosterCard.tsx',
    'components/media/EpisodeCard.tsx',
    'components/media/index.ts',
  ]
  const sources = componentPaths.map((componentPath) => readApp(componentPath)).join('\n')

  assert.doesNotMatch(
    sources,
    /preparePlayback|getContentCatalog|rpc\./,
    'media cockpit components should not call playback preparation, catalog RPC, or raw rpc clients',
  )
  assert.doesNotMatch(
    sources,
    /router\.push|useRouter/,
    'media cockpit components should receive parent callbacks instead of routing directly',
  )
  assert.match(
    sources,
    /ThumbnailImage/,
    'media cockpit cards should reuse the existing thumbnail renderer',
  )
})


test('media cockpit cards surface permissionless media graph signals', () => {
  const sources = [
    'components/media/HeroFeatureCard.tsx',
    'components/media/MediaPosterCard.tsx',
    'components/media/EpisodeCard.tsx',
  ].map((componentPath) => readApp(componentPath)).join('\n')

  for (const required of [
    'posterUrl',
    'backdropUrl',
    'stillUrl',
    'sourceCount',
    'sourceProviderName',
    'archiveStatus',
    'availabilityStatus',
    'conflicts',
    'provenance',
    'localEntityId',
    'publicationId',
    'Permissionless media CDN',
    'Play selected source',
  ]) {
    assert.ok(sources.includes(required), `media cockpit cards should surface ${required}`)
  }
})

test('mobile home media cockpit preserves playback, channel, and refresh paths', () => {
  const source = readApp('app/(tabs)/index.tsx')

  for (const required of [
    'buildMediaHubSections',
    'HeroFeatureCard',
    'MediaRail',
    'MediaPosterCard',
    'EpisodeCard',
    "{ type: 'collections' }",
    "{ type: 'creators' }",
    'mediaHub.collections.items',
    'mediaHub.creators.items',
    'getMediaHubSourceItem',
    'playMediaHubItem',
    'rpc.preparePlayback(playbackRequest)',
    'loadAndPlayVideo(video, result.url)',
    'onPress={refreshFeed}',
    'Recently from the swarm',
  ]) {
    assert.ok(source.includes(required), `Home should contain ${required}`)
  }
  assert.doesNotMatch(source, /getContentCatalog\(/, 'Home should not add catalog fetches for Slice 1 media cockpit rails')
  assert.doesNotMatch(source, /getRecommendations/, 'Home should not add recommendation RPC fetches for Slice 1 media cockpit rails')
})

test('mobile home media cockpit playback helper preserves videoId playback identity', () => {
  const source = readApp('app/(tabs)/index.tsx')
  const mapper = readApp('lib/media-hub.js')

  assert.ok(source.includes('getMediaHubPlayableSourceItem'), 'mobile Home should import the shared playable-source adapter')
  assert.match(
    source,
    /return getMediaHubPlayableSourceItem\(item\)/,
    'media hub playback helper should delegate normalized source unwrapping to the shared adapter',
  )
  assert.match(
    source,
    /playVideo\(getMediaHubSourceItem\(item\)\)/,
    'media cockpit playback should go through the source normalizer before playVideo',
  )
  assert.match(
    mapper,
    /source\.videoId,[\s\S]*source\.path,[\s\S]*source\.id,[\s\S]*selectedSource \? null : item\?\.videoId/,
    'shared adapter should prefer selected source video/path/id before legacy item id fallbacks',
  )
})

test('Task 18 media entity routes expose inspectable source and provenance panels', () => {
  const home = readApp('app/(tabs)/index.tsx')
  const mediaRoute = readApp('app/media/[id].tsx')
  const collectionRoute = readApp('app/collection/[id].tsx')
  const creatorRoute = readApp('app/creator/[id].tsx')
  const detail = readApp('components/media/MediaEntityDetailScreen.tsx')
  const sourceSelector = readApp('components/media/SourceSelector.tsx')
  const provenancePanel = readApp('components/media/ProvenancePanel.tsx')
  const conflictNotice = readApp('components/media/ConflictNotice.tsx')
  const archiveStatus = readApp('components/media/ArchiveStatus.tsx')

  for (const required of [
    "openMediaEntityPage(hero, 'media')",
    "openMediaEntityPage(mediaItem, 'collection')",
    "openMediaEntityPage(mediaItem, 'creator')",
    'encodeMediaEntityRouteParam',
    'getMediaEntityRouteId',
    "onDetailsPress={() => openMediaEntityPage(hero, 'media')}",
    'onChannelPress={() => openMediaHubChannel(hero)}',
  ]) {
    assert.ok(home.includes(required), `mobile Home should wire entity navigation through ${required}`)
  }
  assert.ok(mediaRoute.includes('type="media"'), 'media route should render media entity detail screen')
  assert.ok(collectionRoute.includes('type="collection"'), 'collection route should render collection entity detail screen')
  assert.ok(creatorRoute.includes('type="creator"'), 'creator route should render creator entity detail screen')
  for (const required of [
    'SourceSelector',
    'ProvenancePanel',
    'ConflictNotice',
    'ArchiveStatus',
    'useLocalSearchParams',
    'fallbackItemForRoute',
    'onSelectSource={(source) => setSelectedSourceKey(sourceIdentityKey(source))}',
    'candidateSourcesForItem',
    'fallbackItemForRoute',
    'CollectionStructurePanel',
    'CreatorContributionsPanel',
  ]) {
    assert.ok(detail.includes(required), `entity detail route should include ${required}`)
  }
  assert.ok(sourceSelector.includes('Playable publications and renditions'), 'SourceSelector should expose playable publications')
  assert.ok(sourceSelector.includes('onPress={() => onSelectSource?.(source)}'), 'SourceSelector should wire source presses to the selected-source callback')
  assert.ok(provenancePanel.includes('Publisher claims'), 'ProvenancePanel should expose publisher claims')
  assert.ok(conflictNotice.includes('Conflict notice'), 'ConflictNotice should expose metadata conflicts')
  assert.ok(archiveStatus.includes('Archive status'), 'ArchiveStatus should expose archive evidence')
})
