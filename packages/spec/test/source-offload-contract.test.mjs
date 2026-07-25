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

function fields(message) {
  return message.fields.map(({ name, type, required, array }) => ({ name, type, required: required === true, array: array === true }))
}

test('source offload protocol requires evidence-bound explicit confirmation', (t) => {
  const schema = JSON.parse(read('packages/spec/spec/schema/schema.json'))
  const hrpc = JSON.parse(read('packages/spec/spec/hrpc/hrpc.json'))
  const messages = new Map(schema.schema.map(message => [message.name, message]))
  const commands = new Map(hrpc.schema.map(command => [command.name.replace('@peartube/', ''), command]))

  t.alike(fields(messages.get('assess-source-offload-request')), [
    { name: 'publicationId', type: 'string', required: true, array: false },
  ])
  t.alike(fields(messages.get('confirm-source-offload-request')), [
    { name: 'publicationId', type: 'string', required: true, array: false },
    { name: 'assessmentId', type: 'string', required: true, array: false },
    { name: 'evidenceDigest', type: 'string', required: true, array: false },
    { name: 'confirmationNonce', type: 'string', required: true, array: false },
    { name: 'policyVersion', type: 'uint', required: true, array: false },
    { name: 'confirmIrrecoverableRisk', type: 'bool', required: false, array: false },
  ])
  t.ok(
    read('packages/spec/schema.cjs').includes("{ name: 'confirmIrrecoverableRisk', type: 'bool', required: true }"),
    'schema source requires explicit irrecoverability acknowledgement (compact bools encode as flags)',
  )
  for (const command of ['assess-source-offload', 'confirm-source-offload']) {
    t.ok(commands.has(command), `${command} is registered`)
  }
  for (const legacy of ['assess-upload-offload', 'offload-upload']) {
    t.absent(commands.has(legacy), `${legacy} is removed`)
    t.absent(messages.has(`${legacy}-request`), `${legacy} request is removed`)
  }
})

test('list-videos preserves immutable publication identity for source offload', (t) => {
  const schema = JSON.parse(read('packages/spec/spec/schema/schema.json'))
  const messages = new Map(schema.schema.map(message => [message.name, message]))
  const videoFields = fields(messages.get('video'))
  t.ok(videoFields.some(field =>
    field.name === 'publicationId' && field.type === 'string' && field.required === false
  ))
  t.ok(videoFields.some(field =>
    field.name === 'immutablePublication' &&
    field.type === '@peartube/video-immutable-publication' &&
    field.required === false
  ))
  t.alike(fields(messages.get('video-immutable-publication')), [
    { name: 'publicationId', type: 'string', required: true, array: false },
    { name: 'manifestId', type: 'string', required: false, array: false },
    { name: 'renditionId', type: 'string', required: false, array: false },
    { name: 'publisherId', type: 'string', required: false, array: false },
  ])
})
