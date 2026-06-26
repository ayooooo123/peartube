import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Hyperbee from 'hyperbee'
import Hypercore from 'hypercore'

import {
  createMetaSubspaces,
  migrateMetaSubspaces,
  META_SUBSPACES_MIGRATION_KEY,
} from '../src/meta-subspaces.js'

async function withBee(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-sub-'))
  const core = new Hypercore(dir)
  const bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await bee.ready()
  try {
    await fn(bee)
  } finally {
    await core.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('sub accessors round-trip and are isolated from the base keyspace', async () => {
  await withBee(async (bee) => {
    const subs = createMetaSubspaces(bee)
    await bee.put('subscriptions', { unrelated: true }) // base-level key
    await subs.downloadIntents.put('driveA:vidA', { intent: 'a' })
    await subs.channelKinds.put('cc'.repeat(32), { kind: 'autobase' })

    assert.deepEqual((await subs.downloadIntents.get('driveA:vidA'))?.value, { intent: 'a' })
    assert.deepEqual((await subs.channelKinds.get('cc'.repeat(32)))?.value, { kind: 'autobase' })

    // A full-sub scan returns only that sub's keys (decoded), not base keys.
    const diKeys = []
    for await (const n of subs.downloadIntents.createReadStream()) diKeys.push(n.key)
    assert.deepEqual(diKeys, ['driveA:vidA'])

    await subs.downloadIntents.del('driveA:vidA')
    assert.equal(await subs.downloadIntents.get('driveA:vidA'), null)
    // Base key untouched by sub operations.
    assert.deepEqual((await bee.get('subscriptions'))?.value, { unrelated: true })
  })
})

test('migration relocates legacy keys into subs and deletes the originals', async () => {
  await withBee(async (bee) => {
    // Seed legacy flat keys (pre-subspace format).
    await bee.put('download-intent:driveA:vidA', { intent: 'a' })
    await bee.put('download-intent:driveB:vidB', { intent: 'b' })
    await bee.put('mw-channel:' + 'cc'.repeat(32), { kind: 'hyperdb' })
    await bee.put('playback-profile!' + 'dd'.repeat(32) + '!blob1', { version: 1 })
    // An unrelated base key that must NOT move.
    await bee.put('subscriptions', { keep: true })

    const subs = createMetaSubspaces(bee)
    const res = await migrateMetaSubspaces(bee, subs)
    assert.equal(res.migrated, 4)
    assert.equal(res.skipped, false)

    // New sub keys are present and decoded.
    assert.deepEqual((await subs.downloadIntents.get('driveA:vidA'))?.value, { intent: 'a' })
    assert.deepEqual((await subs.channelKinds.get('cc'.repeat(32)))?.value, { kind: 'hyperdb' })
    assert.deepEqual((await subs.playbackProfiles.get('dd'.repeat(32) + '!blob1'))?.value, { version: 1 })

    // Legacy keys are gone.
    assert.equal(await bee.get('download-intent:driveA:vidA'), null)
    assert.equal(await bee.get('mw-channel:' + 'cc'.repeat(32)), null)
    assert.equal(await bee.get('playback-profile!' + 'dd'.repeat(32) + '!blob1'), null)
    // Unrelated base key preserved.
    assert.deepEqual((await bee.get('subscriptions'))?.value, { keep: true })

    // Marker set.
    assert.equal((await bee.get(META_SUBSPACES_MIGRATION_KEY))?.value?.done, true)
  })
})

test('migration is idempotent (second run is a no-op skip)', async () => {
  await withBee(async (bee) => {
    await bee.put('download-intent:driveA:vidA', { intent: 'a' })
    const subs = createMetaSubspaces(bee)

    const first = await migrateMetaSubspaces(bee, subs)
    assert.equal(first.migrated, 1)
    assert.equal(first.skipped, false)

    // Writing a new legacy key after migration: it won't be touched (marker set),
    // proving the second run short-circuits.
    await bee.put('download-intent:driveZ:vidZ', { intent: 'z' })
    const second = await migrateMetaSubspaces(bee, subs)
    assert.equal(second.skipped, true)
    assert.equal(second.migrated, 0)
    assert.deepEqual((await bee.get('download-intent:driveZ:vidZ'))?.value, { intent: 'z' })
  })
})

test('migration on an empty db just sets the marker', async () => {
  await withBee(async (bee) => {
    const subs = createMetaSubspaces(bee)
    const res = await migrateMetaSubspaces(bee, subs)
    assert.equal(res.migrated, 0)
    assert.equal(res.skipped, false)
    assert.equal((await bee.get(META_SUBSPACES_MIGRATION_KEY))?.value?.done, true)
  })
})
