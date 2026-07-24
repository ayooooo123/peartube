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

test('publisher root operation schema exposes bounded prepare and submit RPCs', (t) => {
  const schema = read('packages/spec/schema.cjs')
  const codegen = read('packages/spec/lib/app-rpc-adapter-codegen.cjs')
  const handlers = read('packages/backend/src/hrpc-handlers.js')

  for (const name of [
    'prepare-publisher-root-operation-request',
    'prepare-publisher-root-operation-response',
    'submit-publisher-root-operation-request',
    'submit-publisher-root-operation-response',
  ]) {
    t.ok(schema.includes(`name: '${name}'`), `${name} schema is registered`)
  }

  t.ok(schema.includes("name: 'prepare-publisher-root-operation'"), 'prepare command registered')
  t.ok(schema.includes("name: 'submit-publisher-root-operation'"), 'submit command registered')
  t.ok(schema.includes("{ name: 'unsignedBytes', type: 'buffer', required: true }"), 'prepared response carries exact canonical bytes')
  t.ok(schema.includes("{ name: 'candidateRecordId', type: 'buffer', required: true }"), 'prepared response carries candidate record id')
  t.ok(schema.includes("{ name: 'displaySummaryJson', type: 'string', required: false }"), 'summary is data, not signature authority')
  t.ok(schema.includes("{ name: 'signature', type: 'buffer', required: true }"), 'submit request carries shell signature bytes')

  t.ok(codegen.includes("'prepare-publisher-root-operation'"), 'prepare method classified in app identity namespace')
  t.ok(codegen.includes("'submit-publisher-root-operation'"), 'submit method classified in app identity namespace')
  t.ok(handlers.includes("'PreparePublisherRootOperation'"), 'prepare shared handler registered')
  t.ok(handlers.includes("'SubmitPublisherRootOperation'"), 'submit shared handler registered')
})
