import assert from 'node:assert/strict'
import fs from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildStorageConfig } from '../src/orchestrator.js'
import { prepareStoredProtocolState, STORAGE_FORMAT_VERSION } from '../src/stored-protocol.js'

async function readSource(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), 'utf8')
}

test('mobile backend entry wires universal core to the real backend orchestrator', async () => {
  const source = await readSource('../src/backend-entry.js')

  assert.match(source, /import \{ createBackendContext \} from '\.\/orchestrator\.js'/)
  assert.match(source, /createUniversalCore\(\{[\s\S]*?createBackendContext,[\s\S]*?onStatsUpdate: onVideoStats,[\s\S]*?\}\)/)
})

test('mobile storage accepts its explicit format independently of the live protocol', () => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-mobile-storage-format-'))
  const markerPath = path.join(storagePath, 'stored-protocol.json')
  const marker = JSON.stringify({ protocolVersion: STORAGE_FORMAT_VERSION - 1 })
  fs.writeFileSync(markerPath, marker)
  try {
    const storageConfig = buildStorageConfig({
      storagePath,
      platform: 'mobile',
      protocolVersion: STORAGE_FORMAT_VERSION + 1,
      expectedStorageFormatVersion: STORAGE_FORMAT_VERSION - 1,
    }, Buffer.alloc(32, 1))
    const storedState = prepareStoredProtocolState({
      storagePath,
      expectedVersion: storageConfig.expectedStorageFormatVersion,
      fs,
      path,
    })
    assert.equal(storedState.commit(), false)
    assert.equal(fs.readFileSync(markerPath, 'utf8'), marker)
  } finally {
    fs.rmSync(storagePath, { recursive: true, force: true })
  }
})
