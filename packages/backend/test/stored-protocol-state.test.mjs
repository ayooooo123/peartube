import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  STORED_PROTOCOL_ERROR_CODE,
  STORED_PROTOCOL_MARKER_FILENAME,
  prepareStoredProtocolState,
} from '../src/stored-protocol.js'

function makeStorage(t) {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-stored-protocol-'))
  t.after(() => fs.rmSync(storagePath, { recursive: true, force: true }))
  return storagePath
}

function markerPath(storagePath) {
  return path.join(storagePath, STORED_PROTOCOL_MARKER_FILENAME)
}

function writeMarker(storagePath, value) {
  fs.writeFileSync(markerPath(storagePath), JSON.stringify(value))
}

test('fresh storage stays uninitialized until successful startup commits its bounded marker', async (t) => {
  const storagePath = makeStorage(t)
  const state = prepareStoredProtocolState({ storagePath, expectedVersion: 4, fs, path })

  assert.equal(state.status, 'uninitialized')
  assert.equal(state.storedVersion, null)
  assert.equal(fs.existsSync(markerPath(storagePath)), false)

  await state.migrate({})
  assert.equal(fs.existsSync(markerPath(storagePath)), false, 'validation and migration must not commit readiness')

  state.commit()
  const serialized = fs.readFileSync(markerPath(storagePath), 'utf8')
  assert.ok(Buffer.byteLength(serialized) <= 128)
  assert.deepEqual(JSON.parse(serialized), { protocolVersion: 4 })
})

test('same-version restart validates without rewriting the marker', (t) => {
  const storagePath = makeStorage(t)
  writeMarker(storagePath, { protocolVersion: 4 })
  const before = fs.statSync(markerPath(storagePath)).mtimeMs

  const state = prepareStoredProtocolState({ storagePath, expectedVersion: 4, fs, path })
  assert.equal(state.status, 'compatible')
  state.commit()

  assert.equal(fs.statSync(markerPath(storagePath)).mtimeMs, before)
  assert.deepEqual(JSON.parse(fs.readFileSync(markerPath(storagePath), 'utf8')), { protocolVersion: 4 })
})

test('older stored state runs every explicitly registered migration before commit', async (t) => {
  const storagePath = makeStorage(t)
  writeMarker(storagePath, { protocolVersion: 2 })
  const applied = []
  const context = { records: [] }
  const migrations = new Map([
    [2, async (ctx, step) => { applied.push(step); ctx.records.push('v3') }],
    [3, async (ctx, step) => { applied.push(step); ctx.records.push('v4') }],
  ])

  const state = prepareStoredProtocolState({ storagePath, expectedVersion: 4, migrations, fs, path })
  assert.equal(state.status, 'migration-required')
  await state.migrate(context)

  assert.deepEqual(applied, [
    { fromVersion: 2, toVersion: 3, expectedVersion: 4 },
    { fromVersion: 3, toVersion: 4, expectedVersion: 4 },
  ])
  assert.deepEqual(context.records, ['v3', 'v4'])
  assert.deepEqual(JSON.parse(fs.readFileSync(markerPath(storagePath), 'utf8')), { protocolVersion: 2 })

  state.commit()
  assert.deepEqual(JSON.parse(fs.readFileSync(markerPath(storagePath), 'utf8')), { protocolVersion: 4 })
})

test('newer or unregistered older state fails closed with stable version details and no write', (t) => {
  for (const storedVersion of [5, 2]) {
    const storagePath = makeStorage(t)
    writeMarker(storagePath, { protocolVersion: storedVersion })
    const before = fs.readFileSync(markerPath(storagePath))

    assert.throws(
      () => prepareStoredProtocolState({ storagePath, expectedVersion: 4, fs, path }),
      (error) => {
        assert.equal(error.code, STORED_PROTOCOL_ERROR_CODE)
        assert.equal(error.storedVersion, storedVersion)
        assert.equal(error.expectedVersion, 4)
        return true
      },
    )
    assert.deepEqual(fs.readFileSync(markerPath(storagePath)), before)
  }
})

test('malformed and oversized markers fail closed without being replaced', (t) => {
  const malformedValues = [
    '{"protocolVersion":"4"}',
    '{"protocolVersion":0}',
    '{"protocolVersion":4,"unexpected":true}',
    'x'.repeat(129),
  ]

  for (const serialized of malformedValues) {
    const storagePath = makeStorage(t)
    fs.writeFileSync(markerPath(storagePath), serialized)

    assert.throws(
      () => prepareStoredProtocolState({ storagePath, expectedVersion: 4, fs, path }),
      (error) => {
        assert.equal(error.code, STORED_PROTOCOL_ERROR_CODE)
        assert.equal(error.storedVersion, null)
        assert.equal(error.expectedVersion, 4)
        return true
      },
    )
    assert.equal(fs.readFileSync(markerPath(storagePath), 'utf8'), serialized)
  }
})

test('a crash before marker commit remains distinguishable as uninitialized storage', async (t) => {
  const storagePath = makeStorage(t)
  const firstAttempt = prepareStoredProtocolState({ storagePath, expectedVersion: 4, fs, path })
  await firstAttempt.migrate({})

  const retry = prepareStoredProtocolState({ storagePath, expectedVersion: 4, fs, path })
  assert.equal(retry.status, 'uninitialized')
  assert.equal(retry.storedVersion, null)
  assert.equal(fs.existsSync(markerPath(storagePath)), false)
})
