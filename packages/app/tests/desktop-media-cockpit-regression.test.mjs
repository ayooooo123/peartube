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
    'DesktopMediaRail',
    'mediaHubSections.featured.item',
    'desktopMediaRails.map',
    'playMediaHubItem',
    'openMediaHubChannel',
    'Recently from the swarm',
    '<VideoGrid',
    'mediaCockpitShell:',
    'mediaHero:',
    'mediaRailSection:',
    'mediaPosterCard:',
  ]) {
    assert.ok(source.includes(required), `desktop Home should contain ${required}`)
  }
})

test('desktop media cockpit preserves existing playback, channel, and feed refresh contracts', () => {
  const source = readApp('app/(tabs)/index.web.tsx')

  assert.match(
    source,
    /const id = source\?\.id \|\| source\?\.videoId \|\| item\?\.id \|\| item\?\.videoId/,
    'desktop cockpit playback helper should map videoId-shaped entries into the id shape used by playVideo',
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
