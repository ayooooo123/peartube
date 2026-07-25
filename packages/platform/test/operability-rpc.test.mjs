import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const platformRoot = path.resolve(import.meta.dirname, '..')
const repositoryRoot = path.resolve(platformRoot, '../..')

async function loadSharedRpc() {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-platform-operability-'))
  const sourcePath = path.join(platformRoot, 'src/rpc.shared.ts')
  const hostEventsUrl = pathToFileURL(path.join(repositoryRoot, 'packages/host/src/event-map.js')).href
  const source = fs.readFileSync(sourcePath, 'utf8')
    .replace(/import type \{[\s\S]*?\} from '@peartube\/host'\n/g, '')
    .replace(
      "import { PROTOCOL_VERSION } from '@peartube/host/contracts'",
      'const PROTOCOL_VERSION = 1',
    )
    .replace(
      "import { PROTOCOL_EVENTS } from '@peartube/host/events'",
      `import { PROTOCOL_EVENTS } from '${hostEventsUrl}'`,
    )
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: sourcePath,
  }).outputText
  const modulePath = path.join(temporaryDirectory, 'rpc.shared.mjs')
  fs.writeFileSync(modulePath, output)
  try {
    return await import(pathToFileURL(modulePath).href)
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

test('shared operability facade forwards exact bounded contract requests', async () => {
  const { createOperabilityRpc } = await loadSharedRpc()
  const calls = []
  const rawRpc = new Proxy({}, {
    get(_target, method) {
      return async (request) => {
        calls.push([method, request])
        return { success: true }
      }
    },
  })
  const facade = createOperabilityRpc(() => rawRpc)
  const manifestBytes = new Uint8Array([1, 2, 3])

  await facade.getMigrationStatus({ migrationId: 'publication-v1' })
  await facade.retryMigration({ migrationId: 'publication-v1' })
  await facade.exportMigrationReport({ migrationId: 'publication-v1' })
  await facade.getPublisherDeviceStatus({ publisherId: 'publisher', devicePublicKey: 'device' })
  await facade.exportPortableState()
  await facade.restorePortableState({ manifestBytes, manifestDigest: 'digest' })
  await facade.previewStorageLimit({ maxBytes: 1024 })
  await facade.getArchiveOperatorStatus()

  assert.deepEqual(calls, [
    ['getMigrationStatus', { migrationId: 'publication-v1' }],
    ['retryMigration', { migrationId: 'publication-v1' }],
    ['exportMigrationReport', { migrationId: 'publication-v1' }],
    ['getPublisherDeviceStatus', { publisherId: 'publisher', devicePublicKey: 'device' }],
    ['exportPortableState', {}],
    ['restorePortableState', { manifestBytes, manifestDigest: 'digest' }],
    ['previewStorageLimit', { maxBytes: 1024 }],
    ['getArchiveOperatorStatus', {}],
  ])
})

test('native and web flat RPC facades share the operability forwarding surface', () => {
  for (const fileName of ['rpc.native.ts', 'rpc.web.ts']) {
    const source = fs.readFileSync(path.join(platformRoot, 'src', fileName), 'utf8')
    assert.match(source, /createOperabilityRpc/)
    assert.match(source, /\.\.\.createOperabilityRpc\(ensureRPC\)/)
  }
})
