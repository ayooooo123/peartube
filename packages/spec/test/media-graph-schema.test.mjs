import test from 'brittle'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..', '..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('media graph schema registers bounded typed app-facing RPCs', (t) => {
  const schemaSource = read('packages/spec/schema.cjs')
  const codegen = read('packages/spec/lib/app-rpc-adapter-codegen.cjs')
  const schemaJson = JSON.parse(read('packages/spec/spec/schema/schema.json'))
  const hrpcJson = JSON.parse(read('packages/spec/spec/hrpc/hrpc.json'))

  const messageNames = new Set(schemaJson.schema.map((message) => message.name))
  const commandNames = new Set(hrpcJson.schema.map((entry) => entry.name.replace('@peartube/', '')))

  for (const command of [
    'get-media-entity',
    'get-media-collection',
    'get-media-collection-items',
    'get-media-agent',
    'get-agent-contributions',
    'get-publication-sources',
    'get-claim-provenance',
    'set-source-preference',
  ]) {
    t.ok(messageNames.has(command + '-request'), `${command} request registered`)
    t.ok(messageNames.has(command + '-response'), `${command} response registered`)
    t.ok(commandNames.has(command), `${command} command registered`)
    t.ok(codegen.includes(`'${command}'`), `${command} classified for app facade`)
  }

  const catalogCommand = hrpcJson.schema.find((entry) => entry.name === '@peartube/get-media-catalog')
  t.is(catalogCommand?.request?.name, '@peartube/media-page-request', 'catalog reuses the shared page request')
  t.is(catalogCommand?.response?.name, '@peartube/get-media-catalog-response', 'catalog has a typed response')
  t.ok(messageNames.has('get-media-catalog-response'), 'catalog response registered')
  t.ok(codegen.includes("'get-media-catalog'"), 'catalog classified for app facade')
  const catalogResponse = schemaJson.schema.find((entry) => entry.name === 'get-media-catalog-response')
  t.is(catalogResponse?.fields.find((field) => field.name === 'items')?.required, true, 'catalog items are required')

  for (const type of [
    'media-page-request',
    'media-entity-summary',
    'media-rendition-descriptor',
    'media-publication-source',
    'media-claim-provenance',
    'media-conflict-summary',
    'media-agent-summary',
    'media-contribution-summary',
  ]) {
    t.ok(messageNames.has(type), `${type} typed schema registered`)
  }

  t.ok(schemaSource.includes("{ name: 'limit', type: 'uint', required: false }"), 'pagination limit is explicit uint')
  t.ok(schemaSource.includes("{ name: 'limitProvided', type: 'bool', required: false }"), 'pagination limit presence is explicit')
  t.ok(schemaSource.includes("{ name: 'nextCursor', type: 'string', required: false }"), 'pagination cursor is explicit')
  t.ok(schemaSource.includes("{ name: 'errorCode', type: 'string', required: false }"), 'explicit error codes are present')
  t.ok(!schemaSource.includes("type: 'json'"), 'media graph contract does not add opaque json fields')
})

test('media graph event replaces legacy public feed contracts', (t) => {
  const schemaJson = JSON.parse(read('packages/spec/spec/schema/schema.json'))
  const hrpcJson = JSON.parse(read('packages/spec/spec/hrpc/hrpc.json'))
  const codegen = read('packages/spec/lib/app-rpc-adapter-codegen.cjs')

  const messages = new Map(schemaJson.schema.map((message) => [message.name, message]))
  const commands = new Map(hrpcJson.schema.map((entry) => [entry.name.replace('@peartube/', ''), entry]))
  const update = messages.get('event-media-graph-update')

  t.alike(
    update?.fields.map(({ name, type, required }) => ({ name, type, required })),
    [
      { name: 'revision', type: 'string', required: true },
      { name: 'changedCount', type: 'uint', required: true },
    ],
    'media graph update payload is exact',
  )
  t.is(
    commands.get('event-media-graph-update')?.request?.name,
    '@peartube/event-media-graph-update',
    'media graph update is registered as an HRPC event',
  )
  t.ok(codegen.includes("'event-media-graph-update'"), 'media graph event is platform-only')

  for (const legacyName of [
    'feed-entry-preview-video',
    'feed-live-stream',
    'feed-entry',
    'refresh-feed-request',
    'refresh-feed-response',
    'submit-to-feed-request',
    'submit-to-feed-response',
    'unpublish-from-feed-request',
    'unpublish-from-feed-response',
    'is-channel-published-request',
    'is-channel-published-response',
    'event-feed-update',
  ]) {
    t.absent(messages.get(legacyName), `${legacyName} message removed`)
  }
  const swarmStatusFields = new Set(messages.get('get-swarm-status-response')?.fields.map((field) => field.name) ?? [])
  for (const legacyField of ['feedConnections', 'feedEntries', 'directPeerDialJson']) {
    t.absent(swarmStatusFields.has(legacyField), `${legacyField} status field removed`)
  }
  for (const legacyCommand of [
    'refresh-feed',
    'submit-to-feed',
    'unpublish-from-feed',
    'is-channel-published',
    'event-feed-update',
  ]) {
    t.absent(commands.get(legacyCommand), `${legacyCommand} command removed`)
  }
})
