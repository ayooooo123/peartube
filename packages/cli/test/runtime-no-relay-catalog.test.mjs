import test from 'brittle'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const runtimeSource = readFileSync(join(here, '../src/runtime.js'), 'utf8')

test('relay runtime publishes cached relay inventory as relay catalog feed entries', (t) => {
  t.ok(runtimeSource.includes('publicFeed.setFeedSnapshotProvider'), 'relay feed snapshot provider should be installed')
  t.ok(runtimeSource.indexOf('publicFeed.setFeedSnapshotProvider') < runtimeSource.indexOf('await publicFeed.start()'), 'snapshot provider should be installed before public feed start')
  t.ok(runtimeSource.includes('publicFeed.setAvailabilityHintProvider'), 'relay availability provider should be installed')
  t.ok(runtimeSource.indexOf('publicFeed.setAvailabilityHintProvider') < runtimeSource.indexOf('await publicFeed.start()'), 'availability provider should be installed before public feed start')
  t.ok(runtimeSource.includes('submitRelayCatalogEntry'), 'relay runtime should publish relay cache entries through the relay catalog feed path')
  t.ok(runtimeSource.includes('relayRole'), 'relay catalog entries should preserve relay role')
  t.ok(runtimeSource.includes('relayServing: false'), 'relay catalog cache defaults should not self-assert relay serving')
})

test('relay runtime requires real P2P networking at storage startup', (t) => {
  t.ok(runtimeSource.includes('requireNetwork: true'), 'relay runtime should not start on the offline no-op swarm')
})
