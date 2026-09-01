import test from 'brittle'
import fs from 'node:fs'

import { APP_RPC_METADATA } from '../spec/hrpc/app-rpc-adapter.mjs'

const readJson = (relative) => JSON.parse(fs.readFileSync(new URL(relative, import.meta.url), 'utf8'))

const METHODS = [
  'resolve-provider-ref',
  'request-acquisition',
  'get-acquisition',
  'list-acquisitions',
  'cancel-acquisition',
  'retry-acquisition',
  'get-acquisition-policy',
  'set-acquisition-policy',
]

const SECRET_FIELD = /(?:url|path|credential|cookie|header|token|adaptername|sourceprovider)/i

test('provider methods and lifecycle event append to generated HRPC', (t) => {
  const hrpc = readJson('../spec/hrpc/hrpc.json')
  const commands = hrpc.schema.map((entry) => entry.name.replace('@peartube/', ''))
  for (const method of METHODS) t.ok(commands.includes(method), `${method} is registered`)
  t.ok(commands.includes('event-acquisition-lifecycle'), 'acquisition lifecycle event is registered')
  const provider = new Set(APP_RPC_METADATA.namespaces.provider.map((entry) => entry.command))
  for (const method of METHODS) t.ok(provider.has(method), `${method} is exposed by provider namespace`)
  t.is(commands.at(-1), 'event-acquisition-lifecycle', 'provider lifecycle stays append-only at the command tail')
})

test('public provider and acquisition records contain no source secrets', (t) => {
  const schema = readJson('../spec/schema/schema.json')
  const publicRecords = schema.schema.filter((entry) =>
    /^(?:provider-(?:search-hit|resolution|publication|status)|acquisition-(?:request|v1|lifecycle-event))/.test(entry.name),
  )
  const leaked = publicRecords.flatMap((entry) =>
    entry.fields.filter((field) => SECRET_FIELD.test(field.name)).map((field) => `${entry.name}.${field.name}`),
  )
  t.alike(leaked, [], 'public records expose no source URL, path, credential, token, or private header')
  const acquisition = publicRecords.find((entry) => entry.name === 'acquisition-v1')
  t.alike(
    acquisition.fields.slice(0, 4).map((field) => field.name),
    ['schemaVersion', 'acquisitionId', 'state', 'retentionClass'],
    'public acquisition identity and state lead the record',
  )
})
