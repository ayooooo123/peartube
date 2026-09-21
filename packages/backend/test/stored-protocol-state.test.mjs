import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  STORED_PROTOCOL_ERROR_CODE,
  STORED_PROTOCOL_MARKER_FILENAME,
  STORAGE_FORMAT_VERSION,
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

test('fresh storage stays uninitialized until successful startup commits its bounded marker', (t) => {
  const storagePath = makeStorage(t)
  const state = prepareStoredProtocolState({ storagePath, expectedVersion: 4, fs, path })

  assert.equal(state.status, 'uninitialized')
  assert.equal(state.storedVersion, null)
  assert.equal(state.expectedVersion, 4)
  assert.equal(state.markerPath, markerPath(storagePath))
  assert.equal(fs.existsSync(markerPath(storagePath)), false, 'validation alone must not commit readiness')

  assert.equal(state.commit(), true)
  const serialized = fs.readFileSync(markerPath(storagePath), 'utf8')
  assert.ok(Buffer.byteLength(serialized) <= 128)
  assert.deepEqual(JSON.parse(serialized), { protocolVersion: 4 })
})

test('committing writes the marker atomically and leaves no partial temporary file', (t) => {
  const storagePath = makeStorage(t)
  prepareStoredProtocolState({ storagePath, expectedVersion: 4, fs, path }).commit()

  assert.deepEqual(fs.readdirSync(storagePath), [STORED_PROTOCOL_MARKER_FILENAME])
  assert.equal(fs.existsSync(`${markerPath(storagePath)}.tmp`), false)
})

test('same-version restart validates and commits without rewriting the marker', (t) => {
  const storagePath = makeStorage(t)
  writeMarker(storagePath, { protocolVersion: 4 })
  const before = fs.statSync(markerPath(storagePath)).mtimeMs

  const state = prepareStoredProtocolState({ storagePath, expectedVersion: 4, fs, path })
  assert.equal(state.status, 'compatible')
  assert.equal(state.storedVersion, 4)
  assert.equal(state.commit(), false, 'an already-current marker is never rewritten')

  assert.equal(fs.statSync(markerPath(storagePath)).mtimeMs, before)
  assert.deepEqual(JSON.parse(fs.readFileSync(markerPath(storagePath), 'utf8')), { protocolVersion: 4 })
})

test('state written by a newer protocol is refused as newer-state without a write', (t) => {
  const storagePath = makeStorage(t)
  writeMarker(storagePath, { protocolVersion: 5 })
  const before = fs.readFileSync(markerPath(storagePath))

  assert.throws(
    () => prepareStoredProtocolState({ storagePath, expectedVersion: 4, fs, path }),
    (error) => {
      assert.equal(error.code, STORED_PROTOCOL_ERROR_CODE)
      assert.equal(error.reason, 'newer-state')
      assert.equal(error.storedVersion, 5)
      assert.equal(error.expectedVersion, 4)
      assert.deepEqual(error.details, { storedVersion: 5, expectedVersion: 4 })
      return true
    },
  )
  assert.deepEqual(fs.readFileSync(markerPath(storagePath)), before)
})

test('state written by a retired protocol is refused as retired-state without a write', (t) => {
  for (const storedVersion of [1, STORAGE_FORMAT_VERSION - 1]) {
    const storagePath = makeStorage(t)
    writeMarker(storagePath, { protocolVersion: storedVersion })
    const before = fs.readFileSync(markerPath(storagePath))

    assert.throws(
      () => prepareStoredProtocolState({ storagePath, expectedVersion: STORAGE_FORMAT_VERSION, fs, path }),
      (error) => {
        assert.equal(error.code, STORED_PROTOCOL_ERROR_CODE)
        assert.equal(error.reason, 'retired-state', 'older state is retired, never migrated forward')
        assert.equal(error.storedVersion, storedVersion)
        assert.equal(error.expectedVersion, STORAGE_FORMAT_VERSION)
        return true
      },
    )
    assert.deepEqual(fs.readFileSync(markerPath(storagePath)), before, 'refused state is left untouched')
  }
})

test('malformed and oversized markers fail closed with a stable reason and are not replaced', (t) => {
  const cases = [
    ['x'.repeat(129), 'marker-size-invalid'],
    ['not json', 'marker-json-invalid'],
    ['{"protocolVersion":"4"}', 'marker-shape-invalid'],
    ['{"protocolVersion":0}', 'marker-shape-invalid'],
    ['{"protocolVersion":4,"unexpected":true}', 'marker-shape-invalid'],
  ]

  for (const [serialized, reason] of cases) {
    const storagePath = makeStorage(t)
    fs.writeFileSync(markerPath(storagePath), serialized)

    assert.throws(
      () => prepareStoredProtocolState({ storagePath, expectedVersion: 4, fs, path }),
      (error) => {
        assert.equal(error.code, STORED_PROTOCOL_ERROR_CODE)
        assert.equal(error.reason, reason)
        assert.equal(error.storedVersion, null)
        assert.equal(error.expectedVersion, 4)
        return true
      },
    )
    assert.equal(fs.readFileSync(markerPath(storagePath), 'utf8'), serialized)
  }
})

test('an unreadable marker fails closed rather than being treated as fresh storage', (t) => {
  const storagePath = makeStorage(t)
  fs.mkdirSync(markerPath(storagePath))

  assert.throws(
    () => prepareStoredProtocolState({ storagePath, expectedVersion: 4, fs, path }),
    (error) => {
      assert.equal(error.code, STORED_PROTOCOL_ERROR_CODE)
      assert.equal(error.reason, 'marker-unreadable')
      assert.equal(error.storedVersion, null)
      return true
    },
  )
  assert.equal(fs.existsSync(markerPath(storagePath)), true)
})

test('a crash before marker commit remains distinguishable as uninitialized storage', (t) => {
  const storagePath = makeStorage(t)
  prepareStoredProtocolState({ storagePath, expectedVersion: 4, fs, path })

  const retry = prepareStoredProtocolState({ storagePath, expectedVersion: 4, fs, path })
  assert.equal(retry.status, 'uninitialized')
  assert.equal(retry.storedVersion, null)
  assert.equal(fs.existsSync(markerPath(storagePath)), false)
})

test('a marker at the current format reads back compatible under the default expectedVersion', (t) => {
  const storagePath = makeStorage(t)
  writeMarker(storagePath, { protocolVersion: STORAGE_FORMAT_VERSION })

  const state = prepareStoredProtocolState({ storagePath, fs, path })
  assert.equal(state.status, 'compatible')
  assert.equal(state.storedVersion, STORAGE_FORMAT_VERSION)
  assert.equal(state.expectedVersion, STORAGE_FORMAT_VERSION)
})

test('a marker one format behind is refused, because nothing migrates it', (t) => {
  const storagePath = makeStorage(t)
  writeMarker(storagePath, { protocolVersion: STORAGE_FORMAT_VERSION - 1 })

  assert.throws(
    () => prepareStoredProtocolState({ storagePath, fs, path }),
    (error) => error.code === STORED_PROTOCOL_ERROR_CODE && error.storedVersion === STORAGE_FORMAT_VERSION - 1,
  )
})

test('prepared state is frozen and exposes no migration escape hatch', (t) => {
  const storagePath = makeStorage(t)
  const state = prepareStoredProtocolState({ storagePath, expectedVersion: 4, fs, path })

  assert.equal(Object.isFrozen(state), true)
  assert.deepEqual(
    Object.keys(state).sort(),
    ['commit', 'expectedVersion', 'markerPath', 'status', 'storedVersion'],
  )
})
