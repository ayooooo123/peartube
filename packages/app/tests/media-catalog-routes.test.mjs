import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const appRoot = path.resolve(import.meta.dirname, '..')
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), 'utf8')
const routes = ['app/(tabs)/index.tsx', 'app/(tabs)/index.web.tsx', 'app/(tabs)/discover.tsx']
const forbidden = /publicFeed|PublicFeed|getPublicFeed|refreshFeed|submitToFeed|unpublishFromFeed|onFeedUpdate|FEED_UPDATED|publicFeedDiscoveryJoined/

test('native and web catalog routes share the paged media catalog view and navigate by entity id', () => {
  for (const route of routes) {
    const source = read(route)
    assert.match(source, /useMediaCatalog/)
    assert.match(source, /MediaCatalogView/)
    assert.match(source, /['"]\/collection\/\[id\]['"][\s\S]*['"]\/creator\/\[id\]['"][\s\S]*['"]\/media\/\[id\]['"]/)
    assert.match(source, /getMediaEntityRouteId\(item as any\)/)
    assert.match(source, /item:\s*encodeMediaEntityRouteParam\(item as any\)/)
    assert.doesNotMatch(source, forbidden)
    assert.doesNotMatch(source, /setInterval|setTimeout/)
  }
})

test('shared catalog hook wires graph updates, foreground refresh, and platform request spelling', () => {
  const hook = read('hooks/useMediaCatalog.ts')
  assert.match(hook, /rpc\.getMediaCatalog\(request\)/)
  assert.match(hook, /events\.onMediaGraphUpdate/)
  assert.match(hook, /controller\.handleGraphUpdate\(update\)/)
  assert.match(hook, /AppState\.addEventListener\(['"]change['"]/)
  assert.match(hook, /controller\.handleForeground\(\)/)
  assert.match(hook, /controller\.destroy\(\)[\s\S]*?\}, \[controller\]\)/)
  assert.match(hook, /if \(ready && controller\) void controller\.load\(\)[\s\S]*?\}, \[controller, ready\]\)/)
  assert.doesNotMatch(hook, forbidden)
  assert.doesNotMatch(hook, /setInterval|setTimeout/)
})

test('profile and native diagnostics have no global-feed controls or status', () => {
  for (const file of [
    'app/profile.tsx',
    'components/native-diagnostics/DiagnosticsPanel.native.tsx',
    'components/native-diagnostics/types.ts',
    'lib/store/appStore.tsx',
  ]) {
    assert.doesNotMatch(read(file), forbidden, file)
  }
})
