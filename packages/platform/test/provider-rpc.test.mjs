import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = path.resolve(import.meta.dirname, '..')

async function loadSharedRpc() {
  const sourcePath = path.join(root, 'src/rpc.shared.ts')
  const source = fs.readFileSync(sourcePath, 'utf8')
    .replace(/^import type[\s\S]*?from '@peartube\/host'\n/gm, '')
    .replace("import { PROTOCOL_VERSION } from '@peartube/host/contracts'", 'const PROTOCOL_VERSION = 9')
    .replace("import { PROTOCOL_EVENTS } from '@peartube/host/events'", "const PROTOCOL_EVENTS = { ACQUISITION_LIFECYCLE: 'acquisition.lifecycle' }")
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-provider-rpc-'))
  const modulePath = path.join(directory, 'rpc.shared.mjs')
  fs.writeFileSync(modulePath, output)
  try {
    return await import(`${pathToFileURL(modulePath).href}?${Math.random()}`)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('mobile and desktop export the same shared provider facade', async () => {
  const nativeSource = fs.readFileSync(path.join(root, 'src/rpc.native.ts'), 'utf8')
  const webSource = fs.readFileSync(path.join(root, 'src/rpc.web.ts'), 'utf8')
  for (const source of [nativeSource, webSource]) {
    assert.match(source, /provider: createProviderRpc\(ensureProtocolClient\)/)
  }

  const { createProviderRpc } = await loadSharedRpc()
  const calls = []
  const provider = Object.fromEntries([
    'search', 'resolveProviderRef', 'requestAcquisition', 'attachSourceGrant',
    'getAcquisition', 'listAcquisitions', 'cancelAcquisition', 'getPublication',
    'openStream', 'getStatus', 'getPolicy', 'setPolicy', 'getAcquisitionPolicy',
    'setAcquisitionPolicy',
  ].map((name) => [name, async (request) => { calls.push([name, request]); return { success: true } }]))
  const facade = createProviderRpc(() => ({ ready: async () => {}, provider }))

  await facade.resolveProviderRef({ resolutionRef: 'ref-1' })
  await facade.cancelAcquisition({ acquisitionId: 'a-1' })
  await facade.setAcquisitionPolicy({ policy: { policyVersion: 1 }, expectedRevision: 0, consent: { version: 1, granted: true } })

  assert.deepEqual(calls.map(([name]) => name), ['resolveProviderRef', 'cancelAcquisition', 'setAcquisitionPolicy'])
})
