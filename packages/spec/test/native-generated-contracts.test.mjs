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
  const hrpc = read('packages/desktop-native/Sources/Support/GeneratedHRPC.swift')

  t.absent(forbidden.test(schema), 'Swift message codecs remove legacy feed types and status fields')
  forbidden.lastIndex = 0
  t.absent(forbidden.test(hrpc), 'Swift HRPC removes legacy feed methods and events')
  t.ok(schema.includes('public struct MediaPageRequest'), 'Swift schema includes shared media page request')
  t.ok(schema.includes('public struct MediaEntitySummary'), 'Swift schema includes media entity summary')
  t.ok(schema.includes('public struct GetMediaCatalogResponse'), 'Swift schema includes catalog response')
  t.ok(schema.includes('public struct EventMediaGraphUpdate'), 'Swift schema includes graph update event')
  t.ok(hrpc.includes('public func getMediaCatalog('), 'Swift HRPC exposes catalog request')
  t.ok(hrpc.includes('public func eventMediaGraphUpdate('), 'Swift HRPC exposes graph update event')
  t.ok(hrpc.includes('public func onEventMediaGraphUpdate('), 'Swift HRPC receives graph update events')
})

