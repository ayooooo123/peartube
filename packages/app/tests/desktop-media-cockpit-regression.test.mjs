import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

function readApp(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

test('desktop Home imports and renders the media cockpit instead of only the legacy grids', () => {
  const source = readApp('app/(tabs)/index.web.tsx')

  for (const required of [
    'buildMediaHubSections',
    'DesktopMediaHero',
    'DesktopMediaStats',
    'DesktopMediaEvidencePanel',
    'DesktopMediaRail',
    'PERMISSIONLESS MEDIA CDN',
    'A media graph, not a feed',
    'Publisher + asset topics',
    'getMediaHubSourceSummary',
    'getMediaHubArchiveSummary',
    'SourceSelector',
    'ProvenancePanel',
    'ConflictNotice',
    'ArchiveStatus',
    'MediaFallbackArtwork',
    'mediaHubSections.featured.item',
    'desktopMediaRails.map',
    'playMediaHubItem',
    'openMediaHubChannel',
    'Recently from the swarm',
    '<VideoGrid',
    'mediaCockpitShell:',
    'mediaHero:',
    'mediaEvidenceGrid:',
    'mediaRailSection:',
    'mediaPosterCard:',
  ]) {
    assert.ok(source.includes(required), `desktop Home should contain ${required}`)
  }
})

test('desktop media cockpit preserves existing playback, channel, and feed refresh contracts', () => {
  const source = readApp('app/(tabs)/index.web.tsx')

  assert.ok(source.includes('getMediaHubPlayableSourceItem'), 'desktop cockpit should import the shared playable-source adapter')
  assert.match(
    source,
    /return getMediaHubPlayableSourceItem\(item, \{ fallbackChannelKey: identity\?\.driveKey \|\| '' \}\) as VideoData/,
    'desktop cockpit playback helper should delegate selected-source unwrapping while preserving desktop fallback channel identity',
  )
  assert.match(
    source,
    /playVideo\(getMediaHubSourceItem\(item\)\)/,
    'desktop cockpit rail taps should still route through existing playVideo',
  )
  assert.match(
    source,
    /window\.location\.hash = `\/watch\/\$\{encodeURIComponent\(channelKey\)\}\/\$\{encodeURIComponent\(video\.id\)\}`/,
    'desktop playback should keep the existing hash-based watch route',
  )
  assert.match(source, /await rpc\.refreshFeed\(\{\}\)/, 'feed refresh should keep using the existing desktop feed refresh path')
  assert.doesNotMatch(source, /getContentCatalog\(/, 'desktop cockpit should not add catalog RPC fetches')
  assert.doesNotMatch(source, /getRecommendations/, 'desktop cockpit should not add recommendation RPC fetches')
})


test('desktop cockpit should render inspectable media evidence without new RPC dependencies', () => {
  const source = readApp('app/(tabs)/index.web.tsx')

  for (const required of [
    '<DesktopMediaEvidencePanel item={mediaHubSections.featured.item} />',
    'getDesktopEvidenceSources',
    'Playable publications',
    'Publisher claims',
    'No archive evidence yet',
    'unresolved metadata conflict',
  ]) {
    assert.ok(source.includes(required), `desktop evidence panel should contain ${required}`)
  }
  assert.doesNotMatch(source, /getMediaGraph\(/, 'desktop evidence panel should not add a new graph RPC fetch')
  assert.doesNotMatch(source, /resolveMediaEntity\(/, 'desktop evidence panel should not add a new entity-resolution RPC fetch')
})


test('desktop collection and creator rails route to entity pages while playable rails keep playback', () => {
  const source = readApp('app/(tabs)/index.web.tsx')

  assert.ok(source.includes('openMediaEntityPage'), 'desktop Home should define entity-page routing for non-playable graph rails')
  assert.ok(source.includes("interface EntityRoute"), 'desktop hash parser should model entity routes')
  assert.match(source, /parts\[0\] === 'media' \|\| parts\[0\] === 'collection' \|\| parts\[0\] === 'creator'/, 'desktop hash parser should recognize media, collection, and creator entity hashes')
  assert.ok(source.includes('<MediaEntityDetailScreen'), 'desktop entity hashes should render the shared entity detail surface')
  assert.match(source, /if \(rail\.id === 'collections'\) openMediaEntityPage\(item, 'collection'\)/, 'collections rail should open collection entity pages')
  assert.match(source, /else if \(rail\.id === 'creators'\) openMediaEntityPage\(item, 'creator'\)/, 'creators rail should open creator entity pages')
  assert.match(source, /else playMediaHubItem\(item\)/, 'playable media rails should keep selected-source playback')
  assert.match(source, /window\.location\.hash = `#\/\$\{entityType\}\/\$\{encodeURIComponent\(id\)\}\?item=\$\{encodedItem\}`/, 'entity pages should be addressable through hash routes with serialized graph payloads')
})
