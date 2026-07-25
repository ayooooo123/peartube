import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const appRoot = path.resolve(import.meta.dirname, '..')
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), 'utf8')
const stale = /onFeedUpdate|eventFeedUpdate|publicFeedDiscoveryJoined|refreshPublishedChannelFeed|submitToFeed|unpublishFromFeed|publicFeed/

test('mobile backend forwards graph revisions without global refresh timers or caches', () => {
  const source = read('backend/index.mjs')
  assert.match(source, /onMediaGraphUpdate:\s*\(update\) => \{/)
  assert.match(source, /rpc\?\.eventMediaGraphUpdate\?\.\(\{[\s\S]*revision: update\.revision,[\s\S]*changedCount: update\.changedCount/)
  assert.doesNotMatch(source, stale)
  assert.doesNotMatch(source, /feedRefreshInterval|persistFeedCache|requestFeedsFromPeers|setInterval/)
})

test('desktop worker forwards graph updates and retains scoped network diagnostics only', () => {
  const source = read('workers/desktop/index.ts')
  assert.match(source, /onMediaGraphUpdate:\s*\(update: \{ revision: string; changedCount: number \}\) => \{/)
  assert.match(source, /_rpc\?\.eventMediaGraphUpdate\?\.\(\{ revision: update\.revision, changedCount: update\.changedCount \}\)/)
  assert.match(source, /const scopedDiagnostics = scopedNetwork\?\.getDiagnostics\?\.\(\) \|\| null/)
  assert.match(source, /networkJson: scopedDiagnostics \? JSON\.stringify\(scopedDiagnostics\) : null/)
  assert.match(source, /recommendedBoundary: s\.recommendedBoundary \|\| s\.doctor\?\.recommendedBoundary \|\| null/)
  assert.doesNotMatch(source, stale)
  assert.doesNotMatch(source, /feedConnections:|feedEntries:/)
})

test('native diagnostics present scoped topics and sessions without global-feed counters', () => {
  const source = read('components/native-diagnostics/DiagnosticsPanel.native.tsx')
  const types = read('components/native-diagnostics/types.ts')
  assert.match(source, /Scoped topics/)
  assert.match(source, /Scoped sessions/)
  assert.match(source, /network\?\.topics/)
  assert.match(types, /topics\?: ScopedNetworkTopic\[\]/)
  assert.match(types, /sessions\?: ScopedNetworkSession\[\]/)
  assert.doesNotMatch(source, /feedConnections|lastHaveFeed|Feed links|gossip/i)
  assert.doesNotMatch(types, /feedConnections|feedEntries/)
})
