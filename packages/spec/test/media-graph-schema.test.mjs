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
