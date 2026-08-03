import test from 'brittle'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const forbidden = /(?:get-public-feed|get-canonical-feed|refresh-feed|submit-to-feed|unpublish-from-feed|is-channel-published|event-feed-update|publicFeedDiscoveryJoined|GetPublicFeed|GetCanonicalFeed|RefreshFeed|SubmitToFeed|UnpublishFromFeed|IsChannelPublished|EventFeedUpdate)/

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}


test('quarantined Swift codecs mirror the media catalog cutover without feed compatibility', (t) => {
  const schema = read('packages/desktop-native/Sources/Support/GeneratedSchema.swift')
  const packageSchema = read('packages/spec/spec/swift-schema/Sources/Schema.swift')
  const hrpc = read('packages/desktop-native/Sources/Support/GeneratedHRPC.swift')

  t.absent(forbidden.test(schema), 'Swift message codecs remove legacy feed types and status fields')
  forbidden.lastIndex = 0
  t.absent(forbidden.test(hrpc), 'Swift HRPC removes legacy feed methods and events')
  t.ok(schema.includes('public struct MediaPageRequest'), 'Swift schema includes shared media page request')
  t.ok(schema.includes('public struct MediaEntitySummary'), 'Swift schema includes media entity summary')
  t.ok(schema.includes('public struct GetMediaCatalogResponse'), 'Swift schema includes catalog response')
  t.ok(schema.includes('public struct EventMediaGraphUpdate'), 'Swift schema includes graph update event')
  t.ok(schema.includes('public struct MediaSourceCoordinates'), 'Swift schema includes provider coordinates')
  t.ok(schema.includes('public var mediaCoordinates: MediaSourceCoordinates?'), 'Swift publication sources carry coordinates')
  t.ok(schema.includes('flags |= 268435456'), 'Swift source flags remain below the 32-bit overflow boundary')
  t.is(schema, packageSchema, 'desktop and package Swift schema mirrors stay identical')
  t.ok(hrpc.includes('public func getMediaCatalog('), 'Swift HRPC exposes catalog request')
  t.ok(hrpc.includes('public func eventMediaGraphUpdate('), 'Swift HRPC exposes graph update event')
  t.ok(hrpc.includes('public func onEventMediaGraphUpdate('), 'Swift HRPC receives graph update events')
})

// The Swift mirrors carry hand-maintained numeric command ids. Removing a
// command renumbers every later one, so a stale mirror would silently dispatch
// the wrong handler on a native client.
test('quarantined Swift HRPC command ids match the generated id table', (t) => {
  const generated = read('packages/spec/spec/hrpc/index.js')
  const ids = new Map(
    [...generated.matchAll(/\['(@peartube\/[a-z0-9-]+)',\s*(\d+)\]/g)].map(([, command, id]) => [command, Number(id)]),
  )
  t.ok(ids.size > 100, 'the generated id table was parsed')

  for (const relativePath of [
    'packages/desktop-native/Sources/Support/GeneratedHRPC.swift',
    'packages/spec/spec/swift-hrpc/Sources/HRPC.swift',
  ]) {
    const source = read(relativePath)
    const cases = [...source.matchAll(/case (\d+):\s*\/\/ (@peartube\/[a-z0-9-]+)/g)]
    t.ok(cases.length > 100, `${relativePath} dispatches the command surface`)
    const mismatched = cases
      .filter(([, id, command]) => ids.get(command) !== Number(id))
      .map(([, id, command]) => `${command}=${id} (expected ${ids.get(command)})`)
    t.alike(mismatched, [], `${relativePath} command ids match the generated table`)
    t.absent(/@peartube\/(log-watch-event|get-recommendations|get-video-recommendations)/.test(source),
      `${relativePath} exposes no watch-event telemetry or server-side recommendations`)
    t.ok(source.includes('@peartube/redeem-personal-device-invite'),
      `${relativePath} carries personal-store device pairing`)
  }
})

