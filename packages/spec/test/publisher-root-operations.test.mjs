import test from 'brittle'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const specRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(specRoot, '..', '..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('publisher root schema exposes typed catalog provision and single-use signing RPCs', (t) => {
  const schema = read('packages/spec/schema.cjs')
  const codegen = read('packages/spec/lib/app-rpc-adapter-codegen.cjs')
  const handlers = read('packages/backend/src/hrpc-handlers.js')

  for (const name of [
    'provision-publisher-catalog-request',
    'provision-publisher-catalog-response',
    'prepare-publisher-root-operation-request',
    'prepare-publisher-root-operation-response',
    'submit-publisher-root-operation-request',
    'submit-publisher-root-operation-response',
  ]) {
    t.ok(schema.includes(`name: '${name}'`), `${name} schema is registered`)
  }

  t.ok(schema.includes("name: 'provision-publisher-catalog'"), 'provision command registered')
  t.ok(schema.includes("name: 'prepare-publisher-root-operation'"), 'prepare command registered')
  t.ok(schema.includes("name: 'submit-publisher-root-operation'"), 'submit command registered')
  t.ok(schema.includes("{ name: 'unsignedBytes', type: 'buffer', required: true }"), 'prepared response carries exact canonical bytes')
  t.ok(schema.includes("{ name: 'candidateRecordId', type: 'buffer', required: true }"), 'prepared response carries candidate record id')
  t.ok(schema.includes("{ name: 'displaySummaryJson', type: 'string', required: false }"), 'summary is data, not signature authority')
  t.ok(schema.includes("{ name: 'signature', type: 'buffer', required: true }"), 'submit request carries shell signature bytes')
  t.ok(schema.includes("{ name: 'genesisRootKey', type: 'buffer', required: true }"), 'provision binds the genesis root')
  t.ok(schema.includes("{ name: 'localWriterKey', type: 'buffer', required: true }"), 'provision returns the local Autobase writer')
  t.ok(schema.includes("{ name: 'localSignerKey', type: 'buffer', required: true }"), 'provision returns the bounded device signer key')
  t.ok(schema.includes("{ name: 'writable', type: 'bool', required: true }"), 'provision proves catalog writability')
  t.ok(schema.includes("{ name: 'namespaceInitialized', type: 'bool', required: true }"), 'provision reports namespace initialization')
  t.ok(schema.includes("{ name: 'admitted', type: 'bool', required: true }"), 'provision reports local device admission')
  t.ok(schema.includes("{ name: 'intentId', type: 'string', required: true }"), 'prepare and submit carry the shell intent id')
  t.ok(schema.includes("{ name: 'intentExpiresAt', type: 'uint', required: true }"), 'UI intent expiry is separate transport state')
  t.ok(schema.includes("{ name: 'complete', type: 'bool', required: true }"), 'submit reports transition accumulation completion')

  t.ok(codegen.includes("'provision-publisher-catalog'"), 'provision method classified in publisher namespace')
  t.ok(codegen.includes("'prepare-publisher-root-operation'"), 'prepare method classified in publisher namespace')
  t.ok(codegen.includes("'submit-publisher-root-operation'"), 'submit method classified in publisher namespace')
  t.ok(handlers.includes("'ProvisionPublisherCatalog'"), 'provision shared handler registered')
  t.ok(handlers.includes("'PreparePublisherRootOperation'"), 'prepare shared handler registered')
  t.ok(handlers.includes("'SubmitPublisherRootOperation'"), 'submit shared handler registered')
})
