import test from 'brittle'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(directory, '../../..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')

const universalMethods = [
  'followPublisher',
  'unfollowPublisher',
  'publishLocalPublisherCatalog',
  'resolveLocalPublisherCatalog',
  'retainAuthorizedRendition',
  'releaseAuthorizedRendition',
  'retainAuthorizedArchive',
  'releaseAuthorizedArchive',
  'publishBootstrapLocator',
  'listBootstrapLocators',
  'getScopedNetworkDiagnostics',
]

test('backend result and CLI-facing API use only the universal scoped network contract', (t) => {
  const orchestrator = read('packages/backend/src/orchestrator.js')
  const runtime = read('packages/backend/src/network/scoped-runtime.js')
  const api = read('packages/backend/src/api.js')
  const sessionRuntime = read('packages/backend/src/network/scoped-session-runtime.js')
  const purposeRuntimes = [
    read('packages/backend/src/network/bootstrap-locator-runtime.js'),
    read('packages/backend/src/network/scoped-feed-runtime.js'),
    read('packages/backend/src/network/publisher-catalog-runtime.js'),
    read('packages/backend/src/network/scoped-content-runtime.js'),
  ]
  const implementation = [runtime, sessionRuntime, ...purposeRuntimes].join('\n')
  const cliRuntime = read('packages/cli/src/runtime.js')

  for (const forbidden of ['createNoopFeed', 'ctx.publicFeed', 'startBackendSeedPinBeforeDiscovery', 'blindPeering']) {
    t.is(orchestrator.includes(forbidden), false, `orchestrator excludes ${forbidden}`)
  }
  t.is(/const result\s*=\s*\{[\s\S]*?\n\s*publicFeed[,\n]/.test(orchestrator), false, 'backend result excludes publicFeed')
  t.ok(/\n\s*scopedNetwork,/.test(orchestrator), 'backend result exposes scopedNetwork')
  for (const method of universalMethods) {
    t.ok(implementation.includes(method), `scoped modules implement ${method}`)
    t.ok(api.includes('createScopedNetworkApi'), 'API composes scoped runtime methods')
  }
  t.ok(
    orchestrator.includes('...scopedNetwork.listRetainedIndexServiceAdapters(Math.max(0, maximum - 1))'),
    'production verifier combines the local index with retained network services only when a client searches',
  )
  t.ok(sessionRuntime.includes('listRetainedIndexServiceAdapters'), 'session runtime owns the bounded index query adapters')
  t.is(cliRuntime.includes('publicFeed'), false, 'CLI-facing runtime type has no publicFeed result')
})

test('production transport has no global topic or unrestricted Corestore replication', (t) => {
  const sources = [
    read('packages/backend/src/storage.js'),
    read('packages/backend/src/orchestrator.js'),
    read('packages/backend/src/channel/pairer.js'),
  ].join('\n')
  for (const forbidden of [
    /PROTOCOL_NAME/,
    /PEARTUBE_NETWORK_TOPIC/,
    /store\.replicate\s*\(/,
    /createNoopFeed/,
  ]) t.is(forbidden.test(sources), false, String(forbidden))
  const runtime = read('packages/backend/src/network/scoped-runtime.js')
  const sessionRuntime = read('packages/backend/src/network/scoped-session-runtime.js')
  t.ok(sessionRuntime.includes('Protomux.from(connection)'), 'session connection adapter uses Protomux')
  t.is(runtime.includes('Protomux'), false, 'runtime facade contains no channel implementation')
  t.ok(runtime.includes("export * from './scoped-session-runtime.js'"), 'runtime facade exports the composed session runtime')
})

test('scoped runtime purpose seams own their handlers without duplicating the facade', (t) => {
  const facade = read('packages/backend/src/network/scoped-runtime.js')
  const seams = {
    bootstrap: read('packages/backend/src/network/bootstrap-locator-runtime.js'),
    feeds: read('packages/backend/src/network/scoped-feed-runtime.js'),
    publisher: read('packages/backend/src/network/publisher-catalog-runtime.js'),
    content: read('packages/backend/src/network/scoped-content-runtime.js'),
  }
  const networkIndex = read('packages/backend/src/network/index.js')
  t.ok(seams.bootstrap.includes('handleBootstrapFrame'), 'bootstrap seam owns locator ingestion')
  t.ok(seams.feeds.includes('handleFeedFrame'), 'feed seam owns bounded feed frames')
  t.ok(seams.publisher.includes('syncPublisherCatalog'), 'publisher seam owns catalog synchronization')
  t.ok(seams.content.includes('handleAssetFrame') && seams.content.includes('handleArchiveFrame'), 'content seam owns asset and archive adapters')
  for (const handler of ['handleBootstrapFrame', 'handleFeedFrame', 'syncPublisherCatalog', 'handleAssetFrame', 'handleArchiveFrame']) {
    t.is(facade.includes(handler), false, `facade does not duplicate ${handler}`)
  }
  for (const factory of ['createBootstrapLocatorRuntime', 'createScopedFeedRuntime', 'createPublisherCatalogRuntime', 'createScopedContentRuntime']) {
    t.ok(networkIndex.includes(factory), `network index exports ${factory}`)
  }
})
