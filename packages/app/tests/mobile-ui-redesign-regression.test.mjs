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

test('mobile design tokens use the MediaStorm dark catalog system', () => {
  const source = readRepo('packages/core/src/utils/index.ts')

  // Supersedes the earlier violet-on-navy system. The product now adopts
  // MediaStorm's dark theme wholesale — an accent blue on a neutral near-black
  // with two solid lift steps — so these assertions pin the new palette rather
  // than the violet one they replace.
  assert.match(source, /primary:\s*'#3f66ff'/, 'primary accent should use the MediaStorm accent blue')
  assert.match(source, /accentSecondary:\s*'#ff9f1a'/, 'the amber secondary accent has to stay available for badges and warnings')
  assert.match(source, /onPrimary:\s*'#ffffff'/, 'text on accent fills has to be white to stay legible')
  assert.match(source, /bg:\s*'#0b0b0f'/, 'the base surface should be the neutral near-black')
  assert.match(source, /surface:\s*'#16161f'/, 'cards and panels sit one solid step above the base')
  assert.match(source, /surfaceBorder:\s*'#2b2f3c'/, 'separators are a solid subtle border, not a translucent white wash')
  assert.match(source, /overlayButton:\s*'rgba\(255, 255, 255, 0\.12\)'/, 'secondary actions over artwork need the button overlay fill')
  assert.doesNotMatch(source, /#a3e635|#bef264|#65a30d/, 'no lime tokens should survive the recolor')
  assert.doesNotMatch(source, /primary:\s*'#7b5bf5'/, 'the violet brand accent is fully replaced by the MediaStorm blue')
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

test('mobile home preserves resolved entity type and payload in detail navigation', () => {
  const source = readApp('app/(tabs)/index.tsx')

  for (const required of [
    'useMediaCatalog',
    'ConsumerHomeView',
    'onRefresh={() => { void catalog.refresh() }}',
    "item.entityKind === 'collection'",
    "item.entityKind === 'agent'",
    "'/collection/[id]'",
    "'/creator/[id]'",
    "'/media/[id]'",
    'encodeMediaEntityRouteParam(item',
    'getMediaEntityRouteId(item',
  ]) {
    assert.ok(source.includes(required), `Home should contain ${required}`)
  }
  assert.doesNotMatch(source, /getContentCatalog|preparePlayback|setInterval|setTimeout/)
})

test('permissionless media cards retain resolved graph signals', () => {
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
  ]) {
    assert.ok(sources.includes(required), `media cards should surface ${required}`)
  }
})
