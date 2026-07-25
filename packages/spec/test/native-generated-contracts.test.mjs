import test from 'brittle'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const nativeRoot = path.join(repoRoot, 'packages/desktop-native')
const forbidden = /(?:get-public-feed|get-canonical-feed|refresh-feed|submit-to-feed|unpublish-from-feed|is-channel-published|event-feed-update|publicFeedDiscoveryJoined|GetPublicFeed|GetCanonicalFeed|RefreshFeed|SubmitToFeed|UnpublishFromFeed|IsChannelPublished|EventFeedUpdate)/

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function readBundleFiles(bundlePath) {
  const packed = fs.readFileSync(bundlePath)
  let headerStart = 0
  while (packed[headerStart] >= 0x30 && packed[headerStart] <= 0x39) headerStart += 1
  const headerLength = Number.parseInt(packed.toString('utf8', 0, headerStart), 10)
  const header = JSON.parse(packed.toString('utf8', headerStart, headerStart + headerLength))
  let payloadOffset = headerStart + headerLength
  const files = new Map()
  for (const [name, metadata] of Object.entries(header.files)) {
    files.set(name, packed.subarray(payloadOffset, payloadOffset + metadata.length))
    payloadOffset += metadata.length
  }
  return files
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

test('native host bundles embed the fresh generated schema and HRPC outputs', (t) => {
  const expectedSchema = fs.readFileSync(path.join(repoRoot, 'packages/spec/spec/schema/schema.json'))
  const expectedHrpc = fs.readFileSync(path.join(repoRoot, 'packages/spec/spec/hrpc/hrpc.json'))

  for (const fileName of ['native-host-sidecar.bundle', 'native-host-worklet.bundle']) {
    const files = readBundleFiles(path.join(nativeRoot, 'Resources/Generated', fileName))
    t.alike(files.get('/packages/spec/spec/schema/schema.json'), expectedSchema, `${fileName} embeds fresh schema JSON`)
    t.alike(files.get('/packages/spec/spec/hrpc/hrpc.json'), expectedHrpc, `${fileName} embeds fresh HRPC JSON`)

    const generatedText = [...files.entries()]
      .filter(([name]) => name.startsWith('/packages/spec/') || name.startsWith('/packages/host/'))
      .map(([, contents]) => contents.toString('utf8'))
      .join('\n')
    t.absent(forbidden.test(generatedText), `${fileName} removes legacy generated feed names`)
    forbidden.lastIndex = 0
    t.ok(generatedText.includes('@peartube/get-media-catalog'), `${fileName} includes media catalog command`)
    t.ok(generatedText.includes('@peartube/event-media-graph-update'), `${fileName} includes media graph event`)
  }
})
