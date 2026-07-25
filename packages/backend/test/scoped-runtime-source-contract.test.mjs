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
  const cliRuntime = read('packages/cli/src/runtime.js')

  for (const forbidden of ['createNoopFeed', 'ctx.publicFeed', 'startBackendSeedPinBeforeDiscovery', 'blindPeering']) {
    t.is(orchestrator.includes(forbidden), false, `orchestrator excludes ${forbidden}`)
  }
  t.is(/const result\s*=\s*\{[\s\S]*?\n\s*publicFeed[,\n]/.test(orchestrator), false, 'backend result excludes publicFeed')
  t.ok(/\n\s*scopedNetwork,/.test(orchestrator), 'backend result exposes scopedNetwork')
  for (const method of universalMethods) {
    t.ok(runtime.includes(method), `runtime implements ${method}`)
    t.ok(api.includes('createScopedNetworkApi'), 'API composes scoped runtime methods')
  }
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
  t.ok(read('packages/backend/src/network/scoped-runtime.js').includes('Protomux.from(connection)'), 'production connection adapter uses Protomux')
})
